import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createKernel } from "../../src/index.js";
import { mkdtemp } from "../helpers/tmp.js";

test("runtime loop executes read tool and feeds result back to model", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-loop-"));
  await writeFile(path.join(root, "README.md"), "hello runtime loop");
  let invokeCount = 0;
  const kernel = await createKernel(root, {
    sessionId: "sess_loop_read",
    modelGateway: {
      invoke: async (messages) => {
        invokeCount++;
        if (invokeCount === 1) {
          return { content: "", tool_calls: [{ id: "call_read", name: "read", arguments: { path: "README.md" } }] };
        }
        assert.ok(messages.some((message) => message.role === "tool" && message.content.includes("hello runtime loop")));
        return { content: "README says hello runtime loop", tool_calls: [] };
      },
      reply: async () => ({ content: "query fast path" })
    }
  });

  const result = await kernel.agent.send("inspect README", { autonomy: "gated" });

  assert.equal(result.status, "complete");
  assert.equal(result.content, "README says hello runtime loop");
  assert.equal(invokeCount, 2);
});

test("runtime loop executes edit tool and verifier after edit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-loop-edit-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  let invokeCount = 0;
  const diff = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new";
  const events = [];
  const kernel = await createKernel(root, {
    sessionId: "sess_loop_edit",
    modelGateway: {
      invoke: async () => {
        invokeCount++;
        if (invokeCount === 1) {
          return { content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff, prompt: "update a" } }] };
        }
        return { content: "updated a.txt", tool_calls: [] };
      },
      reply: async () => ({ content: "query fast path" })
    }
  });
  const sub = kernel.session.subscribe((event) => events.push(event));

  const result = await kernel.agent.send("modify a.txt", { autonomy: "gated" });
  sub.unsubscribe();

  assert.equal(result.status, "complete");
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "new\n");
  assert.ok(events.some((event) => event.type === "file:diff_applied"));
  assert.ok(events.some((event) => event.type === "verification:result"));
});

test("runtime loop stops for approval and does not write", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-loop-approval-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  const diff = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new";
  const kernel = await createKernel(root, {
    sessionId: "sess_loop_approval",
    modelGateway: {
      invoke: async () => ({ content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff } }] }),
      reply: async () => ({ content: "query fast path" })
    }
  });

  const result = await kernel.agent.send("modify a.txt", { autonomy: "supervised" });

  assert.equal(result.status, "awaiting_approval");
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "old\n");
});

test("runtime loop completes normally when verifier runs with auto autonomy", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-loop-verify-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  const diff = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new";
  let invokeCount = 0;
  const kernel = await createKernel(root, {
    sessionId: "sess_loop_verify",
    modelGateway: {
      invoke: async () => {
        invokeCount++;
        if (invokeCount === 1) {
          return { content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff, prompt: "update a" } }] };
        }
        return { content: "updated", tool_calls: [] };
      },
      reply: async () => ({ content: "query fast path" })
    }
  });

  // gated autonomy: verifier now runs with auto so detect-only test won't hang on approval
  const result = await kernel.agent.send("modify a.txt", { autonomy: "gated" });

  assert.equal(result.status, "complete");
  assert.ok(result.verification, "verification result must be present");
  assert.equal(result.verification.status, "passed");
});
