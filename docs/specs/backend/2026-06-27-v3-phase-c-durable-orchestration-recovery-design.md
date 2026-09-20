# DeepSeek Code V3 Phase C-Durable · 跨进程编排级 durable 恢复设计

> 类型:后端设计 spec(backend)
> 日期:2026-06-27
> 状态:已实施(见 [实施计划](../../plans/backend/2026-06-27-v3-phase-c-durable-orchestration-recovery.md),M0–M8 TDD;含 review 5 边界 + M0 契约层)
> 关联:[C5 同进程续跑](2026-06-27-v3-phase-c5-replan-resume-design.md) · [V2-18 持久化恢复](2026-06-01-v2-18-durable-recovery-resume-hardening-design.md) · [C1+C2 编排](2026-06-27-v3-phase-c1-c2-orchestration-design.md)

---

## 1. 背景与范围

C5 实现了**同进程**编排级续跑:回合中串行主区 worker 命中审批暂停 → 存内存 `orchPaused`(编排状态 + **活的 worker 实例引用** + 闭包)→ `kernel.agent.approve` 路由 `orchestrator.resume` → 续跑。**进程退出 → 内存丢失 → 无法恢复。**

**本片目标**:**跨进程** —— 崩溃/重启后,从暂停的编排状态续跑。用户选 **Option B「完整 worker turn 重水化」**:重启后精确重水化被暂停的 worker turn,审批落到其原在途工具调用,而非重派整个 subtask。

**延续约束**:`agent-runtime.js` **一行不改**;**opt-in**(`recovery.enabled`,默认关)→ 默认零回归(关闭时 C5 同进程续跑不变);编排确定性。

---

## 2. 根本难题 + 三个化解它的关键事实

**难题**:`orchPaused` 含**活的 worker 实例引用 + 闭包**,无法序列化落盘。

