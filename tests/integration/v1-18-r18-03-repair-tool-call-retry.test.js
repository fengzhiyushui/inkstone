import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createKernel } from "../../src/index.js";
import { createEventBus } from "../../src/shared/event-bus.js";
import { createEditService } from "../../src/edits/edit-service.js";
import { createBuiltinTools } from "../../src/tools/builtin/index.js";
import { createToolRegistry } from "../../src/tools/registry.js";
import { createDeepSeekGateway } from "../../src/deepseek/model-gateway.js";
import { createRequestBudget, createRequestScope } from "../../src/core/runtime/request-budget.js";
import { mkdtemp } from "../helpers/tmp.js";

const BROKEN_DIFF = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+broken";
const REPAIR_DIFF = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-broken\n+fixed";
const SECOND_FILE_DIFF = "--- a/b.txt\n+++ b/b.txt\n@@ -1 +1 @@\n-start\n+updated";

function createRepairTestKernel(root, {
  modelGateway,
  testResults = [{ exit_code: 1, text: "failed" }, { exit_code: 0, text: "passed" }],
  sessionId = "sess_r18_03",
  maxRepairAttempts = 1,
  maxToolCallRepairs = 0,
  maxModelCalls = null,
  maxTurnTokens = null,
  modelTimeoutMs = null,
  extraTools = [],
  projectRules = []
} = {}) {
  const eventBus = createEventBus();
  let testRuns = 0;
  const editService = createEditService({ projectRoot: root, eventBus });
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
  const builtin = createBuiltinTools({ editService }).filter((tool) => tool.name !== "test");
  const toolRegistry = createToolRegistry({ tools: [...builtin, fakeTestTool, ...extraTools] });

  return createKernel(root, {
    eventBus,
    editService,
    toolRegistry,
    sessionRoot: path.join(root, ".sessions"),
    sessionId,
    verifyMode: "run",
    maxRepairAttempts,
    projectRules,
    recovery: { enabled: true, lock: false },
    limits: {
      maxToolCallRepairs,
      maxModelCalls,
      maxTurnTokens,
      modelTimeoutMs
    },
    modelGateway
  });
}

test("P01: default maxToolCallRepairs=0 preserves legacy repair behavior (throws immediately on malformed tool call, no extra model calls)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-r18-03-p01-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  let actCalls = 0;
  let repairCalls = 0;

  const kernel = await createRepairTestKernel(root, {
    maxToolCallRepairs: 0,
    modelGateway: {
      invoke: async (_messages, options = {}) => {
        if (options.purpose === "repair") {
          repairCalls += 1;
          return {
            content: "",
            tool_calls: [{ id: "bad_1", name: "edit", arguments: null, arguments_parse_error: "Unexpected token }" }]
          };
        }
        actCalls += 1;
        if (actCalls === 1) {
          return { content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: BROKEN_DIFF, prompt: "break a" } }] };
        }
        return { content: "done", tool_calls: [] };
      }
    }
  });

  await assert.rejects(
    () => kernel.agent.send("modify a.txt", { autonomy: "gated", verifyMode: "run" }),
    /invalid tool arguments/i
  );
  assert.equal(repairCalls, 1);
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "broken\n");
});

