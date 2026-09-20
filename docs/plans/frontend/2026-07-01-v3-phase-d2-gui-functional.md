# V3 Phase D-2 · GUI 做「真」 实施计划

> 完成状态以 [CHANGELOG](../../CHANGELOG.md) 为准。

> **执行说明:** 按 TDD bite-sized 步骤落地,每 Task 末「跑测试 + 提交」。
> **纯逻辑(M1 部分/M2/M4/M5)无 GUI 集成依赖,主控内联做**;**Monaco(M3)/node-pty·xterm(M6)需装依赖 + node-pty 原生重建**,门控(本机/联网)。
>
> 设计 spec:[2026-07-01-v3-phase-d2-gui-functional-design.md](../../specs/frontend/2026-07-01-v3-phase-d2-gui-functional-design.md)。

**Goal:** 把 D-1 的占位(文件树/编辑器/终端/Agent 卡片)换成真的:真文件树 + Monaco 只读高亮 + 实时 Agent 卡片 + node-pty 交互终端;修 language 持久化。

**Architecture:** kernel(`src/`)零改动;GUI 后端(`gui/kernel-host.js` 复用 `src/workspace/path-safety.js` 做文件桥、新 `gui/pty-host.js` 做 PTY 桥)+ 渲染层(Explorer/EditorGroup/AgentPanel/Terminal 接真)。派生/生命周期逻辑纯函数化 → node:test;Monaco/xterm/真 pty → build + 门控 smoke。

**Tech Stack:** React19 + Vite7 · node:test · `monaco-editor` + `@monaco-editor/react` · `@xterm/xterm` + `@xterm/addon-fit` · `node-pty` + `@electron/rebuild`(仅 `gui/`)。

## Global Constraints(每 Task 隐含遵守)

- **kernel(`src/`)零改动**;`kernel-host` 动态 import 复用 `src/workspace/path-safety.js`(只读 util),不改它。新增只在 `gui/`。
- **路径安全**:`readFile` 走 `readWorkspaceTextFile`(realpath 边界 + 拒目录/超大/二进制),`listTree` 走 `walkWorkspaceFiles`(排除 `.git`/`node_modules`/`.deepseek-code` + `maxFiles` 封顶)。
- **确定性可测**:`buildTree` / `deriveAgentCards` / `normalizeGuiPreferences` / reducer 新状态 / `pty-host`(注入 mock spawn)全 node:test;Monaco/xterm/真 pty 走 build + 门控 smoke。
- **依赖门控 + 降级**:新依赖只进 `gui/package.json`;`node-pty` 需 `@electron/rebuild`;无 deps/未重建 → 终端优雅降级(提示不崩)。build/smoke 无 deps → `test.skip`,核心 799 全绿不受影响。
- **离线**:Monaco worker 本地化(不走 CDN)。

---

## File Structure

| 文件 | 责任 | 动作 | deps |
|------|------|------|------|
| `gui/kernel-host.js` | `listTree()`/`readFile(rel)` 复用 path-safety;`normalizeGuiPreferences` 加 language | 改 | 无 |
| `gui/main.js` | `fs:tree`/`fs:read` IPC + PTY IPC | 改 | 无(pty 门控)|
| `gui/preload.js` | `listTree`/`readFile` + `pty.*` 桥 | 改 | 无 |
| `gui/pty-host.js` | PTY 生命周期(注入 spawn 可测)| **新建** | node-pty(注入)|
| `gui/src/state/file-tree.js` | `buildTree(paths)` 纯 | **新建** | 无 |
| `gui/src/state/agent-cards.js` | `deriveAgentCards(activity)` 纯 | **新建** | 无 |
| `gui/src/state/workbench-state.js` | `openFiles`/`activeFile`/`fileTree` + actions | 改 | 无 |
| `gui/src/components/Explorer.jsx` | 真文件树 + 点选打开 | 改 | 无 |
| `gui/src/components/EditorGroup.jsx` | Monaco 只读 + 标签页反映 openFiles | 改 | monaco |
| `gui/src/components/Terminal.jsx` | xterm ↔ pty | **新建** | xterm |
| `gui/src/components/AgentPanel.jsx` | 实时卡片替换示例 | 改 | 无 |
| `gui/src/hooks/useKernel.js` | + listTree/readFile/pty 动作 | 改 | 无 |
| `gui/vite.renderer.config.mjs` | monaco worker 配 | 改 | monaco |
| `tests/unit/gui/*.test.js` · `tests/e2e/gui-*.test.js` | 单测 + 门控 build/smoke | 新建/改 | 无 |
| docs | 收口 | 改 | — |

---

## Task D2-M1 · 文件桥 + language 修复(kernel-host,无 deps,内联)

