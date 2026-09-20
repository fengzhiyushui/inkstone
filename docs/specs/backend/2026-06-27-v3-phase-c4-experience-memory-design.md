# DeepSeek Code V3 Phase C4 · 跨任务经验记忆(完整)设计

> 类型:后端设计 spec(backend)
> 日期:2026-06-27
> 状态:已评审,待转实施计划
> 关联:[Agent 分层记忆系统(原始构想)](2026-06-24-agent-layered-memory-design.md) · [C1+C2 编排](2026-06-27-v3-phase-c1-c2-orchestration-design.md) · [C5 重规划+续跑](2026-06-27-v3-phase-c5-replan-resume-design.md) · [V3 路线图](../architecture/2026-06-24-v3-roadmap-design.md) §7.3

---

## 1. 背景与范围

原始构想 [2026-06-24 分层记忆 spec](2026-06-24-agent-layered-memory-design.md) 给了完整的「双记忆 + 七层 + 三级分化 + 巩固器」蓝图,但留了一堆「实施前再定」。本 spec 是其**实施级落地**,把开放问题全部定死,并**修正与现有代码不符之处**。

**关键前提(已变化)**:原构想 §6 的「**本次任务内**(始终开)」那层 —— 次 agent 审核摘要 → 主 agent 立即调整后续派发 —— **C5 已交付**(`orchestrator` 回合循环 + `planner.replan(摘要)`)。故 C4 真正要做的是**另一层**:

> **跨任务沉淀(开关,默认关)**:次 agent 在**任务边界**提炼高价值教训 → 写入独立**经验记忆系统** → 新任务时 planner 检索相关经验 → 影响拆/派 + 风险经验联动权限层。

**本片范围(用户选「完整」)**:经验库 + 三级分化(打分/升降/淘汰)+ 语义聚簇去重 + 巩固器(次 agent)+ planner 检索注入 + 风险→权限耦合 + 开关。

**两处关键修正**(基于真实代码勘察):
1. 原 §5.3「聚簇复用 Phase B 语义检索」**站不住** —— Phase B 是**代码符号依赖图**,非**教训文本**相似度,项目无任何文本相似度设施(无 embedding/cosine/jaccard)。本片改用**启发式 token-集 Jaccard**(零依赖、确定性、可单测)。
2. 原 §3「风险记忆 → 权限层」需落到 `permission-engine`,但必须**只升不降**(经验只能让权限更谨慎),且**不改 `agent-runtime`**。机制见 §9。

**延续硬约束**:`agent-runtime.js` **一行不改**;编排/记忆决策确定性(模型只提炼/读简报,程序逻辑控打分/定级/淘汰/检索/升级);**默认零回归**(`crossTaskLearning="off"` → 与 C1–C5 逐字节一致)。

---

## 2. 范围与非目标

**做**:① 经验库存储层(独立目录 + schema + 原子写 + CRUD/query)② 三级分化(打分/定级/升降/老化/末位淘汰)③ 语义聚簇去重(Jaccard)④ 巩固器(次 agent 任务边界异步提炼)⑤ 检索 + planner 注入 ⑥ 风险经验 → permission 单调升级 ⑦ 开关 `off|on|gated` + 事件。

**不做(留后续)**:跨**项目**经验共享(本片项目级隔离);经验的向量/embedding 检索(本片 Jaccard 足够,embedding 留增强);经验库 UI/CLI 浏览器(只读写 API,展示留前端片);周期后台清扫线程(本片「写时即评」已保证不超 cap,定时清扫非必需)。

---

## 3. 两套记忆系统(彻底分开)

| | **主记忆**(已有) | **经验记忆**(本片新增) |
|---|---|---|
| 存什么 | 项目事实、用户偏好 | 次 agent 提炼的教训(程序/风险经验)|
| 谁写 | 子 agent 执行时(`tools/builtin/memory.js`)| **只有巩固器(次 agent)** |
| 谁读 | 子 agent 取事实 | **主 agent 的 planner**(拆/派时)+ permission(风险)|
| 存哪 | `~/.deepseek-code/projects/<hash>/memory/` | `<root>/.deepseek-code/v2/experience/<hash>/`(项目级、随仓忽略)|
| 信任级别 | 高(事实) | 低(启发,带置信度 + 出处)|
| 开关 | 一直 | `crossTaskLearning`(默认 `off`)|

