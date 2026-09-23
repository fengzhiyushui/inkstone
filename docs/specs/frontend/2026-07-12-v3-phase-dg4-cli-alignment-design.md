# V3 Phase D-G4 · CLI 对齐

- 类型：前端 spec
- 日期：2026-07-12
- 状态：已实现
- 关联：[V3 路线图](../architecture/2026-06-24-v3-roadmap-design.md) · [补救文档](../backend/2026-07-12-agent-findings-remediation.md) · `src/apps/event-contract.js`

## 问题与目标

CLI / TUI / GUI 三处各自防御式读同一批 kernel 事件，字段口径漂移，且 CLI 完全没有 `orchestration:*` / `experience:*` 摘要。本篇建立共享事件展示契约，补 CLI 多 agent 摘要，并让 TUI `/recovery` 与 CLI 对齐。

## 决策

| 选了什么 | 否决了什么 | 为什么 |
|---|---|---|
| 三端共用 `describeEvent` 展示契约 | 只补 CLI 不抽共享 | 根治四份并行实现 |
| 契约只做「已产出事件 → 展示语义」 | 改 core 事件生产 | 边界清晰 |
| taxonomy 保留近义 kind | 合并 recovery-report/blocked 等 | 避免分支漏回渲染器 |
| 编排 kind 统一 `orchestration-` 前缀 | 短名 | 避免与普通 plan/route 冲突 |
| `fields` 按 kind 区分，缺失归一 `null` | 无约束 `{…}` | 表现层决定显示 |
| `quiet` 是默认可见性提示 | 丢弃事件 | 调试模式仍可显示 |
| UMD fallback 保留自有副本，记 P2 | 本轮改休眠层 | 不消费 orchestration |
| TUI `/recovery clear` 无二次确认 | GUI 式弹层 | 与 CLI 同策略 |

## 设计

```text
src/apps/event-contract.js   describeEvent(event) → EventDescriptor
src/apps/cli/render-events.js  消费契约，补编排/经验摘要
src/apps/tui/event-cards.js    消费契约
gui/src/state/agent-cards.js   消费契约后折卡
```

`EventDescriptor`：`{ kind, sourceType, severity, quiet, fields }`。`sourceType` 保留原始 `event.type`。

归一规则：别名兜底集中一处（`name = call?.name || tool?.name || tool`；`changeId = change_id || record?.id`；`files` 兼容 `files`/`summary`）。`normFiles` 的 `status` 缺省 `"M"`；`verification.pass` 为 `true|false|null`（未知≠失败）。缺失一律 `null`。畸形输入返回 `other`，绝不抛错。

完整 kind 映射：

| 原始 event.type | kind | severity | quiet | fields |
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

注：`rewind` 的 severity 由子类型细分；`final`/`error` 标 quiet 是既有各端约定（CLI/TUI 走 `send()` 结果路径）。

CLI 新增编排摘要（单复数正确、无空括号、review 只出 `passed`/`failed`）：

| kind | 摘要 |
|---|---|
| orchestration-route | `routing: multi-agent` |
| orchestration-plan | `plan: N subtask(s)` |
| orchestration-round-start | `round N: N subtask(s)` |
| orchestration-subtask-start | `subtask <id>: starting (attempt N[, profile <p>])` |
| orchestration-subtask-review | `subtask <id>: review passed` 或 `review failed (severity: <level>)` |
| orchestration-replan | `replan round N: N new subtask(s)` |
| orchestration-complete | `orchestration complete: N succeeded, N failed (status: <status>)` |
| experience-retrieved | `experience: N recalled`（仅 count > 0） |

已覆盖的 V2 事件摘要逐字不变。

Part C：TUI `/recovery` 补 `clear <id>`，与 CLI 同 facade、无二次确认（`clear` 软标记 `status:"cleared"`，拒 blocked 项）。help/补全/参数校验/成功/失败/双语齐备。

## 边界与不变量

- `src/core` / `src/index.js` 零改动。
- 契约纯函数、无 I/O、无副作用、任意输入不抛错。
- 现有 16 条渲染测试原样全绿；编排输出有意改变，单列测试。
- 零新增运行时依赖。
- 措辞/颜色/i18n 各端自持；契约不含展示字符串。
- 问题 #5 不标「完全解决」，UMD fallback 残留副本列 P2。

## 与现状的差异

`event-contract.js` 现含 `thought` kind（v1.8.0 推理摘要卡）。GUI `deriveAgentCards` 已消费契约。CLI/TUI 渲染层按 `descriptor.kind` 展示。

## 验收

- `event-contract.test.js` 覆盖映射、别名、缺失字段、畸形输入、未知事件、`quiet`。
- 三端旧测试不删不放宽。
- CLI 编排摘要单复数、无空括号、passed/failed、experience 零不打印。
- TUI `/recovery clear` 参数校验与错误路径。
- `npm test` 与 `npm run check` 通过。
