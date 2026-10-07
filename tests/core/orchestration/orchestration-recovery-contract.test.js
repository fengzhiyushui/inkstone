import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ORCH_RECOVERY_SCHEMA_VERSION, ORCH_FINGERPRINTS,
  fingerprintsMatch, isOrchestrationWorkerSidecar, ownershipOk
} from "../../../src/core/orchestration/orchestration-recovery-contract.js";
import {
  serializeOrchestrationState, deserializeOrchestrationState,
  validateOrchestrationSidecar, orchestrationResumeGate, budgetContinuation
} from "../../../src/core/orchestration/orchestration-recovery-contract.js";

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
