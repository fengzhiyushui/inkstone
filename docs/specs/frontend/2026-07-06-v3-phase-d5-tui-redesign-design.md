# V3 Phase D-5 · TUI 重设计(行内滚动流 agent 会话 TUI)设计

- 日期:2026-07-06
- 状态:已评审(四问 + 设计分段确认 + /config 修订,用户已批)
- 前置:D-1–D-4 GUI 线已收官;支柱①②已收官。本篇属支柱③前端三端中的 TUI 线。
- 关联:`docs/plans/frontend/`(plan 待产出)· GUI 先例 `2026-07-02-v3-phase-d3-gui-full-functional-design.md`(API 列表管理)· `src/apps/cli/kernel-runner.js`(chat REPL 契约)

## 1. 背景与目标

现 `src/tui.js`(568 行)是菜单循环式(12 个动作 + readline 问答 + 结果页),与现代 agent CLI 的交互形态脱节。目标:整体重写为 **claude code 式行内滚动流 agent 会话 TUI**——持久对话滚动区 + 底部固定输入框/状态栏 + 流式输出 + 工具/diff/审批卡片 + slash 命令。

**非目标**:alt-screen 多窗格、鼠标支持、TUI 复刻 GUI 设置页全部七组(只做 API 列表管理)、多主题系统。低频功能(search/scan/test/rollback)不进 TUI——交给 agent 工具调用或既有 CLI 子命令(`deepseek-code search/scan/test/rollback`,已存在)。

## 2. 决策记录

1. **范围** = agent 会话主体 + 高频 slash 命令;低频功能出 TUI(CLI 子命令兜底)。
2. **双语 zh/en,默认中文**,`/lang` 切换并持久化到 `.deepseek-code/tui-prefs.json`(原子小文件);字典形态对齐 `gui/src/i18n/strings.js`。
3. **零运行时依赖手写 ANSI**(主包保持零依赖;不引 Ink/blessed 等会定观感的框架,延续 GUI「手写皮」方针)。
4. **渲染模型 = 行内滚动流**(claude code 式):历史消息直接打进终端原生滚动区(滚轮/复制/搜索全是终端自带),仅底部输入框 + 状态栏为固定重绘区。已否决:整屏 alt-screen(丢原生滚动/复制,零依赖下整屏 diff 重绘代价大)、命令式直绘(现 tui.js 式,不可测)。
5. **/config = 与 GUI 同一套 API 列表管理**(用户修订指定):共享实现与存储,激活互通(见 §6)。
6. **autonomy 默认 `gated`**(有审批门,对齐 claude code 手感),`/mode` 可切 `read-only|gated|auto`。
7. **kernel 核心(`src/core|deepseek|tools|edits|sessions|context|security|workspace` 等)零改动**;流式靠既有 `options.onDelta` 透传(`agent-runtime.js:156` 展开 options → `model-gateway.js:58` 消费 `options.onDelta`)。允许动的是 app 层(`src/apps/`、`src/tui.js`、`gui/` 接线)。

## 3. 架构与文件布局

沿用 GUI 线「纯逻辑 + 薄 IO」模式,新目录 `src/apps/tui/`:

| 模块 | 职责 | 纯度 |
|---|---|---|
| `tui-state.js` | reducer:对话时间线、输入行(光标/编辑/输入历史)、流式缓冲、审批挂起、mode/lang/busy、slash 与配置选择器菜单态 | 纯,node:test |
| `event-cards.js` | kernel 事件 → 卡片/行模型(工具对、diff 卡、审批卡、编排/验证/修复进度行、终态行) | 纯 |
| `tui-i18n.js` | zh/en 文案字典 + `t(lang, key, params)` | 纯 |
| `slash.js` | 命令注册/解析/前缀补全:`/config /diff /changes /mode /lang /clear /recovery /help /quit` | 纯 |
| `ansi.js` | 转义序列构造(光标移动/行擦除/样式/括号粘贴开关),扩展 `theme.js`,尊重 `NO_COLOR` | 纯 |
| `input.js` | 原始字节流 → 按键事件(字符/方向/Home/End/Ctrl 键/回车/退格/括号粘贴块) | 纯 |
| `paint.js` | (prevState, nextState) → 写序列:历史区 append(println 进滚动区)+ 底部区重绘(擦除重画);`write` 可注入 | 薄 IO |
| `config-flow.js` | /config 交互状态机(列表→操作菜单→逐字段编辑),纯 reducer 子域,被 `tui-state` 组合 | 纯 |
| `tui-app.js` | 组合根:createKernel、`session.subscribe`、驱动 reducer、重绘调度(setImmediate/16ms 合并)、send/approve/history、终端态进出与 finally 恢复 | 组合根 |

