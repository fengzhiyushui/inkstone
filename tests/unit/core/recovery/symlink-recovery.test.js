import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, symlink, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTransactionJournal } from "../../../../src/core/recovery/transaction-journal.js";

test("transaction journal recognizes symlink/junction and restores it as symlink on abort", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-symlink-rec-"));
  const targetDir = path.join(root, "target_dir");
  const linkDir = path.join(root, "link_dir");

  await mkdir(targetDir);
  await writeFile(path.join(targetDir, "sample.txt"), "hello world");

  const symlinkType = process.platform === "win32" ? "junction" : "dir";
  try {
    await symlink(targetDir, linkDir, symlinkType);
  } catch (error) {
    // If platform doesn't allow symlink creation, return gracefully
    if (process.platform === "win32" && (error.code === "EPERM" || error.code === "ENOENT")) {
      return;
    }
    throw error;
  }

  const initialStat = await lstat(linkDir);
  assert.equal(initialStat.isSymbolicLink(), true, "link_dir should initially be a symbolic link");

  const journal = createTransactionJournal({ root, projectId: "proj_symlink" });
  const manifest = await journal.open({
    kind: "edit",
    tx_id: "tx_symlink_1",
    session_id: "sess_1",
    turn_id: "turn_1",
    owner_epoch: 1,
    paths: ["link_dir"]
  });

  assert.equal(manifest.paths.length, 1);
  assert.equal(manifest.paths[0].kind, "symlink");

  // Simulate an errant operation overwriting the symlink with a regular directory or file
  await rm(linkDir, { recursive: true, force: true });
  await writeFile(linkDir, "errant regular file content");

  const midStat = await lstat(linkDir);
  assert.equal(midStat.isSymbolicLink(), false, "link_dir was replaced with a regular file");

  // Abort the transaction
  const abortResult = await journal.abort("tx_symlink_1");
  assert.equal(abortResult.status, "rolled_back");

  // Verify that link_dir is restored back to a symbolic link
  const restoredStat = await lstat(linkDir);
  assert.equal(restoredStat.isSymbolicLink(), true, "link_dir must be restored as a symbolic link");
});
