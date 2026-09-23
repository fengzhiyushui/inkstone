# V2-11 Transactional Edit & Dirty Workspace Safety

- 类型：实施计划
- 日期：2026-05-31
- 状态：已完成
- 关联：[CHANGELOG](../../CHANGELOG.md)、[V2-3 Edit Service](2026-05-30-v2-3-edit-service.md)、[设计](../../specs/backend/2026-05-31-v2-11-transactional-edit-dirty-workspace-design.md)

## 目标

让 V2 编辑 apply 具备事务性，并让回滚对脏工作区安全，默认显式 `force` 才覆盖。

## 结果

`src/edits/edit-transaction.js` 负责 touched 文件快照、失败恢复、变更记录前后 hash，以及脏回滚冲突检测与 force 回滚。legacy diff 解析/apply 路径保留，外面包事务安全，经 `EditService` 与延迟编辑工具暴露。

### 文件结构

创建：

| 路径 | 职责 |
|------|------|
| `src/edits/edit-transaction.js` | hash、touched 快照、恢复、变更记录 hash 增强、脏回滚冲突、force 回滚 |
| `tests/unit/edits/edit-transaction.test.js` | 事务快照/恢复/冲突/force |

修改：

| 路径 | 变更 |
|------|------|
| `src/edits/edit-service.js` | `apply()` 走事务助手；`rollback()` 走冲突感知回滚；发布事务事件 |
| `src/edits/rollback-service.js` | 接受 `force`，委托冲突感知回滚 |
| `src/tools/builtin/edit-deferred.js` | `diff_rollback` 增加可选 `force: boolean` |
| `src/sessions/event-types.js` | 注册事务与回滚冲突事件 |
| `tests/unit/edits/edit-service.test.js` | apply 失败恢复、脏冲突、force、事件隐私 |
| `tests/integration/v2-edit-tools-kernel.test.js` | 内核级冲突与 force |
| `tests/unit/sessions/event-types.test.js` | 新事件注册 |
| `package.json` | 新模块进 `npm run check` |

### 事务契约

| 导出 | 行为 |
|------|------|
| `hashContent(text)` | 返回 `{ hash: "sha256:…", bytes }`，稳定可复现 |
| `snapshotTouchedFiles(root, patches)` | 记录 `modify` / `create`；既有文件带 `before` 与 `before_hash`；新建目标若已存在则拒绝 |
| `restoreSnapshots(root, snapshots)` | 恢复被改文件，删除本次创建文件，返回恢复路径列表 |

快照记录字段：`path`、`status`、`existed_before`、`before`、`before_hash`。create patch 的目标已存在时视为冲突，避免覆盖用户内容。

### 行为锁定

| 场景 | 行为 |
|------|------|
| 多文件 apply 失败 | 恢复更早写入 |
| apply 失败 | 不发布 `file:diff_applied` |
| 成功变更记录 | 含 `before_hash` 与 `after_hash` |
| 默认 rollback | 检测脏文件，且不写任何东西 |
| `force: true` | 才覆盖脏文件 |
| `diff_rollback(change_id)` | 向后兼容 |
| rollback 权限类别 | 仍为 `write_update` |

`rollbackChangeRecord({ change_id = "latest", force = false, branch_id = null })` 在脏冲突时发布 `file:rollback_conflict`，返回 blocked 语义的成功载荷，不写文件。

### 事件契约

| 事件 | 内容边界 |
|------|----------|
| `file:transaction_started` | transaction id、路径列表 |
| `file:transaction_committed` | change id、前后 hash 摘要 |
| `file:transaction_failed` | 失败类别 |
| `file:transaction_rolled_back` | 恢复路径列表 |
| `file:rollback_conflict` | change id、脏路径摘要 |

事务与回滚事件不含原始 diff 或文件正文。

### 与后续计划的关系

- rewind（V2-12）文件恢复一律调用本阶段回滚能力。
- rewind 失败补偿（V2-13）复用同类快照/恢复思路。
- V2-18 在 apply/rollback 外再包 durable transaction journal。

### 验收锁定清单（当时完成标准）

- 多文件 apply 失败恢复更早写入。
- apply 失败不发布 `file:diff_applied`。
- 成功变更记录含 `before_hash` 与 `after_hash`。
- 默认回滚检测脏文件且不写。
- 仅 `force: true` 时覆盖脏文件。
- `diff_rollback(change_id)` 向后兼容。
- 事务与回滚事件不含原始 diff 或文件正文。
- 工具权限路径仍把回滚当 `write_update`。
- 全量测试、语法检查、空白检查、污染检查通过。

## 关键决策 / 遗留约束

| 决策 | 选择 | 否决 | 原因 |
|------|------|------|------|
| 事务范围 | touched 文件快照 | 全工作区拷贝 | 成本可控 |
| 失败处理 | 恢复 + 明确事件 | 半成功继续 | 避免脏写 |
| 脏回滚 | 默认硬停 | 默认覆盖 | 保护用户本地修改 |
| force | 显式参数 | 隐式覆盖 | 可审计 |
| legacy | 保留 apply 内核 | 重写 patch | 风险隔离 |
| hash | sha256 前缀 | 弱校验 | 可比对 before/after |

遗留约束：

- 除非测试证明包装做不到，不重构 `src/patch.js`。
- 不改 V0/V1 其余文件。
- 不把原始 diff/文件正文放进事件。
- 会话级 durable 事务日志见 V2-18。
- 不加依赖。
- Windows 命令统一 `npm.cmd`。

## 验证

| 测试 | 锁定行为 |
|------|----------|
| `tests/unit/edits/edit-transaction.test.js` | hash 稳定性、modify/create 快照、恢复、create-exists 拒绝 |
| `tests/unit/edits/edit-service.test.js` | apply 失败恢复、不发 diff_applied、before/after hash、脏回滚、force、事件隐私 |
| `tests/integration/v2-edit-tools-kernel.test.js` | 内核级 `diff_rollback` 冲突与 force |
| `tests/unit/sessions/event-types.test.js` | 新事件已注册 |

当时全量 `npm.cmd test`、`npm.cmd run check`、`git diff --check` 通过。测试数量应高于 V2-10 基线（427）。

现对应入口：

- `src/edits/edit-transaction.js`
- `src/edits/edit-service.js` 的 `apply` / `rollback`
- `src/edits/rollback-service.js`
