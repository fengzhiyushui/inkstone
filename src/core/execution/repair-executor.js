import { redactSecrets } from "../../security/redactor.js";
import { toolResultsToMessages } from "./tool-result-router.js";
import {
  runToolCallCycle,
  runToolCallsInOrder,
  toolCallRepairPrompt
} from "./execution-cycle.js";

// v1.19.2 补丁版(纯重构):执行循环骨架(模型调用/预算检查/事件发射/整批预校验与
// maxToolCallRepairs 有界重试/顺序执行工具与审批挂起)收敛到 execution-cycle.js。
// 本文件只保留 repair 场景差异:
//   - purpose 恒 "repair"(request/response/invoke 三处);
//   - 预算检查仅 syntaxAttempt > 0 时生效并回退 options?.scope?.budget,stopped
//     返回带 messages/toolCallRepairs 且 toolResults 恒为 [];
//   - invoke 的 BUDGET_EXCEEDED 错误特判(仅 syntaxAttempt > 0 时转 stopped);
//   - 重试循环无界:有界性只由 maxToolCallRepairs 决定;
//   - model:tool_call_repair 载荷多 purpose 且 reason 经脱敏截断
//     (sanitizeSyntaxRepairReason),重试消息追加 "Allowed tools: ..." 提示;
//   - repair 版 assistantToolCallMessage(缺失 id/name/arguments 的容错映射:
//     call_repair_${idx} / "unknown_tool" / 2000 字符截断),与 executor 版行为
//     不同,必须原样保留;
//   - 工具循环每个工具前查 signal 中止,策略阶段为 "repair";
//   - repair 字段的 resume_state(iteration 恒 0、budget_spent 仅快照非空时附)。

const REPAIR_ABORT_MESSAGE = "Repair operation was aborted";
const MAX_REPAIR_REASON_CHARS = 240;
const MAX_RAW_ARGUMENTS_ECHO_CHARS = 2000;

function sanitizeSyntaxRepairReason(message) {
  const redacted = redactSecrets(String(message || "invalid tool call syntax"));
  return redacted.length > MAX_REPAIR_REASON_CHARS
    ? `${redacted.slice(0, MAX_REPAIR_REASON_CHARS - 1)}…`
    : redacted;
}

