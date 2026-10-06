import test from "node:test";
import assert from "node:assert/strict";
import { createEventBus } from "../../../src/shared/event-bus.js";
import { createAgentRuntime } from "../../../src/core/runtime/agent-runtime.js";

test("agent runtime completes a mock query turn", async () => {
  const bus = createEventBus();
  const events = [];
  bus.subscribe("agent:turn_started", (data) => events.push(["turn", data]));
  bus.subscribe("agent:step", (data) => events.push(["step", data]));
  bus.subscribe("agent:final", (data) => events.push(["final", data]));

  const runtime = createAgentRuntime({
    eventBus: bus,
    sessionId: "sess_test",
    modelGateway: {
      reply: async ({ classification }) => ({
        content: `mock ${classification.task_type} response`
      })
    }
  });

  const result = await runtime.send("what does this project do?", { autonomy: "auto" });

  assert.equal(result.status, "complete");
  assert.equal(result.state, "idle");
  assert.equal(result.content, "mock query response");
  assert.equal(result.turn.session_id, "sess_test");
  assert.ok(events.some(([type]) => type === "turn"));
  assert.ok(events.some(([type]) => type === "step"));
  assert.ok(events.some(([type]) => type === "final"));
});

test("agent runtime rejects concurrent turns", async () => {
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });

  const runtime = createAgentRuntime({
    sessionId: "sess_test",
    modelGateway: {
      reply: async () => {
        await blocked;
        return { content: "released" };
      }
    }
  });

  const first = runtime.send("what is this?");

  await assert.rejects(
    () => runtime.send("second"),
    /another turn is in progress/
  );

  release();
  await first;
});

test("agent runtime interrupt returns to idle", async () => {
  const runtime = createAgentRuntime({ sessionId: "sess_test" });

  const before = runtime.getState();
  runtime.interrupt("turn_missing");
  const after = runtime.getState();

  assert.equal(before.current, "idle");
  assert.equal(after.current, "idle");
});

test("agent runtime approve publishes approval resolution and completes", async () => {
  const bus = createEventBus();
  const approvals = [];
  bus.subscribe("approval:resolved", (data) => approvals.push(data));

  let invokeCount = 0;
  let approved = false;
  const runtime = createAgentRuntime({
    eventBus: bus,
    sessionId: "sess_approve_publish",
    modelGateway: {
      invoke: async () => {
        invokeCount += 1;
        if (invokeCount === 1) {
          return { content: "", tool_calls: [{ id: "call_test", name: "shell", arguments: { argv: ["npm", "test"] } }] };
        }
        return { content: "done", tool_calls: [] };
      },
      reply: async () => ({ content: "fast" })
    },
    executeTool: async (toolCall) => {
      if (!approved) {
        return {
          call_id: toolCall.id,
          status: "approval_required",
          content: [{ type: "text", text: "needs approval" }],
          metadata: { approval: { id: "approval_1", summary: "needs approval" } }
        };
      }
      return { call_id: toolCall.id, status: "success", content: [{ type: "text", text: "ran" }] };
    },
    createPolicyContext: () => ({ autonomy: "supervised" }),
    grantApprovalForToolCall: async () => { approved = true; }
  });

  const first = await runtime.send("run test", { autonomy: "supervised" });
  assert.equal(first.status, "awaiting_approval");

  const result = await runtime.approve("approval_1", "approve");
  assert.deepEqual(approvals, [{ approval_id: "approval_1", decision: "approve" }]);
  assert.equal(result.status, "complete");
});

test("agent runtime interrupt cancels in-flight turn and prevents stale events", async () => {
  const bus = createEventBus();
  const events = [];
  bus.subscribe("agent:final", (data) => events.push(["final", data]));
  bus.subscribe("agent:error", (data) => events.push(["error", data]));

  let release;
  const blocked = new Promise((resolve) => { release = resolve; });

  const runtime = createAgentRuntime({
    eventBus: bus,
    sessionId: "sess_cancel",
    modelGateway: {
      reply: async () => {
        await blocked;
        return { content: "stale response" };
      }
    }
  });

  // Start a turn that blocks on modelGateway
  const first = runtime.send("long task");
  await new Promise(r => setTimeout(r, 20));

  // Interrupt should cancel the turn
  runtime.interrupt();

  // Release the blocked gateway — the old turn should throw InterruptedError
  release();
  await assert.rejects(() => first, /turn was interrupted/);

  // No agent:final or agent:error should have been published for the old turn
  assert.equal(events.length, 0, "interrupted turn must not publish final or error events");
});

