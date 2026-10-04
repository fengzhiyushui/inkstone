import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runKernelAgentCommand } from "../../src/apps/cli/kernel-runner.js";
import { mkdtemp } from "../helpers/tmp.js";

test("CLI kernel runner can drive a V2 read tool loop", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-cli-runner-"));
  await writeFile(path.join(root, "README.md"), "hello cli runner");
  let invokeCount = 0;
  const lines = [];

  const result = await runKernelAgentCommand({
    root,
    prompt: "inspect README",
    write: (line) => lines.push(line),
    createKernelOptions: {
      sessionId: "sess_cli_runner",
      modelGateway: {
        invoke: async (messages) => {
          invokeCount++;
          if (invokeCount === 1) {
            return { content: "", tool_calls: [{ id: "call_read", name: "read", arguments: { path: "README.md" } }] };
          }
          assert.ok(messages.some((message) => message.role === "tool" && message.content.includes("hello cli runner")));
          return { content: "README inspected", tool_calls: [] };
        },
        reply: async () => ({ content: "fast" })
      }
    }
  });

  assert.equal(result.status, "complete");
  assert.equal(result.content, "README inspected");
  assert.equal(invokeCount, 2);
  assert.ok(lines.some((line) => line.includes("README inspected")));
});
