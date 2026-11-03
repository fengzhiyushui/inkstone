# 编排（Living Spec）

- 类型：后端 spec
- 状态：Living Spec，随实现更新；v1.19.0 整合自 6 篇历史 spec（实现至 v1.18.0）
- 关联：[运行时与执行](runtime-and-execution.md) · [上下文与记忆](context-and-memory.md) · [编辑/会话/恢复](edits-sessions-recovery.md) · [系统架构](../architecture/system-architecture.md) · [文档索引](../../README.md)

> 本文是 v1.19.0 整合后的领域 Living Spec，取代原 6 篇碎片化历史 spec（见文末「来源」）。`agent-runtime.js` 在整个 Phase C 与 v1.18.0 期间保持不改：Worker / Reviewer 就是注入了不同工具子集与上下文作用域的 `agent-runtime` 实例。

## 来源与覆盖

| 来源（basename） | 覆盖内容 |
|---|---|
| `2026-06-27-v3-phase-c1-c2-orchestration-design.md` | 唯一入口与路由、Planner、派发循环、两级审核、工具子集、成本闸与事件 |
| `2026-06-27-v3-phase-c-router-tiered-design.md` | C-Router 分层与评分、模型档、事件与配置 |
| `2026-06-27-v3-phase-c3-parallel-isolation-design.md` | 并行写隔离：切批、iso 工作区、CAS 合并、清扫 |
| `2026-06-27-v3-phase-c4-experience-memory-design.md` | 编排面对齐部分（经验记忆本体见[上下文与记忆](context-and-memory.md)） |
| `2026-06-27-v3-phase-c5-replan-resume-design.md` | 回合循环、replan 契约、终止闸、同进程续跑 |
| `2026-06-27-v3-phase-c-durable-orchestration-recovery-design.md` | 跨进程编排级持久恢复 |
| `2026-10-07-v1.18-r18-01-aggregate-budget-contract.md` | 请求级全角色聚合记账与全树取消（编排视角） |
| `2026-10-23-v1.18.0-runtime-closure-design.md` | R18-02 真实 `task` 委派 |

---

## 1. 组件总览（`src/core/orchestration/`）

`task-router.js`、`router-scoring.js`、`orchestrator.js`、`planner.js`、`subtask-schema.js`、`worker-factory.js`、`reviewer.js`、`tool-profiles.js`、`synthesizer.js`、`dispatch-loop.js`、`batch-planner.js`、`workspace-snapshot.js`、`path-overlap.js`、`iso-workspace.js`、`merge-back.js`、`iso-worker-runner.js`、`task-delegation-contract.js`、`task-delegation-service.js`、`orchestration-recovery-contract.js`。

意图分类词表在 `src/core/planning/keywords.js`（中英共表，`classifier.js` 与 `task-router.js` 共用；edit/diagnostic/query + 中文疑问语气）。

---

## 2. 确定性路由器与 `RoutingDecision`

```
kernel.send(message)
  → task-router → lane=single → agentRuntime.send（既有路径）
               → lane=orchestrate → orchestrator.run
```

`RoutingDecision`：`{ lane, reason, signals }`，`lane ∈ { single, orchestrate }`。复杂度信号（可配，`config.orchestration.router.markers`）：多重性标记（这几个/分别/for each/迁移…）、跨多文件（`minComplexFiles: 2`）、显式要规划。默认 single，命中强信号才 orchestrate。

---

## 3. C-Router 分层（模型辅助复杂度判定）

### 3.1 分层骨架

```
feat = extractFeatures → score = computeScore → band = classifyBand
if !modelActive: lane = signals.length ? orchestrate : single   # 今天的逻辑
if band==simple:  single（免费）
if band==complex: orchestrate（免费）
else: modelTier → verdict.lane 或 heuristicFallbackLane
```

| band | 条件 | 决策 | 模型 |
|---|---|---|---|
| simple | `score = 0` | single | 无 |
| complex | `score ≥ complexThreshold`（默认 3） | orchestrate | 无 |
| ambiguous | 其间 | 模型判 | 1 次（失败回退） |

`route()` 启发式档同步返回；仅模型档返回 Promise。调用方已 `await`。

### 3.2 评分（`router-scoring.js`，纯函数）

