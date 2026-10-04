import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createKernel } from "../../src/index.js";
import { createToolCall } from "../../src/core/protocol/index.js";
import { mkdtemp } from "../helpers/tmp.js";

test("kernel exposes V2 tool list and executes read tool", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-kernel-tools-"));
  await writeFile(path.join(root, "README.md"), "hello tools", "utf8");
  const kernel = await createKernel(root, { sessionId: "sess_tools" });

  assert.ok(kernel.tools.list().some((tool) => tool.name === "read"));

  const result = await kernel.tools.execute(
    createToolCall({ name: "read", params: { path: "README.md" }, requestedByStepId: "step_1" }),
    { autonomy: "gated", turnId: "turn_1" }
  );

  assert.equal(result.status, "success");
  assert.equal(result.content[0].text, "hello tools");
});

test("kernel tool execution emits session events", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-kernel-tools-"));
  await writeFile(path.join(root, "README.md"), "hello events", "utf8");
  const kernel = await createKernel(root, { sessionId: "sess_tools_events" });
  const events = [];
  const sub = kernel.session.subscribe((event) => events.push(event));

  await kernel.tools.execute(
    createToolCall({ name: "read", params: { path: "README.md" }, requestedByStepId: "step_1" }),
    { autonomy: "gated", turnId: "turn_1" }
  );
  sub.unsubscribe();

  assert.ok(events.some((event) => event.type === "tool:call"));
  assert.ok(events.some((event) => event.type === "permission:decision"));
  assert.ok(events.some((event) => event.type === "tool:result"));
});

test("kernel tool execution returns approval_required for supervised shell", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-kernel-tools-"));
  const kernel = await createKernel(root, { sessionId: "sess_tools_shell" });

  const result = await kernel.tools.execute(
    createToolCall({ name: "shell", params: { argv: [process.execPath, "--version"] }, requestedByStepId: "step_1" }),
    { autonomy: "supervised", turnId: "turn_1" }
  );

  assert.equal(result.status, "approval_required");
});
