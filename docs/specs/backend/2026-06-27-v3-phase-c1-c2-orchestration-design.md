# Phase C1+C2 · 多智能体编排（统一入口 + 两级审核）

- 类型：后端 spec
- 日期：2026-06-27
- 状态：已实现
- 关联：[V3 路线图](../architecture/2026-06-24-v3-roadmap-design.md) · [C-Router](2026-06-27-v3-phase-c-router-tiered-design.md) · [C3 并行隔离](2026-06-27-v3-phase-c3-parallel-isolation-design.md) · [C4 经验记忆](2026-06-27-v3-phase-c4-experience-memory-design.md) · [C5 重规划](2026-06-27-v3-phase-c5-replan-resume-design.md)

---

## 问题与目标

`agent-runtime` 是单 agent 单轮引擎。C1+C2 把单/多 agent 合并成唯一入口 `kernel.send()`：简单任务走现有快车道，复杂任务由 Orchestrator 拆解、Worker 执行、两级审核、汇总。Worker / Reviewer 就是 `agent-runtime` 实例，`agent-runtime` 内部不改。

## 决策

| 决策点 | 选择 | 否决项 | 理由 |
|---|---|---|---|
| 入口 | 唯一 `kernel.send()` + 路由 | 用户选模式 | 系统判档，快车道零回归 |
| 路由 | 确定性启发式（后由 C-Router 扩展） | 每请求问模型 | 热路径零延迟、可测 |
| 角色 | Worker/Reviewer = runtime 实例 | 新引擎 | 复用审批/验证/修复 |
| 审核 | 子自审 + Reviewer 独立审 | 单级 | 便宜过滤 + 纵深防御 |
| 派发 | 程序逻辑读结构化结果 | 模型即兴决定 | 可测可重放 |
| 失败 | 有界重试后诚实标失败 | 无限打回 | 成本可控 |

## 设计

### 路由与入口

```
kernel.send(message)
  → task-router → lane=single → agentRuntime.send（今天路径）
               → lane=orchestrate → orchestrator.run
```

`RoutingDecision`: `{ lane, reason, signals }`。复杂度信号（可配）：多重性标记（这几个/分别/for each/迁移…）、跨多文件、显式要规划。默认 single，命中强信号才 orchestrate。后续由 [C-Router](2026-06-27-v3-phase-c-router-tiered-design.md) 加模型辅助档。

### 组件（`src/core/orchestration/`）

`task-router.js`、`orchestrator.js`、`planner.js`、`subtask-schema.js`、`worker-factory.js`、`reviewer.js`、`tool-profiles.js`、`synthesizer.js`、`dispatch-loop.js`。

Planner（thinking）产出 `Plan`：

```text
SubTask { id, goal, acceptance[], context_scope{files,symbols}, tool_profile: edit|readonly, depends_on[] }
Plan { task_summary, subtasks[], done_when }
```

schema 校验失败有界重试；仍失败降级为单个 edit 子任务。

### 派发循环

拓扑序串行执行（并行见 C3）。每个子任务：Worker `send` → 自审不过带反馈重试 → Reviewer 出 `Verdict { pass, severity, reasons[], checked[] }` → 通过收集 / 否决打回（有界）→ 耗尽标失败。预算超限则「部分完成」诚实收尾。

### 两级审核

关卡 1 子自审复用 `verifyAndMaybeRepair` / `runRepairLoop`。关卡 2 Reviewer 只读工具独立复查，不因 Worker 自审通过就放行；无写工具。Verdict schema 校验失败则保守 `pass:false, severity:"warn"`。

### 工具子集与上下文

`tool-profiles.js`：`edit` = read/ls/grep/glob/edit/test/git；`readonly` = read/ls/grep/glob/test。Reviewer 恒 readonly。Worker 用 `st.context_scope` 偏置上下文。

### 成本闸与事件

聚合 `createCostBudget`，`maxSubtasks`（默认 8）、`maxWorkerAttempts`（默认 2）、`budget.maxTokens/maxModelCalls` 常开。命中即部分完成，不抛。

事件（仅 orchestrate 档）：`orchestration:routed` / `planned` / `subtask_started` / `subtask_reviewed` / `completed`。子 run 嵌在父 turn 时间线下。

### 持久化边界

Worker 个体审批/事务天然可用。审批上浮到编排层暂停。编排级 durable 恢复不在本片（见 C 路持久化 spec）。

## 边界与不变量

1. `agent-runtime.js` 不改。
2. 派发/打回/再派是程序逻辑。
3. 默认 simple 档零新事件、与今天一致。
4. 本片不做并行写隔离、经验记忆、重规划、编排级崩溃续跑。

## 与现状的差异

配置键见 `src/config.js` 的 `orchestration.*`。C3 起 `dispatch-loop` 支持批次并行。事件名以 `SESSION_EVENT_TYPES` 与 eventBus 实际为准。

## 验收

router 对既有单 agent 场景判 single；planner 校验/重试/降级可测；dispatch-loop mock 可单测；Reviewer 独立且只读；审批上浮；成本闸部分完成；既有测试全绿。入口 `npm test`。