test("P02: first repair tool-call has bad JSON, second is valid with maxToolCallRepairs=1 -> 2 repair model calls, 1 write side effect", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-r18-03-p02-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  let actCalls = 0;
  let repairCalls = 0;
  const repairEvents = [];

  const kernel = await createRepairTestKernel(root, {
    maxToolCallRepairs: 1,
    modelGateway: {
      invoke: async (_messages, options = {}) => {
        if (options.purpose === "repair") {
          repairCalls += 1;
          if (repairCalls === 1) {
            return {
              content: "",
              tool_calls: [{ id: "bad_1", name: "edit", arguments: null, arguments_parse_error: "Unexpected end of JSON input", raw_arguments: "{\"diff\":" }]
            };
          }
          return {
            content: "applied fix",
            tool_calls: [{ id: "good_1", name: "edit", arguments: { diff: REPAIR_DIFF, prompt: "repair a" } }]
          };
        }
        actCalls += 1;
        if (actCalls === 1) {
          return { content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: BROKEN_DIFF, prompt: "break a" } }] };
        }
        return { content: "done", tool_calls: [] };
      }
    }
  });
  kernel.eventBus.subscribe("model:tool_call_repair", (ev) => {
    repairEvents.push(ev);
  });

  const result = await kernel.agent.send("modify a.txt", { autonomy: "gated", verifyMode: "run" });
  assert.equal(result.status, "complete");
  assert.equal(repairCalls, 2);
  assert.equal(result.repair.tool_call_repairs, 1);
  assert.equal(repairEvents.length, 1);
  assert.equal(repairEvents[0].attempt, 1);
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "fixed\n");
});

test("P03: continuous malformed tool calls exceeding N=2 stop after 1+N requests and leave file unchanged", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-r18-03-p03-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  let actCalls = 0;
  let repairCalls = 0;

  const kernel = await createRepairTestKernel(root, {
    maxToolCallRepairs: 2,
    modelGateway: {
      invoke: async (_messages, options = {}) => {
        if (options.purpose === "repair") {
          repairCalls += 1;
          return {
            content: "",
            tool_calls: [{ id: `bad_${repairCalls}`, name: "edit", arguments: null, arguments_parse_error: "Malformed JSON" }]
          };
        }
        actCalls += 1;
        if (actCalls === 1) {
          return { content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: BROKEN_DIFF, prompt: "break a" } }] };
        }
        return { content: "done", tool_calls: [] };
      }
    }
  });

  await assert.rejects(
    () => kernel.agent.send("modify a.txt", { autonomy: "gated", verifyMode: "run" }),
    /invalid tool arguments/i
  );
  assert.equal(repairCalls, 3); // 1 initial + 2 syntax repairs
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "broken\n");
});

test("P04: batch pre-validation rejects entire batch when item 1 is valid write and item 2 is malformed; item 1 is NOT executed before syntax repair", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-r18-03-p04-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  await writeFile(path.join(root, "b.txt"), "start\n");
  let actCalls = 0;
  let repairCalls = 0;
  let aContentDuringSecondRepairCall = null;

  const kernel = await createRepairTestKernel(root, {
    maxToolCallRepairs: 1,
    modelGateway: {
      invoke: async (_messages, options = {}) => {
        if (options.purpose === "repair") {
          repairCalls += 1;
          if (repairCalls === 1) {
            return {
              content: "",
              tool_calls: [
                { id: "c1", name: "edit", arguments: { diff: REPAIR_DIFF, prompt: "repair a" } },
                { id: "c2", name: "edit", arguments: null, arguments_parse_error: "Broken second call" }
              ]
            };
          }
          aContentDuringSecondRepairCall = await readFile(path.join(root, "a.txt"), "utf8");
          return {
            content: "fixed both",
            tool_calls: [
              { id: "c1_ok", name: "edit", arguments: { diff: REPAIR_DIFF, prompt: "repair a" } },
              { id: "c2_ok", name: "edit", arguments: { diff: SECOND_FILE_DIFF, prompt: "update b" } }
            ]
          };
        }
        actCalls += 1;
        if (actCalls === 1) {
          return { content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: BROKEN_DIFF, prompt: "break a" } }] };
        }
        return { content: "done", tool_calls: [] };
      }
    }
  });

  const result = await kernel.agent.send("modify a.txt and b.txt", { autonomy: "gated", verifyMode: "run" });
  assert.equal(result.status, "complete");
  // Item 1 was NOT executed during the failed first batch!
  assert.equal(aContentDuringSecondRepairCall, "broken\n");
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "fixed\n");
  assert.equal(await readFile(path.join(root, "b.txt"), "utf8"), "updated\n");
});

