# V3 Phase C-Durable · 跨进程编排级 durable 恢复 Implementation Plan

- 类型：实施计划
- 日期：2026-06-27
- 状态：已完成
- 关联：[C-Durable design](../../specs/backend/2026-06-27-v3-phase-c-durable-orchestration-recovery-design.md)、[C5 replan](2026-06-27-v3-phase-c5-replan-resume.md)、[V2-18 recovery](../../specs/backend/2026-06-01-v2-18-durable-recovery-resume-hardening-design.md)、[CHANGELOG](../../CHANGELOG.md)

## 目标

让编排回合（orchestration round）在崩溃重启后能从暂定点续跑：重启后精确重水化被暂停的 worker turn（Option B「完整 worker turn 重水化」），审批落到其原在途工具调用，而非重派整个 subtask。

## 结果

暂停时落两份 sidecar，以同一 `approvalId` 关联：既有 worker turn sidecar（`paused/<approvalId>.json`）+ 新增编排 sidecar（`orchestration-paused/<approvalId>.json`）。重启时 `recovery-service` 扫 `orchestration-paused/` 并与 worker sidecar 交叉校验后登记 inbox。续跑经校验门 → `worker-factory` 确定性重建 worker → 共享 `pausedTurnStore` 让重建 worker 的 `approve` 命中恢复记录 → 重水化其 turn → 结算 → `resumeDispatchLoop` 续本回合 → `driveFrom` 续后续回合。`agent-runtime.js` 一行不改，全靠既有注入依赖（`pausedTurnPersistence` + 共享 `pausedTurnStore`）。

### 新增源码

**`src/core/orchestration/orchestration-recovery-contract.js`**：纯契约层，无 I/O、无活对象。导出 schema 版本常量、指纹常量，以及：

```text
serializeOrchestrationState(state) -> plain JSON
deserializeOrchestrationState(json) -> state | throws
validateOrchestrationSidecar(json) -> { ok, error? }
fingerprintsMatch(stored, current) -> boolean
isOrchestrationWorkerSidecar(workerSidecar) -> boolean
ownershipOk(orchSidecar, workerSidecar) -> boolean
budgetContinuation(orchSidecar) -> { initialTokens, initialModelCalls }
```

**`src/core/recovery/orchestration-persistence.js`**：I/O 层，镜像 `paused-turn-persistence.js` 的原子写 + 损坏隔离：

```text
createOrchestrationPersistence({ root, projectId, faults })
  -> { save, load, scan, consume, quarantine, delete, writeRawForTest }
```

### 修改源码

- `src/core/runtime/cost-budget.js`：新增可选 `initialTokens` / `initialModelCalls` 种子参数（默认 0，零回归），支撑预算续扣（CST-8）。
- `src/core/orchestration/orchestrator.js`：新增注入位 `orchPersistence` / `makeResumedBudget`；`serializeState` / `deserializeState`；`driveFrom` / `resume` 暂停点双轨（gated）；`resumeDurable` / `hasDurablePaused`。
- `src/core/recovery/recovery-service.js`：`recoverOnStartup` 扫 `orchestration-paused` + 交叉校验；`list` / `resume` / `cancel` 处理 `orchestration_paused` 项；边界①孤儿一律 blocked。
- `src/index.js`：recovery 启用时注入共享 `pausedTurnStore`；给 orchestrator 注入 `orchPersistence` / `makeResumedBudget`；`recovery-service` 接 orchestration resume 回调；`kernel.agent.approve` 对 durable id 也路由。
- `package.json`：`check` 脚本登记两个新源码文件。

### 编排 sidecar 契约（canonical shape）

`orchestration-paused/<approvalId>.json` 只存白名单字段，绝不含 raw `options` / 活对象：

