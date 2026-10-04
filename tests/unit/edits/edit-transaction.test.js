import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  enhanceChangeRecord,
  hashContent,
  restoreSnapshots,
  safeTransactionError,
  snapshotTouchedFiles
} from "../../../src/edits/edit-transaction.js";
import { parseDiff } from "../../../src/edits/diff-parser.js";
import { mkdtemp } from "../../helpers/tmp.js";

test("hashContent returns stable sha256 metadata", () => {
  const result = hashContent("hello\n");

  assert.equal(result.hash.startsWith("sha256:"), true);
  assert.equal(result.bytes, Buffer.byteLength("hello\n"));
  assert.equal(hashContent("hello\n").hash, result.hash);
  assert.notEqual(hashContent("other\n").hash, result.hash);
});

test("snapshotTouchedFiles records existing and created file states", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-edit-tx-snapshot-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  const diff = [
    "diff --git a/a.txt b/a.txt",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "diff --git a/new.txt b/new.txt",
    "--- /dev/null",
    "+++ b/new.txt",
    "@@ -0,0 +1 @@",
    "+created"
  ].join("\n");
  const parsed = parseDiff(diff);

  const snapshots = await snapshotTouchedFiles(root, parsed.patches);

  const byPath = Object.fromEntries(snapshots.map((item) => [item.path, item]));
  assert.equal(byPath["a.txt"].status, "modify");
  assert.equal(byPath["a.txt"].existed_before, true);
  assert.equal(byPath["a.txt"].before, "old\n");
  assert.equal(byPath["a.txt"].before_hash, hashContent("old\n").hash);
  assert.equal(byPath["new.txt"].status, "create");
  assert.equal(byPath["new.txt"].existed_before, false);
  assert.equal(byPath["new.txt"].before, null);
  assert.equal(byPath["new.txt"].before_hash, null);
});

test("restoreSnapshots restores modified files and removes created files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-edit-tx-restore-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  const parsed = parseDiff([
    "diff --git a/a.txt b/a.txt",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "diff --git a/new.txt b/new.txt",
    "--- /dev/null",
    "+++ b/new.txt",
    "@@ -0,0 +1 @@",
    "+created"
  ].join("\n"));
  const snapshots = await snapshotTouchedFiles(root, parsed.patches);
  await writeFile(path.join(root, "a.txt"), "new\n");
  await writeFile(path.join(root, "new.txt"), "created\n");

  const restored = await restoreSnapshots(root, snapshots);

  assert.deepEqual(restored.sort(), ["a.txt", "new.txt"]);
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "old\n");
  await assert.rejects(() => readFile(path.join(root, "new.txt"), "utf8"), /ENOENT/);
});

test("snapshotTouchedFiles refuses create patches when target already exists", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-edit-tx-create-exists-"));
  await writeFile(path.join(root, "new.txt"), "user content\n");
  const parsed = parseDiff([
    "diff --git a/new.txt b/new.txt",
    "--- /dev/null",
    "+++ b/new.txt",
    "@@ -0,0 +1 @@",
    "+created"
  ].join("\n"));

  await assert.rejects(
    () => snapshotTouchedFiles(root, parsed.patches),
    /already exists/
  );
});

test("safeTransactionError returns category-only message, no raw content", () => {
  const contentLeak = safeTransactionError(new Error("patch context mismatch: expected 'secret a', got 'old a'"));
  assert.equal(contentLeak.includes("secret a"), false);
  assert.equal(contentLeak.includes("old a"), false);
  assert.match(contentLeak, /patch_failed/);

  const finalizeErr = safeTransactionError(new Error("ENOENT: write failed"));
  assert.match(finalizeErr, /transaction_finalize_failed/);

  const restoreErr = safeTransactionError(new Error("something else"));
  assert.match(restoreErr, /transaction_failed/);
});

test("detectRollbackConflicts treats non-file paths as dirty", async () => {
  const { detectRollbackConflicts } = await import("../../../src/edits/edit-transaction.js");
  const root = await mkdtemp(path.join(tmpdir(), "dsc-edit-tx-eisdir-"));
  // Create a directory at the file path to trigger EISDIR
  await (await import("node:fs/promises")).mkdir(path.join(root, "a.txt"));

  const record = {
    id: "change_1",
    files: [{ path: "a.txt", newPath: "a.txt", oldPath: "a.txt", status: "modify", before: "old\n", after: "new\n", after_hash: hashContent("new\n").hash }]
  };
  const conflicts = await detectRollbackConflicts(root, record);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].path, "a.txt");
  assert.equal(conflicts[0].reason, "dirty");
});

test("restoreSnapshots removes empty parent dirs created during apply", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-edit-tx-cleandir-"));
  // Diff creates nested/new.txt
  const parsed = parseDiff([
    "diff --git a/deep/nested/new.txt b/deep/nested/new.txt",
    "--- /dev/null",
    "+++ b/deep/nested/new.txt",
    "@@ -0,0 +1 @@",
    "+created"
  ].join("\n"));
  const snapshots = await snapshotTouchedFiles(root, parsed.patches);
  // Apply: create the nested file
  const { resolveWorkspacePath } = await import("../../../src/workspace/path-safety.js");
  const resolved = await resolveWorkspacePath(root, "deep/nested/new.txt", { mustExist: false });
  await (await import("node:fs/promises")).mkdir(path.dirname(resolved.absolute), { recursive: true });
  await writeFile(resolved.absolute, "created\n");

  const restored = await restoreSnapshots(root, snapshots);
  assert.deepEqual(restored, ["deep/nested/new.txt"]);
  // All parent dirs should be cleaned up
  const { stat } = await import("node:fs/promises");
  await assert.rejects(() => stat(path.join(root, "deep", "nested")), /ENOENT/);
  await assert.rejects(() => stat(path.join(root, "deep")), /ENOENT/);
});

test("enhanceChangeRecord adds before and after hashes to each file", () => {
  const record = {
    id: "change_1",
    files: [
      {
        path: "a.txt",
        oldPath: "a.txt",
        newPath: "a.txt",
        status: "modify",
        before: "old\n",
        after: "new\n"
      }
    ]
  };
  const enhanced = enhanceChangeRecord(record, { transaction_id: "tx_1" });

  assert.equal(enhanced.transaction_id, "tx_1");
  assert.equal(enhanced.files[0].before_hash, hashContent("old\n").hash);
  assert.equal(enhanced.files[0].after_hash, hashContent("new\n").hash);
  assert.equal(enhanced.files[0].before_bytes, Buffer.byteLength("old\n"));
  assert.equal(enhanced.files[0].after_bytes, Buffer.byteLength("new\n"));
});