test("P05: when valid tool A succeeds and valid tool B fails at execution time, it does NOT enter syntax repair or re-run tool A", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-r18-03-p05-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  let actCalls = 0;
  let repairCalls = 0;
  let toolACalls = 0;

  const countingWriteTool = {
    name: "count_write",
    description: "Counts executions",
    category: "write",
    side_effect: "filesystem",
    risk_level: "low",
    source: "test",
    version: "1.0",
    params: { fail: { type: "boolean", required: false } },
    execute: async (params) => {
      if (params.fail) {
        return { status: "error", content: [{ type: "error", text: "disk full business error" }] };
      }
      toolACalls += 1;
      await writeFile(path.join(root, "a.txt"), `written_${toolACalls}\n`);
      return { status: "success", content: [{ type: "text", text: "ok" }] };
    }
  };

  const kernel = await createRepairTestKernel(root, {
    maxToolCallRepairs: 2,
    extraTools: [countingWriteTool],
    projectRules: [{ id: "allow_count_write", tool: "count_write", decision: "allow" }],
    modelGateway: {
      invoke: async (_messages, options = {}) => {
        if (options.purpose === "repair") {
          repairCalls += 1;
          return {
            content: "",
            tool_calls: [
              { id: "call_a", name: "count_write", arguments: { fail: false } },
              { id: "call_b", name: "count_write", arguments: { fail: true } }
            ]
          };
        }
        actCalls += 1;
        if (actCalls === 1) {
          return { content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: BROKEN_DIFF, prompt: "break a" } }] };
        }
        return { content: "done", tool_calls: [] };
      }
    }
  });

  const result = await kernel.agent.send("modify a.txt", { autonomy: "gated", verifyMode: "run" });
  assert.equal(result.status, "complete");
  assert.equal(repairCalls, 1);
  assert.equal(toolACalls, 1);
  assert.equal(result.repair.tool_call_repairs, 0);
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "written_1\n");
});

test("P06: repair tool A completes, tool B pauses for approval -> approve resumes from B without re-running A and preserves syntax repair count & budget", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-r18-03-p06-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  await writeFile(path.join(root, "b.txt"), "start\n");
  let actCalls = 0;
  let repairCalls = 0;
  let aExecutions = 0;
  let bExecutions = 0;

  const toolA = {
    name: "safe_step",
    description: "Allowed step A",
    category: "write",
    side_effect: "filesystem",
    risk_level: "low",
    source: "test",
    version: "1.0",
    params: {},
    execute: async () => {
      aExecutions += 1;
      await writeFile(path.join(root, "a.txt"), `fixed_${aExecutions}\n`);
      return { status: "success", content: [{ type: "text", text: "step A done" }] };
    }
  };
  const toolB = {
    name: "gated_step",
    description: "Gated step B requiring approval",
    category: "execute",
    side_effect: "process",
    risk_level: "high",
    source: "test",
    version: "1.0",
    params: {},
    execute: async () => {
      bExecutions += 1;
      await writeFile(path.join(root, "b.txt"), `b_${bExecutions}\n`);
      return { status: "success", content: [{ type: "text", text: "step B done" }] };
    }
  };

  const kernel = await createRepairTestKernel(root, {
    maxToolCallRepairs: 1,
    extraTools: [toolA, toolB],
    projectRules: [
      { id: "allow_safe_step", tool: "safe_step", decision: "allow" },
      { id: "ask_gated_step", tool: "gated_step", decision: "ask" }
    ],
    modelGateway: {
      invoke: async (_messages, options = {}) => {
        if (options.purpose === "repair") {
          repairCalls += 1;
          if (repairCalls === 1) {
            // Use up the 1 allowed syntax repair before pausing on toolB
            return {
              content: "",
              tool_calls: [{ id: "bad", name: "safe_step", arguments: null, arguments_parse_error: "bad json" }]
            };
          }
          if (repairCalls === 2) {
            return {
              content: "",
              tool_calls: [
                { id: "call_a", name: "safe_step", arguments: {} },
                { id: "call_b", name: "gated_step", arguments: {} }
              ]
            };
          }
          // Post-approval continuation in resumeExecutorLoop: if this returned malformed JSON,
          // it would fail because 1 syntax repair was already used! Return clean completion.
          return { content: "repair finished", tool_calls: [] };
        }
        actCalls += 1;
        if (actCalls === 1) {
          return { content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: BROKEN_DIFF, prompt: "break a" } }] };
        }
        return { content: "done", tool_calls: [] };
      }
    }
  });

  const paused = await kernel.agent.send("modify a.txt", { autonomy: "gated", verifyMode: "run" });
  assert.equal(paused.status, "awaiting_approval");
  assert.equal(aExecutions, 1);
  assert.equal(bExecutions, 0);

  const resumed = await kernel.agent.approve(paused.approval.id, "approve");
  assert.equal(resumed.status, "complete");
  assert.equal(aExecutions, 1); // A was NOT re-executed
  assert.equal(bExecutions, 1); // B executed once after approval
  assert.equal(resumed.repair.tool_call_repairs, 1);
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "fixed_1\n");
  assert.equal(await readFile(path.join(root, "b.txt"), "utf8"), "b_1\n");
});

