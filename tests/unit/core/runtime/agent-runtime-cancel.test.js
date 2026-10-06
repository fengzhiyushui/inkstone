import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { createAgentRuntime } from "../../../../src/core/runtime/agent-runtime.js";

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
