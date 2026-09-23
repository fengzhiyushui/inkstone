import test from "node:test";
import assert from "node:assert/strict";
import { applyPatchToText, parseUnifiedDiff } from "../../../src/patch.js";

test("byte fidelity: preserves absence of final newline", () => {
  const [patch] = parseUnifiedDiff("--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n hello\n-old\n+new");
  // 源文件没有以 \n 结尾
  const output = applyPatchToText("hello\nold", patch);
  assert.equal(output, "hello\nnew");
});

test("byte fidelity: preserves CRLF line endings", () => {
  const [patch] = parseUnifiedDiff("--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n hello\n-old\n+new");
  const output = applyPatchToText("hello\r\nold\r\n", patch);
  assert.equal(output, "hello\r\nnew\r\n");
});

test("byte fidelity: empty file or empty lines handling", () => {
  const [patch] = parseUnifiedDiff("--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new");
  const output = applyPatchToText("old", patch);
  assert.equal(output, "new");
});
