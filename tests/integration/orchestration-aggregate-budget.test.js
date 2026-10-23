import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { createKernel } from "../../src/index.js";
import { createRequestBudget, createRequestScope } from "../../src/core/runtime/request-budget.js";
import { createDeepSeekGateway } from "../../src/deepseek/model-gateway.js";
import { createPlanner } from "../../src/core/orchestration/planner.js";
import { createSynthesizer } from "../../src/core/orchestration/synthesizer.js";
import {
  serializeOrchestrationState,
  deserializeOrchestrationState,
  budgetContinuation,
  orchestrationResumeGate
} from "../../src/core/orchestration/orchestration-recovery-contract.js";
import { createWorkerFactory } from "../../src/core/orchestration/worker-factory.js";
import { runDispatchLoop } from "../../src/core/orchestration/dispatch-loop.js";
import { createOrchestrationPersistence } from "../../src/core/recovery/orchestration-persistence.js";
import { createEventBus } from "../../src/shared/event-bus.js";
import { createEditService } from "../../src/edits/edit-service.js";
import { createBuiltinTools } from "../../src/tools/builtin/index.js";
import { createToolRegistry } from "../../src/tools/registry.js";
import { createIso, removeIso } from "../../src/core/orchestration/iso-workspace.js";
import { toBatches } from "../../src/core/orchestration/batch-planner.js";
import { mkdtemp } from "../helpers/tmp.js";

async function tmpRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "orch-agg-budget-"));
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "orch-agg-budget-test" }) + "\n");
  return root;
}

function jsonResponse(content, usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map(),
    json: async () => ({
      choices: [{
        finish_reason: "stop",
        message: { role: "assistant", content: typeof content === "string" ? content : JSON.stringify(content) }
      }],
      ...(usage !== null && usage !== undefined ? { usage } : {})
    }),
    text: async () => typeof content === "string" ? content : JSON.stringify(content)
  };
}

function createDeferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createBarrier(count) {
  let arrived = 0;
  const resolvers = [];
  return {
    arriveAndWait() {
      arrived++;
      if (arrived >= count) {
        for (const r of resolvers) r();
        resolvers.length = 0;
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        resolvers.push(resolve);
      });
    },
    get arrivedCount() {
      return arrived;
    }
  };
}

