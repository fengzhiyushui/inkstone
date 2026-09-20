# V3 Phase D-4 · GUI agent 改动跟踪 实施计划

> 完成状态以 [CHANGELOG](../../CHANGELOG.md) 为准。

> 纯逻辑(M1 桥 / M2 派生+reducer)node:test 内联先跑;UI(M3/M4)走 `cd gui && npm run build:renderer`;M5 门控 smoke + 全量回归。
> 提交前**单独验证绿**(勿用 `npm test | grep` 吞退出码后直接提交)。
>
> 设计 spec:[2026-07-02-v3-phase-d4-change-tracking-design.md](../../specs/frontend/2026-07-02-v3-phase-d4-change-tracking-design.md)。

**Goal:** GUI 里看到 agent 改了哪些文件/位置(SCM「AGENT 改动」分区 + Agent 卡片)→ 点击看该次改动 before↔after 对比(记录内全文,方案 C)→ hunk 级跳转到编辑器对应行。

**Architecture:** kernel(`src/`)零改动。kernel-host 动态 import `src/edits/change-store.js`(list/describe)+ `src/patch.js`(parseUnifiedDiff 算 +/−/hunkStarts),列表瘦身(剥 before/after/diff 全文)、describe 回单文件切片;`.deepseek-code/rollbacks.jsonl` 打已回滚标。渲染层纯函数派生(来源标签/状态字母/clamp)+ reducer 新状态(changes/changesTick/changeDiff/pendingReveal);SCM 第三分区 + ChangeDiffView(复用 DiffView/Monaco DiffEditor)+ revealLineInCenter 跳转。顺手修 agent-cards/panels-derive 读不存在字段的真 bug。

**Tech Stack:** React19 + Vite7 + Monaco DiffEditor · node:test · 复用 `src/edits/change-store.js` / `src/patch.js`。

## Global Constraints(每 Task 隐含遵守)
- **kernel(`src/`)零改动**;新增只在 `gui/`(src 工具经 dynamic import 复用)。
- **大文本不滥载**:`listChanges` 输出**必须不含** `files[].before/after` 与 `diff` 全文;前后全文仅 `describeChange` 单文件切片按需过 IPC。
- **只读**:GUI 侧对 `.deepseek-code/changes/` 与 `rollbacks.jsonl` 只读,绝不写(smoke 种子记录除外,写后即删)。
- **来源识别约定**:prompt 前缀 `"GUI edit "` → `manual`,其余 → `agent`(kernel-host `writeFile` 自有约定)。
- **优雅降级**:无桥 / list 失败 / describe 失败 / diff 解析失败 / 记录缺字段 → 提示或缺省显示(计数为 null 时省略),不崩。
- **双语**:新文案 zh/en 都入 `gui/src/i18n/strings.js`(zh 默认)。
- 验证命令:单测 `node --test <file>`;全量 `npm test`(基线 ≥837 全绿);检查 `npm run check`;渲染层 `cd gui && npm run build:renderer`;门控 smoke `cd gui; $env:DEEPSEEK_CODE_GUI_SMOKE="1"; npx electron .`(期望 stdout `GUI_SMOKE_READY`)。

---

## File Structure(增量)

| 文件 | 责任 | 动作 |
|------|------|------|
| `gui/kernel-host.js` | `listChanges`(瘦身+富化+rollback 标)/ `describeChange`(单文件切片) | 改 |
| `gui/main.js` · `gui/preload.js` | IPC `changes:list` / `changes:describe`;M5 smoke 扩展 | 改 |
| `gui/src/state/changes-derive.js` | `deriveChangeEntries` / `statusLetter` / `clampLine` / `shortTime` 纯函数 | 新建 |
| `gui/src/state/workbench-state.js` | `changes/changesTick/changeDiff/pendingReveal` 状态 + 5 新 action | 改 |
| `gui/src/state/agent-cards.js` · `gui/src/state/panels-derive.js` | 修 `file:diff_applied` 真实字段(change_id/files/summary) | 改 |
| `gui/src/hooks/useKernel.js` | `refreshChanges/openChangeDiff/dismissChangeDiff/revealInEditor` | 改 |
| `gui/src/components/Explorer.jsx` | SCM 第三分区「AGENT 改动」 | 改 |
| `gui/src/components/DiffView.jsx` | 加可选 `title`/`actions` props(向后兼容) | 改 |
| `gui/src/components/ChangeDiffView.jsx` | 改动对比(hunk chips + 跳到编辑器 + 错误态) | 新建 |
| `gui/src/components/EditorGroup.jsx` | changeDiff 渲染优先 + pendingReveal 效果(revealLineInCenter) | 改 |
| `gui/src/components/AgentPanel.jsx` | diff 卡片可点(带 changeId) | 改 |
| `gui/src/App.jsx` | changesTick→refresh 接线 + 新 props 下发 | 改 |
| `gui/src/i18n/strings.js` · `gui/src/styles/theme.css` | `changes.*` 双语文案 + 小样式 | 改 |
| `tests/unit/gui/kernel-host-changes.test.js` · `tests/unit/gui/changes-derive.test.js` | 新单测 | 新建 |
| `tests/unit/gui/{agent-cards,panels-derive,workbench-state,i18n}.test.js` | 更新/追加断言 | 改 |
| docs(overview/CHANGELOG/README 中英/docs/README) | 收口 | 改 |

---

## Task D4-M1 · kernel-host 只读改动桥 + IPC/preload(内联纯逻辑)

**Files:**
- Modify: `gui/kernel-host.js`(顶部 lazy loader 区 + `createKernelHost` 内 + return 对象)
- Modify: `gui/main.js`(`IPC_CHANNELS` 数组 + `registerIpcHandlers` 的 `wrap` 区)
- Modify: `gui/preload.js`
- Test: `tests/unit/gui/kernel-host-changes.test.js`(新建)

**Interfaces:**
- Consumes: `createChangeStore({projectRoot})`→`.list({limit})/.describe({change_id})`(`src/edits/change-store.js`);`parseUnifiedDiff(diff)`→`[{oldPath,newPath,hunks:[{newStart,lines:[{type,text}]}]}]`(`src/patch.js`);kernel-host 现成 `languageForExt(rel)`。
- Produces(后续 Task 依赖的确切形状):
  - `host.listChanges({limit=50})` → `Promise<[{id, time, prompt, rolledBack, files:[{path, status, added:number|null, removed:number|null, hunkStarts:number[]|null}]}]>`(time 倒序)
  - `host.describeChange(changeId, relPath?)` → `Promise<{id, time, prompt, rolledBack, file:{path, status, before:string|null, after:string|null, language, added, removed, hunkStarts}}>`(relPath 缺省取首文件;changeId 缺省 `"latest"`;找不到 → throw)
  - preload:`window.deepseek.listChanges(limit)` / `window.deepseek.describeChange(id, relPath)`(经 `wrap`,错误回 `{error}`)

- [ ] **Step 1: 写失败测试** `tests/unit/gui/kernel-host-changes.test.js`

