# Phase C5 · 重规划 + 持续派发回合循环

- 类型：后端 spec
- 日期：2026-06-27
- 状态：已实现
- 关联：[C1+C2 编排](2026-06-27-v3-phase-c1-c2-orchestration-design.md) · [C3 并行隔离](2026-06-27-v3-phase-c3-parallel-isolation-design.md) · [C 路持久化](2026-06-27-v3-phase-c-durable-orchestration-recovery-design.md)

---

## 问题与目标

C1–C3 只规划一次；Reviewer 打回仅限 worker 有界重试。C5 把「规划一次→派发一次」扩成确定性回合循环：失败后 `planner.replan` 调整拆法，长任务持续派发，并支持同进程编排级续跑。模型只产下一批子任务，终止由程序闸决定。

## 决策

| 决策点 | 选择 | 否决项 | 理由 |
|---|---|---|---|
| 循环控制 | 程序终止闸 | 模型说停就成功 | done 只停派发，终态看 allCollected |
| replan 校验 | `validateReplan` 严格 | 宽松接受 | 防重复 id 与依赖失败任务 |
| 无进展 | fingerprint 守卫 | 只看 completed 数 | 防换 id 原地打转 |
| 续跑 | 同进程内存 `orchPaused` | 先做跨进程 | 跨进程归后续 durable 片 |
| 暂停点 | 仅串行主区 worker | iso/merge 也暂停 | 状态干净、续跑简单 |
| 默认 | `maxRounds: 2`；1 即退化 C1+C2 | 默认单轮 | 零回归逃生口 |

## 设计

### 回合循环

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

### replan 契约

`planner.replan({ message, done_when, completed, failed }) -> { done, subtasks }`。摘要只含 id/goal/短结果。畸形有界重试；仍失败视作 `{ done:true, subtasks:[] }`。

`validateReplan`：id 跨轮全局唯一；`depends_on` 只能指向 completed 或本轮 id；依赖 failed 仅当 `corrective_for` 指向该失败任务；必给 `tool_profile` / `context_scope`。违规则终止循环。

`fingerprint(st) = normalize(goal + sorted(files) + tool_profile)`。与 `seenSubtaskIds` 分开维护。某轮零新增 completed 且新 subtask 指纹全在 `seenFp` → 无进展停止。

### 终止闸

`decideContinue` 要求同时满足：模型未 `done`、subtasks 非空且过校验、非无进展、未到 `maxRounds`、预算未超。模型 `done:true` 只停止派发回合。最终状态由 synthesizer 依 `allCollected` 判：全 complete=完成；有 failed=部分完成；预算/轮数耗尽未尽=未完成。

### 同进程续跑

暂停时：本轮暂停点前已结算项进 `allCollected`；`roundResume` 只含 pausedWorker、pausedApprovalId、pausedSubtask、remaining。编排状态存内存 `orchPaused[approvalId]`。

`kernel.agent.approve` 先查 `orchestrator.hasPaused`，命中则 `resume`，否则走单 agent。resume 消费条目 → approve/deny paused worker → 结算 → `resumeDispatchLoop` 续 remaining → 续回合循环（用保存 plan，不重 plan）。再次暂停则用新 approval id 存新条目。

不变量：不重 plan、不重复派发、结算单一来源；同进程活 worker 直接 approve；崩溃不保（跨进程见 durable 片）。

### 组件与配置

`planner.replan`、`subtask-schema.validateReplan` / `fingerprint`、`dispatch-loop` 暂停返回 resume + `resumeDispatchLoop`、`orchestrator` 回合循环 / `resume` / `hasPaused`、`synthesizer` 终判、`index.js` approve 路由。`agent-runtime.js` 不改。

`config.orchestration.maxRounds`（默认 2）。事件：`orchestration:round_started` / `replanned`，`orchestration:completed` 扩展 rounds/status。

## 边界与不变量

1. `maxRounds=1` 或无 replan → 与 C1+C2 一致。
2. 模型不得决定最终成功。
3. 暂停只在串行主区 worker。
4. 跨进程 durable、iso/merge 审批门不在本轮。

## 与现状的差异

跨进程续跑见 [C 路持久化](2026-06-27-v3-phase-c-durable-orchestration-recovery-design.md)。`resumeDispatchLoop` 实现以 `dispatch-loop.js` 为准。

## 验收

validateReplan / fingerprint 可单测；回合循环 mock 可测；`maxRounds=1` 零回归；同进程续跑不重 plan、不重复计入；多次暂停-恢复链完整；approve 路由正确。入口 `npm test`。
