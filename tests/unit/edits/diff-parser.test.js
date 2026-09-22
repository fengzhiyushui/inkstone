import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  normalizeUnifiedDiff,
  parseDiff,
  formatDiffSummary,
  assertDiffPathsSafe
} from "../../../src/edits/diff-parser.js";
import { symlinkTraversalSupported, SYMLINK_SKIP_REASON } from "../../helpers/symlink-capability.js";

test("normalizeUnifiedDiff extracts fenced unified diff", () => {
  const diff = normalizeUnifiedDiff("```diff\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n```");
  assert.equal(diff, "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new");
});

test("parseDiff returns patches summary and files", () => {
  const parsed = parseDiff("--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new");

  assert.equal(parsed.patches.length, 1);
  assert.deepEqual(parsed.summary, [{ path: "a.txt", status: "modify" }]);
  assert.deepEqual(parsed.files, ["a.txt"]);
  assert.match(formatDiffSummary(parsed.summary), /modify a\.txt/);
});

test("parseDiff rejects empty or non-diff input", () => {
  assert.throws(() => normalizeUnifiedDiff("plain text"), /unified diff is required/);
  assert.throws(() => parseDiff(""), /unified diff is required/);
});

test("assertDiffPathsSafe rejects lexical traversal", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-edit-safe-"));
  const parsed = parseDiff("--- a/../outside.txt\n+++ b/../outside.txt\n@@ -1 +1 @@\n-old\n+new");

  await assert.rejects(
    () => assertDiffPathsSafe(root, parsed.patches),
    /escapes project root/
  );
});

test("assertDiffPathsSafe rejects symlink escape before legacy apply", async (t) => {
  if (!(await symlinkTraversalSupported())) { t.skip(SYMLINK_SKIP_REASON); return; }
  const root = await mkdtemp(path.join(tmpdir(), "dsc-edit-safe-"));
  const outside = await mkdtemp(path.join(tmpdir(), "dsc-edit-out-"));
  await writeFile(path.join(outside, "secret.txt"), "secret\n");
  await symlink(outside, path.join(root, "link"), "junction");
  const parsed = parseDiff("--- a/link/secret.txt\n+++ b/link/secret.txt\n@@ -1 +1 @@\n-secret\n+changed");

  await assert.rejects(
    () => assertDiffPathsSafe(root, parsed.patches),
    /escapes project root/
  );
});

test("assertDiffPathsSafe allows creating a new file under safe ancestor", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-edit-safe-"));
  await mkdir(path.join(root, "src"));
  const parsed = parseDiff("--- /dev/null\n+++ b/src/new.js\n@@ -0,0 +1 @@\n+console.log(1);");

  await assert.doesNotReject(() => assertDiffPathsSafe(root, parsed.patches));
});
