import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os"; import path from "node:path"; import { promises as fs } from "node:fs";
import { createKernel } from "../../../src/index.js";
import { mkdtemp } from "../../helpers/tmp.js";

// A mock model gateway: planner asks for JSON plan -> 2 subtasks; reviewer -> pass JSON; synth -> final; worker -> generic (no tool calls).
function mockGateway() {
  return {
    invoke: async (messages, _options) => {
      const text = (messages || []).map((m) => m.content).join("\n");
      if (text.includes("Break the user's request")) {
        return { content: JSON.stringify({ task_summary: "t", done_when: "d", subtasks: [
          { id: "st_1", goal: "do a", acceptance: ["a"], context_scope: {}, tool_profile: "readonly", depends_on: [] },
          { id: "st_2", goal: "do b", acceptance: ["b"], context_scope: {}, tool_profile: "readonly", depends_on: ["st_1"] }
        ] }), tool_calls: [] };
      }
      if (text.includes("INDEPENDENT reviewer")) return { content: '{"pass":true,"severity":"warn","reasons":[],"checked":["read"]}', tool_calls: [] };
      if (text.includes("Synthesize a final answer")) return { content: "final orchestrated answer", tool_calls: [] };
      return { content: "worker did the thing", tool_calls: [] };
    },
    reply: async () => ({ content: "single-agent reply" }),
    getUsageStats: () => ({})
  };
}

test("simple message uses single lane; complex message orchestrates", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orch-e2e-"));
  const events = [];
  const kernel = await createKernel(root, {
    modelGateway: mockGateway(),
    eventBus: { publish: (t, d) => events.push([t, d]), subscribe: () => () => {} },
    sessionLog: null, branchStore: null
  });

  // simple -> single lane: no orchestration:routed event
  await kernel.agent.send("explain the project").catch(() => {});
  assert.equal(events.some(([t]) => t === "orchestration:routed"), false);

  // complex -> orchestrate
  events.length = 0;
  const r = await kernel.agent.send("给这几个模块分别加校验");
  assert.ok(events.some(([t]) => t === "orchestration:routed"), "routed event fires");
  assert.ok(events.some(([t]) => t === "orchestration:planned"), "planned event fires");
  assert.equal(r.content, "final orchestrated answer");
  await kernel.dispose?.();
});
