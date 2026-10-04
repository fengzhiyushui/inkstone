import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os"; import path from "node:path"; import { promises as fs } from "node:fs";
import { createKernel } from "../../../src/index.js";
import { mkdtemp } from "../../helpers/tmp.js";

const exists = (p) => fs.access(p).then(() => true, () => false);

// Mock gateway: planner -> 2 disjoint-scope edit subtasks; each worker -> a diff_apply
// editing its own file; reviewer -> pass; synth -> final.
function mockGateway() {
  return {
    invoke: async (messages) => {
      const text = (messages || []).map((m) => m.content).join("\n");
      if (text.includes("Break the user's request")) {
        return { content: JSON.stringify({ task_summary: "t", done_when: "d", subtasks: [
          { id: "st_a", goal: "edit a.js", acceptance: ["a edited"], context_scope: { files: ["a.js"] }, tool_profile: "edit", depends_on: [] },
          { id: "st_b", goal: "edit b.js", acceptance: ["b edited"], context_scope: { files: ["b.js"] }, tool_profile: "edit", depends_on: [] }
        ] }), tool_calls: [] };
      }
      if (text.includes("INDEPENDENT reviewer")) return { content: '{"pass":true,"severity":"warn","reasons":[],"checked":["read"]}', tool_calls: [] };
      if (text.includes("Synthesize a final answer")) return { content: "final", tool_calls: [] };
      // worker: emit one diff_apply for its file (only on first turn -> no tool_calls after)
      const alreadyApplied = text.includes("Applied change");
      if (!alreadyApplied && text.includes("Sub-task: edit a.js")) {
        return { content: "", tool_calls: [{ id: "t1", name: "diff_apply", arguments: { diff: "--- a/a.js\n+++ b/a.js\n@@ -1,1 +1,1 @@\n-base a\n+edited a\n" } }] };
      }
      if (!alreadyApplied && text.includes("Sub-task: edit b.js")) {
        return { content: "", tool_calls: [{ id: "t2", name: "diff_apply", arguments: { diff: "--- a/b.js\n+++ b/b.js\n@@ -1,1 +1,1 @@\n-base b\n+edited b\n" } }] };
      }
      return { content: "done", tool_calls: [] };
    },
    reply: async () => ({ content: "single reply" }),
    getUsageStats: () => ({})
  };
}

test("parallel orchestrate: two iso workers edit disjoint files, both merge to main, no residue", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "c3-e2e-"));
  await fs.writeFile(path.join(root, "a.js"), "base a\n");
  await fs.writeFile(path.join(root, "b.js"), "base b\n");
  const events = [];
  const kernel = await createKernel(root, {
    modelGateway: mockGateway(),
    eventBus: { publish: (t, d) => events.push([t, d]), subscribe: () => () => {} },
    sessionLog: null, branchStore: null,
    verifyMode: "off"   // keep iso workers from running the test tool
  });

  const r = await kernel.agent.send("分别编辑 a.js 和 b.js 两个文件");
  assert.ok(events.some(([t]) => t === "orchestration:routed"), "routed");
  assert.ok(events.some(([t]) => t === "orchestration:planned"), "planned");
  // both files merged into MAIN workspace
  assert.equal(await fs.readFile(path.join(root, "a.js"), "utf8"), "edited a\n");
  assert.equal(await fs.readFile(path.join(root, "b.js"), "utf8"), "edited b\n");
  // zero residue: the iso run dir is gone
  assert.equal(await exists(path.join(root, ".deepseek-code/v2/orchestration/iso")) , true); // base dir may exist
  const isoBase = path.join(root, ".deepseek-code/v2/orchestration/iso");
  const leftover = await fs.readdir(isoBase).catch(() => []);
  assert.deepEqual(leftover, [], "no run dirs left behind");
  await kernel.dispose?.();
});