**化解(基于真实代码勘察)**:
1. **worker 暂停 turn 今天就已落盘**(recovery 开启时):`createRuntime = createAgentRuntime({ ...runtimeConfig, ...overrides })`,而 `runtimeConfig` 已含 `pausedTurnPersistence`([index.js:141](../../../src/index.js#L141))→ worker runtime 继承它 → worker 命中审批,`savePausedRecord` 已把 turn 的 `resume_state`(含 `pending_tool_call`)写 sidecar。**⇒ 不需要新建 worker turn 持久化,`agent-runtime` 本就支持(经注入依赖)。**
2. **暂停点 = 写操作前的审批门**:串行主区 worker 在 `diff_apply` 等写工具执行**前**暂停 → 暂停时该 subtask **尚未落任何写**,已完成 subtask 早已合并提交。⇒ 重水化后续跑 = 审批落到那个**待执行**的写工具调用(`pending_tool_call`),无半成品要修复。
3. **worker 可由 subtask **确定性重建**:`worker-factory.worker(subtask)` 的工具子集 + 作用域上下文**全从 `subtask` 推出**([worker-factory.js:4](../../../src/core/orchestration/worker-factory.js#L4))。⇒ 重启后,给定持久化的 `subtask`,可重建**字节等价**的 worker runtime。

**⇒ 缺的三块**:① 编排 wrapper 状态(可序列化)持久化为 sidecar;② 主+worker **共享** `pausedTurnStore`(当前各自独立,恢复的 worker 记录重建 worker 读不到);③ 重启后的 resume 路由:识别「编排暂停」approvalId → 重建 worker → 重水化其 turn → approve → 续编排回合。

---

## 3. 架构

### 3.1 暂停时(`recovery.enabled` 且编排回合中 worker 暂停)
两份落盘,**同 `approvalId` 关联**:
- **worker turn sidecar**(既有机制,无需改 agent-runtime):worker 的 `savePausedRecord` 已写 `paused/<approvalId>`,含 `resume_state.pending_tool_call`、`turn`、`permission_context`。**编排归属标记(边界①④)**:orchestrator 给 worker 的 send options 注入 `__orchestration: { approvalId, taskId }`(小、可序列化),随 `resume_state.options` 落盘 → 扫描时据此识别「这是编排 worker」(§3.2 孤儿判定 + §3.3 归属校验用)。
- **编排 sidecar**(新):`orchestration-paused/<approvalId>.json`。**只存白名单可序列化字段(边界②:不存 raw `options`)**:
  ```json
  {
    "schemaVersion": 1,
    "fingerprints": { "workerFactory", "toolSubset", "subtaskSchema" },   // 版本/指纹,不匹配→blocked(§5.8)
    "approvalId", "taskId", "sessionId",
    "message", "done_when", "plan", "round",
    "env": { "root", "orchestrationConfig" },          // 重注活对象的最小白名单,非 raw options
    "allCollected": [{ "st", "status", "wres": {"status","content"}, "lastFeedback" }],
    "seenSubtaskIds": [...], "seenFp": [...],
    "budget": { "quotaTokens", "quotaCalls", "spentTokens", "spentCalls" },  // 配额+已花,恢复续扣(§5.10)
    "adoptedExperienceIds": [...], "riskCues": [...],
    "pausedSubtask": { ... },          // 重建 worker 的依据(含其 schema version)
    "remaining": [ ...subtasks ]        // 本回合暂停点之后未派
  }
  ```
  (`Set`→数组;**绝无** raw `options` / worker 实例 / 闭包 / `eventBus` / 回调 / 权限上下文活对象 —— 活对象恢复时由 kernel **重注入**。)

### 3.2 重启时(`recoverOnStartup`)
`recovery-service` 扩展:除事务日志 + 单 agent paused sidecar,**新扫 `orchestration-paused/`**:
- 校验编排 sidecar + 其关联的 worker turn sidecar 都在且合法 + **版本/指纹匹配**(§5.8)→ 登记 inbox 项 `type: "orchestration_paused"`,`allowed_actions: ["resume","cancel"]`,evidence 含 `taskId`/`round`/已完成数。
- **孤儿判定(收紧,边界①)**:worker turn sidecar 带 `__orchestration` 标记但其编排 sidecar **缺失/损坏/版本不符** → **`blocked_recovery`**(**绝不**降级为单 agent resume —— 否则会执行那个 pending 写工具却无人 settle/merge/续编排,语义悬空);仅**无** `__orchestration` 标记的普通单 agent sidecar 才走既有单 agent resume。编排 sidecar 在、worker sidecar 缺/consumed/损坏 → 编排项同样 `blocked_recovery`(无可恢复 turn)。

### 3.3 续跑(`recovery.resume(id, decision)` 对编排项)
0. **校验门(边界③④,先于一切)**:`schemaVersion` + `fingerprints`(workerFactory/toolSubset/subtaskSchema)匹配当前代码,**且** 编排 sidecar 的 `approvalId`/`taskId`/`sessionId`/`pausedSubtask.id` 与 worker sidecar 的 `resume_state.options.__orchestration` + turn owner 类型一致。任一不符 → `blocked_recovery`,**不重建、不 approve**(防升级后重建出不等价 worker、防跨任务串记录/重放)。
1. 读编排 sidecar → 反序列化编排状态(数组→`Set`,`budget` 重建为「配额 − 已花」续扣,§5.10),**活对象(eventBus/工具平面/权限上下文)由 kernel 重注入**。
2. `worker-factory.worker(pausedSubtask)` **重建 worker runtime**(工具子集+作用域字节等价),**共享 `pausedTurnStore`**(§3.4)。
3. recovery 已把 worker turn sidecar `restore` 进**共享** store → 重建 worker `approve(approvalId, decision)` **重水化其 turn**,审批落到 `pending_tool_call`(deny → 标该 subtask 失败)。
4. 拿 worker 结果 → 结算该 subtask(经既有 settle/merge 路径)→ `resumeDispatchLoop` 续本回合 `remaining` → `driveFrom` 续后续回合(用反序列化的 `plan`/`round`/`allCollected`/两套 seen,**不重 plan**)。
5. 再次暂停 → 写新 `approvalId` 的两份 sidecar;完成 → 删本 `approvalId` 的编排 sidecar + worker sidecar 置 consumed。

### 3.4 共享 `pausedTurnStore`(关键接线)
当前主 runtime 与每个 worker 各持独立内存 `pausedTurnStore`(agent-runtime 默认),recovery 只 `restore` 进主 runtime。**改**:在 `runtimeConfig` 注入**单一共享** `pausedTurnStore`(经 `createAgentRuntime` 的 `pausedTurnStore` 配置位,**agent-runtime 不改**)→ 主 + 所有 worker + 重建 worker 共享。recovery `restore` 进共享 store → 重建 worker `approve` 可见。`approvalId` 全局唯一,记录不串。**仅 `recovery.enabled` 时注入共享 store**;关闭时维持各自独立(默认行为不变)。

---

## 4. 组件

| 单元 | 改动 |
|------|------|
| `src/core/recovery/orchestration-persistence.js` | **新**:`save(approvalId, state)` / `scan()` / `restore`/`consume(approvalId)` / `quarantine`(镜像 `paused-turn-persistence`,原子写 + 损坏隔离)|
| `orchestrator.js` | 暂停时(若注入 `orchPersistence`)序列化编排状态 `save`;新增 `resumeDurable(approvalId, decision, { rebuildWorker })`(§3.3);`serializeState`/`deserializeState`(Set↔数组、budget 计数)|
| `recovery-service.js` | `recoverOnStartup` 扫 `orchestration-paused`;`list`/`resume`/`cancel` 处理 `orchestration_paused` 项(resume 路由到编排 durable resume)|
| `worker-factory.js` | 暴露 `worker(subtask)` 已够(确定性重建);无需改逻辑 |
| `index.js` | `recovery.enabled` 时:注入**共享 `pausedTurnStore`** 进 `runtimeConfig`;给 orchestrator 注入 `orchPersistence` + 重建 worker 的 `worker-factory` 句柄;`recovery-service` 的 orchestration resume 接到 `orchestrator.resumeDurable`;`kernel.agent.approve` 对编排 durable id 也路由 |
| `subtask-schema.js` / 序列化 | 编排状态 schema 校验(反序列化时验完整性,损坏→blocked)|

`agent-runtime.js` **不改**(worker 暂停/重水化用其现成 `savePausedRecord`/`approve` + 注入的 `pausedTurnPersistence`/共享 `pausedTurnStore`)。

---

## 5. 硬约束(实施判据)
1. **`agent-runtime.js` 一行不改**;worker turn 持久化/重水化全靠既有注入依赖。
2. **opt-in 零回归**:`recovery.enabled=false`(默认)→ 不注入 `orchPersistence`/共享 store/不扫 orchestration-paused → **C5 同进程续跑逐字节不变**、现有 739 全绿。
3. **确定性**:重建 worker 由 `subtask` 确定;续跑回合逻辑复用 C5(不重 plan、不重复派发、结算单一来源 `allCollected`)。
4. **安全**:暂停=写前审批门 → 重水化只续**待执行**写工具调用,无半成品;`deny` → subtask 失败、主区不变;编排 sidecar 与 worker sidecar 任一损坏 → blocked 隔离、绝不带病自动续。
5. **幂等清理**:完成/取消 → 删编排 sidecar + worker sidecar 置 consumed;启动扫描 consumed/孤儿清理(沿用既有隔离机制)。
6. **崩溃窗口(收紧,边界①)**:两份 sidecar 非原子写,**编排 worker 的孤儿一律 blocked**:① worker sidecar 带 `__orchestration` 但编排 sidecar 缺/坏/版本不符 → **blocked**(绝不当单 agent 续——防执行 pending 写却无人 settle/续编排);② 编排 sidecar 在、worker sidecar 缺/坏 → blocked。**写序**:先写编排 sidecar、再触发 worker 暂停落盘(worker sidecar 后写),使「worker 在而编排缺」窗口最小;无论如何孤儿都 blocked,绝不带病续。
7. **不存 raw `options`(边界②)**:编排 sidecar 只存白名单(`env.root` / `orchestrationConfig` / budget 配额 / ids / 指纹);活对象(`eventBus` / 回调 / runtime 句柄 / 权限上下文)恢复时由 kernel **重注入**。worker sidecar 的 `resume_state.options` 仅含 orchestrator 注入的小集(`autonomy` / `projectRules` / `__orchestration`)。
8. **版本/指纹门(边界③)**:sidecar 存 `schemaVersion` + `fingerprints`(workerFactory / toolSubset / subtaskSchema);恢复前校验匹配当前代码,不匹配 → **blocked,不强行重建**(防升级后重建出不等价 worker)。
9. **approval 归属校验(边界④)**:共享 store 下,resume 前校验 `approvalId` / `taskId` / `sessionId` / `pausedSubtask.id` / turn owner 类型一致,防跨任务串记录 / 重放。
10. **预算续扣(边界⑤,定死)**:编排 sidecar 存**原配额 + 已花计数**;恢复后 `budget` 重建为「配额 − 已花」继续扣,**绝不重置**(防重启绕过预算)。

---

## 6. 里程碑(供拆实施计划;每 Task 末测试+提交)
```
M0  durable recovery contract(review 建议):sidecar schema(`schemaVersion`)+ 字段白名单(无 raw options)+ 版本/指纹(workerFactory/toolSubset/subtaskSchema)+ 孤儿降级=blocked 策略 + budget 续扣语义 + approval 归属校验规则 —— 纯契约/类型 + 校验函数(validate/serialize/deserialize/fingerprint/ownershipOk)+ 单测(往返等价 + 各拒绝路径:坏 schema/指纹不符/归属不符/缺字段)
M1  orchestration-persistence(save/scan/restore/consume/quarantine + 原子写 + 损坏隔离)+ 单测
M2  orchestrator serializeState/deserializeState(Set↔数组、budget 配额+已花、白名单 env、schema 校验、往返等价)+ 单测
M3  共享 pausedTurnStore 注入(index runtimeConfig,仅 recovery.enabled)+ 单测(主+worker 共享、approvalId 不串、关闭时独立)
M4  orchestrator.resumeDurable(校验门 → 重建 worker + 重水化 approve + resumeDispatchLoop + driveFrom 续回合)+ 单测(mock 重建 worker/store;指纹/归属不符→blocked)
M5  暂停时双写 sidecar(orchestrator 注入 orchPersistence + worker `__orchestration` 标记,recovery 开启才写;写序编排先于 worker)+ 单测
M6  recovery-service 扫 orchestration-paused + list/resume/cancel 处理编排项 + **孤儿一律 blocked**(§5.6)+ 单测
M7  index 接线(注入共享 store + orchPersistence + 重建句柄 + recovery resume 路由 + kernel.agent.approve durable 路由 + budget 续扣重建)+ 单测
M8  e2e(真链路:recovery.enabled,编排 worker 暂停→落盘→**新 kernel 实例**重启扫描→resume 重水化 approve→续跑完成;off 零回归)+ 回归 739 + 文档
```
> M0–M4 纯 mock 单测;M5–M7 接线;M8 真跨实例 e2e + 收口。`recovery.enabled=false` 永远是零回归逃生口。

---

## 7. 测试策略(node:test,确定性优先)
- **persistence**:save/scan/restore/consume 往返;原子写;损坏 sidecar → quarantine;孤儿清理。
- **contract(M0)**:serialize→deserialize 往返等价;坏 schema/缺字段拒绝;`fingerprints` 不符→blocked;`ownershipOk` 校验(approvalId/taskId/sessionId/subtask.id/owner 一致才过);budget 续扣计算正确。
- **共享 store**:主 runtime 与 worker 写入同一 store、approvalId 不冲突;`recovery.enabled=false` 时各自独立(默认行为不变断言)。
- **resumeDurable**(mock 重建 worker + 共享 store 预置 restored 记录):校验门过 → approve → 重水化 worker turn → 结算 → 续回合(不重 plan,plan 调用=0);deny → subtask 失败续跑;再次暂停 → 新 sidecar;**指纹/归属不符 → blocked,不重建不 approve**。
- **recovery 扫描**:orchestration sidecar + worker sidecar 齐且指纹符 → inbox `orchestration_paused`;**编排 worker 孤儿(worker 在/编排缺,或反之)→ 一律 `blocked_recovery`**(不降级单 agent);普通无 `__orchestration` 单 agent sidecar 仍走单 agent resume。
- **e2e 跨实例**:kernel A `recovery.enabled` 跑编排→worker 暂停→`dispose`(保留 sidecar);kernel B 同 root 启动→`recoverOnStartup` 登记→`recovery.resume`→重水化 approve→编辑落主区→续跑完成;断言 `plan` 跨实例仅初始 1 次、budget 续扣不重置。
- **off 零回归**:`recovery.enabled=false` 下编排暂停仍走 C5 内存 `orchPaused`、不落 orchestration sidecar、共享 store 不注入;现有 739 全绿。

---

## 8. 开放问题(实施前/中再定)
- 是否把编排状态**内联**进 worker sidecar 的 `resume_state.orchestration` 子字段以**单份原子**落盘(消双写崩溃窗口,但耦合 worker `resume_state` 结构)—— M0 评估;默认双 sidecar + 孤儿一律 blocked 已安全。
- 多个并发编排暂停(理论串行主区一次一个,replan 后可能链式)→ 多份 sidecar 的 inbox 呈现与逐个 resume。
- 重建 worker 时 `context_scope` 的语义上下文快照在新进程的可重现性(文件级稳定;语义级若启用需重扫——按需,不阻塞)。

> review 已定死(移出开放问题):预算续扣(§5.10)、孤儿降级=blocked(§5.6/§3.2)、不存 raw options(§5.7)、版本指纹门(§5.8)、approval 归属校验(§5.9)。
