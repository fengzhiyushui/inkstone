import { assembleReplyMessages } from "../../deepseek/prompt-assembler.js";
import { adaptDeepSeekToolCalls } from "./tool-call-adapter.js";
import { toolResultsToMessages } from "./tool-result-router.js";

export async function runExecutorLoop({
  message,
  classification,
  turnId,
  sessionId = null,
  modelGateway,
  toolSchemas = [],
  executeTool,
  createPolicyContext,
  eventBus = null,
  signal = null,
  maxIterations = 5,
  context = null,
  budget = null,
  modelTimeoutMs = null,
  maxToolCallRepairs = 0,
  permissionContext = null,
  options = {}
} = {}) {
  if (!modelGateway || typeof modelGateway.invoke !== "function") {
    throw new Error("modelGateway.invoke is required for executor loop");
  }
  if (typeof executeTool !== "function") throw new Error("executeTool is required");
  if (typeof createPolicyContext !== "function") throw new Error("createPolicyContext is required");

  let messages = assembleReplyMessages({
    message,
    classification,
    context,
    systemAddendum: "Use tools when needed. When tool results are sufficient, answer normally.",
    history: options.history
  });
  const toolResults = [];
  let toolCallRepairs = 0;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const over = budget?.exceeded();
    if (over) {
      return { status: "stopped", reason: over, content: `Stopped: cost budget exceeded (${over.reason}).`, iterations: iteration, toolResults };
    }
    eventBus?.publish?.("model:request", { turn_id: turnId, purpose: "act", iteration });
    const modelResult = await modelGateway.invoke(messages, {
      purpose: iteration === 0 ? "plan" : "act",
      tools: toolSchemas,
      toolChoice: "auto",
      signal,
      ...options,
      timeoutMs: modelTimeoutMs ?? options.timeoutMs
    });
    if (budget) budget.recordModelResult(modelResult);
    eventBus?.publish?.("model:response", {
      turn_id: turnId,
      purpose: iteration === 0 ? "plan" : "act",
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
      return {
        status: "complete",
        content: modelResult.content || "",
        iterations: iteration + 1,
        toolResults
      };
    }

    let toolCalls;
    try {
      toolCalls = adaptDeepSeekToolCalls(rawToolCalls, { requestedByStepId: `model:${turnId}:${iteration}` });
    } catch (error) {
      if (toolCallRepairs >= maxToolCallRepairs) throw error;
      toolCallRepairs += 1;
      eventBus?.publish?.("model:tool_call_repair", { turn_id: turnId, iteration, attempt: toolCallRepairs, reason: error.message });
      messages = [
        ...messages,
        assistantToolCallMessage(modelResult, rawToolCalls),
        { role: "user", content: `Your previous tool call had invalid arguments (${error.message}). Re-issue the tool call with valid JSON arguments.` }
      ];
      continue;
    }
    const next = await continueToolIteration({
      turnId,
      message,
      classification,
      messages,
      modelResult,
      rawToolCalls,
      toolCalls,
      iteration,
      toolResults,
      toolSchemas,
      maxIterations,
      options,
      context,
      permissionContext,
      executeTool,
      createPolicyContext
    });
    if (next.status === "awaiting_approval") {
      return { ...next, resume_state: withBudgetSpent(next.resume_state, budget) };
    }
    messages = [
      ...messages,
      assistantToolCallMessage(modelResult, rawToolCalls),
      ...toolResultsToMessages(next.iterationResults)
    ];
  }

  throw new Error(`maximum tool iterations exceeded: ${maxIterations}`);
}

// 暂停时把已消耗的预算(不计 max)写入 resume_state,续跑时按 spent 续扣,
// 避免审批暂停/续跑重置每回合 token/调用次数预算。
function withBudgetSpent(resumeState, budget) {
  if (!resumeState || !budget?.snapshot) return resumeState;
  const spent = budget.snapshot();
  return { ...resumeState, budget_spent: { tokens: spent.tokens, model_calls: spent.model_calls } };
}

