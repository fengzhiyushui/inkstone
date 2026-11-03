// tests/unit/core/protocol-and-lifecycle.test.js — 协议与生命周期领域测试
//
// v1.19.1 测试归并:本文件由下列历史任务单测试合并而成,每个来源包裹在独立
// describe 块中(异步回调 + 动态 import,来源间零共享绑定),测试语义与拆分前一致。
import { describe } from "node:test";

// ---------------------------------------------------------------------------
// 来源:tests/unit/core/protocol.test.js
// ---------------------------------------------------------------------------
describe("unit/core/protocol", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createAgentTurn, setTurnStatus, addTurnStep, createAgentStep, completeAgentStep, createToolCall, createToolResult, createApprovalRequest, createArtifact } = await import("../../../src/core/protocol/index.js");

  test("createAgentTurn builds a valid turn", () => {
    const turn = createAgentTurn({
      sessionId: "sess_1",
      userMessage: "hello",
      autonomy: "gated"
    });

    assert.ok(turn.id.startsWith("turn_"));
    assert.equal(turn.session_id, "sess_1");
    assert.equal(turn.user_message, "hello");
    assert.equal(turn.status, "running");
    assert.equal(turn.autonomy, "gated");
    assert.deepEqual(turn.steps, []);
    assert.deepEqual(turn.artifacts, []);
    assert.equal(turn.usage.total_tokens, 0);
  });

  test("turn helpers update status and append steps immutably", () => {
    const turn = createAgentTurn({ sessionId: "sess_1", userMessage: "hello" });
    const step = createAgentStep({ turnId: turn.id, type: "classify", channel: "system" });
    const withStep = addTurnStep(turn, step);
    const completed = setTurnStatus(withStep, "completed");

    assert.equal(turn.steps.length, 0);
    assert.equal(withStep.steps.length, 1);
    assert.equal(completed.status, "completed");
    assert.notEqual(completed.updated_at, undefined);
  });

  test("createAgentStep and completeAgentStep build step lifecycle records", () => {
    const step = createAgentStep({ turnId: "turn_1", type: "model", channel: "think" });
    const completed = completeAgentStep(step, { outputRef: "artifact_1" });

    assert.ok(step.id.startsWith("step_"));
    assert.equal(step.status, "started");
    assert.equal(completed.status, "completed");
    assert.equal(completed.output_ref, "artifact_1");
    assert.ok(Date.parse(completed.ended_at) > 0);
  });

  test("tool and approval protocol records use stable field names", () => {
    const call = createToolCall({
      name: "read",
      params: { path: "README.md" },
      requestedByStepId: "step_1"
    });
    const result = createToolResult({
      callId: call.id,
      status: "success",
      content: [{ type: "text", text: "ok" }]
    });
    const approval = createApprovalRequest({
      turnId: "turn_1",
      kind: "tool",
      risk: "medium",
      summary: "Read README"
    });

    assert.equal(call.name, "read");
    assert.equal(call.requested_by_step_id, "step_1");
    assert.equal(result.call_id, call.id);
    assert.equal(result.status, "success");
    assert.equal(approval.kind, "tool");
    assert.deepEqual(approval.decisions, ["approve", "deny"]);
  });

  test("createArtifact records durable artifact metadata", () => {
    const artifact = createArtifact({
      kind: "diff",
      path: ".deepseek-code/artifacts/a.diff",
      hash: "sha256:abc",
      size: 42
    });

    assert.ok(artifact.id.startsWith("artifact_"));
    assert.equal(artifact.kind, "diff");
    assert.equal(artifact.ttl, null);
    assert.deepEqual(artifact.metadata, {});
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/core/lifecycle.test.js
// ---------------------------------------------------------------------------
describe("unit/core/lifecycle", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { classifyMessage } = await import("../../../src/core/planning/classifier.js");
  const { createLifecycleState, transitionLifecycle, RUNTIME_STATES } = await import("../../../src/core/runtime/lifecycle.js");

  test("classifyMessage separates query, edit, diagnostic, and general tasks", () => {
    assert.equal(classifyMessage("what does this project do?").task_type, "query");
    assert.equal(classifyMessage("fix the login bug").task_type, "edit");
    assert.equal(classifyMessage("debug the failing test").task_type, "diagnostic");
    assert.equal(classifyMessage("continue").task_type, "general");
  });

  test("classifyMessage supports Chinese edit, diagnostic, query, and full-width question mark", () => {
    assert.equal(classifyMessage("修复这个登录 bug").task_type, "edit");
    assert.equal(classifyMessage("重构认证模块并补测试").task_type, "edit");
    assert.equal(classifyMessage("排查为什么测试失败").task_type, "diagnostic");
    assert.equal(classifyMessage("解释这个项目的架构").task_type, "query");
    assert.equal(classifyMessage("这个函数做什么？").task_type, "query");
    assert.equal(classifyMessage("可以继续吗").task_type, "query");
    assert.equal(classifyMessage("继续").task_type, "general");
  });

  test("Chinese edit intent wins over embedded query words", () => {
    assert.equal(classifyMessage("修复为什么登录失败的问题").task_type, "edit");
  });

  test("classifyMessage carries autonomy and route metadata", () => {
    const result = classifyMessage("fix the bug", { autonomy: "supervised" });

    assert.equal(result.autonomy, "supervised");
    assert.equal(result.risk, "medium");
    assert.equal(result.channel, "think");
    assert.equal(result.requires_plan, true);
  });

  test("lifecycle starts idle and transitions immutably", () => {
    const initial = createLifecycleState();
    const next = transitionLifecycle(initial, {
      to: "classify",
      reason: "user message received",
      channel: "think"
    });

    assert.deepEqual(RUNTIME_STATES.includes("idle"), true);
    assert.equal(initial.current, "idle");
    assert.equal(next.current, "classify");
    assert.equal(next.previous, "idle");
    assert.equal(next.channel, "think");
    assert.equal(next.reason, "user message received");
    assert.ok(next.trace_id.startsWith("trace_"));
  });

  test("transitionLifecycle rejects invalid states", () => {
    const initial = createLifecycleState();
    assert.throws(
      () => transitionLifecycle(initial, { to: "missing", reason: "bad" }),
      /invalid runtime state/
    );
  });
});
