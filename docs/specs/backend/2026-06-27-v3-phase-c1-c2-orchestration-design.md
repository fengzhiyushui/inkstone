# DeepSeek Code V3 Phase C1+C2 · 多智能体编排(统一入口 + 两级审核)设计

> 类型:后端设计 spec(backend)
> 日期:2026-06-27
> 状态:已评审,待转实施计划
> 关联:[V3 路线图](../architecture/2026-06-24-v3-roadmap-design.md) §7 · [Agent 分层记忆系统](2026-06-24-agent-layered-memory-design.md)(C4,本片不做)· [Phase B 语义级上下文](2026-06-26-v3-phase-b-semantic-context-design.md)

---

## 1. 背景与目标

**现状**:`src/core/runtime/agent-runtime.js` 是单 agent、单轮执行引擎(分类 → 工具循环 → 自审 → 修复 → 答复),全依赖注入,已被 559 个测试覆盖审批/暂停/恢复/验证修复等硬骨头正确性。

**目标(本片 = Phase C 的 C1+C2)**:把「单 agent」与「多 agent」**合并为一条路** —— 唯一入口 `kernel.send()`,由**路由器**按复杂度判断走哪档:简单任务走快车道(== 今天的单 agent,行为不变),复杂任务走 **Orchestrator** 编排(Planner 拆任务 → 串行 Worker 执行 → **两级审核** → 汇总)。Worker / Reviewer **就是 `agent-runtime` 实例**(注入不同工具子集 + 作用域上下文),编排层在其**公开边界 `send()` 之上**组合,`agent-runtime` 内部**一行不改**。

**MVP 立场**:先落地能跑的最小闭环,不行再迭代。范围严格收在 C1+C2,把 worktree 并行、经验记忆、自主重规划、编排级 durable 恢复都显式留给后续片。

---

## 2. 范围与非目标

**本片做(C1+C2)**:
- ✅ 统一入口 + 确定性路由器(升级 `classifier`,启发式、无额外模型调用)。
- ✅ Orchestrator:持有 Planner、跑确定性派发循环、创建 Worker/Reviewer 实例、汇总最终答复。
- ✅ Planner:模型(thinking)产出结构化计划,schema 校验 + 失败重试。
- ✅ Worker:`agent-runtime` 实例,工具子集 + 作用域上下文,串行执行,自带子自审(关卡1)。
- ✅ Reviewer:`agent-runtime` 实例,只读工具,独立复查(关卡2),出结构化裁决。
- ✅ 成本闸常开(`maxSubtasks` / `maxWorkerAttempts` / 聚合预算)+ 命中即「部分完成」诚实收尾。
- ✅ 子代理事件嵌进现有会话时间线(父 Orchestrator turn ⊃ 子 Worker/Reviewer run)。

**本片不做(留后续片)**:
- ❌ **C3** 并行 Worker 的 worktree 写隔离与合并(本片 Worker **串行**)。
- ❌ **C4** 跨任务经验记忆(巩固器 / 三级分化 / `crossTaskLearning` 开关)—— 已有独立 spec。
- ❌ **C5** Reviewer 打回触发 Orchestrator **重新规划**(改拆法)/ 长任务持续派发循环 —— 本片打回只做**有界重试**。
- ❌ 编排级 **durable 恢复**(崩溃后从第 k 个子任务续跑)—— 本片只让单个 Worker 的审批暂停**上浮**(§11)。
- ❌ 模型驱动的路由(本片路由器纯启发式、确定性)。

---

## 3. 统一入口与路由

```
用户消息 → kernel.send(message, options)        唯一入口,签名不变
   ↓
task-router(升级 classifier:复杂度 + 风险,确定性启发式)
   ├─ lane="single"   → agentRuntime.send(...)    今天的代码原样,零回归
   └─ lane="orchestrate" → orchestrator.run(...)  新编排
```

- **「单 agent」不再是用户可选模式**;用户永远只 `send()`,系统决定。它以两种身份存活:**简单档处理器**(快车道直接复用现有 `agent-runtime`)+ **复杂档 Worker 的引擎**。
- **路由器无 on/off 开关**(产品决策:路由全权判)。安全网换成两道**常开**机制:① 路由器**保守**(高精度判 complex,默认 single);② 成本闸常开(§9)。
- **路由器是确定性启发式**,不加模型调用 —— 快车道在简单查询前不付额外延迟/成本,且路由决策可单测、可复现。

**RoutingDecision**:`{ lane: "single" | "orchestrate", reason: string, signals: string[] }`。