// v1.9.0 M1 契约冻结:model:response 顶层键集一次定稿。既有八键
// {turn_id,purpose,iteration,content,tool_call_count,usage,model,channel}
// 逐字节不动;本 helper 产出的四个新键一律「仅非 null 时附键」(不用 undefined
// 占位),旧 mock/旧时间线因此逐字节兼容。cache hit/miss 与 reasoning tokens
// 不加顶层键,继续走 usage 子对象。
//   reasoning  : modelResult.reasoning_content 截断 500 字符(超长结尾补「…」);
//   tps        : usage.completion_tokens / (latency_ms/1000),保留 1 位小数,
//                缺 usage/latency 或 latency<=0 时不附键;
//   session_id : sessionId 非空才附;
//   latency_ms : modelResult.latency_ms 为有限数才附。
function modelResponseExtras(modelResult, sessionId) {
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

async function continueToolIteration({
  turnId,
  message,
  classification,
  messages,
  modelResult,
  rawToolCalls,
  toolCalls,
  iteration,
  toolResults,
  toolSchemas,
  maxIterations,
  options,
  context,
  permissionContext,
  executeTool,
  createPolicyContext
}) {
  const iterationResults = [];
  for (let index = 0; index < toolCalls.length; index += 1) {
    const toolCall = toolCalls[index];
    const policyContext = createPolicyContext({ turnId, toolCall, phase: "execute" });
    const result = await executeTool(toolCall, policyContext);
    iterationResults.push(result);
    toolResults.push(result);
    if (result.status === "approval_required") {
      return {
        status: "awaiting_approval",
        content: result.content?.[0]?.text || "Approval required",
        approval: result.metadata?.approval || null,
        toolResults,
        iterations: iteration + 1,
        resume_state: {
          turn_id: turnId,
          message,
          classification,
          messages,
          model_result: modelResult,
          raw_tool_calls: rawToolCalls,
          pending_tool_call: toolCall,
          remaining_tool_calls: toolCalls.slice(index + 1),
          iteration,
          tool_results: iterationResults.slice(0, -1),
          tool_schemas: toolSchemas,
          max_iterations: maxIterations,
          options,
          context,
          permission_context: permissionContext
        }
      };
    }
  }
  return { status: "continued", iterationResults };
}

export async function resumeExecutorLoop({
  resumeState,
  modelGateway,
  executeTool,
  createPolicyContext,
  eventBus = null,
  signal = null,
  budget = null,
  modelTimeoutMs = null,
  maxToolCallRepairs = 0,
  sessionId = null
} = {}) {
  if (!resumeState) throw new Error("resumeState is required");
  if (!modelGateway || typeof modelGateway.invoke !== "function") {
    throw new Error("modelGateway.invoke is required for executor loop resume");
  }
  if (typeof executeTool !== "function") throw new Error("executeTool is required");
  if (typeof createPolicyContext !== "function") throw new Error("createPolicyContext is required");

  const iterationResults = [];
  const toolResults = [...(resumeState.tool_results || [])];
  const pendingAndRemaining = [
    resumeState.pending_tool_call,
    ...(resumeState.remaining_tool_calls || [])
  ].filter(Boolean);

  for (let index = 0; index < pendingAndRemaining.length; index += 1) {
    const toolCall = pendingAndRemaining[index];
    const policyContext = createPolicyContext({ turnId: resumeState.turn_id, toolCall, phase: "resume" });
    const result = await executeTool(toolCall, policyContext);
    iterationResults.push(result);
    toolResults.push(result);
    if (result.status === "approval_required") {
      return {
        status: "awaiting_approval",
        content: result.content?.[0]?.text || "Approval required",
        approval: result.metadata?.approval || null,
        toolResults,
        iterations: resumeState.iteration + 1,
        resume_state: {
          turn_id: resumeState.turn_id,
          message: resumeState.message,
          classification: resumeState.classification,
          messages: resumeState.messages,
          model_result: resumeState.model_result,
          raw_tool_calls: resumeState.raw_tool_calls,
          pending_tool_call: toolCall,
          remaining_tool_calls: pendingAndRemaining.slice(index + 1),
          iteration: resumeState.iteration,
          tool_results: toolResults.slice(0, -1),
          tool_schemas: resumeState.tool_schemas || [],
          max_iterations: resumeState.max_iterations || 5,
          options: resumeState.options || {},
          context: resumeState.context || null,
          permission_context: resumeState.permission_context || resumeState.options?.permission_context || null
        }
      };
    }
  }

  let messages = [
    ...resumeState.messages,
    assistantToolCallMessage(resumeState.model_result, resumeState.raw_tool_calls),
    ...toolResultsToMessages([...resumeState.tool_results, ...iterationResults])
  ];

  let resumeToolCallRepairs = 0;
  for (let iteration = resumeState.iteration + 1; iteration < (resumeState.max_iterations || 5); iteration += 1) {
    const over = budget?.exceeded();
    if (over) {
      return { status: "stopped", reason: over, content: `Stopped: cost budget exceeded (${over.reason}).`, iterations: iteration, toolResults };
    }
    eventBus?.publish?.("model:request", { turn_id: resumeState.turn_id, purpose: "act", iteration });
    const modelResult = await modelGateway.invoke(messages, {
      purpose: "act",
      tools: resumeState.tool_schemas || [],
      toolChoice: "auto",
      signal,
      ...(resumeState.options || {}),
      timeoutMs: modelTimeoutMs ?? resumeState.options?.timeoutMs
    });
    if (budget) budget.recordModelResult(modelResult);
    eventBus?.publish?.("model:response", {
      turn_id: resumeState.turn_id,
      purpose: "act",
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
      return { status: "complete", content: modelResult.content || "", iterations: iteration + 1, toolResults };
    }
    let toolCalls;
    try {
      toolCalls = adaptDeepSeekToolCalls(rawToolCalls, { requestedByStepId: `model:${resumeState.turn_id}:${iteration}` });
    } catch (error) {
      if (resumeToolCallRepairs >= maxToolCallRepairs) throw error;
      resumeToolCallRepairs += 1;
      eventBus?.publish?.("model:tool_call_repair", { turn_id: resumeState.turn_id, iteration, attempt: resumeToolCallRepairs, reason: error.message });
      messages = [
        ...messages,
        assistantToolCallMessage(modelResult, rawToolCalls),
        { role: "user", content: `Your previous tool call had invalid arguments (${error.message}). Re-issue the tool call with valid JSON arguments.` }
      ];
      continue;
    }
    const next = await continueToolIteration({
      turnId: resumeState.turn_id,
      message: resumeState.message,
      classification: resumeState.classification,
      messages,
      modelResult,
      rawToolCalls,
      toolCalls,
      iteration,
      toolResults,
      toolSchemas: resumeState.tool_schemas || [],
      maxIterations: resumeState.max_iterations || 5,
      options: resumeState.options || {},
      context: resumeState.context || null,
      permissionContext: resumeState.permission_context || resumeState.options?.permission_context || null,
      executeTool,
      createPolicyContext
    });
    if (next.status === "awaiting_approval") {
      return { ...next, resume_state: withBudgetSpent(next.resume_state, budget) };
    }
    messages = [...messages, assistantToolCallMessage(modelResult, rawToolCalls), ...toolResultsToMessages(next.iterationResults)];
  }

  throw new Error(`maximum tool iterations exceeded: ${resumeState.max_iterations || 5}`);
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
