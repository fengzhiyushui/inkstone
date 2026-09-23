# V3 Phase D-G4 · CLI 对齐实施计划

- 类型：实施计划
- 日期：2026-07-12
- 状态：已完成
- 关联：[CHANGELOG](../../CHANGELOG.md) · [设计 spec](../../specs/frontend/2026-07-12-v3-phase-dg4-cli-alignment-design.md) · [D-5 TUI 重设计](2026-07-06-v3-phase-d5-tui-redesign.md) · [D-G7 恢复中心](2026-09-15-d-g7-gui-recovery-center.md)

## 目标

抽出三端共用的事件展示契约 `describeEvent`，CLI / TUI / GUI 都改成消费它，并补上 CLI 缺失的多 agent 摘要与 TUI `/recovery clear`。

## 结果

新建纯函数模块 `src/apps/event-contract.js`，把三处并行的「事件 → 展示」字段兼容逻辑收敛为唯一语义源。kernel `src/core` / `src/index.js` 零改动。

### Task 1 · 共享契约 `describeEvent`

Produces：

```text
describeEvent(event) → { kind, sourceType, severity, quiet, fields }
```

- `kind` 覆盖 plan / tool / diff / test / approval / orchestration / experience / error / message / other 等（与设计 §4.2 一致）。
- `severity ∈ { "info", "success", "warn", "danger" }`。
- `quiet: boolean`。
- `fields` 缺失值为 `null`。

别名归一规则：

| 产出字段 | 归一 |
|---|---|
| `name` | `call?.name \|\| tool?.name \|\| tool` |
| `changeId` | `change_id \|\| record?.id` |
| `files` | `files` 数组否则 `summary` 数组；逐项 `{ status: status\|\|"M", path: path\|\|file\|\|null, added: Number.isFinite(added)?added:null, removed: Number.isFinite(removed)?removed:null }` |
| `argHint` | args 中 `path` / `file` / `pattern` / `command` / `query` / `url` 首个非空 |

畸形输入返回 `{ kind: "other", sourceType: "", severity: "info", quiet: true, fields: {} }`。

### Task 2 · CLI 消费契约 + 多 agent 摘要

`src/apps/cli/render-events.js`：`summarizeKernelEvent(event) → string`。既有 V2 输出字节不变；新增编排（orchestration / experience）行。`renderKernelResult`、`createEventRenderer` 签名不变。

注意：`createEventRenderer` 原先跳过固定 `QUIET_EVENTS`（4 个 model/step 事件），改为同时跳过契约 `quiet` 项。`user:message` 是否打印以契约为准（契约可标 `quiet`），渲染器测试需与契约一致。

### Task 3 · TUI 事件卡片消费契约 + 编排 subtask 卡

`src/apps/tui/event-cards.js`：`eventToLines(event, t) → string[]`。既有输出字节不变；新增 subtask start / review 卡片行。`QUIET` 集合不变。

### Task 4 · GUI agent-cards 消费契约

`gui/src/state/agent-cards.js`：`deriveAgentCards(activity) → card[]`。现有卡片形状与字段不变（plan / tool / diff / test）。

注意：既有 diff 测试用 `files: ["src/a.js", "src/b.js"]`（字符串元组）时，字符串无 `.path`，`normFiles` 必须处理字符串元素，否则 `paths` 为空。

### Task 5 · TUI `/recovery clear` 与 CLI 对齐

`/recovery clear <id>` 分支；无 id 时打印 usage 且不调 facade；失败渲染错误不崩。

`createTuiApp` 参数形状（`createKernelImpl` / `buildKernelOptionsImpl` / `input` / `output`）取自既有 `tui-app-config` 测试实证；`run()` 返回 promise；`q` / `quit` 结束提示符；`\x03\x03` 或 Ctrl+C 退出。成功文案以实现的 `pushLines` 为准（语义：清 clear、扔回 usage、错误不崩不变）。

### Task 6 · check 脚本与文档

`package.json` check 纳入 `src/apps/event-contract.js`；文档回写 overview / CHANGELOG / 索引。

## 关键决策 / 遗留约束

- 契约只描述事件语义（kind / severity / quiet / fields），不绑定措辞、颜色、i18n。
- 三端降为薄适配层，只读 `descriptor.*`。
- `quiet` 同时约束 CLI 不打印与 TUI 不刷卡片，避免每回合噪音。
- 字符串文件名与对象文件名都要能进 `files` 归一。
- kernel 公开契约与事件发布顺序不变。
- 全局约束沿用三端既有安全与零依赖红线。

## 验证

- `describeEvent` 单测：别名归一、quiet、severity、畸形输入、`argHint`、字符串 files。
- 三端既有渲染测试字节级回归 + 新编排/recovery 分支。
- `node --test` 相关文件；全量 `npm test` + `npm run check`。
- 现役对照：`src/apps/event-contract.js`；`src/apps/cli/render-events.js`；`src/apps/tui/event-cards.js`；`gui/src/state/agent-cards.js`。
