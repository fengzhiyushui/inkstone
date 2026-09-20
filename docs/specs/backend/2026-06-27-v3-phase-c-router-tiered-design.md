# DeepSeek Code V3 Phase C-Router · 分层路由(模型辅助复杂度判定)设计

> 类型:后端设计 spec(backend)
> 日期:2026-06-27
> 状态:已评审,待转实施计划
> 关联:[C1+C2 多智能体编排](2026-06-27-v3-phase-c1-c2-orchestration-design.md) · [V3 路线图](../architecture/2026-06-24-v3-roadmap-design.md) §7.3

---

## 1. 背景与目标

C1+C2 把单/多 agent 合并成一条路:`kernel.send` → **确定性路由器**([`task-router.js`](../../../src/core/orchestration/task-router.js))判 `single | orchestrate`。当前路由器**纯启发式**:`classifyMessage` + marker/文件名扫描,**有任一信号即 `orchestrate`、零信号即 `single`**。接线 [`index.js`](../../../src/index.js) 已 `await taskRouter.route(...)`,异步就绪。

**问题(用户提出)**:纯关键词启发式**太窄** —— 无 marker 的长编辑请求("把用户认证系统彻底改造一遍并补测试")会因零信号被判 `single`(漏报);而命中关键词却其实简单的请求会被判 `orchestrate`(误报)。但"每个请求都问模型"又太贵、且引入热路径延迟。

**C-Router 目标**:**分层路由** —— 启发式给「**明显简单 / 明显复杂**」免费短路,只有**模糊中间档**才掉模型判复杂度;模型失败永远回退启发式 lane(永不崩、永不挂)。

**默认姿态(用户已定)**:模型辅助档**默认开**(开箱即智能路由)。这是本项目首次主动打破「默认零回归」铁律 —— 但保留 **opt-out escape hatch**(`router.model.enabled=false` → 逐字节回到今天),既给确定性/零成本用户退路,也保留 **disabled-parity** 回归守护。

**延续约束**:`agent-runtime.js` 一行不改;路由仍**确定性**(档位由程序逻辑定,模型只在模糊档被调一次产结构化 lane);单 lane 执行契约不变(明显简单档发零新事件、与 `runtime.send` 逐字节一致);C4 跨任务经验记忆不在本片。

---

## 2. 范围与非目标

**做**:启发式评分(可解释)+ 双阈值档位 · 模糊档模型调用(`act`/flash 档,短超时,有界重试,失败回退)· `signals` 与 `score` 严格分离(disabled-parity)· `orchestration:route_resolved` 事件(仅模型档触发,带 `score`/`features`)· 配置归一化 + kernel-options 透传。

**不做(留后续)**:模型驱动的**拆分/派发**决策(模型只决 lane,不决子任务 —— 那是 planner 的事)· 路由决策缓存(同消息复用 —— YAGNI,实测有热点再加)· 把启发式特征权重做成配置(本片权重为文档化内部常量,`complexThreshold` 可配;权重调整先改代码,实测后再决定是否提配置)· C4 经验记忆喂路由。

---

## 3. 分层模型(确定性骨架)

```text
route(message, options):                       # 真异步(index.js 已 await)
  feat  = extractFeatures(message, options)     # 纯函数:markers / 归一化文件 token / 长 edit
  score = computeScore(feat)                    # 纯函数:加权求和(§5)
  band  = classifyBand(score, complexThreshold) # 纯函数:simple | ambiguous | complex
  signals = legacySignals(feat)                 # 今天的 marker+文件信号(disabled 路径用)

  # modelActive = 模型档可用 = enabled !== false 且 真注入了 callModel 函数
  if !modelActive:                              # —— opt-out 或裸构造无模型 → 逐字节回到今天 ——
      lane = signals.length > 0 ? "orchestrate" : "single"
      return { lane, reason, signals, score, features: feat, band, tier: "heuristic" }

  if band == "simple":   return heuristicLane("single",      ...)   # 免费短路,无模型调用
  if band == "complex":  return heuristicLane("orchestrate", ...)   # 免费短路,无模型调用

  # —— 仅模糊中间档:掉模型 ——
  verdict = await modelTier(message, feat)      # §6:总超时 8s,≤maxRepairs+1 次调用
  lane = verdict.ok ? verdict.lane : heuristicFallbackLane(signals)   # 失败回退,不分叉
  return { lane, reason, signals, score, features: feat, band, tier: verdict.ok ? "model" : "fallback" }
```

**三档**(由 `score` 与 `complexThreshold` 程序判,模型无权改档):

