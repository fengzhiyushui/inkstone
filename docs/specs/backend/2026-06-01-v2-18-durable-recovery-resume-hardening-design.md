# V2-18 持久化恢复与 Resume 加固

- 类型：后端 spec
- 日期：2026-06-01
- 状态：已实现（as-built：恢复默认关闭，`createKernel(root, { recovery: { enabled: true } })` 开启）
- 关联：[V2-13 rewind 加固](2026-05-31-v2-13-rewind-hardening-recovery-design.md) · [V2-17 chat 统一](2026-05-31-v2-17-chat-kernel-unification-bypass-closure-design.md)

> As-built 偏离：recovery 为 opt-in（kernel 管机制、config 管策略）；`kernel.dispose()` 释放项目锁；Recovery Center 先提供 `kernel.recovery.*` CLI 门面，GUI 面板延后。另含 V2-18c 编辑/rewind 事务日志。

---

## 问题与目标

审批、修复、rewind 的恢复只在进程内：暂停记录在内存 Map，rewind 补偿快照仅内存，无项目级写者锁。进程在暂停或改文件时死亡后，下次启动看不见待批、可能双写或只留半套文件。V2-18 做进程崩溃级持久恢复，同时不引入 daemon、不替换 Git、不自动重做破坏性操作。

## 决策

| 决策点 | 选择 | 否决项 | 理由 |
|---|---|---|---|
| 载荷存放 | 侧车 + journal，事件只留标记 | 全进 event log | 事件无 payload 约束不变 |
| 持久级别 | process-crash durable | fsync 级断电持久 | 刻意不做电源/OS 崩溃保证 |
| 并发 | 单写者锁 + epoch fencing + 接管 | 无锁 | 管理态不许双写 |
| 中断事务 | 一律 abort 回 preimage | 自动完成破坏性操作 | 保守 |
| 未知状态 | 先保全到 `recovered/`，保不了就阻断 | 猜测覆盖 | 不毁数据 |
| 开关 | `recovery.enabled` 默认 false | 默认开 | 不改 main 默认行为 |

## 设计

### 存储布局

```
.deepseek-code/v2/
  .lock/owner.json · takeover/<requestId>.json
  sessions/<projectId>/
    <sessionId>.jsonl · <sessionId>.branches.json
    paused/<approvalId>.json
  journal/<txId>/manifest.json · blobs/
  recovered/<txId>/manifest.json · blobs/
  recovery/inbox.json
```

新模块：`src/core/recovery/atomic-file.js`、`recovery-faults.js`、`project-lock.js`、`paused-turn-persistence.js`、`transaction-journal.js`、`recovery-inbox.js`、`recovery-service.js`、`recovery-errors.js`、`orchestration-persistence.js`。

### 项目锁与接管

`fs.mkdir(lockDir)` 作 Windows 兼容独占原语。`owner.json` 含 `epoch`、owner token/pid/host/surface、`session_id`、`heartbeat_at`、`phase`。心跳约 2s；同机 PID 存活且心跳 <10s 视为 live，否则 stale（跨机 30s）。

管理写路径（事件追加、侧车、journal、编辑/rewind、恢复对账、分支元数据等）在变更前调 `assertOwner()` 比对 `(token, epoch)`。

交互发现 live holder：提示 Take over / Cancel。Take over 写 `takeover/<requestId>.json`（`wx`），holder 取最早请求，发 `takeover:requested`，中断 turn、中止/回滚自有事务、写 `released_at`、释放锁；请求方获得锁后发 `takeover:completed`。超时可确认 force：写 `epoch+1` 新 owner，读回确认 `(token, epoch)` 才算持有。陈旧 holder 醒来后 `assertOwner()` 失败。非交互默认 fail-closed，除非 `takeover: "force"`。

错误码见 `RECOVERY_LOCK_HELD` / `CORRUPT` / `NOT_HELD` / `CHANGED` / `INVALID_OWNER` / `BUSY` / `NOT_OWNED` 等（`project-lock.js` / `recovery-errors.js`）。

### 暂停侧车

路径 `sessions/<projectId>/paused/<approvalId>.json`。存 `schema_version`、ids、`surface`、`permission_context`（自治、指纹用 project_id、信任规则、verify_mode 等）、`approval`、`turn`、`resume_state`。`permission_context` 供重启后续跑复原安全语义；repair 暂停必须含 `resume_state.repair_context.initial_tool_results`。

