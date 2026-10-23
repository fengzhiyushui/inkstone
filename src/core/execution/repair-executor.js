import { adaptDeepSeekToolCalls, isToolCallSyntaxError } from "./tool-call-adapter.js";
import { toolResultsToMessages } from "./tool-result-router.js";
import { redactSecrets } from "../../security/redactor.js";

const MAX_REPAIR_REASON_CHARS = 240;
const MAX_RAW_ARGUMENTS_ECHO_CHARS = 2000;

function abortFromSignal(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const err = new Error(typeof reason === "string" && reason ? reason : "Repair operation was aborted");
  err.name = "AbortError";
  err.code = "ABORT";
  return err;
}

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
  let toolCallRepairs = Math.max(
    0,
    Math.trunc(Number(initialToolCallRepairs ?? options?.initialToolCallRepairs ?? 0) || 0)
  );
  let currentMessages = [...messages];
  let modelResult = null;
  let rawToolCalls = [];
  let toolCalls = [];

  for (let syntaxAttempt = 0; ; syntaxAttempt += 1) {
    if (signal?.aborted) {
      throw abortFromSignal(signal);
    }
    const over = syntaxAttempt > 0
      ? (budget?.exceeded?.() || options?.scope?.budget?.exceeded?.())
      : budget?.exceeded?.();
    if (over) {
      return {
        status: "stopped",
        reason: over,
        content: `Stopped: cost budget exceeded (${over.reason}).`,
        toolResults: [],
        messages: currentMessages,
        toolCallRepairs
      };
    }

    eventBus?.publish?.("model:request", { turn_id: turnId, purpose: "repair", iteration: syntaxAttempt });
    try {
      modelResult = await modelGateway.invoke(currentMessages, {
        ...options,
        purpose: "repair",
        tools: toolSchemas,
        toolChoice: "auto",
        timeoutMs: modelTimeoutMs ?? options.timeoutMs,
        signal
      });
    } catch (error) {
      if (error?.code === "BUDGET_EXCEEDED" && syntaxAttempt > 0) {
        const overReason = error.details || budget?.exceeded?.() || options?.scope?.budget?.exceeded?.() || { reason: "budget_exceeded" };
        return {
          status: "stopped",
          reason: overReason,
          content: `Stopped: cost budget exceeded (${overReason.reason || "budget_exceeded"}).`,
          toolResults: [],
          messages: currentMessages,
          toolCallRepairs
        };
      }
      throw error;
    }
    // repair 期的模型调用同样计入每回合预算(budget 为 null 时行为与此前一致)。
    if (budget) budget.recordModelResult(modelResult);
    if (signal?.aborted) {
      throw abortFromSignal(signal);
    }
    eventBus?.publish?.("model:response", {
      turn_id: turnId,
      purpose: "repair",
      iteration: syntaxAttempt,
      content: modelResult.content || "",
      tool_call_count: modelResult.tool_calls?.length || 0,
      usage: modelResult.usage || null,
      model: modelResult.model,
      channel: modelResult.channel,
      ...repairResponseExtras(modelResult, effectiveSessionId)
    });

    rawToolCalls = modelResult.tool_calls || [];
    if (!rawToolCalls.length) {
      return {
        status: "complete",
        content: modelResult.content || "",
        toolResults: [],
        messages: currentMessages,
        toolCallRepairs
      };
    }

    // 整批预校验:全部工具通过语法与结构校验之前,绝不执行任何一个工具(P04)。
    try {
      toolCalls = adaptDeepSeekToolCalls(rawToolCalls, { requestedByStepId: `repair:${turnId}:${syntaxAttempt}` });
      break;
    } catch (error) {
      if (!isToolCallSyntaxError(error) || toolCallRepairs >= effectiveMaxToolCallRepairs) {
        throw error;
      }
      toolCallRepairs += 1;
      const conciseReason = sanitizeSyntaxRepairReason(error.message);
      eventBus?.publish?.("model:tool_call_repair", {
        turn_id: turnId,
        purpose: "repair",
        iteration: syntaxAttempt,
        attempt: toolCallRepairs,
        reason: conciseReason
      });
      const allowedNames = (toolSchemas || [])
        .map((s) => s?.function?.name)
        .filter(Boolean);
      const schemaHint = allowedNames.length ? ` Allowed tools: ${allowedNames.join(", ")}.` : "";
      currentMessages = [
        ...currentMessages,
        assistantToolCallMessage(modelResult, rawToolCalls),
        {
          role: "user",
          content: `Your previous tool call had invalid arguments (${conciseReason}). Re-issue the tool call with valid JSON arguments.${schemaHint}`
        }
      ];
    }
  }

  const toolResults = [];
  for (let index = 0; index < toolCalls.length; index += 1) {
    if (signal?.aborted) {
      throw abortFromSignal(signal);
    }
    const toolCall = toolCalls[index];
    const result = await executeTool(toolCall, createPolicyContext({ turnId, toolCall, phase: "repair" }));
    toolResults.push(result);
    if (result.status === "approval_required") {
      const budgetSnap = budget?.snapshot?.() || null;
      return {
        status: "awaiting_approval",
        content: result.content?.[0]?.text || "Approval required",
        approval: result.metadata?.approval || null,
        toolResults,
        toolCallRepairs,
        resume_state: {
          turn_id: turnId,
          message: options.message || "repair",
          classification: options.classification || { task_type: "edit" },
          messages: currentMessages,
          model_result: modelResult,
          raw_tool_calls: rawToolCalls,
          pending_tool_call: toolCall,
          remaining_tool_calls: toolCalls.slice(index + 1),
          iteration: 0,
          tool_results: toolResults.slice(0, -1),
          tool_schemas: toolSchemas,
          max_iterations: options.maxToolIterations || 5,
          tool_call_repairs: toolCallRepairs,
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
  }

  return {
    status: "complete",
    content: modelResult.content || "Repair tools executed.",
    toolResults,
    toolCallRepairs,
    messages: [...currentMessages, assistantToolCallMessage(modelResult, rawToolCalls), ...toolResultsToMessages(toolResults)]
  };
}

// 与 executor-loop.js 的 modelResponseExtras 等价——v1.9.0 M1 明确本文件保留
// 重复实现、不抽共享模块。model:response 四个新键一律「仅非 null 时附键」:
//   reasoning  : reasoning_content 截断 500 字符(超长结尾补「…」);
//   tps        : completion_tokens / (latency_ms/1000),1 位小数,缺项即不附;
//   session_id : sessionId 非空才附;
//   latency_ms : latency_ms 为有限数才附。
// cache hit/miss 与 reasoning tokens 不加顶层键,继续走 usage 子对象。
function repairResponseExtras(modelResult, sessionId) {
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
