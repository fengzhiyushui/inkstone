# V3 Phase C1+C2 多智能体编排 Implementation Plan

> 完成状态以 [CHANGELOG](../../CHANGELOG.md) 为准。


**Goal:** 把「单 agent」与「多 agent」合并为一条路 —— `kernel.send()` 经确定性路由器:简单任务走今天的 `agentRuntime.send()`(零回归),复杂任务走 Orchestrator(Planner 拆 → 串行 Worker 执行 → 两级审核 → 汇总),Worker/Reviewer 复用 `agent-runtime` 实例。

**Architecture:** 在 `agent-runtime` 公开边界 `send()` 之上组合一个 `src/core/orchestration/` 层。Orchestrator 持有 Planner + 确定性派发循环,用注入的 `createRuntime` 工厂造 Worker(工具子集 `edit`)与 Reviewer(工具子集 `readonly`)。编排由程序逻辑读结构化结果(`wres.status` / `verdict.pass`)决策;模型只在 planner/worker/reviewer/synth 节点内被调。`agent-runtime.js` 一行不改。

**Tech Stack:** Node ESM (Node ≥ 20)、`node:test`、复用 `createAgentRuntime` / `createCostBudget` / `createToolRegistry.toDeepSeekTools` / `classifyMessage`。无新运行时依赖。

## Global Constraints

- **`src/core/runtime/agent-runtime.js` 一行不改** —— Worker/Reviewer 都是它的实例,只在公开边界 `send(message, options) → { status, content, turn, verification }` 之上组合。
- **编排确定性** —— 派/收/打回由程序逻辑读结构化结果(`wres.status`、`verdict.pass`),模型只在 planner/worker/reviewer/synth **节点内**被调,不负责「派谁、要不要再来一轮」。
- **路由器确定性启发式** —— 无模型调用、**无 on/off 开关**;默认 `single`,够强信号才 `orchestrate`;阈值可配。
- **Reviewer 恒 `readonly`** —— 工具子集物理排除一切 write/edit/git/shell,审核者不可改。
- **成本闸常开** —— `maxSubtasks` / `maxWorkerAttempts` / 聚合预算命中 → **优雅停止 + 部分完成诚实收尾,不抛、不崩**(沿用 V2-20b 语义)。
- **默认行为零回归** —— 简单档 = 今天的 `runtime.send()` 原样;`single` 档**不发任何 orchestration 事件**;现有 559 测试全绿。
- **dispatch-loop 用注入工厂** → 纯 mock 可测、不打真模型。
- **`node:test`**;每个 task 末尾跑测试 + 提交。

## Shared Interfaces(全任务一致)

```text
// subtask-schema.js
validatePlan(obj)     -> { ok:boolean, plan?:Plan, error?:string }
validateVerdict(obj)  -> { ok:boolean, verdict?:Verdict, error?:string }
topoOrder(subtasks)   -> SubTask[]            // 抛 { code:"CYCLE" } 若有环
hasCycle(subtasks)    -> boolean
SubTask  = { id, goal, acceptance:string[], context_scope:{files?,symbols?}, tool_profile:"edit"|"readonly", depends_on:string[] }
Plan     = { task_summary, subtasks:SubTask[], done_when }
Verdict  = { pass:boolean, severity:"block"|"warn", reasons:string[], checked:string[] }

// task-router.js
createTaskRouter({ minComplexFiles, markers }) -> { route(message, options) -> RoutingDecision }
RoutingDecision = { lane:"single"|"orchestrate", reason, signals:string[], classification }

// tool-profiles.js
TOOL_PROFILES = { readonly:Set<string>, edit:Set<string> }
filterToolSchemas(schemas, profile) -> schemas[]   // 按 .function.name 过滤

// worker-factory.js
createWorkerFactory({ createRuntime, baseToolSchemas, makeContextSnapshot }) -> { worker(subtask)->runtime, reviewerRuntime()->runtime }

// reviewer.js
createReviewer({ runtime }) -> { review(subtask, workerResult) -> Verdict }

// planner.js
createPlanner({ callModel, maxPlanRepairs }) -> { plan({ message, context }) -> Plan }   // callModel(prompt)->string

// synthesizer.js
createSynthesizer({ callModel }) -> { synthesize({ message, collected }) -> string }

// dispatch-loop.js
runDispatchLoop({ plan, workerFactory, makeReviewer, synthesizer, budget, maxWorkerAttempts, autonomy, onEvent })
   -> { status:"complete"|"awaiting_approval", content?, approval?, collected }

// orchestrator.js
createOrchestrator({ planner, makeWorkerFactory, makeReviewer, synthesizer, makeBudget, config, eventBus, makeContext })
   -> { run({ message, options, routing }) -> { status, content, turn?, collected } }
```

---

# 里程碑 M1 · schema + 路由器 + 配置

## Task 1: subtask-schema(Plan/SubTask/Verdict 校验 + topo)

**Files:**
- Create: `src/core/orchestration/subtask-schema.js`
- Test: `tests/core/orchestration/subtask-schema.test.js`

**Interfaces:**
- Produces:`validatePlan` / `validateVerdict` / `topoOrder` / `hasCycle`(见 Shared)。手写校验,无依赖。

- [ ] **Step 1: 写失败测试**

```js
// tests/core/orchestration/subtask-schema.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { validatePlan, validateVerdict, topoOrder, hasCycle } from "../../../src/core/orchestration/subtask-schema.js";

const goodPlan = {
  task_summary: "add validation to 2 modules",
  done_when: "both modules validate inputs",
  subtasks: [
    { id: "st_1", goal: "validate a", acceptance: ["a rejects empty"], context_scope: { files: ["a.js"] }, tool_profile: "edit", depends_on: [] },
    { id: "st_2", goal: "validate b", acceptance: ["b rejects empty"], context_scope: {}, tool_profile: "edit", depends_on: ["st_1"] }
  ]
};

test("validatePlan accepts a well-formed plan", () => {
  const r = validatePlan(goodPlan);
  assert.equal(r.ok, true);
  assert.equal(r.plan.subtasks.length, 2);
});

test("validatePlan rejects missing fields", () => {
  assert.equal(validatePlan({}).ok, false);
  assert.equal(validatePlan({ task_summary: "x", done_when: "y", subtasks: [{ id: "st_1" }] }).ok, false);
  assert.equal(validatePlan({ task_summary: "x", done_when: "y", subtasks: [{ id: "st_1", goal: "g", acceptance: [], context_scope: {}, tool_profile: "nope", depends_on: [] }] }).ok, false);
});

test("topoOrder sorts by depends_on; hasCycle detects loops", () => {
  const order = topoOrder(goodPlan.subtasks).map((s) => s.id);
  assert.deepEqual(order, ["st_1", "st_2"]);
  assert.equal(hasCycle(goodPlan.subtasks), false);
  const cyclic = [
    { id: "a", goal: "g", acceptance: [], context_scope: {}, tool_profile: "edit", depends_on: ["b"] },
    { id: "b", goal: "g", acceptance: [], context_scope: {}, tool_profile: "edit", depends_on: ["a"] }
  ];
  assert.equal(hasCycle(cyclic), true);
  assert.throws(() => topoOrder(cyclic), (e) => e.code === "CYCLE");
});

test("validateVerdict accepts/rejects", () => {
  assert.equal(validateVerdict({ pass: true, severity: "warn", reasons: [], checked: ["ran tests"] }).ok, true);
  assert.equal(validateVerdict({ pass: "yes" }).ok, false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/core/orchestration/subtask-schema.test.js`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现**

