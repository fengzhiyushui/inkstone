# DeepSeek Code V3 Phase D-1 · GUI React 外壳(地基 + 视觉外壳)设计

> 类型:前端设计 spec(frontend)
> 日期:2026-06-27
> 状态:**已落地(含实施后 pivot)**
> 关联:[GUI 前端优化方案](../../plans/frontend/gui-frontend-optimization-plan.md) · [future GUI redesign(早期,已被 V3 路线图取代)](../../plans/frontend/2026-06-01-future-gui-deepseek-code-ide-redesign.md) · [V3 路线图](../architecture/2026-06-24-v3-roadmap-design.md) Phase D

---

## 0. 实施后修订(pivot,以此为准)

本 spec 正文原按「**React + Vite + Semi UI**」写。实施出成品后用户判定 Semi UI 观感像「在别人界面上二次开发」,遂 **pivot**:

- **弃用 Semi UI(及任何会强加观感的成品 UI 套件)**;渲染层改为**手写 VS Code 风格** —— 原创 CSS 设计系统 + 内联 SVG 图标。第三方库只用于**不带界面风格的功能引擎**(Monaco/xterm/diff,D-2 按需)。设计基准 = 已批准的 [`gui/mockups/deepseek-code-ide-mockup.html`](../../../gui/mockups/deepseek-code-ide-mockup.html)。
- **新增中英双语 i18n**:zh/en 可切换、**默认中文**,`language` 入 reducer + preferences 持久化,`gui/src/i18n/strings.js` 字典。
- 组件重命名:TopBar→TitleBar、ActivityRail→ActivityBar、Sidebar→Explorer、CodeWorkspace→EditorGroup、ChatPanel→AgentPanel、+StatusBar/Icons。其余不变量(后端零改动、reducer 纯函数复用 + 不可变防线、布局契约 §6.1、a11y 基线 §6.2、占位强标记 §6.3、依赖门控测试)**全部延续**。
- 正文 §4/§6 中的「Semi UI」「lucide」描述作废,以本节为准;其余章节仍有效。

---

## 1. 背景与范围

现 GUI 是原生 HTML/CSS/JS Electron(`gui/main.js`/`preload.js`/`kernel-host.js` + `renderer/app.js`/`workbench-state.js`/`event-adapter.js`/`style.css`),功能全但视觉停留在自绘 DOM。原型 [`DeepSeekCodeIDE.jsx`](../../../DeepSeekCodeIDE.jsx)(Semi UI + React + Lucide 四栏 IDE)视觉远超现状,但纯静态 mock、无状态、无 IPC。

**方向裁定**:早期 redesign 计划(2026-06-01)建议「先别上 React、原生复刻」;**更晚的 V3 路线图(2026-06-24)决定「GUI 全面迁 React + Vite + Semi UI」** —— 以路线图为准,早期保守方案作废。

**本片范围(用户选「地基 + 视觉外壳」= GUI-R1 + P0)**:
1. **构建层**:`gui/` 内落 React + Vite 渲染管线,`main.js` 加载构建产物(dev/prod),Electron 主进程/IPC/kernel-host **不动**。
2. **状态层**:`workbench-state.js`(已是纯 reducer)迁 React `useReducer`;`useKernel` hook 桥接 `window.deepseek` 事件流 → dispatch。
3. **视觉外壳**:`DeepSeekCodeIDE.jsx` 拆成组件、四栏布局落地(Semi UI + Lucide),mock 数据换成 reducer/IPC 真数据(有真数据的接真、暂无的先占位)。
4. **功能保真**:agent 发送/审批/中断、时间线、分支、检查点/回退、主题——全走现有 `window.deepseek` API,零后端改动。

---

## 2. 非目标(留后续 D-2+)
- **Monaco 编辑器**(本片编辑器 = 静态代码预览)。
- **xterm.js 终端 / diff2html**(本片底部面板静态)。
- **文件树接真实 workspace-indexer**(本片文件树占位/示例数据)。
- **Agent 面板全卡片实时化**(R2:plan/search/edit/test/patch 卡片全接事件流——下一片)。
- 性能(虚拟滚动/代码分割)、面板拖拽调宽、Recovery Center UI、**进阶 a11y**(完整读屏朗读流程 / 全局快捷键体系)—— 后续。**注:a11y 基线**(键盘可达 / `aria-label` / 审批语义 / WCAG AA)**在 D-1 打底**(§6.2,review a)。
- **TUI 重设计**(独立线,Phase D 下一片,参考 opencode/codex/claude code)。
- 删除旧原生 renderer(本片保留为休眠回退,D-2 对等后再删)。

