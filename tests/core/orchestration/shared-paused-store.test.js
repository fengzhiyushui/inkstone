import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os"; import path from "node:path"; import { promises as fs } from "node:fs";
import { createAgentRuntime } from "../../../src/core/runtime/agent-runtime.js";
import { createPausedTurnStore } from "../../../src/core/approval/paused-turn-store.js";
import { createKernel } from "../../../src/index.js";
import { mkdtemp } from "../../helpers/tmp.js";

const REC = { approval_id: "ap1", turn_id: "t1", approval: { id: "ap1" }, turn: {}, resume_state: {} };

test("mechanism: a record restored via one runtime is visible to another sharing the store", () => {
  const shared = createPausedTurnStore();
  const a = createAgentRuntime({ pausedTurnStore: shared });
  const b = createAgentRuntime({ pausedTurnStore: shared });
  a.restorePaused(REC);
  assert.equal(b.listPaused().some((r) => r.approval_id === "ap1"), true);
});

test("mechanism: default (unshared) stores stay independent — off-path parity", () => {
  const a = createAgentRuntime({});
  const b = createAgentRuntime({});
  a.restorePaused(REC);
  assert.equal(b.listPaused().some((r) => r.approval_id === "ap1"), false);
});

// Orchestration worker (singleton in-main, gated) calls diff_apply -> needs approval -> pauses.
function mockGateway() {
  return {
    invoke: async (messages) => {
      const text = (messages || []).map((m) => m.content).join("\n");
      if (text.includes("Break the user's request")) return { content: JSON.stringify({ task_summary: "t", done_when: "d", subtasks: [
        { id: "st_a", goal: "edit a.js", acceptance: ["a edited"], context_scope: { files: ["a.js"] }, tool_profile: "edit", depends_on: [] }
      ] }), tool_calls: [] };
      if (text.includes("revising a multi-agent plan")) return { content: '{"done":true,"subtasks":[]}', tool_calls: [] };
      if (text.includes("INDEPENDENT reviewer")) return { content: '{"pass":true,"severity":"warn","reasons":[],"checked":["read"]}', tool_calls: [] };
      if (text.includes("Synthesize a final answer")) return { content: "final", tool_calls: [] };
      if (text.includes("Sub-task: edit a.js") && !text.includes("Applied change")) return { content: "", tool_calls: [{ id: "t1", name: "diff_apply", arguments: { diff: "--- a/a.js\n+++ b/a.js\n@@ -1,1 +1,1 @@\n-base a\n+edited a\n" } }] };
      return { content: "done", tool_calls: [] };
    },
    reply: async () => ({ content: "single" }), getUsageStats: () => ({})
  };
}
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "m3-shared-"));
  await fs.writeFile(path.join(root, "a.js"), "base a\n");
  return root;
}

test("recovery ON: orchestration worker pause is visible in the shared main-runtime store", async () => {
  const root = await fixture();
  const kernel = await createKernel(root, {
    modelGateway: mockGateway(), sessionLog: null, branchStore: null, verifyMode: "off",
    projectId: "proj", sessionId: "s", recovery: { enabled: true, lock: false, surface: "cli" }
  });
  const p = await kernel.agent.send("逐一处理 a.js 的输入校验", { autonomy: "supervised" });
  assert.equal(p.status, "awaiting_approval");
  assert.equal(kernel.runtime.listPaused().some((r) => r.approval_id === p.approval.id), true);
  await kernel.dispose?.();
});

test("recovery OFF: orchestration worker pause is NOT in the main-runtime store (C5 in-memory only)", async () => {
  const root = await fixture();
  const kernel = await createKernel(root, {
    modelGateway: mockGateway(), eventBus: { publish() {}, subscribe: () => () => {} },
    sessionLog: null, branchStore: null, verifyMode: "off"
  });
  const p = await kernel.agent.send("逐一处理 a.js 的输入校验", { autonomy: "supervised" });
  assert.equal(p.status, "awaiting_approval");
  assert.equal(kernel.runtime.listPaused().some((r) => r.approval_id === p.approval.id), false);
  await kernel.dispose?.();
});
