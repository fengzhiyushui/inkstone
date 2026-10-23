import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { createKernel } from "../../src/index.js";
import { createRequestBudget, createRequestScope } from "../../src/core/runtime/request-budget.js";
import { createWorkerFactory } from "../../src/core/orchestration/worker-factory.js";
import { orchestrationResumeGate } from "../../src/core/orchestration/orchestration-recovery-contract.js";
import { mkdtemp } from "../helpers/tmp.js";

async function tmpRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "failing-repro-"));
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "failing-repro" }) + "\n");
  return root;
}

function jsonResponse(content, usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }) {
  return {
    ok: true,
    status: 200,
    headers: new Map(),
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

function createDeferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// 1. 默认入口漏记 router (F01)
test("REPRO 1 (F01): default entry without custom scope must meter router within same budget and executionId", async () => {
  const root = await tmpRoot();
  const stages = [];
  const kernel = await createKernel(root, {
    sessionLog: null,
    branchStore: null,
    verifyMode: "off",
    orchestration: {
      budget: { maxModelCalls: 1, maxTokens: null } // Only 1 call allowed in total!
    },
    deepseek: {
      apiKey: "test-key",
      fetchImpl: async (url, init) => {
        const bodyStr = init.body;
        if (bodyStr.includes("Classify this coding request")) {
          stages.push("router");
          return jsonResponse({ lane: "orchestrate", reason: "multi-file" });
        }
        if (bodyStr.includes("Break the user's request")) {
          stages.push("planner");
          return jsonResponse({ task_summary: "t", done_when: "d", subtasks: [] });
        }
        stages.push("other");
        return jsonResponse("done");
      }
    }
  });

  // Call send WITHOUT passing scope (pure product default entry)
  const res = await kernel.agent.send("请处理这些校验逻辑", { autonomy: "auto" });
  // Since maxModelCalls = 1, router used call 1, planner must NOT have executed!
  assert.equal(stages.length, 1, "strictly 1 outbound fetch call was made before budget exhausted");
  assert.deepEqual(stages, ["router"]);
  assert.equal(res.outcome, "incomplete", "stopped by budget cap");
  await kernel.dispose();
});

// 2. 旧 signal 误取消新回合 (F04-a)
test("REPRO 2 (F04-a): aborting old turn's signal after it completes must not abort new turn", async () => {
  const root = await tmpRoot();
  const fetchBStarted = createDeferred();
  const deferredB = createDeferred();
  let fetchCount = 0;

  const kernel = await createKernel(root, {
    sessionLog: null,
    branchStore: null,
    verifyMode: "off",
    deepseek: {
      apiKey: "test-key",
      fetchImpl: async (url, init) => {
        fetchCount++;
        if (fetchCount === 1) {
          return jsonResponse("reply A");
        }
        // Turn B has started fetch
        fetchBStarted.resolve();
        return new Promise((resolve, reject) => {
          if (init?.signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          }, { once: true });
          deferredB.promise.then(() => resolve(jsonResponse("reply B")));
        });
      }
    }
  });

  const controllerA = new AbortController();
  // Turn A runs with controllerA and completes
  const resA = await kernel.runtime.send("edit file a.js to add hello", { signal: controllerA.signal, autonomy: "auto" });
  assert.equal(resA.status, "complete");

  // Turn B starts
  const promiseB = kernel.runtime.send("edit file a.js to add world", { autonomy: "auto" });
  await fetchBStarted.promise;

  // Now abort controller A (old turn's signal)
  controllerA.abort("turn A cancelled late");

  // Release Turn B's fetch
  deferredB.resolve();

  // Turn B should complete normally, NOT be aborted!
  const resB = await promiseB;
  assert.equal(resB.status, "complete");

  await kernel.dispose();
});

// 3. 工具 signal 未继承 (F04-b)
test("REPRO 3 (F04-b): orchestration scope cancellation must propagate into running tool context signal via AgentRuntime", async () => {
  const root = await tmpRoot();
  const scope = createRequestScope({ budget: createRequestBudget({ maxModelCalls: 10 }) });
  let toolSignalAborted = false;
  const toolStarted = createDeferred();
  const toolDeferred = createDeferred();

  const mockTool = {
    name: "test_tool",
    description: "test",
    parameters: { type: "object", properties: {} },
    execute: async (args, context) => {
      toolStarted.resolve();
      if (context.signal) {
        if (context.signal.aborted) toolSignalAborted = true;
        context.signal.addEventListener("abort", () => {
          toolSignalAborted = true;
        });
      }
      await toolDeferred.promise;
      return "tool done";
    }
  };

  const kernel = await createKernel(root, {
    sessionLog: null,
    branchStore: null,
    verifyMode: "off",
    tools: [mockTool],
    deepseek: {
      apiKey: "test-key",
      fetchImpl: async () => {
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
                  id: "tc_1",
                  type: "function",
                  function: { name: "test_tool", arguments: "{}" }
                }]
              }
            }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
          }),
          text: async () => ""
        };
      }
    }
  });

  const workerFactory = createWorkerFactory({
    createRuntime: (overrides) => kernel.createRuntime({
      ...overrides,
      executeTool: async (toolCall, policyContext) => {
        return mockTool.execute(toolCall.function?.arguments, policyContext);
      }
    }),
    baseToolSchemas: () => [{ type: "function", function: { name: "test_tool" } }],
    makeContextSnapshot: () => ({}),
    modelGateway: kernel.modelGateway,
    scope
  });

  const worker = workerFactory.worker({ id: "st1", goal: "g", tool_profile: "all" });
  const sendPromise = worker.send("do work");

  await toolStarted.promise;
  scope.abort("tool interrupted by orchestration scope");
  toolDeferred.resolve();

  await assert.rejects(async () => {
    await sendPromise;
  }, (err) => err.name === "InterruptedError" || err.name === "AbortError" || err.code === "ABORT");

  assert.equal(toolSignalAborted, true, "running tool context.signal was aborted when scope aborted");

  await kernel.dispose();
});