---

## 3. 架构

```
Electron 主进程(不动)   gui/main.js + kernel-host.js + preload.js(window.deepseek)
        │ IPC(不动)
        ▼
React + Vite 渲染层(新)  gui/src/
   main.jsx → <App>
     useReducer(applyWorkbenchAction, createInitialState())   ← 复用现有纯 reducer
     useKernel(dispatch)  ← 包 window.deepseek:onKernelEvent→dispatch、send/approve/...
     ┌ TopBar ┬ ActivityRail ┬ Sidebar ┬ CodeWorkspace ┬ ChatPanel ┐
```

**核心原则**:后端(kernel-host/IPC/preload)零改动,只换渲染层;`workbench-state.js` 的纯 reducer + selectors 原样复用(转 ESM),React 只做「订阅 → dispatch → 渲染」。

---

## 4. 构建层

- **依赖**(只进 `gui/package.json`,对齐已验证的 `preview-deepseek-code/`):`react@19` · `react-dom@19` · `@douyinfe/semi-ui@2.100` · `@douyinfe/semi-icons` · `lucide-react` · dev:`vite@7` · `@vitejs/plugin-react`。**不碰核心 CLI 零依赖**(GUI 本就独立 npm 工程)。
- **版本兼容门(review f,M2 第一步)**:react19 / vite7 / semi2.100 / electron30 版本较新 —— M2 **先**核 `node -v`/`npm -v`/Electron 版本支持这些(vite7 要 Node≥18、Electron30 内置 Node 版本兼容 React19),并确认 `preview-deepseek-code/` 已能装能跑(它就是活证据)。**不匹配 → 先钉可兼容版本再动产品实现**,别让 M2 卡在工具链。`gui/package.json` 加 `engines` 声明。
- **Vite 配置** `gui/vite.renderer.config.js`:`@vitejs/plugin-react`,`base: "./"`(Electron `file://` 相对路径),`build.outDir: "renderer-dist"`,别名 `@ → gui/src`,`server.host: 127.0.0.1`。
- **`main.js` 加载**(唯一改动点):
  ```js
  const devUrl = process.env.DEEPSEEK_CODE_GUI_DEV_URL;   // 例 http://127.0.0.1:5173
  if (devUrl) win.loadURL(devUrl);
  else win.loadFile(path.join(__dirname, "renderer-dist", "index.html"));
  ```
  **smoke 模式保留**(`DEEPSEEK_CODE_GUI_SMOKE=1`);smoke 走构建产物(prod 分支),不依赖 devserver。
- **脚本** `gui/package.json`:`"build:renderer": "vite build -c vite.renderer.config.js"`、`"dev": "electron . --dev"`(dev 前置起 vite devserver 或用 `DEEPSEEK_CODE_GUI_DEV_URL`)、`"start": "electron ."`。
- `renderer-dist/` 入 `.gitignore`。

---

## 5. 状态层(reducer 复用,TDD 不降)

- **`workbench-state.js` 转 ESM**:纯 reducer `applyWorkbenchAction(state, action)` + `createInitialState()` + selectors(`statusSummary`/`trafficTone`/`trafficLabel`/`metricsFromUsage`/`formatTokenCount`/...)**逻辑一字不改**,只把 UMD 包装换成 `export`。现有 `tests/unit/gui/workbench-state.test.js` 改 import 后**全部断言保留**。
- **不可变返回防线(review d)**:React `useReducer` 靠**新引用**触发重渲染。加测试钉死:每个会改状态的 action(`message_added`/`event_received`/`branch_selected`/`theme_changed`/...)返回 `next !== prev`(新引用)、且**未原地 mutate** 旧 state(`copy()` 已保证浅拷贝,测试守护它不退化);无变化的未知 action 返回**同引用**(避免无谓重渲染)。
- **`useWorkbench()`**:`const [state, dispatch] = useReducer(applyWorkbenchAction, undefined, createInitialState)`。
- **`useKernel(dispatch)`**(hook,薄):
  - `useEffect` 挂 `window.deepseek.onKernelEvent(e => dispatch({ type:"event_received", event:e }))`,返回清理。
  - 首屏拉取:`getPreferences`→`preferences_loaded`、`listBranches`/`getActiveBranch`→`branches_loaded`、`listCheckpoints`→`checkpoints_loaded`、`getUsage`→`usage_loaded`、`getState`→`runtime_loaded`。
  - 动作封装:`send`/`approve`/`interrupt`/`rewindPreview`/`rewindApply`/`setPreferences`,各自 dispatch `loading_changed`/结果 action(错误 → `error_reported`)。
  - **取数编排逻辑抽成纯函数**(`buildInitialLoads(api) -> [{call, toAction}]`)→ node:test 可测,hook 只调它。
