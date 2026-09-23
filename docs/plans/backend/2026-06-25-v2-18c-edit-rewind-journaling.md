# V2-18c 编辑/回滚事务日志集成 Implementation Plan

- 类型：实施计划
- 日期：2026-06-25
- 状态：已完成
- 关联：[V2-18 durable recovery](../../specs/backend/2026-06-01-v2-18-durable-recovery-resume-hardening-design.md)、[CHANGELOG](../../CHANGELOG.md)

## 目标

把事务日志库 `transaction-journal.js` 接入 edit/rewind，启用恢复时崩溃中断的文件改动可在重启后回滚。

## 结果

`createEditService({ ..., recoveryJournal = null, assertOwner = async () => {} })`：`apply()` 在写文件前 `open({ kind, tx_id, paths, ... })`，成功 `commit(tx_id, final)`，失败 `abort(tx_id)` 恢复 preimage。`edit-transaction.js` 导出 `pathsFromParsedDiff(parsed)` 返回受影响路径。

`createRewindService({ ..., recoveryJournal = null, assertOwner })`：`apply()` 捕获 `rewind_branch_state`（current/target branch、rollback change ids），open →（rollback + branch）→ commit，失败 abort 并恢复。

`createRecoveryService({ ..., transactionJournal = null })`：`recoverOnStartup()` 扫描 open/aborting/committed/corrupt 日志并入收件箱；新增 `abortJournal(id)` / `commitJournal(id)`。

`createKernel({ recovery: { enabled: true } })` 时 index.js 构造 `createTransactionJournal` 并注入 editService / rewindService（`recoveryJournal` + `assertOwner = () => projectLock.assertOwner()`），recovery facade 暴露 `abortJournal` / `commitJournal`。日志目录 `.deepseek-code/v2/journal`。

## 关键决策 / 遗留约束

- 不传 journal 时整条链路 no-op，edit/rewind 行为与现状一致。安全前提不变。
- journal 的 `open/commit/abort` 失败不静默吞掉 edit 真实结果，沿用 transaction-journal 既有错误语义（含 `RECOVERY_INVALID_STATE`、`RECOVERY_BLOCKED`）。
- recovery 仍为 opt-in：仅 `recovery.enabled === true` 时注入 journal。
- rewind 的 branch 状态写入 manifest 的 `rewind_branch_state`，abort 时一并恢复。
- 每步 TDD，不传 journal 的既有测试零回归。

## 验证

单测 `tests/unit/edits/edit-service-journal.test.js`（成功 open→commit、失败 open→abort）、`tests/unit/sessions/rewind-service-journal.test.js`（中断 rewind 回滚、成功 rewind commit 带分支状态）、`tests/unit/core/recovery/recovery-service-journal.test.js`（扫描暴露 open 事务、abort/commit）。集成 `tests/integration/v2-recovery-edit-journal.test.js`、`v2-recovery-rewind-journal.test.js`、`v2-recovery-service-journal.test.js`。`npm test` 全绿 + `npm run check`。当前入口 `src/edits/edit-service.js`、`src/edits/edit-transaction.js`、`src/sessions/rewind-service.js`、`src/core/recovery/transaction-journal.js`、`src/core/recovery/recovery-service.js`、`src/index.js`。