**为什么分开**:经验记忆可一键清空/降权/重置而**不碰**主事实;消费者不同(planner vs 子 agent);防审核噪音沉淀进事实库。**隔离即保险**。

---

## 4. 组件(新子系统 `src/core/memory/`)

| 单元 | 类型 | 职责 |
|---|---|---|
| `experience-store.js` | I/O | 独立存储 + CRUD/query;单 `experience.json`(条目数组)原子 temp-rename 写、全量载入内存(受 cap 保证小)|
| `experience-scoring.js` | **纯** | `score(e, now)` · `tierOf(score, thresholds)` · 升降/老化 delta(注入 `now` 可测)|
| `experience-cluster.js` | **纯** | 归一化 cues 的 token-集 Jaccard · `dedupThreshold` · 同簇合并(留最高 tier、并证据、累加 validations)|
| `experience-upsert.js` | 编排(纯+store) | 写入管线:聚簇 → 评分 → 定级 → 淘汰 → 封顶(全程序逻辑)|
| `experience-consolidator.js` | 次 agent | 任务边界回放 `allCollected`+outcome → readonly runtime 提炼 ≤K 条 → `upsert`(模型只提炼)|
| `experience-retrieval.js` | **纯** | 按当前 message cues 查库 → cue 重叠 × tier 权重 top-K → 合成简报(procedural)+ 风险 cue 集(risk)|
| `risk-rules.js` | **纯** | 风险经验 → `escalate_only` projectRules(§9)|

### 4.1 Schema(`ExperienceEntry`)
```json
{
  "id": "exp_<hash>",
  "kind": "procedural" | "risk",
  "lesson": "<提炼后的一句判断模型,非原文>",
  "cues": ["归一化关键词", ...],
  "provenance": { "taskId", "sessionId", "round", "subtaskIds": [...] },
  "confidence": 0.0,            // 0..1
  "validations": 0,            // 被采纳且任务 outcome 证明有效次数
  "misleads": 0,                // 被判误导次数
  "created": "<iso>",
  "lastReinforced": "<iso>",
  "tier": 1 | 2 | 3
}
```
- `cues`:巩固时由次 agent 产出 + 归一化(小写、去标点、去停用词)+ **去重 + 字典序排序**(存储/检索/事件/prompt 都用排序后的稳定序,杜绝 Set 迭代序非确定);检索与聚簇都用它。
- `reasoning_content` **不入库**(原 §11):只存提炼后 `lesson`,原始推理留事件时间线。