```json
{
  "schemaVersion": 1,
  "fingerprints": { "workerFactory": 1, "toolSubset": 1, "subtaskSchema": 1 },
  "approvalId": "ap_x",
  "taskId": "task_x",
  "sessionId": "session",
  "message": "…",
  "done_when": "…",
  "autonomy": "gated",
  "plan": { "subtasks": [ /* SubTask[] */ ] },
  "round": 1,
  "env": { "root": "/abs/root", "orchestrationConfig": { /* plain */ } },
  "allCollected": [
    {
      "st": { /* SubTask */ },
      "status": "complete",
      "wres": { "status": "complete", "content": "…" },
      "verdict": { "pass": true, "severity": "warn", "reasons": [], "checked": [] },
      "lastFeedback": "",
      "change_id": null
    }
  ],
  "seenSubtaskIds": ["a", "b"],
  "seenFp": ["goal|files|profile"],
  "budget": {
    "quotaTokens": null,
    "quotaCalls": null,
    "spentTokens": 0,
    "spentCalls": 0
  },
  "adoptedExperienceIds": [],
  "riskCues": [],
  "pausedSubtask": { /* SubTask: 被暂停子任务, 重建 worker 的依据 */ },
  "remaining": [ /* SubTask[]: 本回合暂定点之后未派 */ ]
}
```

### worker sidecar 的编排归属标记

orchestrator 注入 worker `send` options → 经 `executor-loop` 落 `resume_state.options.__orchestration`：

```json
{
  "__orchestration": {
    "taskId": "task_x",
    "sessionId": "session",
    "subtaskId": "a"
  }
}
```

相关性由共享键 `approvalId` 建立：worker sidecar 落 `paused/<approvalId>.json`，编排 sidecar 落 `orchestration-paused/<approvalId>.json`，同 `approvalId`。`__orchestration` 携带 `taskId` / `sessionId` / `subtaskId` 供边界④归属校验；`approvalId` 的一致性经两份 sidecar 同键隐式保证。

### 新增测试

- `tests/core/orchestration/orchestration-recovery-contract.test.js`（M0）
- `tests/unit/core/recovery/orchestration-persistence.test.js`（M1）
- `tests/unit/core/runtime/cost-budget.test.js`（M2，扩展既有）
- `tests/core/orchestration/orchestrator-serialize.test.js`（M2）
- 后续 M3–M8 的 resume / scan / e2e 测试

## 关键决策 / 遗留约束

### 五条硬边界（CST，逐字取自 spec §5）

**CST-1 `agent-runtime.js` 一行不改。** worker turn 的持久化/重水化只靠既有注入依赖 `pausedTurnPersistence`（worker 继承 → 暂停自动落 `paused/<approvalId>.json` sidecar，含 `resume_state.pending_tool_call`）与可注入的 `pausedTurnStore`（`createAgentRuntime({ pausedTurnStore })` 配置位）。

**CST-2 opt-in 零回归。** 全部新行 gated on `options.recovery.enabled === true`。`recovery.enabled=false`（默认）时不注入 `orchPersistence`、不注入共享 `pausedTurnStore`、不扫 `orchestration-paused/` → C5 同进程续跑逐字节不变。`recovery-service` 仅在 recovery 开启时才被构造，故改动只作用于 recovery-ON 路径。

**CST-3 确定性。** 重建 worker 由持久化的 `subtask` 唯一确定（`worker-factory.worker(subtask)` 的工具子集 + 作用域全从 subtask 推出）；续跑回合逻辑复用 C5（不重 plan、不重复派发、结算单一来源 `allCollected`）。

**CST-4 边界①孤儿一律 blocked。** worker sidecar 带 `__orchestration` 标记但编排 sidecar 缺失/损坏/版本不符 → `blocked_recovery`（绝不降级为单 agent resume）；编排 sidecar 在而 worker sidecar 缺 / consumed / 损坏 → 编排项同样 `blocked_recovery`。仅无 `__orchestration` 标记的普通单 agent sidecar 才走既有单 agent resume。