test("interrupted turn cleanup does not corrupt a new turn", async () => {
  const bus = createEventBus();
  let releaseA, releaseB, enteredA;
  const startedA = new Promise((resolve) => { enteredA = resolve; });
  const blockedA = new Promise((r) => { releaseA = r; });
  const blockedB = new Promise((r) => { releaseB = r; });
  let callCount = 0;

  const runtime = createAgentRuntime({
    eventBus: bus,
    sessionId: "sess_race",
    modelGateway: {
      reply: async () => {
        callCount++;
        if (callCount === 1) { enteredA(); await blockedA; return { content: "A" }; }
        if (callCount === 2) { await blockedB; return { content: "B" }; }
        return { content: "C" };
      }
    }
  });

  // Turn A: blocks on modelGateway
  const turnA = runtime.send("task A");
  await startedA;

  // Interrupt A
  runtime.interrupt();

  // Turn B: starts immediately, blocks on modelGateway
  const turnB = runtime.send("task B");

  // Release A's gateway — the late response must NOT corrupt B's state
  releaseA();
  await assert.rejects(() => turnA, /turn was interrupted/);

  // Turn C must be rejected because B is still running
  await assert.rejects(() => runtime.send("task C"), /another turn is in progress/);

  // Release B — should complete normally
  releaseB();
  const resultB = await turnB;
  assert.equal(resultB.status, "complete");
  assert.equal(resultB.content, "B");
});

test("agent runtime keeps query tasks on reply fast path", async () => {
  let invokeCalled = false;
  const runtime = createAgentRuntime({
    sessionId: "sess_query_fast",
    modelGateway: {
      reply: async () => ({ content: "fast reply" }),
      invoke: async () => {
        invokeCalled = true;
        return { content: "slow path" };
      }
    },
    toolSchemas: () => [],
    executeTool: async () => { throw new Error("query should not execute tools"); },
    createPolicyContext: () => ({ autonomy: "gated" })
  });

  const result = await runtime.send("what is this?");

  assert.equal(result.content, "fast reply");
  assert.equal(invokeCalled, false);
});

test("query fast path includes final step in returned turn", async () => {
  const runtime = createAgentRuntime({
    sessionId: "sess_query_steps",
    modelGateway: {
      reply: async () => ({ content: "fast reply" }),
      invoke: async () => ({ content: "slow" })
    },
    toolSchemas: () => [],
    executeTool: async () => { throw new Error("should not execute"); },
    createPolicyContext: () => ({ autonomy: "gated" })
  });

  const result = await runtime.send("what is this?");

  assert.equal(result.status, "complete");
  const stepTypes = result.turn.steps.map((s) => s.type);
  assert.ok(stepTypes.includes("final"), "turn should include final step from reply fast path");
});

