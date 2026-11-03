// tests/unit/context/semantic-js-ts.test.js — JS/TS 语义(query 抽取/依赖图/方法提示/模块解析)领域测试
//
// v1.19.1 测试归并:本文件由下列历史任务单测试合并而成,每个来源包裹在独立
// describe 块中(异步回调 + 动态 import,来源间零共享绑定),测试语义与拆分前一致。
import { describe } from "node:test";

// ---------------------------------------------------------------------------
// 来源:tests/context/semantic/query-extractor-core.test.js
// ---------------------------------------------------------------------------
describe("context/semantic/query-extractor-core", async () => {

  // minimal JS def: only top-level function symbols + identifier calls

  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createWasmTreeSitterProvider } = await import("../../../src/context/semantic/wasm-tree-sitter-provider.js");
  const { extractWithDef } = await import("../../../src/context/semantic/query-extractor.js");
  const { makeSymbolId } = await import("../../../src/context/semantic/symbol-id.js");

  const miniDef = {
    language: "js",
    callablePriority: { method: 0, function: 1, variable: 2, class: 3 },
    query: `(function_declaration) @fn
            (call_expression function: (identifier) @callee) @call`,
    handleMatch(group, ctx) {
      if (group.has("fn")) {
        const node = group.get("fn")[0];
        const name = node.childForFieldName("name")?.text;
        if (!name) return null;
        return { symbol: {
          symbol_id: makeSymbolId({ file: ctx.file, kind: "function", name, startLine: node.startPosition.row + 1 }),
          file: ctx.file, name, kind: "function",
          range: { start_line: node.startPosition.row + 1, end_line: node.endPosition.row + 1 },
          exported: false, _node: node
        } };
      }
      if (group.has("call")) {
        const node = group.get("call")[0];
        return { rawCall: { _node: node, callee_raw: group.get("callee")[0].text, kind: "identifier", file: ctx.file, line: node.startPosition.row + 1 } };
      }
      return null;
    }
  };

  test("runner assembles symbols + calls; enclosing-symbol by smallest range", async () => {
    const provider = createWasmTreeSitterProvider();
    await provider.load();
    const source = "function outer(){ function inner(){ foo(); } }";
    const { tree } = provider.parseTree("a.js", source);
    const query = provider.compileQuery("js", miniDef.query);
    const r = extractWithDef({ file: "src/a.js", source, tree, query, def: miniDef });
    assert.equal(r.ok, true);
    assert.deepEqual(r.symbols.map((s) => s.name).sort(), ["inner", "outer"]);
    // foo() is inside inner -> enclosing is inner (smallest byte range), not outer
    assert.equal(r.calls.length, 1);
    assert.ok(r.calls[0].caller_symbol_id.includes("#function:inner:"));
    // no _node leaks into output
    assert.equal("_node" in r.symbols[0], false);
  });

  test("extractParseResult degrades to ok:false when no def in registry", async () => {
    const provider = createWasmTreeSitterProvider();
    await provider.load();
    const { extractParseResult } = await import("../../../src/context/semantic/query-extractor.js");
    const registry = new Map(); // empty -> no def for js
    const r = extractParseResult({ file: "src/a.js", source: "function f(){}", provider, registry });
    assert.equal(r.ok, false);
    assert.deepEqual(r.symbols, []);
    assert.deepEqual(r.calls, []);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/context/semantic/dependency-graph.test.js
// ---------------------------------------------------------------------------
describe("context/semantic/dependency-graph", async () => {

  // Two files: a.js imports foo from b.js and calls it + calls local helper + obj.run()

  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { buildDependencyGraph } = await import("../../../src/context/semantic/dependency-graph.js");

  const fooSym = { symbol_id: "src/b.js#function:foo:1", file: "src/b.js", name: "foo", kind: "function", range: { start_line: 1, end_line: 1 }, exported: true };
  const mainSym = { symbol_id: "src/a.js#function:main:2", file: "src/a.js", name: "main", kind: "function", range: { start_line: 2, end_line: 5 }, exported: true };
  const helpSym = { symbol_id: "src/a.js#function:help:6", file: "src/a.js", name: "help", kind: "function", range: { start_line: 6, end_line: 6 }, exported: false };

  const byFile = new Map([
    ["src/b.js", { file: "src/b.js", symbols: [fooSym], imports: [], exports: [{ file: "src/b.js", name: "foo", local_name: "foo", kind: "named", source_spec: null }], calls: [], ok: true }],
    ["src/a.js", { file: "src/a.js", symbols: [mainSym, helpSym], ok: true,
      imports: [{ from_file: "src/a.js", source_spec: "./b.js", resolved_file: "src/b.js", names: [{ imported: "foo", local: "foo" }], default: false, namespace: false, kind: "esm", dynamic: false }],
      exports: [],
      calls: [
        { caller_symbol_id: mainSym.symbol_id, callee_raw: "foo", kind: "identifier", file: "src/a.js", line: 3 },
        { caller_symbol_id: mainSym.symbol_id, callee_raw: "help", kind: "identifier", file: "src/a.js", line: 4 },
        { caller_symbol_id: mainSym.symbol_id, callee_raw: "obj.run", kind: "member", file: "src/a.js", line: 5 }
      ] }]
  ]);
  const symbolTable = new Map([fooSym, mainSym, helpSym].map((s) => [s.symbol_id, s]));

  test("resolves import-binding, local call; marks member call unresolved", () => {
    const g = buildDependencyGraph({ byFile, symbolTable });
    const byRaw = Object.fromEntries(g.callEdges.map((e) => [e.callee_raw, e]));
    assert.deepEqual([byRaw.foo.confidence, byRaw.foo.reason, byRaw.foo.callee_symbol_id],
      ["resolved", "import-binding", fooSym.symbol_id]);
    assert.deepEqual([byRaw.help.confidence, byRaw.help.reason, byRaw.help.callee_symbol_id],
      ["resolved", "direct-local-call", helpSym.symbol_id]);
    assert.deepEqual([byRaw["obj.run"].confidence, byRaw["obj.run"].reason, byRaw["obj.run"].callee_symbol_id],
      ["unresolved", "member-call", null]);
  });

  test("neighbors expands resolved edges only", () => {
    const g = buildDependencyGraph({ byFile, symbolTable });
    const out = g.neighbors(mainSym.symbol_id, { hops: 1, direction: "out" });
    assert.equal(out.has(fooSym.symbol_id), true);
    assert.equal(out.has(helpSym.symbol_id), true);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/context/semantic/dependency-graph-method-hints.test.js
// ---------------------------------------------------------------------------
describe("context/semantic/dependency-graph-method-hints", async () => {

  // caller `use` makes 4 member calls: obj.uniqueFn(), obj.dupFn(), obj.Widget(), obj.uniqueMethod()

  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { buildDependencyGraph } = await import("../../../src/context/semantic/dependency-graph.js");

  const useSym = { symbol_id: "src/a.js#function:use:1", file: "src/a.js", name: "use", kind: "function", range: { start_line: 1, end_line: 4 }, exported: true };
  const uniqueFn = { symbol_id: "src/b.js#function:uniqueFn:1", file: "src/b.js", name: "uniqueFn", kind: "function", range: { start_line: 1, end_line: 1 }, exported: true };
  const dup1 = { symbol_id: "src/b.js#function:dupFn:2", file: "src/b.js", name: "dupFn", kind: "function", range: { start_line: 2, end_line: 2 }, exported: true };
  const dup2 = { symbol_id: "src/c.js#function:dupFn:1", file: "src/c.js", name: "dupFn", kind: "function", range: { start_line: 1, end_line: 1 }, exported: true };
  const widget = { symbol_id: "src/b.js#class:Widget:3", file: "src/b.js", name: "Widget", kind: "class", range: { start_line: 3, end_line: 3 }, exported: true };
  const uniqueMethod = { symbol_id: "src/b.js#method:uniqueMethod:4", file: "src/b.js", name: "uniqueMethod", kind: "method", range: { start_line: 4, end_line: 4 }, exported: false };

  const memberCall = (prop) => ({ caller_symbol_id: useSym.symbol_id, callee_raw: `obj.${prop}`, kind: "member", member_property: prop, file: "src/a.js", line: 2 });
  const byFile = new Map([
    ["src/a.js", { file: "src/a.js", symbols: [useSym], imports: [], exports: [], ok: true,
      calls: [memberCall("uniqueFn"), memberCall("dupFn"), memberCall("Widget"), memberCall("uniqueMethod")] }],
    ["src/b.js", { file: "src/b.js", symbols: [uniqueFn, dup1, widget, uniqueMethod], imports: [], exports: [], calls: [], ok: true }],
    ["src/c.js", { file: "src/c.js", symbols: [dup2], imports: [], exports: [], calls: [], ok: true }]
  ]);
  const symbolTable = new Map([useSym, uniqueFn, dup1, dup2, widget, uniqueMethod].map((s) => [s.symbol_id, s]));

  test("methodHints OFF -> all member calls unresolved (unchanged)", () => {
    const g = buildDependencyGraph({ byFile, symbolTable });
    for (const e of g.callEdges.filter((e) => e.callee_raw.startsWith("obj."))) {
      assert.deepEqual([e.confidence, e.reason, e.callee_symbol_id], ["unresolved", "member-call", null]);
    }
    assert.equal(g.neighbors(useSym.symbol_id, { hops: 1 }).size, 0);
  });

  test("methodHints ON -> unique callable match -> probable; dup/class -> unresolved", () => {
    const g = buildDependencyGraph({ byFile, symbolTable, methodHints: true });
    const byRaw = Object.fromEntries(g.callEdges.map((e) => [e.callee_raw, e]));
    assert.deepEqual([byRaw["obj.uniqueFn"].confidence, byRaw["obj.uniqueFn"].reason, byRaw["obj.uniqueFn"].callee_symbol_id],
      ["probable", "member-call", uniqueFn.symbol_id]);
    assert.deepEqual([byRaw["obj.uniqueMethod"].confidence, byRaw["obj.uniqueMethod"].callee_symbol_id],
      ["probable", uniqueMethod.symbol_id]);                 // method kind is callable
    assert.equal(byRaw["obj.dupFn"].confidence, "unresolved"); // 2 matches -> ambiguous
    assert.equal(byRaw["obj.Widget"].confidence, "unresolved"); // class excluded from nameIndex
    const nb = g.neighbors(useSym.symbol_id, { hops: 1, direction: "out" });
    assert.equal(nb.get(uniqueFn.symbol_id), "probable");
    assert.equal(nb.has(widget.symbol_id), false);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/context/semantic/method-hints-e2e.test.js
// ---------------------------------------------------------------------------
describe("context/semantic/method-hints-e2e", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { promises: fs } = await import("node:fs");
  const { createSemanticEngine } = await import("../../../src/context/semantic/semantic-engine.js");
  const { createWasmTreeSitterProvider } = await import("../../../src/context/semantic/wasm-tree-sitter-provider.js");
  const { mkdtemp } = await import("../../helpers/tmp.js");

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
});

// ---------------------------------------------------------------------------
// 来源:tests/context/semantic/module-resolver.test.js
// ---------------------------------------------------------------------------
describe("context/semantic/module-resolver", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { resolveModule } = await import("../../../src/context/semantic/module-resolver.js");

  const fileSet = new Set(["src/foo.js", "src/bar/index.ts", "src/baz.ts"]);

  test("resolves relative specifiers with extension/index completion", () => {
    assert.equal(resolveModule({ fromFile: "src/a.js", spec: "./foo", fileSet }), "src/foo.js");
    assert.equal(resolveModule({ fromFile: "src/a.js", spec: "./foo.js", fileSet }), "src/foo.js");
    assert.equal(resolveModule({ fromFile: "src/a.js", spec: "./bar", fileSet }), "src/bar/index.ts");
    assert.equal(resolveModule({ fromFile: "src/x/a.js", spec: "../baz", fileSet }), "src/baz.ts");
  });

  test("bare and alias specifiers are external -> null", () => {
    assert.equal(resolveModule({ fromFile: "src/a.js", spec: "react", fileSet }), null);
    assert.equal(resolveModule({ fromFile: "src/a.js", spec: "@/foo", fileSet }), null);
    assert.equal(resolveModule({ fromFile: "src/a.js", spec: "./missing", fileSet }), null);
  });
});
