import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createKernel } from "../../src/index.js";
import { createPausedTurnPersistence } from "../../src/core/recovery/paused-turn-persistence.js";
import { createRecoveryFaults } from "../../src/core/recovery/recovery-faults.js";
import { mkdtemp } from "../helpers/tmp.js";

const DIFF = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new";

test("paused sidecar stores original autonomy and project id for resume", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-durable-pause-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  const kernel = await createKernel(root, {
    sessionRoot: path.join(root, ".deepseek-code", "v2", "sessions"),
    sessionId: "sess_original",
    projectId: "proj_test",
    recovery: { enabled: true, surface: "cli", lock: false },
    modelGateway: {
      invoke: async () => ({ content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: DIFF, prompt: "update" } }] }),
      reply: async () => ({ content: "fast" })
    }
  });

  const paused = await kernel.agent.send("modify", { autonomy: "supervised" });
  const items = await kernel.recovery.list();
  const sidecar = await createPausedTurnPersistence({ root, projectId: "proj_test" }).load(paused.approval.id);

  assert.equal(paused.status, "awaiting_approval");
  assert.equal(items[0].type, "paused_turn");
  assert.equal(items[0].source_id, paused.approval.id);
  assert.equal(items[0].metadata.autonomy, "supervised");
  assert.equal(sidecar.permission_context.autonomy, "supervised");
  assert.equal(sidecar.permission_context.project_id, "proj_test");
});

test("recovery facade rehydrates paused sidecar and resumes under stored context", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-durable-rehydrate-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  const first = await createKernel(root, {
    sessionRoot: path.join(root, ".deepseek-code", "v2", "sessions"),
    sessionId: "sess_original",
    projectId: "proj_test",
    recovery: { enabled: true, surface: "cli", lock: false },
    modelGateway: {
      invoke: async () => ({ content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: DIFF, prompt: "update" } }] }),
      reply: async () => ({ content: "fast" })
    }
  });

  const paused = await first.agent.send("modify", { autonomy: "supervised" });
  const second = await createKernel(root, {
    sessionRoot: path.join(root, ".deepseek-code", "v2", "sessions"),
    sessionId: "sess_restart",
    projectId: "proj_test",
    recovery: { enabled: true, surface: "cli", lock: false },
    modelGateway: {
      invoke: async () => ({ content: "updated", tool_calls: [] }),
      reply: async () => ({ content: "fast" })
    }
  });

  const resumed = await second.recovery.resume(`rec_pause_${paused.approval.id}`);
  const items = await second.recovery.list();
  const timeline = await second.session.getTimeline({ count: 100, all_branches: true });

  assert.equal(resumed.status, "resumed");
  assert.equal(resumed.result.status, "complete");
  assert.deepEqual(items, []);
  assert.ok(timeline.some((event) => event.type === "turn:resumed" && event.approval_id === paused.approval.id));
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "new\n");
});

test("recovery facade quarantines corrupt paused sidecar on cancel", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-durable-corrupt-cancel-"));
  const store = createPausedTurnPersistence({ root, projectId: "proj_test" });
  await store.writeRawForTest("approval_bad", "{ bad json");
  const kernel = await createKernel(root, {
    sessionRoot: path.join(root, ".deepseek-code", "v2", "sessions"),
    sessionId: "sess_corrupt",
    projectId: "proj_test",
    recovery: { enabled: true, surface: "cli", lock: false },
    modelGateway: {
      invoke: async () => ({ content: "unused", tool_calls: [] }),
      reply: async () => ({ content: "fast" })
    }
  });

  const items = await kernel.recovery.list();
  const cancelled = await kernel.recovery.cancel("rec_pause_approval_bad", "operator cancelled corrupt sidecar");
  const sourceExists = await exists(path.join(store.baseDir, "approval_bad.json"));
  const quarantineExists = await exists(path.join(store.baseDir, "quarantine", "approval_bad.json"));

  assert.equal(items[0].status, "blocked");
  assert.deepEqual(items[0].allowed_actions, ["cancel"]);
  assert.equal(cancelled.status, "quarantined");
  assert.equal(sourceExists, false);
  assert.equal(quarantineExists, true);
});

test("recovery facade does not rehydrate consumed paused sidecar after delete failure", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-durable-consumed-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  const faults = createRecoveryFaults({ labels: ["before-paused-sidecar-delete"] });
  const first = await createKernel(root, {
    sessionRoot: path.join(root, ".deepseek-code", "v2", "sessions"),
    sessionId: "sess_original",
    projectId: "proj_test",
    recovery: { enabled: true, surface: "cli", faults },
    modelGateway: {
      invoke: async () => ({ content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: DIFF, prompt: "update" } }] }),
      reply: async () => ({ content: "fast" })
    }
  });

  const paused = await first.agent.send("modify", { autonomy: "supervised", maxToolIterations: 1 });
  await assert.rejects(
    () => first.agent.approve(paused.approval.id, "approve"),
    /maximum tool iterations exceeded/
  );

  const store = createPausedTurnPersistence({ root, projectId: "proj_test" });
  const scanned = await store.scan();
  const second = await createKernel(root, {
    sessionRoot: path.join(root, ".deepseek-code", "v2", "sessions"),
    sessionId: "sess_restart",
    projectId: "proj_test",
    recovery: { enabled: true, surface: "cli", lock: false },
    modelGateway: {
      invoke: async () => ({ content: "unused", tool_calls: [] }),
      reply: async () => ({ content: "fast" })
    }
  });

  const items = await second.recovery.list();
  await assert.rejects(
    () => second.recovery.resume(`rec_pause_${paused.approval.id}`),
    /approval not found/
  );

  assert.equal(scanned[0].status, "consumed");
  assert.equal(scanned[0].approval_id, paused.approval.id);
  assert.deepEqual(items, []);
  assert.equal(faults.hitCount("before-paused-sidecar-delete"), 1);
});

test("recovery facade does not rehydrate denied paused sidecar after delete failure", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-durable-denied-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  const faults = createRecoveryFaults({ labels: ["before-paused-sidecar-delete"] });
  const first = await createKernel(root, {
    sessionRoot: path.join(root, ".deepseek-code", "v2", "sessions"),
    sessionId: "sess_original",
    projectId: "proj_test",
    recovery: { enabled: true, surface: "cli", faults },
    modelGateway: {
      invoke: async () => ({ content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: DIFF, prompt: "update" } }] }),
      reply: async () => ({ content: "fast" })
    }
  });

  const paused = await first.agent.send("modify", { autonomy: "supervised" });
  const denied = await first.agent.approve(paused.approval.id, "deny");

  const store = createPausedTurnPersistence({ root, projectId: "proj_test" });
  const scanned = await store.scan();
  const second = await createKernel(root, {
    sessionRoot: path.join(root, ".deepseek-code", "v2", "sessions"),
    sessionId: "sess_restart",
    projectId: "proj_test",
    recovery: { enabled: true, surface: "cli", lock: false },
    modelGateway: {
      invoke: async () => ({ content: "unused", tool_calls: [] }),
      reply: async () => ({ content: "fast" })
    }
  });

  const items = await second.recovery.list();
  await assert.rejects(
    () => second.recovery.resume(`rec_pause_${paused.approval.id}`),
    /approval not found/
  );

  assert.equal(denied.status, "cancelled");
  assert.equal(scanned[0].status, "consumed");
  assert.equal(scanned[0].approval_id, paused.approval.id);
  assert.deepEqual(items, []);
  assert.equal(faults.hitCount("before-paused-sidecar-delete"), 1);
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "old\n");
});

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