| band | 条件 | 决策 | 模型调用 |
|------|------|------|---------|
| **simple** | `score === 0` | `single` | 无(免费) |
| **complex** | `score >= complexThreshold`(默认 3) | `orchestrate` | 无(免费) |
| **ambiguous** | `0 < score < complexThreshold` | **模型判** | 1 次(失败回退启发式) |

明显档免费、成本有界;只有真模糊才花一次便宜的 flash 调用。**模型只在 ambiguous 档被调,且只产 `lane`,不改档、不拆任务。**

> **`route()` 返回契约(关键)**:启发式档(disabled / 裸构造 / simple / complex)**同步返回** `RoutingDecision`(与今天逐字节一致);**仅 ambiguous 模型档返回 `Promise<RoutingDecision>`**。唯一调用方 `index.js` 已 `await taskRouter.route(...)`,对同步对象与 Promise 皆正确。⇒ 现有 4 个同步调用 `route(x).lane` 的测试在启发式档**仍有效、无需改**。`route` 不声明 `async`,只在模型档分支 `return modelTier(...)`(后者 `async`)。

---

## 4. 硬约束(实施判据)

### 4.1 `signals` 与 `score` 严格分离(disabled-parity 基石)
- **`signals[]`**(今天的):配置 `markers` 命中 + `files.size >= minComplexFiles`。**`router.model.enabled=false` 时,lane 恒 = `signals.length > 0 ? orchestrate : single`,与今天逐字节一致。**
- **`score`**(新的):加权特征(§5),**含「长 edit」捕手**。`score` 只在 `enabled` 路径影响档位/lane;**disabled 路径绝不读 `score`**。
- ⇒ 「长 edit 捕手」是 `score` 专属特征,**永不进入 `signals`** → disabled 时它**不改变今天的 lane**(用户硬点 ④,测试钉死)。

