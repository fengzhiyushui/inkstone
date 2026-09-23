# Phase C-Router · 分层路由（模型辅助复杂度判定）

- 类型：后端 spec
- 日期：2026-06-27
- 状态：已实现
- 关联：[C1+C2 编排](2026-06-27-v3-phase-c1-c2-orchestration-design.md)

---

## 问题与目标

纯关键词路由器漏报无标记的长编辑请求，也误报命中关键词的简单请求；每请求问模型又太贵。C-Router 做分层：启发式短路明显简单/复杂，仅模糊档调一次模型判 lane，失败回退启发式。模型辅助默认开，`router.model.enabled=false` 可逐字节回到旧路径。

## 决策

| 决策点 | 选择 | 否决项 | 理由 |
|---|---|---|---|
| 分层 | simple / ambiguous / complex 三档 | 全模型或全启发式 | 成本与准确平衡 |
| 模型职责 | 只产 `lane` | 顺带拆任务 | 拆分是 Planner 的事 |
| 失败 | 统一 heuristic fallback + 短码 reason | 多分支分叉 | 可测、不崩 |
| disabled 路径 | 只读 signals，不读 score | 共用评分 | 保证 opt-out parity |
| 长 edit | 只进 score，不进 signals | 也进 signals | disabled 时不改今日 lane |
| 默认 | `model.enabled: true` | 默认关 | 开箱智能路由 |

## 设计

### 分层骨架

```
feat = extractFeatures → score = computeScore → band = classifyBand
if !modelActive: lane = signals.length ? orchestrate : single   # 今天的逻辑
if band==simple:  single（免费）
if band==complex: orchestrate（免费）
else: modelTier → verdict.lane 或 heuristicFallbackLane
```

| band | 条件 | 决策 | 模型 |
|---|---|---|---|
| simple | score=0 | single | 无 |
| complex | score ≥ complexThreshold（默认 3） | orchestrate | 无 |
| ambiguous | 其间 | 模型判 | 1 次（失败回退） |

`route()` 启发式档同步返回；仅模型档返回 Promise。调用方已 `await`。

### 评分（`router-scoring.js`，纯函数）

- 强 marker +2/个（重构整个/迁移/跨多个文件/跨文件/refactor the entire/migrate/across multiple）。
- 弱 marker +1/个（这几个/这些/分别/各自/逐个/逐一/for each/each of）。
- 文件 token：`normalizeFileToken` 去重后首个免计、其后 +1、封顶 +3。
- 长 edit 捕手：`task_type==="edit"` 且消息长度 ≥ `LONG_EDIT_CHARS`（80）→ +1。

`features` 只含命中的短 token 与计数，列表截断 ≤8，不进完整用户消息。`score` / `band` / `features` 一并返回，便于调阈值。

### 模型档

- 总调用 ≤ `maxRepairs+1`（默认 1 → 最多 2 次；`maxRepairs=0` → 1 次）。
- 总超时 `timeoutMs`（默认 8000）跨全部重试。
- verdict 仅 `{"lane":"single"|"orchestrate","reason":"..."}`，越界字段忽略。
- 失败短码：`router_model_timeout` / `_invalid` / `_empty` / `_error`，异常原文不进事件。
- 回退 lane = 今日 signals-only。

配置 `channel` 作 gateway `purpose`（默认 `act` flash 档）；未知 channel 抛错后兜底。

### 事件与配置

`orchestration:route_resolved` 仅模型档运行时发出，载荷含 band/score/features/lanes/tier/reason。simple/complex 短路与 disabled 不发。该事件为 eventBus 级，不进 `SESSION_EVENT_TYPES`。

```js
config.orchestration.router.model = {
  enabled: true, channel: "act", timeoutMs: 8000, maxRepairs: 1, complexThreshold: 3
}
```

## 边界与不变量

1. `agent-runtime.js` / `classifier.js` 不改。
2. 模型不得改档、不得拆任务。
3. disabled 或裸构造无 `callModel` 时 lane 与今天逐字节一致。
4. 长 edit 捕手永不进入 signals。
5. 路由决策缓存、权重配置化、经验喂路由不在本轮。

## 与现状的差异

实现在 `src/core/orchestration/task-router.js` 与 `router-scoring.js`。默认值以 `src/config.js` 为准。

## 验收

评分纯函数可单测；模型档调用/超时/短码有测；disabled-parity 钉死长 edit 仍 single；简单/复杂零模型调用；失败回退不崩。入口 `npm test`。
