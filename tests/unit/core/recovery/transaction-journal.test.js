import test from "node:test";
import assert from "node:assert/strict";
import { readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTransactionJournal } from "../../../../src/core/recovery/transaction-journal.js";
import { mkdtemp } from "../../../helpers/tmp.js";

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
