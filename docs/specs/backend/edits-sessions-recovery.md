# 编辑、会话与恢复（Living Spec）

- 类型：后端 spec
- 状态：Living Spec，随实现更新；v1.19.0 整合自 4 篇历史 spec（恢复默认关闭 opt-in）
- 关联：[运行时与执行](runtime-and-execution.md) · [编排](orchestration.md) · [上下文与记忆](context-and-memory.md) · [工作台与三端](../frontend/workbench-and-surfaces.md) · [文档索引](../../README.md)

> 本文是 v1.19.0 整合后的领域 Living Spec，取代原 4 篇碎片化历史 spec（见文末「来源」）。As-built 偏离：recovery 为 opt-in（kernel 管机制、config 管策略）；`kernel.dispose()` 释放项目锁；Recovery Center 先提供 `kernel.recovery.*` CLI 门面，GUI 面板随后落地。

## 来源与覆盖

| 来源（basename） | 覆盖内容 |
|---|---|
| `2026-05-31-v2-11-transactional-edit-dirty-workspace-design.md` | 事务编辑、脏工作区检测、回滚语义、工具兼容 |
| `2026-05-31-v2-12-branching-conversation-rewind-design.md` | 分支模型、检查点、rewind preview/apply/force、查询 API |
| `2026-05-31-v2-13-rewind-hardening-recovery-design.md` | rewind 补偿、状态流、错误与事件分类 |
| `2026-06-01-v2-18-durable-recovery-resume-hardening-design.md` | 存储布局、项目锁与接管、暂停侧车、事务日志、恢复矩阵、Recovery Center、故障注入 |
| `2026-06-25-v2-18c-edit-rewind-journaling.md` | edit/rewind 事务日志接线 |

---

## 1. EditService

`src/edits/`：`edit-service.js`、`diff-parser.js`、`edit-transaction.js`、`rollback-service.js`、`change-store.js`、`sensitive-notice.js`。

对外契约：

```js
EditService.preview({ diff })
EditService.apply({ diff, prompt, approval_id })
EditService.rollback({ change_id, force })
EditService.describe(change_id)
EditService.list({ limit })
```

每次写入产生 diff 摘要、change id、前后快照、会话事件与回滚路径。写路径全部过 `src/workspace/path-safety.js` 的 workspace 边界。category 来自注册工具元数据，不信模型输入。

事务事件（`SESSION_EVENT_TYPES`）：`file:diff_preview`、`file:transaction_started`、`file:transaction_committed`、`file:diff_applied`、`file:transaction_failed`、`file:transaction_rolled_back`、`file:rollback_applied`、`file:rollback_conflict`。

---

## 2. 事务编辑

### 2.1 事务流

```
parse diff → assertDiffPathsSafe → snapshotTouchedFiles
  → capture change plan → applyDiffTransaction
  → 失败 restoreSnapshots → safeTransactionError
  → 成功 enhanceChangeRecord(before_hash/after_hash/transaction_id)
  → 发安全事件
```

`edit-transaction.js` 导出 `snapshotTouchedFiles`、`restoreSnapshots`、`applyDiffTransaction`、`enhanceChangeRecord`、`detectRollbackConflicts`、`applyRollbackRecord`、`assertRollbackableRecord`、`makeTransactionId`、`pathsFromParsedDiff`、`safeTransactionError`。

### 2.2 快照与记录

文件快照含 `path` / `oldPath` / `newPath` / `status` / `existed_before` / `before_hash` / `before_bytes` / `before_mtime_ms`。创建文件 `before_hash: null`；**diff 声明 create 但目标已存在则 apply 前拒绝**（伪 create 防护，避免 rollback 删用户原文件）。

变更记录 `files[]` 增加 `before_hash`、`after_hash`、`before_bytes`、`after_bytes`、`transaction_id`。无 hash 的旧记录尽量用存下的 before/after 算；缺 `after` 时脏检测尽力而为，安全侧失败。

