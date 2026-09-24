import test from "node:test";
import assert from "node:assert/strict";
import { initialTuiState, reduce, statusLine, formatTokens, deriveTps, SPINNER } from "../../../src/apps/tui/tui-state.js";
import { makeT } from "../../../src/apps/tui/tui-i18n.js";

const S = () => initialTuiState({});

test("input editing: insert at cursor, move, backspace", () => {
  let s = reduce(S(), { type: "input_insert", text: "ab" });
  s = reduce(s, { type: "input_left" });
  s = reduce(s, { type: "input_insert", text: "中" });
  assert.equal(s.input.text, "a中b");
  assert.equal(s.input.cursor, 2);
  s = reduce(s, { type: "input_backspace" });
  assert.equal(s.input.text, "ab");
  assert.equal(s.input.cursor, 1);
  s = reduce(s, { type: "input_end" });
  assert.equal(s.input.cursor, 2);
  s = reduce(s, { type: "input_home" });
  assert.equal(s.input.cursor, 0);
});

test("submit_local queues echo line, records history, clears input", () => {
  let s = reduce(S(), { type: "input_insert", text: "hi" });
  s = reduce(s, { type: "submit_local", line: " ❯ hi" });
  assert.deepEqual(s.pending, [" ❯ hi", ""]);
  assert.equal(s.input.text, "");
  assert.deepEqual(s.input.history, ["hi"]);
  assert.equal(s.input.hi, -1);
});

test("input history navigation preserves draft", () => {
  let s = S();
  for (const text of ["one", "two"]) {
    s = reduce(s, { type: "input_insert", text });
    s = reduce(s, { type: "submit_local", line: "x" });
  }
  s = reduce(s, { type: "input_insert", text: "draf" });
  s = reduce(s, { type: "input_hist_prev" });
  assert.equal(s.input.text, "two");
  s = reduce(s, { type: "input_hist_prev" });
  assert.equal(s.input.text, "one");
  s = reduce(s, { type: "input_hist_prev" }); // 顶端夹住
  assert.equal(s.input.text, "one");
  s = reduce(s, { type: "input_hist_next" });
  assert.equal(s.input.text, "two");
  s = reduce(s, { type: "input_hist_next" });
  assert.equal(s.input.text, "draf"); // 回到草稿
  assert.equal(s.input.hi, -1);
});

test("stream/push/flush lifecycle", () => {
  let s = reduce(S(), { type: "stream_delta", text: "he" });
  s = reduce(s, { type: "stream_delta", text: "llo" });
  assert.equal(s.stream, "hello");
  s = reduce(s, { type: "push", lines: ["a", "b"] });
  assert.deepEqual(s.pending, ["a", "b"]);
  s = reduce(s, { type: "flush", count: 1 });
  assert.deepEqual(s.pending, ["b"]);
  s = reduce(s, { type: "stream_clear" });
  assert.equal(s.stream, "");
});

test("approval/menu/overlay/mode/lang/hint/status/spin/exit", () => {
  let s = reduce(S(), { type: "approval", approval: { id: "ap_1", summary: "write file" } });
  assert.equal(s.approval.id, "ap_1");
  s = reduce(s, { type: "approval", approval: null });
  assert.equal(s.approval, null);
  s = reduce(s, { type: "menu", menu: { items: [{ name: "help", desc: "d" }], index: 0 } });
  s = reduce(s, { type: "menu_move", delta: 1 }); // 单项:回绕仍 0
  assert.equal(s.menu.index, 0);
  s = reduce(s, { type: "overlay", overlay: { lines: ["x"], cursorRow: null, cursorCol: null } });
  assert.deepEqual(s.overlay.lines, ["x"]);
  s = reduce(s, { type: "mode", mode: "auto" });
  s = reduce(s, { type: "lang", lang: "en" });
  s = reduce(s, { type: "hint", text: "h" });
  s = reduce(s, { type: "status", patch: { model: "deepseek-chat", tokens: 12400, cacheRate: 0.71 } });
  s = reduce(s, { type: "spin" });
  assert.equal(s.spin, 1);
  s = reduce(s, { type: "ctrlc_mark", now: 1000 });
  assert.equal(s.ctrlcAt, 1000);
  s = reduce(s, { type: "exit" });
  assert.equal(s.exit, true);
  assert.equal(s.mode, "auto");
  assert.equal(s.lang, "en");
});

