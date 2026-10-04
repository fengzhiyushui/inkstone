import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os"; import path from "node:path"; import { promises as fs } from "node:fs";
import { createSemanticEngine } from "../../../src/context/semantic/semantic-engine.js";
import { createWasmTreeSitterProvider } from "../../../src/context/semantic/wasm-tree-sitter-provider.js";
import { mkdtemp } from "../../helpers/tmp.js";

// pkg/a.py defines helper(); pkg/b.py does `from .a import helper` then calls it.
// With Python module resolution wired in, the call b.main -> a.helper is a resolved
// import-binding edge, so selecting on "main" expands to helper as a resolved neighbor.
async function project() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pybind-"));
  await fs.mkdir(path.join(root, "pkg"));
  await fs.writeFile(path.join(root, "pkg", "__init__.py"), "");
  await fs.writeFile(path.join(root, "pkg", "a.py"), "def helper():\n    return 1\n");
  await fs.writeFile(path.join(root, "pkg", "b.py"), "from .a import helper\ndef main():\n    helper()\n");
  return root;
}
const records = () => new Map([
  ["pkg/__init__.py", { path: "pkg/__init__.py", hash: "sha256:i" }],
  ["pkg/a.py", { path: "pkg/a.py", hash: "sha256:a" }],
  ["pkg/b.py", { path: "pkg/b.py", hash: "sha256:b" }]
]);
const ask = (e) => e.select({ message: "main", pinned: new Set(), warmed: new Map(), budget: 10000 });

test("Python relative import binds across files -> helper is a resolved neighbor", async () => {
  const root = await project();
  const engine = createSemanticEngine({ root, options: { semantic: { enabled: true, includeMethodHints: false, importRoots: [] } }, provider: createWasmTreeSitterProvider() });
  await engine.index(records());
  const out = ask(engine);
  const helper = out?.selected.find((u) => u.name === "helper");
  assert.ok(helper, "helper should be selected via resolved import-binding edge");
  assert.equal(helper.reason, "graph-neighbor");
});
