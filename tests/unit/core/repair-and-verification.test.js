// tests/unit/core/repair-and-verification.test.js — 修复执行与验证(策略/验证器/修复循环/提示)领域测试
//
// v1.19.1 测试归并:本文件由下列历史任务单测试合并而成,每个来源包裹在独立
// describe 块中(异步回调 + 动态 import,来源间零共享绑定),测试语义与拆分前一致。
import { describe } from "node:test";

// ---------------------------------------------------------------------------
// 来源:tests/unit/core/execution/repair-executor.test.js
// ---------------------------------------------------------------------------
describe("unit/core/execution/repair-executor", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { runRepairExecutor } = await import("../../../src/core/execution/repair-executor.js");

  test("repair executor invokes repair model and executes tool calls through executeTool", async () => {
    const executed = [];
    const modelCalls = [];
    const result = await runRepairExecutor({
      turnId: "turn_repair",
      messages: [{ role: "user", content: "repair" }],
      modelGateway: {
        invoke: async (messages, options) => {
          modelCalls.push({ messages, options });
          return {
            content: "",
            tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: "d" } }]
          };
        }
      },
      toolSchemas: [{ type: "function", function: { name: "edit" } }],
      executeTool: async (toolCall) => {
        executed.push(toolCall);
        return { call_id: toolCall.id, status: "success", content: [{ type: "text", text: "applied" }], metadata: { change_id: "chg_1" } };
      },
      createPolicyContext: ({ phase }) => ({ autonomy: "gated", phase })
    });

    assert.equal(result.status, "complete");
    assert.equal(modelCalls[0].options.purpose, "repair");
    assert.equal(executed[0].name, "edit");
    assert.equal(result.toolResults.length, 1);
  });

  test("repair executor returns awaiting_approval with V2-7 resume_state", async () => {
    const result = await runRepairExecutor({
      turnId: "turn_repair_approval",
      messages: [{ role: "user", content: "repair" }],
      modelGateway: {
        invoke: async () => ({
          content: "",
          tool_calls: [
            { id: "call_shell", name: "shell", arguments: { argv: ["npm", "test"] } },
            { id: "call_edit", name: "edit", arguments: { diff: "d" } }
          ]
        })
      },
      toolSchemas: [],
      executeTool: async (toolCall) => ({
        call_id: toolCall.id,
        status: "approval_required",
        content: [{ type: "text", text: "needs approval" }],
        metadata: { approval: { id: "approval_repair" } }
      }),
      createPolicyContext: () => ({ autonomy: "supervised" })
    });

    assert.equal(result.status, "awaiting_approval");
    assert.equal(result.approval.id, "approval_repair");
    assert.equal(result.resume_state.pending_tool_call.name, "shell");
    assert.equal(result.resume_state.turn_id, "turn_repair_approval");
    assert.equal(result.resume_state.options.purpose, "repair");
  });

  test("repair executor stores context in approval resume state", async () => {
    const result = await runRepairExecutor({
      turnId: "turn_repair_context",
      messages: [{ role: "user", content: "{}" }],
      modelGateway: {
        invoke: async () => ({
          content: "",
          tool_calls: [{ id: "call_shell", name: "shell", arguments: { argv: ["npm", "test"] } }]
        })
      },
      toolSchemas: [],
      executeTool: async (toolCall) => ({
        call_id: toolCall.id,
        status: "approval_required",
        content: [{ type: "text", text: "approval" }],
        metadata: { approval: { id: "approval_repair_ctx" } }
      }),
      createPolicyContext: () => ({}),
      options: { context: { snapshot_id: "ctxsnap_repair", summary: "Project files:\n- a.txt" } }
    });

    assert.equal(result.status, "awaiting_approval");
    assert.equal(result.resume_state.context.snapshot_id, "ctxsnap_repair");
  });

  test("repair executor returns final content when model has no tool calls", async () => {
    const result = await runRepairExecutor({
      turnId: "turn_repair_final",
      messages: [{ role: "user", content: "repair" }],
      modelGateway: {
        invoke: async () => ({ content: "cannot repair", tool_calls: [] })
      },
      executeTool: async () => { throw new Error("should not execute tools"); },
      createPolicyContext: () => ({ autonomy: "gated" })
    });

    assert.equal(result.status, "complete");
    assert.equal(result.content, "cannot repair");
    assert.deepEqual(result.toolResults, []);
  });

  test("repair executor replays model reasoning_content in assistant message", async () => {
    // DeepSeek 协议:请求带 tools 时,历史 assistant 消息必须完整回传
    // reasoning_content,否则后续请求 HTTP 400。repair 完成后返回的 messages
    // 会被拼回后续请求,其中的 assistant 工具消息必须携带该字段且值与上游一致。
    const result = await runRepairExecutor({
      turnId: "turn_repair_reasoning",
      messages: [{ role: "user", content: "repair" }],
      modelGateway: {
        invoke: async () => ({
          content: "",
          reasoning_content: "fix the diff first, then re-run tests.",
          tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: "d" } }]
        })
      },
      toolSchemas: [{ type: "function", function: { name: "edit" } }],
      executeTool: async (toolCall) => ({
        call_id: toolCall.id, status: "success", content: [{ type: "text", text: "applied" }]
      }),
      createPolicyContext: () => ({ autonomy: "gated" })
    });

    assert.equal(result.status, "complete");
    const assistantMessages = result.messages.filter((message) => message.role === "assistant");
    assert.equal(assistantMessages.length, 1);
    assert.equal(assistantMessages[0].reasoning_content, "fix the diff first, then re-run tests.");
    assert.equal(assistantMessages[0].tool_calls[0].id, "call_edit");
  });

  test("repair executor omits reasoning_content key when model returns none", async () => {
    // 反向用例:上游模型结果无 reasoning_content 时,回传的 assistant 消息
    // 不得包含该键(不能用 undefined 占位),保持旧 mock 行为逐字节不变。
    const result = await runRepairExecutor({
      turnId: "turn_repair_no_reasoning",
      messages: [{ role: "user", content: "repair" }],
      modelGateway: {
        invoke: async () => ({
          content: "",
          tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: "d" } }]
        })
      },
      toolSchemas: [{ type: "function", function: { name: "edit" } }],
      executeTool: async (toolCall) => ({
        call_id: toolCall.id, status: "success", content: [{ type: "text", text: "applied" }]
      }),
      createPolicyContext: () => ({ autonomy: "gated" })
    });

    assert.equal(result.status, "complete");
    const assistantMessages = result.messages.filter((message) => message.role === "assistant");
    assert.equal(assistantMessages.length, 1);
    assert.ok(!("reasoning_content" in assistantMessages[0]));
    assert.deepEqual(Object.keys(assistantMessages[0]), ["role", "content", "tool_calls"]);
  });

  function captureRepairModelResponses() {
    const responses = [];
    return { responses, eventBus: { publish: (type, data) => { if (type === "model:response") responses.push(data); } } };
  }

  test("v1.9.0 M1: repair executor model:response carries the four new top-level keys", async () => {
    // mock 带 reasoning_content/latency_ms/usage 且传 sessionId:事件附四新键。
    // tps = completion_tokens / (latency_ms/1000) = 300 / (4000/1000) = 75。
    const { responses, eventBus } = captureRepairModelResponses();
    const result = await runRepairExecutor({
      turnId: "turn_repair_extras",
      messages: [{ role: "user", content: "repair" }],
      sessionId: "sess_repair",
      modelGateway: {
        invoke: async () => ({
          content: "repaired",
          reasoning_content: "fix the diff first",
          latency_ms: 4000,
          usage: { completion_tokens: 300 },
          tool_calls: []
        })
      },
      toolSchemas: [],
      executeTool: async () => { throw new Error("no tools expected"); },
      createPolicyContext: () => ({ autonomy: "gated" }),
      eventBus
    });

    assert.equal(result.status, "complete");
    assert.equal(responses.length, 1);
    const evt = responses[0];
    assert.equal(evt.turn_id, "turn_repair_extras");
    assert.equal(evt.purpose, "repair");
    assert.equal(evt.iteration, 0);
    assert.equal(evt.reasoning, "fix the diff first");
    assert.equal(evt.tps, 75);
    assert.equal(evt.session_id, "sess_repair");
    assert.equal(evt.latency_ms, 4000);
    // 既有八键不动
    assert.equal(evt.content, "repaired");
    assert.equal(evt.tool_call_count, 0);
    assert.deepEqual(evt.usage, { completion_tokens: 300 });
  });

  test("v1.9.0 M1: repair executor model:response omits the four new keys when absent", async () => {
    const { responses, eventBus } = captureRepairModelResponses();
    const result = await runRepairExecutor({
      turnId: "turn_repair_no_extras",
      messages: [{ role: "user", content: "repair" }],
      modelGateway: { invoke: async () => ({ content: "cannot repair", tool_calls: [] }) },
      toolSchemas: [],
      executeTool: async () => { throw new Error("no tools expected"); },
      createPolicyContext: () => ({ autonomy: "gated" }),
      eventBus
    });

    assert.equal(result.status, "complete");
    assert.equal(responses.length, 1);
    const evt = responses[0];
    assert.ok(!("reasoning" in evt));
    assert.ok(!("tps" in evt));
    assert.ok(!("session_id" in evt));
    assert.ok(!("latency_ms" in evt));
    assert.deepEqual(Object.keys(evt).sort(),
      ["channel", "content", "iteration", "model", "purpose", "tool_call_count", "turn_id", "usage"]);
    assert.equal(evt.usage, null);
  });

  test("v1.9.0 M1: repair executor accepts sessionId via options fallback", async () => {
    // sessionId 直接参数缺席时,options.sessionId 兜底(repair-loop 透传链路取值)。
    const { responses, eventBus } = captureRepairModelResponses();
    const result = await runRepairExecutor({
      turnId: "turn_repair_options_sid",
      messages: [{ role: "user", content: "repair" }],
      modelGateway: {
        invoke: async () => ({ content: "ok", reasoning_content: "r", latency_ms: 1000, usage: { completion_tokens: 60 }, tool_calls: [] })
      },
      toolSchemas: [],
      executeTool: async () => { throw new Error("no tools expected"); },
      createPolicyContext: () => ({ autonomy: "gated" }),
      options: { sessionId: "sess_from_options" },
      eventBus
    });

    assert.equal(result.status, "complete");
    assert.equal(responses.length, 1);
    assert.equal(responses[0].session_id, "sess_from_options");
    assert.equal(responses[0].reasoning, "r");
    // 60 / (1000/1000) = 60
    assert.equal(responses[0].tps, 60);
    assert.equal(responses[0].latency_ms, 1000);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/core/verification/verification-policy.test.js
// ---------------------------------------------------------------------------
describe("unit/core/verification/verification-policy", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createVerificationPolicy } = await import("../../../src/core/verification/verification-policy.js");

  test("verification policy auto detects in supervised mode", () => {
    const policy = createVerificationPolicy({ verifyMode: "auto" });
    assert.deepEqual(
      policy.plan({ autonomy: "supervised", hasEditResults: true }),
      { shouldVerify: true, testParams: { detect: true }, mode: "detect" }
    );
  });

  test("verification policy auto runs tests in gated mode", () => {
    const policy = createVerificationPolicy({ verifyMode: "auto" });
    assert.deepEqual(
      policy.plan({ autonomy: "gated", hasEditResults: true }),
      { shouldVerify: true, testParams: { detect: false }, mode: "run" }
    );
  });

  test("verification policy accepts explicit argv only as string array", () => {
    const policy = createVerificationPolicy({ verifyMode: "run", testArgv: ["npm", "test"] });
    assert.deepEqual(
      policy.plan({ autonomy: "auto", hasEditResults: true }),
      { shouldVerify: true, testParams: { detect: false, argv: ["npm", "test"] }, mode: "run" }
    );

    assert.throws(
      () => createVerificationPolicy({ verifyMode: "run", testArgv: "npm test" }),
      /testArgv must be an array of strings/
    );
    assert.throws(
      () => createVerificationPolicy({ verifyMode: "run", testArgv: ["npm", 1] }),
      /testArgv must be an array of strings/
    );
  });

  test("verification policy off or no edit results skips", () => {
    assert.deepEqual(
      createVerificationPolicy({ verifyMode: "off" }).plan({ autonomy: "auto", hasEditResults: true }),
      { shouldVerify: false, reason: "verification disabled", mode: "off" }
    );
    assert.deepEqual(
      createVerificationPolicy({ verifyMode: "run" }).plan({ autonomy: "auto", hasEditResults: false }),
      { shouldVerify: false, reason: "no edit results", mode: "skip" }
    );
  });

  test("verification policy rejects unknown modes", () => {
    assert.throws(
      () => createVerificationPolicy({ verifyMode: "always" }),
      /unknown verifyMode: always/
    );
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/core/verification/verifier.test.js
// ---------------------------------------------------------------------------
describe("unit/core/verification/verifier", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { shouldVerifyToolResults, runVerifier } = await import("../../../src/core/verification/verifier.js");
  const { decideRepair } = await import("../../../src/core/verification/repair-decision.js");

  test("shouldVerifyToolResults detects successful edit-like tools", () => {
    assert.equal(shouldVerifyToolResults([
      { status: "success", metadata: { change_id: "c1" } }
    ]), true);
    assert.equal(shouldVerifyToolResults([
      { status: "success", metadata: { path: "README.md" } }
    ]), false);
  });

  test("runVerifier executes detect-only test tool when edits occurred", async () => {
    const calls = [];
    const result = await runVerifier({
      turnId: "turn_1",
      autonomy: "supervised",
      toolResults: [{ status: "success", metadata: { change_id: "c1" } }],
      executeTool: async (toolCall) => {
        calls.push(toolCall);
        return { call_id: toolCall.id, status: "success", content: [{ type: "text", text: "Detected: npm test" }], metadata: { argv: ["npm", "test"] } };
      },
      createPolicyContext: () => ({ autonomy: "gated" })
    });

    assert.equal(result.status, "passed");
    assert.equal(calls[0].name, "test");
    assert.deepEqual(calls[0].params, { detect: true });
  });

  test("runVerifier skips when there are no edit results", async () => {
    const result = await runVerifier({
      turnId: "turn_1",
      toolResults: [],
      executeTool: async () => { throw new Error("should not run"); },
      createPolicyContext: () => ({})
    });

    assert.equal(result.status, "skipped");
  });

  test("decideRepair asks for repair on failed verification and stops on approval", () => {
    assert.equal(decideRepair({ status: "failed" }).decision, "repair");
    assert.equal(decideRepair({ status: "approval_required" }).decision, "stop");
    assert.equal(decideRepair({ status: "passed" }).decision, "none");
  });

  test("runVerifier treats non-zero test exit code as failed", async () => {
    const result = await runVerifier({
      turnId: "turn_fail",
      toolResults: [{ status: "success", metadata: { change_id: "chg_1" } }],
      verificationPolicy: { plan: () => ({ shouldVerify: true, testParams: { detect: false }, mode: "run" }) },
      executeTool: async () => ({
        call_id: "call_test",
        status: "success",
        content: [{ type: "text", text: "failing tests" }],
        metadata: { exit_code: 2, argv: ["npm", "test"] }
      }),
      createPolicyContext: () => ({ autonomy: "auto" })
    });

    assert.equal(result.status, "failed");
    assert.equal(result.exit_code, 2);
    assert.match(result.reason, /failing tests/);
  });

  test("runVerifier uses verification policy test params", async () => {
    const calls = [];
    const result = await runVerifier({
      turnId: "turn_policy",
      toolResults: [{ status: "success", metadata: { change_id: "chg_1" } }],
      verificationPolicy: { plan: () => ({ shouldVerify: true, testParams: { detect: false, argv: ["node", "--test"] }, mode: "run" }) },
      executeTool: async (toolCall) => {
        calls.push(toolCall);
        return {
          call_id: toolCall.id,
          status: "success",
          content: [{ type: "text", text: "ok" }],
          metadata: { exit_code: 0 }
        };
      },
      createPolicyContext: () => ({ autonomy: "auto" })
    });

    assert.equal(result.status, "passed");
    assert.deepEqual(calls[0].params, { detect: false, argv: ["node", "--test"] });
  });

  test("runVerifier passes caller autonomy to verification policy", async () => {
    let observedAutonomy = null;
    const result = await runVerifier({
      turnId: "turn_autonomy",
      autonomy: "supervised",
      toolResults: [{ status: "success", metadata: { change_id: "chg_1" } }],
      verificationPolicy: {
        plan: ({ autonomy }) => {
          observedAutonomy = autonomy;
          return { shouldVerify: false, reason: "observed", mode: "detect" };
        }
      },
      executeTool: async () => { throw new Error("should not execute test tool"); },
      createPolicyContext: () => ({ autonomy: "auto" })
    });

    assert.equal(observedAutonomy, "supervised");
    assert.deepEqual(result, { status: "skipped", reason: "observed", mode: "detect" });
  });

  test("runVerifier can skip through verification policy", async () => {
    const result = await runVerifier({
      turnId: "turn_skip_policy",
      toolResults: [{ status: "success", metadata: { change_id: "chg_1" } }],
      verificationPolicy: { plan: () => ({ shouldVerify: false, reason: "verification disabled", mode: "off" }) },
      executeTool: async () => { throw new Error("should not execute test tool"); },
      createPolicyContext: () => ({ autonomy: "auto" })
    });

    assert.deepEqual(result, { status: "skipped", reason: "verification disabled", mode: "off" });
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/core/verification/repair-loop.test.js
// ---------------------------------------------------------------------------
describe("unit/core/verification/repair-loop", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createEventBus } = await import("../../../src/shared/event-bus.js");
  const { runRepairLoop } = await import("../../../src/core/verification/repair-loop.js");

  test("repair loop repairs failed verification and returns complete when verification passes", async () => {
    const bus = createEventBus();
    const events = [];
    for (const type of ["repair:started", "repair:attempt", "repair:result"]) {
      bus.subscribe(type, (data) => events.push([type, data]));
    }
    let verifierCalls = 0;
    const result = await runRepairLoop({
      turnId: "turn_repair",
      userMessage: "fix bug",
      classification: { task_type: "edit" },
      modelGateway: {
        invoke: async () => ({ content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: "d" } }] })
      },
      toolSchemas: [],
      executeTool: async (toolCall) => ({ call_id: toolCall.id, status: "success", content: [{ type: "text", text: "applied" }], metadata: { change_id: "chg_2" } }),
      createPolicyContext: () => ({ autonomy: "gated" }),
      verificationPolicy: { plan: () => ({ shouldVerify: true, testParams: { detect: false }, mode: "run" }) },
      runVerifierImpl: async () => {
        verifierCalls += 1;
        return { status: "passed", reason: "ok" };
      },
      initialVerification: { status: "failed", reason: "tests failed" },
      initialToolResults: [{ call_id: "call_old", status: "success", content: [], metadata: { change_id: "chg_1" } }],
      eventBus: bus,
      maxRepairAttempts: 2
    });

    assert.equal(result.status, "complete");
    assert.equal(verifierCalls, 1);
    assert.ok(events.some(([type]) => type === "repair:started"));
    assert.ok(events.some(([type]) => type === "repair:attempt"));
    assert.ok(events.some(([type]) => type === "repair:result"));
  });

  test("repair loop stops on approval_required", async () => {
    const result = await runRepairLoop({
      turnId: "turn_repair_approval",
      userMessage: "fix bug",
      classification: { task_type: "edit" },
      modelGateway: {
        invoke: async () => ({ content: "", tool_calls: [{ id: "call_shell", name: "shell", arguments: { argv: ["npm", "test"] } }] })
      },
      toolSchemas: [],
      executeTool: async (toolCall) => ({
        call_id: toolCall.id,
        status: "approval_required",
        content: [{ type: "text", text: "approval" }],
        metadata: { approval: { id: "approval_repair" } }
      }),
      createPolicyContext: () => ({ autonomy: "supervised" }),
      verificationPolicy: { plan: () => ({ shouldVerify: true, testParams: { detect: false }, mode: "run" }) },
      initialVerification: { status: "failed", reason: "tests failed" },
      initialToolResults: [],
      maxRepairAttempts: 2
    });

    assert.equal(result.status, "awaiting_approval");
    assert.equal(result.approval.id, "approval_repair");
  });

  test("repair loop exhausts max attempts", async () => {
    const bus = createEventBus();
    const exhausted = [];
    bus.subscribe("repair:exhausted", (data) => exhausted.push(data));
    let verifierCalls = 0;
    const result = await runRepairLoop({
      turnId: "turn_exhaust",
      userMessage: "fix bug",
      classification: { task_type: "edit" },
      modelGateway: {
        invoke: async () => ({ content: "no repair", tool_calls: [] })
      },
      toolSchemas: [],
      executeTool: async () => { throw new Error("should not execute"); },
      createPolicyContext: () => ({ autonomy: "gated" }),
      verificationPolicy: { plan: () => ({ shouldVerify: true, testParams: { detect: false }, mode: "run" }) },
      runVerifierImpl: async () => {
        verifierCalls += 1;
        return { status: "failed", reason: `still failing ${verifierCalls}` };
      },
      initialVerification: { status: "failed", reason: "tests failed" },
      initialToolResults: [],
      eventBus: bus,
      maxRepairAttempts: 2
    });

    assert.equal(result.status, "failed");
    assert.equal(result.repair.attempts, 2);
    assert.equal(exhausted.length, 1);
  });

  test("repair loop saves repair context on pause for approval resume", async () => {
    const result = await runRepairLoop({
      turnId: "turn_repair_ctx",
      userMessage: "fix bug",
      classification: { task_type: "edit" },
      modelGateway: {
        invoke: async () => ({ content: "", tool_calls: [{ id: "call_shell", name: "shell", arguments: { argv: ["npm", "test"] } }] })
      },
      toolSchemas: [],
      executeTool: async (toolCall) => ({
        call_id: toolCall.id,
        status: "approval_required",
        content: [{ type: "text", text: "approval" }],
        metadata: { approval: { id: "approval_repair_ctx" } }
      }),
      createPolicyContext: () => ({ autonomy: "supervised" }),
      verificationPolicy: { plan: () => ({ shouldVerify: true, testParams: { detect: false }, mode: "run" }) },
      initialVerification: { status: "failed", reason: "tests failed" },
      initialToolResults: [{ call_id: "call_orig", status: "success", content: [], metadata: { change_id: "chg_1" } }],
      maxRepairAttempts: 2
    });

    assert.equal(result.status, "awaiting_approval");
    const ctx = result.resume_state?.repair_context;
    assert.ok(ctx, "should save repair context in resume_state");
    assert.equal(ctx.attempt, 1);
    assert.equal(ctx.max_repair_attempts, 2);
    assert.equal(ctx.verification.status, "failed");
    assert.equal(ctx.all_tool_results.length, 1);
    assert.equal(ctx.all_tool_results[0].metadata.change_id, "chg_1");
    assert.equal(ctx.initial_verification.status, "failed");
  });

  test("repair loop passes context into repair messages", async () => {
    let receivedMessages = null;
    const result = await runRepairLoop({
      turnId: "turn_repair_context",
      userMessage: "modify a.txt",
      classification: { task_type: "edit" },
      modelGateway: {},
      toolSchemas: [],
      executeTool: async () => { throw new Error("no tools expected"); },
      createPolicyContext: () => ({}),
      verificationPolicy: { plan: () => ({ shouldVerify: false, mode: "off" }) },
      initialVerification: { status: "failed", reason: "tests failed" },
      initialToolResults: [],
      context: { snapshot_id: "ctxsnap_repair", summary: "Project files:\n- a.txt" },
      maxRepairAttempts: 1,
      runRepairExecutorImpl: async ({ messages }) => {
        receivedMessages = messages;
        return { status: "complete", content: "no fix", toolResults: [] };
      },
      runVerifierImpl: async () => ({ status: "skipped", reason: "off" })
    });

    assert.equal(result.status, "complete");
    const payload = JSON.parse(receivedMessages[1].content);
    assert.equal(payload.context_summary.includes("a.txt"), true);
  });

  test("repair loop resumeAfterApproval verifies with original + resumed results then exhausts", async () => {
    // Simulate: repair paused for shell, shell approved and executed,
    // now resume repair loop. Verifier should see original edit + shell results.
    const bus = createEventBus();
    const exhausted = [];
    bus.subscribe("repair:exhausted", (data) => exhausted.push(data));
    let verifierToolResults = null;

    const result = await runRepairLoop({
      turnId: "turn_resume_after",
      userMessage: "fix bug",
      classification: { task_type: "edit" },
      modelGateway: {
        invoke: async () => ({ content: "no more repair", tool_calls: [] })
      },
      executeTool: async () => { throw new Error("should not execute"); },
      createPolicyContext: () => ({ autonomy: "gated" }),
      verificationPolicy: { plan: () => ({ shouldVerify: true, testParams: { detect: false }, mode: "run" }) },
      runVerifierImpl: async ({ toolResults }) => {
        verifierToolResults = toolResults;
        // No new edit happened — should still fail
        return { status: "failed", reason: "still failing" };
      },
      initialVerification: { status: "failed", reason: "tests failed" },
      initialToolResults: [{ call_id: "call_orig", status: "success", content: [], metadata: { change_id: "chg_1" } }],
      maxRepairAttempts: 1,
      eventBus: bus,
      resumeAfterApproval: {
        all_tool_results: [
          { call_id: "call_orig", status: "success", content: [], metadata: { change_id: "chg_1" } },
          { call_id: "call_shell", status: "success", content: [{ type: "text", text: "ran" }] }
        ],
        verification: { status: "failed", reason: "tests failed" },
        attempt: 1,
        attempts: [],
        initial_verification: { status: "failed", reason: "tests failed" }
      }
    });

    // Verifier should have seen BOTH the original edit AND the shell result
    assert.ok(verifierToolResults, "verifier should have been called");
    assert.ok(verifierToolResults.some(r => r.metadata?.change_id === "chg_1"), "original edit results must be present");
    assert.ok(verifierToolResults.some(r => r.call_id === "call_shell"), "resumed shell result must be present");
    // No repair edit happened, verifier still fails, 1 attempt exhausted
    assert.equal(result.status, "failed");
    assert.equal(result.repair.attempts, 1);
    assert.equal(exhausted.length, 1);
  });

  test("repair loop without budget is unchanged (repair proceeds as before)", async () => {
    let invokeCount = 0;
    const result = await runRepairLoop({
      turnId: "turn_repair_null_budget",
      userMessage: "fix bug",
      classification: { task_type: "edit" },
      modelGateway: {
        invoke: async () => {
          invokeCount += 1;
          return { content: "repaired", tool_calls: [], usage: { total_tokens: 10 } };
        }
      },
      toolSchemas: [],
      executeTool: async () => ({ call_id: "c", status: "success", content: [], metadata: { change_id: "chg" } }),
      createPolicyContext: () => ({ autonomy: "gated" }),
      verificationPolicy: { plan: () => ({ shouldVerify: true, testParams: { detect: false }, mode: "run" }) },
      runVerifierImpl: async () => ({ status: "passed", reason: "ok" }),
      initialVerification: { status: "failed", reason: "tests failed" },
      initialToolResults: [],
      maxRepairAttempts: 2
    });

    assert.equal(result.status, "complete");
    assert.equal(invokeCount, 1, "不传 budget 时 repair 照常发起模型调用(逐字节不变)");
  });

  test("repair loop with an already-exceeded budget stops before any model call", async () => {
    let invokeCount = 0;
    const exceededBudget = {
      exceeded: () => ({ reason: "max_model_calls" }),
      snapshot: () => ({ tokens: 100, model_calls: 5 })
    };
    const result = await runRepairLoop({
      turnId: "turn_repair_exceeded",
      userMessage: "fix bug",
      classification: { task_type: "edit" },
      modelGateway: {
        invoke: async () => {
          invokeCount += 1;
          return { content: "", tool_calls: [] };
        }
      },
      toolSchemas: [],
      executeTool: async () => ({ call_id: "c", status: "success", content: [], metadata: { change_id: "chg" } }),
      createPolicyContext: () => ({ autonomy: "gated" }),
      verificationPolicy: { plan: () => ({ shouldVerify: true, testParams: { detect: false }, mode: "run" }) },
      runVerifierImpl: async () => ({ status: "passed", reason: "ok" }),
      initialVerification: { status: "failed", reason: "tests failed" },
      initialToolResults: [],
      maxRepairAttempts: 2,
      budget: exceededBudget
    });

    assert.equal(result.status, "stopped");
    assert.equal(invokeCount, 0, "预算已耗尽时 repair 不应再调模型");
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/core/verification/repair-loop-timeout.test.js
// ---------------------------------------------------------------------------
describe("unit/core/verification/repair-loop-timeout", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { runRepairExecutor } = await import("../../../src/core/execution/repair-executor.js");
  const { runRepairLoop } = await import("../../../src/core/verification/repair-loop.js");

  test("runRepairExecutor forwards modelTimeoutMs as timeoutMs to gateway.invoke", async () => {
    let seen = null;
    const modelGateway = { invoke: async (messages, options) => { seen = options; return { content: "fixed", tool_calls: [] }; } };
    const result = await runRepairExecutor({
      turnId: "t1",
      messages: [{ role: "user", content: "fix" }],
      modelGateway,
      toolSchemas: [],
      executeTool: async () => ({ status: "success", content: [] }),
      createPolicyContext: () => ({}),
      modelTimeoutMs: 1234
    });
    assert.equal(result.status, "complete");
    assert.equal(seen.timeoutMs, 1234);
  });

  test("runRepairLoop threads modelTimeoutMs into the repair executor", async () => {
    let seenTimeout;
    const fakeExecutor = async (args) => { seenTimeout = args.modelTimeoutMs; return { status: "complete", content: "x", toolResults: [] }; };
    const fakeVerifier = async () => ({ status: "passed" });
    await runRepairLoop({
      turnId: "t1",
      userMessage: "fix",
      modelGateway: { invoke: async () => ({ content: "", tool_calls: [] }) },
      executeTool: async () => ({ status: "success", content: [] }),
      createPolicyContext: () => ({}),
      verificationPolicy: {},
      initialVerification: { status: "failed" },
      initialToolResults: [],
      maxRepairAttempts: 1,
      modelTimeoutMs: 777,
      runRepairExecutorImpl: fakeExecutor,
      runVerifierImpl: fakeVerifier
    });
    assert.equal(seenTimeout, 777);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/core/verification/repair-prompt.test.js
// ---------------------------------------------------------------------------
describe("unit/core/verification/repair-prompt", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { buildRepairMessages, summarizeRepairToolResults } = await import("../../../src/core/verification/repair-prompt.js");

  test("buildRepairMessages includes failure reason and excludes reasoning content", () => {
    const messages = buildRepairMessages({
      userMessage: "fix failing test",
      classification: { task_type: "edit" },
      verification: {
        status: "failed",
        reason: "Expected 1, got 2",
        reasoning_content: "hidden chain of thought"
      },
      toolResults: [
        {
          call_id: "call_edit",
          status: "success",
          content: [{ type: "text", text: "applied diff" }],
          metadata: { change_id: "chg_1", diff_hash: "abc", secret: "sk-test" }
        }
      ],
      previousRepairAttempts: [],
      maxRepairAttempts: 2
    });

    const text = JSON.stringify(messages);
    assert.match(text, /Expected 1, got 2/);
    assert.match(text, /fix failing test/);
    assert.doesNotMatch(text, /hidden chain of thought/);
    assert.doesNotMatch(text, /sk-test/);
  });

  test("summarizeRepairToolResults truncates long tool output", () => {
    const long = "x".repeat(5000);
    const summary = summarizeRepairToolResults([
      { call_id: "call_1", status: "success", content: [{ type: "text", text: long }], metadata: { path: "a.txt" } }
    ], { maxTextChars: 120 });

    assert.equal(summary.length, 1);
    assert.equal(summary[0].text.length, 120);
    assert.equal(summary[0].truncated, true);
    assert.deepEqual(summary[0].metadata, { path: "a.txt" });
  });

  test("repair prompt includes bounded context summary", () => {
    const messages = buildRepairMessages({
      userMessage: "fix a bug",
      classification: { task_type: "edit" },
      verification: { status: "failed", reason: "tests failed" },
      toolResults: [],
      context: { summary: "Project files:\n- src/index.js (P1 mentioned)\n--- src/index.js\nexport const x = 1;" }
    });

    const payload = JSON.parse(messages[1].content);
    assert.equal(payload.context_summary.includes("src/index.js"), true);
  });
});