// B01: 模糊请求触发模型 router 后进入编排
test("B01: ambiguous prompt routes through model tier and records router role in aggregate execution budget", async () => {
  const root = await tmpRoot();
  const kernel = await createKernel(root, {
    sessionLog: null,
    branchStore: null,
    verifyMode: "off",
    orchestration: {
      budget: { maxTokens: 10000, maxModelCalls: 50 }
    },
    deepseek: {
      apiKey: "test-key",
      fetchImpl: async (url, init) => {
        const bodyStr = init.body;
        if (bodyStr.includes("Classify this coding request")) {
          return jsonResponse({ lane: "orchestrate", reason: "multiple components involved" }, { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 });
        }
        if (bodyStr.includes("Break the user's request")) {
          return jsonResponse({
            task_summary: "summary",
            done_when: "done",
            subtasks: [
              { id: "st_1", goal: "do task 1", acceptance: ["ok"], context_scope: { files: [] }, tool_profile: "readonly", depends_on: [] }
            ]
          }, { prompt_tokens: 30, completion_tokens: 15, total_tokens: 45 });
        }
        if (bodyStr.includes("INDEPENDENT reviewer")) {
          return jsonResponse({ pass: true, severity: "warn", reasons: [], checked: ["read"] }, { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 });
        }
        if (bodyStr.includes("Synthesize a final answer")) {
          return jsonResponse("All done successfully", { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
        }
        return jsonResponse("Subtask complete", { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
      }
    }
  });

  const ambig = "请处理这些校验逻辑"; // triggers ambiguous band in router
  // Default entry without passing custom scope (F01 verification)
  const res = await kernel.agent.send(ambig, { autonomy: "auto" });

  assert.ok(res);
  const snap = res.budget;
  assert.ok(snap, "budget snapshot returned from default entry");
  assert.ok(snap.by_role.router, "router role recorded in budget");
  assert.equal(snap.by_role.router.calls, 1, "router made exactly 1 call");
  assert.equal(snap.by_role.router.tokens, 30, "router tokens recorded correctly");
  assert.ok(snap.by_role.planner, "planner role recorded in budget");
  assert.ok(snap.model_calls >= 1, "total calls includes router");
  assert.equal(snap.execution_id, res.executionId, "unified executionId across router and orchestrator");
  await kernel.dispose();
});

// B02: 依次触发 plan、worker、reviewer、replan、synthesizer 全角色（产品默认入口）
test("B02: aggregate usage across all roles (router, plan, worker, reviewer, replan, synth) matches outbound fetch sum via default entry", async () => {
  const root = await tmpRoot();
  let physicalOutboundCount = 0;
  let totalOutboundTokens = 0;
  let round1Reviewed = false;

  const kernel = await createKernel(root, {
    sessionLog: null,
    branchStore: null,
    verifyMode: "off",
    orchestration: {
      maxRounds: 2,
      budget: { maxTokens: 5000, maxModelCalls: 30 }
    },
    deepseek: {
      apiKey: "test-key",
      fetchImpl: async (url, init) => {
        physicalOutboundCount++;
        const pTok = 10;
        const cTok = 5;
        totalOutboundTokens += (pTok + cTok);
        const bodyStr = init.body;

        if (bodyStr.includes("Classify this coding request")) {
          return jsonResponse({ lane: "orchestrate", reason: "multi-file refactor" }, { prompt_tokens: pTok, completion_tokens: cTok, total_tokens: pTok + cTok });
        }
        if (bodyStr.includes("Break the user's request")) {
          return jsonResponse({
            task_summary: "plan sum",
            done_when: "done",
            subtasks: [
              { id: "st_1", goal: "task one", acceptance: ["ok"], context_scope: { files: [] }, tool_profile: "readonly", depends_on: [] }
            ]
          }, { prompt_tokens: pTok, completion_tokens: cTok, total_tokens: pTok + cTok });
        }
        if (bodyStr.includes("INDEPENDENT reviewer")) {
          if (!round1Reviewed) {
            round1Reviewed = true;
            return jsonResponse({ pass: false, severity: "block", reasons: ["needs fix"], checked: ["checked"] }, { prompt_tokens: pTok, completion_tokens: cTok, total_tokens: pTok + cTok });
          }
          return jsonResponse({ pass: true, severity: "warn", reasons: [], checked: ["read"] }, { prompt_tokens: pTok, completion_tokens: cTok, total_tokens: pTok + cTok });
        }
        if (bodyStr.includes("replan") || bodyStr.includes("Replan") || bodyStr.includes("revising a multi-agent plan")) {
          return jsonResponse({
            done: false,
            subtasks: [
              { id: "st_2", goal: "task two corrective", acceptance: ["ok"], context_scope: { files: [] }, tool_profile: "readonly", depends_on: [] }
            ]
          }, { prompt_tokens: pTok, completion_tokens: cTok, total_tokens: pTok + cTok });
        }
        if (bodyStr.includes("Synthesize a final answer")) {
          return jsonResponse("Synthesis complete", { prompt_tokens: pTok, completion_tokens: cTok, total_tokens: pTok + cTok });
        }
        return jsonResponse("Worker done", { prompt_tokens: pTok, completion_tokens: cTok, total_tokens: pTok + cTok });
      }
    }
  });

  // Call default send without passing custom scope!
  const res = await kernel.agent.send("请处理这些校验逻辑", { autonomy: "auto" });
  assert.ok(res);

  const snap = res.budget;
  assert.ok(snap, "budget snapshot returned from default entry");
  assert.equal(snap.model_calls, physicalOutboundCount, "snap.model_calls equals physical outbound fetch count");
  assert.equal(snap.tokens, totalOutboundTokens, "snap.tokens equals outbound token sum");

  // Verify role breakdown sum
  const sumRolesCalls = Object.values(snap.by_role).reduce((acc, r) => acc + r.calls, 0);
  const sumRolesTokens = Object.values(snap.by_role).reduce((acc, r) => acc + r.tokens, 0);
  assert.equal(sumRolesCalls, snap.model_calls, "sum of role calls matches aggregate calls");
  assert.equal(sumRolesTokens, snap.tokens, "sum of role tokens matches aggregate tokens");
  assert.ok(snap.by_role.router, "router role exists");
  assert.ok(snap.by_role.planner, "planner role exists");
  assert.ok(snap.by_role.worker, "worker role exists");
  assert.ok(snap.by_role.reviewer, "reviewer role exists");
  assert.ok(snap.by_role.replan, "replan role exists");
  assert.ok(snap.by_role.synthesizer, "synthesizer role exists");

  await kernel.dispose();
});

// B03: Worker 内 verify/repair 和 task 契约
test("B03: worker internal verify/repair and task delegation calls stay within aggregate scope", async (t) => {
  const root = await tmpRoot();
  const BROKEN_DIFF = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+broken";
  const REPAIR_DIFF = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-broken\n+fixed";
  await fs.writeFile(path.join(root, "a.txt"), "old\n");

  let workerInvokeCount = 0;
  let repairInvokeCount = 0;
  let testRuns = 0;
  const testResults = [
    { exit_code: 1, text: "verification failed" },
    { exit_code: 0, text: "verification passed" }
  ];

  const fakeTestTool = {
    name: "test",
    description: "Fake integration test runner",
    category: "execute",
    side_effect: "process",
    risk_level: "low",
    source: "test",
    version: "2.0",
    params: {
      detect: { type: "boolean", required: false, default: true },
      argv: { type: "array", required: false }
    },
    execute: async () => {
      const next = testResults[Math.min(testRuns, testResults.length - 1)];
      testRuns += 1;
      return {
        status: "success",
        content: [{ type: "text", text: next.text }],
        metadata: { exit_code: next.exit_code, run: testRuns }
      };
    }
  };

  const budget = createRequestBudget({ maxModelCalls: 10, maxTokens: 5000 });
  const scope = createRequestScope({ budget });

  const customGateway = {
    _isDeepSeekGateway: false,
    invoke: async (msgs, opts) => {
      workerInvokeCount++;
      if (opts.purpose === "repair") {
        repairInvokeCount++;
        return { content: "", tool_calls: [{ id: "call_repair", name: "edit", arguments: { diff: REPAIR_DIFF, prompt: "repair a" } }], usage: { total_tokens: 30 } };
      }
      if (workerInvokeCount === 1) {
        return { content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: BROKEN_DIFF, prompt: "break a" } }], usage: { total_tokens: 25 } };
      }
      return { content: "worker task completed", tool_calls: [], usage: { total_tokens: 15 } };
    }
  };

  const eventBus = createEventBus();
  const editService = createEditService({ projectRoot: root, eventBus });
  const tools = createBuiltinTools({ editService }).filter((tool) => tool.name !== "test");
  const toolRegistry = createToolRegistry({ tools: [...tools, fakeTestTool] });

  const kernel = await createKernel(root, {
    eventBus,
    editService,
    toolRegistry,
    sessionLog: null,
    branchStore: null,
    verifyMode: "run",
    maxRepairAttempts: 1,
    modelGateway: customGateway
  });
  t.after(() => kernel.dispose());

  // Rebuild worker with scope binding
  const scopedGw = scope.bindGateway(customGateway, { role: "worker", subtaskId: "st_verify" });
  const workerRuntime = kernel.runtime; // AgentRuntime
  const workerResult = await workerRuntime.send("fix a.txt", {
    autonomy: "auto",
    verifyMode: "run",
    modelGateway: scopedGw,
    scope,
    signal: scope.signal
  });

  assert.equal(workerResult.status, "complete");
  assert.equal(workerResult.verification.status, "passed");
  assert.equal(workerResult.repair.status, "complete");
  assert.equal(repairInvokeCount, 1, "one repair request reached the gateway");
  assert.equal(testRuns, 2, "verification failed before repair and passed afterwards");

  const snap = budget.snapshot();
  assert.equal(snap.model_calls, 3, "worker edit (1), completion (1), and repair (1) calls exactly equal 3");
  assert.equal(snap.by_role.worker.calls, 3, "role worker includes exactly 3 attempts");
  assert.equal(snap.tokens, 70, "aggregated tokens across worker edit (25), completion (15), and repair (30) exactly equal 70");
  assert.equal(snap.by_role.worker.tokens, 70, "role worker tokens exactly equal 70");
  assert.equal(workerInvokeCount, 3, "gateway was invoked exactly three times without duplicate billing");
  assert.equal(await fs.readFile(path.join(root, "a.txt"), "utf8"), "fixed\n");

  // Complete edit and completion first, then exhaust the shared budget at repair.
  const rootCap = await tmpRoot();
  await fs.writeFile(path.join(rootCap, "a.txt"), "old\n");
  const budgetCap = createRequestBudget({ maxModelCalls: 2, maxTokens: 5000 });
  const scopeCap = createRequestScope({ budget: budgetCap });
  let capWorkerInvokes = 0;
  let capRepairInvokes = 0;
  let repairBoundaryAttempts = 0;
  const customGatewayCap = {
    _isDeepSeekGateway: false,
    invoke: async (msgs, opts) => {
      capWorkerInvokes++;
      if (opts.purpose === "repair") {
        capRepairInvokes++;
        return { content: "", tool_calls: [{ id: "call_repair", name: "edit", arguments: { diff: REPAIR_DIFF, prompt: "repair a" } }], usage: { total_tokens: 30 } };
      }
      if (capWorkerInvokes === 1) {
        return { content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: BROKEN_DIFF, prompt: "break a" } }], usage: { total_tokens: 25 } };
      }
      return { content: "worker task completed", tool_calls: [], usage: { total_tokens: 15 } };
    }
  };
  let testRunsCap = 0;
  const fakeTestToolCap = {
    ...fakeTestTool,
    execute: async () => {
      testRunsCap++;
      return { status: "success", content: [{ type: "text", text: "fail" }], metadata: { exit_code: 1, run: testRunsCap } };
    }
  };
  const editServiceCap = createEditService({ projectRoot: rootCap });
  const toolsCap = createBuiltinTools({ editService: editServiceCap }).filter((t) => t.name !== "test");
  const regCap = createToolRegistry({ tools: [...toolsCap, fakeTestToolCap] });
  const kernelCap = await createKernel(rootCap, {
    editService: editServiceCap,
    toolRegistry: regCap,
    sessionLog: null,
    branchStore: null,
    verifyMode: "run",
    maxRepairAttempts: 1,
    modelGateway: customGatewayCap
  });
  t.after(() => kernelCap.dispose());
  const verificationsCap = [];
  kernelCap.eventBus.subscribe("verification:result", ({ result }) => verificationsCap.push(result));
  const scopedGwCap = scopeCap.bindGateway(customGatewayCap, { role: "worker", subtaskId: "st_cap" });
  const invokeScopedCap = scopedGwCap.invoke.bind(scopedGwCap);
  scopedGwCap.invoke = async (messages, options) => {
    if (options.purpose === "repair") repairBoundaryAttempts++;
    return invokeScopedCap(messages, options);
  };
  await assert.rejects(
    kernelCap.runtime.send("fix a.txt", {
      autonomy: "auto",
      verifyMode: "run",
      modelGateway: scopedGwCap,
      scope: scopeCap,
      signal: scopeCap.signal
    }),
    (err) => {
      assert.equal(err.code, "BUDGET_EXCEEDED");
      assert.deepEqual(err.details, {
        reason: "max_model_calls", model_calls: 2, max_model_calls: 2, reserved_calls: 0
      });
      return true;
    }
  );
  assert.equal(testRunsCap, 1, "verification ran and failed before the repair budget check");
  assert.deepEqual(verificationsCap.map(({ status, exit_code }) => ({ status, exit_code })), [
    { status: "failed", exit_code: 1 }
  ]);
  assert.equal(repairBoundaryAttempts, 1, "repair reached the gateway budget boundary");
  assert.equal(capWorkerInvokes, 2, "only edit and completion reached the underlying gateway");
  assert.equal(capRepairInvokes, 0, "the exhausted budget blocked repair before an outbound call");
  const snapCap = budgetCap.snapshot();
  assert.equal(snapCap.model_calls, 2);
  assert.equal(snapCap.tokens, 40, "only edit (25) and completion (15) were billed");
  assert.deepEqual(snapCap.by_role, { worker: { calls: 2, tokens: 40 } });
  assert.equal(snapCap.reserved_calls, 0);
  assert.equal(snapCap.reserved_tokens, 0);
  assert.equal(snapCap.unknown_usage_attempts, 0);
  assert.equal(await fs.readFile(path.join(rootCap, "a.txt"), "utf8"), "broken\n", "edit was applied but no repair side effect occurred");

  // Task delegation inside shared RequestScope bills under role "task" on the same RequestBudget
  const rootTask = await tmpRoot();
  await fs.writeFile(path.join(rootTask, "target.txt"), "TASK_TARGET_DATA\n");
  const budgetTask = createRequestBudget({ maxModelCalls: 10, maxTokens: 5000 });
  const scopeTask = createRequestScope({ budget: budgetTask });
  let taskParentCalls = 0;
  let taskChildCalls = 0;
  const gatewayTask = {
    _isDeepSeekGateway: false,
    invoke: async (msgs) => {
      const isChild = msgs.some((m) => typeof m.content === "string" && m.content.includes("[B03_TASK_CHILD]"));
      if (isChild) {
        taskChildCalls += 1;
        if (taskChildCalls === 1) {
          return {
            content: "Child reading target.txt",
            tool_calls: [{ id: "b03_c_read", name: "read", arguments: { path: "target.txt" } }],
            usage: { total_tokens: 12 }
          };
        }
        return { content: "Child read TASK_TARGET_DATA", tool_calls: [], usage: { total_tokens: 8 } };
      }
      taskParentCalls += 1;
      if (taskParentCalls === 1) {
        return {
          content: "Parent delegating task",
          tool_calls: [{ id: "b03_p_task", name: "task", arguments: { prompt: "[B03_TASK_CHILD] read target.txt", tools: ["read"] } }],
          usage: { total_tokens: 20 }
        };
      }
      return { content: "Parent finished with child result", tool_calls: [], usage: { total_tokens: 10 } };
    }
  };
  const kernelTask = await createKernel(rootTask, {
    sessionLog: null,
    branchStore: null,
    verifyMode: "off",
    modelGateway: gatewayTask
  });
  t.after(() => kernelTask.dispose());
  const scopedGwTask = scopeTask.bindGateway(gatewayTask, { role: "worker", subtaskId: "st_parent" });
  const taskRes = await kernelTask.runtime.send("Run task delegation in shared scope", {
    autonomy: "auto",
    modelGateway: scopedGwTask,
    scope: scopeTask,
    signal: scopeTask.signal
  });
  assert.equal(taskRes.status, "complete");
  const snapTask = budgetTask.snapshot();
  assert.equal(snapTask.model_calls, 4, "2 parent worker calls + 2 child task calls = 4 total");
  assert.equal(snapTask.tokens, 50, "20 + 10 parent tokens + 12 + 8 child tokens = 50 total");
  assert.deepEqual(snapTask.by_role.worker, { calls: 2, tokens: 30 });
  assert.deepEqual(snapTask.by_role.task, { calls: 2, tokens: 20 });
});

