import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os"; import path from "node:path"; import { promises as fs } from "node:fs";
import { createKernel } from "../../../src/index.js";
import { createOrchestrationPersistence } from "../../../src/core/recovery/orchestration-persistence.js";
import { mkdtemp } from "../../helpers/tmp.js";

function mockGateway(counters) {
  return {
    invoke: async (messages) => {
      const text = (messages || []).map((m) => m.content).join("\n");
      if (text.includes("Break the user's request")) { counters.plan += 1; return { content: JSON.stringify({ task_summary: "t", done_when: "d", subtasks: [
        { id: "st_a", goal: "edit a.js", acceptance: ["a edited"], context_scope: { files: ["a.js"] }, tool_profile: "edit", depends_on: [] }
      ] }), tool_calls: [] }; }
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

test("cross-instance: worker pauses in A, resumes to completion in B (plan once, edit merged, budget persisted)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "c-durable-e2e-"));
  await fs.writeFile(path.join(root, "a.js"), "base a\n");
  const cA = { plan: 0 }, cB = { plan: 0 };

  const a = await createKernel(root, { modelGateway: mockGateway(cA), sessionLog: null, branchStore: null, verifyMode: "off", projectId: "proj", sessionId: "sA", recovery: { enabled: true, lock: false, surface: "cli" } });
  const p = await a.agent.send("逐一处理 a.js 的输入校验", { autonomy: "supervised" });
  assert.equal(p.status, "awaiting_approval");
  assert.equal(cA.plan, 1);

  const store = createOrchestrationPersistence({ root, projectId: "proj" });
  const sidecar = await store.load(p.approval.id);
  assert.ok("quotaTokens" in sidecar.budget && "spentTokens" in sidecar.budget && "spentCalls" in sidecar.budget, "budget quota+spend serialized (edge⑤ shape)");

  await a.dispose?.();   // preserve sidecars, release lock

  const b = await createKernel(root, { modelGateway: mockGateway(cB), sessionLog: null, branchStore: null, verifyMode: "off", projectId: "proj", sessionId: "sB", recovery: { enabled: true, lock: false, surface: "cli" } });
  const items = await b.recovery.list();
  assert.ok(items.find((i) => i.type === "orchestration_paused" && i.source_id === p.approval.id), "orchestration_paused registered on restart");

  const resumed = await b.recovery.resume(`rec_orch_${p.approval.id}`, { decision: "approve" });
  assert.equal(resumed.status, "resumed");
  assert.equal(resumed.result.status, "complete");
  assert.equal(await fs.readFile(path.join(root, "a.js"), "utf8"), "edited a\n");   // edit merged to main
  assert.equal(cB.plan, 0, "no re-plan on durable resume (plan across instances = 1)");

  const after = await store.scan();
  assert.ok(after.every((s) => s.approvalId !== p.approval.id || s.status === "consumed"), "orchestration sidecar consumed");
  await b.dispose?.();
});

test("recovery off: orchestration pause stays in-memory (C5), no durable sidecar, same-process approve completes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "c-durable-off-"));
  await fs.writeFile(path.join(root, "a.js"), "base a\n");
  const counters = { plan: 0 };
  const kernel = await createKernel(root, { modelGateway: mockGateway(counters), eventBus: { publish() {}, subscribe: () => () => {} }, sessionLog: null, branchStore: null, verifyMode: "off", projectId: "proj" });
  const p = await kernel.agent.send("逐一处理 a.js 的输入校验", { autonomy: "supervised" });
  assert.equal(p.status, "awaiting_approval");
  assert.equal(await exists(path.join(root, ".deepseek-code", "v2", "sessions", "proj", "orchestration-paused")), false);
  const done = await kernel.agent.approve(p.approval.id, "approve");   // C5 in-memory resume
  assert.equal(done.status, "complete");
  assert.equal(await fs.readFile(path.join(root, "a.js"), "utf8"), "edited a\n");
  assert.equal(counters.plan, 1);
  await kernel.dispose?.();
});