export async function runRepairExecutor({
  turnId,
  messages = [],
  modelGateway,
  toolSchemas = [],
  executeTool,
  createPolicyContext,
  eventBus = null,
  signal = null,
  modelTimeoutMs = null,
  maxToolCallRepairs = null,
  initialToolCallRepairs = 0,
  permissionContext = null,
  options = {},
  budget = null,
  sessionId = null
} = {}) {
  if (!modelGateway || typeof modelGateway.invoke !== "function") {
    throw new Error("modelGateway.invoke is required for repair executor");
  }
  if (typeof executeTool !== "function") throw new Error("executeTool is required");
  if (typeof createPolicyContext !== "function") throw new Error("createPolicyContext is required");

  // sessionId 直接参数优先,options.sessionId 兜底(repair-loop 透传/续跑链路可取)。
  const effectiveSessionId = sessionId ?? options.sessionId ?? null;
  const effectiveMaxToolCallRepairs = Math.max(
    0,
    Math.trunc(Number(maxToolCallRepairs ?? options?.maxToolCallRepairs ?? 0) || 0)
  );
  const initialRepairs = Math.max(
    0,
    Math.trunc(Number(initialToolCallRepairs ?? options?.initialToolCallRepairs ?? 0) || 0)
  );

  return runToolCallCycle({
    turnId,
    messages: [...messages],
    modelGateway,
    eventBus,
    budget,
    signal,
    abortMessage: REPAIR_ABORT_MESSAGE,
    sessionId: effectiveSessionId,
    maxToolCallRepairs: effectiveMaxToolCallRepairs,
    initialToolCallRepairs: initialRepairs,
    // repair 的重试循环无界,有界性只由 maxToolCallRepairs 决定。
    maxIterations: null,
    requestPurpose: "repair",
    responsePurpose: "repair",
    // 预算检查:首次调用(syntaxAttempt === 0)只查本地 budget,重试轮起同时
    // 回退查 options?.scope?.budget(聚合 RequestBudget)。
    checkBudget: ({ iteration }) => (iteration > 0
      ? (budget?.exceeded?.() || options?.scope?.budget?.exceeded?.())
      : budget?.exceeded?.()),
    onBudgetExceeded: (over, ctx) => ({
      status: "stopped",
      reason: over,
      content: `Stopped: cost budget exceeded (${over.reason}).`,
      toolResults: [],
      messages: ctx.messages,
      toolCallRepairs: ctx.toolCallRepairs
    }),
    buildInvokeOptions: () => ({
      ...options,
      purpose: "repair",
      tools: toolSchemas,
      toolChoice: "auto",
      timeoutMs: modelTimeoutMs ?? options.timeoutMs,
      signal
    }),
    onInvokeError: (error, ctx) => {
      // BUDGET_EXCEEDED 仅在重试轮(syntaxAttempt > 0)转 stopped,首轮原样抛出。
      if (error?.code === "BUDGET_EXCEEDED" && ctx.iteration > 0) {
        const overReason = error.details || budget?.exceeded?.() || options?.scope?.budget?.exceeded?.() || { reason: "budget_exceeded" };
        return {
          status: "stopped",
          reason: overReason,
          content: `Stopped: cost budget exceeded (${overReason.reason || "budget_exceeded"}).`,
          toolResults: [],
          messages: ctx.messages,
          toolCallRepairs: ctx.toolCallRepairs
        };
      }
      return null;
    },
    onComplete: (ctx, modelResult) => ({
      status: "complete",
      content: modelResult.content || "",
      toolResults: [],
      messages: ctx.messages,
      toolCallRepairs: ctx.toolCallRepairs
    }),
    requestedByStepId: ({ iteration }) => `repair:${turnId}:${iteration}`,
    onToolCallRepair: (ctx, error) => {
      const conciseReason = sanitizeSyntaxRepairReason(error.message);
      const allowedNames = (toolSchemas || [])
        .map((s) => s?.function?.name)
        .filter(Boolean);
      const schemaHint = allowedNames.length ? ` Allowed tools: ${allowedNames.join(", ")}.` : "";
      return {
        event: {
          turn_id: turnId,
          purpose: "repair",
          iteration: ctx.iteration,
          attempt: ctx.attempt,
          reason: conciseReason
        },
        message: toolCallRepairPrompt(conciseReason, schemaHint)
      };
    },
    buildAssistantMessage: assistantToolCallMessage,
    onToolCallsReady: async (ctx, modelResult, rawToolCalls, toolCalls) => {
      // 顺序执行工具(阶段 "repair",每个工具前查中止);approval_required 时构造
      // repair 字段的 resume_state 并挂起(budget_spent 仅快照非空时附)。
      const next = await runToolCallsInOrder({
        toolCalls,
        turnId,
        executeTool,
        createPolicyContext,
        phase: "repair",
        signal,
        abortMessage: REPAIR_ABORT_MESSAGE,
        abortBeforeEachTool: true,
        onApproval: ({ result, toolCall, index, results }) => {
          const budgetSnap = budget?.snapshot?.() || null;
          return {
            status: "awaiting_approval",
            content: result.content?.[0]?.text || "Approval required",
            approval: result.metadata?.approval || null,
            toolResults: results,
            toolCallRepairs: ctx.toolCallRepairs,
            resume_state: {
              turn_id: turnId,
              message: options.message || "repair",
              classification: options.classification || { task_type: "edit" },
              messages: ctx.messages,
              model_result: modelResult,
              raw_tool_calls: rawToolCalls,
              pending_tool_call: toolCall,
              remaining_tool_calls: toolCalls.slice(index + 1),
              iteration: 0,
              tool_results: results.slice(0, -1),
              tool_schemas: toolSchemas,
              max_iterations: options.maxToolIterations || 5,
              tool_call_repairs: ctx.toolCallRepairs,
              max_tool_call_repairs: effectiveMaxToolCallRepairs,
              ...(budgetSnap ? { budget_spent: { tokens: budgetSnap.tokens, model_calls: budgetSnap.model_calls } } : {}),
              options: {
                ...options,
                purpose: "repair",
                maxToolCallRepairs: effectiveMaxToolCallRepairs
              },
              context: options.context || null,
              permission_context: permissionContext
            }
          };
        }
      });
      if (next.status === "awaiting_approval") {
        return { kind: "result", result: next };
      }
      // 全部工具执行完毕:repair 回合完成,回传含 assistant 工具消息与工具结果
      // 的完整 messages,供调用方拼回后续请求。
      return {
        kind: "result",
        result: {
          status: "complete",
          content: modelResult.content || "Repair tools executed.",
          toolResults: next.results,
          toolCallRepairs: ctx.toolCallRepairs,
          messages: [
            ...ctx.messages,
            assistantToolCallMessage(modelResult, rawToolCalls),
            ...toolResultsToMessages(next.results)
          ]
        }
      };
    }
  });
}

function assistantToolCallMessage(modelResult, rawToolCalls) {
  return {
    role: "assistant",
    content: modelResult.content || "",
    // DeepSeek 协议:带 tools 的请求必须完整回传历史每轮 assistant 消息的
    // reasoning_content,否则 HTTP 400。仅当上游确实返回了该字段(真字符串)时
    // 才附带,不用 undefined 占位键——旧 mock 不传该字段时行为逐字节不变。
    ...(modelResult.reasoning_content ? { reasoning_content: modelResult.reasoning_content } : {}),
    tool_calls: rawToolCalls.map((call, idx) => {
      let argsText;
      if (typeof call?.raw_arguments === "string") {
        argsText = call.raw_arguments.length > MAX_RAW_ARGUMENTS_ECHO_CHARS
          ? `${call.raw_arguments.slice(0, MAX_RAW_ARGUMENTS_ECHO_CHARS)}…`
          : call.raw_arguments;
      } else if (call?.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments)) {
        argsText = JSON.stringify(call.arguments);
      } else {
        argsText = "{}";
      }
      return {
        id: call?.id || `call_repair_${idx}`,
        type: "function",
        function: {
          name: typeof call?.name === "string" && call.name ? call.name : "unknown_tool",
          arguments: argsText
        }
      };
    })
  };
}
