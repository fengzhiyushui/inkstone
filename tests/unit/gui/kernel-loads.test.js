import test from "node:test";
import assert from "node:assert/strict";
import { buildInitialLoads, branchesAction, eventToAction, errorToAction, refreshLoadsFor } from "../../../gui/src/hooks/kernel-loads.js";

test("buildInitialLoads maps single-call apis to reducer actions", () => {
  const byCall = Object.fromEntries(buildInitialLoads().map((c) => [c.call, c]));
  assert.ok(byCall.getPreferences && byCall.listCheckpoints && byCall.getUsage && byCall.getState);
  assert.equal(byCall.getPreferences.toAction({ theme: "day" }).type, "preferences_loaded");
  assert.equal(byCall.getPreferences.toAction({ theme: "day" }).preferences.theme, "day");
  assert.equal(byCall.listCheckpoints.toAction([{ seq: 1 }]).type, "checkpoints_loaded");
  assert.equal(byCall.getUsage.toAction({ requests: 3 }).type, "usage_loaded");
  assert.equal(byCall.getState.toAction({ current: "idle" }).type, "runtime_loaded");
  assert.equal(byCall.getSettings.toAction({ config: { model: "m1", hasApiKey: true } }).type, "settings_loaded");
  assert.equal(byCall.getSettings.toAction({ config: { model: "m1" } }).config.model, "m1");
});

test("branchesAction combines list + active branch", () => {
  const a = branchesAction([{ branch_id: "br_x" }], "br_x");
  assert.equal(a.type, "branches_loaded");
  assert.equal(a.activeBranchId, "br_x");
  assert.equal(a.branches.length, 1);
  assert.equal(branchesAction(null, null).activeBranchId, "br_main");
});

test("eventToAction wraps a kernel event", () => {
  assert.deepEqual(eventToAction({ type: "agent:step" }), { type: "event_received", event: { type: "agent:step" } });
  assert.deepEqual(eventToAction(null), { type: "event_received", event: {} });
});

test("errorToAction reports area with a short message", () => {
  const a = errorToAction("branches", new Error("boom"));
  assert.equal(a.type, "error_reported");
  assert.equal(a.area, "branches");
  assert.match(a.message, /boom/);
});

test("refreshLoadsFor re-pulls usage + checkpoints on turn end, nothing otherwise", () => {
  for (const type of ["agent:final", "agent:error", "turn:cancelled", "file:rollback_applied"]) {
    const calls = refreshLoadsFor(type).map((l) => l.call).sort();
    assert.deepEqual(calls, ["getUsage", "listCheckpoints"], type);
  }
  assert.deepEqual(refreshLoadsFor("model:request"), []);
  assert.deepEqual(refreshLoadsFor("agent:step"), []);
  assert.deepEqual(refreshLoadsFor(undefined), []);
  // toAction 与首屏加载同形状,reducer 无需新 action
  const usage = refreshLoadsFor("agent:final").find((l) => l.call === "getUsage");
  assert.equal(usage.toAction({ requests: 1 }).type, "usage_loaded");
});
