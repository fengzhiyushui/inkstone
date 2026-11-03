# 工作台与三端（Living Spec）

- 类型：前端 spec
- 状态：Living Spec，随实现更新；v1.19.0 整合自 13 篇历史 spec（壳层形态至 v1.8.1）
- 关联：[系统架构](../architecture/system-architecture.md) · [MCP 子系统](../architecture/mcp-subsystem.md) · [运行时与执行](../backend/runtime-and-execution.md) · [编辑/会话/恢复](../backend/edits-sessions-recovery.md) · [文档索引](../../README.md)

> 本文是 v1.19.0 整合后的领域 Living Spec，取代原 13 篇碎片化历史 spec（见文末「来源」）。三端只负责输入、展示、审批，共用 kernel facade 与 `src/apps/event-contract.js`，不重新解释内核原始事件。

## 来源与覆盖

| 来源（basename） | 覆盖内容 |
|---|---|
| `2026-05-31-v2-frontend-workbench-redesign-design.md` | V2 工作台视觉重设计：布局契约、色板规则、响应式断点 |
| `2026-05-31-v2-14-gui-workbench-branch-rewind-design.md` | 三栏 agent 工作台、分支/回退 IPC、指标 stat 行 |
| `2026-05-31-v2-15-natural-agent-workbench-design.md` | 自然工作台：activity rail、双主题 token、traffic 语义、inspector 随选中切换 |
| `2026-05-31-v2-16-gui-interaction-hardening-design.md` | 偏好持久化、键盘可达、inspector/drawer 生命周期、Electron smoke |
| `2026-06-27-v3-phase-d1-gui-react-shell-design.md` | React + Vite 渲染层、布局契约、a11y 基线、占位强标记 |
| `2026-07-01-v3-phase-d2-gui-functional-design.md` | 真文件树、Monaco 只读、Agent 卡片、终端、`language` 持久化 |
| `2026-07-02-v3-phase-d3-gui-full-functional-design.md` | 设置页七组、API 列表、可编辑保存、菜单模型、分支切换 |
| `2026-07-02-v3-phase-d4-change-tracking-design.md` | SCM「AGENT 改动」分区、前后对比、hunk 跳转 |
| `2026-07-06-v3-phase-d5-tui-redesign-design.md` | TUI 行内滚动流、十模块、slash 命令集、`/config` 共享 |
| `2026-07-12-v3-phase-dg4-cli-alignment-design.md` | 三端共享事件展示契约 `describeEvent`、CLI 编排摘要 |
| `2026-07-28-v1.4.0-frontend-redesign-design.md` | 会话优先 UI 重做定稿、10 套主题、指标 5 形态、侧栏三段 |
| `2026-09-17-v1.8.0-ergo-restyle-design.md` | 工学换肤：四段带主题、对比度闸门常驻、卡片两段式 |
| `2026-09-20-v1.8.1-dsh-shell-design.md` | 壳层三列 + dock + 设置模态、列宽常量、代码纪律 |

---

## 1. GUI 演进脉络

| 阶段 | 版本 | 内容 |
|---|---|---|
| V2 视觉重设计 | 2026-05-31 | 原生 HTML/CSS/JS 三栏工作台：Sidebar 260px / Conversation 弹性 / Inspector 340px + 固定 status bar；近黑 ink 底、3–4 层 slate 表面；绿=运行/成功/缓存、蓝=中性主操作、琥珀=审批/警告、红=危险；圆角 4–8px、间距 4px 基数；`≤1020px` 收起 inspector、`≤720px` 侧栏折成顶部上下文条 |
| V2-14 / V2-15 / V2-16 | 2026-05-31 | 三栏 agent 工作台 → 自然工作台（activity rail + 可折叠 context + 右 inspector + 底 statusline，双主题 token、traffic 状态簇）→ 交互加固（偏好落 `.deepseek-code/gui-preferences.json`、Ctrl+1..5 / Ctrl+K / Escape、显式 inspector 关闭、Electron smoke） |
| V3 D-1 React 外壳 | 2026-06-27 | 渲染层迁 React + Vite（`gui/src/`），手写 VS Code 风格设计系统 + 内联 SVG（弃用 Semi UI 等强加观感的成品套件）；组件命名对齐 IDE 心智；`workbench-state.js` 纯 reducer 转 ESM；中英双语 i18n 默认中文；后端/IPC/`window.deepseek` 契约不动 |
| V3 D-2 做真 | 2026-07-01 | 文件树、Monaco 只读查看、实时 Agent 卡片、node-pty 交互终端全部接真数据；修 `language` 偏好未持久化 |
| V3 D-3 全功能 | 2026-07-02 | 设置页（含模型接入 API 列表）、菜单真下拉、状态栏 Ln/Col、可编辑保存、分支切换、检查点回退确认流 |
| V3 D-4 改动跟踪 | 2026-07-02 | SCM「AGENT 改动」分区 + 前后对比 + hunk 跳转 |
| v1.4.0 会话优先 UI 重做 | 2026-07-28 | GUI 参 Codex / Claude Desktop、TUI 参 opencode；10 套主题、侧栏三段固定、指标 5 形态、TUI 首页垂直居中限宽 74ch、`/theme` `/shell` |
| v1.8.0 工学换肤 | 2026-09-17 | 10 套主题从「5 暗 5 明双峰」重编为暗 → 柔暗 → 柔明 → 明四段带；卡片两段式；composer 柔光；主题中枢 ThemeHub；对比度闸门升级为常驻单测 |
| v1.8.1 壳层重构（β） | 2026-09-20 | 三列可拖拽 grid + 右栏 dock + 模态设置；结构色改明暗两档中性阶梯，10 主题只保留 accent/语义槽 |
| D-G7 恢复中心 | 2026-09-15 | Recovery Center 完整检查器（v1.7.1 装箱） |
| v1.7.2 缺陷补丁 | 2026-09-17 | assistant 回复入流、usage 刷新、未定义变量；敏感模态冒烟截图 |

