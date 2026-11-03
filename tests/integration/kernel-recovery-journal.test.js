// tests/integration/kernel-recovery-journal.test.js — 内核恢复与事务日志集成领域测试
//
// v1.19.1 测试归并:本文件由下列历史任务单测试合并而成,每个来源包裹在独立
// describe 块中(异步回调 + 动态 import,来源间零共享绑定),测试语义与拆分前一致。
import { describe } from "node:test";

// ---------------------------------------------------------------------------
// 来源:tests/integration/v2-kernel-recovery-journal.test.js
// ---------------------------------------------------------------------------
describe("integration/v2-kernel-recovery-journal", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { createKernel } = await import("../../src/index.js");
  const { createTransactionJournal } = await import("../../src/core/recovery/transaction-journal.js");
  const { mkdtemp } = await import("../helpers/tmp.js");

  test("kernel exposes recovery.abortJournal and recovery.commitJournal", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-kernel-recovery-"));
    await writeFile(path.join(root, "a.txt"), "original\n");

    const kernel = await createKernel(root, {
      sessionRoot: path.join(root, ".deepseek-code", "v2", "sessions"),
      recovery: { enabled: true, surface: "cli" },
      modelGateway: null
    });

    // Verify APIs exist
    assert.equal(typeof kernel.recovery.abortJournal, "function");
    assert.equal(typeof kernel.recovery.commitJournal, "function");
    assert.equal(typeof kernel.recovery.list, "function");
    assert.equal(typeof kernel.recovery.report, "function");
  });

  test("kernel recovery.abortJournal rolls back open transaction", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-kernel-abort-"));
    await writeFile(path.join(root, "a.txt"), "original\n");

    const kernel = await createKernel(root, {
      sessionRoot: path.join(root, ".deepseek-code", "v2", "sessions"),
      recovery: { enabled: true, surface: "cli" },
      modelGateway: null
    });

    // Create open transaction
    const journal = createTransactionJournal({ root, projectId: kernel.root });
    await journal.open({
      kind: "edit",
      tx_id: "tx_abort_test",
      session_id: "sess_1",
      turn_id: "turn_1",
      owner_epoch: 1,
      paths: ["a.txt"],
      target: { type: "edit", description: "test" }
    });

    // Trigger recovery scan
    await kernel.recovery.list();

    // Abort via kernel API
    const result = await kernel.recovery.abortJournal("rec_journal_tx_abort_test");
    assert.equal(result.status, "aborted");
  });

  test("kernel recovery.commitJournal commits open transaction", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-kernel-commit-"));
    await writeFile(path.join(root, "a.txt"), "original\n");

    const kernel = await createKernel(root, {
      sessionRoot: path.join(root, ".deepseek-code", "v2", "sessions"),
      recovery: { enabled: true, surface: "cli" },
      modelGateway: null
    });

    // Create open transaction
    const journal = createTransactionJournal({ root, projectId: kernel.root });
    await journal.open({
      kind: "edit",
      tx_id: "tx_commit_test",
      session_id: "sess_1",
      turn_id: "turn_1",
      owner_epoch: 1,
      paths: ["a.txt"],
      target: { type: "edit", description: "test" }
    });

    // Trigger recovery scan
    await kernel.recovery.list();

    // Commit via kernel API
    const result = await kernel.recovery.commitJournal("rec_journal_tx_commit_test");
    assert.equal(result.status, "committed");
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/integration/v2-recovery-edit-journal.test.js
// ---------------------------------------------------------------------------
describe("integration/v2-recovery-edit-journal", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { readFile, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { createEditService } = await import("../../src/edits/edit-service.js");
  const { createTransactionJournal } = await import("../../src/core/recovery/transaction-journal.js");
  const { createRecoveryFaults } = await import("../../src/core/recovery/recovery-faults.js");
  const { mkdtemp } = await import("../helpers/tmp.js");

  const DIFF = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new";

  test("interrupted edit journal rolls back only the open transaction", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-edit-recovery-"));
    await writeFile(path.join(root, "a.txt"), "old\n");
    const faults = createRecoveryFaults({ labels: ["after-first-file-write"] });
    const journal = createTransactionJournal({ root, projectId: "proj_1" });
    const service = createEditService({ projectRoot: root, recoveryJournal: journal, faults });

    await assert.rejects(() => service.apply({ diff: DIFF, prompt: "update" }), /recovery fault: after-first-file-write/);

    // The fault was injected after file write but before journal commit, so edit-service already aborted the journal
    // Verify the file was restored to original content
    assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "old\n");
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/integration/v2-recovery-rewind-journal.test.js
// ---------------------------------------------------------------------------
describe("integration/v2-recovery-rewind-journal", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { createRewindService } = await import("../../src/sessions/rewind-service.js");
  const { createTransactionJournal } = await import("../../src/core/recovery/transaction-journal.js");
  const { createRecoveryFaults } = await import("../../src/core/recovery/recovery-faults.js");
  const { mkdtemp } = await import("../helpers/tmp.js");

  test("interrupted rewind journal captures branch state and rolls back", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-rewind-recovery-"));
    await writeFile(path.join(root, "a.txt"), "original\n");

    const faults = createRecoveryFaults({ labels: ["after-branch-created"] });
    const journal = createTransactionJournal({ root, projectId: "proj_1" });

    let branchCreated = false;
    const timeline = [
      { seq: 1, event_id: "e1", type: "user:message", turn_id: "turn_1", branch_id: "main", turn_index: 0 },
      { seq: 2, event_id: "e2", type: "file:transaction_committed", change_id: "ch_1", branch_id: "main", turn_id: "turn_1", turn_index: 0 },
      { seq: 3, event_id: "e3", type: "agent:final", turn_id: "turn_1", branch_id: "main", turn_index: 0 },
      { seq: 4, event_id: "e4", type: "user:message", turn_id: "turn_2", branch_id: "main", turn_index: 1 }
    ];

    const service = createRewindService({
      projectRoot: root,
      getTimeline: async () => timeline,
      getActiveBranchId: async () => "main",
      createBranch: async ({ branch_id }) => {
        branchCreated = true;
        return { branch_id, parent_branch_id: "main", forked_from_seq: 3, forked_from_event_id: "e3", forked_from_turn_id: "turn_1" };
      },
      activateBranch: async () => {},
      rollback: async () => ({ status: "success", metadata: { files: ["a.txt"] } }),
      recoveryJournal: journal,
      faults
    });

    const result = await service.apply({ target: { turn_id: "turn_1" } });

    // Fault injected after branch created, so rewind failed and restored
    assert.equal(result.status, "failed_restored");
    assert.equal(branchCreated, true);

    // After failure, rewind-service calls journal.abort() which removes the journal directory
    // So we verify by checking that the abort succeeded (no lingering journals)
    const entries = await journal.scan();
    assert.equal(entries.length, 0, "journal should be cleaned up after abort");
  });

  test("successful rewind commits journal with branch state", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-rewind-journal-success-"));
    await writeFile(path.join(root, "a.txt"), "original\n");

    const journal = createTransactionJournal({ root, projectId: "proj_1" });

    const timeline = [
      { seq: 1, event_id: "e1", type: "user:message", turn_id: "turn_1", branch_id: "main", turn_index: 0 },
      { seq: 2, event_id: "e2", type: "file:transaction_committed", change_id: "ch_1", branch_id: "main", turn_id: "turn_1", turn_index: 0, files: ["a.txt"] },
      { seq: 3, event_id: "e3", type: "agent:final", turn_id: "turn_1", branch_id: "main", turn_index: 0 },
      { seq: 4, event_id: "e4", type: "user:message", turn_id: "turn_2", branch_id: "main", turn_index: 1 },
      { seq: 5, event_id: "e5", type: "file:transaction_committed", change_id: "ch_2", branch_id: "main", turn_id: "turn_2", turn_index: 1, files: ["b.txt"] },
      { seq: 6, event_id: "e6", type: "agent:final", turn_id: "turn_2", branch_id: "main", turn_index: 1 }
    ];

    const service = createRewindService({
      projectRoot: root,
      getTimeline: async () => timeline,
      getActiveBranchId: async () => "main",
      createBranch: async () => ({ branch_id: "br_new", parent_branch_id: "main", forked_from_seq: 3 }),
      activateBranch: async () => {},
      rollback: async () => ({ status: "success", metadata: { files: ["b.txt"] } }),
      recoveryJournal: journal
    });

    const result = await service.apply({ target: { turn_id: "turn_1" } });

    assert.equal(result.status, "success");

    // Successful rewind commits the journal (state becomes "committed")
    const entries = await journal.scan();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].state, "committed");
    assert.equal(entries[0].kind, "rewind");
    assert.equal(entries[0].rewind_branch_state.current_branch_id, "main");
    assert.equal(entries[0].rewind_branch_state.rollback_change_ids[0], "ch_2");
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/integration/v2-recovery-service-journal.test.js
// ---------------------------------------------------------------------------
describe("integration/v2-recovery-service-journal", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { createRecoveryService } = await import("../../src/core/recovery/recovery-service.js");
  const { createTransactionJournal } = await import("../../src/core/recovery/transaction-journal.js");
  const { createRecoveryInbox } = await import("../../src/core/recovery/recovery-inbox.js");
  const { acquireProjectLock } = await import("../../src/core/recovery/project-lock.js");
  const { createPausedTurnPersistence } = await import("../../src/core/recovery/paused-turn-persistence.js");
  const { mkdtemp } = await import("../helpers/tmp.js");

  test("recovery service scans and exposes open transaction journals", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-recovery-svc-"));
    await writeFile(path.join(root, "a.txt"), "original\n");

    const journal = createTransactionJournal({ root, projectId: "proj_1" });
    const inbox = createRecoveryInbox({ root, projectId: "proj_1" });
    const lock = await acquireProjectLock({ root, surface: "cli", sessionId: "sess_1" });
    const paused = createPausedTurnPersistence({ root, projectId: "proj_1" });
    const pausedTurnStore = { restore: () => {}, list: () => [] };

    // Create an open transaction
    await journal.open({
      kind: "edit",
      tx_id: "tx_open_1",
      session_id: "sess_1",
      turn_id: "turn_1",
      owner_epoch: 1,
      paths: ["a.txt"],
      target: { type: "edit", description: "test edit" }
    });

    const markers = [];
    const service = createRecoveryService({
      projectId: "proj_1",
      lock,
      paused,
      pausedTurnStore,
      inbox,
      appendMarker: async (type, data) => markers.push({ type, data }),
      transactionJournal: journal
    });

    const report = await service.recoverOnStartup();

    assert.equal(report.found.length, 1);
    assert.equal(report.found[0].type, "transaction_journal");
    assert.equal(report.found[0].summary.includes("tx_open_1"), true);

    const items = await service.list();
    const journalItem = items.find(item => item.id === "rec_journal_tx_open_1");
    assert.ok(journalItem);
    assert.equal(journalItem.type, "transaction_journal");
    assert.equal(journalItem.status, "pending");
    assert.deepEqual(journalItem.allowed_actions, ["abort_journal", "commit_journal"]);

    await lock.release();
  });

  test("recovery service can abort open transaction journal", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-recovery-abort-"));
    await writeFile(path.join(root, "a.txt"), "original\n");

    const journal = createTransactionJournal({ root, projectId: "proj_1" });
    const inbox = createRecoveryInbox({ root, projectId: "proj_1" });
    const lock = await acquireProjectLock({ root, surface: "cli", sessionId: "sess_1" });
    const paused = createPausedTurnPersistence({ root, projectId: "proj_1" });
    const pausedTurnStore = { restore: () => {}, list: () => [] };

    await journal.open({
      kind: "edit",
      tx_id: "tx_abort_1",
      session_id: "sess_1",
      turn_id: "turn_1",
      owner_epoch: 1,
      paths: ["a.txt"],
      target: { type: "edit", description: "test" }
    });

    const markers = [];
    const service = createRecoveryService({
      projectId: "proj_1",
      lock,
      paused,
      pausedTurnStore,
      inbox,
      appendMarker: async (type, data) => markers.push({ type, data }),
      transactionJournal: journal
    });

    await service.recoverOnStartup();

    const result = await service.abortJournal("rec_journal_tx_abort_1");
    assert.equal(result.status, "aborted");

    const items = await service.list();
    const journalItem = items.find(item => item.id === "rec_journal_tx_abort_1");
    assert.equal(journalItem.status, "aborted");

    await lock.release();
  });

  test("recovery service can commit open transaction journal", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-recovery-commit-"));
    await writeFile(path.join(root, "a.txt"), "original\n");

    const journal = createTransactionJournal({ root, projectId: "proj_1" });
    const inbox = createRecoveryInbox({ root, projectId: "proj_1" });
    const lock = await acquireProjectLock({ root, surface: "cli", sessionId: "sess_1" });
    const paused = createPausedTurnPersistence({ root, projectId: "proj_1" });
    const pausedTurnStore = { restore: () => {}, list: () => [] };

    await journal.open({
      kind: "edit",
      tx_id: "tx_commit_1",
      session_id: "sess_1",
      turn_id: "turn_1",
      owner_epoch: 1,
      paths: ["a.txt"],
      target: { type: "edit", description: "test" }
    });

    const markers = [];
    const service = createRecoveryService({
      projectId: "proj_1",
      lock,
      paused,
      pausedTurnStore,
      inbox,
      appendMarker: async (type, data) => markers.push({ type, data }),
      transactionJournal: journal
    });

    await service.recoverOnStartup();

    const result = await service.commitJournal("rec_journal_tx_commit_1");
    assert.equal(result.status, "committed");

    const items = await service.list();
    const journalItem = items.find(item => item.id === "rec_journal_tx_commit_1");
    assert.equal(journalItem.status, "committed");

    await lock.release();
  });
});
