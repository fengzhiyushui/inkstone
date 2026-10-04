import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "../../../helpers/tmp.js";

import { tmpdir } from "node:os";
import path from "node:path";
import { createPausedTurnPersistence } from "../../../../src/core/recovery/paused-turn-persistence.js";
import { createRecoveryFaults } from "../../../../src/core/recovery/recovery-faults.js";

test("paused turn sidecar saves scans loads and deletes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-paused-sidecar-"));
  const store = createPausedTurnPersistence({ root, projectId: "proj_1" });
  const record = pausedRecord({ root });

  await store.save(record);

  assert.deepEqual((await store.scan()).map((item) => item.approval_id), ["approval_1"]);
  assert.equal((await store.load("approval_1")).permission_context.autonomy, "supervised");
  assert.equal(await store.delete("approval_1"), true);
  assert.deepEqual(await store.scan(), []);
});

test("paused turn sidecar quarantines corrupt JSON", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-paused-corrupt-"));
  const store = createPausedTurnPersistence({ root, projectId: "proj_1" });
  await store.writeRawForTest("approval_bad", "{not json");

  const scanned = await store.scan();

  assert.equal(scanned[0].status, "corrupt");
  assert.equal(scanned[0].approval_id, "approval_bad");
});

test("paused turn sidecar moves records into quarantine", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-paused-quarantine-"));
  const store = createPausedTurnPersistence({ root, projectId: "proj_1" });
  await store.save(pausedRecord({ root }));

  const result = await store.quarantine("approval_1", "cancelled");

  assert.equal(result.status, "quarantined");
  assert.equal(result.reason, "cancelled");
  assert.deepEqual(await store.scan(), []);
  assert.equal((await store.load("approval_1").catch((error) => error.code)), "ENOENT");
});

test("paused turn sidecar tombstones consumed records when delete fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-paused-consumed-"));
  const faults = createRecoveryFaults({ labels: ["before-paused-sidecar-delete"] });
  const store = createPausedTurnPersistence({ root, projectId: "proj_1", faults });
  await store.save(pausedRecord({ root }));

  const consumed = await store.consume("approval_1");
  const scanned = await store.scan();

  assert.equal(consumed.status, "consumed");
  assert.equal(scanned.length, 1);
  assert.equal(scanned[0].status, "consumed");
  assert.equal(scanned[0].approval_id, "approval_1");
  assert.equal(faults.hitCount("before-paused-sidecar-delete"), 1);
  await assert.rejects(
    () => store.load("approval_1"),
    /turn_id is required/
  );
});

test("paused turn sidecar validates ids and required durable fields", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-paused-validation-"));
  const store = createPausedTurnPersistence({ root, projectId: "proj_1" });

  await assert.rejects(
    () => store.save(pausedRecord({ root, approval_id: "../approval" })),
    /invalid recovery path segment/
  );
  await assert.rejects(
    () => store.save(pausedRecord({ root, approval: { id: "different" } })),
    /approval.id must match approval_id/
  );
  await assert.rejects(
    () => store.save(pausedRecord({ root, permission_context: null })),
    /permission_context is required/
  );
});

test("paused turn sidecar scans corrupt mismatched sidecars without throwing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-paused-mismatch-"));
  const store = createPausedTurnPersistence({ root, projectId: "proj_1" });
  await store.writeRawForTest(
    "approval_path",
    JSON.stringify(pausedRecord({ root, approval_id: "approval_other", approval: { id: "approval_other" } }))
  );

  const scanned = await store.scan();

  assert.equal(scanned[0].status, "corrupt");
  assert.equal(scanned[0].approval_id, "approval_path");
  assert.match(scanned[0].reason, /approval_id must match sidecar path/);
});

function pausedRecord(overrides = {}) {
  const root = overrides.root || "D:\\workspace";
  const record = {
    schema_version: 1,
    approval_id: "approval_1",
    turn_id: "turn_1",
    session_id: "sess_1",
    created_at: "2026-06-01T00:00:00.000Z",
    surface: "cli",
    permission_context: {
      schema_version: 1,
      autonomy: "supervised",
      project_id: "proj_1",
      project_root: root,
      trust_store_rules: [],
      project_rules: [],
      memory_root: null,
      verify_mode: "auto",
      test_argv: null
    },
    approval: { id: "approval_1", summary: "edit" },
    turn: { id: "turn_1", autonomy: "supervised" },
    resume_state: { pending_tool_call: { id: "call_1", name: "edit", params: {} } }
  };
  return { ...record, ...overrides };
}