**Files:** 改 `gui/kernel-host.js`、`gui/main.js`、`gui/preload.js`;新建 `tests/unit/gui/kernel-host-fs.test.js`、`tests/unit/gui/gui-preferences-language.test.js`。

**Interfaces (Produces):** `host.listTree() -> string[]`(posix rel 文件路径)· `host.readFile(rel) -> { path, content, language, bytes }`。

- [ ] **Step 1: 失败测试**(临时目录夹具)
```js
// tests/unit/gui/kernel-host-fs.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createKernelHost } = require("../../../gui/kernel-host.js");

async function tmpProject() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-fs-"));
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.writeFile(path.join(dir, "src", "index.js"), "export const x = 1;\n");
  await fs.writeFile(path.join(dir, "README.md"), "# hi\n");
  await fs.mkdir(path.join(dir, "node_modules", "z"), { recursive: true });
  await fs.writeFile(path.join(dir, "node_modules", "z", "a.js"), "junk");
  return dir;
}

test("listTree returns project files, excludes node_modules/.git", async () => {
  const host = createKernelHost({ projectRoot: await tmpProject() });
  const files = await host.listTree();
  assert.ok(files.includes("src/index.js"));
  assert.ok(files.includes("README.md"));
  assert.ok(!files.some((f) => f.startsWith("node_modules/")));
});

test("readFile returns content + language, rejects escape", async () => {
  const host = createKernelHost({ projectRoot: await tmpProject() });
  const f = await host.readFile("src/index.js");
  assert.match(f.content, /export const x/);
  assert.equal(f.language, "javascript");
  await assert.rejects(() => host.readFile("../../../etc/passwd"));
});
```
```js
// tests/unit/gui/gui-preferences-language.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { normalizeGuiPreferences } = require("../../../gui/kernel-host.js");

test("normalizeGuiPreferences persists language (default zh)", () => {
  assert.equal(normalizeGuiPreferences({}).language, "zh");
  assert.equal(normalizeGuiPreferences({ language: "en" }).language, "en");
  assert.equal(normalizeGuiPreferences({ language: "fr" }).language, "zh");
  assert.equal(normalizeGuiPreferences({ theme: "day" }).theme, "day"); // no regression
});
```
- [ ] **Step 2: 跑红**
- [ ] **Step 3: 实现** — `gui/kernel-host.js`:
  - `GUI_PREFERENCE_DEFAULTS` 加 `language: "zh"`;`normalizeGuiPreferences` 加 `language: input.language === "en" ? "en" : "zh"`。
  - 缓存动态 import path-safety:`let pathSafety; async function ps(){ if(!pathSafety) pathSafety = await import(pathToFileURL(path.join(__dirname,"..","src","workspace","path-safety.js")).href); return pathSafety; }`
  - `async function listTree(){ const { walkWorkspaceFiles } = await ps(); return walkWorkspaceFiles(projectRoot); }`
  - `async function readFile(rel){ const { readWorkspaceTextFile } = await ps(); const r = await readWorkspaceTextFile(projectRoot, rel); return { ...r, language: languageForExt(rel) }; }` + `languageForExt`(js/mjs/cjs/jsx→javascript, ts/tsx→typescript, py→python, json→json, md→markdown, css/html/yaml/sh→对应, else plaintext)。
  - 加进 return 的 facade。
- [ ] **Step 4: 跑绿** · [ ] **Step 5: `gui/main.js`** 加 IPC `fs:tree`→`host.listTree()`、`fs:read`→`host.readFile(rel)`(+ IPC_CHANNELS 登记);**`gui/preload.js`** 加 `listTree`/`readFile`。node --check。
- [ ] **Step 6: 提交** `feat(gui): kernel-host file bridge (listTree/readFile via path-safety) + language persistence (D2-M1)` + 署名

---

## Task D2-M2 · reducer 文件状态 + 真文件树 UI

**Files:** 新建 `gui/src/state/file-tree.js`;改 `gui/src/state/workbench-state.js`、`gui/src/components/Explorer.jsx`、`gui/src/hooks/useKernel.js`;测试。

- [ ] **Step 1: 失败测试** — `buildTree(["src/index.js","README.md","src/core/x.js"])` → 嵌套 `{name,type,path,children}`(dir 先、字典序);reducer:`tree_loaded`(存 `fileTree`)、`file_opened`(openFiles 去重 + activeFile=path,不可变)、`file_activated`、`file_closed`(移除 + activeFile 回退)。
- [ ] **Step 2–4: 实现**
  - `file-tree.js`:`buildTree(paths)` 纯——按 `/` 拆、建目录节点、排序(dir 优先 + name 升序)。
  - reducer:`createInitialState` 加 `fileTree:[], openFiles:[], activeFile:null`;对应 actions(不可变 copy)。
  - `Explorer.jsx`:渲染 `buildTree(state.fileTree)`(可折叠),叶子点选 → `onOpenFile(path)`;真树时不显「示例」徽标(fileTree 非空)。
  - `useKernel.js`:首屏 `listTree`→`tree_loaded`;`openFile(path)` = `readFile(path)`→`file_opened`(失败→error_reported)。
