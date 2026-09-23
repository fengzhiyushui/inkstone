# V3 Phase D-1 · GUI React 外壳

- 类型：前端 spec
- 日期：2026-06-27
- 状态：已实现
- 关联：[V3 路线图](../architecture/2026-06-24-v3-roadmap-design.md) Phase D · [D-2 做真](2026-07-01-v3-phase-d2-gui-functional-design.md)（原 GUI 优化草稿已删除）

## 问题与目标

原生 HTML/CSS/JS Electron GUI 功能完整，视觉停留在自绘 DOM。本片把渲染层迁到 React + Vite，落手写 VS Code 风格外壳，后端零改动，功能保真。范围是地基加视觉外壳（GUI-R1 + P0）。

## 决策

| 选了什么 | 否决了什么 | 为什么 |
|---|---|---|
| React + Vite 渲染层，手写 CSS 设计系统 + 内联 SVG | Semi UI 等成品 UI 套件 | 成品套件会强加观感 |
| 组件命名对齐 IDE 心智（TitleBar/ActivityBar/Explorer/EditorGroup/AgentPanel） | 旧 TopBar/Sidebar/ChatPanel 命名 | 后续组件演进更顺 |
| `workbench-state.js` 纯 reducer 转 ESM，逻辑不改 | 重写状态层 | 现有单测与不可变防线可复用 |
| 中英双语 i18n，默认中文，`language` 进 preferences | 仅英文 UI | 用户要求 |
| 后端 / IPC / `window.deepseek` 契约不动 | 顺手改 host | 风险隔离 |
| 旧 `gui/renderer/*` 休眠保留 | 立刻删除 | 对等后再删 |
| 版本兼容门先行（Node/npm/Electron 对 react19/vite7） | 直接写产品代码 | 避免卡在工具链 |

实施后 pivot：弃用 Semi UI（及任何强加观感的成品套件），改手写 VS Code 风格。第三方库只用于不带界面风格的功能引擎。设计基准曾为 `gui/mockups/deepseek-code-ide-mockup.html`。

## 设计

```text
Electron 主进程(不动)   gui/main.js + kernel-host.js + preload.js(window.deepseek)
        │ IPC(不动)
        ▼
React + Vite 渲染层      gui/src/
   main.jsx → <App>
     useReducer(applyWorkbenchAction, createInitialState())
     useKernel(dispatch)  包 window.deepseek 事件流
     外壳组件分区渲染
```

构建层：依赖只进 `gui/package.json`（react/react-dom、dev vite 与 plugin-react）。Vite `base: "./"`（Electron `file://` 相对路径），`build.outDir: "renderer-dist"`，别名 `@ → gui/src`。`main.js` 加载 `DEEPSEEK_CODE_GUI_DEV_URL` 或 `renderer-dist/index.html`；smoke 走构建产物。`renderer-dist/` 入 `.gitignore`。脚本 `build:renderer` / `dev` / `start`。

状态层：

- `applyWorkbenchAction` / `createInitialState` / selectors（`statusSummary`、`trafficTone`、`trafficLabel`、`metricsFromUsage`、`formatTokenCount` 等）原样复用。
- 不可变返回：改状态 action 返回 `next !== prev` 且不 mutate 旧 state；无变化未知 action 返回同引用。
- `useKernel` 订阅 `onKernelEvent` → `event_received`；首拉 preferences/branches/checkpoints/usage/runtime；封装 send/approve/interrupt/rewindPreview/rewindApply/setPreferences。取数编排抽纯函数 `buildInitialLoads` 可测。
- `window.deepseek` 缺失时 degraded，不崩。

布局契约：Rail 固定 48px；Sidebar 260px 可折叠；ChatPanel 380px 可折叠；主工作区 `flex:1` 最小 320px；TopBar 44px；StatusBar 28px。断点纯函数 `layoutForWidth`：`>1340` 四栏，`1060–1340` 隐 Sidebar，`760–1060` 隐 ChatPanel，`<760` 仅主区且 Rail 变底栏。各栏独立滚动，composer 固定底部。长名 ellipsis，状态栏各段固定宽不互挤。

a11y 基线：键盘可达、图标按钮 `aria-label`、审批 `role="alertdialog"` + `aria-live="assertive"`、deny 说明后果、双主题 WCAG AA。

占位强标记：文件树/编辑器/终端/未接卡片显式「示例」徽标与 `aria-label`，纯函数 `isLivePanel` 决定真假，与真数据视觉可区分。

主题：`night`/`day` 映射到 CSS 变量，默认 `night`。切换经 `setPreferences` 持久化。后续演进为 10 套主题 id，见 [v1.4.0](2026-07-28-v1.4.0-frontend-redesign-design.md)。

功能保真映射：send / approve / interrupt / 时间线 / 分支 / 检查点 / 回退 / 主题全走 `window.deepseek`。数据流：`window.deepseek` → `useKernel` → dispatch → reducer → 组件。

## 边界与不变量

- `gui/main.js` 仅改加载目标；preload / kernel-host / IPC 通道 / `window.deepseek` 契约不变。
- reducer 逻辑不变（仅 UMD→ESM），现有单测断言保留。
- 可测逻辑走 node:test；组件走 Vite build + 门控 Electron smoke。
- GUI 依赖只进 `gui/package.json`，不碰核心 CLI 零依赖。
- 无 gui deps 时核心 `npm test` 仍全绿。
- 新依赖/构建需联网时单独列步骤。
- a11y 基线、布局契约、占位强标记、不可变返回均为实施判据。

## 与现状的差异

组件最终落在 `gui/src/components/v4/`（AppFrame、Rail、Dock、ChatView、HomeView 等），见 [v1.8.1](2026-09-20-v1.8.1-dsh-shell-design.md)。reducer 复用、后端零改动、a11y/占位/布局契约原则仍有效。`layoutForWidth` 常量后来收敛进 `gui/src/state/columns.js`。

## 验收

- reducer/不可变/断点/占位/取数编排 node:test 全绿。
- Vite build 产出 `renderer-dist/index.html` 与资源。
- 门控 smoke：外壳容器、状态栏、composer、审批挂载、aria-label、ApprovalBanner role。
- 截图 desktop 与 narrow 各一张，核 composer 可用、长文本截断合理。
- 发送/审批/中断/时间线/分支/检查点/回退/主题功能保真。
