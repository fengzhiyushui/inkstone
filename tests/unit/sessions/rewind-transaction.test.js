import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  captureRewindSnapshots,
  restoreRewindSnapshots,
  safeRewindError
} from "../../../src/sessions/rewind-transaction.js";
import { mkdtemp } from "../../helpers/tmp.js";

test("captureRewindSnapshots captures existing and missing files without leaking content in metadata", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-rewind-tx-"));
  await writeFile(path.join(root, "a.txt"), "before a\n", "utf8");

  const snapshots = await captureRewindSnapshots(root, ["a.txt", "new/created.txt"]);

  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[0].path, "a.txt");
  assert.equal(snapshots[0].existed_before, true);
  assert.equal(snapshots[0].before, "before a\n");
  assert.match(snapshots[0].before_hash, /^sha256:/);
  assert.equal(snapshots[1].path, "new/created.txt");
  assert.equal(snapshots[1].existed_before, false);
  assert.equal(snapshots[1].before, null);
  assert.equal(JSON.stringify(snapshots.map(({ before, ...safe }) => safe)).includes("before a"), false);
});

test("restoreRewindSnapshots restores modified files and removes files created during rewind", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-rewind-restore-"));
  await writeFile(path.join(root, "a.txt"), "before a\n", "utf8");
  const snapshots = await captureRewindSnapshots(root, ["a.txt", "nested/new.txt"]);

  await writeFile(path.join(root, "a.txt"), "after rewind\n", "utf8");
  await mkdir(path.join(root, "nested"), { recursive: true });
  await writeFile(path.join(root, "nested", "new.txt"), "created\n", "utf8");

  const restored = await restoreRewindSnapshots(root, snapshots);

  assert.deepEqual(restored.sort(), ["a.txt", "nested/new.txt"].sort());
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "before a\n");
  await assert.rejects(() => readFile(path.join(root, "nested", "new.txt"), "utf8"), /ENOENT/);
});

test("captureRewindSnapshots rejects path traversal", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-rewind-unsafe-"));
  await assert.rejects(
    () => captureRewindSnapshots(root, ["../outside.txt"]),
    /outside workspace|path traversal|outside project|escapes project/i
  );
});

test("safeRewindError returns category only and never raw message", () => {
  const error = new Error("disk failed while writing secret-token-123");
  assert.equal(safeRewindError(error, "create_branch"), "branch_create_failed");
  assert.equal(safeRewindError(error, "activate_branch"), "branch_activate_failed");
  assert.equal(safeRewindError(error, "rollback"), "rollback_failed");
  assert.equal(safeRewindError(error, "restore"), "restore_failed");
  assert.equal(safeRewindError(error, "other"), "rewind_failed");
});
