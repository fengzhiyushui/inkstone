import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os"; import path from "node:path"; import { promises as fs } from "node:fs";
import { createContextEngine } from "../../src/context/index.js";
import { mkdtemp } from "../helpers/tmp.js";

async function project() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ctx-sem-"));
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src", "a.js"), "export function alpha(){ beta(); }\nexport function beta(){}\n");
  return root;
}

test("semantic disabled -> snapshot units are file-level (unchanged)", async () => {
  const root = await project();
  const engine = createContextEngine({ root, options: {} });
  await engine.scan();
  const snap = await engine.snapshot({ message: "alpha", channel: "reply" });
  assert.ok(snap.units.every((u) => !u.type || u.type === "file"));
});

test("semantic enabled -> snapshot can include symbol units", async () => {
  const root = await project();
  const events = [];
  const eventBus = { publish: (t, p) => events.push(t) };
  const engine = createContextEngine({ root, eventBus, options: { semantic: { enabled: true, hops: 2, maxSymbols: 50, includeMethodHints: false } } });
  await engine.scan();
  const snap = await engine.snapshot({ message: "alpha", channel: "reply" });
  assert.ok(snap.units.some((u) => u.type === "symbol"));
  assert.ok(events.includes("context:symbol_indexed"));
});