// B04: 网关 429 和 JSON 空回复重试物理计数与配额保护
test("B04: gateway retries (429 and JSON empty) count separate physical attempts against budget", async () => {
  const budget = createRequestBudget({ maxModelCalls: 5 });
  const scope = createRequestScope({ budget });
  let fetchAttempts = 0;

  const gateway = createDeepSeekGateway({
    apiKey: "test-key",
    sleepFn: async () => {},
    fetchImpl: async () => {
      fetchAttempts++;
      if (fetchAttempts === 1) {
        return {
          ok: false,
          status: 429,
          headers: new Map(),
          json: async () => ({ error: { message: "Rate limit exceeded" } }),
          text: async () => "Rate limit exceeded"
        };
      }
      return jsonResponse("Success on attempt 2", { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 });
    }
  });

  const res = await gateway.invoke([{ role: "user", content: "test 429 retry" }], { scope });
  assert.equal(res.content, "Success on attempt 2");
  assert.equal(fetchAttempts, 2, "2 physical fetch attempts occurred");
  assert.equal(budget.snapshot().model_calls, 2, "both attempts billed against budget");

  // When quota is 1, a 429 must NOT make a 2nd call (prevents overdraft)
  const strictBudget = createRequestBudget({ maxModelCalls: 1 });
  const strictScope = createRequestScope({ budget: strictBudget });
  let strictAttempts = 0;

  const strictGateway = createDeepSeekGateway({
    apiKey: "test-key",
    sleepFn: async () => {},
    fetchImpl: async () => {
      strictAttempts++;
      return {
        ok: false,
        status: 429,
        headers: new Map(),
        json: async () => ({ error: { message: "Rate limit exceeded" } }),
        text: async () => "Rate limit exceeded"
      };
    }
  });

  await assert.rejects(async () => {
    await strictGateway.invoke([{ role: "user", content: "test overdraft prevention" }], { scope: strictScope });
  }, (err) => err.code === "BUDGET_EXCEEDED" || err.status === 429);

  assert.equal(strictAttempts, 1, "strictly 1 fetch attempt made when quota was 1; retry suppressed");
  assert.equal(strictBudget.snapshot().model_calls, 1, "exactly 1 call counted");

  // JSON empty content retry
  const jsonBudget = createRequestBudget({ maxModelCalls: 5 });
  const jsonScope = createRequestScope({ budget: jsonBudget });
  let jsonAttempts = 0;

  const jsonGateway = createDeepSeekGateway({
    apiKey: "test-key",
    sleepFn: async () => {},
    fetchImpl: async () => {
      jsonAttempts++;
      if (jsonAttempts === 1) {
        return jsonResponse("", { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 });
      }
      return jsonResponse(JSON.stringify({ result: "valid json" }), { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 });
    }
  });

  const jres = await jsonGateway.invoke([{ role: "user", content: "return json format" }], { jsonMode: true, scope: jsonScope });
  assert.ok(jres);
  assert.equal(jsonAttempts, 2, "JSON empty content triggered 1 retry = 2 attempts");
  assert.equal(jsonBudget.snapshot().model_calls, 2, "budget recorded 2 attempts");
});