暂停顺序：写侧车 → 追加并 flush `turn:paused` → 入内存 store → 返回。续跑/取消消费后删或隔离侧车，并发 `turn:resumed` / `turn:cancelled`。扫描按侧车与项目内全部 JSONL 的 `turn:*` 标记对账：有效侧车缺标记可 rehydrate 并补 `turn:rehydrated`；有标记无侧车或侧车损坏 → blocked 项；重复 approval id → blocked/隔离。

### 事务日志

边界：一次 agent 编辑工具调用或一次 rewind apply。已提交事务不回滚；单事务多文件则整单回滚。

`journal/<txId>/manifest.json`：state `open|aborting|committed`、kind `edit|rewind`、paths[]（pre_hash/size/mtime/mode/symlink/blob）、rewind 时另存 `rewind_branch_state.state_before`。文件字节进 blob，不用 UTF-8 JSON 字符串。路径拒绝对路径、穿越、symlink 逃逸、重复 `path_key`。

写序：枚举路径 → 捕获 preimage → 原子写 blob+manifest → 追加 flush `tx:opened` → 才允许第一次工作区变更。提交点：变更完成 → `state: committed` + `commit_id` → flush `tx:committed`。manifest `committed` 是权威提交证明，事件标记可修复。

恢复矩阵要点：`open` 无成功标记 → abort 整单；`open` 有成功标记 → 阻断；`aborting` → 幂等续回滚；`committed` 缺标记 → 修标记后清 journal；损坏或缺 undo blob → 阻断。

冲突/未知状态先保全到 `recovered/<txId>/`，成功后再恢复 preimage；保全失败则阻断启动。恢复自身可崩：先置 `aborting`，不提前删 journal，产物写幂等。

### Recovery Center

`recovery/inbox.json` 只存摘要：`id`、`type`（paused_turn/recovered_tx/blocked_recovery/takeover/quarantined_state）、`status`、`source_id`、`summary`、`evidence`、`allowed_actions`。id 稳定：`rec_pause_*`、`rec_tx_*` 等。`clear` 只隐藏已安全报告项，不删未解决证据。

```js
kernel.recovery.list / resume / cancel / clear / report
```

CLI：`/recovery`、`/recovery resume|cancel|clear <id>`。GUI/TUI 共用同一模型。

启动序：拿锁 → 跑恢复对账 → 不安全则阻断普通启动但仍可看 Recovery Center 做安全 clear/隔离 → 再进正常操作。

### 事件

`recovery:started` / `blocked` / `report`，`tx:opened` / `committed` / `recovered`，`turn:paused` / `rehydrated` / `resumed` / `cancelled`，`takeover:requested` / `completed`。载荷仅 id、计数、类别、必要相对路径；禁止 resume_state、prompt、diff、文件字节、密钥、undo 数据。

### 故障注入测试

`recovery-faults` 按标签在写边界抛 `RECOVERY_FAULT`（如 after-journal-write、after-first-file-write、during-rollback）。要求覆盖：journal 后未变更即崩；多文件中途崩整单回滚；commit 后缺标记修标记；回滚中再崩幂等；外部改文件先保全；损坏侧车/journal 阻断；协作/强制接管与 epoch fencing；Windows 路径大小写；rewind 分支库还原。

## 边界与不变量

1. 不做断电/fsync 级持久、只读观察者、外部 hook 平台。
2. 不自动重做破坏性编辑/rewind。
3. 不回滚任意 shell / 外部编辑器副作用。
4. `paused/`、`journal/`、`recovered/` 是私有恢复载荷，排除遥测与 UI 原文展示，`.gitignore` 覆盖。
5. 事件日志保持 payload-free。

## 与现状的差异

编排暂停侧车见 `orchestration-persistence.js` 与 [C 路持久化](2026-06-27-v3-phase-c-durable-orchestration-recovery-design.md)。存储与错误码以 `src/core/recovery/` 为准。

## 验收

审批/修复暂停重启后可 list/resume/cancel，且自治与权限上下文复原；编辑/rewind 中断事务下次启动回滚；已提交事务不回滚；journal committed 缺标记可修；外部修改先保全；第二进程可 Take over/Cancel；非交互 fail-closed；事件无载荷泄漏；Rewind 恢复分支库；测试无仓库污染。入口 `npm test`、`npm run check`。
