# V3 Phase C-Router 分层路由 实施计划

> 完成状态以 [CHANGELOG](../../CHANGELOG.md) 为准。

> **执行说明:** 本计划按 TDD bite-sized 步骤落地;每个 Task 末「跑测试 + 提交」。全程主控内联(无 429/联网依赖,模型调用全 mock)。
>
> 设计 spec:[2026-06-27-v3-phase-c-router-tiered-design.md](../../specs/backend/2026-06-27-v3-phase-c-router-tiered-design.md)。

**Goal:** 把确定性路由器从「纯关键词启发式」升级为**分层**:启发式给明显简单/复杂免费定档,只有模糊中间档掉一次便宜模型判复杂度;模型失败永远回退启发式,永不崩、永不挂。

**Architecture:** `route()` = 纯启发式评分(`router-scoring.js`)→ 三档(simple/complex 免费短路、ambiguous 掉模型)。模型档复刻 planner 的「callModel → 取 JSON → 校验 → 有界重试 → 保守兜底」。启发式档**同步**返回(与今天逐字节一致),仅 ambiguous 档返回 `Promise`(`index.js` 已 `await`)。

**Tech Stack:** Node ESM(Node≥20)· node:test · 复用 `classifyMessage`(`src/core/planning/classifier.js`)· `modelGateway.invoke({purpose})`(`src/deepseek/`)。

## Global Constraints(每个 Task 隐含遵守)

- **`agent-runtime.js` 一行不改**;**`classifier.js` 不改**(只读 `classifyMessage().task_type`)。
- **路由确定性**:档位由程序逻辑定(`score` + `complexThreshold`),模型只在 ambiguous 档被调一次、只产 `lane`,不改档、不拆任务。
- **`signals` 与 `score` 严格分离**:`signals`(今天的 marker + 旧 FILE_TOKEN 文件计数)只在 disabled/裸构造路径决定 lane;`score`(加权 + 长 edit 捕手)只在 modelActive 路径决定档位。**长 edit 捕手永不进 `signals`**。
- **`modelActive = model.enabled !== false && typeof model.callModel === "function"`**。非 active → 走今天 signals-only(同步、无模型调用、无新事件、`lane` 逐字节一致)。⇒ 裸构造 `createTaskRouter()` = 今天。
- **模型档总调用 ≤ `maxRepairs + 1`**(`maxRepairs=0 ⇒ ≤1`);**总超时 = `timeoutMs` 跨所有重试**;畸形/超时/空网关/抛错**全收敛同一启发式兜底**(`signals.length>0?orchestrate:single`),回退带短码 `reason`(`router_model_timeout`/`_invalid`/`_empty`/`_error`),**异常全文不入事件**。
- **事件 eventBus 级**:`orchestration:route_resolved` 仅 modelActive 实际跑模型时 publish,**不改 `event-types.js`**(同现有 `orchestration:routed`)。`features` 已脱敏(无完整消息、列表截断)。
- **默认零回归**:`enabled:false` 或裸构造 → 现有 644 全绿不改。

---

## File Structure

| 文件 | 责任 | 动作 |
|------|------|------|
| `src/core/orchestration/router-scoring.js` | 纯函数:`normalizeFileToken` · `extractFeatures` · `computeScore` · `classifyBand` · `featuresForEvent` · 强/弱 marker 常量 | **新建** |
| `src/core/orchestration/task-router.js` | `route` 分层(modelActive 守卫 + 三档 + `modelTier` + `validateRouteVerdict` + `legacySignals`) | 改 |
| `src/config.js` | `DEFAULT_CONFIG.orchestration.router.model` + `normalizeOrchestration` 归一 model 子块 | 改 |
| `src/index.js` | 注入 `routerCallModel`(gateway `purpose:cfg.channel`)+ modelActive 跑模型时 publish `route_resolved` | 改 |
| `tests/core/orchestration/router-scoring.test.js` | M1 纯函数单测 | **新建** |
| `tests/core/orchestration/task-router.test.js` | 现有 4 测试**不改** + 追加模型档/档位/parity/narrowness 单测 | 改 |
| `tests/config-orchestration-router-model.test.js` | M3 config 归一化单测 | **新建** |
| `tests/core/orchestration/c-router-e2e.test.js` | M4 经 `createKernel` + mock gateway 真链路 | **新建** |
| docs(README 中英 / CHANGELOG / overview §14 / docs/README 索引) | M4 收口 | 改 |

---

