// tests/unit/core/orchestration/planner.test.js — 规划器(经验/重规划/子任务/batch)领域测试
//
// v1.19.1 测试归并:本文件由下列历史任务单测试合并而成,每个来源包裹在独立
// describe 块中(异步回调 + 动态 import,来源间零共享绑定),测试语义与拆分前一致。
import { describe } from "node:test";

// ---------------------------------------------------------------------------
// 来源:tests/core/orchestration/planner.test.js
// ---------------------------------------------------------------------------
describe("core/orchestration/planner", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createPlanner } = await import("../../../../src/core/orchestration/planner.js");

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
});

// ---------------------------------------------------------------------------
// 来源:tests/core/orchestration/planner-experiences.test.js
// ---------------------------------------------------------------------------
describe("core/orchestration/planner-experiences", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createPlanner } = await import("../../../../src/core/orchestration/planner.js");

  const validPlanJson = (extra = "") => JSON.stringify({
    task_summary: "s", done_when: "d",
    subtasks: [{ id: "st1", goal: "g", acceptance: ["a"], context_scope: { files: [] }, tool_profile: "edit", depends_on: [] }],
    ...(extra ? JSON.parse(extra) : {})
  });

  test("experiences are injected into the planner prompt; used_experience_ids parsed", async () => {
    let seen = "";
    const callModel = async (p) => { seen = p; return validPlanJson('{"used_experience_ids":["exp_1"]}'); };
    const planner = createPlanner({ callModel });
    const plan = await planner.plan({ message: "x", experiences: [{ id: "exp_1", lesson: "prefer X over Y", tier: 1 }] });
    assert.match(seen, /prefer X over Y/);
    assert.match(seen, /used_experience_ids/);
    assert.deepEqual(plan.used_experience_ids, ["exp_1"]);
  });

  test("no experiences → no experience section, used_experience_ids defaults to []", async () => {
    let seen = "";
    const callModel = async (p) => { seen = p; return validPlanJson(); };
    const planner = createPlanner({ callModel });
    const plan = await planner.plan({ message: "x" });
    assert.ok(!/past experience/i.test(seen));
    assert.ok(!/used_experience_ids/.test(seen));
    assert.deepEqual(plan.used_experience_ids, []);
  });

  test("malformed used_experience_ids ignored (defaults to [])", async () => {
    const callModel = async () => validPlanJson('{"used_experience_ids":"nope"}');
    const planner = createPlanner({ callModel });
    const plan = await planner.plan({ message: "x", experiences: [{ id: "exp_1", lesson: "L", tier: 2 }] });
    assert.deepEqual(plan.used_experience_ids, []);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/core/orchestration/planner-replan.test.js
// ---------------------------------------------------------------------------
describe("core/orchestration/planner-replan", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createPlanner } = await import("../../../../src/core/orchestration/planner.js");

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

  test("invalid subtasks (id collision) -> conservative done", async () => {
    const COLLIDE = JSON.stringify({ done: false, subtasks: [{ id: "st_1", goal: "g", acceptance: [], context_scope: {}, tool_profile: "edit", depends_on: [] }] });
    const planner = createPlanner({ callModel: async () => COLLIDE, maxPlanRepairs: 0 });
    const r = await planner.replan({ message: "m", done_when: "d", completed: [], failed: [], ...ctx });
    assert.equal(r.done, true);
  });

  test("plan still works (createPlanner returns both)", async () => {
    const planner = createPlanner({ callModel: async () => '{"task_summary":"t","done_when":"d","subtasks":[{"id":"st_1","goal":"g","acceptance":[],"context_scope":{},"tool_profile":"edit","depends_on":[]}]}' });
    assert.equal(typeof planner.plan, "function");
    assert.equal(typeof planner.replan, "function");
    const p = await planner.plan({ message: "m", context: null });
    assert.equal(p.subtasks.length, 1);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/core/orchestration/replan-schema.test.js
// ---------------------------------------------------------------------------
describe("core/orchestration/replan-schema", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { validateReplan, fingerprint } = await import("../../../../src/core/orchestration/subtask-schema.js");

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
    assert.equal(validateReplan([st("n1", ["f1"], { corrective_for: "nope" })], ctx()).ok, false);
  });

  test("rejects dep on unknown id", () => {
    assert.equal(validateReplan([st("n1", ["ghost"])], ctx()).ok, false);
  });

  test("fingerprint stable across id renames, sensitive to goal; file order-insensitive", () => {
    assert.equal(fingerprint(st("a")) === fingerprint({ ...st("b"), goal: "a" }), false); // goal a vs b differ
    const x = { id: "x", goal: "do", context_scope: { files: ["b.js", "a.js"] }, tool_profile: "edit" };
    const y = { id: "y", goal: "do", context_scope: { files: ["a.js", "b.js"] }, tool_profile: "edit" };
    assert.equal(fingerprint(x), fingerprint(y));
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/core/orchestration/subtask-schema.test.js
// ---------------------------------------------------------------------------
describe("core/orchestration/subtask-schema", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { validatePlan, validateVerdict, topoOrder, hasCycle } = await import("../../../../src/core/orchestration/subtask-schema.js");

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
});

// ---------------------------------------------------------------------------
// 来源:tests/core/orchestration/batch-planner.test.js
// ---------------------------------------------------------------------------
describe("core/orchestration/batch-planner", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { toBatches } = await import("../../../../src/core/orchestration/batch-planner.js");

  function st(id, files, deps = []) { return { id, context_scope: files ? { files } : {}, depends_on: deps }; }

  test("independent disjoint subtasks form one parallel batch", () => {
    const subs = [st("a", ["src/a.js"]), st("b", ["src/b.js"])];
    const batches = toBatches(subs, { completedIds: new Set(), maxParallelWorkers: 4 });
    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0].map((s) => s.id).sort(), ["a", "b"]);
  });

  test("overlapping scopes split into separate batches", () => {
    const subs = [st("a", ["src/shared.js"]), st("b", ["src/shared.js"])];
    const batches = toBatches(subs, { completedIds: new Set(), maxParallelWorkers: 4 });
    assert.equal(batches.length, 2);
  });

  test("no declared scope -> own batch (not parallelized)", () => {
    const subs = [st("a", null), st("b", ["src/b.js"])];
    const batches = toBatches(subs, { completedIds: new Set(), maxParallelWorkers: 4 });
    assert.equal(batches[0].length, 1);   // a alone
  });

  test("dependencies gate batching", () => {
    const subs = [st("a", ["src/a.js"]), st("b", ["src/b.js"], ["a"])];
    const batches = toBatches(subs, { completedIds: new Set(), maxParallelWorkers: 4 });
    assert.deepEqual(batches.map((b) => b.map((s) => s.id)), [["a"], ["b"]]);
  });

  test("maxParallelWorkers=1 -> every batch size 1", () => {
    const subs = [st("a", ["src/a.js"]), st("b", ["src/b.js"])];
    const batches = toBatches(subs, { completedIds: new Set(), maxParallelWorkers: 1 });
    assert.deepEqual(batches.map((b) => b.length), [1, 1]);
  });
});