**Pivot 注记**：早期 Semi UI / CodeMirror / xterm 栈在实施中已改；相位编号以 D-1–D-5 / D-G4 与 CHANGELOG 为准，而非早期 D-0 草案。

---

## 2. 当前壳层规格（v1.8.1 落地形态）

### 2.1 布局

- **三列 grid + 拖拽 handle + 右栏可收**；Windows 上原生 `titleBarOverlay` 接管窗控，Frame 自带 **40px 标题栏拖拽区**（`data-windows-titlebar`，`padding-top: 40px`）。
- 列宽常量（`gui/src/state/columns.js`）：

| 常量 | 值 |
|---|---|
| `SIDEBAR_MIN` / `MAX` / `DEFAULT` / `COLLAPSED` | 264 / 420 / 280 / 56 |
| `SIDEBAR_AUTO_COLLAPSE` | 1024 |
| `RIGHTBAR_MIN` / `MAX` / `MAX_RATIO` / `DEFAULT_RATIO` | 300 / 1600 / 0.7 / 0.45 |
| `CENTER_MIN` | 400 |

`computeColumns` / `clampWidth` / `clampRightbarWidth` / `computeKeyboardDelta` 均为纯函数。窄窗 `<880` 强制右栏关、侧栏可折叠；列宽拖拽持久化到偏好（`sidebarWidth` / `rightbarWidth` / `rightbarOpen`）。

### 2.2 组件

`App.jsx` 组 `AppFrame`（三列 + `DragHandle`）、`Rail`（侧栏：新会话、功能区、搜索、项目树、设置）、`ChatView` / `HomeView`、`Composer`、`Dock`（四 tab）、`Settings/` 模态。组件落在 `gui/src/components/v4/`。类名沿用 `.rail-*` `.cz-*` `.ev-*` 等，CSS Modules 只对新建组件使用。

**右栏 dock 四 tab**：`plan` / `files` / `changes` / `recovery`（`role=tablist/tab`，面板槽 + 关闭钮）。文件树接 `listTree`/`readFile`；改动接 `ChangesPanel`；恢复接 `RecoveryPanel`。视图：`home|chat|projects|mcp|plugins`。

**会话页**：用户气泡右对齐限宽，助手正文无气泡，思考折叠，composer 卡 + stats 行。`chatTab` 支持对话/轨迹。

### 2.3 主题