成功结果：`{ transaction_id, change_id, files, summary, diff_hash, diff_size, restored_on_failure: false }`。失败错误含 `restored`、`restored_files`、`failed_files`、短 reason；恢复本身失败则 `restore_failed: true`。

### 2.3 脏工作区检测

`detectRollbackConflicts` 比较当前 hash 与 `after_hash`：

- 默认（无 `force`）：有冲突则 `status: "conflict"`，metadata 含 `conflicts[]`（`expected_after_hash`、`current_hash`、`reason`）与 `force_available: true`，**不写盘**。
- `force: true`：覆盖脏文件，结果与事件带 `forced: true` 与冲突列表。仍走 `diff_rollback` 的 `write_update` 权限。
- 强制回滚必须显式；危险操作可审计。

### 2.4 错误分类（`safeTransactionError`）

| 类别 | 触发 |
|---|---|
| `patch_failed` | diff 应用/解析阶段失败 |
| `transaction_finalize_failed` | 变更记录落盘/收尾失败 |
| `transaction_failed_restored` | 事务失败但快照恢复成功 |
| `transaction_failed` | 事务失败（未标注已恢复） |

只返回类别，不含 `error.message`。

### 2.5 工具兼容

`diff_rollback({ change_id, force })` 增加布尔 `force`，缺省 `false`；`edit` / `diff_apply` 参数不变。

---

## 3. 变更记录

### 3.1 存储形态

```
.deepseek-code/
  changes/<id>.json        变更记录（含 before/after 原文、diff、summary）
  rollbacks.jsonl          回滚流水（{ time, id, forced }）
  config.json              项目配置
  gui-preferences.json     GUI 偏好
  gui-api-profiles.json    API 列表（GUI 与 TUI /config 共享）
  v2/                     恢复私有载荷（见 §6）
```

`changes/<id>.json` 目录以 `mode: 0o700` 创建；Windows 上 `fs.chmod` 基本无效（账户 ACL 决定实际权限），因此目录权限只是尽力而为，不是安全边界。

### 3.2 展示层脱敏 vs 存储保持原文

- **落盘记录必须保持原文**——回滚靠逐字节复原，**不能**对存储套 redactor（审计 #9.3 硬约束）。
- `formatChange(record)` 是**显示**函数（CLI `changes` / TUI 卡片都用它）：对 `prompt` 与 `diff` 过 `redactSecrets`。打到屏幕上的内容会被截图、贴进 issue，是密钥唯一能离开本机的路径，故在此处脱敏。
- GUI 对 `changes/` 与 `rollbacks.jsonl` 只读；列表条目瘦身（不含 before/after/diff 全文），前后全文仅 `describeChange` 单文件按需过 IPC（见[工作台与三端](../frontend/workbench-and-surfaces.md)）。

### 3.3 记录卫生（`config.edits`）

```js
edits: {
  maxCaptureBytes: 1024 * 1024,                        // 1 MiB；null 关闭截断
  changeRetention: { maxRecords: 200, maxAgeDays: 90 } // null 关闭清理
}
```

- **截断**：`captureText(value, maxCaptureBytes)` 超限时只存 `sha256` + 原始 `size`，并置 `truncated: true`，不存全文。任一侧（before/after）被截断，记录即视为 `truncated`。
- **回滚截断守卫**：`assertRollbackableRecord` 在任何文件缺 before 全文时抛 `ROLLBACK_TRUNCATED`，**绝不写 `before ?? ""` 把用户文件清空**。先全部校验再动手。判定综合 `before_truncated`、`truncated`、`before_size`、`before_bytes` 两条记录增强路径。
- **保留期**：`pruneChangeRecords` 在 `finalizeChange` 写新记录后按 `maxRecords`（数量上限）与 `maxAgeDays`（保留期）做确定性清理，**只删 `.deepseek-code/changes/*.json`**，绝不碰工作区文件；损坏记录视为最旧优先清理。新的在前排序，与 `listChanges` 一致。
- **全链路接线**：`config.edits` 经 `createChangeStore({ edits })` 注入 `capture` / `finalize`；`normalizeEdits` 归一化（`maxCaptureBytes` 非正数回退默认；`changeRetention` 两项皆 null 时整体关闭）。

