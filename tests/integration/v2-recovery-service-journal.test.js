import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRecoveryService } from "../../src/core/recovery/recovery-service.js";
import { createTransactionJournal } from "../../src/core/recovery/transaction-journal.js";
import { createRecoveryInbox } from "../../src/core/recovery/recovery-inbox.js";
import { acquireProjectLock } from "../../src/core/recovery/project-lock.js";
import { createPausedTurnPersistence } from "../../src/core/recovery/paused-turn-persistence.js";
import { mkdtemp } from "../helpers/tmp.js";

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
