// src/core/execution/execution-cycle.js
// v1.19.2 补丁版(纯重构):把 executor-loop.js 与 repair-executor.js 中真正同构的
// 执行循环骨架收敛到本模块,场景差异全部经参数/钩子注入,逐字节保留现有差异。
//
// 收敛的公共骨架:
//   1. abortFromSignal     —— 两者原本各一份,仅默认消息文本不同(可配置);
//   2. modelResponseExtras —— 两者逻辑完全一致(v1.9.0 M1 四新键契约),合并为
//      单一实现(原 repairResponseExtras 与此逐字节等价);
//   3. runToolCallCycle    —— 「模型调用 → 预算检查 → model:request/model:response
//      事件发射 → tool_calls 为空则 complete → adaptDeepSeekToolCalls 整批预校验
//      → 失败且有预算则发 model:tool_call_repair 并追加修复消息后重试」的循环
//      骨架(含预校验通过后的顺序工具执行与审批挂起编排);
//   4. runToolCallsInOrder —— 顺序执行工具 + approval_required 挂起的公共部分,
//      resume_state 由调用方按各自字段构造。
//
// 明确保留的场景差异(钩子注入,不得抹平):
//   - abortFromSignal 默认消息(executor "Operation was aborted" /
//     repair "Repair operation was aborted");
//   - purpose 命名:model:request 载荷 executor/resume 恒 "act"(executor 的
//     model:response 与 invoke 首轮为 "plan"、其余 "act";resume 恒 "act";
//     repair 恒 "repair");
//   - budget 检查条件(executor/resume 每轮查 budget?.exceeded();repair 仅
//     iteration > 0 时查并回退 options?.scope?.budget)与 stopped 返回形状;
//   - invoke 选项键序(repair 的 ...options 在前、purpose/toolChoice 固定);
//   - repair 的 BUDGET_EXCEEDED 错误特判(仅 iteration > 0 时转 stopped);
//   - model:tool_call_repair 载荷(repair 多 purpose 且 reason 脱敏截断)与修复
//     消息文本(repair 追加 "Allowed tools: ..." 提示);
//   - assistantToolCallMessage 两个版本(repair 的容错映射)留在各自文件;
//   - resume_state 字段(executor/resume 与 repair 各自不同)与 budget_spent 附键
//     时机(repair 仅在快照非空时附,保持内联原样);
//   - 工具循环内的中止检查:仅 repair 在每个工具前查 signal(executor 不查)。

import { adaptDeepSeekToolCalls, isToolCallSyntaxError } from "./tool-call-adapter.js";

// signal 中止 → AbortError。defaultMessage 可配置:executor 用
// "Operation was aborted",repair 用 "Repair operation was aborted";
// signal.reason 为 Error 时原样返回,为非空字符串时作为消息,均不改写。
export function abortFromSignal(signal, defaultMessage = "Operation was aborted") {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const err = new Error(typeof reason === "string" && reason ? reason : defaultMessage);
  err.name = "AbortError";
  err.code = "ABORT";
  return err;
}

// v1.9.0 M1 契约冻结:model:response 顶层键集一次定稿。既有八键
// {turn_id,purpose,iteration,content,tool_call_count,usage,model,channel}
// 由调用方逐字节不动;本 helper 产出的四个新键一律「仅非 null 时附键」(不用
// undefined 占位),旧 mock/旧时间线因此逐字节兼容。cache hit/miss 与 reasoning
// tokens 不加顶层键,继续走 usage 子对象。
//   reasoning  : modelResult.reasoning_content 截断 500 字符(超长结尾补「…」);
//   tps        : usage.completion_tokens / (latency_ms/1000),保留 1 位小数,
//                缺 usage/latency 或 latency<=0 时不附键;
//   session_id : sessionId 非空才附;
//   latency_ms : modelResult.latency_ms 为有限数才附。
// executor-loop.js 与 repair-executor.js 的 model:response 事件共用本实现
// (原 repairResponseExtras 与 modelResponseExtras 逻辑逐字节一致)。
export function modelResponseExtras(modelResult, sessionId) {
  const extras = {};
  const reasoning = modelResult?.reasoning_content;
  if (typeof reasoning === "string" && reasoning.length > 0) {
    extras.reasoning = reasoning.length > 500 ? `${reasoning.slice(0, 500)}…` : reasoning;
  }
  const completionTokens = modelResult?.usage?.completion_tokens;
  const latencyMs = modelResult?.latency_ms;
  if (Number.isFinite(completionTokens) && Number.isFinite(latencyMs) && latencyMs > 0) {
    extras.tps = Math.round((completionTokens / (latencyMs / 1000)) * 10) / 10;
  }
  if (typeof sessionId === "string" && sessionId.length > 0) {
    extras.session_id = sessionId;
  }
  if (Number.isFinite(latencyMs)) {
    extras.latency_ms = latencyMs;
  }
  return extras;
}

