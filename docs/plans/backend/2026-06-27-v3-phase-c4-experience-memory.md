# V3 Phase C4 跨任务经验记忆实施计划

- 类型：实施计划
- 日期：2026-06-27
- 状态：已完成
- 关联：[C4 design](../../specs/backend/2026-06-27-v3-phase-c4-experience-memory-design.md)、[C1+C2](2026-06-27-v3-phase-c1-c2-orchestration.md)、[CHANGELOG](../../CHANGELOG.md)

## 目标

给编排加跨任务经验记忆：次 agent 在任务边界提炼教训 → 独立经验库（三级分化 + Jaccard 聚簇）→ 新任务 planner 检索影响拆派 + 风险经验单调升级权限。默认 `off` 零回归。

## 结果

新子系统 `src/core/memory/`（纯函数 store/scoring/cluster/retrieval + 次 agent consolidator），接进 `orchestrator`（检索 pre-plan / 后台巩固 + flush）与 `permission-engine`（只升不降 escalation pass）。

| 文件 | 责任 |
|------|------|
| `experience-schema.js` | `ExperienceEntry` / `PendingEntry` 校验 + `FILE_SCHEMA_VERSION=1` + id 状态流类型注释 |
| `experience-store.js` | 存储 + 写队列 + 原子写 + CRUD/query + pending 待审区 |
| `experience-scoring.js` | 纯：score / tierOf / reinforce / weaken / age |
| `experience-cluster.js` | 纯：cue 归一化 + 护栏 + Jaccard + 合并去重 |
| `experience-upsert.js` | 写管线：聚簇→评分→定级→淘汰→封顶 + eviction 日志 |
| `experience-consolidator.js` | 次 agent 提炼 + adopted 升降 |
| `experience-retrieval.js` | 纯：cues→top-K 简报 / presentedIds / riskCues |
| `risk-rules.js` | 纯：riskCues→`escalate_only` projectRules |

配置 `orchestration.crossTaskLearning`（`off` / `on` / `gated`，默认 `off`）与 `orchestration.experience`：

```text
cap: 200, decayPerDay: 0.02
thresholds: { T1: 0.7, T2: 0.4, T3: 0.2 }
dedupThreshold: 0.6, maxLessonsPerTask: 5
retrieveK: 5, pendingTtlMs: 86400000
```

经验目录 `.deepseek-code/v2/experience`。`kernel.experience` facade 含 `listPending` / `resolvePending` / `flushExperience`。事件 `experience:pending_approval`、`experience:retrieved`（含 count / tiers）。强化只认 `adopted = used_experience_ids ∩ presentedIds`，`presented \ adopted` 不升降。

## 关键决策 / 遗留约束

- **`agent-runtime.js` 一行不改**：consolidator/worker 用其现成 readonly runtime；风险升级走 `options.projectRules` 已有转发通道。
- **确定性**：打分/定级/淘汰/聚簇/检索/升降/权限升级全程序逻辑；模型只提炼教训 + 产审核摘要 + `used_experience_ids`。时间戳经注入的 `now`；遍历/平分按 id 字典序 tie-break。
- **单调权限升级**：只 `allow→ask`、只覆盖 `default-matrix`、绝不降级或覆盖用户显式 trust/cache；只作用串行主区 worker（并行 iso 路径不传 projectRules）。
- **默认零回归**：`crossTaskLearning="off"` → 无检索/巩固/升级/事件/目录，`decide()` 输出 byte-equal，现有 670 全绿不改。
- **写串行化**：store 内置每实例 async 写队列，唯一 tmp 名。
- **gated 模式**：高影响风险 / 拟升 tier-1 进 pending 待审 + `experience:pending_approval`，不影响检索与权限；`resolvePending(approve)` 落库，`deny` 删 + 日志；TTL 过期自动 deny；`dispose` 未决 pending 保留磁盘、不落库。
- 状态流 `retrieved → presented → adopted` 三态。

## 验证

`tests/core/memory/*.test.js`（schema / store / scoring / cluster / upsert / consolidator / retrieval / risk-rules）、`tests/core/orchestration/c4-*.test.js`（含 e2e：on 时 task1 完成→flushExperience→库有经验→task2 检索注入 plan 简报 + 风险 `allow→ask`）。off-parity 断言 decide byte-equal、无目录无事件。当时基线 670 全绿不改。当前入口 `src/core/memory/*`、`src/index.js` 的 experience 装配、`src/tools/permissions/permission-engine.js` 的 risk-experience 升级、`src/config.js` 的 `crossTaskLearning`。

Spec coverage：§4 组件 → M0–M6/M8；§5 三级分化 → M2/M4；§5.3 护栏 → M3；§6 巩固器 → M5；§7 检索三态 id → M6/M7；§8/§8.1 开关 gated → M7/M9；§9 风险升级 → M8；§10 事件 → 各 M；§11 硬约束 → Global Constraints；§12 里程碑 → M0–M9；§13 测试 → 各 Step1。
