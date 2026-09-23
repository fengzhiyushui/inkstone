# V3 Phase C5 重规划 + 持续派发回合循环 Implementation Plan

- 类型：实施计划
- 日期：2026-06-27
- 状态：已完成
- 关联：[C1+C2](2026-06-27-v3-phase-c1-c2-orchestration.md)、[C3](2026-06-27-v3-phase-c3-parallel-isolation.md)、[C-Durable](2026-06-27-v3-phase-c-durable-orchestration-recovery.md)、[CHANGELOG](../../CHANGELOG.md)

## 目标

把 orchestrator 的「规划一次→派发一次」一般化为确定性回合循环（失败重规划 + 长任务持续派发），并支持同进程编排级续跑：回合中主区 worker 命中审批暂停 → 保存编排状态 → `approve` 后从原状态续跑，不重 plan、不重复派发。

## 结果

`orchestrator.run` 跑回合循环：`plan → dispatch → replan({completed,failed}) → decideContinue 终止闸 → 下一轮`，由程序逻辑控回合数/终止/预算，`replan` 只产结构化下一批。暂停只发生在串行主区 worker；`dispatch-loop` 暂停时返回 `resume`，orchestrator 存内存 `orchPaused`（键=approvalId），`kernel.agent.approve` 路由到 `orchestrator.resume` 续跑。`agent-runtime.js` 一行不改。

Shared interfaces：

```text
// subtask-schema.js
validateReplan(subtasks, { seenSubtaskIds, completedIds, failedIds })
  -> { ok, error? }
fingerprint(st) -> string
  // normalize(goal + sorted(context_scope.files) + tool_profile)

// planner.js  (createPlanner now returns { plan, replan })
replan({ message, done_when, completed, failed }) -> { done:boolean, subtasks:SubTask[] }
  // completed/failed = [{ id, goal, note }] summaries

// dispatch-loop.js
runDispatchLoop(deps)
  -> { status:"complete"|"awaiting_approval", content?, collected:Entry[],
       resume?:RoundResume, stopped_reason? }
RoundResume = { pausedWorker, pausedApprovalId, pausedSubtask, remaining:SubTask[], deps }
resumeDispatchLoop(roundResume, decision)
  -> { status, collected:Entry[], resume?:RoundResume }
Entry = { st, status:"complete"|"failed", wres?, verdict?, change_id?, lastFeedback? }

// synthesizer.js
classifyOutcome(collected, { stoppedByCap:boolean })
  -> "complete" | "partial" | "incomplete"

// orchestrator.js
createOrchestrator({ ..., planner, maxRounds })
  -> { run, resume(id, decision), hasPaused(id) }
```

配置 `orchestration.maxRounds`（默认 2）。事件 `orchestration:replanned`（含 round / new_subtasks）。

## 关键决策 / 遗留约束

- **`agent-runtime.js` 一行不改**：worker 暂停/恢复用其现成 `send`/`approve`，orchestrator 持 worker 实例引用续跑。
- **编排确定性**：回合数 / 终止 / 预算由 orchestrator 程序逻辑判；`replan` 只是被调的模型节点，产结构化下一批。
- **`maxRounds` = 总 dispatch 回合数**（初始轮计 1）；`maxRounds=1` 退化 C1+C2。
- **结算单一来源 `allCollected`**：暂停时本轮已结算项经 `result.collected` 进 `allCollected`；`roundResume` 不带 `roundCollected`；续跑只追加 paused + remaining 新项 → 绝无重复结算。
- **两套集合不混用**：`seenSubtaskIds`（id 跨轮唯一，供 `validateReplan`）/ `seenFp`（fingerprint，供无进展守卫）。`validateReplan` 拒 id 冲突、拒依赖 failed 除非 `corrective_for` 指向真实 failed id。
- **`done: true` 仅停派发，不代表成功**：最终状态恒由 `classifyOutcome` 依 `allCollected` 判（有 failed=partial；预算/轮数耗尽未尽=incomplete；否则 complete）。
- **多次暂停-恢复是常态**：每次 `resume` 消费旧 `orchPaused` 条目、可能以新 approvalId 产生新条目。
- **暂停点只在串行主区 worker**：并行 iso worker 仍 `autonomy: "auto"`（C3 不变）；merge 不走审批门。
- **默认零回归**：`maxRounds=1` 或 `planner` 无 `replan` 或 `replan` 首轮 `done` → 第 1 轮后停 == C1+C2；现有 618 全绿。
- 跨进程 durable 续跑见 C-Durable；同进程续跑到此完整。

## 验证

`tests/core/orchestration/replan-schema.test.js`（validateReplan 拒 id 冲突、拒 failed 依赖除非 corrective_for、fingerprint 归一）、dispatch-resume 单测（不重复结算 + remaining 续派）、orchestrator-resume（plan 调用=1、无重复派发、多次暂停链）、`c5-rounds-e2e.test.js`。当时基线 618 全绿。当前入口 `src/core/orchestration/{subtask-schema,planner,dispatch-loop,orchestrator,synthesizer}.js`、`src/index.js` 的 approve 路由（`orchestrator.hasPaused(id) ? orchestrator.resume : runtime.approve`）。

## 任务覆盖（as-built 映射）

| 里程碑 | 内容 |
|--------|------|
| M1 | validateReplan + fingerprint |
| M2 | planner.replan |
| M3 | maxRounds 配置 |
| M4 | dispatch 暂停/续跑 |
| M5 | orchestrator 回合循环 + gateAndReplan |
| M6 | orchestrator.resume |
| M7 | approve 路由 + classifyOutcome + e2e |
| M8 | 回归 + 文档 |

最大风险是 Task 4（dispatch 暂停/续跑）+ Task 6（orchestrator 续跑驱动）。判据明确：dispatch-resume 单测断言不重复结算 + remaining 续派；orchestrator-resume 断言 plan 调用=1 + 无重复派发 + 多次链。`maxRounds=1` / 无 replan 永远是零回归逃生口；`agent-runtime` 全程不改。
