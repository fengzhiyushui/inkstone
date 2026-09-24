import { createAgentTurn, addTurnStep, setTurnStatus } from "../protocol/agent-turn.js";
import { createAgentStep, completeAgentStep } from "../protocol/agent-step.js";
import { classifyMessage } from "../planning/classifier.js";
import { runExecutorLoop, resumeExecutorLoop } from "../execution/executor-loop.js";
import { runVerifier } from "../verification/verifier.js";
import { decideRepair } from "../verification/repair-decision.js";
import { createVerificationPolicy } from "../verification/verification-policy.js";
import { runRepairLoop } from "../verification/repair-loop.js";
import { createPausedTurnStore } from "../approval/paused-turn-store.js";
import { createLifecycleState, transitionLifecycle } from "./lifecycle.js";
import { createCostBudget } from "./cost-budget.js";
import { nowIso } from "../../shared/time.js";

function publish(eventBus, eventType, data) {
  if (eventBus && typeof eventBus.publish === "function") eventBus.publish(eventType, data);
}

class InterruptedError extends Error {
  constructor(reason = "turn was interrupted") {
    super(reason);
    this.name = "InterruptedError";
    this.code = "INTERRUPTED";
  }
}

export function createAgentRuntime({
  eventBus = null,
  sessionId = `sess_${Date.now()}`,
  modelGateway = null,
  toolSchemas = () => [],
  executeTool = null,
  createPolicyContext = () => ({}),
  maxToolIterations = 5,
  maxRepairAttempts = 2,
  verifyMode = "auto",
  testArgv = null,
  pausedTurnStore = createPausedTurnStore(),
  pausedTurnPersistence = null,
  flushEvents = async () => {},
  projectId = sessionId,
  projectRoot = null,
  trustStore = { rules: [] },
  projectRules = [],
  memoryRoot = null,
  recoverySurface = "cli",
  grantApprovalForToolCall = async () => {},
  createContextSnapshot = async () => null,
  maxTurnTokens = null,
  maxModelCalls = null,
  modelTimeoutMs = null,
  maxToolCallRepairs = 0
} = {}) {
  let lifecycle = createLifecycleState();
  let currentTurnId = null;
  let currentAbortController = null;
  let turnGeneration = 0;

  function getState() { return { ...lifecycle }; }
  function assertNotInterrupted(generation) { if (turnGeneration !== generation) throw new InterruptedError(); }

  async function send(message, options = {}) {
    if (pausedTurnStore.size() > 0) {
      const err = new Error("approval is awaiting resolution");
      err.code = "AWAITING_APPROVAL";
      throw err;
    }
    if (currentTurnId) { const err = new Error("another turn is in progress"); err.code = "BUSY"; throw err; }
    const generation = ++turnGeneration;
    currentAbortController = new AbortController();
    let turn = createAgentTurn({ sessionId, userMessage: message, autonomy: options.autonomy || "gated" });
    const permissionContext = buildPermissionContext(options, turn);
    currentTurnId = turn.id;
    publish(eventBus, "user:message", { turn_id: turn.id, content: message, options });
    publish(eventBus, "agent:turn_started", { turn });
    try {
      lifecycle = transitionLifecycle(lifecycle, { to: "classify", reason: "user message received", channel: "think" });
      assertNotInterrupted(generation);
      const classifyStep = createAgentStep({ turnId: turn.id, type: "classify", channel: "think" });
      const classification = classifyMessage(message, options);
      const completedClassifyStep = completeAgentStep(classifyStep, { outputRef: `classification:${classification.task_type}` });
      turn = addTurnStep(turn, completedClassifyStep);
      publish(eventBus, "agent:step", { turn_id: turn.id, step: completedClassifyStep, classification });
      assertNotInterrupted(generation);

      const context = await createContextSnapshot({
        message,
        classification,
        channel: classification.task_type === "query" ? "reply" : "act",
        phase: "execute",
        options
      });

      let response;
      if (classification.task_type === "query" || !modelGateway?.invoke || !executeTool) {
        response = await runReplyFastPath({ message, classification, turn, options, signal: currentAbortController.signal, context });
      } else {
        response = await runToolLoopPath({ message, classification, turn, options, signal: currentAbortController.signal, context, permissionContext });
      }
      assertNotInterrupted(generation);

      if (response.turn) {
        turn = response.turn;
      }

      if (response.status === "awaiting_approval") {
        if (response.approval?.id && response.resume_state) {
          await savePausedRecord({ approval: response.approval, turn, resumeState: response.resume_state, permissionContext });
        }
        lifecycle = transitionLifecycle(lifecycle, { to: "awaiting_approval", reason: "tool approval required", channel: "system" });
        turn = setTurnStatus(turn, "awaiting_approval");
        currentTurnId = null;
        currentAbortController = null;
        return { status: "awaiting_approval", state: "awaiting_approval", content: response.content, approval: response.approval, turn };
      }

      if (response.status === "stopped") {
        turn = setTurnStatus(turn, "completed");
        publish(eventBus, "agent:final", { turn_id: turn.id, content: response.content, status: "stopped" });
        lifecycle = transitionLifecycle(lifecycle, { to: "idle", reason: "cost budget stop", channel: null });
        currentTurnId = null;
        currentAbortController = null;
        return { status: "stopped", state: "idle", content: response.content, turn, budget: response.reason || null };
      }

      if (response.status === "failed") {
        throw new Error(`verification failed: ${response.content || response.verification?.reason || "repair failed"}`);
      }

      turn = setTurnStatus(turn, "completed");
      publish(eventBus, "agent:final", { turn_id: turn.id, content: response.content, status: "complete" });
      lifecycle = transitionLifecycle(lifecycle, { to: "idle", reason: "turn complete", channel: null });
      currentTurnId = null;
      currentAbortController = null;
      return { status: "complete", state: "idle", content: response.content, turn, verification: response.verification || null, repair: response.repair || null };
    } catch (error) {
      if (currentTurnId !== turn.id) throw error;
      if (error instanceof InterruptedError || error.name === "AbortError") {
        currentTurnId = null;
        currentAbortController = null;
        lifecycle = transitionLifecycle(lifecycle, { to: "idle", reason: error.message, channel: null });
        throw error instanceof InterruptedError ? error : new InterruptedError(error.message);
      }
      lifecycle = transitionLifecycle(lifecycle, { to: "failed", reason: error.message, channel: lifecycle.channel });
      publish(eventBus, "agent:error", { turn_id: turn.id, message: error.message });
      currentTurnId = null;
      currentAbortController = null;
      throw error;
    }
  }

  async function runReplyFastPath({ message, classification, turn, options, signal, context = null }) {
    lifecycle = transitionLifecycle(lifecycle, { to: "complete", reason: "reply fast path", channel: "system" });
    const finalStep = completeAgentStep(createAgentStep({ turnId: turn.id, type: "final", channel: "system" }));
    const updatedTurn = addTurnStep(turn, finalStep);
    const response = modelGateway && typeof modelGateway.reply === "function"
      ? await modelGateway.reply({ message, classification, turn, options: { ...options, timeoutMs: options.timeoutMs ?? modelTimeoutMs }, signal, context })
      : { content: `V2-0 mock ${classification.task_type} response` };
    return { status: "complete", content: response.content, turn: updatedTurn, context };
  }

  async function runToolLoopPath({ message, classification, turn, options, signal, context = null, permissionContext = null }) {
    lifecycle = transitionLifecycle(lifecycle, { to: "execute", reason: "tool loop started", channel: "act" });
    const budget = createCostBudget({
      maxTokens: options.maxTurnTokens ?? maxTurnTokens,
      maxModelCalls: options.maxModelCalls ?? maxModelCalls
    });
    const loop = await runExecutorLoop({
      message,
      classification,
      turnId: turn.id,
      sessionId,
      context,
      permissionContext,
      modelGateway,
      toolSchemas: typeof toolSchemas === "function" ? toolSchemas() : toolSchemas,
      executeTool,
      createPolicyContext: ({ turnId, toolCall, phase }) => createPolicyContext({
        ...policyOptionsFromPermissionContext(permissionContext, { autonomy: options.autonomy || turn.autonomy }),
        turnId,
        toolCall,
        phase
      }),
      eventBus,
      signal,
      maxIterations: options.maxToolIterations || maxToolIterations,
      budget,
      modelTimeoutMs: options.modelTimeoutMs ?? modelTimeoutMs,
      maxToolCallRepairs: options.maxToolCallRepairs ?? maxToolCallRepairs,
      options
    });
    if (loop.status === "awaiting_approval") return loop;
    if (loop.status === "stopped") return loop;

    return verifyAndMaybeRepair({ turn, message, classification, loop, options, signal, context, permissionContext, budget });
  }

  async function verifyAndMaybeRepair({ turn, message, classification, loop, options, signal, context = null, permissionContext = null, budget = null }) {
    lifecycle = transitionLifecycle(lifecycle, { to: "verify", reason: "tool loop complete", channel: "system" });
    const verificationPolicy = createVerificationPolicyFrom({ options, permissionContext });
    const verification = await runVerifier({
      turnId: turn.id,
      autonomy: permissionContext?.autonomy || options.autonomy || turn.autonomy,
      toolResults: loop.toolResults,
      executeTool,
      createPolicyContext: ({ turnId, toolCall, phase }) => createPolicyContext({
        ...policyOptionsFromPermissionContext(permissionContext, { autonomy: "auto" }),
        turnId,
        toolCall,
        phase
      }),
      verificationPolicy,
      eventBus
    });
    const repair = decideRepair(verification);
    if (repair.decision === "none") return { ...loop, verification, repair: null };
    if (repair.decision === "stop" && verification.status === "approval_required") {
      return {
        status: "awaiting_approval",
        content: verification.reason || "Verification requires approval",
        approval: verification.tool_result?.metadata?.approval || null,
        toolResults: loop.toolResults,
        iterations: loop.iterations,
        verification,
        resume_state: {
          ...verifierApprovalResumeState({
            turn,
            message,
            classification,
            loop,
            verification,
            options,
            permissionContext,
            context
          }),
          // 验证器审批暂停同样带上已耗预算,续跑按 spent 续扣
          ...(budget ? { budget_spent: budgetSpentOf(budget) } : {})
        }
      };
    }
    if (repair.decision === "repair") {
      lifecycle = transitionLifecycle(lifecycle, { to: "repair", reason: repair.reason, channel: "think" });
      const repairLoop = await runRepairLoop({
        turnId: turn.id,
        userMessage: message,
        classification,
        modelGateway,
        toolSchemas: typeof toolSchemas === "function" ? toolSchemas() : toolSchemas,
        executeTool,
        createPolicyContext: ({ turnId, toolCall, phase }) => createPolicyContext({
          ...policyOptionsFromPermissionContext(permissionContext, {
            autonomy: phase === "verify" ? "auto" : (options.autonomy || turn.autonomy)
          }),
          turnId,
          toolCall,
          phase
        }),
        verificationPolicy,
        initialVerification: verification,
        initialToolResults: loop.toolResults,
        eventBus,
        signal,
        maxRepairAttempts: options.maxRepairAttempts || maxRepairAttempts,
        modelTimeoutMs: options.modelTimeoutMs ?? modelTimeoutMs,
        options,
        permissionContext,
        context,
        budget,
        sessionId
      });
      return repairLoop;
    }
    return { status: "failed", content: repair.reason, verification, toolResults: loop.toolResults };
  }

  async function approve(approvalId, decision = "approve") {
    const normalized = normalizeApprovalDecision(decision);
    if (currentTurnId) {
      const err = new Error("another turn is in progress");
      err.code = "BUSY";
      throw err;
    }
    const record = pausedTurnStore.get(approvalId);
    if (!record) {
      const err = new Error(`approval not found: ${approvalId}`);
      err.code = "APPROVAL_NOT_FOUND";
      throw err;
    }

    const recordPermissionContext = permissionContextForRecord(record);
    currentTurnId = record.turn_id;
    currentAbortController = new AbortController();
    try {
      publish(eventBus, "approval:resolved", { approval_id: approvalId, decision: normalized });
      await flushEvents();

      if (normalized === "deny") {
        await clearConsumedPausedRecord(approvalId);
        lifecycle = transitionLifecycle(lifecycle, { to: "idle", reason: "approval denied", channel: null });
        publish(eventBus, "turn:cancelled", {
          approval_id: approvalId,
          turn_id: record.turn_id,
          original_session_id: record.session_id || record.turn?.session_id || sessionId,
          reason: "denied"
        });
        publish(eventBus, "agent:final", { turn_id: record.turn_id, content: "Approval denied.", status: "cancelled" });
        await flushEvents();
        currentTurnId = null;
        currentAbortController = null;
        return { status: "cancelled", state: "idle", content: "Approval denied.", approval: record.approval, turn: setTurnStatus(record.turn, "completed") };
      }

      lifecycle = transitionLifecycle(lifecycle, { to: "execute", reason: "approval resolved", channel: "act" });
      if (record.resume_state.repair_context?.approval_phase === "verify") {
        return await resumeRepairVerifierApproval({ record, approvalId, permissionContext: recordPermissionContext });
      }
      if (record.resume_state.verification_context?.approval_phase === "verify") {
        return await resumeRuntimeVerifierApproval({ record, approvalId, permissionContext: recordPermissionContext });
      }

      await grantApprovalForToolCall(record.resume_state.pending_tool_call, {
        turnId: record.turn_id,
        toolCall: record.resume_state.pending_tool_call,
        options: record.resume_state.options || {},
        permission_context: recordPermissionContext
      });
      await publishTurnResumed(record, approvalId);
      const resumeOptions = record.resume_state.options || {};
      // 暂停时已消耗的预算续扣(executor-loop 在 resume_state.budget_spent 落盘),
      // 避免审批暂停/续跑把已计 token/调用次数清零而实际超限。
      const budgetSpent = record.resume_state.budget_spent || null;
      const budget = createCostBudget({
        maxTokens: resumeOptions.maxTurnTokens ?? maxTurnTokens,
        maxModelCalls: resumeOptions.maxModelCalls ?? maxModelCalls,
        initialTokens: budgetSpent?.tokens || 0,
        initialModelCalls: budgetSpent?.model_calls || 0
      });
      const loop = await runAfterClearingConsumedPause(approvalId, () => resumeExecutorLoop({
        resumeState: record.resume_state,
        modelGateway,
        executeTool,
        createPolicyContext: ({ turnId, toolCall, phase }) => createPolicyContext({
          ...policyOptionsFromPermissionContext(recordPermissionContext, { autonomy: recordPermissionContext.autonomy || record.turn.autonomy }),
          turnId,
          toolCall,
          phase
        }),
        eventBus,
        signal: currentAbortController.signal,
        budget,
        modelTimeoutMs: resumeOptions.modelTimeoutMs ?? modelTimeoutMs,
        maxToolCallRepairs: resumeOptions.maxToolCallRepairs ?? maxToolCallRepairs,
        sessionId
      }));
      if (loop.status === "awaiting_approval") {
        const resumeState = preserveRepairContextOnRePause(record.resume_state, loop.resume_state);
        await savePausedRecord({
          approval: loop.approval,
          turn: record.turn,
          resumeState,
          permissionContext: recordPermissionContext,
          replaceApprovalId: approvalId
        });
        lifecycle = transitionLifecycle(lifecycle, { to: "awaiting_approval", reason: "tool approval required", channel: "system" });
        currentTurnId = null;
        currentAbortController = null;
        return { status: "awaiting_approval", state: "awaiting_approval", content: loop.content, approval: loop.approval, turn: setTurnStatus(record.turn, "awaiting_approval") };
      }

      if (loop.status === "stopped") {
        const stoppedTurn = setTurnStatus(record.turn, "completed");
        publish(eventBus, "agent:final", { turn_id: record.turn_id, content: loop.content, status: "stopped" });
        lifecycle = transitionLifecycle(lifecycle, { to: "idle", reason: "cost budget stop", channel: null });
        currentTurnId = null;
        currentAbortController = null;
        return { status: "stopped", state: "idle", content: loop.content, turn: stoppedTurn, budget: loop.reason || null };
      }

      // Repair-phase approval: resume within the repair loop, not a fresh verifyAndMaybeRepair
      if (record.resume_state.repair_context) {
        const ctx = record.resume_state.repair_context;
        const mergedToolResults = [...ctx.all_tool_results, ...(loop.toolResults || [])];
        const repairResult = await runAfterClearingConsumedPause(approvalId, () => runRepairLoop({
          turnId: record.turn_id,
          userMessage: record.turn.user_message,
          classification: record.resume_state.classification || { task_type: "edit" },
          modelGateway,
          toolSchemas: typeof toolSchemas === "function" ? toolSchemas() : toolSchemas,
          executeTool,
          createPolicyContext: ({ turnId, toolCall, phase }) => createPolicyContext({
            ...policyOptionsFromPermissionContext(recordPermissionContext, {
              autonomy: phase === "verify" ? "auto" : (recordPermissionContext.autonomy || record.turn.autonomy)
            }),
            turnId,
            toolCall,
            phase
          }),
          verificationPolicy: createVerificationPolicyFrom({ options: record.resume_state.options || {}, permissionContext: recordPermissionContext }),
          initialVerification: ctx.initial_verification,
          initialToolResults: ctx.initial_tool_results || [],
          eventBus,
          signal: currentAbortController.signal,
          maxRepairAttempts: ctx.max_repair_attempts,
          modelTimeoutMs: record.resume_state.options?.modelTimeoutMs ?? modelTimeoutMs,
          options: record.resume_state.options || {},
          permissionContext: recordPermissionContext,
          context: record.resume_state.context || record.resume_state.repair_context?.context || null,
          resumeAfterApproval: {
            all_tool_results: mergedToolResults,
            verification: ctx.verification,
            attempt: ctx.attempt,
            attempts: ctx.attempts,
            skip_to_verification: true
          },
          budget,
          sessionId
        }));

        if (repairResult.status === "awaiting_approval") {
          if (repairResult.approval?.id && repairResult.resume_state) {
            await savePausedRecord({
              approval: repairResult.approval,
              turn: record.turn,
              resumeState: repairResult.resume_state,
              permissionContext: recordPermissionContext,
              replaceApprovalId: approvalId
            });
          }
          lifecycle = transitionLifecycle(lifecycle, { to: "awaiting_approval", reason: "repair approval required", channel: "system" });
          currentTurnId = null;
          currentAbortController = null;
          return {
            status: "awaiting_approval",
            state: "awaiting_approval",
            content: repairResult.content,
            approval: repairResult.approval,
            turn: setTurnStatus(record.turn, "awaiting_approval"),
            verification: repairResult.verification
          };
        }

        if (repairResult.status === "failed") {
          await throwAfterClearingConsumedPause(
            approvalId,
            new Error(`verification failed: ${repairResult.content || repairResult.verification?.reason || "repair failed"}`)
          );
        }

        const finalTurn = setTurnStatus(record.turn, "completed");
        publish(eventBus, "agent:final", { turn_id: record.turn_id, content: repairResult.content, status: "complete" });
        await clearConsumedPausedRecord(approvalId);
        lifecycle = transitionLifecycle(lifecycle, { to: "idle", reason: "turn complete", channel: null });
        currentTurnId = null;
        currentAbortController = null;
        return { status: "complete", state: "idle", content: repairResult.content, turn: finalTurn, verification: repairResult.verification, repair: repairResult.repair || null };
      }

      const repaired = await runAfterClearingConsumedPause(approvalId, () => verifyAndMaybeRepair({
        turn: record.turn,
        message: record.turn.user_message,
        classification: record.resume_state.classification || { task_type: "edit" },
        loop,
        options: record.resume_state.options || {},
        signal: currentAbortController.signal,
        context: record.resume_state.context || null,
        permissionContext: recordPermissionContext,
        budget
      }));
      if (repaired.status === "awaiting_approval") {
        if (repaired.approval?.id && repaired.resume_state) {
          await savePausedRecord({
            approval: repaired.approval,
            turn: record.turn,
            resumeState: repaired.resume_state,
            permissionContext: recordPermissionContext,
            replaceApprovalId: approvalId
          });
        }
        lifecycle = transitionLifecycle(lifecycle, { to: "awaiting_approval", reason: "repair approval required", channel: "system" });
        currentTurnId = null;
        currentAbortController = null;
        return {
          status: "awaiting_approval",
          state: "awaiting_approval",
          content: repaired.content,
          approval: repaired.approval,
          turn: setTurnStatus(record.turn, "awaiting_approval"),
          verification: repaired.verification
        };
      }
      if (repaired.status === "failed") {
        await throwAfterClearingConsumedPause(
          approvalId,
          new Error(`verification failed: ${repaired.content || repaired.verification?.reason || "repair failed"}`)
        );
      }
      const finalTurn = setTurnStatus(record.turn, "completed");
      publish(eventBus, "agent:final", { turn_id: record.turn_id, content: repaired.content, status: "complete" });
      await clearConsumedPausedRecord(approvalId);
      lifecycle = transitionLifecycle(lifecycle, { to: "idle", reason: "turn complete", channel: null });
      currentTurnId = null;
      currentAbortController = null;
      return { status: "complete", state: "idle", content: repaired.content, turn: finalTurn, verification: repaired.verification, repair: repaired.repair || null };
    } catch (error) {
      lifecycle = transitionLifecycle(lifecycle, { to: "failed", reason: error.message, channel: lifecycle.channel });
      publish(eventBus, "agent:error", { turn_id: record.turn_id, message: error.message });
      currentTurnId = null;
      currentAbortController = null;
      throw error;
    }
  }

  function interrupt(turnId = null) {
    turnGeneration += 1;
    if (currentAbortController) currentAbortController.abort();
    for (const record of pausedTurnStore.list?.() || []) {
      void deletePausedSidecar(record.approval_id).catch(() => {});
    }
    pausedTurnStore.clear();
    currentTurnId = null;
    currentAbortController = null;
    lifecycle = transitionLifecycle(lifecycle, { to: "idle", reason: turnId ? `turn interrupted: ${turnId}` : "interrupt requested", channel: null });
  }

  function listPaused() {
    return pausedTurnStore.list();
  }

  async function cancelPaused(approvalId, reason = "cancelled") {
    const record = pausedTurnStore.get(approvalId);
    if (!record) return null;
    await deletePausedSidecar(approvalId);
    pausedTurnStore.delete(approvalId);
    publish(eventBus, "turn:cancelled", {
      approval_id: approvalId,
      turn_id: record.turn_id,
      original_session_id: record.session_id || record.turn?.session_id || sessionId,
      reason
    });
    await flushEvents();
    return record;
  }

  function restorePaused(record) {
    return pausedTurnStore.restore(record);
  }

  async function resumeRuntimeVerifierApproval({ record, approvalId, permissionContext }) {
    const ctx = record.resume_state.verification_context;
    const pendingToolCall = verifierPendingToolCallForResume(
      record.resume_state.pending_tool_call,
      ctx?.verification,
      record.resume_state.options || {},
      permissionContext
    );
    await grantApprovalForToolCall(pendingToolCall, {
      turnId: record.turn_id,
      toolCall: pendingToolCall,
      options: record.resume_state.options || {},
      permission_context: permissionContext
    });
    await publishTurnResumed(record, approvalId);
    const verifierResult = await runAfterClearingConsumedPause(approvalId, () => executeTool(
      pendingToolCall,
      createPolicyContext({
        ...policyOptionsFromPermissionContext(permissionContext, { autonomy: "auto" }),
        turnId: record.turn_id,
        toolCall: pendingToolCall,
        phase: "verify"
      })
    ));
    const verification = mapVerifierToolResult(verifierResult, ctx.verification?.mode);
    publish(eventBus, "verification:result", { turn_id: record.turn_id, result: verification });
    if (verification.status === "approval_required") {
      const resumeState = {
        ...record.resume_state,
        pending_tool_call: pendingToolCall,
        verification_context: {
          ...ctx,
          verification
        }
      };
      await savePausedRecord({
        approval: verification.tool_result?.metadata?.approval,
        turn: record.turn,
        resumeState,
        permissionContext,
        replaceApprovalId: approvalId
      });
      lifecycle = transitionLifecycle(lifecycle, { to: "awaiting_approval", reason: "verification approval required", channel: "system" });
      currentTurnId = null;
      currentAbortController = null;
      return {
        status: "awaiting_approval",
        state: "awaiting_approval",
        content: verification.reason || "Verification requires approval",
        approval: verification.tool_result?.metadata?.approval || null,
        turn: setTurnStatus(record.turn, "awaiting_approval"),
        verification
      };
    }

    const repair = decideRepair(verification);
    if (repair.decision === "none") {
      const finalTurn = setTurnStatus(record.turn, "completed");
      const content = ctx.content || record.resume_state.content || "Verification complete.";
      publish(eventBus, "agent:final", { turn_id: record.turn_id, content, status: "complete" });
      await clearConsumedPausedRecord(approvalId);
      await flushEvents();
      lifecycle = transitionLifecycle(lifecycle, { to: "idle", reason: "turn complete", channel: null });
      currentTurnId = null;
      currentAbortController = null;
      return { status: "complete", state: "idle", content, turn: finalTurn, verification, repair: null };
    }

    if (repair.decision === "repair") {
      const repairLoop = await runAfterClearingConsumedPause(approvalId, () => runRepairLoop({
        turnId: record.turn_id,
        userMessage: record.turn.user_message,
        classification: record.resume_state.classification || { task_type: "edit" },
        modelGateway,
        toolSchemas: typeof toolSchemas === "function" ? toolSchemas() : toolSchemas,
        executeTool,
        createPolicyContext: ({ turnId, toolCall, phase }) => createPolicyContext({
          ...policyOptionsFromPermissionContext(permissionContext, {
            autonomy: phase === "verify" ? "auto" : (permissionContext.autonomy || record.turn.autonomy)
          }),
          turnId,
          toolCall,
          phase
        }),
        verificationPolicy: createVerificationPolicyFrom({ options: record.resume_state.options || {}, permissionContext }),
        initialVerification: verification,
        initialToolResults: ctx.tool_results || [],
        eventBus,
        signal: currentAbortController.signal,
        maxRepairAttempts: record.resume_state.options?.maxRepairAttempts || maxRepairAttempts,
        options: record.resume_state.options || {},
        permissionContext,
        context: record.resume_state.context || ctx.context || null,
        budget,
        sessionId
      }));

      if (repairLoop.status === "awaiting_approval" && repairLoop.approval?.id && repairLoop.resume_state) {
        await savePausedRecord({
          approval: repairLoop.approval,
          turn: record.turn,
          resumeState: repairLoop.resume_state,
          permissionContext,
          replaceApprovalId: approvalId
        });
      }
      if (repairLoop.status === "awaiting_approval") {
        lifecycle = transitionLifecycle(lifecycle, { to: "awaiting_approval", reason: "repair approval required", channel: "system" });
        currentTurnId = null;
        currentAbortController = null;
        return {
          status: "awaiting_approval",
          state: "awaiting_approval",
          content: repairLoop.content,
          approval: repairLoop.approval,
          turn: setTurnStatus(record.turn, "awaiting_approval"),
          verification: repairLoop.verification
        };
      }
      if (repairLoop.status === "failed") {
        await throwAfterClearingConsumedPause(
          approvalId,
          new Error(`verification failed: ${repairLoop.content || repairLoop.verification?.reason || "repair failed"}`)
        );
      }
      const finalTurn = setTurnStatus(record.turn, "completed");
      publish(eventBus, "agent:final", { turn_id: record.turn_id, content: repairLoop.content, status: "complete" });
      await clearConsumedPausedRecord(approvalId);
      await flushEvents();
      lifecycle = transitionLifecycle(lifecycle, { to: "idle", reason: "turn complete", channel: null });
      currentTurnId = null;
      currentAbortController = null;
      return { status: "complete", state: "idle", content: repairLoop.content, turn: finalTurn, verification: repairLoop.verification, repair: repairLoop.repair || null };
    }

    await throwAfterClearingConsumedPause(
      approvalId,
      new Error(`verification failed: ${repair.reason || verification.reason || "repair failed"}`)
    );
  }

  async function resumeRepairVerifierApproval({ record, approvalId, permissionContext }) {
    const ctx = record.resume_state.repair_context;
    const pendingToolCall = verifierPendingToolCallForResume(
      record.resume_state.pending_tool_call,
      ctx?.verification,
      record.resume_state.options || {},
      permissionContext
    );
    await grantApprovalForToolCall(pendingToolCall, {
      turnId: record.turn_id,
      toolCall: pendingToolCall,
      options: record.resume_state.options || {},
      permission_context: permissionContext
    });
    await publishTurnResumed(record, approvalId);
    const verifierResult = await runAfterClearingConsumedPause(approvalId, () => executeTool(
      pendingToolCall,
      createPolicyContext({
        ...policyOptionsFromPermissionContext(permissionContext, { autonomy: "auto" }),
        turnId: record.turn_id,
        toolCall: pendingToolCall,
        phase: "verify"
      })
    ));
    const verification = mapVerifierToolResult(verifierResult, ctx.verification?.mode);
    publish(eventBus, "verification:result", { turn_id: record.turn_id, result: verification });
    if (verification.status === "approval_required") {
      const resumeState = {
        ...record.resume_state,
        pending_tool_call: pendingToolCall,
        repair_context: {
          ...ctx,
          verification
        }
      };
      await savePausedRecord({
        approval: verification.tool_result?.metadata?.approval,
        turn: record.turn,
        resumeState,
        permissionContext,
        replaceApprovalId: approvalId
      });
      lifecycle = transitionLifecycle(lifecycle, { to: "awaiting_approval", reason: "repair verification approval required", channel: "system" });
      currentTurnId = null;
      currentAbortController = null;
      return {
        status: "awaiting_approval",
        state: "awaiting_approval",
        content: verification.reason || "Verification requires approval",
        approval: verification.tool_result?.metadata?.approval || null,
        turn: setTurnStatus(record.turn, "awaiting_approval"),
        verification
      };
    }

    const repairResult = {
      turn_id: record.turn_id,
      attempt: ctx.attempt,
      status: verification.status === "passed" || verification.status === "skipped" ? "complete" : "failed",
      verification_status: verification.status,
      tool_result_count: ctx.all_tool_results.length
    };
    const attempts = [...(ctx.attempts || []), repairResult];
    publish(eventBus, "repair:result", repairResult);

    if (verification.status === "passed" || verification.status === "skipped") {
      const finalTurn = setTurnStatus(record.turn, "completed");
      publish(eventBus, "agent:final", { turn_id: record.turn_id, content: "Repair complete.", status: "complete" });
      await clearConsumedPausedRecord(approvalId);
      await flushEvents();
      lifecycle = transitionLifecycle(lifecycle, { to: "idle", reason: "turn complete", channel: null });
      currentTurnId = null;
      currentAbortController = null;
      return {
        status: "complete",
        state: "idle",
        content: "Repair complete.",
        turn: finalTurn,
        verification,
        repair: { attempts: ctx.attempt, status: "complete", history: attempts }
      };
    }

    if (ctx.attempt < ctx.max_repair_attempts) {
      const repairLoop = await runAfterClearingConsumedPause(approvalId, () => runRepairLoop({
        turnId: record.turn_id,
        userMessage: record.turn.user_message,
        classification: record.resume_state.classification || { task_type: "edit" },
        modelGateway,
        toolSchemas: typeof toolSchemas === "function" ? toolSchemas() : toolSchemas,
        executeTool,
        createPolicyContext: ({ turnId, toolCall, phase }) => createPolicyContext({
          ...policyOptionsFromPermissionContext(permissionContext, {
            autonomy: phase === "verify" ? "auto" : (permissionContext.autonomy || record.turn.autonomy)
          }),
          turnId,
          toolCall,
          phase
        }),
        verificationPolicy: createVerificationPolicyFrom({ options: record.resume_state.options || {}, permissionContext }),
        initialVerification: ctx.initial_verification,
        initialToolResults: ctx.initial_tool_results || [],
        eventBus,
        signal: currentAbortController.signal,
        maxRepairAttempts: ctx.max_repair_attempts,
        options: record.resume_state.options || {},
        permissionContext,
        context: record.resume_state.context || ctx.context || null,
        resumeAfterApproval: {
          all_tool_results: ctx.all_tool_results,
          verification,
          attempt: ctx.attempt + 1,
          attempts,
          skip_to_verification: false
        },
        budget,
        sessionId
      }));
      if (repairLoop.status === "awaiting_approval" && repairLoop.approval?.id && repairLoop.resume_state) {
        await savePausedRecord({
          approval: repairLoop.approval,
          turn: record.turn,
          resumeState: repairLoop.resume_state,
          permissionContext,
          replaceApprovalId: approvalId
        });
      }
      if (repairLoop.status === "awaiting_approval") {
        lifecycle = transitionLifecycle(lifecycle, { to: "awaiting_approval", reason: "repair approval required", channel: "system" });
        currentTurnId = null;
        currentAbortController = null;
        return {
          status: "awaiting_approval",
          state: "awaiting_approval",
          content: repairLoop.content,
          approval: repairLoop.approval,
          turn: setTurnStatus(record.turn, "awaiting_approval"),
          verification: repairLoop.verification
        };
      }
      if (repairLoop.status === "failed") {
        await throwAfterClearingConsumedPause(
          approvalId,
          new Error(`verification failed: ${repairLoop.content || repairLoop.verification?.reason || "repair failed"}`)
        );
      }
      const finalTurn = setTurnStatus(record.turn, "completed");
      publish(eventBus, "agent:final", { turn_id: record.turn_id, content: repairLoop.content, status: "complete" });
      await clearConsumedPausedRecord(approvalId);
      await flushEvents();
      lifecycle = transitionLifecycle(lifecycle, { to: "idle", reason: "turn complete", channel: null });
      currentTurnId = null;
      currentAbortController = null;
      return { status: "complete", state: "idle", content: repairLoop.content, turn: finalTurn, verification: repairLoop.verification, repair: repairLoop.repair || null };
    }

    publish(eventBus, "repair:exhausted", { turn_id: record.turn_id, attempts: ctx.max_repair_attempts, verification_status: verification.status });
    const failure = new Error(`verification failed: ${verification.reason || "repair failed"}`);
    await clearConsumedPausedRecord(approvalId);
    await flushEvents().catch(() => {});
    lifecycle = transitionLifecycle(lifecycle, { to: "failed", reason: verification.reason || "repair failed", channel: lifecycle.channel });
    currentTurnId = null;
    currentAbortController = null;
    throw failure;
  }

  async function savePausedRecord({ approval, turn, resumeState, permissionContext, replaceApprovalId = null }) {
    const recordPermissionContext = resumeState.permission_context || permissionContext || permissionContextForRecord({ resume_state: resumeState });
    const record = {
      approval_id: approval.id,
      turn_id: turn.id,
      session_id: turn.session_id || sessionId,
      created_at: nowIso(),
      surface: recoverySurface,
      permission_context: recordPermissionContext,
      approval,
      turn,
      resume_state: {
        ...resumeState,
        permission_context: recordPermissionContext
      }
    };
    if (replaceApprovalId) {
      const previousRecord = pausedTurnStore.get(replaceApprovalId);
      if (replaceApprovalId !== record.approval_id && pausedTurnStore.get(record.approval_id)) {
        throw new Error(`paused approval already exists: ${record.approval_id}`);
      }
      try {
        if (pausedTurnPersistence?.save) await pausedTurnPersistence.save(record);
        if (replaceApprovalId !== record.approval_id) {
          await deletePausedSidecar(replaceApprovalId);
          pausedTurnStore.delete(replaceApprovalId);
        }
        const stored = replaceApprovalId === record.approval_id
          ? pausedTurnStore.restore(record)
          : pausedTurnStore.save(record);
        await publishTurnPaused(record);
        return stored;
      } catch (error) {
        await rollbackReplacementPause({ previousRecord, newApprovalId: record.approval_id });
        throw error;
      }
    }
    if (pausedTurnStore.get(record.approval_id)) {
      throw new Error(`paused approval already exists: ${record.approval_id}`);
    }
    if (pausedTurnPersistence?.save) {
      await pausedTurnPersistence.save(record);
    }
    const stored = pausedTurnStore.save(record);
    await publishTurnPaused(record);
    return stored;
  }

  async function rollbackReplacementPause({ previousRecord, newApprovalId }) {
    if (newApprovalId) {
      await deletePausedSidecar(newApprovalId).catch(() => {});
      pausedTurnStore.delete(newApprovalId);
    }
    if (previousRecord) {
      try {
        if (pausedTurnPersistence?.save) await pausedTurnPersistence.save(previousRecord);
        pausedTurnStore.restore(previousRecord);
      } catch (error) {
        // rollback failed; leave memory-only inconsistency rather than corrupting disk state
      }
    }
  }

  function preserveRepairContextOnRePause(previousResumeState, nextResumeState) {
    const ctx = previousResumeState?.repair_context;
    if (!ctx || !nextResumeState) return nextResumeState;
    return {
      ...nextResumeState,
      repair_context: {
        ...ctx,
        all_tool_results: [
          ...(ctx.all_tool_results || []),
          ...((nextResumeState.tool_results || []).filter((result) => !(ctx.all_tool_results || []).includes(result)))
        ],
        initial_tool_results: ctx.initial_tool_results || []
      }
    };
  }

  async function clearPausedRecord(approvalId) {
    await deletePausedSidecar(approvalId);
    pausedTurnStore.delete(approvalId);
  }

  async function clearConsumedPausedRecord(approvalId) {
    try {
      if (pausedTurnPersistence?.consume) {
        await pausedTurnPersistence.consume(approvalId);
      } else {
        await deletePausedSidecar(approvalId);
      }
      pausedTurnStore.delete(approvalId);
    } catch (error) {
      publish(eventBus, "recovery:blocked", {
        item_id: `paused:${approvalId}`,
        source_id: approvalId,
        reason: `consumed paused sidecar cleanup failed: ${sanitizeErrorMessage(error)}`
      });
    }
  }

  async function runAfterClearingConsumedPause(approvalId, operation) {
    try {
      return await operation();
    } catch (error) {
      await clearConsumedPausedRecord(approvalId);
      throw error;
    }
  }

  async function throwAfterClearingConsumedPause(approvalId, error) {
    await clearConsumedPausedRecord(approvalId);
    throw error;
  }

  async function publishTurnResumed(record, approvalId) {
    publish(eventBus, "turn:resumed", {
      approval_id: approvalId,
      turn_id: record.turn_id,
      original_session_id: record.session_id || record.turn?.session_id || sessionId
    });
    await flushEvents();
  }

  async function publishTurnPaused(record) {
    publish(eventBus, "turn:paused", {
      approval_id: record.approval_id,
      turn_id: record.turn_id,
      original_session_id: record.session_id,
      surface: record.surface
    });
    await flushEvents();
  }

  async function deletePausedSidecar(approvalId) {
    if (!pausedTurnPersistence?.delete) return false;
    return pausedTurnPersistence.delete(approvalId);
  }

  function buildPermissionContext(options, turn) {
    const existing = options.permission_context || options.permissionContext;
    if (existing && typeof existing === "object") {
      return normalizePermissionContext(existing, options, turn);
    }
    return normalizePermissionContext({
      schema_version: 1,
      autonomy: options.autonomy || turn.autonomy,
      project_id: options.projectId || projectId,
      project_root: options.projectRoot || projectRoot,
      trust_store_rules: options.trustStore?.rules || trustStore?.rules || [],
      project_rules: options.projectRules || projectRules || [],
      memory_root: options.memoryRoot ?? memoryRoot,
      verify_mode: options.verifyMode || verifyMode,
      test_argv: readPresent(options, "testArgv", testArgv)
    }, options, turn);
  }

  function permissionContextForRecord(record) {
    return normalizePermissionContext(
      record.permission_context || record.resume_state?.permission_context || record.resume_state?.options?.permission_context || {},
      record.resume_state?.options || {},
      record.turn || { autonomy: "gated" }
    );
  }

  function normalizePermissionContext(input, options = {}, turn = {}) {
    const inputTestArgv = readPresent(input, "test_argv");
    const inputTestArgvCamel = readPresent(input, "testArgv");
    const optionsTestArgv = readPresent(options, "testArgv");
    return {
      schema_version: 1,
      autonomy: input.autonomy || options.autonomy || turn.autonomy || "gated",
      project_id: input.project_id || input.projectId || options.projectId || projectId || sessionId,
      project_root: input.project_root ?? input.projectRoot ?? options.projectRoot ?? projectRoot,
      trust_store_rules: Array.isArray(input.trust_store_rules) ? input.trust_store_rules : (input.trustStore?.rules || options.trustStore?.rules || trustStore?.rules || []),
      project_rules: Array.isArray(input.project_rules) ? input.project_rules : (input.projectRules || options.projectRules || projectRules || []),
      memory_root: input.memory_root ?? input.memoryRoot ?? options.memoryRoot ?? memoryRoot,
      verify_mode: input.verify_mode || input.verifyMode || options.verifyMode || verifyMode,
      test_argv: firstDefined(inputTestArgv, inputTestArgvCamel, optionsTestArgv, testArgv)
    };
  }

  function policyOptionsFromPermissionContext(permissionContext, overrides = {}) {
    const ctx = normalizePermissionContext(permissionContext || {}, {}, { autonomy: "gated" });
    return {
      autonomy: overrides.autonomy || ctx.autonomy,
      projectId: ctx.project_id,
      projectRoot: ctx.project_root,
      trustStore: { rules: ctx.trust_store_rules || [] },
      projectRules: ctx.project_rules || [],
      memoryRoot: ctx.memory_root,
      verifyMode: ctx.verify_mode,
      testArgv: ctx.test_argv
    };
  }

  function createVerificationPolicyFrom({ options = {}, permissionContext = null } = {}) {
    const ctx = normalizePermissionContext(permissionContext || {}, options, { autonomy: options.autonomy || "gated" });
    const contextTestArgv = readPresent(permissionContext, "test_argv");
    const contextTestArgvCamel = readPresent(permissionContext, "testArgv");
    const optionsTestArgv = readPresent(options, "testArgv");
    const contextVerifyMode = firstDefined(readPresent(permissionContext, "verify_mode"), readPresent(permissionContext, "verifyMode"));
    const optionsVerifyMode = readPresent(options, "verifyMode");
    return createVerificationPolicy({
      verifyMode: firstDefined(contextVerifyMode, optionsVerifyMode, ctx.verify_mode, verifyMode),
      testArgv: firstDefined(contextTestArgv, contextTestArgvCamel, optionsTestArgv, testArgv)
    });
  }

  function verifierApprovalResumeState({ turn, message, classification, loop, verification, options = {}, permissionContext = null, context = null }) {
    const pendingToolCall = {
      id: verification.tool_result?.call_id || `verify:${turn.id}`,
      name: "test",
      params: verifierParamsFromMode(verification.mode, options, permissionContext),
      source: "runtime",
      requested_by_step_id: `verify:${turn.id}`
    };
    return {
      turn_id: turn.id,
      message,
      classification,
      messages: [],
      model_result: { content: "", tool_calls: [] },
      raw_tool_calls: [],
      pending_tool_call: pendingToolCall,
      remaining_tool_calls: [],
      iteration: 0,
      tool_results: [],
      tool_schemas: [],
      max_iterations: 1,
      options,
      context,
      permission_context: permissionContext,
      verification_context: {
        approval_phase: "verify",
        content: loop.content || "",
        tool_results: loop.toolResults || [],
        iterations: loop.iterations || 0,
        verification,
        context
      }
    };
  }

  function verifierPendingToolCallForResume(toolCall, verification = {}, options = {}, permissionContext = null) {
    if (!toolCall || toolCall.name !== "test") return toolCall;
    const mode = firstDefined(
      readPresent(verification, "mode"),
      readPresent(permissionContext, "verify_mode"),
      readPresent(permissionContext, "verifyMode"),
      readPresent(options, "verifyMode")
    );
    const params = verifierParamsFromMode(mode, options, permissionContext, toolCall.params);
    return Object.keys(params).length ? { ...toolCall, params } : toolCall;
  }

  function verifierParamsFromMode(mode, options = {}, permissionContext = null, existingParams = null) {
    if (mode === "detect") return { detect: true };
    if (mode === "run") {
      const testArgv = resolveVerifierTestArgv(options, permissionContext, existingParams);
      return testArgv ? { detect: false, argv: testArgv } : { detect: false };
    }
    return {};
  }

  function resolveVerifierTestArgv(options = {}, permissionContext = null, existingParams = null) {
    const value = firstDefined(
      readPresent(permissionContext, "test_argv"),
      readPresent(permissionContext, "testArgv"),
      readPresent(options, "testArgv"),
      readPresent(existingParams, "argv"),
      null
    );
    return Array.isArray(value) ? [...value] : null;
  }

  function mapVerifierToolResult(result, mode) {
    const reason = result.content?.[0]?.text || "";
    if (result.status === "success") {
      const exitCode = result.metadata?.exit_code;
      if (exitCode != null && exitCode !== 0) {
        return { status: "failed", tool_result: result, reason, exit_code: exitCode, mode };
      }
      return { status: "passed", tool_result: result, reason, mode };
    }
    if (result.status === "approval_required") {
      return { status: "approval_required", tool_result: result, reason, mode };
    }
    if (result.status === "denied") {
      return { status: "failed", tool_result: result, reason, mode };
    }
    return { status: result.status || "error", tool_result: result, reason, mode };
  }

  return { send, approve, interrupt, getState, listPaused, cancelPaused, restorePaused };
}

function normalizeApprovalDecision(decision) {
  const value = String(decision || "").toLowerCase();
  if (value === "approve" || value === "allow" || value === "yes") return "approve";
  if (value === "deny" || value === "reject" || value === "no") return "deny";
  throw new Error(`unknown approval decision: ${decision}`);
}

// 与 executor-loop.withBudgetSpent 保持同一形状(只取已耗,不带 max):
// 供验证器/修复期审批暂停把预算写进 resume_state,续跑按 spent 做种子。
function budgetSpentOf(budget) {
  const spent = budget.snapshot();
  return { tokens: spent.tokens, model_calls: spent.model_calls };
}

function readPresent(object, key, fallback = undefined) {
  if (object && Object.prototype.hasOwnProperty.call(object, key)) return object[key];
  return fallback;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined);
}

function sanitizeErrorMessage(error) {
  const message = String(error?.message || "unknown error");
  return message.length > 200 ? `${message.slice(0, 197)}...` : message;
}