test("P07: exhausting local or aggregate budget during syntax repair stops immediately without an extra free retry", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-r18-03-p07-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  let actCalls = 0;
  let repairCalls = 0;

  // 2 calls in act loop + 1 first repair call = 3 total calls -> hits maxModelCalls=3 before syntax retry!
  const kernel = await createRepairTestKernel(root, {
    maxToolCallRepairs: 3,
    maxModelCalls: 3,
    modelGateway: {
      invoke: async (_messages, options = {}) => {
        if (options.purpose === "repair") {
          repairCalls += 1;
          return {
            content: "",
            tool_calls: [{ id: "bad_repair", name: "edit", arguments: null, arguments_parse_error: "bad json" }],
            usage: { total_tokens: 10 }
          };
        }
        actCalls += 1;
        if (actCalls === 1) {
          return {
            content: "",
            tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: BROKEN_DIFF, prompt: "break a" } }],
            usage: { total_tokens: 10 }
          };
        }
        return { content: "done", tool_calls: [], usage: { total_tokens: 10 } };
      }
    }
  });

  const result = await kernel.agent.send("modify a.txt", { autonomy: "gated", verifyMode: "run" });
  assert.equal(result.status, "stopped");
  assert.equal(actCalls + repairCalls, 3);
  assert.equal(repairCalls, 1); // Did NOT get a free syntax retry after hitting maxModelCalls=3
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "broken\n");
});

test("P08: interrupt or timeout while awaiting syntax repair response aborts in-flight call and prevents tool execution", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-r18-03-p08-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  let actCalls = 0;
  let repairCalls = 0;
  let abortController = new AbortController();

  const kernel = await createRepairTestKernel(root, {
    maxToolCallRepairs: 2,
    modelGateway: {
      invoke: async (_messages, options = {}) => {
        if (options.purpose === "repair") {
          repairCalls += 1;
          if (repairCalls === 1) {
            return {
              content: "",
              tool_calls: [{ id: "bad", name: "edit", arguments: null, arguments_parse_error: "syntax err" }]
            };
          }
          // Abort while the 2nd (syntax repair) response is in flight, then return a valid tool call
          abortController.abort(new Error("user cancelled during syntax repair"));
          return {
            content: "",
            tool_calls: [{ id: "late_valid", name: "edit", arguments: { diff: REPAIR_DIFF, prompt: "late fix" } }]
          };
        }
        actCalls += 1;
        if (actCalls === 1) {
          return { content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: BROKEN_DIFF, prompt: "break a" } }] };
        }
        return { content: "done", tool_calls: [] };
      }
    }
  });

  await assert.rejects(
    () => kernel.agent.send("modify a.txt", { autonomy: "gated", verifyMode: "run", signal: abortController.signal }),
    /interrupted|cancelled|abort/i
  );
  assert.equal(repairCalls, 2);
  // Late valid tool call must NOT have executed!
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "broken\n");
});

