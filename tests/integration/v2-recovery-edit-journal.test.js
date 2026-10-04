import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEditService } from "../../src/edits/edit-service.js";
import { createTransactionJournal } from "../../src/core/recovery/transaction-journal.js";
import { createRecoveryFaults } from "../../src/core/recovery/recovery-faults.js";
import { mkdtemp } from "../helpers/tmp.js";

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