test("verifier approval_required returns awaiting_approval even with auto autonomy", async () => {
  let invokeCount = 0;
  const runtime = createAgentRuntime({
    sessionId: "sess_verify_approval",
    modelGateway: {
      invoke: async () => {
        invokeCount++;
        if (invokeCount === 1) {
          return { content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new" } }] };
        }
        return { content: "model done", tool_calls: [] };
      },
      reply: async () => ({ content: "fast" })
    },
    toolSchemas: () => [{ type: "function", function: { name: "edit" } }],
    executeTool: async (toolCall) => {
      if (toolCall.name === "test") {
        return { call_id: toolCall.id, status: "approval_required", content: [{ type: "text", text: "verify needs approval" }], metadata: {} };
      }
      // edit tool succeeds (simulates change_id for verifier trigger)
      return { call_id: toolCall.id, status: "success", content: [{ type: "text", text: "applied" }], metadata: { change_id: "20260530120000" } };
    },
    createPolicyContext: () => ({ autonomy: "auto" })
  });

  // "modify" is an edit task → tool loop completes → verifier returns approval_required
  const result = await runtime.send("modify a.txt");

  assert.equal(result.status, "awaiting_approval");
});

test("agent runtime resumes a paused tool call after approval", async () => {
  const bus = createEventBus();
  const events = [];
  for (const type of ["approval:requested", "approval:resolved", "tool:result", "agent:final"]) {
    bus.subscribe(type, (data) => events.push([type, data]));
  }
  let approved = false;
  let invokeCount = 0;
  const runtime = createAgentRuntime({
    eventBus: bus,
    sessionId: "sess_resume",
    modelGateway: {
      invoke: async () => {
        invokeCount += 1;
        if (invokeCount === 1) {
          return { content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: "d" } }] };
        }
        return { content: "done after approve", tool_calls: [] };
      },
      reply: async () => ({ content: "fast" })
    },
    toolSchemas: () => [],
    executeTool: async (toolCall) => {
      if (!approved) {
        return {
          call_id: toolCall.id,
          status: "approval_required",
          content: [{ type: "text", text: "edit requires approval" }],
          metadata: { approval: { id: "approval_edit", summary: "edit requires approval" } }
        };
      }
      return { call_id: toolCall.id, status: "success", content: [{ type: "text", text: "applied" }], metadata: { change_id: "chg_1" } };
    },
    createPolicyContext: () => ({ autonomy: "supervised" }),
    grantApprovalForToolCall: async (toolCall) => {
      assert.equal(toolCall.name, "edit");
      approved = true;
    }
  });

  const first = await runtime.send("modify a.txt", { autonomy: "supervised" });
  assert.equal(first.status, "awaiting_approval");

  const resumed = await runtime.approve("approval_edit", "approve");

  assert.equal(resumed.status, "complete");
  assert.equal(resumed.content, "done after approve");
  assert.ok(events.some(([type]) => type === "approval:resolved"));
  assert.ok(events.some(([type]) => type === "agent:final"));
});

test("agent runtime runs verifier after approval resume edit results", async () => {
  let approved = false;
  let verifierRan = false;
  let invokeCount = 0;
  const runtime = createAgentRuntime({
    sessionId: "sess_resume_verify",
    modelGateway: {
      invoke: async () => {
        invokeCount += 1;
        if (invokeCount === 1) {
          return { content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: "d" } }] };
        }
        return { content: "done after verify", tool_calls: [] };
      },
      reply: async () => ({ content: "fast" })
    },
    toolSchemas: () => [],
    executeTool: async (toolCall) => {
      if (toolCall.name === "test") {
        verifierRan = true;
        return { call_id: toolCall.id, status: "success", content: [{ type: "text", text: "detect only" }], metadata: { detect_only: true } };
      }
      if (!approved) {
        return {
          call_id: toolCall.id,
          status: "approval_required",
          content: [{ type: "text", text: "edit requires approval" }],
          metadata: { approval: { id: "approval_edit", summary: "edit requires approval" } }
        };
      }
      return { call_id: toolCall.id, status: "success", content: [{ type: "text", text: "applied" }], metadata: { change_id: "chg_1" } };
    },
    createPolicyContext: () => ({ autonomy: "supervised" }),
    grantApprovalForToolCall: async () => { approved = true; }
  });

  const paused = await runtime.send("modify a.txt", { autonomy: "supervised" });
  const resumed = await runtime.approve(paused.approval.id, "approve");

  assert.equal(resumed.status, "complete");
  assert.equal(verifierRan, true);
  assert.equal(resumed.verification.status, "passed");
});

test("agent runtime denies a paused approval without executing the tool", async () => {
  let executions = 0;
  const runtime = createAgentRuntime({
    sessionId: "sess_deny",
    modelGateway: {
      invoke: async () => ({ content: "", tool_calls: [{ id: "call_shell", name: "shell", arguments: { argv: ["npm", "test"] } }] }),
      reply: async () => ({ content: "fast" })
    },
    executeTool: async (toolCall) => {
      executions += 1;
      return {
        call_id: toolCall.id,
        status: "approval_required",
        content: [{ type: "text", text: "shell requires approval" }],
        metadata: { approval: { id: "approval_shell" } }
      };
    },
    createPolicyContext: () => ({ autonomy: "supervised" })
  });

  const first = await runtime.send("run tests", { autonomy: "supervised" });
  assert.equal(first.status, "awaiting_approval");

  const denied = await runtime.approve("approval_shell", "deny");

  assert.equal(denied.status, "cancelled");
  assert.equal(executions, 1, "deny should not execute the pending tool again");
});

