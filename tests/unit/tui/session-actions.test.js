// tests/unit/tui/session-actions.test.js — /branch /rewind /fim 纯逻辑单测(零内核、零 IO)。
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseBranchArgs,
  formatBranchLines,
  parseRewindArgs,
  formatCheckpointLines,
  parseFimArgs
} from "../../../src/apps/tui/session-actions.js";

// 文案桩:键名与 tui-i18n.js 执行器接线轨共用;返回可断言的显著文本。
const T = (key) => ({
  "msg.branchEmpty": "(no branches)",
  "msg.checkpointEmpty": "(no checkpoints)"
}[key] ?? key);

test("parseBranchArgs: empty arg lists branches", () => {
  const list = { action: "list", id: null, label: null };
  assert.deepEqual(parseBranchArgs(""), list);
  assert.deepEqual(parseBranchArgs("   "), list);
  assert.deepEqual(parseBranchArgs(null), list);
  assert.deepEqual(parseBranchArgs(undefined), list);
});

test("parseBranchArgs: switch takes the branch id", () => {
  assert.deepEqual(parseBranchArgs("switch br_9k2m"), { action: "switch", id: "br_9k2m", label: null });
  assert.deepEqual(parseBranchArgs("  switch   br_main  "), { action: "switch", id: "br_main", label: null });
  // 后续多余词元忽略(取首个为 id)
  assert.deepEqual(parseBranchArgs("switch br_a extra words"), { action: "switch", id: "br_a", label: null });
});

test("parseBranchArgs: new keeps multi-word label trimmed and space-collapsed", () => {
  assert.deepEqual(parseBranchArgs("new fix fim parser"), { action: "new", id: null, label: "fix fim parser" });
  assert.deepEqual(parseBranchArgs("new    多词   标签  "), { action: "new", id: null, label: "多词 标签" });
  assert.deepEqual(parseBranchArgs("new one"), { action: "new", id: null, label: "one" });
});

test("parseBranchArgs: invalid shapes carry an error code", () => {
  assert.deepEqual(parseBranchArgs("switch"), { action: "invalid", id: null, label: null, error: "missing_id" });
  assert.deepEqual(parseBranchArgs("new"), { action: "invalid", id: null, label: null, error: "missing_label" });
  assert.deepEqual(parseBranchArgs("new    "), { action: "invalid", id: null, label: null, error: "missing_label" });
  assert.deepEqual(parseBranchArgs("delete br_1"), { action: "invalid", id: null, label: null, error: "unknown_action" });
  assert.deepEqual(parseBranchArgs("Switch br_1"), { action: "invalid", id: null, label: null, error: "unknown_action" });
  assert.deepEqual(parseBranchArgs("list"), { action: "invalid", id: null, label: null, error: "unknown_action" });
});

test("parseRewindArgs: action and checkpoint id", () => {
  assert.deepEqual(parseRewindArgs(""), { action: "list", checkpointId: null });
  assert.deepEqual(parseRewindArgs("  "), { action: "list", checkpointId: null });
  assert.deepEqual(parseRewindArgs(null), { action: "list", checkpointId: null });
  assert.deepEqual(parseRewindArgs("preview cp_1"), { action: "preview", checkpointId: "cp_1" });
  assert.deepEqual(parseRewindArgs("  apply   cp_2  "), { action: "apply", checkpointId: "cp_2" });
  assert.deepEqual(parseRewindArgs("apply cp_3 extra"), { action: "apply", checkpointId: "cp_3" });
});

test("parseRewindArgs: invalid shapes carry an error code", () => {
  assert.deepEqual(parseRewindArgs("preview"), { action: "invalid", checkpointId: null, error: "missing_id" });
  assert.deepEqual(parseRewindArgs("apply"), { action: "invalid", checkpointId: null, error: "missing_id" });
  assert.deepEqual(parseRewindArgs("bogus cp_1"), { action: "invalid", checkpointId: null, error: "unknown_action" });
  assert.deepEqual(parseRewindArgs("PREVIEW cp_1"), { action: "invalid", checkpointId: null, error: "unknown_action" });
});

test("parseFimArgs: whole arg is prefix; suffix is always empty", () => {
  assert.deepEqual(parseFimArgs("def foo(a, b)"), { prefix: "def foo(a, b)", suffix: "" });
  assert.deepEqual(parseFimArgs("  pad me  "), { prefix: "pad me", suffix: "" });
  assert.deepEqual(parseFimArgs(""), { prefix: "", suffix: "" });
  assert.deepEqual(parseFimArgs(null), { prefix: "", suffix: "" });
  // 无光标内联:含分隔符的整段也是 prefix,suffix 恒 ""
  assert.deepEqual(parseFimArgs("a<|b|>c"), { prefix: "a<|b|>c", suffix: "" });
});