---

## 4. 敏感文件提醒（#9.3）

`sensitive-notice.js` 是纯判定层，无 IO。判定复用 context 扫描的忽略集 `contextSkipReason`，但**只取含密钥的两类**：`secret-file`、`credential-file`。`ignored-directory`（`.git`/`node_modules`/`dist`/`build`）与 `hidden-tool-dir`（`.vscode`/`.claude`）只是「不进上下文索引」，不是密钥文件；整个复用会让红色提醒在改 `dist/` 时也弹，沦为噪音，所以在这里收窄。

命中的典型路径：`.env`、`.env.*`、`*.pem`、`*.key`、`.npmrc` 等。

行为：

- 在**编辑真正发生之前**告知用户「这次改动会把该文件的完整原文抄进变更记录」，由用户拍板。
- **刻意不经 PermissionEngine**：权限矩阵管的是「agent 能不能做这个动作」，本提醒是「这个动作会在磁盘留下你看不见的密钥副本」的副作用告知；混进权限档位会被 `auto` / `full-auto` 一键放行，恰好绕过最该提醒的场景。
- **不进审批缓存**；所有自治档位一律提问。
- 未获许可时抛 `error.code = "SENSITIVE_EDIT_DECLINED"`，带 `paths`。安全默认：只有显式 `true` 才放行，漏写返回值不等于同意。
- 未注入 `onSensitiveNotice` 回调时行为逐字节不变。
- 三端红色告知（GUI 弹层、CLI/TUI 醒目提示）；载荷 `{ paths: [{path, reason}], recordDir: ".deepseek-code/changes" }`。

---

## 5. 分支与 Rewind

### 5.1 模块与分支模型

```
src/sessions/
  branch-store.js       # 分支元数据与激活分支
  checkpoint-index.js   # buildCheckpointIndex / resolveRewindTarget / computeRollbackPlan
  rewind-service.js     # preview / apply / rollback 编排
  rewind-transaction.js # 补偿快照与安全错误
  session-manager.js    # 事件盖 branch_id
  event-log.js · event-types.js
```

`BR_MAIN = "br_main"`，`BRANCH_SCHEMA_VERSION = 1`，分支 id 形如 `br_[a-zA-Z0-9._-]+`。记录含 `branch_id`、`parent_branch_id`、`forked_from_event_id`、`forked_from_seq`、`forked_from_turn_id`、`created_at`、`label`。无分支文件的旧会话惰性建 `br_main`，缺 `branch_id` 的事件视作主分支。运行时事件盖当前 `branch_id`；分支控制事件可同时带 `parent_branch_id`。

事件日志为 append-only JSONL，每条带 `schema_version`（当前 2）与 hash chain（`prev_hash` + `event_hash`），损坏行不阻断读取，`verifyEventLog` 可校验链。事件类型以 `SESSION_EVENT_TYPES` 为唯一清单，写入前经 `assertSessionEventType` 校验。

### 5.2 检查点

从时间线推导：`checkpoint_id`、`branch_id`、`event_id`、`seq`、`turn_id`、`type`、`label`、`change_ids`、`cumulative_change_ids`。支持按 event_id / seq / turn_id 定位，并计算目标之后要回滚的 change 列表。

### 5.3 Rewind

**preview（只读）**：解析目标，给出 `planned_branch_id`、`rollback_change_ids`、`files`、`force_required`，发 `session:rewind_preview`。不写文件、不切分支。

**apply**：冲刷事件 → 解析检查点 → 逆序 `editService.rollback({ change_id, force })` → 任一冲突则停、发 `session:rewind_conflict` 并如实报告已回滚/剩余 change → 全部成功则 `createBranch` + `activateBranch` → 发 `session:rewind_started`、`branch_created`、`branch_activated`、`rewind_applied`。之后的新 turn 落入子分支。