- [ ] **Step 5: 提交** `feat(gui): real file tree + open-files reducer state (D2-M2)` + 署名

---

## Task D2-M4 · 实时 Agent 卡片(纯派生,无 deps,内联)

**Files:** 新建 `gui/src/state/agent-cards.js`;改 `gui/src/components/AgentPanel.jsx`;测试。

**Interfaces:** `deriveAgentCards(activity) -> Array<{kind:"plan"|"tool"|"diff"|"test", ...}>`。

- [ ] **Step 1: 失败测试**
```js
import { deriveAgentCards } from "../../../gui/src/state/agent-cards.js";
test("plan/tool(pair)/diff/test cards derived from event stream", () => {
  const cards = deriveAgentCards([
    { type: "orchestration:planned", subtasks: 4 },
    { type: "tool:call", id: "t1", tool: "read" },
    { type: "tool:result", id: "t1", status: "ok" },
    { type: "tool:call", id: "t2", tool: "edit" },       // no result yet → running
    { type: "file:diff_applied", path: "a.js", added: 3, removed: 1 },
    { type: "verification:result", pass: true }
  ]);
  const byKind = (k) => cards.filter((c) => c.kind === k);
  assert.equal(byKind("plan")[0].subtasks, 4);
  assert.equal(byKind("tool").find((c) => c.id === "t1").status, "ok");
  assert.equal(byKind("tool").find((c) => c.id === "t2").status, "running");
  assert.equal(byKind("diff")[0].path, "a.js");
  assert.equal(byKind("test")[0].pass, true);
});
test("empty activity → no cards", () => { assert.deepEqual(deriveAgentCards([]), []); });
```
- [ ] **Step 2–4: 实现** `deriveAgentCards`(纯:遍历 activity,tool:call 建 running 卡、tool:result 按 id 置状态;orchestration:planned/replanned→plan;file:diff_*→diff;verification:result→test)→ 跑绿。
- [ ] **Step 5:** `AgentPanel.jsx`:`const cards = deriveAgentCards(state.activity)`;有卡片/消息 → 渲染真卡片;完全空 → 示例预览。
- [ ] **Step 6: 提交** `feat(gui): live agent cards derived from event stream (D2-M4)` + 署名

---

## Task D2-M5 · pty-host(注入 spawn 可测,无 deps,内联)

**Files:** 新建 `gui/pty-host.js`;测试。

**Interfaces:** `createPtyHost({ spawn, cwd, shell, onData }) -> { start(cols,rows), write(data), resize(cols,rows), kill(), available }`。

- [ ] **Step 1: 失败测试**(mock spawn 返回假 pty)
```js
const require = createRequire(import.meta.url);
const { createPtyHost } = require("../../../gui/pty-host.js");
test("pty lifecycle: start/write/resize/kill via injected spawn", () => {
  const calls = [];
  const fakePty = { onData: (cb) => { fakePty._cb = cb; }, write: (d) => calls.push(["write", d]), resize: (c, r) => calls.push(["resize", c, r]), kill: () => calls.push(["kill"]) };
  const spawn = (shell, args, opts) => { calls.push(["spawn", shell, opts.cwd]); return fakePty; };
  let out = "";
  const host = createPtyHost({ spawn, cwd: "/proj", shell: "bash", onData: (d) => { out += d; } });
  host.start(80, 24);
  fakePty._cb("hello");
  host.write("ls\n"); host.resize(100, 30); host.kill();
  assert.ok(calls.some((c) => c[0] === "spawn" && c[2] === "/proj"));
  assert.equal(out, "hello");
  assert.deepEqual(calls.filter((c) => c[0] !== "spawn"), [["write", "ls\n"], ["resize", 100, 30], ["kill"]]);
});
test("unavailable spawn → available=false, no throw", () => {
  const host = createPtyHost({ spawn: null });
  assert.equal(host.available, false);
  host.start(); host.write("x"); // no-op, no throw
});
```
- [ ] **Step 2–4: 实现** `pty-host.js`(CommonJS;`spawn` 缺失→`available:false` 全 no-op;否则 start 建 pty + 绑 onData;write/resize/kill 透传;kill 幂等)→ 跑绿
- [ ] **Step 5: 提交** `feat(gui): pty-host lifecycle (injected spawn, mock-testable) (D2-M5)` + 署名

---

## Task D2-M3 · Monaco 只读集成(门控·deps)