// 预校验失败后的有界重试提示文本:executor 与 repair 共用同一句,差异仅在
// reason(repair 经脱敏截断的 sanitizeSyntaxRepairReason)与 schemaHint
// (repair 追加 " Allowed tools: ..." 提示,executor 不附即空串)。
export function toolCallRepairPrompt(reason, schemaHint = "") {
  return `Your previous tool call had invalid arguments (${reason}). Re-issue the tool call with valid JSON arguments.${schemaHint}`;
}

// 暂停时把已消耗的预算(不计 max)写入 resume_state,续跑时按 spent 续扣,
// 避免审批暂停/续跑重置每回合 token/调用次数预算。repair 的 budget_spent 附键
// 时机不同(仅在快照非空时附),保持其内联写法,不走本 helper。
export function withBudgetSpent(resumeState, budget) {
  if (!resumeState || !budget?.snapshot) return resumeState;
  const spent = budget.snapshot();
  return { ...resumeState, budget_spent: { tokens: spent.tokens, model_calls: spent.model_calls } };
}

// 执行循环骨架:模型调用 → 预算检查 → model:request/model:response 事件发射 →
// tool_calls 为空则 complete → adaptDeepSeekToolCalls 整批预校验 → 失败且有预算
// 则发 model:tool_call_repair 并追加修复消息后重试;预校验通过后交由
// onToolCallsReady 顺序执行工具(见 runToolCallsInOrder),全部通过则按调用方给出
// 的新消息进入下一轮迭代。事件发射顺序与现有实现完全一致(同一 iteration 内
// request → response → repair/tool 事件的相对次序不变)。
//
// 场景差异全部经钩子注入(逐字节保留):
//   requestPurpose / responsePurpose : 事件载荷的 purpose(string 或
//     (iteration) => string;executor 的 request 恒 "act"、response 首轮
//     "plan" 其余 "act");
//   checkBudget        : 每轮迭代的预算检查条件,返回 over 对象或空值;
//   onBudgetExceeded   : (over, ctx) => 终止结果(stopped 形状各自不同);
//   buildInvokeOptions : (ctx) => invoke 选项(键序差异:repair 的 ...options 在前);
//   onInvokeError      : (error, ctx) => 终止结果或 null(null 表示重新抛出);
//     repair 的 BUDGET_EXCEEDED 特判经此注入,executor/resume 不传;
//   onComplete         : (ctx, modelResult) => 终止结果(complete 形状各自不同);
//   requestedByStepId  : (ctx) => 整批预校验的 step 标识(命名差异);
//   onToolCallRepair   : (ctx, error) => { event, message },修复事件载荷与
//     追加的 user 消息内容各自不同;
//   buildAssistantMessage : (modelResult, rawToolCalls) => assistant 工具消息,
//     executor 版与 repair 版(容错映射)各自注入;
//   onToolCallsReady   : (ctx, modelResult, rawToolCalls, toolCalls) =>
//     { kind: "result", result } 终止,或 { kind: "continue", messages } 进入
//     下一轮迭代;顺序执行与审批挂起在该钩子内经 runToolCallsInOrder 完成;
//   maxIterations      : 数字为有界(耗尽走 onExhausted),null/缺省为无界
//     (repair 的重试循环无界,有界性只由 maxToolCallRepairs 决定)。
export async function runToolCallCycle({
  turnId,
  messages,
  modelGateway,
  eventBus = null,
  budget = null,
  signal = null,
  abortMessage = "Operation was aborted",
  sessionId = null,
  maxToolCallRepairs = 0,
  initialToolCallRepairs = 0,
  startIteration = 0,
  maxIterations = null,
  requestPurpose,
  responsePurpose,
  checkBudget,
  onBudgetExceeded,
  buildInvokeOptions,
  onInvokeError = null,
  onComplete,
  requestedByStepId,
  onToolCallRepair,
  buildAssistantMessage,
  onToolCallsReady,
  onExhausted = null
}) {
  let currentMessages = messages;
  let toolCallRepairs = initialToolCallRepairs;
  const bound = maxIterations ?? Infinity;
  for (let iteration = startIteration; iteration < bound; iteration += 1) {
    if (signal?.aborted) {
      throw abortFromSignal(signal, abortMessage);
    }
    const over = checkBudget({ iteration });
    if (over) {
      return onBudgetExceeded(over, { iteration, messages: currentMessages, toolCallRepairs });
    }
    const requestPurposeLabel = typeof requestPurpose === "function" ? requestPurpose(iteration) : requestPurpose;
    eventBus?.publish?.("model:request", { turn_id: turnId, purpose: requestPurposeLabel, iteration });
    let modelResult;
    try {
      modelResult = await modelGateway.invoke(currentMessages, buildInvokeOptions({ iteration }));
    } catch (error) {
      // repair 的 BUDGET_EXCEEDED 特判:钩子返回 null 表示重新抛出原错误。
      const handled = onInvokeError
        ? onInvokeError(error, { iteration, messages: currentMessages, toolCallRepairs })
        : null;
      if (handled) return handled;
      throw error;
    }
    // repair 期的模型调用同样计入每回合预算(budget 为 null 时行为与此前一致)。
    if (budget) budget.recordModelResult(modelResult);
    if (signal?.aborted) {
      throw abortFromSignal(signal, abortMessage);
    }
    const responsePurposeLabel = typeof responsePurpose === "function" ? responsePurpose(iteration) : responsePurpose;
    eventBus?.publish?.("model:response", {
      turn_id: turnId,
      purpose: responsePurposeLabel,
      iteration,
      content: modelResult.content || "",
      tool_call_count: modelResult.tool_calls?.length || 0,
      usage: modelResult.usage || null,
      model: modelResult.model,
      channel: modelResult.channel,
      ...modelResponseExtras(modelResult, sessionId)
    });

    const rawToolCalls = modelResult.tool_calls || [];
    if (!rawToolCalls.length) {
      return onComplete({ iteration, messages: currentMessages, toolCallRepairs }, modelResult);
    }

    // 整批预校验:全部工具通过语法与结构校验之前,绝不执行任何一个工具(P04)。
    let toolCalls;
    try {
      toolCalls = adaptDeepSeekToolCalls(rawToolCalls, { requestedByStepId: requestedByStepId({ iteration }) });
    } catch (error) {
      if (!isToolCallSyntaxError(error) || toolCallRepairs >= maxToolCallRepairs) throw error;
      toolCallRepairs += 1;
      const { event, message } = onToolCallRepair({ iteration, attempt: toolCallRepairs }, error);
      eventBus?.publish?.("model:tool_call_repair", event);
      currentMessages = [
        ...currentMessages,
        buildAssistantMessage(modelResult, rawToolCalls),
        { role: "user", content: message }
      ];
      continue;
    }

    const outcome = await onToolCallsReady(
      { iteration, messages: currentMessages, toolCallRepairs },
      modelResult,
      rawToolCalls,
      toolCalls
    );
    if (outcome.kind === "continue") {
      currentMessages = outcome.messages;
      continue;
    }
    return outcome.result;
  }

  if (onExhausted) return onExhausted({ messages: currentMessages, toolCallRepairs });
  throw new Error(`maximum tool iterations exceeded: ${bound}`);
}