test("formatBranchLines: empty list renders the injected dim line", () => {
  assert.deepEqual(formatBranchLines([], "br_main", T), ["  (no branches)"]);
  assert.deepEqual(formatBranchLines(null, "br_main", T), ["  (no branches)"]);
  assert.deepEqual(formatBranchLines(undefined, null, T), ["  (no branches)"]);
});

test("formatBranchLines: marks the active branch with the ● glyph", () => {
  const branches = [
    { branch_id: "br_main", label: "main" },
    { branch_id: "br_side", label: "feature x" }
  ];
  assert.deepEqual(formatBranchLines(branches, "br_side", T), [
    "  br_main  main  ",
    "  br_side  feature x  ●"
  ]);
  // activeId 不在列表中 → 无任何标记
  assert.deepEqual(formatBranchLines(branches, "br_gone", T), [
    "  br_main  main  ",
    "  br_side  feature x  "
  ]);
  // 空 label 段不省略
  assert.deepEqual(formatBranchLines([{ branch_id: "br_x", label: "" }], "br_x", T), ["  br_x    ●"]);
  // t 桩可换 → 空列表文案随注入变化
  assert.deepEqual(formatBranchLines([], "br_main", (k) => `[${k}]`), ["  [msg.branchEmpty]"]);
});

test("formatBranchLines: sorted by branch_id, input untouched, repeatable", () => {
  const branches = [
    { branch_id: "br_c", label: "c" },
    { branch_id: "br_a", label: "a" },
    { branch_id: "br_b", label: "b" }
  ];
  const snapshot = JSON.parse(JSON.stringify(branches));
  const lines = formatBranchLines(branches, "br_b", T);
  assert.deepEqual(lines, [
    "  br_a  a  ",
    "  br_b  b  ●",
    "  br_c  c  "
  ]);
  assert.deepEqual(branches, snapshot, "must not mutate the input array");
  assert.deepEqual(formatBranchLines(branches, "br_b", T), lines, "same input → same output");
  // 同 id 时保留输入顺序(稳定排序)
  const dup = [
    { branch_id: "br_dup", label: "first" },
    { branch_id: "br_dup", label: "second" }
  ];
  assert.deepEqual(formatBranchLines(dup, null, T), ["  br_dup  first  ", "  br_dup  second  "]);
});

test("formatCheckpointLines: empty list renders the injected dim line", () => {
  assert.deepEqual(formatCheckpointLines([], T), ["  (no checkpoints)"]);
  assert.deepEqual(formatCheckpointLines(null, T), ["  (no checkpoints)"]);
});

test("formatCheckpointLines: id, turn/seq summary, and time", () => {
  const checkpoints = [
    { checkpoint_id: "cp_2", branch_id: "br_main", seq: 7, turn_id: "turn_2", type: "turn", label: "after turn_2", timestamp: "2026-01-02T03:04:05.000Z" },
    { checkpoint_id: "cp_1", branch_id: "br_main", seq: 3, turn_id: null, type: "event", label: "user:message", created_at: "2026-01-01T00:00:00.000Z" }
  ];
  assert.deepEqual(formatCheckpointLines(checkpoints, T), [
    "  cp_1  seq 3  2026-01-01T00:00:00.000Z",
    "  cp_2  turn turn_2  2026-01-02T03:04:05.000Z"
  ]);
  // 时间字段回退:timestamp 优先,然后 created_at,然后 ts;全缺省时段落省略
  assert.deepEqual(formatCheckpointLines(
    [{ checkpoint_id: "cp_0", seq: 1, turn_id: "turn_0", timestamp: "T1", created_at: "T2", ts: "T3" }], T),
    ["  cp_0  turn turn_0  T1"]);
  assert.deepEqual(formatCheckpointLines(
    [{ checkpoint_id: "cp_0", seq: 1, created_at: "T2", ts: "T3" }], T),
    ["  cp_0  seq 1  T2"]);
  assert.deepEqual(formatCheckpointLines([{ checkpoint_id: "cp_0", seq: 1, ts: "T3" }], T), ["  cp_0  seq 1  T3"]);
  assert.deepEqual(formatCheckpointLines([{ checkpoint_id: "cp_0", seq: 1 }], T), ["  cp_0  seq 1"]);
});

test("formatCheckpointLines: seq ascending, ties by checkpoint_id, input untouched", () => {
  const checkpoints = [
    { checkpoint_id: "cp_b", seq: 5 },
    { checkpoint_id: "cp_a", seq: 5 },
    { checkpoint_id: "cp_c", seq: 2 }
  ];
  const snapshot = JSON.parse(JSON.stringify(checkpoints));
  const lines = formatCheckpointLines(checkpoints, T);
  assert.deepEqual(lines, ["  cp_c  seq 2", "  cp_a  seq 5", "  cp_b  seq 5"]);
  assert.deepEqual(checkpoints, snapshot, "must not mutate the input array");
  assert.deepEqual(formatCheckpointLines(checkpoints, T), lines, "same input → same output");
});