```js
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createKernelHost } = require("../../../gui/kernel-host.js");

const DIFF_A = [
  "--- a/src/a.js",
  "+++ b/src/a.js",
  "@@ -1,2 +1,3 @@",
  " line1",
  "-old",
  "+new",
  "+added",
  ""
].join("\n");

async function tmpProject() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-chg-"));
  await fs.mkdir(path.join(root, ".deepseek-code", "changes"), { recursive: true });
  return root;
}

async function seedChange(root, record) {
  const target = path.join(root, ".deepseek-code", "changes", `${record.id}.json`);
  await fs.writeFile(target, JSON.stringify(record, null, 2), "utf8");
}

function makeRecord(overrides = {}) {
  return {
    id: "20260702090000-aaaaaa",
    time: "2026-07-02T09:00:00.000Z",
    prompt: "agent edits a",
    diff: DIFF_A,
    summary: [{ path: "src/a.js", status: "modify" }],
    files: [{
      path: "src/a.js", oldPath: "src/a.js", newPath: "src/a.js", status: "modify",
      before: "SECRET_BEFORE_TEXT", after: "SECRET_AFTER_TEXT"
    }],
    ...overrides
  };
}

test("listChanges slims records, enriches counts/hunkStarts, marks rollbacks", async () => {
  const root = await tmpProject();
  await seedChange(root, makeRecord());
  await seedChange(root, makeRecord({
    id: "20260702100000-bbbbbb", time: "2026-07-02T10:00:00.000Z", prompt: "GUI edit src/a.js"
  }));
  await fs.writeFile(path.join(root, ".deepseek-code", "rollbacks.jsonl"),
    `${JSON.stringify({ time: "2026-07-02T11:00:00.000Z", id: "20260702090000-aaaaaa", forced: false })}\n`, "utf8");

  const host = createKernelHost({ projectRoot: root });
  const list = await host.listChanges();
  assert.equal(list.length, 2);
  assert.equal(list[0].id, "20260702100000-bbbbbb"); // time desc
  const f = list[1].files[0];
  assert.equal(f.added, 2);
  assert.equal(f.removed, 1);
  assert.deepEqual(f.hunkStarts, [1]);
  assert.equal(list[1].rolledBack, true);
  assert.equal(list[0].rolledBack, false);
  const text = JSON.stringify(list);
  assert.ok(!text.includes("SECRET_BEFORE_TEXT"), "list must not carry before text");
  assert.ok(!text.includes("SECRET_AFTER_TEXT"), "list must not carry after text");
  assert.ok(!text.includes("@@ -1,2 +1,3 @@"), "list must not carry raw diff");
});

test("describeChange returns single-file slice with before/after + language", async () => {
  const root = await tmpProject();
  await seedChange(root, makeRecord());
  const host = createKernelHost({ projectRoot: root });
  const d = await host.describeChange("20260702090000-aaaaaa", "src/a.js");
  assert.equal(d.id, "20260702090000-aaaaaa");
  assert.equal(d.file.path, "src/a.js");
  assert.equal(d.file.before, "SECRET_BEFORE_TEXT");
  assert.equal(d.file.after, "SECRET_AFTER_TEXT");
  assert.equal(d.file.language, "javascript");
  assert.deepEqual(d.file.hunkStarts, [1]);
  // relPath 缺省 → 首文件;changeId 缺省 → latest
  assert.equal((await host.describeChange("20260702090000-aaaaaa")).file.path, "src/a.js");
  assert.equal((await host.describeChange(null)).id, "20260702090000-aaaaaa");
  await assert.rejects(() => host.describeChange("20260702090000-aaaaaa", "src/missing.js"));
  await assert.rejects(() => host.describeChange("no-such-id"));
});

test("graceful: no changes dir → [], unparseable diff → null counts", async () => {
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-chg-"));
  const host0 = createKernelHost({ projectRoot: empty });
  assert.deepEqual(await host0.listChanges(), []);

  const root = await tmpProject();
  await seedChange(root, makeRecord({ diff: "not a diff at all" }));
  const host = createKernelHost({ projectRoot: root });
  const list = await host.listChanges();
  assert.equal(list.length, 1);
  assert.equal(list[0].files[0].added, null);
  assert.equal(list[0].files[0].hunkStarts, null);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/unit/gui/kernel-host-changes.test.js`
Expected: FAIL(`host.listChanges is not a function`)

- [ ] **Step 3: 实现 kernel-host**(`gui/kernel-host.js`)

顶部 lazy loader 区(`loadSaveDiffMod` 之后)加:

```js
let changeStoreModPromise = null;
function loadChangeStoreMod() {
  if (!changeStoreModPromise) changeStoreModPromise = import(pathToFileURL(path.join(__dirname, "..", "src", "edits", "change-store.js")).href);
  return changeStoreModPromise;
}
let patchModPromise = null;
function loadPatchMod() {
  if (!patchModPromise) patchModPromise = import(pathToFileURL(path.join(__dirname, "..", "src", "patch.js")).href);
  return patchModPromise;
}
```

`createKernelHost` 内(`writeFile` 之后)加:

```js
  // D-4 read-only change-tracking bridge. Reads .deepseek-code/changes/ via the
  // kernel's own change-store (never writes); full before/after texts only leave
  // the main process one file at a time (describeChange slice).
  let changeStore = null;
  async function getChangeStore() {
    if (!changeStore) {
      const { createChangeStore } = await loadChangeStoreMod();
      changeStore = createChangeStore({ projectRoot });
    }
    return changeStore;
  }

  async function readRolledBackIds() {
    try {
      const raw = await fs.readFile(path.join(projectRoot, ".deepseek-code", "rollbacks.jsonl"), "utf8");
      const ids = new Set();
      for (const line of raw.split(/\r?\n/)) {
        const s = line.trim();
        if (!s) continue;
        try { const j = JSON.parse(s); if (j && j.id) ids.add(j.id); } catch { /* skip bad line */ }
      }
      return ids;
    } catch { return new Set(); }
  }

  function diffFileStats(parseUnifiedDiff, diff) {
    const map = new Map();
    try {
      for (const patch of parseUnifiedDiff(String(diff || ""))) {
        const p = patch.newPath === "/dev/null" ? patch.oldPath : patch.newPath;
        let added = 0, removed = 0;
        const hunkStarts = [];
        for (const h of patch.hunks || []) {
          hunkStarts.push(h.newStart);
          for (const l of h.lines || []) {
            if (l.type === "+") added += 1;
            else if (l.type === "-") removed += 1;
          }
        }
        map.set(p, { added, removed, hunkStarts });
      }
    } catch { return new Map(); }
    return map;
  }

  function slimFile(f, stats) {
    const s = stats.get(f.path) || null;
    return {
      path: f.path,
      status: f.status,
      added: s ? s.added : null,
      removed: s ? s.removed : null,
      hunkStarts: s ? s.hunkStarts : null
    };
  }

  async function listChanges(opts = {}) {
    const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 50;
    const store = await getChangeStore();
    const { parseUnifiedDiff } = await loadPatchMod();
    const [records, rolledBack] = await Promise.all([store.list({ limit }), readRolledBackIds()]);
    return records.map((r) => {
      const stats = diffFileStats(parseUnifiedDiff, r.diff);
      return {
        id: r.id,
        time: r.time,
        prompt: r.prompt || "",
        rolledBack: rolledBack.has(r.id),
        files: (r.files || []).map((f) => slimFile(f, stats))
      };
    });
  }

  async function describeChange(changeId, relPath) {
    const store = await getChangeStore();
    const { parseUnifiedDiff } = await loadPatchMod();
    const record = await store.describe({ change_id: changeId || "latest" });
    const files = record.files || [];
    const file = relPath ? files.find((f) => f.path === relPath) : files[0];
    if (!file) throw new Error(`change ${record.id}: file not found: ${relPath || "(first)"}`);
    const stats = diffFileStats(parseUnifiedDiff, record.diff);
    const s = stats.get(file.path) || null;
    const rolledBack = (await readRolledBackIds()).has(record.id);
    return {
      id: record.id,
      time: record.time,
      prompt: record.prompt || "",
      rolledBack,
      file: {
        path: file.path,
        status: file.status,
        before: typeof file.before === "string" ? file.before : null,
        after: typeof file.after === "string" ? file.after : null,
        language: languageForExt(file.path),
        added: s ? s.added : null,
        removed: s ? s.removed : null,
        hunkStarts: s ? s.hunkStarts : null
      }
    };
  }
```

