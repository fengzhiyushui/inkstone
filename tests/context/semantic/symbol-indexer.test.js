import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os"; import path from "node:path"; import { promises as fs } from "node:fs";
import { createSymbolCache } from "../../../src/context/semantic/symbol-cache.js";
import { createWasmTreeSitterProvider } from "../../../src/context/semantic/wasm-tree-sitter-provider.js";
import { createLanguageRegistry } from "../../../src/context/semantic/language-registry.js";
import { indexSymbols } from "../../../src/context/semantic/symbol-indexer.js";
import { mkdtemp } from "../../helpers/tmp.js";

test("indexes only supported files; populates symbol table; reuses cache", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "symidx-"));
  const provider = createWasmTreeSitterProvider();
  await provider.load();
  const registry = createLanguageRegistry();
  const cache = createSymbolCache({ cacheRoot: root });
  const sources = { "src/a.js": "export function main(){ foo(); }", "README.md": "# hi" };
  const records = new Map([
    ["src/a.js", { path: "src/a.js", hash: "sha256:aaa" }],
    ["README.md", { path: "README.md", hash: "sha256:bbb" }]
  ]);
  let reads = 0;
  const readFile = async (f) => { reads += 1; return sources[f]; };

  const first = await indexSymbols({ root, records, provider, registry, cache, readFile });
  assert.ok([...first.symbolTable.values()].some((s) => s.name === "main"));
  assert.equal(first.byFile.has("README.md"), false); // unsupported ext skipped
  assert.equal(reads, 1);                              // only the supported file was read
  const readsAfterFirst = reads;

  const second = await indexSymbols({ root, records, provider, registry, cache, readFile });
  assert.ok(second.stats.reused >= 1);
  assert.equal(reads, readsAfterFirst);                // cache hit -> no new file reads
  assert.ok([...second.symbolTable.values()].some((s) => s.name === "main"));
});