// B05: 仅剩 1 个名额，并行启动 4 个可控 Worker（屏障并发）
test("B05: parallel workers atomically compete for remaining quota under barrier: exactly 1 wins, 3 rejected", async () => {
  const root = await tmpRoot();
  const budget = createRequestBudget({ maxModelCalls: 1 });
  const scope = createRequestScope({ budget });
  const barrier = createBarrier(4);
  let outboundFetchCount = 0;

  const gateway = createDeepSeekGateway({
    apiKey: "test-key",
    fetchImpl: async () => {
      outboundFetchCount++;
      return jsonResponse("Winner response", { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    }
  });

  const kernel = await createKernel(root, {
    sessionLog: null,
    branchStore: null,
    verifyMode: "off",
    modelGateway: gateway
  });

  const workerFactory = createWorkerFactory({
    createRuntime: kernel.createRuntime,
    baseToolSchemas: () => [],
    makeContextSnapshot: () => ({}),
    modelGateway: gateway,
    scope
  });

  const runWorker = async (id) => {
    await barrier.arriveAndWait();
    const w = workerFactory.worker({ id: `st_${id}`, goal: `subtask ${id}`, tool_profile: "readonly" });
    return w.send(`worker ${id} prompt`);
  };

  const results = await Promise.allSettled([
    runWorker(1),
    runWorker(2),
    runWorker(3),
    runWorker(4)
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");

  assert.equal(fulfilled.length, 1, "strictly 1 worker succeeded");
  assert.equal(rejected.length, 3, "other 3 workers rejected before outbound HTTP");
  for (const r of rejected) {
    assert.equal(r.reason.code, "BUDGET_EXCEEDED");
  }
  assert.equal(outboundFetchCount, 1, "outbound HTTP fetchImpl was only called once");
  assert.equal(budget.snapshot().model_calls, 1, "budget model_calls is 1");

  await kernel.dispose();
});

// B06: 预留后、出站前取消
test("B06: cancellation before outbound fetch releases reservation without charging quota", () => {
  const budget = createRequestBudget({ maxModelCalls: 2 });
  const ticket = budget.reserveCall({ role: "worker" });
  assert.equal(ticket.ok, true);
  assert.equal(budget.snapshot().reserved_calls, 1);
  assert.equal(budget.snapshot().model_calls, 0);

  ticket.cancel();
  assert.equal(budget.snapshot().reserved_calls, 0, "reserved call released");
  assert.equal(budget.snapshot().model_calls, 0, "no spent calls recorded");

  // Quota is completely available
  const t2 = budget.reserveCall({ role: "worker" });
  const t3 = budget.reserveCall({ role: "worker" });
  assert.equal(t2.ok, true);
  assert.equal(t3.ok, true);
});

// B07: 发送后超时／取消／网络断开
test("B07: outbound network error/timeout charges model_call and marks unknownUsageAttempts", async () => {
  const budget = createRequestBudget({ maxModelCalls: 5 });
  const scope = createRequestScope({ budget });

  const gateway = createDeepSeekGateway({
    apiKey: "test-key",
    fetchImpl: async () => {
      throw new Error("ETIMEDOUT: Connection reset by peer");
    }
  });

  await assert.rejects(async () => {
    await gateway.invoke([{ role: "user", content: "network fail prompt" }], { scope, role: "worker", maxTokens: 50 });
  }, /ETIMEDOUT/);

  const snap = budget.snapshot();
  assert.equal(snap.model_calls, 1, "outbound failure charges call quota");
  assert.equal(snap.unknown_usage_attempts, 1, "marked as unknownUsageAttempts");
  assert.equal(snap.tokens, 0, "zero tokens recorded as unknown");
});

// B08: 有限 token 预算 + 缺失 usage 与非法/负值 usage（R1 & R2）
test("B08: finite token budget bounds unknown and invalid usage, blocking overspend", async () => {
  // maxTokens = 2500, fallbackTokensPerUnknown = 1000
  const budget = createRequestBudget({ maxTokens: 2500, maxModelCalls: 10, fallbackTokensPerUnknown: 1000 });
  const scope = createRequestScope({ budget });

  let fetchCount = 0;
  const gateway = createDeepSeekGateway({
    apiKey: "test-key",
    fetchImpl: async () => {
      fetchCount++;
      if (fetchCount === 1) {
        // Missing usage object
        return jsonResponse("response 1", null);
      }
      if (fetchCount === 2) {
        // Negative / malformed usage values
        return jsonResponse("response 2", { prompt_tokens: -50, completion_tokens: 30, total_tokens: -20 });
      }
      return jsonResponse("response 3", { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 });
    }
  });

  // Call 1: missing usage -> unknownUsageAttempts = 1, effective_tokens = 1000
  const res1 = await gateway.invoke([{ role: "user", content: "req 1" }], { scope, maxTokens: 50 });
  assert.ok(res1);
  assert.equal(budget.snapshot().unknown_usage_attempts, 1);
  assert.equal(budget.snapshot().tokens, 0);
  assert.equal(budget.snapshot().effective_tokens, 1000);

  // Call 2: negative usage rejected by normalizeUsageTokens -> unknownUsageAttempts = 2, effective_tokens = 2000
  const res2 = await gateway.invoke([{ role: "user", content: "req 2" }], { scope, maxTokens: 50 });
  assert.ok(res2);
  assert.equal(budget.snapshot().unknown_usage_attempts, 2);
  assert.equal(budget.snapshot().tokens, 0);
  assert.equal(budget.snapshot().effective_tokens, 2000);

  // Call 3: effective_tokens (2000) + estimatedTokens (52) <= 2500, but if estimatedTokens was 600, 2000 + 600 > 2500 -> exceeded!
  // Let's test with estimatedTokens requiring 600 tokens:
  await assert.rejects(async () => {
    await gateway.invoke([{ role: "user", content: "req 3" }], { scope, maxTokens: 600 });
  }, (err) => err.code === "BUDGET_EXCEEDED");

  assert.equal(fetchCount, 2, "3rd fetch was blocked by budget check before outbound request");
});

// B09: 响应后处理异常时 usage 依然被恰好结算一次（R8）
test("B09: gateway post-processing exception settles usage exactly once without double counting", async () => {
  const budget = createRequestBudget({ maxModelCalls: 5, maxTokens: 1000 });
  const scope = createRequestScope({ budget });

  const gateway = createDeepSeekGateway({
    apiKey: "test-key",
    fetchImpl: async () => {
      // Return 200 OK with valid usage, but malformed tool_calls object that causes error in processChatPayload
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        json: async () => ({
          choices: [{
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: "invalid-not-an-array" // triggers toolCalls.map error
            }
          }],
          usage: { prompt_tokens: 15, completion_tokens: 10, total_tokens: 25 }
        }),
        text: async () => ""
      };
    }
  });

  await assert.rejects(async () => {
    await gateway.invoke([{ role: "user", content: "test post-processing error" }], { scope, maxTokens: 50 });
  });

  const snap = budget.snapshot();
  assert.equal(snap.model_calls, 1, "exactly 1 call recorded despite post-processing error");
  assert.equal(snap.tokens, 25, "usage was accurately settled");
  assert.equal(snap.unknown_usage_attempts, 0, "usage was known and settled");
});

// B09-b: SSE 流式响应中的 usage 多 chunk / 重复推送恰好结算一次
test("B09-b: SSE stream with usage in chunks settles exactly once without double counting", async () => {
  const budget = createRequestBudget({ maxModelCalls: 5, maxTokens: 1000 });
  const scope = createRequestScope({ budget });

  const encoder = new TextEncoder();
  const streamBody = new ReadableStream({
    start(controller) {
      // Chunk 1: text delta, no usage
      controller.enqueue(encoder.encode("data: {\"choices\":[{\"delta\":{\"content\":\"hello \"}}]}\n\n"));
      // Chunk 2: text delta with interim usage (12 tokens: 10 prompt, 2 completion)
      controller.enqueue(encoder.encode("data: {\"choices\":[{\"delta\":{\"content\":\"world\"}}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":2,\"total_tokens\":12}}\n\n"));
      // Chunk 3: final cumulative usage (15 tokens: 10 prompt, 5 completion)
      controller.enqueue(encoder.encode("data: {\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5,\"total_tokens\":15}}\n\n"));
      // Chunk 4: duplicate final usage event before DONE
      controller.enqueue(encoder.encode("data: {\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5,\"total_tokens\":15}}\n\n"));
      // Chunk 5: [DONE]
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    }
  });

  const gateway = createDeepSeekGateway({
    apiKey: "test-key",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Map([["content-type", "text/event-stream"]]),
      body: streamBody
    })
  });

  const res = await gateway.stream([{ role: "user", content: "test stream" }], { scope });
  assert.equal(res.content, "hello world");
  assert.deepEqual(res.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });

  const snap = budget.snapshot();
  assert.equal(snap.model_calls, 1, "stream call settled exactly once");
  assert.equal(snap.tokens, 15, "stream usage settled accurately to final 15 tokens without double counting interim 12 or duplicate 15");
  assert.equal(snap.unknown_usage_attempts, 0);
});

// B10: 预算在 planner 或 router 内部耗尽时不吞错、不降级
test("B10: planner and router budget exhaustion throws BUDGET_EXCEEDED without swallowing or retrying", async () => {
  const budget = createRequestBudget({ maxModelCalls: 0 }); // zero quota
  const scope = createRequestScope({ budget });

  const planner = createPlanner({
    callModel: async (prompt, opts) => {
      const ticket = opts.scope.budget.reserveCall({ role: "planner" });
      if (!ticket.ok) throw ticket.error;
      return "{}";
    }
  });

  await assert.rejects(async () => {
    await planner.plan({ message: "do something", scope, signal: scope.signal });
  }, (err) => err.code === "BUDGET_EXCEEDED");
});