## Task M1 · router-scoring.js(纯函数评分)

**Files:**
- Create: `src/core/orchestration/router-scoring.js`
- Test: `tests/core/orchestration/router-scoring.test.js`

**Interfaces (Produces):**
- `normalizeFileToken(tok: string) -> string`(`\`→`/`、去 `./`、折叠 `//`、小写)
- `extractFeatures(message, options, { markers }) -> { strong:string[], weak:string[], files:string[], longEdit:boolean, classification }`
- `computeScore(feat) -> number`(强×2 + 弱×1 + min(files,3) + longEdit)
- `classifyBand(score, complexThreshold) -> "simple"|"ambiguous"|"complex"`
- `featuresForEvent(feat) -> { strongMarkers, weak, files, fileScore, longEdit }`(脱敏 + 截断)
- 常量 `STRONG_MARKERS`、`DEFAULT_WEAK_MARKERS`、`LONG_EDIT_CHARS=80`

- [ ] **Step 1: 写失败测试** `tests/core/orchestration/router-scoring.test.js`

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeFileToken, extractFeatures, computeScore, classifyBand, featuresForEvent,
  STRONG_MARKERS, DEFAULT_WEAK_MARKERS
} from "../../../src/core/orchestration/router-scoring.js";

test("normalizeFileToken unifies separators/case/leading-dot", () => {
  assert.equal(normalizeFileToken("src\\foo.ts"), "src/foo.ts");
  assert.equal(normalizeFileToken("SRC/Foo.ts"), "src/foo.ts");
  assert.equal(normalizeFileToken("./a//b.js"), "a/b.js");
});

test("extractFeatures dedupes file tokens by normalized key", () => {
  const f = extractFeatures("touch src/foo.ts and src\\foo.ts", {}, { markers: DEFAULT_WEAK_MARKERS });
  assert.deepEqual(f.files, ["src/foo.ts"]);            // same path, both separators → 1
});

test("extractFeatures captures globs", () => {
  const f = extractFeatures("rename all *.ts under src/**", {}, { markers: DEFAULT_WEAK_MARKERS });
  assert.ok(f.files.includes("*.ts"));
  assert.ok(f.files.includes("src/**"));
});

test("computeScore: strong+2 weak+1 file+1(cap3) longEdit+1", () => {
  const strong = extractFeatures("迁移 重构整个", {}, { markers: [] });
  assert.equal(computeScore(strong), 4);               // 2 strong markers
  const weak = extractFeatures("这些 分别", {}, { markers: DEFAULT_WEAK_MARKERS });
  assert.equal(computeScore(weak), 2);                 // 2 weak
  const files = extractFeatures("a.ts b.ts c.ts d.ts", {}, { markers: [] });
  assert.equal(computeScore(files), 3);                // 4 files capped at 3
});

test("longEdit only for edit task_type and length>=80", () => {
  const long = "Please refactor and clean up the authentication module thoroughly and add input validation everywhere now";
  const f = extractFeatures(long, {}, { markers: [] });
  assert.equal(f.longEdit, true);
  assert.equal(computeScore(f), 1);                    // longEdit only, no markers/files
  const shortQ = extractFeatures("what is x?", {}, { markers: [] });
  assert.equal(shortQ.longEdit, false);
});

test("classifyBand boundaries", () => {
  assert.equal(classifyBand(0, 3), "simple");
  assert.equal(classifyBand(2, 3), "ambiguous");
  assert.equal(classifyBand(3, 3), "complex");
});

test("featuresForEvent redacts: counts + capped lists, no raw message", () => {
  const f = extractFeatures("迁移 a.ts b.ts c.ts d.ts", {}, { markers: [] });
  const ev = featuresForEvent(f);
  assert.equal(ev.fileScore, 3);
  assert.ok(ev.files.length <= 8);
  assert.equal(typeof ev.weak, "number");
  assert.ok(!("classification" in ev));                // no raw/derived message data
});
```

- [ ] **Step 2: 跑测试看失败** — `node --test tests/core/orchestration/router-scoring.test.js` → FAIL(模块不存在)。

- [ ] **Step 3: 写最小实现** `src/core/orchestration/router-scoring.js`

```js
import { classifyMessage } from "../planning/classifier.js";

// Strong complexity markers score +2; everything else configured scores +1 (weak).
export const STRONG_MARKERS = ["重构整个", "迁移", "跨多个文件", "跨文件", "refactor the entire", "migrate", "across multiple"];
export const DEFAULT_WEAK_MARKERS = ["这几个", "这些", "分别", "各自", "逐个", "逐一", "for each", "each of"];
export const LONG_EDIT_CHARS = 80;

