# V2-11 事务编辑与脏工作区安全设计

- 类型：后端 spec
- 日期：2026-05-31
- 状态：已实现
- 关联：[V2-12 分支 rewind](2026-05-31-v2-12-branching-conversation-rewind-design.md)

---

## 问题与目标

统一 diff 逐文件写入，中途失败会留下半套修改；回滚直接写回 `before`，不检查文件是否已被再次改动。V2-11 把 apply/rollback 变成事务感知的安全底座，为后续对话 rewind 备好精确文件恢复。本轮不做 rewind。

## 决策

| 决策点 | 选择 | 否决项 | 理由 |
|---|---|---|---|
| 失败恢复 | 事务快照整单回退 | 只报错 | 工作区必须原子化 |
| 变更记录 | 增加 before/after hash | 只存文本 | 脏检测需要指纹 |
| 脏回滚 | 默认拒绝 + 冲突报告 | 静默覆盖 | 用户改动优先 |
| 强制回滚 | 显式 `force: true` | 默认 force | 危险操作可审计 |
| 伪 create | 目标已存在则拒改 | 当 create 写入 | 避免 rollback 删用户原文件 |

## 设计

### 事务流

```
parse diff → assertDiffPathsSafe → snapshotTouchedFiles
  → capture change plan → applyDiffTransaction
  → 失败 restoreSnapshots → safeTransactionError
  → 成功 enhanceChangeRecord(before_hash/after_hash/transaction_id)
  → 发安全事件
```

实现：`src/edits/edit-transaction.js`（`snapshotTouchedFiles`、`restoreSnapshots`、`applyDiffTransaction`、`enhanceChangeRecord`、`detectRollbackConflicts`、`applyRollbackRecord`、`makeTransactionId`、`pathsFromParsedDiff`、`safeTransactionError`）。门面 `edit-service.js`。

### 快照与记录

文件快照含 path/oldPath/newPath/status/existed_before/before_hash/before_bytes/before_mtime_ms。创建文件 `before_hash: null`；diff 声明 create 但目标已存在则 apply 前拒绝。

变更记录 `files[]` 增加 `before_hash`、`after_hash`、`before_bytes`、`after_bytes`、`transaction_id`。无 hash 的旧记录尽量用存下的 before/after 算；缺 `after` 时脏检测尽力而为，安全侧失败。

成功结果：`{ transaction_id, change_id, files, summary, diff_hash, diff_size, restored_on_failure: false }`。失败错误含 `restored`、`restored_files`、`failed_files`、短 reason；恢复本身失败则 `restore_failed: true`。

### 回滚语义

默认：比较当前 hash 与 `after_hash`，有冲突则 `status: "conflict"`，metadata 含 `conflicts[]`（expected_after_hash、current_hash、reason）与 `force_available: true`，不写盘。

`force: true`：覆盖脏文件，结果与事件带 `forced: true` 与冲突列表。仍走 `diff_rollback` 的 `write_update` 权限。

### 事件

`file:transaction_started` / `committed` / `failed` / `rolled_back` / `file:rollback_conflict`，保留 `file:diff_applied` / `file:rollback_applied`。载荷可含 transaction_id、change_id、files、summary、diff_hash、diff_size、restored_files、conflicts、forced；不含 raw diff、文件内容、绝对路径、密钥、reasoning。

### 工具兼容

`diff_rollback({ change_id, force })` 增加布尔 `force`，缺省 false；`edit` / `diff_apply` 参数不变。

## 边界与不变量

1. 写路径全部过 workspace path safety。
2. 事务失败且恢复成功时不得留下半套文件。
3. 默认拒绝脏回滚；force 必须显式。
4. category 来自注册工具元数据，不信模型输入。
5. 三方合并、二进制编辑、日志压缩不在本轮。

## 与现状的差异

rewind 在 [V2-12](2026-05-31-v2-12-branching-conversation-rewind-design.md) 用本层 rollback。事件白名单以 `src/sessions/event-types.js` 为准。

## 验收

多文件失败后工作区回到 apply 前；成功记录含 before/after hash；默认脏回滚拒绝且零写盘；force 可覆盖并报告冲突；事件无内容泄漏；旧调用兼容。入口 `npm test`、`npm run check`。
