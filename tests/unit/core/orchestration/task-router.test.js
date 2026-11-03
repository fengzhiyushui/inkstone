// tests/unit/core/orchestration/task-router.test.js — 任务路由与评分领域测试
//
// v1.19.1 测试归并:本文件由下列历史任务单测试合并而成,每个来源包裹在独立
// describe 块中(异步回调 + 动态 import,来源间零共享绑定),测试语义与拆分前一致。
import { describe } from "node:test";

// ---------------------------------------------------------------------------
// 来源:tests/core/orchestration/task-router.test.js
// ---------------------------------------------------------------------------
describe("core/orchestration/task-router", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createTaskRouter } = await import("../../../../src/core/orchestration/task-router.js");

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
    const r = createTaskRouter({ model: { enabled: true, callModel, maxRepairs: 1, complexThreshold: 3 }, now: () => 0 });
    const d = await r.route(AMBIG);
    assert.equal(calls, 2);                                  // maxRepairs+1
    assert.equal(d.tier, "fallback");
    assert.equal(d.reason, "router_model_invalid");
    assert.equal(d.lane, "orchestrate");                     // signals(weak marker)>0 → fallback orchestrate
  });

  test("maxRepairs=0 ⇒ total calls <= 1", async () => {
    let calls = 0;
    const callModel = async () => { calls += 1; return "garbage"; };
    const r = createTaskRouter({ model: { enabled: true, callModel, maxRepairs: 0, complexThreshold: 3 }, now: () => 0 });
    await r.route(AMBIG);
    assert.equal(calls, 1);
  });

  test("total timeout across retries → router_model_timeout fallback", async () => {
    let t = 1000, calls = 0;
    const now = () => t;
    const callModel = async () => { calls += 1; t += 5000; return "not json"; };  // each attempt burns 5s
    const r = createTaskRouter({ model: { enabled: true, callModel, timeoutMs: 8000, maxRepairs: 5, complexThreshold: 3 }, now });
    const d = await r.route(AMBIG);
    assert.equal(d.reason, "router_model_timeout");
    assert.equal(calls, 2);                                  // 3rd attempt short-circuits on remaining<=0
  });

  test("empty gateway and thrown error both fall back", async () => {
    const empty = createTaskRouter({ model: { enabled: true, callModel: async () => "", complexThreshold: 3 }, now: () => 0 });
    assert.equal((await empty.route(AMBIG)).reason, "router_model_empty");
    const thrown = createTaskRouter({ model: { enabled: true, callModel: async () => { throw new Error("boom"); }, complexThreshold: 3 }, now: () => 0 });
    assert.equal((await thrown.route(AMBIG)).reason, "router_model_error");
  });

  test("invalid verdict lane is rejected (treated as malformed)", async () => {
    let calls = 0;
    const callModel = async () => { calls += 1; return '{"lane":"banana"}'; };
    const r = createTaskRouter({ model: { enabled: true, callModel, maxRepairs: 0, complexThreshold: 3 }, now: () => 0 });
    const d = await r.route(AMBIG);
    assert.equal(d.tier, "fallback");
    assert.equal(d.reason, "router_model_invalid");
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/core/orchestration/router-scoring.test.js
// ---------------------------------------------------------------------------
describe("core/orchestration/router-scoring", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { normalizeFileToken, extractFeatures, computeScore, classifyBand, featuresForEvent, STRONG_MARKERS, DEFAULT_WEAK_MARKERS } = await import("../../../../src/core/orchestration/router-scoring.js");

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
    assert.equal(computeScore(files), 3);                // 4 files → 3 (first free, cap 3)
  });

  test("file score: first file is free (not a complexity signal), then +1 each capped at 3", () => {
    const one = extractFeatures("touch a.ts", {}, { markers: [] });
    assert.equal(computeScore(one), 0);                  // 1 file → 0 (single-file = confidently simple)
    const two = extractFeatures("touch a.ts b.ts", {}, { markers: [] });
    assert.equal(computeScore(two), 1);                  // 2 files → 1
    const five = extractFeatures("a.ts b.ts c.ts d.ts e.ts", {}, { markers: [] });
    assert.equal(computeScore(five), 3);                 // capped at 3
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
});

// ---------------------------------------------------------------------------
// 来源:tests/core/orchestration/c-router-e2e.test.js
// ---------------------------------------------------------------------------
describe("core/orchestration/c-router-e2e", async () => {

  // Router triage (purpose=act) is dispatched by the "Classify this coding request" prompt;
  // the orchestrate machinery (planner/reviewer/synth/worker) reuses the c5/c3 e2e mock shape.

  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { promises: fs } = await import("node:fs");
  const { createKernel } = await import("../../../../src/index.js");
  const { mkdtemp } = await import("../../../helpers/tmp.js");

  function mockGateway({ triage, calls }) {
    return {
      invoke: async (messages, options = {}) => {
        const text = (messages || []).map((m) => m.content).join("\n");
        if (text.includes("Classify this coding request")) {
          calls.triage += 1;
          return typeof triage === "function" ? triage(options) : { content: triage, tool_calls: [] };
        }
        if (text.includes("Break the user's request")) {
          calls.plan += 1;
          return { content: JSON.stringify({ task_summary: "t", done_when: "d", subtasks: [
            { id: "st_a", goal: "inspect a", acceptance: ["done"], context_scope: { files: [] }, tool_profile: "readonly", depends_on: [] }
          ] }), tool_calls: [] };
        }
        if (text.includes("revising a multi-agent plan")) return { content: '{"done":true,"subtasks":[]}', tool_calls: [] };
        if (text.includes("INDEPENDENT reviewer")) return { content: '{"pass":true,"severity":"warn","reasons":[],"checked":["read"]}', tool_calls: [] };
        if (text.includes("Synthesize a final answer")) return { content: "final", tool_calls: [] };
        return { content: "done", tool_calls: [] };
      },
      reply: async () => ({ content: "single" }),
      getUsageStats: () => ({})
    };
  }

  function recordingBus() {
    const events = [];
    return { events, publish: (type, data) => { events.push({ type, data }); }, subscribe: () => () => {} };
  }

  const AMBIG = "请处理这些校验逻辑";   // weak "这些" → score 1 → ambiguous band

  async function tmpRoot() {
    const root = await mkdtemp(path.join(os.tmpdir(), "c-router-e2e-"));
    await fs.writeFile(path.join(root, "package.json"), "{\"name\":\"demo\"}\n");
    return root;
  }

  test("ambiguous request consults model → route_resolved(model) → orchestrate runs", async () => {
    const root = await tmpRoot();
    const calls = { triage: 0, plan: 0 };
    const bus = recordingBus();
    const kernel = await createKernel(root, {
      modelGateway: mockGateway({ triage: '{"lane":"orchestrate","reason":"multi"}', calls }),
      eventBus: bus, sessionLog: null, branchStore: null, verifyMode: "off"
    });

    const res = await kernel.agent.send(AMBIG, { autonomy: "gated" });

    assert.equal(calls.triage, 1, "router model tier consulted once");
    const rr = bus.events.find((e) => e.type === "orchestration:route_resolved");
    assert.ok(rr, "route_resolved emitted");
    assert.equal(rr.data.tier, "model");
    assert.equal(rr.data.finalLane, "orchestrate");
    assert.equal(res.status, "complete");
    await kernel.dispose?.();
  });

  test("router.model.enabled=false: no triage call, no route_resolved, routes like today", async () => {
    const root = await tmpRoot();
    const calls = { triage: 0, plan: 0 };
    const bus = recordingBus();
    const kernel = await createKernel(root, {
      modelGateway: mockGateway({ triage: '{"lane":"single"}', calls }),
      eventBus: bus, sessionLog: null, branchStore: null, verifyMode: "off",
      orchestration: { router: { model: { enabled: false } } }
    });

    const res = await kernel.agent.send(AMBIG, { autonomy: "gated" });

    assert.equal(calls.triage, 0, "no model triage when disabled");
    assert.ok(!bus.events.some((e) => e.type === "orchestration:route_resolved"));
    assert.equal(res.status, "complete");   // heuristic: 这些 signal → orchestrate → completes
    await kernel.dispose?.();
  });

  test("triage garbage → heuristic fallback, no crash, route_resolved(fallback)", async () => {
    const root = await tmpRoot();
    const calls = { triage: 0, plan: 0 };
    const bus = recordingBus();
    const kernel = await createKernel(root, {
      modelGateway: mockGateway({ triage: "not json", calls }),
      eventBus: bus, sessionLog: null, branchStore: null, verifyMode: "off"
    });

    const res = await kernel.agent.send(AMBIG, { autonomy: "gated" });

    assert.ok(calls.triage >= 1, "triage attempted");
    const rr = bus.events.find((e) => e.type === "orchestration:route_resolved");
    assert.equal(rr.data.tier, "fallback");
    assert.equal(res.status, "complete");   // fallback: 这些 signal → orchestrate
    await kernel.dispose?.();
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/core/orchestration/kernel-routing-e2e.test.js
// ---------------------------------------------------------------------------
describe("core/orchestration/kernel-routing-e2e", async () => {

  // A mock model gateway: planner asks for JSON plan -> 2 subtasks; reviewer -> pass JSON; synth -> final; worker -> generic (no tool calls).

  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { promises: fs } = await import("node:fs");
  const { createKernel } = await import("../../../../src/index.js");
  const { mkdtemp } = await import("../../../helpers/tmp.js");

  function mockGateway() {
    return {
      invoke: async (messages, _options) => {
        const text = (messages || []).map((m) => m.content).join("\n");
        if (text.includes("Break the user's request")) {
          return { content: JSON.stringify({ task_summary: "t", done_when: "d", subtasks: [
            { id: "st_1", goal: "do a", acceptance: ["a"], context_scope: {}, tool_profile: "readonly", depends_on: [] },
            { id: "st_2", goal: "do b", acceptance: ["b"], context_scope: {}, tool_profile: "readonly", depends_on: ["st_1"] }
          ] }), tool_calls: [] };
        }
        if (text.includes("INDEPENDENT reviewer")) return { content: '{"pass":true,"severity":"warn","reasons":[],"checked":["read"]}', tool_calls: [] };
        if (text.includes("Synthesize a final answer")) return { content: "final orchestrated answer", tool_calls: [] };
        return { content: "worker did the thing", tool_calls: [] };
      },
      reply: async () => ({ content: "single-agent reply" }),
      getUsageStats: () => ({})
    };
  }

  test("simple message uses single lane; complex message orchestrates", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orch-e2e-"));
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
    assert.ok(events.some(([t]) => t === "orchestration:routed"), "routed event fires");
    assert.ok(events.some(([t]) => t === "orchestration:planned"), "planned event fires");
    assert.equal(r.content, "final orchestrated answer");
    await kernel.dispose?.();
  });
});