```js
// src/core/orchestration/subtask-schema.js
const TOOL_PROFILE_VALUES = new Set(["edit", "readonly"]);
const SEVERITY_VALUES = new Set(["block", "warn"]);

function isStr(v) { return typeof v === "string" && v.length > 0; }
function isStrArray(v) { return Array.isArray(v) && v.every((x) => typeof x === "string"); }

export function validateSubTask(st) {
  if (!st || typeof st !== "object") return "subtask not an object";
  if (!isStr(st.id)) return "subtask.id missing";
  if (!isStr(st.goal)) return `subtask ${st.id}: goal missing`;
  if (!isStrArray(st.acceptance)) return `subtask ${st.id}: acceptance not string[]`;
  if (!st.context_scope || typeof st.context_scope !== "object") return `subtask ${st.id}: context_scope missing`;
  if (!TOOL_PROFILE_VALUES.has(st.tool_profile)) return `subtask ${st.id}: bad tool_profile`;
  if (!isStrArray(st.depends_on)) return `subtask ${st.id}: depends_on not string[]`;
  return null;
}

export function validatePlan(obj) {
  if (!obj || typeof obj !== "object") return { ok: false, error: "plan not an object" };
  if (!isStr(obj.task_summary)) return { ok: false, error: "task_summary missing" };
  if (!isStr(obj.done_when)) return { ok: false, error: "done_when missing" };
  if (!Array.isArray(obj.subtasks) || obj.subtasks.length === 0) return { ok: false, error: "subtasks empty" };
  const ids = new Set();
  for (const st of obj.subtasks) {
    const err = validateSubTask(st);
    if (err) return { ok: false, error: err };
    if (ids.has(st.id)) return { ok: false, error: `duplicate subtask id ${st.id}` };
    ids.add(st.id);
  }
  for (const st of obj.subtasks) {
    for (const dep of st.depends_on) if (!ids.has(dep)) return { ok: false, error: `${st.id} depends on unknown ${dep}` };
  }
  return { ok: true, plan: obj };
}

export function validateVerdict(obj) {
  if (!obj || typeof obj !== "object") return { ok: false, error: "verdict not an object" };
  if (typeof obj.pass !== "boolean") return { ok: false, error: "verdict.pass not boolean" };
  if (!SEVERITY_VALUES.has(obj.severity)) return { ok: false, error: "verdict.severity invalid" };
  if (!isStrArray(obj.reasons)) return { ok: false, error: "verdict.reasons not string[]" };
  if (!isStrArray(obj.checked)) return { ok: false, error: "verdict.checked not string[]" };
  return { ok: true, verdict: obj };
}

export function hasCycle(subtasks) {
  try { topoOrder(subtasks); return false; } catch (e) { if (e.code === "CYCLE") return true; throw e; }
}

export function topoOrder(subtasks) {
  const byId = new Map(subtasks.map((s) => [s.id, s]));
  const state = new Map(); // id -> 0 unseen|1 visiting|2 done
  const out = [];
  function visit(id) {
    const st = byId.get(id);
    if (!st) return;
    const s = state.get(id) || 0;
    if (s === 2) return;
    if (s === 1) { const err = new Error(`dependency cycle at ${id}`); err.code = "CYCLE"; throw err; }
    state.set(id, 1);
    for (const dep of st.depends_on) visit(dep);
    state.set(id, 2);
    out.push(st);
  }
  for (const st of subtasks) visit(st.id);
  return out;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/core/orchestration/subtask-schema.test.js`
Expected: PASS

- [ ] **Step 5: 提交(含 src → 不加署名)**

```bash
git add src/core/orchestration/subtask-schema.js tests/core/orchestration/subtask-schema.test.js
git commit -m "feat(orchestration): Plan/SubTask/Verdict schema + topo order"
```

---

## Task 2: task-router(确定性启发式 → RoutingDecision)

**Files:**
- Create: `src/core/orchestration/task-router.js`
- Test: `tests/core/orchestration/task-router.test.js`

**Interfaces:**
- Consumes:`classifyMessage`(`src/core/planning/classifier.js`)。
- Produces:`createTaskRouter({ minComplexFiles=2, markers }) -> { route(message, options) -> RoutingDecision }`。保守:默认 `single`,markers 命中或 ≥`minComplexFiles` 个不同文件类 token 才 `orchestrate`。无模型调用。

- [ ] **Step 1: 写失败测试**

```js
// tests/core/orchestration/task-router.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTaskRouter } from "../../../src/core/orchestration/task-router.js";

test("simple messages route to single (zero-regression default)", () => {
  const r = createTaskRouter();
  assert.equal(r.route("what does this function do?").lane, "single");
  assert.equal(r.route("fix the typo in a.js").lane, "single"); // 1 file, no markers
});

test("multiplicity markers route to orchestrate", () => {
  const r = createTaskRouter();
  const d = r.route("给这几个模块分别加输入校验");
  assert.equal(d.lane, "orchestrate");
  assert.ok(d.signals.length > 0);
});

test("multiple file mentions route to orchestrate", () => {
  const r = createTaskRouter({ minComplexFiles: 2 });
  assert.equal(r.route("update a.js and b.js and c.js to use the new api").lane, "orchestrate");
  assert.equal(r.route("update a.js").lane, "single");
});

test("classification is carried through", () => {
  const r = createTaskRouter();
  assert.equal(r.route("explain x").classification.task_type, "query");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/core/orchestration/task-router.test.js`
Expected: FAIL

- [ ] **Step 3: 实现**

```js
// src/core/orchestration/task-router.js
import { classifyMessage } from "../planning/classifier.js";

const DEFAULT_MARKERS = [
  "这几个", "这些", "分别", "各自", "逐个", "逐一", "重构整个", "迁移", "跨多个文件", "跨文件",
  "for each", "each of", "across multiple", "refactor the entire", "migrate"
];
const FILE_TOKEN = /\b[\w.-]+\.(?:js|mjs|cjs|jsx|ts|tsx|py|json|md)\b/gi;

export function createTaskRouter({ minComplexFiles = 2, markers = DEFAULT_MARKERS } = {}) {
  function route(message, options = {}) {
    const classification = classifyMessage(message, options);
    const text = String(message || "");
    const signals = [];
    for (const m of markers) if (text.toLowerCase().includes(m.toLowerCase())) signals.push(`marker:${m}`);
    const files = new Set((text.match(FILE_TOKEN) || []).map((f) => f.toLowerCase()));
    if (files.size >= minComplexFiles) signals.push(`files:${files.size}`);
    const lane = signals.length > 0 ? "orchestrate" : "single";
    return {
      lane,
      reason: lane === "orchestrate" ? "complexity signals present" : "no complexity signals",
      signals,
      classification
    };
  }
  return { route };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/core/orchestration/task-router.test.js`
Expected: PASS

- [ ] **Step 5: 提交(含 src → 不加署名)**

```bash
git add src/core/orchestration/task-router.js tests/core/orchestration/task-router.test.js
git commit -m "feat(orchestration): deterministic task-router (single|orchestrate, no model call)"
```

---

## Task 3: config.orchestration 归一化

**Files:**
- Modify: `src/config.js`(`DEFAULT_CONFIG` + `normalizeConfig` + 新 `normalizeOrchestration`)
- Test: `tests/config-orchestration.test.js`

**Interfaces:**
- Produces:`DEFAULT_CONFIG.orchestration = { router:{ minComplexFiles:2, markers:[...] }, maxSubtasks:8, maxWorkerAttempts:2, budget:{ maxTokens:null, maxModelCalls:40 } }`;`normalizeOrchestration(raw)` per-field 深合并 + 安全默认。**无 `enabled` 字段**(路由全权判)。

- [ ] **Step 1: 写失败测试**