**初始复杂度信号(保守,阈值可配)**:
- 显式多重性标记:`这几个 / 分别 / 各自 / 逐个 / for each / 跨多个文件 / 重构整个 / 迁移`。
- `task_type === "edit"` 且语义上下文(Phase B,启用时)显示目标跨 **≥ `minComplexFiles`** 个文件/模块。
- 用户显式请求规划(`先规划 / 分步 / plan`)。
- 默认 `single`;仅当命中强信号才 `orchestrate`。所有阈值进 `config.orchestration.router`(配置哲学:给用户旋钮,不锁死)。

---

## 4. 组件(新增于 `src/core/orchestration/`)

| 单元 | 职责 | 依赖 |
|---|---|---|
| `task-router.js`(新文件,内部用 `planning/classifier.js`) | 启发式判 `single \| orchestrate`(+ 风险);产出 `RoutingDecision` | — |
| `orchestrator.js` | 复杂任务总控:调 Planner、跑派发循环、建 Worker/Reviewer、调 Synthesizer;读结构化结果做确定性决策 | 全部下列 |
| `planner.js` | 模型 thinking → `Plan`(结构化子任务),schema 校验 + 重试 | `modelGateway` |
| `subtask-schema.js` | `Plan` / `SubTask` / `Verdict` 的 schema 定义与校验 | — |
| `worker-factory.js` | 按 `SubTask` 建一个 Worker `agent-runtime`(工具子集 + 作用域上下文 + 聚合预算份额) | `createAgentRuntime` |
| `reviewer.js` | 建只读 Reviewer `agent-runtime`,独立复查 Worker 产出 → `Verdict` | `createAgentRuntime` |
| `tool-profiles.js` | 工具子集定义(`edit` / `readonly`),从现有 registry 过滤 | `tools/registry` |
| `synthesizer.js` | 汇总子任务产出 + 审核摘要 → 最终答复(含失败诚实汇报) | `modelGateway` |
| `dispatch-loop.js` | 确定性派发循环(§6),纯程序逻辑,接收注入的 worker/reviewer 工厂(可测) | — |

**铁律**:`agent-runtime` 不改;编排 = 程序逻辑读结构化结果,模型只在 planner / worker / reviewer / synth **节点内**被调用,不负责「派谁、要不要再来一轮」。

---

## 5. Planner 与子任务 schema

**Planner**:输入用户消息 + 路由决策 + 任务级语义上下文(Phase B,作用域=整任务);模型(thinking,走现有 `model-router` 的 `plan` 用途)产出结构化 `Plan`;**schema 校验失败 → 有界重试**(复用 `deepseek/tool-call-repair.js` 的回灌纠正思路,`maxPlanRepairs`)。

```text
SubTask {
  id: string,                       // "st_1"
  goal: string,                     // 这个 Worker 要达成什么
  acceptance: string[],             // 验收标准(Reviewer 据此独立审)
  context_scope: { files?: string[], symbols?: string[] },  // 作用域上下文(喂 Worker)
  tool_profile: "edit" | "readonly",                        // 工具子集
  depends_on: string[]              // 串行序;本片靠它定 topo 顺序(并行留 C3)
}
Plan { task_summary: string, subtasks: SubTask[], done_when: string }
```

- `depends_on` 在本片只用于**拓扑排序定串行顺序**;并行执行留 C3。环检测失败 → 计划无效 → 重试/降级。
- 计划重试仍失败 → **降级**:把整个用户任务当**单个 `edit` 子任务**交给一个 Worker(即退回近似单 agent),不崩。

---

## 6. 确定性派发循环

```text
plan = await planner(task, routing, context)            // 失败重试→降级单子任务
collected = []
for st in topoOrder(plan.subtasks):                     // 串行(本片)
   priorFeedback = null
   for attempt in 1..maxWorkerAttempts:
      worker  = workerFactory(st)                        // 工具子集 + 作用域上下文 + 预算份额
      wres    = await worker.send(workerPrompt(st, priorFeedback), { autonomy })
      if wres.status == "awaiting_approval": return surfaceApproval(wres)   // §11 上浮
      if wres.status == "stopped": return partialComplete(collected, "budget")
      if wres.status != "complete": priorFeedback = selfAuditFeedback(wres); continue  // 关卡1 没过→带反馈重试
      verdict = await reviewer.review(st, wres)          // 关卡2 独立复查(只读)
      if verdict.pass: collected.push({ st, wres, verdict }); break
      priorFeedback = verdict.reasons                    // 打回→带根因重试
   else:
      collected.push({ st, status: "failed", lastFeedback: priorFeedback })  // 重试耗尽→诚实标失败
   if budgetExceeded(): return partialComplete(collected, "budget")
final = await synthesizer(task, collected)              // 汇总(含失败诚实汇报)
return { status: "complete", content: final, collected }
```