**Files:** 改 `gui/package.json`(+ `monaco-editor`/`@monaco-editor/react`)、`gui/vite.renderer.config.mjs`(worker)、`gui/src/components/EditorGroup.jsx`。

- [ ] **Step 1(门控·联网):** `cd gui && npm install monaco-editor @monaco-editor/react`。
- [ ] **Step 2:** vite worker 本地化:`@monaco-editor/react` `loader.config({ monaco })` 绑本地 + `self.MonacoEnvironment.getWorker` 用 `?worker` 导入(或 `vite-plugin-monaco-editor`);`base:"./"` 相对。
- [ ] **Step 3:** `EditorGroup.jsx`:`<Editor readOnly theme={dark?"vs-dark":"vs"} language={active.language} value={active.content} />`;标签页由 `state.openFiles` 渲染、`activeFile` 高亮;无打开文件 → 提示空态。保留面包屑/占位徽标去除(真文件)。
- [ ] **Step 4(门控):** `npm run build:renderer` 通过(含 monaco worker 产出)。
- [ ] **Step 5: 提交** `feat(gui): Monaco read-only editor (local workers, real file + highlight) (D2-M3)` + 署名

---

## Task D2-M6 · xterm 终端 + node-pty(门控·deps·原生重建)

**Files:** 改 `gui/package.json`(+ `@xterm/xterm`/`@xterm/addon-fit`/`node-pty` + dev `@electron/rebuild`)、`gui/main.js`(pty IPC 接 pty-host)、`gui/preload.js`(pty 桥)、新建 `gui/src/components/Terminal.jsx`;EditorGroup 底部面板接 Terminal。

- [ ] **Step 1(门控·联网):** `cd gui && npm install @xterm/xterm @xterm/addon-fit node-pty && npm i -D @electron/rebuild && npx electron-rebuild -f -w node-pty`。**重建失败 → 终端降级为命令跑器(spec §8),记 warning,不阻塞。**
- [ ] **Step 2:** `main.js` 接线:`const pty = createPtyHost({ spawn: require("node-pty").spawn, cwd: projectRoot, onData: (d)=>win.webContents.send("pty:data", d) })`;IPC `pty:start`/`pty:input`/`pty:resize`/`pty:kill`;窗口关 kill。preload 加 `pty` 桥 + `onPtyData`。
- [ ] **Step 3:** `Terminal.jsx`:xterm + fit;`onData→pty:input`,`onPtyData→term.write`,resize→`pty:resize`;`pty.available` false → 显示「终端不可用(node-pty 未重建)」。挂进 EditorGroup 底部 Terminal 面板(替换静态)。
- [ ] **Step 4(门控):** `npm run build:renderer` + 手动起 `npm start` 验证真终端(本机)。
- [ ] **Step 5: 提交** `feat(gui): interactive node-pty terminal (xterm) with graceful degrade (D2-M6)` + 署名

---

## Task D2-M7 · build + smoke + 截图 + 回归 + 文档

- [ ] **Step 1:** 扩 `tests/e2e/gui-smoke.test.js`(门控):断言 `.editor`(Monaco 容器)、Terminal 容器、真文件树行挂载;pty 未重建 → 终端降级不崩。
- [ ] **Step 2:** 截图 desktop(真文件 + Monaco 高亮 + 终端输出)。
- [ ] **Step 3:** 全量回归 `npm test`(核心 799 全绿 + 新纯逻辑测试;门控 skip)+ `npm run check`。
- [ ] **Step 4:** 文档:overview GUI 段(Monaco/pty/文件桥)、CHANGELOG D-2 条目、README 中英(GUI 现可看真文件 + 真终端)、docs/README 索引加 D-2 spec+plan。
- [ ] **Step 5: 提交** `docs: ship V3 Phase D-2 GUI functional` + 署名

---

## Self-Review
- **Spec 覆盖**:§4.1 文件桥→M1;§4.5 language→M1;§4.2 Monaco→M3;§4.3 卡片→M4;§4.4 pty→M5/M6;§6 里程碑↔M1–M7;§7 测试→各 Step1。
- **依赖门控清晰**:M1/M2/M4/M5 纯逻辑无 GUI 集成 deps → 内联先做;M3(monaco)/M6(xterm+node-pty+rebuild)门控。核心 799 不受 gui deps 影响。
- **kernel 零改动**:仅 gui/ + 只读复用 path-safety。
- **类型一致**:`readFile` 产出(path/content/language)被 reducer `file_opened` + Monaco 消费;`deriveAgentCards` 卡片形状 M4 产/AgentPanel 消费;pty-host 接口 M5 定/M6 main.js 消费一致。
- **降级**:pty 不可用/monaco 缺失/deps 未装 → 提示不崩;门控测试 skip。
