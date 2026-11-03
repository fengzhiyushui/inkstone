// tests/unit/context/semantic-engine.test.js — 语义引擎(解析器/WASM 提供者/符号缓存/索引/选择/语言注册)领域测试
//
// v1.19.1 测试归并:本文件由下列历史任务单测试合并而成,每个来源包裹在独立
// describe 块中(异步回调 + 动态 import,来源间零共享绑定),测试语义与拆分前一致。
import { describe } from "node:test";

// ---------------------------------------------------------------------------
// 来源:tests/context/index-semantic.test.js
// ---------------------------------------------------------------------------
describe("context/index-semantic", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { promises: fs } = await import("node:fs");
  const { createContextEngine } = await import("../../../src/context/index.js");
  const { mkdtemp } = await import("../../helpers/tmp.js");

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
});

// ---------------------------------------------------------------------------
// 来源:tests/context/semantic/semantic-engine.test.js
// ---------------------------------------------------------------------------
describe("context/semantic/semantic-engine", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createSemanticEngine } = await import("../../../src/context/semantic/semantic-engine.js");

  test("disabled engine: index is a no-op and select returns null", async () => {
    const eng = createSemanticEngine({ root: process.cwd(), options: {}, eventBus: null });
    assert.equal(eng.enabled, false);
    await eng.index(new Map());           // no-op, must not throw
    assert.equal(eng.select({ message: "x", pinned: new Set(), warmed: new Map(), budget: 1000 }), null);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/context/semantic/semantic-engine-fallback.test.js
// ---------------------------------------------------------------------------
describe("context/semantic/semantic-engine-fallback", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { promises: fs } = await import("node:fs");
  const { createSemanticEngine } = await import("../../../src/context/semantic/semantic-engine.js");
  const { mkdtemp } = await import("../../helpers/tmp.js");

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
});

// ---------------------------------------------------------------------------
// 来源:tests/context/semantic/disabled-parity.test.js
// ---------------------------------------------------------------------------
describe("context/semantic/disabled-parity", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { promises: fs } = await import("node:fs");
  const { createContextEngine } = await import("../../../src/context/index.js");
  const { mkdtemp } = await import("../../helpers/tmp.js");

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
});