- **10 套主题 id**：`sumi`(墨) / `slate`(玄) / `vesper`(烬) / `nord`(峡) / `ash`(灰) / `snow`(霜) / `sand`(沙) / `lotus`(荷) / `latte`(瓷) / `paper`(宣)。旧 id 经 `LEGACY_THEME_MAP` 静默迁移（`night→sumi`、`day→latte`、`dawn→lotus`、`mocha→sumi`、`moon→slate`、`forest→ash`、`clay→vesper`、`rose→sumi`）。
- **v1.8.0 四段带**：dark L 25–51（3 套）/ dim L 55–89（2 套）/ tint L 165–235（2 套）/ light L 236–251（3 套）。对比度 ≥7:1 决定底色亮度有物理死区（L 90–164 之间白字与墨字都做不到 7:1），过渡主题只能从两侧向死区边缘延伸。
- **v1.8.1 C 变体**：结构槽 10 个（`bg-base/panel/element/inset`、`text/mut/faint`、`border/border-strong`、`code-bg`）走明暗两档，两档逐字节相同；10 主题各定义 `accent/hover/soft/text` 与 `ok/warn/err/info`。见 `gui/src/styles/tokens.css`。`themes.js` 保留 `tier` 与 `group`，`isLightTheme()` 语义不变；四档只是展示分组，代码明暗判定仍二元（`dark|dim → dark`，`tint|light → light`）。
- **对比度闸门常驻单测**：`scripts/check-theme-contrast.mjs` + `tests/unit/gui/theme-contrast.test.js`，亮度实现单源 `gui/src/state/contrast.js`。阈值：正文/画布与正文/面板 `[7, 19.5]`；次级 ≥4.5；弱化/强调/语义 ≥3；按钮文字 ≥4.5；描边 ≥1.5。v1.8.1 闸门口径为结构 2×7 + accent 10×4 = 54 项。设置 › 外观按四段分组，ThemeHub 展示五色块 + hex + 实测对比度详情。
- 舒适性：正文对比上限 19.5；字阶不出现 <11px；卡片圆角 10–14px；柔光只在 `focus-within` 与 hover；玻璃态只给浮层，`blur ≤ 12px`（偏好 `glass`）；动效 ≤ .25s 且尊重 `prefers-reduced-motion`。
- 冻结清单：`<html theme="id">`、18 槽位名、10 个 `[theme]` 块、smoke 选择器、`.rail-fn` 顺序、`.cz-meta` 5 形态、`.shell.shell-settings`、30px 标题栏、`.sn-backdrop`。

### 2.4 双语

中英双语 i18n，**默认中文**（`language: "zh"`，`normalizeGuiPreferences` 只接受 `en`/`zh`，非法回 `zh`）。中文界面下配置必须完整。TUI `/lang` 持久化。

---

## 3. 数据接入与安全边界

- GUI **只经 `gui/kernel-host.js`**（主进程）+ `gui/preload.js`（`window.deepseek` bridge）触达内核；renderer 不直接依赖 Node runtime，不裸 `fs`。
- **`IPC_CHANNELS` 是唯一权威清单**（`gui/main.js`）：`registerIpcHandlers` 里任何未登记 channel 的 `handle` 注册会在**启动即抛错**（`IPC channel "..." is not in the IPC_CHANNELS allowlist`），防止新增通道漏登记；渲染层仅能调用 preload 暴露的子集。IPC 不暴露任意 kernel 方法。
- `nodeIntegration: false` + `contextIsolation: true` + `sandbox: true`。
- **API Key 绝不回渲染层明文**：`getSettings()` 对任何 apiKey 只回 `hasKey` / 掩码（如 `sk-…abcd`）；Key 明文只落 `.deepseek-code/`。GUI IPC、日志、会话事件都不含密钥。
- v1.18.0 起 `will-navigate` 与 `setWindowOpenHandler` 拦截非本地应用入口的外部跳转，防渲染层被诱导导航至外部不可信 URL。
- `gui/package.json` 不得新增 `@deepseek-ai/*`；守卫测试（`no-dsh-imports`）断言源文本无此类 import。不复制 DSH 源文件，每个新文件是 Inkstone 原生写法，文件头不标 DSH 来源。
- `src/core` / `src/index.js` 零改动红线；GUI 依赖只进 `gui/package.json`，无 gui deps 时核心 `npm test` 仍全绿。
- 动态内容一律 `textContent`，禁止不安全 `innerHTML`；模型输出禁 `innerHTML`。

---

## 4. 文件与编辑

- **真文件树**：递归 `projectRoot`，排除 `.git` / `node_modules` / `.deepseek-code` / `renderer-dist` / `dist`，返回扁平 `[{ path(rel, posix), name, type:"dir"|"file", depth }]`，约 5000 条封顶并截断标记；渲染层组装折叠树。IPC `fs:tree` / `fs:read` / `fs:write`。
- **`readFile(relPath)`** 经 `src/workspace/path-safety.js` 的 `resolveWorkspacePath`（realpath 边界，阻 symlink 逃逸）。拒目录、超大（约 1MB）、二进制（NUL 探测）。返回 `{ path, content, language, truncated }`，`language` 由扩展名映射。
- **Monaco 只读 Diff**：`monaco-editor` + `@monaco-editor/react`，本地 worker（不依赖 CDN），`base:"./"` 下 worker 路径相对。`readOnly:true`、`theme` 随 night/day（`vs-dark`/`vs`）、`language` 来自读文件结果、minimap 关或简、字体 Cascadia Code。`openFiles`/`activeFile` 管标签，点树打开/激活。Monaco Diff 只读对比 before/after。
- **手动保存走独立 `editService.apply`**：Monaco 可写，dirty 进 reducer；`Ctrl/⌘+S` → `writeFile` 生成整文件 unified diff → `editService.apply({ diff, prompt: "gui edit" })`，成功清 dirty。与 agent 编辑同一事务/回滚管线，过 workspace 边界。
- 终端：`@xterm/xterm`、`@xterm/addon-fit`、`node-pty`（需 `@electron/rebuild` 按 Electron ABI）；`gui/pty-host.js` `spawn(cwd=projectRoot)`，`onData → pty:data`，IPC `pty:start`/`pty:input`/`pty:resize`/`pty:kill`，窗口关闭 kill。pty 不可用显示「终端不可用」，优雅降级不崩。
- **降级不崩**：`window.deepseek` 缺失时 degraded；无桥/读失败/读写失败均降级不崩。