test("P09: permission denial, unknown tool, and schema parameter errors do not trigger syntax repair retries", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-r18-03-p09-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  let actCalls = 0;
  let repairCalls = 0;
  const syntaxRepairEvents = [];

  const kernel = await createRepairTestKernel(root, {
    maxToolCallRepairs: 3,
    projectRules: [{ id: "deny_shell", tool: "shell", decision: "deny" }],
    modelGateway: {
      invoke: async (_messages, options = {}) => {
        if (options.purpose === "repair") {
          repairCalls += 1;
          return {
            content: "",
            tool_calls: [
              { id: "c_unknown", name: "nonexistent_tool", arguments: {} },
              { id: "c_schema", name: "edit", arguments: {} }, // missing required 'diff' param in normalizeParams
              { id: "c_denied", name: "shell", arguments: { argv: ["echo", "hi"] } }
            ]
          };
        }
        actCalls += 1;
        if (actCalls === 1) {
          return { content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: BROKEN_DIFF, prompt: "break a" } }] };
        }
        return { content: "done", tool_calls: [] };
      }
    }
  });
  kernel.eventBus.subscribe("model:tool_call_repair", (ev) => {
    syntaxRepairEvents.push(ev);
  });

  const result = await kernel.agent.send("modify a.txt", { autonomy: "gated", verifyMode: "run" });
  assert.equal(result.status, "complete");
  assert.equal(repairCalls, 1); // No syntax repair retry triggered
  assert.equal(syntaxRepairEvents.length, 0);
});

test("P10: second verification repair attempt encountering malformed output tracks both counters under aggregate RequestBudget", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-r18-03-p10-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  const STILL_BROKEN_DIFF = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-broken\n+still_broken";
  const FINAL_FIX_DIFF = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-still_broken\n+fixed";

  let actCalls = 0;
  let repairCalls = 0;
  const reqBudget = createRequestBudget({ maxTokens: 10000, maxModelCalls: 10, executionId: "exec_p10" });
  const scope = createRequestScope({ budget: reqBudget, executionId: "exec_p10" });

  const rawGateway = {
    invoke: async (_messages, options = {}) => {
      if (options.purpose === "repair") {
        repairCalls += 1;
        // Repair attempt 1: call 1 bad JSON, call 2 valid edit (still fails test)
        if (repairCalls === 1) {
          return { content: "", tool_calls: [{ id: "r1_bad", name: "edit", arguments: null, arguments_parse_error: "bad 1" }], usage: { total_tokens: 10 } };
        }
        if (repairCalls === 2) {
          return { content: "", tool_calls: [{ id: "r1_ok", name: "edit", arguments: { diff: STILL_BROKEN_DIFF, prompt: "try 1" } }], usage: { total_tokens: 10 } };
        }
        // Repair attempt 2: call 3 bad JSON, call 4 valid edit (passes test)
        if (repairCalls === 3) {
          return { content: "", tool_calls: [{ id: "r2_bad", name: "edit", arguments: null, arguments_parse_error: "bad 2" }], usage: { total_tokens: 10 } };
        }
        return { content: "", tool_calls: [{ id: "r2_ok", name: "edit", arguments: { diff: FINAL_FIX_DIFF, prompt: "try 2" } }], usage: { total_tokens: 10 } };
      }
      actCalls += 1;
      if (actCalls === 1) {
        return { content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: BROKEN_DIFF, prompt: "break a" } }], usage: { total_tokens: 10 } };
      }
      return { content: "done", tool_calls: [], usage: { total_tokens: 10 } };
    }
  };
  const boundGateway = scope.bindGateway(rawGateway, { role: "worker" });

  const kernel = await createRepairTestKernel(root, {
    maxRepairAttempts: 2,
    maxToolCallRepairs: 1,
    testResults: [
      { exit_code: 1, text: "initial fail" },
      { exit_code: 1, text: "attempt 1 fail" },
      { exit_code: 0, text: "attempt 2 pass" }
    ],
    modelGateway: boundGateway
  });

  const result = await kernel.agent.send("modify a.txt", { autonomy: "gated", verifyMode: "run", scope });
  assert.equal(result.status, "complete");
  assert.equal(result.repair.attempts, 2);
  assert.equal(result.repair.tool_call_repairs, 2); // 1 in attempt 1 + 1 in attempt 2
  assert.equal(reqBudget.snapshot().model_calls, 6); // 2 act + 4 repair
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "fixed\n");
});

