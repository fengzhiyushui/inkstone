# Phase C-Durable · 跨进程编排级持久恢复

- 类型：后端 spec
- 日期：2026-06-27
- 状态：已实现
- 关联：[C5 同进程续跑](2026-06-27-v3-phase-c5-replan-resume-design.md) · [V2-18 持久化恢复](2026-06-01-v2-18-durable-recovery-resume-hardening-design.md)

---

## 问题与目标

C5 续跑靠内存 `orchPaused`（含活 worker 引用与闭包），进程退出即丢。本片做跨进程恢复：崩溃/重启后从暂停的编排状态续跑。采用 Option B「完整 worker turn 重水化」——审批落回原在途工具调用，不重派整个 subtask。opt-in：`recovery.enabled` 默认关。

## 决策

| 决策点 | 选择 | 否决项 | 理由 |
|---|---|---|---|
| 重水化 | 重建 worker + 重水化其 turn | 重派 subtask | 暂停在写前审批门，无半成品 |
| 持久化 | 编排 sidecar + 既有 worker turn sidecar | 序列化活对象 | 闭包不可落盘 |
| 孤儿 | 一律 `blocked_recovery` | 降级单 agent | 防执行 pending 写却无人 settle |
| 版本 | schemaVersion + fingerprints 校验 | 盲目重建 | 防升级后不等价 worker |
| 预算 | 配额 − 已花续扣 | 重启重置 | 防绕过成本闸 |
| 共享 store | recovery 开启时主+worker 共用 `pausedTurnStore` | 各自独立 | restore 后重建 worker 须可见 |

## 设计

### 双 sidecar

Worker turn sidecar 由既有 `pausedTurnPersistence` 写（`agent-runtime` 不改），options 带 `__orchestration: { approvalId, taskId }` 标记。

编排 sidecar `orchestration-paused/<approvalId>.json`（`orchestration-persistence.js`）只存白名单：schemaVersion、fingerprints（workerFactory/toolSubset/subtaskSchema）、ids、message、plan、round、env.root、orchestrationConfig、allCollected 摘要、seen 集、budget 配额与已花、pausedSubtask、remaining。无 raw options / 实例 / 闭包 / eventBus。

写序：先编排 sidecar，再触发 worker 暂停落盘，缩小「worker 在、编排缺」窗口。

### 启动扫描

`recovery-service` 扫 `orchestration-paused/`：双 sidecar 合法且指纹匹配 → inbox 项 `type: "orchestration_paused"`，actions `resume|cancel`。孤儿（任一侧缺失/损坏/版本不符，或 worker 带编排标记但编排侧不可用）→ `blocked_recovery`，绝不降级单 agent。

### 续跑

`resumeDurable`：校验门（schema、指纹、approval/task/session/subtask 归属）→ 反序列化状态、活对象由 kernel 重注入 → `worker-factory.worker(pausedSubtask)` 重建 worker（共享 store）→ restore worker turn → `approve` 落到 `pending_tool_call`（deny 则 subtask 失败）→ 结算 → `resumeDispatchLoop` 续 remaining → 续回合（不重 plan）。完成/取消删双 sidecar 或置 consumed。

### 约束

1. `agent-runtime.js` 不改。
2. `recovery.enabled=false` 时行为与 C5 逐字节一致。
3. 暂停=写前门，重水化只续待执行写调用。
4. 指纹/归属不符则 blocked，不重建不 approve。
5. 预算续扣，绝不重置。

## 边界与不变量

契约函数在 `src/core/orchestration/orchestration-recovery-contract.js`（`ORCH_RECOVERY_SCHEMA_VERSION`、`ORCH_FINGERPRINTS`、`validateOrchestrationSidecar`、`ownershipOk`、`serializeOrchestrationState` 等）。存储见 `src/core/recovery/orchestration-persistence.js`。

不做：把编排状态内联进 worker sidecar 的单份原子写（可评估）、跨进程并发多编排锁以外的协调、语义上下文跨进程完整重放。

## 验收

契约往返等价与拒绝路径有测；共享 store 不串 id；指纹/归属不符 blocked；e2e 跨 kernel 实例：暂停→dispose→新实例扫描→resume 重水化→续跑完成；off 零回归。入口 `npm test`。
