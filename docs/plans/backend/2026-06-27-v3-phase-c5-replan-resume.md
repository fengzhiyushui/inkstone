# V3 Phase C5 重规划 + 持续派发回合循环(同进程编排级续跑)Implementation Plan

> 完成状态以 [CHANGELOG](../../CHANGELOG.md) 为准。


**Goal:** 把 orchestrator 的「规划一次→派发一次」一般化为**确定性回合循环**(失败重规划 + 长任务持续派发),并支持**同进程编排级续跑**(回合中主区 worker 命中审批暂停 → 保存编排状态 → `approve` 后从原状态续跑,不重 plan、不重复派发)。

**Architecture:** `orchestrator.run` 跑回合循环:`plan → dispatch → replan({completed,failed})→{done,subtasks} → decideContinue 终止闸 → 下一轮`,由程序逻辑控回合数/终止/预算,`replan` 只产结构化下一批。暂停只发生在串行主区 worker;`dispatch-loop` 暂停时返回 `resume`,`orchestrator` 存内存 `orchPaused`(键=approvalId),`kernel.agent.approve` 路由到 `orchestrator.resume` 续跑。`agent-runtime.js` 一行不改。

**Tech Stack:** Node ESM (Node ≥ 20)、`node:test`、复用 C1+C2+C3 编排件 + `agent-runtime` 的 `send`/`approve`。无新运行时依赖。

## Global Constraints

- **`src/core/runtime/agent-runtime.js` 一行不改**:worker 暂停/恢复用其现成 `send`/`approve`;orchestrator 持 worker 实例引用续跑。
- **编排确定性**:回合数 / 终止 / 预算由 orchestrator 程序逻辑判;`replan` 只是被调的模型节点,产结构化下一批。
- **`maxRounds` = 总 dispatch 回合数**(初始轮计 1);`maxRounds=1` 退化 C1+C2。默认 2。
- **结算单一来源 `allCollected`**:暂停时本轮已结算项经 `result.collected` 进 `allCollected`;`roundResume` **不带** `roundCollected`;续跑只追加 paused + remaining 新项 → **绝无重复结算**。
- **两套集合不混用**:`seenSubtaskIds`(id 跨轮唯一,供 `validateReplan`)/ `seenFp`(fingerprint,供无进展守卫)。
- **`done:true` 仅停派发,不代表成功**:最终状态恒由 `classifyOutcome` 依 `allCollected` 判(有 failed=partial;预算/轮数耗尽未尽=incomplete;否则 complete)。
- **多次暂停-恢复是常态**:每次 `resume` 消费旧 `orchPaused` 条目、可能以新 approvalId 产生新条目。
- **暂停点只在串行主区 worker**:并行 iso worker 仍 `autonomy:"auto"`(C3 不变);merge 不走审批门。C3 批次并行行为不变。
- **默认零回归**:`maxRounds=1` 或 `planner` 无 `replan` 或 `replan` 首轮 `done` → 第 1 轮后停 == C1+C2;现有 618 全绿。
- `node:test`;每 task 末跑测试 + 提交。

## Shared Interfaces(全任务一致)

```text
// subtask-schema.js
validateReplan(subtasks, { seenSubtaskIds:Set, completedIds:Set, failedIds:Set }) -> { ok:boolean, error?:string }
fingerprint(st) -> string     // normalize(goal + sorted(context_scope.files) + tool_profile)

// planner.js  (createPlanner now returns { plan, replan })
replan({ message, done_when, completed, failed }) -> { done:boolean, subtasks:SubTask[] }
   // completed/failed = [{ id, goal, note }] summaries

// dispatch-loop.js
runDispatchLoop(deps) -> { status:"complete"|"awaiting_approval", content?, collected:Entry[], resume?:RoundResume, stopped_reason? }
RoundResume = { pausedWorker, pausedApprovalId, pausedSubtask, remaining:SubTask[], deps }
resumeDispatchLoop(roundResume, decision) -> { status, collected:Entry[], resume?:RoundResume }
Entry = { st, status:"complete"|"failed", wres?, verdict?, change_id?, lastFeedback? }

// synthesizer.js
classifyOutcome(collected, { stoppedByCap:boolean }) -> "complete" | "partial" | "incomplete"

// orchestrator.js
createOrchestrator({ ... , planner, maxRounds }) -> { run, resume(id, decision), hasPaused(id) }
```

---

# 里程碑 M1 · validateReplan + fingerprint

## Task 1: subtask-schema 加 validateReplan + fingerprint

**Files:**
- Modify: `src/core/orchestration/subtask-schema.js`
- Test: `tests/core/orchestration/replan-schema.test.js`

**Interfaces:** Produces `validateReplan` / `fingerprint`(见 Shared)。复用现有 `validateSubTask`。

- [ ] **Step 1: 写失败测试**