test("statusLine composes mode/model/state/tokens/cache/lang", () => {
  let s = reduce(S(), { type: "status", patch: { state: "idle", model: "deepseek-chat", tokens: 12400, cacheRate: 0.714 } });
  const line = statusLine(s, makeT("zh"));
  assert.ok(line.includes("gated"));
  assert.ok(line.includes("deepseek-chat"));
  assert.ok(line.includes("tokens 12.4k"));
  assert.ok(line.includes("cache 71%"));
  assert.ok(line.includes("中文"));
  s = reduce(s, { type: "busy", busy: true });
  assert.ok(statusLine(s, makeT("zh")).includes(SPINNER[0]));
});

test("formatTokens", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(12400), "12.4k");
  assert.equal(formatTokens(3200000), "3.2m");
});

test("v1.9 M4 #11:statusLine hides reasoning/tps segments without data", () => {
  let s = reduce(S(), { type: "status", patch: { model: "deepseek-chat", tokens: 12400, cacheRate: 0.5 } });
  const line = statusLine(s, makeT("zh"));
  assert.ok(line.includes("tokens 12.4k"));
  assert.ok(line.includes("cache 50%"));
  assert.ok(!line.includes("r:")); // 无推理 tokens → 不出段
  assert.ok(!line.includes("tps")); // 无 tps → 不出段
  s = reduce(s, { type: "status", patch: { reasoningTokens: 0, tps: 0 } });
  assert.equal(statusLine(s, makeT("zh")), line); // 显式 0 与缺字段等价
  s = reduce(s, { type: "status", patch: { tps: 0.04 } });
  assert.ok(!statusLine(s, makeT("zh")).includes("tps")); // 四舍五入不到 0.1 视为无数据
});

test("v1.9 M4 #11:statusLine renders r: tok and tps segments when data present", () => {
  const s = reduce(S(), { type: "status", patch: { model: "deepseek-chat", tokens: 12400, reasoningTokens: 3200, tps: 42.35, cacheRate: 0.714 } });
  const line = statusLine(s, makeT("zh"));
  assert.ok(line.includes("tokens 12.4k"));
  assert.ok(line.includes("r:3.2k tok"));
  assert.ok(line.includes("42.4 tps")); // 保留 1 位小数
  assert.ok(line.includes("cache 71%")); // 既有 cache 段不受影响
  // 段序:reasoning/tps 紧挨 tokens,cache 保持原位
  assert.ok(line.indexOf("r:") > line.indexOf("tokens"));
  assert.ok(line.indexOf("tps") < line.indexOf("cache"));
});

test("v1.9 M4 #11:deriveTps uses per-request mean throughput, 0 on missing data", () => {
  assert.equal(deriveTps(), 0);
  assert.equal(deriveTps({}), 0);
  // 2 请求 × 平均 500ms = 1s 总时长,100 completion tokens → 100 tok/s
  assert.equal(deriveTps({ requests: 2, avg_latency_ms: 500, total_completion_tokens: 100 }), 100);
  assert.equal(deriveTps({ requests: 1, avg_latency_ms: 1000, total_completion_tokens: 33 }), 33);
  // 90 / (0.333s × 3) = 90.09… → 1 位小数
  assert.equal(deriveTps({ requests: 3, avg_latency_ms: 333, total_completion_tokens: 90 }), 90.1);
  // 缺 requests / 缺延迟 / 无 completion → 0(状态行即不渲染)
  assert.equal(deriveTps({ avg_latency_ms: 500, total_completion_tokens: 100 }), 0);
  assert.equal(deriveTps({ requests: 2, total_completion_tokens: 100 }), 0);
  assert.equal(deriveTps({ requests: 2, avg_latency_ms: 500 }), 0);
  assert.equal(deriveTps({ requests: 2, avg_latency_ms: 0, total_completion_tokens: 100 }), 0);
});

test("reducer is immutable and ignores unknown actions", () => {
  const s = S();
  const out = reduce(s, { type: "__nope__" });
  assert.equal(out, s);
  const after = reduce(s, { type: "input_insert", text: "x" });
  assert.notEqual(after, s);
  assert.equal(s.input.text, "");
});

test("status action with identical values is a no-op (same reference)", () => {
  const s = reduce(S(), { type: "status", patch: { state: "idle", tokens: 5 } });
  const again = reduce(s, { type: "status", patch: { state: "idle", tokens: 5 } });
  assert.equal(again, s);
  const changed = reduce(s, { type: "status", patch: { tokens: 6 } });
  assert.notEqual(changed, s);
});