- **强 marker +2/个**：重构整个/迁移/跨多个文件/跨文件/refactor the entire/migrate/across multiple。
- **弱 marker +1/个**：这几个/这些/分别/各自/逐个/逐一/for each/each of。
- **文件 token**：`normalizeFileToken` 去重后首个免计、其后 +1、**封顶 +3**。
- **长 edit 捕手**：`task_type === "edit"` 且消息长度 ≥ `LONG_EDIT_CHARS`（80）→ +1。

`features` 只含命中的短 token 与计数，列表截断 ≤8，不进完整用户消息。`score` / `band` / `features` 一并返回，便于调阈值。

### 3.3 模型档

- 总调用 ≤ `maxRepairs + 1`（默认 1 → 最多 2 次；`maxRepairs = 0` → 1 次）。
- 总超时 `timeoutMs`（默认 8000）跨全部重试。
- verdict 仅 `{"lane":"single"|"orchestrate","reason":"..."}`，越界字段忽略。
- 失败短码：`router_model_timeout` / `_invalid` / `_empty` / `_error`，异常原文不进事件。
- 回退 lane = signals-only（今日逻辑）。
- 配置 `channel` 作 gateway `purpose`（默认 `act` flash 档）；未知 channel 抛错后兜底。

### 3.4 事件与配置

`orchestration:route_resolved` 仅模型档运行时发出，载荷含 band/score/features/lanes/tier/reason。simple/complex 短路与 disabled 不发。该事件为 eventBus 级，不进 `SESSION_EVENT_TYPES`。

```js
config.orchestration.router.model = {
  enabled: true, channel: "act", timeoutMs: 8000, maxRepairs: 1, complexThreshold: 3
}
```

### 3.5 边界

1. `agent-runtime.js` / `classifier.js` 不改。
2. 模型不得改档、不得拆任务（拆分是 Planner 的事）。
3. `disabled` 或裸构造无 `callModel` 时 lane 与今天逐字节一致；disabled 路径只读 signals，不读 score。
4. 长 edit 捕手永不进入 signals。
5. 路由决策缓存、权重配置化、经验喂路由不在范围内。

---

## 4. `subtask-schema`：Plan / SubTask / Verdict + `topoOrder`

```text
SubTask { id, goal, acceptance[], context_scope{files,symbols}, tool_profile: edit|readonly, depends_on[] }
Plan { task_summary, subtasks[], done_when }
Verdict { pass, severity, reasons[], checked[] }
```

`topoOrder(subtasks)` 产出拓扑序；`validateReplan` 做 replan 严格校验（见 §9）。`fingerprint(st) = normalize(goal + sorted(files) + tool_profile)`。

---

## 5. Planner

- thinking 通道产出结构化 `Plan`；schema 校验失败有界重试；仍失败**降级为单个 edit 子任务**。
- `planner.replan({ message, done_when, completed, failed }) -> { done, subtasks }`。摘要只含 id/goal/短结果。畸形有界重试；仍失败视作 `{ done:true, subtasks:[] }`。
- Planner 消耗经验简报：`planner.plan({ experiences })`，并回 `used_experience_ids`。
- 预算行为：`role: "planner"` 预留默认 1000 tokens；预算耗尽抛 `BUDGET_EXCEEDED` 不吞错、不降级。

---

## 6. `tool-profiles`（edit / readonly）

| profile | 工具 |
|---|---|
| `readonly` | `read` `ls` `grep` `glob` `test` `diff_preview` |
| `edit` | readonly + `edit` `diff_apply` `diff_rollback` `git` |

Reviewer 恒 readonly。Worker 用 `st.context_scope` 偏置上下文。

---

## 7. Worker / Reviewer / `worker-factory`

- `worker-factory.worker(subtask)` 产出可多开的 `agent-runtime` 实例（注入不同 `executeTool` / `project_root` 与工具子集）。
- **关卡 1 子自审**：复用 `verifyAndMaybeRepair` / `runRepairLoop`（测试 + 验收标准）。
- **关卡 2 Reviewer 独立审**：`makeReviewer` 注入 `scopedGateway`，只读工具独立复查，无写工具，不因 Worker 自审通过就放行。Verdict schema 校验失败则保守 `pass:false, severity:"warn"`。
- Reviewer 记账 `role: "reviewer"`（默认 500 tokens）；Worker 记账 `role: "worker"`（默认 1500 tokens），Worker 内部 verify/repair 在同一 scope 内记账。

---

## 8. `dispatch-loop` 与 `synthesizer`

### 8.1 派发循环