test("P11: pause after syntax repair in repair loop -> cross-process recovery preserves normalized batch, completed results, and repair counts without re-running completed tool", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-r18-03-p11-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  await writeFile(path.join(root, "b.txt"), "start\n");

  let aRuns = 0;
  let bRuns = 0;
  const makeExtraTools = () => [
    {
      name: "step_one",
      description: "First repair step",
      category: "write",
      side_effect: "filesystem",
      risk_level: "low",
      source: "test",
      version: "1.0",
      params: {},
      execute: async () => {
        aRuns += 1;
        await writeFile(path.join(root, "a.txt"), `step1_run_${aRuns}\n`);
        return { status: "success", content: [{ type: "text", text: "step 1 ok" }] };
      }
    },
    {
      name: "step_two_gated",
      description: "Second repair step requiring approval",
      category: "execute",
      side_effect: "process",
      risk_level: "high",
      source: "test",
      version: "1.0",
      params: {},
      execute: async () => {
        bRuns += 1;
        await writeFile(path.join(root, "b.txt"), `step2_run_${bRuns}\n`);
        return { status: "success", content: [{ type: "text", text: "step 2 ok" }] };
      }
    }
  ];

  let k1ActCalls = 0;
  let k1RepairCalls = 0;
  const kernel1 = await createRepairTestKernel(root, {
    sessionId: "sess_p11_1",
    maxToolCallRepairs: 1,
    extraTools: makeExtraTools(),
    projectRules: [
      { id: "allow_step_one", tool: "step_one", decision: "allow" },
      { id: "ask_step_two", tool: "step_two_gated", decision: "ask" }
    ],
    modelGateway: {
      invoke: async (_messages, options = {}) => {
        if (options.purpose === "repair") {
          k1RepairCalls += 1;
          if (k1RepairCalls === 1) {
            return { content: "", tool_calls: [{ id: "bad", name: "step_one", arguments: null, arguments_parse_error: "bad json" }] };
          }
          return {
            content: "",
            tool_calls: [
              { id: "c1", name: "step_one", arguments: {} },
              { id: "c2", name: "step_two_gated", arguments: {} }
            ]
          };
        }
        k1ActCalls += 1;
        if (k1ActCalls === 1) {
          return { content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: BROKEN_DIFF, prompt: "break a" } }] };
        }
        return { content: "done", tool_calls: [] };
      }
    }
  });

  const paused = await kernel1.agent.send("modify a.txt", { autonomy: "gated", verifyMode: "run" });
  assert.equal(paused.status, "awaiting_approval");
  assert.equal(aRuns, 1);
  assert.equal(bRuns, 0);

  // Simulate process restart with kernel2 on the same workspace root
  let k2RepairCalls = 0;
  const kernel2 = await createRepairTestKernel(root, {
    sessionId: "sess_p11_2",
    maxToolCallRepairs: 1,
    testResults: [{ exit_code: 0, text: "passed after resume" }],
    extraTools: makeExtraTools(),
    projectRules: [
      { id: "allow_step_one", tool: "step_one", decision: "allow" },
      { id: "ask_step_two", tool: "step_two_gated", decision: "ask" }
    ],
    modelGateway: {
      invoke: async () => {
        k2RepairCalls += 1;
        return { content: "post-approval completion", tool_calls: [] };
      }
    }
  });

  const items = await kernel2.recovery.list();
  const item = items.find((it) => it.source_id === paused.approval.id);
  assert.ok(item, "expected paused repair turn in recovery list");
  assert.equal(item.status, "pending");

  const resumedInfo = await kernel2.recovery.resume(item.id, { decision: "approve" });
  const finalRes = resumedInfo.result;
  assert.equal(finalRes.status, "complete");
  assert.equal(aRuns, 1); // step_one was NOT re-executed across process recovery!
  assert.equal(bRuns, 1); // step_two_gated executed once
  assert.equal(finalRes.repair.tool_call_repairs, 1);
  assert.equal(k2RepairCalls, 1);
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "step1_run_1\n");
  assert.equal(await readFile(path.join(root, "b.txt"), "utf8"), "step2_run_1\n");
});

