// tests/unit/core/orchestration/orchestration-recovery.test.js — 编排恢复(恢复/暂停持久化/共享暂停存储)领域测试
//
// v1.19.1 测试归并:本文件由下列历史任务单测试合并而成,每个来源包裹在独立
// describe 块中(异步回调 + 动态 import,来源间零共享绑定),测试语义与拆分前一致。
import { describe } from "node:test";

// ---------------------------------------------------------------------------
// 来源:tests/core/orchestration/orchestrator-resume.test.js
// ---------------------------------------------------------------------------
describe("core/orchestration/orchestrator-resume", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createOrchestrator } = await import("../../../../src/core/orchestration/orchestrator.js");

  function st(id) { return { id, goal: id, acceptance: [], context_scope: {}, tool_profile: "edit", depends_on: [] }; }

  function build({ subtasks, workerFor, replan = async () => ({ done: true, subtasks: [] }), onPlan = () => {}, maxRounds = 2 }) {
    return createOrchestrator({
      planner: { plan: async () => { onPlan(); return { task_summary: "t", done_when: "d", subtasks }; }, replan },
      makeWorkerFactory: () => ({ worker: (s) => workerFor(s) }),
      makeReviewerFor: () => ({ review: async () => ({ pass: true, severity: "warn", reasons: [], checked: [] }) }),
      synthesizer: { synthesize: async ({ collected }) => collected.map((c) => `${c.st.id}=${c.status}`).join(",") },
      makeBudget: () => ({ exceeded: () => null }),
      maxSubtasks: 8, maxWorkerAttempts: 1, eventBus: { publish() {} }, makeContext: async () => null, maxRounds
    });
  }

  test("pause -> resume continues without re-plan or duplicate dispatch", async () => {
    let planCalls = 0;
    const pausedWorker = { send: async () => ({ status: "awaiting_approval", approval: { id: "ap1" } }), approve: async () => ({ status: "complete", content: "did a" }) };
    const orch = build({
      subtasks: [st("a"), st("b")],
      workerFor: (s) => (s.id === "a" ? pausedWorker : { send: async () => ({ status: "complete", content: "did b" }) }),
      onPlan: () => { planCalls += 1; }
    });
    const p = await orch.run({ message: "m", options: { autonomy: "gated" } });
    assert.equal(p.status, "awaiting_approval");
    assert.equal(orch.hasPaused("ap1"), true);
    const done = await orch.resume("ap1", "approve");
    assert.equal(done.status, "complete");
    assert.match(done.content, /a=complete/);
    assert.match(done.content, /b=complete/);
    assert.equal(planCalls, 1);                       // NOT re-planned
    assert.equal(done.collected.filter((c) => c.st.id === "a").length, 1);  // no duplicate
    assert.equal(orch.hasPaused("ap1"), false);       // consumed
  });

  test("multi-pause chain: approve -> pause again -> approve -> complete", async () => {
    let aDone = false, bDone = false;
    const workerA = { send: async () => ({ status: "awaiting_approval", approval: { id: "apA" } }), approve: async () => { aDone = true; return { status: "complete", content: "a" }; } };
    const workerB = { send: async () => ({ status: "awaiting_approval", approval: { id: "apB" } }), approve: async () => { bDone = true; return { status: "complete", content: "b" }; } };
    const orch = build({ subtasks: [st("a"), st("b")], workerFor: (s) => (s.id === "a" ? workerA : workerB) });
    const p1 = await orch.run({ message: "m", options: { autonomy: "gated" } });
    assert.equal(p1.approval.id, "apA");
    const p2 = await orch.resume("apA", "approve");     // a approved -> b pauses
    assert.equal(p2.status, "awaiting_approval");
    assert.equal(p2.approval.id, "apB");
    assert.equal(orch.hasPaused("apA"), false);         // old consumed
    assert.equal(orch.hasPaused("apB"), true);          // new stored
    const done = await orch.resume("apB", "approve");
    assert.equal(done.status, "complete");
    assert.ok(aDone && bDone);
    assert.match(done.content, /a=complete/);
    assert.match(done.content, /b=complete/);
  });

  test("deny -> paused subtask failed, loop continues", async () => {
    const pausedWorker = { send: async () => ({ status: "awaiting_approval", approval: { id: "ap1" } }), approve: async () => ({ status: "complete", content: "x" }) };
    const orch = build({ subtasks: [st("a"), st("b")], workerFor: (s) => (s.id === "a" ? pausedWorker : { send: async () => ({ status: "complete", content: "ok" }) }) });
    await orch.run({ message: "m", options: { autonomy: "gated" } });
    const done = await orch.resume("ap1", "deny");
    assert.match(done.content, /a=failed/);
    assert.match(done.content, /b=complete/);
    assert.equal(done.outcome, "partial");
  });

  test("resume unknown id throws", async () => {
    const orch = build({ subtasks: [st("a")], workerFor: () => ({ send: async () => ({ status: "complete", content: "x" }) }) });
    await assert.rejects(() => orch.resume("nope", "approve"), (e) => e.code === "ORCH_NOT_PAUSED");
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/core/orchestration/orchestrator-resume-durable.test.js
// ---------------------------------------------------------------------------
describe("core/orchestration/orchestrator-resume-durable", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createOrchestrator } = await import("../../../../src/core/orchestration/orchestrator.js");
  const { serializeOrchestrationState } = await import("../../../../src/core/orchestration/orchestration-recovery-contract.js");

  function stub(id) { return { id, goal: id, acceptance: [], context_scope: {}, tool_profile: "edit", depends_on: [] }; }
  function noBudget() { return { exceeded: () => null, snapshot: () => ({ tokens: 0, model_calls: 0, max_tokens: null, max_model_calls: null }) }; }

  function makeSidecar({ approvalId = "ap1", taskId = "task_1", sessionId = "s", subtaskId = "a", remaining = [] } = {}) {
    const state = {
      message: "m", done_when: "d", options: { autonomy: "gated", sessionId },
      plan: { subtasks: [stub(subtaskId)] }, round: 1, allCollected: [],
      seenSubtaskIds: new Set([subtaskId]), seenFp: new Set(["fp"]), budget: noBudget(),
      adoptedExperienceIds: [], riskCues: new Set(), taskId, sessionId, env: { root: "/root", orchestrationConfig: {} }
    };
    return serializeOrchestrationState(state, { approvalId, pausedSubtask: stub(subtaskId), remaining });
  }
  function makeWorkerRecord({ approvalId = "ap1", taskId = "task_1", sessionId = "s", subtaskId = "a", marker = true } = {}) {
    return { approval_id: approvalId, turn_id: "t", approval: { id: approvalId }, turn: {}, resume_state: { options: marker ? { __orchestration: { taskId, sessionId, subtaskId } } : {} } };
  }

  function buildDurable(opts = {}) {
    const {
      workerFor, replan = async () => ({ done: true, subtasks: [] }), onPlan = () => {},
      sidecar = makeSidecar(), workerRecord = makeWorkerRecord(), reviewerPass = true, onWorkerBuild = () => {},
      orchConsumeSpy = () => {}, orchSaveSpy = () => {}, workerConsumeSpy = () => {}
    } = opts;
    return createOrchestrator({
      planner: { plan: async () => { onPlan(); return { subtasks: [] }; }, replan },
      makeWorkerFactory: () => ({ worker: (st) => { onWorkerBuild(st); return workerFor(st); } }),
      makeReviewerFor: () => ({ review: async () => ({ pass: reviewerPass, severity: "warn", reasons: [], checked: [] }) }),
      synthesizer: { synthesize: async ({ collected }) => collected.map((c) => `${c.st.id}=${c.status}`).join(",") },
      makeBudget: () => noBudget(), makeResumedBudget: () => noBudget(),
      maxSubtasks: 8, maxWorkerAttempts: 1, eventBus: { publish() {} }, makeContext: async () => null, maxRounds: 2,
      orchPersistence: { load: async () => sidecar, consume: async (id) => orchConsumeSpy(id), save: async (id, json) => orchSaveSpy(id, json) },
      pausedTurnStore: { get: () => workerRecord, delete: () => {} },
      pausedTurnPersistence: { consume: async (id) => workerConsumeSpy(id) },
      env: { root: "/root", orchestrationConfig: {} }
    });
  }

  test("resumeDurable: gate passes → rebuild + approve → settle → complete (no re-plan)", async () => {
    let planCalls = 0, approveCalls = 0, orchConsumed = null;
    const orch = buildDurable({
      workerFor: () => ({ approve: async () => { approveCalls += 1; return { status: "complete", content: "did a" }; } }),
      onPlan: () => { planCalls += 1; }, orchConsumeSpy: (id) => { orchConsumed = id; }
    });
    const done = await orch.resumeDurable("ap1", "approve");
    assert.equal(done.status, "complete");
    assert.match(done.content, /a=complete/);
    assert.equal(approveCalls, 1);
    assert.equal(planCalls, 0);          // durable resume never re-plans
    assert.equal(orchConsumed, "ap1");   // orchestration sidecar consumed on completion
  });

  test("resumeDurable: fingerprint mismatch → ORCH_RECOVERY_BLOCKED, no rebuild, no approve (CST-6)", async () => {
    let built = 0, approveCalls = 0;
    const bad = makeSidecar(); bad.fingerprints = { workerFactory: 9, toolSubset: 1, subtaskSchema: 1 };
    const orch = buildDurable({
      sidecar: bad, onWorkerBuild: () => { built += 1; },
      workerFor: () => ({ approve: async () => { approveCalls += 1; return { status: "complete" }; } })
    });
    await assert.rejects(() => orch.resumeDurable("ap1", "approve"), (e) => e.code === "ORCH_RECOVERY_BLOCKED");
    assert.equal(built, 0);
    assert.equal(approveCalls, 0);
  });

  test("resumeDurable: ownership mismatch → blocked (CST-7)", async () => {
    const orch = buildDurable({
      workerRecord: makeWorkerRecord({ subtaskId: "WRONG" }),
      workerFor: () => ({ approve: async () => ({ status: "complete" }) })
    });
    await assert.rejects(() => orch.resumeDurable("ap1", "approve"), (e) => e.code === "ORCH_RECOVERY_BLOCKED");
  });

  test("resumeDurable: missing worker record → blocked (orphan, CST-4)", async () => {
    const orch = buildDurable({ workerRecord: null, workerFor: () => ({ approve: async () => ({ status: "complete" }) }) });
    await assert.rejects(() => orch.resumeDurable("ap1", "approve"), (e) => e.code === "ORCH_RECOVERY_BLOCKED");
  });

  test("resumeDurable: deny → paused subtask failed, worker sidecar consumed, round continues", async () => {
    let workerConsumed = null;
    const orch = buildDurable({
      workerFor: () => ({ approve: async () => { throw new Error("approve must not be called on deny"); } }),
      workerConsumeSpy: (id) => { workerConsumed = id; }
    });
    const done = await orch.resumeDurable("ap1", "deny");
    assert.match(done.content, /a=failed/);
    assert.equal(done.outcome, "partial");
    assert.equal(workerConsumed, "ap1");   // deny path consumes the worker sidecar (agent-runtime didn't)
  });

  test("resumeDurable: re-pause writes a new durable sidecar and consumes the old", async () => {
    let saved = null, orchConsumed = null;
    const workers = {
      a: { approve: async () => ({ status: "complete", content: "a" }) },
      b: { send: async () => ({ status: "awaiting_approval", approval: { id: "ap2" } }) }
    };
    const orch = buildDurable({
      sidecar: makeSidecar({ subtaskId: "a", remaining: [stub("b")] }),
      workerFor: (st) => (st.id === "a" ? workers.a : workers.b),
      orchSaveSpy: (id) => { saved = id; }, orchConsumeSpy: (id) => { orchConsumed = id; }
    });
    const res = await orch.resumeDurable("ap1", "approve");
    assert.equal(res.status, "awaiting_approval");
    assert.equal(res.approval.id, "ap2");
    assert.equal(saved, "ap2");          // new durable sidecar written
    assert.equal(orchConsumed, "ap1");   // old consumed
    assert.equal(orch.hasPaused("ap2"), true);  // also tracked in-memory for same-process re-resume
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/core/orchestration/orchestration-pause-persist.test.js
// ---------------------------------------------------------------------------
describe("core/orchestration/orchestration-pause-persist", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { runDispatchLoop } = await import("../../../../src/core/orchestration/dispatch-loop.js");
  const { createOrchestrator } = await import("../../../../src/core/orchestration/orchestrator.js");

  function st(id) { return { id, goal: id, acceptance: [], context_scope: {}, tool_profile: "edit", depends_on: [] }; }
  const reviewerOk = () => ({ review: async () => ({ pass: true, severity: "warn", reasons: [], checked: [] }) });

  test("worker send options carry __orchestration marker when durable", async () => {
    let captured = null;
    const worker = { send: async (_p, opts) => { captured = opts; return { status: "awaiting_approval", approval: { id: "apX" } }; }, approve: async () => ({}) };
    await runDispatchLoop({
      plan: { subtasks: [st("a")] }, workerFactory: { worker: () => worker }, makeReviewer: reviewerOk,
      synthesizer: { synthesize: async () => "" }, budget: { exceeded: () => null }, maxWorkerAttempts: 1, autonomy: "gated",
      orchestrationMarker: { taskId: "task_1", sessionId: "s" }
    });
    assert.deepEqual(captured.__orchestration, { taskId: "task_1", sessionId: "s", subtaskId: "a" });
  });

  test("no __orchestration marker when not durable (off parity)", async () => {
    let captured = null;
    const worker = { send: async (_p, opts) => { captured = opts; return { status: "complete", content: "ok" }; } };
    await runDispatchLoop({
      plan: { subtasks: [st("a")] }, workerFactory: { worker: () => worker }, makeReviewer: reviewerOk,
      synthesizer: { synthesize: async () => "" }, budget: { exceeded: () => null }, maxWorkerAttempts: 1, autonomy: "gated"
    });
    assert.equal("__orchestration" in captured, false);
    assert.deepEqual(Object.keys(captured).sort(), ["autonomy", "projectRules"]);
  });

  function noBudget() { return { exceeded: () => null, snapshot: () => ({ tokens: 0, model_calls: 0, max_tokens: null, max_model_calls: null }) }; }
  function buildOrch({ subtasks, workerFor, orchPersistence = null }) {
    return createOrchestrator({
      planner: { plan: async () => ({ task_summary: "t", done_when: "d", subtasks }), replan: async () => ({ done: true, subtasks: [] }) },
      makeWorkerFactory: () => ({ worker: (s) => workerFor(s) }),
      makeReviewerFor: () => ({ review: async () => ({ pass: true, severity: "warn", reasons: [], checked: [] }) }),
      synthesizer: { synthesize: async ({ collected }) => collected.map((c) => `${c.st.id}=${c.status}`).join(",") },
      makeBudget: () => noBudget(), makeResumedBudget: () => noBudget(),
      maxSubtasks: 8, maxWorkerAttempts: 1, eventBus: { publish() {} }, makeContext: async () => null, maxRounds: 2,
      orchPersistence, pausedTurnStore: { get: () => null, delete: () => {} }, pausedTurnPersistence: { consume: async () => {} },
      env: { root: "/root", orchestrationConfig: {} }
    });
  }

  test("initial pause writes a durable orchestration sidecar (driveFrom, recovery on)", async () => {
    let saved = null;
    const orch = buildOrch({
      subtasks: [st("a"), st("b")],
      workerFor: (s) => (s.id === "a"
        ? { send: async () => ({ status: "awaiting_approval", approval: { id: "ap1" } }), approve: async () => ({ status: "complete", content: "a" }) }
        : { send: async () => ({ status: "complete", content: "b" }) }),
      orchPersistence: { save: async (id, json) => { saved = { id, json }; }, consume: async () => {}, load: async () => null }
    });
    const p = await orch.run({ message: "m", options: { autonomy: "gated" } });
    assert.equal(p.status, "awaiting_approval");
    assert.equal(saved.id, "ap1");
    assert.equal(saved.json.pausedSubtask.id, "a");
    assert.deepEqual(saved.json.remaining.map((s) => s.id), ["b"]);
  });

  test("off: no durable sidecar written, C5 in-memory path unchanged", async () => {
    const orch = buildOrch({
      subtasks: [st("a")],
      workerFor: () => ({ send: async () => ({ status: "awaiting_approval", approval: { id: "ap1" } }) })
      // orchPersistence omitted -> null
    });
    const p = await orch.run({ message: "m", options: { autonomy: "gated" } });
    assert.equal(p.status, "awaiting_approval");
    assert.equal(orch.hasPaused("ap1"), true);   // held in memory only (C5)
  });

  test("same-process resume consumes the old durable sidecar", async () => {
    const consumed = [];
    const orch = buildOrch({
      subtasks: [st("a"), st("b")],
      workerFor: (s) => (s.id === "a"
        ? { send: async () => ({ status: "awaiting_approval", approval: { id: "ap1" } }), approve: async () => ({ status: "complete", content: "a" }) }
        : { send: async () => ({ status: "complete", content: "b" }) }),
      orchPersistence: { save: async () => {}, consume: async (id) => { consumed.push(id); }, load: async () => null }
    });
    await orch.run({ message: "m", options: { autonomy: "gated" } });
    const done = await orch.resume("ap1", "approve");
    assert.equal(done.status, "complete");
    assert.ok(consumed.includes("ap1"));   // old sidecar consumed on resume
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/core/orchestration/orchestration-recovery-contract.test.js
// ---------------------------------------------------------------------------
describe("core/orchestration/orchestration-recovery-contract", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createRequestBudget } = await import("../../../../src/core/runtime/request-budget.js");
  const { ORCH_RECOVERY_SCHEMA_VERSION, ORCH_FINGERPRINTS, fingerprintsMatch, isOrchestrationWorkerSidecar, ownershipOk } = await import("../../../../src/core/orchestration/orchestration-recovery-contract.js");
  const { serializeOrchestrationState, deserializeOrchestrationState, validateOrchestrationSidecar, orchestrationResumeGate, budgetContinuation } = await import("../../../../src/core/orchestration/orchestration-recovery-contract.js");

  function workerRecord({ approvalId = "ap1", taskId = "task_1", sessionId = "session", subtaskId = "a", marker = true } = {}) {
    return {
      approval_id: approvalId,
      resume_state: { options: marker ? { __orchestration: { taskId, sessionId, subtaskId } } : {} }
    };
  }
  function sidecar(over = {}) {
    return { approvalId: "ap1", taskId: "task_1", sessionId: "session", pausedSubtask: { id: "a" }, ...over };
  }

  test("schema version + fingerprints are the pinned current values", () => {
    assert.equal(ORCH_RECOVERY_SCHEMA_VERSION, 1);
    assert.deepEqual({ ...ORCH_FINGERPRINTS }, { workerFactory: 1, toolSubset: 1, subtaskSchema: 1 });
  });

  test("fingerprintsMatch: exact match only", () => {
    assert.equal(fingerprintsMatch({ workerFactory: 1, toolSubset: 1, subtaskSchema: 1 }), true);
    assert.equal(fingerprintsMatch({ workerFactory: 2, toolSubset: 1, subtaskSchema: 1 }), false);
    assert.equal(fingerprintsMatch({ workerFactory: 1, toolSubset: 1 }), false);               // missing key
    assert.equal(fingerprintsMatch({ workerFactory: 1, toolSubset: 1, subtaskSchema: 1, extra: 9 }), false);
    assert.equal(fingerprintsMatch(null), false);
  });

  test("isOrchestrationWorkerSidecar reads the __orchestration marker", () => {
    assert.equal(isOrchestrationWorkerSidecar(workerRecord({ marker: true })), true);
    assert.equal(isOrchestrationWorkerSidecar(workerRecord({ marker: false })), false);
    assert.equal(isOrchestrationWorkerSidecar({}), false);
    assert.equal(isOrchestrationWorkerSidecar(null), false);
  });

  test("ownershipOk: passes only when key + task + session + subtask + marker all align (CST-7)", () => {
    assert.equal(ownershipOk({ sidecar: sidecar(), workerRecord: workerRecord() }), true);
    assert.equal(ownershipOk({ sidecar: sidecar({ approvalId: "other" }), workerRecord: workerRecord() }), false);
    assert.equal(ownershipOk({ sidecar: sidecar({ taskId: "task_other" }), workerRecord: workerRecord() }), false);
    assert.equal(ownershipOk({ sidecar: sidecar({ sessionId: "other" }), workerRecord: workerRecord() }), false);
    assert.equal(ownershipOk({ sidecar: sidecar({ pausedSubtask: { id: "b" } }), workerRecord: workerRecord() }), false);
    assert.equal(ownershipOk({ sidecar: sidecar(), workerRecord: workerRecord({ marker: false }) }), false);  // wrong owner type
  });

  function fakeState() {
    return {
      message: "m", done_when: "d",
      options: { autonomy: "supervised", sessionId: "session" },
      plan: { subtasks: [{ id: "a", goal: "g", acceptance: [], context_scope: { files: ["a.js"] }, tool_profile: "edit", depends_on: [] }] },
      round: 2,
      allCollected: [
        { st: { id: "x", goal: "gx" }, status: "complete", wres: { status: "complete", content: "done x", extra: "STRIP_ME" }, verdict: { pass: true, severity: "warn", reasons: [], checked: ["read"] }, lastFeedback: "", change_id: "chg_1" },
        { st: { id: "y", goal: "gy" }, status: "failed", lastFeedback: "nope" }
      ],
      seenSubtaskIds: new Set(["a", "x", "y"]),
      seenFp: new Set(["g|a.js|edit"]),
      budget: { snapshot: () => ({ tokens: 40, model_calls: 3, max_tokens: 100, max_model_calls: 10, settled_attempts: [], unknown_usage_attempts: 0 }) },
      adoptedExperienceIds: ["exp_1"],
      riskCues: new Set(["rm -rf"]),
      taskId: "task_1", sessionId: "session",
      env: { root: "/root", orchestrationConfig: { maxRounds: 2 } }
    };
  }

  test("serialize → JSON round-trip → deserialize preserves state, rebuilds Sets, computes budget continuation", () => {
    const json = serializeOrchestrationState(fakeState(), {
      approvalId: "ap1", pausedSubtask: { id: "b", goal: "gb", tool_profile: "edit", context_scope: {}, acceptance: [], depends_on: [] },
      remaining: [{ id: "c" }]
    });
    // survives JSON serialization (no functions/live objects)
    const round = JSON.parse(JSON.stringify(json));
    assert.equal(round.schemaVersion, 1);
    assert.deepEqual(round.fingerprints, { workerFactory: 1, toolSubset: 1, subtaskSchema: 1 });
    assert.equal(round.approvalId, "ap1");
    assert.equal(round.autonomy, "supervised");
    assert.equal(round.pausedSubtask.id, "b");
    assert.deepEqual(round.remaining, [{ id: "c" }]);
    // CST-5: no raw options / live objects leaked
    assert.equal(round.options, undefined);
    assert.equal(round.budget.spentTokens, 40);
    assert.equal(round.budget.quotaTokens, 100);
    // allCollected trimmed: wres keeps only {status,content}
    assert.deepEqual(round.allCollected[0].wres, { status: "complete", content: "done x" });

    const state = deserializeOrchestrationState(round);
    assert.ok(state.seenSubtaskIds instanceof Set && state.seenSubtaskIds.has("x"));
    assert.ok(state.seenFp instanceof Set && state.seenFp.has("g|a.js|edit"));
    assert.ok(state.riskCues instanceof Set && state.riskCues.has("rm -rf"));
    assert.equal(state.options.autonomy, "supervised");
    assert.deepEqual(state.budgetSnapshot, { maxTokens: 100, maxModelCalls: 10, initialTokens: 40, initialModelCalls: 3 });
    assert.equal(state.round, 2);
    assert.equal(state.taskId, "task_1");
  });

  test("validateOrchestrationSidecar (structural) accepts a well-formed sidecar and rejects each shape failure", () => {
    const good = serializeOrchestrationState(fakeState(), { approvalId: "ap1", pausedSubtask: { id: "b" }, remaining: [] });
    assert.deepEqual(validateOrchestrationSidecar(good), { ok: true });
    assert.equal(validateOrchestrationSidecar({ ...good, schemaVersion: 2 }).ok, false);
    assert.equal(validateOrchestrationSidecar({ ...good, taskId: undefined }).ok, false);
    assert.equal(validateOrchestrationSidecar({ ...good, budget: { quotaTokens: 1 } }).ok, false);  // missing spent counts
    assert.equal(validateOrchestrationSidecar(null).ok, false);
    // structural validation does NOT reject a fingerprint-outdated-but-well-formed sidecar (that is the gate's job)
    assert.equal(validateOrchestrationSidecar({ ...good, fingerprints: { workerFactory: 9, toolSubset: 1, subtaskSchema: 1 } }).ok, true);
  });

  test("orchestrationResumeGate is the authoritative CST-6+CST-7 gate (structure + fingerprint + ownership)", () => {
    const sc = serializeOrchestrationState(fakeState(), {
      approvalId: "ap1",
      pausedSubtask: { id: "b", goal: "gb", tool_profile: "edit", context_scope: {}, acceptance: [], depends_on: [] },
      remaining: []
    });
    const wr = { approval_id: "ap1", resume_state: { options: { __orchestration: { taskId: "task_1", sessionId: "session", subtaskId: "b" } } } };
    assert.deepEqual(orchestrationResumeGate({ sidecar: sc, workerRecord: wr }), { ok: true });
    // fingerprint mismatch -> blocked (CST-6)
    assert.equal(orchestrationResumeGate({ sidecar: { ...sc, fingerprints: { workerFactory: 9, toolSubset: 1, subtaskSchema: 1 } }, workerRecord: wr }).ok, false);
    // worker sidecar missing -> blocked
    assert.equal(orchestrationResumeGate({ sidecar: sc, workerRecord: null }).ok, false);
    // worker sidecar present but not orchestration-owned -> blocked
    assert.equal(orchestrationResumeGate({ sidecar: sc, workerRecord: { approval_id: "ap1", resume_state: { options: {} } } }).ok, false);
    // ownership mismatch (subtask id) -> blocked (CST-7)
    assert.equal(orchestrationResumeGate({ sidecar: sc, workerRecord: { approval_id: "ap1", resume_state: { options: { __orchestration: { taskId: "task_1", sessionId: "session", subtaskId: "WRONG" } } } } }).ok, false);
    // structurally broken sidecar -> blocked
    assert.equal(orchestrationResumeGate({ sidecar: { ...sc, budget: {} }, workerRecord: wr }).ok, false);
  });

  test("budgetContinuation maps quota+spent, tolerates nulls (never resets — CST-8)", () => {
    assert.deepEqual(budgetContinuation({ quotaTokens: 100, quotaCalls: 10, spentTokens: 40, spentCalls: 3 }),
      { maxTokens: 100, maxModelCalls: 10, initialTokens: 40, initialModelCalls: 3 });
    assert.deepEqual(budgetContinuation({ quotaTokens: null, quotaCalls: null, spentTokens: 0, spentCalls: 0 }),
      { maxTokens: null, maxModelCalls: null, initialTokens: 0, initialModelCalls: 0 });
    assert.deepEqual(budgetContinuation(undefined), { maxTokens: null, maxModelCalls: null, initialTokens: 0, initialModelCalls: 0 });
  });

  function meteredSidecar(budget) {
    const json = serializeOrchestrationState(fakeState(), {
      approvalId: "ap1", pausedSubtask: { id: "a" }, remaining: []
    });
    json.budget = {
      quotaTokens: 5000, quotaCalls: 10, spentTokens: 0, spentCalls: 2,
      unknownUsageAttempts: 2, settledAttempts: ["old_unknown", "new_unknown"],
      // Historical role totals omit the first unknown charge of 500 tokens.
      byRole: { worker: { calls: 2, tokens: 4020 } },
      ...budget
    };
    return json;
  }

  test("finite token recovery blocks incomplete unknown amounts even when role totals are present", () => {
    const values = [undefined, null, 0, -1, NaN, Infinity, "4520"];
    for (const amount of values) {
      const sc = meteredSidecar({ unknownUsageTokens: amount });
      if (amount === undefined) delete sc.budget.unknownUsageTokens;
      const original = structuredClone(sc);
      const gate = orchestrationResumeGate({ sidecar: sc, workerRecord: workerRecord() });
      assert.equal(gate.ok, false, `unknown amount ${String(amount)} must not release quota`);
      assert.match(gate.reason, /unknown usage amount/i);
      const isBlocked = (err) => err.code === "ORCH_RECOVERY_BLOCKED" && /unknown usage amount/i.test(err.message);
      assert.throws(() => budgetContinuation(sc.budget, sc), isBlocked);
      assert.throws(() => deserializeOrchestrationState(sc), isBlocked);
      assert.deepEqual(sc, original, "blocked recovery must not alter the saved record");
    }
  });

  test("exact unknown amount takes precedence over incomplete role history and keeps the next request blocked", () => {
    const sc = meteredSidecar({ unknownUsageTokens: 4520, fallbackTokensPerUnknown: 500 });
    assert.deepEqual(orchestrationResumeGate({ sidecar: sc, workerRecord: workerRecord() }), { ok: true });
    const decoded = deserializeOrchestrationState(JSON.parse(JSON.stringify(sc)));
    const budget = createRequestBudget({ ...decoded.budgetSnapshot, executionId: decoded.executionId });
    assert.equal(budget.snapshot().unknown_usage_tokens, 4520);
    assert.equal(budget.snapshot().model_calls, 2);
    assert.equal(budget.snapshot().execution_id, sc.executionId);
    assert.throws(() => budget.reserveCall({ role: "worker", estimatedTokens: 620 }), { code: "BUDGET_EXCEEDED" });
    assert.equal(budget.snapshot().reserved_calls, 0);
  });

  test("metered records without unknown charges remain resumable without the new amount field", () => {
    for (const amount of [undefined, 0]) {
      const sc = meteredSidecar({ unknownUsageAttempts: 0, unknownUsageTokens: amount, spentTokens: 70,
        byRole: { worker: { calls: 2, tokens: 70 } } });
      assert.deepEqual(orchestrationResumeGate({ sidecar: sc, workerRecord: workerRecord() }), { ok: true });
      const budget = createRequestBudget(deserializeOrchestrationState(sc).budgetSnapshot);
      assert.equal(budget.snapshot().tokens, 70);
      assert.equal(budget.snapshot().unknown_usage_tokens, 0);
    }
  });

  test("missing legacy unknown amount does not block recovery when only model calls are limited", () => {
    for (const quotaCalls of [null, 10]) {
      const sc = meteredSidecar({ quotaTokens: null, quotaCalls });
      assert.deepEqual(orchestrationResumeGate({ sidecar: sc, workerRecord: workerRecord() }), { ok: true });
      const continuation = deserializeOrchestrationState(sc).budgetSnapshot;
      assert.equal(continuation.maxTokens, null);
      assert.equal(continuation.maxModelCalls, quotaCalls);
      assert.equal(continuation.initialModelCalls, 2);
      assert.equal(continuation.initialUnknownUsageAttempts, 2);
    }
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/core/orchestration/durable-orchestration-wiring.test.js
// ---------------------------------------------------------------------------
describe("core/orchestration/durable-orchestration-wiring", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { promises: fs } = await import("node:fs");
  const { createKernel } = await import("../../../../src/index.js");
  const { mkdtemp } = await import("../../../helpers/tmp.js");

  function mockGateway() {
    return {
      invoke: async (messages) => {
        const text = (messages || []).map((m) => m.content).join("\n");
        if (text.includes("Break the user's request")) return { content: JSON.stringify({ task_summary: "t", done_when: "d", subtasks: [
          { id: "st_a", goal: "edit a.js", acceptance: ["a edited"], context_scope: { files: ["a.js"] }, tool_profile: "edit", depends_on: [] }
        ] }), tool_calls: [] };
        if (text.includes("revising a multi-agent plan")) return { content: '{"done":true,"subtasks":[]}', tool_calls: [] };
        if (text.includes("INDEPENDENT reviewer")) return { content: '{"pass":true,"severity":"warn","reasons":[],"checked":["read"]}', tool_calls: [] };
        if (text.includes("Synthesize a final answer")) return { content: "final", tool_calls: [] };
        if (text.includes("Sub-task: edit a.js") && !text.includes("Applied change")) return { content: "", tool_calls: [{ id: "t1", name: "diff_apply", arguments: { diff: "--- a/a.js\n+++ b/a.js\n@@ -1,1 +1,1 @@\n-base a\n+edited a\n" } }] };
        return { content: "done", tool_calls: [] };
      },
      reply: async () => ({ content: "single" }), getUsageStats: () => ({})
    };
  }
  const exists = async (p) => { try { await fs.stat(p); return true; } catch (e) { if (e.code === "ENOENT") return false; throw e; } };
  async function fixture() { const root = await mkdtemp(path.join(os.tmpdir(), "m7-wire-")); await fs.writeFile(path.join(root, "a.js"), "base a\n"); return root; }
  const sidecars = (root) => ({
    worker: (id) => path.join(root, ".deepseek-code", "v2", "sessions", "proj", "paused", `${id}.json`),
    orch: (id) => path.join(root, ".deepseek-code", "v2", "sessions", "proj", "orchestration-paused", `${id}.json`),
    orchDir: path.join(root, ".deepseek-code", "v2", "sessions", "proj", "orchestration-paused")
  });

  test("recovery ON: orchestration worker pause writes BOTH worker and orchestration sidecars", async () => {
    const root = await fixture();
    const kernel = await createKernel(root, { modelGateway: mockGateway(), sessionLog: null, branchStore: null, verifyMode: "off", projectId: "proj", sessionId: "s", recovery: { enabled: true, lock: false, surface: "cli" } });
    const p = await kernel.agent.send("逐一处理 a.js 的输入校验", { autonomy: "supervised" });
    assert.equal(p.status, "awaiting_approval");
    const s = sidecars(root);
    assert.equal(await exists(s.worker(p.approval.id)), true, "worker sidecar written");
    assert.equal(await exists(s.orch(p.approval.id)), true, "orchestration sidecar written");
    await kernel.dispose?.();
  });

  test("recovery OFF: no orchestration-paused dir created (zero regression)", async () => {
    const root = await fixture();
    const kernel = await createKernel(root, { modelGateway: mockGateway(), eventBus: { publish() {}, subscribe: () => () => {} }, sessionLog: null, branchStore: null, verifyMode: "off", projectId: "proj" });
    const p = await kernel.agent.send("逐一处理 a.js 的输入校验", { autonomy: "supervised" });
    assert.equal(p.status, "awaiting_approval");
    assert.equal(await exists(sidecars(root).orchDir), false);
    await kernel.dispose?.();
  });

  test("recovery ON: a restart kernel lists the orchestration_paused recovery item", async () => {
    const root = await fixture();
    const a = await createKernel(root, { modelGateway: mockGateway(), sessionLog: null, branchStore: null, verifyMode: "off", projectId: "proj", sessionId: "sA", recovery: { enabled: true, lock: false, surface: "cli" } });
    const p = await a.agent.send("逐一处理 a.js 的输入校验", { autonomy: "supervised" });
    assert.equal(p.status, "awaiting_approval");
    await a.dispose?.();

    const b = await createKernel(root, { modelGateway: mockGateway(), sessionLog: null, branchStore: null, verifyMode: "off", projectId: "proj", sessionId: "sB", recovery: { enabled: true, lock: false, surface: "cli" } });
    const items = await b.recovery.list();
    assert.ok(items.some((i) => i.type === "orchestration_paused" && i.source_id === p.approval.id));
    assert.equal(items.some((i) => i.type === "paused_turn" && i.source_id === p.approval.id), false, "orchestration worker never leaks as single-agent (CST-4)");
    await b.dispose?.();
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/core/orchestration/shared-paused-store.test.js
// ---------------------------------------------------------------------------
describe("core/orchestration/shared-paused-store", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { promises: fs } = await import("node:fs");
  const { createAgentRuntime } = await import("../../../../src/core/runtime/agent-runtime.js");
  const { createPausedTurnStore } = await import("../../../../src/core/approval/paused-turn-store.js");
  const { createKernel } = await import("../../../../src/index.js");
  const { mkdtemp } = await import("../../../helpers/tmp.js");

  const REC = { approval_id: "ap1", turn_id: "t1", approval: { id: "ap1" }, turn: {}, resume_state: {} };

  test("mechanism: a record restored via one runtime is visible to another sharing the store", () => {
    const shared = createPausedTurnStore();
    const a = createAgentRuntime({ pausedTurnStore: shared });
    const b = createAgentRuntime({ pausedTurnStore: shared });
    a.restorePaused(REC);
    assert.equal(b.listPaused().some((r) => r.approval_id === "ap1"), true);
  });

  test("mechanism: default (unshared) stores stay independent — off-path parity", () => {
    const a = createAgentRuntime({});
    const b = createAgentRuntime({});
    a.restorePaused(REC);
    assert.equal(b.listPaused().some((r) => r.approval_id === "ap1"), false);
  });

  // Orchestration worker (singleton in-main, gated) calls diff_apply -> needs approval -> pauses.
  function mockGateway() {
    return {
      invoke: async (messages) => {
        const text = (messages || []).map((m) => m.content).join("\n");
        if (text.includes("Break the user's request")) return { content: JSON.stringify({ task_summary: "t", done_when: "d", subtasks: [
          { id: "st_a", goal: "edit a.js", acceptance: ["a edited"], context_scope: { files: ["a.js"] }, tool_profile: "edit", depends_on: [] }
        ] }), tool_calls: [] };
        if (text.includes("revising a multi-agent plan")) return { content: '{"done":true,"subtasks":[]}', tool_calls: [] };
        if (text.includes("INDEPENDENT reviewer")) return { content: '{"pass":true,"severity":"warn","reasons":[],"checked":["read"]}', tool_calls: [] };
        if (text.includes("Synthesize a final answer")) return { content: "final", tool_calls: [] };
        if (text.includes("Sub-task: edit a.js") && !text.includes("Applied change")) return { content: "", tool_calls: [{ id: "t1", name: "diff_apply", arguments: { diff: "--- a/a.js\n+++ b/a.js\n@@ -1,1 +1,1 @@\n-base a\n+edited a\n" } }] };
        return { content: "done", tool_calls: [] };
      },
      reply: async () => ({ content: "single" }), getUsageStats: () => ({})
    };
  }
  async function fixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), "m3-shared-"));
    await fs.writeFile(path.join(root, "a.js"), "base a\n");
    return root;
  }

  test("recovery ON: orchestration worker pause is visible in the shared main-runtime store", async () => {
    const root = await fixture();
    const kernel = await createKernel(root, {
      modelGateway: mockGateway(), sessionLog: null, branchStore: null, verifyMode: "off",
      projectId: "proj", sessionId: "s", recovery: { enabled: true, lock: false, surface: "cli" }
    });
    const p = await kernel.agent.send("逐一处理 a.js 的输入校验", { autonomy: "supervised" });
    assert.equal(p.status, "awaiting_approval");
    assert.equal(kernel.runtime.listPaused().some((r) => r.approval_id === p.approval.id), true);
    await kernel.dispose?.();
  });

  test("recovery OFF: orchestration worker pause is NOT in the main-runtime store (C5 in-memory only)", async () => {
    const root = await fixture();
    const kernel = await createKernel(root, {
      modelGateway: mockGateway(), eventBus: { publish() {}, subscribe: () => () => {} },
      sessionLog: null, branchStore: null, verifyMode: "off"
    });
    const p = await kernel.agent.send("逐一处理 a.js 的输入校验", { autonomy: "supervised" });
    assert.equal(p.status, "awaiting_approval");
    assert.equal(kernel.runtime.listPaused().some((r) => r.approval_id === p.approval.id), false);
    await kernel.dispose?.();
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/core/orchestration/c-durable-e2e.test.js
// ---------------------------------------------------------------------------
describe("core/orchestration/c-durable-e2e", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { promises: fs } = await import("node:fs");
  const { createKernel } = await import("../../../../src/index.js");
  const { createOrchestrationPersistence } = await import("../../../../src/core/recovery/orchestration-persistence.js");
  const { mkdtemp } = await import("../../../helpers/tmp.js");

  function mockGateway(counters) {
    return {
      invoke: async (messages) => {
        const text = (messages || []).map((m) => m.content).join("\n");
        if (text.includes("Break the user's request")) { counters.plan += 1; return { content: JSON.stringify({ task_summary: "t", done_when: "d", subtasks: [
          { id: "st_a", goal: "edit a.js", acceptance: ["a edited"], context_scope: { files: ["a.js"] }, tool_profile: "edit", depends_on: [] }
        ] }), tool_calls: [] }; }
        if (text.includes("revising a multi-agent plan")) return { content: '{"done":true,"subtasks":[]}', tool_calls: [] };
        if (text.includes("INDEPENDENT reviewer")) return { content: '{"pass":true,"severity":"warn","reasons":[],"checked":["read"]}', tool_calls: [] };
        if (text.includes("Synthesize a final answer")) return { content: "final", tool_calls: [] };
        if (text.includes("Sub-task: edit a.js") && !text.includes("Applied change")) return { content: "", tool_calls: [{ id: "t1", name: "diff_apply", arguments: { diff: "--- a/a.js\n+++ b/a.js\n@@ -1,1 +1,1 @@\n-base a\n+edited a\n" } }] };
        return { content: "done", tool_calls: [] };
      },
      reply: async () => ({ content: "single" }), getUsageStats: () => ({})
    };
  }
  const exists = async (p) => { try { await fs.stat(p); return true; } catch (e) { if (e.code === "ENOENT") return false; throw e; } };

  test("cross-instance: worker pauses in A, resumes to completion in B (plan once, edit merged, budget persisted)", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "c-durable-e2e-"));
    await fs.writeFile(path.join(root, "a.js"), "base a\n");
    const cA = { plan: 0 }, cB = { plan: 0 };

    const a = await createKernel(root, { modelGateway: mockGateway(cA), sessionLog: null, branchStore: null, verifyMode: "off", projectId: "proj", sessionId: "sA", recovery: { enabled: true, lock: false, surface: "cli" } });
    const p = await a.agent.send("逐一处理 a.js 的输入校验", { autonomy: "supervised" });
    assert.equal(p.status, "awaiting_approval");
    assert.equal(cA.plan, 1);

    const store = createOrchestrationPersistence({ root, projectId: "proj" });
    const sidecar = await store.load(p.approval.id);
    assert.ok("quotaTokens" in sidecar.budget && "spentTokens" in sidecar.budget && "spentCalls" in sidecar.budget, "budget quota+spend serialized (edge⑤ shape)");

    await a.dispose?.();   // preserve sidecars, release lock

    const b = await createKernel(root, { modelGateway: mockGateway(cB), sessionLog: null, branchStore: null, verifyMode: "off", projectId: "proj", sessionId: "sB", recovery: { enabled: true, lock: false, surface: "cli" } });
    const items = await b.recovery.list();
    assert.ok(items.find((i) => i.type === "orchestration_paused" && i.source_id === p.approval.id), "orchestration_paused registered on restart");

    const resumed = await b.recovery.resume(`rec_orch_${p.approval.id}`, { decision: "approve" });
    assert.equal(resumed.status, "resumed");
    assert.equal(resumed.result.status, "complete");
    assert.equal(await fs.readFile(path.join(root, "a.js"), "utf8"), "edited a\n");   // edit merged to main
    assert.equal(cB.plan, 0, "no re-plan on durable resume (plan across instances = 1)");

    const after = await store.scan();
    assert.ok(after.every((s) => s.approvalId !== p.approval.id || s.status === "consumed"), "orchestration sidecar consumed");
    await b.dispose?.();
  });

  test("recovery off: orchestration pause stays in-memory (C5), no durable sidecar, same-process approve completes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "c-durable-off-"));
    await fs.writeFile(path.join(root, "a.js"), "base a\n");
    const counters = { plan: 0 };
    const kernel = await createKernel(root, { modelGateway: mockGateway(counters), eventBus: { publish() {}, subscribe: () => () => {} }, sessionLog: null, branchStore: null, verifyMode: "off", projectId: "proj" });
    const p = await kernel.agent.send("逐一处理 a.js 的输入校验", { autonomy: "supervised" });
    assert.equal(p.status, "awaiting_approval");
    assert.equal(await exists(path.join(root, ".deepseek-code", "v2", "sessions", "proj", "orchestration-paused")), false);
    const done = await kernel.agent.approve(p.approval.id, "approve");   // C5 in-memory resume
    assert.equal(done.status, "complete");
    assert.equal(await fs.readFile(path.join(root, "a.js"), "utf8"), "edited a\n");
    assert.equal(counters.plan, 1);
    await kernel.dispose?.();
  });
});