拓扑序串行执行（并行见 §11）。每个子任务：Worker `send` → 自审不过带反馈重试 → Reviewer 出 `Verdict` → 通过收集 / 否决打回（有界，`maxWorkerAttempts` 默认 2）→ 耗尽标失败。预算超限则「部分完成」诚实收尾，不抛。

### 8.2 `synthesizer`

汇总 `allCollected`，失败诚实汇报。`role: "synthesizer"`（默认 800 tokens）；若预算耗尽，直接返回确定性摘要，不发起额外模型调用。

### 8.3 事件（仅 orchestrate 档）

`orchestration:routed` / `planned` / `subtask_started` / `subtask_reviewed` / `completed`，以及 §9 的 `round_started` / `replanned` 与取消时的 `orchestration:cancelled`。子 run 嵌在父 turn 时间线下。

---

## 9. 重规划（C5）与回合循环

### 9.1 回合循环

```
plan = planner.plan(...)
loop:
  result = runDispatchLoop(当前批)
  allCollected += result.collected   # 唯一结算入口
  if awaiting_approval → 存 roundResume + orchPaused → 上浮
  if round >= maxRounds or budget exceeded → break
  next = planner.replan({ completed, failed 摘要 })
  gate = decideContinue(next, state)
  if !gate.continue → break
  续跑下一批
final = synthesizer(allCollected)  # 完成 / 部分完成 / 未完成
```

`config.orchestration.maxRounds` 默认 **2**；1 即退化 C1+C2。`maxRounds = 1` 或无 replan 时与 C1+C2 一致。

### 9.2 replan 契约与校验

`validateReplan`：id 跨轮全局唯一；`depends_on` 只能指向 completed 或本轮 id；依赖 failed 仅当 `corrective_for` 指向该失败任务；必给 `tool_profile` / `context_scope`。违规则终止循环。

`fingerprint` 与 `seenSubtaskIds` 分开维护。某轮零新增 completed 且新 subtask 指纹全在 `seenFp` → **无进展停止**。

### 9.3 终止闸

`decideContinue` 要求同时满足：模型未 `done`、subtasks 非空且过校验、非无进展、未到 `maxRounds`、预算未超。模型 `done: true` 只停止派发回合，**不代表成功**。最终状态由 synthesizer 依 `allCollected` 判：

| 条件 | 终态 |
|---|---|
| 全 complete | `complete` |
| 有 failed | `partial` |
| 被预算/轮数 cap 停 | `incomplete` |

### 9.4 同进程续跑

暂停时：本轮暂停点前已结算项进 `allCollected`；`roundResume` 只含 `pausedWorker`、`pausedApprovalId`、`pausedSubtask`、`remaining`。编排状态存内存 `orchPaused[approvalId]`。

`kernel.agent.approve` 先查 `orchestrator.hasPaused`，命中则 `resume`，否则走单 agent。resume 消费条目 → approve/deny paused worker → 结算 → `resumeDispatchLoop` 续 remaining → 续回合循环（用保存 plan，**不重 plan**）。再次暂停则用新 approval id 存新条目。

不变量：不重 plan、不重复派发、结算单一来源；同进程活 worker 直接 approve；暂停点仅串行主区 worker（iso/merge 不暂停）；崩溃不保（跨进程见 §13）。

---

## 10. 成本闸与 `orchestrator` 组装

聚合 `createCostBudget`：

| 键 | 默认 |
|---|---|
| `orchestration.maxSubtasks` | 8 |
| `orchestration.maxWorkerAttempts` | 2 |
| `orchestration.maxRounds` | 2 |
| `orchestration.budget.maxTokens` | null |
| `orchestration.budget.maxModelCalls` | 40 |

命中即部分完成，不抛。`maxSubtasks` 超限时截断计划。`orchestrator.run` 组装修整 dispatch-loop / synthesizer / planner / worker-factory / reviewer。

请求级全角色聚合记账（`RequestBudget` / `RequestScope`）见 §14 与[运行时与执行](runtime-and-execution.md) §7。

---

## 11. 并行写隔离（C3）

### 11.1 流程

