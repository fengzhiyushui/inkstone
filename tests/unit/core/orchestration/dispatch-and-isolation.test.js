// tests/unit/core/orchestration/dispatch-and-isolation.test.js — 派发循环与工作区隔离领域测试
//
// v1.19.1 测试归并:本文件由下列历史任务单测试合并而成,每个来源包裹在独立
// describe 块中(异步回调 + 动态 import,来源间零共享绑定),测试语义与拆分前一致。
import { describe } from "node:test";

// ---------------------------------------------------------------------------
// 来源:tests/core/orchestration/dispatch-loop.test.js
// ---------------------------------------------------------------------------
describe("core/orchestration/dispatch-loop", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { runDispatchLoop } = await import("../../../../src/core/orchestration/dispatch-loop.js");
  const { createSynthesizer } = await import("../../../../src/core/orchestration/synthesizer.js");

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

  function completedRound(synthesizer, scope = {}) {
    return runDispatchLoop({
      plan: { subtasks: [st("st_1")] }, workerFactory: { worker: () => okWorker("worker result") },
      makeReviewer: passReviewer, synthesizer, budget: scope.budget || noBudget,
      maxWorkerAttempts: 1, autonomy: "auto", scope
    });
  }

  function assertCancelledRound(result) {
    assert.equal(result.status, "cancelled");
    assert.equal(result.stopped_reason, "aborted");
    assert.deepEqual(result.collected.map((c) => [c.st.id, c.status, c.wres.content]), [
      ["st_1", "complete", "worker result"]
    ]);
  }

  for (const abortSignal of [false, true]) {
    test(`round synthesis cancellation preserves collected work (${abortSignal ? "aborted signal" : "AbortError"})`, async () => {
      const controller = new AbortController();
      const synthesizer = { synthesize: async () => {
        if (abortSignal) controller.abort();
        const error = new Error("synthesis interrupted");
        if (!abortSignal) error.name = "AbortError";
        throw error;
      } };
      assertCancelledRound(await completedRound(synthesizer, { signal: controller.signal }));
    });
  }

  test("round synthesis ignores a late model result after cancellation", async () => {
    const controller = new AbortController();
    const synthesizer = { synthesize: async () => {
      controller.abort();
      return "late model result";
    } };
    const result = await completedRound(synthesizer, { signal: controller.signal });
    assertCancelledRound(result);
    assert.notEqual(result.content, "late model result");
  });

  test("round synthesis propagates ordinary errors without cancellation", async () => {
    const error = new Error("unexpected synthesis failure");
    await assert.rejects(completedRound({ synthesize: async () => { throw error; } }), (caught) => caught === error);
  });

  test("exhausted budget still returns a deterministic partial summary", async () => {
    let modelCalls = 0;
    const budget = { exceeded: () => ({ reason: "max_model_calls" }) };
    const synthesizer = createSynthesizer({ callModel: async () => { modelCalls += 1; return "unexpected"; } });
    const result = await completedRound(synthesizer, { budget });
    assert.equal(result.status, "complete");
    assert.equal(result.stopped_reason, "budget");
    assert.match(result.content, /st_1/);
    assert.equal(result.collected[0].status, "complete");
    assert.equal(modelCalls, 0);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/core/orchestration/dispatch-parallel.test.js
// ---------------------------------------------------------------------------
describe("core/orchestration/dispatch-parallel", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { runDispatchLoop } = await import("../../../../src/core/orchestration/dispatch-loop.js");
  const { toBatches } = await import("../../../../src/core/orchestration/batch-planner.js");

  function st(id, files, deps = []) { return { id, goal: id, acceptance: [], context_scope: { files }, tool_profile: "edit", depends_on: deps }; }
  const noBudget = { exceeded: () => null };
  const synth = { synthesize: async ({ collected }) => `synth:${collected.map((c) => `${c.st.id}=${c.status}`).join(",")}` };

  test("parallel batch: disjoint subtasks merge; one out-of-scope fails; no residue", async () => {
    const removed = [];
    const plan = { subtasks: [st("a", ["a.js"]), st("b", ["b.js"])] };
    const runIsolatedWorker = async ({ subtask }) => ({
      st: subtask,
      wres: { status: "complete", content: `did ${subtask.id}` },
      verdict: { pass: true, severity: "warn", reasons: [], checked: [] },
      actual: subtask.id === "b"
        ? { added: [], modified: ["unscoped.js"], deleted: [] }   // b writes out of scope!
        : { added: [], modified: ["a.js"], deleted: [] },
      isoRoot: `/iso/${subtask.id}`
    });
    const mergeSubtask = async ({ isoRoot }) => ({ ok: true, change_id: `chg_${isoRoot}` });
    const removeIso = async (dir) => { removed.push(dir); return true; };

    const r = await runDispatchLoop({
      plan, synthesizer: synth, budget: noBudget, maxWorkerAttempts: 1, autonomy: "auto",
      toBatches, maxParallelWorkers: 4, runIsolatedWorker, mergeSubtask, removeIso
    });
    assert.equal(r.status, "complete");
    assert.match(r.content, /a=complete/);
    assert.match(r.content, /b=failed/);                  // out-of-scope -> failed
    assert.deepEqual(removed.sort(), ["/iso", "/iso/a", "/iso/b"]); // subtask copies + run dir cleaned
  });

  test("iso dir removed even when the isolated worker throws (zero residue)", async () => {
    const removed = [];
    const plan = { subtasks: [st("a", ["a.js"]), st("b", ["b.js"])] };
    const runIsolatedWorker = async ({ subtask }) => {
      if (subtask.id === "b") return { st: subtask, error: new Error("boom"), isoRoot: "/iso/b" };
      return { st: subtask, wres: { status: "complete", content: "ok" }, verdict: { pass: true, severity: "warn", reasons: [], checked: [] }, actual: { added: [], modified: ["a.js"], deleted: [] }, isoRoot: "/iso/a" };
    };
    const r = await runDispatchLoop({
      plan, synthesizer: synth, budget: noBudget, maxWorkerAttempts: 1, autonomy: "auto",
      toBatches, maxParallelWorkers: 4, runIsolatedWorker, mergeSubtask: async () => ({ ok: true }), removeIso: async (d) => { removed.push(d); return true; }
    });
    assert.match(r.content, /a=complete/);
    assert.match(r.content, /b=failed/);
    assert.deepEqual(removed.sort(), ["/iso", "/iso/a", "/iso/b"]);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/core/orchestration/dispatch-resume.test.js
// ---------------------------------------------------------------------------
describe("core/orchestration/dispatch-resume", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { runDispatchLoop, resumeDispatchLoop } = await import("../../../../src/core/orchestration/dispatch-loop.js");

  function st(id) { return { id, goal: id, acceptance: [], context_scope: {}, tool_profile: "edit", depends_on: [] }; }
  const reviewerPass = () => ({ review: async () => ({ pass: true, severity: "warn", reasons: [], checked: [] }) });
  const synth = { synthesize: async () => "x" };
  const noBudget = { exceeded: () => null };

  test("pause returns resume with worker + remaining; resume finishes round (no dup)", async () => {
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
    assert.deepEqual(done.collected.map((c) => `${c.st.id}:${c.status}`), ["st_1:complete", "st_2:complete"]);
  });

  test("deny -> paused subtask failed, remaining still dispatched", async () => {
    const pausedWorker = { send: async () => ({ status: "awaiting_approval", approval: { id: "ap1" } }), approve: async () => ({ status: "complete", content: "x" }) };
    const workerFactory = { worker: (s) => (s.id === "st_1" ? pausedWorker : { send: async () => ({ status: "complete", content: "ok" }) }) };
    const r = await runDispatchLoop({ plan: { subtasks: [st("st_1"), st("st_2")] }, workerFactory, makeReviewer: reviewerPass, synthesizer: synth, budget: noBudget, maxWorkerAttempts: 1, autonomy: "gated" });
    const done = await resumeDispatchLoop(r.resume, "deny");
    assert.equal(done.collected.find((c) => c.st.id === "st_1").status, "failed");
    assert.equal(done.collected.find((c) => c.st.id === "st_2").status, "complete");
  });

  test("settled-before-pause goes into result.collected (single source)", async () => {
    // st_1 completes; st_2 pauses -> result.collected has st_1 only; resume adds st_2
    const pausedWorker = { send: async () => ({ status: "awaiting_approval", approval: { id: "ap2" } }), approve: async () => ({ status: "complete", content: "did st_2" }) };
    const workerFactory = { worker: (s) => (s.id === "st_2" ? pausedWorker : { send: async () => ({ status: "complete", content: "did st_1" }) }) };
    const r = await runDispatchLoop({ plan: { subtasks: [st("st_1"), st("st_2")] }, workerFactory, makeReviewer: reviewerPass, synthesizer: synth, budget: noBudget, maxWorkerAttempts: 1, autonomy: "gated" });
    assert.deepEqual(r.collected.map((c) => c.st.id), ["st_1"]);   // st_1 settled pre-pause
    const done = await resumeDispatchLoop(r.resume, "approve");
    assert.deepEqual(done.collected.map((c) => c.st.id), ["st_2"]); // resume only adds post-pause
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/core/orchestration/iso-worker-runner.test.js
// ---------------------------------------------------------------------------
describe("core/orchestration/iso-worker-runner", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { promises: fs } = await import("node:fs");
  const { createIsoWorkerRunner } = await import("../../../../src/core/orchestration/iso-worker-runner.js");
  const { removeIso } = await import("../../../../src/core/orchestration/iso-workspace.js");
  const { mkdtemp } = await import("../../../helpers/tmp.js");

  async function tmp() { return mkdtemp(path.join(os.tmpdir(), "iso-run-")); }

  test("runIsolatedWorker copies, runs worker in iso, reports actual changes; main untouched", async () => {
    const root = await tmp();
    await fs.writeFile(path.join(root, "a.js"), "base\n");
    const runner = createIsoWorkerRunner({
      root,
      buildToolPlane: () => ({ execute: () => {}, toolRegistry: { toDeepSeekTools: () => [{ type: "function", function: { name: "edit" } }] } }),
      createRuntime: (ov) => ({ send: async () => { await fs.writeFile(path.join(ov.projectRoot, "a.js"), "edited\n"); return { status: "complete", content: "did" }; } }),
      makeReviewer: () => ({ review: async () => ({ pass: true, severity: "warn", reasons: [], checked: [] }) }),
      maxCopyFiles: 5000
    });
    const r = await runner({ subtask: { id: "st_1", goal: "edit a", acceptance: [], context_scope: { files: ["a.js"] }, tool_profile: "edit" }, runId: "run1" });
    assert.deepEqual(r.actual.modified, ["a.js"]);
    assert.equal(r.verdict.pass, true);
    assert.ok(r.isoRoot);
    assert.equal(await fs.readFile(path.join(root, "a.js"), "utf8"), "base\n");   // main untouched
    await removeIso(r.isoRoot);
  });

  test("runIsolatedWorker returns {error, isoRoot} on COPY_TOO_BIG (caller cleans up)", async () => {
    const root = await tmp();
    await fs.writeFile(path.join(root, "a.js"), "x\n");
    await fs.writeFile(path.join(root, "b.js"), "y\n");
    const runner = createIsoWorkerRunner({
      root,
      buildToolPlane: () => ({ execute: () => {}, toolRegistry: { toDeepSeekTools: () => [] } }),
      createRuntime: () => ({ send: async () => ({ status: "complete", content: "x" }) }),
      makeReviewer: () => ({ review: async () => ({ pass: true, severity: "warn", reasons: [], checked: [] }) }),
      maxCopyFiles: 1   // forces truncation -> COPY_TOO_BIG
    });
    const r = await runner({ subtask: { id: "st_1", goal: "g", acceptance: [], context_scope: { files: ["a.js"] }, tool_profile: "edit" }, runId: "run2" });
    assert.ok(r.error);
    assert.equal(r.error.code, "COPY_TOO_BIG");
    assert.ok(r.isoRoot);
    await removeIso(r.isoRoot);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/core/orchestration/iso-workspace.test.js
// ---------------------------------------------------------------------------
describe("core/orchestration/iso-workspace", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { promises: fs } = await import("node:fs");
  const { createIso, removeIso, sweepOrphans } = await import("../../../../src/core/orchestration/iso-workspace.js");
  const { mkdtemp } = await import("../../../helpers/tmp.js");

  async function tmp() { return mkdtemp(path.join(os.tmpdir(), "iso-")); }
  const exists = (p) => fs.access(p).then(() => true, () => false);

  test("createIso makes dir + .owner; removeIso deletes it", async () => {
    const root = await tmp();
    const iso = await createIso({ root, runId: "run1", subtaskId: "st_1" });
    assert.ok(await exists(iso));
    assert.ok(await exists(path.join(root, ".deepseek-code/v2/orchestration/iso/run1/.owner")));
    assert.equal(await removeIso(iso), true);
    assert.equal(await exists(iso), false);
  });

  test("sweepOrphans removes stale runs but keeps fresh non-owned ones", async () => {
    const root = await tmp();
    await createIso({ root, runId: "old", subtaskId: "st_1" });
    await createIso({ root, runId: "fresh", subtaskId: "st_1" });
    const base = path.join(root, ".deepseek-code/v2/orchestration/iso");
    // old: another pid + stale ts -> removed; fresh: another pid + fresh ts -> kept
    await fs.writeFile(path.join(base, "old/.owner"), JSON.stringify({ pid: 999999, ts: Date.now() - 10 * 3600 * 1000 }));
    await fs.writeFile(path.join(base, "fresh/.owner"), JSON.stringify({ pid: 111111, ts: Date.now() }));
    const swept = await sweepOrphans({ root, ttlMs: 3600000, pid: process.pid });
    assert.equal(await exists(path.join(base, "old")), false);
    assert.equal(await exists(path.join(base, "fresh")), true);
    assert.ok(swept.some((d) => d.includes("old")));
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/core/orchestration/merge-back.test.js
// ---------------------------------------------------------------------------
describe("core/orchestration/merge-back", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { promises: fs } = await import("node:fs");
  const { createEditService } = await import("../../../../src/edits/edit-service.js");
  const { makeUnifiedDiff, mergeSubtask } = await import("../../../../src/core/orchestration/merge-back.js");
  const { hashTree } = await import("../../../../src/core/orchestration/workspace-snapshot.js");
  const { mkdtemp } = await import("../../../helpers/tmp.js");

  async function tmp() { return mkdtemp(path.join(os.tmpdir(), "merge-")); }

  test("makeUnifiedDiff modify roundtrips through the real edit service", async () => {
    const main = await tmp();
    await fs.writeFile(path.join(main, "a.js"), "old line\n");
    const diff = makeUnifiedDiff("a.js", "old line\n", "new line\n");
    const svc = createEditService({ projectRoot: main });
    const res = await svc.apply({ diff });
    assert.equal(res.status, "success");
    assert.equal(await fs.readFile(path.join(main, "a.js"), "utf8"), "new line\n");
  });

  test("makeUnifiedDiff add creates a new file through the edit service", async () => {
    const main = await tmp();
    const diff = makeUnifiedDiff("nested/b.js", null, "fresh\n");
    const svc = createEditService({ projectRoot: main });
    const res = await svc.apply({ diff });
    assert.equal(res.status, "success");
    assert.equal(await fs.readFile(path.join(main, "nested/b.js"), "utf8"), "fresh\n");
  });

  test("mergeSubtask applies disjoint iso changes; CAS conflict if main diverged", async () => {
    const main = await tmp(); const iso = await tmp();
    await fs.writeFile(path.join(main, "a.js"), "base\n");
    await fs.writeFile(path.join(iso, "a.js"), "base\n");
    const baseManifest = await hashTree(iso, {});
    await fs.writeFile(path.join(iso, "a.js"), "worker edit\n");          // worker changed it in iso
    const actual = { added: [], deleted: [], modified: ["a.js"] };
    const svc = createEditService({ projectRoot: main });

    const ok = await mergeSubtask({ editService: svc, mainRoot: main, isoRoot: iso, baseManifest, actual });
    assert.equal(ok.ok, true);
    assert.equal(await fs.readFile(path.join(main, "a.js"), "utf8"), "worker edit\n");

    // diverge main, merge a fresh iso edit -> CAS conflict, main untouched
    const iso2 = await tmp(); await fs.writeFile(path.join(iso2, "a.js"), "base\n");
    const base2 = await hashTree(iso2, {});
    await fs.writeFile(path.join(iso2, "a.js"), "iso2 edit\n");
    await fs.writeFile(path.join(main, "a.js"), "user changed main\n");   // diverged from base2
    const conflict = await mergeSubtask({ editService: svc, mainRoot: main, isoRoot: iso2, baseManifest: base2, actual: { added: [], deleted: [], modified: ["a.js"] } });
    assert.equal(conflict.ok, false);
    assert.equal(await fs.readFile(path.join(main, "a.js"), "utf8"), "user changed main\n");
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/core/orchestration/path-overlap.test.js
// ---------------------------------------------------------------------------
describe("core/orchestration/path-overlap", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { normalizePath, overlaps, withinScope } = await import("../../../../src/core/orchestration/path-overlap.js");

  test("normalizePath unifies separators and strips ./", () => {
    assert.equal(normalizePath("./src\\a.js"), normalizePath("src/a.js"));
  });

  test("overlaps detects equality and directory containment", () => {
    assert.equal(overlaps(["src/a.js"], ["src/b.js"]), false);
    assert.equal(overlaps(["src/a.js"], ["src/a.js"]), true);
    assert.equal(overlaps(["src/"], ["src/a.js"]), true);   // dir contains file
    assert.equal(overlaps(["lib/x.js"], ["src/"]), false);
  });

  test("withinScope returns out-of-scope paths", () => {
    assert.deepEqual(withinScope(["src/a.js"], ["src/"]), []);          // a.js inside src/
    assert.deepEqual(withinScope(["src/a.js", "lib/b.js"], ["src/a.js"]), ["lib/b.js"]);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/core/orchestration/workspace-snapshot.test.js
// ---------------------------------------------------------------------------
describe("core/orchestration/workspace-snapshot", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { promises: fs } = await import("node:fs");
  const { fsCopyWorkspace, hashTree, changedPaths } = await import("../../../../src/core/orchestration/workspace-snapshot.js");
  const { mkdtemp } = await import("../../../helpers/tmp.js");

  async function tmp() { return mkdtemp(path.join(os.tmpdir(), "ws-snap-")); }
  const exists = (p) => fs.access(p).then(() => true, () => false);

  test("copy excludes .git/node_modules/.deepseek-code; hashTree captures dirty content", async () => {
    const src = await tmp();
    await fs.mkdir(path.join(src, "src")); await fs.writeFile(path.join(src, "src/a.js"), "A\n");
    await fs.mkdir(path.join(src, ".git")); await fs.writeFile(path.join(src, ".git/x"), "g");
    await fs.mkdir(path.join(src, "node_modules")); await fs.writeFile(path.join(src, "node_modules/y"), "n");
    const dest = await tmp();
    const res = await fsCopyWorkspace(src, dest, { maxCopyFiles: 5000 });
    assert.ok(res.copied >= 1);
    assert.equal(await fs.readFile(path.join(dest, "src/a.js"), "utf8"), "A\n");
    assert.equal(await exists(path.join(dest, ".git")), false);
    assert.equal(await exists(path.join(dest, "node_modules")), false);
    const manifest = await hashTree(dest, { maxCopyFiles: 5000 });
    assert.ok(manifest.has("src/a.js"));
  });

  test("changedPaths reports added/deleted/modified vs base manifest", async () => {
    const root = await tmp();
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(path.join(root, "src/keep.js"), "k\n");
    await fs.writeFile(path.join(root, "src/mod.js"), "old\n");
    await fs.writeFile(path.join(root, "src/del.js"), "d\n");
    const base = await hashTree(root, { maxCopyFiles: 5000 });
    await fs.writeFile(path.join(root, "src/mod.js"), "new\n");      // modify
    await fs.rm(path.join(root, "src/del.js"));                       // delete
    await fs.writeFile(path.join(root, "src/add.js"), "a\n");         // add
    const ch = changedPaths(await hashTree(root, { maxCopyFiles: 5000 }), base);
    assert.deepEqual(ch.added, ["src/add.js"]);
    assert.deepEqual(ch.deleted, ["src/del.js"]);
    assert.deepEqual(ch.modified, ["src/mod.js"]);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/core/orchestration/worker-factory.test.js
// ---------------------------------------------------------------------------
describe("core/orchestration/worker-factory", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createWorkerFactory } = await import("../../../../src/core/orchestration/worker-factory.js");

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
});

// ---------------------------------------------------------------------------
// 来源:tests/core/orchestration/build-tool-plane.test.js
// ---------------------------------------------------------------------------
describe("core/orchestration/build-tool-plane", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { promises: fs } = await import("node:fs");
  const { buildToolPlane } = await import("../../../../src/index.js");
  const { mkdtemp } = await import("../../../helpers/tmp.js");

  test("buildToolPlane returns a plane bound to the given root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "plane-"));
    const plane = buildToolPlane(root, {});
    assert.equal(typeof plane.execute, "function");
    assert.ok(plane.toolRegistry.toDeepSeekTools().some((s) => s.function.name === "read"));
    // editService is bound to `root`: applying a new-file diff lands the file under root
    const diff = "--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,1 @@\n+hello\n";
    const res = await plane.editService.apply({ diff });
    assert.equal(res.status, "success");
    assert.equal(await fs.readFile(path.join(root, "new.txt"), "utf8"), "hello\n");
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/core/orchestration/tool-profiles.test.js
// ---------------------------------------------------------------------------
describe("core/orchestration/tool-profiles", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { TOOL_PROFILES, filterToolSchemas } = await import("../../../../src/core/orchestration/tool-profiles.js");

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

  test("TOOL_PROFILES are exported as sets", () => {
    assert.ok(TOOL_PROFILES.readonly instanceof Set);
    assert.ok(TOOL_PROFILES.edit instanceof Set);
  });
});
