import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEventBus } from "../../../../src/shared/event-bus.js";
import { createEditService } from "../../../../src/edits/edit-service.js";
import { createTransactionJournal } from "../../../../src/core/recovery/transaction-journal.js";

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

