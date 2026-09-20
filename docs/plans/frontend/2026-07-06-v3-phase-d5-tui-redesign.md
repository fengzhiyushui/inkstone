# V3 Phase D-5 · TUI 重设计实施计划(行内滚动流 agent 会话 TUI)

> 完成状态以 [CHANGELOG](../../CHANGELOG.md) 为准。


**Goal:** 把 `src/tui.js` 菜单循环整体重写为 claude code 式行内滚动流 agent 会话 TUI(流式输出/工具与 diff 卡片/审批/slash 命令/与 GUI 共享的 API 列表管理),零运行时依赖、zh/en 双语默认中文。

**Architecture:** 纯逻辑(reducer/派生/解码/序列构造)+ 薄 IO(painter/组合根)分层,全部纯层 node:test;`tui-app` 接受可注入 `{input, output}` 流与 mock kernel 做全链路测试,不依赖真 pty。历史消息 println 进终端原生滚动区,仅底部(分隔线/菜单/输入行/状态栏)为固定重绘区。

**Tech Stack:** Node ≥20 原生(ESM、node:test、ANSI/VT 序列);无任何新依赖。

**Spec:** `docs/specs/frontend/2026-07-06-v3-phase-d5-tui-redesign-design.md`

## Global Constraints

1. **零新增依赖**:dependencies/devDependencies 一律不加;门控 smoke 只复用 `gui/node_modules` 已有的 node-pty,没装优雅 skip。
2. **kernel 核心 `src/` diff 为空**;例外仅:`src/apps/**`(新增/改动)与 `src/tui.js`(薄入口重写)。`gui/` 只允许动 `kernel-host.js` 的 api-profiles/listModels 接线与删除 `gui/api-profiles.js`。
3. **`runTui(root, kernel = null)` 对外签名不变**;`deepseek-code tui` 入口行为不变(cli.js 不改)。
4. **双语文案全部走 `tui-i18n.js`**,组件内禁止硬编码中英文文案(边框/图标字符除外)。
5. **密钥明文只落 `.deepseek-code/`**;渲染路径(滚动区/状态栏/卡片/输入回显)只出现掩码;密钥不进对话 history。
6. **任何退出路径恢复终端态**(cooked mode、显示光标、颜色复位、关闭括号粘贴)。
7. **git 提交不加任何 Co-Authored-By trailer**(现行署名规则)。
8. 每个 Task:先写失败测试 → 跑红 → 最小实现 → 跑绿 → 提交;全量回归用 `npm test`(当前基线 847 全绿)与 `npm run check`。

## 文件地图

```
src/apps/tui/                  ← 全部新建
  ansi.js          转义序列构造 + 显示宽度(CJK=2)          纯
  input.js         字节流→按键事件解码(含括号粘贴/CSI)      纯
  tui-i18n.js      zh/en 字典 + makeT                      纯
  tui-state.js     reducer + statusLine 派生               纯
  event-cards.js   kernel 事件→卡片行(QUIET 静默集)         纯
  paint.js         computeBottom + createPainter           薄 IO
  slash.js         命令注册/解析/过滤                       纯
  prefs.js         tui-prefs.json 原子读写                  薄 IO
  config-flow.js   /config 状态机 + renderConfigLines       纯
  tui-app.js       组合根(kernel 接线/按键路由/重绘调度)     组合根
src/apps/api-profiles.js       ← gui/api-profiles.js ESM 化迁入(+maskKey)
src/apps/model-catalog.js      ← listModels 的 fetch 抽取(fetchImpl 可注入)
src/tui.js                     ← 重写为薄入口(runTui)
gui/kernel-host.js             ← api-profiles/listModels 改动态 import 共享模块
gui/api-profiles.js            ← 删除
tests/unit/tui/*.test.js       ← 新测试
tests/unit/gui/api-profiles.test.js  ← import 路径随迁移更新
tests/unit/apps/tui-metrics.test.js  ← 删除(statusLine 测试并入 tui-state)
tests/integration/v2-interface-boundary.test.js  ← tui 断言更新
tests/e2e/tui-smoke.test.js    ← 门控 pty smoke
package.json                   ← check 脚本增删条目
```

里程碑映射:M1→T1–T4 · M2→T5 · M3→T6 · M4→T7–T8 · M5→T9 · M6→T10–T13 · M7→T14–T15。

---

## Milestone M1 — 纯基建

### Task 1: `ansi.js` 转义序列 + 显示宽度

**Files:**
- Create: `src/apps/tui/ansi.js`
- Test: `tests/unit/tui/ansi.test.js`

**Interfaces:**
- Produces: `seq`(hideCursor/showCursor/pasteOn/pasteOff/clearDown/up(n)/down(n)/col(n))、`displayWidth(text) → number`、`truncateToWidth(text, max) → string`、`padToWidth(text, width) → string`。后续 T4/T6/T12 直接 import。

- [ ] **Step 1: 写失败测试**

```js
// tests/unit/tui/ansi.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { seq, displayWidth, truncateToWidth, padToWidth } from "../../../src/apps/tui/ansi.js";

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
```

- [ ] **Step 2: 跑红**

Run: `node --test tests/unit/tui/ansi.test.js`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 最小实现**

