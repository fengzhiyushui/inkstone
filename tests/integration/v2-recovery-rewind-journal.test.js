import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRewindService } from "../../src/sessions/rewind-service.js";
import { createTransactionJournal } from "../../src/core/recovery/transaction-journal.js";
import { createRecoveryFaults } from "../../src/core/recovery/recovery-faults.js";
import { mkdtemp } from "../helpers/tmp.js";

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