```js
// tests/config-orchestration.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeOrchestration, DEFAULT_CONFIG } from "../src/config.js";

test("defaults: no enabled flag; safe gates", () => {
  const o = DEFAULT_CONFIG.orchestration;
  assert.equal("enabled" in o, false);
  assert.equal(o.maxSubtasks, 8);
  assert.equal(o.maxWorkerAttempts, 2);
  assert.equal(o.router.minComplexFiles, 2);
  assert.equal(o.budget.maxModelCalls, 40);
});

test("normalizeOrchestration deep-merges per field, clamps to safe", () => {
  const o = normalizeOrchestration({ maxSubtasks: 3, router: { minComplexFiles: 5 }, budget: { maxModelCalls: 100 } });
  assert.equal(o.maxSubtasks, 3);
  assert.equal(o.router.minComplexFiles, 5);
  assert.equal(o.budget.maxModelCalls, 100);
  assert.equal(o.maxWorkerAttempts, 2);            // untouched default
  assert.ok(Array.isArray(o.router.markers));      // default markers preserved
});

test("invalid values fall back to defaults", () => {
  const o = normalizeOrchestration({ maxSubtasks: -1, maxWorkerAttempts: 0 });
  assert.equal(o.maxSubtasks, 8);
  assert.equal(o.maxWorkerAttempts, 2);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/config-orchestration.test.js`
Expected: FAIL

- [ ] **Step 3: 实现** —— `DEFAULT_CONFIG` 加 `orchestration` 字段;`normalizeConfig` 返回对象加 `orchestration: normalizeOrchestration(config.orchestration)`;新增 helper(放 `normalizeContext` 之后):

```js
const DEFAULT_ORCH_MARKERS = [
  "这几个", "这些", "分别", "各自", "逐个", "逐一", "重构整个", "迁移", "跨多个文件", "跨文件",
  "for each", "each of", "across multiple", "refactor the entire", "migrate"
];

export function normalizeOrchestration(raw = {}) {
  const safe = raw && typeof raw === "object" ? raw : {};
  const d = DEFAULT_CONFIG.orchestration;
  const r = safe.router && typeof safe.router === "object" ? safe.router : {};
  const b = safe.budget && typeof safe.budget === "object" ? safe.budget : {};
  const posInt = (v, fb) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fb; };
  const limOrNull = (v, fb) => (v === null ? null : posInt(v, fb));
  return {
    router: {
      minComplexFiles: posInt(r.minComplexFiles, d.router.minComplexFiles),
      markers: Array.isArray(r.markers) && r.markers.every((x) => typeof x === "string") ? r.markers : [...d.router.markers]
    },
    maxSubtasks: posInt(safe.maxSubtasks, d.maxSubtasks),
    maxWorkerAttempts: posInt(safe.maxWorkerAttempts, d.maxWorkerAttempts),
    budget: {
      maxTokens: b.maxTokens === undefined ? d.budget.maxTokens : limOrNull(b.maxTokens, d.budget.maxTokens),
      maxModelCalls: b.maxModelCalls === undefined ? d.budget.maxModelCalls : limOrNull(b.maxModelCalls, d.budget.maxModelCalls)
    }
  };
}
```

`DEFAULT_CONFIG.orchestration`:

```js
  orchestration: {
    router: { minComplexFiles: 2, markers: DEFAULT_ORCH_MARKERS },
    maxSubtasks: 8,
    maxWorkerAttempts: 2,
    budget: { maxTokens: null, maxModelCalls: 40 }
  }
```

- [ ] **Step 4: 跑测试 + 现有 config 回归**

Run: `node --test tests/config-orchestration.test.js tests/config-context-semantic.test.js`
Expected: 全 PASS

- [ ] **Step 5: 提交(含 src → 不加署名)**

```bash
git add src/config.js tests/config-orchestration.test.js
git commit -m "feat(config): orchestration gates (router/maxSubtasks/maxWorkerAttempts/budget, no enable flag)"
```

---

# 里程碑 M2 · 工具子集 + worker/reviewer 工厂

## Task 4: tool-profiles(edit / readonly 过滤)

**Files:**
- Create: `src/core/orchestration/tool-profiles.js`
- Test: `tests/core/orchestration/tool-profiles.test.js`

**Interfaces:**
- Produces:`TOOL_PROFILES`(`readonly`/`edit` 的名字集合)、`filterToolSchemas(schemas, profile)`(按 `.function.name` 过滤)。`readonly` 物理排除 edit/diff_apply/diff_rollback/git/shell/memory/web_fetch。

- [ ] **Step 1: 写失败测试**

```js
// tests/core/orchestration/tool-profiles.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOL_PROFILES, filterToolSchemas } from "../../../src/core/orchestration/tool-profiles.js";

const ALL = ["read", "ls", "grep", "glob", "test", "diff_preview", "edit", "diff_apply", "diff_rollback", "git", "shell", "memory", "web_fetch"]
  .map((name) => ({ type: "function", function: { name } }));

test("readonly excludes every write/edit/shell tool", () => {
  const names = filterToolSchemas(ALL, "readonly").map((s) => s.function.name);
  for (const forbidden of ["edit", "diff_apply", "diff_rollback", "git", "shell", "memory", "web_fetch"]) {
    assert.equal(names.includes(forbidden), false, `readonly must exclude ${forbidden}`);
  }
  assert.ok(names.includes("read") && names.includes("test"));
});

test("edit includes the edit + diff_apply tools", () => {
  const names = filterToolSchemas(ALL, "edit").map((s) => s.function.name);
  assert.ok(names.includes("edit") && names.includes("diff_apply") && names.includes("git"));
  assert.ok(names.includes("read") && names.includes("test"));
});

test("unknown profile falls back to readonly", () => {
  const names = filterToolSchemas(ALL, "nope").map((s) => s.function.name);
  assert.equal(names.includes("edit"), false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/core/orchestration/tool-profiles.test.js`
Expected: FAIL

- [ ] **Step 3: 实现**

```js
// src/core/orchestration/tool-profiles.js
// Tool names come from src/tools/builtin/*: read ls grep glob shell test git
// web_fetch memory task ask_user diff_preview diff_apply diff_rollback edit.
const READONLY = ["read", "ls", "grep", "glob", "test", "diff_preview"];
const EDIT = [...READONLY, "edit", "diff_apply", "diff_rollback", "git"];

export const TOOL_PROFILES = {
  readonly: new Set(READONLY),
  edit: new Set(EDIT)
};

export function filterToolSchemas(schemas, profile) {
  const allow = TOOL_PROFILES[profile] || TOOL_PROFILES.readonly;
  return (schemas || []).filter((s) => allow.has(s?.function?.name));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/core/orchestration/tool-profiles.test.js`
Expected: PASS

- [ ] **Step 5: 提交(含 src → 不加署名)**

```bash
git add src/core/orchestration/tool-profiles.js tests/core/orchestration/tool-profiles.test.js
git commit -m "feat(orchestration): tool-profiles (edit/readonly schema filters)"
```

---

## Task 5: worker-factory(注入 createRuntime 造 worker/reviewer 实例)

**Files:**
- Create: `src/core/orchestration/worker-factory.js`
- Test: `tests/core/orchestration/worker-factory.test.js`

**Interfaces:**
- Consumes:`filterToolSchemas`(Task 4)。
- Produces:`createWorkerFactory({ createRuntime, baseToolSchemas, makeContextSnapshot }) -> { worker(subtask)->runtime, reviewerRuntime()->runtime }`。`createRuntime(overrides)` 由调用方注入(真实 = `createAgentRuntime({ ...baseConfig, ...overrides })`);worker 注入 `edit` 子集 schemas + 作用域 snapshot;reviewer 注入 `readonly` 子集。

- [ ] **Step 1: 写失败测试**

