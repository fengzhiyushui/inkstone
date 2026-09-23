# V3 Phase C1+C2 多智能体编排 Implementation Plan

- 类型：实施计划
- 日期：2026-06-27
- 状态：已完成
- 关联：[C3 parallel](2026-06-27-v3-phase-c3-parallel-isolation.md)、[C5 replan](2026-06-27-v3-phase-c5-replan-resume.md)、[C-Router](2026-06-27-v3-phase-c-router-tiered.md)、[CHANGELOG](../../CHANGELOG.md)

## 目标

把「单 agent」与「多 agent」合并为一条路：`kernel.send()` 经确定性路由器分流，简单任务走今天的 `agentRuntime.send()`（零回归），复杂任务走 Orchestrator（Planner 拆 → 串行 Worker 执行 → 两级审核 → 汇总），Worker/Reviewer 复用 `agent-runtime` 实例。

## 结果

在 `agent-runtime` 公开边界 `send()` 之上组合 `src/core/orchestration/` 层。Orchestrator 持有 Planner + 确定性派发循环，用注入的 `createRuntime` 工厂造 Worker（工具子集 `edit`）与 Reviewer（工具子集 `readonly`）。编排由程序逻辑读结构化结果（`wres.status` / `verdict.pass`）决策；模型只在 planner/worker/reviewer/synth 节点内被调。`agent-runtime.js` 一行不改。

Shared interfaces：

```text
// subtask-schema.js
validatePlan(obj)     -> { ok, plan?, error? }
validateVerdict(obj)  -> { ok, verdict?, error? }
topoOrder(subtasks)   -> SubTask[]            // 抛 { code:"CYCLE" } 若有环
hasCycle(subtasks)    -> boolean
SubTask  = { id, goal, acceptance:string[], context_scope:{files?,symbols?},
             tool_profile:"edit"|"readonly", depends_on:string[] }
Plan     = { task_summary, subtasks:SubTask[], done_when }
Verdict  = { pass:boolean, severity:"block"|"warn", reasons:string[], checked:string[] }

// task-router.js
createTaskRouter({ minComplexFiles, markers }) -> { route(message, options) -> RoutingDecision }
RoutingDecision = { lane:"single"|"orchestrate", reason, signals:string[], classification }

// tool-profiles.js
TOOL_PROFILES = { readonly:Set<string>, edit:Set<string> }
filterToolSchemas(schemas, profile) -> schemas[]   // 按 .function.name 过滤

// worker-factory.js
createWorkerFactory({ createRuntime, baseToolSchemas, makeContextSnapshot })
  -> { worker(subtask)->runtime, reviewerRuntime()->runtime }

// reviewer.js
createReviewer({ runtime }) -> { review(subtask, workerResult) -> Verdict }

// planner.js
createPlanner({ callModel, maxPlanRepairs }) -> { plan({ message, context }) -> Plan }

// synthesizer.js
createSynthesizer({ callModel }) -> { synthesize({ message, collected }) -> string }

// dispatch-loop.js
runDispatchLoop({ plan, workerFactory, makeReviewer, synthesizer, budget,
                  maxWorkerAttempts, autonomy, onEvent })
  -> { status:"complete"|"awaiting_approval", content?, approval?, collected }

// orchestrator.js
createOrchestrator({ planner, makeWorkerFactory, makeReviewer, synthesizer,
                     makeBudget, config, eventBus, makeContext })
  -> { run({ message, options, routing }) -> { status, content, turn?, collected } }
```

配置 `orchestration.maxSubtasks`（默认 8）、`maxWorkerAttempts`（默认 2）、`router.minComplexFiles`（默认 2）、`router.markers`（中英复杂标记）。

## 关键决策 / 遗留约束

- **`agent-runtime.js` 一行不改**：Worker/Reviewer 都是它的实例，只在公开边界 `send(message, options) → { status, content, turn, verification }` 之上组合。
- **编排确定性**：派/收/打回由程序逻辑读结构化结果（`wres.status`、`verdict.pass`），模型只在 planner/worker/reviewer/synth 节点内被调，不负责「派谁、要不要再来一轮」。
- **路由器确定性启发式**：无模型调用、无 on/off 开关；默认 `single`，够强信号才 `orchestrate`；阈值可配。C-Router 后续升级为分层（含模型档）。
- **Reviewer 恒 `readonly`**：工具子集物理排除一切 write/edit/git/shell，审核者不可改。
- **成本闸常开**：`maxSubtasks` / `maxWorkerAttempts` / 聚合预算命中 → 优雅停止 + 部分完成诚实收尾，不抛、不崩（沿用 V2-20b 语义）。
- **默认行为零回归**：简单档 = 今天的 `runtime.send()` 原样；`single` 档不发任何 orchestration 事件；现有 559 测试全绿。
- dispatch-loop 用注入工厂 → 纯 mock 可测、不打真模型。
- 审批可从 worker 上浮为 `awaiting_approval` 返回。
- 后续 C3 加并行写隔离，C5 加回合循环与续跑，C-Router 加分层路由，C4 加经验记忆，C-Durable 加跨进程恢复。

## 验证

`tests/core/orchestration/` 下 subtask-schema（validatePlan/validateVerdict/topoOrder/hasCycle）、task-router、tool-profiles（filterToolSchemas）、worker-factory、reviewer、planner（含 maxPlanRepairs）、synthesizer、dispatch-loop、orchestrator、kernel-routing-e2e（single 快车道零 orchestration 事件、orchestrate 链路启动）。当时基线 559 全绿 + 新增。当前入口 `src/core/orchestration/*`、`src/index.js` 的 `kernel.send` 路由、`src/config.js` 的 `orchestration`。

## 任务覆盖（as-built 映射）

| 里程碑 | 内容 |
|--------|------|
| M1 | subtask-schema + 路由器 + 配置 |
| M2 | tool-profiles + worker-factory |
| M3 | reviewer + planner + synthesizer |
| M4 | dispatch-loop |
| M5 | orchestrator 组合 |
| M6 | 回归 + 配置接线 + 文档 |

file structure：`src/core/orchestration/{subtask-schema,task-router,tool-profiles,worker-factory,reviewer,planner,synthesizer,dispatch-loop,orchestrator}.js`，测试在 `tests/core/orchestration/`。`package.json` check 脚本追加 orchestration 段。

最大风险是 index.js 重构（收 `runtimeConfig` + 改 facade）；判据是现有 559 全绿 + e2e。`single` 档直接 `runtime.send` → 零回归路径清晰。`createAgentRuntime` 一行不改贯穿全程。后续 C3/C5/C-Router/C4/C-Durable 均在此层之上叠加，不回头改 agent-runtime。