- **确定性**:派几个、收谁、打回谁、是否再来一轮 = 程序逻辑读 `wres.status` / `verdict.pass`,不甩给模型即兴 → 可测、可重放。
- **不带病提交**:Worker 自审(关卡1)没过先自我修复(其内置 `verifyAndMaybeRepair`),仍不过则诚实上报、不进 collect 为成功。
- `dispatch-loop.js` 接收**注入的** `workerFactory` / `reviewer` / `synthesizer` / `budget`,因此可用 mock 完整单测(不打真模型)。

---

## 7. 两级审核(roadmap §7.2)

- **关卡1 · 子自审(局部,便宜)**:Worker 内置的 `verifyAndMaybeRepair` + `runRepairLoop`(已有)—— 跑测试 + 对照子任务隐含验收,有界自修复。**免费复用,无新代码**。
- **关卡2 · Reviewer 独立审核(全局,贵)**:独立 `agent-runtime` 实例,**只读工具**(read / ls / grep / glob / test),拿到 Worker 的产出摘要 + 改动(change ids / diff)+ `st.acceptance`,**独立对抗式复查**(可自己跑 test / grep 取证),产出:

```text
Verdict { pass: boolean, severity: "block" | "warn", reasons: string[], checked: string[] }
```

- 确定性 gate 读 `verdict.pass`:通过 → 收;否决 → 带 `reasons` 打回重试(有界)。
- **Reviewer 必须独立**:不因「Worker 说自审过了」就放行(否则两级塌一级)。Reviewer 无写工具 → 物理上不可能「帮忙改」。
- Reviewer 的 `Verdict` 也走 schema 校验 + 有界重试;校验不出 → 保守判 `pass:false, severity:"warn"`(不阻断但记审核未决)。

---

## 8. 上下文作用域与工具子集

- **作用域上下文**:Worker 经现有 `createContextSnapshot` 注入点拿上下文,但带 `scope` 提示(`st.context_scope` 的 files/symbols),启用 Phase B 语义时**偏置/限定**到子任务范围;Planner/Synthesizer 拿任务级(更宽)上下文;Reviewer 拿「Worker 改动 + 验收标准 + 只读取证能力」。
- **工具子集**(`tool-profiles.js` 从现有 registry 过滤):
  - `edit`:read · ls · grep · glob · edit · test · git(常规编码子集)。
  - `readonly`:read · ls · grep · glob · test(无 edit/write)。
  - Reviewer 恒 `readonly`,且永不给 edit/write/git-write —— 物理隔离「审核者不可改」。
- 经由 `createAgentRuntime` 的 `toolSchemas` / `executeTool` DI 注入,不改 runtime。

---

## 9. 成本闸与优雅停止(常开,替代 opt-in 闸)

- **聚合预算**:复用 `core/runtime/cost-budget.js`,在 Orchestrator 建**一个聚合预算**,planner / 每个 Worker(含子自审重试)/ 每个 Reviewer / synth 的 token 与模型调用**全部计入**;Worker/Reviewer 实例创建时分得预算视图。
- **闸值**(`config.orchestration`):`maxSubtasks`、`maxWorkerAttempts`、`budget.maxTokens`、`budget.maxModelCalls`。
- **命中即优雅停止**:返回 `status:"complete"` + 诚实「部分完成」汇总(已完成哪些子任务、哪些未做/失败、为何停),**不抛、不崩**(沿用 V2-20b 优雅停止语义)。
- 默认值给安全起点、可配(配置哲学);**无 on/off 总开关**。

---

## 10. 事件与时间线嵌套

- 新事件**仅在 `orchestrate` 档触发**(`single` 档事件与今天逐字节一致):
  - `orchestration:routed` —— `{ lane, reason, signals }`
  - `orchestration:planned` —— `{ subtasks, done_when }`
  - `orchestration:subtask_started` —— `{ subtask_id, attempt, tool_profile }`
  - `orchestration:subtask_reviewed` —— `{ subtask_id, pass, severity }`
  - `orchestration:completed` —— `{ completed, failed, stopped_reason? }`
- **嵌套**:父 = Orchestrator turn;子 Worker/Reviewer run 用 turn/branch 模型挂在父 turn 下(roadmap §7.4「子代理事件嵌套进现有会话时间线」)。每个子 runtime 给一个派生 `sessionId` + 指向父 turn 的链接字段,使 GUI(Phase D 的 D-G2 泳道)能原生渲染主/子层级。

---

## 11. 持久化与恢复(MVP 边界)