### 4.2 存储格式(定死开放问题)
- **单文件 `experience.json` = `{ schemaVersion, entries:[...] }`**,原子写(写 `<unique>.tmp` → rename)。理由:更新频繁(置信度/tier/删除),内存内算分+聚簇最简;cap 保证文件小。
- 项目级目录 `<root>/.deepseek-code/v2/experience/<projectHash>/`(`.deepseek-code/` 已 gitignore)。
- **写串行化(review #2,硬约束)**:store 内置**每实例 async 写队列(mutex)**——`upsert`/`reinforce`/`evict`/`flush` 全部经队列串行落盘,杜绝异步巩固 + 多任务边界 + `flushExperience`/`dispose` 并发导致的 lost-update;每次写用**唯一 tmp 名**(`pid+counter`,不撞)。读时全量载入内存快照,写时「读快照→改→经队列原子落盘」;队列保证「读-改-写」对单进程是原子序列。**跨进程并发写非本片目标**(经验库项目级单实例;跨进程 durable 与编排级 durable 同属后续)。
- `schemaVersion` 不匹配 → 保守:载入失败按空库起(不崩、不误读旧格式),记一条 warning 事件。
- 删除有日志:`experience-evictions.jsonl`(可追溯,原 §5.4)。

---

## 5. 三级分化(定死打分/阈值)

### 5.1 打分(纯函数,注入 `now`)
```
score(e, now) = clamp01(
    e.confidence
  + 0.1 * ln(1 + e.validations)        // 反复验证有效 → 升
  - decayPerDay * daysSince(e.lastReinforced, now)   // 久未强化 → 自然下沉
  - 0.2 * e.misleads                   // 被判误导 → 骤降
)
```
默认 `decayPerDay = 0.02`(全可配)。

### 5.2 定级与淘汰
| tier | 阈值(默认) | planner 检索权重 |
|---|---|---|
| 1 核心 | `score ≥ T1=0.7` | 强(优先采纳)|
| 2 候选 | `score ≥ T2=0.4` | 中(参考)|
| 3 观察 | `score ≥ T3=0.2` | 弱(仅提示)|
| 淘汰 | `score < T3` | **立即删**(写日志)|

- **新经验** → 进三级(初始 `confidence` 由次 agent 给,夹到 `[0.2, 0.6]` 防过自信)。
- **强化**:被本任务采纳且任务 outcome 证明有效 → `validations++`、`lastReinforced=now`(→ score↑ → 可升级)。
- **削弱**:被采纳但相关工作失败 / 被审核判误导 / 与新事实冲突 → `misleads++`(→ score↓ → 可降级/淘汰)。
- **写时即评**:每次 upsert/强化重算该簇所有条目分级,跌破 `T3` 当场删 + 记日志。
- **封顶 `cap=200`**(可配):超 cap → 删 score 最低者(末位淘汰)。**平分 tie-break(确定性)**:score 相等 → 删 `lastReinforced` 更早者 → 再相等删 `created` 更早者 → 再相等按 `id` 字典序。淘汰/定级/聚簇遍历**一律按 `id` 字典序**遍历,杜绝顺序非确定。

> **强化/削弱在任务边界由巩固器做(单一写者,确定性)**:升降**只针对 `adopted`(planner 明确声明用到)的经验,不针对仅 `presented`(进了 prompt)的**(review #1,杜绝「读到≠用到」的错误强化)。三类 id 状态流见 §7。task 跑完后,巩固器(§6,同一次边界调用)拿 `{adoptedExperienceIds, outcome, allCollected}` → **程序判定**:task `complete` 且采纳经验相关 subtask 成功 → 强化;task 失败 / 该经验相关 subtask failed / 审核摘要标其误导 → 削弱;**`adopted` 为空 → 不强化任何条目**(保守)。**模型不决定升降**,只产审核摘要 + `used_experience_ids`;升降是程序逻辑。强化/削弱也是写,故仍由巩固器统一执行(契合 §3「只有巩固器写」)。

### 5.3 聚簇去重(Jaccard,修正 Phase B)
- 相似度 = `|cues(a) ∩ cues(b)| / |cues(a) ∪ cues(b)|`(归一化 token 集)。
- `dedupThreshold = 0.6`:≥ 阈值视为同簇。
- **cue 质量护栏(review #3,防短 cue 误命中)**:
  - **归一化**:小写、去标点;**去停用词**(中英最小停用集 + 低信息词 `test/file/error/code/fix/update/...`);**代码路径/命令 token** 整体保留为单 cue(不按 `/`/`.` 拆碎,避免 `src`/`js` 这类碎片污染)。
  - **最少有效 cue 数 `minEffectiveCues=2`**:有效 cue < 2 的条目**不参与聚簇也不参与检索匹配**(避免单个泛词触发 Jaccard 误命中);空 cue 条目巩固时即判低信息、**不入库**。
  - **kind 边界(硬)**:`risk` 与 `procedural` **永不同簇**(聚簇先按 `kind` 分桶,只簇内比相似度);合并时 `provenance` 取并、保留两条出处链,`kind` 不混。
- 同簇:保留最高 tier 那条,合并 `cues`(并集)、累加 `validations`、`provenance.subtaskIds` 取并;簇内其余删。
- 防「同一教训不同措辞反复堆积」。

---

## 6. 巩固器 = 次 agent(任务边界,异步,不丢写)

### 6.1 时机与位置
- 挂 `orchestrator.finalize()` **之后**(`synthesize` + `classifyOutcome` 已出,见 [orchestrator.js:83](../../../src/core/orchestration/orchestrator.js#L83))。
- **异步离关键路径**:`run()` 立即把用户结果返回;巩固作为 **tracked promise** 进 `pendingConsolidations` 集合,**不 await**;`kernel.dispose` / 新增 `flushExperience()` 时 await —— **不拖慢用户、不丢写**(仿 `session-manager` 的 `pending`+`flush`)。
- 仅 `crossTaskLearning !== "off"` 触发;且仅 `orchestrate` 档任务(single 档不巩固)。

### 6.2 提炼(模型只做这一步)
- 输入:`{ message, done_when, allCollected(摘要), outcome }`。
- readonly `agent-runtime` 实例(`worker-factory` readonly profile,**引擎不改**)→ 产 ≤K(默认 5)条 `{kind, lesson, cues, confidence}`。
- 输出过 schema 校验 + 有界重试 + 保守收尾(畸形 → 本次不沉淀,不崩,同 planner 模式)。
- 每条 → `experience-upsert`(§5 管线)。

---

## 7. 检索 + planner 注入

**三类经验 id 状态流(review #1,「读到 ≠ 用到」)**:
| 类 | 含义 | 谁定 |
|---|---|---|
| `retrieved` | query 命中的全部 | retrieval(程序)|
| `presented` | 过 top-K + cue 护栏、真进了 planner prompt | retrieval(程序)|
| `adopted` | planner **明确声明实际采用** | planner 结构化输出 `used_experience_ids`(模型),程序兜底为 ∅ |

- `orchestrator.run()` 内 `planner.plan` **之前**,`crossTaskLearning !== "off"` → `retrieval.query({ message })`:
  - 抽 message 的 cues(同 §5.3 归一化 + 护栏)→ 与库内条目 cue 重叠打分 × tier 权重 → top-K(默认 5)= `presented`。
  - 产出:`{ procedural:[{id,lesson,tier,confidence}], presentedIds, riskCues:Set<string> }`。
- **procedural 简报**作为 `experiences` 传入 `planner.plan({ message, context, experiences })` → planner 加进 prompt(模型只读「判断简报」,不读原文),并要求 planner 在 Plan 里回 **`used_experience_ids`**(它真正参考的子集;缺省/畸形 → 视为 `[]`)。
- `state.adoptedExperienceIds = used_experience_ids ∩ presentedIds`(交集兜底:planner 不能「采纳」没给它看的)。**只有 `adopted` 参与 §5.2 升降**;`presented \ adopted` 不强化也不削弱。
- **riskCues** 流向 §9(权限升级)——与 adoption 无关,风险一旦命中即升级。
- 检索是**纯读**,不改库。`subtask-schema` 给 `Plan` 加可选字段 `used_experience_ids?: string[]`(不影响既有 plan 校验,缺省合法)。

---

## 8. 开关 + 配置 + 零回归

```
config.orchestration.crossTaskLearning = "off" | "on" | "gated"   // 默认 "off"
config.orchestration.experience = {
  cap: 200, decayPerDay: 0.02, thresholds: { T1: 0.7, T2: 0.4, T3: 0.2 },
  dedupThreshold: 0.6, maxLessonsPerTask: 5, retrieveK: 5
}
```
- **`off`(默认)**:无检索、无巩固、无权限升级、无新事件、不建经验目录 → 与 C1–C5 **逐字节一致**(disabled-parity 守护)。
- **`on`**:自动检索 + 自动沉淀 + 风险升级。
- **`gated`**:同 `on`,但**高影响写入**(`risk`-kind,或 procedural 拟升到 tier-1)在落库前**人工确认**(详见 §8.1)。普通 procedural 直接落。
  > **消歧(F1)**:`crossTaskLearning:"gated"` 与权限 `DEFAULT_POLICY_MATRIX` 里的 autonomy 档 `"gated"`(§9)**同名但完全正交** —— 前者管「经验写入要不要人工确认」,后者管「工具调用的默认放行级别」。实现中两者**不可互相读取或耦合**;命名沿用旧 spec,实施时注释钉死区分。
- `normalizeOrchestration` 加 `crossTaskLearning`(枚举,默认 off)+ `experience` 子块(posInt/0..1 归一);kernel-options 已透传 `orchestration`。

### 8.1 gated 写入的交互生命周期(review #4,带外审批)
巩固在**后台**、用户结果**已返回**,故 gated 审批是**带外**的(不阻塞任何 turn),状态机写死:
1. 巩固器算出高影响条目 → **不直接落库**,而是写进 store 的 **`pending/` 待审区**(独立于正式库)+ 发 `experience:pending_approval` 事件 `{ pendingId, kind, lessonPreview, reason }`。条目此刻**不影响**任何检索/权限。
2. 暴露 API:`kernel.experience.listPending()` / `kernel.experience.resolvePending(pendingId, "approve"|"deny")`(CLI/GUI 据此展示与处理;**复用现有 approval 事件管线**渲染)。`approve` → 经写队列落正式库;`deny` → 从待审区删 + 记 eviction 日志(reason `gated_denied`)。
   > 与 §3「只有巩固器写」一致:`resolvePending(approve)` 落的是**巩固器先前暂存的条目**(人只决定放不放行,不产新内容),非独立写者。
3. **pending 不阻塞、不无限留存**:`pendingTtlMs`(默认 24h)过期 → 自动判 `deny`(保守:宁可不沉淀)。
4. **`dispose`/进程退出**:未决 pending **保留在 `pending/` 磁盘待审区**(不丢、下次启动可继续处理),但**绝不**因退出而自动落正式库。即「有门没人开 → 默认不进」。
5. `off`/`on` 无 pending 流程(`on` 直接落、`off` 全不动)。

---

## 9. 风险经验 → 权限层(单调升级,agent-runtime 不改)

### 9.1 安全不变量(写死,最高优先)
**经验只能让权限更谨慎,绝不放松。** 形式化:对任何工具调用,启用经验后的决策 `∈ {原决策, 比原决策更严}`,且:
- **绝不** `deny → {ask, allow}`、**绝不** `ask → allow`。
- **只允许** `allow → ask`,且**仅当**原 `allow` 来自 `default-matrix`(系统默认自动放行),**不覆盖**用户显式 `trust-store`/`approval-cache`/`project-rules`(那是用户主动决定)。
- destructive 永远 deny(既有不变量不动)。

### 9.2 机制(只改 `permission-engine.js`,不改 `agent-runtime`)
1. retrieval 的 `riskCues` → `risk-rules.js` 生成 **`escalate_only: true`** 的 projectRules(按 cue 匹配 tool 名 / 路径 glob)。
2. orchestrator 把这些规则经 dispatch deps 下传,**dispatch-loop 在 `worker.send(prompt, { autonomy })` 处补成 `{ autonomy, projectRules }`**([dispatch-loop.js:73](../../../src/core/orchestration/dispatch-loop.js#L73) 当前只传 `{autonomy}` —— 需扩,**改 dispatch-loop 非 agent-runtime**);`agent-runtime.buildPermissionContext` **已转发** `options.projectRules` → executor → `decide` 的 context,**无需改 agent-runtime**。
3. **作用域(F8,硬)**:风险升级**只作用串行主区 worker**(C1+C2/C5 路径,审批暂停已支持)。**并行 iso worker(C3,autonomy `auto`、设计上不暂停)不施加升级** —— 否则 `allow→ask` 会逼出审批暂停、破 C3 自动并行(与 C5「暂停点只在串行主区」一致)。iso worker 隔离 + CAS 合并,风险面本就低。
4. `permission-engine.decide` 两处改:
   - 普通 projectRules 循环 **跳过** `escalate_only` 规则(它们不是常规 allow/deny 规则,不得直接 return → 杜绝降级)。
   - 算出 `default-matrix` 决策后,加 **escalation pass**:若存在匹配的 `escalate_only` 规则 **且** `decision==="allow"` **且** `source==="default-matrix"` → 改 `{decision:"ask", source:"risk-experience", escalated:true}`。其余情况原样返回。
5. `gated` 下,被风险升级触发的确认即天然的人工 gate。

> **为何不直接用普通 projectRules**:普通规则在矩阵前 return `rule.decision`,在 read-only(write=deny)下一条 `ask` 风险规则会 **deny→ask 降级**,违反 §9.1。`escalate_only` + 独立单调 pass 是唯一安全形态。

---

## 10. 事件(eventBus 级,同 `orchestration:*`,不入 `SESSION_EVENT_TYPES`)
- `experience:retrieved` —— `{ count, tiers, riskCueCount }`
- `experience:consolidated` —— `{ taskId, written, merged, evicted }`
- `experience:evicted` —— `{ id, reason: "below_tier3"|"over_cap"|"gated_denied" }`
- `experience:reinforced` / `:weakened` —— `{ id, validations|misleads, tier }`
- `experience:pending_approval` / `:pending_resolved` —— `{ pendingId, kind, decision? }`(仅 `gated`,§8.1)
仅 `crossTaskLearning !== "off"` 触发(off 档与今天一致)。

---

## 11. 硬约束(实施判据)
1. **`agent-runtime.js` 一行不改**;巩固器/worker 用其现成 readonly runtime;权限升级走 `options.projectRules` 已有通道。
2. **确定性**:打分/定级/淘汰/聚簇/检索/升降/权限升级全程序逻辑;模型只「提炼教训」与「产审核摘要」。
3. **单调权限升级**(§9.1):只 `allow→ask`、只覆盖 default-matrix、绝不降级;dedicated 测试钉死。
4. **默认零回归**:`off` → 无检索/巩固/升级/事件/目录,C1–C5 + 现有 670 全绿不改。
5. **异步不丢写**:巩固后台跑、`flushExperience`/`dispose` 收口;用户结果不等巩固。
6. **隔离即保险**:清空经验目录 → 主记忆与事件时间线毫发无伤。
7. **无文本相似度新依赖**:聚簇/检索用 Jaccard,纯 JS。

---

## 12. 里程碑(供拆实施计划;每 Task 末测试+提交)
```
M0  契约 + 状态机小样(review 建议):`ExperienceEntry`(含 `schemaVersion`)+ `retrieved/presented/adopted` 三类 id 状态流类型 + store 写队列接口 + gated `pending` 状态接口 + **`off` 零回归断言骨架**(目录/事件/prompt/permission 输出全不变的测试夹具)。纯类型/接口 + 骨架测试,无逻辑
M1  experience-store(schema + 原子写 + **写队列/mutex + 唯一 tmp 名** + CRUD/query + 项目级目录 + schemaVersion 不匹配保守起空)+ 单测(含并发写不丢失)
M2  experience-scoring(score/tierOf/升降/老化,纯,注入 now)+ 单测
M3  experience-cluster(归一化 + **cue 护栏:停用词/低信息词/最少有效 cue/代码 token/kind 分桶** + Jaccard + 合并去重,纯)+ 单测
M4  experience-upsert 管线(聚簇→评分→定级→淘汰→封顶 + eviction 日志)+ 单测
M5  experience-consolidator(次 agent readonly 提炼,mock 模型 + schema 校验 + 保守收尾)+ **强化/削弱 adopted 经验(按 task outcome 程序判定)** + 单测
M6  experience-retrieval(cues 抽取 + 护栏 + tier 加权 top-K + 简报/`presentedIds`/riskCues,纯)+ `Plan.used_experience_ids` 可选字段 + planner.plan 注入 experiences + 单测(presented≠adopted)
M7  config(crossTaskLearning + experience 归一)+ orchestrator 接线(检索 pre-plan / `adopted = used ∩ presented` / 后台巩固 + flush,把 {adoptedIds,outcome} 传入巩固器)+ 事件 + 单测
M8  risk-rules + permission-engine escalation pass(escalate_only + 单调升级)+ orchestrator 注入 worker projectRules + 单测(钉死 §9.1 只升不降)
M9  gated 模式(§8.1 带外审批:pending 待审区 + listPending/resolvePending + TTL + dispose 保留不落库)+ e2e(任务完成→沉淀→下任务检索影响拆派 + 风险升级 allow→ask;off 零回归)+ 回归 + 文档
```
> M0 契约 + off-parity 骨架;M1–M6 纯 mock 单测;M7–M8 接线;M9 真链路 + 收口。`off` 永远是零回归逃生口。

---

## 13. 测试策略(node:test,确定性优先)
- **store**:原子写/读回/list/delete/query;**写队列串行化 —— 并发 `upsert`/`reinforce`/`flush` 无 lost-update**(并发发 N 次写,终态含全部);唯一 tmp 名;schemaVersion 不匹配起空库;目录项目级隔离。
- **scoring**:注入 `now` → 老化衰减、validations 升、misleads 降、tier 边界 `T1/T2/T3`、淘汰阈值。
- **cluster**:Jaccard 对称/边界(0/1)、`≥0.6` 同簇、合并留最高 tier + 累加 validations + 并 cues;**护栏 —— 短/低信息 cue(`test`/`file`)不误命中、有效 cue<2 不参簇/不参检索、`risk` 与 `procedural` 永不同簇**。
- **upsert**:新→三级、同簇合并、跌破 T3 即删 + 日志、超 cap 末位淘汰。
- **consolidator**(mock 模型):合法 ≤K 条 → upsert;畸形 → 不沉淀不崩;空/低信息 cue 条目不入库;`off` → 不调模型。
- **retrieval**:cue 重叠 × tier 权重排序、top-K、`presentedIds`、riskCues 抽取;纯读不改库。
- **planner 注入**:`experiences` 进 prompt(断言 prompt 含简报);planner 回 `used_experience_ids`;无 experiences → 与今天一致。
- **强化只认 adopted**(review #1,钉死):`presented` 但 planner **未**声明 `used` → **不**强化也不削弱;`adopted=used∩presented`(planner 谎报未 presented 的 id → 被交集滤掉);`adopted` + task complete → validations++;failed/误导 → misleads++;`adopted` 空 → 全库不动。
- **permission 单调升级**(§9.1 核心,钉死):default-matrix `allow` + 命中 risk → `ask`;`deny`/`ask` 不变;trust-store/approval-cache `allow` **不被**升级;`escalate_only` 规则**不**在普通循环 return;`off`/无 riskCues → `decide` 输出逐字节同今天。
- **gated 生命周期**(§8.1,钉死):高影响 → 入 `pending/` + 发 `experience:pending_approval`、**不影响检索/权限**;`resolvePending(approve)` 经写队列落库 / `deny` 记日志删;TTL 过期自动 deny;`dispose` 未决 pending 保留磁盘、**不自动落库**。
- **e2e**:`on` 下 task1 完成→沉淀→task2 检索影响 plan + 风险 allow→ask;`off` 全链路逐字节同今天。
- **off 零回归骨架**(M0):同一组任务在 `off` 下,目录不建、`experience:*` 零事件、planner prompt 不含简报、`decide` 输出与今天 byte-equal。
- **回归**:现有 670 全绿(`off` 默认 / mock-only 路径退化)。

---

## 14. 开放问题(实施中可微调,不阻塞)
- `T1/T2/T3`、`decayPerDay`、`cap`、`dedupThreshold` 初值(已给默认,实测样本再调)。
- cues 归一化的停用词表范围(中英最小集起步)。
- gated「高影响」判定边界(risk-kind ∪ 拟升 tier-1;实测再收紧)。
- 跨**会话**的 taskId 关联粒度(本片用 orchestrator run 的一次 = 一个 taskId)。