// B11: 预算不足以跑 synthesizer 时返回确定性摘要收口
test("B11: synthesizer budget exhaustion returns deterministic summary without model call", async () => {
  const budget = createRequestBudget({ maxModelCalls: 0 });
  const scope = createRequestScope({ budget });
  let synthModelCalled = false;

  const synth = createSynthesizer({
    callModel: async () => {
      synthModelCalled = true;
      return "Model summary";
    }
  });

  const collected = [{ st: { id: "st1", goal: "goal 1" }, status: "complete", wres: { content: "ok" } }];
  const result = await synth.synthesize({
    collected,
    message: "user goal",
    scope,
    signal: scope.signal
  });

  assert.equal(synthModelCalled, false, "synthesizer did NOT call model when budget was exhausted");
  assert.ok(result.includes("Completed 1/1 sub-tasks"), "returned deterministic summary");
});

// B12: cancel 发生在运行期 / 全树取消与无迟到合并（R3 & R4）
test("B12: tree-wide abort during parallel isolated worker execution cancels running scope, blocks merges, and cleans up iso directories", async () => {
  const root = await tmpRoot();
  const budget = createRequestBudget({ maxModelCalls: 10 });
  const scope = createRequestScope({ budget });
  let mergeCalls = 0;

  // Root project has initial main.js
  await fs.writeFile(path.join(root, "main.js"), "original main content\n");

  const workersArrived = createBarrier(2);
  const workersCanFinish = createDeferred();
  const createdIsoDirs = [];

  const subtasks = [
    { id: "st_1", goal: "edit main.js in isolation", tool_profile: "edit", context_scope: { files: ["main.js", "st1.txt"] }, depends_on: [] },
    { id: "st_2", goal: "create st2.txt in isolation", tool_profile: "readonly", context_scope: { files: ["st2.txt"] }, depends_on: [] }
  ];

  const dispatchLoopPromise = runDispatchLoop({
    plan: { subtasks },
    workerFactory: {
      worker: () => ({
        send: async () => ({ status: "complete" })
      })
    },
    makeReviewer: () => ({ review: async () => ({ pass: true }) }),
    synthesizer: { synthesize: async () => "summary" },
    budget,
    maxWorkerAttempts: 1,
    autonomy: "auto",
    onEvent: () => {},
    toBatches,
    maxParallelWorkers: 2,
    runIsolatedWorker: async ({ subtask, runId }) => {
      const isoRoot = await createIso({ root, runId, subtaskId: subtask.id });
      createdIsoDirs.push(isoRoot);
      if (subtask.id === "st_1") {
        await fs.writeFile(path.join(isoRoot, "main.js"), "modified by st_1\n");
        await fs.writeFile(path.join(isoRoot, "st1.txt"), "st1 content\n");
      } else {
        await fs.writeFile(path.join(isoRoot, "st2.txt"), "st2 content\n");
      }
      await workersArrived.arriveAndWait();
      await workersCanFinish.promise;
      return {
        st: subtask,
        isoRoot,
        wres: { status: "complete", content: "done" },
        verdict: { pass: true, reasons: [] },
        actual: {
          added: subtask.id === "st_1" ? ["st1.txt"] : ["st2.txt"],
          modified: subtask.id === "st_1" ? ["main.js"] : [],
          deleted: []
        }
      };
    },
    mergeSubtask: async () => {
      mergeCalls++;
      return { ok: true, change_id: "c1" };
    },
    removeIso,
    projectRules: [],
    scope
  });

  // Wait until both parallel workers have created their isolated directories and are in flight
  await workersArrived.arriveAndWait();
  assert.equal(createdIsoDirs.length, 2, "both isolated workspaces were created");
  for (const d of createdIsoDirs) {
    const stat = await fs.stat(d);
    assert.equal(stat.isDirectory(), true, "isolated workspace exists on disk");
  }

  // Tree-wide abort occurs while workers are actively running in isolation!
  scope.abort("interrupted by user");
  workersCanFinish.resolve();

  const loopResult = await dispatchLoopPromise;
  assert.equal(loopResult.status, "cancelled", "dispatch loop returned cancelled");
  assert.equal(mergeCalls, 0, "zero merges occurred after abort");
  assert.equal(scope.signal.aborted, true, "scope signal marked aborted");

  // Verify main project files are completely untouched
  const mainContent = await fs.readFile(path.join(root, "main.js"), "utf8");
  assert.equal(mainContent, "original main content\n", "main.js was untouched in root");
  await assert.rejects(fs.access(path.join(root, "st1.txt")), "st1.txt was not merged into root");
  await assert.rejects(fs.access(path.join(root, "st2.txt")), "st2.txt was not merged into root");

  // Verify isolated directories were cleanly removed by removeIso
  for (const d of createdIsoDirs) {
    await assert.rejects(fs.access(d), `isolated directory ${d} was cleaned up on abort`);
  }

  // Future reservations throw AbortError
  assert.throws(() => {
    scope.budget.reserveCall({ role: "worker", signal: scope.signal });
  }, (err) => err.name === "AbortError" || err.code === "ABORT");
});

// B13: 两个 kernel／会话交错运行保持完全隔离
test("B13: two concurrent kernels maintain isolated scopes, budgets, and execution IDs", async () => {
  const root1 = await tmpRoot();
  const root2 = await tmpRoot();

  const k1 = await createKernel(root1, {
    sessionLog: null,
    branchStore: null,
    verifyMode: "off",
    deepseek: {
      apiKey: "key1",
      fetchImpl: async () => jsonResponse("k1 resp", { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })
    }
  });

  const k2 = await createKernel(root2, {
    sessionLog: null,
    branchStore: null,
    verifyMode: "off",
    deepseek: {
      apiKey: "key2",
      fetchImpl: async () => jsonResponse("k2 resp", { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 })
    }
  });

  const b1 = createRequestBudget({ maxModelCalls: 10 });
  const b2 = createRequestBudget({ maxModelCalls: 10 });

  await Promise.all([
    k1.agent.send("hello k1", { scope: createRequestScope({ budget: b1 }) }),
    k2.agent.send("hello k2", { scope: createRequestScope({ budget: b2 }) })
  ]);

  assert.notEqual(b1.executionId, b2.executionId, "execution IDs are distinct");
  assert.equal(b1.snapshot().tokens, 15, "k1 budget recorded k1 tokens");
  assert.equal(b2.snapshot().tokens, 30, "k2 budget recorded k2 tokens");

  await k1.dispose();
  await k2.dispose();
});

