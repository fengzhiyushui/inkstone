// tests/unit/context/semantic-python.test.js — Python 语义(抽取/绑定/模块解析)领域测试
//
// v1.19.1 测试归并:本文件由下列历史任务单测试合并而成,每个来源包裹在独立
// describe 块中(异步回调 + 动态 import,来源间零共享绑定),测试语义与拆分前一致。
import { describe } from "node:test";

// ---------------------------------------------------------------------------
// 来源:tests/context/semantic/python-extraction.test.js
// ---------------------------------------------------------------------------
describe("context/semantic/python-extraction", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createWasmTreeSitterProvider } = await import("../../../src/context/semantic/wasm-tree-sitter-provider.js");
  const { extractWithDef } = await import("../../../src/context/semantic/query-extractor.js");
  const { pythonLanguageDef } = await import("../../../src/context/semantic/languages/python.js");

  const provider = createWasmTreeSitterProvider();
  async function extract(file, source) {
    await provider.load();
    const { tree } = provider.parseTree(file, source);
    const q = provider.compileQuery("py", pythonLanguageDef.query);
    return extractWithDef({ file, source, tree, query: q, def: pythonLanguageDef });
  }

  test("module-level fn/class exported:true; method exported:false", async () => {
    const r = await extract("pkg/m.py", "def top():\n    helper()\nclass S:\n    def run(self):\n        self.x()\ndef helper():\n    pass");
    const byName = Object.fromEntries(r.symbols.map((s) => [s.name, s]));
    assert.equal(byName.top.kind, "function");
    assert.equal(byName.top.exported, true);
    assert.equal(byName.S.kind, "class");
    assert.equal(byName.S.exported, true);
    assert.equal(byName.run.kind, "method");
    assert.equal(byName.run.exported, false);
    assert.equal(byName.helper.exported, true);
    // direct call top()->helper captured; self.x() member with property x
    assert.ok(r.calls.some((c) => c.callee_raw === "helper" && c.kind === "identifier"));
    assert.ok(r.calls.some((c) => c.kind === "member" && c.member_property === "x"));
    // helper() is enclosed by top
    const helperCall = r.calls.find((c) => c.callee_raw === "helper");
    assert.ok(helperCall.caller_symbol_id.includes("#function:top:"));
    // exports always empty for Python
    assert.deepEqual(r.exports, []);
  });

  test("imports: relative (level + alias), absolute, bare module", async () => {
    const r = await extract("pkg/m.py", "from .sub import a as b, c\nimport os\nfrom pkg.mod import d");
    const specs = r.imports.map((i) => i.source_spec).sort();
    assert.ok(specs.includes("os"));
    assert.ok(specs.includes("sub"));
    assert.ok(specs.includes("pkg.mod"));
    const rel = r.imports.find((i) => i.names.some((n) => n.local === "b"));
    assert.equal(rel.level, 1);
    assert.equal(rel.names.find((n) => n.local === "b").imported, "a");
    assert.ok(rel.names.some((n) => n.imported === "c" && n.local === "c"));
    const abs = r.imports.find((i) => i.source_spec === "pkg.mod");
    assert.equal(abs.level, 0);
    assert.equal(abs.names[0].imported, "d");
    const bare = r.imports.find((i) => i.source_spec === "os");
    assert.equal(bare.level, 0);
    assert.deepEqual(bare.names, []);
  });

  test("from . import x -> level 1, empty spec", async () => {
    const r = await extract("pkg/m.py", "from . import x");
    assert.equal(r.imports.length, 1);
    assert.equal(r.imports[0].level, 1);
    assert.equal(r.imports[0].source_spec, "");
    assert.equal(r.imports[0].names[0].imported, "x");
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/context/semantic/python-binding-e2e.test.js
// ---------------------------------------------------------------------------
describe("context/semantic/python-binding-e2e", async () => {

  // pkg/a.py defines helper(); pkg/b.py does `from .a import helper` then calls it.
  // With Python module resolution wired in, the call b.main -> a.helper is a resolved
  // import-binding edge, so selecting on "main" expands to helper as a resolved neighbor.

  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { promises: fs } = await import("node:fs");
  const { createSemanticEngine } = await import("../../../src/context/semantic/semantic-engine.js");
  const { createWasmTreeSitterProvider } = await import("../../../src/context/semantic/wasm-tree-sitter-provider.js");
  const { mkdtemp } = await import("../../helpers/tmp.js");

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
});

// ---------------------------------------------------------------------------
// 来源:tests/context/semantic/python-module-resolver.test.js
// ---------------------------------------------------------------------------
describe("context/semantic/python-module-resolver", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { resolvePythonModule } = await import("../../../src/context/semantic/python-module-resolver.js");

  const fileSet = new Set(["pkg/__init__.py", "pkg/mod.py", "pkg/sub/__init__.py", "app/main.py", "util.py"]);

  test("relative imports resolve by level", () => {
    // from .mod import x  (in app/main.py) -> level 1, spec "mod" -> app/mod.py absent
    assert.equal(resolvePythonModule({ fromFile: "app/main.py", spec: "mod", level: 1, fileSet, importRoots: [] }), null);
    // from . import x (in pkg/mod.py) -> level 1 spec "" -> package pkg -> pkg/__init__.py
    assert.equal(resolvePythonModule({ fromFile: "pkg/mod.py", spec: "", level: 1, fileSet, importRoots: [] }), "pkg/__init__.py");
    // from .sub import y (in pkg/mod.py) -> pkg/sub/__init__.py
    assert.equal(resolvePythonModule({ fromFile: "pkg/mod.py", spec: "sub", level: 1, fileSet, importRoots: [] }), "pkg/sub/__init__.py");
  });

  test("absolute imports resolve from project root / import roots", () => {
    assert.equal(resolvePythonModule({ fromFile: "app/main.py", spec: "pkg.mod", level: 0, fileSet, importRoots: [] }), "pkg/mod.py");
    assert.equal(resolvePythonModule({ fromFile: "app/main.py", spec: "util", level: 0, fileSet, importRoots: [] }), "util.py");
    assert.equal(resolvePythonModule({ fromFile: "app/main.py", spec: "os", level: 0, fileSet, importRoots: [] }), null); // external
  });

  test("importRoots are appended (src/ as a root)", () => {
    const fs2 = new Set(["src/pkg/mod.py"]);
    assert.equal(resolvePythonModule({ fromFile: "app/main.py", spec: "pkg.mod", level: 0, fileSet: fs2, importRoots: ["src"] }), "src/pkg/mod.py");
  });

  test("module file wins over package __init__; namespace package w/o __init__ -> null", () => {
    const fs2 = new Set(["pkg.py", "pkg/__init__.py", "ns/leaf.py"]); // pkg both as module and package
    assert.equal(resolvePythonModule({ fromFile: "app/main.py", spec: "pkg", level: 0, fileSet: fs2, importRoots: [] }), "pkg.py");
    // "ns" dir exists in paths but has no __init__.py and no ns.py -> external (null)
    assert.equal(resolvePythonModule({ fromFile: "app/main.py", spec: "ns", level: 0, fileSet: fs2, importRoots: [] }), null);
  });
});