// ---------------------------------------------------------------------------
// 来源:tests/context/semantic/parser-provider.test.js
// ---------------------------------------------------------------------------
describe("context/semantic/parser-provider", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createParserRegistry, extensionOf } = await import("../../../src/context/semantic/parser-provider.js");

  test("extensionOf returns lowercased extension with dot", () => {
    assert.equal(extensionOf("src/A.TS"), ".ts");
    assert.equal(extensionOf("noext"), "");
  });

  test("registry routes by extension, null when unsupported", () => {
    const fake = { name: "fake", supports: (e) => e === ".js", load: async () => {}, parse: () => ({}) };
    const reg = createParserRegistry({ providers: [fake] });
    assert.equal(reg.providerForExtension(".js"), fake);
    assert.equal(reg.providerForExtension(".py"), null);
    assert.deepEqual(reg.list().map((p) => p.name), ["fake"]);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/context/semantic/wasm-tree-sitter-provider.test.js
// ---------------------------------------------------------------------------
describe("context/semantic/wasm-tree-sitter-provider", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createWasmTreeSitterProvider } = await import("../../../src/context/semantic/wasm-tree-sitter-provider.js");

  test("provider parses JS into a tree", async () => {
    const p = createWasmTreeSitterProvider();
    assert.equal(p.supports(".js"), true);
    assert.equal(p.supports(".py"), true);
    assert.equal(p.supports(".rb"), false);
    await p.load();
    const out = p.parseTree("a.js", "function main(){ foo(); }");
    assert.equal(out.ok, true);
    assert.equal(out.language, "js");
    assert.equal(out.tree.rootNode.type, "program");
  });

  test("provider returns ok:false on a grammar-load failure path", async () => {
    const p = createWasmTreeSitterProvider({ grammarsDir: "does/not/exist" });
    const out = await p.load().then(() => p.parseTree("a.js", "x")).catch(() => ({ ok: false }));
    assert.equal(out.ok, false);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/context/semantic/provider-compile-query.test.js
// ---------------------------------------------------------------------------
describe("context/semantic/provider-compile-query", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createWasmTreeSitterProvider } = await import("../../../src/context/semantic/wasm-tree-sitter-provider.js");

  test("compileQuery compiles + caches; unknown language -> null", async () => {
    const p = createWasmTreeSitterProvider();
    await p.load();
    const q1 = p.compileQuery("js", "(function_declaration name: (identifier) @n) @fn");
    const q2 = p.compileQuery("js", "(function_declaration name: (identifier) @n) @fn");
    assert.equal(typeof q1.matches, "function");
    assert.equal(q1, q2);                                  // cached (same instance)
    assert.equal(p.compileQuery("go", "(x) @y"), null);    // grammar not loaded
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/context/semantic/symbol-cache.test.js
// ---------------------------------------------------------------------------
describe("context/semantic/symbol-cache", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { promises: fs } = await import("node:fs");
  const { createSymbolCache } = await import("../../../src/context/semantic/symbol-cache.js");
  const { mkdtemp } = await import("../../helpers/tmp.js");

  async function tmp() { return mkdtemp(path.join(os.tmpdir(), "symcache-")); }

  test("set/get round-trips only on matching hash", async () => {
    const root = await tmp();
    const cache = createSymbolCache({ cacheRoot: root });
    const pr = { file: "src/a.js", language: "js", symbols: [{ name: "x" }], imports: [], exports: [], calls: [], ok: true };
    await cache.set("src/a.js", "h1", pr);
    assert.deepEqual((await cache.get("src/a.js", "h1")).symbols, [{ name: "x" }]);
    assert.equal(await cache.get("src/a.js", "h2"), null); // hash mismatch -> miss
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/context/semantic/symbol-indexer.test.js
// ---------------------------------------------------------------------------
describe("context/semantic/symbol-indexer", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { promises: fs } = await import("node:fs");
  const { createSymbolCache } = await import("../../../src/context/semantic/symbol-cache.js");
  const { createWasmTreeSitterProvider } = await import("../../../src/context/semantic/wasm-tree-sitter-provider.js");
  const { createLanguageRegistry } = await import("../../../src/context/semantic/language-registry.js");
  const { indexSymbols } = await import("../../../src/context/semantic/symbol-indexer.js");
  const { mkdtemp } = await import("../../helpers/tmp.js");

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
});

// ---------------------------------------------------------------------------
// 来源:tests/context/semantic/symbol-selector.test.js
// ---------------------------------------------------------------------------
describe("context/semantic/symbol-selector", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { selectSymbolUnits } = await import("../../../src/context/semantic/symbol-selector.js");

  const mainSym = { symbol_id: "src/a.js#function:main:1", file: "src/a.js", name: "main", kind: "function", range: { start_line: 1, end_line: 1 }, exported: true };
  const fooSym = { symbol_id: "src/b.js#function:foo:1", file: "src/b.js", name: "foo", kind: "function", range: { start_line: 1, end_line: 1 }, exported: true };
  const symbolTable = new Map([[mainSym.symbol_id, mainSym], [fooSym.symbol_id, fooSym]]);
  const sources = new Map([["src/a.js", "function main(){ foo(); }"], ["src/b.js", "function foo(){}"]]);
  const graph = { neighbors: (id) => (id === mainSym.symbol_id ? new Map([[fooSym.symbol_id, "resolved"]]) : new Map()) };

  test("seeds on mentioned symbol name and expands to neighbor", () => {
    const out = selectSymbolUnits({
      message: "please look at main", symbolTable, byFile: new Map(), graph, sources,
      pinned: new Set(), warmed: new Map(), budget: 10000, hops: 1, maxSymbols: 50
    });
    const names = out.selected.map((u) => u.name).sort();
    assert.deepEqual(names, ["foo", "main"]);
    const main = out.selected.find((u) => u.name === "main");
    assert.equal(main.priority, 1);             // seed
    assert.equal(out.selected.find((u) => u.name === "foo").priority, 2); // neighbor
  });

  test("budget caps selection", () => {
    const out = selectSymbolUnits({
      message: "main", symbolTable, byFile: new Map(), graph, sources,
      pinned: new Set(), warmed: new Map(), budget: 1, hops: 1, maxSymbols: 50
    });
    assert.equal(out.selected.length, 0);
  });

  test("probable neighbor -> priority 3 / graph-neighbor-probable", () => {
    const probableGraph = { neighbors: (id) => (id === mainSym.symbol_id ? new Map([[fooSym.symbol_id, "probable"]]) : new Map()) };
    const out = selectSymbolUnits({
      message: "main", symbolTable, byFile: new Map(), graph: probableGraph, sources,
      pinned: new Set(), warmed: new Map(), budget: 10000, hops: 1, maxSymbols: 50
    });
    const foo = out.selected.find((u) => u.name === "foo");
    assert.equal(foo.priority, 3);
    assert.equal(foo.reason, "graph-neighbor-probable");
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/context/semantic/symbol-unit.test.js
// ---------------------------------------------------------------------------
describe("context/semantic/symbol-unit", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createSymbolUnit } = await import("../../../src/context/semantic/symbol-unit.js");

  const symbol = { symbol_id: "src/a.js#function:main:2", file: "src/a.js", name: "main", kind: "function", range: { start_line: 2, end_line: 3 }, exported: true };
  const source = "line1\nfunction main() {\n  return 1;\n}\nline5\n";

  test("symbol unit slices the symbol's line range", () => {
    const u = createSymbolUnit({ symbol, source, priority: 1, reason: "seed" });
    assert.equal(u.type, "symbol");
    assert.equal(u.path, "src/a.js");
    assert.equal(u.symbol_id, symbol.symbol_id);
    assert.deepEqual(u.defined_in, { start_line: 2, end_line: 3 });
    assert.equal(u.snippet, "function main() {\n  return 1;");
    assert.ok(u.token_count > 0);
    assert.ok(u.hash.startsWith("sha256:"));
  });
});
