import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createKernel } from "../../src/index.js";
import { createTransactionJournal } from "../../src/core/recovery/transaction-journal.js";
import { mkdtemp } from "../helpers/tmp.js";

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
