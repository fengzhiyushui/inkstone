import { runDispatchLoop, resumeDispatchLoop } from "./dispatch-loop.js";
import { fingerprint } from "./subtask-schema.js";
import { classifyOutcome } from "./synthesizer.js";
import { riskRules } from "../memory/risk-rules.js";
import { serializeOrchestrationState, deserializeOrchestrationState, orchestrationResumeGate } from "./orchestration-recovery-contract.js";
import { createRequestScope } from "../runtime/request-budget.js";

export function createOrchestrator({
  planner, makeWorkerFactory, makeReviewerFor, synthesizer, makeBudget, maxSubtasks, maxWorkerAttempts,
  eventBus, makeContext, maxParallelWorkers = 1, toBatches, runIsolatedWorker, mergeSubtask, removeIso, maxRounds = 1,
  crossTaskLearning = "off", experienceRetrieval = null, experienceConsolidator = null, now = () => Date.now(),
  orchPersistence = null, makeResumedBudget = null, env = { root: null, orchestrationConfig: null },
  pausedTurnStore = null, pausedTurnPersistence = null
}) {
  const orchPaused = new Map();   // approvalId -> { state, dispatchResume }  (C5 same-process resume)
  const pendingConsolidations = new Set();   // C4: background experience consolidation promises
  const backgroundScopes = new Set();
  const learningOn = crossTaskLearning !== "off" && !!experienceRetrieval && !!experienceConsolidator;
  let activeRunningScope = null;

  async function run({ message, options = {}, routing = {}, scope = null }) {
    const activeScope = scope || createRequestScope({
      budget: makeBudget(),
      signal: options.signal,
      executionId: "task_" + Math.trunc(now()).toString(36)
    });
    const budget = activeScope.budget;
    activeRunningScope = activeScope;
    try {
      return await executeRun({ message, options, routing, activeScope, budget });
    } finally {
      if (activeRunningScope === activeScope) activeRunningScope = null;
    }
  }

  async function executeRun({ message, options, routing, activeScope, budget }) {

    const context = await makeContext?.({ message, options });
    let experiences = [];
    let presentedIds = [];
    let riskCues = new Set();
    if (learningOn) {
      const r = experienceRetrieval.query({ message }) || {};
      experiences = r.procedural || [];
      presentedIds = r.presentedIds || [];
      riskCues = r.riskCues || new Set();
      publish(eventBus, "experience:retrieved", { count: experiences.length, tiers: experiences.map((e) => e.tier), riskCueCount: riskCues.size });
    }

    let plan;
    try {
      plan = await planner.plan({ message, context, experiences, signal: activeScope.signal, scope: activeScope });
    } catch (e) {
      if (e.code === "BUDGET_EXCEEDED" || budget.exceeded()) {
        const state = {
          message, options, plan: { subtasks: [] }, round: 1, allCollected: [],
          seenSubtaskIds: new Set(), seenFp: new Set(), budget, scope: activeScope,
          stoppedByCap: true, done_when: "the request is fulfilled", adoptedExperienceIds: [], riskCues: new Set(),
          taskId: "task_" + Math.trunc(now()).toString(36), sessionId: options.sessionId || "session",
          executionId: activeScope?.executionId || budget?.executionId || ("task_" + Math.trunc(now()).toString(36)),
          env
        };
        return finalize(state);
      }
      throw e;
    }

    if (plan.subtasks.length > maxSubtasks) plan.subtasks = plan.subtasks.slice(0, maxSubtasks);
    publish(eventBus, "orchestration:planned", { subtasks: plan.subtasks.length, done_when: plan.done_when });
    const adoptedExperienceIds = learningOn ? intersect(plan.used_experience_ids, presentedIds) : [];
    const state = {
      message, options, plan, round: 1, allCollected: [],
      seenSubtaskIds: new Set(plan.subtasks.map((s) => s.id)),
      seenFp: new Set(plan.subtasks.map(fingerprint)),
      budget, scope: activeScope, stoppedByCap: false, done_when: plan.done_when,
      adoptedExperienceIds, riskCues,
      taskId: "task_" + Math.trunc(now()).toString(36), sessionId: options.sessionId || "session",
      executionId: activeScope?.executionId || budget?.executionId || ("task_" + Math.trunc(now()).toString(36)),
      env
    };
    return driveFrom(state, { afterPausedRound: false });
  }

  function dispatchDeps(state) {
    const workerFactory = makeWorkerFactory(state.scope);
    return {
      workerFactory,
      makeReviewer: () => makeReviewerFor(workerFactory, state.scope),
      synthesizer, budget: state.budget, maxWorkerAttempts,
      autonomy: state.options.autonomy || "gated",
      onEvent: (type, data) => publish(eventBus, `orchestration:${type}`, data),
      toBatches, maxParallelWorkers,
      runIsolatedWorker: (args) => runIsolatedWorker({ ...args, scope: state.scope }),
      mergeSubtask, removeIso,
      projectRules: learningOn ? riskRules(state.riskCues) : [],
      orchestrationMarker: orchPersistence ? { taskId: state.taskId, sessionId: state.sessionId } : null,
      scope: state.scope
    };
  }

  async function driveFrom(state, { afterPausedRound }) {
    let skipDispatch = afterPausedRound;
    let lastRoundCollected = [];
    while (true) {
      if (!skipDispatch) {
        publish(eventBus, "orchestration:round_started", { round: state.round, subtasks: state.plan.subtasks.length });
        const result = await runDispatchLoop({ plan: state.plan, ...dispatchDeps(state) });
        state.allCollected.push(...result.collected);
        if (result.status === "awaiting_approval") {
          orchPaused.set(result.approval.id, { state, dispatchResume: result.resume });
          await persistDurablePause(state, result);      // M5: durable double-write (no-op when off)
          return { status: "awaiting_approval", approval: result.approval, collected: state.allCollected };
        }
        if (result.status === "cancelled" || state.scope?.signal?.aborted) {
          publish(eventBus, "orchestration:cancelled", { round: state.round, completed: count(state.allCollected, "complete") });
          return { status: "cancelled", outcome: "cancelled", collected: state.allCollected };
        }
        lastRoundCollected = result.collected;
      } else {
        lastRoundCollected = state.allCollected;   // after a paused round, treat whole round's collected as progress signal
      }
      skipDispatch = false;
      const gate = await gateAndReplan(state, lastRoundCollected);
      if (gate.cancelled || state.scope?.signal?.aborted) {
        publish(eventBus, "orchestration:cancelled", { round: state.round, completed: count(state.allCollected, "complete") });
        return { status: "cancelled", outcome: "cancelled", collected: state.allCollected };
      }
      if (!gate.continue) { state.stoppedByCap = gate.cap; break; }
      state.plan = { subtasks: gate.subtasks };
      state.round += 1;
    }
    return finalize(state);
  }

  async function gateAndReplan(state, roundCollected) {
    if (state.scope?.signal?.aborted) return { continue: false, cap: false, cancelled: true };
    if (state.round >= maxRounds) return { continue: false, cap: true };
    if (state.budget.exceeded()) return { continue: false, cap: true };
    const completed = state.allCollected.filter((c) => c.status === "complete").map(sumEntry);
    const failed = state.allCollected.filter((c) => c.status !== "complete").map(sumEntry);
    const completedIds = new Set(completed.map((c) => c.id));
    const failedIds = new Set(failed.map((c) => c.id));
    let next;
    try {
      next = await planner.replan?.({ message: state.message, done_when: state.done_when, completed, failed, seenSubtaskIds: state.seenSubtaskIds, completedIds, failedIds, signal: state.scope?.signal, scope: state.scope });
    } catch (e) {
      if (e.code === "BUDGET_EXCEEDED" || state.budget.exceeded()) return { continue: false, cap: true };
      next = { done: true, subtasks: [] };
    }
    if (!next || next.done || !next.subtasks?.length) return { continue: false, cap: false };
    // no-progress guard: round completed nothing AND every proposed subtask is a stale fingerprint
    const completedThisRound = (roundCollected || []).filter((c) => c.status === "complete").length;
    const fresh = next.subtasks.filter((s) => !state.seenFp.has(fingerprint(s)));
    if (completedThisRound === 0 && fresh.length === 0) return { continue: false, cap: false };
    publish(eventBus, "orchestration:replanned", { round: state.round + 1, done: false, new_subtasks: next.subtasks.length });
    for (const s of next.subtasks) { state.seenSubtaskIds.add(s.id); state.seenFp.add(fingerprint(s)); }
    return { continue: true, subtasks: next.subtasks, cap: false };
  }

  async function finalize(state) {
    if (state.scope?.signal?.aborted) {
      const abortSnap = typeof state.budget?.snapshot === "function" ? state.budget.snapshot() : null;
      publish(eventBus, "orchestration:cancelled", { round: state.round, completed: count(state.allCollected, "complete"), executionId: state.executionId });
      return { status: "cancelled", outcome: "cancelled", collected: state.allCollected, budget: abortSnap, executionId: state.executionId };
    }
    const content = await synthesizer.synthesize({ message: state.message, collected: state.allCollected, signal: state.scope?.signal, scope: state.scope });
    const status = classifyOutcome(state.allCollected, { stoppedByCap: state.stoppedByCap });
    const snap = typeof state.budget?.snapshot === "function" ? state.budget.snapshot() : null;
    publish(eventBus, "orchestration:completed", { rounds: state.round, completed: count(state.allCollected, "complete"), failed: count(state.allCollected, "failed"), status, executionId: state.executionId });
    if (learningOn) kickConsolidation(state, status);
    return { status: "complete", content, collected: state.allCollected, outcome: status, budget: snap, executionId: state.executionId };
  }

  // C4: consolidate experience in the background — never blocks the user's result.
  // Tracked so flushExperience()/dispose can await it (no lost writes).
  function kickConsolidation(state, outcome) {
    if (state.scope?.signal?.aborted || state.budget?.exceeded()) {
      publish(eventBus, "experience:consolidation_skipped", { taskId: state.taskId, reason: "budget_or_abort" });
      return;
    }
    const bgScope = state.scope;
    if (bgScope) backgroundScopes.add(bgScope);
    const p = Promise.resolve()
      .then(() => experienceConsolidator.consolidate({
        message: state.message, done_when: state.done_when, allCollected: state.allCollected,
        outcome, adoptedExperienceIds: state.adoptedExperienceIds, taskId: state.taskId, sessionId: state.sessionId
      }, { scope: bgScope, signal: bgScope?.signal }))
      .then((r) => publish(eventBus, "experience:consolidated", { taskId: state.taskId, written: r?.written || 0 }))
      .catch(() => {})
      .finally(() => {
        pendingConsolidations.delete(p);
        if (bgScope) backgroundScopes.delete(bgScope);
      });
    pendingConsolidations.add(p);
  }

  async function flushExperience() { await Promise.allSettled([...pendingConsolidations]); }

  function sumEntry(c) { return { id: c.st.id, goal: c.st.goal, note: c.status === "complete" ? String(c.wres?.content ?? "").slice(0, 160) : String(c.lastFeedback ?? "") }; }

  // C5: same-process orchestration resume. Finish the paused round, then continue
  // the round loop from saved state — no re-plan, no duplicate dispatch.
  async function resume(id, decision = "approve") {
    const saved = orchPaused.get(id);
    if (!saved) { const e = new Error(`no paused orchestration: ${id}`); e.code = "ORCH_NOT_PAUSED"; throw e; }
    orchPaused.delete(id);                                  // consume in-memory
    const { state, dispatchResume } = saved;
    activeRunningScope = state.scope;
    try {
      const res = await resumeDispatchLoop(dispatchResume, decision);
      state.allCollected.push(...res.collected);
      if (decision === "deny") await consumeWorkerSidecar(dispatchResume.pausedApprovalId);   // M5: deny cleans worker sidecar
      if (orchPersistence) await orchPersistence.consume(id).catch(() => {});                  // M5: consume old durable sidecar
      if (res.status === "awaiting_approval") {
        orchPaused.set(res.approval.id, { state, dispatchResume: res.resume });   // re-pause: new id
        await persistDurablePause(state, res);                                    // M5: new durable sidecar
        return { status: "awaiting_approval", approval: res.approval, collected: state.allCollected };
      }
      if (res.status === "cancelled" || state.scope?.signal?.aborted) {
        publish(eventBus, "orchestration:cancelled", { round: state.round, completed: count(state.allCollected, "complete") });
        return { status: "cancelled", outcome: "cancelled", collected: state.allCollected };
      }
      return await driveFrom(state, { afterPausedRound: true });    // round done -> gate + further rounds
    } finally {
      if (activeRunningScope === state.scope) activeRunningScope = null;
    }
  }

  function blocked(reason) {
    const e = new Error(`orchestration recovery blocked: ${reason}`);
    e.code = "ORCH_RECOVERY_BLOCKED";
    return e;
  }

  // Consume a worker sidecar the deny path leaves behind (resumeDispatchLoop never
  // calls the worker's approve on deny, so agent-runtime never consumed it). No-op
  // primitives when recovery is off. Reused by the same-process resume (M5).
  async function consumeWorkerSidecar(approvalId) {
    await pausedTurnPersistence?.consume?.(approvalId);
    pausedTurnStore?.delete?.(approvalId);
  }

  // Persist a durable snapshot of a fresh pause (initial or re-pause). Opt-in: no-op
  // unless orchPersistence is injected (recovery.enabled). Used by driveFrom/resume (M5)
  // and resumeDurable's re-pause branch.
  async function persistDurablePause(state, roundResult) {
    if (!orchPersistence) return;
    const json = serializeState(state, {
      approvalId: roundResult.approval.id,
      pausedSubtask: roundResult.resume.pausedSubtask,
      remaining: roundResult.resume.remaining
    });
    await orchPersistence.save(roundResult.approval.id, json);
  }

  // Cross-process orchestration resume. Rebuild the paused worker from the persisted
  // subtask, rehydrate its turn via the shared store, settle, then continue the round
  // loop from saved state — no re-plan, no duplicate dispatch (CST-3).
  async function resumeDurable(approvalId, decision = "approve") {
    let sidecar;
    try { sidecar = await orchPersistence.load(approvalId); }
    catch (e) { throw blocked(`orchestration sidecar unreadable: ${e.message}`); }
    if (sidecar?.status === "consumed") throw blocked("orchestration sidecar already consumed");
    let workerRecord = pausedTurnStore?.get?.(approvalId) || null;
    if (!workerRecord && pausedTurnPersistence?.load) {
      try {
        const loaded = await pausedTurnPersistence.load(approvalId);
        if (loaded && loaded.status !== "consumed") {
          pausedTurnStore?.restore?.(loaded);
          workerRecord = loaded;
        }
      } catch {}
    }
    const gate = orchestrationResumeGate({ sidecar, workerRecord });   // CST-6 + CST-7, fail-closed
    if (!gate.ok) throw blocked(gate.reason);

    const state = deserializeState(sidecar);
    activeRunningScope = state.scope;
    try {
      const pausedWorker = makeWorkerFactory(state.scope).worker(state.pausedSubtask);   // deterministic rebuild (CST-3)
      const dispatchResume = {
        pausedWorker, pausedApprovalId: approvalId,
        pausedSubtask: state.pausedSubtask, remaining: state.remaining, deps: dispatchDeps(state)
      };
      const res = await resumeDispatchLoop(dispatchResume, decision);
      state.allCollected.push(...res.collected);
      if (decision === "deny") await consumeWorkerSidecar(approvalId);
      if (res.status === "awaiting_approval") {
        await persistDurablePause(state, res);                // re-pause: new durable sidecar
        await orchPersistence.consume(approvalId);            // consume the old one
        orchPaused.set(res.approval.id, { state, dispatchResume: res.resume });   // same-process re-resume too
        return { status: "awaiting_approval", approval: res.approval, collected: state.allCollected };
      }
      if (res.status === "cancelled" || state.scope?.signal?.aborted) {
        await orchPersistence.consume(approvalId);
        publish(eventBus, "orchestration:cancelled", { round: state.round, completed: count(state.allCollected, "complete") });
        return { status: "cancelled", outcome: "cancelled", collected: state.allCollected };
      }
      await orchPersistence.consume(approvalId);              // round settled: consume this sidecar
      return await driveFrom(state, { afterPausedRound: true });
    } finally {
      if (activeRunningScope === state.scope) activeRunningScope = null;
    }
  }

  function hasDurablePaused(approvalId) {
    if (!orchPersistence) return Promise.resolve(false);
    return orchPersistence.load(approvalId).then((r) => !!r && r.status !== "consumed").catch(() => false);
  }

  // Durable recovery (opt-in): serialize the wrapper state to a sidecar JSON, and
  // rebuild it after restart with a live budget that continues from prior spend.
  function serializeState(state, pauseInfo) {
    return serializeOrchestrationState(state, pauseInfo);
  }
  function deserializeState(json) {
    const s = deserializeOrchestrationState(json);
    const budget = makeResumedBudget ? makeResumedBudget({
      ...s.budgetSnapshot,
      executionId: s.executionId || s.taskId,
      initialByRole: s.budgetSnapshot?.initialByRole || {}
    }) : makeBudget();
    const scope = createRequestScope({ budget, executionId: s.executionId || s.taskId });
    return { ...s, budget, scope, stoppedByCap: false };
  }
  function interrupt() {
    let interrupted = false;
    if (activeRunningScope) {
      activeRunningScope.abort("turn was interrupted");
      interrupted = true;
    }
    for (const s of backgroundScopes) {
      try { s.abort("turn was interrupted"); interrupted = true; } catch {}
    }
    return interrupted;
  }

  return { run, resume, hasPaused: (id) => orchPaused.has(id), flushExperience, serializeState, deserializeState, resumeDurable, hasDurablePaused, interrupt };
}

function intersect(a, b) {
  const s = new Set(b || []);
  return (a || []).filter((x) => s.has(x));
}

// C5: final outcome — model's replan.done never auto-implies success.

function count(c, s) { return c.filter((x) => x.status === s).length; }
function publish(bus, type, data) { if (bus && typeof bus.publish === "function") bus.publish(type, data); }
