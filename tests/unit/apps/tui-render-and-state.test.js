// tests/unit/apps/tui-render-and-state.test.js — TUI 渲染与状态(状态机/绘制/ANSI/输入/事件卡/i18n/主题)领域测试
//
// v1.19.1 测试归并:本文件由下列历史任务单测试合并而成,每个来源包裹在独立
// describe 块中(异步回调 + 动态 import,来源间零共享绑定),测试语义与拆分前一致。
import { describe } from "node:test";

// ---------------------------------------------------------------------------
// 来源:tests/unit/tui/tui-state.test.js
// ---------------------------------------------------------------------------
describe("unit/tui/tui-state", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { initialTuiState, reduce, statusLine, formatTokens, deriveTps, SPINNER } = await import("../../../src/apps/tui/tui-state.js");
  const { makeT } = await import("../../../src/apps/tui/tui-i18n.js");

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
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/tui/paint.test.js
// ---------------------------------------------------------------------------
describe("unit/tui/paint", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { computeBottom, createPainter } = await import("../../../src/apps/tui/paint.js");
  const { initialTuiState, reduce } = await import("../../../src/apps/tui/tui-state.js");
  const { makeT } = await import("../../../src/apps/tui/tui-i18n.js");

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
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/tui/ansi.test.js
// ---------------------------------------------------------------------------
describe("unit/tui/ansi", async () => {
  // tests/unit/tui/ansi.test.js


  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { seq, displayWidth, truncateToWidth, padToWidth } = await import("../../../src/apps/tui/ansi.js");

  test("seq builders emit VT sequences", () => {
    assert.equal(seq.up(3), "\x1b[3A");
    assert.equal(seq.up(0), "");
    assert.equal(seq.down(2), "\x1b[2B");
    assert.equal(seq.col(5), "\x1b[5G");
    assert.equal(seq.clearDown, "\x1b[J");
    assert.equal(seq.pasteOn, "\x1b[?2004h");
    assert.equal(seq.pasteOff, "\x1b[?2004l");
  });

  test("displayWidth counts CJK as 2 columns", () => {
    assert.equal(displayWidth("abc"), 3);
    assert.equal(displayWidth("中文"), 4);
    assert.equal(displayWidth("a中b"), 4);
    assert.equal(displayWidth(""), 0);
  });

  test("truncateToWidth cuts by display width", () => {
    assert.equal(truncateToWidth("hello", 10), "hello");
    assert.equal(truncateToWidth("hello", 4), "hell");
    assert.equal(truncateToWidth("中文字", 4), "中文");
    assert.equal(truncateToWidth("中文字", 5), "中文"); // 半列放不下宽字符
  });

  test("padToWidth pads with spaces to target width", () => {
    assert.equal(padToWidth("ab", 4), "ab  ");
    assert.equal(padToWidth("中", 4), "中  ");
    assert.equal(padToWidth("abcde", 3), "abcde"); // 不截断,只负责补
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/tui/input.test.js
// ---------------------------------------------------------------------------
describe("unit/tui/input", async () => {
  // tests/unit/tui/input.test.js


  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createKeyDecoder } = await import("../../../src/apps/tui/input.js");

  test("printable runs coalesce into one char event (incl. CJK)", () => {
    const d = createKeyDecoder();
    assert.deepEqual(d.feed("ab中"), [{ type: "char", text: "ab中" }]);
  });

  test("control keys decode", () => {
    const d = createKeyDecoder();
    assert.deepEqual(d.feed("\r"), [{ type: "enter" }]);
    assert.deepEqual(d.feed("\x7f"), [{ type: "backspace" }]);
    assert.deepEqual(d.feed("\t"), [{ type: "tab" }]);
    assert.deepEqual(d.feed("\x03"), [{ type: "ctrl_c" }]);
  });

  test("CSI arrows/home/end decode; unknown CSI dropped", () => {
    const d = createKeyDecoder();
    assert.deepEqual(d.feed("\x1b[A\x1b[B\x1b[C\x1b[D"), [
      { type: "up" }, { type: "down" }, { type: "right" }, { type: "left" }
    ]);
    assert.deepEqual(d.feed("\x1b[H"), [{ type: "home" }]);
    assert.deepEqual(d.feed("\x1b[F"), [{ type: "end" }]);
    assert.deepEqual(d.feed("\x1b[1~"), [{ type: "home" }]);
    assert.deepEqual(d.feed("\x1b[4~"), [{ type: "end" }]);
    assert.deepEqual(d.feed("\x1b[5~"), []); // PgUp 未映射,丢弃
  });

  test("escape sequence split across chunks buffers", () => {
    const d = createKeyDecoder();
    assert.deepEqual(d.feed("\x1b"), []);
    assert.deepEqual(d.feed("[A"), [{ type: "up" }]);
  });

  test("lone ESC followed by printable yields esc + char", () => {
    const d = createKeyDecoder();
    assert.deepEqual(d.feed("\x1bx"), [{ type: "esc" }, { type: "char", text: "x" }]);
  });

  test("SS3 sequence split across chunks buffers", () => {
    const d = createKeyDecoder();
    assert.deepEqual(d.feed("\x1bO"), []);
    assert.deepEqual(d.feed("A"), [{ type: "up" }]);
  });

  test("unknown complete SS3 dropped silently", () => {
    const d = createKeyDecoder();
    assert.deepEqual(d.feed("\x1bOPx"), [{ type: "char", text: "x" }]);
  });

  test("paste terminator split mid-sequence reassembles", () => {
    const d = createKeyDecoder();
    assert.deepEqual(d.feed("\x1b[200~ab\x1b[20"), []);
    assert.deepEqual(d.feed("1~c"), [{ type: "paste", text: "ab" }, { type: "char", text: "c" }]);
  });

  test("bracketed paste accumulates across chunks", () => {
    const d = createKeyDecoder();
    assert.deepEqual(d.feed("\x1b[200~he"), []);
    assert.deepEqual(d.feed("llo\nwo"), []);
    assert.deepEqual(d.feed("rld\x1b[201~z"), [
      { type: "paste", text: "hello\nworld" },
      { type: "char", text: "z" }
    ]);
  });

  test("flush disambiguates pending lone ESC", () => {
    const d = createKeyDecoder();
    assert.deepEqual(d.feed("\x1b"), []);
    assert.equal(d.hasPending(), true);
    assert.deepEqual(d.flush(), [{ type: "esc" }]);
    assert.equal(d.hasPending(), false);
    assert.deepEqual(d.flush(), []);
  });

  test("pending split CSI still completes when continuation arrives", () => {
    const d = createKeyDecoder();
    assert.deepEqual(d.feed("\x1b"), []);
    assert.deepEqual(d.feed("[A"), [{ type: "up" }]);
    assert.equal(d.hasPending(), false);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/tui/slash.test.js
// ---------------------------------------------------------------------------
describe("unit/tui/slash", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { SLASH_COMMANDS, filterCommands, parseSlash } = await import("../../../src/apps/tui/slash.js");

  test("registry holds the command set", () => {
    assert.deepEqual(SLASH_COMMANDS.map((c) => c.name),
      ["help", "config", "diff", "changes", "mode", "lang", "theme", "shell", "clear", "recovery", "branch", "rewind", "fim", "mcp", "quit"]);
    for (const c of SLASH_COMMANDS) assert.match(c.descKey, /^slash\./);
  });

  test("filterCommands prefix-matches", () => {
    assert.deepEqual(filterCommands("").map((c) => c.name), SLASH_COMMANDS.map((c) => c.name));
    assert.deepEqual(filterCommands("c").map((c) => c.name), ["config", "changes", "clear"]);
    assert.deepEqual(filterCommands("zzz"), []);
  });

  test("parseSlash splits name and arg", () => {
    assert.deepEqual(parseSlash("/mode auto"), { name: "mode", arg: "auto" });
    assert.deepEqual(parseSlash("/help"), { name: "help", arg: "" });
    assert.deepEqual(parseSlash("/recovery resume x1"), { name: "recovery", arg: "resume x1" });
    assert.equal(parseSlash("hello"), null);
    assert.equal(parseSlash("/"), null);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/tui/event-cards.test.js
// ---------------------------------------------------------------------------
describe("unit/tui/event-cards", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { QUIET, eventToLines } = await import("../../../src/apps/tui/event-cards.js");
  const { makeT } = await import("../../../src/apps/tui/tui-i18n.js");

  const t = makeT("zh");
  const strip = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
  const flat = (ev) => eventToLines(ev, t).map(strip).join("\n");

  test("noisy events are quiet", () => {
    for (const type of ["model:request", "model:response", "agent:step", "agent:turn_started", "user:message", "agent:final", "agent:error"]) {
      assert.ok(QUIET.has(type), type);
    }
  });

  test("tool call/result render as paired lines", () => {
    assert.match(flat({ type: "tool:call", call: { name: "edit", args: { path: "src/a.js" } } }), /┌ tool ▸ edit.*src\/a\.js/);
    assert.match(flat({ type: "tool:result", result: { status: "ok" } }), /└ ok/);
    assert.match(flat({ type: "tool:result", result: { status: "error" } }), /└ error/);
  });

  test("diff applied renders per-file card", () => {
    const out = flat({
      type: "file:diff_applied",
      change_id: "chg_1",
      files: [{ path: "src/a.js", status: "M", added: 2, removed: 1 }]
    });
    assert.match(out, /┌─ diff · chg_1/);
    assert.match(out, /│ M src\/a\.js \+2 −1/);
    assert.match(out, /└─/);
  });

  test("diff applied falls back to summary array and unknown counts", () => {
    const out = flat({ type: "file:diff_applied", change_id: "chg_2", summary: [{ path: "b.js" }] });
    assert.match(out, /│ M b\.js/);
    assert.doesNotMatch(out, /undefined|NaN/);
  });

  test("approval request renders summary card", () => {
    const out = flat({ type: "approval:requested", approval: { id: "ap_1", summary: "write src/a.js" } });
    assert.match(out, /需要审批/);
    assert.match(out, /write src\/a\.js/);
  });

  test("misc one-liners", () => {
    assert.match(flat({ type: "file:rollback_applied", change_id: "chg_1" }), /已回退 chg_1/);
    assert.match(flat({ type: "verification:result", result: { status: "pass" } }), /验证 pass/);
    assert.match(flat({ type: "orchestration:route_resolved", lane: "single" }), /路由 ▸ single/);
    assert.match(flat({ type: "orchestration:worker_started", worker: "w1" }), /orch ▸ worker_started/);
    assert.match(flat({ type: "recovery:blocked", reason: "orphan", item_id: "x1" }), /恢复 blocked orphan x1/);
    assert.match(flat({ type: "some:new_thing" }), /· some:new_thing/);
  });

  test("orchestration subtask start/review render distinct cards", () => {
    assert.match(flat({ type: "orchestration:subtask_started", subtask_id: "s1", attempt: 1, tool_profile: "edit" }), /子任务 s1/);
    assert.match(flat({ type: "orchestration:subtask_reviewed", subtask_id: "s1", pass: true }), /审核.*通过/);
    assert.match(flat({ type: "orchestration:subtask_reviewed", subtask_id: "s1", pass: false, severity: "high" }), /审核.*未通过/);
  });

  test("orchestration planned/round/replanned render meaningful summaries", () => {
    assert.match(flat({ type: "orchestration:planned", subtasks: 3 }), /orch ▸ planned/);
    assert.match(flat({ type: "orchestration:round_started", round: 2, subtasks: 4 }), /orch ▸ round_started/);
    assert.match(flat({ type: "orchestration:replanned", round: 3, new_subtasks: 2 }), /orch ▸ replanned/);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/tui/tui-i18n.test.js
// ---------------------------------------------------------------------------
describe("unit/tui/tui-i18n", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { STRINGS, makeT } = await import("../../../src/apps/tui/tui-i18n.js");

  test("zh/en dictionaries expose identical key sets", () => {
    assert.deepEqual(Object.keys(STRINGS.zh).sort(), Object.keys(STRINGS.en).sort());
  });

  test("t interpolates and falls back", () => {
    const t = makeT("zh");
    assert.equal(t("msg.modeSet", { mode: "auto" }), "模式:auto");
    assert.equal(makeT("en")("msg.modeSet", { mode: "auto" }), "mode: auto");
    assert.equal(t("__nope__"), "__nope__");
  });

  test("unknown lang falls back to zh dictionary", () => {
    assert.equal(makeT("fr")("status.lang"), "中文");
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/apps/tui-theme-palette.test.js
// ---------------------------------------------------------------------------
describe("unit/apps/tui-theme-palette", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { hexToXterm } = await import("../../../scripts/gen-tui-theme.js");
  const { TUI_THEMES, DEFAULT_TUI_THEME } = await import("../../../src/apps/tui/theme-palette.js");

  const SLOTS = ["bg", "panel", "fg", "mut", "faint", "border", "accent", "accentHover", "ok", "warn", "err", "info"];

  test("TUI 调色板:10 主题 × 全部槽位非空且色号在 16–255", () => {
    const ids = Object.keys(TUI_THEMES);
    assert.equal(ids.length, 10, `期望 10 主题,实得 ${ids.length}`);
    for (const id of ids) {
      const theme = TUI_THEMES[id];
      assert.ok(theme.id === id && typeof theme.name === "string" && theme.name.length > 0);
      for (const slot of SLOTS) {
        assert.ok(slot in theme, `主题 ${id} 缺槽位 ${slot}`);
        const idx = theme[slot];
        assert.ok(Number.isInteger(idx), `主题 ${id} ${slot} 非整数:${idx}`);
        assert.ok(idx >= 16 && idx <= 255, `主题 ${id} ${slot} 色号越界:${idx}`);
      }
    }
  });

  test("默认主题为 sumi(墨)", () => {
    assert.equal(DEFAULT_TUI_THEME, "sumi");
    assert.ok(DEFAULT_TUI_THEME in TUI_THEMES);
  });

  test("hexToXterm:灰阶与色立方映射边界", () => {
    assert.equal(hexToXterm("#000000"), 16);   // 纯黑 → 16
    assert.equal(hexToXterm("#ffffff"), 231);  // 纯白 → 231(灰阶带末端)
    assert.equal(hexToXterm("#808080"), 244);  // 中灰 → 244(128→(128-8)/10=12→232+12=244)
    // 色立方:纯红 #ff0000 → R=255,G=0,B=0 → 16 + 36*5 + 6*0 + 0 = 196
    assert.equal(hexToXterm("#ff0000"), 196);
    assert.equal(hexToXterm("#00ff00"), 46);   // 纯绿 → 16 + 36*0 + 6*5 + 0 = 46
    assert.equal(hexToXterm("#0000ff"), 21);   // 纯蓝 → 16 + 36*0 + 6*0 + 5 = 21
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/apps/tui-theme-palette-sync.test.js
// ---------------------------------------------------------------------------
describe("unit/apps/tui-theme-palette-sync", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { readFileSync } = await import("node:fs");
  const { buildPaletteBody } = await import("../../../scripts/gen-tui-theme.js");

  const tokens = readFileSync(new URL("../../../gui/src/styles/tokens.css", import.meta.url), "utf8");
  const paletteUrl = new URL("../../../src/apps/tui/theme-palette.js", import.meta.url);

  // v1.8.3 C1:生成物入库契约必须可自证 —— 曾出现 tokens 改了(paper warn #ad8301)
  // 却没重跑生成器,导致 TUI 主题色与 GUI 不一致,且既有测试抓不到。
  test("theme-palette.js 必须与 tokens.css 的生成结果逐字节一致(不得手改/不得滞后)", () => {
    const expected = buildPaletteBody(tokens);
    const actual = readFileSync(paletteUrl, "utf8");
    if (actual !== expected) {
      const firstDiff = [...expected].findIndex((ch, i) => ch !== actual[i]);
      const ctx = (s) => s.slice(Math.max(0, firstDiff - 60), firstDiff + 60).replace(/\n/g, "\\n");
      assert.fail(`theme-palette.js 已过期(首个差异 @${firstDiff})\n  期望: …${ctx(expected)}…\n  实得: …${ctx(actual)}…\n  修复:node scripts/gen-tui-theme.js`);
    }
  });

  test("buildPaletteBody 契约:主题数不为 10 或缺槽位时抛错", () => {
    assert.throws(() => buildPaletteBody('[theme="sumi"] { --bg-base: #000000; }'), /10 主题/);
    const nine = Array.from({ length: 9 }, (_, i) => `[theme="t${i}"] { --bg-base:#000000; }`).join("\n");
    assert.throws(() => buildPaletteBody(nine), /10 主题/);
    const tenBad = Array.from({ length: 10 }, (_, i) => `[theme="t${i}"] { --bg-base:#000000; }`).join("\n");
    assert.throws(() => buildPaletteBody(tenBad), /缺/);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/apps/tui/sensitive-notice.test.js
// ---------------------------------------------------------------------------
describe("unit/apps/tui/sensitive-notice", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { initialTuiState, reduce } = await import("../../../src/apps/tui/tui-state.js");
  const { computeBottom } = await import("../../../src/apps/tui/paint.js");
  const { makeT } = await import("../../../src/apps/tui/tui-i18n.js");

  const t = makeT("zh");
  const NOTICE = {
    kind: "sensitive-file-write",
    severity: "danger",
    paths: [{ path: ".env", reason: "secret-file", reasonKey: "sensitive.reason.secret" }],
    recordDir: ".deepseek-code/changes",
    count: 1
  };

  test("sensitive_notice is a state field distinct from approval", () => {
    const base = initialTuiState({});
    assert.equal(base.sensitiveNotice, null);

    const withNotice = reduce(base, { type: "sensitive_notice", notice: NOTICE });
    assert.deepEqual(withNotice.sensitiveNotice, NOTICE);
    // 关键:不得污染 approval 态 —— 它不是审批
    assert.equal(withNotice.approval, null, "敏感提醒不得写进 approval 态");

    const cleared = reduce(withNotice, { type: "sensitive_notice", notice: null });
    assert.equal(cleared.sensitiveNotice, null);
  });

  test("approval and sensitive notice do not overwrite each other", () => {
    let s = initialTuiState({});
    s = reduce(s, { type: "approval", approval: { id: "ap1" } });
    s = reduce(s, { type: "sensitive_notice", notice: NOTICE });
    assert.equal(s.approval.id, "ap1");
    assert.equal(s.sensitiveNotice.count, 1);
    // 清掉提醒不应影响审批
    s = reduce(s, { type: "sensitive_notice", notice: null });
    assert.equal(s.approval.id, "ap1");
  });

  // 注:TUI 颜色在非 TTY 下按设计降级(theme.js 的 supportsColor),且用 256 色
  // 序列。断言 ANSI 码等于在测运行环境而非测代码,故这里断言**文本内容** ——
  // 底部行用的是哪个 i18n key,才是环境无关的真实行为。
  test("bottom input line shows the sensitive prompt and takes priority over approval", () => {
    let s = initialTuiState({});
    s = reduce(s, { type: "approval", approval: { id: "ap1" } });
    s = reduce(s, { type: "sensitive_notice", notice: NOTICE });

    const bottom = computeBottom(s, t, 80);
    const inputLine = bottom.lines[bottom.lines.length - 2];
    assert.match(inputLine, /敏感文件/, "应渲染 input.sensitive");
    assert.doesNotMatch(inputLine, /^ 审批/, "不得退化成普通审批提示");
  });

  test("approval line is unchanged when no sensitive notice is pending", () => {
    let s = initialTuiState({});
    s = reduce(s, { type: "approval", approval: { id: "ap1" } });
    const bottom = computeBottom(s, t, 80);
    const inputLine = bottom.lines[bottom.lines.length - 2];
    assert.match(inputLine, /审批/, "普通审批提示不受本片影响");
    assert.doesNotMatch(inputLine, /敏感文件/);
  });

  test("zh and en both provide every sensitive-notice key", () => {
    const keys = [
      "input.sensitive", "sensitive.title", "sensitive.body",
      "sensitive.reason.secret", "sensitive.reason.credential", "sensitive.reason.other"
    ];
    for (const lang of ["zh", "en"]) {
      const tr = makeT(lang);
      for (const k of keys) assert.notEqual(tr(k), k, `${lang} 缺 ${k}`);
    }
  });
});
