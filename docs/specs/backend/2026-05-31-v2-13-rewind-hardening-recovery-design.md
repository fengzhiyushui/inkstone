# V2-13 Rewind 加固与恢复设计

- 类型：后端 spec
- 日期：2026-05-31
- 状态：已实现
- 关联：[V2-12 分支 rewind](2026-05-31-v2-12-branching-conversation-rewind-design.md) · [V2-18 持久化恢复](2026-06-01-v2-18-durable-recovery-resume-hardening-design.md)

---

## 问题与目标

V2-12 的 `rewind.apply()` 可能先回滚文件、再在创建或激活子分支时失败，工作区已回到目标点而分支元数据仍停在旧分支。V2-13 给 rewind 加补偿：失败时恢复到尝试前状态，或返回明确的不可恢复结果与安全审计元数据。本轮不做跨进程崩溃持久化（归 V2-18）。

## 决策

| 决策点 | 选择 | 否决项 | 理由 |
|---|---|---|---|
| 补偿范围 | rewind 计划触及的全部文件快照 | 只补最后一笔 | 中途失败也要整单回到起点 |
| 快照位置 | 内存 `rewind-transaction` | 先落盘 | 本轮进程内；持久化归 V2-18 |
| 错误 | `safeRewindError` 分类 | 原样抛 message | 事件不泄内容 |
| 分支失败 | 恢复文件即可 | 必须删子分支记录 | 非活跃分支无害，删除不在 branch-store API |
| 冲突 | 有先前成功回滚则先补偿 | 只停不补 | 不能留半套文件 |

## 设略

### 模块

`src/sessions/rewind-transaction.js`：`captureRewindSnapshots`、`restoreRewindSnapshots`、`redactRewindSnapshots`、`safeRewindError`。只关心 projectRoot 与回滚计划，不碰分支与事件。`rewind-service.js` 仍是编排者：

```
preview → begin snapshot → rollback 循环 → createBranch → activateBranch → commit
                 ↓ 失败/冲突
        restore snapshots → 发恢复事件
```

### 状态流

结果元数据与事件区分：`previewed` / `started` / `rollback_applied` / `branch_created` / `branch_activated` / `committed` / `failed_restored` / `failed_unrestorable` / `conflict_restored`。

成功结果保持 V2-12 形状，并带 `recovery: null`。已补偿失败含 `phase`、`applied_rollbacks`、`restored_files`、`reason`。不可恢复失败另含 `restore_error`。

### 恢复规则

存在的文件按快照写回；rewind 期间新建的文件删除；期间新建的空目录尽力删除；路径全经 workspace path safety。快照仅内存，不进事件。

覆盖失败模式：全部 rollback 成功后 `createBranch` 抛错；分支已建后 `activateBranch` 抛错；中途 rollback 非冲突失败；中途 rollback 冲突（若前面已有成功回滚则先补偿）。

### 错误与事件

`safeRewindError(error, phase)` 只返回类别：`rollback_failed` / `branch_create_failed` / `branch_activate_failed` / `restore_failed` / `rewind_failed`，不含 `error.message`。

新事件：`session:rewind_restore_started`、`session:rewind_restored`、`session:rewind_recovery_failed`。载荷限 branch id、phase、applied_rollbacks、restored_files、reason、forced。禁止 before/after/snippet/diff/原始异常。原有 `session:rewind_started` / `rewind_applied` / `rewind_conflict` / `rewind_failed` 保留。

### Kernel

`createRewindService` 注入 `projectRoot`。`preview()` 仍只读。`branchStore` 不可用时 rewind 不可用。

## 边界与不变量

1. 成功路径行为与 V2-12 一致。
2. 失败或已补偿 rewind 后活跃分支不变。
3. 事件无 raw diff、文件内容、snippet、原始异常。
4. 不做 GUI 分支树、Git 集成、崩溃后自动续跑恢复。
5. 测试不在仓库根写 `.deepseek-code/v2`。

## 与现状的差异

跨进程事务日志与恢复收件箱见 [V2-18](2026-06-01-v2-18-durable-recovery-resume-hardening-design.md)。实现导出以 `src/sessions/rewind-transaction.js` 为准。

## 验收

V2-12 成功路径不回归；分支创建/激活失败可恢复文件；中途失败或冲突可恢复先前回滚；恢复事件已注册且无泄漏；失败后活跃分支不变。入口 `npm test`、`npm run check`。
