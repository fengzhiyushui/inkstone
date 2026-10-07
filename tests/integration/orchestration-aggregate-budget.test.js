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
import { serializeOrchestrationState, deserializeOrchestrationState, budgetContinuation } from "../../src/core/orchestration/orchestration-recovery-contract.js";
import { mkdtemp } from "../helpers/tmp.js";

async function tmpRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "orch-budget-test-"));
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "orch-budget-test" }) + "\n");
  return root;
}

function jsonResponse(content, usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({
      choices: [{
        finish_reason: "stop",
        message: { role: "assistant", content: typeof content === "string" ? content : JSON.stringify(content) }
      }],
      usage
    }),
    text: async () => typeof content === "string" ? content : JSON.stringify(content)
  };
}

test("B01: ambiguous prompt routes through model tier and records router role in aggregate execution budget", async () => {
  const root = await tmpRoot();
  const fetchCalls = [];
  const kernel = await createKernel(root, {
    sessionLog: null,
    branchStore: null,
    verifyMode: "off",
    deepseek: {
      apiKey: "test-key",
      fetchImpl: async (url, init) => {
        fetchCalls.push({ url, body: JSON.parse(init.body) });
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

  const customBudget = createRequestBudget({ maxTokens: 10000, maxModelCalls: 50 });
  const scope = createRequestScope({ budget: customBudget });

  const ambig = "请处理这些校验逻辑"; // triggers ambiguous band
  const res = await kernel.agent.send(ambig, { autonomy: "auto", scope });

  assert.ok(res);
  const snap = customBudget.snapshot();
  assert.ok(snap.by_role.router, "router role recorded in budget");
  assert.equal(snap.by_role.router.calls, 1, "router made exactly 1 call");
  assert.equal(snap.by_role.router.tokens, 30, "router tokens recorded correctly");
  assert.ok(snap.model_calls >= 1, "total calls includes router");
  assert.equal(snap.execution_id, customBudget.executionId);
  await kernel.dispose();
});

test("B02 & B03: aggregate usage across all roles equals outbound fetchImpl calls and token sum", async () => {
  const root = await tmpRoot();
  let physicalOutboundCount = 0;
  const outboundTokens = { prompt: 0, completion: 0 };

  const kernel = await createKernel(root, {
    sessionLog: null,
    branchStore: null,
    verifyMode: "off",
    orchestration: { maxRounds: 2 },
    deepseek: {
      apiKey: "test-key",
      fetchImpl: async (url, init) => {
        physicalOutboundCount++;
        const bodyStr = init.body;
        const promptTok = 10;
        const compTok = 5;
        outboundTokens.prompt += promptTok;
        outboundTokens.completion += compTok;

        if (bodyStr.includes("Classify this coding request")) {
          return jsonResponse({ lane: "orchestrate", reason: "complex task" }, { prompt_tokens: promptTok, completion_tokens: compTok, total_tokens: promptTok + compTok });
        }
        if (bodyStr.includes("Break the user's request")) {
          return jsonResponse({
            task_summary: "summary",
            done_when: "done",
            subtasks: [
              { id: "st_1", goal: "task one", acceptance: ["ok"], context_scope: { files: [] }, tool_profile: "readonly", depends_on: [] }
            ]
          }, { prompt_tokens: promptTok, completion_tokens: compTok, total_tokens: promptTok + compTok });
        }
        if (bodyStr.includes("INDEPENDENT reviewer")) {
          return jsonResponse({ pass: true, severity: "warn", reasons: [], checked: ["read"] }, { prompt_tokens: promptTok, completion_tokens: compTok, total_tokens: promptTok + compTok });
        }
        if (bodyStr.includes("Synthesize a final answer")) {
          return jsonResponse("Synthesis complete", { prompt_tokens: promptTok, completion_tokens: compTok, total_tokens: promptTok + compTok });
        }
        return jsonResponse("Worker done", { prompt_tokens: promptTok, completion_tokens: compTok, total_tokens: promptTok + compTok });
      }
    }
  });

  const budget = createRequestBudget({ maxTokens: 5000, maxModelCalls: 20 });
  const scope = createRequestScope({ budget });

  const res = await kernel.agent.send("请处理这些校验逻辑", { autonomy: "auto", scope });
  assert.ok(res);

  const snap = budget.snapshot();
  assert.equal(snap.model_calls, physicalOutboundCount, "snap.model_calls equals physical outbound fetch count");
  assert.equal(snap.tokens, outboundTokens.prompt + outboundTokens.completion, "snap.tokens equals outbound token sum");

  // Verify role breakdown sum
  const sumRolesCalls = Object.values(snap.by_role).reduce((acc, r) => acc + r.calls, 0);
  const sumRolesTokens = Object.values(snap.by_role).reduce((acc, r) => acc + r.tokens, 0);
  assert.equal(sumRolesCalls, snap.model_calls, "sum of role calls matches aggregate calls");
  assert.equal(sumRolesTokens, snap.tokens, "sum of role tokens matches aggregate tokens");
  assert.ok(snap.by_role.router, "router role exists");
  assert.ok(snap.by_role.planner, "planner role exists");
  assert.ok(snap.by_role.worker, "worker role exists");
  assert.ok(snap.by_role.reviewer, "reviewer role exists");
  assert.ok(snap.by_role.synthesizer, "synthesizer role exists");

  await kernel.dispose();
});

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
        return jsonResponse("", { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 }); // empty content
      }
      return jsonResponse(JSON.stringify({ result: "valid json" }), { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 });
    }
  });

  const jres = await jsonGateway.invoke([{ role: "user", content: "return json format" }], { jsonMode: true, scope: jsonScope });
  assert.ok(jres);
  assert.equal(jsonAttempts, 2, "JSON empty content triggered 1 retry = 2 attempts");
  assert.equal(jsonBudget.snapshot().model_calls, 2, "budget recorded 2 attempts");
});