- **`window.deepseek` 缺失兜底**(浏览器裸跑 Vite 预览时):`useKernel` 检测 `window.deepseek` 不存在 → degraded 占位,不崩(便于纯前端调样式)。

---

## 6. 组件层(拆分 + 数据接线)

按优化方案 §86 拆:
```
gui/src/
  App.jsx  main.jsx
  components/
    TopBar.jsx            品牌 / 项目·分支标签 / 连接·模型状态 / 主题切换
    ActivityRail.jsx      chat|context|branches|timeline|settings(映射 railMode)
    Sidebar/FileTree.jsx  AgentTasks.jsx    (文件树占位;分支/任务接真)
    CodeWorkspace/EditorTabs.jsx CodeEditor.jsx(静态预览) BottomPanel.jsx(静态)
    ChatPanel/AgentHeader.jsx ChatThread.jsx PlanSummary.jsx ToolCalls.jsx Timeline.jsx Composer.jsx ApprovalBanner.jsx
  hooks/ useWorkbench.js useKernel.js
  state/ workbench-state.js(ESM)
  styles/ theme.css
```
**数据接线(真 vs 占位)**:
| 区域 | 数据源 | 本片 |
|---|---|---|
| ChatThread(消息)| `state.messages`(`message_added` + send)| **真** |
| ApprovalBanner | `state.approval`(`approval:requested` 事件)+ `approve()` | **真** |
| Timeline / Activity | `state.activity`(事件流)| **真** |
| 分支列表/切换 | `state.branches`/`activeBranchId` + `listBranches` | **真** |
| 检查点/回退 | `state.checkpoints` + `rewindPreview`/`rewindApply` | **真** |
| 状态栏(runtime/traffic/metrics)| `statusSummary`/`trafficTone`/`metricsFromUsage` | **真** |
| 主题 | `state.theme`(night/day)+ `setPreferences` | **真** |
| 文件树内容 / 编辑器代码 / 终端输出 | —— | **占位**(示例数据,D-2 接真)|
| Plan/Search/Edit/Test/Patch 卡片 | 部分可从 activity 派生 | 有则接、无则占位(R2 全接)|

**Composer**:输入 → `send(message)` → dispatch `message_added`。**中断**按钮 → `interrupt()`。

### 6.1 布局契约(review b,写死 —— 防挤压/漂移/撑爆)
- **列宽**:Rail 固定 `48px`;Sidebar `260px`(可折叠,`contextCollapsed`);ChatPanel `380px`(可折叠);CodeWorkspace `flex:1`(占余量,最小 `320px`)。TopBar 固定高 `44px`,底部状态栏固定高 `28px`。
- **折叠/窄屏断点**(沿用优化方案 §200):`>1340` 四栏全开;`1060–1340` 隐 Sidebar;`760–1060` 隐 ChatPanel;`<760` 仅 CodeWorkspace(Rail 变底部 Tab)。断点由**纯函数** `layoutForWidth(px) -> { sidebar, chat, rail }` 决定 → node:test 可测。
- **滚动归属**:每栏**独立滚动容器**(`overflow:auto`),互不牵连;页面根 `overflow:hidden`。ChatPanel = 滚动 scrollback + **composer 固定底部**(`position:sticky/flex` 末行,不随 thread 滚)。
- **溢出/截断**:分支名/文件名/tab 标题 `text-overflow:ellipsis`(单行);消息/日志 `word-break` 换行;长 lesson/branch id 用 `title`/tooltip 全文。状态栏各段固定宽 + 截断,**不因内容长度推挤**其它段。