test("agent runtime rejects duplicate or unknown approval ids", async () => {
  const runtime = createAgentRuntime({ sessionId: "sess_unknown" });

  await assert.rejects(
    () => runtime.approve("missing", "approve"),
    /approval not found/
  );
});

test("agent runtime rejects new send while approval is paused", async () => {
  const runtime = createAgentRuntime({
    sessionId: "sess_paused_busy",
    modelGateway: {
      invoke: async () => ({ content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: "d" } }] }),
      reply: async () => ({ content: "fast" })
    },
    executeTool: async (toolCall) => ({
      call_id: toolCall.id,
      status: "approval_required",
      content: [{ type: "text", text: "edit requires approval" }],
      metadata: { approval: { id: "approval_edit" } }
    }),
    createPolicyContext: () => ({ autonomy: "supervised" })
  });

  const first = await runtime.send("modify a.txt", { autonomy: "supervised" });
  assert.equal(first.status, "awaiting_approval");

  await assert.rejects(
    () => runtime.send("second request"),
    /approval is awaiting resolution/
  );
});

test("agent runtime repairs failed verification and completes", async () => {
  let invokeCount = 0;
  let testRuns = 0;
  const runtime = createAgentRuntime({
    sessionId: "sess_repair_runtime",
    maxRepairAttempts: 1,
    verifyMode: "run",
    modelGateway: {
      invoke: async (_messages, options = {}) => {
        invokeCount += 1;
        if (options.purpose === "repair") {
          return { content: "", tool_calls: [{ id: "call_repair_edit", name: "edit", arguments: { diff: "repair" } }] };
        }
        if (invokeCount === 1) {
          return { content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: "broken" } }] };
        }
        return { content: "done", tool_calls: [] };
      },
      reply: async () => ({ content: "fast" })
    },
    toolSchemas: () => [],
    executeTool: async (toolCall) => {
      if (toolCall.name === "test") {
        testRuns += 1;
        return {
          call_id: toolCall.id,
          status: "success",
          content: [{ type: "text", text: testRuns === 1 ? "failed" : "passed" }],
          metadata: { exit_code: testRuns === 1 ? 1 : 0 }
        };
      }
      return { call_id: toolCall.id, status: "success", content: [{ type: "text", text: "applied" }], metadata: { change_id: `chg_${toolCall.id}` } };
    },
    createPolicyContext: () => ({ autonomy: "gated" })
  });

  const result = await runtime.send("modify a.txt", { autonomy: "gated", verifyMode: "run" });

  assert.equal(result.status, "complete");
  assert.equal(result.verification.status, "passed");
  assert.equal(result.repair.status, "complete");
  assert.equal(testRuns, 2);
});

test("agent runtime returns awaiting_approval when repair tool asks", async () => {
  let testRuns = 0;
  let mainInvokeCount = 0;
  const runtime = createAgentRuntime({
    sessionId: "sess_repair_approval",
    maxRepairAttempts: 1,
    verifyMode: "run",
    modelGateway: {
      invoke: async (_messages, options = {}) => {
        if (options.purpose === "repair") {
          return { content: "", tool_calls: [{ id: "call_shell", name: "shell", arguments: { argv: ["npm", "test"] } }] };
        }
        mainInvokeCount += 1;
        if (mainInvokeCount === 1) {
          return { content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: "broken" } }] };
        }
        return { content: "done", tool_calls: [] };
      },
      reply: async () => ({ content: "fast" })
    },
    toolSchemas: () => [],
    executeTool: async (toolCall) => {
      if (toolCall.name === "test") {
        testRuns += 1;
        return { call_id: toolCall.id, status: "success", content: [{ type: "text", text: "failed" }], metadata: { exit_code: 1 } };
      }
      if (toolCall.name === "shell") {
        return {
          call_id: toolCall.id,
          status: "approval_required",
          content: [{ type: "text", text: "shell requires approval" }],
          metadata: { approval: { id: "approval_repair_shell" } }
        };
      }
      return { call_id: toolCall.id, status: "success", content: [{ type: "text", text: "applied" }], metadata: { change_id: "chg_1" } };
    },
    createPolicyContext: () => ({ autonomy: "supervised" })
  });

  const result = await runtime.send("modify a.txt", { autonomy: "gated", verifyMode: "run" });

  assert.equal(result.status, "awaiting_approval");
  assert.equal(result.approval.id, "approval_repair_shell");
});

