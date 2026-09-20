# V3 Phase D-1 · GUI React 外壳 实施计划

> 完成状态以 [CHANGELOG](../../CHANGELOG.md) 为准。

> **执行说明:** 按 TDD bite-sized 步骤落地,每 Task 末「跑测试 + 提交」。
> **纯逻辑里程碑(M1/M3/M6 的纯函数)无 gui deps,主控内联做**;**依赖门控里程碑(M2 build / M4–M5 组件 / M7 smoke·截图)需 `npm install` gui deps + vite/electron**——环境 429 时**单列交用户本地跑**。
>
> 设计 spec:[2026-06-27-v3-phase-d1-gui-react-shell-design.md](../../specs/frontend/2026-06-27-v3-phase-d1-gui-react-shell-design.md)。

**Goal:** 把 Electron GUI 渲染层从原生 DOM 迁到 React+Vite+Semi UI 四栏外壳,复用现有纯 reducer + `window.deepseek` IPC,后端零改动,默认功能保真。

**Architecture:** Electron 主进程/preload/kernel-host/IPC 不动;`main.js` 只改加载目标(dev→Vite devserver、prod→`renderer-dist`)。`workbench-state.js` UMD→ESM 纯 reducer → `useReducer`;`useKernel` 桥 `window.deepseek`;组件 = 订阅→dispatch→渲染。

**Tech Stack:** node:test(纯逻辑)· React19 + Vite7 + Semi UI 2.100 + lucide(gui/ 独立 npm)· Electron smoke(门控)。

## Global Constraints(每 Task 隐含遵守)

- **后端零改动**:`preload.js`/`kernel-host.js`/IPC 通道/`window.deepseek` 契约一字不改;`main.js` 仅改加载目标。
- **reducer 纯函数复用**:`workbench-state.js` 逻辑不改(仅 UMD→ESM);现有单测保留 + **不可变返回防线**(改状态 action 返回新引用、不 mutate)。
- **TDD 强度**:reducer/selectors/`layoutForWidth`/`buildInitialLoads`/`isLivePanel`/事件→action 全 node:test(无 deps);组件走 build+smoke+截图(门控)。
- **a11y 基线**(§6.2)+ **布局契约**(§6.1)+ **占位强标记**(§6.3)**D-1 内建**。
- **GUI 独立 npm**:React/Semi/Vite 只进 `gui/package.json`,不碰核心 CLI 零依赖。
- **依赖门控**:build/smoke/截图无 deps 时 `test.skip`;核心 `npm test`(纯逻辑)不依赖 gui deps → 782 基线仍全绿。
- **休眠回退**:旧 `renderer/*` 保留不删(D-1)。

---

## File Structure

| 文件 | 责任 | 动作 | deps |
|------|------|------|------|
| `gui/src/state/workbench-state.js` | 纯 reducer + selectors(ESM) | 新建(从 `renderer/` 迁 ESM) | 无 |
| `gui/src/state/layout.js` | `layoutForWidth(px)` 断点纯函数 | 新建 | 无 |
| `gui/src/state/panels.js` | `isLivePanel(region,state)` 占位判定 | 新建 | 无 |
| `gui/src/hooks/kernel-loads.js` | `buildInitialLoads(api)` + 事件→action(纯) | 新建 | 无 |
| `gui/src/hooks/useKernel.js` · `useWorkbench.js` | 薄 hook 封装 | 新建 | React |
| `gui/src/components/**` | TopBar/Rail/Sidebar/CodeWorkspace/ChatPanel 拆分 | 新建 | React+Semi |
| `gui/src/App.jsx` · `main.jsx` · `styles/theme.css` | 组装 + 主题 | 新建 | React+Semi |
| `gui/vite.renderer.config.js` | Vite 配置 | 新建 | vite |
| `gui/main.js` | 加载目标 dev/prod | 改(仅加载) | electron |
| `gui/package.json` | 依赖 + 脚本 + engines | 改 | — |
| `tests/unit/gui/*.test.js` | 纯逻辑单测 | 改/新建 | 无 |
| `tests/e2e/gui-smoke.test.js` | smoke + a11y + 截图 | 改(门控) | electron |
| docs(overview/CHANGELOG/README 中英/索引) | 收口 | 改 | — |

---

## Task M1 · reducer ESM + 不可变防线(无 deps,内联)

**Files:** Create `gui/src/state/workbench-state.js`(从 `gui/renderer/workbench-state.js` 迁 ESM,逻辑不改);改 `tests/unit/gui/workbench-state.test.js` 指向新 ESM 路径 + 补不可变测试。