- `src/tui.js` 保留为薄入口,`runTui(root, kernel = null)` 签名不变(cli.js 分发不动);旧菜单代码与旧导出(`renderTuiStatusLine` 等)删除,旧 tui 单测同步替换。
- 共享新模块(见 §6):`src/apps/api-profiles.js`、`src/apps/model-catalog.js`。
- `package.json` check 脚本:加入 `src/apps/tui/*.js` 与两个共享模块;`gui/api-profiles.js` 移除。

## 4. 交互设计

基准 mockup(评审时已批):

```
(终端原生滚动区 — 滚轮/复制/搜索都是终端自带)

 ❯ 把 config.js 默认超时改成 30s

 ● 我先看一下 config.js 的当前实现…
 ┌ tool ▸ read  src/config.js            ok
 └ tool ▸ edit  src/config.js            +2 −2
 ┌─ diff · src/config.js ─────────────
 │ - timeoutMs: 10_000,
 │ + timeoutMs: 30_000,
 └──────────────────────────────────
 ✓ 已完成:默认超时改为 30s(chg_a1b2)

───────────────────────────────────────
 ❯ 输入消息,/ 呼出命令…        ← 底部固定重绘区
───────────────────────────────────────
 gated · deepseek-chat · tokens 12.4k · cache 71%
```

- **底部固定区**(唯一重绘区):分隔线 + `❯` 输入行 + 状态栏(`mode · 模型 · 运行态 spinner · tokens · cache% · 语言`,数据源 `kernel.runtime.getState()/metrics.getUsage()/config.getPublicConfig()`)。输入行支持:字符插删、←→/Home/End、↑↓ 翻本地输入历史、括号粘贴(多行粘贴合并为一条消息)。
- **历史区卡片**:用户行 `❯`;助手流式文本(onDelta 打字机式在底部区预览,回合完成后定格 println 进滚动区);工具对 `┌/└ tool ▸ name … ok/err ±计数`;diff 卡(边框 + 着色 ± 摘录,数据取自 `file:diff_preview`/`file:diff_applied` 事件负载);审批卡;`✓/✗` 终态行;编排(route_resolved lane、worker 轮次)/verification/repair 压缩为单行进度;`model:request/response`、`agent:step` 等噪音事件静默(沿 `render-events.js` 的 QUIET 思路扩充)。
- **审批**:`send` 返回 `awaiting_approval` 时输入区切审批态(`y` 批准 / `n` 或 `Esc` 拒绝),卡片显示 approval summary 与 diff 预览;`kernel.agent.approve(id, decision)` 循环直至终态(同 `resolveApprovals` 契约)。
- **slash 菜单**:输入 `/` 在输入行上方弹前缀过滤补全列表(重绘区临时长高),↑↓ 选、Tab/Enter 补全、Esc 关闭。`/diff` = 工作区 git 差异(复用 `src/git.showDiff`)渲染为 diff 卡进滚动区;`/changes` = 最近改动记录(复用 `src/changes.listChanges/formatChange`,默认 5 条)渲染为卡片,只读不含回退(回退走 CLI)。
- **流式降级**:onDelta 仅单 agent 通道有效;编排通道(orchestrate lane)无顶层流式 → 状态栏 spinner + 事件进度行呈现,不装死。
- **中断/退出**:`/quit` 退出;`Ctrl+C` 空闲时双击(3s 内)退出、单击给提示;回合运行中的中断——plan 阶段核实 `kernel.agent.send` 是否透传 AbortSignal:支持则 `Esc` 中断当前回合,不支持则显示「等待当前回合结束」提示(两分支行为都已定义)。
- **Resize**(SIGWINCH)只重绘底部区;非 TTY 启动直接报错(同今天);要求支持 VT 序列的终端(Windows Terminal / 现代 conhost / 各类 *nix 终端)。

## 5. 数据流

- **事件路**:`kernel.session.subscribe` → `event-cards` 派生 → reducer dispatch → 重绘调度器(合并高频事件,空闲帧刷)。
- **发送路**:提交输入 → `kernel.agent.send(text, { autonomy, history, onDelta, stream: true })` → delta 进流式缓冲(只重绘底部) → `complete` 后按 `appendHistory` 同语义更新 TUI 持有的 history 数组(与 `kernel-runner.js` chat REPL 契约一致;helper 可导出复用则复用,否则镜像实现,plan 定) → `awaiting_approval` 进审批态。
- **会话上下文归 TUI 持有**(caller-owned history):/clear 清空;/config 激活重建 kernel 后 history 原样保留,上下文不丢。

## 6. /config = API 列表管理(与 GUI 共享)

**一份实现、一份存储,GUI 与 TUI 管理同一个 API 列表,激活互通。**