---

## 5. 改动跟踪（D-4）

- **入口 = SCM「AGENT 改动」分区**（时间倒序折叠列表）+ Agent diff 卡联动；不加活动栏一级入口。
- **对比数据源 = change 记录内 `files[].before/after`**（`captureChangePlan` / `finalizeChange`），零解析、时点精确，新建/删除天然单侧为空；不渲 unified 文本、不读当前文件反推。
- **只读读取器**走 `createChangeStore({projectRoot}).list/describe`，复用 change-store；`editService.describe()` 不含 before/after，不用。`file:diff_applied` 带 `change_id`/`summary`/`files`；hunk 用 `parseUnifiedDiff`（`src/patch.js`）。
- **kernel-host 只读桥**：
  - `listChanges({limit=50})` 主进程瘦身后过 IPC，条目 `{ id, time, prompt, files:[{ path, status, added, removed, hunkStarts }], rolledBack }`，**不含 before/after/diff 全文**；diff 解析失败则计数为 null，不抛。
  - `describeChange(changeId, relPath)` 只回指定文件切片 `{ id, time, prompt, rolledBack, file:{ path, status, before, after, language, added, removed, hunkStarts } }`；`language` 用 `EXT_LANGUAGE` 映射；找不到 change/文件抛错。
- IPC：`changes:list` / `changes:describe`。preload：`listChanges(limit)` / `describeChange(id, path)`。
- **UI**：头行 `时间 · prompt截断 · 来源标签 · ↺已回滚`，子行 `M/A/D path +a −r`。`ChangeDiffView` 在代码区替代 Editor（不进标签条），头部 path/时间/prompt + hunk chips + 「跳到编辑器」；`revealLineInCenter(clamp)`。diff 卡片可点，默认首文件。
- 渲染状态 `changes[]` / `changeDiff` / `pendingReveal`；action `changes_loaded` / `change_diff_loaded` / `change_diff_dismissed` / `reveal_requested` / `reveal_consumed`。`file:diff_applied`/`file:rollback_applied` 自增 `changesTick` 触发重拉（activity 50 条滑窗下事件计数不单调，故用 tick 而非 version）。
- 纯函数 `changes-derive.js`：`deriveChangeEntries` 归一来源标签（`source: "manual"|"agent"`；手动保存 prompt 前缀 `"GUI edit "` → manual）。回滚看 `rollbacks.jsonl` 与 `file:rollback_applied`。
- GUI 对 `changes/` 与 `rollbacks.jsonl` 只读；全部显示 + 来源标签 + 已回滚标记，过滤器先不做。

---

## 6. Inspector 面板

随选中对象切换：事件详情、检查点回退预览、审批风险详情、分支祖先/检查点、无选中时近期活动与健康。**审批与回退自动聚焦 inspector**。

生命周期：审批、回退预览、错误/冲突/恢复失败自动打开；可见关闭钮或 `Escape` 关闭（`inspectorMode: "activity"`，中/窄屏关 drawer 覆盖）；选检查点重回 rewind；审批解决后关 approval 模式，除非另有风险结果。

回退流程：点 `Preview` → `rewindPreview({ target })` → 展示目标标签、回滚数、文件、计划分支 id、force 勾选、`Apply rewind` → **无 preview 不 apply** → `rewindApply({ target, force })` 后渲染结果并刷新分支/检查点/时间线。

状态文案：`success` = Rewind applied. New branch active. / `conflict` = Rewind blocked by dirty files. / `conflict_restored` = Rewind blocked; previous changes were restored. / `failed_restored` = Rewind failed; workspace was restored. / `failed_unrestorable` = Rewind recovery failed. Manual check required.

审批传真实 approval id；UI 不显示 `reasoning_content`；回退预览只显示路径与计数，不显示原始 diff；恢复错误只显示安全类别。

---

## 7. 设置页

设置现为**模态**（`Settings/`），左导航右表单。分组由 `gui/src/state/settings-schema.js` 的 `SETTINGS_GROUPS` 驱动（纯 schema + coercion，node:test 覆盖）。