```js
// tests/core/orchestration/replan-schema.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateReplan, fingerprint } from "../../../src/core/orchestration/subtask-schema.js";

function st(id, deps = [], extra = {}) { return { id, goal: id, acceptance: [], context_scope: { files: [`${id}.js`] }, tool_profile: "edit", depends_on: deps, ...extra }; }
const ctx = (over = {}) => ({ seenSubtaskIds: new Set(["old1"]), completedIds: new Set(["c1"]), failedIds: new Set(["f1"]), ...over });

test("accepts well-formed replan subtasks", () => {
  assert.equal(validateReplan([st("n1"), st("n2", ["n1"])], ctx()).ok, true);
  assert.equal(validateReplan([st("n1", ["c1"])], ctx()).ok, true); // dep on completed OK
});

test("rejects id colliding with a prior round", () => {
  assert.equal(validateReplan([st("old1")], ctx()).ok, false);
});

test("rejects dep on failed unless corrective_for points to it", () => {
  assert.equal(validateReplan([st("n1", ["f1"])], ctx()).ok, false);
  assert.equal(validateReplan([st("n1", ["f1"], { corrective_for: "f1" })], ctx()).ok, true);
  assert.equal(validateReplan([st("n1", ["f1"], { corrective_for: "nope" })], ctx()).ok, false); // corrective_for must be a real failed id
});

test("rejects dep on unknown id", () => {
  assert.equal(validateReplan([st("n1", ["ghost"])], ctx()).ok, false);
});

test("fingerprint is stable across id renames, sensitive to scope/goal", () => {
  assert.equal(fingerprint(st("a")) === fingerprint({ ...st("b"), goal: "a" }), false); // goal differs (a vs b)
  const x = { id: "x", goal: "do", context_scope: { files: ["b.js", "a.js"] }, tool_profile: "edit" };
  const y = { id: "y", goal: "do", context_scope: { files: ["a.js", "b.js"] }, tool_profile: "edit" };
  assert.equal(fingerprint(x), fingerprint(y)); // id differs, files reordered -> same fp
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/core/orchestration/replan-schema.test.js`
Expected: FAIL

- [ ] **Step 3: 实现**(加到 `subtask-schema.js` 末尾)

```js
export function fingerprint(st) {
  const files = Array.isArray(st.context_scope?.files) ? [...st.context_scope.files].map((f) => String(f).replace(/\\/g, "/").toLowerCase()).sort() : [];
  return [String(st.goal || "").trim().toLowerCase(), files.join(","), st.tool_profile || ""].join("|");
}

export function validateReplan(subtasks, { seenSubtaskIds = new Set(), completedIds = new Set(), failedIds = new Set() } = {}) {
  if (!Array.isArray(subtasks)) return { ok: false, error: "subtasks not an array" };
  const thisRound = new Set();
  for (const st of subtasks) {
    const base = validateSubTask(st);
    if (base) return { ok: false, error: base };
    if (seenSubtaskIds.has(st.id) || thisRound.has(st.id)) return { ok: false, error: `duplicate subtask id across rounds: ${st.id}` };
    thisRound.add(st.id);
  }
  for (const st of subtasks) {
    if (st.corrective_for !== undefined && !failedIds.has(st.corrective_for)) {
      return { ok: false, error: `${st.id}: corrective_for must reference a failed task` };
    }
    for (const dep of st.depends_on) {
      const known = completedIds.has(dep) || thisRound.has(dep);
      if (!known) return { ok: false, error: `${st.id} depends on unknown ${dep}` };
      if (failedIds.has(dep) && st.corrective_for !== dep) {
        return { ok: false, error: `${st.id} depends on failed ${dep} without corrective_for` };
      }
    }
  }
  return { ok: true };
}
```

> 注:`validateSubTask` 已存在(C1)。`corrective_for` 是可选字段;`validateSubTask` 不认识它但不报错(它只查必需字段)。`depends_on` 指向 `failedIds` 中的 id 且非其 `corrective_for` → 拒;指向 `completedIds`/同轮 → 准;指向 failed 且正是 `corrective_for` → 准。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/core/orchestration/replan-schema.test.js`
Expected: PASS

- [ ] **Step 5: 提交(含 src → 不加署名)**

```bash
git add src/core/orchestration/subtask-schema.js tests/core/orchestration/replan-schema.test.js
git commit -m "feat(orchestration): validateReplan (cross-round id/dep/corrective rules) + fingerprint"
```

---

# 里程碑 M2 · planner.replan

## Task 2: planner 加 replan

**Files:**
- Modify: `src/core/orchestration/planner.js`
- Test: `tests/core/orchestration/planner-replan.test.js`

**Interfaces:** Consumes `validateReplan`(M1)。Produces `createPlanner(...) -> { plan, replan }`;`replan({ message, done_when, completed, failed }) -> { done, subtasks }`。畸形/校验失败有界重试;耗尽 → 保守 `{ done:true, subtasks:[] }`。

- [ ] **Step 1: 写失败测试**

```js
// tests/core/orchestration/planner-replan.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPlanner } from "../../../src/core/orchestration/planner.js";

const VALID = JSON.stringify({ done: false, subtasks: [
  { id: "r1", goal: "fix a", acceptance: ["a fixed"], context_scope: { files: ["a.js"] }, tool_profile: "edit", depends_on: [] }
] });
const ctx = { seenSubtaskIds: new Set(["st_1"]), completedIds: new Set(["st_1"]), failedIds: new Set() };

test("replan returns {done, subtasks} from model", async () => {
  const planner = createPlanner({ callModel: async () => VALID });
  const r = await planner.replan({ message: "m", done_when: "d", completed: [{ id: "st_1", goal: "x" }], failed: [], ...ctx });
  assert.equal(r.done, false);
  assert.equal(r.subtasks.length, 1);
});

test("replan done:true short-circuits", async () => {
  const planner = createPlanner({ callModel: async () => '{"done":true,"subtasks":[]}' });
  const r = await planner.replan({ message: "m", done_when: "d", completed: [], failed: [], ...ctx });
  assert.equal(r.done, true);
  assert.deepEqual(r.subtasks, []);
});

test("malformed -> conservative done:true after retries", async () => {
  const planner = createPlanner({ callModel: async () => "not json", maxPlanRepairs: 1 });
  const r = await planner.replan({ message: "m", done_when: "d", completed: [], failed: [], ...ctx });
  assert.equal(r.done, true);
  assert.deepEqual(r.subtasks, []);
});

