# V3 Phase D-5 · TUI 重设计

- 类型：前端 spec
- 日期：2026-07-06
- 状态：已实现
- 关联：[GUI API 列表](2026-07-02-v3-phase-d3-gui-full-functional-design.md) · [CLI 对齐](2026-07-12-v3-phase-dg4-cli-alignment-design.md) · `src/apps/cli/kernel-runner.js`

## 问题与目标

旧 `src/tui.js` 是菜单循环加 readline 问答，与现代 agent CLI 脱节。整体重写为行内滚动流 agent 会话 TUI：历史进终端原生滚动区，底部固定输入框与状态栏，流式输出，工具/diff/审批卡片，slash 命令。

## 决策

| 选了什么 | 否决了什么 | 为什么 |
|---|---|---|
| agent 会话主体 + 高频 slash | 低频 search/scan/test/rollback 进 TUI | 低频交 CLI 子命令或 agent 工具 |
| 双语 zh/en，默认中文，`/lang` 持久化 | 多语言扩展 | 对齐 GUI |
| 零运行时依赖手写 ANSI | Ink/blessed 等框架 | 主包零依赖，且不强加观感 |
| 行内滚动流（claude code 式） | alt-screen 整屏重绘 | 保留原生滚动/复制/搜索 |
| `/config` 与 GUI 共享 API 列表 | 各自实现 | 一份实现一份存储，激活互通 |
| autonomy 默认 `gated` | 默认 auto | 有审批门 |
| kernel 核心零改动 | 顺手改 runtime | 流式靠既有 `options.onDelta` |

不做：alt-screen 多窗格、鼠标、TUI 复刻 GUI 全部设置组。

## 设计

新目录 `src/apps/tui/`：

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

`src/tui.js` 保留薄入口 `runTui(root, kernel = null)`，签名不变。共享模块：`src/apps/api-profiles.js`、`src/apps/model-catalog.js`。

交互：历史区用户行 `❯`、助手流式（onDelta 底部预览，完成后定格进滚动区）、工具对 `┌/└ tool ▸ name`、diff 卡、审批卡、`✓/✗` 终态行；编排/验证/修复压成单行进度；`model:request`/`agent:step` 等静默。

底部固定区：分隔线 + 输入行 + 状态栏（mode · 模型 · spinner · tokens · cache% · 语言）。输入支持编辑、历史、括号粘贴。

审批：`send` 返回 `awaiting_approval` 时 `y`/`n`/`Esc`，经 `kernel.agent.approve`。slash 菜单 `/config /diff /changes /mode /lang /clear /recovery /help /quit`。`/diff` 复用 `src/git.showDiff`；`/changes` 复用 `src/changes.listChanges/formatChange`。

会话 history 由 TUI 持有（caller-owned），`/clear` 清空；`/config` 激活重建 kernel 后 history 保留。

`/config` 与 GUI 共享 `api-profiles.js`（存储 `.deepseek-code/gui-api-profiles.json` 保留）与 `model-catalog.js`。密钥只落 `.deepseek-code/`，滚动区只见掩码。

退出/异常 finally 恢复 cooked mode、光标、颜色、括号粘贴。`NO_COLOR` 只降级样式。宽字符按显示宽度算光标列。

## 边界与不变量

- 主包零新增运行时依赖。
- kernel 核心 diff 为空；允许 `src/apps/` 与 `src/tui.js`。
- `runTui(root, kernel = null)` 签名不变。
- 双语文案全走 `tui-i18n.js`。
- 密钥明文只在 `.deepseek-code/` 与输入瞬间内存。
- 任何退出路径恢复终端态。

## 与现状的差异

TUI 现位于 `src/apps/tui/`，主题经 `gen-tui-theme` 映射 10 套 token 主题，支持 `/theme` 与 `/shell`。API 列表与 GUI 仍共享。见 [v1.4.0](2026-07-28-v1.4.0-frontend-redesign-design.md)。

## 验收

- 纯层 node:test：reducer / event-cards / slash / i18n / ansi / input / paint。
- `tui-app` 注入流全链路：流式回合、审批、slash、/config、/lang、Ctrl+C、终端态恢复。
- 门控 pty smoke 可选。
- api-profiles 迁移后 gui 单测全绿；`npm test` + `npm run check`。