```js
// tests/core/orchestration/worker-factory.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorkerFactory } from "../../../src/core/orchestration/worker-factory.js";

const ALL = ["read", "test", "edit", "git", "diff_apply"].map((name) => ({ type: "function", function: { name } }));

function makeFactory() {
  const created = [];
  const createRuntime = (overrides) => { created.push(overrides); return { id: created.length, overrides }; };
  const factory = createWorkerFactory({
    createRuntime,
    baseToolSchemas: () => ALL,
    makeContextSnapshot: async (input) => ({ scope: input.scope })
  });
  return { factory, created };
}

test("worker gets edit profile schemas + scoped snapshot", async () => {
  const { factory } = makeFactory();
  const st = { id: "st_1", tool_profile: "edit", context_scope: { files: ["a.js"] } };
  const w = factory.worker(st);
  const names = w.overrides.toolSchemas().map((s) => s.function.name);
  assert.ok(names.includes("edit") && names.includes("read"));
  const snap = await w.overrides.createContextSnapshot({ message: "x" });
  assert.deepEqual(snap.scope, { files: ["a.js"] });
});

test("reviewerRuntime gets readonly schemas (no edit/git)", () => {
  const { factory } = makeFactory();
  const r = factory.reviewerRuntime();
  const names = r.overrides.toolSchemas().map((s) => s.function.name);
  assert.equal(names.includes("edit"), false);
  assert.equal(names.includes("git"), false);
  assert.ok(names.includes("read") && names.includes("test"));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/core/orchestration/worker-factory.test.js`
Expected: FAIL

- [ ] **Step 3: 实现**

```js
// src/core/orchestration/worker-factory.js
import { filterToolSchemas } from "./tool-profiles.js";

export function createWorkerFactory({ createRuntime, baseToolSchemas, makeContextSnapshot }) {
  function worker(subtask) {
    return createRuntime({
      toolSchemas: () => filterToolSchemas(baseToolSchemas(), subtask.tool_profile),
      createContextSnapshot: (input) => makeContextSnapshot({ ...input, scope: subtask.context_scope || {} })
    });
  }
  function reviewerRuntime() {
    return createRuntime({
      toolSchemas: () => filterToolSchemas(baseToolSchemas(), "readonly")
    });
  }
  return { worker, reviewerRuntime };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/core/orchestration/worker-factory.test.js`
Expected: PASS

- [ ] **Step 5: 提交(含 src → 不加署名)**

```bash
git add src/core/orchestration/worker-factory.js tests/core/orchestration/worker-factory.test.js
git commit -m "feat(orchestration): worker-factory (edit worker + readonly reviewer runtimes)"
```

---

## Task 6: reviewer(独立复查 → Verdict)

**Files:**
- Create: `src/core/orchestration/reviewer.js`
- Test: `tests/core/orchestration/reviewer.test.js`

**Interfaces:**
- Consumes:一个 `readonly` runtime(`runtime.send`)、`validateVerdict`(Task 1)。
- Produces:`createReviewer({ runtime }) -> { review(subtask, workerResult) -> Verdict }`。runtime 输出 JSON → `validateVerdict`;校验不出 → 保守 `{ pass:false, severity:"warn", reasons:["verdict unparseable"], checked:[] }`。

- [ ] **Step 1: 写失败测试**

```js
// tests/core/orchestration/reviewer.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createReviewer } from "../../../src/core/orchestration/reviewer.js";

function runtimeReturning(content) { return { send: async () => ({ status: "complete", content }) }; }

test("parses a valid verdict from runtime output", async () => {
  const r = createReviewer({ runtime: runtimeReturning('{"pass":true,"severity":"warn","reasons":[],"checked":["ran tests"]}') });
  const v = await r.review({ id: "st_1", acceptance: ["x"] }, { content: "did the thing" });
  assert.equal(v.pass, true);
});

test("unparseable output -> conservative warn fail", async () => {
  const r = createReviewer({ runtime: runtimeReturning("looks fine to me, no JSON here") });
  const v = await r.review({ id: "st_1", acceptance: ["x"] }, { content: "x" });
  assert.equal(v.pass, false);
  assert.equal(v.severity, "warn");
});

test("extracts JSON embedded in prose", async () => {
  const r = createReviewer({ runtime: runtimeReturning('Verdict: {"pass":false,"severity":"block","reasons":["missing test"],"checked":["read diff"]} done') });
  const v = await r.review({ id: "st_1", acceptance: ["x"] }, { content: "x" });
  assert.equal(v.pass, false);
  assert.deepEqual(v.reasons, ["missing test"]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/core/orchestration/reviewer.test.js`
Expected: FAIL

- [ ] **Step 3: 实现**

```js
// src/core/orchestration/reviewer.js
import { validateVerdict } from "./subtask-schema.js";

const FALLBACK = { pass: false, severity: "warn", reasons: ["verdict unparseable"], checked: [] };

export function createReviewer({ runtime }) {
  async function review(subtask, workerResult) {
    const res = await runtime.send(reviewPrompt(subtask, workerResult), { autonomy: "auto" });
    const obj = extractJson(res?.content || "");
    if (!obj) return { ...FALLBACK };
    const v = validateVerdict(obj);
    return v.ok ? v.verdict : { ...FALLBACK };
  }
  return { review };
}

function reviewPrompt(subtask, workerResult) {
  return [
    "You are an INDEPENDENT reviewer. Do not trust the worker's self-report.",
    `Sub-task goal: ${subtask.goal}`,
    `Acceptance criteria:\n${(subtask.acceptance || []).map((a) => `- ${a}`).join("\n")}`,
    `Worker output:\n${workerResult?.content || ""}`,
    "Independently verify (read files, run tests via your read-only tools).",
    'Reply with ONLY a JSON object: {"pass":bool,"severity":"block"|"warn","reasons":[...],"checked":[...]}'
  ].join("\n\n");
}

function extractJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/core/orchestration/reviewer.test.js`
Expected: PASS

- [ ] **Step 5: 提交(含 src → 不加署名)**

```bash
git add src/core/orchestration/reviewer.js tests/core/orchestration/reviewer.test.js
git commit -m "feat(orchestration): independent reviewer (readonly runtime -> Verdict, conservative fallback)"
```

---

# 里程碑 M3 · Planner

## Task 7: planner(模型 → Plan,校验 + 重试 + 环检测 + 降级)

**Files:**
- Create: `src/core/orchestration/planner.js`
- Test: `tests/core/orchestration/planner.test.js`

**Interfaces:**
- Consumes:`validatePlan` / `hasCycle`(Task 1)。
- Produces:`createPlanner({ callModel, maxPlanRepairs=2 }) -> { plan({ message, context }) -> Plan }`。`callModel(prompt) -> string`(注入,真实=包 `modelGateway.invoke`)。畸形/环 → 有界重试;耗尽 → 降级为单 `edit` 子任务。

- [ ] **Step 1: 写失败测试**

