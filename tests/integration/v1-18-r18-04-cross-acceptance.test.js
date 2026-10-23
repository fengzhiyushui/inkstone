import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { mkdtemp } from "../helpers/tmp.js";
import { createKernel } from "../../src/index.js";
import { createRequestBudget, createRequestScope } from "../../src/core/runtime/request-budget.js";
import { createEventBus } from "../../src/shared/event-bus.js";
import { createEditService } from "../../src/edits/edit-service.js";
import { createBuiltinTools } from "../../src/tools/builtin/index.js";
import { createToolRegistry } from "../../src/tools/registry.js";

async function withTempProject(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-r18-04-"));
  try {
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "r18-04-cross" }) + "\n", "utf8");
    await writeFile(path.join(root, "config.txt"), "INITIAL_CONFIG=v1\n", "utf8");
    await writeFile(path.join(root, "app.js"), "export const version = 'old';\n", "utf8");
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
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

// ============================================================================
// Chain A: router -> planner -> worker -> reviewer -> replan -> budget exhausted -> deterministic synthesis
// ============================================================================
test("R18-04 Chain A: router -> planner -> worker -> reviewer -> replan -> budget exhausted -> deterministic synthesis", async () => {
  await withTempProject(async (root) => {
    let outboundFetchCalls = 0;
    const observedRoles = [];

    const kernel = await createKernel(root, {
      sessionLog: null,
      branchStore: null,
      verifyMode: "off",
      orchestration: {
        maxRounds: 2,
        maxWorkerAttempts: 1,
        // Exactly 6 calls allowed:
        // 1: router (ambiguous band)
        // 2: planner (round 1 plan)
        // 3: worker (subtask 1 execution)
        // 4: reviewer (fails subtask 1)
        // 5: round-1 partial synthesizer
        // 6: replan (round 2 corrective plan) -> budget hits 6/6 -> round 2 worker is blocked and final synthesis falls back to deterministic summary
        budget: { maxModelCalls: 6, maxTokens: 5000 }
      },
      deepseek: {
        apiKey: "test-key",
        fetchImpl: async (_url, init) => {
          outboundFetchCalls += 1;
          const bodyStr = String(init?.body || "");
          if (bodyStr.includes("Classify this coding request")) {
            observedRoles.push("router");
            return jsonResponse({ lane: "orchestrate", reason: "multi-step" }, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
          }
          if (bodyStr.includes("Break the user's request")) {
            observedRoles.push("planner");
            return jsonResponse({
              task_summary: "initial plan",
              done_when: "done",
              subtasks: [
                { id: "st_1", goal: "inspect config", acceptance: ["ok"], context_scope: { files: [] }, tool_profile: "readonly", depends_on: [] }
              ]
            }, { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 });
          }
          if (bodyStr.includes("INDEPENDENT reviewer")) {
            observedRoles.push("reviewer");
            return jsonResponse({ pass: false, severity: "block", reasons: ["incomplete check"], checked: ["config.txt"] }, { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 });
          }
          if (bodyStr.includes("revising a multi-agent plan") || bodyStr.includes("replan")) {
            observedRoles.push("replan");
            return jsonResponse({
              done: false,
              task_summary: "corrective plan",
              done_when: "done",
              subtasks: [
                { id: "st_2", goal: "re-inspect config", acceptance: ["ok"], context_scope: { files: [] }, tool_profile: "readonly", depends_on: [] }
              ]
            }, { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 });
          }
          if (bodyStr.includes("Synthesize a final answer")) {
            observedRoles.push("synthesizer");
            return jsonResponse("Unexpected LLM synthesis", { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
          }
          observedRoles.push("worker");
          return jsonResponse("Worker completed subtask 1", { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 });
        }
      }
    });

    try {
      const res = await kernel.agent.send("请处理这些校验逻辑", { autonomy: "auto" });
      assert.equal(outboundFetchCalls, 6, "physical outbound HTTP calls must stop at maxModelCalls=6");
      assert.deepEqual(observedRoles, ["router", "planner", "worker", "reviewer", "synthesizer", "replan"]);
      assert.match(res.content, /Completed 0\/2 sub-tasks/, "final synthesis falls back to deterministic summary when budget is exhausted");
      assert.ok(res.budget, "orchestration result includes aggregate budget snapshot");
      assert.equal(res.budget.model_calls, 6);
      assert.equal(res.budget.tokens, 130);
      assert.equal(res.budget.by_role.router.calls, 1);
      assert.equal(res.budget.by_role.planner.calls, 1);
      assert.equal(res.budget.by_role.worker.calls, 1);
      assert.equal(res.budget.by_role.reviewer.calls, 1);
      assert.equal(res.budget.by_role.replan.calls, 1);
      assert.equal(res.budget.by_role.synthesizer.calls, 1, "final LLM synthesizer skipped after replan exhausted budget");
    } finally {
      await kernel.dispose();
    }
  });
});

// ============================================================================
// Chain B: parent runtime -> task child worker -> child write approval -> repair syntax retry -> result feedback -> shared aggregate budget
// ============================================================================
test("R18-04 Chain B: parent runtime -> task child worker -> approval -> verification failure -> repair syntax retry -> shared aggregate budget & single writes", async () => {
  await withTempProject(async (root) => {
    const childDiff = [
      "--- a/config.txt",
      "+++ b/config.txt",
      "@@ -1,1 +1,2 @@",
      " INITIAL_CONFIG=v1",
      "+CHILD_UPDATED=true"
    ].join("\n");
    const parentInitialDiff = [
      "--- a/app.js",
      "+++ b/app.js",
      "@@ -1,1 +1,1 @@",
      "-export const version = 'old';",
      "+export const version = 'broken';"
    ].join("\n");
    const parentRepairDiff = [
      "--- a/app.js",
      "+++ b/app.js",
      "@@ -1,1 +1,1 @@",
      "-export const version = 'broken';",
      "+export const version = '1.18.0';"
    ].join("\n");

    let testRuns = 0;
    const fakeTestTool = {
      name: "test",
      description: "Fake verifier test tool",
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
        testRuns += 1;
        const appContent = await readFile(path.join(root, "app.js"), "utf8");
        const ok = appContent.includes("1.18.0");
        return {
          status: "success",
          content: [{ type: "text", text: ok ? "tests passed" : "tests failed: version is broken" }],
          metadata: { exit_code: ok ? 0 : 1, run: testRuns }
        };
      }
    };

    const budget = createRequestBudget({ maxModelCalls: 15, maxTokens: 5000 });
    const scope = createRequestScope({ budget });

    let parentMainCalls = 0;
    let childCalls = 0;
    let repairCalls = 0;

    const gateway = {
      _isDeepSeekGateway: false,
      async invoke(messages, opts = {}) {
        const isChild = messages.some((m) => typeof m.content === "string" && m.content.includes("[CHAIN_B_CHILD]"));
        if (isChild) {
          childCalls += 1;
          if (childCalls === 1) {
            return {
              content: "Child updating config.txt",
              tool_calls: [{ id: "cb_child_edit", name: "edit", arguments: { diff: childDiff, prompt: "update config" } }],
              usage: { total_tokens: 20 }
            };
          }
          return {
            content: "Child finished updating config.txt",
            tool_calls: [],
            usage: { total_tokens: 10 }
          };
        }

        if (opts.purpose === "repair") {
          repairCalls += 1;
          if (repairCalls === 1) {
            // Malformed tool-call arguments on first repair model call -> triggers R18-03 bounded syntax retry!
            return {
              content: "Attempting repair with malformed JSON",
              tool_calls: [
                {
                  id: "cb_repair_bad",
                  name: "edit",
                  arguments: null,
                  arguments_parse_error: "Unexpected end of JSON input"
                }
              ],
              usage: { total_tokens: 15 }
            };
          }
          if (repairCalls === 2) {
            return {
              content: "Repairing app.js with valid diff",
              tool_calls: [
                {
                  id: "cb_repair_good",
                  name: "edit",
                  arguments: { diff: parentRepairDiff, prompt: "fix version to 1.18.0" }
                }
              ],
              usage: { total_tokens: 25 }
            };
          }
          return {
            content: "Repair finished",
            tool_calls: [],
            usage: { total_tokens: 10 }
          };
        }

        parentMainCalls += 1;
        if (parentMainCalls === 1) {
          return {
            content: "Delegating config update to task child, then updating app.js",
            tool_calls: [
              {
                id: "cb_parent_task",
                name: "task",
                arguments: {
                  prompt: "[CHAIN_B_CHILD] Update config.txt",
                  tools: ["edit"]
                }
              },
              {
                id: "cb_parent_edit",
                name: "edit",
                arguments: {
                  diff: parentInitialDiff,
                  prompt: "initial edit to app.js"
                }
              }
            ],
            usage: { total_tokens: 30 }
          };
        }
        return {
          content: "Parent main loop complete, proceeding to verification",
          tool_calls: [],
          usage: { total_tokens: 15 }
        };
      }
    };

    const eventBus = createEventBus();
    const editService = createEditService({ projectRoot: root, eventBus });
    const builtins = createBuiltinTools({ editService }).filter((t) => t.name !== "test");
    const toolRegistry = createToolRegistry({ tools: [...builtins, fakeTestTool] });

    const kernel = await createKernel(root, {
      eventBus,
      editService,
      toolRegistry,
      sessionLog: null,
      branchStore: null,
      verifyMode: "run",
      maxRepairAttempts: 1,
      limits: { maxToolCallRepairs: 1 },
      modelGateway: gateway,
      projectRules: [{ id: "allow-task", tool: "task", decision: "allow" }]
    });

    try {
      const scopedGw = scope.bindGateway(gateway, { role: "worker", subtaskId: "chain_b_main" });
      // Step 1: Send under supervised autonomy, but allow app.js edit so only child config.txt edit pauses
      const paused = await kernel.runtime.send("Update config via task and update app.js", {
        autonomy: "supervised",
        verifyMode: "run",
        maxToolCallRepairs: 1,
        modelGateway: scopedGw,
        scope,
        signal: scope.signal,
        projectRules: [
          { id: "allow-task", tool: "task", decision: "allow" }
        ]
      });

      assert.equal(paused.status, "awaiting_approval");
      assert.match(paused.approval.summary, /^edit requires approval/);
      // Neither file should be modified before approval
      assert.equal(await readFile(path.join(root, "config.txt"), "utf8"), "INITIAL_CONFIG=v1\n");
      assert.equal(await readFile(path.join(root, "app.js"), "utf8"), "export const version = 'old';\n");

      // Step 2: Approve child's config.txt edit -> child completes -> parent remaining tool 'cb_parent_edit' pauses for approval!
      const pausedParentEdit = await kernel.runtime.approve(paused.approval.id, "approve");
      assert.equal(pausedParentEdit.status, "awaiting_approval");
      assert.equal(await readFile(path.join(root, "config.txt"), "utf8"), "INITIAL_CONFIG=v1\nCHILD_UPDATED=true\n");
      assert.equal(await readFile(path.join(root, "app.js"), "utf8"), "export const version = 'old';\n");

      // Step 3: Approve parent's cb_parent_edit -> verification fails -> enters repair -> repair syntax error retry -> repair edit pauses for approval!
      const pausedRepairEdit = await kernel.runtime.approve(pausedParentEdit.approval.id, "approve");
      assert.equal(pausedRepairEdit.status, "awaiting_approval");
      assert.equal(repairCalls, 2, "repair syntax retry ran within the same repair attempt");
      assert.equal(await readFile(path.join(root, "app.js"), "utf8"), "export const version = 'broken';\n");

      // Step 4: Approve repair edit -> verification passes -> turn completes!
      const finalRes = await kernel.runtime.approve(pausedRepairEdit.approval.id, "approve");
      assert.equal(finalRes.status, "complete");
      assert.equal(finalRes.verification.status, "passed");
      assert.equal(finalRes.repair.status, "complete");
      assert.equal(finalRes.repair.attempts, 1, "syntax retry did not consume a second verification repair attempt");
      assert.equal(finalRes.repair.tool_call_repairs, 1, "one syntax retry recorded");

      // Verify files written once per step
      assert.equal(await readFile(path.join(root, "config.txt"), "utf8"), "INITIAL_CONFIG=v1\nCHILD_UPDATED=true\n");
      assert.equal(await readFile(path.join(root, "app.js"), "utf8"), "export const version = '1.18.0';\n");

      // Verify shared RequestBudget accounting across parent worker, child task, and repair syntax retry
      const snap = budget.snapshot();
      // Calls: parent (2) + child task (2) + repair (3: 1 malformed + 1 valid + 1 post-tool final) = 7
      assert.equal(snap.model_calls, 7);
      assert.equal(snap.tokens, 30 + 15 + 20 + 10 + 15 + 25 + 10);
      assert.deepEqual(snap.by_role.task, { calls: 2, tokens: 30 });
      assert.deepEqual(snap.by_role.worker, { calls: 5, tokens: 95 });
    } finally {
      await kernel.dispose();
    }
  });
});

// ============================================================================
// Chain C: concurrent quota contention + isolated request cancellation + durable recovery across restart
// ============================================================================
test("R18-04 Chain C: concurrent quota contention, isolated request cancellation, and durable recovery across restart", async () => {
  await withTempProject(async (root) => {
    // Part 1: Concurrent quota contention on a shared RequestBudget (maxModelCalls: 1)
    const sharedBudget = createRequestBudget({ maxModelCalls: 1, maxTokens: 5000 });
    const scopeA = createRequestScope({ budget: sharedBudget });
    const scopeB = createRequestScope({ budget: createRequestBudget({ maxModelCalls: 5, maxTokens: 5000 }) });

    let rawInvokeCalls = 0;
    const rawGw = {
      async invoke() {
        rawInvokeCalls += 1;
        await new Promise((r) => setTimeout(r, 15));
        return { content: "ok", tool_calls: [], usage: { total_tokens: 10 } };
      }
    };

    const gwA1 = scopeA.bindGateway(rawGw, { role: "worker", subtaskId: "w1" });
    const gwA2 = scopeA.bindGateway(rawGw, { role: "worker", subtaskId: "w2" });
    const settled = await Promise.allSettled([gwA1.invoke([]), gwA2.invoke([])]);
    const fulfilled = settled.filter((s) => s.status === "fulfilled");
    const rejected = settled.filter((s) => s.status === "rejected");
    assert.equal(fulfilled.length, 1, "only one concurrent worker wins the single model call slot");
    assert.equal(rejected.length, 1, "second concurrent worker is deterministically rejected");
    assert.equal(rejected[0].reason?.code, "BUDGET_EXCEEDED");
    assert.equal(rawInvokeCalls, 1, "underlying model gateway invoked at most once");

    // Part 2: Isolated request cancellation (cancelling scopeA does not abort scopeB)
    scopeA.abort("request_a_cancelled");
    assert.equal(scopeA.signal.aborted, true);
    assert.equal(scopeB.signal.aborted, false);
    const gwB = scopeB.bindGateway(rawGw, { role: "worker", subtaskId: "b1" });
    const resB = await gwB.invoke([]);
    assert.equal(resB.content, "ok");

    // Part 3: Durable recovery across process restart preserves non-zero budget_spent & task child pause
    const childEditDiff = [
      "--- a/config.txt",
      "+++ b/config.txt",
      "@@ -1,1 +1,2 @@",
      " INITIAL_CONFIG=v1",
      "+RECOVERED_CHILD=true"
    ].join("\n");

    let childTurnStep = 0;
    const recoveryGateway = {
      _isDeepSeekGateway: false,
      async invoke(messages) {
        const isChild = messages.some((m) => typeof m.content === "string" && m.content.includes("[CHAIN_C_CHILD]"));
        if (isChild) {
          childTurnStep += 1;
          if (childTurnStep === 1) {
            return {
              content: "Child proposing config edit",
              tool_calls: [{ id: "cc_child_edit", name: "edit", arguments: { diff: childEditDiff, prompt: "edit config" } }],
              usage: { total_tokens: 40 }
            };
          }
          return {
            content: "Child completed after recovery",
            tool_calls: [],
            usage: { total_tokens: 20 }
          };
        }
        const hasTaskResult = messages.some((m) => m.role === "tool" && m.tool_call_id === "cc_parent_task");
        if (!hasTaskResult) {
          return {
            content: "Parent delegating to child",
            tool_calls: [{ id: "cc_parent_task", name: "task", arguments: { prompt: "[CHAIN_C_CHILD] Edit config.txt", tools: ["edit"] } }],
            usage: { total_tokens: 50 }
          };
        }
        return {
          content: "Parent completed after restart",
          tool_calls: [],
          usage: { total_tokens: 30 }
        };
      }
    };

    const kernel1 = await createKernel(root, {
      sessionLog: null,
      branchStore: null,
      verifyMode: "off",
      recovery: { enabled: true },
      modelGateway: recoveryGateway,
      projectRules: [{ id: "allow-task", tool: "task", decision: "allow" }]
    });

    let approvalId = null;
    try {
      const paused = await kernel1.runtime.send("Delegate config edit and recover across restart", {
        autonomy: "supervised",
        maxModelCalls: 4,
        maxTurnTokens: 200
      });
      assert.equal(paused.status, "awaiting_approval");
      approvalId = paused.approval.id;
    } finally {
      await kernel1.dispose();
    }

    // Boot second kernel instance (simulated process restart) and resume with tight remaining budget
    const kernel2 = await createKernel(root, {
      sessionLog: null,
      branchStore: null,
      verifyMode: "off",
      recovery: { enabled: true },
      modelGateway: recoveryGateway,
      projectRules: [{ id: "allow-task", tool: "task", decision: "allow" }]
    });

    try {
      const items = await kernel2.recovery.list();
      const pausedItem = items.find((item) => item.source_id === approvalId);
      const record = kernel2.runtime.listPaused().find((r) => r.approval_id === approvalId);
      assert.ok(pausedItem, "paused parent-child turn discovered by recovery service after restart");
      assert.ok(record, "paused record restored in runtime after restart");
      assert.equal(record.resume_state?.budget_spent?.model_calls, 2, "parent (1) + child (1) pre-pause model calls persisted");
      assert.equal(record.resume_state?.budget_spent?.tokens, 90, "parent (50) + child (40) pre-pause tokens persisted");

      const resumed = await kernel2.agent.approve(approvalId, "approve");
      assert.equal(resumed.status, "complete");
      assert.equal(await readFile(path.join(root, "config.txt"), "utf8"), "INITIAL_CONFIG=v1\nRECOVERED_CHILD=true\n");
    } finally {
      await kernel2.dispose();
    }
  });
});
