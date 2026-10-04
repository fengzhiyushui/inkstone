import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os"; import path from "node:path"; import { promises as fs } from "node:fs";
import { createKernel } from "../../../src/index.js";
import { mkdtemp } from "../../helpers/tmp.js";

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
const exists = async (p) => { try { await fs.stat(p); return true; } catch (e) { if (e.code === "ENOENT") return false; throw e; } };
async function fixture() { const root = await mkdtemp(path.join(os.tmpdir(), "m7-wire-")); await fs.writeFile(path.join(root, "a.js"), "base a\n"); return root; }
const sidecars = (root) => ({
  worker: (id) => path.join(root, ".deepseek-code", "v2", "sessions", "proj", "paused", `${id}.json`),
  orch: (id) => path.join(root, ".deepseek-code", "v2", "sessions", "proj", "orchestration-paused", `${id}.json`),
  orchDir: path.join(root, ".deepseek-code", "v2", "sessions", "proj", "orchestration-paused")
});

test("recovery ON: orchestration worker pause writes BOTH worker and orchestration sidecars", async () => {
  const root = await fixture();
  const kernel = await createKernel(root, { modelGateway: mockGateway(), sessionLog: null, branchStore: null, verifyMode: "off", projectId: "proj", sessionId: "s", recovery: { enabled: true, lock: false, surface: "cli" } });
  const p = await kernel.agent.send("逐一处理 a.js 的输入校验", { autonomy: "supervised" });
  assert.equal(p.status, "awaiting_approval");
  const s = sidecars(root);
  assert.equal(await exists(s.worker(p.approval.id)), true, "worker sidecar written");
  assert.equal(await exists(s.orch(p.approval.id)), true, "orchestration sidecar written");
  await kernel.dispose?.();
});

test("recovery OFF: no orchestration-paused dir created (zero regression)", async () => {
  const root = await fixture();
  const kernel = await createKernel(root, { modelGateway: mockGateway(), eventBus: { publish() {}, subscribe: () => () => {} }, sessionLog: null, branchStore: null, verifyMode: "off", projectId: "proj" });
  const p = await kernel.agent.send("逐一处理 a.js 的输入校验", { autonomy: "supervised" });
  assert.equal(p.status, "awaiting_approval");
  assert.equal(await exists(sidecars(root).orchDir), false);
  await kernel.dispose?.();
});

test("recovery ON: a restart kernel lists the orchestration_paused recovery item", async () => {
  const root = await fixture();
  const a = await createKernel(root, { modelGateway: mockGateway(), sessionLog: null, branchStore: null, verifyMode: "off", projectId: "proj", sessionId: "sA", recovery: { enabled: true, lock: false, surface: "cli" } });
  const p = await a.agent.send("逐一处理 a.js 的输入校验", { autonomy: "supervised" });
  assert.equal(p.status, "awaiting_approval");
  await a.dispose?.();

  const b = await createKernel(root, { modelGateway: mockGateway(), sessionLog: null, branchStore: null, verifyMode: "off", projectId: "proj", sessionId: "sB", recovery: { enabled: true, lock: false, surface: "cli" } });
  const items = await b.recovery.list();
  assert.ok(items.some((i) => i.type === "orchestration_paused" && i.source_id === p.approval.id));
  assert.equal(items.some((i) => i.type === "paused_turn" && i.source_id === p.approval.id), false, "orchestration worker never leaks as single-agent (CST-4)");
  await b.dispose?.();
});