```js
// src/apps/tui/ansi.js — VT 序列构造与显示宽度(零依赖,纯函数)。
export const seq = {
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
  pasteOn: "\x1b[?2004h",
  pasteOff: "\x1b[?2004l",
  clearDown: "\x1b[J",
  clearLine: "\x1b[2K",
  reset: "\x1b[0m",
  up: (n) => (n > 0 ? `\x1b[${n}A` : ""),
  down: (n) => (n > 0 ? `\x1b[${n}B` : ""),
  col: (n) => `\x1b[${n}G`
};

// CJK/全角近似:这些区间记 2 列,其余 1 列(控制字符不应出现在渲染文本里)。
function charWidth(code) {
  if (
    (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
    (code >= 0x2e80 && code <= 0xa4cf) || // CJK 部首~Yi
    (code >= 0xac00 && code <= 0xd7a3) || // Hangul 音节
    (code >= 0xf900 && code <= 0xfaff) || // CJK 兼容表意
    (code >= 0xfe30 && code <= 0xfe4f) || // CJK 兼容形式
    (code >= 0xff00 && code <= 0xff60) || // 全角形式
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x3fffd)  // CJK 扩展 B+
  ) return 2;
  return 1;
}

export function displayWidth(text) {
  let width = 0;
  for (const ch of String(text || "")) width += charWidth(ch.codePointAt(0));
  return width;
}

export function truncateToWidth(text, max) {
  let width = 0;
  let out = "";
  for (const ch of String(text || "")) {
    const w = charWidth(ch.codePointAt(0));
    if (width + w > max) break;
    width += w;
    out += ch;
  }
  return out;
}

export function padToWidth(text, width) {
  const value = String(text || "");
  const pad = width - displayWidth(value);
  return pad > 0 ? value + " ".repeat(pad) : value;
}
```

- [ ] **Step 4: 跑绿**

Run: `node --test tests/unit/tui/ansi.test.js`
Expected: PASS(4 tests)

- [ ] **Step 5: 提交**

```bash
git add src/apps/tui/ansi.js tests/unit/tui/ansi.test.js
git commit -m "feat(tui): ansi sequence builders + CJK display width (D5-M1)"
```

### Task 2: `input.js` 按键解码器

**Files:**
- Create: `src/apps/tui/input.js`
- Test: `tests/unit/tui/input.test.js`

**Interfaces:**
- Produces: `createKeyDecoder() → { feed(chunk: string) → Event[] }`。Event 为:`{type:"char", text}` `{type:"paste", text}` 与无载荷的 `{type:"enter"|"backspace"|"left"|"right"|"up"|"down"|"home"|"end"|"tab"|"esc"|"ctrl_c"}`。跨 chunk 的不完整转义序列内部缓冲;未识别 CSI 静默丢弃。T7 消费。

- [ ] **Step 1: 写失败测试**

```js
// tests/unit/tui/input.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { createKeyDecoder } from "../../../src/apps/tui/input.js";

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

test("bracketed paste accumulates across chunks", () => {
  const d = createKeyDecoder();
  assert.deepEqual(d.feed("\x1b[200~he"), []);
  assert.deepEqual(d.feed("llo\nwo"), []);
  assert.deepEqual(d.feed("rld\x1b[201~z"), [
    { type: "paste", text: "hello\nworld" },
    { type: "char", text: "z" }
  ]);
});
```

- [ ] **Step 2: 跑红**

Run: `node --test tests/unit/tui/input.test.js`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 最小实现**

```js
// src/apps/tui/input.js — 原始输入(utf8 字符串)→ 按键事件。跨 chunk 缓冲不完整转义。
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

const CSI_FINAL = {
  A: "up", B: "down", C: "right", D: "left", H: "home", F: "end"
};
const CSI_TILDE = { 1: "home", 4: "end", 7: "home", 8: "end" };

export function createKeyDecoder() {
  let pending = "";   // 不完整的转义序列尾巴
  let pasting = false;
  let pasteBuf = "";

  function feed(chunk) {
    let data = pending + String(chunk || "");
    pending = "";
    const events = [];
    let chars = "";
    const flushChars = () => {
      if (chars) { events.push({ type: "char", text: chars }); chars = ""; }
    };

    let i = 0;
    while (i < data.length) {
      if (pasting) {
        const end = data.indexOf(PASTE_END, i);
        if (end === -1) {
          // 结束符可能被截断在 chunk 边界:保留可疑尾巴
          const keep = Math.max(i, data.length - (PASTE_END.length - 1));
          pasteBuf += data.slice(i, keep);
          pending = data.slice(keep);
          return events;
        }
        pasteBuf += data.slice(i, end);
        events.push({ type: "paste", text: pasteBuf });
        pasteBuf = "";
        pasting = false;
        i = end + PASTE_END.length;
        continue;
      }
      const ch = data[i];
      if (ch === "\x1b") {
        flushChars();
        if (data.startsWith(PASTE_START, i)) { pasting = true; i += PASTE_START.length; continue; }
        const next = data[i + 1];
        if (next === undefined) {
          // 可能是被截断的序列开头,也可能是孤立 ESC:留到下一次 feed 判定
          pending = data.slice(i);
          return events;
        }
        if (next === "[") {
          // CSI: \x1b [ 参数字节* 终止字节(@-~)
          let j = i + 2;
          while (j < data.length && !(data[j] >= "@" && data[j] <= "~")) j += 1;
          if (j >= data.length) {
            if (data.startsWith(PASTE_START.slice(0, data.length - i), i)) { pending = data.slice(i); return events; }
            pending = data.slice(i); return events;
          }
          const params = data.slice(i + 2, j);
          const final = data[j];
          if (final === "~" && CSI_TILDE[params]) events.push({ type: CSI_TILDE[params] });
          else if (CSI_FINAL[final] && (params === "" || params === "1")) events.push({ type: CSI_FINAL[final] });
          // 其余 CSI(含鼠标/PgUp 等)静默丢弃
          i = j + 1;
          continue;
        }
        if (next === "O" && CSI_FINAL[data[i + 2]]) { // SS3 变体
          events.push({ type: CSI_FINAL[data[i + 2]] });
          i += 3;
          continue;
        }
        events.push({ type: "esc" });
        i += 1;
        continue;
      }
      if (ch === "\r" || ch === "\n") { flushChars(); events.push({ type: "enter" }); i += 1; continue; }
      if (ch === "\x7f" || ch === "\x08") { flushChars(); events.push({ type: "backspace" }); i += 1; continue; }
      if (ch === "\t") { flushChars(); events.push({ type: "tab" }); i += 1; continue; }
      if (ch === "\x03") { flushChars(); events.push({ type: "ctrl_c" }); i += 1; continue; }
      if (ch < " ") { i += 1; continue; } // 其余控制字符丢弃
      chars += ch;
      i += 1;
    }
    flushChars();
    return events;
  }

  return { feed };
}
```

- [ ] **Step 4: 跑绿**

Run: `node --test tests/unit/tui/input.test.js`
Expected: PASS(6 tests)

- [ ] **Step 5: 提交**

```bash
git add src/apps/tui/input.js tests/unit/tui/input.test.js
git commit -m "feat(tui): raw key decoder with CSI + bracketed paste (D5-M1)"
```

### Task 3: `tui-i18n.js` 双语字典

**Files:**
- Create: `src/apps/tui/tui-i18n.js`
- Test: `tests/unit/tui/tui-i18n.test.js`

**Interfaces:**
- Produces: `STRINGS`(zh/en 两套 key→string)、`makeT(lang) → t(key, vars?) → string`(`{x}` 插值;缺 key 回落 en 再回落 key)。全部后续 Task 消费;**文案 key 一旦在此定义,后续 Task 不得内联中英文**。

- [ ] **Step 1: 写失败测试**

```js
// tests/unit/tui/tui-i18n.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { STRINGS, makeT } from "../../../src/apps/tui/tui-i18n.js";

test("zh/en dictionaries expose identical key sets", () => {
  assert.deepEqual(Object.keys(STRINGS.zh).sort(), Object.keys(STRINGS.en).sort());
});

test("t interpolates and falls back", () => {
  const t = makeT("zh");
  assert.equal(t("msg.modeSet", { mode: "auto" }), "模式:auto");
  assert.equal(makeT("en")("msg.modeSet", { mode: "auto" }), "mode: auto");
  assert.equal(t("__nope__"), "__nope__");
});
```

- [ ] **Step 2: 跑红**

Run: `node --test tests/unit/tui/tui-i18n.test.js`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 最小实现**

```js
// src/apps/tui/tui-i18n.js — TUI 双语文案。仅门面双语策略的 TUI 侧字典。
export const STRINGS = {
  zh: {
    "input.placeholder": "输入消息,/ 呼出命令",
    "input.approval": "审批:y 批准 · n 拒绝 · Esc 拒绝",
    "hint.ctrlc": "再按一次 Ctrl+C 退出",
    "hint.busy": "回合运行中,等待完成…",
    "status.lang": "中文",
    "banner.ready": "DeepSeek Code TUI — 就绪(/help 查看命令)",
    "banner.offline": "内核不可用(未配置密钥?),仅 /config /help 可用",
    "ev.toolOk": "ok",
    "ev.approvalTitle": "需要审批",
    "ev.done": "已完成",
    "ev.error": "错误",
    "ev.rollback": "已回退",
    "ev.verify": "验证",
    "ev.repair": "修复",
    "ev.route": "路由",
    "ev.recovery": "恢复",
    "msg.modeSet": "模式:{mode}",
    "msg.modeInvalid": "模式必须是 read-only / gated / auto",
    "msg.cleared": "已清空会话上下文",
    "msg.langSet": "界面语言:中文",
    "msg.noDiff": "没有可显示的 Git 差异",
    "msg.noChanges": "还没有修改记录",
    "msg.unknownSlash": "未知命令:/{name}(/help 查看命令)",
    "msg.sendFailed": "发送失败:{err}",
    "slash.help.desc": "命令帮助",
    "slash.config.desc": "管理 API 配置(增/删/改/激活/拉模型/测试)",
    "slash.diff.desc": "查看工作区 Git 差异",
    "slash.changes.desc": "查看最近修改记录",
    "slash.mode.desc": "切换 autonomy:read-only/gated/auto",
    "slash.lang.desc": "切换界面语言 zh/en",
    "slash.clear.desc": "清空会话上下文",
    "slash.recovery.desc": "恢复中心:列表/resume/cancel",
    "slash.quit.desc": "退出 TUI",
    "cfg.title": "API 配置(Enter 选择,Esc 返回)",
    "cfg.empty": "暂无配置,选「新增」创建",
    "cfg.new": "+ 新增配置",
    "cfg.active": "●已激活",
    "cfg.act.activate": "激活",
    "cfg.act.edit": "编辑",
    "cfg.act.models": "拉取模型列表",
    "cfg.act.test": "连接测试",
    "cfg.act.delete": "删除",
    "cfg.field.name": "名称",
    "cfg.field.baseUrl": "接口地址",
    "cfg.field.apiKey": "API 密钥(输入以掩码显示)",
    "cfg.field.model": "模型(可 /config 拉取后选择)",
    "cfg.editHint": "Enter 下一项,最后一项 Enter 保存;Esc 取消",
    "cfg.saved": "配置已保存:{name}",
    "cfg.deleted": "配置已删除",
    "cfg.activated": "已激活:{name}(内核已按新配置重建,会话上下文保留)",
    "cfg.testOk": "连接测试通过",
    "cfg.testFail": "连接测试失败:{err}",
    "cfg.modelsTitle": "选择模型(Enter 选定,Esc 返回)",
    "cfg.modelsFail": "模型拉取失败:{err}",
    "cfg.modelsEmpty": "接口未返回任何模型"
  },
  en: {
    "input.placeholder": "Type a message, / for commands",
    "input.approval": "Approval: y approve · n deny · Esc deny",
    "hint.ctrlc": "Press Ctrl+C again to exit",
    "hint.busy": "Turn in progress, please wait…",
    "status.lang": "EN",
    "banner.ready": "DeepSeek Code TUI — ready (/help for commands)",
    "banner.offline": "Kernel unavailable (no API key?), only /config /help work",
    "ev.toolOk": "ok",
    "ev.approvalTitle": "Approval required",
    "ev.done": "done",
    "ev.error": "error",
    "ev.rollback": "rolled back",
    "ev.verify": "verify",
    "ev.repair": "repair",
    "ev.route": "route",
    "ev.recovery": "recovery",
    "msg.modeSet": "mode: {mode}",
    "msg.modeInvalid": "mode must be read-only / gated / auto",
    "msg.cleared": "history cleared",
    "msg.langSet": "Language: English",
    "msg.noDiff": "No git diff to show",
    "msg.noChanges": "No change records yet",
    "msg.unknownSlash": "unknown command: /{name} (see /help)",
    "msg.sendFailed": "send failed: {err}",
    "slash.help.desc": "show command help",
    "slash.config.desc": "manage API profiles (add/edit/delete/activate/models/test)",
    "slash.diff.desc": "show workspace git diff",
    "slash.changes.desc": "show recent change records",
    "slash.mode.desc": "switch autonomy: read-only/gated/auto",
    "slash.lang.desc": "switch UI language zh/en",
    "slash.clear.desc": "clear conversation history",
    "slash.recovery.desc": "recovery center: list/resume/cancel",
    "slash.quit.desc": "quit the TUI",
    "cfg.title": "API profiles (Enter select, Esc back)",
    "cfg.empty": "No profiles yet — pick \"Add new\"",
    "cfg.new": "+ Add new profile",
    "cfg.active": "●active",
    "cfg.act.activate": "Activate",
    "cfg.act.edit": "Edit",
    "cfg.act.models": "Fetch model list",
    "cfg.act.test": "Test connection",
    "cfg.act.delete": "Delete",
    "cfg.field.name": "Name",
    "cfg.field.baseUrl": "Base URL",
    "cfg.field.apiKey": "API key (masked as you type)",
    "cfg.field.model": "Model (fetch via /config to pick)",
    "cfg.editHint": "Enter next field, Enter on last saves; Esc cancels",
    "cfg.saved": "Profile saved: {name}",
    "cfg.deleted": "Profile deleted",
    "cfg.activated": "Activated: {name} (kernel rebuilt with new config, history kept)",
    "cfg.testOk": "Connection test passed",
    "cfg.testFail": "Connection test failed: {err}",
    "cfg.modelsTitle": "Pick a model (Enter select, Esc back)",
    "cfg.modelsFail": "Model fetch failed: {err}",
    "cfg.modelsEmpty": "Endpoint returned no models"
  }
};

export function makeT(lang) {
  const primary = STRINGS[lang] || STRINGS.zh;
  return function t(key, vars = {}) {
    let text = primary[key] ?? STRINGS.en[key] ?? key;
    for (const [name, value] of Object.entries(vars)) {
      text = text.split(`{${name}}`).join(String(value));
    }
    return text;
  };
}
```

- [ ] **Step 4: 跑绿**

Run: `node --test tests/unit/tui/tui-i18n.test.js`
Expected: PASS(2 tests)

- [ ] **Step 5: 提交**

```bash
git add src/apps/tui/tui-i18n.js tests/unit/tui/tui-i18n.test.js
git commit -m "feat(tui): zh/en i18n dictionary with key parity test (D5-M1)"
```

### Task 4: `tui-state.js` reducer + 状态栏派生

**Files:**
- Create: `src/apps/tui/tui-state.js`
- Test: `tests/unit/tui/tui-state.test.js`

**Interfaces:**
- Consumes: `displayWidth`(T1,statusLine 不用宽度,输入光标列由 T6 计算,此处不依赖)。
- Produces:
  - `initialTuiState({ lang="zh", mode="gated" }) → state`,shape:`{ lang, mode, busy, spin, exit, input:{text,cursor,history[],hi,saved}, stream, approval, menu, overlay, pending[], hint, status:{state,model,tokens,cacheRate}, ctrlcAt }`
  - `reduce(state, action) → state`(不可变返回;未知 action 原样返回)。action 类型见测试。
  - `statusLine(state, t) → string`(无色纯文本;着色归 T6)
  - `formatTokens(n) → "999" | "12.4k" | "3.2m"`
  - `SPINNER = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"]`
- 约定:`menu = null | { items:[{name, desc}], index }`(slash 补全);`overlay = null | { lines:[string], cursorRow:number|null, cursorCol:number|null }`(config 等全接管视图,T13 灌入);`pending` 是待 println 进滚动区的行队列,painter 消费后 `{type:"flush", count}`。

- [ ] **Step 1: 写失败测试**

```js
// tests/unit/tui/tui-state.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { initialTuiState, reduce, statusLine, formatTokens, SPINNER } from "../../../src/apps/tui/tui-state.js";
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

test("reducer is immutable and ignores unknown actions", () => {
  const s = S();
  const out = reduce(s, { type: "__nope__" });
  assert.equal(out, s);
  const after = reduce(s, { type: "input_insert", text: "x" });
  assert.notEqual(after, s);
  assert.equal(s.input.text, "");
});
```

- [ ] **Step 2: 跑红**

Run: `node --test tests/unit/tui/tui-state.test.js`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 最小实现**

```js
// src/apps/tui/tui-state.js — TUI 纯 reducer(不可变)+ 状态栏派生。IO 一概不进此文件。
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const HISTORY_CAP = 100; // 本地输入历史条数上限

export function initialTuiState({ lang = "zh", mode = "gated" } = {}) {
  return {
    lang,
    mode,
    busy: false,
    spin: 0,
    exit: false,
    input: { text: "", cursor: 0, history: [], hi: -1, saved: "" },
    stream: "",
    approval: null,
    menu: null,
    overlay: null,
    pending: [],
    hint: "",
    status: { state: "idle", model: "", tokens: 0, cacheRate: 0 },
    ctrlcAt: 0
  };
}

function chars(text) { return Array.from(text); }

export function reduce(state, action = {}) {
  switch (action.type) {
    case "input_insert": {
      const cs = chars(state.input.text);
      const add = chars(String(action.text || ""));
      cs.splice(state.input.cursor, 0, ...add);
      return withInput(state, { text: cs.join(""), cursor: state.input.cursor + add.length });
    }
    case "input_backspace": {
      if (state.input.cursor === 0) return state;
      const cs = chars(state.input.text);
      cs.splice(state.input.cursor - 1, 1);
      return withInput(state, { text: cs.join(""), cursor: state.input.cursor - 1 });
    }
    case "input_left": return withInput(state, { cursor: Math.max(0, state.input.cursor - 1) });
    case "input_right": return withInput(state, { cursor: Math.min(chars(state.input.text).length, state.input.cursor + 1) });
    case "input_home": return withInput(state, { cursor: 0 });
    case "input_end": return withInput(state, { cursor: chars(state.input.text).length });
    case "input_set": return withInput(state, { text: action.text, cursor: chars(action.text).length });
    case "input_hist_prev": {
      const { history, hi, text, saved } = state.input;
      if (!history.length) return state;
      const next = hi === -1 ? history.length - 1 : Math.max(0, hi - 1);
      const keepSaved = hi === -1 ? text : saved;
      return withInput(state, { text: history[next], cursor: chars(history[next]).length, hi: next, saved: keepSaved });
    }
    case "input_hist_next": {
      const { history, hi, saved } = state.input;
      if (hi === -1) return state;
      if (hi >= history.length - 1) return withInput(state, { text: saved, cursor: chars(saved).length, hi: -1, saved: "" });
      const next = hi + 1;
      return withInput(state, { text: history[next], cursor: chars(history[next]).length, hi: next });
    }
    case "submit_local": {
      const entry = state.input.text;
      const history = entry ? [...state.input.history, entry].slice(-HISTORY_CAP) : state.input.history;
      return {
        ...state,
        pending: [...state.pending, action.line, ""],
        input: { text: "", cursor: 0, history, hi: -1, saved: "" }
      };
    }
    case "push": return { ...state, pending: [...state.pending, ...action.lines] };
    case "flush": return { ...state, pending: state.pending.slice(action.count) };
    case "stream_delta": return { ...state, stream: state.stream + String(action.text || "") };
    case "stream_clear": return { ...state, stream: "" };
    case "busy": return { ...state, busy: Boolean(action.busy), hint: action.busy ? state.hint : "" };
    case "spin": return { ...state, spin: (state.spin + 1) % SPINNER.length };
    case "approval": return { ...state, approval: action.approval || null };
    case "menu": return { ...state, menu: action.menu || null };
    case "menu_move": {
      if (!state.menu || !state.menu.items.length) return state;
      const n = state.menu.items.length;
      const index = ((state.menu.index + action.delta) % n + n) % n;
      return { ...state, menu: { ...state.menu, index } };
    }
    case "overlay": return { ...state, overlay: action.overlay || null };
    case "mode": return { ...state, mode: action.mode };
    case "lang": return { ...state, lang: action.lang };
    case "hint": return { ...state, hint: String(action.text || "") };
    case "status": return { ...state, status: { ...state.status, ...action.patch } };
    case "ctrlc_mark": return { ...state, ctrlcAt: action.now };
    case "exit": return { ...state, exit: true };
    default: return state;
  }
}

function withInput(state, patch) {
  return { ...state, input: { ...state.input, ...patch } };
}

export function formatTokens(n) {
  const v = Number(n) || 0;
  if (v < 1000) return String(v);
  if (v < 1_000_000) return `${(v / 1000).toFixed(1)}k`;
  return `${(v / 1_000_000).toFixed(1)}m`;
}

export function statusLine(state, t) {
  const runState = state.busy ? SPINNER[state.spin] : (state.status.state || "idle");
  const parts = [
    state.mode,
    state.status.model || "-",
    runState,
    `tokens ${formatTokens(state.status.tokens)}`,
    `cache ${Math.round((state.status.cacheRate || 0) * 100)}%`,
    t("status.lang")
  ];
  const line = parts.join(" · ");
  return state.hint ? `${line} — ${state.hint}` : line;
}
```

- [ ] **Step 4: 跑绿**

Run: `node --test tests/unit/tui/tui-state.test.js`
Expected: PASS(8 tests)

- [ ] **Step 5: 提交**

```bash
git add src/apps/tui/tui-state.js tests/unit/tui/tui-state.test.js
git commit -m "feat(tui): pure workbench reducer + status line derivation (D5-M1)"
```

---

## Milestone M2 — 事件派生

### Task 5: `event-cards.js` kernel 事件 → 卡片行

**Files:**
- Create: `src/apps/tui/event-cards.js`
- Test: `tests/unit/tui/event-cards.test.js`

**Interfaces:**
- Consumes: `makeT` 产出的 `t`(T3);`color`(`src/theme.js`)。
- Produces: `QUIET: Set<string>`、`eventToLines(event, t) → string[]`(已着色的整行,行首统一一个空格缩进;未知事件回退 dim `· type`)。T7 消费。
- 约定:`user:message`/`agent:final`/`agent:error` 进 QUIET——用户行与终态行由 app 从 `send()` 结果路径打印,避免重复。

- [ ] **Step 1: 写失败测试**

```js
// tests/unit/tui/event-cards.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { QUIET, eventToLines } from "../../../src/apps/tui/event-cards.js";
import { makeT } from "../../../src/apps/tui/tui-i18n.js";

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
```

- [ ] **Step 2: 跑红**

Run: `node --test tests/unit/tui/event-cards.test.js`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 最小实现**

```js
// src/apps/tui/event-cards.js — kernel 事件 → 已着色卡片行。纯函数;负载全部防御式读取。
import { color } from "../../theme.js";

export const QUIET = new Set([
  "model:request", "model:response", "agent:step", "agent:turn_started",
  "user:message", "agent:final", "agent:error",
  "context:cache_loaded", "context:cache_reused", "context:cache_saved",
  "context:snapshot", "context:warm", "context:pin", "context:unpin"
]);

function clip(value, max = 48) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function argsHint(args) {
  if (!args || typeof args !== "object") return "";
  for (const key of ["path", "file", "pattern", "command", "query", "url"]) {
    if (args[key]) return clip(args[key]);
  }
  return "";
}

function fileRows(event) {
  const entries = (Array.isArray(event.files) && event.files.length ? event.files : event.summary) || [];
  if (!Array.isArray(entries)) return [];
  return entries.map((e) => {
    const status = e.status || "M";
    const path = e.path || e.file || "?";
    const counts = [
      Number.isFinite(e.added) ? color.green(`+${e.added}`) : "",
      Number.isFinite(e.removed) ? color.red(`−${e.removed}`) : ""
    ].filter(Boolean).join(" ");
    return ` ${color.dim("│")} ${status} ${path}${counts ? ` ${counts}` : ""}`;
  });
}

export function eventToLines(event = {}, t) {
  const type = event.type || "";
  if (type === "tool:call") {
    const name = event.call?.name || event.tool?.name || event.tool || "?";
    const hint = argsHint(event.call?.args || event.call?.arguments);
    return [` ${color.dim("┌")} tool ▸ ${color.bold(name)}${hint ? ` ${color.dim(hint)}` : ""}`];
  }
  if (type === "tool:result") {
    const status = event.result?.status || event.status || "?";
    const mark = status === "ok" ? color.green(t("ev.toolOk")) : color.red(String(status));
    return [` ${color.dim("└")} ${mark}`];
  }
  if (type === "approval:requested") {
    const summary = clip(event.approval?.summary || event.approval?.id || "", 100);
    return [
      ` ${color.yellow("┌─ " + t("ev.approvalTitle") + " ─")}`,
      ` ${color.yellow("│")} ${summary}`
    ];
  }
  if (type === "approval:resolved") {
    return [` ${color.dim(`· approval ${event.decision || event.approval?.decision || ""}`)}`];
  }
  if (type === "file:diff_preview") {
    return [` ${color.dim(`· diff preview ${clip(event.summary_text || event.diff_hash || "")}`)}`];
  }
  if (type === "file:diff_applied") {
    return [
      ` ${color.dim("┌─")} diff · ${color.cyan(event.change_id || event.record?.id || "?")}`,
      ...fileRows(event),
      ` ${color.dim("└─")}`
    ];
  }
  if (type === "file:rollback_applied") {
    return [` ${color.yellow(`↺ ${t("ev.rollback")} ${event.change_id || event.record?.id || ""}`)}`];
  }
  if (type === "verification:result") {
    return [` ${color.dim(`· ${t("ev.verify")} ${event.result?.status || event.status || "?"}`)}`];
  }
  if (type.startsWith("repair:")) {
    return [` ${color.dim(`· ${t("ev.repair")} ${type.slice("repair:".length)}`)}`];
  }
  if (type === "orchestration:route_resolved") {
    return [` ${color.dim(`· ${t("ev.route")} ▸ ${event.lane || event.route || ""}`)}`];
  }
  if (type.startsWith("orchestration:")) {
    return [` ${color.dim(`· orch ▸ ${type.slice("orchestration:".length)}`)}`];
  }
  if (type === "recovery:report") {
    const found = event.found_count ?? 0;
    const done = event.done_count ?? 0;
    const blocked = event.blocked_count ?? 0;
    return [` ${color.dim(`· ${t("ev.recovery")} found ${found} done ${done} blocked ${blocked}`)}`];
  }
  if (type === "recovery:blocked") {
    return [` ${color.yellow(`· ${t("ev.recovery")} blocked ${event.reason || ""} ${event.item_id || event.source_id || ""}`.trimEnd())}`];
  }
  return [` ${color.dim(`· ${type || "event"}`)}`];
}
```

- [ ] **Step 4: 跑绿**

Run: `node --test tests/unit/tui/event-cards.test.js`
Expected: PASS(6 tests)

- [ ] **Step 5: 提交**

```bash
git add src/apps/tui/event-cards.js tests/unit/tui/event-cards.test.js
git commit -m "feat(tui): kernel event to card-line derivation with quiet set (D5-M2)"
```

---

## Milestone M3 — 渲染

### Task 6: `paint.js` 底部区计算 + painter

**Files:**
- Create: `src/apps/tui/paint.js`
- Test: `tests/unit/tui/paint.test.js`

**Interfaces:**
- Consumes: `seq/displayWidth/truncateToWidth`(T1)、`statusLine`(T4)、`color`(theme)。
- Produces:
  - `computeBottom(state, t, columns) → { lines: string[], cursorRow: number, cursorCol: number }`。布局(自上而下):流式预览(≤3 行,仅 busy 且有 stream 时)→ 分隔线 → slash 菜单(≤6 行,仅 menu 时)→ 输入行(approval 时换审批提示;overlay 时输入/菜单整段被 `overlay.lines` 取代)→ 状态栏。`cursorRow` 是 `lines` 内 0 起的行号。
  - `createPainter({ write }) → { paint({ append, bottom, cursorRow, cursorCol }), teardown() }`。paint 协议:回到上次停靠行(`\r` + up(parkRow))→ `clearDown`(首帧跳过)→ 逐行 println `append` → 打印 `bottom`(行间 `\n`,末行不换行)→ 光标定位到 `(cursorRow, cursorCol)` 停靠。teardown 把光标移到区域底部另起一行。
- T7/T13 消费。

- [ ] **Step 1: 写失败测试**

```js
// tests/unit/tui/paint.test.js
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
  assert.match(strip(out.lines[1]), /审批:y 批准/);
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
```

- [ ] **Step 2: 跑红**

Run: `node --test tests/unit/tui/paint.test.js`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 最小实现**

```js
// src/apps/tui/paint.js — 底部固定区计算(纯)+ painter(唯一写终端的地方,write 可注入)。
import { seq, displayWidth, truncateToWidth } from "./ansi.js";
import { statusLine } from "./tui-state.js";
import { color } from "../../theme.js";

const MENU_MAX = 6;
const STREAM_MAX = 3;

export function computeBottom(state, t, columns) {
  const width = Math.max(20, Number(columns) || 80);
  const sep = color.dim("─".repeat(Math.min(width - 1, 120)));
  const status = color.dim(truncateToWidth(statusLine(state, t), width - 1));

  if (state.overlay) {
    const lines = [sep, ...state.overlay.lines, status];
    const cursorRow = state.overlay.cursorRow == null ? lines.length - 1 : state.overlay.cursorRow + 1;
    const cursorCol = state.overlay.cursorCol == null ? 1 : state.overlay.cursorCol;
    return { lines, cursorRow, cursorCol };
  }

  const streamLines = state.busy && state.stream
    ? state.stream.split("\n").slice(-STREAM_MAX).map((l) => ` ${truncateToWidth(l, width - 2)}`)
    : [];

  const menuLines = [];
  if (state.menu && state.menu.items.length) {
    const items = state.menu.items;
    const start = Math.max(0, Math.min(state.menu.index - (MENU_MAX - 1), items.length - MENU_MAX));
    for (let i = start; i < Math.min(items.length, start + MENU_MAX); i += 1) {
      const item = items[i];
      const label = ` /${item.name} `;
      const desc = color.dim(truncateToWidth(item.desc, Math.max(0, width - displayWidth(label) - 3)));
      menuLines.push(i === state.menu.index ? ` ${color.inverse(label)}${desc}` : ` ${label}${desc}`);
    }
  }

  let inputLine;
  let cursorCol;
  if (state.approval) {
    inputLine = ` ${color.yellow(t("input.approval"))}`;
    cursorCol = 1;
  } else {
    const chars = Array.from(state.input.text);
    let from = 0; // 尾窗:光标必须可见
    while (displayWidth(chars.slice(from, state.input.cursor).join("")) > width - 8) from += 1;
    const visible = chars.slice(from).join("");
    inputLine = visible
      ? ` ❯ ${truncateToWidth(visible, width - 5)}`
      : ` ❯ ${color.dim(truncateToWidth(t("input.placeholder"), width - 5))}`;
    cursorCol = 4 + displayWidth(chars.slice(from, state.input.cursor).join(""));
  }

  const lines = [...streamLines, sep, ...menuLines, inputLine, status];
  return { lines, cursorRow: lines.length - 2, cursorCol };
}

export function createPainter({ write }) {
  let height = 0;
  let parkRow = 0;

  function paint({ append = [], bottom, cursorRow, cursorCol }) {
    let out = "\r" + seq.up(parkRow);
    if (height > 0) out += seq.clearDown;
    for (const line of append) out += `${line}\n`;
    out += bottom.join("\n");
    out += "\r" + seq.up(bottom.length - 1 - cursorRow) + seq.col(cursorCol);
    write(out);
    height = bottom.length;
    parkRow = cursorRow;
  }

  function teardown() {
    if (height > 0) write("\r" + seq.down(height - 1 - parkRow) + "\n");
    height = 0;
    parkRow = 0;
  }

  return { paint, teardown };
}
```

- [ ] **Step 4: 跑绿**

Run: `node --test tests/unit/tui/paint.test.js`
Expected: PASS(7 tests)

- [ ] **Step 5: 提交**

```bash
git add src/apps/tui/paint.js tests/unit/tui/paint.test.js
git commit -m "feat(tui): bottom-region layout compute + injectable painter (D5-M3)"
```

---

## Milestone M4 — 组装

### Task 7: `tui-app.js` 组合根 + `prefs.js`

**Files:**
- Create: `src/apps/tui/tui-app.js`
- Create: `src/apps/tui/prefs.js`
- Test: `tests/unit/tui/tui-app.test.js`

**Interfaces:**
- Consumes: T1–T6 全部导出;`createKernel`(`src/index.js`)、`buildKernelOptions`(`src/apps/kernel-options.js`)、`loadConfig`(`src/config.js`)、`color`(theme)。kernel 契约:`agent.send(text, {autonomy, history, stream, onDelta}) → {status:"complete"|"awaiting_approval"|"error", content?, approval?, error?}`、`agent.approve(id, decision)`、`session.subscribe(fn)→{unsubscribe}`、`runtime.getState()`、`metrics.getUsage()`、`dispose()`。
- Produces:
  - `createTuiApp({ root, input=process.stdin, output=process.stdout, kernel=null, createKernelImpl, buildKernelOptionsImpl, loadConfigImpl, now=Date.now, spinnerMs=120 }) → { run(): Promise<void> }`(全部依赖可注入,测试不需要真 pty/真 kernel)。
  - `prefs.js`:`loadTuiPrefs(root) → Promise<object>`、`saveTuiPrefs(root, prefs)`(原子写 `.deepseek-code/tui-prefs.json`)。
  - 文件内预留两个扩展点(后续 Task 在本文件上编辑):`handleSlash(text)`(T9 用注册表替换实现)与 `modalHandler`(T13 config 视图接管按键)。
- 行为要点:autonomy 默认 gated(state.mode);`onDelta` 流式进底部预览;审批 y/n/Esc;Ctrl+C 3 秒内双击退出、单击提示;busy 中 Esc 显示 `hint.busy`(内核 send 不支持外部 AbortSignal,spec 降级分支);会话 history 由 app 持有,`appendHistory` 镜像 kernel-runner 语义(保留最近 20 条 = 10 轮);退出路径 finally 恢复终端态;自建 kernel 才 dispose。

- [ ] **Step 1: 写失败测试**

```js
// tests/unit/tui/tui-app.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTuiApp } from "../../../src/apps/tui/tui-app.js";
import { loadTuiPrefs, saveTuiPrefs } from "../../../src/apps/tui/prefs.js";

function makeIO() {
  const input = new PassThrough();
  input.setRawMode = () => {};
  input.isTTY = true;
  const output = new PassThrough();
  output.columns = 80;
  const chunks = [];
  output.on("data", (c) => chunks.push(String(c)));
  return { input, output, text: () => chunks.join("") };
}

function makeFakeKernel({ onSend, onApprove } = {}) {
  const subs = new Set();
  const kernel = {
    disposed: false,
    session: { subscribe(fn) { subs.add(fn); return { unsubscribe: () => subs.delete(fn) }; } },
    runtime: { getState: () => ({ current: "idle", channel: null }) },
    metrics: { getUsage: () => ({ total_tokens: 42, cache_hit_rate: 0.5 }) },
    agent: {
      send: (text, options) => onSend({ text, options, emit }),
      approve: (id, decision) => onApprove({ id, decision })
    },
    async dispose() { kernel.disposed = true; }
  };
  function emit(ev) { for (const fn of subs) fn(ev); }
  kernel.emit = emit;
  return kernel;
}

async function until(fn, ms = 3000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function tmpRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "dsc-tui-"));
}

test("prefs roundtrip", async () => {
  const root = await tmpRoot();
  assert.deepEqual(await loadTuiPrefs(root), {});
  await saveTuiPrefs(root, { lang: "en" });
  assert.deepEqual(await loadTuiPrefs(root), { lang: "en" });
});

test("full streaming round: echo, deltas, final, history", async () => {
  const io = makeIO();
  const sends = [];
  const kernel = makeFakeKernel({
    onSend: async ({ text, options }) => {
      sends.push({ text, options });
      options.onDelta("你好");
      options.onDelta("世界");
      return { status: "complete", content: "你好世界" };
    }
  });
  const app = createTuiApp({ root: await tmpRoot(), kernel, input: io.input, output: io.output });
  const done = app.run();
  await until(() => io.text().includes("❯"));
  io.input.write("hi\r");
  await until(() => io.text().includes("你好世界"));
  assert.match(io.text(), /❯ hi/);
  assert.equal(sends[0].options.autonomy, "gated");
  assert.equal(sends[0].options.stream, true);
  io.input.write("again\r");
  await until(() => sends.length === 2);
  assert.equal(sends[1].options.history.length, 2); // 上一轮 user+assistant
  assert.equal(sends[1].options.history[0].content, "hi");
  io.input.write("\x03");
  io.input.write("\x03");
  await done;
  assert.ok(io.text().includes("\x1b[?2004l")); // pasteOff
  assert.ok(io.text().includes("\x1b[?25h"));   // showCursor
  assert.equal(kernel.disposed, false);          // 注入的 kernel 不由 app dispose
});

test("approval flow: y approves, esc denies", async () => {
  const io = makeIO();
  const approvals = [];
  let phase = 0;
  const kernel = makeFakeKernel({
    onSend: async ({ emit }) => {
      phase += 1;
      emit({ type: "approval:requested", approval: { id: `ap_${phase}`, summary: `write file ${phase}` } });
      return { status: "awaiting_approval", approval: { id: `ap_${phase}`, summary: `write file ${phase}` } };
    },
    onApprove: async ({ id, decision }) => {
      approvals.push({ id, decision });
      return { status: "complete", content: "done" };
    }
  });
  const app = createTuiApp({ root: await tmpRoot(), kernel, input: io.input, output: io.output });
  const done = app.run();
  await until(() => io.text().includes("❯"));
  io.input.write("do it\r");
  await until(() => io.text().includes("审批"));
  io.input.write("y");
  await until(() => approvals.length === 1);
  assert.deepEqual(approvals[0], { id: "ap_1", decision: "approve" });
  io.input.write("redo\r");
  await until(() => io.text().includes("write file 2")); // 第二轮审批卡片可见(按轮次区分,避免重绘计数竞态)
  io.input.write("\x1b"); // Esc → deny
  await until(() => approvals.length === 2);
  assert.equal(approvals[1].decision, "deny");
  io.input.write("\x03");
  io.input.write("\x03");
  await done;
});

test("kernel events render as cards; ctrl_c single press hints", async () => {
  const io = makeIO();
  const kernel = makeFakeKernel({ onSend: async () => ({ status: "complete", content: "" }) });
  const app = createTuiApp({ root: await tmpRoot(), kernel, input: io.input, output: io.output });
  const done = app.run();
  await until(() => io.text().includes("❯"));
  kernel.emit({ type: "tool:call", call: { name: "read", args: { path: "a.js" } } });
  await until(() => io.text().includes("tool ▸ read"));
  io.input.write("\x03");
  await until(() => io.text().includes("再按一次"));
  await new Promise((r) => setTimeout(r, 20));
  io.input.write("\x03"); // 20ms 内第二次 → 退出
  await done;
});

test("offline kernel: banner + offline notice on submit", async () => {
  const io = makeIO();
  const app = createTuiApp({
    root: await tmpRoot(),
    input: io.input,
    output: io.output,
    createKernelImpl: async () => { throw new Error("no key"); },
    buildKernelOptionsImpl: async () => ({})
  });
  const done = app.run();
  await until(() => io.text().includes("内核不可用"));
  io.input.write("hello\r");
  await until(() => io.text().split("内核不可用").length > 2);
  io.input.write("\x03");
  io.input.write("\x03");
  await done;
});
```

- [ ] **Step 2: 跑红**

Run: `node --test tests/unit/tui/tui-app.test.js`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 最小实现**

先 `prefs.js`:

```js
// src/apps/tui/prefs.js — TUI 本地偏好(语言等),原子小文件。
import fsp from "node:fs/promises";
import path from "node:path";

function fileOf(root) { return path.join(root, ".deepseek-code", "tui-prefs.json"); }

export async function loadTuiPrefs(root) {
  try {
    const raw = JSON.parse(await fsp.readFile(fileOf(root), "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

export async function saveTuiPrefs(root, prefs) {
  const file = fileOf(root);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(prefs, null, 2), "utf8");
  await fsp.rename(tmp, file);
}
```

再 `tui-app.js`:

```js
// src/apps/tui/tui-app.js — TUI 组合根:kernel 接线、按键路由、重绘调度、终端态管理。
// 唯一的副作用汇聚点;所有依赖可注入,node:test 直接驱动。
import { createKernel } from "../../index.js";
import { buildKernelOptions } from "../kernel-options.js";
import { loadConfig } from "../../config.js";
import { color } from "../../theme.js";
import { seq } from "./ansi.js";
import { createKeyDecoder } from "./input.js";
import { makeT } from "./tui-i18n.js";
import { initialTuiState, reduce } from "./tui-state.js";
import { QUIET, eventToLines } from "./event-cards.js";
import { computeBottom, createPainter } from "./paint.js";
import { loadTuiPrefs } from "./prefs.js";

const CTRLC_WINDOW_MS = 3000;
const HISTORY_CAP = 20; // 与 kernel-runner appendHistory 同语义:10 轮

export function createTuiApp({
  root,
  input = process.stdin,
  output = process.stdout,
  kernel = null,
  createKernelImpl = createKernel,
  buildKernelOptionsImpl = buildKernelOptions,
  loadConfigImpl = loadConfig,
  now = Date.now,
  spinnerMs = 120
} = {}) {
  let state = initialTuiState({});
  let t = makeT(state.lang);
  const T = (key, vars) => t(key, vars);
  let history = [];
  let ownKernel = false;
  let subscription = null;
  let spinTimer = null;
  let paintQueued = null;
  let approvalResolve = null;
  let finishResolve = null;
  let modalHandler = null; // T13:config 等全接管视图的按键处理器
  const painter = createPainter({ write: (s) => output.write(s) });
  const columns = () => output.columns || 80;

  function apply(action) { state = reduce(state, action); }

  function dispatch(action) {
    apply(action);
    if (state.exit && finishResolve) { const r = finishResolve; finishResolve = null; r(); return; }
    schedulePaint();
  }

  function schedulePaint() {
    if (paintQueued) return;
    paintQueued = setImmediate(() => {
      paintQueued = null;
      const append = state.pending;
      if (append.length) apply({ type: "flush", count: append.length });
      const bottom = computeBottom(state, T, columns());
      painter.paint({ append, ...bottom, bottom: bottom.lines });
    });
  }

  function pushLines(lines) { dispatch({ type: "push", lines }); }

  function refreshStatus() {
    if (!kernel) return;
    const st = kernel.runtime?.getState?.() || {};
    const usage = kernel.metrics?.getUsage?.() || {};
    dispatch({ type: "status", patch: {
      state: st.current || "idle",
      tokens: usage.total_tokens || 0,
      cacheRate: usage.cache_hit_rate || 0
    } });
  }

  function appendHistory(list, user, assistant) {
    return [
      ...list,
      { role: "user", content: user },
      { role: "assistant", content: assistant }
    ].slice(-HISTORY_CAP);
  }

  function subscribeKernel() {
    if (!kernel?.session?.subscribe) return;
    subscription = kernel.session.subscribe((event) => {
      refreshStatus();
      if (!event?.type || QUIET.has(event.type)) return;
      pushLines(eventToLines(event, T));
    });
  }

  function waitApproval(approval) {
    return new Promise((resolve) => {
      approvalResolve = (decision) => {
        approvalResolve = null;
        dispatch({ type: "approval", approval: null });
        resolve(decision);
      };
      dispatch({ type: "approval", approval });
    });
  }

  async function sendTurn(text) {
    dispatch({ type: "submit_local", line: ` ${color.cyan("❯")} ${text}` });
    if (!kernel) { pushLines([` ${color.yellow(T("banner.offline"))}`, ""]); return; }
    dispatch({ type: "busy", busy: true });
    try {
      let result = await kernel.agent.send(text, {
        autonomy: state.mode,
        history,
        stream: true,
        onDelta: (d) => dispatch({ type: "stream_delta", text: String(d) })
      });
      while (result && result.status === "awaiting_approval" && result.approval?.id) {
        const decision = await waitApproval(result.approval);
        result = await kernel.agent.approve(result.approval.id, decision);
      }
      if (result && result.status === "complete") {
        const content = result.content || "";
        const body = content ? content.split("\n").map((l) => ` ${l}`) : [];
        pushLines([` ${color.green("✓")} ${T("ev.done")}`, ...body, ""]);
        history = appendHistory(history, text, content);
      } else if (result) {
        pushLines([` ${color.red("✗")} ${T("ev.error")}: ${result.error || result.message || "?"}`, ""]);
      }
    } catch (error) {
      pushLines([` ${color.red("✗")} ${T("msg.sendFailed", { err: error?.message || String(error) })}`, ""]);
    } finally {
      dispatch({ type: "stream_clear" });
      dispatch({ type: "busy", busy: false });
      refreshStatus();
    }
  }

  // T9 会用命令注册表替换本实现;M4 阶段所有 /xxx 一律未知命令。
  async function handleSlash(text) {
    dispatch({ type: "submit_local", line: ` ${color.cyan("❯")} ${text}` });
    const name = text.slice(1).split(/\s+/)[0] || "";
    pushLines([` ${color.yellow(T("msg.unknownSlash", { name }))}`, ""]);
  }

  function submit() {
    const text = state.input.text.trim();
    if (!text || state.busy) return;
    if (text.startsWith("/")) { void handleSlash(text); return; }
    void sendTurn(text);
  }

  function onKey(ev) {
    if (ev.type === "ctrl_c") {
      if (now() - state.ctrlcAt <= CTRLC_WINDOW_MS) { dispatch({ type: "exit" }); return; }
      dispatch({ type: "ctrlc_mark", now: now() });
      dispatch({ type: "hint", text: T("hint.ctrlc") });
      return;
    }
    if (modalHandler) { modalHandler(ev); return; }
    if (state.approval) {
      if (ev.type === "char" && /^y$/i.test(ev.text)) approvalResolve?.("approve");
      else if ((ev.type === "char" && /^n$/i.test(ev.text)) || ev.type === "esc") approvalResolve?.("deny");
      return;
    }
    switch (ev.type) {
      case "char": dispatch({ type: "input_insert", text: ev.text }); return;
      case "paste": dispatch({ type: "input_insert", text: ev.text }); return;
      case "enter": submit(); return;
      case "backspace": dispatch({ type: "input_backspace" }); return;
      case "left": dispatch({ type: "input_left" }); return;
      case "right": dispatch({ type: "input_right" }); return;
      case "home": dispatch({ type: "input_home" }); return;
      case "end": dispatch({ type: "input_end" }); return;
      case "up": dispatch({ type: "input_hist_prev" }); return;
      case "down": dispatch({ type: "input_hist_next" }); return;
      case "esc": if (state.busy) dispatch({ type: "hint", text: T("hint.busy") }); return;
      default: return;
    }
  }

  async function run() {
    const prefs = await loadTuiPrefs(root).catch(() => ({}));
    if (prefs.lang === "en" || prefs.lang === "zh") {
      apply({ type: "lang", lang: prefs.lang });
      t = makeT(prefs.lang);
    }
    if (!kernel) {
      try {
        kernel = await createKernelImpl(root, await buildKernelOptionsImpl(root));
        ownKernel = true;
      } catch { kernel = null; }
    }
    try {
      const cfg = await loadConfigImpl(root, { allowMissingKey: true });
      apply({ type: "status", patch: { model: cfg?.model || "" } });
    } catch { /* 状态栏模型名留空 */ }

    input.setRawMode?.(true);
    input.resume?.();
    input.setEncoding?.("utf8");
    output.write(seq.pasteOn + "\n");
    const decoder = createKeyDecoder();
    const onData = (chunk) => { for (const ev of decoder.feed(String(chunk))) onKey(ev); };
    input.on("data", onData);
    const onResize = () => schedulePaint();
    output.on?.("resize", onResize);
    spinTimer = setInterval(() => { if (state.busy) dispatch({ type: "spin" }); refreshStatus(); }, spinnerMs);

    subscribeKernel();
    pushLines([` ${color.cyan(T(kernel ? "banner.ready" : "banner.offline"))}`, ""]);
    refreshStatus();
    schedulePaint();

    await new Promise((resolve) => { finishResolve = resolve; });

    // 清理与终端态恢复(任何退出路径都走到这里)
    try {
      if (paintQueued) { clearImmediate(paintQueued); paintQueued = null; }
      clearInterval(spinTimer);
      subscription?.unsubscribe?.();
      input.removeListener("data", onData);
      output.removeListener?.("resize", onResize);
      painter.teardown();
      output.write(seq.pasteOff + seq.showCursor + seq.reset);
      input.setRawMode?.(false);
      input.pause?.();
    } finally {
      if (ownKernel && kernel?.dispose) await kernel.dispose().catch(() => {});
    }
  }

  return { run };
}
```

- [ ] **Step 4: 跑绿**

Run: `node --test tests/unit/tui/tui-app.test.js`
Expected: PASS(5 tests)。若 approval 测试偶发超时,检查 `waitApproval` 是否在 `approval:requested` 事件渲染后才切态(事件卡片由订阅路径渲染,`waitApproval` 只负责切输入区)。

- [ ] **Step 5: 提交**

```bash
git add src/apps/tui/tui-app.js src/apps/tui/prefs.js tests/unit/tui/tui-app.test.js
git commit -m "feat(tui): composition root with injectable io/kernel + prefs store (D5-M4)"
```

### Task 8: `src/tui.js` 薄入口替换 + 旧测试清理 + check 脚本

**Files:**
- Modify: `src/tui.js`(整文件替换,568 行 → ~12 行)
- Delete: `tests/unit/apps/tui-metrics.test.js`(`renderTuiStatusLine` 已删;状态栏测试在 T4)
- Modify: `tests/integration/v2-interface-boundary.test.js`(两处 tui 断言块)
- Modify: `package.json`(check 脚本追加 TUI 模块)

**Interfaces:**
- Consumes: `createTuiApp`(T7)。
- Produces: `runTui(root, kernel = null)`(签名与 TTY 前置检查同旧版;cli.js `case "tui": await runTui(root)` 不动)。

- [ ] **Step 1: 先改边界测试(红)**

用 `grep -n "src/tui.js" tests/integration/v2-interface-boundary.test.js` 定位两个引用 `src/tui.js` 的 test 块,**整块替换**为:

```js
test("tui entry stays thin and only reaches the kernel via tui-app", async () => {
  const tui = await source("src/tui.js");
  assert.match(tui, /from "\.\/apps\/tui\/tui-app\.js"/);
  assert.doesNotMatch(tui, /from "\.\/agent\.js"/);
  assert.doesNotMatch(tui, /kernel-api/);
});

test("tui-app talks to the unified kernel entry", async () => {
  const app = await source("src/apps/tui/tui-app.js");
  assert.match(app, /from "\.\.\/\.\.\/index\.js"/);
  assert.doesNotMatch(app, /from "\.\.\/\.\.\/chat\.js"/);
  assert.doesNotMatch(app, /askDeepSeek/);
});
```

(保留文件里既有的 `source` helper 与其它非 tui 断言不动。)

Run: `node --test tests/integration/v2-interface-boundary.test.js`
Expected: FAIL(旧 src/tui.js 还是菜单版,无 tui-app import)

- [ ] **Step 2: 整文件替换 `src/tui.js`**

```js
// src/tui.js — TUI 薄入口。真正的实现在 src/apps/tui/tui-app.js(D-5 重设计)。
import { stdin, stdout } from "node:process";
import { createTuiApp } from "./apps/tui/tui-app.js";

export async function runTui(root, kernel = null) {
  if (!stdin.isTTY || !stdout.isTTY) {
    // 启动前置错误,早于语言偏好加载;文案与旧版保持一致。
    throw new Error("TUI 需要在交互式终端中运行。");
  }
  const app = createTuiApp({ root, kernel, input: stdin, output: stdout });
  await app.run();
}
```

- [ ] **Step 3: 删除旧状态栏测试**

```bash
git rm tests/unit/apps/tui-metrics.test.js
```

- [ ] **Step 4: check 脚本追加 TUI 模块**

Edit `package.json` 的 `check` 脚本:在末尾(最后一个 `node --check ... orchestration-recovery-contract.js` 之后)追加一段:

```
 && node --check src/apps/tui/ansi.js src/apps/tui/input.js src/apps/tui/tui-i18n.js src/apps/tui/tui-state.js src/apps/tui/event-cards.js src/apps/tui/paint.js src/apps/tui/prefs.js src/apps/tui/tui-app.js
```

(T9/T13 各自把 `slash.js`/`config-flow.js` 补进同一段。)

- [ ] **Step 5: 跑绿 + 全量回归**

Run: `node --test tests/integration/v2-interface-boundary.test.js` → PASS
Run: `npm test` → 全绿(0 fail;总数 = 847 − 旧 tui-metrics 若干 + T1–T7 新增)
Run: `npm run check` → exit 0

- [ ] **Step 6: 提交**

```bash
git add src/tui.js tests/integration/v2-interface-boundary.test.js package.json
git commit -m "feat(tui): replace menu-loop with inline agent-session TUI entry (D5-M4)"
```

---

## Milestone M5 — slash 基础命令

### Task 9: `slash.js` 注册表 + 补全菜单 + 基础命令接线

**Files:**
- Create: `src/apps/tui/slash.js`
- Modify: `src/apps/tui/tui-app.js`(替换 `handleSlash`、加菜单联动与命令处理器)
- Modify: `package.json`(check 脚本 TUI 段补 `src/apps/tui/slash.js`)
- Test: `tests/unit/tui/slash.test.js`、`tests/unit/tui/tui-app-slash.test.js`

**Interfaces:**
- Consumes: T3 的 `descKey` 文案、T4 的 menu 状态、T7 的 `handleSlash` 替换点与 `pushLines/dispatch`;`showDiff`(`src/git.js`)、`listChanges/formatChange`(`src/changes.js`)、`saveTuiPrefs`(T7)。
- Produces:
  - `SLASH_COMMANDS: [{name, descKey}]`(**本 Task 不含 `config`**,T13 追加该条目);
  - `filterCommands(prefix) → SLASH_COMMANDS 子集`(前缀匹配);
  - `parseSlash(line) → { name, arg } | null`;
  - `createTuiApp` 新增可注入:`showDiffImpl = showDiff`、`listChangesImpl = listChanges`、`formatChangeImpl = formatChange`。
- 交互:输入以 `/` 开头且无空格 → 打开补全菜单(实时过滤);菜单开着时 ↑↓ 移动、Tab 补全进输入行、Enter 直接执行选中项、Esc 关闭;`/mode` 无参循环切换 read-only→gated→auto;`/lang` 无参在 zh/en 间切换并持久化 prefs;`/quit` 退出;`/recovery [resume|cancel] <id>` 镜像 kernel-runner 语义。

- [ ] **Step 1: 写失败测试(纯函数)**

```js
// tests/unit/tui/slash.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { SLASH_COMMANDS, filterCommands, parseSlash } from "../../../src/apps/tui/slash.js";

test("registry holds the M5 command set (config comes in M6)", () => {
  assert.deepEqual(SLASH_COMMANDS.map((c) => c.name),
    ["help", "diff", "changes", "mode", "lang", "clear", "recovery", "quit"]);
  for (const c of SLASH_COMMANDS) assert.match(c.descKey, /^slash\./);
});

test("filterCommands prefix-matches", () => {
  assert.deepEqual(filterCommands("").map((c) => c.name), SLASH_COMMANDS.map((c) => c.name));
  assert.deepEqual(filterCommands("c").map((c) => c.name), ["changes", "clear"]);
  assert.deepEqual(filterCommands("zzz"), []);
});

test("parseSlash splits name and arg", () => {
  assert.deepEqual(parseSlash("/mode auto"), { name: "mode", arg: "auto" });
  assert.deepEqual(parseSlash("/help"), { name: "help", arg: "" });
  assert.deepEqual(parseSlash("/recovery resume x1"), { name: "recovery", arg: "resume x1" });
  assert.equal(parseSlash("hello"), null);
  assert.equal(parseSlash("/"), null);
});
```

- [ ] **Step 2: 跑红**

Run: `node --test tests/unit/tui/slash.test.js`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现 `slash.js`**

```js
// src/apps/tui/slash.js — slash 命令注册表与解析(纯)。执行器在 tui-app 闭包里。
export const SLASH_COMMANDS = [
  { name: "help", descKey: "slash.help.desc" },
  { name: "diff", descKey: "slash.diff.desc" },
  { name: "changes", descKey: "slash.changes.desc" },
  { name: "mode", descKey: "slash.mode.desc" },
  { name: "lang", descKey: "slash.lang.desc" },
  { name: "clear", descKey: "slash.clear.desc" },
  { name: "recovery", descKey: "slash.recovery.desc" },
  { name: "quit", descKey: "slash.quit.desc" }
];

export function filterCommands(prefix) {
  const p = String(prefix || "").toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(p));
}

export function parseSlash(line) {
  const text = String(line || "").trim();
  if (!text.startsWith("/") || text.length < 2) return null;
  const body = text.slice(1);
  const space = body.indexOf(" ");
  if (space === -1) return { name: body, arg: "" };
  return { name: body.slice(0, space), arg: body.slice(space + 1).trim() };
}
```

- [ ] **Step 4: 写失败测试(接线)**

```js
// tests/unit/tui/tui-app-slash.test.js — 复用 tui-app.test.js 的 makeIO/makeFakeKernel/until/tmpRoot
// 结构相同,此处不重复粘贴 helper;实现时把四个 helper 抽到 tests/unit/tui/helpers.js 并让两个测试文件共用。
import test from "node:test";
import assert from "node:assert/strict";
import { createTuiApp } from "../../../src/apps/tui/tui-app.js";
import { loadTuiPrefs } from "../../../src/apps/tui/prefs.js";
import { makeIO, makeFakeKernel, until, tmpRoot } from "./helpers.js";

test("/help lists registered commands", async () => {
  const io = makeIO();
  const kernel = makeFakeKernel({ onSend: async () => ({ status: "complete", content: "" }) });
  const app = createTuiApp({ root: await tmpRoot(), kernel, input: io.input, output: io.output });
  const done = app.run();
  await until(() => io.text().includes("❯"));
  io.input.write("/help\r");
  await until(() => io.text().includes("/quit"));
  assert.match(io.text(), /\/mode/);
  io.input.write("\x03"); io.input.write("\x03");
  await done;
});

test("typing / opens filtered menu; tab completes; enter runs selection", async () => {
  const io = makeIO();
  const kernel = makeFakeKernel({ onSend: async () => ({ status: "complete", content: "" }) });
  const app = createTuiApp({ root: await tmpRoot(), kernel, input: io.input, output: io.output });
  const done = app.run();
  await until(() => io.text().includes("❯"));
  io.input.write("/cl");
  await until(() => io.text().includes("/clear"));
  io.input.write("\t"); // Tab 补全
  io.input.write("\r");
  await until(() => io.text().includes("已清空会话上下文"));
  io.input.write("\x03"); io.input.write("\x03");
  await done;
});

test("/mode auto changes autonomy for next send; bad arg rejected", async () => {
  const io = makeIO();
  const sends = [];
  const kernel = makeFakeKernel({ onSend: async ({ text, options }) => { sends.push(options); return { status: "complete", content: "" }; } });
  const app = createTuiApp({ root: await tmpRoot(), kernel, input: io.input, output: io.output });
  const done = app.run();
  await until(() => io.text().includes("❯"));
  io.input.write("/mode auto\r");
  await until(() => io.text().includes("模式:auto"));
  io.input.write("go\r");
  await until(() => sends.length === 1);
  assert.equal(sends[0].autonomy, "auto");
  io.input.write("/mode bogus\r");
  await until(() => io.text().includes("模式必须是"));
  io.input.write("\x03"); io.input.write("\x03");
  await done;
});

test("/clear wipes conversation history", async () => {
  const io = makeIO();
  const sends = [];
  const kernel = makeFakeKernel({ onSend: async ({ options }) => { sends.push(options); return { status: "complete", content: "r" }; } });
  const app = createTuiApp({ root: await tmpRoot(), kernel, input: io.input, output: io.output });
  const done = app.run();
  await until(() => io.text().includes("❯"));
  io.input.write("one\r");
  await until(() => sends.length === 1);
  io.input.write("/clear\r");
  await until(() => io.text().includes("已清空"));
  io.input.write("two\r");
  await until(() => sends.length === 2);
  assert.equal(sends[1].history.length, 0);
  io.input.write("\x03"); io.input.write("\x03");
  await done;
});

test("/lang en switches ui language and persists", async () => {
  const io = makeIO();
  const root = await tmpRoot();
  const kernel = makeFakeKernel({ onSend: async () => ({ status: "complete", content: "" }) });
  const app = createTuiApp({ root, kernel, input: io.input, output: io.output });
  const done = app.run();
  await until(() => io.text().includes("❯"));
  io.input.write("/lang en\r");
  await until(() => io.text().includes("Language: English"));
  assert.equal((await loadTuiPrefs(root)).lang, "en");
  io.input.write("\x03"); io.input.write("\x03");
  await done;
});

test("/diff renders injected diff; /quit exits", async () => {
  const io = makeIO();
  const kernel = makeFakeKernel({ onSend: async () => ({ status: "complete", content: "" }) });
  const app = createTuiApp({
    root: await tmpRoot(), kernel, input: io.input, output: io.output,
    showDiffImpl: async () => "+added line\n-removed line"
  });
  const done = app.run();
  await until(() => io.text().includes("❯"));
  io.input.write("/diff\r");
  await until(() => io.text().includes("+added line"));
  io.input.write("/quit\r");
  await done;
});
```

- [ ] **Step 5: 跑红**

Run: `node --test tests/unit/tui/tui-app-slash.test.js`
Expected: FAIL(handleSlash 还是 unknown stub;helpers.js 不存在)

- [ ] **Step 6: 实现接线**

1. 把 T7 测试里的 `makeIO/makeFakeKernel/until/tmpRoot` 抽到 `tests/unit/tui/helpers.js`(内容原样,加 `export`),`tui-app.test.js` 改为从 helpers import。
2. `tui-app.js` 顶部加 import:

```js
import { SLASH_COMMANDS, filterCommands, parseSlash } from "./slash.js";
import { saveTuiPrefs } from "./prefs.js";
import { showDiff } from "../../git.js";
import { listChanges, formatChange } from "../../changes.js";
```

3. `createTuiApp` 参数加 `showDiffImpl = showDiff, listChangesImpl = listChanges, formatChangeImpl = formatChange`。
4. 在 `createTuiApp` 体内(`submit` 之前)定义处理器与菜单联动,并**整体替换** T7 的 `handleSlash` stub:

```js
  const diffLine = (l) =>
    l.startsWith("+") ? ` ${color.green(l)}` : l.startsWith("-") ? ` ${color.red(l)}` : ` ${color.dim(l)}`;

  const SLASH_HANDLERS = {
    help: async () => {
      pushLines([...activeCommands().map((c) => `  /${c.name.padEnd(9)} ${color.dim(T(c.descKey))}`), ""]);
    },
    lang: async (arg) => {
      const next = arg === "en" || arg === "zh" ? arg : (state.lang === "zh" ? "en" : "zh");
      t = makeT(next);
      dispatch({ type: "lang", lang: next });
      try {
        const prefs = await loadTuiPrefs(root);
        await saveTuiPrefs(root, { ...prefs, lang: next });
      } catch { /* 持久化失败不阻塞切换 */ }
      pushLines([` ${T("msg.langSet")}`, ""]);
    },
    mode: async (arg) => {
      const order = ["read-only", "gated", "auto"];
      const next = arg || order[(order.indexOf(state.mode) + 1) % order.length];
      if (!order.includes(next)) { pushLines([` ${color.red(T("msg.modeInvalid"))}`, ""]); return; }
      dispatch({ type: "mode", mode: next });
      pushLines([` ${T("msg.modeSet", { mode: next })}`, ""]);
    },
    clear: async () => { history = []; pushLines([` ${T("msg.cleared")}`, ""]); },
    diff: async () => {
      try {
        const diff = await showDiffImpl(root);
        pushLines(diff ? [...diff.split("\n").map(diffLine), ""] : [` ${color.dim(T("msg.noDiff"))}`, ""]);
      } catch (e) { pushLines([` ${color.red(T("ev.error"))}: ${e?.message || e}`, ""]); }
    },
    changes: async () => {
      try {
        const records = await listChangesImpl(root, 5);
        pushLines(records.length
          ? [...records.map((r) => formatChangeImpl(r)).join("\n\n---\n\n").split("\n").map((l) => ` ${l}`), ""]
          : [` ${color.dim(T("msg.noChanges"))}`, ""]);
      } catch (e) { pushLines([` ${color.red(T("ev.error"))}: ${e?.message || e}`, ""]); }
    },
    recovery: async (arg) => {
      if (!kernel?.recovery) { pushLines([` ${color.yellow(T("banner.offline"))}`, ""]); return; }
      const [action, id] = (arg || "").split(/\s+/).filter(Boolean);
      try {
        if (!action) {
          const report = (await kernel.recovery.report?.()) || { found: [], done: [], blocked: [] };
          const items = (await kernel.recovery.list?.()) || [];
          const lines = [` ${T("ev.recovery")}: found ${report.found.length} done ${report.done.length} blocked ${report.blocked.length}`];
          for (const item of items) lines.push(`   - ${item.id} (${item.type}, ${item.status}) ${color.dim(item.summary || "")}`);
          pushLines([...lines, ""]);
        } else if (action === "resume" && id) {
          const res = await kernel.recovery.resume(id, {});
          pushLines([` ${T("ev.recovery")} resume ${id}: ${res.status}`, ""]);
        } else if (action === "cancel" && id) {
          const res = await kernel.recovery.cancel(id);
          pushLines([` ${T("ev.recovery")} cancel ${id}: ${res?.status || "ok"}`, ""]);
        } else {
          pushLines([` ${color.dim("/recovery [resume|cancel] <id>")}`, ""]);
        }
      } catch (e) { pushLines([` ${color.red(T("ev.error"))}: ${e?.message || e}`, ""]); }
    },
    quit: async () => { dispatch({ type: "exit" }); }
  };

  // T13 会往 SLASH_HANDLERS 加 config;菜单项统一从这里取,保证注册表与处理器一致。
  function activeCommands() {
    return SLASH_COMMANDS.filter((c) => SLASH_HANDLERS[c.name]);
  }

  async function handleSlash(text) {
    dispatch({ type: "submit_local", line: ` ${color.cyan("❯")} ${text}` });
    const parsed = parseSlash(text);
    const handler = parsed && SLASH_HANDLERS[parsed.name];
    if (!handler) {
      pushLines([` ${color.yellow(T("msg.unknownSlash", { name: parsed?.name || "" }))}`, ""]);
      return;
    }
    await handler(parsed.arg);
  }

  function syncSlashMenu() {
    const text = state.input.text;
    if (text.startsWith("/") && !text.includes(" ")) {
      const items = filterCommands(text.slice(1))
        .filter((c) => SLASH_HANDLERS[c.name])
        .map((c) => ({ name: c.name, desc: T(c.descKey) }));
      dispatch({ type: "menu", menu: items.length ? { items, index: 0 } : null });
    } else if (state.menu) {
      dispatch({ type: "menu", menu: null });
    }
  }
```

5. `onKey` 的普通模式分支改造:菜单开着时 ↑↓/Tab/Enter/Esc 优先;字符/退格后调 `syncSlashMenu()`:

```js
    if (state.menu) {
      if (ev.type === "up") { dispatch({ type: "menu_move", delta: -1 }); return; }
      if (ev.type === "down") { dispatch({ type: "menu_move", delta: 1 }); return; }
      if (ev.type === "tab") {
        const item = state.menu.items[state.menu.index];
        dispatch({ type: "input_set", text: `/${item.name}` });
        dispatch({ type: "menu", menu: null });
        return;
      }
      if (ev.type === "enter") {
        const item = state.menu.items[state.menu.index];
        dispatch({ type: "input_set", text: `/${item.name}` });
        dispatch({ type: "menu", menu: null });
        submit();
        return;
      }
      if (ev.type === "esc") { dispatch({ type: "menu", menu: null }); return; }
    }
    switch (ev.type) {
      case "char": dispatch({ type: "input_insert", text: ev.text }); syncSlashMenu(); return;
      case "paste": dispatch({ type: "input_insert", text: ev.text }); syncSlashMenu(); return;
      case "backspace": dispatch({ type: "input_backspace" }); syncSlashMenu(); return;
      // enter/left/right/home/end/up/down/esc 分支保持 T7 原样
    }
```

6. check 脚本 TUI 段补 `src/apps/tui/slash.js`(Edit `package.json`,在 `src/apps/tui/prefs.js` 前插入)。

- [ ] **Step 7: 跑绿 + 回归**

Run: `node --test tests/unit/tui/slash.test.js tests/unit/tui/tui-app-slash.test.js tests/unit/tui/tui-app.test.js`
Expected: PASS(3+6+5 tests)
Run: `npm test && npm run check` → 全绿

- [ ] **Step 8: 提交**

```bash
git add src/apps/tui/slash.js src/apps/tui/tui-app.js tests/unit/tui/ package.json
git commit -m "feat(tui): slash command registry + completion menu + base commands (D5-M5)"
```

---

## Milestone M6 — /config 配置管理(与 GUI 共享)

### Task 10: `api-profiles` 迁移 `src/apps/`(ESM 化,GUI 动态 import 复用)

**Files:**
- Create: `src/apps/api-profiles.js`
- Delete: `gui/api-profiles.js`
- Modify: `gui/kernel-host.js`(require → 惰性动态 import 适配器)
- Modify: `tests/unit/gui/api-profiles.test.js`(import 路径)
- Modify: `package.json`(check 脚本:gui 组移除 `gui/api-profiles.js`,TUI 段补 `src/apps/api-profiles.js`)

**Interfaces:**
- Produces: `createApiProfiles({ dir }) → { list(), save(profile), remove(id), activate(id), getActive() }`(逻辑与 gui 版逐字节等价;存储文件名 `gui-api-profiles.json` **保留**,兼容既有数据)+ `maskKey(key) → "sk-…abcd" | "•••" | ""`。T13 与 gui/kernel-host 消费。
- gui 侧行为不变,由既有 `tests/unit/gui/*` 回归把关。

- [ ] **Step 1: 先改 gui 测试 import(红)**

`tests/unit/gui/api-profiles.test.js` 头部,删掉:

```js
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createApiProfiles } = require("../../../gui/api-profiles.js");
```

换成:

```js
import { createApiProfiles, maskKey } from "../../../src/apps/api-profiles.js";
```

并在文件末尾追加:

```js
test("maskKey masks all shapes", () => {
  assert.equal(maskKey(""), "");
  assert.equal(maskKey("short"), "•••");
  assert.equal(maskKey("sk-1234567890abcd"), "sk-…abcd");
});
```

Run: `node --test tests/unit/gui/api-profiles.test.js`
Expected: FAIL(`src/apps/api-profiles.js` 不存在)

- [ ] **Step 2: 创建 ESM 模块(逻辑照搬 gui 版,仅语法迁移 + maskKey)**

```js
// src/apps/api-profiles.js — 模型 API 配置列表(名称/baseUrl/apiKey/model),GUI 与 TUI 共享一份实现与存储。
// 存 .deepseek-code/(随仓忽略);激活时由调用方把凭据写进 config.json 供内核读(kernel 不变)。
// 存储文件名 gui-api-profiles.json 是历史遗留,保留以兼容既有用户数据。
import fsp from "node:fs/promises";
import path from "node:path";

export function createApiProfiles({ dir }) {
  const file = path.join(dir, "gui-api-profiles.json");

  async function load() {
    try {
      const raw = JSON.parse(await fsp.readFile(file, "utf8"));
      return {
        profiles: Array.isArray(raw.profiles) ? raw.profiles : [],
        activeId: raw.activeId || null,
        seq: Number.isInteger(raw.seq) ? raw.seq : 0
      };
    } catch {
      return { profiles: [], activeId: null, seq: 0 };
    }
  }

  async function persist(state) {
    await fsp.mkdir(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
    await fsp.rename(tmp, file);
  }

  async function list() { return (await load()).profiles; }

  async function save(profile) {
    const state = await load();
    let saved;
    if (profile.id && state.profiles.some((p) => p.id === profile.id)) {
      saved = { ...state.profiles.find((p) => p.id === profile.id), ...profile };
      state.profiles = state.profiles.map((p) => (p.id === profile.id ? saved : p));
    } else {
      state.seq += 1;
      saved = { ...profile, id: `p_${state.seq}` };
      state.profiles.push(saved);
    }
    await persist(state);
    return saved;
  }

  async function remove(id) {
    const state = await load();
    state.profiles = state.profiles.filter((p) => p.id !== id);
    if (state.activeId === id) state.activeId = null;
    await persist(state);
  }

  async function activate(id) {
    const state = await load();
    const target = state.profiles.find((p) => p.id === id);
    if (!target) throw new Error(`no such API profile: ${id}`);
    state.activeId = id;
    await persist(state);
    return target;
  }

  async function getActive() {
    const state = await load();
    return state.profiles.find((p) => p.id === state.activeId) || null;
  }

  return { list, save, remove, activate, getActive };
}

export function maskKey(key) {
  const k = String(key || "");
  if (!k) return "";
  if (k.length <= 8) return "•••";
  return `${k.slice(0, 3)}…${k.slice(-4)}`;
}
```

- [ ] **Step 3: gui/kernel-host.js 切换到共享模块**

1. 删除第 5 行 `const { createApiProfiles } = require("./api-profiles.js");`
2. 在顶部 `loadProviderMod` 等惰性加载器旁,按同一模式加:

```js
let apiProfilesModPromise = null;
function loadApiProfilesMod() {
  if (!apiProfilesModPromise) apiProfilesModPromise = import(pathToFileURL(path.join(__dirname, "..", "src", "apps", "api-profiles.js")).href);
  return apiProfilesModPromise;
}
```

3. 把 `const apiProfiles = createApiProfiles({ dir: path.join(projectRoot, ".deepseek-code") });` 替换为**异步适配器**(7 个调用点全是 async,无需改动):

```js
  const apiProfiles = (() => {
    let promise = null;
    const load = () => {
      if (!promise) promise = loadApiProfilesMod().then((m) => m.createApiProfiles({ dir: path.join(projectRoot, ".deepseek-code") }));
      return promise;
    };
    return {
      list: async () => (await load()).list(),
      save: async (p) => (await load()).save(p),
      remove: async (id) => (await load()).remove(id),
      activate: async (id) => (await load()).activate(id),
      getActive: async () => (await load()).getActive()
    };
  })();
```

4. 删除文件 `gui/api-profiles.js`:`git rm gui/api-profiles.js`

- [ ] **Step 4: check 脚本增删**

Edit `package.json` check:gui 组里删掉 `gui/api-profiles.js`(即 `gui/kernel-host.js gui/api-profiles.js gui/pty-host.js` → `gui/kernel-host.js gui/pty-host.js`);TUI 段追加 `src/apps/api-profiles.js`。

- [ ] **Step 5: 跑绿 + 回归**

Run: `node --test tests/unit/gui/api-profiles.test.js` → PASS
Run: `npm test && npm run check` → 全绿(gui kernel-host 既有单测覆盖惰性加载路径)

- [ ] **Step 6: 提交**

```bash
git add src/apps/api-profiles.js gui/kernel-host.js tests/unit/gui/api-profiles.test.js package.json
git rm gui/api-profiles.js 2>/dev/null; git add -u
git commit -m "refactor(apps): promote api-profiles to shared ESM module; gui reuses via dynamic import (D5-M6)"
```

### Task 11: `model-catalog.js` 抽取模型拉取

**Files:**
- Create: `src/apps/model-catalog.js`
- Modify: `gui/kernel-host.js`(`listModels` 的 fetch 体换成共享函数)
- Modify: `package.json`(check 脚本 TUI 段补 `src/apps/model-catalog.js`)
- Test: `tests/unit/apps/model-catalog.test.js`

**Interfaces:**
- Produces: `fetchModelIds({ baseUrl, apiKey, fetchImpl = globalThis.fetch }) → Promise<string[]>`。**无 apiKey 抛错、非 2xx 抛错、不设默认模型**(对齐 GUI 原则)。T13 与 gui/kernel-host 消费。

- [ ] **Step 1: 写失败测试**

```js
// tests/unit/apps/model-catalog.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { fetchModelIds } from "../../../src/apps/model-catalog.js";

test("fetches /models with bearer auth and maps ids", async () => {
  const calls = [];
  const ids = await fetchModelIds({
    baseUrl: "https://api.example.com/",
    apiKey: "sk-x",
    fetchImpl: async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, json: async () => ({ data: [{ id: "m1" }, { id: "m2" }, {}] }) };
    }
  });
  assert.deepEqual(ids, ["m1", "m2"]);
  assert.equal(calls[0].url, "https://api.example.com/models");
  assert.equal(calls[0].opts.headers.Authorization, "Bearer sk-x");
});

test("throws without api key", async () => {
  await assert.rejects(() => fetchModelIds({ baseUrl: "x", apiKey: "" }), /no API key/);
});

test("throws on non-2xx with status detail", async () => {
  await assert.rejects(
    () => fetchModelIds({ baseUrl: "b", apiKey: "k", fetchImpl: async () => ({ ok: false, status: 401, text: async () => "denied" }) }),
    /401 denied/
  );
});
```

- [ ] **Step 2: 跑红**

Run: `node --test tests/unit/apps/model-catalog.test.js` → FAIL

- [ ] **Step 3: 实现 + gui 接线**

```js
// src/apps/model-catalog.js — GET {baseUrl}/models 拉模型列表(Bearer)。不设默认、失败抛错;fetch 可注入。
export async function fetchModelIds({ baseUrl, apiKey, fetchImpl = globalThis.fetch } = {}) {
  if (!apiKey) throw new Error("no API key configured");
  const url = `${String(baseUrl || "https://api.deepseek.com").replace(/\/+$/, "")}/models`;
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) {
    const detail = res.text ? await res.text().catch(() => "") : "";
    throw new Error(`models fetch failed: ${res.status} ${detail}`.trim());
  }
  const body = await res.json();
  return (body.data || []).map((m) => m.id).filter(Boolean);
}
```

`gui/kernel-host.js`:加惰性加载器(同 T10 模式):

```js
let modelCatalogModPromise = null;
function loadModelCatalogMod() {
  if (!modelCatalogModPromise) modelCatalogModPromise = import(pathToFileURL(path.join(__dirname, "..", "src", "apps", "model-catalog.js")).href);
  return modelCatalogModPromise;
}
```

`listModels` 保留 profile 解析,fetch 体换共享函数(整函数替换为):

```js
  async function listModels(profileId, opts = {}) {
    let baseUrl = opts.baseUrl;
    let apiKey = opts.apiKey;
    if (!baseUrl || !apiKey) {
      const prof = profileId ? (await apiProfiles.list()).find((p) => p.id === profileId) : await apiProfiles.getActive();
      baseUrl = baseUrl || (prof && prof.baseUrl);
      apiKey = apiKey || (prof && prof.apiKey);
    }
    const m = await loadModelCatalogMod();
    return m.fetchModelIds({ baseUrl, apiKey, fetchImpl: opts.fetchImpl });
  }
```

check 脚本 TUI 段补 `src/apps/model-catalog.js`。

- [ ] **Step 4: 跑绿 + 回归**

Run: `node --test tests/unit/apps/model-catalog.test.js` → PASS;`npm test && npm run check` → 全绿

- [ ] **Step 5: 提交**

```bash
git add src/apps/model-catalog.js gui/kernel-host.js tests/unit/apps/model-catalog.test.js package.json
git commit -m "refactor(apps): extract shared model-catalog fetch; gui listModels reuses it (D5-M6)"
```

### Task 12: `config-flow.js` /config 状态机(纯)

**Files:**
- Create: `src/apps/tui/config-flow.js`
- Test: `tests/unit/tui/config-flow.test.js`

**Interfaces:**
- Consumes: `truncateToWidth/displayWidth`(T1)、`color`(theme);`maskKey` 由调用方传入 render(避免循环依赖)。
- Produces:
  - `CONFIG_ACTIONS = ["activate", "edit", "models", "test", "delete"]`
  - `CONFIG_FIELDS = ["name", "baseUrl", "apiKey", "model"]`
  - `initialConfigState({ profiles, activeId }) → cfg`,shape:`{ view:"list"|"actions"|"edit"|"models", profiles, activeId, index, actionIndex, draft, field, models, modelIndex, notice, error }`。`profiles` 是**原始记录**(TUI 直读共享存储;掩码只发生在 render)。
  - `reduceConfig(cfg, action) → cfg`(不可变;动作见测试:`cfg_profiles/cfg_move/cfg_view/cfg_draft_new/cfg_draft_edit/cfg_field_input/cfg_field_backspace/cfg_field_next/cfg_models/cfg_model_pick/cfg_notice/cfg_error`)
  - `renderConfigLines(cfg, t, maskKeyFn, columns) → { lines, cursorRow, cursorCol }`(cursorRow/Col 仅 edit 视图非 null,行号相对返回的 lines;**apiKey 字段值渲染为 `•` × 字符数,任何视图不出现明文**)
- T13 消费。

- [ ] **Step 1: 写失败测试**

```js
// tests/unit/tui/config-flow.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { CONFIG_ACTIONS, CONFIG_FIELDS, initialConfigState, reduceConfig, renderConfigLines } from "../../../src/apps/tui/config-flow.js";
import { maskKey } from "../../../src/apps/api-profiles.js";
import { makeT } from "../../../src/apps/tui/tui-i18n.js";

const t = makeT("zh");
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
const P = [{ id: "p_1", name: "main", baseUrl: "https://api.deepseek.com", apiKey: "sk-1234567890abcd", model: "deepseek-chat" }];

test("list view: rows + add-new entry, wrap navigation over profiles+1", () => {
  let cfg = initialConfigState({ profiles: P, activeId: "p_1" });
  assert.equal(cfg.view, "list");
  cfg = reduceConfig(cfg, { type: "cfg_move", delta: 1 }); // → 新增项
  assert.equal(cfg.index, 1);
  cfg = reduceConfig(cfg, { type: "cfg_move", delta: 1 }); // 回绕
  assert.equal(cfg.index, 0);
  const out = renderConfigLines(cfg, t, maskKey, 100);
  const text = out.lines.map(strip).join("\n");
  assert.match(text, /main/);
  assert.match(text, /●已激活/);
  assert.match(text, /sk-…abcd/);
  assert.match(text, /\+ 新增配置/);
  assert.doesNotMatch(text, /sk-1234567890abcd/);
  assert.equal(out.cursorRow, null);
});

test("draft edit: field input masked in render, field_next walks fields", () => {
  let cfg = initialConfigState({ profiles: [], activeId: null });
  cfg = reduceConfig(cfg, { type: "cfg_draft_new" });
  assert.equal(cfg.view, "edit");
  assert.deepEqual(CONFIG_FIELDS, ["name", "baseUrl", "apiKey", "model"]);
  cfg = reduceConfig(cfg, { type: "cfg_field_input", text: "p1" });
  cfg = reduceConfig(cfg, { type: "cfg_field_next" });
  cfg = reduceConfig(cfg, { type: "cfg_field_next" }); // 到 apiKey
  cfg = reduceConfig(cfg, { type: "cfg_field_input", text: "sk-secret" });
  cfg = reduceConfig(cfg, { type: "cfg_field_backspace" });
  assert.equal(cfg.draft.apiKey, "sk-secre");
  const out = renderConfigLines(cfg, t, maskKey, 100);
  const text = out.lines.map(strip).join("\n");
  assert.doesNotMatch(text, /sk-secre/);
  assert.match(text, /••••••••/); // 8 个掩码点
  assert.equal(typeof out.cursorRow, "number");
});

test("models view: pick writes draft.model and returns to edit", () => {
  let cfg = initialConfigState({ profiles: P, activeId: null });
  cfg = reduceConfig(cfg, { type: "cfg_draft_edit", profile: P[0] });
  cfg = reduceConfig(cfg, { type: "cfg_models", models: ["m1", "m2"] });
  assert.equal(cfg.view, "models");
  cfg = reduceConfig(cfg, { type: "cfg_move", delta: 1 });
  cfg = reduceConfig(cfg, { type: "cfg_model_pick" });
  assert.equal(cfg.view, "edit");
  assert.equal(cfg.draft.model, "m2");
});

test("actions view renders CONFIG_ACTIONS; error renders red line", () => {
  let cfg = initialConfigState({ profiles: P, activeId: null });
  cfg = reduceConfig(cfg, { type: "cfg_view", view: "actions" });
  let out = renderConfigLines(cfg, t, maskKey, 100).lines.map(strip).join("\n");
  for (const key of ["激活", "编辑", "拉取模型列表", "连接测试", "删除"]) assert.match(out, new RegExp(key));
  cfg = reduceConfig(cfg, { type: "cfg_error", error: "boom" });
  out = renderConfigLines(cfg, t, maskKey, 100).lines.map(strip).join("\n");
  assert.match(out, /boom/);
  assert.equal(CONFIG_ACTIONS.length, 5);
});
```

- [ ] **Step 2: 跑红**

Run: `node --test tests/unit/tui/config-flow.test.js` → FAIL

- [ ] **Step 3: 实现**

```js
// src/apps/tui/config-flow.js — /config 交互状态机(纯)。IO(读写存储/拉模型/测试/激活)全在 tui-app。
import { truncateToWidth } from "./ansi.js";
import { color } from "../../theme.js";

export const CONFIG_ACTIONS = ["activate", "edit", "models", "test", "delete"];
export const CONFIG_FIELDS = ["name", "baseUrl", "apiKey", "model"];

export function initialConfigState({ profiles = [], activeId = null } = {}) {
  return {
    view: "list", profiles, activeId,
    index: 0, actionIndex: 0,
    draft: null, field: 0,
    models: [], modelIndex: 0,
    notice: "", error: ""
  };
}

function wrap(index, delta, length) {
  if (!length) return 0;
  return ((index + delta) % length + length) % length;
}

export function reduceConfig(cfg, action = {}) {
  switch (action.type) {
    case "cfg_profiles": {
      const profiles = action.profiles || [];
      return { ...cfg, profiles, activeId: action.activeId ?? null, index: Math.min(cfg.index, profiles.length), view: "list", notice: cfg.notice, error: "" };
    }
    case "cfg_move": {
      if (cfg.view === "list") return { ...cfg, index: wrap(cfg.index, action.delta, cfg.profiles.length + 1) };
      if (cfg.view === "actions") return { ...cfg, actionIndex: wrap(cfg.actionIndex, action.delta, CONFIG_ACTIONS.length) };
      if (cfg.view === "models") return { ...cfg, modelIndex: wrap(cfg.modelIndex, action.delta, cfg.models.length) };
      return cfg;
    }
    case "cfg_view": return { ...cfg, view: action.view, actionIndex: 0, notice: "", error: "" };
    case "cfg_draft_new":
      return { ...cfg, view: "edit", field: 0, error: "", draft: { id: null, name: "", baseUrl: "https://api.deepseek.com", apiKey: "", model: "" } };
    case "cfg_draft_edit":
      return { ...cfg, view: "edit", field: 0, error: "", draft: { ...action.profile } };
    case "cfg_field_input": {
      const key = CONFIG_FIELDS[cfg.field];
      return { ...cfg, draft: { ...cfg.draft, [key]: String(cfg.draft[key] || "") + String(action.text || "").replace(/[\r\n]/g, "") } };
    }
    case "cfg_field_backspace": {
      const key = CONFIG_FIELDS[cfg.field];
      const value = Array.from(String(cfg.draft[key] || ""));
      value.pop();
      return { ...cfg, draft: { ...cfg.draft, [key]: value.join("") } };
    }
    case "cfg_field_next": return { ...cfg, field: Math.min(cfg.field + 1, CONFIG_FIELDS.length - 1) };
    case "cfg_models": return { ...cfg, view: "models", models: action.models || [], modelIndex: 0, error: "" };
    case "cfg_model_pick":
      return { ...cfg, view: "edit", draft: { ...cfg.draft, model: cfg.models[cfg.modelIndex] || cfg.draft.model } };
    case "cfg_notice": return { ...cfg, notice: String(action.notice || ""), error: "" };
    case "cfg_error": return { ...cfg, error: String(action.error || ""), notice: "" };
    default: return cfg;
  }
}

function row(selected, text, width) {
  const line = ` ${truncateToWidth(text, width - 2)}`;
  return selected ? color.inverse(line) : line;
}

export function renderConfigLines(cfg, t, maskKeyFn, columns) {
  const width = Math.max(30, Number(columns) || 80);
  const lines = [];
  let cursorRow = null;
  let cursorCol = null;

  if (cfg.view === "list") {
    lines.push(` ${color.bold(t("cfg.title"))}`);
    if (!cfg.profiles.length) lines.push(` ${color.dim(t("cfg.empty"))}`);
    cfg.profiles.forEach((p, i) => {
      const active = p.id === cfg.activeId ? ` ${color.green(t("cfg.active"))}` : "";
      lines.push(row(i === cfg.index, `${p.name || p.id} · ${p.baseUrl || "-"} · ${p.model || "-"} · ${maskKeyFn(p.apiKey)}${active}`, width));
    });
    lines.push(row(cfg.index === cfg.profiles.length, t("cfg.new"), width));
  } else if (cfg.view === "actions") {
    const profile = cfg.profiles[cfg.index] || {};
    lines.push(` ${color.bold(profile.name || profile.id || "?")}`);
    CONFIG_ACTIONS.forEach((name, i) => lines.push(row(i === cfg.actionIndex, t(`cfg.act.${name}`), width)));
  } else if (cfg.view === "edit") {
    lines.push(` ${color.dim(t("cfg.editHint"))}`);
    CONFIG_FIELDS.forEach((key, i) => {
      const raw = String(cfg.draft?.[key] || "");
      const shown = key === "apiKey" ? "•".repeat(Array.from(raw).length) : raw;
      const line = ` ${t(`cfg.field.${key}`)}: ${shown}`;
      lines.push(i === cfg.field ? color.bold(line) : line);
      if (i === cfg.field) {
        cursorRow = lines.length - 1;
        cursorCol = stripWidth(line) + 1;
      }
    });
  } else if (cfg.view === "models") {
    lines.push(` ${color.bold(t("cfg.modelsTitle"))}`);
    cfg.models.forEach((m, i) => lines.push(row(i === cfg.modelIndex, m, width)));
  }

  if (cfg.notice) lines.push(` ${color.green(truncateToWidth(cfg.notice, width - 2))}`);
  if (cfg.error) lines.push(` ${color.red(truncateToWidth(cfg.error, width - 2))}`);
  return { lines, cursorRow, cursorCol };
}

// 渲染行含 ANSI 包装;光标列按去码后的显示宽度算
import { displayWidth } from "./ansi.js";
function stripWidth(line) {
  return displayWidth(line.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ""));
}
```

(实现时把 `import { displayWidth }` 合并到顶部 import;此处分开写只为标注用途。)

- [ ] **Step 4: 跑绿**

Run: `node --test tests/unit/tui/config-flow.test.js` → PASS(4 tests)

- [ ] **Step 5: 提交**

```bash
git add src/apps/tui/config-flow.js tests/unit/tui/config-flow.test.js
git commit -m "feat(tui): /config pure state machine + masked rendering (D5-M6)"
```

### Task 13: `/config` 接线(共享存储/拉模型/测试/激活重建 kernel)

**Files:**
- Modify: `src/apps/tui/tui-app.js`(config 处理器 + modalHandler)
- Modify: `src/apps/tui/slash.js`(注册表加 `config`)
- Modify: `tests/unit/tui/slash.test.js`(命令集断言加 `config`)
- Modify: `package.json`(check 脚本 TUI 段补 `src/apps/tui/config-flow.js`)
- Test: `tests/unit/tui/tui-app-config.test.js`

**Interfaces:**
- Consumes: T10 `createApiProfiles/maskKey`、T11 `fetchModelIds`、T12 全部、`configureProject`(`src/config.js`)、`testDeepSeekConnection`(`src/provider.js`)、T7 `modalHandler` 扩展点。
- Produces: `createTuiApp` 新增可注入 `apiProfilesImpl = null`(默认 `createApiProfiles({ dir: <root>/.deepseek-code })`)、`fetchModelIdsImpl = fetchModelIds`、`testConnectionImpl = testDeepSeekConnection`、`configureProjectImpl = configureProject`。
- 行为:激活 = `activate(id)` → `configureProjectImpl(root, {apiKey, baseUrl, model?})` → **dispose 旧自建 kernel → createKernelImpl 重建 → 重新订阅**;`history` 原样保留;状态栏模型名更新。注入 kernel(非自建)时不 dispose 旧实例,但同样切换到新自建实例。

- [ ] **Step 1: 写失败测试**

```js
// tests/unit/tui/tui-app-config.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { createTuiApp } from "../../../src/apps/tui/tui-app.js";
import { createApiProfiles } from "../../../src/apps/api-profiles.js";
import { makeIO, makeFakeKernel, until, tmpRoot } from "./helpers.js";
import path from "node:path";

function fakeKernelFactory(log) {
  return async () => {
    log.created += 1;
    return makeFakeKernel({ onSend: async () => ({ status: "complete", content: "" }) });
  };
}

test("/config add-new flow saves profile to shared store; key never echoed", async () => {
  const io = makeIO();
  const root = await tmpRoot();
  const log = { created: 0 };
  const app = createTuiApp({
    root, input: io.input, output: io.output,
    createKernelImpl: fakeKernelFactory(log), buildKernelOptionsImpl: async () => ({})
  });
  const done = app.run();
  await until(() => io.text().includes("❯"));
  io.input.write("/config\r");
  await until(() => io.text().includes("+ 新增配置"));
  io.input.write("\r");                    // 选「新增」(空列表 index=0)
  await until(() => io.text().includes("名称"));
  io.input.write("p1\r");                  // name → 下一项
  io.input.write("\r");                    // baseUrl 保默认 → 下一项
  io.input.write("sk-1234567890abcd\r");   // apiKey → 下一项
  io.input.write("deepseek-chat\r");       // model,最后一项 Enter = 保存
  await until(() => io.text().includes("配置已保存"));
  assert.doesNotMatch(io.text(), /sk-1234567890abcd/); // 明文永不上屏
  const store = createApiProfiles({ dir: path.join(root, ".deepseek-code") });
  const profiles = await store.list();
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].apiKey, "sk-1234567890abcd"); // 明文只在盘上
  io.input.write("\x1b");                  // Esc 回列表
  io.input.write("\x1b");                  // Esc 关闭 config
  io.input.write("\x03"); io.input.write("\x03");
  await done;
});

test("activate writes config and rebuilds kernel keeping history", async () => {
  const io = makeIO();
  const root = await tmpRoot();
  const store = createApiProfiles({ dir: path.join(root, ".deepseek-code") });
  const saved = await store.save({ name: "main", baseUrl: "https://x", apiKey: "sk-aaaaaaaaaa", model: "m9" });
  const log = { created: 0 };
  const patches = [];
  const app = createTuiApp({
    root, input: io.input, output: io.output,
    createKernelImpl: fakeKernelFactory(log), buildKernelOptionsImpl: async () => ({}),
    configureProjectImpl: async (r, patch) => { patches.push(patch); return { target: "x", config: patch }; }
  });
  const done = app.run();
  await until(() => log.created === 1);
  io.input.write("/config\r");
  await until(() => io.text().includes("main"));
  io.input.write("\r");                    // 选中 profile → actions
  await until(() => io.text().includes("激活"));
  io.input.write("\r");                    // 激活(actionIndex=0)
  await until(() => io.text().includes("已激活:main"));
  assert.equal(patches[0].apiKey, "sk-aaaaaaaaaa");
  assert.equal(patches[0].model, "m9");
  assert.equal(log.created, 2);            // kernel 重建
  assert.equal((await store.getActive()).id, saved.id);
  io.input.write("\x03"); io.input.write("\x03");
  await done;
});

test("models fetch failure shows red error, no default injected", async () => {
  const io = makeIO();
  const root = await tmpRoot();
  const store = createApiProfiles({ dir: path.join(root, ".deepseek-code") });
  await store.save({ name: "main", baseUrl: "https://x", apiKey: "sk-bbbbbbbbbb", model: "" });
  const log = { created: 0 };
  const app = createTuiApp({
    root, input: io.input, output: io.output,
    createKernelImpl: fakeKernelFactory(log), buildKernelOptionsImpl: async () => ({}),
    fetchModelIdsImpl: async () => { throw new Error("401 denied"); }
  });
  const done = app.run();
  await until(() => io.text().includes("❯"));
  io.input.write("/config\r");
  await until(() => io.text().includes("main"));
  io.input.write("\r");
  await until(() => io.text().includes("拉取模型列表"));
  io.input.write("\x1b[B\x1b[B");          // ↓↓ 到「拉取模型列表」
  io.input.write("\r");
  await until(() => io.text().includes("模型拉取失败"));
  assert.match(io.text(), /401 denied/);
  io.input.write("\x03"); io.input.write("\x03");
  await done;
});

test("connection test success shows notice", async () => {
  const io = makeIO();
  const root = await tmpRoot();
  const store = createApiProfiles({ dir: path.join(root, ".deepseek-code") });
  await store.save({ name: "main", baseUrl: "https://x", apiKey: "sk-cccccccccc", model: "m" });
  const app = createTuiApp({
    root, input: io.input, output: io.output,
    createKernelImpl: fakeKernelFactory({ created: 0 }), buildKernelOptionsImpl: async () => ({}),
    testConnectionImpl: async () => true
  });
  const done = app.run();
  await until(() => io.text().includes("❯"));
  io.input.write("/config\r");
  await until(() => io.text().includes("main"));
  io.input.write("\r");
  io.input.write("\x1b[B\x1b[B\x1b[B");    // ↓↓↓ 到「连接测试」
  io.input.write("\r");
  await until(() => io.text().includes("连接测试通过"));
  io.input.write("\x03"); io.input.write("\x03");
  await done;
});
```

- [ ] **Step 2: 跑红**

Run: `node --test tests/unit/tui/tui-app-config.test.js` → FAIL(/config 未注册)

- [ ] **Step 3: 实现接线**

1. `slash.js`:`SLASH_COMMANDS` 在 `help` 后插入 `{ name: "config", descKey: "slash.config.desc" }`;`tests/unit/tui/slash.test.js` 期望数组同步加 `"config"`。
2. `tui-app.js` 顶部 import:

```js
import path from "node:path";
import { createApiProfiles, maskKey } from "../api-profiles.js";
import { fetchModelIds } from "../model-catalog.js";
import { testDeepSeekConnection } from "../../provider.js";
import { configureProject } from "../../config.js";
import { CONFIG_ACTIONS, CONFIG_FIELDS, initialConfigState, reduceConfig, renderConfigLines } from "./config-flow.js";
```

3. `createTuiApp` 参数加 `apiProfilesImpl = null, fetchModelIdsImpl = fetchModelIds, testConnectionImpl = testDeepSeekConnection, configureProjectImpl = configureProject`;体内:

```js
  const profilesStore = apiProfilesImpl || createApiProfiles({ dir: path.join(root, ".deepseek-code") });
  let cfgState = null;

  function syncConfigOverlay() {
    if (!cfgState) { modalHandler = null; dispatch({ type: "overlay", overlay: null }); return; }
    dispatch({ type: "overlay", overlay: renderConfigLines(cfgState, T, maskKey, columns()) });
  }

  function cfgDispatch(action) { cfgState = reduceConfig(cfgState, action); syncConfigOverlay(); }

  async function refreshCfgProfiles() {
    const profiles = await profilesStore.list();
    const active = await profilesStore.getActive();
    cfgDispatch({ type: "cfg_profiles", profiles, activeId: active ? active.id : null });
  }

  async function activateProfile(profile) {
    try {
      const prof = await profilesStore.activate(profile.id);
      await configureProjectImpl(root, { apiKey: prof.apiKey, baseUrl: prof.baseUrl, ...(prof.model ? { model: prof.model } : {}) });
      subscription?.unsubscribe?.();
      if (ownKernel && kernel?.dispose) await kernel.dispose().catch(() => {});
      try {
        kernel = await createKernelImpl(root, await buildKernelOptionsImpl(root));
        ownKernel = true;
      } catch { kernel = null; }
      subscribeKernel();
      dispatch({ type: "status", patch: { model: prof.model || "" } });
      cfgDispatch({ type: "cfg_notice", notice: T("cfg.activated", { name: prof.name || prof.id }) });
      await refreshCfgProfiles();
      cfgDispatch({ type: "cfg_notice", notice: T("cfg.activated", { name: prof.name || prof.id }) });
    } catch (e) { cfgDispatch({ type: "cfg_error", error: `${e?.message || e}` }); }
  }

  async function runConfigAction(name, profile) {
    if (name === "activate") { await activateProfile(profile); return; }
    if (name === "edit") { cfgDispatch({ type: "cfg_draft_edit", profile }); return; }
    if (name === "models") {
      cfgDispatch({ type: "cfg_draft_edit", profile });
      try {
        const models = await fetchModelIdsImpl({ baseUrl: profile.baseUrl, apiKey: profile.apiKey });
        if (!models.length) { cfgDispatch({ type: "cfg_error", error: T("cfg.modelsEmpty") }); return; }
        cfgDispatch({ type: "cfg_models", models });
      } catch (e) { cfgDispatch({ type: "cfg_error", error: T("cfg.modelsFail", { err: e?.message || e }) }); }
      return;
    }
    if (name === "test") {
      try {
        await testConnectionImpl({ apiKey: profile.apiKey, baseUrl: profile.baseUrl });
        cfgDispatch({ type: "cfg_notice", notice: T("cfg.testOk") });
      } catch (e) { cfgDispatch({ type: "cfg_error", error: T("cfg.testFail", { err: e?.message || e }) }); }
      return;
    }
    if (name === "delete") {
      await profilesStore.remove(profile.id);
      cfgDispatch({ type: "cfg_notice", notice: T("cfg.deleted") });
      await refreshCfgProfiles();
    }
  }

  async function saveDraft() {
    const draft = cfgState.draft;
    const saved = await profilesStore.save(draft);
    await refreshCfgProfiles();
    cfgDispatch({ type: "cfg_notice", notice: T("cfg.saved", { name: saved.name || saved.id }) });
  }

  function configKeys(ev) {
    if (!cfgState) return;
    if (ev.type === "esc") {
      if (cfgState.view === "list") { cfgState = null; syncConfigOverlay(); return; }
      if (cfgState.view === "models") { cfgDispatch({ type: "cfg_view", view: "edit" }); return; }
      cfgDispatch({ type: "cfg_view", view: "list" });
      return;
    }
    if (ev.type === "up") { cfgDispatch({ type: "cfg_move", delta: -1 }); return; }
    if (ev.type === "down") { cfgDispatch({ type: "cfg_move", delta: 1 }); return; }
    if (ev.type === "char" || ev.type === "paste") {
      if (cfgState.view === "edit") cfgDispatch({ type: "cfg_field_input", text: ev.text });
      return;
    }
    if (ev.type === "backspace") {
      if (cfgState.view === "edit") cfgDispatch({ type: "cfg_field_backspace" });
      return;
    }
    if (ev.type !== "enter") return;
    if (cfgState.view === "list") {
      if (cfgState.index === cfgState.profiles.length) { cfgDispatch({ type: "cfg_draft_new" }); return; }
      cfgDispatch({ type: "cfg_view", view: "actions" });
      return;
    }
    if (cfgState.view === "actions") {
      const profile = cfgState.profiles[cfgState.index];
      void runConfigAction(CONFIG_ACTIONS[cfgState.actionIndex], profile);
      return;
    }
    if (cfgState.view === "edit") {
      if (cfgState.field < CONFIG_FIELDS.length - 1) { cfgDispatch({ type: "cfg_field_next" }); return; }
      void saveDraft();
      return;
    }
    if (cfgState.view === "models") { cfgDispatch({ type: "cfg_model_pick" }); return; }
  }
```

4. `SLASH_HANDLERS` 加:

```js
    config: async () => {
      cfgState = initialConfigState({ profiles: await profilesStore.list(), activeId: (await profilesStore.getActive())?.id || null });
      modalHandler = configKeys;
      syncConfigOverlay();
    },
```

(注意 `saveDraft` 后停在 list 视图——`refreshCfgProfiles` 已切回;`cfg.saved` 的 notice 在 refresh 后再补一次,与 `activateProfile` 同法。)

5. check 脚本 TUI 段补 `src/apps/tui/config-flow.js`。

- [ ] **Step 4: 跑绿 + 回归**

Run: `node --test tests/unit/tui/` → PASS(全部 TUI 测试)
Run: `npm test && npm run check` → 全绿

- [ ] **Step 5: 提交**

```bash
git add src/apps/tui/tui-app.js src/apps/tui/slash.js tests/unit/tui/ package.json
git commit -m "feat(tui): /config profile management wired to shared store; activate rebuilds kernel (D5-M6)"
```

---

## Milestone M7 — 收口

### Task 14: 门控真终端 smoke

**Files:**
- Create: `tests/e2e/tui-smoke.test.js`

**Interfaces:**
- Consumes: `gui/node_modules/node-pty`(**仅当已安装**;未装 skip——对齐 gui 门控 smoke 哲学,主包零新增依赖)。
- Produces: 真 pty 里跑 `bin/deepseek-code.js tui`:启动(offline 分支,不出网)→ `/help` 渲染 → `/quit` 退出且终端态恢复(以 `pasteOff` 序列为标志)。

- [ ] **Step 1: 写测试(门控,天然先绿于 skip 分支)**

```js
// tests/e2e/tui-smoke.test.js — 门控真终端 smoke:装了 gui 的 node-pty 才跑,否则优雅 skip。
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

let pty = null;
try { pty = require(path.join(repoRoot, "gui", "node_modules", "node-pty")); } catch { pty = null; }

test("tui smoke: boots offline, /help renders, /quit restores terminal", { skip: !pty && "gui node-pty not installed" }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-tui-smoke-"));
  const term = pty.spawn(process.execPath, [path.join(repoRoot, "bin", "deepseek-code.js"), "tui"], {
    name: "xterm-256color", cols: 100, rows: 30, cwd: root,
    env: { ...process.env, NO_COLOR: "1" }
  });
  let out = "";
  term.onData((d) => { out += d; });
  const waitFor = async (fn, ms = 15000) => {
    const start = Date.now();
    while (!fn()) {
      if (Date.now() - start > ms) throw new Error(`smoke timeout; tail:\n${out.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  await waitFor(() => out.includes("❯"));            // 底部输入行出现
  term.write("/help\r");
  await waitFor(() => out.includes("/quit"));         // 命令列表渲染
  assert.ok(out.includes("/mode"));
  term.write("/quit\r");
  await waitFor(() => out.includes("\x1b[?2004l")); // 括号粘贴关闭 = 终端态恢复
  await new Promise((resolve) => term.onExit(resolve));
});
```

- [ ] **Step 2: 两种环境各验一次**

Run(未装 gui deps 的环境): `node --test tests/e2e/tui-smoke.test.js` → SKIP(原因可见)
Run(装了 gui deps): `node --test tests/e2e/tui-smoke.test.js` → PASS
(本机已有 `gui/node_modules`,应走 PASS 分支;临时目录无 config → offline 分支,全程不出网。)

- [ ] **Step 3: 提交**

```bash
git add tests/e2e/tui-smoke.test.js
git commit -m "test(tui): gated real-pty smoke (boot + /help + /quit restore) (D5-M7)"
```

### Task 15: 全量回归 + 文档收口 + ship 提交

**Files:**
- Modify: `docs/project-overview.md` · `docs/CHANGELOG.md` · `README.md` · `README.en.md` · `docs/README.md`

- [ ] **Step 1: 全量回归取数**

Run: `npm test`(记录总数,应为 847 − 2(旧 tui-metrics)+ 本计划新增 ≈ 90+,全绿)与 `npm run check` → exit 0;`git diff --check` 干净。

- [ ] **Step 2: 文档收口**(按更新顺序:overview → CHANGELOG → README 中英 → 索引;叙述性文档给要点,要点即验收项)

1. `docs/project-overview.md`:定位 TUI 描述(`grep -n "tui\|TUI" docs/project-overview.md`),把旧菜单循环描述替换为 D-5 形态要点:行内滚动流(历史进原生滚动区,底部输入/状态栏固定重绘)· 流式 `onDelta`(kernel 零改动,options 透传)· 审批 y/n/Esc · slash 命令(help/config/diff/changes/mode/lang/clear/recovery/quit + 补全菜单)· `/config` 与 GUI **共享** `src/apps/api-profiles.js`(gui/kernel-host 动态 import;激活写 config.json 并重建 kernel、history 保留)· zh/en 双语(`tui-prefs.json` 持久化)· 零依赖手写 ANSI · 测试策略(纯层 node:test + 注入流全链路 + 门控 pty smoke)。安全不变量补一句:TUI 渲染路径只出现密钥掩码。
2. `docs/CHANGELOG.md`:置顶新条目 `### 已落地 — Phase D-5 TUI 重设计(行内滚动流 agent 会话)`,要点同上 + 测试数 + 链接 `plans/frontend/2026-07-06-v3-phase-d5-tui-redesign.md` 与 `specs/frontend/2026-07-06-v3-phase-d5-tui-redesign-design.md`。
3. `README.md` + `README.en.md`:TUI 段(`grep -n "tui" README.md README.en.md`)更新为一段话:全屏 agent 会话式 TUI(流式回复 / 工具与 diff 卡片 / 审批 / slash 命令 / 与 GUI 共享的 API 列表管理),中英同步。
4. `docs/README.md`:specs/frontend 与 plans/frontend 索引各加 D-5 一行(格式对齐 D-4 行)。

- [ ] **Step 3: ship 提交**(现行署名规则:**不加** Co-Authored-By)

```bash
git add docs/project-overview.md docs/CHANGELOG.md README.md README.en.md docs/README.md
git commit -m "docs: ship V3 Phase D-5 TUI redesign (inline agent-session TUI)"
```

---

## Self-Review

- **Spec 覆盖**:§2 决策 1(范围)→ T9 命令集 + 非目标不进 TUI;决策 2(双语+prefs)→ T3/T7/T9(/lang);决策 3(零依赖)→ Global Constraints 1 + 全部手写模块;决策 4(行内流)→ T6 painter 协议;决策 5(/config 共享)→ T10–T13;决策 6(默认 gated)→ T4 initialTuiState/T7 send;决策 7(kernel 零改动+onDelta)→ T7 send options,无任何 src 核心改动任务。§3 模块表 ↔ 文件地图逐一对应(9 模块 + 2 共享 + 入口)。§4 交互(mockup/审批/slash 菜单/流式降级/中断两分支/Resize/非 TTY)→ T6/T7/T8/T9;中断走降级分支(runtime 的 AbortController 为内部实现,`send` 不收外部 signal,已核实)。§5 数据流 → T7(事件路/发送路/history 归 app)。§6 → T10(迁移+文件名保留)/T11(listModels 抽取)/T12+T13(交互与激活重建)。§7 安全边界 → 约束 5/6 + T12 掩码渲染测试 + T13 明文不上屏断言 + T7 清理路径。§8 测试策略 → 各 Task 红绿步 + T14 门控 smoke。§9 里程碑 ↔ 映射行。§10 硬约束 → Global Constraints 1–7 逐条。无缺口。
- **占位符扫描**:无 TBD/TODO/「类似 Task N」;每个代码步给出完整代码;T15 叙述性文档按仓库惯例给要点清单(D-3/D-4 同法)。两处标注性说明(T12 底部 import 合并注记、T13 activateProfile 的 notice 双写属保守冗余)是实现提示,非占位。
- **类型一致性**:按键 Event 形状 T2 产 / T7 消费一致;`menu {items:[{name,desc}], index}` 与 `overlay {lines, cursorRow, cursorCol}` T4 定义 / T6 渲染 / T9、T13 灌入一致;`computeBottom` 返回 `{lines, cursorRow, cursorCol}` 而 painter 收 `{append, bottom, cursorRow, cursorCol}`(T7 调用处 `{ append, ...bottom, bottom: bottom.lines }` 已对齐);`fetchModelIds({baseUrl, apiKey, fetchImpl})` T11 产 / T13 消费一致;`maskKey` T10 产 / T12 render 参数 / T13 传入一致;`makeIO/makeFakeKernel/until/tmpRoot` 在 T9 抽到 `tests/unit/tui/helpers.js` 后由三个 app 测试文件共用;`SLASH_COMMANDS` 的 config 条目在 T13 加入且 slash.test.js 断言同步更新。
- **降级路径**:无 kernel(offline 横幅 + /config /help 可用)· onDelta 无流(spinner + 事件行)· 拉模型失败红字不设默认 · prefs 读写失败不阻塞 · 未识别按键/CSI 丢弃 · 未知事件 dim 单行 · 门控 smoke 未装 pty 即 skip。