**D-3 起源的七组**：通用（语言、主题、界面偏好 → GUI 偏好）、模型接入（API 列表 CRUD + 激活、模型拉取、reasoning effort、连接测试 → `.deepseek-code/gui-api-profiles.json` + 激活写 `config.json`）、运行护栏（`toolTimeoutMs`/`modelTimeoutMs`/`maxTurnTokens`/`maxModelCalls`/`maxToolCallRepairs` → `config.limits`）、多智能体（`crossTaskLearning`、router 档、`maxRounds`、并行数 → `config.orchestration`）、语义上下文（`semantic.enabled`/`hops`/`maxSymbols`/`languages`/`importRoots` → `config.context.semantic`）、持久化恢复（`recovery.enabled` → `config.recovery`）、关于（版本、许可、链接）。

**当前 10 组**（`general` / `appearance` / `statusDisplay` / `api` / `model` / `limits` / `orchestration` / `context` / `experience` / `about`）：`appearance` 走 ThemeHub；`statusDisplay` 管指标形态、位置、11 个信息开关、数值格式；`model` 管 `models.act`/`think`/`fim`；`orchestration` 含 `maxRounds`/`maxSubtasks`/`maxWorkerAttempts`/`parallel.maxParallelWorkers`/`budget`/`router.model.enabled`/`crossTaskLearning`；`context` 含 `semantic.enabled`/`hops`/`maxSymbols`/`includeMethodHints`；`experience` 含 `retrieveK`/`cap`/`maxLessonsPerTask`。`sanitizeConfigPatch` 剥离 renderer-only 键；保存经 `setConfig(patch)` 复用 `src/config.js` 写 `.deepseek-code/config.json`，per-field 合并。

配置桥（kernel-host，`src` 零改动）：`getSettings()` 合并公开配置 + GUI 偏好 + API 列表；`listApiProfiles` / `saveApiProfile({id?,name,baseUrl,apiKey})` / `deleteApiProfile` / `activateApiProfile`，存储 `{ profiles:[{id,name,baseUrl,apiKey}], activeId }`；激活把 `apiKey`/`baseUrl`/model 写入 `config.json`；`testConnection(profileId?)` 复用 `provider.testDeepSeekConnection`；`listModels(profileId?)` 调 `{baseUrl}/models`（`Authorization: Bearer {apiKey}`）取 `data[].id`，**失败抛错，不静默回退**，`config.model` 仅在用户选定后写入。

**指标 5 形态**（`.cz-meta`，`statusDisplay` 偏好驱动）：`text` = `tok 34.2k · 命中 38%`；`num` = `上下文 34.2k/128k · 缓存命中 38%`；`bar` = 细长条 + 百分比（默认）；`dots` = 十格方块填充；`off` = 不渲染。状态型标签恒为文字。

**状态栏**：runtime、channel、total tokens、cache hit rate、active branch、autonomy、审批态、dirty/degraded/offline；Ln/Col 来自 Monaco `onDidChangeCursorPosition`，语言 = `activeFile.language`，模型徽标 = `config.model`。只放持久事实；无吞吐时不编造 speed，显示 `avg_latency_ms`。

**菜单**：标题栏菜单由 `menu-model.js` 纯模型驱动，自绘浮层；`enabled:false` 渲染置灰。活动栏视图 `explorer` / `search`（文件名过滤 `filterTree`）/ `scm` / `run` / `settings`。底部问题/输出由 `derivePanels(activity)` 派生。

**分支切换**：`activateBranch(id)` → `kernel.session.branches.activate(id)`，IPC `session:branch-activate`。

---

## 8. MCP GUI（McpView）

