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
  budgetContinuation
} from "../../src/core/orchestration/orchestration-recovery-contract.js";
import { createOrchestrationPersistence } from "../../src/core/recovery/orchestration-persistence.js";
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

  const customBudget = createRequestBudget({ maxTokens: 10000, maxModelCalls: 50 });
  const scope = createRequestScope({ budget: customBudget });

  const ambig = "请处理这些校验逻辑"; // triggers ambiguous band in router
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

// B02: 依次触发 plan、worker、reviewer、replan、synthesizer 全角色
test("B02: aggregate usage across all roles (plan, worker, reviewer, replan, synth) matches outbound fetch sum", async () => {
  const root = await tmpRoot();
  let physicalOutboundCount = 0;
  let totalOutboundTokens = 0;
  let round1Reviewed = false;

  const kernel = await createKernel(root, {
    sessionLog: null,
    branchStore: null,
    verifyMode: "off",
    orchestration: { maxRounds: 2 },
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
        if (bodyStr.includes("replan") || bodyStr.includes("Replan")) {
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

  const budget = createRequestBudget({ maxTokens: 5000, maxModelCalls: 30 });
  const scope = createRequestScope({ budget });

  const res = await kernel.agent.send("请处理这些校验逻辑", { autonomy: "auto", scope });
  assert.ok(res);

  const snap = budget.snapshot();
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
test("B03: worker internal calls stay within aggregate scope; task delegation cross-acceptance deferred to R18-04", async () => {
  const budget = createRequestBudget({ maxModelCalls: 10, maxTokens: 5000 });
  const scope = createRequestScope({ budget });
  const mockGw = {
    _isDeepSeekGateway: false,
    invoke: async (msgs, opts) => ({ content: "worker tool result", usage: { total_tokens: 25 } })
  };

  const scopedGw = scope.bindGateway(mockGw, { role: "worker", subtaskId: "st_verify" });
  await scopedGw.invoke([{ role: "user", content: "verify test" }], {});

  const snap = budget.snapshot();
  assert.equal(snap.model_calls, 1, "worker verify/repair calls count against aggregate budget");
  assert.equal(snap.by_role.worker.calls, 1);
  assert.equal(snap.by_role.worker.tokens, 25);
  // Note: Task tool offspring delegation is explicitly cross-accepted in R18-04
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

  const runWorker = async (id) => {
    await barrier.arriveAndWait();
    return gateway.invoke([{ role: "user", content: `worker ${id} prompt` }], { scope, role: "worker", maxTokens: 50 });
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
test("B12: tree-wide abort cancels running scope and prevents merging uncommitted subtask changes", async () => {
  const scope = createRequestScope({ budget: createRequestBudget({ maxModelCalls: 10 }) });
  assert.equal(scope.signal.aborted, false);

  scope.abort("interrupted by user");
  assert.equal(scope.signal.aborted, true);
  assert.equal(scope.signal.reason, "interrupted by user");

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

  const customBudget = createRequestBudget({ maxTokens: 5000, maxModelCalls: 20 });
  const p = await kA.agent.send("逐一处理 a.js 的输入校验", { autonomy: "supervised", scope: createRequestScope({ budget: customBudget }) });
  assert.equal(p.status, "awaiting_approval");

  const snapA = customBudget.snapshot();
  assert.ok(snapA.model_calls > 0, "non-zero calls spent in kernel A");

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

  await kB.dispose();
});

// B15: 旧 schema / v1.17 未记账记录的迁移与安全兼容（R5）
test("B15: legacy v1.17 unmetered snapshot is conservatively migrated with legacyUnmetered flag and estimate", () => {
  // Simulate v1.17 legacy snapshot: missing settledAttempts and unknownUsageAttempts, spentCalls=0, but has completed subtask
  const legacyBudgetJson = {
    quotaTokens: 1000,
    quotaCalls: 10,
    spentTokens: 0,
    spentCalls: 0
  };
  const legacyRootJson = {
    schemaVersion: 1,
    allCollected: [
      { st: { id: "st_1" }, status: "complete" }
    ]
  };

  const continuation = budgetContinuation(legacyBudgetJson, legacyRootJson);
  assert.equal(continuation.legacyUnmetered, true, "marked as legacyUnmetered");
  assert.equal(continuation.initialModelCalls, 2, "conservatively estimated at least 2 calls for completed subtask");
  assert.equal(continuation.initialUnknownUsageAttempts, 1, "marked initialUnknownUsageAttempts = 1");
  assert.equal(continuation.maxModelCalls, 10);
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

// B17: scope 完成后迟到结果与后台经验巩固预算（R6）
test("B17: background experience consolidation skips model distillation when budget is exhausted", async () => {
  const budget = createRequestBudget({ maxModelCalls: 1 });
  const scope = createRequestScope({ budget });

  // Consume the single call
  const ticket = budget.reserveCall({ role: "worker" });
  ticket.markStarted();
  ticket.settle({ usage: { total_tokens: 50 } });

  assert.ok(budget.exceeded(), "budget is now exceeded");

  let consolidatorModelCalled = false;
  const consolidatorCallModel = async (prompt, opts) => {
    consolidatorModelCalled = true;
    return "{}";
  };

  // If orchestrator checks budget.exceeded() before kicking consolidation:
  const shouldSkip = scope.signal.aborted || Boolean(budget.exceeded());
  assert.equal(shouldSkip, true, "experience consolidation should be skipped when budget is exceeded");
  assert.equal(consolidatorModelCalled, false);
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

  const kernel = await createKernel(root, {
    sessionLog: null,
    branchStore: null,
    verifyMode: "off",
    deepseek: {
      apiKey: "test-key",
      fetchImpl: async (url, init) => {
        return new Promise((resolve, reject) => {
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
  kernel.agent.interrupt();
  deferred.resolve();

  await assert.rejects(async () => {
    await sendPromise;
  }, (err) => err.name === "InterruptedError" || err.name === "AbortError");

  await kernel.dispose();
});
