import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os"; import path from "node:path"; import { promises as fs } from "node:fs";
import { createKernel } from "../../../src/index.js";
import { mkdtemp } from "../../helpers/tmp.js";

// Confidently-complex message (score >= 3) so the router short-circuits to orchestrate
// without a model triage call; carries auth/login cues for cross-task retrieval.
const MSG = "重构整个 auth login 系统 across multiple 文件";
const PLAN_JSON = JSON.stringify({
  task_summary: "t", done_when: "d",
  subtasks: [{ id: "st_a", goal: "review auth login", acceptance: ["ok"], context_scope: { files: [] }, tool_profile: "readonly", depends_on: [] }]
});
const LESSONS_JSON = '[{"kind":"procedural","lesson":"prefer pooled auth sessions","cues":["auth","login","pool"],"confidence":0.5}]';

function mockGateway(counters, prompts) {
  return {
    invoke: async (messages) => {
      const text = (messages || []).map((m) => m.content).join("\n");
      prompts.push(text);
      if (text.includes("Break the user's request")) { counters.plan += 1; return { content: PLAN_JSON, tool_calls: [] }; }
      if (text.includes("revising a multi-agent plan")) return { content: '{"done":true,"subtasks":[]}', tool_calls: [] };
      if (text.includes("INDEPENDENT reviewer")) return { content: '{"pass":true,"severity":"warn","reasons":[],"checked":["read"]}', tool_calls: [] };
      if (text.includes("Synthesize a final answer")) return { content: "final", tool_calls: [] };
      if (text.includes("just finished a multi-agent task")) { counters.distill += 1; return { content: LESSONS_JSON, tool_calls: [] }; }
      return { content: "done", tool_calls: [] }; // worker
    },
    reply: async () => ({ content: "single" }),
    getUsageStats: () => ({})
  };
}

function capturingBus(events) {
  return { publish: (type, data) => events.push({ type, data }), subscribe: () => () => {} };
}

test("on: task1 consolidates a lesson; task2 retrieves it into the planner prompt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "c4-e2e-on-"));
  const counters = { plan: 0, distill: 0 };
  const prompts = [];
  const events = [];
  const kernel = await createKernel(root, {
    modelGateway: mockGateway(counters, prompts),
    eventBus: capturingBus(events),
    sessionLog: null, branchStore: null, verifyMode: "off",
    orchestration: { crossTaskLearning: "on" }
  });

  const r1 = await kernel.agent.send(MSG, { autonomy: "auto" });
  assert.equal(r1.status, "complete");
  await kernel.experience.flush();                       // wait for background consolidation
  assert.ok(counters.distill >= 1, "consolidator distilled");
  assert.ok(events.some((e) => e.type === "experience:consolidated"), "consolidated event fired");

  const planPromptsBefore = prompts.filter((p) => p.includes("Break the user's request")).length;
  const r2 = await kernel.agent.send(MSG, { autonomy: "auto" });
  assert.equal(r2.status, "complete");
  const task2PlanPrompt = prompts.filter((p) => p.includes("Break the user's request"))[planPromptsBefore];
  assert.ok(task2PlanPrompt.includes("prefer pooled auth sessions"), "task2 planner prompt carries the retrieved lesson");
  assert.ok(events.some((e) => e.type === "experience:retrieved"), "retrieved event fired");
  await kernel.dispose?.();
});

test("off (default): zero regression — no consolidation, no experience dir, no experience events", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "c4-e2e-off-"));
  const counters = { plan: 0, distill: 0 };
  const prompts = [];
  const events = [];
  const kernel = await createKernel(root, {
    modelGateway: mockGateway(counters, prompts),
    eventBus: capturingBus(events),
    sessionLog: null, branchStore: null, verifyMode: "off"
    // crossTaskLearning omitted -> default "off"
  });

  const r = await kernel.agent.send(MSG, { autonomy: "auto" });
  assert.equal(r.status, "complete");
  await kernel.experience.flush();
  assert.equal(counters.distill, 0, "no consolidation in off mode");
  assert.ok(!events.some((e) => String(e.type).startsWith("experience:")), "no experience events");
  const planPrompt = prompts.find((p) => p.includes("Break the user's request"));
  assert.ok(!planPrompt.includes("past experience"), "planner prompt has no experience section");
  const dirExists = await fs.stat(path.join(root, ".deepseek-code", "v2", "experience")).then(() => true).catch(() => false);
  assert.equal(dirExists, false, "no experience directory created");
  await kernel.dispose?.();
});