- **服务卡片状态流转**：`DISCONNECTED`（灰色，未启用或已停止）/ `CONNECTING`（黄色微光动效，正在启动子进程并初始化握手）/ `CONNECTED`（绿色常亮，展示探测到的工具标签）/ `ERROR`（红色报警，一键重试与错误堆栈折叠展开）。
- **接入方式选择**：stdio（command/args/env）与 streamable-http（url/headers/oauth）分别表单；`type` 缺省按 `command`/`url` 推断。
- **风险徽章 + 信任开关**：动态工具树按 annotations 推导的风险分类展示徽章；逐工具可设「始终允许」或「每次询问」；信任开关控制 annotations 是否被采信（不受信 server 默认偏保守）。
- **密钥面板**：`${input:name}` 引用的 secret inputs 由 GUI 收集（password 类型），不明文回显；OAuth 只由主进程打开授权 URL，IPC 仅返回安全状态（disabled/unauthenticated/pending/authenticated/error）。
- **资源树 + URI 模板 + 提示词参数浏览**：资源列表/读取、URI 模板列表、提示词列表与参数表单；「放入对话」只填入引用草稿，由用户发送。
- **日志 / 试跑**：日志抽屉按需加载、过滤、刷新、导出；工具试跑面板简单 schema 生成字段、复杂 schema 可输入 JSON，参数与可见结果限制 64 KiB。
- **全局弹窗需勾选确认**：MRTR 人工表单在应用层显示来源明确的弹窗，适用于聊天和工具试跑；**必须勾选确认才能提交**，支持拒绝与取消；schema 校验失败可重新填写。**非交互 CLI 立即 decline**；TUI 用独立于聊天历史的隐藏输入区（Enter 下一项、`y` 确认、`n` 拒绝、`Esc` 取消）。
- IPC：`mcp:list` / `mcp:restart` / `mcp:toggle` / `mcp:add` / `mcp:remove` / `mcp:inputs` / `mcp:set-input` / `mcp:auth-*` / `mcp:logs` / `mcp:logs-export` / `mcp:tools-list` / `mcp:tool-test*` / `mcp:input-requests` / `mcp:input-respond` / `mcp:resources-list` / `mcp:resource-templates-list` / `mcp:resource-read` / `mcp:prompts-list` / `mcp:prompt-get`。

---

## 9. 恢复中心（D-G7）

右栏 dock `recovery` tab 接 `RecoveryPanel`，与 CLI `/recovery`、TUI `/recovery` 共用同一 `kernel.recovery.*` 模型（`list` / `resume` / `cancel` / `clear` / `report`）。inbox 项类型 `paused_turn` / `recovered_tx` / `blocked_recovery` / `takeover` / `quarantined_state` / `orchestration_paused`，每项带 `allowed_actions`；`clear` 只软标记 `status:"cleared"` 且拒 blocked 项，无二次确认。启动序与阻断语义见[编辑/会话/恢复](../backend/edits-sessions-recovery.md) §6。

---

## 10. TUI（`src/apps/tui/`）

### 10.1 十模块

| 模块 | 职责 | 纯度 |
|---|---|---|
| `tui-state.js` | 对话时间线、输入行、流式缓冲、审批、mode/lang/busy、slash/配置菜单态 | 纯 |
| `event-cards.js` | kernel 事件 → 卡片/行模型 | 纯 |
| `tui-i18n.js` | zh/en 字典 + `t(lang, key, params)` | 纯 |
| `slash.js` | 命令注册/解析/补全 | 纯 |
| `ansi.js` | 转义序列、宽度计算、`NO_COLOR` | 纯 |
| `input.js` | 原始字节 → 按键事件（含括号粘贴） | 纯 |
| `paint.js` | state diff → 历史 append + 底部重绘 | 薄 IO |
| `config-flow.js` | `/config` 交互状态机 | 纯 |
| `tui-app.js` | 组合根：kernel、订阅、调度、终端态恢复 | 组合根 |
| `theme.js`（TUI 调色板） | 10 套 token 主题映射（`gen-tui-theme` 生成） | 纯 |

`src/tui.js` 保留薄入口 `runTui(root, kernel = null)`，签名不变。共享模块：`src/apps/api-profiles.js`、`src/apps/model-catalog.js`。**零运行时依赖手写 ANSI/VT**（不用 Ink/blessed 等框架），主包零依赖。

### 10.2 交互

- **行内滚动流**（claude code 式）：历史进终端原生滚动区，保留原生滚动/复制/搜索；底部固定输入框与状态栏。不用 alt-screen 整屏重绘。
- 历史区用户行 `❯`、助手流式（`onDelta` 底部预览，完成后定格进滚动区）、工具对 `┌/└ tool ▸ name`、diff 卡、审批卡、`✓/✗` 终态行；编排/验证/修复压成单行进度；`model:request`/`agent:step` 等静默。
- 底部固定区：分隔线 + 输入行 + 状态栏（mode · 模型 · spinner · tokens · cache% · 语言）。输入支持编辑、历史、括号粘贴。
- **审批**：`send` 返回 `awaiting_approval` 时 `y`/`n`/`Esc`，经 `kernel.agent.approve`。
- 会话 history 由 TUI 持有（caller-owned），`/clear` 清空；`/config` 激活重建 kernel 后 history 保留。
- **`/config` 与 GUI 共享 `api-profiles.js`**（存储 `.deepseek-code/gui-api-profiles.json`）与 `model-catalog.js`，一份实现一份存储，激活互通。**密钥明文只落 `.deepseek-code/`**，滚动区只见掩码。
- **退出/异常 finally 恢复 cooked mode、光标、颜色、括号粘贴**；`NO_COLOR` 只降级样式；宽字符按显示宽度算光标列。
- autonomy 默认 `gated`（有审批门）；kernel 核心 diff 为空，流式靠既有 `options.onDelta`。

