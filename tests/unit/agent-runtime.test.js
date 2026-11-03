// tests/unit/agent-runtime.test.js — Agent 运行时、执行循环、验证修复与生命周期
import test from "node:test";
import assert from "node:assert/strict";
import { createEventBus } from "../../src/shared/event-bus.js";
import { createAgentRuntime } from "../../src/core/runtime/agent-runtime.js";
import { createCostBudget } from "../../src/core/runtime/cost-budget.js";
import { createPausedTurnStore } from "../../src/core/approval/paused-turn-store.js";
import { createLifecycleState, transitionLifecycle, RUNTIME_STATES } from "../../src/core/runtime/lifecycle.js";
import { runExecutorLoop } from "../../src/core/execution/executor-loop.js";
import { createVerificationPolicy } from "../../src/core/verification/verification-policy.js";
import { runRepairLoop } from "../../src/core/verification/repair-loop.js";
import { createAgentTurn, createAgentStep, createToolCall } from "../../src/core/protocol/index.js";

test("协议对象规范与 11 态生命周期状态机转移", () => {
  assert.equal(RUNTIME_STATES.length, 11);
  assert.ok(RUNTIME_STATES.includes("idle"));
  assert.ok(RUNTIME_STATES.includes("awaiting_approval"));
  assert.ok(RUNTIME_STATES.includes("complete"));

  const state = createLifecycleState();
  assert.equal(state.current, "idle");

  const executing = transitionLifecycle(state, { to: "execute", reason: "tool needed" });
  assert.equal(executing.current, "execute");
  assert.equal(executing.previous, "idle");

  assert.throws(
    () => transitionLifecycle(executing, { to: "non_existent_state" }),
    /invalid runtime state/i
  );

  const turn = createAgentTurn({ sessionId: "sess_1", id: "turn_1", userMessage: "test" });
  assert.equal(turn.id, "turn_1");
  assert.equal(turn.status, "running");

  const step = createAgentStep({ id: "step_1", turnId: "turn_1", type: "classify" });
  assert.equal(step.id, "step_1");

  const call = createToolCall({ id: "call_1", name: "read", params: { path: "a.js" }, requestedByStepId: "step_1" });
  assert.equal(call.name, "read");
});

test("每回合 CostBudget 与暂停记录内存存储", () => {
  const budget = createCostBudget({ maxTokens: 100, maxModelCalls: 2 });
  assert.equal(budget.exceeded(), null);

  budget.recordModelResult({
    usage: { prompt_tokens: 40, completion_tokens: 30, total_tokens: 70 },
    attempt_count: 1
  });
  assert.equal(budget.exceeded(), null);

  budget.recordModelResult({
    usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 },
    attempt_count: 1
  });
  const over = budget.exceeded();
  assert.ok(over);
  assert.equal(over.reason, "max_tokens");

  const store = createPausedTurnStore();
  store.save({
    approval_id: "app_mem_1",
    turn_id: "t1",
    session_id: "s1",
    approval: { id: "app_mem_1" },
    turn: { turnId: "t1" },
    resume_state: {},
    created_at: new Date().toISOString()
  });
  assert.equal(store.list().length, 1);
  assert.equal(store.get("app_mem_1").approval_id, "app_mem_1");

  store.delete("app_mem_1");
  assert.equal(store.list().length, 0);
});

test("execution-cycle 主执行循环、预算耗尽优雅停止与超时", async () => {
  const events = [];
  const bus = createEventBus();
  bus.subscribe("model:request", (e) => events.push(["request", e]));
  bus.subscribe("model:response", (e) => events.push(["response", e]));

  const mockGateway = {
    invoke: async () => ({
      content: "All done!",
      toolCalls: [],
      usage: { total_tokens: 10 }
    })
  };

  const result = await runExecutorLoop({
    message: "say hello",
    classification: { task_type: "general" },
    turnId: "turn_exec_1",
    modelGateway: mockGateway,
    toolSchemas: [],
    executeTool: async () => ({ status: "success" }),
    createPolicyContext: () => ({ autonomyLevel: "full-auto" }),
    eventBus: bus
  });

  assert.equal(result.status, "complete");
  assert.equal(result.content, "All done!");
  assert.ok(events.length >= 2);

  const exhaustedBudget = createCostBudget({ maxTokens: 5 });
  exhaustedBudget.recordModelResult({ usage: { total_tokens: 10 } });

  const stopped = await runExecutorLoop({
    message: "say hello",
    classification: { task_type: "general" },
    turnId: "turn_exec_2",
    modelGateway: mockGateway,
    toolSchemas: [],
    executeTool: async () => ({ status: "success" }),
    createPolicyContext: () => ({ autonomyLevel: "full-auto" }),
    budget: exhaustedBudget
  });
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.reason?.reason, "max_tokens");
});