**force**：向每笔 rollback 传 `force: true`，事件记 `forced` 与冲突元数据；仍不绕过路径安全。

### 5.4 查询与 API

`kernel.session.getTimeline(50)` 保持兼容（默认活跃分支）。可选 `{ count, branch_id }` 返回该分支及祖先继承事件；`{ all_branches: true }` 返回全部。

```js
kernel.session.branches.list/getActive/activate
kernel.session.checkpoints.list
kernel.session.rewind.preview/apply
```

`activate()` 只改元数据，不写文件。

### 5.5 rewind 硬化（V2-13）

`rewind-transaction.js`：`captureRewindSnapshots`、`restoreRewindSnapshots`、`redactRewindSnapshots`、`safeRewindError`。只关心 projectRoot 与回滚计划，不碰分支与事件。

```
preview → begin snapshot → rollback 循环 → createBranch → activateBranch → commit
                 ↓ 失败/冲突
        restore snapshots → 发恢复事件
```

- 补偿范围是 rewind 计划触及的**全部文件快照**（不只最后一笔），中途失败也整单回到起点。
- 存在的文件按快照写回；rewind 期间新建的文件删除；期间新建的空目录尽力删除；路径全经 workspace path safety。快照仅内存，不进事件。
- 覆盖失败模式：全部 rollback 成功后 `createBranch` 抛错；分支已建后 `activateBranch` 抛错；中途 rollback 非冲突失败；中途 rollback 冲突（若前面已有成功回滚则先补偿）。
- `safeRewindError(error, phase)` 只返回类别：`rollback_failed` / `branch_create_failed` / `branch_activate_failed` / `restore_failed` / `rewind_failed`，不含 `error.message`。
- 新事件：`session:rewind_restore_started`、`session:rewind_restored`、`session:rewind_recovery_failed`。原有 `session:rewind_started` / `rewind_applied` / `rewind_conflict` / `rewind_failed` 保留。
- 状态流元数据：`previewed` / `started` / `rollback_applied` / `branch_created` / `branch_activated` / `committed` / `failed_restored` / `failed_unrestorable` / `conflict_restored`。成功结果带 `recovery: null`；已补偿失败含 `phase`、`applied_rollbacks`、`restored_files`、`reason`；不可恢复失败另含 `restore_error`。
- 载荷限 branch id、phase、applied_rollbacks、restored_files、reason、forced；禁止 before/after/snippet/diff/原始异常。

### 5.6 边界

1. 事件日志 append-only，hash 链保持有效。
2. Rewind 只经 rollback 写文件。
3. 冲突默认停；部分回滚必须明说。
4. 事件与分支元数据不含 raw diff / 文件内容 / reasoning。
5. 失败或已补偿 rewind 后活跃分支不变。
6. 测试不在仓库根制造 `.deepseek-code/v2`。

---

## 6. 持久化恢复（V2-18）

### 6.1 开关与存储布局

`recovery.enabled` 默认 **false**（opt-in）：`createKernel(root, { recovery: { enabled: true } })` 开启。kernel 管机制、config 管策略。

```
.deepseek-code/v2/
  .lock/owner.json · takeover/<requestId>.json
  sessions/<projectId>/
    <sessionId>.jsonl · <sessionId>.branches.json
    paused/<approvalId>.json
    orchestration-paused/<approvalId>.json
    task-paused/<approvalId>.json
  journal/<txId>/manifest.json · blobs/
  recovered/<txId>/manifest.json · blobs/
  recovery/inbox.json
  context/manifest.json
  mcp-logs/
```

模块：`src/core/recovery/atomic-file.js`、`recovery-faults.js`、`project-lock.js`、`sidecar-store.js`（v1.19.2 通用持久化底座，承载 `paused-turn-persistence.js`、`orchestration-persistence.js` 与 `task-paused-persistence.js` 三套侧车存储）、`transaction-journal.js`、`recovery-inbox.js`、`recovery-service.js`、`recovery-errors.js`。