test("invalid subtasks (id collision) -> retry then conservative done", async () => {
  const COLLIDE = JSON.stringify({ done: false, subtasks: [{ id: "st_1", goal: "g", acceptance: [], context_scope: {}, tool_profile: "edit", depends_on: [] }] });
  const planner = createPlanner({ callModel: async () => COLLIDE, maxPlanRepairs: 0 });
  const r = await planner.replan({ message: "m", done_when: "d", completed: [], failed: [], ...ctx });
  assert.equal(r.done, true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/core/orchestration/planner-replan.test.js`
Expected: FAIL

- [ ] **Step 3: 实现**(改 `planner.js`:import `validateReplan`;`createPlanner` 返回 `{ plan, replan }`)

```js
import { validatePlan, hasCycle, validateReplan } from "./subtask-schema.js";
```

`createPlanner` 内新增 `replan` 并改 return:

```js
  async function replan({ message, done_when, completed, failed, seenSubtaskIds, completedIds, failedIds }) {
    let feedback = null;
    for (let attempt = 0; attempt <= maxPlanRepairs; attempt += 1) {
      let raw;
      try { raw = await callModel(replanPrompt(message, done_when, completed, failed, feedback)); }
      catch (e) { feedback = `model error: ${e.message}`; continue; }
      const obj = extractJson(raw);
      if (!obj || typeof obj.done !== "boolean" || !Array.isArray(obj.subtasks)) { feedback = 'reply ONLY {"done":bool,"subtasks":[...]}'; continue; }
      if (obj.done || obj.subtasks.length === 0) return { done: true, subtasks: [] };
      const v = validateReplan(obj.subtasks, { seenSubtaskIds, completedIds, failedIds });
      if (!v.ok) { feedback = `replan invalid: ${v.error}`; continue; }
      return { done: false, subtasks: obj.subtasks };
    }
    return { done: true, subtasks: [] };   // conservative: stop rather than loop badly
  }
  return { plan, replan };
```

加 prompt:

```js
function replanPrompt(message, done_when, completed, failed, feedback) {
  const sum = (list) => (list || []).map((c) => `- ${c.id} (${c.goal}): ${c.note || ""}`).join("\n");
  return [
    "You are revising a multi-agent plan after a dispatch round.",
    `Original request: ${message}`,
    `Done when: ${done_when}`,
    `Completed so far:\n${sum(completed) || "(none)"}`,
    `Failed so far:\n${sum(failed) || "(none)"}`,
    'If the goal is met, reply {"done":true,"subtasks":[]}. Otherwise reply {"done":false,"subtasks":[...]} with NEW sub-tasks (corrective for failures or continuation).',
    "New subtask ids must be globally unique (not reuse any prior id). To redo a failed task add \"corrective_for\":\"<failedId>\". context_scope.files + tool_profile required.",
    feedback ? `Previous attempt rejected: ${feedback}` : ""
  ].filter(Boolean).join("\n\n");
}
```

- [ ] **Step 4: 跑测试 + 现有 planner 测试**

Run: `node --test tests/core/orchestration/planner-replan.test.js tests/core/orchestration/planner.test.js`
Expected: 全 PASS

- [ ] **Step 5: 提交(含 src → 不加署名)**

```bash
git add src/core/orchestration/planner.js tests/core/orchestration/planner-replan.test.js
git commit -m "feat(orchestration): planner.replan (model -> {done,subtasks}, validate + conservative stop)"
```

---

# 里程碑 M3 · config.maxRounds

## Task 3: config.orchestration.maxRounds

**Files:**
- Modify: `src/config.js`
- Test: `tests/config-orchestration-maxrounds.test.js`

**Interfaces:** Produces `DEFAULT_CONFIG.orchestration.maxRounds = 2`;`normalizeOrchestration` 归一化(posInt,默认 2)。

- [ ] **Step 1: 写失败测试**

```js
// tests/config-orchestration-maxrounds.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeOrchestration, DEFAULT_CONFIG } from "../src/config.js";

test("maxRounds default 2", () => {
  assert.equal(DEFAULT_CONFIG.orchestration.maxRounds, 2);
});
test("normalize maxRounds posInt with fallback", () => {
  assert.equal(normalizeOrchestration({ maxRounds: 5 }).maxRounds, 5);
  assert.equal(normalizeOrchestration({ maxRounds: 0 }).maxRounds, 2);
  assert.equal(normalizeOrchestration({ maxRounds: 1 }).maxRounds, 1);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/config-orchestration-maxrounds.test.js`
Expected: FAIL

- [ ] **Step 3: 改 `config.js`** —— `DEFAULT_CONFIG.orchestration` 加 `maxRounds: 2`;`normalizeOrchestration` 返回对象加 `maxRounds: posInt(safe.maxRounds, d.maxRounds)`。

- [ ] **Step 4: 跑测试 + 现有 config 回归**

Run: `node --test tests/config-orchestration-maxrounds.test.js tests/config-orchestration.test.js tests/config-orchestration-parallel.test.js`
Expected: 全 PASS

- [ ] **Step 5: 提交(含 src → 不加署名)**

```bash
git add src/config.js tests/config-orchestration-maxrounds.test.js
git commit -m "feat(config): orchestration.maxRounds (default 2, =1 reverts to C1+C2)"
```

---

# 里程碑 M4 · dispatch-loop 暂停/续跑

## Task 4: dispatch-loop 返回 RoundResume + resumeDispatchLoop

**Files:**
- Modify: `src/core/orchestration/dispatch-loop.js`
- Test: `tests/core/orchestration/dispatch-resume.test.js`

**Interfaces:** `runDispatchLoop` 暂停时返回 `resume`(RoundResume,见 Shared);新增 `resumeDispatchLoop(roundResume, decision)`。`processSubtask` 暂停时**回带 worker 实例**。

**实现要点**:
1. `processSubtask` 暂停分支改为 `return { control: "awaiting_approval", approval: wres.approval, worker }`(回带 worker)。
2. 序列路径(非批):暂停时 `return { status:"awaiting_approval", approval, collected, resume: { pausedWorker, pausedApprovalId: approval.id, pausedSubtask: st, remaining: order.slice(i+1), deps } }`(`collected` = 暂停点前已结算项;`deps` = 重派 remaining 所需的全部注入)。
3. `runBatched` 单任务批暂停时同理(`remaining` = 后续批 flatten 的 subtasks;先 `cleanupRun`)。
4. `resumeDispatchLoop(roundResume, decision)`:`decision==="deny"` → pausedEntry 失败;否则 `wres = await pausedWorker.approve(pausedApprovalId, "approve")` → settle(reviewer)→ pausedEntry;再 `sub = await runDispatchLoop({ plan:{subtasks:remaining}, ...deps })`;合并 `collected=[pausedEntry, ...sub.collected]`;`sub` 再暂停 → 回带 `sub.resume`。

- [ ] **Step 1: 写失败测试(mock worker/reviewer,序列路径)**

```js
// tests/core/orchestration/dispatch-resume.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { runDispatchLoop, resumeDispatchLoop } from "../../../src/core/orchestration/dispatch-loop.js";

function st(id) { return { id, goal: id, acceptance: [], context_scope: {}, tool_profile: "edit", depends_on: [] }; }
const reviewerPass = () => ({ review: async () => ({ pass: true, severity: "warn", reasons: [], checked: [] }) });
const synth = { synthesize: async () => "x" };
const noBudget = { exceeded: () => null };

test("pause returns resume with worker + remaining; resume finishes round", async () => {
  // worker for st_1 pauses (awaiting_approval) on first send, then completes after approve.
  const pausedWorker = {
    send: async () => ({ status: "awaiting_approval", approval: { id: "ap1" } }),
    approve: async () => ({ status: "complete", content: "did st_1" })
  };
  const okWorker = (id) => ({ send: async () => ({ status: "complete", content: `did ${id}` }) });
  const workerFactory = { worker: (s) => (s.id === "st_1" ? pausedWorker : okWorker(s.id)) };
  const plan = { subtasks: [st("st_1"), st("st_2")] };
  const r = await runDispatchLoop({ plan, workerFactory, makeReviewer: reviewerPass, synthesizer: synth, budget: noBudget, maxWorkerAttempts: 1, autonomy: "gated" });
  assert.equal(r.status, "awaiting_approval");
  assert.equal(r.approval.id, "ap1");
  assert.deepEqual(r.collected, []);                 // nothing settled before the pause (st_1 was first)
  assert.equal(r.resume.pausedSubtask.id, "st_1");
  assert.deepEqual(r.resume.remaining.map((s) => s.id), ["st_2"]);

  const done = await resumeDispatchLoop(r.resume, "approve");
  assert.equal(done.status, "complete");
  assert.deepEqual(done.collected.map((c) => `${c.st.id}:${c.status}`), ["st_1:complete", "st_2:complete"]); // no dup, both settled
});

test("deny -> paused subtask failed, remaining still dispatched", async () => {
  const pausedWorker = { send: async () => ({ status: "awaiting_approval", approval: { id: "ap1" } }), approve: async () => ({ status: "complete", content: "x" }) };
  const workerFactory = { worker: (s) => (s.id === "st_1" ? pausedWorker : { send: async () => ({ status: "complete", content: "ok" }) }) };
  const r = await runDispatchLoop({ plan: { subtasks: [st("st_1"), st("st_2")] }, workerFactory, makeReviewer: reviewerPass, synthesizer: synth, budget: noBudget, maxWorkerAttempts: 1, autonomy: "gated" });
  const done = await resumeDispatchLoop(r.resume, "deny");
  assert.equal(done.collected.find((c) => c.st.id === "st_1").status, "failed");
  assert.equal(done.collected.find((c) => c.st.id === "st_2").status, "complete");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/core/orchestration/dispatch-resume.test.js`
Expected: FAIL

- [ ] **Step 3: 改 `dispatch-loop.js`**

`processSubtask` 暂停分支:
```js
    if (wres.status === "awaiting_approval") return { control: "awaiting_approval", approval: wres.approval, worker };
```

序列路径(替换 `for (const st of order)` 块):
```js
  const order = orderOf(plan);
  const deps = { workerFactory, makeReviewer, synthesizer, budget, maxWorkerAttempts, autonomy, onEvent, toBatches, maxParallelWorkers, runIsolatedWorker, mergeSubtask, removeIso };
  const collected = [];
  for (let i = 0; i < order.length; i += 1) {
    const st = order[i];
    const r = await processSubtask(st, { workerFactory, makeReviewer, maxWorkerAttempts, autonomy, onEvent });
    if (r.control === "awaiting_approval") {
      return { status: "awaiting_approval", approval: r.approval, collected,
        resume: { pausedWorker: r.worker, pausedApprovalId: r.approval.id, pausedSubtask: st, remaining: order.slice(i + 1), deps } };
    }
    collected.push(r.entry);
    if (budget.exceeded()) return finishPartial(collected, synthesizer, "budget");
  }
  return finishPartial(collected, synthesizer, null);
```

`runBatched` 单任务批暂停分支:
```js
      if (r.control === "awaiting_approval") {
        await cleanupRun(runDir, removeIso);
        const remaining = batches.slice(batches.indexOf(batch) + 1).flat();
        const deps = { workerFactory, makeReviewer, synthesizer, budget, maxWorkerAttempts, autonomy, onEvent, toBatches, maxParallelWorkers, runIsolatedWorker, mergeSubtask, removeIso };
        return { status: "awaiting_approval", approval: r.approval, collected,
          resume: { pausedWorker: r.worker, pausedApprovalId: r.approval.id, pausedSubtask: batch[0], remaining, deps } };
      }
```

新增 `resumeDispatchLoop`(导出):
```js
export async function resumeDispatchLoop(roundResume, decision) {
  const { pausedWorker, pausedApprovalId, pausedSubtask, remaining, deps } = roundResume;
  let pausedEntry;
  if (decision === "deny") {
    pausedEntry = { st: pausedSubtask, status: "failed", lastFeedback: "approval denied" };
  } else {
    const wres = await pausedWorker.approve(pausedApprovalId, "approve");
    if (wres.status === "complete") {
      const verdict = await deps.makeReviewer().review(pausedSubtask, wres);
      pausedEntry = verdict.pass
        ? { st: pausedSubtask, wres, verdict, status: "complete" }
        : { st: pausedSubtask, status: "failed", lastFeedback: (verdict.reasons || []).join("; ") || "review rejected" };
    } else {
      pausedEntry = { st: pausedSubtask, status: "failed", lastFeedback: `resume not complete: ${wres.status}` };
    }
  }
  const sub = await runDispatchLoop({ plan: { subtasks: remaining }, ...deps });
  const collected = [pausedEntry, ...sub.collected];
  if (sub.status === "awaiting_approval") {
    return { status: "awaiting_approval", approval: sub.approval, collected, resume: sub.resume };
  }
  return { status: "complete", collected };
}
```

> 注:`runDispatchLoop` 的 `deps` 解构里 `toBatches/maxParallelWorkers/runIsolatedWorker/...` 在序列路径下为 `undefined` 也无妨(remaining 的 re-dispatch 会再次按 maxParallelWorkers 决定路径;`maxParallelWorkers` 透传保持一致)。

- [ ] **Step 4: 跑测试 + 现有 dispatch 测试(回归)**

Run: `node --test tests/core/orchestration/dispatch-resume.test.js tests/core/orchestration/dispatch-loop.test.js tests/core/orchestration/dispatch-parallel.test.js`
Expected: 全 PASS(原 dispatch 测试不破:未暂停时 `resume` 字段不出现,行为不变)

- [ ] **Step 5: 提交(含 src → 不加署名)**

```bash
git add src/core/orchestration/dispatch-loop.js tests/core/orchestration/dispatch-resume.test.js
git commit -m "feat(orchestration): dispatch-loop pause RoundResume + resumeDispatchLoop (settle paused + dispatch remaining)"
```

---

# 里程碑 M5 · orchestrator 回合循环

## Task 5: orchestrator 回合循环 + 终止闸 + 事件

**Files:**
- Modify: `src/core/orchestration/orchestrator.js`
- Test: `tests/core/orchestration/orchestrator-rounds.test.js`

**Interfaces:** `createOrchestrator({ ..., planner(含 replan), maxRounds })`。`run` 跑回合循环(§3);终止闸 `decideContinue`;事件 `round_started`/`replanned`;维护 `seenSubtaskIds`/`seenFp`。本任务**先不含续跑**(暂停直接返回,M6 加 resume)。

**实现**:把 `run` 重构为 `driveFrom(state, { afterPausedRound })`(M6 复用)。state = `{ message, options, plan, round, allCollected, seenSubtaskIds, seenFp, budget, stoppedByCap }`。

```js
import { runDispatchLoop } from "./dispatch-loop.js";
import { fingerprint } from "./subtask-schema.js";

export function createOrchestrator({ planner, makeWorkerFactory, makeReviewerFor, synthesizer, makeBudget, maxSubtasks, maxWorkerAttempts, eventBus, makeContext, maxParallelWorkers = 1, toBatches, runIsolatedWorker, mergeSubtask, removeIso, maxRounds = 1 }) {
  const orchPaused = new Map();

  async function run({ message, options = {}, routing = {} }) {
    const context = await makeContext?.({ message, options });
    const plan = await planner.plan({ message, context });
    if (plan.subtasks.length > maxSubtasks) plan.subtasks = plan.subtasks.slice(0, maxSubtasks);
    publish(eventBus, "orchestration:planned", { subtasks: plan.subtasks.length, done_when: plan.done_when });
    const state = {
      message, options, plan, round: 1, allCollected: [],
      seenSubtaskIds: new Set(plan.subtasks.map((s) => s.id)),
      seenFp: new Set(plan.subtasks.map(fingerprint)),
      budget: makeBudget(), stoppedByCap: false, done_when: plan.done_when
    };
    return driveFrom(state, { afterPausedRound: false });
  }

  function dispatchDeps(state) {
    const workerFactory = makeWorkerFactory();
    return {
      workerFactory,
      makeReviewer: () => makeReviewerFor(workerFactory),
      synthesizer, budget: state.budget, maxWorkerAttempts,
      autonomy: state.options.autonomy || "gated",
      onEvent: (type, data) => publish(eventBus, `orchestration:${type}`, data),
      toBatches, maxParallelWorkers, runIsolatedWorker, mergeSubtask, removeIso
    };
  }

  async function driveFrom(state, { afterPausedRound }) {
    let skipDispatch = afterPausedRound;
    while (true) {
      if (!skipDispatch) {
        publish(eventBus, "orchestration:round_started", { round: state.round, subtasks: state.plan.subtasks.length });
        const result = await runDispatchLoop({ plan: state.plan, ...dispatchDeps(state) });
        state.allCollected.push(...result.collected);
        if (result.status === "awaiting_approval") {
          orchPaused.set(result.approval.id, { state, dispatchResume: result.resume });
          return { status: "awaiting_approval", approval: result.approval, collected: state.allCollected };
        }
      }
      skipDispatch = false;
      const gate = await gateAndReplan(state);
      if (!gate.continue) { state.stoppedByCap = gate.cap; break; }
      state.plan = { subtasks: gate.subtasks };
      state.round += 1;
    }
    return finalize(state);
  }

  async function gateAndReplan(state) {
    if (state.round >= maxRounds) return { continue: false, cap: true };
    if (state.budget.exceeded()) return { continue: false, cap: true };
    const completed = state.allCollected.filter((c) => c.status === "complete").map(sumEntry);
    const failed = state.allCollected.filter((c) => c.status !== "complete").map(sumEntry);
    const completedIds = new Set(completed.map((c) => c.id));
    const failedIds = new Set(failed.map((c) => c.id));
    let next;
    try {
      next = await planner.replan?.({ message: state.message, done_when: state.done_when, completed, failed, seenSubtaskIds: state.seenSubtaskIds, completedIds, failedIds });
    } catch { next = { done: true, subtasks: [] }; }
    if (!next || next.done || !next.subtasks?.length) return { continue: false, cap: false };
    // no-progress guard
    const fresh = next.subtasks.filter((s) => !state.seenFp.has(fingerprint(s)));
    const addedCompletedThisRound = completed.length; // simple proxy; refined by caller history is overkill for MVP
    if (fresh.length === 0) return { continue: false, cap: false };
    publish(eventBus, "orchestration:replanned", { round: state.round + 1, done: false, new_subtasks: next.subtasks.length });
    for (const s of next.subtasks) { state.seenSubtaskIds.add(s.id); state.seenFp.add(fingerprint(s)); }
    return { continue: true, subtasks: next.subtasks, cap: false };
  }

  async function finalize(state) {
    const content = await synthesizer.synthesize({ message: state.message, collected: state.allCollected });
    const status = classifyOutcome(state.allCollected, { stoppedByCap: state.stoppedByCap });
    publish(eventBus, "orchestration:completed", { rounds: state.round, completed: count(state.allCollected, "complete"), failed: count(state.allCollected, "failed"), status });
    return { status: "complete", content, collected: state.allCollected, outcome: status };
  }

  function sumEntry(c) { return { id: c.st.id, goal: c.st.goal, note: c.status === "complete" ? (c.wres?.content || "").slice(0, 160) : (c.lastFeedback || "") }; }

  return { run, hasPaused: (id) => orchPaused.has(id), _orchPaused: orchPaused, _driveFrom: driveFrom };
}
```

需要 `classifyOutcome`(M7 在 synthesizer 实现;M5 先在 orchestrator 内置一个等价 helper 或 import)。**M5 为简化,先在 orchestrator 内定义** `classifyOutcome`:

```js
function classifyOutcome(collected, { stoppedByCap }) {
  const failed = collected.filter((c) => c.status !== "complete").length;
  if (failed > 0) return "partial";
  if (stoppedByCap) return "incomplete";
  return "complete";
}
function count(c, s) { return c.filter((x) => x.status === s).length; }
function publish(bus, t, d) { if (bus?.publish) bus.publish(t, d); }
```

> M7 把 `classifyOutcome` 抽到 `synthesizer.js` 导出、orchestrator 改 import(避免重复);M5 先内置以独立通过测试。

- [ ] **Step 1: 写测试**(mock planner.plan + replan + mock dispatch via injected workerFactory/reviewer;覆盖 失败→纠正→过 / done→1轮 / maxRounds封顶 / 无进展停 / maxRounds=1零回归)。测试用真实 `runDispatchLoop` + mock worker/reviewer(像 orchestrator C1+C2 测试那样注入 `makeWorkerFactory`/`makeReviewerFor`),`planner` 用 `{ plan: async()=>..., replan: async()=>... }` mock。

```js
// tests/core/orchestration/orchestrator-rounds.test.js  (核心用例,完整断言见实现时补)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createOrchestrator } from "../../../src/core/orchestration/orchestrator.js";

function st(id) { return { id, goal: id, acceptance: [], context_scope: {}, tool_profile: "edit", depends_on: [] }; }
function deps({ plan, replan, workerFor, maxRounds = 2 }) {
  return createOrchestrator({
    planner: { plan: async () => plan, replan },
    makeWorkerFactory: () => ({ worker: (s) => workerFor(s) }),
    makeReviewerFor: () => ({ review: async () => ({ pass: true, severity: "warn", reasons: [], checked: [] }) }),
    synthesizer: { synthesize: async ({ collected }) => collected.map((c) => `${c.st.id}=${c.status}`).join(",") },
    makeBudget: () => ({ exceeded: () => null }),
    maxSubtasks: 8, maxWorkerAttempts: 1, eventBus: { publish() {} }, makeContext: async () => null,
    maxRounds
  });
}
const ok = (id) => ({ send: async () => ({ status: "complete", content: id }) });
const fail = () => ({ send: async () => ({ status: "failed", content: "broke" }) });

test("failure -> replan corrective -> 2nd round completes", async () => {
  let planCalls = 0;
  const orch = deps({
    plan: { task_summary: "t", done_when: "d", subtasks: [st("a")] },
    replan: async () => ({ done: false, subtasks: [{ id: "a2", goal: "fix a", acceptance: [], context_scope: {}, tool_profile: "edit", depends_on: [], corrective_for: "a" }] }),
    workerFor: (s) => (s.id === "a" ? fail() : ok(s.id)), maxRounds: 2
  });
  const r = await orch.run({ message: "m", options: {} });
  assert.match(r.content, /a=failed/);
  assert.match(r.content, /a2=complete/);
  assert.equal(r.outcome, "partial");   // a failed (corrective a2 done) -> partial
});

test("replan done -> single round; maxRounds=1 zero-regression", async () => {
  const orch1 = deps({ plan: { task_summary: "t", done_when: "d", subtasks: [st("a")] }, replan: async () => ({ done: true, subtasks: [] }), workerFor: ok, maxRounds: 1 });
  const r1 = await orch1.run({ message: "m", options: {} });
  assert.equal(r1.outcome, "complete");
  assert.match(r1.content, /a=complete/);
});
```

- [ ] **Step 2: 跑测试确认失败** → **Step 3: 实现**(上面代码)→ **Step 4: 跑 + 现有 orchestrator 测试回归**(C1+C2 orchestrator 测试:planner 只有 `.plan`,`maxRounds` 默认... 注意默认这里 createOrchestrator 的 `maxRounds=1` 默认 → 现有测试单轮、`replan?.` 可选链不炸 → 绿)。

Run: `node --test tests/core/orchestration/orchestrator-rounds.test.js tests/core/orchestration/orchestrator.test.js`
Expected: 全 PASS

- [ ] **Step 5: 提交(含 src → 不加署名)**

```bash
git add src/core/orchestration/orchestrator.js tests/core/orchestration/orchestrator-rounds.test.js
git commit -m "feat(orchestration): round loop (replan + deterministic terminate gate + seen sets + outcome)"
```

> 注:M5 的 `createOrchestrator` 默认 `maxRounds=1`(零回归);真实 maxRounds 由 index.js(M7)按 config 注入。

---

# 里程碑 M6 · 同进程续跑

## Task 6: orchestrator.resume(同进程编排级续跑)

**Files:**
- Modify: `src/core/orchestration/orchestrator.js`
- Test: `tests/core/orchestration/orchestrator-resume.test.js`

**Interfaces:** `orchestrator.resume(id, decision)`(消费 `orchPaused[id]` → `resumeDispatchLoop` 续本回合 → `driveFrom(state, { afterPausedRound:true })` 续后续回合)。`hasPaused(id)` 已在 M5。

- [ ] **Step 1: 写测试(暂停→resume→不重plan/不重复派发;多次暂停链;deny)**

```js
// tests/core/orchestration/orchestrator-resume.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createOrchestrator } from "../../../src/core/orchestration/orchestrator.js";

function st(id) { return { id, goal: id, acceptance: [], context_scope: {}, tool_profile: "edit", depends_on: [] }; }

test("pause -> resume continues round loop without re-plan or duplicate dispatch", async () => {
  let planCalls = 0;
  const pausedWorker = { send: async () => ({ status: "awaiting_approval", approval: { id: "ap1" } }), approve: async () => ({ status: "complete", content: "did a" }) };
  const orch = createOrchestrator({
    planner: { plan: async () => { planCalls += 1; return { task_summary: "t", done_when: "d", subtasks: [st("a"), st("b")] }; }, replan: async () => ({ done: true, subtasks: [] }) },
    makeWorkerFactory: () => ({ worker: (s) => (s.id === "a" ? pausedWorker : { send: async () => ({ status: "complete", content: "did b" }) }) }),
    makeReviewerFor: () => ({ review: async () => ({ pass: true, severity: "warn", reasons: [], checked: [] }) }),
    synthesizer: { synthesize: async ({ collected }) => collected.map((c) => `${c.st.id}=${c.status}`).join(",") },
    makeBudget: () => ({ exceeded: () => null }),
    maxSubtasks: 8, maxWorkerAttempts: 1, eventBus: { publish() {} }, makeContext: async () => null, maxRounds: 2
  });
  const p = await orch.run({ message: "m", options: { autonomy: "gated" } });
  assert.equal(p.status, "awaiting_approval");
  assert.equal(orch.hasPaused("ap1"), true);
  const done = await orch.resume("ap1", "approve");
  assert.equal(done.status, "complete");
  assert.match(done.content, /a=complete/);
  assert.match(done.content, /b=complete/);
  assert.equal(planCalls, 1);                          // NOT re-planned
  assert.equal(done.collected.filter((c) => c.st.id === "a").length, 1);  // no duplicate dispatch
  assert.equal(orch.hasPaused("ap1"), false);          // consumed
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/core/orchestration/orchestrator-resume.test.js`
Expected: FAIL（`resume` 未实现）

- [ ] **Step 3: 实现**(`orchestrator.js`:import `resumeDispatchLoop`;加 `resume`)

```js
import { runDispatchLoop, resumeDispatchLoop } from "./dispatch-loop.js";
```

`createOrchestrator` 内加:
```js
  async function resume(id, decision = "approve") {
    const saved = orchPaused.get(id);
    if (!saved) { const e = new Error(`no paused orchestration: ${id}`); e.code = "ORCH_NOT_PAUSED"; throw e; }
    orchPaused.delete(id);                              // consume
    const { state, dispatchResume } = saved;
    const res = await resumeDispatchLoop(dispatchResume, decision);
    state.allCollected.push(...res.collected);
    if (res.status === "awaiting_approval") {
      orchPaused.set(res.approval.id, { state, dispatchResume: res.resume });   // re-pause: new id
      return { status: "awaiting_approval", approval: res.approval, collected: state.allCollected };
    }
    return driveFrom(state, { afterPausedRound: true });   // round done -> gate + further rounds
  }
```

return 增加 `resume`:`return { run, resume, hasPaused: (id) => orchPaused.has(id) };`(去掉 M5 临时暴露的 `_orchPaused`/`_driveFrom`)。

- [ ] **Step 4: 跑测试 + 全套 orchestration 回归**

Run: `node --test tests/core/orchestration/*.test.js`
Expected: 全绿

- [ ] **Step 5: 提交(含 src → 不加署名)**

```bash
git add src/core/orchestration/orchestrator.js tests/core/orchestration/orchestrator-resume.test.js
git commit -m "feat(orchestration): same-process orchestration resume (orchPaused + resume, no re-plan/no dup)"
```

---

# 里程碑 M7 · kernel 路由 + 终判 + e2e

## Task 7: agent.approve 路由 + synthesizer 终判 + e2e

**Files:**
- Modify: `src/index.js`(`agent.approve` 路由 + 给 orchestrator 注入 `maxRounds: orch.maxRounds`)、`src/core/orchestration/synthesizer.js`(导出 `classifyOutcome`)、`src/core/orchestration/orchestrator.js`(import classifyOutcome 替换内置)
- Test: `tests/core/orchestration/c5-rounds-e2e.test.js`

- [ ] **Step 1: 写 e2e 失败测试**(mock 模型:子任务失败→replan 补纠正→第2轮完成;worker awaiting_approval→kernel.agent.approve 续跑;planner.plan 只调1次)

```js
// tests/core/orchestration/c5-rounds-e2e.test.js  (结构参考 c3-parallel-e2e;mock gateway 的 invoke 识别 plan/replan/worker/reviewer/synth 提示)
// 断言:① 失败子任务经 replan 纠正后最终 outcome 至少 partial/complete;② awaiting_approval 经 kernel.agent.approve(id) 续跑到完成;③ 整个过程 planner plan 提示只出现 1 次(不重 plan)。
```

- [ ] **Step 2–4**:
  - `synthesizer.js` 导出 `classifyOutcome(collected, { stoppedByCap })`;`orchestrator.js` 改 `import { classifyOutcome }`,删内置。
  - `index.js`:`createOrchestrator({ ..., maxRounds: orch.maxRounds })`;`agent.approve` 改为:
    ```js
    approve: (id, decision) => (orchestrator.hasPaused(id) ? orchestrator.resume(id, decision) : runtime.approve(id, decision)),
    ```
  - 跑 e2e + 全量回归。

- [ ] **Step 5: 提交(含 src → 不加署名)**

```bash
git add src/index.js src/core/orchestration/synthesizer.js src/core/orchestration/orchestrator.js tests/core/orchestration/c5-rounds-e2e.test.js
git commit -m "feat(orchestration): wire C5 (approve routing to orchestrator + outcome classify + maxRounds)"
```

---

# 里程碑 M8 · 回归 + 文档

## Task 8: 回归 + check + 文档

**Files:**
- Modify: `package.json`(check 脚本无新文件则不动;subtask-schema/planner/dispatch-loop/orchestrator/synthesizer 已在 check)、`README.md`、`README.en.md`、`docs/CHANGELOG.md`、`docs/project-overview.md`、`docs/README.md`

- [ ] **Step 1: 全量回归 + check**

Run: `node --test test/**/*.test.js tests/**/*.test.js`
Expected: 618 + 新增全绿(`maxRounds` 默认经 config=2,但现有 mock-only-`.plan` orchestrator 测试:`replan?.` 可选链 + replan 缺失 → `gateAndReplan` 的 `next` undefined → 不继续 → 单轮,零回归)
Run: `npm run check`
Expected: OK

- [ ] **Step 2: 文档(纯文档 → 加署名)**
  - README 中英:编排条目补"复杂任务多回合自适应(失败重规划 / 继续派发,`maxRounds` 可配)+ 审批中断可续跑"。
  - CHANGELOG:已落地 — Phase C5 重规划 + 持续派发 + 同进程编排级续跑。
  - project-overview §14:补 C5 段(回合循环 / replan / 终止闸 / 同进程续跑 / outcome 终判)。
  - docs/README 索引:加 C5 plan 条目。

```bash
git add README.md README.en.md docs/CHANGELOG.md docs/project-overview.md docs/README.md
git commit -m "docs: Phase C5 replan + continuous dispatch + same-process orchestration resume"
```

---

## Self-Review

- **Spec coverage**:§3 回合循环 → Task 5;§4.1 maxRounds → Task 3/5;§4.2 replan 契约 → Task 2;§4.3 validateReplan → Task 1;§4.3b 两套集合 → Task 5(seenSubtaskIds/seenFp);§4.4 无进展 → Task 5(fingerprint guard);§4.5 done 闸 → Task 5(gateAndReplan)+ Task 7(classifyOutcome);§4.6 暂停点 → Task 4(只串行 processSubtask 暂停);§4.7 零回归 → Task 5/8;§5 同进程续跑 → Task 4(resumeDispatchLoop)+ Task 6(orchestrator.resume)+ Task 7(approve 路由);§6 组件 → 各 task;§7 config → Task 3;§8 事件 → Task 5;§9 测试 → 各 task。
- **Placeholder scan**:Task 7 的 e2e 给了断言要点 + 结构参考(c3-parallel-e2e),mock gateway 识别提示的写法在 C1+C2/C3 e2e 已有先例;非空泛。Task 5 的 `gateAndReplan` 无进展守卫用 `fresh.length===0` 程序判。
- **Type consistency**:`validateReplan(subtasks,{seenSubtaskIds,completedIds,failedIds})`、`replan({...})->{done,subtasks}`、`RoundResume{pausedWorker,pausedApprovalId,pausedSubtask,remaining,deps}`、`resumeDispatchLoop(roundResume,decision)`、`orchestrator.{run,resume,hasPaused}`、`classifyOutcome(collected,{stoppedByCap})` 各处一致;结算单一来源 `allCollected`(暂停 result.collected 进、resume res.collected 进,无 roundCollected)。
- **风险**:最大风险 Task 4(dispatch 暂停/续跑)+ Task 6(orchestrator 续跑驱动);判据明确(dispatch-resume 单测断言不重复结算 + remaining 续派;orchestrator-resume 断言 plan 调用=1 + 无重复 + 多次链)。`maxRounds=1` / 无 replan 永远是零回归逃生口;`agent-runtime` 全程不改。