### 10.3 slash 命令集

`/help` `/config` `/diff` `/changes` `/mode` `/lang` `/theme` `/shell` `/clear` `/recovery` `/branch` `/rewind` `/fim` `/mcp` `/quit`。

- `/diff` 复用 `src/git.showDiff`；`/changes` 复用 `listChanges`/`formatChange`。
- `/theme` 10 套；`/shell` Windows 宏（pwsh/powershell/cmd/git-bash）。
- `/mcp [list|restart <server>|disable <server>|enable <server>|logs [server] [limit]]` 不调用模型；管理操作与模型回合互斥，不支持 Esc 中断。
- `/recovery` 与 CLI 同 facade，`clear <id>` 无二次确认。
- `/fim` 位置补全（Q3 拍板：FIM 落 TUI/CLI，不引入编辑器依赖）。

---

## 11. 三端共享事件展示契约（D-G4）

`src/apps/event-contract.js` 的 `describeEvent(event) → EventDescriptor`：

```js
{ kind, sourceType, severity, quiet, fields }
```

- `sourceType` 保留原始 `event.type`；`kind` 是展示语义分类。
- 契约只做「已产出事件 → 展示语义」，**不改 core 事件生产**；`src/core` / `src/index.js` 零改动，不因展示契约改动而改动。
- **纯函数、无 I/O、无副作用、任意输入不抛错**：畸形输入返回 `other`。
- 归一规则集中一处：`name = call?.name || tool?.name || tool`；`changeId = change_id || record?.id`；`files` 兼容 `files`/`summary`；`normFiles` 的 `status` 缺省 `"M"`；`verification.pass` 为 `true|false|null`（未知≠失败）；缺失一律 `null`。
- `quiet` 是默认可见性提示（调试模式仍可显示），不是丢弃事件。

**完整 kind 映射**：

| 原始 `event.type` | kind | severity | quiet | fields |
|---|---|---|---|---|
| `user:message` | `user` | info | ✓ | `{ text }` |
| `tool:call` | `tool-call` | info | | `{ name, argHint }` |
| `tool:result` | `tool-result` | ok→success / 其他→warn | | `{ status }` |
| `permission:decision` | `permission` | info | | `{ decision }` |
| `approval:requested` | `approval` | warn | | `{ id, summary }` |
| `approval:resolved` | `approval-resolved` | info | | `{ decision }` |
| `file:diff_preview` | `diff-preview` | info | | `{ summaryText, diffHash }` |
| `file:diff_applied` | `diff` | success | | `{ changeId, files }` |
| `file:rollback_applied` | `rollback` | warn | | `{ changeId }` |
| `verification:result` | `verification` | passed→success / 其他→warn | | `{ status, pass }` |
| `repair:*` | `repair` | info | | `{ phase }` |
| `orchestration:routed` / `route_resolved` | `orchestration-route` | info | | `{ lane, score }` |
| `orchestration:planned` | `orchestration-plan` | info | | `{ subtasks, doneWhen }` |
| `orchestration:round_started` | `orchestration-round-start` | info | | `{ round, subtasks }` |
| `orchestration:subtask_started` | `orchestration-subtask-start` | info | | `{ subtaskId, attempt, toolProfile }` |
| `orchestration:subtask_reviewed` | `orchestration-subtask-review` | pass→success / 否→warn | | `{ subtaskId, pass, reviewSeverity }` |
| `orchestration:replanned` | `orchestration-replan` | info | | `{ round, newSubtasks }` |
| `orchestration:completed` | `orchestration-complete` | failed>0→warn / 否→success | | `{ rounds, completed, failed, status }` |
| `experience:retrieved` | `experience-retrieved` | info | retrieved==0 时 ✓ | `{ count, tiers }` |
| `recovery:report` | `recovery-report` | info | | `{ found, done, blocked }` |
| `recovery:blocked` | `recovery-blocked` | warn | | `{ reason, itemId }` |
| `session:rewind_*` | `rewind` | 见注 | | `{ phase, branchId, changeCount, failedChangeId, reason }` |
| `session:branch_*` | `branch` | info | | `{ branchId }` |
| `tx:recovered` | `tx-recovered` | info | | `{ kind, txId, preservedCount }` |
| `turn:*` | `turn` | info | | `{ approvalId }` |
| `takeover:*` | `takeover` | info | | `{ requestId }` |
| `model:*` / `agent:step` / `agent:turn_started` | `other` | info | ✓ | `{}` |
| `context:*` | `context` | info | ✓ | `{}` |
| `agent:final` | `final` | success | ✓* | `{ content }` |
| `agent:error` | `error` | danger | ✓* | `{ message }` |
| 其余 | `other` | info | ✓ | `{}` |

