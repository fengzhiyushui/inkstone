// tests/unit/core/recovery/recovery-persistence.test.js — 崩溃恢复持久化(原子文件/暂停轮次/编排/事务日志/故障)领域测试
//
// v1.19.1 测试归并:本文件由下列历史任务单测试合并而成,每个来源包裹在独立
// describe 块中(异步回调 + 动态 import,来源间零共享绑定),测试语义与拆分前一致。
import { describe } from "node:test";

// ---------------------------------------------------------------------------
// 来源:tests/unit/core/recovery/atomic-file.test.js
// ---------------------------------------------------------------------------
describe("unit/core/recovery/atomic-file", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { mkdir, readFile, readdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { atomicReadJson, atomicWriteBytes, atomicWriteJson, cleanupAtomicTemps, safeRecoverySegment } = await import("../../../../src/core/recovery/atomic-file.js");
  const { mkdtemp } = await import("../../../helpers/tmp.js");

  test("atomicWriteJson writes readable JSON and ignores temp leftovers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-atomic-json-"));
    const target = path.join(root, "state.json");

    await atomicWriteJson(target, { schema_version: 1, value: "ok" });
    const loaded = await atomicReadJson(target);

    assert.deepEqual(loaded, { schema_version: 1, value: "ok" });
    assert.deepEqual((await readdir(root)).filter((name) => name.startsWith(".recovery-tmp-")), []);
  });

  test("atomicWriteBytes preserves binary bytes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-atomic-bytes-"));
    const target = path.join(root, "blob.bin");
    const bytes = Buffer.from([0, 255, 12, 10, 65]);

    await atomicWriteBytes(target, bytes);

    assert.deepEqual(await readFile(target), bytes);
  });

  test("cleanupAtomicTemps removes only helper-shaped recovery temp regular files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-atomic-clean-"));
    const helperTemp = ".recovery-tmp-123-00000000-0000-4000-8000-000000000000";
    const unrelatedTemp = ".recovery-tmp-not-from-helper";
    const tempDirectory = ".recovery-tmp-dir";
    await writeFile(path.join(root, helperTemp), Buffer.from("tmp"));
    await writeFile(path.join(root, unrelatedTemp), Buffer.from("keep"));
    await mkdir(path.join(root, tempDirectory));
    await atomicWriteBytes(path.join(root, "keep.txt"), Buffer.from("keep"));

    const removed = await cleanupAtomicTemps(root);
    const remaining = await readdir(root);

    assert.deepEqual(removed, [helperTemp]);
    assert.equal(remaining.includes(helperTemp), false);
    assert.equal(remaining.includes(unrelatedTemp), true);
    assert.equal(remaining.includes(tempDirectory), true);
    assert.equal(remaining.includes("keep.txt"), true);
  });

  test("safeRecoverySegment rejects traversal and unsafe values while keeping portable ids", () => {
    assert.equal(safeRecoverySegment("tx_123"), "tx_123");
    assert.throws(() => safeRecoverySegment("../evil"), /invalid recovery path segment/);
    assert.throws(() => safeRecoverySegment(""), /invalid recovery path segment/);
    assert.throws(() => safeRecoverySegment("."), /invalid recovery path segment/);
    assert.throws(() => safeRecoverySegment(".."), /invalid recovery path segment/);
    assert.throws(() => safeRecoverySegment(null), /invalid recovery path segment/);
    assert.throws(() => safeRecoverySegment(123), /invalid recovery path segment/);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/core/recovery/paused-turn-persistence.test.js
// ---------------------------------------------------------------------------
describe("unit/core/recovery/paused-turn-persistence", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { mkdtemp } = await import("../../../helpers/tmp.js");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { createPausedTurnPersistence } = await import("../../../../src/core/recovery/paused-turn-persistence.js");
  const { createRecoveryFaults } = await import("../../../../src/core/recovery/recovery-faults.js");

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
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/core/recovery/orchestration-persistence.test.js
// ---------------------------------------------------------------------------
describe("unit/core/recovery/orchestration-persistence", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { stat } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { createOrchestrationPersistence } = await import("../../../../src/core/recovery/orchestration-persistence.js");
  const { serializeOrchestrationState } = await import("../../../../src/core/orchestration/orchestration-recovery-contract.js");
  const { createRecoveryFaults } = await import("../../../../src/core/recovery/recovery-faults.js");
  const { mkdtemp } = await import("../../../helpers/tmp.js");

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
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/core/recovery/transaction-journal.test.js
// ---------------------------------------------------------------------------
describe("unit/core/recovery/transaction-journal", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { readFile, symlink, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { createTransactionJournal } = await import("../../../../src/core/recovery/transaction-journal.js");
  const { mkdtemp } = await import("../../../helpers/tmp.js");

  test("transaction journal captures binary preimage before mutation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-journal-binary-"));
    await writeFile(path.join(root, "a.bin"), Buffer.from([0, 255, 10]));
    const journal = createTransactionJournal({ root, projectId: "proj_1" });

    const tx = await journal.open({ kind: "edit", tx_id: "tx_1", session_id: "sess_1", turn_id: "turn_1", owner_epoch: 1, paths: ["a.bin"] });

    assert.equal(tx.state, "open");
    assert.equal(tx.paths[0].pre_hash.startsWith("sha256:"), true);
    assert.deepEqual(await readFile(path.join(root, ".deepseek-code", "v2", "journal", "tx_1", tx.paths[0].blob)), Buffer.from([0, 255, 10]));
  });

  test("transaction journal abort restores modified and created files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-journal-abort-"));
    await writeFile(path.join(root, "a.txt"), "old\n");
    const journal = createTransactionJournal({ root, projectId: "proj_1" });
    await journal.open({ kind: "edit", tx_id: "tx_2", session_id: "sess_1", turn_id: "turn_1", owner_epoch: 1, paths: ["a.txt", "new.txt"] });
    await writeFile(path.join(root, "a.txt"), "new\n");
    await writeFile(path.join(root, "new.txt"), "created\n");

    const result = await journal.abort("tx_2");

    assert.equal(result.status, "rolled_back");
    assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "old\n");
    await assert.rejects(() => readFile(path.join(root, "new.txt"), "utf8"), /ENOENT/);
  });

  test("transaction journal blocks symlink escape", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-journal-symlink-"));
    const outside = await mkdtemp(path.join(tmpdir(), "dsc-journal-outside-"));

    try {
      await symlink(outside, path.join(root, "escape"), "dir");
    } catch (error) {
      // Skip test on Windows if symlink creation fails due to permissions
      if (process.platform === "win32" && (error.code === "EPERM" || error.code === "ENOENT")) {
        return;
      }
      throw error;
    }

    const journal = createTransactionJournal({ root, projectId: "proj_1" });

    await assert.rejects(
      () => journal.open({ kind: "edit", tx_id: "tx_3", session_id: "sess_1", turn_id: "turn_1", owner_epoch: 1, paths: ["escape/file.txt"] }),
      /path escapes workspace|symlink/
    );
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/core/recovery/journal-commit-fault.test.js
// ---------------------------------------------------------------------------
describe("unit/core/recovery/journal-commit-fault", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { readFile, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { createEventBus } = await import("../../../../src/shared/event-bus.js");
  const { createEditService } = await import("../../../../src/edits/edit-service.js");
  const { createTransactionJournal } = await import("../../../../src/core/recovery/transaction-journal.js");
  const { mkdtemp } = await import("../../../helpers/tmp.js");

  const MODIFY_DIFF = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new";

  test("edit-service rolls back snapshots and aborts journal when recoveryJournal.commit fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-commit-fault-"));
    await writeFile(path.join(root, "a.txt"), "old\n");

    const realJournal = createTransactionJournal({ root, projectId: "proj_fault" });
    let abortCalledWith = null;

    const mockJournal = {
      open: (...args) => realJournal.open(...args),
      commit: async () => {
        throw new Error("disk failure during journal commit");
      },
      abort: async (txId) => {
        abortCalledWith = txId;
        return realJournal.abort(txId);
      },
      scan: (...args) => realJournal.scan(...args),
      readManifest: (...args) => realJournal.readManifest(...args),
      preserveCurrent: (...args) => realJournal.preserveCurrent(...args)
    };

    const eventBus = createEventBus();
    const failedEvents = [];
    eventBus.subscribe("file:transaction_failed", (data) => failedEvents.push(data));

    const service = createEditService({
      projectRoot: root,
      eventBus,
      recoveryJournal: mockJournal
    });

    await assert.rejects(
      () => service.apply({ diff: MODIFY_DIFF, prompt: "test failure" }),
      /disk failure during journal commit/
    );

    // File was reverted by restoreSnapshots
    assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "old\n");

    // recoveryJournal.abort was called
    assert.ok(abortCalledWith);

    // file:transaction_failed event was emitted
    assert.equal(failedEvents.length, 1);
    assert.equal(failedEvents[0].restored, true);
    assert.equal(failedEvents[0].message, "transaction_failed");
  });

  test("rewind-service restores after failure and aborts journal when recoveryJournal.commit fails", async () => {
    const { createRewindService } = await import("../../../../src/sessions/rewind-service.js");
    const eventBus = createEventBus();
    let abortCalled = false;
    const mockJournal = {
      open: async () => ({ tx_id: "tx_rewind_test" }),
      commit: async () => {
        throw new Error("disk failure during rewind journal commit");
      },
      abort: async () => {
        abortCalled = true;
      }
    };

    let activeBranch = "br_main";
    const rollbacks = [];
    const service = createRewindService({
      eventBus,
      recoveryJournal: mockJournal,
      getTimeline: async () => [
        { seq: 1, event_id: "evt_1", type: "user:message", turn_id: "turn_1", branch_id: "br_main" },
        { seq: 2, event_id: "evt_2", type: "file:diff_applied", change_id: "c1", files: ["a.txt"], branch_id: "br_main" }
      ],
      getActiveBranchId: async () => activeBranch,
      createBranch: async (input) => ({ branch_id: "br_new", ...input }),
      activateBranch: async (b) => { activeBranch = b; },
      rollback: async (input) => {
        rollbacks.push(input);
        return { status: "success" };
      }
    });

    const res = await service.apply({ target: { turn_id: "turn_1" } });
    assert.equal(abortCalled, true);
    assert.equal(res.status, "failed_restored");
    assert.equal(res.phase, "commit_journal");
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/core/recovery/recovery-faults.test.js
// ---------------------------------------------------------------------------
describe("unit/core/recovery/recovery-faults", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createRecoveryFaults } = await import("../../../../src/core/recovery/recovery-faults.js");

  test("recovery faults are no-op by default", async () => {
    const faults = createRecoveryFaults();
    await faults.maybe("after-journal-write");
    assert.equal(faults.hitCount("after-journal-write"), 0);
  });

  test("recovery faults throw once for configured labels", async () => {
    const faults = createRecoveryFaults({ labels: ["after-journal-write"] });

    await assert.rejects(() => faults.maybe("after-journal-write"), /recovery fault: after-journal-write/);
    await faults.maybe("after-journal-write");
    assert.equal(faults.hitCount("after-journal-write"), 1);
  });
});
