# Phase C4 · 跨任务经验记忆

- 类型：后端 spec
- 日期：2026-06-27
- 状态：已实现
- 关联：[分层记忆构想](2026-06-24-agent-layered-memory-design.md) · [C1+C2 编排](2026-06-27-v3-phase-c1-c2-orchestration-design.md) · [C5 重规划](2026-06-27-v3-phase-c5-replan-resume-design.md)

---

## 问题与目标

分层记忆构想里的「任务内即时调派」已由 C5 交付。C4 落地另一层：任务边界由次 agent 提炼教训 → 独立经验库 → 下次任务 planner 检索影响拆派，风险经验单调升权。默认 `crossTaskLearning: "off"`，关闭时与既有行为一致。

相对构想的修正：聚簇不用 Phase B 代码符号图，改 token 集 Jaccard；风险升权只升不降，且不改 `agent-runtime`。

## 决策

| 决策点 | 选择 | 否决项 | 理由 |
|---|---|---|---|
| 存储 | 独立 `experience.json` + 写队列 | 并入主记忆 | 可整体清空、防污染 |
| 相似度 | cue 的 Jaccard | embedding / 符号图 | 零依赖、确定 |
| 写者 | 仅巩固器（次 agent） | worker 随手写 | 降噪 |
| 升降 | 只认 `adopted` 经验 | presented 也升 | 读到 ≠ 用到 |
| 权限 | `allow→ask` 且仅 default-matrix | 可降级 | 只更谨慎 |
| 生效 | `off|on|gated`，默认 off | 默认开 | 零回归 |

## 设计

### 双记忆

主记忆（`memory` 工具，事实/偏好）与经验记忆（`.deepseek-code/v2/experience/`，教训）目录、信任级、消费者全分离。

### Schema 与存储

`ExperienceEntry`：id、kind（procedural|risk）、lesson、cues[]、provenance、confidence、validations、misleads、created、lastReinforced、tier。不存 `reasoning_content`。

单文件原子写 + 实例内写队列防 lost-update；schemaVersion 不匹配起空库；淘汰写 `experience-evictions.jsonl`。

### 打分与分级

```
score = clamp01(confidence + 0.1*ln(1+validations)
                - decayPerDay*daysSince(lastReinforced) - 0.2*misleads)
```

默认 T1/T2/T3 = 0.7/0.4/0.2，`decayPerDay=0.02`，`cap=200`。低于 T3 删除；超 cap 末位淘汰（确定性 tie-break）。新经验 confidence 夹在 [0.2, 0.6]。

聚簇：cue 归一化（去停用词、代码路径整段保留）、有效 cue ≥2 才参与；`dedupThreshold=0.6`；risk 与 procedural 永不同簇；同簇保留最高 tier 并合并证据。

### 巩固器

挂在 `orchestrator.finalize()` 之后异步跑（tracked promise，`flushExperience` / `dispose` 收口）。readonly runtime 提炼 ≤ `maxLessonsPerTask`（默认 5）条。仅 `crossTaskLearning !== "off"` 且 orchestrate 档触发。强化/削弱按 `adopted = used_experience_ids ∩ presentedIds` 与任务 outcome 程序判定。

### 检索与注入

`experience-retrieval.js`：cue 重叠 × tier 权重 top-`retrieveK`（默认 5）。产出 procedural 简报、`presentedIds`、`riskCues`。简报进 `planner.plan({ experiences })`；Planner 回 `used_experience_ids`。检索只读。

### 风险 → 权限

`risk-rules.js` 生成 `escalate_only` 规则。`permission-engine` 在 default-matrix 的 `allow` 上做单调升级为 `ask`（source `risk-experience`）；绝不覆盖 trust-store / approval-cache / project-rules 的显式决策，绝不 `deny/ask` 变松。升级只作用串行主区 worker，不作用 C3 iso worker。

### 开关与 gated

`crossTaskLearning: "off" | "on" | "gated"`。gated 下高影响条目（risk 或拟升 T1）进 `pending/` 待审区，`kernel.experience.listPending/resolvePending` 带外审批；TTL 默认 24h 过期自动 deny；进程退出保留待审不自动落库。

配置块见 `src/config.js` 的 `orchestration.experience`（cap、decayPerDay、thresholds、dedupThreshold、maxLessonsPerTask、retrieveK、pendingTtlMs）。

事件（eventBus 级）：`experience:retrieved` / `consolidated` / `evicted` / `reinforced` / `weakened` / `pending_approval` / `pending_resolved`。

## 边界与不变量

1. `agent-runtime.js` 不改。
2. 模型只提炼与读简报；打分/定级/淘汰/升级是程序逻辑。
3. 权限只升不降。
4. `off` 时无目录、无事件、无 prompt 注入、decide 输出与今天一致。
5. 清空经验不影响主记忆与时间线。

## 与现状的差异

实现位于 `src/core/memory/`。默认值以配置为准。

## 验收

并发写无 lost-update；打分/聚簇护栏/upsert 可单测；只强化 adopted；权限单调升级钉死；gated 生命周期完整；`off` 零回归。入口 `npm test`。