return 对象加 `listChanges, describeChange`(`writeFile,` 之后同一行风格)。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/unit/gui/kernel-host-changes.test.js`
Expected: PASS(3 tests)

- [ ] **Step 5: IPC + preload**

`gui/main.js` `IPC_CHANNELS` 数组尾部加 `"changes:list", "changes:describe"`;`registerIpcHandlers` 里 `wrap` 定义之后(`conn:test` 行附近)加:

```js
  ipcMain.handle("changes:list", wrap((_e, limit) => host.listChanges({ limit })));
  ipcMain.handle("changes:describe", wrap((_e, id, relPath) => host.describeChange(id, relPath)));
```

`gui/preload.js` `activateBranch` 行后加:

```js
  listChanges: (limit) => ipcRenderer.invoke("changes:list", limit),
  describeChange: (id, relPath) => ipcRenderer.invoke("changes:describe", id, relPath),
```

- [ ] **Step 6: 语法检查**

Run: `npm run check`
Expected: 退出码 0(check 已覆盖 gui/main.js、gui/preload.js、gui/kernel-host.js)

- [ ] **Step 7: 提交**

```powershell
git add gui/kernel-host.js gui/main.js gui/preload.js tests/unit/gui/kernel-host-changes.test.js
git commit -m @'
feat(gui): read-only change-tracking bridge (list/describe + hunk stats + rollback marks) (D4-M1)

'@
```

---

## Task D4-M2 · 渲染层纯逻辑 + reducer + 卡片/面板字段修复(内联)

**Files:**
- Create: `gui/src/state/changes-derive.js`
- Modify: `gui/src/state/workbench-state.js`(`createInitialState` + `applyWorkbenchAction`)
- Modify: `gui/src/state/agent-cards.js`(diff 分支)· `gui/src/state/panels-derive.js`(`formatEvent`)
- Test: `tests/unit/gui/changes-derive.test.js`(新建);`tests/unit/gui/{workbench-state,agent-cards,panels-derive}.test.js`(改)

**Interfaces:**
- Consumes: M1 的 list 条目形状;`file:diff_applied` 真实 payload `{change_id, summary:[{path,status}], files:[路径], ...}`(session 扁平化转发)。
- Produces:
  - `deriveChangeEntries(list)` → `[{id, time, timeShort, prompt, promptShort, source:"manual"|"agent", rolledBack, files:[{path,status,added,removed,hunkStarts}]}]`
  - `statusLetter(status)` → `"A"|"D"|"M"`;`clampLine(line, maxLine)` → 夹在 `[1, maxLine]` 的整数;`shortTime(iso)` → `"MM-DD HH:mm"`(本地时区)或 `""`
  - reducer 新状态:`changes:[]` · `changesTick:0`(**规划期修正**:spec §4 的 `changesVersion(activity)` 在 activity 50 条滑窗下不单调——新旧 diff 事件一进一出计数不变;改为 reducer 在 `event_received` 收到 `file:diff_applied`/`file:rollback_applied` 时自增 `changesTick`,单调可靠)· `changeDiff:null|{meta:{id,time,prompt,rolledBack}, file, error:null}|{error}` · `pendingReveal:null|{path,line}`
  - 新 action:`changes_loaded{changes}` / `change_diff_loaded{diff}` / `change_diff_dismissed` / `reveal_requested{path,line}` / `reveal_consumed`
  - diff 卡片新形状:`{kind:"diff", changeId:string|null, path, fileCount, applied}`

- [ ] **Step 1: 写失败测试** `tests/unit/gui/changes-derive.test.js`

```js
import test from "node:test";
import assert from "node:assert/strict";
import { deriveChangeEntries, statusLetter, clampLine, shortTime } from "../../../gui/src/state/changes-derive.js";

test("deriveChangeEntries: source tag, normalization, rollback flag", () => {
  const entries = deriveChangeEntries([
    { id: "c2", time: "2026-07-02T10:00:00.000Z", prompt: "GUI edit src/a.js", rolledBack: false,
      files: [{ path: "src/a.js", status: "modify", added: 2, removed: 1, hunkStarts: [1] }] },
    { id: "c1", time: "2026-07-02T09:00:00.000Z", prompt: "fix login bug", rolledBack: true,
      files: [{ path: "src/auth.js", status: "create", added: null, removed: null, hunkStarts: null }] },
    null,
    { time: "no-id-dropped" }
  ]);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].source, "manual");
  assert.equal(entries[1].source, "agent");
  assert.equal(entries[1].rolledBack, true);
  assert.match(entries[0].timeShort, /^\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(entries[0].files[0].added, 2);
  assert.equal(entries[1].files[0].added, null);
});

test("long prompt truncated with ellipsis; bad time → empty", () => {
  const [e] = deriveChangeEntries([{ id: "c", time: "bogus", prompt: "x".repeat(80), files: [] }]);
  assert.equal(e.timeShort, "");
  assert.ok(e.promptShort.length <= 42);
  assert.ok(e.promptShort.endsWith("…"));
  assert.equal(shortTime("not-a-date"), "");
});