- **共享迁移**:`gui/api-profiles.js`(纯 Node:fs/path,原子写)提升为 **ESM `src/apps/api-profiles.js`**,逻辑不变;`gui/kernel-host.js` 改动态 import 复用(D-4 已有 `src/edits/change-store.js` 动态 import 先例)。存储文件名 `.deepseek-code/gui-api-profiles.json` **保留不改**(兼容既有数据,名字属历史遗留,注释注明)。`listModels` 的 fetch(GET `{baseUrl}/models`,Bearer)抽成 **`src/apps/model-catalog.js`**(fetch 可注入、可测),两端共用;连接测试本就共享 `src/provider.testDeepSeekConnection`。
- **TUI 交互**(复用 slash 菜单同款选择器,底部区临时长高):
  - 列表视图:每条 `名称 · baseUrl · 模型 · ●激活标 · sk-…abcd 掩码` + 「新增」;
  - 操作菜单:**激活 / 编辑 / 拉取模型列表 / 连接测试 / 删除**,Esc 逐级返回;
  - 编辑/新增逐字段输入(名称/baseUrl/密钥[掩码输入]/模型);模型字段可从拉取结果 ↑↓ 选,**不设默认、拉取失败红字报错**(对齐 GUI 原则);
  - **激活** = `apiProfiles.activate(id)` → `configureProject` 写 config.json → **TUI dispose 并重建 kernel**(history 保留)→ 状态栏模型名即时刷新。
- **安全不变量**(同 GUI):明文密钥只落 `.deepseek-code/`(随仓忽略);滚动区/状态栏/卡片只出现掩码;密钥不进对话 history、不进流式缓冲。

## 7. 安全与边界

- 退出与异常路径 finally 恢复终端态:cooked mode、显示光标、颜色复位、关闭括号粘贴。
- `NO_COLOR` 只降级样式,不破坏布局;宽字符(中文)按显示宽度计算光标列(输入行与卡片边框对齐需 wcwidth 近似:CJK 记 2 列,纯函数实现进 `ansi.js`)。
- kernel 核心零改动红线见 §2 决策 7;gui/ 侧只动 `kernel-host.js` 的 api-profiles/listModels 接线,行为不变、由既有 gui node:test 回归把关。

## 8. 测试策略

- **纯层全 node:test**:reducer(含 config-flow 子域)/event-cards/slash/i18n/ansi(含宽度计算)/input(按键与粘贴解码)/paint 差量输出(注入 write 捕获断言序列)。
- **`tui-app` 全链路 node:test**:构造函数接受 `{ input, output }` 可注入流(默认 process 流)+ mock kernel(脚本化 send/approve/subscribe/onDelta),覆盖:一轮流式回合、审批 y/n、slash 补全、/config 增改激活(mock profiles 目录)、/lang 切换、Ctrl+C 退出、终端态恢复。**不依赖真 pty。**
- **门控真终端 smoke(可选)**:检测到 gui 的 node-pty 已装才跑「启动 → mock 一轮 → 退出」并断言无 ANSI 残留,未装优雅 skip(对齐 gui 门控 smoke 哲学);核心 `npm test` 不受影响。
- **回归**:api-profiles 迁移后,gui 侧既有单测更新 import 路径并保持全绿;全量 `npm test` + `npm run check`(check 清单同步增删)。

## 9. 里程碑草案(细化归实施计划)

- **M1 纯基建**:`ansi.js`(含宽度)/`input.js`/`tui-i18n.js`/`tui-state.js` 骨架 + node:test。
- **M2 事件派生**:`event-cards.js` + reducer 集成(含静默清单、编排/验证压缩行)。
- **M3 渲染**:`paint.js` 历史 append + 底部区重绘 + 调度合并;注入 write 断言。
- **M4 组装**:`tui-app.js` 接线 kernel(send/approve/流式/历史/mode/状态栏)+ 注入流全链路测试;`src/tui.js` 薄入口替换旧菜单;核实 AbortSignal 分支。
- **M5 slash 基础命令**:`/help /lang /mode /clear /diff /changes /recovery /quit` + 补全菜单。
- **M6 /config 配置管理**:api-profiles ESM 迁移 + model-catalog 抽取 + gui 动态 import 切换与回归 + TUI 配置流(config-flow)全交互。
- **M7 收口**:门控 pty smoke + 全量回归 + check 脚本 + 文档(overview/CHANGELOG/README 中英/索引)。

## 10. 硬约束(Global Constraints)

1. 主包零新增运行时依赖(devDependencies 亦不加;门控 smoke 只复用 gui 已有 node-pty)。
2. kernel 核心 `src/` diff 为空(例外仅:`src/apps/` 新增/改动、`src/tui.js` 薄入口重写;与 §2 决策 7 一致)。
3. `runTui(root, kernel = null)` 对外签名不变;`deepseek-code tui` 行为入口不变。
4. 双语文案全部走 `tui-i18n.js`,禁止组件内硬编码中英文。
5. 密钥明文只存在于 `.deepseek-code/` 与输入瞬间的内存;渲染路径只见掩码。
6. 任何退出路径(正常/异常/信号)必须恢复终端态。
