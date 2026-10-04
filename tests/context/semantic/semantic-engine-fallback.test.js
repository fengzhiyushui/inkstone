import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os"; import path from "node:path"; import { promises as fs } from "node:fs";
import { createSemanticEngine } from "../../../src/context/semantic/semantic-engine.js";
import { mkdtemp } from "../../helpers/tmp.js";

async function mkProject() {
  const root = await mkdtemp(path.join(os.tmpdir(), "sem-fallback-"));
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src", "a.js"), "export function alpha(){ beta(); }\nexport function beta(){}\n");
  return root;
}

const records = () => new Map([["src/a.js", { path: "src/a.js", hash: "sha256:x" }]]);
const ask = (engine) => engine.select({ message: "alpha", pinned: new Set(), warmed: new Map(), budget: 10000 });

test("provider load failure -> degrade: degraded event exactly-once with reason, no symbol events, select null", async () => {
  const root = await mkProject();
  const events = [];
  const eventBus = { publish: (t, d) => events.push(d ? `${t}:${d.reason}` : t) };
  const failing = {
    name: "failing-load",
    supports: () => true,
    load: async () => { throw new Error("grammar unavailable"); },
    parseTree: () => ({ ok: false, language: "js", tree: null })
  };
  const engine = createSemanticEngine({ root, options: { semantic: { enabled: true } }, eventBus, provider: failing });
  await engine.index(records());                       // must not throw
  assert.equal(events.includes("context:symbol_indexed"), false);
  assert.equal(events.includes("context:graph_built"), false);
  // exactly-once degraded event with reason
  const degraded = events.filter((e) => e.startsWith("context:semantic_degraded"));
  assert.equal(degraded.length, 1);
  assert.ok(degraded[0].includes("grammar unavailable"));
  // second scan does NOT re-publish
  await engine.index(records());
  const degraded2 = events.filter((e) => e.startsWith("context:semantic_degraded"));
  assert.equal(degraded2.length, 1);
  assert.equal(ask(engine), null);                     // -> caller falls back to file level
});

test("provider that parses nothing -> select null (file-level fallback), no crash", async () => {
  const root = await mkProject();
  const engine = createSemanticEngine({
    root,
    options: { semantic: { enabled: true } },
    provider: { name: "empty", supports: () => true, load: async () => {}, parseTree: () => ({ ok: false, language: "js", tree: null }) }
  });
  await engine.index(records());
  assert.equal(ask(engine), null);
});

test("sanity: a working injected provider DOES select the mentioned symbol", async () => {
  const root = await mkProject();
  const { createWasmTreeSitterProvider } = await import("../../../src/context/semantic/wasm-tree-sitter-provider.js");
  const engine = createSemanticEngine({ root, options: { semantic: { enabled: true } }, provider: createWasmTreeSitterProvider() });
  await engine.index(records());
  const out = ask(engine);
  assert.ok(out && out.selected.some((u) => u.name === "alpha"));   // proves injection is actually used
});