**Interfaces (Produces):** 命名导出 `createInitialState` · `applyWorkbenchAction` · `statusSummary` · `trafficTone` · `trafficLabel` · `metricsFromUsage` · `formatTokenCount` · `formatCacheRate` · `formatLatency` · `targetFromCheckpoint` · `shortId` · `formatRewindStatus` · `themeLabel`。

- [ ] **Step 1: 迁 ESM** —— 把 UMD 包装(`(function(root,factory){...})`)去掉,内部每个公开函数改 `export function`,helper(`copy`/`normalize`/`keyPatch`/`sanitizeMessage`)保留为模块内函数。**函数体一字不改**。放 `gui/src/state/workbench-state.js`。
- [ ] **Step 2: 改现有测试 import** —— 读 `tests/unit/gui/workbench-state.test.js`,把它对旧 UMD 的引入改为 `import { ... } from "../../../gui/src/state/workbench-state.js"`,**断言全部不变**。
- [ ] **Step 3: 加不可变防线测试**(追加)
```js
import { createInitialState, applyWorkbenchAction } from "../../../gui/src/state/workbench-state.js";

test("state-changing actions return a NEW reference (React re-render)", () => {
  const s0 = createInitialState();
  const mutating = [
    { type: "message_added", message: { role: "user", text: "hi" } },
    { type: "event_received", event: { type: "agent:step" } },
    { type: "theme_changed", theme: "day" },
    { type: "branch_selected", branch_id: "br_x" },
    { type: "rail_mode_changed", mode: "timeline" }
  ];
  let prev = s0;
  for (const a of mutating) {
    const next = applyWorkbenchAction(prev, a);
    assert.notEqual(next, prev, `${a.type} must return new ref`);
    prev = next;
  }
});

test("does not mutate the previous state in place", () => {
  const s0 = createInitialState();
  const before = JSON.stringify(s0);
  applyWorkbenchAction(s0, { type: "message_added", message: { text: "x" } });
  assert.equal(JSON.stringify(s0), before); // s0 untouched
});

test("unknown/no-op action returns SAME reference (avoid needless re-render)", () => {
  const s0 = createInitialState();
  assert.equal(applyWorkbenchAction(s0, { type: "___nope___" }), s0);
});
```
- [ ] **Step 4: 跑** `node --test tests/unit/gui/workbench-state.test.js` → 绿(逻辑未变 + 不可变成立)。
- [ ] **Step 5: 提交** `feat(gui): migrate workbench-state reducer to ESM + immutability guards (D1-M1)` + 署名。

---

## Task M3(先做,纯函数,无 deps)· layout / loads / panels 纯逻辑

> 注:M3 的纯函数不依赖组件,先于 M2 做(可内联)。hook 薄封装(useKernel/useWorkbench)在 M4 组件接线时补(需 React)。

**Files:** Create `gui/src/state/layout.js`、`gui/src/hooks/kernel-loads.js`、`gui/src/state/panels.js` + 对应 `tests/unit/gui/*.test.js`。

- [ ] **Step 1: layoutForWidth 测试**
```js
import { layoutForWidth } from "../../../gui/src/state/layout.js";
test("breakpoints 760/1060/1340 toggle panels", () => {
  assert.deepEqual(layoutForWidth(1400), { rail: true, sidebar: true, chat: true });
  assert.deepEqual(layoutForWidth(1200), { rail: true, sidebar: false, chat: true });
  assert.deepEqual(layoutForWidth(900),  { rail: true, sidebar: false, chat: false });
  assert.deepEqual(layoutForWidth(700),  { rail: false, sidebar: false, chat: false }); // rail→bottom tabs
});
```
- [ ] **Step 2: 实现** `layout.js`
```js
export function layoutForWidth(px) {
  const w = Number(px) || 0;
  return {
    rail: w >= 760,
    sidebar: w >= 1340,
    chat: w >= 1060
  };
}
```
- [ ] **Step 3: buildInitialLoads + 事件映射测试**
```js
import { buildInitialLoads, eventToAction, resultToAction } from "../../../gui/src/hooks/kernel-loads.js";
test("buildInitialLoads maps each api call to its action", () => {
  const calls = buildInitialLoads();
  const keys = calls.map((c) => c.call);
  assert.ok(keys.includes("getPreferences") && keys.includes("listBranches") && keys.includes("getUsage"));
  const pref = calls.find((c) => c.call === "getPreferences");
  assert.equal(pref.toAction({ theme: "day" }).type, "preferences_loaded");
});
test("eventToAction wraps kernel events", () => {
  assert.deepEqual(eventToAction({ type: "agent:step" }), { type: "event_received", event: { type: "agent:step" } });
});
```
- [ ] **Step 4: 实现** `kernel-loads.js`(纯):`buildInitialLoads()` 返回 `[{call, toAction}]`(getPreferences→preferences_loaded、listBranches/getActiveBranch→branches_loaded、listCheckpoints→checkpoints_loaded、getUsage→usage_loaded、getState→runtime_loaded);`eventToAction(e)`;`resultToAction`/`errorToAction`(area→error_reported)。
- [ ] **Step 5: isLivePanel 测试 + 实现** `panels.js`
```js
// test
import { isLivePanel } from "../../../gui/src/state/panels.js";
test("live regions vs placeholders", () => {
  const s = { messages: [], activity: [{ type: "tool:call" }] };
  assert.equal(isLivePanel("chat", s), true);
  assert.equal(isLivePanel("toolcards", s), true);   // has activity → live
  assert.equal(isLivePanel("filetree", s), false);   // always placeholder in D-1
  assert.equal(isLivePanel("editor", s), false);
  assert.equal(isLivePanel("terminal", s), false);
});
// impl
export function isLivePanel(region, state) {
  if (region === "filetree" || region === "editor" || region === "terminal") return false;
  if (region === "toolcards") return (state?.activity || []).length > 0;
  return true; // chat/timeline/branches/checkpoints/status = live
}
```
- [ ] **Step 6: 跑三份测试全绿 → 提交** `feat(gui): layout/loads/panels pure logic (D1-M3-pure)` + 署名。