```
topoOrder → toBatches（依赖完成 + 不重叠最大集）
  批大小 1 或并发 1 → 主区原路（C1+C2）
  否则并行：
    isoRoot = fsCopyWorkspace（排除 .git/node_modules/.deepseek-code）
    baseManifest = hashTree(isoRoot)
    toolPlane = buildToolPlane(isoRoot)
    worker.send → 审核 → actual = changedPaths
    校验 actual ⊆ 声明范围 && 批内 actual 不重叠
    finally removeIso
  合并（按 subtask id 序）：
    净 diff → 主区 path hash == base → 一次 editService.apply
    冲突/失败 → 回滚标失败
```

### 11.2 硬约束

- **每 subtask 全部改动 = 一次原子事务**；批次可部分成功。
- **合并前 CAS**：主区当前 hash 必须等于 `baseManifest`；不符即冲突，该 subtask 失败不污染主区。
- **不信声明**：用 `baseManifest` 算 `actual`，断言 `actual ⊆ context_scope.files` 且批内两两不重叠；越界则该 subtask 失败。
- **路径归一**：分隔符、`./`、Windows 小写、尽力 realpath；`overlaps` 支持目录包含；rename 记旧+新两路径。
- **零残留**：iso 目录 `.deepseek-code/v2/orchestration/iso/<runId>/<subtaskId>/`，`finally` 删除带 retry/backoff；启动 `sweepOrphans` 只删 owner pid 超 TTL（默认 1h）或本进程遗留；批末删 run 目录。
- **降级**：超过 `maxCopyFiles`（默认 5000）或拷贝失败 → 该批回退串行，不崩。
- 合并用**整文件净 unified diff**，一次 `editService.apply` 原子合并。

### 11.3 组件与配置

`workspace-snapshot.js`（`fsCopyWorkspace` / `hashTree` / `changedPaths`）、`path-overlap.js`、`iso-workspace.js`、`merge-back.js`、`batch-planner.js`；`dispatch-loop.js` 改为按批；`index.js` 抽 `buildToolPlane(root)`。

```js
config.orchestration.parallel = { maxParallelWorkers: 4, maxCopyFiles: 5000, sweepTtlMs: 3600000 }
```

默认 `maxParallelWorkers = 1` 等价串行，是零回归逃生口。

### 11.4 取消时的无迟到合并

派发前、并行等待后、以及调用 `mergeSubtask` 前严格检查 `signal.aborted`。若已被取消，已在隔离目录产出修改的 Worker 成果**绝不**合入主工作区；临时隔离目录经 `removeIso` 彻底清理，终态返回 `status: "cancelled"`。

---

## 12. `task` 委派（v1.18.0 真实受限子 Worker）

### 12.1 权能交集与防递归护栏（`task-delegation-contract.js`）

- **参数契约**：`prompt` 必填非空字符串；`tools` 可选字符串数组，最多 `MAX_TASK_TOOLS = 5` 项，拒绝非字符串、空串、重复项、未知工具与递归工具（`task`、`ask_user`），**不做静默截断**。
- **有效工具集（交集收窄）**：
  `effectiveTools = (requestedTools ∪ defaultReadonly) ∩ parentAllowedTools ∩ profileAllowedTools \ {task, ask_user}`
  若父上下文不具备某写工具权限（如只读父任务请求 `edit` 或 `shell`），直接返回 `status: "denied"`（`TASK_TOOL_ESCALATION_DENIED`），零副作用。
- **深度限制（`MAX_TASK_DELEGATION_DEPTH = 1`）**：子 Worker 的工具 schema 列表**硬性剥离** `task` 与 `ask_user`；执行层通过 `context.taskDelegationDepth >= 1` 双重拦截伪造的 `task` 调用（`TASK_RECURSION_DENIED`），杜绝孙任务与无限递归。

### 12.2 父子状态机与审批暂停（`task-delegation-service.js`）

```text
[*] --> Dispatched: parent invokes task
Dispatched --> ChildRunning: intersection & depth=1 verified
ChildRunning --> Completed: child status == complete
ChildRunning --> Failed: child error / stopped / empty
ChildRunning --> ChildPaused: child tool requires approval
ChildPaused --> ChildResuming: parent approve(approvalId, "approve")
ChildPaused --> Cancelled: parent approve(approvalId, "deny") / cancelPaused
ChildResuming --> ChildPaused: child pauses on subsequent tool (re-pause)
ChildResuming --> ChildCompletedPendingParent: child finishes (State 5 checkpoint)
ChildCompletedPendingParent --> Completed: parent turn consumes checkpointed tool result
```