test("statusLetter + clampLine", () => {
  assert.equal(statusLetter("create"), "A");
  assert.equal(statusLetter("delete"), "D");
  assert.equal(statusLetter("modify"), "M");
  assert.equal(clampLine(7, 100), 7);
  assert.equal(clampLine(999, 10), 10);
  assert.equal(clampLine(0, 10), 1);
  assert.equal(clampLine(NaN, 10), 1);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/unit/gui/changes-derive.test.js`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现** `gui/src/state/changes-derive.js`

```js
// gui/src/state/changes-derive.js — fold change-bridge entries into the SCM
// "Agent Changes" view-models. Pure — node:test-covered.

const MANUAL_PREFIX = "GUI edit ";

export function deriveChangeEntries(list) {
  return (list || []).filter((c) => c && c.id).map((c) => {
    const prompt = String(c.prompt || "");
    return {
      id: c.id,
      time: c.time || "",
      timeShort: shortTime(c.time),
      prompt,
      promptShort: truncate(prompt, 42),
      source: prompt.startsWith(MANUAL_PREFIX) ? "manual" : "agent",
      rolledBack: Boolean(c.rolledBack),
      files: (c.files || []).map((f) => ({
        path: f.path || "",
        status: f.status || "modify",
        added: Number.isInteger(f.added) ? f.added : null,
        removed: Number.isInteger(f.removed) ? f.removed : null,
        hunkStarts: Array.isArray(f.hunkStarts) ? f.hunkStarts : null
      }))
    };
  });
}

export function statusLetter(status) {
  if (status === "create") return "A";
  if (status === "delete") return "D";
  return "M";
}

export function clampLine(line, maxLine) {
  const l = Math.max(1, Math.floor(Number(line) || 1));
  const m = Math.max(1, Math.floor(Number(maxLine) || 1));
  return Math.min(l, m);
}

export function shortTime(iso) {
  const d = new Date(String(iso || ""));
  if (Number.isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function truncate(s, n) {
  const t = String(s || "");
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/unit/gui/changes-derive.test.js`
Expected: PASS(3 tests)

- [ ] **Step 5: reducer 失败测试** — `tests/unit/gui/workbench-state.test.js` 追加:

```js
test("D4: changesTick increments only on diff/rollback events", () => {
  let s = createInitialState();
  assert.equal(s.changesTick, 0);
  s = applyWorkbenchAction(s, { type: "event_received", event: { type: "file:diff_applied", change_id: "c1" } });
  assert.equal(s.changesTick, 1);
  s = applyWorkbenchAction(s, { type: "event_received", event: { type: "tool:call", id: "t" } });
  assert.equal(s.changesTick, 1);
  s = applyWorkbenchAction(s, { type: "event_received", event: { type: "file:rollback_applied", change_id: "c1" } });
  assert.equal(s.changesTick, 2);
});

test("D4: changes/changeDiff/pendingReveal actions", () => {
  let s = createInitialState();
  s = applyWorkbenchAction(s, { type: "changes_loaded", changes: [{ id: "c1" }] });
  assert.equal(s.changes.length, 1);
  s = applyWorkbenchAction(s, { type: "change_diff_loaded", diff: { meta: { id: "c1" }, file: { path: "a" }, error: null } });
  assert.equal(s.changeDiff.meta.id, "c1");
  s = applyWorkbenchAction(s, { type: "reveal_requested", path: "a", line: 7 });
  assert.deepEqual(s.pendingReveal, { path: "a", line: 7 });
  s = applyWorkbenchAction(s, { type: "reveal_requested", path: "a", line: 0 });
  assert.equal(s.pendingReveal.line, 1);
  s = applyWorkbenchAction(s, { type: "reveal_consumed" });
  assert.equal(s.pendingReveal, null);
  s = applyWorkbenchAction(s, { type: "change_diff_dismissed" });
  assert.equal(s.changeDiff, null);
});
```

Run: `node --test tests/unit/gui/workbench-state.test.js` → Expected: 新 2 条 FAIL。

- [ ] **Step 6: 实现 reducer**(`gui/src/state/workbench-state.js`)

`createInitialState()` 里 `activity: []` 行后加:

```js
    changes: [],
    changesTick: 0,
    changeDiff: null,
    pendingReveal: null,
```

`event_received` 分支里(`inspectorMode = "details"` 判断之后、`return` 之前)加:

```js
    if (event.type === "file:diff_applied" || event.type === "file:rollback_applied") {
      patch.changesTick = (current.changesTick || 0) + 1;
    }
```

`rewind_dismissed` 分支后加 5 个新分支:

```js
  if (action.type === "changes_loaded") {
    return copy(current, { changes: Array.isArray(action.changes) ? action.changes.slice() : [] });
  }
  if (action.type === "change_diff_loaded") {
    return copy(current, { changeDiff: action.diff || null });
  }
  if (action.type === "change_diff_dismissed") {
    return copy(current, { changeDiff: null });
  }
  if (action.type === "reveal_requested") {
    return copy(current, {
      pendingReveal: { path: action.path || "", line: Math.max(1, Math.floor(Number(action.line) || 1)) }
    });
  }
  if (action.type === "reveal_consumed") {
    return copy(current, { pendingReveal: null });
  }
```

Run: `node --test tests/unit/gui/workbench-state.test.js` → Expected: PASS(全部)。

- [ ] **Step 7: 卡片/面板修复失败测试**

`tests/unit/gui/agent-cards.test.js` 首个测试改为真实 payload(整体替换该测试):

```js
test("plan/tool(pair)/diff/test cards derived from event stream", () => {
  const cards = deriveAgentCards([
    { type: "orchestration:planned", subtasks: 4 },
    { type: "tool:call", id: "t1", tool: "read" },
    { type: "tool:result", id: "t1", status: "ok" },
    { type: "tool:call", id: "t2", tool: "edit" },
    { type: "file:diff_applied", change_id: "chg_1", files: ["src/a.js", "src/b.js"],
      summary: [{ path: "src/a.js", status: "modify" }, { path: "src/b.js", status: "create" }] },
    { type: "verification:result", pass: true }
  ]);
  const byKind = (k) => cards.filter((c) => c.kind === k);
  assert.equal(byKind("plan")[0].subtasks, 4);
  assert.equal(byKind("tool").find((c) => c.id === "t1").status, "ok");
  assert.equal(byKind("tool").find((c) => c.id === "t2").status, "running");
  assert.equal(byKind("diff")[0].path, "src/a.js");
  assert.equal(byKind("diff")[0].fileCount, 2);
  assert.equal(byKind("diff")[0].changeId, "chg_1");
  assert.equal(byKind("diff")[0].applied, true);
  assert.equal(byKind("test")[0].pass, true);
});

test("diff_preview without change_id → changeId null, summary fallback for paths", () => {
  const [card] = deriveAgentCards([
    { type: "file:diff_preview", summary: [{ path: "src/x.js", status: "modify" }] }
  ]);
  assert.equal(card.kind, "diff");
  assert.equal(card.changeId, null);
  assert.equal(card.path, "src/x.js");
  assert.equal(card.fileCount, 1);
  assert.equal(card.applied, false);
});
```

`tests/unit/gui/panels-derive.test.js` 追加:

```js
test("diff_applied output line uses files/summary (real payload)", () => {
  const { output } = derivePanels([
    { type: "file:diff_applied", change_id: "c1", files: ["src/a.js", "src/b.js"] }
  ], []);
  assert.equal(output.length, 1);
  assert.ok(output[0].text.includes("src/a.js"));
  assert.ok(output[0].text.includes("+1"));
});
```

Run: `node --test tests/unit/gui/agent-cards.test.js tests/unit/gui/panels-derive.test.js` → Expected: FAIL(旧实现读 e.path/e.added)。

- [ ] **Step 8: 实现修复**

`gui/src/state/agent-cards.js` 的 diff 分支整体替换为:

```js
    } else if (type === "file:diff_applied" || type === "file:diff_preview") {
      const paths = Array.isArray(e.files) && e.files.length
        ? e.files.filter((p) => typeof p === "string")
        : (Array.isArray(e.summary) ? e.summary.map((s) => s && s.path).filter(Boolean) : []);
      cards.push({
        kind: "diff",
        changeId: e.change_id || null,
        path: paths[0] || "",
        fileCount: paths.length,
        applied: type === "file:diff_applied"
      });
    }
```

`gui/src/state/panels-derive.js` 的 `formatEvent` 中 `file:diff_applied` 行替换为:

```js
  if (e.type === "file:diff_applied") {
    const paths = Array.isArray(e.files) && e.files.length
      ? e.files
      : (Array.isArray(e.summary) ? e.summary.map((s) => s && s.path).filter(Boolean) : []);
    return `edit ${paths[0] || ""}${paths.length > 1 ? ` (+${paths.length - 1})` : ""}`;
  }
```

- [ ] **Step 9: 跑相关测试确认全绿**

Run: `node --test tests/unit/gui/changes-derive.test.js tests/unit/gui/workbench-state.test.js tests/unit/gui/agent-cards.test.js tests/unit/gui/panels-derive.test.js`
Expected: PASS(全部)

- [ ] **Step 10: 提交**

```powershell
git add gui/src/state/changes-derive.js gui/src/state/workbench-state.js gui/src/state/agent-cards.js gui/src/state/panels-derive.js tests/unit/gui/changes-derive.test.js tests/unit/gui/workbench-state.test.js tests/unit/gui/agent-cards.test.js tests/unit/gui/panels-derive.test.js
git commit -m @'
feat(gui): change entries derivation + reducer actions; fix diff-card/panel field mismatch (D4-M2)

file:diff_applied really carries {change_id, summary, files} — e.path/e.added/e.removed
never existed, so diff cards rendered an empty path with +0 -0. Cards now key on
change_id (clickable in D4-M4). changesTick replaces spec's changesVersion(activity):
the 50-event activity window makes a derived count non-monotonic.

'@
```

---

## Task D4-M3 · useKernel 桥接 + SCM「AGENT 改动」分区 + i18n(UI,build 门)

**Files:**
- Modify: `gui/src/hooks/useKernel.js`(openFile 提为共享 impl + 4 新方法)
- Modify: `gui/src/components/Explorer.jsx`(scm 视图第三分区)
- Modify: `gui/src/App.jsx`(changesTick→refresh 接线 + Explorer 新 props)
- Modify: `gui/src/i18n/strings.js`(zh/en `changes.*`)· `gui/src/styles/theme.css`
- Test: `tests/unit/gui/i18n.test.js`(探针键追加)

**Interfaces:**
- Consumes: preload `listChanges/describeChange`(M1);`deriveChangeEntries/statusLetter`(M2);reducer 新 action(M2)。
- Produces:
  - `kernel.refreshChanges(limit?)` → dispatch `changes_loaded`(失败 → `error_reported area:"changes"`)
  - `kernel.openChangeDiff(changeId, path?)` → dispatch `change_diff_loaded{diff:{meta,file,error:null}}`(失败 → `{diff:{error}}`)
  - `kernel.dismissChangeDiff()` → `change_diff_dismissed`
  - `kernel.revealInEditor(path, line)` → 先 `change_diff_dismissed` + `reveal_requested`,再走 openFile(M4 的 EditorGroup 消费 `pendingReveal`)
  - Explorer 新 props:`onOpenChange(changeId, path)` · `offline:boolean`

- [ ] **Step 1: useKernel 实现**(`gui/src/hooks/useKernel.js` 的 `useMemo` 内)

`useMemo(() => {` 之后、`refreshBranches` 旁,把现有 `openFile` 内联函数提为共享 `openFileImpl`,并加新方法;返回对象中 `openFile: openFileImpl`:

```js
    async function openFileImpl(path) {
      if (!api?.readFile) return;
      try {
        const r = await api.readFile(path);
        if (r && r.error) dispatch(errorToAction("readFile", new Error(r.error)));
        else dispatch({ type: "file_opened", file: r });
      } catch (err) {
        dispatch(errorToAction("readFile", err));
      }
    }
```

返回对象加(`activateBranch` 前):

```js
      openFile: openFileImpl,

      refreshChanges: async (limit) => {
        if (!api?.listChanges) return;
        try {
          const r = await api.listChanges(limit);
          if (r && r.error) dispatch(errorToAction("changes", new Error(r.error)));
          else dispatch({ type: "changes_loaded", changes: Array.isArray(r) ? r : [] });
        } catch (err) {
          dispatch(errorToAction("changes", err));
        }
      },

      openChangeDiff: async (changeId, path) => {
        if (!api?.describeChange) {
          dispatch({ type: "change_diff_loaded", diff: { error: "changes unavailable (no bridge)" } });
          return;
        }
        try {
          const r = await api.describeChange(changeId, path);
          if (r && r.error) dispatch({ type: "change_diff_loaded", diff: { error: r.error } });
          else dispatch({
            type: "change_diff_loaded",
            diff: { meta: { id: r.id, time: r.time, prompt: r.prompt, rolledBack: r.rolledBack }, file: r.file, error: null }
          });
        } catch (err) {
          dispatch({ type: "change_diff_loaded", diff: { error: err && err.message ? err.message : String(err) } });
        }
      },

      dismissChangeDiff: () => dispatch({ type: "change_diff_dismissed" }),

      revealInEditor: (path, line) => {
        dispatch({ type: "change_diff_dismissed" });
        dispatch({ type: "reveal_requested", path, line });
        return openFileImpl(path);
      },
```

(原 `openFile:` 内联定义删除,避免重复键。)

- [ ] **Step 2: i18n**(`gui/src/i18n/strings.js`)

zh 块(`rewind.*` 行后)加:

```js
    "changes.section": "AGENT 改动", "changes.empty": "暂无改动记录",
    "changes.noBridge": "无内核桥接,改动不可用", "changes.manual": "手动", "changes.agent": "agent",
    "changes.rolledBack": "已回滚", "changes.jump": "跳到编辑器", "changes.error": "改动读取失败"
```

en 块对应位置加:

```js
    "changes.section": "Agent Changes", "changes.empty": "No change records",
    "changes.noBridge": "No kernel bridge; changes unavailable", "changes.manual": "manual", "changes.agent": "agent",
    "changes.rolledBack": "rolled back", "changes.jump": "Open in editor", "changes.error": "Failed to load change"
```

`tests/unit/gui/i18n.test.js` 探针 `keys` 数组追加 `"changes.section", "changes.jump", "changes.rolledBack"`。
Run: `node --test tests/unit/gui/i18n.test.js` → Expected: PASS。

- [ ] **Step 3: Explorer SCM 分区**(`gui/src/components/Explorer.jsx`)

顶部 import 加:

```js
import { deriveChangeEntries, statusLetter } from "../state/changes-derive.js";
```

组件签名加 props `onOpenChange, offline`;组件体内(`filtered` 定义后)加:

```js
  const changeEntries = useMemo(() => deriveChangeEntries(state.changes), [state.changes]);
  const [chgToggled, setChgToggled] = useState(() => new Set());
  const toggleChange = (id) => setChgToggled((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  // Latest entry is expanded by default; toggling XOR-flips against that default.
  const isChangeOpen = (id, idx) => (idx === 0) !== chgToggled.has(id);
```

`view === "scm"` 块内、检查点列表之后加:

```jsx
          <div className="section-head">{t("changes.section")}</div>
          {offline && (
            <div className="row" style={{ color: "var(--text-mut)" }}><span className="chev" />{t("changes.noBridge")}</div>
          )}
          {!offline && changeEntries.length === 0 && (
            <div className="row" style={{ color: "var(--text-mut)" }}><span className="chev" />{t("changes.empty")}</div>
          )}
          {changeEntries.map((c, idx) => (
            <React.Fragment key={c.id}>
              <button type="button" className="row chg-head" title={`${c.time} · ${c.prompt}`}
                aria-expanded={isChangeOpen(c.id, idx)} onClick={() => toggleChange(c.id)}>
                <span className="chev">{isChangeOpen(c.id, idx) ? "▾" : "▸"}</span>
                <span className="name">{c.timeShort} {c.promptShort}</span>
                {c.rolledBack && <span className="flag" title={t("changes.rolledBack")}>{"↺"}</span>}
                <span className={`src-tag ${c.source}`}>{c.source === "manual" ? t("changes.manual") : t("changes.agent")}</span>
              </button>
              {isChangeOpen(c.id, idx) && c.files.map((f) => (
                <button key={f.path} type="button" className="row chg-file" style={{ paddingLeft: 22 }} title={f.path}
                  onClick={() => onOpenChange && onOpenChange(c.id, f.path)}>
                  <span className={`st st-${f.status}`}>{statusLetter(f.status)}</span>
                  <span className="name">{f.path}</span>
                  {f.added != null && (
                    <span className="flag">
                      <span style={{ color: "var(--green)" }}>+{f.added}</span>{" "}
                      <span style={{ color: "var(--red)" }}>−{f.removed}</span>
                    </span>
                  )}
                </button>
              ))}
            </React.Fragment>
          ))}
```

- [ ] **Step 4: App 接线**(`gui/src/App.jsx`)

`useEffect` 区(language effect 后)加:

```jsx
  useEffect(() => { kernel.refreshChanges(); }, [state.changesTick, kernel]);
```

Explorer 调用处加 props:

```jsx
            onOpenFile={kernel.openFile} onSelectCheckpoint={selectCheckpoint}
            onOpenChange={kernel.openChangeDiff} offline={!kernel.available} />
```

- [ ] **Step 5: CSS**(`gui/src/styles/theme.css`,`.section-head` 规则后加)

```css
.side .src-tag{flex:none; margin-right:10px; font-size:10px; padding:0 5px; border-radius:8px; background:var(--bg-3,#333); color:var(--text-mut);}
.side .chg-file .st{flex:none; width:14px; font-weight:600; font-size:10px;}
.side .st-create{color:var(--green);} .side .st-delete{color:var(--red);} .side .st-modify{color:var(--accent);}
```

(`.row .flag` 已有 `margin-left:auto`,`src-tag` 排 flag 后自然靠右。)

- [ ] **Step 6: build + 相关单测**

Run: `cd gui; npm run build:renderer; cd ..`,再 `node --test tests/unit/gui/i18n.test.js`
Expected: vite build ✓ + 测试 PASS

- [ ] **Step 7: 提交**

```powershell
git add gui/src/hooks/useKernel.js gui/src/components/Explorer.jsx gui/src/App.jsx gui/src/i18n/strings.js gui/src/styles/theme.css tests/unit/gui/i18n.test.js
git commit -m @'
feat(gui): SCM Agent-Changes section + change bridges in useKernel (D4-M3)

'@
```

---

## Task D4-M4 · ChangeDiffView + hunk 跳转 + Agent 卡片可点(UI,build 门)

**Files:**
- Modify: `gui/src/components/DiffView.jsx`(可选 `title`/`actions` props,向后兼容)
- Create: `gui/src/components/ChangeDiffView.jsx`
- Modify: `gui/src/components/EditorGroup.jsx`(changeDiff 优先渲染 + reveal 效果)
- Modify: `gui/src/components/AgentPanel.jsx`(diff 卡片可点)· `gui/src/App.jsx`(props)· `gui/src/styles/theme.css`

**Interfaces:**
- Consumes: `state.changeDiff`(M2/M3 形状 `{meta:{id,time,prompt,rolledBack}, file:{path,status,before,after,language,hunkStarts}, error}`)· `state.pendingReveal` · `kernel.revealInEditor/dismissChangeDiff/openChangeDiff` · `clampLine/shortTime`(M2)。
- Produces: EditorGroup 新 props `onDismissChangeDiff()` / `onReveal(path,line)` / `onRevealConsumed()`;AgentPanel `actions.openChange(changeId, path)`。

- [ ] **Step 1: DiffView 扩展**(`gui/src/components/DiffView.jsx` 头部区替换)

```jsx
export default function DiffView({ theme, language, original, modified, onClose, t, title, actions }) {
  return (
    <div className="diffview" role="document" aria-label="diff">
      <div className="diffview-head">
        <span className="name" title={typeof title === "string" ? title : undefined}>
          {title || (t ? t("diff.title") : "Diff")}
        </span>
        {actions || null}
        <button type="button" className="ghost" onClick={onClose} aria-label={t ? t("diff.close") : "Close diff"}>✕</button>
      </div>
```

(body 不变;不传 title/actions 时行为与 D-3 完全一致 → 现有 dirty 对比零回归。)

- [ ] **Step 2: 新建** `gui/src/components/ChangeDiffView.jsx`

```jsx
import React from "react";
import DiffView from "./DiffView.jsx";
import { shortTime } from "../state/changes-derive.js";

// Read-only before↔after of one persisted change record, with hunk-level jump-to-editor.
export default function ChangeDiffView({ t, theme, changeDiff, onClose, onReveal }) {
  if (!changeDiff) return null;
  if (changeDiff.error) {
    return (
      <div className="changediff-error" role="alert">
        <span>{t("changes.error")}: {changeDiff.error}</span>
        <button type="button" className="ghost" onClick={onClose} aria-label={t("diff.close")}>✕</button>
      </div>
    );
  }
  const { meta, file } = changeDiff;
  const starts = file.status === "delete" ? [] : (file.hunkStarts || []);
  const actions = (
    <span className="chg-actions">
      {meta.rolledBack && <span title={t("changes.rolledBack")}>↺</span>}
      {starts.map((n) => (
        <button key={n} type="button" className="bc-btn" title={`${t("changes.jump")} @@ ${n}`}
          onClick={() => onReveal(file.path, n)}>@@ {n}</button>
      ))}
      {file.status !== "delete" && (
        <button type="button" className="bc-btn accent" onClick={() => onReveal(file.path, starts[0] || 1)}>
          {t("changes.jump")}
        </button>
      )}
    </span>
  );
  return (
    <DiffView t={t} theme={theme} language={file.language}
      original={file.before ?? ""} modified={file.after ?? ""}
      onClose={onClose}
      title={`${file.path} · ${shortTime(meta.time) || meta.time || ""} · ${meta.prompt || ""}`}
      actions={actions} />
  );
}
```

- [ ] **Step 3: EditorGroup 集成**(`gui/src/components/EditorGroup.jsx`)

import 加:

```jsx
import ChangeDiffView from "./ChangeDiffView.jsx";
import { clampLine } from "../state/changes-derive.js";
```

签名加 props:`onDismissChangeDiff, onReveal, onRevealConsumed`;`useState`/`useRef` 区加 mount 计数,`handleMount` 尾部自增(Monaco 异步挂载,effect 需在 mount 后重跑):

```jsx
  const [monacoTick, setMonacoTick] = useState(0);
```

```jsx
    setMonacoTick((m) => m + 1);   // handleMount 末尾
```

`handleMount` 定义后加 reveal 效果(import `useEffect`):

```jsx
  useEffect(() => {
    const pr = state.pendingReveal;
    const ed = editorRef.current;
    if (!pr || !ed || state.changeDiff || state.activeFile !== pr.path) return;
    const model = typeof ed.getModel === "function" ? ed.getModel() : null;
    if (!model) return;
    const line = clampLine(pr.line, model.getLineCount());
    ed.revealLineInCenter(line);
    ed.setPosition({ lineNumber: line, column: 1 });
    if (typeof ed.focus === "function") ed.focus();
    if (onRevealConsumed) onRevealConsumed();
  }, [state.pendingReveal, state.activeFile, state.changeDiff, monacoTick, onRevealConsumed]);
```

渲染:现有 `{active ? (...) : (...)}` 三元外面套 changeDiff 优先分支:

```jsx
      {state.changeDiff ? (
        <>
          <div className="breadcrumb" aria-label="breadcrumb"> </div>
          <div className="code" role="document" aria-label="change diff">
            <ChangeDiffView t={t} theme={state.theme} changeDiff={state.changeDiff}
              onClose={onDismissChangeDiff} onReveal={onReveal} />
          </div>
        </>
      ) : active ? (
        ...现有 active 分支原样...
      ) : (
        ...现有空态分支原样...
      )}
```

- [ ] **Step 4: AgentPanel diff 卡片可点**(`gui/src/components/AgentPanel.jsx`)

`LiveCards` 签名改 `{ t, cards, onOpenChange }`,diff 分支整体替换:

```jsx
    if (c.kind === "diff") {
      const clickable = Boolean(c.changeId && onOpenChange);
      return (
        <div key={i} className="card">
          <div className={`ch ${clickable ? "clickable" : ""}`}
            role={clickable ? "button" : undefined} tabIndex={clickable ? 0 : undefined}
            onClick={clickable ? () => onOpenChange(c.changeId, c.path) : undefined}
            onKeyDown={clickable ? (e) => { if (e.key === "Enter") onOpenChange(c.changeId, c.path); } : undefined}>
            <Icon name="edit" size={14} style={{ color: "var(--fn)" }} />
            <span className="name" style={{ color: "var(--text-mut)" }}>
              {c.path}{c.fileCount > 1 ? ` (+${c.fileCount - 1})` : ""}
            </span>
            {!c.applied && <span className="r" style={{ color: "var(--text-mut)" }}>preview</span>}
          </div>
        </div>
      );
    }
```

`AgentPanel` 内 `<LiveCards t={t} cards={cards} />` 改 `<LiveCards t={t} cards={cards} onOpenChange={actions.openChange} />`。

- [ ] **Step 5: App 接线**(`gui/src/App.jsx`)

`actions` 对象加 `openChange: (id, p) => kernel.openChangeDiff(id, p)`;EditorGroup 调用处加:

```jsx
              onCursor={(pos) => dispatch({ type: "cursor_moved", position: pos })}
              onDismissChangeDiff={kernel.dismissChangeDiff}
              onReveal={(p, line) => kernel.revealInEditor(p, line)}
              onRevealConsumed={() => dispatch({ type: "reveal_consumed" })} />}
```

- [ ] **Step 6: CSS**(`theme.css`,`.diffview-head .ghost` 规则后加)

```css
.diffview-head .name{overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
.diffview-head .chg-actions{display:flex; gap:4px; align-items:center; margin-left:auto; text-transform:none;}
.diffview-head .bc-btn{background:none; border:1px solid var(--border-2); color:var(--text); border-radius:4px; padding:1px 8px; font-size:11px; cursor:pointer;}
.diffview-head .bc-btn.accent{background:var(--accent); color:#04283f; border-color:var(--accent); font-weight:600;}
.card .ch.clickable{cursor:pointer;}
.changediff-error{display:flex; gap:8px; align-items:center; padding:12px 16px; color:var(--red); font-size:12px;}
.changediff-error .ghost{background:none; border:none; color:var(--text-mut); cursor:pointer;}
```

(`.bc-btn` 既有规则作用域是 `.breadcrumb .bc-btn`,在 diffview-head 下需重declare。)

- [ ] **Step 7: build + 全部 gui 单测**

Run: `cd gui; npm run build:renderer; cd ..`,再 `node --test tests/unit/gui/`
Expected: vite build ✓;单测全 PASS

- [ ] **Step 8: 提交**

```powershell
git add gui/src/components/DiffView.jsx gui/src/components/ChangeDiffView.jsx gui/src/components/EditorGroup.jsx gui/src/components/AgentPanel.jsx gui/src/App.jsx gui/src/styles/theme.css
git commit -m @'
feat(gui): ChangeDiffView with hunk jump + clickable diff cards (D4-M4)

'@
```

---

## Task D4-M5 · 门控 smoke + 全量回归 + 文档收口

**Files:**
- Modify: `gui/main.js`(smoke 种子 + SCM/对比截图)
- Modify: `docs/project-overview.md` · `docs/CHANGELOG.md` · `README.md` · `README.en.md` · `docs/README.md`

**Interfaces:**
- Consumes: M1–M4 全部落地;smoke 依赖 `.side .chg-file`(M3)与 `.diffview`(M4)选择器。
- Produces: 截图 `gui/__screenshots__/scm-changes.png` / `change-diff.png`;文档 D-4 收口。

- [ ] **Step 1: smoke 种子记录**(`gui/main.js` `createWindow` 内,`const smoke = ...` 行后)

```js
  const seededChangePath = path.join(
    resolveProjectRoot(process.argv, path.resolve(__dirname, "..")),
    ".deepseek-code", "changes", "20990101000000-smoke0.json"
  );
  if (smoke) {
    // Deterministic first entry for the SCM changes capture (2099 sorts first, removed on quit).
    try {
      fs.mkdirSync(path.dirname(seededChangePath), { recursive: true });
      fs.writeFileSync(seededChangePath, JSON.stringify({
        id: "20990101000000-smoke0",
        time: "2099-01-01T00:00:00.000Z",
        prompt: "smoke: sample agent change",
        diff: "--- a/src/smoke-sample.js\n+++ b/src/smoke-sample.js\n@@ -1,2 +1,3 @@\n line1\n-old\n+new\n+added\n",
        summary: [{ path: "src/smoke-sample.js", status: "modify" }],
        files: [{ path: "src/smoke-sample.js", oldPath: "src/smoke-sample.js", newPath: "src/smoke-sample.js",
          status: "modify", before: "line1\nold\n", after: "line1\nnew\nadded\n" }]
      }, null, 2), "utf8");
    } catch (seedErr) { console.log("SMOKE_SEED_SKIPPED:" + seedErr.message); }
  }
```

- [ ] **Step 2: smoke 截图段**(did-finish-load 内,settings 捕获段之后、`win.setSize(800, 720)` 之前)

```js
          // D-4: SCM Agent-Changes section + change diff (uses the seeded record).
          try {
            const scmReady = await win.webContents.executeJavaScript(`
              new Promise((resolve) => {
                const btns = document.querySelectorAll('.activity button[role="tab"]');
                if (btns[2]) btns[2].click();
                let n = 0;
                const iv = setInterval(() => {
                  if (document.querySelector('.side .chg-file') || n++ > 30) { clearInterval(iv); resolve(Boolean(document.querySelector('.side .chg-file'))); }
                }, 100);
              })
            `);
            if (scmReady) {
              const scm = await win.webContents.capturePage();
              await fs.promises.writeFile(path.join(dir, "scm-changes.png"), scm.toPNG());
              const diffReady = await win.webContents.executeJavaScript(`
                new Promise((resolve) => {
                  const row = document.querySelector('.side .chg-file');
                  if (row) row.click();
                  let n = 0;
                  const iv = setInterval(() => {
                    if (document.querySelector('.diffview') || n++ > 50) { clearInterval(iv); resolve(Boolean(document.querySelector('.diffview'))); }
                  }, 100);
                })
              `);
              if (diffReady) {
                await new Promise((r) => setTimeout(r, 400)); // let the DiffEditor paint
                const cd = await win.webContents.capturePage();
                await fs.promises.writeFile(path.join(dir, "change-diff.png"), cd.toPNG());
              }
              await win.webContents.executeJavaScript(`(document.querySelector('.diffview-head .ghost')||{}).click?.()`);
              await win.webContents.executeJavaScript(`document.querySelector('.activity button[role="tab"]').click()`);
            } else {
              console.log("SMOKE_CHANGES_SKIPPED:no-entries");
            }
          } catch (chgErr) {
            console.log("SMOKE_CHANGES_SKIPPED:" + chgErr.message);
          }
```

`app.quit()` 前加清理:

```js
      try { fs.rmSync(seededChangePath, { force: true }); } catch { /* best-effort */ }
```

- [ ] **Step 3: 跑门控 smoke**

Run(PowerShell):`cd gui; $env:DEEPSEEK_CODE_GUI_SMOKE="1"; npx electron .; Remove-Item Env:DEEPSEEK_CODE_GUI_SMOKE; cd ..`
Expected: stdout 含 `GUI_SMOKE_READY`(无 `SMOKE_CHANGES_SKIPPED`);`gui/__screenshots__/scm-changes.png` 与 `change-diff.png` 生成;肉眼核截图(分区有种子条目 + 对比双栏可见)。种子文件已被清理(`.deepseek-code/changes/` 下无 `20990101000000-smoke0.json`)。

- [ ] **Step 4: 全量回归(单独跑,勿管道吞码)**

Run: `npm test` → Expected: ≥837 pass(+本片新增),0 fail(门控 skip 正常)
Run: `npm run check` → Expected: 退出码 0
Run: `git diff --check` → Expected: 无输出

- [ ] **Step 5: 提交 smoke**

```powershell
git add gui/main.js
git commit -m @'
test(gui): smoke covers SCM changes section + change diff (seeded record) (D4-M5)

'@
```

- [ ] **Step 6: 文档收口**(按 docs/README 更新顺序:overview → CHANGELOG → README 中英 → 索引)

1. `docs/project-overview.md`:GUI 段追加 D-4 —— SCM「AGENT 改动」分区(来源标签 agent/手动、已回滚 ↺、+/− 计数)、ChangeDiffView(记录内 before/after 直喂 Monaco DiffEditor)、hunk chips 跳转(revealLineInCenter + clamp)、只读桥 `changes:list`/`changes:describe`(列表瘦身、describe 单文件切片)、agent 卡片/输出面板字段修复。
2. `docs/CHANGELOG.md`:新 D-4 条目(同上要点 + 测试数)。
3. `README.md` + `README.en.md`:GUI 功能列表各加一行「agent 改动跟踪:改动列表 → 前后对比 → 跳转编辑器 / Agent change tracking: change list → before/after diff → jump to editor」(中英同步)。
4. `docs/README.md`:索引加 D-4 spec + 本 plan。

- [ ] **Step 7: 最终提交**

```powershell
git add docs/project-overview.md docs/CHANGELOG.md README.md README.en.md docs/README.md
git commit -m @'
docs: ship V3 Phase D-4 GUI agent change tracking

'@
```

---

## Self-Review
- **Spec 覆盖**:§1 决策1(方案 C:describe 切片 before/after)→ M1/M4;决策2(SCM 分区+卡片联动)→ M3/M4;决策3(主开对比+hunk chips 跳转)→ M4;决策4(全部显示+来源标签+回滚标)→ M1(rolledBack)/M2(source)/M3(UI);§3 桥 → M1;§4 派生/reducer/字段修复 → M2;§5 UI/跳转/卡片 → M3/M4;§6 硬约束 → Global Constraints;§7 里程碑 ↔ M1–M5;§8 测试策略 → 各 Task 测试步。
- **Spec 偏差(1 处,已注明)**:§4 `changesVersion(activity)` 派生计数在 activity 50 条滑窗下不单调 → 改 reducer `changesTick`(M2 Interfaces 有说明,提交信息亦注明)。
- **占位符扫描**:无 TBD/TODO;每个代码步都给了完整代码;M5 文档步给出具体要点清单(叙述性文档无法给逐字 diff,要点即验收项)。
- **类型一致性**:list 条目 `{id,time,prompt,rolledBack,files[{path,status,added,removed,hunkStarts}]}` 在 M1 产 / M2 `deriveChangeEntries` 消费;describe 切片 `{meta:{id,time,prompt,rolledBack},file}` 在 M3 `openChangeDiff` 组装 / M4 `ChangeDiffView` 消费;`pendingReveal{path,line}` M2 产 / M4 效果消费;`actions.openChange` M4 两处(App 定义、AgentPanel 消费)同名;`clampLine/shortTime/statusLetter/deriveChangeEntries` 导出名与 import 处一致。
- **降级路径**:无桥(offline 提示/`refreshChanges` 静默跳过/`openChangeDiff` 回 error 态)、describe 失败(error 态 + ✕ 可关)、坏 diff(null 计数,UI 省略)、坏 rollbacks 行(跳过)、越界行号(clamp)、删除态文件(隐藏跳转)。