test("agent runtime throws when repair attempts are exhausted", async () => {
  let testRuns = 0;
  let mainInvokeCount = 0;
  const runtime = createAgentRuntime({
    sessionId: "sess_repair_exhausted",
    maxRepairAttempts: 1,
    verifyMode: "run",
    modelGateway: {
      invoke: async (_messages, options = {}) => {
        if (options.purpose === "repair") {
          return { content: "no fix", tool_calls: [] };
        }
        mainInvokeCount += 1;
        if (mainInvokeCount === 1) {
          return { content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: "broken" } }] };
        }
        return { content: "done", tool_calls: [] };
      },
      reply: async () => ({ content: "fast" })
    },
    toolSchemas: () => [],
    executeTool: async (toolCall) => {
      if (toolCall.name === "test") {
        testRuns += 1;
        return {
          call_id: toolCall.id,
          status: "success",
          content: [{ type: "text", text: `failed ${testRuns}` }],
          metadata: { exit_code: 1 }
        };
      }
      return { call_id: toolCall.id, status: "success", content: [{ type: "text", text: "applied" }], metadata: { change_id: "chg_1" } };
    },
    createPolicyContext: () => ({ autonomy: "gated" })
  });

  await assert.rejects(
    () => runtime.send("modify a.txt", { autonomy: "gated", verifyMode: "run" }),
    /verification failed|repair/i
  );
});

test("agent runtime passes context to query fast path", async () => {
  let receivedContext = null;
  const runtime = createAgentRuntime({
    sessionId: "sess_context_query",
    createContextSnapshot: async ({ message, classification, channel }) => ({
      snapshot_id: "ctxsnap_query",
      message,
      task_type: classification.task_type,
      channel,
      summary: "Project files:\n- README.md (P0 project-doc)"
    }),
    modelGateway: {
      reply: async ({ context }) => {
        receivedContext = context;
        return { content: "answer" };
      }
    }
  });

  const result = await runtime.send("what is this project?");

  assert.equal(result.status, "complete");
  assert.equal(receivedContext.snapshot_id, "ctxsnap_query");
  assert.equal(receivedContext.channel, "reply");
});

test("agent runtime passes context to executor loop model messages", async () => {
  let firstMessages = null;
  const runtime = createAgentRuntime({
    sessionId: "sess_context_loop",
    createContextSnapshot: async () => ({
      snapshot_id: "ctxsnap_act",
      channel: "act",
      summary: "Project files:\n- src/index.js (P1 mentioned)"
    }),
    modelGateway: {
      invoke: async (messages) => {
        firstMessages = messages;
        return { content: "done", tool_calls: [] };
      },
      reply: async () => ({ content: "fast" })
    },
    executeTool: async () => { throw new Error("no tools expected"); },
    createPolicyContext: () => ({ autonomy: "gated" })
  });

  const result = await runtime.send("modify src/index.js");

  assert.equal(result.status, "complete");
  assert.ok(firstMessages[0].content.includes("Project context:"));
  assert.ok(firstMessages[0].content.includes("src/index.js"));
});

test("agent runtime interrupt clears paused approvals", async () => {
  const runtime = createAgentRuntime({
    sessionId: "sess_interrupt_paused",
    modelGateway: {
      invoke: async () => ({ content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: "d" } }] }),
      reply: async () => ({ content: "fast" })
    },
    executeTool: async (toolCall) => ({
      call_id: toolCall.id,
      status: "approval_required",
      content: [{ type: "text", text: "edit requires approval" }],
      metadata: { approval: { id: "approval_edit" } }
    }),
    createPolicyContext: () => ({ autonomy: "supervised" })
  });

  await runtime.send("modify a.txt", { autonomy: "supervised" });
  runtime.interrupt();

  await assert.rejects(
    () => runtime.approve("approval_edit", "approve"),
    /approval not found/
  );
});