**CST-5 边界②不存 raw `options`。** 编排 sidecar 只存白名单字段（见契约）；绝无 raw `options`、worker 实例、闭包、`eventBus`、回调、权限上下文活对象。活对象恢复时由 kernel 重注入。worker sidecar 的 `resume_state.options` 仅含 orchestrator 注入的小集 `autonomy` / `projectRules` / `__orchestration`。

**CST-6 边界③版本/指纹门。** sidecar 存 `schemaVersion` + `fingerprints`（`workerFactory` / `toolSubset` / `subtaskSchema`）；恢复前扫描登记与 resume 前校验匹配当前代码常量，不匹配 → `blocked_recovery`，不重建、不 approve。

**CST-7 边界④ approval 归属校验。** 共享 store 与 resume 前校验 `approvalId`（与 sidecar 同键）/ `taskId` / `sessionId` / `pausedSubtask.id` 与 worker sidecar 的 `resume_state.options.__orchestration` 一致，且 worker sidecar 确带 `__orchestration`（turn owner 类型一致）。任一不符 → `blocked_recovery`。

**CST-8 边界⑤预算续扣。** 编排 sidecar 存原配额 + 已花计数；恢复时 `budget` 重建为「配额 − 已花」继续扣（`createCostBudget` 的 `initialTokens` / `initialModelCalls` 种子），绝不重置。

> 实现注（防误读）：当前编排聚合 `state.budget` 只被 `.exceeded()` 读、其 `recordModelResult` 尚未被编排层调用（worker/planner 各持自己的 agent-runtime 预算），故真实「已花」现为 0。本片只负责忠实序列化 + 续扣重建（spentTokens/spentCalls 从 `budget.snapshot()` 取、恢复时 reseed）；续抽数学由 M0/M2 单测用显式 `recordModelResult` 打点验证。M8 e2e 只断言 sidecar 携带 quota+spent 字段，不依赖非零 spend。将来若把聚合记账接上，续扣自动生效。

**CST-9 对等清理。** 完成/取消 → 删编排 sidecar（consume 墓碑）+ worker sidecar 由 agent-runtime `approve` 置 consumed；启动扫描 consumed/孤儿沿用既有隔离机制。

**CST-10 node:test。** 全部测试用 `node:test` + `node:assert/strict`，确定性优先（mock gateway/store/worker，不打真实网络）。运行 `npm test`；语法门 `npm run check`（新增源码文件必须登记进 `package.json` 的 check 脚本）。

### 写序 / 崩溃窗口

spec §5.6 期望「先写编排 sidecar、再触发 worker 暂停落盘」。但在 CST-1（agent-runtime 不改）下，worker sidecar 由 `worker.send()` 内部的 `savePausedRecord` 写出，发生在 orchestrator 重获控制权之前；且编排 sidecar 的键 `approvalId` 由 worker 暂停时才生成，物理上无法在 worker sidecar 之前写。

本计划落地的实际写序：worker sidecar 先（`worker.send` 内，不可改）→ 编排 sidecar 后（orchestrator 见 `awaiting_approval` 时立即写）。崩溃窗口是「worker 在、编排缺」，正落在 CST-4 的 blocked 分支，安全不变量（孤儿一律 blocked、绝不带病续跑）完全保持。仅「哪一份先落」这一窗口最小化细节因 CST-1 而反置；两个方向的孤儿都 blocked，故写序不影响安全性。

### 里程碑映射（as-built）

| 里程碑 | 内容 |
|--------|------|
| M0 | 契约层 + 状态机 + off-parity 骨架 |
| M1 | orchestration-persistence I/O |
| M2 | cost-budget 种子 + orchestrator serialize |
| M3 | 暂停点双轨（gated） |
| M4 | resumeDurable + worker 重建 |
| M5 | 编排 sidecar 写出 + orchestrationMarker |
| M6 | recovery-service scan + 交叉校验 + blocked |
| M7 | 预算续扣接线 |
| M8 | e2e + 回归 + 文档收口 |

