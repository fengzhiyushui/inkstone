import { assembleReplyMessages } from "../../deepseek/prompt-assembler.js";
import { toolResultsToMessages } from "./tool-result-router.js";
import {
  runToolCallCycle,
  runToolCallsInOrder,
  toolCallRepairPrompt,
  withBudgetSpent
} from "./execution-cycle.js";

// v1.19.2 补丁版(纯重构):执行循环骨架(模型调用/预算检查/事件发射/整批预校验与
// maxToolCallRepairs 有界重试/顺序执行工具与审批挂起)收敛到 execution-cycle.js。
// 本文件只保留 executor 场景差异:
//   - model:request 恒 purpose "act";model:response 与 invoke 首轮 "plan"、
//     其余 "act";
//   - 每轮迭代都查 budget?.exceeded(),stopped 返回带 iterations/toolResults;
//   - executor 版 assistantToolCallMessage(无容错映射,与 repair 版行为不同);
//   - executor 字段的 resume_state(turn_id/message/classification/messages/...);
//   - resumeExecutorLoop 的 resumeToolCallRepairs/effectiveMaxToolCallRepairs
//     归一化与 pendingAndRemaining 拼接逻辑原样保留。

const EXECUTOR_ABORT_MESSAGE = "Operation was aborted";

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

  const messages = assembleReplyMessages({
    message,
    classification,
    context,
    systemAddendum: "Use tools when needed. When tool results are sufficient, answer normally.",
    history: options.history
  });
  const toolResults = [];

  return runToolCallCycle({
    turnId,
    messages,
    modelGateway,
    eventBus,
    budget,
    signal,
    abortMessage: EXECUTOR_ABORT_MESSAGE,
    sessionId,
    maxToolCallRepairs,
    maxIterations,
    requestPurpose: "act",
    responsePurpose: (iteration) => (iteration === 0 ? "plan" : "act"),
    checkBudget: () => budget?.exceeded(),
    onBudgetExceeded: (over, ctx) => ({
      status: "stopped",
      reason: over,
      content: `Stopped: cost budget exceeded (${over.reason}).`,
      iterations: ctx.iteration,
      toolResults
    }),
    buildInvokeOptions: ({ iteration }) => ({
      purpose: iteration === 0 ? "plan" : "act",
      tools: toolSchemas,
      toolChoice: "auto",
      signal,
      ...options,
      timeoutMs: modelTimeoutMs ?? options.timeoutMs
    }),
    onComplete: (ctx, modelResult) => ({
      status: "complete",
      content: modelResult.content || "",
      iterations: ctx.iteration + 1,
      toolResults
    }),
    requestedByStepId: ({ iteration }) => `model:${turnId}:${iteration}`,
    onToolCallRepair: (ctx, error) => ({
      event: { turn_id: turnId, iteration: ctx.iteration, attempt: ctx.attempt, reason: error.message },
      message: toolCallRepairPrompt(error.message)
    }),
    buildAssistantMessage: assistantToolCallMessage,
    onToolCallsReady: async (ctx, modelResult, rawToolCalls, toolCalls) => {
      // 顺序执行工具(阶段 "execute");approval_required 时构造 executor 字段的
      // resume_state 并挂起,已耗预算经 withBudgetSpent 写入续跑种子。
      const next = await runToolCallsInOrder({
        toolCalls,
        turnId,
        executeTool,
        createPolicyContext,
        phase: "execute",
        signal,
        abortMessage: EXECUTOR_ABORT_MESSAGE,
        onResult: (result) => { toolResults.push(result); },
        onApproval: ({ result, toolCall, index, results }) => ({
          status: "awaiting_approval",
          content: result.content?.[0]?.text || "Approval required",
          approval: result.metadata?.approval || null,
          toolResults,
          iterations: ctx.iteration + 1,
          resume_state: {
            turn_id: turnId,
            message,
            classification,
            messages: ctx.messages,
            model_result: modelResult,
            raw_tool_calls: rawToolCalls,
            pending_tool_call: toolCall,
            remaining_tool_calls: toolCalls.slice(index + 1),
            iteration: ctx.iteration,
            tool_results: results.slice(0, -1),
            tool_schemas: toolSchemas,
            max_iterations: maxIterations,
            tool_call_repairs: ctx.toolCallRepairs,
            max_tool_call_repairs: maxToolCallRepairs,
            options,
            context,
            permission_context: permissionContext,
            ...(result.metadata?.task_delegation ? { task_delegation: result.metadata.task_delegation } : {})
          }
        })
      });
      if (next.status === "awaiting_approval") {
        return { kind: "result", result: { ...next, resume_state: withBudgetSpent(next.resume_state, budget) } };
      }
      return {
        kind: "continue",
        messages: [
          ...ctx.messages,
          assistantToolCallMessage(modelResult, rawToolCalls),
          ...toolResultsToMessages(next.results)
        ]
      };
    },
    onExhausted: () => { throw new Error(`maximum tool iterations exceeded: ${maxIterations}`); }
  });
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

  // 续跑的修复计数归一化:resume_state 里的有效值优先,否则回退入参。
  let resumeToolCallRepairs = Number.isFinite(resumeState.tool_call_repairs) && resumeState.tool_call_repairs >= 0
    ? resumeState.tool_call_repairs
    : 0;
  const effectiveMaxToolCallRepairs = Number.isFinite(resumeState.max_tool_call_repairs) && resumeState.max_tool_call_repairs >= 0
    ? resumeState.max_tool_call_repairs
    : maxToolCallRepairs;

  const iterationResults = [];
  const toolResults = [...(resumeState.tool_results || [])];
  const pendingAndRemaining = [
    resumeState.pending_tool_call,
    ...(resumeState.remaining_tool_calls || [])
  ].filter(Boolean);

  // 先跑完暂停点的 pending + remaining(阶段 "resume");再次审批挂起时
  // remaining 从当前下标之后重新切片,resume_state 字段与首暂停一致。
  const pending = await runToolCallsInOrder({
    toolCalls: pendingAndRemaining,
    turnId: resumeState.turn_id,
    executeTool,
    createPolicyContext,
    phase: "resume",
    signal,
    abortMessage: EXECUTOR_ABORT_MESSAGE,
    onResult: (result) => {
      iterationResults.push(result);
      toolResults.push(result);
    },
    onApproval: ({ result, toolCall, index }) => ({
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
        tool_call_repairs: resumeToolCallRepairs,
        max_tool_call_repairs: effectiveMaxToolCallRepairs,
        options: resumeState.options || {},
        context: resumeState.context || null,
        permission_context: resumeState.permission_context || resumeState.options?.permission_context || null,
        ...(result.metadata?.task_delegation ? { task_delegation: result.metadata.task_delegation } : {})
      }
    })
  });
  if (pending.status === "awaiting_approval") {
    return { ...pending, resume_state: withBudgetSpent(pending.resume_state, budget) };
  }

  const messages = [
    ...resumeState.messages,
    assistantToolCallMessage(resumeState.model_result, resumeState.raw_tool_calls),
    ...toolResultsToMessages([...resumeState.tool_results, ...iterationResults])
  ];

  return runToolCallCycle({
    turnId: resumeState.turn_id,
    messages,
    modelGateway,
    eventBus,
    budget,
    signal,
    abortMessage: EXECUTOR_ABORT_MESSAGE,
    sessionId,
    maxToolCallRepairs: effectiveMaxToolCallRepairs,
    initialToolCallRepairs: resumeToolCallRepairs,
    startIteration: resumeState.iteration + 1,
    maxIterations: resumeState.max_iterations || 5,
    requestPurpose: "act",
    responsePurpose: "act",
    checkBudget: () => budget?.exceeded(),
    onBudgetExceeded: (over, ctx) => ({
      status: "stopped",
      reason: over,
      content: `Stopped: cost budget exceeded (${over.reason}).`,
      iterations: ctx.iteration,
      toolResults
    }),
    buildInvokeOptions: () => ({
      purpose: "act",
      tools: resumeState.tool_schemas || [],
      toolChoice: "auto",
      signal,
      ...(resumeState.options || {}),
      timeoutMs: modelTimeoutMs ?? resumeState.options?.timeoutMs
    }),
    onComplete: (ctx, modelResult) => ({
      status: "complete",
      content: modelResult.content || "",
      iterations: ctx.iteration + 1,
      toolResults
    }),
    requestedByStepId: ({ iteration }) => `model:${resumeState.turn_id}:${iteration}`,
    onToolCallRepair: (ctx, error) => ({
      event: {
        turn_id: resumeState.turn_id,
        iteration: ctx.iteration,
        attempt: ctx.attempt,
        reason: error.message
      },
      message: toolCallRepairPrompt(error.message)
    }),
    buildAssistantMessage: assistantToolCallMessage,
    onToolCallsReady: async (ctx, modelResult, rawToolCalls, toolCalls) => {
      // 顺序执行工具(阶段 "execute");resume 后的再次挂起同样套 withBudgetSpent。
      const next = await runToolCallsInOrder({
        toolCalls,
        turnId: resumeState.turn_id,
        executeTool,
        createPolicyContext,
        phase: "execute",
        signal,
        abortMessage: EXECUTOR_ABORT_MESSAGE,
        onResult: (result) => { toolResults.push(result); },
        onApproval: ({ result, toolCall, index, results }) => ({
          status: "awaiting_approval",
          content: result.content?.[0]?.text || "Approval required",
          approval: result.metadata?.approval || null,
          toolResults,
          iterations: ctx.iteration + 1,
          resume_state: {
            turn_id: resumeState.turn_id,
            message: resumeState.message,
            classification: resumeState.classification,
            messages: ctx.messages,
            model_result: modelResult,
            raw_tool_calls: rawToolCalls,
            pending_tool_call: toolCall,
            remaining_tool_calls: toolCalls.slice(index + 1),
            iteration: ctx.iteration,
            tool_results: results.slice(0, -1),
            tool_schemas: resumeState.tool_schemas || [],
            max_iterations: resumeState.max_iterations || 5,
            tool_call_repairs: ctx.toolCallRepairs,
            max_tool_call_repairs: effectiveMaxToolCallRepairs,
            options: resumeState.options || {},
            context: resumeState.context || null,
            permission_context: resumeState.permission_context || resumeState.options?.permission_context || null,
            ...(result.metadata?.task_delegation ? { task_delegation: result.metadata.task_delegation } : {})
          }
        })
      });
      if (next.status === "awaiting_approval") {
        return { kind: "result", result: { ...next, resume_state: withBudgetSpent(next.resume_state, budget) } };
      }
      return {
        kind: "continue",
        messages: [
          ...ctx.messages,
          assistantToolCallMessage(modelResult, rawToolCalls),
          ...toolResultsToMessages(next.results)
        ]
      };
    },
    onExhausted: () => { throw new Error(`maximum tool iterations exceeded: ${resumeState.max_iterations || 5}`); }
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
