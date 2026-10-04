import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os"; import path from "node:path"; import { promises as fs } from "node:fs";
import { createKernel } from "../../../src/index.js";
import { mkdtemp } from "../../helpers/tmp.js";

// Router triage (purpose=act) is dispatched by the "Classify this coding request" prompt;
// the orchestrate machinery (planner/reviewer/synth/worker) reuses the c5/c3 e2e mock shape.
function mockGateway({ triage, calls }) {
  return {
    invoke: async (messages, options = {}) => {
      const text = (messages || []).map((m) => m.content).join("\n");
      if (text.includes("Classify this coding request")) {
        calls.triage += 1;
        return typeof triage === "function" ? triage(options) : { content: triage, tool_calls: [] };
      }
      if (text.includes("Break the user's request")) {
        calls.plan += 1;
        return { content: JSON.stringify({ task_summary: "t", done_when: "d", subtasks: [
          { id: "st_a", goal: "inspect a", acceptance: ["done"], context_scope: { files: [] }, tool_profile: "readonly", depends_on: [] }
        ] }), tool_calls: [] };
      }
      if (text.includes("revising a multi-agent plan")) return { content: '{"done":true,"subtasks":[]}', tool_calls: [] };
      if (text.includes("INDEPENDENT reviewer")) return { content: '{"pass":true,"severity":"warn","reasons":[],"checked":["read"]}', tool_calls: [] };
      if (text.includes("Synthesize a final answer")) return { content: "final", tool_calls: [] };
      return { content: "done", tool_calls: [] };
    },
    reply: async () => ({ content: "single" }),
    getUsageStats: () => ({})
  };
}

function recordingBus() {
  const events = [];
  return { events, publish: (type, data) => { events.push({ type, data }); }, subscribe: () => () => {} };
}

const AMBIG = "请处理这些校验逻辑";   // weak "这些" → score 1 → ambiguous band

async function tmpRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "c-router-e2e-"));
  await fs.writeFile(path.join(root, "package.json"), "{\"name\":\"demo\"}\n");
  return root;
}

test("ambiguous request consults model → route_resolved(model) → orchestrate runs", async () => {
  const root = await tmpRoot();
  const calls = { triage: 0, plan: 0 };
  const bus = recordingBus();
  const kernel = await createKernel(root, {
    modelGateway: mockGateway({ triage: '{"lane":"orchestrate","reason":"multi"}', calls }),
    eventBus: bus, sessionLog: null, branchStore: null, verifyMode: "off"
  });

  const res = await kernel.agent.send(AMBIG, { autonomy: "gated" });

  assert.equal(calls.triage, 1, "router model tier consulted once");
  const rr = bus.events.find((e) => e.type === "orchestration:route_resolved");
  assert.ok(rr, "route_resolved emitted");
  assert.equal(rr.data.tier, "model");
  assert.equal(rr.data.finalLane, "orchestrate");
  assert.equal(res.status, "complete");
  await kernel.dispose?.();
});

test("router.model.enabled=false: no triage call, no route_resolved, routes like today", async () => {
  const root = await tmpRoot();
  const calls = { triage: 0, plan: 0 };
  const bus = recordingBus();
  const kernel = await createKernel(root, {
    modelGateway: mockGateway({ triage: '{"lane":"single"}', calls }),
    eventBus: bus, sessionLog: null, branchStore: null, verifyMode: "off",
    orchestration: { router: { model: { enabled: false } } }
  });

  const res = await kernel.agent.send(AMBIG, { autonomy: "gated" });

  assert.equal(calls.triage, 0, "no model triage when disabled");
  assert.ok(!bus.events.some((e) => e.type === "orchestration:route_resolved"));
  assert.equal(res.status, "complete");   // heuristic: 这些 signal → orchestrate → completes
  await kernel.dispose?.();
});

test("triage garbage → heuristic fallback, no crash, route_resolved(fallback)", async () => {
  const root = await tmpRoot();
  const calls = { triage: 0, plan: 0 };
  const bus = recordingBus();
  const kernel = await createKernel(root, {
    modelGateway: mockGateway({ triage: "not json", calls }),
    eventBus: bus, sessionLog: null, branchStore: null, verifyMode: "off"
  });

  const res = await kernel.agent.send(AMBIG, { autonomy: "gated" });

  assert.ok(calls.triage >= 1, "triage attempted");
  const rr = bus.events.find((e) => e.type === "orchestration:route_resolved");
  assert.equal(rr.data.tier, "fallback");
  assert.equal(res.status, "complete");   // fallback: 这些 signal → orchestrate
  await kernel.dispose?.();
});
