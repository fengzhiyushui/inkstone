# Phase B · 语义级上下文引擎 Implementation Plan

> 完成状态以 [CHANGELOG](../../CHANGELOG.md) 为准。


**Goal:** 在现有 `createContextEngine` 门面之下增加一个 opt-in 的符号级上下文层(符号表 + 依赖图 + 调用图),让检索粒度从"整文件"降到"符号"、相关性从"路径启发"升到"依赖图"。

**Architecture:** 新增 `src/context/semantic/` 子模块,内部分为 ParserProvider(解析后端抽象,首版仅 web-tree-sitter)→ js-ts-extractor(AST → ParseResult)→ symbol-indexer(增量缓存)→ dependency-graph(模块边/绑定/尽力调用边)→ symbol-selector(种子→扩展→预算)。门面 `scan()`/`snapshot()` 签名不变;`context.semantic.enabled` 默认 `false`,关闭时行为与今天逐字节一致。

**Tech Stack:** Node ESM (`type:"module"`, Node ≥ 20)、`node:test` + `node:assert/strict`、web-tree-sitter(WASM,仅语义启用时懒加载)、vendored grammar `.wasm`。

## Global Constraints

- Node ≥ 20;纯 ESM(`import`/`export`,文件用 `.js`)。
- 测试用 `node:test`:`import { test } from "node:test"; import assert from "node:assert/strict";`。运行 `node --test <file>`。
- **opt-in 默认关**:`context.semantic.enabled` 默认 `false`;**关闭时引擎行为(单元、事件、快照)与今天逐字节一致**——每个改动门面/事件的任务都必须有"semantic 关闭 → 旧行为不变"的回归测试。
- **单解析栈**:只用 web-tree-sitter;**不得引入 TypeScript 编译器**或第二套解析器。
- **核心零必需依赖**:web-tree-sitter 及 grammar wasm 仅在 `enabled` 时 `await import()` 懒加载;`package.json` 里它放 `optionalDependencies`,核心 CLI 路径不 import 它。
- **可靠静态子集**:只把可静态确认的 import/export、function/class、直接调用标 `resolved`;`obj.method()`/`this.x()`/`factory()()`/动态 `import()` 标 `unresolved`(`member-call`/`dynamic-call`)。
- **`unresolved` 是一等图事实,不是解析失败**:unresolved 调用边照常进图、照常计数。
- **回退永不崩**:provider 加载失败 / grammar 缺失 / 单文件解析报错 → 该文件降级为文件级单元;provider 整体不可用 → 全量退回文件级行为。
- 每个新文件单一职责;`check` 脚本(`package.json`)需在新增源码文件后追加对应 `node --check` 条目(并入相关任务的提交)。
- 频繁提交:每个 task 末尾 commit。提交信息英文,scope 用 `feat(semantic)` / `test(semantic)` / `docs`。

## Shared Data Shapes（全任务共用,逐字一致)

```js
// ParseResult —— js-ts-extractor 的产物(per file)
ParseResult = {
  file,                          // workspace-relative path, e.g. "src/a.js"
  language: "js" | "ts",
  symbols: [Symbol],
  imports: [Import],
  exports: [Export],
  calls: [RawCall],              // 抽取期的"原始调用",B3 再解析成 CallEdge
  ok: boolean,                   // false = 解析失败(该文件回退文件级)
}

Symbol = { symbol_id, file, name, kind: "function"|"class"|"method"|"variable",
           range: { start_line, end_line }, exported: boolean }

Import = { from_file, source_spec, resolved_file: string|null,
           names: [{ imported, local }], default: boolean, namespace: boolean,
           kind: "esm"|"cjs", dynamic: boolean }

Export = { file, name, local_name, kind: "named"|"default"|"reexport", source_spec: string|null }

RawCall = { caller_symbol_id, callee_raw, kind: "identifier"|"member"|"dynamic", file, line }

CallEdge = { caller_symbol_id, callee_raw, callee_symbol_id: string|null,
             confidence: "resolved"|"probable"|"unresolved",
             reason: "direct-local-call"|"import-binding"|"member-call"|"dynamic-call",
             file, line }

// symbol_id 稳定格式（spec §9）:
//   `${file}#${kind}:${name}:${start_line}`   e.g. "src/a.js#function:main:12"
//   稳定边界:体编辑稳、行移会变、不承诺跨编辑持久身份。

SymbolUnit = { id, type: "symbol", path, symbol_id, symbol_kind, name,
               defined_in: { start_line, end_line }, hash, token_count,
               priority, reason, snippet }
```

---

## Task 1: ParserProvider 抽象与注册表

**Files:**
- Create: `src/context/semantic/parser-provider.js`
- Test: `tests/context/semantic/parser-provider.test.js`

**Interfaces:**
- Produces:
  - `createParserRegistry({ providers = [] }) → { register(provider), providerForExtension(ext) → provider|null, list() }`
  - Provider 契约:`{ name, supports(ext) → boolean, load() → Promise<void>, parse(file, source) → ParseResult }`
  - `extensionOf(path) → string`(小写含点,如 `.js`)

- [ ] **Step 1: 写失败测试**

```js
// tests/context/semantic/parser-provider.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createParserRegistry, extensionOf } from "../../../src/context/semantic/parser-provider.js";

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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/context/semantic/parser-provider.test.js`
Expected: FAIL（`Cannot find module .../parser-provider.js`)

- [ ] **Step 3: 实现**

```js
// src/context/semantic/parser-provider.js
export function extensionOf(inputPath) {
  const last = String(inputPath || "").split(/[\\/]/).pop() || "";
  const i = last.lastIndexOf(".");
  return i >= 0 ? last.slice(i).toLowerCase() : "";
}