test("P12: thinking reasoning_content is preserved in assistant history during syntax repair retry while secret values in error reason are redacted", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-r18-03-p12-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  let actCalls = 0;
  let repairCalls = 0;
  let secondRepairMessages = null;
  const repairEvents = [];

  const kernel = await createRepairTestKernel(root, {
    maxToolCallRepairs: 1,
    modelGateway: {
      invoke: async (messages, options = {}) => {
        if (options.purpose === "repair") {
          repairCalls += 1;
          if (repairCalls === 1) {
            return {
              content: "thinking about repair",
              reasoning_content: "step-by-step hidden chain of thought",
              tool_calls: [{
                id: "bad_secret",
                name: "edit",
                arguments: null,
                arguments_parse_error: "Unexpected token near sk-1234567890abcdefghijklmnop"
              }]
            };
          }
          secondRepairMessages = messages;
          return {
            content: "fixed",
            reasoning_content: "second thought",
            tool_calls: [{ id: "good", name: "edit", arguments: { diff: REPAIR_DIFF, prompt: "repair a" } }]
          };
        }
        actCalls += 1;
        if (actCalls === 1) {
          return { content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: BROKEN_DIFF, prompt: "break a" } }] };
        }
        return { content: "done", tool_calls: [] };
      }
    }
  });
  kernel.eventBus.subscribe("model:tool_call_repair", (ev) => {
    repairEvents.push(ev);
  });

  const result = await kernel.agent.send("modify a.txt", { autonomy: "gated", verifyMode: "run" });
  assert.equal(result.status, "complete");
  const assistantMsg = secondRepairMessages.find((m) => m.role === "assistant" && Array.isArray(m.tool_calls));
  assert.ok(assistantMsg, "expected assistant tool_call message in retry history");
  assert.equal(assistantMsg.reasoning_content, "step-by-step hidden chain of thought");
  // Secret in error reason must be redacted in published event and retry prompt
  assert.equal(repairEvents.length, 1);
  assert.doesNotMatch(repairEvents[0].reason, /sk-1234567890abcdefghijklmnop/);
});

test("P13: duplicate tool call IDs in a batch trigger syntax repair before any execution, and duplicate approve throws APPROVAL_NOT_FOUND", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-r18-03-p13-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  let actCalls = 0;
  let repairCalls = 0;
  let gatedRuns = 0;

  const gatedTool = {
    name: "gated_write",
    description: "Gated write tool",
    category: "execute",
    side_effect: "process",
    risk_level: "high",
    source: "test",
    version: "1.0",
    params: {},
    execute: async () => {
      gatedRuns += 1;
      await writeFile(path.join(root, "a.txt"), `fixed_${gatedRuns}\n`);
      return { status: "success", content: [{ type: "text", text: "ok" }] };
    }
  };

  const kernel = await createRepairTestKernel(root, {
    maxToolCallRepairs: 1,
    extraTools: [gatedTool],
    projectRules: [{ id: "ask_gated_write", tool: "gated_write", decision: "ask" }],
    modelGateway: {
      invoke: async (_messages, options = {}) => {
        if (options.purpose === "repair") {
          repairCalls += 1;
          if (repairCalls === 1) {
            // Duplicate call IDs in the same batch!
            return {
              content: "",
              tool_calls: [
                { id: "dup_id", name: "gated_write", arguments: {} },
                { id: "dup_id", name: "gated_write", arguments: {} }
              ]
            };
          }
          if (repairCalls === 2) {
            return {
              content: "",
              tool_calls: [{ id: "unique_id", name: "gated_write", arguments: {} }]
            };
          }
          return { content: "done", tool_calls: [] };
        }
        actCalls += 1;
        if (actCalls === 1) {
          return { content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: BROKEN_DIFF, prompt: "break a" } }] };
        }
        return { content: "done", tool_calls: [] };
      }
    }
  });

  const paused = await kernel.agent.send("modify a.txt", { autonomy: "gated", verifyMode: "run" });
  assert.equal(paused.status, "awaiting_approval");
  assert.equal(gatedRuns, 0);

  const approved = await kernel.agent.approve(paused.approval.id, "approve");
  assert.equal(approved.status, "complete");
  assert.equal(gatedRuns, 1);

  await assert.rejects(
    () => kernel.agent.approve(paused.approval.id, "approve"),
    (err) => err.code === "APPROVAL_NOT_FOUND"
  );
  assert.equal(gatedRuns, 1);
});

