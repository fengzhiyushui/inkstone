# V3 Phase D-5 · TUI 重设计实施计划（行内滚动流 agent 会话 TUI）

- 类型：实施计划
- 日期：2026-07-06
- 状态：已完成
- 关联：[CHANGELOG](../../CHANGELOG.md) · [设计 spec](../../specs/frontend/2026-07-06-v3-phase-d5-tui-redesign-design.md) · [D-G4 CLI 对齐](2026-07-12-v3-phase-dg4-cli-alignment.md) · [v1.4.0 前端重构](2026-07-31-v1.4.0-frontend-redesign-plan.md)

## 目标

把 `src/tui.js` 菜单循环重写为行内滚动流 agent 会话 TUI，覆盖流式输出、工具与 diff 卡片、审批、slash 命令，并与 GUI 共享 API 列表管理；零运行时依赖，zh/en 双语默认中文。

## 结果

现役 TUI 在 `src/apps/tui/`。入口 `runTui(root, kernel = null)` 签名与 TTY 前置检查同旧版，`src/cli.js` 的 `case "tui"` 不变。历史消息 println 进终端原生滚动区，仅底部（分隔线 / 菜单 / 输入行 / 状态栏）为固定重绘区。纯逻辑（reducer / 派生 / 解码 / 序列构造）与薄 IO（painter / 组合根）分层；`tui-app` 接受可注入 `{ input, output }` 与 mock kernel，全链路测试不依赖真 pty。

### 文件地图

| 模块 | 职责 | 被谁消费 |
|---|---|---|
| `ansi.js` | 转义序列 + 显示宽度 | input / paint / event-cards / slash |
| `input.js` | 按键解码器 | tui-app |
| `tui-i18n.js` | zh/en 字典 | 全部后续模块 |
| `tui-state.js` | reducer + 状态栏派生 | tui-app / paint |
| `event-cards.js` | kernel 事件 → 卡片行 | tui-app |
| `paint.js` | 底部区计算 + painter | tui-app |
| `tui-app.js` | 组合根 | `src/tui.js` |
| `slash.js` | 注册表 + 补全 + 基础命令 | tui-app |
| `config-flow.js` | `/config` 纯状态机 | tui-app |
| `prefs.js` | `tui-prefs.json` | tui-app |
| `theme.js` | 主题应用 | tui-app |
| `theme-palette.js` | 256 色生成物（入库） | theme |

共享能力在 `src/apps/`：`api-profiles.js`、`model-catalog.js`、`event-contract.js`（由 [D-G4](2026-07-12-v3-phase-dg4-cli-alignment.md) 收敛）。GUI 经动态 import 复用同一套 API profile 存储。

### 里程碑与接口

#### M1 纯基建

**`ansi.js`**

- Produces：`seq.hideCursor` / `showCursor` / `pasteOn` / `pasteOff` / `clearDown` / `up(n)` / `down(n)` / `col(n)`。
- `displayWidth(text) → number`（CJK 按显示列计）。
- `truncateToWidth(text, max) → string`。
- `padToWidth(text, width) → string`。

**`input.js`**

- Produces：`createKeyDecoder() → { feed(chunk: string) → Event[] }`。
- Event 载荷形态：`{ type: "char", text }`、`{ type: "paste", text }`。
- Event 无载荷形态：`enter`、`backspace`、`left`、`right`、`up`、`down`、`home`、`end`、`tab`、`esc`、`ctrl_c`。
- 跨 chunk 的不完整转义序列内部缓冲；未识别 CSI 静默丢弃。

**`tui-i18n.js`**

- Produces：`STRINGS`（zh / en 两套 key→string）、`makeT(lang) → t(key, vars?) → string`。
- `{x}` 插值；缺 key 回落 en 再回落 key。
- 文案 key 一旦在此定义，后续 Task 不得内联中英文。

**`tui-state.js`**

- Produces：reducer 与状态栏派生（运行态、通道、分支、模型、耗时等）。
- 纯函数、不可变返回；与 GUI `workbench-state` 的 traffic/metrics 语义对齐但不共用代码。

#### M2 事件派生

**`event-cards.js`**

- Produces：`QUIET: Set<string>`、`eventToLines(event, t) → string[]`。
- 已着色整行，行首统一一个空格缩进；未知事件回退 dim `· type`。
- 后续经 `describeEvent` 契约对齐字段（见 D-G4）。