const FILE_EXT = "js|mjs|cjs|jsx|ts|tsx|py|json|md";
const FILE_TOKEN = new RegExp(
  `[\\w.\\\\/-]*\\.(?:${FILE_EXT})\\b` +   // path?/name.ext  (src/foo.ts, src\foo.ts, foo.ts)
  `|\\*\\.(?:${FILE_EXT})` +               // *.ts
  `|[\\w.\\\\/-]+\\/\\*\\*?`,              // dir/* or dir/**
  "gi"
);

export function normalizeFileToken(tok) {
  return String(tok || "")
    .replace(/\\/g, "/")        // win32 sep → posix
    .replace(/^\.\//, "")       // strip leading ./
    .replace(/\/{2,}/g, "/")    // collapse repeated /
    .toLowerCase();
}

export function extractFeatures(message, options = {}, { markers = DEFAULT_WEAK_MARKERS } = {}) {
  const text = String(message || "");
  const lower = text.toLowerCase();
  const strong = STRONG_MARKERS.filter((m) => lower.includes(m.toLowerCase()));
  const weak = markers.filter((m) => !STRONG_MARKERS.includes(m)).filter((m) => lower.includes(m.toLowerCase()));
  const files = [...new Set((text.match(FILE_TOKEN) || []).map(normalizeFileToken))];
  const classification = classifyMessage(text, options);
  const longEdit = classification.task_type === "edit" && text.trim().length >= LONG_EDIT_CHARS;
  return { strong, weak, files, longEdit, classification };
}

export function computeScore(feat) {
  return feat.strong.length * 2
    + feat.weak.length
    + Math.min(feat.files.length, 3)
    + (feat.longEdit ? 1 : 0);
}

export function classifyBand(score, complexThreshold) {
  if (score <= 0) return "simple";
  if (score >= complexThreshold) return "complex";
  return "ambiguous";
}

// Event-safe projection: short tokens + counts only, never the raw message; lists capped.
export function featuresForEvent(feat) {
  return {
    strongMarkers: feat.strong.slice(0, 8),
    weak: feat.weak.length,
    files: feat.files.slice(0, 8),
    fileScore: Math.min(feat.files.length, 3),
    longEdit: feat.longEdit
  };
}
```

- [ ] **Step 4: 跑测试看通过** — `node --test tests/core/orchestration/router-scoring.test.js` → PASS。

- [ ] **Step 5: 提交**

```bash
git add src/core/orchestration/router-scoring.js tests/core/orchestration/router-scoring.test.js
git commit -m "feat(orchestration): router-scoring pure module (features/score/band, normalized file tokens)

```

---

## Task M2 · task-router.js 分层(模型档)

**Files:**
- Modify: `src/core/orchestration/task-router.js`(整体重写 `route`,保 `createTaskRouter({...}) -> { route }`)
- Test: `tests/core/orchestration/task-router.test.js`(现有 4 测试**不动**,追加新测试)

**Interfaces:**
- Consumes(M1):`extractFeatures` · `computeScore` · `classifyBand` · `featuresForEvent`
- Produces:`createTaskRouter({ minComplexFiles, markers, model: { enabled, callModel, timeoutMs, maxRepairs, complexThreshold }, now }) -> { route }`;`route(message, options) -> RoutingDecision | Promise<RoutingDecision>`,`RoutingDecision = { lane, reason, signals, score, features, band, tier, classification }`(`tier ∈ heuristic|model|fallback`)

- [ ] **Step 1: 写失败测试**(追加到 `tests/core/orchestration/task-router.test.js` 末尾)

```js
// ── C-Router 分层(模型档)──
const AMBIG = "把这些逻辑整理一下";                       // 弱 "这些" → score 1 → ambiguous
const SIMPLE = "hello";                                   // score 0
const COMPLEX = "重构整个项目并迁移到新框架";              // 强×2 → score 4
const LONG_EDIT = "Please refactor and clean up the authentication module thoroughly and add input validation everywhere now";

test("bare construct (no callModel) stays heuristic = today", () => {
  const r = createTaskRouter();
  assert.equal(r.route(LONG_EDIT).lane, "single");        // long-edit catcher NOT in signals
  assert.equal(r.route(AMBIG).lane, "orchestrate");       // weak marker is a today-signal
});

test("disabled: long-edit catcher does not change today's lane", () => {
  const r = createTaskRouter({ model: { enabled: false } });
  const d = r.route(LONG_EDIT);                            // sync (heuristic)
  assert.equal(d.lane, "single");
  assert.equal(d.tier, "heuristic");
});

test("enabled: simple/complex short-circuit with no model call", async () => {
  let calls = 0;
  const callModel = async () => { calls += 1; return '{"lane":"orchestrate"}'; };
  const r = createTaskRouter({ model: { enabled: true, callModel, complexThreshold: 3 } });
  assert.equal((await r.route(SIMPLE)).lane, "single");
  assert.equal((await r.route(COMPLEX)).lane, "orchestrate");
  assert.equal(calls, 0);                                  // confident bands are free
});

test("enabled: ambiguous consults model once, takes its lane", async () => {
  let calls = 0;
  const callModel = async () => { calls += 1; return '{"lane":"orchestrate","reason":"multi"}'; };
  const r = createTaskRouter({ model: { enabled: true, callModel, complexThreshold: 3 } });
  const d = await r.route(AMBIG);
  assert.equal(calls, 1);
  assert.equal(d.lane, "orchestrate");
  assert.equal(d.tier, "model");
});

test("narrowness fix: keyword-less long edit routes via model", async () => {
  const callModel = async () => '{"lane":"orchestrate","reason":"big refactor"}';
  const r = createTaskRouter({ model: { enabled: true, callModel, complexThreshold: 3 } });
  const d = await r.route(LONG_EDIT);
  assert.equal(d.band, "ambiguous");
  assert.equal(d.lane, "orchestrate");
});

test("malformed output retries then falls back (total calls <= maxRepairs+1)", async () => {
  let calls = 0;
  const callModel = async () => { calls += 1; return "not json"; };
  const r = createTaskRouter({ model: { enabled: true, callModel, maxRepairs: 1, complexThreshold: 3, now: () => 0 } });
  const d = await r.route(AMBIG);
  assert.equal(calls, 2);                                  // maxRepairs+1
  assert.equal(d.tier, "fallback");
  assert.equal(d.reason, "router_model_invalid");
  assert.equal(d.lane, "orchestrate");                     // signals(weak marker)>0 → fallback orchestrate
});

test("maxRepairs=0 ⇒ total calls <= 1", async () => {
  let calls = 0;
  const callModel = async () => { calls += 1; return "garbage"; };
  const r = createTaskRouter({ model: { enabled: true, callModel, maxRepairs: 0, complexThreshold: 3, now: () => 0 } });
  await r.route(AMBIG);
  assert.equal(calls, 1);
});

test("total timeout across retries → router_model_timeout fallback", async () => {
  let t = 1000, calls = 0;
  const now = () => t;
  const callModel = async () => { calls += 1; t += 5000; return "not json"; };  // each attempt burns 5s
  const r = createTaskRouter({ model: { enabled: true, callModel, timeoutMs: 8000, maxRepairs: 5, complexThreshold: 3, now } });
  const d = await r.route(AMBIG);
  assert.equal(d.reason, "router_model_timeout");
  assert.equal(calls, 2);                                  // 3rd attempt short-circuits on remaining<=0
});

test("empty gateway and thrown error both fall back", async () => {
  const empty = createTaskRouter({ model: { enabled: true, callModel: async () => "", complexThreshold: 3, now: () => 0 } });
  assert.equal((await empty.route(AMBIG)).reason, "router_model_empty");
  const thrown = createTaskRouter({ model: { enabled: true, callModel: async () => { throw new Error("boom"); }, complexThreshold: 3, now: () => 0 } });
  assert.equal((await thrown.route(AMBIG)).reason, "router_model_error");
});

test("invalid verdict lane is rejected (treated as malformed)", async () => {
  let calls = 0;
  const callModel = async () => { calls += 1; return '{"lane":"banana"}'; };
  const r = createTaskRouter({ model: { enabled: true, callModel, maxRepairs: 0, complexThreshold: 3, now: () => 0 } });
  const d = await r.route(AMBIG);
  assert.equal(d.tier, "fallback");
  assert.equal(d.reason, "router_model_invalid");
});
```

- [ ] **Step 2: 跑测试看失败** — `node --test tests/core/orchestration/task-router.test.js` → 新测试 FAIL,现有 4 PASS(裸构造未触发模型)。

- [ ] **Step 3: 写实现** `src/core/orchestration/task-router.js`(整体替换)

```js
import { extractFeatures, computeScore, classifyBand, featuresForEvent } from "./router-scoring.js";

const DEFAULT_MARKERS = [
  "这几个", "这些", "分别", "各自", "逐个", "逐一", "重构整个", "迁移", "跨多个文件", "跨文件",
  "for each", "each of", "across multiple", "refactor the entire", "migrate"
];
// Today's file-count signal regex — kept verbatim so disabled-path lane is byte-identical.
const LEGACY_FILE_TOKEN = /\b[\w.-]+\.(?:js|mjs|cjs|jsx|ts|tsx|py|json|md)\b/gi;

export function createTaskRouter({ minComplexFiles = 2, markers = DEFAULT_MARKERS, model = {}, now = () => Date.now() } = {}) {
  const { enabled = true, callModel = null, timeoutMs = 8000, maxRepairs = 1, complexThreshold = 3 } = model;
  const modelActive = enabled !== false && typeof callModel === "function";

  function legacySignals(text) {
    const signals = [];
    for (const m of markers) if (text.toLowerCase().includes(m.toLowerCase())) signals.push(`marker:${m}`);
    const files = new Set((text.match(LEGACY_FILE_TOKEN) || []).map((f) => f.toLowerCase()));
    if (files.size >= minComplexFiles) signals.push(`files:${files.size}`);
    return signals;
  }

  function decide(lane, tier, ctx) {
    return { lane, tier, reason: ctx.reason, signals: ctx.signals, score: ctx.score, band: ctx.band, features: featuresForEvent(ctx.feat), classification: ctx.feat.classification };
  }

  function route(message, options = {}) {
    const text = String(message || "");
    const feat = extractFeatures(text, options, { markers });
    const score = computeScore(feat);
    const band = classifyBand(score, complexThreshold);
    const signals = legacySignals(text);
    const heuristicLane = signals.length > 0 ? "orchestrate" : "single";

    if (!modelActive) {
      return decide(heuristicLane, "heuristic", { feat, score, band, signals, reason: heuristicLane === "orchestrate" ? "complexity signals present" : "no complexity signals" });
    }
    if (band === "simple") return decide("single", "heuristic", { feat, score, band, signals, reason: "band:simple" });
    if (band === "complex") return decide("orchestrate", "heuristic", { feat, score, band, signals, reason: "band:complex" });

    // ambiguous → model tier (async)
    return modelTier(text, feat).then((v) => v.ok
      ? decide(v.lane, "model", { feat, score, band, signals, reason: v.reason || "model" })
      : decide(heuristicLane, "fallback", { feat, score, band, signals, reason: v.reason }));
  }

  async function modelTier(message, feat) {
    const start = now();
    let feedback = null;
    for (let attempt = 0; attempt <= maxRepairs; attempt += 1) {
      const remaining = timeoutMs - (now() - start);
      if (remaining <= 0) return { ok: false, reason: "router_model_timeout" };
      let raw;
      try { raw = await callModel(routerPrompt(message, feat, feedback), { timeoutMs: remaining }); }
      catch (e) { return { ok: false, reason: isTimeout(e) ? "router_model_timeout" : "router_model_error" }; }
      if (!raw) return { ok: false, reason: "router_model_empty" };
      const v = validateRouteVerdict(extractJson(raw));
      if (v.ok) return v;
      feedback = 'reply ONLY {"lane":"single"|"orchestrate","reason":"..."}';
    }
    return { ok: false, reason: "router_model_invalid" };
  }

  return { route };
}

export function validateRouteVerdict(obj) {
  if (!obj || typeof obj !== "object") return { ok: false, reason: "router_model_invalid" };
  if (obj.lane !== "single" && obj.lane !== "orchestrate") return { ok: false, reason: "router_model_invalid" };
  return { ok: true, lane: obj.lane, reason: typeof obj.reason === "string" ? obj.reason.slice(0, 200) : "model" };
}

function routerPrompt(message, feat, feedback) {
  return [
    "Classify this coding request for routing.",
    "Answer single = one focused change or question; orchestrate = spans multiple files / sub-goals / a large refactor.",
    `Request: ${message}`,
    feat.files.length ? `Files mentioned: ${feat.files.join(", ")}` : "",
    'Reply with ONLY JSON: {"lane":"single"|"orchestrate","reason":"<short>"}',
    feedback ? `Previous attempt rejected: ${feedback}` : ""
  ].filter(Boolean).join("\n\n");
}

function isTimeout(e) { return Boolean(e) && (e.code === "MODEL_TIMEOUT" || /timeout/i.test(e.message || "")); }

function extractJson(text) {
  const s = String(text || "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}
```

- [ ] **Step 4: 跑测试看通过** — `node --test tests/core/orchestration/task-router.test.js` → 全 PASS(含现有 4)。

- [ ] **Step 5: 提交**

```bash
git add src/core/orchestration/task-router.js tests/core/orchestration/task-router.test.js
git commit -m "feat(orchestration): tiered task-router with model-assisted ambiguous tier

```

---

## Task M3 · config 归一化 + index 注入 + 事件

**Files:**
- Modify: `src/config.js`(`DEFAULT_CONFIG.orchestration.router.model` + `normalizeOrchestration`)
- Modify: `src/index.js`(注入 `routerCallModel` + publish `route_resolved`)
- Test: `tests/config-orchestration-router-model.test.js`(新建)

**Interfaces:**
- Consumes(M2):`createTaskRouter({ model: { ...cfg, callModel } })`
- Produces:`normalizeOrchestration(raw).router.model = { enabled:bool, channel:string, timeoutMs:posInt, maxRepairs:nonNegInt, complexThreshold:posInt }`

- [ ] **Step 1: 写失败测试** `tests/config-orchestration-router-model.test.js`

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeOrchestration } from "../src/config.js";

test("router.model defaults: enabled on, act channel, 8000/1/3", () => {
  const m = normalizeOrchestration({}).router.model;
  assert.deepEqual(m, { enabled: true, channel: "act", timeoutMs: 8000, maxRepairs: 1, complexThreshold: 3 });
});

test("router.model.enabled coerced to boolean", () => {
  assert.equal(normalizeOrchestration({ router: { model: { enabled: false } } }).router.model.enabled, false);
  assert.equal(normalizeOrchestration({ router: { model: { enabled: 0 } } }).router.model.enabled, false);
  assert.equal(normalizeOrchestration({ router: { model: { enabled: "yes" } } }).router.model.enabled, true);
});

test("router.model.maxRepairs is nonNegativeInt: 0 kept, negative/invalid → 1", () => {
  assert.equal(normalizeOrchestration({ router: { model: { maxRepairs: 0 } } }).router.model.maxRepairs, 0);
  assert.equal(normalizeOrchestration({ router: { model: { maxRepairs: -2 } } }).router.model.maxRepairs, 1);
  assert.equal(normalizeOrchestration({ router: { model: { maxRepairs: "x" } } }).router.model.maxRepairs, 1);
});

test("router.model.channel: any non-empty string passes through; blank → default", () => {
  assert.equal(normalizeOrchestration({ router: { model: { channel: "think" } } }).router.model.channel, "think");
  assert.equal(normalizeOrchestration({ router: { model: { channel: "" } } }).router.model.channel, "act");
  assert.equal(normalizeOrchestration({ router: { model: { channel: 7 } } }).router.model.channel, "act");
});

test("timeoutMs/complexThreshold posInt fallback; existing router fields kept", () => {
  const r = normalizeOrchestration({ router: { minComplexFiles: 4, model: { timeoutMs: 0, complexThreshold: -1 } } }).router;
  assert.equal(r.minComplexFiles, 4);
  assert.equal(r.model.timeoutMs, 8000);
  assert.equal(r.model.complexThreshold, 3);
});
```

- [ ] **Step 2: 跑测试看失败** — `node --test tests/config-orchestration-router-model.test.js` → FAIL(`model` undefined)。

- [ ] **Step 3: 改 `src/config.js`**

`DEFAULT_CONFIG.orchestration.router` 改为带 `model`:

```js
    router: {
      minComplexFiles: 2,
      markers: DEFAULT_ORCH_MARKERS,
      model: { enabled: true, channel: "act", timeoutMs: 8000, maxRepairs: 1, complexThreshold: 3 }
    },
```

`normalizeOrchestration` 的 `router` 块加 `model` 归一(在 `posInt` 旁加 `nonNegInt`/`bool`/`str` 局部助手):

```js
  const posInt = (v, fb) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fb; };
  const nonNegInt = (v, fb) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : fb; };
  const str = (v, fb) => (typeof v === "string" && v.trim() ? v : fb);
  const limOrNull = (v, fb) => (v === null ? null : posInt(v, fb));
  const rm = r.model && typeof r.model === "object" ? r.model : {};
  const dm = d.router.model;
  return {
    router: {
      minComplexFiles: posInt(r.minComplexFiles, d.router.minComplexFiles),
      markers: Array.isArray(r.markers) && r.markers.every((x) => typeof x === "string") ? r.markers : [...d.router.markers],
      model: {
        enabled: rm.enabled === undefined ? dm.enabled : Boolean(rm.enabled),
        channel: str(rm.channel, dm.channel),
        timeoutMs: posInt(rm.timeoutMs, dm.timeoutMs),
        maxRepairs: nonNegInt(rm.maxRepairs, dm.maxRepairs),
        complexThreshold: posInt(rm.complexThreshold, dm.complexThreshold)
      }
    },
    // ...(maxSubtasks/maxWorkerAttempts/maxRounds/budget/parallel 原样不动)
```

- [ ] **Step 4: 跑 config 测试看通过** — `node --test tests/config-orchestration-router-model.test.js` 及现有 `tests/config-orchestration*.test.js` 全 PASS。

- [ ] **Step 5: 改 `src/index.js`**

在 `const orch = normalizeOrchestration(...)` 后、`createTaskRouter` 处注入 callModel:

```js
  const orch = normalizeOrchestration(options.orchestration);
  const routerCallModel = async (prompt, { timeoutMs } = {}) => {
    if (!modelGateway?.invoke) return "";
    const res = await modelGateway.invoke([{ role: "user", content: prompt }], { purpose: orch.router.model.channel, timeoutMs });
    return res?.content || "";
  };
  const taskRouter = createTaskRouter({ ...orch.router, model: { ...orch.router.model, callModel: routerCallModel } });
```

`routedSend` 在 modelActive 实际跑模型时 publish `route_resolved`:

```js
  async function routedSend(message, sendOptions = {}) {
    const decision = await taskRouter.route(message, sendOptions);
    if (decision.tier === "model" || decision.tier === "fallback") {
      eventBus.publish("orchestration:route_resolved", {
        band: decision.band, score: decision.score, features: decision.features,
        finalLane: decision.lane, tier: decision.tier, reason: decision.reason
      });
    }
    if (decision.lane === "single") return runtime.send(message, sendOptions);
    eventBus.publish("orchestration:routed", { lane: decision.lane, reason: decision.reason, signals: decision.signals });
    return orchestrator.run({ message, options: sendOptions, routing: decision });
  }
```

> `decision.features` 已是 `featuresForEvent` 脱敏结果(M1/M2),直接入事件;`reason` 为短码或模型短理由,无异常全文。

- [ ] **Step 6: 跑 check + 提交**

```bash
npm run check
git add src/config.js src/index.js tests/config-orchestration-router-model.test.js
git commit -m "feat(orchestration): wire router model tier (config normalize + gateway inject + route_resolved event)

```

---

## Task M4 · e2e + 回归 + 文档

**Files:**
- Test: `tests/core/orchestration/c-router-e2e.test.js`(新建)
- Modify: docs(README 中英 / CHANGELOG / project-overview §14 / docs/README 索引)

- [ ] **Step 1: 写 e2e 失败测试** `tests/core/orchestration/c-router-e2e.test.js`

构造 `createKernel` + mock `modelGateway`(注入路径同现有 orchestration e2e:参照 `tests/core/orchestration/c5-rounds-e2e.test.js` 的 kernel 装配 + mock gateway 方式),断言:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createKernel } from "../../../src/index.js";
// (沿用现有 e2e 的 mock gateway 装配 helper / 临时 sessionRoot)

test("ambiguous request consults model → orchestrate path runs", async () => {
  // mock gateway: router triage 调用(purpose=act)返回 {"lane":"orchestrate"};
  // 后续 planner/worker 调用走既有 mock。断言:收到 orchestration:route_resolved 事件(tier=model)
  // 且 orchestrate 链路启动。
});

test("router.model.enabled=false → byte-identical to today (no route_resolved, no model triage call)", async () => {
  // 同一模糊请求,enabled:false → 无 route_resolved 事件、无 act-purpose triage 调用;lane 同今天。
});

test("model triage timeout/garbage → heuristic fallback, no crash", async () => {
  // mock gateway 对 act-purpose 调用抛 MODEL_TIMEOUT / 返回非 JSON → 回退启发式,turn 正常完成。
});
```

> e2e 装配细节(临时 sessionRoot、mock gateway 的 `invoke` 按 `purpose` 分流、`supervised`/`auto` autonomy)**照搬** `tests/core/orchestration/c5-rounds-e2e.test.js` 与 `c3-parallel-e2e.test.js` 既有范式,避免另起炉灶。

- [ ] **Step 2: 跑 e2e 看失败 → 实现到通过**(实现已在 M2/M3 完成,e2e 主要验证装配正确;若发现接线缺口在此补)。

- [ ] **Step 3: 全量回归** — `npm test`(期望 **≥665 全绿**:644 + M1/M2/M3/M4 新增)+ `npm run check` + `git diff --check`。

- [ ] **Step 4: 文档**(按 docs/README 维护顺序:overview → CHANGELOG → README 中英 → 索引)

- `docs/project-overview.md`:§14 多智能体编排下补 **§14.3 分层路由(C-Router)**(默认开 + opt-out + 三档 + 模型档兜底 + route_resolved 事件)。
- `docs/CHANGELOG.md`:加「已落地 — Phase C-Router 分层路由」条目(默认开、三档、总超时/总调用上限、disabled-parity、测试数)。
- 根 `README.md` + `README.en.md`:多智能体编排段补一句「模糊请求经模型辅助判复杂度(默认开,可 `router.model.enabled=false` 关)」——中英同步。
- `docs/README.md`:specs 索引加 C-Router design 行、plans 索引加本计划行。

- [ ] **Step 5: 提交**(文档 + e2e 两笔或合一,均带署名)

```bash
git add tests/core/orchestration/c-router-e2e.test.js
git commit -m "test(orchestration): C-Router e2e (model triage / disabled-parity / fallback)

git add docs/
git commit -m "docs: ship V3 Phase C-Router tiered routing (overview/CHANGELOG/README/index)

```

---

## Self-Review(写完计划回扫)

- **Spec 覆盖**:§3 分层 → M2;§4.1 signals/score 分离 → M2 `legacySignals`(旧 regex)+ M1 新提取;§4.2 归一化 → M1;§4.3 可解释/脱敏 → M1 `featuresForEvent` + M3 事件;§4.4 总上限/不分叉/短码 → M2 `modelTier`;§4.5 verdict schema → M2 `validateRouteVerdict`;§4.6/§9 事件不登记 → M3;§4.7 modelActive/裸构造 → M2;§5 评分 → M1;§6 模型档 → M2;§7 组件 → M1–M3;§8 config → M3;§10 测试 → 全程;§11 里程碑 ↔ M1–M4。**无遗漏**。
- **Placeholder 扫描**:M1–M3 全为可运行代码;M4 e2e 装配引用现有 `c5-rounds-e2e`/`c3-parallel-e2e` 范式(非占位,是「照此装配」的明确指向),M4 实现步骤主要验证接线。
- **类型一致**:`RoutingDecision` 字段(`lane/tier/reason/signals/score/band/features/classification`)在 M2 产出、M3 事件消费一致;`featuresForEvent` 形状(`strongMarkers/weak/files/fileScore/longEdit`)M1 定义、M3 直用;`model` 配置形状 M3 定义、M2 消费一致(`enabled/callModel/timeoutMs/maxRepairs/complexThreshold` + 注入 `now`)。
- **零回归口**:`enabled:false` 与裸构造在 M2 同走 `legacySignals` 同步路径;现有 4 router 测试 + 644 全绿不改。

---

## 实施偏差(as-built,落地后回填)

1. **文件计分「首个免计」**:`computeScore`/`featuresForEvent` 的文件项由 `min(files,3)` 改为 **`min(max(files-1,0),3)`**。集成测试 `v2-runtime-context` 暴露:单文件请求(`modify src/index.js`)原会 score 1 → ambiguous → 白白触发模型 triage 抢占"首个 model 调用"。单文件本就非复杂度信号(对齐 `minComplexFiles=2`),首个免计后 = score 0 = simple = 单 agent 零调用。新增 router-scoring 边界单测钉死(1→0、2→1、cap3)。对应提交 `fix(orchestration): single file mention is not a complexity signal`。
2. **`now` 时钟为顶层注入**:`createTaskRouter({ ..., now })` 顶层参数(非 `model.now`)—— `now` 是时钟注入基础设施,不属 model 配置(config/index 均不产 `model.now`)。M2 测试片段里把 `now` 写进 `model` 是笔误,落地时置于顶层。
3. **最终测试数**:M1 router-scoring 8 + M2 task-router 14(现有 4 不改)+ M3 config 5 + M4 e2e 3,全量 **670 全绿**、check OK、diff-check OK。
