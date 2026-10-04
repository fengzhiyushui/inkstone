import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os"; import path from "node:path"; import { promises as fs } from "node:fs";
import { createKernel } from "../../../src/index.js";
import { mkdtemp } from "../../helpers/tmp.js";

// Worker (singleton in-main, gated) calls diff_apply -> needs approval -> pauses.
// kernel.agent.approve routes to orchestrator.resume -> worker applies -> completes.
function mockGateway(counters) {
  return {
    invoke: async (messages) => {
      const text = (messages || []).map((m) => m.content).join("\n");
      if (text.includes("Break the user's request")) {
        counters.plan += 1;
        return { content: JSON.stringify({ task_summary: "t", done_when: "d", subtasks: [
          { id: "st_a", goal: "edit a.js", acceptance: ["a edited"], context_scope: { files: ["a.js"] }, tool_profile: "edit", depends_on: [] }
        ] }), tool_calls: [] };
      }
      if (text.includes("revising a multi-agent plan")) return { content: '{"done":true,"subtasks":[]}', tool_calls: [] };
      if (text.includes("INDEPENDENT reviewer")) return { content: '{"pass":true,"severity":"warn","reasons":[],"checked":["read"]}', tool_calls: [] };
      if (text.includes("Synthesize a final answer")) return { content: "final", tool_calls: [] };
      if (text.includes("Sub-task: edit a.js") && !text.includes("Applied change")) {
        return { content: "", tool_calls: [{ id: "t1", name: "diff_apply", arguments: { diff: "--- a/a.js\n+++ b/a.js\n@@ -1,1 +1,1 @@\n-base a\n+edited a\n" } }] };
      }
      return { content: "done", tool_calls: [] };
    },
    reply: async () => ({ content: "single" }),
    getUsageStats: () => ({})
  };
}

test("orchestrate worker pauses on gated edit; kernel.approve routes to orchestrator.resume; completes; plan called once", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "c5-e2e-"));
  await fs.writeFile(path.join(root, "a.js"), "base a\n");
  const counters = { plan: 0 };
  const kernel = await createKernel(root, {
    modelGateway: mockGateway(counters),
    eventBus: { publish: () => {}, subscribe: () => () => {} },
    sessionLog: null, branchStore: null,
    verifyMode: "off"
  });

  const p = await kernel.agent.send("逐一处理 a.js 的输入校验", { autonomy: "supervised" });
  assert.equal(p.status, "awaiting_approval", "worker paused on gated edit");
  assert.ok(p.approval?.id);

  const done = await kernel.agent.approve(p.approval.id, "approve");   // routes to orchestrator.resume
  assert.equal(done.status, "complete");
  assert.equal(await fs.readFile(path.join(root, "a.js"), "utf8"), "edited a\n");  // edit merged to main
  assert.equal(counters.plan, 1, "planner.plan called exactly once (no re-plan on resume)");
  await kernel.dispose?.();
});