### 6.2 a11y 基线(review a,D-1 就打底,非 D-2)
工作台类 UI 的键盘/语义必须**结构性内建**,后补会牵动组件树:
- **键盘导航**:Rail/Tabs/Tree/审批按钮全可 `Tab` 到达,顺序符合视觉;`Enter/Space` 激活,`Esc` 关 inspector/审批浮层;`focus-visible` 可见环。
- **可访问名**:所有图标按钮(Rail/中断/主题/审批)带 `aria-label`;Tabs `role="tab"`+`aria-selected`;Tree `role="tree"`。
- **审批/危险操作语义**:ApprovalBanner `role="alertdialog"` + `aria-live="assertive"`;approve/deny 按钮语义清晰、deny 标 `aria-describedby` 说明后果;危险态用**语义**(不只颜色)。
- **对比度**:night/day 双主题达 **WCAG AA**(文本 4.5:1)。
- 这些进组件契约 + smoke/截图验收(§11),不留到 D-2。

### 6.3 占位强标记(review c,真假不混淆)
- 占位区(文件树内容/编辑器代码/终端/未接线的 Plan·Tool 卡片)**必须显式标记**:视觉加 `示例 / Placeholder` 徽标 + 降饱和/虚线边;a11y 加 `aria-label="示例数据(未接入)"`。
- **绝不**把占位渲染成与真数据同款,尤其 **Agent 工具卡片**:真卡片(源自 `state.activity` 事件)与占位卡片**视觉可区分**,防「真假混排伤信任」。
- 一个纯函数 `isLivePanel(region, state) -> bool` 决定某区是真是占位 → 可测;组件据此渲染徽标。

---

## 7. 主题
- reducer `theme ∈ {night, day}`。映射:`night → Semi 暗色`(`document.body.setAttribute("theme-mode","dark")`)+ 自定义 CSS 变量(`--ide-bg/#080a0f` 等,优化方案 §126);`day → Semi 亮色`(原型配色)。默认 `night`(与现状一致)。
- 切换经 `setPreferences({theme})` 持久化 + dispatch `theme_changed`。

---

## 8. 功能保真映射(现状 → 新外壳)
send/approve/interrupt/时间线/分支/检查点/回退/主题**全部保留**,数据流:`window.deepseek`(不变)→ `useKernel` → dispatch → reducer(不变)→ 组件。**验收基线**:新外壳能完成现 GUI 能做的这些操作。

---

## 9. 硬约束(实施判据)
1. **后端零改动**:`gui/main.js` 仅改**加载目标**;`preload.js`/`kernel-host.js`/IPC 通道/`window.deepseek` 契约**一字不改**。
2. **reducer 纯函数复用**:`workbench-state.js` 逻辑不改(仅 UMD→ESM),现有单测保留。
3. **TDD 强度**:所有可测逻辑(reducer/selectors/event-adapter/`useKernel` 取数编排纯函数)走 node:test;React 组件走 **Vite build 校验 + Electron smoke**。
4. **GUI 独立 npm**:React/Semi/Vite 只进 `gui/package.json`,不触碰核心 CLI「零运行时依赖」。
5. **休眠回退**:旧 `renderer/*` 保留不删(D-1),`main.js` 不再引用即可;需要时可临时切回。
6. **联网步骤显式**:`npm install`(装 gui 依赖)+ `vite build` 需联网/本地跑 —— 计划里单列,环境 429 时交用户执行。
7. **a11y 基线内建**(§6.2):键盘可达 + `aria-label` + 审批语义 + WCAG AA,D-1 就打底,不留 D-2。
8. **布局契约**(§6.1):列宽/折叠断点/滚动归属/截断写死;断点用纯函数 `layoutForWidth` 可测。
9. **占位强标记**(§6.3):占位区显式徽标 + a11y 标签,真/占位视觉可区分,绝不混淆。
10. **reducer 不可变返回**(§5):改状态 action 返回新引用、不原地 mutate,测试守护。

---

