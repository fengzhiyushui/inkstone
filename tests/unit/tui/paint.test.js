import test from "node:test";
import assert from "node:assert/strict";
import { computeBottom, createPainter } from "../../../src/apps/tui/paint.js";
import { initialTuiState, reduce } from "../../../src/apps/tui/tui-state.js";
import { makeT } from "../../../src/apps/tui/tui-i18n.js";

const t = makeT("zh");
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

test("computeBottom: idle = separator + placeholder input + status", () => {
  const out = computeBottom(initialTuiState({}), t, 80);
  assert.equal(out.lines.length, 3);
  assert.match(strip(out.lines[0]), /^─+$/);
  assert.match(strip(out.lines[1]), /❯ .*输入消息/);
  assert.match(strip(out.lines[2]), /gated · - · idle/);
  assert.equal(out.cursorRow, 1);
  assert.equal(out.cursorCol, 4); // " ❯ " 宽 3,光标在第 4 列
});

test("computeBottom: cursor column counts CJK as 2", () => {
  const s = reduce(initialTuiState({}), { type: "input_insert", text: "中a" });
  const out = computeBottom(s, t, 80);
  assert.equal(out.cursorCol, 4 + 3); // 中=2 + a=1
});

test("computeBottom: approval replaces input line", () => {
  const s = reduce(initialTuiState({}), { type: "approval", approval: { id: "ap_1", summary: "x" } });
  const out = computeBottom(s, t, 80);
  // v1.13.1:提示行同时给出放行范围按键
  assert.match(strip(out.lines[1]), /审批:y 仅本次/);
  assert.equal(out.cursorCol, 1);
});

test("computeBottom: menu lines sit above input, selected marked", () => {
  const s = reduce(initialTuiState({}), {
    type: "menu",
    menu: { items: [{ name: "help", desc: "d1" }, { name: "quit", desc: "d2" }], index: 1 }
  });
  const out = computeBottom(s, t, 80);
  assert.equal(out.lines.length, 5);
  assert.match(strip(out.lines[1]), /\/help/);
  assert.match(strip(out.lines[2]), /\/quit/);
  assert.equal(out.cursorRow, 3);
});

test("computeBottom: stream preview shows tail lines while busy", () => {
  let s = reduce(initialTuiState({}), { type: "busy", busy: true });
  s = reduce(s, { type: "stream_delta", text: "l1\nl2\nl3\nl4" });
  const out = computeBottom(s, t, 80);
  const text = out.lines.map(strip).join("\n");
  assert.doesNotMatch(text, /l1/); // 只留尾部 3 行
  assert.match(text, /l2[\s\S]*l3[\s\S]*l4/);
});

test("computeBottom: overlay takes over between separator and status", () => {
  const s = reduce(initialTuiState({}), { type: "overlay", overlay: { lines: ["OV1", "OV2"], cursorRow: 1, cursorCol: 7 } });
  const out = computeBottom(s, t, 80);
  assert.deepEqual(out.lines.map(strip).slice(1, 3), ["OV1", "OV2"]);
  assert.equal(out.cursorRow, 2); // 分隔线偏移 +1
  assert.equal(out.cursorCol, 7);
});

test("painter emits climb/clear/append/park sequences", () => {
  const writes = [];
  const p = createPainter({ write: (s) => writes.push(s) });
  p.paint({ append: [], bottom: ["S", "I", "T"], cursorRow: 1, cursorCol: 4 });
  const first = writes.join("");
  assert.ok(first.includes("S\nI\nT"));
  assert.ok(first.endsWith("\x1b[1A\x1b[4G")); // 从末行(row2)上移到 row1、列 4
  writes.length = 0;
  p.paint({ append: ["H1"], bottom: ["S", "I", "T"], cursorRow: 1, cursorCol: 4 });
  const second = writes.join("");
  assert.ok(second.startsWith("\r\x1b[1A\x1b[J")); // 停靠行=1 → 上爬 1 行到区域顶再清屏
  assert.ok(second.includes("H1\n"));
  writes.length = 0;
  p.teardown();
  assert.ok(writes.join("").includes("\x1b[1B")); // 从停靠行下移到区域底再换行
});