// B14: 非零消耗后暂停→dispose→新 kernel 恢复（R3, R10）
test("B14: durable recovery continuation does not duplicate billing and preserves executionId and by_role", async () => {
  const root = await tmpRoot();
  await fs.writeFile(path.join(root, "a.js"), "original a\n");

  const kA = await createKernel(root, {
    sessionLog: null,
    branchStore: null,
    verifyMode: "off",
    projectId: "proj14",
    sessionId: "sess14A",
    recovery: { enabled: true, lock: false, surface: "cli" },
    deepseek: {
      apiKey: "test-key",
      fetchImpl: async (url, init) => {
        const bodyStr = init.body;
        if (bodyStr.includes("Break the user's request")) {
          return jsonResponse({
            task_summary: "summary",
            done_when: "done",
            subtasks: [
              { id: "st_1", goal: "modify a.js", acceptance: ["ok"], context_scope: { files: ["a.js"] }, tool_profile: "edit", depends_on: [] }
            ]
          }, { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 });
        }
        if (bodyStr.includes("INDEPENDENT reviewer")) {
          return jsonResponse({ pass: true, severity: "warn", reasons: [], checked: ["read"] }, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
        }
        return {
          ok: true,
          status: 200,
          headers: new Map(),
          json: async () => ({
            choices: [{
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: "",
                tool_calls: [{
                  id: "t1",
                  type: "function",
                  function: {
                    name: "diff_apply",
                    arguments: JSON.stringify({ diff: "--- a/a.js\n+++ b/a.js\n@@ -1,1 +1,1 @@\n-original a\n+edited a\n" })
                  }
                }]
              }
            }],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
          }),
          text: async () => ""
        };
      }
    }
  });

  const customBudget = createRequestBudget({ maxTokens: 5000, maxModelCalls: 6 });
  const p = await kA.agent.send("逐一处理 a.js 的输入校验", { autonomy: "supervised", scope: createRequestScope({ budget: customBudget }) });
  assert.equal(p.status, "awaiting_approval");

  const snapA = customBudget.snapshot();
  assert.equal(snapA.model_calls, 3, "exactly 3 calls spent in kernel A (router + planner + worker)");
  assert.equal(snapA.tokens, 70, "exactly 70 tokens spent in kernel A (20 router + 30 planner + 20 worker)");
  assert.equal(snapA.by_role.router.calls, 1);
  assert.equal(snapA.by_role.router.tokens, 20);
  assert.equal(snapA.by_role.planner.calls, 1);
  assert.equal(snapA.by_role.planner.tokens, 30);
  assert.equal(snapA.by_role.worker.calls, 1);
  assert.equal(snapA.by_role.worker.tokens, 20);

  // Dispose kernel A (preserves sidecars)
  await kA.dispose();

  // Kernel B recovers from disk
  const kB = await createKernel(root, {
    sessionLog: null,
    branchStore: null,
    verifyMode: "off",
    projectId: "proj14",
    sessionId: "sess14B",
    recovery: { enabled: true, lock: false, surface: "cli" },
    deepseek: {
      apiKey: "test-key",
      fetchImpl: async (url, init) => {
        const bodyStr = init.body;
        if (bodyStr.includes("Synthesize a final answer")) {
          return jsonResponse("All done successfully", { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
        }
        if (bodyStr.includes("INDEPENDENT reviewer")) {
          return jsonResponse({ pass: true, severity: "warn", reasons: [], checked: ["read"] }, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
        }
        return jsonResponse("Worker resumed output", { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 });
      }
    }
  });

  const items = await kB.recovery.list();
  assert.ok(items.some((i) => i.source_id === p.approval.id));

  const resumed = await kB.recovery.resume(`rec_orch_${p.approval.id}`, { decision: "approve" });
  assert.equal(resumed.status, "resumed");
  assert.equal(resumed.result.status, "complete");
  assert.equal(await fs.readFile(path.join(root, "a.js"), "utf8"), "edited a\n");

  const snapResumed = resumed.result.budget;
  assert.ok(snapResumed, "resumed ledger exists");
  assert.equal(snapResumed.execution_id, customBudget.executionId, "executionId preserved across restart");

  // Exact diff assertions: Kernel B added exactly 3 calls (worker resumed + reviewer + synthesizer)
  assert.equal(snapResumed.model_calls, snapA.model_calls + 3, "strictly 3 new calls added across resume (total 6)");
  assert.equal(snapResumed.tokens, snapA.tokens + 50, "strictly 50 new tokens added across resume (total 120: 20 worker + 15 reviewer + 15 synthesizer)");

  // Exact by_role assertions
  assert.equal(snapResumed.by_role.router.calls, snapA.by_role.router.calls);
  assert.equal(snapResumed.by_role.router.tokens, snapA.by_role.router.tokens);
  assert.equal(snapResumed.by_role.planner.calls, snapA.by_role.planner.calls);
  assert.equal(snapResumed.by_role.planner.tokens, snapA.by_role.planner.tokens);
  assert.equal(snapResumed.by_role.worker.calls, snapA.by_role.worker.calls + 1);
  assert.equal(snapResumed.by_role.worker.tokens, snapA.by_role.worker.tokens + 20);
  assert.equal(snapResumed.by_role.reviewer.calls, 1);
  assert.equal(snapResumed.by_role.reviewer.tokens, 15);
  assert.equal(snapResumed.by_role.synthesizer.calls, 1);
  assert.equal(snapResumed.by_role.synthesizer.tokens, 15);

  assert.equal(snapResumed.max_model_calls, 6, "quota preserved");
  assert.equal(snapResumed.max_tokens, 5000, "token quota preserved");

  // Attempt deduplication check: all 6 attempts recorded, duplicate settle is no-op
  assert.equal(snapResumed.settled_attempts.length, 6, "6 settled attempts tracked");
  const testBudget = createRequestBudget({
    maxModelCalls: 10,
    initialModelCalls: snapResumed.model_calls,
    initialTokens: snapResumed.tokens,
    initialSettledAttempts: snapResumed.settled_attempts
  });
  const dupTicket = testBudget.reserveCall({ attemptId: snapResumed.settled_attempts[0], role: "worker" });
  dupTicket.settle({ usage: { total_tokens: 100 } });
  assert.equal(testBudget.snapshot().model_calls, snapResumed.model_calls, "duplicate attemptId did not increment model_calls");
  assert.equal(testBudget.snapshot().tokens, snapResumed.tokens, "duplicate attemptId did not increment tokens");

  // Quota exhaustion check: budget of 6 calls is now full (6/6), next call is blocked
  const fullBudget = createRequestBudget({
    maxModelCalls: snapResumed.max_model_calls,
    initialModelCalls: snapResumed.model_calls,
    initialTokens: snapResumed.tokens
  });
  assert.throws(() => {
    fullBudget.reserveCall({ role: "worker" });
  }, (err) => err.code === "BUDGET_EXCEEDED");

  await kB.dispose();
});

// B15: 旧 schema / v1.17 未记账记录的迁移与安全兼容（R5 & F06）
test("B15: legacy v1.17 sidecar with finite quota fails closed via gate, while unmetered sidecar migrates safely", () => {
  // Scenario 1: First worker paused, allCollected = [], finite quotaCalls = 3, legacy format without settledAttempts
  const legacyFirstWorkerSidecar = {
    schemaVersion: 1,
    fingerprints: { workerFactory: 1, toolSubset: 1, subtaskSchema: 1 },
    approvalId: "app_legacy_1",
    taskId: "task_legacy_1",
    sessionId: "sess_legacy_1",
    message: "do stuff",
    done_when: "done",
    plan: { subtasks: [{ id: "st_1" }] },
    round: 1,
    pausedSubtask: { id: "st_1" },
    remaining: [],
    seenSubtaskIds: ["st_1"],
    seenFp: ["fp1"],
    allCollected: [],
    budget: {
      quotaTokens: null,
      quotaCalls: 3, // finite quota!
      spentTokens: 0,
      spentCalls: 0
    }
  };
  const legacyWorkerRecord = {
    approval_id: "app_legacy_1",
    resume_state: {
      options: {
        __orchestration: {
          taskId: "task_legacy_1",
          sessionId: "sess_legacy_1",
          subtaskId: "st_1"
        }
      }
    }
  };

  const gateResult = orchestrationResumeGate({ sidecar: legacyFirstWorkerSidecar, workerRecord: legacyWorkerRecord });
  assert.equal(gateResult.ok, false, "gate must fail closed on legacy sidecar with finite quota");
  assert.match(gateResult.reason, /legacy unmetered budget: cannot safely verify remaining quota/);

  // Scenario 2: Legacy sidecar with UNMETERED quota (quotaCalls: null, quotaTokens: null) can continue
  const legacyUnmeteredSidecar = {
    ...legacyFirstWorkerSidecar,
    budget: {
      quotaTokens: null,
      quotaCalls: null,
      spentTokens: 0,
      spentCalls: 0
    }
  };
  const gateUnmetered = orchestrationResumeGate({ sidecar: legacyUnmeteredSidecar, workerRecord: legacyWorkerRecord });
  assert.equal(gateUnmetered.ok, true, "unmetered legacy sidecar is permitted to resume");

  const continuation = budgetContinuation(legacyUnmeteredSidecar.budget, legacyUnmeteredSidecar);
  assert.equal(continuation.legacyUnmetered, true, "marked legacyUnmetered");
  assert.equal(continuation.maxModelCalls, null);
});

// B16: 未开启聚合限制或普通 single 请求的兼容性（R7）
test("B16: single lane execution bypasses orchestration aggregate budget and allows multi-turn tool loops", async () => {
  const root = await tmpRoot();
  let fetchCount = 0;

  // Set orchestration.budget.maxModelCalls = 1
  const kernel = await createKernel(root, {
    sessionLog: null,
    branchStore: null,
    verifyMode: "off",
    orchestration: {
      budget: { maxModelCalls: 1, maxTokens: 100 }
    },
    deepseek: {
      apiKey: "test-key",
      fetchImpl: async (url, init) => {
        fetchCount++;
        if (fetchCount === 1) {
          // Model asks to call readonly tool
          return {
            ok: true,
            status: 200,
            headers: new Map(),
            json: async () => ({
              choices: [{
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [{
                    id: "call_1",
                    type: "function",
                    function: { name: "file_search", arguments: JSON.stringify({ query: "test" }) }
                  }]
                }
              }],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
            }),
            text: async () => ""
          };
        }
        // Second model call: answers user after tool result
        return jsonResponse("Final single response", { prompt_tokens: 15, completion_tokens: 10, total_tokens: 25 });
      }
    }
  });

  // Query message routes to single lane
  const res = await kernel.agent.send("help me query package name", { autonomy: "auto" });
  assert.ok(res);
  assert.equal(fetchCount, 2, "single lane was NOT capped at orchestration.budget.maxModelCalls = 1");
  await kernel.dispose();
});

// B17: scope 完成后迟到结果与后台经验巩固预算（R6 & F07）
test("B17: background experience consolidation skips model distillation when budget is exhausted", async () => {
  const root = await tmpRoot();
  let consolidationFetchCount = 0;
  const consolidationSkippedEvents = [];

  const kernel = await createKernel(root, {
    sessionLog: null,
    branchStore: null,
    verifyMode: "off",
    orchestration: {
      crossTaskLearning: "on",
      budget: { maxModelCalls: 2 } // router=1, planner=1 -> exhausted!
    },
    deepseek: {
      apiKey: "test-key",
      fetchImpl: async (url, init) => {
        const bodyStr = init.body;
        if (bodyStr.includes("Classify this coding request")) {
          return jsonResponse({ lane: "orchestrate", reason: "multi-component" });
        }
        if (bodyStr.includes("Break the user's request")) {
          return jsonResponse({ task_summary: "t", done_when: "d", subtasks: [] });
        }
        if (bodyStr.includes("experience") || bodyStr.includes("distill") || bodyStr.includes("Distill")) {
          consolidationFetchCount++;
          return jsonResponse({ lessons: [] });
        }
        return jsonResponse("done");
      }
    }
  });

  kernel.eventBus.subscribe("experience:consolidation_skipped", (evt) => {
    consolidationSkippedEvents.push(evt);
  });

  // Turn 1: 2 calls allowed, consumed by router and planner
  const res = await kernel.agent.send("请处理这些校验逻辑", { autonomy: "auto" });
  assert.ok(res);

  // Await background consolidation flush
  await kernel.experience.flush();

  // Consolidation was skipped because budget was exhausted!
  assert.equal(consolidationFetchCount, 0, "consolidation model fetch was skipped when budget exhausted");
  assert.ok(consolidationSkippedEvents.length > 0, "experience:consolidation_skipped was published");
  assert.equal(consolidationSkippedEvents[0].reason, "budget_or_abort");

  await kernel.dispose();
});

// B18: 生产接线证据与公开入口完整性确认（R3, R9）
test("B18: custom gateway fallback wrapping and agent interrupt lifecycle", async () => {
  // Test R9: bindGateway wraps invoke, reply, stream for custom gateway
  const budget = createRequestBudget({ maxModelCalls: 0 });
  const scope = createRequestScope({ budget });

  const customGateway = {
    _isDeepSeekGateway: false,
    invoke: async () => ({ content: "invoked" }),
    reply: async () => ({ content: "replied" }),
    stream: async () => ({ content: "streamed" })
  };

  const bound = scope.bindGateway(customGateway, { role: "worker" });

  await assert.rejects(async () => {
    await bound.invoke([]);
  }, (err) => err.code === "BUDGET_EXCEEDED");

  await assert.rejects(async () => {
    await bound.reply({});
  }, (err) => err.code === "BUDGET_EXCEEDED");

  await assert.rejects(async () => {
    await bound.stream([]);
  }, (err) => err.code === "BUDGET_EXCEEDED");

  // Test R3: agent.interrupt aborts in-flight turn
  const root = await tmpRoot();
  const deferred = createDeferred();
  const fetchStarted = createDeferred();

  const kernel = await createKernel(root, {
    sessionLog: null,
    branchStore: null,
    verifyMode: "off",
    deepseek: {
      apiKey: "test-key",
      fetchImpl: async (url, init) => {
        return new Promise((resolve, reject) => {
          fetchStarted.resolve(); // Confirm HTTP request is in-flight before interrupting!
          if (init?.signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          }, { once: true });
          deferred.promise.then(() => resolve(jsonResponse("response")));
        });
      }
    }
  });

  const sendPromise = kernel.agent.send("hello wait for interrupt");
  await fetchStarted.promise; // Guaranteed in-flight!
  kernel.agent.interrupt();
  deferred.resolve();

  await assert.rejects(async () => {
    await sendPromise;
  }, (err) => err.name === "InterruptedError" || err.name === "AbortError" || err.code === "ABORT");

  await kernel.dispose();
});

// B19 (F02): 自定义 gateway 的 planner 等直接入口计费与防击穿验证
test("B19 (F02): custom gateway meters all roles (planner, worker, reviewer) under kernel default entry", async () => {
  const root = await tmpRoot();
  let invokeCalls = [];
  const customGateway = {
    _isDeepSeekGateway: false,
    invoke: async (msgs, opts) => {
      invokeCalls.push(opts.role || "unknown");
      if (opts.role === "planner") {
        return {
          content: JSON.stringify({
            task_summary: "summary",
            done_when: "done",
            subtasks: [{ id: "st_1", goal: "task 1", acceptance: ["ok"], context_scope: {}, tool_profile: "readonly", depends_on: [] }]
          })
        };
      }
      if (opts.role === "worker") {
        return { content: "worker finished" };
      }
      if (opts.role === "reviewer") {
        return { content: JSON.stringify({ pass: true, severity: "warn", reasons: [], checked: ["read"] }) };
      }
      return { content: "done" };
    }
  };

  const kernel = await createKernel(root, {
    sessionLog: null,
    branchStore: null,
    verifyMode: "off",
    modelGateway: customGateway,
    orchestration: {
      router: { model: { enabled: false } },
      budget: { maxModelCalls: 1 } // Only 1 call allowed in total!
    }
  });

  // Message routes heuristically to orchestrate lane
  const res = await kernel.agent.send("重构整个工程并跨多个文件", { autonomy: "auto" });
  assert.ok(res);
  // Planner consumed call 1. Worker was intercepted before outbound invoke!
  assert.equal(invokeCalls.length, 1, "custom gateway invoke was strictly called once (planner)");
  assert.equal(res.outcome, "partial", "worker was blocked by budget cap resulting in partial outcome");
  assert.equal(res.collected[0].status, "failed");
  assert.ok(res.collected[0].lastFeedback.includes("budget"));

  await kernel.dispose();
});

// B17-b: 前台返回后的后台在途经验巩固请求被 interrupt 取消
test("B17-b: in-flight background distill fetch is aborted when foreground send has returned and kernel.agent.interrupt() is called", async () => {
  const root = await tmpRoot();
  const distillStarted = createDeferred();
  const distillCanFinish = createDeferred();
  let distillAborted = false;
  let distillCalls = 0;

  const kernel = await createKernel(root, {
    sessionLog: null,
    branchStore: null,
    verifyMode: "off",
    orchestration: {
      maxRounds: 1,
      crossTaskLearning: "on",
      budget: { maxModelCalls: 30 }
    },
    deepseek: {
      apiKey: "test-key",
      fetchImpl: async (url, init) => {
        const bodyStr = init.body;
        if (bodyStr.includes("Classify this coding request")) {
          return jsonResponse({ lane: "orchestrate", reason: "multi-component" });
        }
        if (bodyStr.includes("Break the user's request")) {
          return jsonResponse({
            task_summary: "t",
            done_when: "d",
            subtasks: [{ id: "st_1", goal: "task 1", acceptance: ["ok"], context_scope: { files: [] }, tool_profile: "readonly", depends_on: [] }]
          });
        }
        if (bodyStr.includes("INDEPENDENT reviewer")) {
          return jsonResponse({ pass: true, severity: "warn", reasons: [], checked: ["read"] });
        }
        if (bodyStr.includes("experience") || bodyStr.includes("distill") || bodyStr.includes("Distill")) {
          distillCalls++;
          distillStarted.resolve();
          return new Promise((resolve, reject) => {
            if (init?.signal?.aborted) {
              distillAborted = true;
              return reject(new DOMException("aborted", "AbortError"));
            }
            init?.signal?.addEventListener("abort", () => {
              distillAborted = true;
              reject(new DOMException("aborted", "AbortError"));
            }, { once: true });
            distillCanFinish.promise.then(() => resolve(jsonResponse({ lessons: [] })));
          });
        }
        if (bodyStr.includes("Synthesize a final answer")) {
          return jsonResponse("synthesis summary");
        }
        return jsonResponse("worker response ok");
      }
    }
  });

  const res = await kernel.agent.send("请处理这些校验逻辑", { autonomy: "auto" });
  assert.equal(res.status, "complete", "foreground send returned complete");

  await distillStarted.promise;
  assert.equal(distillCalls, 1, "background distill fetch started after foreground completed");

  kernel.agent.interrupt();

  distillCanFinish.resolve();
  await kernel.experience.flush();

  assert.equal(distillAborted, true, "in-flight background distill fetch was cleanly aborted");

  await kernel.dispose();
});

// B20: T01 回归测试 - 恢复必须完整保留未知占额 (unknown_usage_tokens) 并阻断后续超支
test("B20 (T01 regression): durable recovery preserves unknown_usage_tokens liability and blocks overspend", async () => {
  const customBudget = createRequestBudget({
    maxTokens: 5000,
    fallbackTokensPerUnknown: 500
  });
  const scope = createRequestScope({ budget: customBudget });

  const gateway = createDeepSeekGateway({
    apiKey: "test-key",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Map([["content-type", "application/json"]]),
      json: async () => ({
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }]
      }),
      text: async () => ""
    })
  });

  // Turn 1: 20 prompt tokens estimated + 4000 output tokens = 4020 liability
  const messages = [{ role: "user", content: "x" }];
  const args = { scope, role: "worker", maxTokens: 4000 };
  await gateway.invoke(messages, args);

  const snapBefore = customBudget.snapshot();
  assert.equal(snapBefore.unknown_usage_tokens, 4020, "unknown_usage_tokens is 4020");
  assert.equal(snapBefore.effective_tokens, 4020, "effective_tokens is 4020");

  // Next identical request would need 4020 tokens -> 4020 + 4020 = 8040 > 5000 -> rejected!
  await assert.rejects(gateway.invoke(messages, args), { code: "BUDGET_EXCEEDED" });

  // Serialize and deserialize orchestration state
  const pausedState = {
    taskId: "t1",
    sessionId: "s1",
    message: "msg",
    done_when: "done",
    plan: { subtasks: [{ id: "st_1" }] },
    round: 1,
    pausedSubtask: { id: "st_1" },
    remaining: [],
    seenSubtaskIds: ["st_1"],
    seenFp: [],
    allCollected: [],
    budget: customBudget,
    executionId: customBudget.executionId,
    deps: {}
  };

  const serialized = serializeOrchestrationState(pausedState, "app_1");
  const jsonStr = JSON.stringify(serialized);
  const roundtripped = JSON.parse(jsonStr);
  const continuation = budgetContinuation(roundtripped.budget, roundtripped);

  assert.equal(continuation.initialUnknownUsageTokens, 4020, "continuation preserves unknown_usage_tokens");

  const resumedBudget = createRequestBudget({
    maxTokens: continuation.maxTokens,
    maxModelCalls: continuation.maxModelCalls,
    fallbackTokensPerUnknown: continuation.fallbackTokensPerUnknown,
    initialTokens: continuation.initialTokens,
    initialModelCalls: continuation.initialModelCalls,
    initialUnknownUsageAttempts: continuation.initialUnknownUsageAttempts,
    initialUnknownUsageTokens: continuation.initialUnknownUsageTokens,
    initialByRole: continuation.initialByRole,
    initialSettledAttempts: continuation.initialSettledAttempts,
    executionId: continuation.executionId
  });

  const snapAfter = resumedBudget.snapshot();
  assert.equal(snapAfter.unknown_usage_tokens, 4020, "resumed budget unknown_usage_tokens is still 4020");
  assert.equal(snapAfter.effective_tokens, 4020, "resumed budget effective_tokens is still 4020");

  // Resumed budget ALSO rejects the overspend request!
  const resumedScope = createRequestScope({ budget: resumedBudget });
  await assert.rejects(gateway.invoke(messages, { ...args, scope: resumedScope }), { code: "BUDGET_EXCEEDED" });
});