`paused/`、`journal/`、`recovered/`、`orchestration-paused/`、`task-paused/` 是私有恢复载荷，排除遥测与 UI 原文展示，`.gitignore` 覆盖。

### 6.2 项目锁与 epoch fencing

`fs.mkdir(lockDir)` 作 Windows 兼容独占原语。`owner.json` 含 `epoch`、owner token/pid/host/surface、`session_id`、`heartbeat_at`、`phase`。心跳约 2s；同机 PID 存活且心跳 <10s 视为 live，否则 stale（跨机 30s）。

管理写路径（事件追加、侧车、journal、编辑/rewind、恢复对账、分支元数据等）在变更前调 `assertOwner()` 比对 `(token, epoch)`。

交互发现 live holder：提示 Take over / Cancel。Take over 写 `takeover/<requestId>.json`（`wx`），holder 取最早请求，发 `takeover:requested`，中断 turn、中止/回滚自有事务、写 `released_at`、释放锁；请求方获得锁后发 `takeover:completed`。超时可确认 force：写 `epoch+1` 新 owner，读回确认 `(token, epoch)` 才算持有。陈旧 holder 醒来后 `assertOwner()` 失败。非交互默认 fail-closed，除非 `takeover: "force"`。

错误码：`RECOVERY_LOCK_HELD` / `CORRUPT` / `NOT_HELD` / `CHANGED` / `INVALID_OWNER` / `BUSY` / `NOT_OWNED` 等（`project-lock.js` / `recovery-errors.js`）。

### 6.3 暂停侧车

见[运行时与执行](runtime-and-execution.md) §2.6。扫描按侧车与项目内全部 JSONL 的 `turn:*` 标记对账。

### 6.4 事务日志

边界：一次 agent 编辑工具调用或一次 rewind apply。**已提交事务不回滚**；单事务多文件则整单回滚。

`journal/<txId>/manifest.json`：state `open|aborting|committed`、kind `edit|rewind`、`paths[]`（`pre_hash`/`size`/`mtime`/`mode`/`symlink`/`blob`）、rewind 时另存 `rewind_branch_state.state_before`。文件字节进 blob，不用 UTF-8 JSON 字符串。路径拒绝对数路径、穿越、symlink 逃逸、重复 `path_key`。

写序：枚举路径 → 捕获 preimage → 原子写 blob+manifest → 追加 flush `tx:opened` → 才允许第一次工作区变更。提交点：变更完成 → `state: committed` + `commit_id` → flush `tx:committed`。manifest `committed` 是权威提交证明，事件标记可修复。

**恢复矩阵要点**：

| 状态 | 处置 |
|---|---|
| `open` 无成功标记 | abort 整单 |
| `open` 有成功标记 | 阻断 |
| `aborting` | 幂等续回滚 |
| `committed` 缺标记 | 修标记后清 journal |
| 损坏 / 缺 undo blob | 阻断 |

冲突/未知状态先保全到 `recovered/<txId>/`，成功后再恢复 preimage；保全失败则阻断启动。恢复自身可崩：先置 `aborting`，不提前删 journal，产物写幂等。

### 6.5 edit / rewind journaling 接线（V2-18c）

