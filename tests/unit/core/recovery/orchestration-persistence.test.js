import test from "node:test";
import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createOrchestrationPersistence } from "../../../../src/core/recovery/orchestration-persistence.js";
import { serializeOrchestrationState } from "../../../../src/core/orchestration/orchestration-recovery-contract.js";
import { createRecoveryFaults } from "../../../../src/core/recovery/recovery-faults.js";
import { mkdtemp } from "../../../helpers/tmp.js";

function sidecar(approvalId = "ap1") {
  const state = {
    message: "m", done_when: "d", options: { autonomy: "gated", sessionId: "s" },
    plan: { subtasks: [] }, round: 1, allCollected: [],
    seenSubtaskIds: new Set(["a"]), seenFp: new Set(["fp"]),
    budget: { snapshot: () => ({ tokens: 0, model_calls: 0, max_tokens: null, max_model_calls: null }) },
    adoptedExperienceIds: [], riskCues: new Set(), taskId: "task_1", sessionId: "s",
    env: { root: "/r", orchestrationConfig: null }
  };
  return serializeOrchestrationState(state, { approvalId, pausedSubtask: { id: "b" }, remaining: [] });
}
const tmp = () => mkdtemp(path.join(tmpdir(), "orch-persist-"));
async function exists(p) { try { await stat(p); return true; } catch (e) { if (e.code === "ENOENT") return false; throw e; } }

test("save then load round-trips the orchestration sidecar", async () => {
  const store = createOrchestrationPersistence({ root: await tmp(), projectId: "proj" });
  await store.save("ap1", sidecar("ap1"));
  const loaded = await store.load("ap1");
  assert.equal(loaded.approvalId, "ap1");
  assert.equal(loaded.taskId, "task_1");
});

test("save rejects a structurally invalid sidecar", async () => {
  const store = createOrchestrationPersistence({ root: await tmp(), projectId: "proj" });
  await assert.rejects(() => store.save("ap1", { schemaVersion: 1 }), /invalid orchestration sidecar/);
});

test("scan returns valid records, flags corrupt, and marks consumed", async () => {
  const store = createOrchestrationPersistence({ root: await tmp(), projectId: "proj" });
  await store.save("ap_ok", sidecar("ap_ok"));
  await store.writeRawForTest("ap_bad", "{ not json");
  await store.writeRawForTest("ap_consumed", JSON.stringify({ schemaVersion: 1, approvalId: "ap_consumed", status: "consumed", consumed_at: new Date().toISOString(), reason: "consumed" }));
  const scanned = await store.scan();
  const byId = Object.fromEntries(scanned.map((s) => [s.approvalId, s]));
  assert.equal(byId.ap_ok.status, undefined);      // valid record returned as-is
  assert.equal(byId.ap_ok.taskId, "task_1");
  assert.equal(byId.ap_bad.status, "corrupt");
  assert.equal(byId.ap_consumed.status, "consumed");
});

test("consume writes a tombstone then deletes the sidecar", async () => {
  const root = await tmp();
  const store = createOrchestrationPersistence({ root, projectId: "proj" });
  await store.save("ap1", sidecar("ap1"));
  const res = await store.consume("ap1");
  assert.equal(res.status, "deleted");
  assert.equal(await exists(path.join(store.baseDir, "ap1.json")), false);
});

test("quarantine moves a corrupt sidecar aside", async () => {
  const root = await tmp();
  const store = createOrchestrationPersistence({ root, projectId: "proj" });
  await store.writeRawForTest("ap_bad", "{ not json");
  const res = await store.quarantine("ap_bad", "operator cancelled");
  assert.equal(res.status, "quarantined");
  assert.equal(await exists(path.join(store.baseDir, "ap_bad.json")), false);
  assert.equal(await exists(path.join(store.baseDir, "quarantine", "ap_bad.json")), true);
});

test("crash-after-write fault: file persists but save rejects (recoverable orphan window)", async () => {
  const faults = createRecoveryFaults({ labels: ["after-orchestration-sidecar-write"] });
  const root = await tmp();
  const store = createOrchestrationPersistence({ root, projectId: "proj", faults });
  await assert.rejects(() => store.save("ap1", sidecar("ap1")), /recovery fault/);
  assert.equal(await exists(path.join(store.baseDir, "ap1.json")), true);
});