// B21: T02 回归测试 - 最终汇总期间 interrupt 返回 cancelled 终态并发布 orchestration:cancelled
test("B21 (T02 regression): interrupt during final synthesis returns cancelled status and outcome and publishes orchestration:cancelled", async () => {
  const root = await tmpRoot();
  let synthesisCount = 0;
  let fetchAborted = false;
  const synthFetchStarted = createDeferred();
  const events = [];

  const kernel = await createKernel(root, {
    sessionLog: null,
    branchStore: null,
    verifyMode: "off",
    orchestration: { maxRounds: 1, budget: { maxModelCalls: 30 } },
    deepseek: {
      apiKey: "test-key",
      fetchImpl: async (url, init) => {
        const bodyStr = init.body;
        if (bodyStr.includes("Classify this coding request")) {
          return jsonResponse({ lane: "orchestrate", reason: "multi-component" });
        }
        if (bodyStr.includes("Break the user's request")) {
          return jsonResponse({
            task_summary: "summary",
            done_when: "done",
            subtasks: [{ id: "st_1", goal: "task 1", acceptance: ["ok"], context_scope: {}, tool_profile: "readonly", depends_on: [] }]
          });
        }
        if (bodyStr.includes("INDEPENDENT reviewer")) {
          return jsonResponse({ pass: true, severity: "warn", reasons: [], checked: ["read"] });
        }
        if (bodyStr.includes("Synthesize a final answer")) {
          synthesisCount += 1;
          if (synthesisCount === 2) {
            return new Promise((resolve, reject) => {
              const onAbort = () => {
                fetchAborted = true;
                reject(Object.assign(new Error("cancelled during final synthesis"), { name: "AbortError" }));
              };
              if (init?.signal?.aborted) onAbort();
              else init?.signal?.addEventListener("abort", onAbort, { once: true });
              synthFetchStarted.resolve();
            });
          }
          return jsonResponse("round summary");
        }
        return jsonResponse("worker response ok");
      }
    }
  });

  for (const name of ["orchestration:completed", "orchestration:cancelled"]) {
    kernel.eventBus.subscribe(name, (data) => events.push({ name, data }));
  }

  const sendPromise = kernel.agent.send("请处理这些校验逻辑", { autonomy: "auto" });

  await synthFetchStarted.promise;

  kernel.agent.interrupt();

  const res = await sendPromise;

  assert.equal(fetchAborted, true, "in-flight final synthesis received abort");
  assert.equal(res.status, "cancelled", "status is cancelled");
  assert.equal(res.outcome, "cancelled", "outcome is cancelled");
  assert.equal(events.some((e) => e.name === "orchestration:completed"), false, "orchestration:completed was NOT published");
  assert.equal(events.some((e) => e.name === "orchestration:cancelled"), true, "orchestration:cancelled event was published");

  await kernel.dispose();
});