```js
// tests/core/orchestration/planner.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPlanner } from "../../../src/core/orchestration/planner.js";

const VALID = JSON.stringify({
  task_summary: "two things", done_when: "both done",
  subtasks: [
    { id: "st_1", goal: "a", acceptance: ["a ok"], context_scope: {}, tool_profile: "edit", depends_on: [] },
    { id: "st_2", goal: "b", acceptance: ["b ok"], context_scope: {}, tool_profile: "readonly", depends_on: [] }
  ]
});

test("returns a validated plan from model output", async () => {
  const planner = createPlanner({ callModel: async () => VALID });
  const plan = await planner.plan({ message: "do a and b", context: null });
  assert.equal(plan.subtasks.length, 2);
});

test("retries on malformed plan, then succeeds", async () => {
  let n = 0;
  const planner = createPlanner({ callModel: async () => (n++ === 0 ? "not json" : VALID), maxPlanRepairs: 2 });
  const plan = await planner.plan({ message: "x", context: null });
  assert.equal(plan.subtasks.length, 2);
  assert.equal(n, 2);
});

test("degrades to a single edit subtask when retries exhausted", async () => {
  const planner = createPlanner({ callModel: async () => "still not json", maxPlanRepairs: 1 });
  const plan = await planner.plan({ message: "fix the bug", context: null });
  assert.equal(plan.subtasks.length, 1);
  assert.equal(plan.subtasks[0].tool_profile, "edit");
  assert.equal(plan.subtasks[0].depends_on.length, 0);
});

test("rejects a cyclic plan and degrades", async () => {
  const CYCLE = JSON.stringify({
    task_summary: "x", done_when: "y",
    subtasks: [
      { id: "a", goal: "a", acceptance: [], context_scope: {}, tool_profile: "edit", depends_on: ["b"] },
      { id: "b", goal: "b", acceptance: [], context_scope: {}, tool_profile: "edit", depends_on: ["a"] }
    ]
  });
  const planner = createPlanner({ callModel: async () => CYCLE, maxPlanRepairs: 0 });
  const plan = await planner.plan({ message: "z", context: null });
  assert.equal(plan.subtasks.length, 1); // degraded
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/core/orchestration/planner.test.js`
Expected: FAIL

- [ ] **Step 3: 实现**

```js
// src/core/orchestration/planner.js
import { validatePlan, hasCycle } from "./subtask-schema.js";

export function createPlanner({ callModel, maxPlanRepairs = 2 }) {
  async function plan({ message, context }) {
    let feedback = null;
    for (let attempt = 0; attempt <= maxPlanRepairs; attempt += 1) {
      let raw;
      try { raw = await callModel(plannerPrompt(message, context, feedback)); }
      catch (e) { feedback = `model error: ${e.message}`; continue; }
      const obj = extractJson(raw);
      if (!obj) { feedback = "output was not valid JSON; reply with ONLY the JSON plan"; continue; }
      const v = validatePlan(obj);
      if (!v.ok) { feedback = `plan invalid: ${v.error}`; continue; }
      if (hasCycle(v.plan.subtasks)) { feedback = "plan had a dependency cycle; remove it"; continue; }
      return v.plan;
    }
    return degradeToSingle(message);
  }
  return { plan };
}

function degradeToSingle(message) {
  return {
    task_summary: String(message || "").slice(0, 200),
    done_when: "the request is fulfilled",
    subtasks: [{ id: "st_1", goal: String(message || ""), acceptance: ["request fulfilled"], context_scope: {}, tool_profile: "edit", depends_on: [] }]
  };
}

function plannerPrompt(message, context, feedback) {
  return [
    "Break the user's request into a minimal set of sub-tasks for sub-agents to execute SEQUENTIALLY.",
    `User request: ${message}`,
    context ? `Context summary: ${context.summary || ""}` : "",
    'Reply with ONLY JSON: {"task_summary","done_when","subtasks":[{"id","goal","acceptance":[...],"context_scope":{"files":[...]},"tool_profile":"edit"|"readonly","depends_on":[...]}]}',
    "Use depends_on to express ordering. Keep it minimal — do not over-decompose.",
    feedback ? `Your previous attempt was rejected: ${feedback}` : ""
  ].filter(Boolean).join("\n\n");
}

function extractJson(text) {
  const s = String(text || "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/core/orchestration/planner.test.js`
Expected: PASS

- [ ] **Step 5: 提交(含 src → 不加署名)**

```bash
git add src/core/orchestration/planner.js tests/core/orchestration/planner.test.js
git commit -m "feat(orchestration): planner (model->Plan, validate+retry+cycle-check+degrade)"
```

---

# 里程碑 M4 · 派发循环 + 汇总

## Task 8: synthesizer(汇总 + 失败诚实汇报)

**Files:**
- Create: `src/core/orchestration/synthesizer.js`
- Test: `tests/core/orchestration/synthesizer.test.js`

**Interfaces:**
- Produces:`createSynthesizer({ callModel }) -> { synthesize({ message, collected }) -> string }`。`collected` 项形如 `{ st, wres?, verdict?, status:"complete"|"failed", lastFeedback? }`。callModel 失败 → 确定性兜底摘要(含失败诚实标注)。

- [ ] **Step 1: 写失败测试**

```js
// tests/core/orchestration/synthesizer.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSynthesizer } from "../../../src/core/orchestration/synthesizer.js";

const collected = [
  { st: { id: "st_1", goal: "a" }, status: "complete", wres: { content: "did a" } },
  { st: { id: "st_2", goal: "b" }, status: "failed", lastFeedback: "tests failed" }
];

test("uses model output when available", async () => {
  const s = createSynthesizer({ callModel: async () => "final summary" });
  assert.equal(await s.synthesize({ message: "x", collected }), "final summary");
});

test("falls back to a deterministic summary that names failures", async () => {
  const s = createSynthesizer({ callModel: async () => { throw new Error("model down"); } });
  const out = await s.synthesize({ message: "x", collected });
  assert.match(out, /st_1/);
  assert.match(out, /st_2/);
  assert.match(out, /fail/i);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/core/orchestration/synthesizer.test.js`
Expected: FAIL

- [ ] **Step 3: 实现**

```js
// src/core/orchestration/synthesizer.js
export function createSynthesizer({ callModel }) {
  async function synthesize({ message, collected }) {
    try {
      const out = await callModel(synthPrompt(message, collected));
      if (out && String(out).trim()) return String(out);
    } catch { /* fall through to deterministic summary */ }
    return deterministicSummary(collected);
  }
  return { synthesize };
}

function synthPrompt(message, collected) {
  const lines = collected.map((c) => `- ${c.st.id} (${c.status}): ${c.status === "complete" ? (c.wres?.content || "").slice(0, 400) : `FAILED: ${c.lastFeedback || ""}`}`);
  return [
    `Synthesize a final answer for the user's request: ${message}`,
    "Sub-task outcomes:", lines.join("\n"),
    "Report honestly: state clearly which sub-tasks failed and why; do not claim success for failed parts."
  ].join("\n\n");
}