// 4. resumeDurable 无活跃登记 (F04-c)
test("REPRO 4 (F04-c): interrupt() during resumeDurable must abort the running recovery scope", async () => {
  const root = await tmpRoot();
  await fs.writeFile(path.join(root, "a.js"), "base a\n");

  const kA = await createKernel(root, {
    sessionLog: null,
    branchStore: null,
    verifyMode: "off",
    projectId: "proj_c",
    sessionId: "sess_cA",
    recovery: { enabled: true, lock: false, surface: "cli" },
    deepseek: {
      apiKey: "test-key",
      fetchImpl: async (url, init) => {
        const bodyStr = init.body;
        if (bodyStr.includes("Break the user's request")) {
          return jsonResponse({
            task_summary: "s", done_when: "d",
            subtasks: [{ id: "st_1", goal: "edit a", acceptance: [], context_scope: { files: ["a.js"] }, tool_profile: "edit", depends_on: [] }]
          });
        }
        if (bodyStr.includes("INDEPENDENT reviewer")) {
          return jsonResponse({ pass: true, severity: "warn", reasons: [], checked: ["read"] });
        }
        return {
          ok: true,
          status: 200,
          headers: new Map(),
          json: async () => ({
            choices: [{
              finish_reason: "tool_calls",
              message: {
                role: "assistant", content: "",
                tool_calls: [{ id: "t1", type: "function", function: { name: "diff_apply", arguments: JSON.stringify({ diff: "--- a/a.js\n+++ b/a.js\n@@ -1,1 +1,1 @@\n-base a\n+edited a\n" }) } }]
              }
            }],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
          }),
          text: async () => ""
        };
      }
    }
  });

  const p = await kA.agent.send("逐一处理 a.js 的输入校验", { autonomy: "supervised" });
  assert.equal(p.status, "awaiting_approval");
  await kA.dispose();

  // Kernel B recovers
  const resumeFetchStarted = createDeferred();
  const deferredResumeFetch = createDeferred();
  const kB = await createKernel(root, {
    sessionLog: null,
    branchStore: null,
    verifyMode: "off",
    projectId: "proj_c",
    sessionId: "sess_cB",
    recovery: { enabled: true, lock: false, surface: "cli" },
    deepseek: {
      apiKey: "test-key",
      fetchImpl: async (url, init) => {
        resumeFetchStarted.resolve();
        // Wait on deferred until interrupted
        return new Promise((resolve, reject) => {
          if (init?.signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          }, { once: true });
          deferredResumeFetch.promise.then(() => resolve(jsonResponse("done")));
        });
      }
    }
  });

  const report = await kB.recovery.report();
  const resumePromise = kB.recovery.resume(`rec_orch_${p.approval.id}`, { decision: "approve" });

  // Wait until resume fetch is in-flight, then interrupt
  await resumeFetchStarted.promise;
  kB.agent.interrupt();
  deferredResumeFetch.resolve();

  await assert.rejects(async () => {
    await resumePromise;
  }, (err) => err.name === "AbortError" || err.name === "InterruptedError" || /interrupted|aborted/i.test(err.message));

  await kB.dispose();
});

// 5. 旧首任务暂停错误迁移 (F06)
test("REPRO 5 (F06): legacy v1.17 sidecar with finite quota must be safely blocked when budget is unmetered", () => {
  const legacySidecar = {
    schemaVersion: 1,
    fingerprints: { workerFactory: 1, toolSubset: 1, subtaskSchema: 1 },
    approvalId: "ap_legacy_1",
    taskId: "task_leg_1",
    sessionId: "sess_leg_1",
    message: "legacy task",
    done_when: "done",
    plan: { subtasks: [{ id: "st_1", goal: "first", tool_profile: "edit" }] },
    round: 1,
    pausedSubtask: { id: "st_1" },
    remaining: [],
    seenSubtaskIds: ["st_1"],
    seenFp: ["fp_1"],
    allCollected: [], // First subtask paused: allCollected is EMPTY!
    budget: {
      quotaTokens: 1000,
      quotaCalls: 3, // Finite quota: 3 calls!
      spentTokens: 0,
      spentCalls: 0
      // Missing settledAttempts & unknownUsageAttempts
    }
  };

  const workerRecord = {
    approval_id: "ap_legacy_1",
    resume_state: {
      options: {
        __orchestration: { taskId: "task_leg_1", sessionId: "sess_leg_1", subtaskId: "st_1" }
      }
    }
  };

  // Must be blocked because history is unmetered and cannot safely verify remaining quota!
  const gate = orchestrationResumeGate({ sidecar: legacySidecar, workerRecord });
  assert.equal(gate.ok, false, "must fail closed for legacy unmetered budget with finite quota");
  assert.match(gate.reason, /legacy|unmetered/i);
});
