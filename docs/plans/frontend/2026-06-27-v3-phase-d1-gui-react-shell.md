# V3 Phase D-1 · GUI React 外壳实施计划

- 类型：实施计划
- 日期：2026-06-27
- 状态：已完成
- 关联：[CHANGELOG](../../CHANGELOG.md) · [设计 spec](../../specs/frontend/2026-06-27-v3-phase-d1-gui-react-shell-design.md) · [D-2 GUI 做真](2026-07-01-v3-phase-d2-gui-functional.md)（原 GUI 优化草稿已删除）

## 目标

把 Electron 渲染层从原生 DOM 迁到 React + Vite，复用纯 reducer 与 `window.deepseek` IPC，后端零改动，默认功能保真。

## 结果

### 状态与纯逻辑

`gui/src/state/workbench-state.js` 由 UMD reducer 迁 ESM，函数体不改。命名导出：`createInitialState`、`applyWorkbenchAction`、`statusSummary`、`trafficTone`、`trafficLabel`、`metricsFromUsage`、`formatTokenCount`、`formatCacheRate`、`formatLatency`、`targetFromCheckpoint`、`shortId`、`formatRewindStatus`、`themeLabel`。

不可变防线三条：状态变更 action 返回新引用；不 mutate 旧 state；未知 / no-op action 返回同引用（避免无谓重渲染）。helper（`copy` / `normalize` / `keyPatch` / `sanitizeMessage`）保持模块内私有。

`gui/src/state/layout.js`：

```text
layoutForWidth(px) → { rail, sidebar, chat }
```

断点 760 / 1060 / 1340。`gui/src/state/panels.js` 的 `isLivePanel(region, state)` 在 D-1 判定 filetree / editor / terminal 为占位；toolcards 有 activity 才 live。

`gui/src/hooks/kernel-loads.js` 纯映射：

- `buildInitialLoads()` → `[{ call, toAction }]`：`getPreferences`→`preferences_loaded`，`listBranches` / `getActiveBranch`→`branches_loaded`，`listCheckpoints`→`checkpoints_loaded`，`getUsage`→`usage_loaded`，`getState`→`runtime_loaded`。
- `eventToAction(e)` 包成 `{ type: "event_received", event }`。
- `resultToAction` / `errorToAction`（area → `error_reported`）。

`useWorkbench` = `useReducer(applyWorkbenchAction, undefined, createInitialState)`。`useKernel(dispatch)` 订阅 `window.deepseek.onKernelEvent`，首屏跑 `buildInitialLoads`，无桥时 degraded 不崩。

### 构建与宿主

`gui/vite.renderer.config.js`（后为 `vite.renderer.config.mjs`）：React 插件、`base: "./"`、`outDir: renderer-dist`、别名 `@` → `./src`、dev server `127.0.0.1:5173`。`gui/main.js` 只改加载目标（dev URL 或 `renderer-dist/index.html`）。依赖只进 `gui/package.json`，`renderer-dist/` 进 `.gitignore`。

### 组件与数据

D-1 落地四栏外壳（TopBar / ActivityRail / Sidebar / CodeWorkspace / ChatPanel），布局契约：列宽 Rail48 / Sidebar260 / Chat380 / Workspace flex（min 320），根 `overflow:hidden`，每栏独立滚动，composer 固定底。a11y 基线：图标 `aria-label`、Tabs `role/aria-selected`、Tree `role=tree`、审批 `role=alertdialog` + `aria-live`、`focus-visible`、Esc 关浮层。

数据接线：ChatThread←`messages`；Composer→`send`→`message_added`；中断→`interrupt`；ApprovalBanner←`approval`；Timeline/Activity←`activity`；分支与检查点←branches/checkpoints/rewind；状态栏←`statusSummary` / `trafficTone` / `metricsFromUsage`。主题 Night/Day；filetree / editor / terminal 等占位打「示例」徽标 + `aria-label="示例数据（未接入）"`。

后续 v1.4.0 用会话优先壳替换了四栏 IDE 组件；纯 reducer / loads / 不可变测试模式保留至今。

## 关键决策 / 遗留约束

- preload / kernel-host / IPC / `window.deepseek` 契约一字不改；`main.js` 仅加载目标。
- reducer 只做模块化迁移，逻辑不变；测试断言全部保留并指向新 ESM 路径。
- React / Vite / Semi / lucide 只进 `gui/package.json`，主包零依赖红线不动。
- 依赖门控：build / smoke / 截图无 deps 可 skip，核心单测不受影响。
- 旧 `gui/renderer/*` 在 D-1 休眠保留；禁止长期并存两套渲染层。
- 占位必须视觉可区分，避免假数据被当真。

## 验证

- `tests/unit/gui/workbench-state.test.js`（含不可变与 no-op 同引用）、layout 断点、isLivePanel、kernel-loads 映射单测。
- 门控 `gui-build`（断言 `renderer-dist/index.html`）、`gui-smoke`（四栏或折叠态、composer、approval 挂载、a11y）+ desktop/narrow 截图 + 保真 e2e。
- 全量 `npm test` + `npm run check` + `git diff --check`。
- 现役对照：`gui/src/state/workbench-state.js`、`hooks/useKernel.js`、`hooks/kernel-loads.js`、`App.jsx`、`useWorkbench.js`。
