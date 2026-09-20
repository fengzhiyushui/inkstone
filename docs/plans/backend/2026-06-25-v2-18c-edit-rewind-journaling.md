# V2-18c 编辑/回滚事务日志集成 Implementation Plan

> 完成状态以 [CHANGELOG](../../CHANGELOG.md) 为准。


**Goal:** 把已在 main 的事务日志库(`transaction-journal.js`)接入 edit/rewind,让"启用恢复"时文件改动可在崩溃后回滚;并给 recovery-service + 启动扫描补 open 事务的发现与 abort/commit。

**安全前提(不受影响):** 所有集成点在**不传 journal 时为 no-op**——`recoveryJournal = null` 默认,edit/rewind 行为与现在完全一致;只有 `createKernel({ recovery:{ enabled:true } })` 才注入 journal。每步 TDD + 全量守绿。

**Architecture:** edit-service / rewind-service 接受可选 `recoveryJournal` + `assertOwner`;在文件改动前 `open()`、成功 `commit()`、失败 `abort()`(恢复 preimage)。recovery-service 扫描 open 日志并暴露 `abortJournal`/`commitJournal`。index.js 在 recovery 启用时构造 journal 并注入 edit/rewind + facade。

## Global Constraints

- `recoveryJournal` 默认 `null` → 所有路径 no-op,零行为变化。
- journal 的 `open/commit/abort` 失败不得静默吞掉 edit 的真实结果;遵循 transaction-journal 既有错误语义。
- 沿用 recovery 的 opt-in:仅 `recovery.enabled === true` 时 index.js 注入 journal。

---

### Task 1: edit-service 事务日志集成

**Files:** Modify `src/edits/edit-service.js`、`src/edits/edit-transaction.js`(加 `pathsFromParsedDiff`);Test `tests/unit/edits/edit-service-journal.test.js`

**Interfaces:**
- Consumes:`createTransactionJournal` 的 `open({kind,tx_id,paths,...})`/`commit(tx_id,final)`/`abort(tx_id)`。
- Produces:`createEditService({ ..., recoveryJournal = null, assertOwner = async()=>{} })`;`apply()` 在写文件前 open、成功 commit、失败 abort;无 journal 时与现状一致。

- [ ] **Step 1**: 写失败测试——注入假 journal,断言 `apply` 成功路径调用 open→commit;失败路径 open→abort。(参照原 V2-18 计划 Task 8 的测试结构。)
- [ ] **Step 2**: 跑测试确认红。
- [ ] **Step 3**: `edit-transaction.js` 加 `export function pathsFromParsedDiff(parsed)` 返回受影响路径。
- [ ] **Step 4**: `edit-service.js` 扩展签名 + 在 apply 的文件写入前后包 open/commit/abort;`assertOwner()` 在写入前调用。
- [ ] **Step 5**: 跑 `tests/unit/edits/*.test.js` 全绿(含既有 edit-service 测试无回归)。
- [ ] **Step 6**: 提交。

### Task 2: rewind-service 事务日志集成

**Files:** Modify `src/sessions/rewind-service.js`;Test `tests/unit/sessions/rewind-service-journal.test.js`

**Interfaces:**
- Produces:`createRewindService({ ..., recoveryJournal=null, assertOwner })`;`apply()` 捕获 `rewind_branch_state`(current/target branch、rollback change ids),open→(rollback+branch)→commit,失败 abort + 恢复。

- [ ] **Step 1-2**: 失败测试(中断的 rewind 回滚 + 成功 rewind commit 带分支状态),确认红。
- [ ] **Step 3-4**: 实现 journal 集成 + 分支状态捕获。
- [ ] **Step 5**: `tests/unit/sessions/*.test.js` 全绿。
- [ ] **Step 6**: 提交。

### Task 3: recovery-service 扫描 + abort/commit 日志

**Files:** Modify `src/core/recovery/recovery-service.js`;Test `tests/unit/core/recovery/recovery-service-journal.test.js`

**Interfaces:**
- Produces:`createRecoveryService({ ..., transactionJournal=null })`;`recoverOnStartup()` 扫描 open/aborting/committed/corrupt 日志并入收件箱;新增 `abortJournal(id)`/`commitJournal(id)`。

- [ ] **Step 1-2**: 失败测试(扫描暴露 open 事务 / abort / commit),确认红。
- [ ] **Step 3-4**: 实现扫描 + 两操作 + 收件箱填充。
- [ ] **Step 5**: recovery 单测全绿。
- [ ] **Step 6**: 提交。

### Task 4: kernel 接线 + facade + 集成测试

**Files:** Modify `src/index.js`;Test `tests/integration/v2-recovery-edit-journal.test.js`、`v2-recovery-rewind-journal.test.js`、`v2-recovery-service-journal.test.js`

**Interfaces:**
- Produces:recovery 启用时,index.js `createTransactionJournal` 并注入 editService/rewindService(`recoveryJournal` + `assertOwner = ()=>projectLock.assertOwner()`),recovery facade 暴露 `abortJournal`/`commitJournal`。

- [ ] **Step 1-2**: 集成测试(中断 edit/rewind 经 journal 回滚;kernel facade abort/commit),确认红。
- [ ] **Step 3**: index.js 接线(仅 `recoveryEnabled` 时)。
- [ ] **Step 4**: facade 加 abortJournal/commitJournal。
- [ ] **Step 5**: `npm test` 全绿 + `npm run check`。
- [ ] **Step 6**: 提交 + 更新 CHANGELOG/README/index(V2-18c 落地、V2-18 完整)。

---

## 验收

- 不传 journal:edit/rewind 行为与现状逐字节一致(既有测试零回归)。
- 启用恢复:崩溃中断的 edit/rewind 可在重启后 abort 回滚(preimage 恢复);committed 事务保留。
- 全量绿 + check OK。

> 依据:[V2-18 设计](../../specs/backend/2026-06-01-v2-18-durable-recovery-resume-hardening-design.md) Task 8–12;库已在 main(V2-18 phase 1)。