// 顺序执行整批工具调用;任一工具返回 approval_required 立即挂起,由 onApproval
// 构造该场景的 awaiting_approval 返回(含各自字段的 resume_state,调用方自行套
// withBudgetSpent 等预算语义)。全部通过则返回 { status: "continued", results }
// (results 含本批全部结果,顺序与原 tool_calls 一致)。
//
// 场景差异:
//   - phase:executor/resume 用 "execute",repair 用 "repair";
//   - abortBeforeEachTool:仅 repair 在每个工具前检查 signal 中止(executor 的
//     工具循环不查,保持逐字节一致),默认 false;
//   - onResult:executor/resume 需要把结果同步进跨迭代累积的 toolResults 数组,
//     repair 不需要(直接用返回的 results)。
export async function runToolCallsInOrder({
  toolCalls,
  turnId,
  executeTool,
  createPolicyContext,
  phase,
  signal = null,
  abortMessage = "Operation was aborted",
  abortBeforeEachTool = false,
  onResult = null,
  onApproval
}) {
  const results = [];
  for (let index = 0; index < toolCalls.length; index += 1) {
    if (abortBeforeEachTool && signal?.aborted) {
      throw abortFromSignal(signal, abortMessage);
    }
    const toolCall = toolCalls[index];
    const result = await executeTool(toolCall, createPolicyContext({ turnId, toolCall, phase }));
    results.push(result);
    if (onResult) onResult(result);
    if (result.status === "approval_required") {
      return onApproval({ result, toolCall, index, results });
    }
  }
  return { status: "continued", results };
}
