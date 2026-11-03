// tests/unit/edits/diff-parser.test.js — Diff 解析与补丁(字节保真)领域测试
//
// v1.19.1 测试归并:本文件由下列历史任务单测试合并而成,每个来源包裹在独立
// describe 块中(异步回调 + 动态 import,来源间零共享绑定),测试语义与拆分前一致。
import { describe } from "node:test";

// ---------------------------------------------------------------------------
// 来源:tests/unit/edits/diff-parser.test.js
// ---------------------------------------------------------------------------
describe("unit/edits/diff-parser", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { mkdir, writeFile, symlink } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { normalizeUnifiedDiff, parseDiff, formatDiffSummary, assertDiffPathsSafe } = await import("../../../src/edits/diff-parser.js");
  const { symlinkTraversalSupported, SYMLINK_SKIP_REASON } = await import("../../helpers/symlink-capability.js");
  const { mkdtemp } = await import("../../helpers/tmp.js");

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
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/patch.test.js
// ---------------------------------------------------------------------------
describe("unit/patch", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { applyPatchToText, extractUnifiedDiff, parseUnifiedDiff, summarizeDiff } = await import("../../../src/edits/diff-parser.js");

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
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/patch/byte-fidelity.test.js
// ---------------------------------------------------------------------------
describe("unit/patch/byte-fidelity", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { applyPatchToText, parseUnifiedDiff } = await import("../../../src/edits/diff-parser.js");

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
});
