// tests/unit/semantic-context.test.js — 语义引擎、WASM 语法树解析与多语言符号提取
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWasmTreeSitterProvider } from "../../src/context/semantic/wasm-tree-sitter-provider.js";
import { extractWithDef } from "../../src/context/semantic/query-extractor.js";
import { jsLanguageDef } from "../../src/context/semantic/languages/javascript.js";
import { pythonLanguageDef } from "../../src/context/semantic/languages/python.js";
import { createSemanticEngine } from "../../src/context/semantic/semantic-engine.js";
import { createContextEngine } from "../../src/context/index.js";
import { mkdtemp } from "../helpers/tmp.js";

test("WASM 解析器注册与查询编译缓存", async () => {
  const provider = createWasmTreeSitterProvider();
  await provider.load();

  assert.equal(provider.supports(".js"), true);
  assert.equal(provider.supports(".py"), true);
  assert.equal(provider.supports(".css"), false);

  const { tree } = provider.parseTree("a.js", "function hello() { return 42; }");
  assert.ok(tree);

  const q1 = provider.compileQuery("js", "(function_declaration) @fn");
  const q2 = provider.compileQuery("js", "(function_declaration) @fn");
  assert.equal(q1, q2, "编译查询应命中缓存");
});

test("JS/TS 符号提取、依赖图扩展与方法消歧", async () => {
  const provider = createWasmTreeSitterProvider();
  await provider.load();

  const source = `
    import { helper } from "./utils.js";
    export class Calculator {
      add(a, b) { return a + b; }
    }
    export function compute(x) {
      const c = new Calculator();
      return helper(c.add(x, 1));
    }
  `;
  const { tree } = provider.parseTree("math.js", source);
  const q = provider.compileQuery("js", jsLanguageDef.query);
  const result = extractWithDef({ file: "src/math.js", source, tree, query: q, def: jsLanguageDef });

  assert.equal(result.ok, true);
  const names = result.symbols.map((s) => s.name);
  assert.ok(names.includes("Calculator"));
  assert.ok(names.includes("add"));
  assert.ok(names.includes("compute"));

  assert.ok(result.imports.some((i) => i.source_spec === "./utils.js"));
  assert.ok(result.calls.some((c) => c.callee_raw === "helper" || c.member_property === "add"));
});

test("Python 符号提取与模块解析", async () => {
  const provider = createWasmTreeSitterProvider();
  await provider.load();

  const source = `
from .sub import a as b, c
import os

class Worker:
    def execute(self):
        self.run()

def run():
    pass
  `;
  const { tree } = provider.parseTree("worker.py", source);
  const q = provider.compileQuery("py", pythonLanguageDef.query);
  const result = extractWithDef({ file: "pkg/worker.py", source, tree, query: q, def: pythonLanguageDef });

  assert.equal(result.ok, true);
  const byName = Object.fromEntries(result.symbols.map((s) => [s.name, s]));
  assert.equal(byName.Worker.kind, "class");
  assert.equal(byName.execute.kind, "method");
  assert.equal(byName.run.kind, "function");

  assert.ok(result.imports.some((i) => i.source_spec === "os" || i.source_spec === "sub"));
});

test("语义上下文选择与预算裁剪", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsc-sem-select-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(
    path.join(root, "src", "ops.js"),
    "export function calculate() { return 100; }\nexport function secondary() { return 200; }\n"
  );

  const events = [];
  const eventBus = { publish: (t, p) => events.push(t) };
  const engine = createContextEngine({
    root,
    eventBus,
    options: { semantic: { enabled: true, hops: 2, maxSymbols: 50, includeMethodHints: false } }
  });

  await engine.scan();
  const snap = await engine.snapshot({ message: "calculate", channel: "reply" });

  assert.ok(snap.units.some((u) => u.type === "symbol" || u.path === "src/ops.js"));
  assert.ok(events.includes("context:symbol_indexed"));
});

test("无 WASM / 解析失败环境下的优雅降级", async () => {
  const disabled = createSemanticEngine({ root: process.cwd(), options: {}, eventBus: null });
  assert.equal(disabled.enabled, false);
  await disabled.index(new Map());
  assert.equal(disabled.select({ message: "test", pinned: new Set(), warmed: new Map(), budget: 1000 }), null);

  const root = await mkdtemp(path.join(os.tmpdir(), "dsc-sem-degrade-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "a.js"), "export function fail() {}\n");

  const events = [];
  const eventBus = { publish: (t, d) => events.push(d ? `${t}:${d.reason}` : t) };
  const failingProvider = {
    name: "failing-provider",
    supports: () => true,
    load: async () => { throw new Error("grammar unavailable"); },
    parseTree: () => ({ ok: false, language: "js", tree: null })
  };

  const failingEngine = createSemanticEngine({
    root,
    options: { semantic: { enabled: true } },
    eventBus,
    provider: failingProvider
  });

  await failingEngine.index(new Map([["src/a.js", { path: "src/a.js", hash: "sha256:1" }]]));
  assert.equal(events.some((e) => e.startsWith("context:semantic_degraded")), true);
  assert.equal(events.includes("context:symbol_indexed"), false);
});