## 验证

`tests/core/orchestration/orchestration-recovery-contract.test.js`（serialize 白名单、`round.options === undefined`、指纹门不匹配 blocked、ownershipOk、budgetContinuation）、`tests/unit/core/recovery/orchestration-persistence.test.js`（原子写、损坏隔离、scan/consume/quarantine）、orchestrator-serialize、cost-budget 种子续扣（显式 `recordModelResult` 打点）、c-durable e2e。

M8 自检覆盖 CST-1～CST-10 逐条：`git diff` 不含 agent-runtime.js；off-parity 断言；确定性重建 plan-once；deny 路径 + corrupt/gate blocked；consume 清理；双方孤儿 blocked；serialize 白名单断言；指纹门 + ownershipOk；预算续扣字段。

off-parity：recovery 关闭时 C5 同进程续跑逐字节不变，现有基线不动。当时基线 739 全绿。文档收口补 project-overview §6/§14.5、CHANGELOG、README 中英、docs/README 索引。当前入口 `src/core/recovery/orchestration-persistence.js`、`src/core/recovery/recovery-service.js`、`src/core/orchestration/orchestration-recovery-contract.js`、`src/core/orchestration/orchestrator.js`、`src/core/runtime/cost-budget.js`、`src/index.js`。

## 自检清单（实施完成后逐条核对 spec）

**Spec §5 硬约束条目**：

1. `agent-runtime.js` 一行不改 → M1–M8 无一处改它，仅注入 `pausedTurnStore` / `pausedTurnPersistence`；M8 Step `git diff` 不含 agent-runtime.js。CST-1。
2. opt-in 零回归 → M3/M5/M7 全 gated on `recoveryEnabled` / `orchPersistence`；M3/M7/M8 均有 off-parity 断言；M8.2 全量 739。CST-2。
3. 确定性重建 → M4 `worker-factory.worker(pausedSubtask)`；续跑复用 C5（M8 plan-once 断言）。CST-3。
4. 安全（暂停=写前闸 / deny 失败 / 损坏 blocked）→ M4 deny 路径 + M6 corrupt/gate blocked。
5. 对等清理 → M4/M5 consume；M6 consumed 跳过。
6. 崩溃窗口孤儿一律 blocked → M6 双方都 blocked（orphan worker + 缺 worker）；写序澄清见上文。CST-4。
7. 不存 raw options → M0 serialize 白名单；M0 test 断言 `round.options === undefined`。CST-5。
8. 版本/指纹门 → M0 `orchestrationResumeGate` + M4/M6 调用；不符→blocked。CST-6。
9. approval 归属校验 → M0 `ownershipOk`；M4/M6 门。CST-7。
10. 预算续扣 → M2 cost-budget 种子 + M0 `budgetContinuation` + M7 `makeResumedBudget`；M8 sidecar spend 断言。CST-8。

**Spec §6 里程碑映射**：M0→契约/persistence 起步 → M1→persistence → M2→预算种子 + serialize → M3→暂停双轨 → M4→resumeDurable → M5→sidecar 写出 → M6→scan + blocked → M7→预算续扣 → M8→e2e + 文档。全覆盖。

**类型一致性核对**：`orchestrationResumeGate` / `serializeOrchestrationState` / `deserializeOrchestrationState` / `isOrchestrationWorkerSidecar` / `ownershipOk` / `budgetContinuation`（M0 定义）在 M1/M4/M6 调用签名一致；`resumeDurable` / `hasDurablePaused` / `persistDurablePause` / `consumeWorkerSidecar`（M4 定义）在 M5/M7 调用一致；`orchestrationMarker`（M5）字段 `{taskId, sessionId, subtaskId}` 与 `ownershipOk` 读取一致；inbox id 前缀 `rec_orch_` / `rec_pause_` 在 M6 scan/resume/cancel 一致。