- **两级独立授权**：批准父回合外层 `task` 工具调用**绝不**自动批准子 Worker 内部的受控写工具（如 `edit`、`shell`）；子写工具触发 `awaiting_approval` 时，携带真实子工具审批摘要与 `approval.id` **向上冒泡使父回合暂停**。
- **续跑与二次暂停（Case B）**：批准子审批时，父回合通过 `taskDelegationResume` 定位子 Worker 的 `pending_tool_call` 精确续跑，**不重新派发整个 `task`**，已完成的前置工具不重复执行。若子 Worker 续跑后命中第二个需审批工具，消费旧 `approvalId`、生成新 `approvalId` 并更新父子关联，保留父回合剩余工具队列（`remaining_tool_calls`）。
- **预算与取消共享**：子 Worker 共享父回合局部 `CostBudget`（双向同步增量）与编排 `RequestScope`（`role: "task"` 记账）；父回合 `interrupt()`、超时或 `kernel.dispose()` 立即中止在途子 Worker。

### 12.3 跨进程持久化与幂等边界（`task-paused-persistence.js`）

- **Sidecar 存储**：`recovery.enabled = true` 时，子 Worker 暂停状态写入 `.deepseek-code/v2/sessions/<projectId>/task-paused/<approvalId>.json`（`schemaVersion = 1`，含 `fingerprints`、`task_id`、`parent_turn_id`、`parent_tool_call_id`、`session_id`、脱敏后的 `child_record` 与 `state`）。
- **启动交叉校验（`recovery-service.js`）**：父 `paused/<approvalId>.json` 含 `resume_state.task_delegation` 时，必须存在匹配的 `task-paused/<approvalId>.json`，且 `schemaVersion`、`fingerprints`、`approvalId`、`taskId`、`parentTurnId`、`parentToolCallId`、`sessionId` 全量吻合。孤儿父记录、孤儿子记录、损坏 JSON 或版本/指纹不匹配一律标记为 `blocked_recovery` 并移入隔离或原样保留证据，**绝不降级为无主单 Worker 恢复或自动重派**。
- **故障注入与 State 5 检查点幂等**：子 Worker 恢复执行期间先落盘 `state: "child_resuming"`；若在完成检查点前崩溃，重启扫描见到 `state === "child_resuming"` 无法证明写操作是否已完成，明确阻断自动恢复（`task child crashed mid-resume before completion checkpoint`），防止重复写入。子 Worker 完成后先落盘 `state: "child_completed_pending_parent"`（State 5 检查点，含脱敏限长后的 `completed_tool_result`），再交由父回合继续；若在父回合消费前崩溃，恢复时直接向父回合回灌已保存的 `completed_tool_result`，子写操作严格只执行一次。

---

## 13. 跨进程编排级 durable 恢复（C-Durable）

Option B「完整 worker turn 重水化」——审批落回原在途工具调用，不重派整个 subtask。opt-in：`recovery.enabled` 默认关。

### 13.1 双 sidecar

Worker turn sidecar 由既有 `pausedTurnPersistence` 写（`agent-runtime` 不改），options 带 `__orchestration: { approvalId, taskId }` 标记。

编排 sidecar `orchestration-paused/<approvalId>.json`（`orchestration-persistence.js`）只存白名单：`schemaVersion`、`fingerprints`（workerFactory / toolSubset / subtaskSchema）、ids、message、plan、round、`env.root`、orchestrationConfig、`allCollected` 摘要、seen 集、budget 配额与已花、`pausedSubtask`、`remaining`。**无** raw options / 实例 / 闭包 / eventBus。

写序：先编排 sidecar，再触发 worker 暂停落盘，缩小「worker 在、编排缺」窗口。

### 13.2 启动扫描

`recovery-service` 扫 `orchestration-paused/`：双 sidecar 合法且指纹匹配 → inbox 项 `type: "orchestration_paused"`，actions `resume|cancel`。孤儿（任一侧缺失/损坏/版本不符，或 worker 带编排标记但编排侧不可用）→ `blocked_recovery`，绝不降级单 agent。

### 13.3 续跑（`resumeDurable`）

校验门（schema、指纹、approval/task/session/subtask 归属）→ 反序列化状态、活对象由 kernel 重注入 → `worker-factory.worker(pausedSubtask)` 重建 worker（**共享 `pausedTurnStore`**）→ restore worker turn → `approve` 落到 `pending_tool_call`（deny 则 subtask 失败）→ 结算 → `resumeDispatchLoop` 续 remaining → 续回合（**不重 plan**）。完成/取消删双 sidecar 或置 consumed。**预算续扣，绝不重置**。