### 4.2 文件 token 计分归一化(用户硬点 ②)
计分前每个文件类 token 经 `normalizeFileToken` 归一,再**按归一化 key 去重**后计数:
- `\` → `/`;去前导 `./`;整体小写;去重复 `/`。
- ⇒ `src/foo.ts`、`src\foo.ts`、`SRC/Foo.ts` 归一为同一 key `src/foo.ts` → **计 1 个**,分数不飘。
- glob(`*.ts`、`src/**`)同样归一并各计为一个 scope token(去重后)。
- 文件 token 贡献 **首个免计、其后 +1/个、封顶 +3**(`min(max(files-1,0),3)`):单文件请求**非复杂度信号**(与今天 `minComplexFiles=2` 语义对齐 —— 1 文件不该把单文件编辑推进模糊档白白调模型),避免长清单刷分。
> 归一化逻辑与 C3 [`path-overlap.js`](../../../src/core/orchestration/path-overlap.js) 的 `normalizePath` 同源理念(win32 大小写/分隔符),但路由侧只需 token 级去重、不碰 realpath。

### 4.3 评分可解释输出(用户硬点 ①)
`route()` 返回与 `orchestration:route_resolved` 事件**都必须带 `score` 与 `features`**(不只 `band`)。`score`/`band` 为顶层兄弟字段;`features` 为结构化明细:
```text
score = 4,  band = "complex"                    # 顶层兄弟(与 §9 事件载荷一致)
features = {
  strongMarkers: ["迁移", ...],   weak: 2,
  files: ["src/a.ts","src/b.ts"], fileScore: 1,
  longEdit: true
}
```
> **脱敏/控量(硬点 ⑤)**:`features` 只放**命中的短 token**(归一化文件 token、命中的 marker 短词)+ 计数;**绝不把完整用户消息入 `features`/事件**;列表防御性截断(≤8 项),文件数本就受 `fileScore` 封顶(≤3)。
> 后续按真实样本调 `complexThreshold` 时,`score`+`features` 是唯一依据 —— 不可省。

### 4.4 模型档总调用上限 + 失败不分叉(用户硬点 ③)
- **总调用 ≤ `maxRepairs + 1`**(默认 `maxRepairs=1` ⇒ 最多 2 次尝试;**`maxRepairs=0` ⇒ 总调用 ≤ 1**,零 retry 快速 fallback)。**写死进测试**(含 `0 ⇒ ≤1`)。
- **总超时 = `timeoutMs`(默认 8000ms,上限语义)跨所有重试**:记录起点,每次尝试给 `remaining = timeoutMs - elapsed`;`remaining <= 0` → 立即兜底。⇒ 模型档整体**绝不超过 ~8s**,路由热路径无 120s 级卡顿。
- **所有失败模式收敛到同一个 fallback**(**不分叉**):畸形 JSON / schema 非法 → 消耗重试;耗尽重试 / 超时 / 空网关(`!gateway.invoke`)/ 抛错 → **一律**回退 `heuristicFallbackLane(signals)`。回退 lane = `signals.length > 0 ? orchestrate : single`(今天的安全默认)。
- **回退携带短码 `reason`**(非异常全文,用户硬点 ③):`router_model_timeout` / `router_model_invalid`(畸形 JSON 或 schema 非法)/ `router_model_empty`(空网关)/ `router_model_error`(抛错)。短码进 `route_resolved` 事件;**异常 message 绝不入事件载荷**。

### 4.5 模型档 verdict schema
模型只回 `{"lane":"single"|"orchestrate","reason":"..."}`。`validateRouteVerdict`:`lane ∈ {single,orchestrate}` 必给;`reason` 可选字符串。非法 → 计一次失败(走 §4.4 重试/兜底)。**模型不得返回档位、子任务、复杂度数值** —— 越界字段忽略。

### 4.6 单 lane 契约不变 + 事件边界
- 最终 `lane==="single"` 时执行路径仍 = `runtime.send`(逐字节,零新事件)。
- `orchestration:route_resolved` **仅当模型档实际运行时**触发(simple/complex 短路 & disabled 路径**不发**)→ confident-simple 与 disabled 的单 lane parity 不破。
- `orchestrate` lane 仍发既有 `orchestration:routed`(载荷可加 `tier`/`score`,additive)。

### 4.7 零回归逃生口 + 裸构造安全
**模型档仅当 `enabled !== false` 且真注入了 `callModel` 函数时激活**(`modelActive`)。两条路径都回退今天的 signals-only:
- `router.model.enabled=false`(显式 opt-out)。
- `createTaskRouter()` **裸构造无 `callModel`**(单元测试 / 无网关场景)—— 故**现有 4 个 bare-router 测试无需改一行**(`这几个/分别` 弱信号仍判 `orchestrate`)。

此路径**无模型调用、无新事件、`decision.lane` 与今天逐字节一致**。现有 router/orchestrator/e2e 测试**照绿**。

---

## 5. 启发式评分(纯函数,可单测)

`extractFeatures` + `computeScore`(落 [`router-scoring.js`](../../../src/core/orchestration/router-scoring.js),纯、无 IO):

| 特征 | 来源 | 权重 |
|------|------|------|
| **强 marker** | 内建子集:`重构整个`/`迁移`/`跨多个文件`/`跨文件`/`refactor the entire`/`migrate`/`across multiple` | **+2/个** |
| **弱 marker** | 其余配置 `markers`(默认:`这几个`/`这些`/`分别`/`各自`/`逐个`/`逐一`/`for each`/`each of`) | **+1/个** |
| **文件 token** | `normalizeFileToken` 去重后计数(§4.2) | **首个免计、其后 +1/个,封顶 +3** |
| **长 edit 捕手** | `classifyMessage().task_type === "edit"` 且归一消息长度 ≥ `LONG_EDIT_CHARS`(80) | **+1** |

- 强/弱 marker 集:强集是内建常量(本片不提配置);配置 `markers` 里**非强集**的命中按弱(+1)。默认 `markers` 恰好被强/弱集完全覆盖。
- **长 edit 长度口径(写死、单测钉死)**:`String(message).trim().length >= LONG_EDIT_CHARS`(`=80`)。长度 = JS 字符串长度(UTF-16 code unit;CJK 每字≈1)。MVP **不**剥离代码块/文件清单(从简);实测过激再调阈值或加剥离。
- `computeScore` = Σ 权重。`classifyBand(score, complexThreshold)`:`0→simple`、`>=complexThreshold→complex`、其间 `ambiguous`。
- **长 edit 捕手是漏报修复的关键**:无 marker、无文件名的长编辑请求 → `score=1`(仅长 edit)→ `ambiguous` → 掉模型(可判 `orchestrate`)。**而它只在 `score` 中、不在 `signals` 中**(§4.1),故 disabled 时该请求仍判 `single`(== 今天)。

---

## 6. 模型档调用(复刻 planner 模式)

- **注入**:`index.js` 建 `routerCallModel = async (prompt, { timeoutMs }) => gateway.invoke([{role:"user",content:prompt}], { purpose: cfg.channel, timeoutMs }).content`,注入 `createTaskRouter({ ..., model: { ...cfg, callModel } })`。
  - 配置 `channel` **作为 gateway 的 `purpose` 传入**(命名沿用 overview 口径"channel=act/think")。默认 `"act"` → [`model-router.js`](../../../src/deepseek/model-router.js) flash 档(`deepseek-v4-flash`,thinking disabled,温度 0.1,快且便宜);设 `"think"`/`"review"` → pro 档更准但更慢更贵。
  - **未知 `channel`**:`routeModel` 抛 `unknown DeepSeek purpose` → 被 `callModel` 捕获 → 走 §4.4 兜底(`reason: "router_model_error"`)。⇒ config **不硬校验** channel 取值,加新 channel 无需改 schema(硬点 ②)。
- **prompt**(最小,中性,不锚定启发式倾向):用户消息 + 检测到的文件 token 列表 + 一句"判这是单点改动/单问题(single)还是跨多文件/多子目标/大重构(orchestrate)";要求**只回** `{"lane":...,"reason":...}`。
- **解析/校验/重试/兜底**(与 planner `extractJson`+有界重试+保守收尾同构):`extractJson` → `validateRouteVerdict` → 失败喂 feedback 重试(受 §4.4 总调用/总超时双上限)→ 终失败回退启发式。

---

## 7. 组件

| 单元 | 改动 |
|------|------|
| `router-scoring.js`(**新**) | `normalizeFileToken` · `extractFeatures(message, options)` · `computeScore(features)` · `classifyBand(score, threshold)` · 强/弱 marker 常量。纯函数。 |
| `task-router.js` | `route` 转**真异步**;接 `router-scoring`;`enabled` 分支(disabled→signals-only 今天逻辑 / enabled→档位+模型档);`modelTier`(注入 `callModel` + 解析/校验/重试/总超时/兜底)+ `validateRouteVerdict`。 |
| `config.js` | `normalizeOrchestration` 加 `router.model = { enabled, channel, timeoutMs, maxRepairs, complexThreshold }`(bool/字符串/posInt/nonNegInt 归一,默认见 §8)。 |
| `index.js` | 建并注入 `routerCallModel`(gateway `purpose:cfg.channel` + timeout);`routedSend` 在模型档运行时 `eventBus.publish("orchestration:route_resolved", ...)`(带 `score`/`features`/`band`/`tier`/`reason`)。 |

> **事件不登记 `SESSION_EVENT_TYPES`**:`orchestration:*` 是 eventBus 级临时事件,与现有 `orchestration:routed`/`planned` 一致 —— `session-manager` 只 bridge 注册类型到 session-log,未登记类型不报错、只是不持久化。`route_resolved` 沿用此模式,**不改 `event-types.js`**。`agent-runtime.js` **不改**;`classifier.js` **不改**(`classifyMessage` 仍复用,长 edit 捕手只读其 `task_type`)。

---

## 8. 配置

```text
config.orchestration.router = {
  minComplexFiles: 2,              // 既有(disabled 路径 signals 用)
  markers: [...],                  // 既有(强/弱集划分见 §5)
  model: {
    enabled: true,                 // 默认开;false = 逐字节回到今天(opt-out)
    channel: "act",                // flash 档;可设 "think" 换更准但更慢更贵
    timeoutMs: 8000,               // 模型档总超时(跨重试),上限语义
    maxRepairs: 1,                 // 畸形输出有界重试;总调用 ≤ maxRepairs+1
    complexThreshold: 3            // score >= 此 → 免费判 orchestrate
  }
}
```
`normalizeOrchestration` 对 `model` 子块:`enabled` 取布尔(默认 true)、`channel` 取**非空字符串**(默认 `"act"`,**不硬校验取值** —— 未知由 gateway 抛错后兜底,§6)、`timeoutMs`/`complexThreshold` 取 **posInt**(默认 8000/3)、`maxRepairs` 取 **nonNegativeInt**(默认 1,**允许 0**)。kernel-options 已透传 `orchestration`,嵌套 `model` 顺带;[`kernel-options.js`](../../../src/apps/kernel-options.js) 无需特判。

---

## 9. 事件

- **`orchestration:route_resolved`**(新,**仅模型档运行时**)—— `{ band, score, features, heuristicLane, modelLane, finalLane, tier, reason }`。`reason` 成功时为模型短理由、失败时为 §4.4 短码(`router_model_*`);`features` 已脱敏(§4.3,无完整用户消息、列表截断)。
- `orchestration:routed`(既有,orchestrate lane)—— 载荷可加 `tier`/`score`(additive)。
- simple/complex 短路 & disabled 路径 → **不发任何新事件**(单 lane parity)。

> **不入 `SESSION_EVENT_TYPES`**:`orchestration:*` 为 eventBus 临时事件,不持久化到 session timeline(与现有 `orchestration:routed`/`planned` 一致;`session-manager` 只 bridge 注册类型)。`route_resolved` 沿用此模式,**不改 `event-types.js`**。

---

## 10. 测试策略(node:test,确定性优先)

- **router-scoring(纯)**:`normalizeFileToken`(`src/foo.ts`==`src\foo.ts`==`SRC/Foo.ts` 同 key)· 文件计分去重 + 封顶 3 · 强 marker +2 / 弱 +1 · 长 edit +1(短 edit / 非 edit 不加)· `classifyBand` 三档边界(0 / threshold-1 / threshold)。
- **模型档**(mock `callModel`):合法 verdict → 取其 lane · 畸形→重试→合法 · 畸形×(maxRepairs+1) → 回退启发式 · 空网关 → 回退 · 抛错 → 回退 · **断言总调用 ≤ maxRepairs+1**(钉死,硬点 ③)· **`maxRepairs=0` ⇒ 总调用 ≤ 1**(钉死,硬点 ①)· 超时(mock 慢 callModel + 假时钟/注入 elapsed)→ 回退且不超 8s 语义 · **回退 `reason` 为短码**(`router_model_timeout`/`_invalid`/`_empty`/`_error`)非异常全文。
- **档位路由**(enabled,mock callModel 计数):`score=0` → single **零模型调用** · `score>=3` → orchestrate **零模型调用** · `0<score<3` → 模型调用 1 次、lane 取模型。
- **disabled-parity**(硬点 ④,核心):`enabled:false` 下对语料断言 lane == 今天 signals-only,且 `callModel` **零调用**;**特别钉死**:无 marker 长 edit → `single`(长 edit 捕手不改 disabled lane)、弱信号 → `orchestrate`。
- **narrowness 修复**:无 marker 长 edit,`enabled:true` → `ambiguous` → 模型可返回 `orchestrate`。
- **事件**:模型档运行 → 发 `route_resolved`(载 `score`/`features`);simple/complex/disabled → **不发**。
- **配置归一化**:`model` 缺省补默认;非法 `complexThreshold`/`timeoutMs` 回退 posInt 默认;`maxRepairs` 取 **nonNegativeInt(`0` 保留、负数/非法回退 1)**;`channel` 取非空字符串透传(不硬校验取值);`enabled` 取布尔。
- **e2e**(经 `createKernel` + mock gateway):模糊请求 → 模型档 → orchestrate 真跑 ·  `enabled:false` 全链路 == 今天 · 模型超时/畸形 → 回退启发式不崩。
- **回归**:现有 644 全绿。**现存 4 个 `task-router` 测试为裸构造(无 `callModel`)→ 走 §4.7 heuristic 路径 → 无需改一行**(`这几个/分别` 弱信号仍 `orchestrate`)。仅当测试**显式注入 mock `callModel` + `enabled`** 才进模型档,确定性可控。

---

## 11. 里程碑(供拆实施计划)

```text
M1  router-scoring.js(normalizeFileToken + extractFeatures + computeScore + classifyBand + 强/弱集)+ 纯单测
M2  task-router.js:route 转异步 + enabled 分支 + modelTier(注入 callModel + 解析/校验/重试/总超时/兜底)+ validateRouteVerdict + 单测(mock callModel)
M3  config.orchestration.router.model 归一化 + index.js 注入 routerCallModel + 模型档运行时 publish route_resolved(eventBus,不改 event-types)+ 单测
M4  e2e(mock gateway:模糊→模型→orchestrate;disabled-parity 含长 edit;失败回退)+ 既有 router 测试改造(parity 或确定 mock)+ 回归 644 全绿 + 文档(README 中英 / CHANGELOG / overview §14 补 / docs/README 索引)
```

> M1–M3 全可 mock 纯单测;M4 组真链路 + 既有测试改造 + 收口。`enabled:false` 永远是零回归逃生口与 parity 守护。

---

## 12. 开放问题(实施前/中再定)

- `complexThreshold` 默认 3、`timeoutMs` 8000ms 为起步值,**实测真实样本后再调**(`score`/`features` 事件即为依据)。
- 长 edit 捕手的 `LONG_EDIT_CHARS=80` 阈值(MVP 用 80,实测可调;暂为内部常量)。
- 模型档 prompt 是否带启发式 `score`/`features` 作提示:本片**不带**(避免锚定模型),纯给消息+文件;实测若模型判得差再加。
- `channel` 默认 `act`(flash)够不够准:不够则文档建议用户切 `think`;是否默认升 `think` 留实测。
- 强 marker 集是否需配置化:本片为内建常量;若用户大量自定义 `markers` 且需区分强弱,再提配置(YAGNI)。
