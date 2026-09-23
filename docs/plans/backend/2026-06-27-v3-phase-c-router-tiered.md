# V3 Phase C-Router 分层路由实施计划

- 类型：实施计划
- 日期：2026-06-27
- 状态：已完成
- 关联：[C-Router design](../../specs/backend/2026-06-27-v3-phase-c-router-tiered-design.md)、[C1+C2](2026-06-27-v3-phase-c1-c2-orchestration.md)、[CHANGELOG](../../CHANGELOG.md)

## 目标

把确定性路由器从纯关键词启发式升级为分层：启发式给明显简单/复杂免费定档，只有模糊中间档掉一次便宜模型判复杂度；模型失败永远回退启发式，永不崩、永不挂。

## 结果

`route()` = 纯启发式评分（`router-scoring.js`）→ 三档（simple/complex 免费短路，ambiguous 掉模型）。模型档复刻 planner 的「callModel → 可 JSON → 校验 → 有界重试 → 保守兜底」。启发式档同步返回（与今日逐字节一致），ambiguous 档返回 `Promise`（`index.js` 已 `await`）。

新增 `src/core/orchestration/router-scoring.js`（纯函数评分）：

```text
normalizeFileToken(tok: string) -> string
  // \→/、去 ./、折 //、小写
extractFeatures(message, options, { markers })
  -> { strong:string[], weak:string[], files:string[], longEdit:boolean, classification }
computeScore(feat) -> number
  // strong+2 weak+1 file+1(cap3) longEdit+1
  // 文件项实为 min(max(files-1,0),3) 首文件免费(as-built)
classifyBand(score, complexThreshold) -> "simple"|"ambiguous"|"complex"
featuresForEvent(feat) -> { strongMarkers, weak, files, fileScore, longEdit }
  // 脱敏 + 截断
常量 STRONG_MARKERS / DEFAULT_WEAK_MARKERS / LONG_EDIT_CHARS=80
```

`task-router.js` 分层改造：modelActive 守卫 + 三档 + `modelTier` + `validateRouteVerdict` + `legacySignals`。配置：

```text
orchestration.router.model = {
  enabled: true, channel: "act", timeoutMs: 8000,
  maxRepairs: 1, complexThreshold: 3
}
```

`index.js` 注入 `routerCallModel`（gateway `purpose: cfg.channel`）。事件 `orchestration:route_resolved` 仅 modelActive 实际跑模型时 publish（不改 `event-types.js` 注册表，沿用 `orchestration:routed` 通道）。

## 关键决策 / 遗留约束

- **`signals` 与 `score` 严格分离**：signals（今日 marker + 无 FILE_TOKEN 文件计数）只在 disabled/裸构造路径决定 lane；score（加权 + 长 edit 捕手）只在 modelActive 路径决定档位。长 edit 捕手永不进 `signals`。
- **文件计分首文件免费**：`min(max(files-1, 0), 3)`。单文件请求（`modify src/index.js`）原 score 1 → ambiguous → 白白触发 model triage 占用首个 model 调用；改为首文件免费后 score 0 = simple = 单 agent 零调用。单文件本就非复杂度信号（对齐 `minComplexFiles=2`）。对应提交 `fix(orchestration): single file mention is not a complexity signal`。
- **`now` 时钟为顶层注入**（`createTaskRouter({ ..., now })`），不属 model 配置（config/index 均不产 `model.now`）。
- **模型档总调用 ≤ `maxRepairs + 1`**（`maxRepairs=0` ⇒ ≤1）；总超时 = `timeoutMs` 跨所有重试。畸形 / 超时 / 空 / 网关抛错全收敛同一启发式兜底（`signals.length>0?orchestrate:single`），回退带短码 reason（`router_model_timeout` / `_invalid` / `_empty` / `_error`），异常全文不入事件。
- **`modelActive = model.enabled !== false && typeof model.callModel === "function"`**。非 active 走今日 signals-only 同步路径，`lane` 逐字节一致；裸构造 `createTaskRouter()` = 今天。
- 事件 `features` 已脱敏（无完整消息、列表截断）。
- **`agent-runtime.js` 一行不改，`classifier.js` 不改**（只读 `classifyMessage().task_type`）。默认 enabled，可 `router.model.enabled=false` 关。

## 验证

`tests/core/orchestration/router-scoring.test.js`（归一化、文件去重、glob 捕获、computeScore 边界含首文件免费 1→0、2→1、cap3）、task-router 模型档（档位 / parity / narrowness，现有 4 测试不改）、`tests/config-orchestration-router-model.test.js`、`c-router-e2e.test.js`（ambiguous 掉模型 → orchestrate 并发 route_resolved、enabled=false byte-identical 无 triage 调用、超时/垃圾回退不崩）。最终测试数：router-scoring 8 + task-router 14 + config 5 + e2e 3，全量 670 全绿。当前入口 `src/core/orchestration/router-scoring.js`、`task-router.js`、`src/config.js` 的 `orchestration.router.model`、`src/index.js` 的 `routerCallModel`。

## 任务覆盖（as-built 映射）

M1 router-scoring.js 纯函数评分 → M2 task-router 分层（modelActive 守卫 + 三档 + modelTier + validateRouteVerdict + legacySignals）→ M3 config 归一化（`DEFAULT_CONFIG.orchestration.router.model` + `normalizeOrchestration`）→ M4 e2e + 文档。实施偏差：文件计分首文件免费；`now` 为顶层注入。Self-review 覆盖 spec §3 分层、§4.1 signals/score 分离、§4.2 归一化、§4.3 可解释脱敏、§4.4 总上限短码、§4.5 verdict schema、§4.6/§9 事件不登记、§4.7 modelActive/裸构造、§5 评分、§6 模型档、§8 config。