### 13.4 契约与边界

契约函数在 `src/core/orchestration/orchestration-recovery-contract.js`（`ORCH_RECOVERY_SCHEMA_VERSION`、`ORCH_FINGERPRINTS`、`validateOrchestrationSidecar`、`ownershipOk`、`serializeOrchestrationState` 等）；存储见 `src/core/recovery/orchestration-persistence.js`（基于 `sidecar-store.js` 通用底座）。

1. `agent-runtime.js` 不改。
2. `recovery.enabled = false` 时行为与 C5 逐字节一致。
3. 暂停=写前门，重水化只续待执行写调用。
4. 指纹/归属不符则 blocked，不重建不 approve。
5. 预算续扣，绝不重置。
6. 不做：把编排状态内联进 worker sidecar 的单份原子写、跨进程并发多编排锁以外的协调、语义上下文跨进程完整重放。

---

## 14. 请求级全角色聚合记账与全树取消

编排视角要点（完整契约见[运行时与执行](runtime-and-execution.md) §7）：

- `routedSend` 在路由决策前创建全局 `rootBudget` 与 `baseScope`，`router` 的模型档调用即按 `role: "router"` 计入同一 `executionId` 账本。
- 判定 `orchestrate` 时继承该账本，经 `scope.bindGateway(modelGateway, { role, subtaskId })` 覆盖 `planner` / `worker` / `reviewer` / `replan` / `synthesizer` / `task` / `experience` 全角色；判定 `single` 时不挂载 `orchestration.budget`。
- 三阶段原子记账：`reserveCall`（出站前并发原子预留）→ `markStarted`（物理 HTTP 发起前扣 `model_calls`，网络失败不退还）→ `settle`（按 `attemptId` 幂等结算真实 usage，缺失/非法计入 `unknownUsageAttempts` / `unknownUsageTokens` 保底负债）。
- 并发争抢：多个 Worker 竞争剩余配额时，超限额者在发起出站 HTTP 前被直接拦截（`BUDGET_EXCEEDED`）。
- 后台 `experience` 蒸馏：`kickConsolidation` 检查预算与取消信号，已超限或被取消则主动跳过，不产生未受控的幽灵费用；`agent.interrupt()` 会干净取消在途后台请求。
- 全树取消：`interrupt()` 遍历 `activeScopes` + `orchestrator.interrupt()` 中止 `activeRunningScope` 与 `backgroundScopes` + `runtime.interrupt()`；`dispose()` 类似但**不**调 `runtime.interrupt()`，以保留磁盘 sidecar 供跨进程恢复。
- 旧记录门禁：有限配额 + 历史未记账 → fail-closed 拒绝（`legacy unmetered budget: cannot safely verify remaining quota`）；有未知次数但金额不完整 → `ORCH_RECOVERY_BLOCKED`；无限额历史记录允许恢复并标记 `legacyUnmetered = true`。

---

## 15. 边界与不变量（Phase C 总则）

1. `agent-runtime.js` 不改。
2. 派发/打回/再派是程序逻辑读结构化结果，不甩给模型即兴。
3. 模型不得决定最终成功。
4. 默认 single 档零新事件、与既有路径一致。
5. 成本闸（`maxSubtasks` / `maxWorkerAttempts` / `maxRounds` / `budget`）与轮数有硬上限。
6. 写冲突隔离：隔离工作副本 + 合并 + 项目锁。
7. 持久化复用 Phase A；子 agent 事件嵌套进会话时间线。
8. `off` / `maxRounds=1` / `maxParallelWorkers=1` / `recovery.enabled=false` 都是零回归逃生口。

---

## 来源

- `2026-06-27-v3-phase-c1-c2-orchestration-design.md`
- `2026-06-27-v3-phase-c-router-tiered-design.md`
- `2026-06-27-v3-phase-c3-parallel-isolation-design.md`
- `2026-06-27-v3-phase-c4-experience-memory-design.md`
- `2026-06-27-v3-phase-c5-replan-resume-design.md`
- `2026-06-27-v3-phase-c-durable-orchestration-recovery-design.md`
- `2026-10-07-v1.18-r18-01-aggregate-budget-contract.md`
- `2026-10-23-v1.18.0-runtime-closure-design.md`