- `createEditService({ ..., recoveryJournal = null, assertOwner = async () => {} })`：`apply()` 在写文件前 `open({ kind, tx_id, paths, ... })`，成功 `commit(tx_id, final)`，失败 `abort(tx_id)` 恢复 preimage。`pathsFromParsedDiff(parsed)` 返回受影响路径。
- `createRewindService({ ..., recoveryJournal = null, assertOwner })`：`apply()` 捕获 `rewind_branch_state`（current/target branch、rollback change ids），open →（rollback + branch）→ commit，失败 abort 并恢复。
- `createRecoveryService({ ..., transactionJournal = null })`：`recoverOnStartup()` 扫描 open/aborting/committed/corrupt 日志并入收件箱；新增 `abortJournal(id)` / `commitJournal(id)`。
- `createKernel({ recovery: { enabled: true } })` 时 `index.js` 构造 `createTransactionJournal` 并注入 editService / rewindService（`recoveryJournal` + `assertOwner = () => projectLock.assertOwner()`），recovery facade 暴露 `abortJournal` / `commitJournal`。日志目录 `.deepseek-code/v2/journal`。
- 不传 journal 时整条链路 no-op，edit/rewind 行为与现状一致。journal 的 `open/commit/abort` 失败不静默吞掉 edit 真实结果，沿用既有错误语义（含 `RECOVERY_INVALID_STATE`、`RECOVERY_BLOCKED`）。rewind 的 branch 状态写入 manifest 的 `rewind_branch_state`，abort 时一并恢复。

### 6.6 Recovery Center

`recovery/inbox.json` 只存摘要：`id`、`type`（`paused_turn` / `recovered_tx` / `blocked_recovery` / `takeover` / `quarantined_state` / `orchestration_paused`）、`status`、`source_id`、`summary`、`evidence`、`allowed_actions`。id 稳定：`rec_pause_*`、`rec_tx_*` 等。`clear` 只隐藏已安全报告项，不删未解决证据。

```js
kernel.recovery.list / resume / cancel / clear / report
```

CLI：`/recovery`、`/recovery resume|cancel|clear <id>`。GUI/TUI 共用同一模型。

启动序：拿锁 → 跑恢复对账 → 不安全则阻断普通启动但仍可看 Recovery Center 做安全 clear/隔离 → 再进正常操作。

### 6.7 事件

`recovery:started` / `blocked` / `report`，`tx:opened` / `committed` / `recovered`，`turn:paused` / `rehydrated` / `resumed` / `cancelled`，`takeover:requested` / `completed`。载荷仅 id、计数、类别、必要相对路径；禁止 resume_state、prompt、diff、文件字节、密钥、undo 数据。

### 6.8 故障注入测试

`recovery-faults` 按标签在写边界抛 `RECOVERY_FAULT`（如 `after-journal-write`、`after-first-file-write`、`during-rollback`）。要求覆盖：journal 后未变更即崩；多文件中途崩整单回滚；commit 后缺标记修标记；回滚中再崩幂等；外部改文件先保全；损坏侧车/journal 阻断；协作/强制接管与 epoch fencing；Windows 路径大小写；rewind 分支库还原。

### 6.9 边界

1. 不做断电/fsync 级持久、只读观察者、外部 hook 平台。
2. 不自动重做破坏性编辑/rewind。
3. 不回滚任意 shell / 外部编辑器副作用。
4. 事件日志保持 payload-free。
5. 跨进程编排级恢复与 `task` 委派恢复见[编排](orchestration.md) §12–§13。

---

## 7. 审计台账（findings 与 remediation 记录方式）

审计发现以「根因 / 改法 / 风险 / 验证 / 优先级」登记成可立项台账，实施走各自 spec/plan；各条目以对应版本 CHANGELOG 与测试为准，总体验收要求台账状态与代码一致、未做项不假装完成。完整处置总表见[运行时与执行](runtime-and-execution.md) §9。

已知设计取舍（恢复 opt-in、iso worker 强制 auto、编排 sidecar 有损序列化）**不列为缺陷**。存储正文脱敏与 `agent-runtime` 结构重构须独立 spec。

---

## 来源

- `2026-05-31-v2-11-transactional-edit-dirty-workspace-design.md`
- `2026-05-31-v2-12-branching-conversation-rewind-design.md`
- `2026-05-31-v2-13-rewind-hardening-recovery-design.md`
- `2026-06-01-v2-18-durable-recovery-resume-hardening-design.md`
- `2026-06-25-v2-18c-edit-rewind-journaling.md`
