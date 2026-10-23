import { makeId } from "../../shared/id.js";
import { redactSecrets } from "../../security/redactor.js";
import { createPausedTurnStore } from "../approval/paused-turn-store.js";
import { createToolResult } from "../protocol/index.js";
import {
  TASK_DELEGATION_SCHEMA_VERSION,
  TASK_DELEGATION_FINGERPRINTS,
  TASK_PAUSED_STATES,
  FORBIDDEN_TASK_TOOLS,
  MAX_TASK_DEPTH,
  MAX_TASK_SUBTASKS_PER_TURN,
  MAX_TASK_RESULT_CHARS,
  clampChildAutonomy,
  validateTaskParams,
  authorizeTaskTools,
  taskDelegationResumeGate
} from "./task-delegation-contract.js";

function createAbortError(reason) {
  if (reason instanceof Error) {
    if (reason.name === "AbortError" || reason.code === "INTERRUPTED") return reason;
  }
  const message = typeof reason === "string" && reason
    ? reason
    : (reason instanceof Error ? reason.message : "Task delegation was cancelled");
  const err = new Error(message);
  err.name = "AbortError";
  err.code = "ABORT_ERR";
  return err;
}

function sanitizeAndBoundResultText(rawText) {
  const redacted = redactSecrets(String(rawText ?? ""));
  if (redacted.length <= MAX_TASK_RESULT_CHARS) {
    return { text: redacted, truncated: false };
  }
  return {
    text: `${redacted.slice(0, MAX_TASK_RESULT_CHARS)}\n...[truncated]`,
    truncated: true
  };
}

