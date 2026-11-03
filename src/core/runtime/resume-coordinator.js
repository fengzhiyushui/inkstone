// src/core/runtime/resume-coordinator.js
// 恢复协调器:把 agent-runtime.js 中四条审批恢复路径的「恢复/结算/验证衔接」样板
// 收敛到一处:
//   1) 普通执行暂停(grantApprovalForToolCall → turn:resumed → resumeExecutorLoop
//      后的 awaiting/stopped/repair_context/verifyAndMaybeRepair 四向结算);
//   2) 修复期暂停(repair_context 分支:合并 all_tool_results、累计
//      totalToolCallRepairs、runRepairLoop(resumeAfterApproval) 后的四向结算);
//   3) task 子委派暂停(跳过授权、createPolicyContext 注入 taskDelegationResume、
//      stopped 时 onParentCompleted、savePausedRecord 的 replaceApprovalId 替换);
//   4) 跨进程恢复续跑(resumeRuntimeVerifierApproval / resumeRepairVerifierApproval
//      两个验证器审批恢复函数,以及暂停记录持久化衔接)。
// 依赖全部经 createResumeCoordinator({...deps}) 注入。注意循环依赖:
// verifyAndMaybeRepair 目前定义在 agent-runtime.js 内部且被恢复路径复用,这里用
// 依赖注入(把函数作为参数传入)打破循环,而非互相 import。
import { setTurnStatus } from "../protocol/agent-turn.js";
import { decideRepair } from "../verification/repair-decision.js";
import { createCostBudget } from "./cost-budget.js";
import { nowIso } from "../../shared/time.js";