## 10. 里程碑(供拆实施计划;每 Task 末测试+提交)
```
D1-M1  reducer 转 ESM(逻辑不改)+ 现有 workbench-state 单测改 import 全绿 + selectors 补测 + **不可变返回防线测试**(改状态 action 返回新引用、不 mutate)
D1-M2  **版本兼容门**(核 Node/npm/Electron 支持 react19/vite7/semi2.100 + engines 声明)→ Vite 构建接线:gui/package.json 依赖/脚本 + vite.renderer.config.js + main.js dev/prod 加载(smoke 走 prod)+ 构建校验测试(门控)
D1-M3  useKernel 取数编排纯函数(buildInitialLoads + 事件→action 映射)+ **layoutForWidth 断点纯函数** + node:test;useWorkbench/useKernel hook 薄封装
D1-M4  组件外壳:App + TopBar + ActivityRail + Sidebar + CodeWorkspace(静态)+ ChatPanel 骨架(Semi UI 四栏)+ **布局契约(§6.1 列宽/滚动/截断)** + **a11y 基线(§6.2 键盘/aria/focus)**
D1-M5  数据接线:ChatThread/ApprovalBanner(role=alertdialog+aria-live)/Timeline/分支/检查点/状态栏/主题 接 reducer(真);Composer→send、interrupt
D1-M6  主题(night/day↔Semi + CSS 变量,WCAG AA)+ **占位强标记(§6.3 徽标 + isLivePanel 纯函数)**(文件树/编辑器/终端/未接卡片)
D1-M7  Electron smoke 更新(门控):加载构建产物、断言四栏外壳 + 状态栏/composer/approval + a11y(aria-label/焦点);**截图验收 desktop(1440)+ narrow(800)**;e2e 保真:send→消息、approval→approve
D1-M8  回归(现有 782 + 新前端 node:test 全绿)+ 文档(overview GUI 段 / CHANGELOG / README 中英 GUI 启动更新 / docs/README 索引)
```
> M1/M3 纯 node:test(含不可变/断点/占位判定);M2 版本门 + build 校验;M4–M6 组件(build+smoke+截图覆盖);M7 smoke/e2e/截图;M8 收口。**装依赖 + vite build 若需联网,M2 单列交用户。**

---

## 11. 测试策略(node:test + build/smoke)

> **依赖门控(自审补,关键)**:build 校验 / Electron smoke 需 gui 依赖已装(联网),在无 deps 环境**优雅跳过**(检测 `gui/node_modules/vite`、`electron` 缺失 → `test.skip`,同现有 `gui-smoke.test.js` 门控)。**核心 `npm test` 套件(reducer/hooks/adapter 等纯 node:test)不依赖任何 gui deps** → 782 基线在无 gui install 环境仍全绿。

- **reducer/selectors**(node:test,无 deps):迁 ESM 后现有断言全绿 + 补 selectors 边界。
- **reducer 不可变**(node:test,无 deps,review d):改状态 action → `next !== prev` 且旧 state 未被 mutate;无关 action → 同引用。
- **layoutForWidth / isLivePanel**(node:test,无 deps):断点边界(760/1060/1340)产出正确显隐;占位判定真/占位正确。
- **useKernel 取数编排**(node:test,mock `deepseek` API,无 deps):`buildInitialLoads` 产出正确 call→action;事件→`event_received`;错误→`error_reported`;`deepseek` 缺失→degraded 不崩。
- **event-adapter**(现有)保留。
- **Vite build 校验**(门控):`vite build` 成功产出 `renderer-dist/index.html` + 资源(spawn build 或断言产物存在);无 vite → skip。
- **Electron smoke**(门控,扩现有 `gui-smoke.test.js`):加载**构建产物**,断言四栏容器 + 状态栏 + composer + (注入 approval 事件后)approval banner 挂载;**a11y**:关键图标按钮有 `aria-label`、ApprovalBanner `role=alertdialog`、Tab 焦点可达;无 electron → skip。
- **截图验收**(门控,review e):smoke 截 **desktop(1440×900)+ narrow(800×720)** 两图,人工/断言核:四栏(或折叠后)可见、composer 可用不被遮、approval banner 不遮挡、长 branch/file/message 截断合理。图存 `gui/__screenshots__/`(gitignore 或留档,M7 定)。
- **保真 e2e**(门控):mock kernel 事件 → 断言 ChatThread 渲染消息、approve 调 `window.deepseek.approve`、rewind 流程可达。
- **回归**:现有 782 全绿(后端零改动;纯逻辑新测无 deps 依赖);带 deps 时 build/smoke/截图额外覆盖。

---

## 12. 开放问题(实施中可定)
- dev 模式起 Vite devserver 的方式(并发脚本 vs `DEEPSEEK_CODE_GUI_DEV_URL` 手动)——M2 定,smoke 只依赖 prod 产物不受影响。
- Semi UI 暗色与自定义 CSS 变量的优先级/覆盖范围(先 Semi 主题 + 局部变量,冲突再收敛)。
- 静态代码预览的高亮方案(轻量 token 着色 vs 留白等 Monaco)——本片从简。
- 组件级测试是否后续引 @testing-library/react(本片不引,纯逻辑已覆盖;若组件逻辑变重再评估)。
