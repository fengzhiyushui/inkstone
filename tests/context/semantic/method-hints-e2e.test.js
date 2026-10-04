import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os"; import path from "node:path"; import { promises as fs } from "node:fs";
import { createSemanticEngine } from "../../../src/context/semantic/semantic-engine.js";
import { createWasmTreeSitterProvider } from "../../../src/context/semantic/wasm-tree-sitter-provider.js";
import { mkdtemp } from "../../helpers/tmp.js";

async function project() {
  const root = await mkdtemp(path.join(os.tmpdir(), "mhints-"));
  await fs.mkdir(path.join(root, "src"));
  // seed() makes a member call to a uniquely-named function helperUnique
  await fs.writeFile(path.join(root, "src", "a.js"), "export function seed(){ x.helperUnique(); }\nexport function helperUnique(){}\n");
  return root;
}
const records = () => new Map([["src/a.js", { path: "src/a.js", hash: "sha256:x" }]]);
const ask = (e) => e.select({ message: "seed", pinned: new Set(), warmed: new Map(), budget: 10000 });

test("includeMethodHints ON -> member call surfaces helperUnique as probable neighbor", async () => {
  const root = await project();
  const engine = createSemanticEngine({ root, options: { semantic: { enabled: true, includeMethodHints: true } }, provider: createWasmTreeSitterProvider() });
  await engine.index(records());
  const out = ask(engine);
  const helper = out?.selected.find((u) => u.name === "helperUnique");
  assert.ok(helper, "helperUnique should be selected via probable member-hint edge");
  assert.equal(helper.reason, "graph-neighbor-probable");
});

test("includeMethodHints OFF -> member call stays unresolved, helperUnique not expanded", async () => {
  const root = await project();
  const engine = createSemanticEngine({ root, options: { semantic: { enabled: true, includeMethodHints: false } }, provider: createWasmTreeSitterProvider() });
  await engine.index(records());
  const out = ask(engine);
  // only the mentioned seed symbol is selected; no probable expansion
  assert.equal(out?.selected.some((u) => u.name === "helperUnique"), false);
});