export function createTaskDelegationService({
  createRuntime,
  toolRegistry,
  toolExecutor,
  modelGateway,
  eventBus = null,
  sessionId = null,
  projectId = null,
  projectRoot = null,
  taskPausedPersistence = null,
  grantApprovalForToolCall = async () => {}
} = {}) {
  if (typeof createRuntime !== "function") {
    throw new Error("createRuntime is required for taskDelegationService");
  }
  if (!toolRegistry) {
    throw new Error("toolRegistry is required for taskDelegationService");
  }
  if (!toolExecutor) {
    throw new Error("toolExecutor is required for taskDelegationService");
  }

  // Instance-scoped registries (T10: never shared across kernels)
  const activeChildren = new Map(); // childId -> { controller, runtime }
  const pausedChildren = new Map(); // approvalId -> pausedEntry
  const turnSubtaskCounts = new Map(); // parentTurnId -> number

  function linkAbortSignal(signals = []) {
    const validSignals = signals.filter(Boolean);
    const controller = new AbortController();
    const listeners = [];
    for (const sig of validSignals) {
      if (sig.aborted) {
        controller.abort(sig.reason);
        break;
      }
      const onAbort = () => controller.abort(sig.reason);
      sig.addEventListener("abort", onAbort, { once: true });
      listeners.push([sig, onAbort]);
    }
    return {
      controller,
      signal: controller.signal,
      cleanup() {
        for (const [sig, onAbort] of listeners) {
          sig.removeEventListener("abort", onAbort);
        }
      }
    };
  }

  function buildChildRuntime({
    childId,
    authorizedTools,
    childAutonomy,
    parentSessionId,
    parentTurnId,
    parentToolCallId,
    parentExecutionId,
    parentScope = null,
    parentBudget = null,
    parentOptions = {},
    childPausedTurnStore = createPausedTurnStore(),
    childSignal = null
  }) {
    const allowedSet = new Set(authorizedTools);

    // Filter schemas strictly to authorized tools and never expose task/ask_user (T05)
    const childToolSchemas = () => {
      const allSchemas = toolRegistry.toDeepSeekTools();
      return allSchemas.filter((schema) => {
        const name = schema?.function?.name;
        return typeof name === "string" && allowedSet.has(name) && !FORBIDDEN_TASK_TOOLS.has(name);
      });
    };

    // Execution-time guard: block forged 'task' or any unauthorized tool before ToolExecutor (T03, T05)
    const childExecuteTool = async (call, policyContext = {}) => {
      if (childSignal?.aborted) {
        throw createAbortError(childSignal.reason);
      }
      const toolName = call?.name;
      if (FORBIDDEN_TASK_TOOLS.has(toolName) || !allowedSet.has(toolName)) {
        const denyReason = FORBIDDEN_TASK_TOOLS.has(toolName)
          ? `Nested tool "${toolName}" is forbidden inside a delegated task worker`
          : `Tool "${toolName}" is not in the delegated tool allowlist (${authorizedTools.join(", ")})`;
        const permission = {
          decision: "deny",
          matched_rule: FORBIDDEN_TASK_TOOLS.has(toolName) ? "task:no-recursion" : "task:tool-allowlist",
          source: "task-delegation-guard"
        };
        eventBus?.publish?.("permission:decision", {
          call_id: call?.id || "call_unknown",
          tool: toolName || "unknown",
          category: call?.category || "execute",
          permission
        });
        const deniedResult = createToolResult({
          callId: call?.id || "call_unknown",
          status: "denied",
          content: [{ type: "error", text: `Permission denied: ${denyReason}` }],
          metadata: { permission, child_id: childId },
          durationMs: 0
        });
        eventBus?.publish?.("tool:result", { result: deniedResult });
        return deniedResult;
      }

      return toolExecutor.execute(call, {
        ...policyContext,
        autonomy: clampChildAutonomy(childAutonomy, policyContext.autonomy),
        taskDelegationDepth: 1,
        parentTurnId,
        parentToolCallId,
        childId,
        signal: childSignal || policyContext.signal
      });
    };

    // Bind modelGateway to parent's RequestScope/RequestBudget AND parent's local CostBudget (B03, T11, T16)
    const baseGateway = parentOptions.modelGateway || modelGateway;
    const childScope = parentScope?.createChild
      ? parentScope.createChild({ signal: childSignal })
      : parentScope;
    const scopeBoundGateway = (childScope?.bindGateway && baseGateway && !baseGateway._isDeepSeekGateway)
      ? childScope.bindGateway(baseGateway, { role: "task", subtaskId: childId })
      : baseGateway;

    const childGateway = scopeBoundGateway ? {
      ...scopeBoundGateway,
      invoke: async (messages, invokeOpts = {}) => {
        if (childSignal?.aborted || invokeOpts.signal?.aborted) {
          throw createAbortError(childSignal?.reason || invokeOpts.signal?.reason);
        }
        const overLocal = parentBudget?.exceeded?.();
        const overScope = childScope?.budget?.exceeded?.();
        const over = overLocal || overScope;
        if (over) {
          const err = new Error(`cost budget exceeded: ${over.reason || "budget_exceeded"}`);
          err.code = "BUDGET_EXCEEDED";
          err.details = over;
          throw err;
        }
        const res = await scopeBoundGateway.invoke(messages, {
          ...invokeOpts,
          scope: childScope || invokeOpts.scope,
          role: "task",
          subtaskId: childId,
          signal: childSignal || invokeOpts.signal
        });
        if (parentBudget?.recordModelResult) {
          parentBudget.recordModelResult(res);
        }
        if (childSignal?.aborted || invokeOpts.signal?.aborted) {
          throw createAbortError(childSignal?.reason || invokeOpts.signal?.reason);
        }
        return res;
      },
      reply: typeof scopeBoundGateway.reply === "function"
        ? async (replyInput = {}) => {
            if (childSignal?.aborted || replyInput.signal?.aborted) {
              throw createAbortError(childSignal?.reason || replyInput.signal?.reason);
            }
            return scopeBoundGateway.reply({
              ...replyInput,
              signal: childSignal || replyInput.signal,
              options: {
                ...(replyInput.options || {}),
                scope: childScope || replyInput.options?.scope,
                role: "task",
                subtaskId: childId
              }
            });
          }
        : undefined
    } : null;

    const childRuntime = createRuntime({
      sessionId: parentSessionId || sessionId,
      projectId,
      projectRoot,
      modelGateway: childGateway,
      toolSchemas: childToolSchemas,
      executeTool: childExecuteTool,
      pausedTurnStore: childPausedTurnStore,
      pausedTurnPersistence: null, // Child pause is persisted via taskPausedPersistence with parent-child state machine
      verifyMode: "off", // Subtask worker returns tool outputs directly to parent turn, which handles verification
      grantApprovalForToolCall
    });

    return {
      childRuntime,
      childPausedTurnStore,
      childScope
    };
  }

  function formatCompletedChildOutput(childRes, { childId, authorizedTools }) {
    const toolResults = childRes.toolResults || [];
    const rawContent = String(childRes.content || "").trim();
    const toolSnippets = toolResults
      .map((tr) => (tr.content || []).map((c) => c?.text || "").filter(Boolean).join("\n"))
      .filter(Boolean);

    const hasSuccessfulTool = toolResults.some((tr) => tr.status === "success");
    const allToolsFailed = toolResults.length > 0 && toolResults.every((tr) => tr.status === "error" || tr.status === "denied");

    if (allToolsFailed && !rawContent) {
      const errText = toolSnippets.join("\n") || "Task worker tool execution failed";
      const bounded = sanitizeAndBoundResultText(errText);
      return {
        status: "error",
        content: [{ type: "error", text: bounded.text }],
        metadata: {
          status: "failed",
          child_id: childId,
          delegated_tools: authorizedTools,
          ...(bounded.truncated ? { truncated: true } : {})
        }
      };
    }

    if (!rawContent && !hasSuccessfulTool) {
      return {
        status: "error",
        content: [{ type: "error", text: "Task worker produced no result" }],
        metadata: {
          status: "failed",
          child_id: childId,
          delegated_tools: authorizedTools,
          code: "TASK_EMPTY_RESULT"
        }
      };
    }

    const combinedText = rawContent || toolSnippets.join("\n");
    const bounded = sanitizeAndBoundResultText(combinedText);
    return {
      status: "success",
      content: [{ type: "text", text: bounded.text }],
      metadata: {
        status: "completed",
        child_id: childId,
        delegated_tools: authorizedTools,
        ...(bounded.truncated ? { truncated: true } : {})
      }
    };
  }

  async function runTask(params = {}, context = {}) {
    if (context.taskDelegationResume) {
      return resumeTask(context.taskDelegationResume, context);
    }

    const currentDepth = Number(context.taskDelegationDepth || 0);
    if (currentDepth >= MAX_TASK_DEPTH) {
      return {
        status: "denied",
        content: [{ type: "error", text: "Permission denied: nested task delegation is forbidden (max depth 1)" }],
        metadata: { status: "denied", code: "TASK_DEPTH_EXCEEDED" }
      };
    }

    const paramCheck = validateTaskParams(params);
    if (!paramCheck.ok) {
      return {
        status: "error",
        content: [{ type: "error", text: paramCheck.error }],
        metadata: { status: "error", code: paramCheck.code }
      };
    }

    const parentAutonomy = context.autonomy || "gated";
    const parentToolNames = Array.isArray(context.parentToolNames) ? context.parentToolNames : null;
    const authCheck = authorizeTaskTools({
      requestedTools: paramCheck.tools,
      explicitTools: paramCheck.explicitTools,
      parentToolNames,
      registry: toolRegistry,
      parentAutonomy
    });
    if (!authCheck.ok) {
      return {
        status: authCheck.status || "error",
        content: [{ type: "error", text: authCheck.error }],
        metadata: { status: authCheck.status || "error", code: authCheck.code }
      };
    }

    const authorizedTools = authCheck.tools;
    const childAutonomy = clampChildAutonomy(parentAutonomy, context.autonomy);
    const parentTurnId = context.turnId || "turn_unknown";
    const parentToolCallId = context.toolCall?.id || makeId("call_task");
    const parentSessionId = context.sessionId || sessionId || "sess_unknown";
    const parentScope = context.scope || context.parentOptions?.scope || null;
    const parentExecutionId = parentScope?.executionId || context.executionId || parentTurnId;
    const parentBudget = context.parentBudget || null;

    // Enforce per-turn subtask count limit
    const usedSubtasks = turnSubtaskCounts.get(parentTurnId) || 0;
    if (usedSubtasks >= MAX_TASK_SUBTASKS_PER_TURN) {
      return {
        status: "error",
        content: [{ type: "error", text: `Task delegation limit exceeded for turn (max ${MAX_TASK_SUBTASKS_PER_TURN})` }],
        metadata: { status: "failed", code: "TASK_SUBTASK_LIMIT_EXCEEDED" }
      };
    }

    // Pre-check shared local and aggregate budgets before spawning child worker (T16)
    const preBudgetOver = parentBudget?.exceeded?.() || parentScope?.budget?.exceeded?.();
    if (preBudgetOver) {
      return {
        status: "error",
        content: [{ type: "error", text: `Task delegation rejected: budget exceeded (${preBudgetOver.reason || "budget_exceeded"})` }],
        metadata: {
          status: "failed",
          code: "BUDGET_EXCEEDED",
          reason: preBudgetOver.reason || "budget_exceeded"
        }
      };
    }

    turnSubtaskCounts.set(parentTurnId, usedSubtasks + 1);
    const childId = makeId("task_child");
    const linked = linkAbortSignal([context.signal, parentScope?.signal]);
    const childPausedTurnStore = createPausedTurnStore();
    const { childRuntime, childScope } = buildChildRuntime({
      childId,
      authorizedTools,
      childAutonomy,
      parentSessionId,
      parentTurnId,
      parentToolCallId,
      parentExecutionId,
      parentScope,
      parentBudget,
      parentOptions: context.parentOptions || {},
      childPausedTurnStore,
      childSignal: linked.signal
    });

    activeChildren.set(childId, { controller: linked.controller, runtime: childRuntime });
    try {
      if (linked.signal.aborted) {
        throw createAbortError(linked.signal.reason);
      }

      const childMarker = {
        schema_version: TASK_DELEGATION_SCHEMA_VERSION,
        child_id: childId,
        parent_execution_id: parentExecutionId,
        parent_session_id: parentSessionId,
        parent_turn_id: parentTurnId,
        parent_tool_call_id: parentToolCallId,
        delegated_tools: authorizedTools,
        autonomy: childAutonomy,
        depth: currentDepth + 1
      };

      const childRes = await childRuntime.send(paramCheck.prompt, {
        autonomy: childAutonomy,
        forceToolLoop: true,
        signal: linked.signal,
        scope: childScope,
        projectRules: context.projectRules || [],
        trustStore: context.trustStore || { rules: [] },
        memoryRoot: context.memoryRoot ?? null,
        maxToolCallRepairs: context.parentOptions?.maxToolCallRepairs,
        modelTimeoutMs: context.parentOptions?.modelTimeoutMs,
        __task_child: childMarker
      });

      if (linked.signal.aborted) {
        throw createAbortError(linked.signal.reason);
      }

      if (childRes.status === "awaiting_approval" && childRes.approval?.id) {
        const approvalId = childRes.approval.id;
        const childRecord = childPausedTurnStore.get(approvalId);
        const taskDelegation = {
          schema_version: TASK_DELEGATION_SCHEMA_VERSION,
          fingerprints: { ...TASK_DELEGATION_FINGERPRINTS },
          child_id: childId,
          approval_id: approvalId,
          parent_execution_id: parentExecutionId,
          parent_session_id: parentSessionId,
          parent_turn_id: parentTurnId,
          parent_tool_call_id: parentToolCallId,
          delegated_tools: authorizedTools,
          autonomy: childAutonomy,
          depth: currentDepth + 1,
          state: TASK_PAUSED_STATES.PAUSED_PERSISTED
        };

        if (taskPausedPersistence) {
          await taskPausedPersistence.save(approvalId, {
            schema_version: TASK_DELEGATION_SCHEMA_VERSION,
            fingerprints: { ...TASK_DELEGATION_FINGERPRINTS },
            approval_id: approvalId,
            child_id: childId,
            state: TASK_PAUSED_STATES.CHILD_PAUSED_AWAITING_PARENT_PERSIST,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            parent: {
              execution_id: parentExecutionId,
              session_id: parentSessionId,
              turn_id: parentTurnId,
              tool_call_id: parentToolCallId,
              autonomy: childAutonomy,
              delegated_tools: authorizedTools,
              depth: currentDepth + 1
            },
            child_record: childRecord
          });
        }

        pausedChildren.set(approvalId, {
          approvalId,
          childId,
          childRuntime,
          childPausedTurnStore,
          childRecord,
          taskDelegation,
          authorizedTools,
          childAutonomy,
          parentSessionId,
          parentTurnId,
          parentToolCallId,
          parentExecutionId,
          parentScope,
          parentOptions: context.parentOptions || {},
          state: TASK_PAUSED_STATES.CHILD_PAUSED_AWAITING_PARENT_PERSIST
        });

        return {
          status: "approval_required",
          content: [{ type: "text", text: childRes.approval.summary || "Task child tool requires approval" }],
          metadata: {
            approval: childRes.approval,
            child_id: childId,
            delegated_tools: authorizedTools,
            task_delegation: taskDelegation
          }
        };
      }

      if (childRes.status === "stopped") {
        return {
          status: "error",
          content: [{ type: "error", text: childRes.content || "Task worker stopped due to cost budget" }],
          metadata: {
            status: "failed",
            code: "BUDGET_EXCEEDED",
            child_id: childId,
            delegated_tools: authorizedTools
          }
        };
      }

      if (childRes.status !== "complete") {
        return {
          status: "error",
          content: [{ type: "error", text: childRes.content || `Task worker ended with status: ${childRes.status}` }],
          metadata: {
            status: "failed",
            child_id: childId,
            delegated_tools: authorizedTools
          }
        };
      }

      return formatCompletedChildOutput(childRes, { childId, authorizedTools });
    } catch (error) {
      if (error?.code === "RECOVERY_FAULT") {
        throw error;
      }
      if (linked.signal.aborted || error?.name === "AbortError" || error?.code === "INTERRUPTED") {
        try { childRuntime.interrupt?.(); } catch {}
        throw createAbortError(linked.signal.reason || error);
      }
      if (error?.code === "BUDGET_EXCEEDED") {
        return {
          status: "error",
          content: [{ type: "error", text: `Task worker stopped: ${error.message}` }],
          metadata: {
            status: "failed",
            code: "BUDGET_EXCEEDED",
            child_id: childId,
            delegated_tools: authorizedTools
          }
        };
      }
      const bounded = sanitizeAndBoundResultText(error?.message || "Task delegation failed");
      return {
        status: "error",
        content: [{ type: "error", text: bounded.text }],
        metadata: {
          status: "failed",
          child_id: childId,
          delegated_tools: authorizedTools
        }
      };
    } finally {
      activeChildren.delete(childId);
      linked.cleanup();
    }
  }

  async function markParentPausePersisted(approvalId) {
    const entry = pausedChildren.get(approvalId);
    if (entry) {
      entry.state = TASK_PAUSED_STATES.PAUSED_PERSISTED;
    }
    if (taskPausedPersistence) {
      await taskPausedPersistence.updateState(approvalId, {
        state: TASK_PAUSED_STATES.PAUSED_PERSISTED
      });
    }
  }

  function rehydrateTaskDelegation({ parentRecord, childSidecar, mode }) {
    const approvalId = parentRecord.approval_id;
    const td = parentRecord.resume_state.task_delegation;
    pausedChildren.set(approvalId, {
      approvalId,
      childId: childSidecar.child_id,
      childRuntime: null, // rebuilt on demand during resumeTask
      childPausedTurnStore: null,
      childRecord: childSidecar.child_record || null,
      completedResult: childSidecar.completed_result || null,
      mode: mode || (childSidecar.state === TASK_PAUSED_STATES.CHILD_COMPLETED_PENDING_PARENT ? "deliver_checkpointed_result" : "resume_child"),
      taskDelegation: td,
      authorizedTools: childSidecar.parent.delegated_tools,
      childAutonomy: childSidecar.parent.autonomy || td.autonomy || "gated",
      parentSessionId: childSidecar.parent.session_id,
      parentTurnId: childSidecar.parent.turn_id,
      parentToolCallId: childSidecar.parent.tool_call_id,
      parentExecutionId: childSidecar.parent.execution_id,
      parentScope: null,
      parentOptions: parentRecord.resume_state.options || {},
      state: childSidecar.state
    });
  }

  async function completeParentTaskPause(approvalId) {
    pausedChildren.delete(approvalId);
    if (taskPausedPersistence) {
      await taskPausedPersistence.updateState(approvalId, {
        state: TASK_PAUSED_STATES.PARENT_RESULT_WRITTEN_PENDING_CLEANUP
      }).catch(() => {});
      await taskPausedPersistence.consume(approvalId).catch(() => {});
    }
  }

  async function denyTask(approvalId) {
    const entry = pausedChildren.get(approvalId);
    pausedChildren.delete(approvalId);
    if (entry?.childRuntime?.cancelPaused) {
      await entry.childRuntime.cancelPaused(approvalId, "denied").catch(() => {});
    }
    if (taskPausedPersistence) {
      await taskPausedPersistence.consume(approvalId).catch(() => {});
    }
  }

  async function resumeTask(resumeInfo, context = {}) {
    const { approvalId, scope: approvalScope = "session", taskDelegation, parentBudget = null, parentRecord = null } = resumeInfo;
    let entry = pausedChildren.get(approvalId);

    // If not in memory or if taskPausedPersistence is enabled, verify against sidecar if present
    let childSidecar = null;
    if (taskPausedPersistence) {
      childSidecar = await taskPausedPersistence.load(approvalId).catch(() => null);
      if (parentRecord && childSidecar) {
        const gate = taskDelegationResumeGate({ parentRecord, childSidecar });
        if (!gate.ok) {
          throw new Error(`task delegation recovery blocked: ${gate.reason}`);
        }
      }
    }

    if (!entry && childSidecar && childSidecar.status !== "consumed") {
      entry = {
        approvalId,
        childId: childSidecar.child_id,
        childRuntime: null,
        childPausedTurnStore: null,
        childRecord: childSidecar.child_record || null,
        completedResult: childSidecar.completed_result || null,
        mode: childSidecar.state === TASK_PAUSED_STATES.CHILD_COMPLETED_PENDING_PARENT
          ? "deliver_checkpointed_result"
          : "resume_child",
        taskDelegation: taskDelegation || {
          schema_version: TASK_DELEGATION_SCHEMA_VERSION,
          fingerprints: { ...TASK_DELEGATION_FINGERPRINTS },
          child_id: childSidecar.child_id,
          approval_id: approvalId,
          parent_execution_id: childSidecar.parent.execution_id,
          parent_session_id: childSidecar.parent.session_id,
          parent_turn_id: childSidecar.parent.turn_id,
          parent_tool_call_id: childSidecar.parent.tool_call_id,
          delegated_tools: childSidecar.parent.delegated_tools,
          autonomy: childSidecar.parent.autonomy,
          depth: childSidecar.parent.depth || 1
        },
        authorizedTools: childSidecar.parent.delegated_tools,
        childAutonomy: childSidecar.parent.autonomy || "gated",
        parentSessionId: childSidecar.parent.session_id,
        parentTurnId: childSidecar.parent.turn_id,
        parentToolCallId: childSidecar.parent.tool_call_id,
        parentExecutionId: childSidecar.parent.execution_id,
        parentScope: context.scope || null,
        parentOptions: context.parentOptions || {},
        state: childSidecar.state
      };
    }

    if (!entry) {
      throw new Error(`paused task child not found for approval: ${approvalId}`);
    }

    // Verify ownership correlation between parent context and paused child entry
    if (
      taskDelegation &&
      (taskDelegation.child_id !== entry.childId ||
        taskDelegation.parent_turn_id !== entry.parentTurnId ||
        taskDelegation.parent_tool_call_id !== entry.parentToolCallId)
    ) {
      throw new Error("task delegation ownership mismatch on resume");
    }

    // State 5 idempotent recovery (T15): child already completed before crash, deliver checkpointed result without re-running child!
    const completedCheckpoint = entry.completedResult || childSidecar?.completed_result || null;
    if (
      (entry.mode === "deliver_checkpointed_result" ||
        entry.state === TASK_PAUSED_STATES.CHILD_COMPLETED_PENDING_PARENT ||
        childSidecar?.state === TASK_PAUSED_STATES.CHILD_COMPLETED_PENDING_PARENT) &&
      completedCheckpoint
    ) {
      if (!taskPausedPersistence) {
        pausedChildren.delete(approvalId);
      }
      return completedCheckpoint;
    }

    const linked = linkAbortSignal([context.signal, entry.parentScope?.signal]);
    const childPausedTurnStore = entry.childPausedTurnStore || createPausedTurnStore();
    if (!entry.childPausedTurnStore && entry.childRecord) {
      childPausedTurnStore.restore(entry.childRecord);
    }

    const { childRuntime } = buildChildRuntime({
      childId: entry.childId,
      authorizedTools: entry.authorizedTools,
      childAutonomy: entry.childAutonomy,
      parentSessionId: entry.parentSessionId,
      parentTurnId: entry.parentTurnId,
      parentToolCallId: entry.parentToolCallId,
      parentExecutionId: entry.parentExecutionId,
      parentScope: context.scope || entry.parentScope || null,
      parentBudget,
      parentOptions: entry.parentOptions || {},
      childPausedTurnStore,
      childSignal: linked.signal
    });

    activeChildren.set(entry.childId, { controller: linked.controller, runtime: childRuntime });
    try {
      // Transition sidecar to CHILD_RESUMING before executing pending child tool (T15)
      if (taskPausedPersistence) {
        await taskPausedPersistence.updateState(approvalId, {
          state: TASK_PAUSED_STATES.CHILD_RESUMING
        });
      }

      const childRes = await childRuntime.approve(approvalId, "approve", {
        scope: approvalScope,
        signal: linked.signal
      });

      if (linked.signal.aborted) {
        throw createAbortError(linked.signal.reason);
      }

      // Case B (T09): child worker paused AGAIN on a subsequent tool call!
      if (childRes.status === "awaiting_approval" && childRes.approval?.id) {
        const newApprovalId = childRes.approval.id;
        const newChildRecord = childPausedTurnStore.get(newApprovalId);
        const newTaskDelegation = {
          ...entry.taskDelegation,
          approval_id: newApprovalId,
          state: TASK_PAUSED_STATES.PAUSED_PERSISTED
        };

        if (taskPausedPersistence) {
          await taskPausedPersistence.save(newApprovalId, {
            schema_version: TASK_DELEGATION_SCHEMA_VERSION,
            fingerprints: { ...TASK_DELEGATION_FINGERPRINTS },
            approval_id: newApprovalId,
            child_id: entry.childId,
            state: TASK_PAUSED_STATES.CHILD_PAUSED_AWAITING_PARENT_PERSIST,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            parent: {
              execution_id: entry.parentExecutionId,
              session_id: entry.parentSessionId,
              turn_id: entry.parentTurnId,
              tool_call_id: entry.parentToolCallId,
              autonomy: entry.childAutonomy,
              delegated_tools: entry.authorizedTools,
              depth: 1
            },
            child_record: newChildRecord
          });
          if (newApprovalId !== approvalId) {
            await taskPausedPersistence.consume(approvalId).catch(() => {});
          }
        }

        pausedChildren.delete(approvalId);
        pausedChildren.set(newApprovalId, {
          ...entry,
          approvalId: newApprovalId,
          childRuntime,
          childPausedTurnStore,
          childRecord: newChildRecord,
          taskDelegation: newTaskDelegation,
          state: TASK_PAUSED_STATES.CHILD_PAUSED_AWAITING_PARENT_PERSIST
        });

        return {
          status: "approval_required",
          content: [{ type: "text", text: childRes.approval.summary || "Task child tool requires approval" }],
          metadata: {
            approval: childRes.approval,
            child_id: entry.childId,
            delegated_tools: entry.authorizedTools,
            task_delegation: newTaskDelegation
          }
        };
      }

      let formattedResult;
      if (childRes.status === "stopped") {
        formattedResult = {
          status: "error",
          content: [{ type: "error", text: childRes.content || "Task worker stopped due to cost budget" }],
          metadata: {
            status: "failed",
            code: "BUDGET_EXCEEDED",
            child_id: entry.childId,
            delegated_tools: entry.authorizedTools
          }
        };
      } else if (childRes.status !== "complete") {
        formattedResult = {
          status: "error",
          content: [{ type: "error", text: childRes.content || `Task worker ended with status: ${childRes.status}` }],
          metadata: {
            status: "failed",
            child_id: entry.childId,
            delegated_tools: entry.authorizedTools
          }
        };
      } else {
        formattedResult = formatCompletedChildOutput(childRes, {
          childId: entry.childId,
          authorizedTools: entry.authorizedTools
        });
      }

      // Checkpoint State 5 (CHILD_COMPLETED_PENDING_PARENT) before delivering result to parent (T15)
      entry.state = TASK_PAUSED_STATES.CHILD_COMPLETED_PENDING_PARENT;
      entry.completedResult = formattedResult;
      if (taskPausedPersistence) {
        await taskPausedPersistence.updateState(approvalId, {
          state: TASK_PAUSED_STATES.CHILD_COMPLETED_PENDING_PARENT,
          completed_result: formattedResult
        });
      } else {
        pausedChildren.delete(approvalId);
      }

      return formattedResult;
    } finally {
      activeChildren.delete(entry.childId);
      linked.cleanup();
    }
  }

  function abortActive() {
    for (const [, child] of activeChildren) {
      try { child.controller.abort(new Error("parent disposed")); } catch {}
      try { child.runtime?.interrupt?.(); } catch {}
    }
    activeChildren.clear();
    pausedChildren.clear();
  }

  function interruptAll() {
    for (const [, child] of activeChildren) {
      try { child.controller.abort(new Error("parent interrupted")); } catch {}
      try { child.runtime?.interrupt?.(); } catch {}
    }
    activeChildren.clear();
    for (const [approvalId] of pausedChildren) {
      if (taskPausedPersistence) {
        void taskPausedPersistence.consume(approvalId).catch(() => {});
      }
    }
    pausedChildren.clear();
  }

  return {
    runTask,
    resumeTask,
    denyTask,
    completeParentTaskPause,
    markParentPausePersisted,
    rehydrateTaskDelegation,
    abortActive,
    interruptAll,
    hasPausedChild: (approvalId) => pausedChildren.has(approvalId)
  };
}
