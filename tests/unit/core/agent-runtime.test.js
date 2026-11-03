// tests/unit/core/agent-runtime.test.js — 智能体运行时(预算/取消/特征化/恢复护栏/工具修复)领域测试
//
// v1.19.1 测试归并:本文件由下列历史任务单测试合并而成,每个来源包裹在独立
// describe 块中(异步回调 + 动态 import,来源间零共享绑定),测试语义与拆分前一致。
import { describe } from "node:test";

// ---------------------------------------------------------------------------
// 来源:tests/unit/core/agent-runtime.test.js
// ---------------------------------------------------------------------------
describe("unit/core/agent-runtime", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createEventBus } = await import("../../../src/shared/event-bus.js");
  const { createAgentRuntime } = await import("../../../src/core/runtime/agent-runtime.js");

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
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/core/runtime/agent-runtime-budget.test.js
// ---------------------------------------------------------------------------
describe("unit/core/runtime/agent-runtime-budget", async () => {

  // gateway 永远要求继续调工具,带 usage → 必须靠 budget 截停

  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createAgentRuntime } = await import("../../../src/core/runtime/agent-runtime.js");

  const gateway = {
    invoke: async () => ({
      content: "",
      tool_calls: [{ id: "c1", name: "noop", arguments: {} }],
      usage: { total_tokens: 50 }
    })
  };
  const executeTool = async () => ({ call_id: "c1", status: "success", content: [], metadata: {} });

  test("runtime ends an edit turn cleanly when maxTurnTokens is exceeded", async () => {
    const runtime = createAgentRuntime({
      sessionId: "s1",
      modelGateway: gateway,
      executeTool,
      toolSchemas: () => [{ type: "function", function: { name: "noop" } }],
      createPolicyContext: () => ({}),
      maxToolIterations: 50,
      maxTurnTokens: 120
    });
    const r = await runtime.send("update the file", { autonomy: "auto" });
    assert.equal(r.status, "stopped");
    assert.equal(r.state, "idle");
    assert.match(r.content, /budget/i);
  });

  test("tokens consumed before an approval pause carry into the resumed turn (budget not reset)", async () => {
    let invokeCount = 0;
    let approvalConsumed = false;
    const modelGateway = {
      invoke: async () => {
        invokeCount += 1;
        return {
          content: "",
          tool_calls: [{ id: `c${invokeCount}`, name: "noop", arguments: {} }],
          usage: { total_tokens: 80 }
        };
      }
    };
    const executeTool = async (toolCall) => {
      if (!approvalConsumed) {
        approvalConsumed = true;
        return { call_id: toolCall.id, status: "approval_required", content: [{ type: "text", text: "need ok" }], metadata: { approval: { id: "appr_1" } } };
      }
      return { call_id: toolCall.id, status: "success", content: [] };
    };
    const runtime = createAgentRuntime({
      sessionId: "s1",
      modelGateway,
      executeTool,
      toolSchemas: () => [{ type: "function", function: { name: "noop" } }],
      createPolicyContext: () => ({}),
      grantApprovalForToolCall: async () => {},
      maxTurnTokens: 80 // 恰好一次调用(80)即到顶
    });

    const paused = await runtime.send("go", { autonomy: "gated" });
    assert.equal(paused.status, "awaiting_approval");
    assert.equal(invokeCount, 1);

    const resumed = await runtime.approve("appr_1", "approve");
    assert.equal(resumed.status, "stopped");
    assert.equal(invokeCount, 1); // 暂停前已耗满 → 续跑不再调模型,预算未重置
  });

  // repair 阶段此前完全不计入每回合预算:runRepairLoop 参数表里没有 budget,
  // repair-executor 却实打实调 modelGateway.invoke —— maxTurnTokens 在最容易
  // 失控的路径上失效。
  test("repair-phase model calls count against the turn budget", async () => {
    let invokeCount = 0;
    const events = [];
    const modelGateway = {
      invoke: async () => {
        invokeCount += 1;
        // 第 1 次:发起一个编辑工具调用;第 2 次起:不再要工具 → 工具循环正常结束
        const tool_calls = invokeCount === 1
          ? [{ id: "c1", name: "edit", arguments: {} }]
          : [];
        return { content: "", tool_calls, usage: { total_tokens: 50 } };
      }
    };
    const executeTool = async (toolCall) => {
      // 验证器跑的 test 工具:退出码非 0 → verification failed → 进 repair
      if (toolCall.name === "test") {
        return { call_id: toolCall.id, status: "success", content: [{ type: "text", text: "1 failing" }], metadata: { exit_code: 1 } };
      }
      // 编辑工具:带 change_id 才会触发验证
      return { call_id: toolCall.id, status: "success", content: [], metadata: { change_id: "chg_1" } };
    };

    const runtime = createAgentRuntime({
      sessionId: "s1",
      modelGateway,
      executeTool,
      toolSchemas: () => [{ type: "function", function: { name: "edit" } }],
      createPolicyContext: () => ({}),
      eventBus: { publish: (type) => events.push(type) },
      maxTurnTokens: 100 // 两次调用(50+50)即到顶
    });

    const r = await runtime.send("改一下然后跑测试", { autonomy: "auto" });

    // 前置断言:确实走到了 repair —— 否则下面的计数断言会假绿
    assert.ok(events.includes("repair:started"), "本用例必须真的进入 repair 阶段");
    assert.equal(invokeCount, 2, "预算已耗尽,repair 不应再发起模型调用");
    assert.equal(r.status, "stopped");
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/core/runtime/agent-runtime-cancel.test.js
// ---------------------------------------------------------------------------
describe("unit/core/runtime/agent-runtime-cancel", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { getEventListeners } = await import("node:events");
  const { createAgentRuntime } = await import("../../../src/core/runtime/agent-runtime.js");

  for (const phase of ["verify", "repair", "verify_resume", "repair_resume", "repair_verify_resume"]) {
    test(`runtime interruption reaches ${phase} tool execution and cleans signal listeners`, async () => {
      let notifyStarted, toolSignal, testCalls = 0, mainCalls = 0, approved = false;
      const started = new Promise((resolve) => { notifyStarted = resolve; });
      const waiting = (signal) => new Promise((resolve) => {
        assert.ok(signal instanceof AbortSignal);
        toolSignal = signal;
        signal.addEventListener("abort", () => resolve({ status: "error", content: [] }), { once: true });
        notifyStarted();
      });
      const ok = (metadata = {}) => ({ status: "success", content: [], metadata });
      const pause = () => ({ status: "approval_required", content: [], metadata: { approval: { id: "approval" } } });
      const runtime = createAgentRuntime({
        verifyMode: "run", maxRepairAttempts: 2, createPolicyContext: () => ({}),
        grantApprovalForToolCall: async () => { approved = true; },
        modelGateway: { invoke: async (_messages, options = {}) => {
          if (options.purpose === "repair") return ["repair", "repair_resume"].includes(phase)
            ? { content: "", tool_calls: [{ id: "repair", name: "fix", arguments: {} }] }
            : { content: "repair done", tool_calls: [] };
          return ++mainCalls === 1
            ? { content: "", tool_calls: [{ id: "edit", name: "edit", arguments: {} }] }
            : { content: "done", tool_calls: [] };
        } },
        executeTool: async (call, { signal }) => {
          if (call.name === "edit") return ok({ change_id: "change" });
          if (call.name === "fix") {
            if (phase === "repair_resume" && !approved) return pause();
            return waiting(signal);
          }
          testCalls++;
          if (phase === "verify") return waiting(signal);
          if (phase === "verify_resume") return approved ? waiting(signal) : pause();
          if (phase === "repair_verify_resume" && testCalls > 1) return approved ? waiting(signal) : pause();
          return ok({ exit_code: 1 });
        }
      });
      let operation = runtime.send("modify", { verifyMode: "run" });
      if (phase.includes("resume")) {
        assert.equal((await operation).status, "awaiting_approval");
        operation = runtime.approve("approval");
      }
      const rejected = assert.rejects(operation, { code: "INTERRUPTED" });
      await started;
      runtime.interrupt();
      await rejected;
      assert.equal(toolSignal.aborted, true);
      assert.equal(getEventListeners(toolSignal, "abort").length, 0);
      assert.equal(runtime.getState().current, "idle");
    });
  }
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/core/runtime/agent-runtime-characterization.test.js
// ---------------------------------------------------------------------------
describe("unit/core/runtime/agent-runtime-characterization", async () => {

  // #10 阶段 1 · 行为刻画测试(characterization)
  // 目的:把 agent-runtime 当前的真实行为钉死(事件发布顺序、错误语义、四条
  // 审批恢复分支的续跑语义)。这些断言来自对当前实现的探测输出,不是理想值。
  // 验收标准:本文件全部通过 ≠ 完成 —— 必须额外做「变异验证」:故意改坏实现
  // 任一处,至少一条本文件用例变红;若改坏仍全绿,说明没刻画到,退回重写。
  // 注意:tool:call/tool:result 由 executor 层发布,本文件注入裸 executeTool
  // 不经 executor,故序列里不含它们 —— 序列锁的是 runtime 自己发布的事件。


  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createEventBus } = await import("../../../src/shared/event-bus.js");
  const { SESSION_EVENT_TYPES } = await import("../../../src/sessions/event-types.js");
  const { createAgentRuntime } = await import("../../../src/core/runtime/agent-runtime.js");

  function recorder() {
    const events = [];
    const bus = createEventBus();
    for (const type of SESSION_EVENT_TYPES) {
      bus.subscribe(type, () => events.push(type));
    }
    return { bus, events };
  }

  // ── 场景 1:完整 send 回合(edit 成功 → verify pass → final)的事件顺序 ──
  test("characterization: full edit-verify turn publishes events in exact order", async () => {
    const { bus, events } = recorder();
    let n = 0;
    const runtime = createAgentRuntime({
      sessionId: "char_s1", eventBus: bus, verifyMode: "run",
      modelGateway: {
        invoke: async () => {
          n += 1;
          return n === 1
            ? { content: "", tool_calls: [{ id: "c1", name: "edit", arguments: {} }] }
            : { content: "ok", tool_calls: [] };
        },
        reply: async () => ({ content: "fast" })
      },
      toolSchemas: () => [],
      executeTool: async (tc) => tc.name === "test"
        ? { call_id: tc.id, status: "success", content: [{ type: "text", text: "pass" }], metadata: { exit_code: 0 } }
        : { call_id: tc.id, status: "success", content: [], metadata: { change_id: "chg1" } },
      createPolicyContext: () => ({ autonomy: "gated" })
    });

    const r = await runtime.send("modify", { autonomy: "auto", verifyMode: "run" });
    assert.equal(r.status, "complete");
    assert.deepEqual(events, [
      "user:message", "agent:turn_started", "agent:step",
      "model:request", "model:response",
      "model:request", "model:response",
      "verification:result", "agent:final"
    ]);
  });

  // ── 分支 1:普通工具审批 → approve 续跑的事件顺序 ──
  test("characterization: ordinary tool approval resume publishes events in exact order", async () => {
    const { bus, events } = recorder();
    let approved = false, n = 0;
    const runtime = createAgentRuntime({
      sessionId: "char_s2", eventBus: bus,
      modelGateway: {
        invoke: async () => {
          n += 1;
          return n === 1
            ? { content: "", tool_calls: [{ id: "c1", name: "edit", arguments: {} }] }
            : { content: "done", tool_calls: [] };
        },
        reply: async () => ({ content: "fast" })
      },
      toolSchemas: () => [],
      executeTool: async (tc) => {
        if (tc.name === "test") return { call_id: tc.id, status: "success", content: [], metadata: { exit_code: 0 } };
        if (!approved) return { call_id: tc.id, status: "approval_required", content: [], metadata: { approval: { id: "ap1" } } };
        return { call_id: tc.id, status: "success", content: [], metadata: { change_id: "chg1" } };
      },
      createPolicyContext: () => ({ autonomy: "gated" }),
      grantApprovalForToolCall: async () => { approved = true; }
    });

    const first = await runtime.send("modify", { autonomy: "supervised" });
    assert.equal(first.status, "awaiting_approval");
    const resumed = await runtime.approve("ap1", "approve");
    assert.equal(resumed.status, "complete");
    assert.deepEqual(events, [
      "user:message", "agent:turn_started", "agent:step",
      "model:request", "model:response",
      "turn:paused", "approval:resolved", "turn:resumed",
      "model:request", "model:response",
      "verification:result", "agent:final"
    ]);
  });

  // ── 分支 2:主验证器审批(验证器的 test 工具要求审批)→ approve 续跑 ──
  test("characterization: runtime verifier approval resume re-runs verifier then completes", async () => {
    const { bus, events } = recorder();
    let approveVerifier = false, mainN = 0;
    const runtime = createAgentRuntime({
      sessionId: "char_s3", eventBus: bus, maxRepairAttempts: 2, verifyMode: "run",
      modelGateway: {
        invoke: async (_m, opts = {}) => {
          if (opts.purpose === "repair") return { content: "", tool_calls: [] };
          mainN += 1;
          return mainN === 1
            ? { content: "", tool_calls: [{ id: "c1", name: "edit", arguments: {} }] }
            : { content: "done", tool_calls: [] };
        },
        reply: async () => ({ content: "fast" })
      },
      toolSchemas: () => [],
      executeTool: async (tc) => {
        if (tc.name === "test") {
          if (!approveVerifier) {
            approveVerifier = true;
            return { call_id: tc.id, status: "approval_required", content: [{ type: "text", text: "verifier needs ok" }], metadata: { approval: { id: "ap_v" } } };
          }
          return { call_id: tc.id, status: "success", content: [], metadata: { exit_code: 0 } };
        }
        return { call_id: tc.id, status: "success", content: [], metadata: { change_id: "chg1" } };
      },
      createPolicyContext: () => ({ autonomy: "supervised" }),
      grantApprovalForToolCall: async () => {}
    });

    const first = await runtime.send("modify", { autonomy: "supervised" });
    assert.equal(first.status, "awaiting_approval");
    assert.equal(first.approval.id, "ap_v");
    const resumed = await runtime.approve("ap_v", "approve");
    assert.equal(resumed.status, "complete");
    assert.deepEqual(events, [
      "user:message", "agent:turn_started", "agent:step",
      "model:request", "model:response",
      "model:request", "model:response",
      "verification:result",
      "turn:paused", "approval:resolved", "turn:resumed",
      "verification:result", "agent:final"
    ]);
  });

  // ── 分支 3:修复期工具审批(repair 的 shell 要求审批)→ 续跑继续 repair 循环 ──
  test("characterization: repair tool approval resume continues the repair loop then errors", async () => {
    const { bus, events } = recorder();
    let shellApproved = false, mainN = 0, repairN = 0;
    const runtime = createAgentRuntime({
      sessionId: "char_s4", eventBus: bus, maxRepairAttempts: 2, verifyMode: "run",
      modelGateway: {
        invoke: async (_m, opts = {}) => {
          if (opts.purpose === "repair") {
            repairN += 1;
            return repairN === 1
              ? { content: "", tool_calls: [{ id: "c9", name: "shell", arguments: {} }] }
              : { content: "no fix needed", tool_calls: [] };
          }
          mainN += 1;
          return mainN === 1
            ? { content: "", tool_calls: [{ id: "c1", name: "edit", arguments: {} }] }
            : { content: "done", tool_calls: [] };
        },
        reply: async () => ({ content: "fast" })
      },
      toolSchemas: () => [],
      executeTool: async (tc) => {
        if (tc.name === "test") return { call_id: tc.id, status: "success", content: [{ type: "text", text: "fail" }], metadata: { exit_code: 1 } };
        if (tc.name === "shell") {
          if (!shellApproved) return { call_id: tc.id, status: "approval_required", content: [], metadata: { approval: { id: "ap_shell" } } };
          return { call_id: tc.id, status: "success", content: [], metadata: {} };
        }
        return { call_id: tc.id, status: "success", content: [], metadata: { change_id: "chg1" } };
      },
      createPolicyContext: () => ({ autonomy: "supervised" }),
      grantApprovalForToolCall: async () => { shellApproved = true; }
    });

    const first = await runtime.send("modify", { autonomy: "supervised" });
    assert.equal(first.status, "awaiting_approval");
    assert.equal(first.approval.id, "ap_shell");
    // 续跑会继续 repair 循环;修复始终不生效 → 尝试耗尽 → approve 抛 verification failed
    await assert.rejects(
      () => runtime.approve("ap_shell", "approve"),
      /verification failed/
    );
    assert.deepEqual(events, [
      "user:message", "agent:turn_started", "agent:step",
      "model:request", "model:response",
      "model:request", "model:response",
      "verification:result",
      "repair:started", "repair:attempt",
      "model:request", "model:response",
      "turn:paused", "approval:resolved", "turn:resumed",
      "model:request", "model:response",
      "verification:result", "repair:result",
      "repair:attempt", "model:request", "model:response",
      "verification:result", "repair:result",
      "repair:exhausted", "agent:error"
    ]);
  });

  // ── 分支 4:修复期验证器审批 → 续跑重跑 verifier、记 repair:result 后完成 ──
  test("characterization: repair verifier approval resume re-runs verifier and completes", async () => {
    const { bus, events } = recorder();
    let testCalls = 0, mainN = 0;
    const runtime = createAgentRuntime({
      sessionId: "char_s5", eventBus: bus, maxRepairAttempts: 2, verifyMode: "run",
      modelGateway: {
        invoke: async (_m, opts = {}) => {
          if (opts.purpose === "repair") return { content: "no fix", tool_calls: [] };
          mainN += 1;
          return mainN === 1
            ? { content: "", tool_calls: [{ id: "c1", name: "edit", arguments: {} }] }
            : { content: "done", tool_calls: [] };
        },
        reply: async () => ({ content: "fast" })
      },
      toolSchemas: () => [],
      executeTool: async (tc) => {
        if (tc.name === "test") {
          testCalls += 1;
          if (testCalls === 1) return { call_id: tc.id, status: "success", content: [{ type: "text", text: "main verify fail" }], metadata: { exit_code: 1 } };
          if (testCalls === 2) return { call_id: tc.id, status: "approval_required", content: [{ type: "text", text: "repair verifier needs ok" }], metadata: { approval: { id: "ap_rv" } } };
          return { call_id: tc.id, status: "success", content: [], metadata: { exit_code: 0 } };
        }
        return { call_id: tc.id, status: "success", content: [], metadata: { change_id: "chg1" } };
      },
      createPolicyContext: () => ({ autonomy: "supervised" }),
      grantApprovalForToolCall: async () => {}
    });

    const first = await runtime.send("modify", { autonomy: "supervised" });
    assert.equal(first.status, "awaiting_approval");
    assert.equal(first.approval.id, "ap_rv");
    const resumed = await runtime.approve("ap_rv", "approve");
    assert.equal(resumed.status, "complete");
    assert.deepEqual(events, [
      "user:message", "agent:turn_started", "agent:step",
      "model:request", "model:response",
      "model:request", "model:response",
      "verification:result",
      "repair:started", "repair:attempt",
      "model:request", "model:response",
      "verification:result",
      "turn:paused", "approval:resolved", "turn:resumed",
      "verification:result", "repair:result", "agent:final"
    ]);
  });

  // ── 错误语义:未知审批 id 的 code 与 message ──
  test("characterization: approve with unknown id throws APPROVAL_NOT_FOUND with exact message", async () => {
    const runtime = createAgentRuntime({ sessionId: "char_err1" });
    await assert.rejects(
      () => runtime.approve("missing", "approve"),
      (e) => e.code === "APPROVAL_NOT_FOUND" && e.message === "approval not found: missing"
    );
  });

  // ── 错误语义:审批暂停时新 send 的 code 与 message ──
  test("characterization: send while approval paused throws AWAITING_APPROVAL with exact message", async () => {
    const runtime = createAgentRuntime({
      sessionId: "char_err2",
      modelGateway: {
        invoke: async () => ({ content: "", tool_calls: [{ id: "c1", name: "edit", arguments: {} }] }),
        reply: async () => ({ content: "fast" })
      },
      toolSchemas: () => [],
      executeTool: async () => ({ call_id: "c1", status: "approval_required", content: [], metadata: { approval: { id: "ap1" } } }),
      createPolicyContext: () => ({ autonomy: "supervised" })
    });
    await runtime.send("modify", { autonomy: "supervised" });
    await assert.rejects(
      () => runtime.send("again", { autonomy: "supervised" }),
      (e) => e.code === "AWAITING_APPROVAL" && e.message === "approval is awaiting resolution"
    );
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/core/runtime/agent-runtime-resume-guardrails.test.js
// ---------------------------------------------------------------------------
describe("unit/core/runtime/agent-runtime-resume-guardrails", async () => {

  // 模型每次都要求再调一次工具,以驱动多轮;send 阶段工具需审批,approve 后成功

  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createAgentRuntime } = await import("../../../src/core/runtime/agent-runtime.js");

  function buildRuntime(overrides = {}) {
    let invokeCount = 0;
    let approvalConsumed = false;
    const modelGateway = {
      invoke: async () => {
        invokeCount += 1;
        return {
          content: "",
          tool_calls: [{ id: `c${invokeCount}`, name: "noop", arguments: {} }],
          usage: { total_tokens: 1 }
        };
      }
    };
    const executeTool = async (toolCall) => {
      if (!approvalConsumed) {
        approvalConsumed = true;
        return { call_id: toolCall.id, status: "approval_required", content: [{ type: "text", text: "need ok" }], metadata: { approval: { id: "appr_1" } } };
      }
      return { call_id: toolCall.id, status: "success", content: [] };
    };
    const runtime = createAgentRuntime({
      sessionId: "s1",
      modelGateway,
      executeTool,
      toolSchemas: () => [{ type: "function", function: { name: "noop" } }],
      createPolicyContext: () => ({}),
      grantApprovalForToolCall: async () => {},
      ...overrides
    });
    return { runtime, invokes: () => invokeCount };
  }

  test("approve() resume enforces cost budget and stops the turn", async () => {
    const { runtime } = buildRuntime({ maxModelCalls: 1 });
    const paused = await runtime.send("go", { autonomy: "gated" });
    assert.equal(paused.status, "awaiting_approval");

    const resumed = await runtime.approve("appr_1", "approve");
    assert.equal(resumed.status, "stopped"); // 预算在 resume 段生效 → 干净停止(而非裸跑/抛错)
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/core/runtime/agent-runtime-toolrepair.test.js
// ---------------------------------------------------------------------------
describe("unit/core/runtime/agent-runtime-toolrepair", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createAgentRuntime } = await import("../../../src/core/runtime/agent-runtime.js");

  function malformedThenDone() {
    let n = 0;
    return {
      invoke: async () => {
        n += 1;
        if (n === 1) return { content: "", tool_calls: [{ id: "bad", name: "noop", arguments: null, arguments_parse_error: "bad" }] };
        return { content: "done", tool_calls: [], usage: { total_tokens: 1 } };
      }
    };
  }

  test("runtime repairs a malformed tool call when maxToolCallRepairs > 0", async () => {
    const runtime = createAgentRuntime({
      sessionId: "s1",
      modelGateway: malformedThenDone(),
      executeTool: async () => ({ status: "success", content: [] }),
      toolSchemas: () => [{ type: "function", function: { name: "noop" } }],
      createPolicyContext: () => ({}),
      maxToolCallRepairs: 1
    });
    const r = await runtime.send("do it", { autonomy: "auto" });
    assert.equal(r.status, "complete");
    assert.equal(r.content, "done");
  });
});
