import test from "node:test";
import assert from "node:assert/strict";
import { applyPatchToText, extractUnifiedDiff, parseUnifiedDiff, summarizeDiff } from "../../src/edits/diff-parser.js";

test("extracts fenced diff", () => {
  const diff = extractUnifiedDiff("```diff\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n```");
  assert.match(diff, /^--- a\/a.txt/);
});

test("parses and summarizes a modify diff", () => {
  const patches = parseUnifiedDiff("--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new");
  assert.equal(patches.length, 1);
  assert.deepEqual(summarizeDiff("--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new"), [
    { path: "a.txt", status: "modify" }
  ]);
});

test("applies a simple patch", () => {
  const [patch] = parseUnifiedDiff("--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n hello\n-old\n+new");
  const output = applyPatchToText("hello\nold\n", patch);
  assert.equal(output, "hello\nnew\n");
});