test("B05: parallel workers atomically compete for remaining quota: exactly 1 wins, other rejected", async () => {
  const budget = createRequestBudget({ maxModelCalls: 1 });
  const scope = createRequestScope({ budget });
  let outboundFetchCount = 0;

  const gateway = createDeepSeekGateway({
    apiKey: "test-key",
    fetchImpl: async () => {
      outboundFetchCount++;
      await new Promise((r) => setTimeout(r, 20));
      return jsonResponse("Winner response", { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    }
  });

  // Launch two concurrent worker calls with the same scope
  const worker1 = gateway.invoke([{ role: "user", content: "worker 1 prompt" }], { scope, role: "worker" });
  const worker2 = gateway.invoke([{ role: "user", content: "worker 2 prompt" }], { scope, role: "worker" });

  const results = await Promise.allSettled([worker1, worker2]);
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");

  assert.equal(fulfilled.length, 1, "exactly 1 worker succeeded");
  assert.equal(rejected.length, 1, "exactly 1 worker rejected");
  assert.equal(rejected[0].reason.code, "BUDGET_EXCEEDED", "rejection reason is BUDGET_EXCEEDED");
  assert.equal(outboundFetchCount, 1, "outbound HTTP fetchImpl was only called once");
  assert.equal(budget.snapshot().model_calls, 1, "budget model_calls is 1");
});

test("B06: reservation cancelled before outbound releases quota and does not count against spent", () => {
  const budget = createRequestBudget({ maxModelCalls: 2 });
  const ticket1 = budget.reserveCall({ role: "worker" });
  assert.equal(ticket1.ok, true);
  assert.equal(budget.snapshot().reserved_calls, 1);
  assert.equal(budget.snapshot().model_calls, 0);

  // Cancel ticket before markStarted
  ticket1.cancel();
  assert.equal(budget.snapshot().reserved_calls, 0, "reserved calls released");
  assert.equal(budget.snapshot().model_calls, 0, "no spent calls recorded");

  // Can still reserve 2 calls after cancellation
  const ticket2 = budget.reserveCall({ role: "worker" });
  const ticket3 = budget.reserveCall({ role: "worker" });
  assert.equal(ticket2.ok, true);
  assert.equal(ticket3.ok, true);
});

test("B07: outbound network error/timeout counts model_calls and marks unknownUsageAttempts", async () => {
  const budget = createRequestBudget({ maxModelCalls: 5 });
  const scope = createRequestScope({ budget });

  const gateway = createDeepSeekGateway({
    apiKey: "test-key",
    fetchImpl: async () => {
      throw new Error("ETIMEDOUT: Connection reset by peer");
    }
  });

  await assert.rejects(async () => {
    await gateway.invoke([{ role: "user", content: "network fail prompt" }], { scope, role: "worker" });
  }, /ETIMEDOUT/);

  const snap = budget.snapshot();
  assert.equal(snap.model_calls, 1, "outbound failure still counts call against quota (cannot be refunded)");
  assert.equal(snap.unknown_usage_attempts, 1, "marked as unknownUsageAttempts since usage wasn't received");
  assert.equal(snap.tokens, 0, "zero tokens recorded since unknown");
});

test("B08: token ceiling rejection when maxTokens reached", async () => {
  const budget = createRequestBudget({ maxTokens: 25, maxModelCalls: 10 });
  const scope = createRequestScope({ budget });

  const gateway = createDeepSeekGateway({
    apiKey: "test-key",
    fetchImpl: async () => {
      return jsonResponse("Response with 20 tokens", { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 });
    }
  });

  // Call 1: consumes 20 tokens (limit is 25)
  await gateway.invoke([{ role: "user", content: "call 1" }], { scope });
  assert.equal(budget.snapshot().tokens, 20);

  // Call 2: estimating 10 tokens (total 30 > 25) throws BUDGET_EXCEEDED
  assert.throws(() => {
    budget.reserveCall({ estimatedTokens: 10 });
  }, (err) => err.code === "BUDGET_EXCEEDED");
});

test("B09: single lane execution bypasses orchestration budget tracking", async () => {
  const root = await tmpRoot();
  let fetchCount = 0;
  const kernel = await createKernel(root, {
    sessionLog: null,
    branchStore: null,
    verifyMode: "off",
    deepseek: {
      apiKey: "test-key",
      fetchImpl: async () => {
        fetchCount++;
        return jsonResponse("Single turn response", { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 });
      }
    }
  });

  // Simple query prompt defaults to single lane without consulting model
  const res = await kernel.agent.send("hello simple question");
  assert.ok(res);
  assert.equal(fetchCount, 1);
  await kernel.dispose();
});

test("B10: planner budget exhaustion gracefully stops without degrading or swallowing error", async () => {
  const budget = createRequestBudget({ maxModelCalls: 0 }); // zero quota
  const scope = createRequestScope({ budget });

  const planner = createPlanner({
    callModel: async () => {
      const ticket = budget.reserveCall({ role: "planner" });
      if (!ticket.ok) throw ticket.error;
      return "{}";
    }
  });

  await assert.rejects(async () => {
    await planner.plan({ message: "do something", scope, signal: scope.signal });
  }, (err) => err.code === "BUDGET_EXCEEDED");
});

test("B11: synthesizer budget exhaustion directly returns deterministic summary without model call", async () => {
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

test("B12: tree-wide abort signal propagation cancels running scope", async () => {
  const scope = createRequestScope({ budget: createRequestBudget({ maxModelCalls: 10 }) });
  assert.equal(scope.signal.aborted, false);

  scope.abort("interrupted by user");
  assert.equal(scope.signal.aborted, true);
  assert.equal(scope.signal.reason, "interrupted by user");

  assert.throws(() => {
    scope.budget.reserveCall({ role: "worker", signal: scope.signal });
  }, (err) => err.name === "AbortError" || err.code === "ABORT");
});

test("B13: two concurrent kernels maintain isolated scopes and budgets", async () => {
  const root1 = await tmpRoot();
  const root2 = await tmpRoot();

  const k1Calls = [];
  const k2Calls = [];

  const k1 = await createKernel(root1, {
    sessionLog: null,
    branchStore: null,
    verifyMode: "off",
    deepseek: {
      apiKey: "key1",
      fetchImpl: async () => {
        k1Calls.push(1);
        return jsonResponse("k1 resp", { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
      }
    }
  });

  const k2 = await createKernel(root2, {
    sessionLog: null,
    branchStore: null,
    verifyMode: "off",
    deepseek: {
      apiKey: "key2",
      fetchImpl: async () => {
        k2Calls.push(2);
        return jsonResponse("k2 resp", { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 });
      }
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
  assert.equal(b1.snapshot().model_calls, 1);
  assert.equal(b2.snapshot().model_calls, 1);

  await k1.dispose();
  await k2.dispose();
});

test("B14: durable recovery continuation does not duplicate billing and restores spent quota", () => {
  // Simulate previous run that spent 3 calls and 120 tokens, with 1 unknown usage attempt
  const originalBudget = createRequestBudget({
    maxTokens: 500,
    maxModelCalls: 10,
    initialTokens: 80,
    initialModelCalls: 2,
    initialUnknownUsageAttempts: 1,
    initialSettledAttempts: ["att_1", "att_2"]
  });

  // Make 1 more call
  const t = originalBudget.reserveCall({ attemptId: "att_3", role: "worker" });
  t.markStarted();
  t.settle({ usage: { total_tokens: 40 } });

  const fakeState = {
    message: "resume test",
    done_when: "done",
    options: { autonomy: "gated", sessionId: "sess_r" },
    plan: { subtasks: [{ id: "st_1", goal: "task", acceptance: [], context_scope: {}, tool_profile: "readonly", depends_on: [] }] },
    round: 1,
    allCollected: [],
    seenSubtaskIds: new Set(["st_1"]),
    seenFp: new Set(["fp_1"]),
    riskCues: new Set(),
    adoptedExperienceIds: [],
    taskId: "task_1",
    sessionId: "sess_r",
    executionId: originalBudget.executionId,
    budget: originalBudget,
    pausedSubtask: { id: "st_1" },
    remaining: []
  };

  const serialized = serializeOrchestrationState(fakeState, { approvalId: "ap_1", pausedSubtask: { id: "st_1" }, remaining: [] });
  assert.equal(serialized.budget.spentCalls, 3);
  assert.equal(serialized.budget.spentTokens, 120);
  assert.equal(serialized.budget.unknownUsageAttempts, 1);
  assert.deepEqual(serialized.budget.settledAttempts, ["att_1", "att_2", "att_3"]);

  const deserialized = deserializeOrchestrationState(serialized);
  const continuation = deserialized.budgetSnapshot;
  assert.equal(continuation.initialModelCalls, 3);
  assert.equal(continuation.initialTokens, 120);
  assert.equal(continuation.initialUnknownUsageAttempts, 1);
  assert.deepEqual(continuation.initialSettledAttempts, ["att_1", "att_2", "att_3"]);

  // Create resumed budget
  const resumedBudget = createRequestBudget({
    maxTokens: continuation.maxTokens,
    maxModelCalls: continuation.maxModelCalls,
    initialTokens: continuation.initialTokens,
    initialModelCalls: continuation.initialModelCalls,
    initialUnknownUsageAttempts: continuation.initialUnknownUsageAttempts,
    initialSettledAttempts: continuation.initialSettledAttempts,
    executionId: deserialized.executionId
  });

  const resSnap = resumedBudget.snapshot();
  assert.equal(resSnap.model_calls, 3, "starts from 3 spent calls");
  assert.equal(resSnap.tokens, 120, "starts from 120 spent tokens");
  assert.equal(resSnap.unknown_usage_attempts, 1, "restores unknownUsageAttempts");

  // Attempting to settle "att_3" again is idempotent and does not double-count
  const dupeTicket = resumedBudget.reserveCall({ attemptId: "att_3", role: "worker" });
  dupeTicket.markStarted();
  dupeTicket.settle({ usage: { total_tokens: 40 } });
  assert.equal(resumedBudget.snapshot().model_calls, 3, "model_calls not incremented for already settled attempt");
  assert.equal(resumedBudget.snapshot().tokens, 120, "tokens not incremented for already settled attempt");
});

test("B15: idempotent settlement on identical attemptId does not duplicate metrics", () => {
  const budget = createRequestBudget({ maxModelCalls: 10, maxTokens: 1000 });
  const t1 = budget.reserveCall({ attemptId: "fixed_id", role: "worker" });
  t1.markStarted();
  t1.settle({ usage: { total_tokens: 50 } });

  assert.equal(budget.snapshot().model_calls, 1);
  assert.equal(budget.snapshot().tokens, 50);

  // Settle again with the same attemptId
  const t2 = budget.reserveCall({ attemptId: "fixed_id", role: "worker" });
  t2.markStarted();
  t2.settle({ usage: { total_tokens: 50 } });

  assert.equal(budget.snapshot().model_calls, 1, "calls stayed at 1");
  assert.equal(budget.snapshot().tokens, 50, "tokens stayed at 50");
});

test("B16: unknown usage attempts increment properly on network errors without double settlement", () => {
  const budget = createRequestBudget({ maxModelCalls: 10 });
  const t = budget.reserveCall({ role: "worker" });
  t.markStarted();
  t.settle({ error: new Error("network abort") });

  assert.equal(budget.snapshot().model_calls, 1);
  assert.equal(budget.snapshot().tokens, 0);
  assert.equal(budget.snapshot().unknown_usage_attempts, 1);

  // Settle again on same ticket has no effect
  t.settle({ error: new Error("network abort 2") });
  assert.equal(budget.snapshot().unknown_usage_attempts, 1);
});

test("B17: worker factory and reviewer role attribution in bindGateway", async () => {
  const budget = createRequestBudget({ maxModelCalls: 10 });
  const scope = createRequestScope({ budget });
  const recorded = [];

  const mockGw = {
    invoke: async (msgs, opts) => {
      recorded.push(opts.role);
      return { content: "resp", usage: { total_tokens: 10 } };
    }
  };

  const workerGw = scope.bindGateway(mockGw, { role: "worker", subtaskId: "st_1" });
  const reviewerGw = scope.bindGateway(mockGw, { role: "reviewer" });

  await workerGw.invoke([], {});
  await reviewerGw.invoke([], {});

  assert.deepEqual(recorded, ["worker", "reviewer"]);
  assert.equal(budget.snapshot().by_role.worker.calls, 1);
  assert.equal(budget.snapshot().by_role.reviewer.calls, 1);
});

test("B18: replan calls pass role: 'replan' into model gateway and budget tracks it", async () => {
  const budget = createRequestBudget({ maxModelCalls: 10 });
  const scope = createRequestScope({ budget });

  const planner = createPlanner({
    callModel: async (prompt, opts) => {
      assert.equal(opts.role, "replan", "opts.role is replan");
      const ticket = opts.scope.budget.reserveCall({ role: opts.role });
      ticket.markStarted();
      ticket.settle({ usage: { total_tokens: 25 } });
      return JSON.stringify({ done: true, subtasks: [] });
    }
  });

  const res = await planner.replan({
    message: "corrective step",
    collected: [{ st: { id: "s1" }, status: "failed" }],
    round: 2,
    scope,
    signal: scope.signal
  });

  assert.equal(res.done, true);
  assert.equal(budget.snapshot().by_role.replan.calls, 1);
  assert.equal(budget.snapshot().by_role.replan.tokens, 25);
});