function deterministicSummary(collected) {
  const done = collected.filter((c) => c.status === "complete");
  const failed = collected.filter((c) => c.status !== "complete");
  const parts = [`Completed ${done.length}/${collected.length} sub-tasks.`];
  for (const c of done) parts.push(`✓ ${c.st.id}: ${(c.wres?.content || "").slice(0, 200)}`);
  for (const c of failed) parts.push(`✗ ${c.st.id} FAILED: ${c.lastFeedback || "unknown"}`);
  return parts.join("\n");
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/core/orchestration/synthesizer.test.js`
Expected: PASS

- [ ] **Step 5: 提交(含 src → 不加署名)**

```bash
git add src/core/orchestration/synthesizer.js tests/core/orchestration/synthesizer.test.js
git commit -m "feat(orchestration): synthesizer (model summary + honest deterministic fallback)"
```

---

## Task 9: dispatch-loop(确定性循环,纯 mock 可测)

**Files:**
- Create: `src/core/orchestration/dispatch-loop.js`
- Test: `tests/core/orchestration/dispatch-loop.test.js`

**Interfaces:**
- Consumes:`topoOrder`(Task 1)。
- Produces:`runDispatchLoop({ plan, workerFactory, makeReviewer, synthesizer, budget, maxWorkerAttempts, autonomy, onEvent })`(见 Shared)。`workerFactory.worker(st).send()` 返回 `{ status, content, ... }`;`makeReviewer()` 返回 `{ review(st, wres) -> Verdict }`;`budget.exceeded()` 非空即停。

- [ ] **Step 1: 写失败测试**

```js
// tests/core/orchestration/dispatch-loop.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { runDispatchLoop } from "../../../src/core/orchestration/dispatch-loop.js";

function st(id, deps = []) { return { id, goal: id, acceptance: [], context_scope: {}, tool_profile: "edit", depends_on: deps }; }
const noBudget = { exceeded: () => null };
const passReviewer = () => ({ review: async () => ({ pass: true, severity: "warn", reasons: [], checked: [] }) });
const okWorker = (content) => ({ send: async () => ({ status: "complete", content }) });
const synth = { synthesize: async ({ collected }) => `synth:${collected.map((c) => `${c.st.id}=${c.status}`).join(",")}` };

test("runs subtasks in topo order; all pass -> complete", async () => {
  const order = [];
  const wf = { worker: (s) => { order.push(s.id); return okWorker(`out:${s.id}`); } };
  const plan = { subtasks: [st("st_2", ["st_1"]), st("st_1")] };
  const r = await runDispatchLoop({ plan, workerFactory: wf, makeReviewer: passReviewer, synthesizer: synth, budget: noBudget, maxWorkerAttempts: 2, autonomy: "auto" });
  assert.deepEqual(order, ["st_1", "st_2"]);
  assert.equal(r.status, "complete");
  assert.match(r.content, /st_1=complete,st_2=complete/);
});

test("reviewer reject -> bounded retry then mark failed", async () => {
  let calls = 0;
  const wf = { worker: () => ({ send: async () => { calls += 1; return { status: "complete", content: "x" }; } }) };
  const rejectReviewer = () => ({ review: async () => ({ pass: false, severity: "block", reasons: ["nope"], checked: [] }) });
  const plan = { subtasks: [st("st_1")] };
  const r = await runDispatchLoop({ plan, workerFactory: wf, makeReviewer: rejectReviewer, synthesizer: synth, budget: noBudget, maxWorkerAttempts: 2, autonomy: "auto" });
  assert.equal(calls, 2);                       // tried maxWorkerAttempts times
  assert.match(r.content, /st_1=failed/);
});

test("self-audit non-complete -> retry with feedback", async () => {
  let n = 0;
  const wf = { worker: () => ({ send: async () => (n++ === 0 ? { status: "failed", content: "broke" } : { status: "complete", content: "ok" }) }) };
  const plan = { subtasks: [st("st_1")] };
  const r = await runDispatchLoop({ plan, workerFactory: wf, makeReviewer: passReviewer, synthesizer: synth, budget: noBudget, maxWorkerAttempts: 3, autonomy: "auto" });
  assert.match(r.content, /st_1=complete/);
  assert.equal(n, 2);
});

test("budget exceeded -> partial complete, no throw", async () => {
  const wf = { worker: () => okWorker("x") };
  let checks = 0;
  const budget = { exceeded: () => (++checks >= 2 ? { reason: "max_model_calls" } : null) };
  const plan = { subtasks: [st("st_1"), st("st_2"), st("st_3")] };
  const r = await runDispatchLoop({ plan, workerFactory: wf, makeReviewer: passReviewer, synthesizer: synth, budget, maxWorkerAttempts: 1, autonomy: "auto" });
  assert.equal(r.status, "complete");           // graceful, partial
  assert.match(r.content, /st_1=complete/);
});

test("worker awaiting_approval -> surfaced, loop stops", async () => {
  const wf = { worker: () => ({ send: async () => ({ status: "awaiting_approval", approval: { id: "ap_1" } }) }) };
  const plan = { subtasks: [st("st_1")] };
  const r = await runDispatchLoop({ plan, workerFactory: wf, makeReviewer: passReviewer, synthesizer: synth, budget: noBudget, maxWorkerAttempts: 1, autonomy: "gated" });
  assert.equal(r.status, "awaiting_approval");
  assert.equal(r.approval.id, "ap_1");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/core/orchestration/dispatch-loop.test.js`
Expected: FAIL

- [ ] **Step 3: 实现**

```js
// src/core/orchestration/dispatch-loop.js
import { topoOrder } from "./subtask-schema.js";

export async function runDispatchLoop({ plan, workerFactory, makeReviewer, synthesizer, budget, maxWorkerAttempts, autonomy, onEvent }) {
  let order;
  try { order = topoOrder(plan.subtasks); }
  catch { order = [...plan.subtasks]; } // cycle already excluded by planner; be defensive
  const collected = [];

  for (const st of order) {
    let priorFeedback = null;
    let settled = false;
    for (let attempt = 1; attempt <= maxWorkerAttempts; attempt += 1) {
      onEvent?.("subtask_started", { subtask_id: st.id, attempt, tool_profile: st.tool_profile });
      const worker = workerFactory.worker(st);
      const wres = await worker.send(workerPrompt(st, priorFeedback), { autonomy });

      if (wres.status === "awaiting_approval") return { status: "awaiting_approval", approval: wres.approval, collected };
      if (wres.status === "stopped") { collected.push({ st, status: "failed", lastFeedback: "worker stopped (budget)" }); settled = true; break; }
      if (wres.status !== "complete") { priorFeedback = `self-audit failed: ${wres.content || wres.status}`; continue; } // 关卡1

      const verdict = await makeReviewer().review(st, wres); // 关卡2 (独立)
      onEvent?.("subtask_reviewed", { subtask_id: st.id, pass: verdict.pass, severity: verdict.severity });
      if (verdict.pass) { collected.push({ st, wres, verdict, status: "complete" }); settled = true; break; }
      priorFeedback = (verdict.reasons || []).join("; ") || "review rejected";
    }
    if (!settled) collected.push({ st, status: "failed", lastFeedback: priorFeedback });
    if (budget.exceeded()) { const content = await synthesizer.synthesize({ collected }); return { status: "complete", content, collected, stopped_reason: "budget" }; }
  }

  const content = await synthesizer.synthesize({ collected });
  return { status: "complete", content, collected };
}

function workerPrompt(st, priorFeedback) {
  return [
    `Sub-task: ${st.goal}`,
    `Acceptance criteria:\n${(st.acceptance || []).map((a) => `- ${a}`).join("\n")}`,
    priorFeedback ? `A previous attempt was rejected. Address this feedback: ${priorFeedback}` : ""
  ].filter(Boolean).join("\n\n");
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/core/orchestration/dispatch-loop.test.js`
Expected: PASS

- [ ] **Step 5: 提交(含 src → 不加署名)**

```bash
git add src/core/orchestration/dispatch-loop.js tests/core/orchestration/dispatch-loop.test.js
git commit -m "feat(orchestration): deterministic dispatch-loop (topo + two-level review + bounded retry + graceful budget stop)"
```

---

# 里程碑 M5 · Orchestrator 组装 + kernel 接线 + e2e

## Task 10: orchestrator(组装 planner + dispatch + synth + budget + 事件)

**Files:**
- Create: `src/core/orchestration/orchestrator.js`
- Test: `tests/core/orchestration/orchestrator.test.js`

**Interfaces:**
- Consumes:`createPlanner`/`createSynthesizer`/`createWorkerFactory`/`createReviewer`/`runDispatchLoop`/`createCostBudget`(`../runtime/cost-budget.js`)。
- Produces:`createOrchestrator({ planner, makeWorkerFactory, makeReviewerFor, synthesizer, makeBudget, maxSubtasks, maxWorkerAttempts, eventBus, makeContext }) -> { run({ message, options, routing }) -> { status, content, collected } }`。发 `orchestration:planned` / `:completed`;子任务超 `maxSubtasks` → 截断并 log。

- [ ] **Step 1: 写失败测试**

```js
// tests/core/orchestration/orchestrator.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createOrchestrator } from "../../../src/core/orchestration/orchestrator.js";

function st(id) { return { id, goal: id, acceptance: [], context_scope: {}, tool_profile: "edit", depends_on: [] }; }

function deps(plan) {
  const events = [];
  return {
    events,
    orch: createOrchestrator({
      planner: { plan: async () => plan },
      makeWorkerFactory: () => ({ worker: () => ({ send: async () => ({ status: "complete", content: "ok" }) }), reviewerRuntime: () => ({}) }),
      makeReviewerFor: () => ({ review: async () => ({ pass: true, severity: "warn", reasons: [], checked: [] }) }),
      synthesizer: { synthesize: async ({ collected }) => `done:${collected.length}` },
      makeBudget: () => ({ exceeded: () => null, recordModelResult: () => {} }),
      maxSubtasks: 8,
      maxWorkerAttempts: 2,
      eventBus: { publish: (t, d) => events.push([t, d]) },
      makeContext: async () => null
    })
  };
}

test("run plans, dispatches, synthesizes, emits events", async () => {
  const { orch, events } = deps({ task_summary: "x", done_when: "y", subtasks: [st("st_1"), st("st_2")] });
  const r = await orch.run({ message: "do stuff", options: {}, routing: { signals: [] } });
  assert.equal(r.status, "complete");
  assert.equal(r.content, "done:2");
  assert.ok(events.some(([t]) => t === "orchestration:planned"));
  assert.ok(events.some(([t]) => t === "orchestration:completed"));
});

test("truncates subtasks beyond maxSubtasks", async () => {
  const many = Array.from({ length: 12 }, (_, i) => st(`st_${i}`));
  const { orch } = deps({ task_summary: "x", done_when: "y", subtasks: many });
  // rebuild with maxSubtasks=3 via a fresh orchestrator
  const events = [];
  const orch3 = createOrchestrator({
    planner: { plan: async () => ({ task_summary: "x", done_when: "y", subtasks: many }) },
    makeWorkerFactory: () => ({ worker: () => ({ send: async () => ({ status: "complete", content: "ok" }) }) }),
    makeReviewerFor: () => ({ review: async () => ({ pass: true, severity: "warn", reasons: [], checked: [] }) }),
    synthesizer: { synthesize: async ({ collected }) => `done:${collected.length}` },
    makeBudget: () => ({ exceeded: () => null }),
    maxSubtasks: 3, maxWorkerAttempts: 1,
    eventBus: { publish: (t, d) => events.push([t, d]) },
    makeContext: async () => null
  });
  const r = await orch3.run({ message: "z", options: {}, routing: { signals: [] } });
  assert.equal(r.content, "done:3");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/core/orchestration/orchestrator.test.js`
Expected: FAIL

- [ ] **Step 3: 实现**

```js
// src/core/orchestration/orchestrator.js
import { runDispatchLoop } from "./dispatch-loop.js";

export function createOrchestrator({ planner, makeWorkerFactory, makeReviewerFor, synthesizer, makeBudget, maxSubtasks, maxWorkerAttempts, eventBus, makeContext }) {
  async function run({ message, options = {}, routing = {} }) {
    const context = await makeContext?.({ message, options });
    const plan = await planner.plan({ message, context });
    if (plan.subtasks.length > maxSubtasks) plan.subtasks = plan.subtasks.slice(0, maxSubtasks);
    publish(eventBus, "orchestration:planned", { subtasks: plan.subtasks.length, done_when: plan.done_when });

    const budget = makeBudget();
    const workerFactory = makeWorkerFactory();
    const autonomy = options.autonomy || "gated";
    const onEvent = (type, data) => publish(eventBus, `orchestration:${type}`, data);

    const result = await runDispatchLoop({
      plan,
      workerFactory,
      makeReviewer: () => makeReviewerFor(workerFactory),
      synthesizer,
      budget,
      maxWorkerAttempts,
      autonomy,
      onEvent
    });

    if (result.status === "awaiting_approval") {
      publish(eventBus, "orchestration:completed", { completed: count(result.collected, "complete"), failed: count(result.collected, "failed"), stopped_reason: "awaiting_approval" });
      return result;
    }
    publish(eventBus, "orchestration:completed", { completed: count(result.collected, "complete"), failed: count(result.collected, "failed"), stopped_reason: result.stopped_reason || null });
    return { status: "complete", content: result.content, collected: result.collected };
  }
  return { run };
}

function count(collected, status) { return (collected || []).filter((c) => c.status === status).length; }
function publish(eventBus, type, data) { if (eventBus && typeof eventBus.publish === "function") eventBus.publish(type, data); }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/core/orchestration/orchestrator.test.js`
Expected: PASS

- [ ] **Step 5: 提交(含 src → 不加署名)**

```bash
git add src/core/orchestration/orchestrator.js tests/core/orchestration/orchestrator.test.js
git commit -m "feat(orchestration): orchestrator (plan->dispatch->synth, budget, events, maxSubtasks cap)"
```

---

## Task 11: kernel 接线(routedSend)+ e2e

**Files:**
- Modify: `src/index.js`(提取 runtime 配置为 `runtimeConfig`;加 `createRuntime` 覆盖工厂;`agent.send` → `routedSend`)
- Test: `tests/core/orchestration/kernel-routing-e2e.test.js`

**Interfaces:**
- Consumes:`createTaskRouter` / `createOrchestrator` / `createPlanner` / `createSynthesizer` / `createWorkerFactory` / `createReviewer` / `createCostBudget`。
- Produces:`kernel.agent.send` 路由:`single` → `runtime.send`(原样,无新事件);`orchestrate` → 发 `orchestration:routed` 后 `orchestrator.run`。

**实现要点(index.js)**:
1. 把传给 `createAgentRuntime(...)` 的大对象抽成 `const runtimeConfig = { ...所有现有字段... };`,然后 `const runtime = createAgentRuntime(runtimeConfig);`(纯重构,行为不变)。
2. 加覆盖工厂:`const createRuntime = (overrides = {}) => createAgentRuntime({ ...runtimeConfig, ...overrides });`
3. 归一化配置:`const orch = normalizeOrchestration(options.orchestration);`(`import { normalizeOrchestration } from "./config.js"`)。
4. 造 router + orchestrator:

```js
import { createTaskRouter } from "./core/orchestration/task-router.js";
import { createOrchestrator } from "./core/orchestration/orchestrator.js";
import { createPlanner } from "./core/orchestration/planner.js";
import { createSynthesizer } from "./core/orchestration/synthesizer.js";
import { createWorkerFactory } from "./core/orchestration/worker-factory.js";
import { createReviewer } from "./core/orchestration/reviewer.js";
import { createCostBudget } from "./core/runtime/cost-budget.js";

const taskRouter = createTaskRouter(orch.router);
const callModel = async (prompt) => {
  if (!modelGateway?.invoke) return "";
  const res = await modelGateway.invoke({ messages: [{ role: "user", content: prompt }] });
  return res?.content || "";
};
const orchestrator = createOrchestrator({
  planner: createPlanner({ callModel }),
  makeWorkerFactory: () => createWorkerFactory({
    createRuntime,
    baseToolSchemas: () => toolRegistry.toDeepSeekTools(),
    makeContextSnapshot: (input) => contextEngine.snapshot(input)
  }),
  makeReviewerFor: (workerFactory) => createReviewer({ runtime: workerFactory.reviewerRuntime() }),
  synthesizer: createSynthesizer({ callModel }),
  makeBudget: () => createCostBudget({ maxTokens: orch.budget.maxTokens, maxModelCalls: orch.budget.maxModelCalls }),
  maxSubtasks: orch.maxSubtasks,
  maxWorkerAttempts: orch.maxWorkerAttempts,
  eventBus,
  makeContext: (input) => contextEngine.snapshot({ ...input, phase: "plan" })
});

async function routedSend(message, sendOptions = {}) {
  const decision = taskRouter.route(message, sendOptions);
  if (decision.lane === "single") return runtime.send(message, sendOptions);   // 今天的路径,零新事件
  eventBus.publish("orchestration:routed", { lane: decision.lane, reason: decision.reason, signals: decision.signals });
  return orchestrator.run({ message, options: sendOptions, routing: decision });
}
```

5. facade:把 `agent: { send: runtime.send, ... }` 改为 `agent: { send: routedSend, approve: runtime.approve, interrupt: runtime.interrupt, listPaused: runtime.listPaused, cancelPaused: runtime.cancelPaused }`。

- [ ] **Step 1: 写 e2e 失败测试**(mock 模型 + 真 orchestration 链路,经 kernel facade)

```js
// tests/core/orchestration/kernel-routing-e2e.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os"; import path from "node:path"; import { promises as fs } from "node:fs";
import { createKernel } from "../../../src/index.js";

// A mock model gateway: planner asks for JSON plan -> return 2 subtasks; reviewer -> pass JSON; others -> generic.
function mockGateway() {
  return {
    invoke: async ({ messages }) => {
      const text = messages.map((m) => m.content).join("\n");
      if (text.includes("Break the user's request")) {
        return { content: JSON.stringify({ task_summary: "t", done_when: "d", subtasks: [
          { id: "st_1", goal: "do a", acceptance: ["a"], context_scope: {}, tool_profile: "readonly", depends_on: [] },
          { id: "st_2", goal: "do b", acceptance: ["b"], context_scope: {}, tool_profile: "readonly", depends_on: ["st_1"] }
        ] }) };
      }
      if (text.includes("INDEPENDENT reviewer")) return { content: '{"pass":true,"severity":"warn","reasons":[],"checked":["read"]}' };
      if (text.includes("Synthesize a final answer")) return { content: "final orchestrated answer" };
      return { content: "worker did the thing" };
    },
    reply: async () => ({ content: "single-agent reply" }),
    getUsageStats: () => ({})
  };
}

test("simple message uses single lane; complex message orchestrates", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orch-e2e-"));
  const events = [];
  const kernel = await createKernel(root, {
    modelGateway: mockGateway(),
    eventBus: { publish: (t, d) => events.push([t, d]), subscribe: () => () => {} },
    sessionLog: null, branchStore: null
  });

  // simple -> single lane: no orchestration:routed event
  await kernel.agent.send("explain the project").catch(() => {});
  assert.equal(events.some(([t]) => t === "orchestration:routed"), false);

  // complex -> orchestrate
  events.length = 0;
  const r = await kernel.agent.send("给这几个模块分别加校验");
  assert.ok(events.some(([t]) => t === "orchestration:routed"));
  assert.ok(events.some(([t]) => t === "orchestration:planned"));
  assert.equal(r.content, "final orchestrated answer");
  await kernel.dispose?.();
});
```

> 注:若 `createKernel` 在无 `sessionLog`/`branchStore` 时构造细节有差,按现有其他 e2e 测试(如 `tests/` 下既有 kernel 测试)的最小构造姿势对齐;关键断言是「simple 不发 routed 事件、complex 发 routed+planned 且返回汇总」。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/core/orchestration/kernel-routing-e2e.test.js`
Expected: FAIL

- [ ] **Step 3: 改 `src/index.js`**(按上面 5 点;先重构 `runtimeConfig` 抽取,再加 router/orchestrator/routedSend,最后改 facade)。

- [ ] **Step 4: 跑 e2e + 全量语义/核心回归**

Run: `node --test tests/core/orchestration/kernel-routing-e2e.test.js`
Expected: PASS
Run: `node --test test/**/*.test.js tests/**/*.test.js`
Expected: 全绿(现有 559 + 新增编排测试;`single` 档行为不变)

- [ ] **Step 5: 提交(含 src → 不加署名)**

```bash
git add src/index.js tests/core/orchestration/kernel-routing-e2e.test.js
git commit -m "feat(orchestration): wire unified router into kernel.send (single fast-lane unchanged, orchestrate lane)"
```

---

# 里程碑 M6 · 回归 + 配置接线 + 文档

## Task 12: 回归确认 + 文档

**Files:**
- Modify: `README.md`、`README.en.md`、`docs/CHANGELOG.md`、`docs/project-overview.md`、`docs/README.md`(索引)
- Modify(若需):`src/apps/kernel-options.js`(把 `config.orchestration` 透传给 `createKernel`)、`package.json`(check 脚本加 orchestration 文件)

- [ ] **Step 1: 全量回归 + check**

Run: `node --test test/**/*.test.js tests/**/*.test.js`
Expected: 全绿(现有 559 不回归 + 新增编排单测/e2e)
Run: `npm run check`
Expected: OK(若新增文件未列入 check,在 `package.json` 的语义/核心段后补 `src/core/orchestration/*.js` 一段 `node --check`)

- [ ] **Step 2: 配置透传**(若 CLI/GUI 经 `kernel-options.js` 建 kernel)—— 在 `buildKernelOptions` 把 `config.orchestration` 放进 `createKernel` options(对照其如何透传 `limits` / `context`);加最小单测断言透传。提交(含 src → 不加署名)。

- [ ] **Step 3: README 中英 + CHANGELOG + project-overview**
  - README.md / README.en.md:语义/特性处加一条「**自动多智能体编排**:复杂任务由路由器自动拆成子任务、串行子代理执行、独立审核后汇总;简单任务零开销直跑。无需开关。」(中英同步)。
  - docs/CHANGELOG.md:Unreleased 加「已落地 — Phase C1+C2 多智能体编排」,记统一入口/确定性路由/两级审核/成本闸常开/agent-runtime 不改/测试数。
  - docs/project-overview.md:加「多智能体编排」一节(组件地图 + 确定性派发 + 工具子集 + 事件)。
  - docs/README.md 索引:plans/backend 加本计划条目。

- [ ] **Step 4: 提交(纯文档 → 加署名)**

```bash
git add README.md README.en.md docs/CHANGELOG.md docs/project-overview.md docs/README.md
git commit -m "docs: Phase C1+C2 multi-agent orchestration (unified router + two-level review)"
```

---

## Self-Review

- **Spec coverage**:§3 统一入口/路由 → Task 2/11;§4 组件 → Task 1–10;§5 Planner+schema → Task 1/7;§6 派发循环 → Task 9;§7 两级审核 → Task 6/9(关卡1 复用 worker 内置、关卡2 reviewer);§8 上下文/工具子集 → Task 4/5;§9 成本闸 → Task 3/9/10;§10 事件嵌套 → Task 10/11;§11 审批上浮 → Task 9(awaiting_approval 返回)/11;§12 配置 → Task 3/12;§13 测试 → 各 task;§14 文件结构 → Task 1–11;§15 里程碑 → Task 分组。
- **Placeholder scan**:无 TODO/TBD;Task 11 的 index.js 改动给了具体 5 点 + 代码;e2e 注记了「按现有 kernel 测试最小构造对齐」是真实可执行指引(不是占位)。
- **Type consistency**:`RoutingDecision{lane,reason,signals,classification}`、`Plan/SubTask/Verdict`、`runDispatchLoop({...}) -> {status,content?,approval?,collected}`、`createOrchestrator({planner,makeWorkerFactory,makeReviewerFor,synthesizer,makeBudget,maxSubtasks,maxWorkerAttempts,eventBus,makeContext})`、`createWorkerFactory({createRuntime,baseToolSchemas,makeContextSnapshot})->{worker,reviewerRuntime}` 各 task 一致;`budget.exceeded()` 用非抛版本(对齐 `cost-budget.js`)。
- **风险**:最大风险是 Task 11 的 index.js 重构(抽 `runtimeConfig` + 改 facade);判据是现有 559 全绿 + e2e;`single` 档直接 `runtime.send` → 零回归路径清晰。`createAgentRuntime` 一行不改贯穿全程。