---

## Task M2 · 版本门 + Vite 构建接线（部分门控）

**Files:** 改 `gui/package.json`(deps + scripts + engines)、新建 `gui/vite.renderer.config.js`、改 `gui/main.js`(加载目标)、新建 `tests/e2e/gui-build.test.js`(门控)。

- [ ] **Step 1: 版本门(先做)** —— 记录/校验 `node -v`(vite7 需 ≥18)、Electron30 内置 Node、react19 兼容;确认 `preview-deepseek-code/` 能装能跑(活证据)。`gui/package.json` 加 `"engines": { "node": ">=18" }`。**不匹配 → 先钉可兼容版本,记入 spec 开放问题,再继续。**
- [ ] **Step 2: 写 `gui/vite.renderer.config.js`**(inline,无需装依赖即可写)
```js
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
export default defineConfig({
  plugins: [react()],
  base: "./",
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: { outDir: "renderer-dist", emptyOutDir: true },
  server: { host: "127.0.0.1", port: 5173 }
});
```
- [ ] **Step 3: 改 `gui/main.js` 加载目标**(仅这段,其余不动)
```js
const devUrl = process.env.DEEPSEEK_CODE_GUI_DEV_URL;
if (devUrl) { win.loadURL(devUrl); }
else { win.loadFile(path.join(__dirname, "renderer-dist", "index.html")); }
```
- [ ] **Step 4: `gui/package.json`** 加 deps(react/react-dom/@douyinfe/semi-ui/@douyinfe/semi-icons/lucide-react + dev vite/@vitejs/plugin-react)+ scripts(`build:renderer`/`dev`/`start`)+ `renderer-dist/` 入 `.gitignore`。
- [ ] **Step 5(门控·联网):** `cd gui && npm install && npm run build:renderer` —— **429 时交用户本地执行**。
- [ ] **Step 6: 构建校验测试**(门控)`tests/e2e/gui-build.test.js`:检测 `gui/node_modules/vite` 缺失→`test.skip`;否则断言 `gui/renderer-dist/index.html` 存在(或 spawn build 成功)。
- [ ] **Step 7: 提交** `feat(gui): vite renderer build wiring + main.js dev/prod load (D1-M2)` + 署名。

---

## Task M4 · 组件外壳 + 布局契约 + a11y 基线(门控·React）

**Files:** `gui/src/{main.jsx,App.jsx}`、`components/{TopBar,ActivityRail}.jsx`、`components/Sidebar/*`、`components/CodeWorkspace/*`、`components/ChatPanel/*`、`hooks/{useWorkbench,useKernel}.js`、`styles/theme.css`。