test("maxToolCallRepairs 整批预校验与有界语法重试", async () => {
  let callCount = 0;
  const mockGateway = {
    invoke: async () => {
      callCount += 1;
      if (callCount === 1) {
        return {
          content: "malformed call",
          tool_calls: [{ id: "call_bad", function: { name: "read", arguments: "{bad_json" } }],
          usage: { total_tokens: 10 }
        };
      }
      return {
        content: "repaired call",
        tool_calls: [],
        usage: { total_tokens: 10 }
      };
    }
  };

  const result = await runExecutorLoop({
    message: "read file",
    classification: { task_type: "edit" },
    turnId: "turn_repair_1",
    modelGateway: mockGateway,
    toolSchemas: [{ name: "read", parameters: { type: "object", properties: { path: { type: "string" } } } }],
    executeTool: async () => ({ status: "success", content: [{ type: "text", text: "file content" }] }),
    createPolicyContext: () => ({ autonomyLevel: "full-auto" }),
    maxToolCallRepairs: 2
  });

  assert.equal(result.status, "complete");
  assert.ok(callCount >= 2);
});

test("验证器策略与自动修复循环（repair-loop）", async () => {
  const policy = createVerificationPolicy({ mode: "strict" });
  assert.ok(policy);

  let repairInvocations = 0;
  const mockGateway = {
    invoke: async () => {
      repairInvocations += 1;
      return { content: "repaired!", toolCalls: [], usage: { total_tokens: 5 } };
    }
  };

  const repairResult = await runRepairLoop({
    turnId: "turn_rep_1",
    userMessage: "fix test",
    modelGateway: mockGateway,
    initialVerification: { status: "failed", ok: false, failures: ["test failed: expected 1 got 2"] },
    maxRepairAttempts: 1,
    runVerifierImpl: async () => ({ status: "passed", ok: true, failures: [] }),
    executeTool: async () => ({ status: "success" }),
    createPolicyContext: () => ({ autonomyLevel: "full-auto" })
  });

  assert.equal(repairResult.status, "complete");
  assert.ok(repairInvocations >= 1);
});

test("agent-runtime 正常回合、快答通道与中断取消", async () => {
  const bus = createEventBus();
  const mockGateway = {
    invoke: async () => ({ content: "Hello from agent", toolCalls: [], usage: { total_tokens: 10 } }),
    reply: async () => ({ content: "Hello from agent" })
  };

  const runtime = createAgentRuntime({
    eventBus: bus,
    modelGateway: mockGateway,
    toolRegistry: { listDefinitions: () => [], resolve: () => null },
    permissionEngine: { decide: () => ({ decision: "allow" }) }
  });

  const response = await runtime.send("hi there");
  assert.equal(response.status, "complete");
  assert.equal(response.content, "Hello from agent");

  assert.equal(runtime.getState().current, "idle");
});

test("resume-coordinator 与 agent-runtime 审批恢复闭环", async () => {
  const bus = createEventBus();
  const approvals = [];
  bus.subscribe("approval:resolved", (data) => approvals.push(data));

  let invokeCount = 0;
  let approved = false;
  const runtime = createAgentRuntime({
    eventBus: bus,
    sessionId: "sess_resume_test",
    modelGateway: {
      invoke: async () => {
        invokeCount += 1;
        if (invokeCount === 1) {
          return { content: "", tool_calls: [{ id: "call_test", name: "shell", arguments: { argv: ["npm", "test"] } }] };
        }
        return { content: "done", tool_calls: [] };
      },
      reply: async () => ({ content: "fast reply" })
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
  assert.equal(runtime.getState().current, "idle");
});

test("错误脱敏与 APPROVAL_NOT_FOUND / AWAITING_APPROVAL 严格语义", async () => {
  const pausedStore = createPausedTurnStore();
  const runtime = createAgentRuntime({
    pausedTurnStore: pausedStore,
    modelGateway: {
      invoke: async () => ({ content: "ok" }),
      reply: async () => ({ content: "ok" })
    }
  });

  await assert.rejects(
    async () => runtime.approve("non_existent_id", "approve"),
    (err) => err.code === "APPROVAL_NOT_FOUND" || /not found/i.test(err.message)
  );

  pausedStore.save({
    approval_id: "app_pending_1",
    turn_id: "t_pending",
    session_id: "s1",
    approval: { id: "app_pending_1" },
    turn: { turnId: "t_pending" },
    resume_state: {}
  });

  await assert.rejects(
    async () => runtime.send("cannot start while awaiting approval"),
    (err) => err.code === "AWAITING_APPROVAL"
  );
});