export function createResumeCoordinator({
  sessionId,
  eventBus = null,
  publish,
  flushEvents = async () => {},
  pausedTurnStore,
  pausedTurnPersistence = null,
  taskDelegationHooks = null,
  grantApprovalForToolCall = async () => {},
  recoverySurface = "cli",
  resumeExecutorLoop,
  runRepairLoop,
  verifyAndMaybeRepair,
  toolExecutorFor,
  createPolicyContext,
  toolSchemas = () => [],
  modelGateway = null,
  maxTurnTokens = null,
  maxModelCalls = null,
  modelTimeoutMs = null,
  maxToolCallRepairs = 0,
  maxRepairAttempts = 2,
  transitionTo,
  clearTurnState,
  assertNotInterrupted,
  // 失败态 lifecycle 转换需沿用当前 channel(与原实现逐字一致)。
  getLifecycleChannel,
  permissionContextForRecord,
  policyOptionsFromPermissionContext,
  createVerificationPolicyFrom,
  verifierPendingToolCallForResume,
  mapVerifierToolResult,
  sanitizeErrorMessage
} = {}) {

  // ── 暂停记录持久化衔接 ──────────────────────────────────────────────

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
        if (record.resume_state?.task_delegation) {
          await taskDelegationHooks?.onParentPaused?.(record.approval_id, record);
        }
        if (replaceApprovalId !== record.approval_id) {
          if (previousRecord?.resume_state?.task_delegation && !record.resume_state?.task_delegation) {
            await taskDelegationHooks?.onParentCompleted?.(replaceApprovalId, previousRecord.resume_state.task_delegation);
          }
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
    if (record.resume_state?.task_delegation) {
      await taskDelegationHooks?.onParentPaused?.(record.approval_id, record);
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

  // 再暂停时把上一段修复进度的工具结果/修复计数并进新的 resume_state,
  // 避免审批替换 pause 记录后丢失 repair_context。
  function preserveRepairContextOnRePause(previousResumeState, nextResumeState) {
    const ctx = previousResumeState?.repair_context;
    if (!ctx || !nextResumeState) return nextResumeState;
    const priorRepairs = ctx.prior_tool_call_repairs ?? 0;
    const attemptRepairs = nextResumeState.tool_call_repairs ?? ctx.tool_call_repairs ?? 0;
    return {
      ...nextResumeState,
      repair_context: {
        ...ctx,
        prior_tool_call_repairs: priorRepairs,
        tool_call_repairs: attemptRepairs,
        total_tool_call_repairs: priorRepairs + attemptRepairs,
        max_tool_call_repairs: nextResumeState.max_tool_call_repairs ?? ctx.max_tool_call_repairs ?? 0,
        all_tool_results: [
          ...(ctx.all_tool_results || []),
          ...((nextResumeState.tool_results || []).filter((result) => !(ctx.all_tool_results || []).includes(result)))
        ],
        initial_tool_results: ctx.initial_tool_results || []
      }
    };
  }

  async function deletePausedSidecar(approvalId) {
    if (!pausedTurnPersistence?.delete) return false;
    return pausedTurnPersistence.delete(approvalId);
  }

  // State 5 幂等检查点:清掉已消费的暂停记录。持久化 consume 优先,失败只发
  // recovery:blocked 而不抛出,保证恢复流程不被清理动作反咬。
  async function clearConsumedPausedRecord(approvalId) {
    try {
      const existing = pausedTurnStore.get(approvalId);
      if (existing?.resume_state?.task_delegation) {
        await taskDelegationHooks?.onParentCompleted?.(approvalId, existing.resume_state.task_delegation);
      }
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

  // 恢复执行的外壳:操作失败即清掉已消费的暂停记录(RECOVERY_FAULT 不清除,
  // 交由上层恢复流程决定),再原样抛出。
  async function runAfterClearingConsumedPause(approvalId, operation) {
    try {
      return await operation();
    } catch (error) {
      if (error?.code !== "RECOVERY_FAULT") {
        await clearConsumedPausedRecord(approvalId);
      }
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

  // ── 恢复入口 ────────────────────────────────────────────────────────

  // approve() 审批通过后的恢复总入口:按 resume_state 分流到验证器审批恢复或
  // 普通执行/修复期续跑。三条路径共用预算续扣与回合状态收尾。
  async function resumeApproved({ record, approvalId, permissionContext, signal, approvalScope = "session", generation }) {
    transitionTo({ to: "execute", reason: "approval resolved", channel: "act" });
    const resumeOptions = record.resume_state.options || {};
    const resumeModelGateway = resumeOptions.modelGateway || modelGateway;
    // 暂停时已消耗的预算续扣(executor-loop 在 resume_state.budget_spent 落盘),
    // 避免审批暂停/续跑把已计 token/调用次数清零而实际超限。
    const budgetSpent = record.resume_state.budget_spent || null;
    const budget = createCostBudget({
      maxTokens: resumeOptions.maxTurnTokens ?? maxTurnTokens,
      maxModelCalls: resumeOptions.maxModelCalls ?? maxModelCalls,
      initialTokens: budgetSpent?.tokens || 0,
      initialModelCalls: budgetSpent?.model_calls || 0
    });
    if (record.resume_state.repair_context?.approval_phase === "verify") {
      return await resumeRepairVerifierApproval({ record, approvalId, permissionContext, signal, budget });
    }
    if (record.resume_state.verification_context?.approval_phase === "verify") {
      return await resumeRuntimeVerifierApproval({ record, approvalId, permissionContext, signal, budget });
    }

    const taskDelegation = record.resume_state?.task_delegation || null;
    // task 子委派暂停不在这里授权:授权发生在子任务自身的 approve 流程里。
    if (!taskDelegation) {
      await grantApprovalForToolCall(record.resume_state.pending_tool_call, {
        turnId: record.turn_id,
        toolCall: record.resume_state.pending_tool_call,
        options: record.resume_state.options || {},
        permission_context: permissionContext,
        scope: approvalScope
      });
    }
    await publishTurnResumed(record, approvalId);
    assertNotInterrupted(generation);
    const resumeParentToolNames = (record.resume_state.tool_schemas || [])
      .map((s) => s?.function?.name)
      .filter(Boolean);
    const loop = await runAfterClearingConsumedPause(approvalId, () => resumeExecutorLoop({
      resumeState: record.resume_state,
      modelGateway: resumeModelGateway,
      executeTool: toolExecutorFor(signal),
      createPolicyContext: ({ turnId, toolCall, phase }) => createPolicyContext({
        ...policyOptionsFromPermissionContext(permissionContext, { autonomy: permissionContext.autonomy || record.turn.autonomy }),
        turnId,
        toolCall,
        phase,
        sessionId,
        parentToolNames: resumeParentToolNames,
        parentBudget: budget,
        parentOptions: resumeOptions,
        scope: resumeOptions.scope || null,
        ...(taskDelegation && toolCall?.id === record.resume_state.pending_tool_call?.id ? {
          taskDelegationResume: {
            approvalId,
            decision: "approve",
            scope: approvalScope,
            taskDelegation,
            parentBudget: budget,
            parentRecord: record
          }
        } : {})
      }),
      eventBus,
      signal,
      budget,
      modelTimeoutMs: resumeOptions.modelTimeoutMs ?? modelTimeoutMs,
      maxToolCallRepairs: record.resume_state.max_tool_call_repairs ?? resumeOptions.maxToolCallRepairs ?? maxToolCallRepairs,
      sessionId
    }));
    assertNotInterrupted(generation);
    if (loop.status === "awaiting_approval") {
      const resumeState = preserveRepairContextOnRePause(record.resume_state, loop.resume_state);
      await savePausedRecord({
        approval: loop.approval,
        turn: record.turn,
        resumeState,
        permissionContext,
        replaceApprovalId: approvalId
      });
      transitionTo({ to: "awaiting_approval", reason: "tool approval required", channel: "system" });
      clearTurnState();
      return { status: "awaiting_approval", state: "awaiting_approval", content: loop.content, approval: loop.approval, turn: setTurnStatus(record.turn, "awaiting_approval") };
    }

    if (loop.status === "stopped") {
      if (record.resume_state?.task_delegation) {
        await taskDelegationHooks?.onParentCompleted?.(approvalId, record.resume_state.task_delegation);
      }
      const stoppedTurn = setTurnStatus(record.turn, "completed");
      publish(eventBus, "agent:final", { turn_id: record.turn_id, content: loop.content, status: "stopped" });
      transitionTo({ to: "idle", reason: "cost budget stop", channel: null });
      clearTurnState();
      return { status: "stopped", state: "idle", content: loop.content, turn: stoppedTurn, budget: loop.reason || null };
    }

    // Repair-phase approval: resume within the repair loop, not a fresh verifyAndMaybeRepair
    if (record.resume_state.repair_context) {
      const ctx = record.resume_state.repair_context;
      const mergedToolResults = [...ctx.all_tool_results, ...(loop.toolResults || [])];
      const effectiveRepairMaxToolCallRepairs = record.resume_state.max_tool_call_repairs
        ?? ctx.max_tool_call_repairs
        ?? record.resume_state.options?.maxToolCallRepairs
        ?? maxToolCallRepairs;
      const attemptToolCallRepairs = loop.toolCallRepairs ?? record.resume_state.tool_call_repairs ?? ctx.tool_call_repairs ?? 0;
      const totalToolCallRepairs = (ctx.prior_tool_call_repairs ?? 0) + attemptToolCallRepairs;
      const repairResult = await runAfterClearingConsumedPause(approvalId, () => runRepairLoop({
        turnId: record.turn_id,
        userMessage: record.turn.user_message,
        classification: record.resume_state.classification || { task_type: "edit" },
        modelGateway: resumeModelGateway,
        toolSchemas: typeof toolSchemas === "function" ? toolSchemas() : toolSchemas,
        executeTool: toolExecutorFor(signal),
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
        signal,
        maxRepairAttempts: ctx.max_repair_attempts,
        maxToolCallRepairs: effectiveRepairMaxToolCallRepairs,
        modelTimeoutMs: record.resume_state.options?.modelTimeoutMs ?? modelTimeoutMs,
        options: record.resume_state.options || {},
        permissionContext,
        context: record.resume_state.context || record.resume_state.repair_context?.context || null,
        resumeAfterApproval: {
          all_tool_results: mergedToolResults,
          verification: ctx.verification,
          attempt: ctx.attempt,
          attempts: ctx.attempts,
          total_tool_call_repairs: totalToolCallRepairs,
          max_tool_call_repairs: effectiveRepairMaxToolCallRepairs,
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
            permissionContext,
            replaceApprovalId: approvalId
          });
        }
        transitionTo({ to: "awaiting_approval", reason: "repair approval required", channel: "system" });
        clearTurnState();
        return {
          status: "awaiting_approval",
          state: "awaiting_approval",
          content: repairResult.content,
          approval: repairResult.approval,
          turn: setTurnStatus(record.turn, "awaiting_approval"),
          verification: repairResult.verification
        };
      }

      if (repairResult.status === "stopped") {
        const stoppedTurn = setTurnStatus(record.turn, "completed");
        publish(eventBus, "agent:final", { turn_id: record.turn_id, content: repairResult.content, status: "stopped" });
        await clearConsumedPausedRecord(approvalId);
        transitionTo({ to: "idle", reason: "cost budget stop", channel: null });
        clearTurnState();
        return { status: "stopped", state: "idle", content: repairResult.content, turn: stoppedTurn, budget: repairResult.reason || null, verification: repairResult.verification, repair: repairResult.repair || null };
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
      transitionTo({ to: "idle", reason: "turn complete", channel: null });
      clearTurnState();
      return { status: "complete", state: "idle", content: repairResult.content, turn: finalTurn, verification: repairResult.verification, repair: repairResult.repair || null };
    }

    const repaired = await runAfterClearingConsumedPause(approvalId, () => verifyAndMaybeRepair({
      turn: record.turn,
      message: record.turn.user_message,
      classification: record.resume_state.classification || { task_type: "edit" },
      loop,
      options: record.resume_state.options || {},
      signal,
      context: record.resume_state.context || null,
      permissionContext,
      budget,
      modelGateway: resumeModelGateway
    }));
    if (repaired.status === "awaiting_approval") {
      if (repaired.approval?.id && repaired.resume_state) {
        await savePausedRecord({
          approval: repaired.approval,
          turn: record.turn,
          resumeState: repaired.resume_state,
          permissionContext,
          replaceApprovalId: approvalId
        });
      }
      transitionTo({ to: "awaiting_approval", reason: "repair approval required", channel: "system" });
      clearTurnState();
      return {
        status: "awaiting_approval",
        state: "awaiting_approval",
        content: repaired.content,
        approval: repaired.approval,
        turn: setTurnStatus(record.turn, "awaiting_approval"),
        verification: repaired.verification
      };
    }
    if (repaired.status === "stopped") {
      const stoppedTurn = setTurnStatus(record.turn, "completed");
      publish(eventBus, "agent:final", { turn_id: record.turn_id, content: repaired.content, status: "stopped" });
      await clearConsumedPausedRecord(approvalId);
      transitionTo({ to: "idle", reason: "cost budget stop", channel: null });
      clearTurnState();
      return { status: "stopped", state: "idle", content: repaired.content, turn: stoppedTurn, budget: repaired.reason || null, verification: repaired.verification, repair: repaired.repair || null };
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
    transitionTo({ to: "idle", reason: "turn complete", channel: null });
    clearTurnState();
    return { status: "complete", state: "idle", content: repaired.content, turn: finalTurn, verification: repaired.verification, repair: repaired.repair || null };
  }

  // 跨进程恢复续跑:主验证器(test 工具)审批暂停后的恢复 —— 重跑验证器,
  // 再按 decideRepair 结算(none/repair/失败)。
  async function resumeRuntimeVerifierApproval({ record, approvalId, permissionContext, signal, budget = null }) {
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
    const verifierResult = await runAfterClearingConsumedPause(approvalId, () => toolExecutorFor(signal)(
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
      transitionTo({ to: "awaiting_approval", reason: "verification approval required", channel: "system" });
      clearTurnState();
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
      transitionTo({ to: "idle", reason: "turn complete", channel: null });
      clearTurnState();
      return { status: "complete", state: "idle", content, turn: finalTurn, verification, repair: null };
    }

    if (repair.decision === "repair") {
      const repairLoop = await runAfterClearingConsumedPause(approvalId, () => runRepairLoop({
        turnId: record.turn_id,
        userMessage: record.turn.user_message,
        classification: record.resume_state.classification || { task_type: "edit" },
        modelGateway: (record.resume_state.options || {}).modelGateway || modelGateway,
        toolSchemas: typeof toolSchemas === "function" ? toolSchemas() : toolSchemas,
        executeTool: toolExecutorFor(signal),
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
        signal,
        maxRepairAttempts: record.resume_state.options?.maxRepairAttempts || maxRepairAttempts,
        maxToolCallRepairs: record.resume_state.max_tool_call_repairs ?? record.resume_state.options?.maxToolCallRepairs ?? maxToolCallRepairs,
        modelTimeoutMs: record.resume_state.options?.modelTimeoutMs ?? modelTimeoutMs,
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
        transitionTo({ to: "awaiting_approval", reason: "repair approval required", channel: "system" });
        clearTurnState();
        return {
          status: "awaiting_approval",
          state: "awaiting_approval",
          content: repairLoop.content,
          approval: repairLoop.approval,
          turn: setTurnStatus(record.turn, "awaiting_approval"),
          verification: repairLoop.verification
        };
      }
      if (repairLoop.status === "stopped") {
        const stoppedTurn = setTurnStatus(record.turn, "completed");
        publish(eventBus, "agent:final", { turn_id: record.turn_id, content: repairLoop.content, status: "stopped" });
        await clearConsumedPausedRecord(approvalId);
        await flushEvents();
        transitionTo({ to: "idle", reason: "cost budget stop", channel: null });
        clearTurnState();
        return { status: "stopped", state: "idle", content: repairLoop.content, turn: stoppedTurn, budget: repairLoop.reason || null, verification: repairLoop.verification, repair: repairLoop.repair || null };
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
      transitionTo({ to: "idle", reason: "turn complete", channel: null });
      clearTurnState();
      return { status: "complete", state: "idle", content: repairLoop.content, turn: finalTurn, verification: repairLoop.verification, repair: repairLoop.repair || null };
    }

    await throwAfterClearingConsumedPause(
      approvalId,
      new Error(`verification failed: ${repair.reason || verification.reason || "repair failed"}`)
    );
  }

  // 跨进程恢复续跑:修复期验证器(test 工具)审批暂停后的恢复 —— 重跑验证器、
  // 记 repair:result,再按尝试次数决定继续 repair、完成或耗尽失败。
  async function resumeRepairVerifierApproval({ record, approvalId, permissionContext, signal, budget = null }) {
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
    const verifierResult = await runAfterClearingConsumedPause(approvalId, () => toolExecutorFor(signal)(
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
      transitionTo({ to: "awaiting_approval", reason: "repair verification approval required", channel: "system" });
      clearTurnState();
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
      transitionTo({ to: "idle", reason: "turn complete", channel: null });
      clearTurnState();
      return {
        status: "complete",
        state: "idle",
        content: "Repair complete.",
        turn: finalTurn,
        verification,
        repair: { attempts: ctx.attempt, status: "complete", history: attempts, tool_call_repairs: ctx.total_tool_call_repairs ?? ctx.tool_call_repairs ?? 0 }
      };
    }

    if (ctx.attempt < ctx.max_repair_attempts) {
      const effectiveRepairMaxToolCallRepairs = record.resume_state.max_tool_call_repairs
        ?? ctx.max_tool_call_repairs
        ?? record.resume_state.options?.maxToolCallRepairs
        ?? maxToolCallRepairs;
      const totalToolCallRepairs = ctx.total_tool_call_repairs ?? ctx.tool_call_repairs ?? record.resume_state.tool_call_repairs ?? 0;
      const repairLoop = await runAfterClearingConsumedPause(approvalId, () => runRepairLoop({
        turnId: record.turn_id,
        userMessage: record.turn.user_message,
        classification: record.resume_state.classification || { task_type: "edit" },
        modelGateway: (record.resume_state.options || {}).modelGateway || modelGateway,
        toolSchemas: typeof toolSchemas === "function" ? toolSchemas() : toolSchemas,
        executeTool: toolExecutorFor(signal),
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
        signal,
        maxRepairAttempts: ctx.max_repair_attempts,
        maxToolCallRepairs: effectiveRepairMaxToolCallRepairs,
        modelTimeoutMs: record.resume_state.options?.modelTimeoutMs ?? modelTimeoutMs,
        options: record.resume_state.options || {},
        permissionContext,
        context: record.resume_state.context || ctx.context || null,
        resumeAfterApproval: {
          all_tool_results: ctx.all_tool_results,
          verification,
          attempt: ctx.attempt + 1,
          attempts,
          total_tool_call_repairs: totalToolCallRepairs,
          max_tool_call_repairs: effectiveRepairMaxToolCallRepairs,
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
        transitionTo({ to: "awaiting_approval", reason: "repair approval required", channel: "system" });
        clearTurnState();
        return {
          status: "awaiting_approval",
          state: "awaiting_approval",
          content: repairLoop.content,
          approval: repairLoop.approval,
          turn: setTurnStatus(record.turn, "awaiting_approval"),
          verification: repairLoop.verification
        };
      }
      if (repairLoop.status === "stopped") {
        const stoppedTurn = setTurnStatus(record.turn, "completed");
        publish(eventBus, "agent:final", { turn_id: record.turn_id, content: repairLoop.content, status: "stopped" });
        await clearConsumedPausedRecord(approvalId);
        await flushEvents();
        transitionTo({ to: "idle", reason: "cost budget stop", channel: null });
        clearTurnState();
        return { status: "stopped", state: "idle", content: repairLoop.content, turn: stoppedTurn, budget: repairLoop.reason || null, verification: repairLoop.verification, repair: repairLoop.repair || null };
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
      transitionTo({ to: "idle", reason: "turn complete", channel: null });
      clearTurnState();
      return { status: "complete", state: "idle", content: repairLoop.content, turn: finalTurn, verification: repairLoop.verification, repair: repairLoop.repair || null };
    }

    publish(eventBus, "repair:exhausted", { turn_id: record.turn_id, attempts: ctx.max_repair_attempts, verification_status: verification.status });
    const failure = new Error(`verification failed: ${verification.reason || "repair failed"}`);
    await clearConsumedPausedRecord(approvalId);
    await flushEvents().catch(() => {});
    transitionTo({ to: "failed", reason: verification.reason || "repair failed", channel: getLifecycleChannel() });
    clearTurnState();
    throw failure;
  }

  return {
    resumeApproved,
    savePausedRecord,
    clearConsumedPausedRecord,
    deletePausedSidecar
  };
}
