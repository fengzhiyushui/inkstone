import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createKernel } from "../../src/index.js";
import { createEventBus } from "../../src/shared/event-bus.js";
import { createEditService } from "../../src/edits/edit-service.js";
import { createBuiltinTools } from "../../src/tools/builtin/index.js";
import { createToolRegistry } from "../../src/tools/registry.js";
import { mkdtemp } from "../helpers/tmp.js";

const BROKEN_DIFF = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+broken";
const REPAIR_DIFF = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-broken\n+fixed";

function createKernelWithFakeTest(root, { modelGateway, testResults, sessionId }) {
  const eventBus = createEventBus();
  let testRuns = 0;
  const editService = createEditService({ projectRoot: root, eventBus });
  const fakeTestTool = {
    name: "test",
    description: "Fake integration test runner",
    category: "execute",
    side_effect: "process",
    risk_level: "low",
    source: "test",
    version: "2.0",
    params: {
      detect: { type: "boolean", required: false, default: true },
      argv: { type: "array", required: false }
    },
    execute: async () => {
      const next = testResults[Math.min(testRuns, testResults.length - 1)];
      testRuns += 1;
      return {
        status: "success",
        content: [{ type: "text", text: next.text }],
        metadata: { exit_code: next.exit_code, run: testRuns }
      };
    }
  };
  const tools = createBuiltinTools({ editService }).filter((tool) => tool.name !== "test");
  const toolRegistry = createToolRegistry({ tools: [...tools, fakeTestTool] });

  return createKernel(root, {
    eventBus,
    editService,
    toolRegistry,
    sessionRoot: path.join(root, ".sessions"),
    sessionId,
    verifyMode: "run",
    maxRepairAttempts: 1,
    modelGateway
  });
}

test("kernel repair loop applies repair edit after failed verification", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-repair-loop-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  let invokeCount = 0;
  const kernel = await createKernelWithFakeTest(root, {
    sessionId: "sess_repair_loop",
    testResults: [
      { exit_code: 1, text: "failed" },
      { exit_code: 0, text: "passed" }
    ],
    modelGateway: {
      invoke: async (_messages, options = {}) => {
        if (options.purpose === "repair") {
          return { content: "", tool_calls: [{ id: "call_repair", name: "edit", arguments: { diff: REPAIR_DIFF, prompt: "repair a" } }] };
        }
        invokeCount += 1;
        if (invokeCount === 1) {
          return { content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: BROKEN_DIFF, prompt: "break a" } }] };
        }
        return { content: "done", tool_calls: [] };
      },
      reply: async () => ({ content: "fast" })
    }
  });

  const result = await kernel.agent.send("modify a.txt", { autonomy: "gated", verifyMode: "run" });

  assert.equal(result.status, "complete");
  assert.equal(result.verification.status, "passed");
  assert.equal(result.repair.status, "complete");
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "fixed\n");
});

test("repair timeline persists repair events", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-repair-timeline-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  let invokeCount = 0;
  const kernel = await createKernelWithFakeTest(root, {
    sessionId: "sess_repair_timeline",
    testResults: [
      { exit_code: 1, text: "failed" },
      { exit_code: 1, text: "still failed" }
    ],
    modelGateway: {
      invoke: async (_messages, options = {}) => {
        if (options.purpose === "repair") {
          return { content: "no repair", tool_calls: [] };
        }
        invokeCount += 1;
        if (invokeCount === 1) {
          return { content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: BROKEN_DIFF, prompt: "break a" } }] };
        }
        return { content: "done", tool_calls: [] };
      },
      reply: async () => ({ content: "fast" })
    }
  });

  await assert.rejects(
    () => kernel.agent.send("modify a.txt", { autonomy: "gated", verifyMode: "run" }),
    /verification failed|repair/i
  );
  await kernel.session.flush();
  const types = (await kernel.session.getTimeline(50)).map((event) => event.type);

  assert.ok(types.includes("repair:started"));
  assert.ok(types.includes("repair:attempt"));
  assert.ok(types.includes("repair:result"));
  assert.ok(types.includes("repair:exhausted"));
});

test("query fast path does not enter repair loop", async () => {
  let invokeCalled = false;
  const kernel = await createKernel(process.cwd(), {
    sessionLog: null,
    context: { disabled: true },
    modelGateway: {
      reply: async () => ({ content: "query answer" }),
      invoke: async () => {
        invokeCalled = true;
        return { content: "tool path" };
      }
    }
  });

  const result = await kernel.agent.send("what is this project?");

  assert.equal(result.status, "complete");
  assert.equal(result.content, "query answer");
  assert.equal(invokeCalled, false);
});
