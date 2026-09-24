import { adaptDeepSeekToolCalls } from "./tool-call-adapter.js";
import { toolResultsToMessages } from "./tool-result-router.js";

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
  permissionContext = null,
  options = {},
  budget = null
} = {}) {
  if (!modelGateway || typeof modelGateway.invoke !== "function") {
    throw new Error("modelGateway.invoke is required for repair executor");
  }
  if (typeof executeTool !== "function") throw new Error("executeTool is required");
  if (typeof createPolicyContext !== "function") throw new Error("createPolicyContext is required");

  eventBus?.publish?.("model:request", { turn_id: turnId, purpose: "repair", iteration: 0 });
  const modelResult = await modelGateway.invoke(messages, {
    ...options,
    purpose: "repair",
    tools: toolSchemas,
    toolChoice: "auto",
    timeoutMs: modelTimeoutMs ?? options.timeoutMs,
    signal
  });
  // repair 期的模型调用同样计入每回合预算(budget 为 null 时行为与此前一致)。
  if (budget) budget.recordModelResult(modelResult);
  eventBus?.publish?.("model:response", {
    turn_id: turnId,
    purpose: "repair",
    iteration: 0,
    content: modelResult.content || "",
    tool_call_count: modelResult.tool_calls?.length || 0,
    usage: modelResult.usage || null,
    model: modelResult.model,
    channel: modelResult.channel
  });

  const rawToolCalls = modelResult.tool_calls || [];
  if (!rawToolCalls.length) {
    return { status: "complete", content: modelResult.content || "", toolResults: [], messages };
  }

  const toolCalls = adaptDeepSeekToolCalls(rawToolCalls, { requestedByStepId: `repair:${turnId}:0` });
  const toolResults = [];
  for (let index = 0; index < toolCalls.length; index += 1) {
    const toolCall = toolCalls[index];
    const result = await executeTool(toolCall, createPolicyContext({ turnId, toolCall, phase: "repair" }));
    toolResults.push(result);
    if (result.status === "approval_required") {
      return {
        status: "awaiting_approval",
        content: result.content?.[0]?.text || "Approval required",
        approval: result.metadata?.approval || null,
        toolResults,
        resume_state: {
          turn_id: turnId,
          message: options.message || "repair",
          classification: options.classification || { task_type: "edit" },
          messages,
          model_result: modelResult,
          raw_tool_calls: rawToolCalls,
          pending_tool_call: toolCall,
          remaining_tool_calls: toolCalls.slice(index + 1),
          iteration: 0,
          tool_results: toolResults.slice(0, -1),
          tool_schemas: toolSchemas,
          max_iterations: options.maxToolIterations || 5,
          options: { ...options, purpose: "repair" },
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
    messages: [...messages, assistantToolCallMessage(modelResult, rawToolCalls), ...toolResultsToMessages(toolResults)]
  };
}

function assistantToolCallMessage(modelResult, rawToolCalls) {
  return {
    role: "assistant",
    content: modelResult.content || "",
    // DeepSeek 协议:带 tools 的请求必须完整回传历史每轮 assistant 消息的
    // reasoning_content,否则 HTTP 400。仅当上游确实返回了该字段(真字符串)时
    // 才附带,不用 undefined 占位键——旧 mock 不传该字段时行为逐字节不变。
    ...(modelResult.reasoning_content ? { reasoning_content: modelResult.reasoning_content } : {}),
    tool_calls: rawToolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: {
        name: call.name,
        arguments: call.raw_arguments || JSON.stringify(call.arguments || {})
      }
    }))
  };
}
