import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os"; import path from "node:path"; import { promises as fs } from "node:fs";
import { createContextEngine } from "../../../src/context/index.js";
import { mkdtemp } from "../../helpers/tmp.js";

test("disabled semantic emits no symbol/graph events", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "parity-"));
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src", "a.js"), "export function a(){}\n");
  const events = [];
  const eventBus = { publish: (t) => events.push(t) };
  const engine = createContextEngine({ root, eventBus, options: {} });
  await engine.scan();
  await engine.snapshot({ message: "a", channel: "reply" });
  assert.equal(events.includes("context:symbol_indexed"), false);
  assert.equal(events.includes("context:graph_built"), false);
});