- Worker/Reviewer 是真 `agent-runtime` 实例 → **个体**的审批暂停/恢复、编辑事务日志、change-store 回滚**天然可用**(已有)。
- **审批上浮**:Worker 在 `orchestrate` 档命中需审批的工具时返回 `awaiting_approval`;Orchestrator **暂停整个编排并上浮该审批**(复用现有 paused-turn 机制,审批记录附带 orchestration 上下文标记)。`approve()` 后续跑该 Worker、编排继续。
- **延后(非目标)**:编排级 durable 恢复(崩溃后从第 k 个子任务续跑)——本片**不持久化编排进度**;崩溃则该次编排丢进度(但各 Worker 已落的 change/journal 仍在、可单独回滚)。留作后续片(复用 Phase A 恢复设施扩展)。

---

## 12. 配置

```text
config.orchestration = {
  router: { minComplexFiles: 2, markers: [...默认中英文多重性词...] },  // 复杂度阈值,可配
  maxSubtasks: 8,
  maxWorkerAttempts: 2,
  budget: { maxTokens: <安全起点>, maxModelCalls: <安全起点> }          // 聚合,常开
}
```

- 归一化进 `src/config.js`(沿用 `normalizeContext` / `normalizeLimits` 的 per-field 深合并 + 安全默认)。
- **无 `enabled` 开关**:路由全权判;`router` 阈值是「多保守」的旋钮,不是 on/off。

---

## 13. 测试策略(node:test,确定性优先)

- **router**:代表性消息 → 断言 `single | orchestrate` 决策;现有单 agent 场景须判 `single`(保回归)。
- **planner**:mock 模型 → 合法/畸形计划;schema 校验、重试、环检测、降级单子任务。
- **dispatch-loop**:注入 mock worker/reviewer/synth → 断言拓扑顺序、关卡1 失败重试、Reviewer 打回重试、`maxWorkerAttempts` 有界、预算命中→部分完成、失败子任务诚实标记。**纯确定性,不打真模型**。
- **reviewer 独立性**:Worker 自审 `complete` 时 Reviewer **仍运行**;Reviewer 无写工具(断言工具子集)。
- **两级审核 e2e**:mock 复杂任务 → plan → workers → review → synth,断言最终汇总含失败诚实汇报。
- **审批上浮**:Worker `awaiting_approval` → Orchestrator 上浮;`approve` 后继续。
- **回归**:现有 559 测试全绿(引擎不改);`kernel.send()` 简单档与今天逐字节一致(快车道未绕编排)。
- **成本闸**:聚合预算命中 → 优雅停止 + 部分完成,不抛。

---

## 14. 文件结构(新增,不改 `agent-runtime.js`)

```text
src/core/orchestration/
  task-router.js        新文件;内部用现有 classifier 拿 task_type,叠加复杂度层;classifier 不改
  orchestrator.js
  planner.js
  subtask-schema.js
  worker-factory.js
  reviewer.js
  tool-profiles.js
  synthesizer.js
  dispatch-loop.js
src/index.js            kernel.send() 接 router:single→agentRuntime.send / orchestrate→orchestrator.run
src/config.js           + normalizeOrchestration
```

---

## 15. 里程碑(供拆实施计划)

```text
M1  subtask-schema + task-router(启发式 + RoutingDecision)+ 单测;kernel 仍只走 single(router 旁路验证)
M2  tool-profiles + worker-factory + reviewer(只读)+ 各自单测(mock runtime)
M3  planner(模型→Plan,schema 校验+重试+降级)+ 单测(mock 模型)
M4  dispatch-loop(确定性循环,注入 worker/reviewer/synth)+ synthesizer + 成本闸 + 纯逻辑单测
M5  orchestrator 组装 + kernel.send 接 router(single 快车道走今天路径,orchestrate 走编排)+ 事件嵌套 + 审批上浮 + e2e
M6  回归(559 全绿)+ 文档(README 中英「自动多 agent 编排」、CHANGELOG、project-overview 新章)
```

> M1–M4 全可 mock、不打真模型 → 确定性、便宜;M5 才组装真链路;M6 收口。严格分段降风险。

---

## 16. 非目标(重申)与开放问题

**非目标**:C3 并行写隔离 · C4 经验记忆 · C5 重规划/持续派发 · 编排级 durable 恢复 · 模型驱动路由。

**开放问题(实施前/中再定)**:
- 聚合预算默认值(token / 调用数)——随实测调,给安全起点。
- 路由复杂度信号的初始词表与 `minComplexFiles` 默认(保守起步)。
- Worker 失败 / Reviewer 否决的反馈如何写进下一次 `workerPrompt`(措辞模板,迭代)。
- Synthesizer 对「部分失败」的汇报格式(结构化 vs 叙述)。