注：`rewind` 的 severity 由子类型细分；`final`/`error` 标 quiet 是既有各端约定（CLI/TUI 走 `send()` 结果路径）。`thought` kind 由 v1.8.0 推理摘要卡新增（purpose/model/推理 token，默认折叠）。

**三端薄适配层**：`src/apps/cli/render-events.js`、`src/apps/tui/event-cards.js`、`gui/src/state/agent-cards.js` 都是契约消费者；GUI `deriveAgentCards` 消费契约后折卡。措辞/颜色/i18n 各端自持，**契约不含展示字符串**。

**CLI 编排摘要**（单复数正确、无空括号、review 只出 `passed`/`failed`）：

| kind | 摘要 |
|---|---|
| `orchestration-route` | `routing: multi-agent` |
| `orchestration-plan` | `plan: N subtask(s)` |
| `orchestration-round-start` | `round N: N subtask(s)` |
| `orchestration-subtask-start` | `subtask <id>: starting (attempt N[, profile <p>])` |
| `orchestration-subtask-review` | `subtask <id>: review passed` 或 `review failed (severity: <level>)` |
| `orchestration-replan` | `replan round N: N new subtask(s)` |
| `orchestration-complete` | `orchestration complete: N succeeded, N failed (status: <status>)` |
| `experience-retrieved` | `experience: N recalled`（仅 count > 0） |

已覆盖的 V2 事件摘要逐字不变。审计问题 #5（四份事件展示实现）随 D-G4 共享契约完全解决。

**Agent 卡片映射**（`deriveAgentCards(activity)` 纯派生，node:test）：`orchestration:planned`/`round_started`/`replanned` → plan 卡；`tool:call` + `tool:result`（按 id 配对）→ tool 卡 running/ok/error；`file:diff_applied`/`file:diff_preview` → diff 卡（路径 + 增删行，带 changeId 与首路径）；`verification:result` → test 卡。乱序缺 result 标 running；仅完全空闲时显示示例预览。

---

## 12. 测试策略

- **纯逻辑走 `node:test`**：reducer / 不可变返回 / 断点（`layoutForWidth`、`computeColumns`）/ 占位（`isLivePanel`）/ 取数编排（`buildInitialLoads`）/ 菜单模型 / 视图切换 / 搜索过滤 / 设置归一 / 面板派生 / diff 映射 / 保存 diff 生成 / `deriveAgentCards` / 偏好归一 / tree 组装 / pty 生命周期 / `event-contract` 映射与别名 / theme-contrast 闸门 / `dom-contract` 冻结清单 / `no-dsh-imports` 守卫。
- **`vite build`**：产出 `renderer-dist/index.html` 与资源；断言构建含 monaco worker。
- **门控 Electron smoke**（`tests/e2e/gui-smoke.test.js`）：启动 `gui`，`--project=<temp>` 注入临时项目，断言外壳容器、状态栏、composer、审批挂载、aria-label、ApprovalBanner `role="alertdialog"` 存在、窗口非空、主题切换存在，然后干净退出。无网络、无真实模型调用。**Electron 不可用则明确跳过**；本地有 `gui/node_modules/electron` 时应跑。冒烟模式用 `DEEPSEEK_CODE_GUI_SMOKE=1` 隔离全局项目 MRU 登记表与 userData，只在 `os.tmpdir()` 下回收。
- **截图基线**：1440×900 / 1020×760 / 720×760 核 composer 可用、长文本截断合理、无空白区/重叠/噪色/不可读文本。
- **回归入口**：`npm test`、`npm run check`、`npm run build:renderer`、`gui-smoke`、`git diff --check`。测试用临时项目根，不在仓库根制造 `.deepseek-code/v2` 污染；真实用户启动 GUI 产生的不算测试污染。

---

## 来源

- `2026-05-31-v2-frontend-workbench-redesign-design.md`
- `2026-05-31-v2-14-gui-workbench-branch-rewind-design.md`
- `2026-05-31-v2-15-natural-agent-workbench-design.md`
- `2026-05-31-v2-16-gui-interaction-hardening-design.md`
- `2026-06-27-v3-phase-d1-gui-react-shell-design.md`
- `2026-07-01-v3-phase-d2-gui-functional-design.md`
- `2026-07-02-v3-phase-d3-gui-full-functional-design.md`
- `2026-07-02-v3-phase-d4-change-tracking-design.md`
- `2026-07-06-v3-phase-d5-tui-redesign-design.md`
- `2026-07-12-v3-phase-dg4-cli-alignment-design.md`
- `2026-07-28-v1.4.0-frontend-redesign-design.md`
- `2026-09-17-v1.8.0-ergo-restyle-design.md`
- `2026-09-20-v1.8.1-dsh-shell-design.md`
