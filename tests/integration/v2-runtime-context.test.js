import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createKernel } from "../../src/index.js";
import { mkdtemp } from "../helpers/tmp.js";

test("runtime first tool-loop model call receives context summary", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-runtime-context-"));
  await writeFile(path.join(root, "package.json"), "{\"name\":\"demo\"}\n");
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "index.js"), "export const demo = true;\n");
  let firstMessages = null;
  const kernel = await createKernel(root, {
    sessionRoot: path.join(root, ".sessions"),
    modelGateway: {
      invoke: async (messages) => {
        firstMessages = firstMessages || messages;
        return { content: "done", tool_calls: [] };
      },
      reply: async () => ({ content: "query" })
    }
  });

  const result = await kernel.agent.send("modify src/index.js", { autonomy: "gated" });

  assert.equal(result.status, "complete");
  assert.ok(firstMessages[0].content.includes("Project context:"));
  assert.ok(firstMessages[0].content.includes("src/index.js"));
});

test("runtime query fast path receives context summary", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-runtime-query-context-"));
  await writeFile(path.join(root, "README.md"), "# query context\n");
  let receivedContext = null;
  const kernel = await createKernel(root, {
    sessionRoot: path.join(root, ".sessions"),
    modelGateway: {
      reply: async ({ context }) => {
        receivedContext = context;
        return { content: "answer" };
      },
      invoke: async () => ({ content: "slow", tool_calls: [] })
    }
  });

  const result = await kernel.agent.send("what is this project?");

  assert.equal(result.status, "complete");
  assert.ok(receivedContext.summary.includes("README.md"));
  assert.equal(receivedContext.channel, "reply");
});

test("repair prompt receives context summary from runtime", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-runtime-repair-context-"));
  await writeFile(path.join(root, "package.json"), "{\"scripts\":{\"test\":\"node --test\"}}\n");
  await writeFile(path.join(root, "a.txt"), "old\n");
  let repairPayload = null;
  let invokeCount = 0;
  const diff = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+broken";
  const kernel = await createKernel(root, {
    sessionRoot: path.join(root, ".sessions"),
    verifyMode: "run",
    maxRepairAttempts: 1,
    modelGateway: {
      invoke: async (messages, options = {}) => {
        if (options.purpose === "repair") {
          repairPayload = JSON.parse(messages[1].content);
          return { content: "no repair", tool_calls: [] };
        }
        invokeCount += 1;
        if (invokeCount === 1) {
          return { content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff, prompt: "break a" } }] };
        }
        return { content: "done", tool_calls: [] };
      },
      reply: async () => ({ content: "query" })
    },
    testArgv: ["node", "-e", "process.exit(1)"]
  });

  await assert.rejects(
    () => kernel.agent.send("modify a.txt", { autonomy: "gated", verifyMode: "run" }),
    /verification failed|repair/i
  );

  assert.ok(repairPayload.context_summary.includes("package.json"));
});