#### M3 渲染

**`paint.js`**

- Produces：底部区高度计算与 painter。
- 输入行支持光标、选区与粘贴；状态栏消费 `tui-state` 派生。
- 历史区不重绘，只靠终端原生滚动。

#### M4 组装

**`tui-app.js`**

- Produces：`createTuiApp({ input, output, kernel, ... })`，`run()` 返回 promise。
- `q` / `quit` 结束提示符；`\x03\x03` 或 Ctrl+C 退出。
- 可注入 `apiProfilesImpl` / `fetchModelIdsImpl` / `testConnectionImpl` / `configureProjectImpl`。
- 参数名 `createKernelImpl` / `buildKernelOptionsImpl` / `input` / `output` 与既有单测一致。

**`prefs.js`**：读写 `tui-prefs.json`（语言、主题、shell 等）。

**`src/tui.js`**：薄入口 `runTui(root, kernel = null)`。

#### M5 slash 基础命令

**`slash.js`**

- Produces：注册表、补全菜单、基础命令接线。
- 现役命令含 `/help`、`/config`、`/theme`、`/shell`、`/recovery`、`/quit` 等。

#### M6 `/config`（与 GUI 共享）

**`api-profiles.js`**

- Produces：`createApiProfiles({ dir }) → { list(), save(profile), remove(id), activate(id), getActive() }`。
- `maskKey(key) → "sk-…abcd" | "•••" | ""`。
- 存储文件名 `gui-api-profiles.json` 保留，兼容既有数据。

**`model-catalog.js`**

- Produces：`fetchModelIds({ baseUrl, apiKey, fetchImpl = globalThis.fetch }) → Promise<string[]>`。
- 无 apiKey 抛错、非 2xx 抛错、不设默认模型。

**`config-flow.js`**

- Produces：`/config` 纯状态机（编辑字段 / 拉模型 / 测试连接 / 激活重建）。

**`/config` 接线**：共享存储、拉模型、测试、激活后可重建 kernel。

#### M7 收口

- 门控真终端 smoke：真 pty 跑 `bin/inkstone.js tui`，启动（offline 分支不出网）→ `/help` 渲染 → `/quit` 退出且 `pasteOff` 恢复终端态。
- 全量回归 + 文档收口。

v1.4.0 起 `/theme` 消费 10 主题生成物（sumi / slate / vesper / nord / ash / snow / sand / lotus / latte / paper），`/shell` 提供 pwsh / powershell / cmd / git-bash 四宏，缺失可执行文件时不可用，状态栏带 `sh:` 标识。会话流按 v4 精修角色前缀、引导线工具树、审批块间距。

### 约束回顾

全局约束含：主包零依赖；纯层 node:test；i18n 集中；`/config` 与 GUI 共享存储；模型无默认；NO_COLOR 与非 TTY 退化。

## 关键决策 / 遗留约束

- 主包零依赖：TUI 手写 ANSI，不引 Ink 或其它 TUI 框架。
- 纯层全部 node:test；IO 层薄；`tui-app` 可注入流与 mock kernel。
- `/config` 与 GUI 共享 `api-profiles` / `model-catalog` / `configureProject` / 连接测试。
- 模型无默认；Key 掩码展示；激活 profile 后可重建 kernel。
- NO_COLOR 全禁路径与非 TTY 退化保持。
- 事件展示字段语义以 `src/apps/event-contract.js` 为准（D-G4 之后）。
- `/shell` 检测可执行文件存在性，缺失项不可用。
- 成功文案格式以实现的 `pushLines` 为准（recovery handler 等）。

## 验证

- 纯逻辑单测：ansi 宽度/截断/填充；input 解码（含跨 chunk CSI、粘贴、未知 CSI）；i18n 缺 key 回落与插值；reducer 不可变与状态栏派生；event-cards quiet 集合与未知事件回退；config-flow 各态迁移；api-profiles CRUD 与 `maskKey`；model-catalog mock fetch 成功/401/无 key。
- 门控真终端 smoke：启动 → `/help` → `/quit` 且终端态恢复。
- 全量 `npm test` + `npm run check`（check 脚本纳入 `src/apps/tui/*` 与 `src/apps/{api-profiles,model-catalog,event-contract}.js`）。
- 现役入口：`node ./bin/inkstone.js tui`；手工核对 `/help` `/config` `/theme` `/shell` `/recovery`。
