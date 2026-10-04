import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createKernel } from "../../src/index.js";
import { mkdtemp } from "../helpers/tmp.js";

test("kernel context snapshot returns real workspace units", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-kernel-context-"));
  await writeFile(path.join(root, "package.json"), "{\"name\":\"demo\"}\n");
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "index.js"), "export const demo = true;\n");
  const kernel = await createKernel(root, {
    sessionRoot: path.join(root, ".sessions"),
    modelGateway: { reply: async () => ({ content: "ok" }) }
  });

  const snapshot = await kernel.context.snapshot({
    message: "modify src/index.js",
    classification: { task_type: "edit" },
    channel: "act"
  });

  assert.notEqual(snapshot.snapshot_id, "v2_empty_snapshot");
  assert.ok(snapshot.units.some((unit) => unit.path === "package.json"));
  assert.ok(snapshot.units.some((unit) => unit.path === "src/index.js"));
  assert.ok(snapshot.summary.includes("src/index.js"));
});

test("kernel context pin affects next snapshot and persists safe events", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-kernel-context-events-"));
  await writeFile(path.join(root, "README.md"), "# demo\n");
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "a.js"), "export const a = 1;\n");
  const kernel = await createKernel(root, {
    sessionRoot: path.join(root, ".sessions"),
    modelGateway: { reply: async () => ({ content: "ok" }) }
  });

  kernel.context.pin("src/a.js");
  const snapshot = await kernel.context.snapshot({
    message: "change code",
    classification: { task_type: "edit" },
    channel: "act"
  });
  await kernel.session.flush();
  const timeline = await kernel.session.getTimeline(20);

  assert.ok(snapshot.units.some((unit) => unit.path === "src/a.js" && unit.reason === "pinned"));
  const contextEvents = timeline.filter((event) => event.type.startsWith("context:"));
  assert.ok(contextEvents.some((event) => event.type === "context:pin"));
  assert.ok(contextEvents.some((event) => event.type === "context:snapshot"));
  assert.equal(JSON.stringify(contextEvents).includes("export const a"), false);
  assert.equal(JSON.stringify(contextEvents).includes("Relevant snippets"), false);
});

test("kernel can disable context for focused tests", async () => {
  const kernel = await createKernel(process.cwd(), {
    sessionLog: null,
    context: { disabled: true },
    modelGateway: { reply: async () => ({ content: "ok" }) }
  });

  const snapshot = await kernel.context.snapshot({ channel: "act", classification: { task_type: "edit" } });

  assert.equal(snapshot.snapshot_id, "v2_context_disabled");
  assert.deepEqual(snapshot.units, []);
});
