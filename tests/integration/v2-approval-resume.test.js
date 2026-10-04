import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createKernel } from "../../src/index.js";
import { mkdtemp } from "../helpers/tmp.js";

const DIFF = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new";

test("kernel approval resumes supervised edit and applies file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-approval-resume-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  let invokeCount = 0;
  const events = [];
  const kernel = await createKernel(root, {
    sessionRoot: path.join(root, ".sessions"),
    sessionId: "sess_approval_resume",
    modelGateway: {
      invoke: async () => {
        invokeCount += 1;
        if (invokeCount === 1) {
          return { content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: DIFF, prompt: "update a" } }] };
        }
        return { content: "updated a.txt", tool_calls: [] };
      },
      reply: async () => ({ content: "fast" })
    }
  });
  const sub = kernel.session.subscribe((event) => events.push(event));

  const paused = await kernel.agent.send("modify a.txt", { autonomy: "supervised" });
  assert.equal(paused.status, "awaiting_approval");
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "old\n");

  const resumed = await kernel.agent.approve(paused.approval.id, "approve");
  sub.unsubscribe();

  assert.equal(resumed.status, "complete");
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "new\n");
  assert.ok(events.some((event) => event.type === "approval:requested"));
  assert.ok(events.some((event) => event.type === "approval:resolved"));
  assert.ok(events.some((event) => event.type === "tool:result" && event.result?.status === "success"));
  assert.ok(events.some((event) => event.type === "agent:final"));
});

test("kernel approval deny leaves file unchanged", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-approval-deny-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  const kernel = await createKernel(root, {
    sessionRoot: path.join(root, ".sessions"),
    sessionId: "sess_approval_deny",
    modelGateway: {
      invoke: async () => ({ content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: DIFF, prompt: "update a" } }] }),
      reply: async () => ({ content: "fast" })
    }
  });

  const paused = await kernel.agent.send("modify a.txt", { autonomy: "supervised" });
  const denied = await kernel.agent.approve(paused.approval.id, "deny");

  assert.equal(denied.status, "cancelled");
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "old\n");
});

test("kernel rejects duplicate approval", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-approval-duplicate-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  let invokeCount = 0;
  const kernel = await createKernel(root, {
    sessionRoot: path.join(root, ".sessions"),
    sessionId: "sess_approval_duplicate",
    modelGateway: {
      invoke: async () => {
        invokeCount += 1;
        if (invokeCount === 1) {
          return { content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: DIFF, prompt: "update a" } }] };
        }
        return { content: "done", tool_calls: [] };
      },
      reply: async () => ({ content: "fast" })
    }
  });

  const paused = await kernel.agent.send("modify a.txt", { autonomy: "supervised" });
  await kernel.agent.approve(paused.approval.id, "approve");

  await assert.rejects(
    () => kernel.agent.approve(paused.approval.id, "approve"),
    /approval not found/
  );
});

test("approval resume timeline persists requested resolved tool and final events", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-approval-timeline-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  let invokeCount = 0;
  const kernel = await createKernel(root, {
    sessionRoot: path.join(root, ".sessions"),
    sessionId: "sess_approval_timeline",
    modelGateway: {
      invoke: async () => {
        invokeCount += 1;
        if (invokeCount === 1) {
          return { content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: DIFF, prompt: "update a" } }] };
        }
        return { content: "updated", tool_calls: [] };
      },
      reply: async () => ({ content: "fast" })
    }
  });

  const paused = await kernel.agent.send("modify a.txt", { autonomy: "supervised" });
  await kernel.agent.approve(paused.approval.id, "approve");
  await kernel.session.flush();
  const timeline = await kernel.session.getTimeline(50);
  const types = timeline.map((event) => event.type);

  assert.ok(types.includes("approval:requested"));
  assert.ok(types.includes("approval:resolved"));
  assert.ok(types.includes("tool:result"));
  assert.ok(types.includes("agent:final"));
});
