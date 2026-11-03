// tests/unit/core/orchestration/orchestrator.test.js — 编排器主循环(评审/综合/经验接线/并行/多轮)领域测试
//
// v1.19.1 测试归并:本文件由下列历史任务单测试合并而成,每个来源包裹在独立
// describe 块中(异步回调 + 动态 import,来源间零共享绑定),测试语义与拆分前一致。
import { describe } from "node:test";

// ---------------------------------------------------------------------------
// 来源:tests/core/orchestration/orchestrator.test.js
// ---------------------------------------------------------------------------
describe("core/orchestration/orchestrator", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createOrchestrator } = await import("../../../../src/core/orchestration/orchestrator.js");

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
});

// ---------------------------------------------------------------------------
// 来源:tests/core/orchestration/orchestrator-rounds.test.js
// ---------------------------------------------------------------------------
describe("core/orchestration/orchestrator-rounds", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createOrchestrator } = await import("../../../../src/core/orchestration/orchestrator.js");

  function st(id) { return { id, goal: id, acceptance: [], context_scope: {}, tool_profile: "edit", depends_on: [] }; }
  const ok = (id) => ({ send: async () => ({ status: "complete", content: id }) });
  const fail = () => ({ send: async () => ({ status: "failed", content: "broke" }) });

  function makeOrch({ plan, replan, workerFor, maxRounds = 2 }) {
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

  test("failure -> replan corrective -> 2nd round completes (outcome partial)", async () => {
    const orch = makeOrch({
      plan: { task_summary: "t", done_when: "d", subtasks: [st("a")] },
      replan: async () => ({ done: false, subtasks: [{ id: "a2", goal: "fix a", acceptance: [], context_scope: {}, tool_profile: "edit", depends_on: [], corrective_for: "a" }] }),
      workerFor: (s) => (s.id === "a" ? fail() : ok(s.id)), maxRounds: 2
    });
    const r = await orch.run({ message: "m", options: {} });
    assert.match(r.content, /a=failed/);
    assert.match(r.content, /a2=complete/);
    assert.equal(r.outcome, "partial");
  });

  test("replan done -> single round; outcome complete", async () => {
    const orch = makeOrch({ plan: { task_summary: "t", done_when: "d", subtasks: [st("a")] }, replan: async () => ({ done: true, subtasks: [] }), workerFor: ok, maxRounds: 2 });
    const r = await orch.run({ message: "m", options: {} });
    assert.equal(r.outcome, "complete");
    assert.match(r.content, /a=complete/);
  });

  test("maxRounds=1 -> exactly one dispatch, no replan (zero regression)", async () => {
    let replanCalls = 0;
    const orch = makeOrch({ plan: { task_summary: "t", done_when: "d", subtasks: [st("a")] }, replan: async () => { replanCalls += 1; return { done: false, subtasks: [st("b")] }; }, workerFor: ok, maxRounds: 1 });
    const r = await orch.run({ message: "m", options: {} });
    assert.equal(replanCalls, 0);          // maxRounds=1 -> never replan
    assert.match(r.content, /a=complete/);
    assert.equal(/b=/.test(r.content), false);
  });

  test("no-progress guard: round completed nothing + replan all stale fingerprints -> stop", async () => {
    // round 1: a fails (zero completed). replan returns a same-fingerprint retry (renamed id) -> stale -> stop.
    const orch = makeOrch({
      plan: { task_summary: "t", done_when: "d", subtasks: [st("a")] },
      replan: async () => ({ done: false, subtasks: [{ id: "a_again", goal: "a", acceptance: [], context_scope: {}, tool_profile: "edit", depends_on: [] }] }),
      workerFor: fail, maxRounds: 5
    });
    const r = await orch.run({ message: "m", options: {} });
    assert.match(r.content, /a=failed/);
    assert.equal(/a_again/.test(r.content), false);   // never dispatched (no progress)
    assert.equal(r.outcome, "partial");
  });

  test("no replan method -> single round (zero regression)", async () => {
    const orch = makeOrch({ plan: { task_summary: "t", done_when: "d", subtasks: [st("a")] }, replan: undefined, workerFor: ok, maxRounds: 3 });
    const r = await orch.run({ message: "m", options: {} });
    assert.match(r.content, /a=complete/);
    assert.equal(r.outcome, "complete");
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/core/orchestration/orchestrator-serialize.test.js
// ---------------------------------------------------------------------------
describe("core/orchestration/orchestrator-serialize", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createOrchestrator } = await import("../../../../src/core/orchestration/orchestrator.js");
  const { createCostBudget } = await import("../../../../src/core/runtime/cost-budget.js");

  function build() {
    return createOrchestrator({
      planner: { plan: async () => ({ subtasks: [] }) },
      makeWorkerFactory: () => ({ worker: () => ({}) }),
      makeReviewerFor: () => ({ review: async () => ({}) }),
      synthesizer: { synthesize: async () => "" },
      makeBudget: () => createCostBudget({ maxTokens: 100, maxModelCalls: 10 }),
      makeResumedBudget: (s) => createCostBudget({ maxTokens: s.maxTokens, maxModelCalls: s.maxModelCalls, initialTokens: s.initialTokens, initialModelCalls: s.initialModelCalls }),
      maxSubtasks: 8, maxWorkerAttempts: 1, eventBus: { publish() {} }, makeContext: async () => null, maxRounds: 2,
      env: { root: "/root", orchestrationConfig: { maxRounds: 2 } }
    });
  }

  function fakeState() {
    const budget = createCostBudget({ maxTokens: 100, maxModelCalls: 10 });
    budget.recordModelResult({ usage: { total_tokens: 40 } }); // spent 40 tokens / 1 call
    return {
      message: "m", done_when: "d", options: { autonomy: "gated", sessionId: "s" },
      plan: { subtasks: [{ id: "a", goal: "g", acceptance: [], context_scope: {}, tool_profile: "edit", depends_on: [] }] },
      round: 1, allCollected: [], seenSubtaskIds: new Set(["a"]), seenFp: new Set(["fp"]),
      budget, adoptedExperienceIds: [], riskCues: new Set(), taskId: "task_1", sessionId: "s",
      env: { root: "/root", orchestrationConfig: { maxRounds: 2 } }
    };
  }

  test("serializeState → deserializeState rebuilds a live budget that CONTINUES from spend (CST-8)", () => {
    const orch = build();
    const json = orch.serializeState(fakeState(), {
      approvalId: "ap1",
      pausedSubtask: { id: "b", goal: "gb", acceptance: [], context_scope: {}, tool_profile: "edit", depends_on: [] },
      remaining: []
    });
    assert.equal(json.budget.spentTokens, 40);
    assert.equal(json.budget.quotaTokens, 100);

    const state = orch.deserializeState(JSON.parse(JSON.stringify(json)));
    assert.equal(state.budget.snapshot().tokens, 40);            // continues, not reset
    assert.equal(state.budget.exceeded(), null);
    state.budget.recordModelResult({ usage: { total_tokens: 65 } }); // 40 + 65 = 105 >= 100
    assert.equal(state.budget.exceeded().reason, "max_tokens");
    assert.ok(state.seenSubtaskIds.has("a"));
    assert.equal(state.taskId, "task_1");
    assert.equal(state.pausedSubtask.id, "b");
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/core/orchestration/reviewer.test.js
// ---------------------------------------------------------------------------
describe("core/orchestration/reviewer", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createReviewer } = await import("../../../../src/core/orchestration/reviewer.js");

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
});

// ---------------------------------------------------------------------------
// 来源:tests/core/orchestration/synthesizer.test.js
// ---------------------------------------------------------------------------
describe("core/orchestration/synthesizer", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createSynthesizer } = await import("../../../../src/core/orchestration/synthesizer.js");

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
});

// ---------------------------------------------------------------------------
// 来源:tests/core/orchestration/experience-wiring.test.js
// ---------------------------------------------------------------------------
describe("core/orchestration/experience-wiring", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createOrchestrator } = await import("../../../../src/core/orchestration/orchestrator.js");

  function mk({ crossTaskLearning, planUsed = [], presentedIds = [], procedural = [] }) {
    const calls = { retrieval: 0, consolidate: [], plannerExp: null };
    const orch = createOrchestrator({
      planner: {
        plan: async ({ experiences }) => {
          calls.plannerExp = experiences;
          return {
            task_summary: "s", done_when: "d",
            subtasks: [{ id: "st1", goal: "g", acceptance: ["a"], context_scope: {}, tool_profile: "edit", depends_on: [] }],
            used_experience_ids: planUsed
          };
        }
      },
      makeWorkerFactory: () => ({ worker: () => ({ send: async () => ({ status: "complete", content: "ok" }) }), reviewerRuntime: () => ({}) }),
      makeReviewerFor: () => ({ review: async () => ({ pass: true, severity: "warn", reasons: [], checked: [] }) }),
      synthesizer: { synthesize: async ({ collected }) => `done:${collected.length}` },
      makeBudget: () => ({ exceeded: () => null }),
      maxSubtasks: 8, maxWorkerAttempts: 2, maxRounds: 2,
      crossTaskLearning,
      experienceRetrieval: { query: () => { calls.retrieval += 1; return { procedural, presentedIds, riskCues: new Set(["r"]) }; } },
      experienceConsolidator: { consolidate: async (args) => { calls.consolidate.push(args); return { written: 1 }; } },
      now: () => 1700000000000
    });
    return { orch, calls };
  }

  test("off: no retrieval, no consolidation, planner gets empty experiences (zero regression)", async () => {
    const { orch, calls } = mk({ crossTaskLearning: "off", procedural: [{ id: "e1", lesson: "L", tier: 1 }], presentedIds: ["e1"] });
    const r = await orch.run({ message: "m", options: {} });
    await orch.flushExperience();
    assert.equal(r.status, "complete");
    assert.equal(calls.retrieval, 0);
    assert.equal(calls.consolidate.length, 0);
    assert.deepEqual(calls.plannerExp, []);
  });

  test("on: retrieval feeds planner; consolidation runs with adopted = used ∩ presented", async () => {
    const { orch, calls } = mk({
      crossTaskLearning: "on",
      planUsed: ["e1", "e9"],          // e9 was never presented -> must be dropped
      presentedIds: ["e1", "e2"],
      procedural: [{ id: "e1", lesson: "L1", tier: 1 }, { id: "e2", lesson: "L2", tier: 2 }]
    });
    await orch.run({ message: "m", options: {} });
    await orch.flushExperience();
    assert.equal(calls.retrieval, 1);
    assert.equal(calls.plannerExp.length, 2);
    assert.equal(calls.consolidate.length, 1);
    assert.deepEqual(calls.consolidate[0].adoptedExperienceIds, ["e1"]);
    assert.equal(calls.consolidate[0].outcome, "complete");
    assert.equal(calls.consolidate[0].taskId, "task_" + (1700000000000).toString(36));
  });

  test("run() returns before consolidation completes (background)", async () => {
    let resolved = false;
    const orch = createOrchestrator({
      planner: { plan: async () => ({ task_summary: "s", done_when: "d", subtasks: [{ id: "st1", goal: "g", acceptance: ["a"], context_scope: {}, tool_profile: "edit", depends_on: [] }], used_experience_ids: [] }) },
      makeWorkerFactory: () => ({ worker: () => ({ send: async () => ({ status: "complete", content: "ok" }) }), reviewerRuntime: () => ({}) }),
      makeReviewerFor: () => ({ review: async () => ({ pass: true, severity: "warn", reasons: [], checked: [] }) }),
      synthesizer: { synthesize: async () => "done" },
      makeBudget: () => ({ exceeded: () => null }),
      maxSubtasks: 8, maxWorkerAttempts: 2, maxRounds: 2,
      crossTaskLearning: "on",
      experienceRetrieval: { query: () => ({ procedural: [], presentedIds: [], riskCues: new Set() }) },
      experienceConsolidator: { consolidate: async () => { await new Promise((r) => setTimeout(r, 20)); resolved = true; return { written: 0 }; } },
      now: () => 1
    });
    await orch.run({ message: "m", options: {} });
    assert.equal(resolved, false);   // not awaited by run()
    await orch.flushExperience();
    assert.equal(resolved, true);    // flush awaits it
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/core/orchestration/c3-parallel-e2e.test.js
// ---------------------------------------------------------------------------
describe("core/orchestration/c3-parallel-e2e", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { promises: fs } = await import("node:fs");
  const { createKernel } = await import("../../../../src/index.js");
  const { mkdtemp } = await import("../../../helpers/tmp.js");

  const exists = (p) => fs.access(p).then(() => true, () => false);

  // Mock gateway: planner -> 2 disjoint-scope edit subtasks; each worker -> a diff_apply
  // editing its own file; reviewer -> pass; synth -> final.
  function mockGateway() {
    return {
      invoke: async (messages) => {
        const text = (messages || []).map((m) => m.content).join("\n");
        if (text.includes("Break the user's request")) {
          return { content: JSON.stringify({ task_summary: "t", done_when: "d", subtasks: [
            { id: "st_a", goal: "edit a.js", acceptance: ["a edited"], context_scope: { files: ["a.js"] }, tool_profile: "edit", depends_on: [] },
            { id: "st_b", goal: "edit b.js", acceptance: ["b edited"], context_scope: { files: ["b.js"] }, tool_profile: "edit", depends_on: [] }
          ] }), tool_calls: [] };
        }
        if (text.includes("INDEPENDENT reviewer")) return { content: '{"pass":true,"severity":"warn","reasons":[],"checked":["read"]}', tool_calls: [] };
        if (text.includes("Synthesize a final answer")) return { content: "final", tool_calls: [] };
        // worker: emit one diff_apply for its file (only on first turn -> no tool_calls after)
        const alreadyApplied = text.includes("Applied change");
        if (!alreadyApplied && text.includes("Sub-task: edit a.js")) {
          return { content: "", tool_calls: [{ id: "t1", name: "diff_apply", arguments: { diff: "--- a/a.js\n+++ b/a.js\n@@ -1,1 +1,1 @@\n-base a\n+edited a\n" } }] };
        }
        if (!alreadyApplied && text.includes("Sub-task: edit b.js")) {
          return { content: "", tool_calls: [{ id: "t2", name: "diff_apply", arguments: { diff: "--- a/b.js\n+++ b/b.js\n@@ -1,1 +1,1 @@\n-base b\n+edited b\n" } }] };
        }
        return { content: "done", tool_calls: [] };
      },
      reply: async () => ({ content: "single reply" }),
      getUsageStats: () => ({})
    };
  }

  test("parallel orchestrate: two iso workers edit disjoint files, both merge to main, no residue", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "c3-e2e-"));
    await fs.writeFile(path.join(root, "a.js"), "base a\n");
    await fs.writeFile(path.join(root, "b.js"), "base b\n");
    const events = [];
    const kernel = await createKernel(root, {
      modelGateway: mockGateway(),
      eventBus: { publish: (t, d) => events.push([t, d]), subscribe: () => () => {} },
      sessionLog: null, branchStore: null,
      verifyMode: "off"   // keep iso workers from running the test tool
    });

    const r = await kernel.agent.send("分别编辑 a.js 和 b.js 两个文件");
    assert.ok(events.some(([t]) => t === "orchestration:routed"), "routed");
    assert.ok(events.some(([t]) => t === "orchestration:planned"), "planned");
    // both files merged into MAIN workspace
    assert.equal(await fs.readFile(path.join(root, "a.js"), "utf8"), "edited a\n");
    assert.equal(await fs.readFile(path.join(root, "b.js"), "utf8"), "edited b\n");
    // zero residue: the iso run dir is gone
    assert.equal(await exists(path.join(root, ".deepseek-code/v2/orchestration/iso")) , true); // base dir may exist
    const isoBase = path.join(root, ".deepseek-code/v2/orchestration/iso");
    const leftover = await fs.readdir(isoBase).catch(() => []);
    assert.deepEqual(leftover, [], "no run dirs left behind");
    await kernel.dispose?.();
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/core/orchestration/c4-experience-e2e.test.js
// ---------------------------------------------------------------------------
describe("core/orchestration/c4-experience-e2e", async () => {

  // Confidently-complex message (score >= 3) so the router short-circuits to orchestrate
  // without a model triage call; carries auth/login cues for cross-task retrieval.

  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { promises: fs } = await import("node:fs");
  const { createKernel } = await import("../../../../src/index.js");
  const { mkdtemp } = await import("../../../helpers/tmp.js");

  const MSG = "重构整个 auth login 系统 across multiple 文件";
  const PLAN_JSON = JSON.stringify({
    task_summary: "t", done_when: "d",
    subtasks: [{ id: "st_a", goal: "review auth login", acceptance: ["ok"], context_scope: { files: [] }, tool_profile: "readonly", depends_on: [] }]
  });
  const LESSONS_JSON = '[{"kind":"procedural","lesson":"prefer pooled auth sessions","cues":["auth","login","pool"],"confidence":0.5}]';

  function mockGateway(counters, prompts) {
    return {
      invoke: async (messages) => {
        const text = (messages || []).map((m) => m.content).join("\n");
        prompts.push(text);
        if (text.includes("Break the user's request")) { counters.plan += 1; return { content: PLAN_JSON, tool_calls: [] }; }
        if (text.includes("revising a multi-agent plan")) return { content: '{"done":true,"subtasks":[]}', tool_calls: [] };
        if (text.includes("INDEPENDENT reviewer")) return { content: '{"pass":true,"severity":"warn","reasons":[],"checked":["read"]}', tool_calls: [] };
        if (text.includes("Synthesize a final answer")) return { content: "final", tool_calls: [] };
        if (text.includes("just finished a multi-agent task")) { counters.distill += 1; return { content: LESSONS_JSON, tool_calls: [] }; }
        return { content: "done", tool_calls: [] }; // worker
      },
      reply: async () => ({ content: "single" }),
      getUsageStats: () => ({})
    };
  }

  function capturingBus(events) {
    return { publish: (type, data) => events.push({ type, data }), subscribe: () => () => {} };
  }

  test("on: task1 consolidates a lesson; task2 retrieves it into the planner prompt", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "c4-e2e-on-"));
    const counters = { plan: 0, distill: 0 };
    const prompts = [];
    const events = [];
    const kernel = await createKernel(root, {
      modelGateway: mockGateway(counters, prompts),
      eventBus: capturingBus(events),
      sessionLog: null, branchStore: null, verifyMode: "off",
      orchestration: { crossTaskLearning: "on" }
    });

    const r1 = await kernel.agent.send(MSG, { autonomy: "auto" });
    assert.equal(r1.status, "complete");
    await kernel.experience.flush();                       // wait for background consolidation
    assert.ok(counters.distill >= 1, "consolidator distilled");
    assert.ok(events.some((e) => e.type === "experience:consolidated"), "consolidated event fired");

    const planPromptsBefore = prompts.filter((p) => p.includes("Break the user's request")).length;
    const r2 = await kernel.agent.send(MSG, { autonomy: "auto" });
    assert.equal(r2.status, "complete");
    const task2PlanPrompt = prompts.filter((p) => p.includes("Break the user's request"))[planPromptsBefore];
    assert.ok(task2PlanPrompt.includes("prefer pooled auth sessions"), "task2 planner prompt carries the retrieved lesson");
    assert.ok(events.some((e) => e.type === "experience:retrieved"), "retrieved event fired");
    await kernel.dispose?.();
  });

  test("off (default): zero regression — no consolidation, no experience dir, no experience events", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "c4-e2e-off-"));
    const counters = { plan: 0, distill: 0 };
    const prompts = [];
    const events = [];
    const kernel = await createKernel(root, {
      modelGateway: mockGateway(counters, prompts),
      eventBus: capturingBus(events),
      sessionLog: null, branchStore: null, verifyMode: "off"
      // crossTaskLearning omitted -> default "off"
    });

    const r = await kernel.agent.send(MSG, { autonomy: "auto" });
    assert.equal(r.status, "complete");
    await kernel.experience.flush();
    assert.equal(counters.distill, 0, "no consolidation in off mode");
    assert.ok(!events.some((e) => String(e.type).startsWith("experience:")), "no experience events");
    const planPrompt = prompts.find((p) => p.includes("Break the user's request"));
    assert.ok(!planPrompt.includes("past experience"), "planner prompt has no experience section");
    const dirExists = await fs.stat(path.join(root, ".deepseek-code", "v2", "experience")).then(() => true).catch(() => false);
    assert.equal(dirExists, false, "no experience directory created");
    await kernel.dispose?.();
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/core/orchestration/c5-rounds-e2e.test.js
// ---------------------------------------------------------------------------
describe("core/orchestration/c5-rounds-e2e", async () => {

  // Worker (singleton in-main, gated) calls diff_apply -> needs approval -> pauses.
  // kernel.agent.approve routes to orchestrator.resume -> worker applies -> completes.

  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { promises: fs } = await import("node:fs");
  const { createKernel } = await import("../../../../src/index.js");
  const { mkdtemp } = await import("../../../helpers/tmp.js");

  function mockGateway(counters) {
    return {
      invoke: async (messages) => {
        const text = (messages || []).map((m) => m.content).join("\n");
        if (text.includes("Break the user's request")) {
          counters.plan += 1;
          return { content: JSON.stringify({ task_summary: "t", done_when: "d", subtasks: [
            { id: "st_a", goal: "edit a.js", acceptance: ["a edited"], context_scope: { files: ["a.js"] }, tool_profile: "edit", depends_on: [] }
          ] }), tool_calls: [] };
        }
        if (text.includes("revising a multi-agent plan")) return { content: '{"done":true,"subtasks":[]}', tool_calls: [] };
        if (text.includes("INDEPENDENT reviewer")) return { content: '{"pass":true,"severity":"warn","reasons":[],"checked":["read"]}', tool_calls: [] };
        if (text.includes("Synthesize a final answer")) return { content: "final", tool_calls: [] };
        if (text.includes("Sub-task: edit a.js") && !text.includes("Applied change")) {
          return { content: "", tool_calls: [{ id: "t1", name: "diff_apply", arguments: { diff: "--- a/a.js\n+++ b/a.js\n@@ -1,1 +1,1 @@\n-base a\n+edited a\n" } }] };
        }
        return { content: "done", tool_calls: [] };
      },
      reply: async () => ({ content: "single" }),
      getUsageStats: () => ({})
    };
  }

  test("orchestrate worker pauses on gated edit; kernel.approve routes to orchestrator.resume; completes; plan called once", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "c5-e2e-"));
    await fs.writeFile(path.join(root, "a.js"), "base a\n");
    const counters = { plan: 0 };
    const kernel = await createKernel(root, {
      modelGateway: mockGateway(counters),
      eventBus: { publish: () => {}, subscribe: () => () => {} },
      sessionLog: null, branchStore: null,
      verifyMode: "off"
    });

    const p = await kernel.agent.send("逐一处理 a.js 的输入校验", { autonomy: "supervised" });
    assert.equal(p.status, "awaiting_approval", "worker paused on gated edit");
    assert.ok(p.approval?.id);

    const done = await kernel.agent.approve(p.approval.id, "approve");   // routes to orchestrator.resume
    assert.equal(done.status, "complete");
    assert.equal(await fs.readFile(path.join(root, "a.js"), "utf8"), "edited a\n");  // edit merged to main
    assert.equal(counters.plan, 1, "planner.plan called exactly once (no re-plan on resume)");
    await kernel.dispose?.();
  });
});