- [ ] **Step 1:** `useWorkbench`(`useReducer(applyWorkbenchAction, undefined, createInitialState)`)+ `useKernel(dispatch)`(挂 `onKernelEvent`→`eventToAction`→dispatch;首屏跑 `buildInitialLoads`;`window.deepseek` 缺失→degraded 不崩)。
- [ ] **Step 2:** App 四栏骨架用 Semi UI(Nav/Tree/Tabs/Timeline);**布局契约 §6.1**:CSS 列宽(Rail48/Sidebar260/Chat380/Workspace flex,min 320)、根 `overflow:hidden`、每栏独立滚动、composer 固定底;`layoutForWidth(window.innerWidth)` 驱动折叠。
- [ ] **Step 3:** **a11y 基线 §6.2**:图标按钮 `aria-label`、Tabs `role/aria-selected`、Tree `role=tree`、`focus-visible`、Esc 关浮层。
- [ ] **Step 4(门控):** `npm run build:renderer` 通过(无报错)。
- [ ] **Step 5: 提交** `feat(gui): four-column Semi UI shell + layout contract + a11y baseline (D1-M4)` + 署名。

---

## Task M5 · 数据接线(真数据,门控·React)

- [ ] ChatThread←`state.messages`;Composer→`send`→`message_added`;中断→`interrupt`。
- [ ] ApprovalBanner←`state.approval`(`role=alertdialog`+`aria-live`)+ approve/deny→`approve()`。
- [ ] Timeline/Activity←`state.activity`;分支←`state.branches`+`listBranches`/切换;检查点/回退←`state.checkpoints`+`rewindPreview`/`rewindApply`;状态栏←`statusSummary`/`trafficTone`/`metricsFromUsage`。
- [ ] build 通过 → 提交 `feat(gui): wire live data (chat/approval/timeline/branches/checkpoints/status) (D1-M5)` + 署名。

---

## Task M6 · 主题 + 占位强标记(门控·React,isLivePanel 已在 M3)

- [ ] 主题:`night→body[theme-mode=dark]`+CSS 变量、`day→light`,默认 night;切换→`setPreferences`+`theme_changed`;双主题 WCAG AA。
- [ ] 占位强标记 §6.3:文件树/编辑器/终端/`!isLivePanel` 卡片 → `示例/Placeholder` 徽标 + `aria-label="示例数据(未接入)"` + 降饱和/虚线,与真数据视觉可区分。
- [ ] build 通过 → 提交 `feat(gui): theme (night/day) + explicit placeholder marking (D1-M6)` + 署名。

---

## Task M7 · smoke + a11y + 截图验收(门控·Electron)

**Files:** 改 `tests/e2e/gui-smoke.test.js`。

- [ ] 门控:`electron`/`renderer-dist` 缺失→`test.skip`。
- [ ] 加载构建产物,断言:四栏容器(或折叠态)+ 状态栏 + composer + 注入 `approval:requested` 后 ApprovalBanner 挂载;**a11y**:图标按钮有 `aria-label`、ApprovalBanner `role=alertdialog`、Tab 焦点可达。
- [ ] **截图** desktop(1440×900)+ narrow(800×720)→ `gui/__screenshots__/`,核四栏可见/composer 可用/approval 不遮/长文本截断合理。
- [ ] 保真 e2e:mock 事件→ChatThread 渲染消息、approve 调 `window.deepseek.approve`、rewind 可达。
- [ ] 提交 `test(gui): smoke + a11y + desktop/narrow screenshots + fidelity e2e (D1-M7)` + 署名。

---

## Task M8 · 回归 + 文档

- [ ] `npm test`(现有 782 + 新纯逻辑测试全绿;门控测试在无 deps 时 skip)+ `npm run check` + `git diff --check`。
- [ ] 文档:`project-overview.md` GUI 段(渲染层 React+Vite+Semi)、`CHANGELOG.md`、README 中英(GUI 启动:`cd gui && npm install && npm run build:renderer && npm start`)、`docs/README.md` 索引加本 spec+plan。
- [ ] 提交 `docs: ship V3 Phase D-1 GUI React shell` + 署名。

---

## Self-Review

- **Spec 覆盖**:§4 build→M2;§5 reducer/不可变→M1;§6 组件→M4/M5;§6.1 布局→M4;§6.2 a11y→M4/M7;§6.3 占位→M3(isLivePanel)+M6;§7 主题→M6;§8 保真→M5/M7;§9 约束→Global;§10 里程碑↔M1–M8;§11 测试→各 Step。
- **依赖门控清晰**:M1、M3(纯函数)、M6 的 isLivePanel **无 deps 可内联现做**;M2 build/M4–M5 组件/M7 smoke·截图**门控**(429 交用户)。核心 782 不受 gui deps 影响。
- **类型一致**:reducer 命名导出(M1)被 hooks/组件消费;`layoutForWidth`/`isLivePanel`/`buildInitialLoads`(M3)被 M4 组件调用;action 形状与 reducer 一致。
- **零回归**:后端零改动;旧 renderer 休眠;纯逻辑新测独立于 gui deps。