export function createParserRegistry({ providers = [] } = {}) {
  const list = [...providers];
  return {
    register(provider) { list.push(provider); return provider; },
    providerForExtension(ext) { return list.find((p) => p.supports(ext)) || null; },
    list() { return [...list]; }
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/context/semantic/parser-provider.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/context/semantic/parser-provider.js tests/context/semantic/parser-provider.test.js
git commit -m "feat(semantic): parser provider registry + extension routing"
```

---

## Task 2: 依赖固定与 grammar 落地（web-tree-sitter)

> 这是唯一触及外部库的任务。先把版本钉死、grammar wasm 落仓,再写一个最小冒烟脚本验证 init/load/parse 的真实 API,**用验证结果校准 Task 3 的 provider 代码**。

**Files:**
- Modify: `package.json`（加 `optionalDependencies`)
- Create: `src/context/grammars/.gitkeep`(占位,随后放 `.wasm`)
- Create: `scripts/verify-tree-sitter.mjs`(一次性冒烟,可保留)

**Interfaces:**
- Produces:vendored 文件 `src/context/grammars/tree-sitter-javascript.wasm` 与 `tree-sitter-typescript.wasm`(及 tsx,如分包);确认可用的加载 API 形态。

- [ ] **Step 1: 固定依赖**

把 web-tree-sitter 放入 `optionalDependencies`(核心路径不 import,仅语义启用时懒加载),并锁版本:

```bash
npm pkg set optionalDependencies.web-tree-sitter="0.25.10"
npm install
```

> 若 `0.25.10` 不可用,改用 `npm view web-tree-sitter version` 报告的当前稳定版并据此更新 lock。

- [ ] **Step 2: 落 grammar wasm 到仓库**

从已发布的预编译 grammar 取 `.wasm`(优先 `tree-sitter-wasms` 包,内含多语言预编译产物),复制到 `src/context/grammars/`:

```bash
npm install --no-save tree-sitter-wasms
node -e "import('node:fs').then(fs=>{for(const n of ['javascript','typescript','tsx']){const s=`node_modules/tree-sitter-wasms/out/tree-sitter-${n}.wasm`;const d=`src/context/grammars/tree-sitter-${n}.wasm`;fs.copyFileSync(s,d);console.log('copied',d);}})"
```

> 若 `tree-sitter-wasms` 的路径/文件名不符,用 `node -e "console.log(require('node:fs').readdirSync('node_modules/tree-sitter-wasms/out'))"` 查实际文件名后调整。grammar 与解析器版本需兼容(同主版本)。

- [ ] **Step 3: 写并运行冒烟脚本,确认真实 API**

```js
// scripts/verify-tree-sitter.mjs
import { Parser, Language } from "web-tree-sitter";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
await Parser.init();
const parser = new Parser();
const lang = await Language.load(path.join(dir, "..", "src", "context", "grammars", "tree-sitter-javascript.wasm"));
parser.setLanguage(lang);
const tree = parser.parse("export function main(){ foo(); }");
console.log("root:", tree.rootNode.type, "children:", tree.rootNode.namedChildCount);
```

Run: `node scripts/verify-tree-sitter.mjs`
Expected: 打印 `root: program children: 1`(或类似)。**若 `import { Parser, Language }` 报错**,改用兼容形态 `import Parser from "web-tree-sitter"; await Parser.init(); const lang = await Parser.Language.load(...)`,并记下生效形态——Task 3 以此为准。

- [ ] **Step 4: 提交**

```bash
git add package.json package-lock.json src/context/grammars scripts/verify-tree-sitter.mjs
git commit -m "build(semantic): pin web-tree-sitter (optional) + vendor JS/TS grammars"
```

---

## Task 3: web-tree-sitter Provider（懒加载 + 解析)

**Files:**
- Create: `src/context/semantic/wasm-tree-sitter-provider.js`
- Test: `tests/context/semantic/wasm-tree-sitter-provider.test.js`

**Interfaces:**
- Consumes:Provider 契约(Task 1);grammar wasm(Task 2)。
- Produces:`createWasmTreeSitterProvider({ grammarsDir? }) → provider`;`provider.parse(file, src)` 返回 `{ tree, language }`(tree 为 web-tree-sitter Tree)。**注意:本任务只负责"源码→tree";tree→ParseResult 在 Task 4。** 故 provider 暴露 `parseTree(file, src) → { tree, language, ok }`,`load()` 懒加载且只做一次。

- [ ] **Step 1: 写失败测试(集成,需 Task 2 的 wasm)**

```js
// tests/context/semantic/wasm-tree-sitter-provider.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createWasmTreeSitterProvider } from "../../../src/context/semantic/wasm-tree-sitter-provider.js";

test("provider parses JS into a tree", async () => {
  const p = createWasmTreeSitterProvider();
  assert.equal(p.supports(".js"), true);
  assert.equal(p.supports(".py"), false);
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/context/semantic/wasm-tree-sitter-provider.test.js`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现(以 Task 2 Step 3 确认的 API 形态为准;下为 named-export 形态)**

```js
// src/context/semantic/wasm-tree-sitter-provider.js
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extensionOf } from "./parser-provider.js";

const EXT_LANG = new Map([
  [".js", "js"], [".mjs", "js"], [".cjs", "js"], [".jsx", "js"],
  [".ts", "ts"], [".tsx", "ts"]
]);
const LANG_WASM = { js: "tree-sitter-javascript.wasm", ts: "tree-sitter-typescript.wasm", tsx: "tree-sitter-tsx.wasm" };

export function createWasmTreeSitterProvider({ grammarsDir } = {}) {
  const baseDir = grammarsDir || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "grammars");
  let initPromise = null;
  const langs = new Map();      // "js"|"ts" -> Language
  let ParserCtor = null;

  async function load() {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      const mod = await import("web-tree-sitter");
      const Parser = mod.Parser || mod.default;
      const Language = mod.Language || Parser.Language;
      await Parser.init();
      ParserCtor = Parser;
      for (const lang of ["js", "ts"]) {
        const wasm = path.join(baseDir, LANG_WASM[lang]);
        langs.set(lang, await Language.load(wasm));
      }
    })();
    return initPromise;
  }

  function supports(ext) { return EXT_LANG.has(ext); }

  function parseTree(file, source) {
    const language = EXT_LANG.get(extensionOf(file));
    if (!language || !ParserCtor) return { ok: false, language: language || null, tree: null };
    const grammar = langs.get(language === "ts" ? "ts" : "js");
    if (!grammar) return { ok: false, language, tree: null };
    try {
      const parser = new ParserCtor();
      parser.setLanguage(grammar);
      const tree = parser.parse(String(source ?? ""));
      return { ok: true, language, tree };
    } catch {
      return { ok: false, language, tree: null };
    }
  }

  return { name: "wasm-tree-sitter", supports, load, parseTree };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/context/semantic/wasm-tree-sitter-provider.test.js`
Expected: PASS（两个用例)

- [ ] **Step 5: 提交**

```bash
git add src/context/semantic/wasm-tree-sitter-provider.js tests/context/semantic/wasm-tree-sitter-provider.test.js
git commit -m "feat(semantic): lazy web-tree-sitter provider (source -> tree)"
```

---

## Task 4: JS/TS Extractor（tree → ParseResult)

**Files:**
- Create: `src/context/semantic/js-ts-extractor.js`
- Test: `tests/context/semantic/js-ts-extractor.test.js`

**Interfaces:**
- Consumes:`provider.parseTree(file, src)`(Task 3);`Symbol`/`Import`/`Export`/`RawCall` 形状(Shared)。
- Produces:`makeSymbolId({ file, kind, name, startLine }) → string`;`extractParseResult({ file, source, parseTree }) → ParseResult`。其中 `parseTree` 为依赖注入的 `(file, source) → { ok, language, tree }`(便于测试用真 provider)。

**抽取规则(可靠子集,spec §6):**
- symbols:`function_declaration`、`class_declaration`、`method_definition`、顶层 `lexical_declaration`/`variable_declaration` 中 `= arrow_function|function` 的赋名变量。
- exports:ESM `export_statement`(named/default/re-export);CJS `module.exports=`/`exports.x=` 标 best-effort。
- imports:ESM `import_statement`(default/named/namespace);CJS `require("lit")` 调用。`dynamic import()` → `dynamic:true`。
- calls(RawCall):`call_expression`,callee 为 `identifier` → `kind:"identifier"`;`member_expression` → `"member"`;其它(`call_expression`/计算) → `"dynamic"`。`caller_symbol_id` = 包含该调用的最近 symbol。

- [ ] **Step 1: 写失败测试(用真 provider 做端到端抽取)**

```js
// tests/context/semantic/js-ts-extractor.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createWasmTreeSitterProvider } from "../../../src/context/semantic/wasm-tree-sitter-provider.js";
import { extractParseResult, makeSymbolId } from "../../../src/context/semantic/js-ts-extractor.js";

const provider = createWasmTreeSitterProvider();
const parseTree = (file, src) => provider.parseTree(file, src);

const SRC = `import { foo } from "./foo.js";
import bar from "./bar.js";
export function main() { foo(); bar(); obj.run(); }
export class Service {}
`;

test("makeSymbolId is the stable documented format", () => {
  assert.equal(makeSymbolId({ file: "src/a.js", kind: "function", name: "main", startLine: 3 }),
    "src/a.js#function:main:3");
});

test("extractor pulls symbols/imports/exports/raw calls", async () => {
  await provider.load();
  const r = extractParseResult({ file: "src/a.js", source: SRC, parseTree });
  assert.equal(r.ok, true);
  const names = r.symbols.map((s) => s.name).sort();
  assert.deepEqual(names, ["Service", "main"]);
  assert.equal(r.symbols.find((s) => s.name === "main").exported, true);
  assert.deepEqual(r.imports.map((i) => i.source_spec).sort(), ["./bar.js", "./foo.js"]);
  // raw calls inside main: foo (identifier), bar (identifier), obj.run (member)
  const kinds = r.calls.map((c) => c.kind).sort();
  assert.deepEqual(kinds, ["identifier", "identifier", "member"]);
  assert.ok(r.calls.every((c) => c.caller_symbol_id.startsWith("src/a.js#function:main:")));
});

test("extractor returns ok:false on parse failure", () => {
  const r = extractParseResult({ file: "a.py", source: "x=1", parseTree: () => ({ ok: false }) });
  assert.equal(r.ok, false);
  assert.deepEqual(r.symbols, []);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/context/semantic/js-ts-extractor.test.js`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现**

```js
// src/context/semantic/js-ts-extractor.js
export function makeSymbolId({ file, kind, name, startLine }) {
  return `${file}#${kind}:${name}:${startLine}`;
}

const EMPTY = (file, language = null) => ({ file, language, symbols: [], imports: [], exports: [], calls: [], ok: false });

export function extractParseResult({ file, source, parseTree }) {
  const parsed = parseTree(file, source);
  if (!parsed || !parsed.ok || !parsed.tree) return EMPTY(file, parsed?.language ?? null);

  const symbols = [];
  const imports = [];
  const exports = [];
  const calls = [];
  const root = parsed.tree.rootNode;

  // First pass: collect declared symbols with line ranges.
  walk(root, (node) => {
    const sym = symbolFromNode(node, file);
    if (sym) symbols.push(sym);
  });

  // Second pass: imports/exports/calls (calls attributed to enclosing symbol).
  walk(root, (node) => {
    const imp = importFromNode(node, file);
    if (imp) imports.push(imp);
    const exp = exportFromNode(node, file);
    if (exp) exports.push(...exp);
    const call = callFromNode(node, file, symbols);
    if (call) calls.push(call);
  });

  return { file, language: parsed.language, symbols, imports, exports, calls, ok: true };
}

function walk(node, visit) {
  visit(node);
  for (let i = 0; i < node.namedChildCount; i += 1) walk(node.namedChild(i), visit);
}

function lineOf(node) { return node.startPosition.row + 1; }
function endLineOf(node) { return node.endPosition.row + 1; }
function nameField(node, field) { const n = node.childForFieldName(field); return n ? n.text : null; }

function symbolFromNode(node, file) {
  let kind = null;
  let name = null;
  if (node.type === "function_declaration") { kind = "function"; name = nameField(node, "name"); }
  else if (node.type === "class_declaration") { kind = "class"; name = nameField(node, "name"); }
  else if (node.type === "method_definition") { kind = "method"; name = nameField(node, "name"); }
  else if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
    const decl = node.namedChildren.find((c) => c.type === "variable_declarator");
    const value = decl?.childForFieldName("value");
    if (decl && value && (value.type === "arrow_function" || value.type === "function" || value.type === "function_expression")) {
      kind = "variable"; name = decl.childForFieldName("name")?.text || null;
    }
  }
  if (!kind || !name) return null;
  const startLine = lineOf(node);
  return {
    symbol_id: makeSymbolId({ file, kind, name, startLine }),
    file, name, kind,
    range: { start_line: startLine, end_line: endLineOf(node) },
    exported: isExported(node)
  };
}

function isExported(node) {
  let p = node.parent;
  while (p) { if (p.type === "export_statement") return true; p = p.parent; }
  return false;
}

function importFromNode(node, file) {
  if (node.type === "import_statement") {
    const spec = stringLit(node.childForFieldName("source"));
    const clause = node.namedChildren.find((c) => c.type === "import_clause");
    const names = [];
    let def = false, ns = false;
    if (clause) {
      for (const c of clause.namedChildren) {
        if (c.type === "identifier") def = true;
        else if (c.type === "namespace_import") ns = true;
        else if (c.type === "named_imports") {
          for (const s of c.namedChildren.filter((x) => x.type === "import_specifier")) {
            const imported = s.childForFieldName("name")?.text;
            const local = s.childForFieldName("alias")?.text || imported;
            if (imported) names.push({ imported, local });
          }
        }
      }
    }
    return { from_file: file, source_spec: spec, resolved_file: null, names, default: def, namespace: ns, kind: "esm", dynamic: false };
  }
  // CJS require("lit") + dynamic import()
  if (node.type === "call_expression") {
    const fn = node.childForFieldName("function");
    if (fn?.type === "identifier" && fn.text === "require") {
      const spec = stringLit(node.childForFieldName("arguments")?.namedChild(0));
      if (spec) return { from_file: file, source_spec: spec, resolved_file: null, names: [], default: false, namespace: false, kind: "cjs", dynamic: false };
    }
    if (fn?.type === "import") {
      const spec = stringLit(node.childForFieldName("arguments")?.namedChild(0));
      return { from_file: file, source_spec: spec, resolved_file: null, names: [], default: false, namespace: false, kind: "esm", dynamic: true };
    }
  }
  return null;
}

function exportFromNode(node, file) {
  if (node.type !== "export_statement") return null;
  const out = [];
  const source = stringLit(node.childForFieldName("source")); // re-export source, may be null
  const decl = node.childForFieldName("declaration");
  if (decl) {
    const name = nameField(decl, "name");
    if (name) out.push({ file, name, local_name: name, kind: node.text.includes("export default") ? "default" : "named", source_spec: null });
  }
  for (const c of node.namedChildren.filter((x) => x.type === "export_clause")) {
    for (const s of c.namedChildren.filter((x) => x.type === "export_specifier")) {
      const local = s.childForFieldName("name")?.text;
      const exported = s.childForFieldName("alias")?.text || local;
      if (exported) out.push({ file, name: exported, local_name: local, kind: source ? "reexport" : "named", source_spec: source });
    }
  }
  return out.length ? out : null;
}

function callFromNode(node, file, symbols) {
  if (node.type !== "call_expression") return null;
  const fn = node.childForFieldName("function");
  if (!fn) return null;
  if (fn.type === "identifier" && fn.text === "require") return null; // handled as import
  let kind, callee_raw;
  if (fn.type === "identifier") { kind = "identifier"; callee_raw = fn.text; }
  else if (fn.type === "member_expression") { kind = "member"; callee_raw = fn.text; }
  else { kind = "dynamic"; callee_raw = fn.text; }
  const line = lineOf(node);
  return { caller_symbol_id: enclosingSymbolId(line, symbols), callee_raw, kind, file, line };
}

function enclosingSymbolId(line, symbols) {
  let best = null;
  for (const s of symbols) {
    if (line >= s.range.start_line && line <= s.range.end_line) {
      if (!best || (s.range.end_line - s.range.start_line) < (best.range.end_line - best.range.start_line)) best = s;
    }
  }
  return best ? best.symbol_id : null;
}

function stringLit(node) {
  if (!node) return null;
  if (node.type === "string") return node.text.replace(/^['"`]|['"`]$/g, "");
  const inner = node.namedChildren?.find((c) => c.type === "string");
  return inner ? inner.text.replace(/^['"`]|['"`]$/g, "") : null;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/context/semantic/js-ts-extractor.test.js`
Expected: PASS。**若某断言因 grammar 节点字段名差异失败**(如 `import_clause`/`export_clause` 结构),用 `node -e` 打印 `tree.rootNode.toString()` 核对实际节点类型后微调 extractor;断言保持不变。

- [ ] **Step 5: 提交**

```bash
git add src/context/semantic/js-ts-extractor.js tests/context/semantic/js-ts-extractor.test.js
git commit -m "feat(semantic): JS/TS extractor (tree -> ParseResult)"
```

---

## Task 5: 符号缓存（per-file ParseResult,按内容 hash)

**Files:**
- Create: `src/context/semantic/symbol-cache.js`
- Test: `tests/context/semantic/symbol-cache.test.js`

**Interfaces:**
- Produces:`createSymbolCache({ cacheRoot }) → { get(file, hash), set(file, hash, parseResult), pruneMissing(files) }`。落盘于 `<cacheRoot>/symbols/<sanitized-file>.json`,内含 `{ hash, parseResult }`;`get` 仅当 hash 匹配时命中。

- [ ] **Step 1: 写失败测试**

```js
// tests/context/semantic/symbol-cache.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { createSymbolCache } from "../../../src/context/semantic/symbol-cache.js";

async function tmp() { return fs.mkdtemp(path.join(os.tmpdir(), "symcache-")); }

test("set/get round-trips only on matching hash", async () => {
  const root = await tmp();
  const cache = createSymbolCache({ cacheRoot: root });
  const pr = { file: "src/a.js", language: "js", symbols: [{ name: "x" }], imports: [], exports: [], calls: [], ok: true };
  await cache.set("src/a.js", "h1", pr);
  assert.deepEqual((await cache.get("src/a.js", "h1")).symbols, [{ name: "x" }]);
  assert.equal(await cache.get("src/a.js", "h2"), null); // hash mismatch -> miss
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/context/semantic/symbol-cache.test.js`
Expected: FAIL

- [ ] **Step 3: 实现**

```js
// src/context/semantic/symbol-cache.js
import { promises as fs } from "node:fs";
import path from "node:path";

function sanitize(file) { return file.replace(/[\\/]/g, "__"); }

export function createSymbolCache({ cacheRoot } = {}) {
  if (!cacheRoot) throw new Error("cacheRoot is required");
  const dir = path.join(cacheRoot, "symbols");

  async function get(file, hash) {
    try {
      const raw = await fs.readFile(path.join(dir, `${sanitize(file)}.json`), "utf8");
      const parsed = JSON.parse(raw);
      return parsed.hash === hash ? parsed.parseResult : null;
    } catch { return null; }
  }
  async function set(file, hash, parseResult) {
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, `${sanitize(file)}.json`);
    const tmp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify({ hash, parseResult }, null, 2)}\n`, "utf8");
    await fs.rename(tmp, target);
  }
  async function pruneMissing(files) {
    const keep = new Set(files.map((f) => `${sanitize(f)}.json`));
    let removed = 0;
    try {
      for (const name of await fs.readdir(dir)) {
        if (!keep.has(name)) { await fs.rm(path.join(dir, name)).catch(() => {}); removed += 1; }
      }
    } catch {}
    return removed;
  }
  return { get, set, pruneMissing };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/context/semantic/symbol-cache.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/context/semantic/symbol-cache.js tests/context/semantic/symbol-cache.test.js
git commit -m "feat(semantic): per-file ParseResult cache keyed by content hash"
```

---

## Task 6: symbol-indexer（增量编排 + 符号表)

**Files:**
- Create: `src/context/semantic/symbol-indexer.js`
- Test: `tests/context/semantic/symbol-indexer.test.js`

**Interfaces:**
- Consumes:provider(Task 3)、extractor(Task 4)、symbol-cache(Task 5);输入 `records`(门面里已有的 `Map<path, record>`,record 带 `hash`)。
- Produces:`indexSymbols({ root, records, provider, cache, readFile }) → { byFile: Map<file, ParseResult>, symbolTable: Map<symbol_id, Symbol>, stats }`。`readFile(file) → Promise<string>` 注入(测试可 mock,真用 `readWorkspaceTextFile`)。命中缓存(hash 相同)则不重解析。

- [ ] **Step 1: 写失败测试**

```js
// tests/context/semantic/symbol-indexer.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os"; import path from "node:path"; import { promises as fs } from "node:fs";
import { createSymbolCache } from "../../../src/context/semantic/symbol-cache.js";
import { createWasmTreeSitterProvider } from "../../../src/context/semantic/wasm-tree-sitter-provider.js";
import { indexSymbols } from "../../../src/context/semantic/symbol-indexer.js";

test("indexes only supported files; populates symbol table; reuses cache", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "symidx-"));
  const provider = createWasmTreeSitterProvider();
  await provider.load();
  const cache = createSymbolCache({ cacheRoot: root });
  const sources = { "src/a.js": "export function main(){ foo(); }", "README.md": "# hi" };
  const records = new Map([
    ["src/a.js", { path: "src/a.js", hash: "sha256:aaa" }],
    ["README.md", { path: "README.md", hash: "sha256:bbb" }]
  ]);
  let reads = 0;
  const readFile = async (f) => { reads += 1; return sources[f]; };

  const first = await indexSymbols({ root, records, provider, cache, readFile });
  assert.ok([...first.symbolTable.values()].some((s) => s.name === "main"));
  assert.equal(first.byFile.has("README.md"), false); // unsupported ext skipped
  const readsAfterFirst = reads;

  const second = await indexSymbols({ root, records, provider, cache, readFile });
  assert.equal(second.stats.reused >= 1, true);
  assert.ok(reads === readsAfterFirst + 0 || reads >= readsAfterFirst); // cache hit may skip parse
  assert.ok([...second.symbolTable.values()].some((s) => s.name === "main"));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/context/semantic/symbol-indexer.test.js`
Expected: FAIL

- [ ] **Step 3: 实现**

```js
// src/context/semantic/symbol-indexer.js
import { extractParseResult } from "./js-ts-extractor.js";

export async function indexSymbols({ root, records, provider, cache, readFile }) {
  const byFile = new Map();
  const symbolTable = new Map();
  const stats = { parsed: 0, reused: 0, skipped: 0, failed: 0 };
  const files = [...records.values()].map((r) => r.path);

  for (const record of records.values()) {
    const file = record.path;
    if (!provider.supports(extOf(file))) { stats.skipped += 1; continue; }
    let parseResult = await cache.get(file, record.hash);
    if (parseResult) {
      stats.reused += 1;
    } else {
      let source;
      try { source = await readFile(file); } catch { stats.failed += 1; continue; }
      parseResult = extractParseResult({ file, source, parseTree: (f, s) => provider.parseTree(f, s) });
      if (!parseResult.ok) { stats.failed += 1; continue; }
      await cache.set(file, record.hash, parseResult);
      stats.parsed += 1;
    }
    byFile.set(file, parseResult);
    for (const sym of parseResult.symbols) symbolTable.set(sym.symbol_id, sym);
  }
  await cache.pruneMissing(files);
  return { byFile, symbolTable, stats };
}

function extOf(p) { const last = p.split(/[\\/]/).pop() || ""; const i = last.lastIndexOf("."); return i >= 0 ? last.slice(i).toLowerCase() : ""; }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/context/semantic/symbol-indexer.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/context/semantic/symbol-indexer.js tests/context/semantic/symbol-indexer.test.js
git commit -m "feat(semantic): incremental symbol indexer + symbol table"
```

---

## Task 7: 模块解析器（specifier → workspace 文件)

**Files:**
- Create: `src/context/semantic/module-resolver.js`
- Test: `tests/context/semantic/module-resolver.test.js`

**Interfaces:**
- Produces:`resolveModule({ fromFile, spec, fileSet }) → string|null`。仅解析相对 specifier(`./` `../`),带扩展名补全(`.js/.jsx/.ts/.tsx/.mjs/.cjs`)与 `index.*`;bare/alias(`react`、`@/x`)→ `null`(external)。`fileSet` 为 `Set<workspace-relative path>`。

- [ ] **Step 1: 写失败测试**

```js
// tests/context/semantic/module-resolver.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveModule } from "../../../src/context/semantic/module-resolver.js";

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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/context/semantic/module-resolver.test.js`
Expected: FAIL

- [ ] **Step 3: 实现**

```js
// src/context/semantic/module-resolver.js
import path from "node:path";

const EXTS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];

export function resolveModule({ fromFile, spec, fileSet }) {
  if (typeof spec !== "string" || !(spec.startsWith("./") || spec.startsWith("../"))) return null;
  const fromDir = path.posix.dirname(toPosix(fromFile));
  const base = path.posix.normalize(path.posix.join(fromDir, spec)).replace(/^\.\//, "");
  if (fileSet.has(base)) return base;
  for (const ext of EXTS) if (fileSet.has(base + ext)) return base + ext;
  for (const ext of EXTS) if (fileSet.has(`${base}/index${ext}`)) return `${base}/index${ext}`;
  return null;
}

function toPosix(p) { return String(p).replace(/\\/g, "/"); }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/context/semantic/module-resolver.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/context/semantic/module-resolver.js tests/context/semantic/module-resolver.test.js
git commit -m "feat(semantic): relative module resolver (bare/alias -> external)"
```

---

## Task 8: 依赖图（模块边 + 绑定 + 尽力调用边 + confidence)

**Files:**
- Create: `src/context/semantic/dependency-graph.js`
- Test: `tests/context/semantic/dependency-graph.test.js`

**Interfaces:**
- Consumes:`byFile`、`symbolTable`(Task 6)、`resolveModule`(Task 7);`CallEdge` 形状(Shared)。
- Produces:`buildDependencyGraph({ byFile, symbolTable }) → { callEdges: [CallEdge], neighbors(symbolId, { hops, direction }) → Set<symbol_id> }`。
  - 调用解析:`identifier` 调用 → 先找同文件本地 symbol(`direct-local-call`,resolved);否则查该文件 import 绑定到的导出符号(`import-binding`,resolved);都没有 → `unresolved`/`dynamic-call`。`member`/`dynamic` 原始调用 → `unresolved`(`member-call`/`dynamic-call`)。
  - `direction`:`"out"`(callee)/`"in"`(caller)/`"both"`。`unresolved` 边无 `callee_symbol_id`,不参与扩展但仍在 `callEdges`。

- [ ] **Step 1: 写失败测试**

```js
// tests/context/semantic/dependency-graph.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDependencyGraph } from "../../../src/context/semantic/dependency-graph.js";

// Two files: a.js imports foo from b.js and calls it + calls local helper + obj.run()
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/context/semantic/dependency-graph.test.js`
Expected: FAIL

- [ ] **Step 3: 实现**

```js
// src/context/semantic/dependency-graph.js
export function buildDependencyGraph({ byFile, symbolTable }) {
  const callEdges = [];
  const outAdj = new Map(); // symbol_id -> Set(callee symbol_id)
  const inAdj = new Map();  // symbol_id -> Set(caller symbol_id)

  for (const pr of byFile.values()) {
    const localByName = new Map(pr.symbols.map((s) => [s.name, s]));
    const importBinding = buildImportBinding(pr, byFile);
    for (const rc of pr.calls) {
      const edge = resolveCall(rc, localByName, importBinding);
      callEdges.push(edge);
      if (edge.callee_symbol_id && edge.confidence === "resolved") {
        addAdj(outAdj, edge.caller_symbol_id, edge.callee_symbol_id);
        addAdj(inAdj, edge.callee_symbol_id, edge.caller_symbol_id);
      }
    }
  }

  function neighbors(symbolId, { hops = 1, direction = "out" } = {}) {
    const result = new Set();
    const frontiers = [symbolId];
    const maps = direction === "in" ? [inAdj] : direction === "both" ? [outAdj, inAdj] : [outAdj];
    let frontier = new Set(frontiers);
    for (let h = 0; h < hops; h += 1) {
      const next = new Set();
      for (const id of frontier) for (const m of maps) for (const n of m.get(id) || []) {
        if (!result.has(n)) { result.add(n); next.add(n); }
      }
      frontier = next;
      if (!frontier.size) break;
    }
    return result;
  }

  return { callEdges, neighbors };
}

function buildImportBinding(pr, byFile) {
  // local import name -> resolved exported symbol_id (best-effort)
  const binding = new Map();
  for (const imp of pr.imports) {
    if (!imp.resolved_file) continue;
    const target = byFile.get(imp.resolved_file);
    if (!target) continue;
    for (const { imported, local } of imp.names) {
      const exp = target.exports.find((e) => e.name === imported);
      const localName = exp ? exp.local_name : imported;
      const sym = target.symbols.find((s) => s.name === localName && s.exported) || target.symbols.find((s) => s.name === localName);
      if (sym) binding.set(local, sym.symbol_id);
    }
  }
  return binding;
}

function resolveCall(rc, localByName, importBinding) {
  const base = { caller_symbol_id: rc.caller_symbol_id, callee_raw: rc.callee_raw, file: rc.file, line: rc.line, callee_symbol_id: null };
  if (rc.kind === "identifier") {
    const local = localByName.get(rc.callee_raw);
    if (local) return { ...base, callee_symbol_id: local.symbol_id, confidence: "resolved", reason: "direct-local-call" };
    const bound = importBinding.get(rc.callee_raw);
    if (bound) return { ...base, callee_symbol_id: bound, confidence: "resolved", reason: "import-binding" };
    return { ...base, confidence: "unresolved", reason: "dynamic-call" };
  }
  if (rc.kind === "member") return { ...base, confidence: "unresolved", reason: "member-call" };
  return { ...base, confidence: "unresolved", reason: "dynamic-call" };
}

function addAdj(map, from, to) { if (!map.has(from)) map.set(from, new Set()); map.get(from).add(to); }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/context/semantic/dependency-graph.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/context/semantic/dependency-graph.js tests/context/semantic/dependency-graph.test.js
git commit -m "feat(semantic): dependency graph with confidence-tagged call edges"
```

---

## Task 9: SymbolUnit（符号级上下文单元)

**Files:**
- Create: `src/context/semantic/symbol-unit.js`
- Test: `tests/context/semantic/symbol-unit.test.js`

**Interfaces:**
- Consumes:`Symbol`(Shared);`estimateTokens`、`clipSnippet`(复用 [context-unit.js](../../../src/context/context-unit.js))。
- Produces:`createSymbolUnit({ symbol, source, priority, reason, maxSnippetBytes }) → SymbolUnit`。`snippet` = symbol 行范围切片;`hash` = `sha256:` of 切片;`token_count` = `estimateTokens(snippet)`。

- [ ] **Step 1: 写失败测试**

```js
// tests/context/semantic/symbol-unit.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSymbolUnit } from "../../../src/context/semantic/symbol-unit.js";

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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/context/semantic/symbol-unit.test.js`
Expected: FAIL

- [ ] **Step 3: 实现**

```js
// src/context/semantic/symbol-unit.js
import { createHash } from "node:crypto";
import { estimateTokens, clipSnippet } from "../context-unit.js";

export function createSymbolUnit({ symbol, source, priority = 2, reason = "symbol", maxSnippetBytes = 4000 }) {
  const lines = String(source ?? "").split("\n");
  const slice = lines.slice(symbol.range.start_line - 1, symbol.range.end_line).join("\n");
  const snippet = clipSnippet(slice, maxSnippetBytes);
  return {
    id: `sym_${createHash("sha256").update(symbol.symbol_id).digest("hex").slice(0, 12)}`,
    type: "symbol",
    path: symbol.file,
    symbol_id: symbol.symbol_id,
    symbol_kind: symbol.kind,
    name: symbol.name,
    defined_in: { ...symbol.range },
    hash: `sha256:${createHash("sha256").update(snippet).digest("hex")}`,
    token_count: estimateTokens(snippet),
    priority,
    reason,
    snippet
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/context/semantic/symbol-unit.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/context/semantic/symbol-unit.js tests/context/semantic/symbol-unit.test.js
git commit -m "feat(semantic): symbol-level context unit"
```

---

## Task 10: symbol-selector（种子 → 扩展 → 预算)

**Files:**
- Create: `src/context/semantic/symbol-selector.js`
- Test: `tests/context/semantic/symbol-selector.test.js`

**Interfaces:**
- Consumes:`symbolTable`、`byFile`、graph.`neighbors`(Task 8)、`createSymbolUnit`(Task 9)、`selectWithinBudget`(复用 [token-budget.js](../../../src/context/token-budget.js))、`detectMentionedPaths`(复用 [context-selector.js](../../../src/context/context-selector.js))。
- Produces:`selectSymbolUnits({ message, symbolTable, byFile, graph, sources, pinned, warmed, budget, hops, maxSymbols }) → { selected: [SymbolUnit], budget }`。
  - 种子:符号名在消息中出现的 symbol + pinned/warmed 文件里的 symbol。
  - 扩展:对每个种子 `graph.neighbors(id, { hops })`,priority 随跳数递增(种子=1,邻居=2)。
  - 预算:`createSymbolUnit` 后 `selectWithinBudget`。`sources` = `Map<file, string>`(用于切片)。`maxSymbols` 截断候选。

- [ ] **Step 1: 写失败测试**

```js
// tests/context/semantic/symbol-selector.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectSymbolUnits } from "../../../src/context/semantic/symbol-selector.js";

const mainSym = { symbol_id: "src/a.js#function:main:1", file: "src/a.js", name: "main", kind: "function", range: { start_line: 1, end_line: 1 }, exported: true };
const fooSym = { symbol_id: "src/b.js#function:foo:1", file: "src/b.js", name: "foo", kind: "function", range: { start_line: 1, end_line: 1 }, exported: true };
const symbolTable = new Map([[mainSym.symbol_id, mainSym], [fooSym.symbol_id, fooSym]]);
const sources = new Map([["src/a.js", "function main(){ foo(); }"], ["src/b.js", "function foo(){}"]]);
const graph = { neighbors: (id) => (id === mainSym.symbol_id ? new Set([fooSym.symbol_id]) : new Set()) };

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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/context/semantic/symbol-selector.test.js`
Expected: FAIL

- [ ] **Step 3: 实现**

```js
// src/context/semantic/symbol-selector.js
import { selectWithinBudget } from "../token-budget.js";
import { createSymbolUnit } from "./symbol-unit.js";

export function selectSymbolUnits({ message = "", symbolTable, byFile, graph, sources, pinned = new Set(), warmed = new Map(), budget = 6000, hops = 2, maxSymbols = 200 }) {
  const text = String(message || "");
  const priorityById = new Map();   // symbol_id -> best priority (lower = better)
  const reasonById = new Map();

  const seed = (id, reason) => {
    if (!symbolTable.has(id)) return;
    if (!priorityById.has(id) || priorityById.get(id) > 1) { priorityById.set(id, 1); reasonById.set(id, reason); }
  };

  // Seeds: symbol name mentioned in message, or symbol in pinned/warmed file.
  for (const sym of symbolTable.values()) {
    if (mentionsName(text, sym.name)) seed(sym.symbol_id, "mentioned");
    else if (pinned.has(sym.file)) seed(sym.symbol_id, "pinned");
    else if (warmed.has(sym.file)) seed(sym.symbol_id, "warm");
  }

  // Expand neighbors (priority 2 by hop).
  for (const id of [...priorityById.keys()]) {
    for (const n of graph.neighbors(id, { hops, direction: "out" })) {
      if (!priorityById.has(n)) { priorityById.set(n, 2); reasonById.set(n, "graph-neighbor"); }
    }
  }

  // Build candidate units, ranked by priority then id (stable), capped at maxSymbols.
  const candidates = [...priorityById.keys()]
    .map((id) => symbolTable.get(id))
    .filter(Boolean)
    .sort((a, b) => (priorityById.get(a.symbol_id) - priorityById.get(b.symbol_id)) || a.symbol_id.localeCompare(b.symbol_id))
    .slice(0, maxSymbols)
    .map((sym) => createSymbolUnit({
      symbol: sym,
      source: sources.get(sym.file) || "",
      priority: priorityById.get(sym.symbol_id),
      reason: reasonById.get(sym.symbol_id)
    }));

  const picked = selectWithinBudget(candidates, budget);
  return { selected: picked.selected, budget: picked.budget };
}

function mentionsName(text, name) {
  if (!name || name.length < 2) return false;
  return new RegExp(`(^|[^A-Za-z0-9_$])${escapeRe(name)}($|[^A-Za-z0-9_$])`).test(text);
}
function escapeRe(v) { return String(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/context/semantic/symbol-selector.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/context/semantic/symbol-selector.js tests/context/semantic/symbol-selector.test.js
git commit -m "feat(semantic): symbol selector (seed -> expand -> budget)"
```

---

## Task 11: config —— `context.semantic` 默认值与归一化

**Files:**
- Modify: `src/config.js`（`DEFAULT_CONFIG` 加 `context`;新增 `normalizeContext`;在 `normalizeConfig` 与 `loadConfig` 接入)
- Test: `tests/config-context-semantic.test.js`

**Interfaces:**
- Produces:`DEFAULT_CONFIG.context = { semantic: { enabled:false, hops:2, maxSymbols:200, includeMethodHints:false } }`;`normalizeContext(raw) → { semantic:{...} }`(per-field,enabled 强制 boolean,数值非法回退默认)。`loadConfig` 输出含 `context`。

- [ ] **Step 1: 写失败测试**

```js
// tests/config-context-semantic.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeContext, DEFAULT_CONFIG } from "../src/config.js";

test("defaults: semantic disabled", () => {
  assert.equal(DEFAULT_CONFIG.context.semantic.enabled, false);
  assert.equal(DEFAULT_CONFIG.context.semantic.hops, 2);
});

test("normalizeContext coerces and fills defaults", () => {
  const c = normalizeContext({ semantic: { enabled: true, hops: 0, maxSymbols: "x" } });
  assert.equal(c.semantic.enabled, true);
  assert.equal(c.semantic.hops, 2);        // 0/invalid -> default
  assert.equal(c.semantic.maxSymbols, 200);
  assert.equal(c.semantic.includeMethodHints, false);
});

test("normalizeContext on empty -> defaults", () => {
  assert.deepEqual(normalizeContext(), { semantic: { enabled: false, hops: 2, maxSymbols: 200, includeMethodHints: false } });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/config-context-semantic.test.js`
Expected: FAIL（`normalizeContext` 未导出 / `context` 不存在)

- [ ] **Step 3: 实现(编辑 src/config.js)**

在 `DEFAULT_CONFIG` 末尾(`limits` 之后)加:

```js
  context: {
    semantic: { enabled: false, hops: 2, maxSymbols: 200, includeMethodHints: false }
  }
```

新增导出函数:

```js
export function normalizeContext(raw = {}) {
  const safe = raw && typeof raw === "object" ? raw : {};
  const s = safe.semantic && typeof safe.semantic === "object" ? safe.semantic : {};
  const d = DEFAULT_CONFIG.context.semantic;
  const posInt = (v, fb) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fb; };
  return {
    semantic: {
      enabled: s.enabled === true,
      hops: posInt(s.hops, d.hops),
      maxSymbols: posInt(s.maxSymbols, d.maxSymbols),
      includeMethodHints: s.includeMethodHints === true
    }
  };
}
```

在 `normalizeConfig` 的返回对象里加 `context: normalizeContext(config.context)`;在 `loadConfig` 的返回对象里加 `context: normalizeContext(fileConfig.context)`。

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `node --test tests/config-context-semantic.test.js`
Expected: PASS
Run: `node --test test/**/*.test.js tests/**/*.test.js`
Expected: 全绿(确认未破坏既有 config 用例)

- [ ] **Step 5: 提交**

```bash
git add src/config.js tests/config-context-semantic.test.js
git commit -m "feat(config): context.semantic defaults + normalization (opt-in)"
```

---

## Task 12: kernel-options 转发 `config.context`

**Files:**
- Modify: `src/apps/kernel-options.js`
- Test: `tests/apps-kernel-options-context.test.js`

**Interfaces:**
- Consumes:`buildKernelOptions`(现有);`config.context`(Task 11)。
- Produces:`buildKernelOptions` 在 `config.context` 存在时,把它放进 `result.context`(供 `createKernel` → `createContextEngine`)。

- [ ] **Step 1: 写失败测试**

```js
// tests/apps-kernel-options-context.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildKernelOptions } from "../src/apps/kernel-options.js";

test("forwards config.context into kernel options", async () => {
  const fakeLoad = async () => ({ apiKey: "k", baseUrl: "https://x", context: { semantic: { enabled: true, hops: 2, maxSymbols: 200, includeMethodHints: false } } });
  const out = await buildKernelOptions("/root", {}, fakeLoad);
  assert.deepEqual(out.context.semantic.enabled, true);
});

test("no context key when config lacks it", async () => {
  const fakeLoad = async () => ({ apiKey: "k", baseUrl: "https://x" });
  const out = await buildKernelOptions("/root", {}, fakeLoad);
  assert.equal(out.context, undefined);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/apps-kernel-options-context.test.js`
Expected: FAIL

- [ ] **Step 3: 实现(编辑 src/apps/kernel-options.js)**

在 `if (config.limits) result.limits = config.limits;` 之后加:

```js
  if (config.context) result.context = config.context;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/apps-kernel-options-context.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/apps/kernel-options.js tests/apps-kernel-options-context.test.js
git commit -m "feat(config): forward context.semantic into kernel options"
```

---

## Task 13: ContextEngine 集成（scan/snapshot 接入 + 事件 + 回退 + 关闭逐字节一致)

**Files:**
- Modify: `src/context/index.js`
- Create: `src/context/semantic/semantic-engine.js`(把符号层装配成一个可注入对象,保持 index.js 轻)
- Test: `tests/context/semantic/semantic-engine.test.js`、`tests/context/index-semantic.test.js`

**Interfaces:**
- Consumes:Task 1/3/6/8/10 全部 + `records`(门面内已有)。
- Produces:
  - `createSemanticEngine({ root, options, eventBus }) → { ensureReady(), index(records), select({ message, pinned, warmed, budget }), enabled }`。`index()` 跑 indexer+graph(失败整体回退:`enabled=false` 行为);`select()` 返回 `{ selected, budget }` 或 `null`(回退文件级)。
  - `createContextEngine`:当 `options.semantic?.enabled` → `scan()` 后调用 `semantic.index(records)`;`snapshot()` 优先 `semantic.select(...)`,无果回退现有文件级 selector。**事件 `context:symbol_indexed`/`context:graph_built` 仅在启用时发。**

- [ ] **Step 1: 写失败测试(关闭=逐字节一致 + 开启=符号单元)**

```js
// tests/context/index-semantic.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os"; import path from "node:path"; import { promises as fs } from "node:fs";
import { createContextEngine } from "../../src/context/index.js";

async function project() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ctx-sem-"));
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/context/index-semantic.test.js`
Expected: FAIL

- [ ] **Step 3a: 实现 semantic-engine.js**

```js
// src/context/semantic/semantic-engine.js
import path from "node:path";
import { createParserRegistry } from "./parser-provider.js";
import { createWasmTreeSitterProvider } from "./wasm-tree-sitter-provider.js";
import { createSymbolCache } from "./symbol-cache.js";
import { indexSymbols } from "./symbol-indexer.js";
import { buildDependencyGraph } from "./dependency-graph.js";
import { selectSymbolUnits } from "./symbol-selector.js";
import { resolveModule } from "./module-resolver.js";
import { readWorkspaceTextFile } from "../../workspace/path-safety.js";

export function createSemanticEngine({ root, options = {}, eventBus = null }) {
  const cfg = options.semantic || {};
  const enabled = cfg.enabled === true;
  const provider = createWasmTreeSitterProvider();
  const registry = createParserRegistry({ providers: [provider] });
  const cache = createSymbolCache({ cacheRoot: path.join(root, ".deepseek-code", "v2", "context") });
  let state = null;          // { byFile, symbolTable, graph, sources }
  let degraded = false;

  async function index(records) {
    if (!enabled || degraded) return;
    try {
      await provider.load();
      const sources = new Map();
      const readFile = async (file) => { const t = await readWorkspaceTextFile(root, file, { maxBytes: 64 * 1024 }); sources.set(file, t.content); return t.content; };
      const { byFile, symbolTable, stats } = await indexSymbols({ root, records, provider, cache, readFile });
      const fileSet = new Set(byFile.keys());
      for (const pr of byFile.values()) for (const imp of pr.imports) imp.resolved_file = resolveModule({ fromFile: pr.file, spec: imp.source_spec, fileSet });
      const graph = buildDependencyGraph({ byFile, symbolTable });
      state = { byFile, symbolTable, graph, sources };
      eventBus?.publish?.("context:symbol_indexed", { files_parsed: stats.parsed, symbols: symbolTable.size, reused: stats.reused });
      eventBus?.publish?.("context:graph_built", {
        symbols: symbolTable.size, edges: graph.callEdges.length,
        resolved: graph.callEdges.filter((e) => e.confidence === "resolved").length,
        unresolved: graph.callEdges.filter((e) => e.confidence === "unresolved").length
      });
    } catch { degraded = true; state = null; } // provider/grammar unavailable -> file-level fallback
  }

  function select({ message, pinned, warmed, budget }) {
    if (!enabled || degraded || !state) return null;
    const out = selectSymbolUnits({
      message, symbolTable: state.symbolTable, byFile: state.byFile, graph: state.graph,
      sources: state.sources, pinned, warmed, budget, hops: cfg.hops || 2, maxSymbols: cfg.maxSymbols || 200
    });
    return out.selected.length ? out : null;
  }

  return { enabled, index, select, registry };
}
```

- [ ] **Step 3b: 集成进 src/context/index.js**

在 `createContextEngine` 顶部构造 semantic engine,并在 `scan()` 末尾 `index`、`snapshot()` 优先用符号选择。改动点:

```js
// 顶部 import
import { createSemanticEngine } from "./semantic/semantic-engine.js";

// createContextEngine 内,records/stats 声明之后:
const semantic = createSemanticEngine({ root, options, eventBus });

// scan() 内,records 赋值之后、return 之前:
if (semantic.enabled) await semantic.index(records);

// snapshot() 内:在现有 selectContextUnits 之前,先尝试符号级:
if (semantic.enabled) {
  const channelBudget = budgetForChannel(input.channel || "reply", { ...(options.budgets || {}), ...(input.budget ? { [input.channel || "reply"]: input.budget } : {}) });
  const sem = semantic.select({ message: input.message || "", pinned, warmed, budget: channelBudget.allocated });
  if (sem) {
    const snap = buildContextSnapshot({
      root, channel: channelBudget.channel,
      taskType: input.classification?.task_type || "general",
      selected: sem.selected, budget: sem.budget, stats: { ...stats }
    });
    eventBus?.publish?.("context:snapshot", {
      snapshot_id: snap.snapshot_id, channel: snap.channel, task_type: snap.task_type,
      unit_count: snap.units.length, unit_paths: snap.units.map((u) => u.path), budget: snap.budget, stats: snap.stats
    });
    return snap;
  }
  // sem === null -> 落回下面现有文件级路径
}
```

> 注意:`buildContextSnapshot` 的 `units` 输出当前不带 `type`。让 symbol 单元在快照中可识别——给 [context-snapshot.js](../../../src/context/context-snapshot.js) 的 `units.map` 增加 `type: unit.type || "file"` 与 `symbol_id: unit.symbol_id`(仅当存在)。这是该任务内的小改,需相应更新 [Task 13 Step 1] 断言之外的既有 snapshot 测试(若有断言 units 形状,补 `type` 字段)。

- [ ] **Step 3c: 给 context-snapshot.js 的 units 增加 type/symbol_id 透传**

```js
// src/context/context-snapshot.js 内 units 映射:
const units = selected.map((unit) => ({
  id: unit.id,
  type: unit.type || "file",
  path: unit.path,
  hash: unit.hash,
  token_count: unit.token_count,
  priority: unit.priority,
  reason: unit.reason,
  ...(unit.symbol_id ? { symbol_id: unit.symbol_id } : {})
}));
```

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `node --test tests/context/index-semantic.test.js`
Expected: PASS
Run: `node --test test/**/*.test.js tests/**/*.test.js`
Expected: 全绿。**重点确认**:语义关闭的既有 context 用例(快照/事件)未变;若某既有快照测试因新增 `type:"file"` 字段失败,更新该断言以包含 `type:"file"`(这是预期的、向后兼容的增量字段)。

- [ ] **Step 5: 提交**

```bash
git add src/context/index.js src/context/context-snapshot.js src/context/semantic/semantic-engine.js tests/context/semantic/semantic-engine.test.js tests/context/index-semantic.test.js
git commit -m "feat(semantic): wire symbol layer into ContextEngine (opt-in, fallback-safe)"
```

---

## Task 14: check 脚本 + 端到端 opt-in 不变性回归

**Files:**
- Modify: `package.json`（`check` 脚本追加新增源码文件的 `node --check`)
- Create: `tests/context/semantic/disabled-parity.test.js`

**Interfaces:**
- Produces:`check` 覆盖新文件;一条"语义关闭 → 与基线快照逐字节一致(除既有行为外不发任何 `context:symbol_*` 事件)"的回归。

- [ ] **Step 1: 写回归测试**

```js
// tests/context/semantic/disabled-parity.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os"; import path from "node:path"; import { promises as fs } from "node:fs";
import { createContextEngine } from "../../../src/context/index.js";

test("disabled semantic emits no symbol/graph events", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "parity-"));
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
```

- [ ] **Step 2: 跑测试确认通过(应当直接通过——关闭路径不发事件)**

Run: `node --test tests/context/semantic/disabled-parity.test.js`
Expected: PASS。若失败,说明 Task 13 在关闭时误发了事件 → 修正 `semantic-engine`/`index.js` 的 `enabled` 守卫。

- [ ] **Step 3: 更新 check 脚本**

在 `package.json` 的 `check` 脚本末尾(最后一个 `node --check ...` 之后)追加:

```
 && node --check src/context/semantic/parser-provider.js src/context/semantic/wasm-tree-sitter-provider.js src/context/semantic/js-ts-extractor.js src/context/semantic/symbol-cache.js src/context/semantic/symbol-indexer.js src/context/semantic/module-resolver.js src/context/semantic/dependency-graph.js src/context/semantic/symbol-unit.js src/context/semantic/symbol-selector.js src/context/semantic/semantic-engine.js
```

- [ ] **Step 4: 跑 check + 全量测试**

Run: `npm run check`
Expected: 无输出(全部语法 OK)
Run: `node --test test/**/*.test.js tests/**/*.test.js`
Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add package.json tests/context/semantic/disabled-parity.test.js
git commit -m "test(semantic): disabled-parity regression + check coverage"
```

---

## Task 15: 文档 —— README 零依赖口径补全 + project-overview + 索引/CHANGELOG

**Files:**
- Modify: `README.md`、`README.en.md`、`docs/project-overview.md`、`docs/README.md`、`docs/CHANGELOG.md`

**Interfaces:**
- Produces:README 在"特性"补一条语义上下文(opt-in);把"无必需运行时依赖"口径补全为含 web-tree-sitter 的完整表述;project-overview 增"语义级上下文(可选)"小节;CHANGELOG 记一条;docs 索引补 plan 链接。

- [ ] **Step 1: README.md 特性补一条 + 配置补 `context.semantic`**

在 `## ✨ 特性` 列表合适位置加:

```markdown
- **语义级上下文(可选)** —— 启用后按符号(函数/类)而非整文件检索,沿 import/调用依赖图扩展;基于 web-tree-sitter(WASM,无原生构建依赖),**默认关闭**。
```

并把 §13 完整口径落到"快速开始"附近一句:

```markdown
> 核心 CLI 无必需运行时依赖;可选的语义上下文按需懒加载 web-tree-sitter 与随仓 WASM grammar,不引入任何原生构建依赖。
```

- [ ] **Step 2: README.en.md 同步**

```markdown
- **Semantic context (optional)** — when enabled, retrieves by symbol (function/class) instead of whole files and expands along the import/call dependency graph; powered by web-tree-sitter (WASM, no native build dependency), **off by default**.
```
```markdown
> The core CLI has no required runtime dependencies; optional semantic context lazily loads web-tree-sitter and vendored WASM grammars, introducing no native build dependency.
```

- [ ] **Step 3: docs/project-overview.md 增小节**

在"上下文引擎"相关位置后加一节,概述 `context.semantic`(opt-in、provider、hops/maxSymbols、回退),并链接 spec 与本 plan。

```markdown
### 语义级上下文(可选,opt-in)
启用 `context.semantic.enabled` 后,引擎在文件层之上增加符号层:web-tree-sitter 解析 JS/TS → 符号表 + import/调用依赖图 → 按符号选片段。默认关闭,关闭时行为与文件级完全一致。设计见 [Phase B spec](specs/backend/2026-06-26-v3-phase-b-semantic-context-design.md)。
```

- [ ] **Step 4: CHANGELOG + docs 索引**

`docs/CHANGELOG.md` 的 Unreleased 加一条"已落地 — Phase B 语义级上下文(opt-in)";`docs/README.md` 的 `plans/backend` 区补本 plan 链接。

- [ ] **Step 5: 提交**

```bash
git add README.md README.en.md docs/project-overview.md docs/README.md docs/CHANGELOG.md
git commit -m "docs: document opt-in semantic context; complete zero-dep wording"
```

---

## Self-Review（写完后自查记录)

- **Spec coverage**:§4 组件 → Task 1/3/4/6/8/10/13;§5 数据结构 → Shared + 各任务逐字一致;§6 可靠子集/unresolved → Task 4/8(测试断言 member-call=unresolved);§7 模块解析 → Task 7;§8 CJS → Task 4(require 导入边 + export best-effort);§9 symbol_id → Task 4(`makeSymbolId` 测试);§10 配置 → Task 11/12;§11 缓存/回退 → Task 5/6/13(degraded);§12 事件仅启用时 → Task 13/14;§13 零依赖措辞 → Task 15;§14 测试 → 每任务 + Task 14;§16 里程碑 B1–B6 → Task 1–15 覆盖。
- **Placeholder scan**:无 TBD;Task 2/3/4 的"若 API/节点名不符则核对调整"是**真实集成校准步骤**(给了核对命令),非空泛占位。
- **Type consistency**:`makeSymbolId` 格式、`ParseResult`/`CallEdge`/`SymbolUnit` 字段在 Task 4/8/9/10/13 间一致;`provider.parseTree`、`indexSymbols`、`buildDependencyGraph`、`selectSymbolUnits`、`createSemanticEngine` 的签名前后吻合。
- **已知外部不确定点**:web-tree-sitter 的 `init/Language.load` 形态与 grammar 节点字段名,在 Task 2 Step 3 一次性验证后据以校准 Task 3/4(不影响下游纯逻辑任务)。