test("P14: missing usage or gateway internal HTTP retry during repair syntax retry accounts all HTTP attempts and unknown usage in RequestBudget", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-r18-03-p14-"));
  await writeFile(path.join(root, "a.txt"), "old\n");

  let httpCalls = 0;
  const gateway = createDeepSeekGateway({
    apiKey: "test-key",
    sleepFn: async () => {},
    fetchImpl: async (_url, init) => {
      httpCalls += 1;
      const body = JSON.parse(init.body);
      // 1st HTTP call: act edit
      if (httpCalls === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: "",
                tool_calls: [{ id: "c1", type: "function", function: { name: "edit", arguments: JSON.stringify({ diff: BROKEN_DIFF, prompt: "break" }) } }]
              }
            }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
          })
        };
      }
      // 2nd HTTP call: act completion (missing usage!)
      if (httpCalls === 2) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ finish_reason: "stop", message: { role: "assistant", content: "edited" } }],
            usage: null
          })
        };
      }
      // 3rd HTTP call: repair attempt 1 -> HTTP 503 transient failure (retried inside gateway)
      if (httpCalls === 3) {
        return {
          ok: false,
          status: 503,
          text: async () => "{\"error\":{\"message\":\"overloaded\"}}"
        };
      }
      // 4th HTTP call: repair attempt 1 retry -> returns malformed JSON tool call
      if (httpCalls === 4) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: "",
                tool_calls: [{ id: "bad_call", type: "function", function: { name: "edit", arguments: "{bad json" } }]
              }
            }],
            usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 }
          })
        };
      }
      // 5th HTTP call: repair syntax retry -> returns valid edit tool call
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: "repaired",
              tool_calls: [{ id: "good_call", type: "function", function: { name: "edit", arguments: JSON.stringify({ diff: REPAIR_DIFF, prompt: "fix" }) } }]
            }
          }],
          usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 }
        })
      };
    }
  });

  const reqBudget = createRequestBudget({ maxTokens: 10000, maxModelCalls: 10, executionId: "exec_p14" });
  const scope = createRequestScope({ budget: reqBudget, executionId: "exec_p14" });

  const kernel = await createRepairTestKernel(root, {
    maxToolCallRepairs: 1,
    modelGateway: gateway
  });

  const result = await kernel.agent.send("modify a.txt", { autonomy: "gated", verifyMode: "run", scope });
  assert.equal(result.status, "complete");
  assert.equal(httpCalls, 5);
  const snap = reqBudget.snapshot();
  // All 5 HTTP attempts (including the 503 retry and the missing-usage response) are accounted!
  assert.equal(snap.model_calls, 5);
  assert.equal(snap.unknown_usage_attempts, 2); // call 2 (usage: null) + call 3 (HTTP 503)
  assert.equal(snap.tokens, 15 + 16 + 20);
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "fixed\n");
});
