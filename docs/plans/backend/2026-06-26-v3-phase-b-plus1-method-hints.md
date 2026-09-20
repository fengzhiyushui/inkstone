# Phase B+1 · 方法消歧(--include-method-hints)Implementation Plan

> 完成状态以 [CHANGELOG](../../CHANGELOG.md) 为准。


**Goal:** 点亮 `includeMethodHints` —— 开启后把 `obj.method()`(member 调用)在"项目内恰好一个同名可调用符号"时升级为 `confidence:"probable"` 边,并新增 CLI `--semantic-context` / `--include-method-hints`;默认关、关闭时行为逐字节不变。

**Architecture:** 纯增量,改动 5 个现有文件(extractor / dependency-graph / symbol-selector / semantic-engine / config 入口)+ docs。无新文件、无新依赖。`neighbors` 的返回从 `Set<id>` 升为 `Map<id, confidence>`(`Map.has` 兼容现有断言),`callEdges` 始终保留完整 confidence。

**Tech Stack:** Node ESM (Node ≥ 20)、`node:test` + `node:assert/strict`、web-tree-sitter(已有,opt-in 懒加载)。

## Global Constraints

- **默认关**:`context.semantic.includeMethodHints` 默认 false;**关闭时不产生任何 probable 边,邻接表/选择与今天逐字节一致**——每个改动都要有"关 → 不变"的回归。
- **probable 不作硬决策**:probable 边仅供 selector 邻居扩展;唯一消费者无硬判定。
- **唯一匹配**:member 属性名在项目里**恰好一个**可调用同名符号才连;多个/零个 → `unresolved`。
- **nameIndex 只索引可调用 kind**:`{function, method, variable}`,**排除 class**(`variable` 在 extractor 中仅指函数值赋名箭头/函数)。
- **单解析栈、无新依赖**;`probable`/`resolved`/`unresolved` 三档不变。
- 测试:`node --test <file>`;全量 `node --test test/**/*.test.js tests/**/*.test.js`;`npm run check`。

## Shared Shapes(本轮新增/变更,逐字一致)

```text
RawCall(member 情形新增 member_property):
  { caller_symbol_id, callee_raw:"obj.run", kind:"member", member_property:"run", file, line }
  // identifier / dynamic 情形不带 member_property

buildDependencyGraph({ byFile, symbolTable, methodHints=false }) -> { callEdges, neighbors }
  neighbors(symbolId, { hops, direction }) -> Map<symbol_id, "resolved"|"probable">  // 最强 confidence
  member 唯一匹配命中 -> CallEdge{ confidence:"probable", reason:"member-call", callee_symbol_id }

selector 邻居优先级:resolved -> priority 2 / reason "graph-neighbor"
                     probable -> priority 3 / reason "graph-neighbor-probable"
```

---

## Task 1: extractor —— member 调用抓 `member_property`

**Files:**
- Modify: `src/context/semantic/js-ts-extractor.js`(函数 `callFromNode`)
- Test: `tests/context/semantic/js-ts-extractor-member.test.js`

**Interfaces:**
- Produces:member 调用的 `RawCall` 增可选字段 `member_property`(`member_expression` 的 `property` 字段文本);computed(`subscript_expression`)归 `kind:"dynamic"` 不带该字段。

- [ ] **Step 1: 写失败测试**

```js
// tests/context/semantic/js-ts-extractor-member.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createWasmTreeSitterProvider } from "../../../src/context/semantic/wasm-tree-sitter-provider.js";
import { extractParseResult } from "../../../src/context/semantic/js-ts-extractor.js";

const provider = createWasmTreeSitterProvider();
const parseTree = (f, s) => provider.parseTree(f, s);

test("member calls carry member_property; computed/identifier do not", async () => {
  await provider.load();
  const src = `function main(){ obj.run(); a.b.c(); plain(); obj["x"](); }`;
  const r = extractParseResult({ file: "src/a.js", source: src, parseTree });
  const byRaw = Object.fromEntries(r.calls.map((c) => [c.callee_raw, c]));
  assert.equal(byRaw["obj.run"].kind, "member");
  assert.equal(byRaw["obj.run"].member_property, "run");
  assert.equal(byRaw["a.b.c"].member_property, "c");            // nearest property
  assert.equal(byRaw["plain"].kind, "identifier");
  assert.equal("member_property" in byRaw["plain"], false);     // identifier -> none
  assert.equal(byRaw['obj["x"]'].kind, "dynamic");              // subscript -> dynamic
  assert.equal("member_property" in byRaw['obj["x"]'], false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/context/semantic/js-ts-extractor-member.test.js`
Expected: FAIL(`member_property` undefined / `obj["x"]` 断言不符)

> 若 `obj["x"]()` 的 `callee_raw` 实际不是 `obj["x"]`(grammar 文本差异),用 `node --input-type=module` 打印 `tree.rootNode.toString()` 核对 `subscript_expression` 的文本后调整断言键名;`member_property` 的核心断言不变。

- [ ] **Step 3: 改 `callFromNode`**

```js
function callFromNode(node, file, symbols) {
  if (node.type !== "call_expression") return null;
  const fn = node.childForFieldName("function");
  if (!fn) return null;
  if (fn.type === "identifier" && fn.text === "require") return null; // handled as import
  let kind, callee_raw, memberProperty = null;
  if (fn.type === "identifier") { kind = "identifier"; callee_raw = fn.text; }
  else if (fn.type === "member_expression") {
    kind = "member"; callee_raw = fn.text;
    memberProperty = fn.childForFieldName("property")?.text || null;
  } else { kind = "dynamic"; callee_raw = fn.text; }
  const line = lineOf(node);
  const call = { caller_symbol_id: enclosingSymbolId(line, symbols), callee_raw, kind, file, line };
  if (memberProperty) call.member_property = memberProperty;
  return call;
}
```

- [ ] **Step 4: 跑测试确认通过 + 现有 extractor 回归**

Run: `node --test tests/context/semantic/js-ts-extractor-member.test.js`
Expected: PASS
Run: `node --test tests/context/semantic/js-ts-extractor.test.js`
Expected: PASS（原有断言不依赖 member_property,不受影响)

- [ ] **Step 5: 提交(含 src → 不加署名)**

```bash
git add src/context/semantic/js-ts-extractor.js tests/context/semantic/js-ts-extractor-member.test.js
git commit -m "feat(semantic): extractor captures member_property for member calls"
```

---

## Task 2: dependency-graph + symbol-selector —— 唯一匹配→probable + Map neighbors + probable 优先级

> neighbors 返回类型从 `Set` 升为 `Map<id,confidence>`,这是跨 graph/selector 的契约变更,两文件**同任务**改完,保证全程绿。

**Files:**
- Modify: `src/context/semantic/dependency-graph.js`
- Modify: `src/context/semantic/symbol-selector.js`
- Modify: `tests/context/semantic/symbol-selector.test.js`(mock neighbors 由 `Set` 改 `Map`)
- Test: `tests/context/semantic/dependency-graph-method-hints.test.js`(新增)

**Interfaces:**
- Consumes:`RawCall.member_property`(Task 1)。
- Produces:`buildDependencyGraph({ byFile, symbolTable, methodHints=false })`;`neighbors() -> Map<id,confidence>`;selector 把 probable 邻居置 priority 3 / reason `graph-neighbor-probable`。

- [ ] **Step 1: 写失败测试(method-hints 图行为)**

```js
// tests/context/semantic/dependency-graph-method-hints.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDependencyGraph } from "../../../src/context/semantic/dependency-graph.js";

// caller `use` makes 4 member calls: obj.uniqueFn(), obj.dupFn(), obj.Widget(), obj.uniqueMethod()
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
  // neighbors include probable, tagged with confidence
  const nb = g.neighbors(useSym.symbol_id, { hops: 1, direction: "out" });
  assert.equal(nb.get(uniqueFn.symbol_id), "probable");
  assert.equal(nb.has(widget.symbol_id), false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/context/semantic/dependency-graph-method-hints.test.js`
Expected: FAIL（`methodHints` 未消费 → member 仍 unresolved;`neighbors` 是 Set 没有 `.get`)

- [ ] **Step 3a: 改 `dependency-graph.js`(全文替换)**

```js
export function buildDependencyGraph({ byFile, symbolTable, methodHints = false }) {
  const callEdges = [];
  const outAdj = new Map(); // symbol_id -> Map(callee symbol_id -> confidence)
  const inAdj = new Map();  // symbol_id -> Map(caller symbol_id -> confidence)
  const nameIndex = methodHints ? buildNameIndex(symbolTable) : null;

  for (const pr of byFile.values()) {
    const localByName = new Map(pr.symbols.map((s) => [s.name, s]));
    const importBinding = buildImportBinding(pr, byFile);
    for (const rc of pr.calls) {
      const edge = resolveCall(rc, localByName, importBinding, nameIndex, methodHints);
      callEdges.push(edge);
      if (edge.callee_symbol_id && (edge.confidence === "resolved" || edge.confidence === "probable")) {
        addAdj(outAdj, edge.caller_symbol_id, edge.callee_symbol_id, edge.confidence);
        addAdj(inAdj, edge.callee_symbol_id, edge.caller_symbol_id, edge.confidence);
      }
    }
  }

  function neighbors(symbolId, { hops = 1, direction = "out" } = {}) {
    const result = new Map(); // id -> strongest confidence
    const maps = direction === "in" ? [inAdj] : direction === "both" ? [outAdj, inAdj] : [outAdj];
    let frontier = new Set([symbolId]);
    for (let h = 0; h < hops; h += 1) {
      const next = new Set();
      for (const id of frontier) for (const m of maps) {
        const adj = m.get(id);
        if (!adj) continue;
        for (const [n, conf] of adj) {
          const prev = result.get(n);
          if (prev === undefined) { result.set(n, conf); next.add(n); }
          else if (prev === "probable" && conf === "resolved") { result.set(n, "resolved"); }
        }
      }
      frontier = next;
      if (!frontier.size) break;
    }
    return result;
  }

  return { callEdges, neighbors };
}

function buildNameIndex(symbolTable) {
  const CALLABLE = new Set(["function", "method", "variable"]); // variable = named arrow/function only
  const index = new Map();
  for (const sym of symbolTable.values()) {
    if (!CALLABLE.has(sym.kind)) continue; // exclude class etc.
    if (!index.has(sym.name)) index.set(sym.name, []);
    index.get(sym.name).push(sym.symbol_id);
  }
  return index;
}

function buildImportBinding(pr, byFile) {
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

function resolveCall(rc, localByName, importBinding, nameIndex, methodHints) {
  const base = { caller_symbol_id: rc.caller_symbol_id, callee_raw: rc.callee_raw, file: rc.file, line: rc.line, callee_symbol_id: null };
  if (rc.kind === "identifier") {
    const local = localByName.get(rc.callee_raw);
    if (local) return { ...base, callee_symbol_id: local.symbol_id, confidence: "resolved", reason: "direct-local-call" };
    const bound = importBinding.get(rc.callee_raw);
    if (bound) return { ...base, callee_symbol_id: bound, confidence: "resolved", reason: "import-binding" };
    return { ...base, confidence: "unresolved", reason: "dynamic-call" };
  }
  if (rc.kind === "member") {
    if (methodHints && nameIndex && rc.member_property) {
      const matches = nameIndex.get(rc.member_property);
      if (matches && matches.length === 1) {
        return { ...base, callee_symbol_id: matches[0], confidence: "probable", reason: "member-call" };
      }
    }
    return { ...base, confidence: "unresolved", reason: "member-call" };
  }
  return { ...base, confidence: "unresolved", reason: "dynamic-call" };
}

function addAdj(map, from, to, confidence) {
  if (!map.has(from)) map.set(from, new Map());
  const adj = map.get(from);
  const prev = adj.get(to);
  if (prev === undefined || (prev === "probable" && confidence === "resolved")) adj.set(to, confidence);
}
```

- [ ] **Step 3b: 改 `symbol-selector.js` 的邻居扩展段**

把现有:

```js
  for (const id of [...priorityById.keys()]) {
    for (const n of graph.neighbors(id, { hops, direction: "out" })) {
      if (!priorityById.has(n)) { priorityById.set(n, 2); reasonById.set(n, "graph-neighbor"); }
    }
  }
```

替换为:

```js
  for (const id of [...priorityById.keys()]) {
    for (const [n, conf] of graph.neighbors(id, { hops, direction: "out" })) {
      if (!priorityById.has(n)) {
        const probable = conf === "probable";
        priorityById.set(n, probable ? 3 : 2);
        reasonById.set(n, probable ? "graph-neighbor-probable" : "graph-neighbor");
      }
    }
  }
```

- [ ] **Step 3c: 更新现有 selector 测试 mock(Set → Map)**

`tests/context/semantic/symbol-selector.test.js` 中:

```js
const graph = { neighbors: (id) => (id === mainSym.symbol_id ? new Set([fooSym.symbol_id]) : new Set()) };
```

改为:

```js
const graph = { neighbors: (id) => (id === mainSym.symbol_id ? new Map([[fooSym.symbol_id, "resolved"]]) : new Map()) };
```

(原有断言 `foo.priority === 2` 仍成立——resolved → 2。)

- [ ] **Step 3d: 给 selector 测试加 probable 邻居用例**

在 `tests/context/semantic/symbol-selector.test.js` 末尾追加:

```js
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
```

- [ ] **Step 4: 跑全部相关测试 + 回归**

Run: `node --test tests/context/semantic/dependency-graph-method-hints.test.js tests/context/semantic/dependency-graph.test.js tests/context/semantic/symbol-selector.test.js tests/context/semantic/index-semantic.test.js`
Expected: 全 PASS（含原 dependency-graph 测试用 `Map.has`、index-semantic 端到端 resolved 路径)

- [ ] **Step 5: 提交(含 src → 不加署名)**

```bash
git add src/context/semantic/dependency-graph.js src/context/semantic/symbol-selector.js tests/context/semantic/dependency-graph-method-hints.test.js tests/context/semantic/symbol-selector.test.js
git commit -m "feat(semantic): method-hint resolution (unique match -> probable) + confidence-aware neighbors"
```

---

## Task 3: semantic-engine —— 透传 `methodHints`

**Files:**
- Modify: `src/context/semantic/semantic-engine.js`(`buildDependencyGraph` 调用处)
- Test: `tests/context/semantic/method-hints-e2e.test.js`

**Interfaces:**
- Consumes:`buildDependencyGraph({..., methodHints})`(Task 2);`cfg = options.semantic`。
- Produces:`includeMethodHints:true` 时,member 调用的 probable 邻居经 selector 进入 snapshot。

- [ ] **Step 1: 写失败测试(端到端,经注入 provider)**

```js
// tests/context/semantic/method-hints-e2e.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os"; import path from "node:path"; import { promises as fs } from "node:fs";
import { createSemanticEngine } from "../../../src/context/semantic/semantic-engine.js";
import { createWasmTreeSitterProvider } from "../../../src/context/semantic/wasm-tree-sitter-provider.js";

async function project() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mhints-"));
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/context/semantic/method-hints-e2e.test.js`
Expected: FAIL（第一例:helperUnique 未出现,因 methodHints 未透传)

- [ ] **Step 3: 改 semantic-engine 的图构建**

把:

```js
      const graph = buildDependencyGraph({ byFile, symbolTable });
```

改为:

```js
      const graph = buildDependencyGraph({ byFile, symbolTable, methodHints: cfg.includeMethodHints === true });
```

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `node --test tests/context/semantic/method-hints-e2e.test.js tests/context/semantic/semantic-engine-fallback.test.js tests/context/semantic/index-semantic.test.js`
Expected: 全 PASS

- [ ] **Step 5: 提交(含 src → 不加署名)**

```bash
git add src/context/semantic/semantic-engine.js tests/context/semantic/method-hints-e2e.test.js
git commit -m "feat(semantic): thread includeMethodHints into the dependency graph"
```

---

## Task 4: kernel-options —— 合并 CLI semantic 覆盖

**Files:**
- Modify: `src/apps/kernel-options.js`(第 20 行 `result.context` 处理)
- Test: `tests/apps-kernel-options-semantic-override.test.js`

**Interfaces:**
- Produces:`buildKernelOptions` 在 `overrides.context.semantic` 存在时**合并** over `config.context.semantic`(override 胜);无覆盖时 `result.context = config.context`(现状)。

- [ ] **Step 1: 写失败测试**

```js
// tests/apps-kernel-options-semantic-override.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildKernelOptions } from "../src/apps/kernel-options.js";

const cfg = { apiKey: "k", baseUrl: "https://x", context: { semantic: { enabled: false, hops: 2, maxSymbols: 200, includeMethodHints: false } } };

test("CLI override merges over config (override wins)", async () => {
  const out = await buildKernelOptions("/root", { context: { semantic: { enabled: true, includeMethodHints: true } } }, async () => cfg);
  assert.equal(out.context.semantic.enabled, true);
  assert.equal(out.context.semantic.includeMethodHints, true);
  assert.equal(out.context.semantic.hops, 2); // preserved from config
});

test("no override -> config.context passes through unchanged", async () => {
  const out = await buildKernelOptions("/root", {}, async () => cfg);
  assert.deepEqual(out.context, cfg.context);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/apps-kernel-options-semantic-override.test.js`
Expected: FAIL（第一例:`result.context` 被 `config.context` 覆盖,override 丢失)

- [ ] **Step 3: 改第 20 行**

把:

```js
  if (config.context) result.context = config.context;
```

改为:

```js
  if (overrides.context?.semantic) {
    result.context = {
      ...config.context,
      semantic: { ...(config.context?.semantic || {}), ...overrides.context.semantic }
    };
  } else if (config.context) {
    result.context = config.context;
  }
```

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `node --test tests/apps-kernel-options-semantic-override.test.js tests/apps-kernel-options-context.test.js`
Expected: 全 PASS（原 context 转发测试不受影响)

- [ ] **Step 5: 提交(含 src → 不加署名)**

```bash
git add src/apps/kernel-options.js tests/apps-kernel-options-semantic-override.test.js
git commit -m "feat(config): merge CLI semantic override over config in buildKernelOptions"
```

---

## Task 5: CLI —— `--semantic-context` / `--include-method-hints`

**Files:**
- Modify: `src/cli.js`(新增导出 `semanticOverrideFromFlags`;在 `runAsk`/`runChat`/`runEdit` 接线;`printHelp` 补两行)
- Test: `tests/cli-semantic-flags.test.js`

**Interfaces:**
- Consumes:`buildKernelOptions` 合并(Task 4)。
- Produces:`semanticOverrideFromFlags(flags) -> { enabled, includeMethodHints? } | null`;传了 flag 才注入 `createKernelOptions.context.semantic`,否则不注入(守 disabled-parity)。

- [ ] **Step 1: 写失败测试(测纯函数 + 无 flag 不产生覆盖)**

```js
// tests/cli-semantic-flags.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { semanticOverrideFromFlags } from "../src/cli.js";

test("--include-method-hints implies enabled + hints", () => {
  assert.deepEqual(semanticOverrideFromFlags(new Map([["include-method-hints", true]])), { enabled: true, includeMethodHints: true });
});
test("--semantic-context enables semantic only", () => {
  assert.deepEqual(semanticOverrideFromFlags(new Map([["semantic-context", true]])), { enabled: true });
});
test("no flag -> null (no override, protects disabled-parity)", () => {
  assert.equal(semanticOverrideFromFlags(new Map()), null);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/cli-semantic-flags.test.js`
Expected: FAIL（`semanticOverrideFromFlags` 未导出)

- [ ] **Step 3a: 在 `src/cli.js` 新增导出函数**(放在 `boolFlag` 附近)

```js
export function semanticOverrideFromFlags(flags) {
  if (boolFlag(flags, "include-method-hints")) return { enabled: true, includeMethodHints: true };
  if (boolFlag(flags, "semantic-context")) return { enabled: true };
  return null;
}

function semanticKernelOptions(flags) {
  const semantic = semanticOverrideFromFlags(flags);
  return semantic ? { createKernelOptions: { context: { semantic } } } : {};
}
```

- [ ] **Step 3b: 在 `runAsk` / `runEdit` / `runChat` 接线**

`runAsk` 的 `runKernelAgentCommand({...})` 调用补 `...semanticKernelOptions(flags)`:

```js
  await runKernelAgentCommand({
    root,
    prompt,
    autonomy: stringFlag(flags, "autonomy") || "gated",
    sendOptions: commonOptions(flags),
    ...semanticKernelOptions(flags)
  });
```

`runEdit` 的 `runKernelAgentCommand({...})` 同样补 `...semanticKernelOptions(flags)`(放在 `sendOptions: commonOptions(flags)` 之后)。

`runChat` 的 `runKernelChatCommand({...})` 同样补 `...semanticKernelOptions(flags)`。

- [ ] **Step 3c: `printHelp` 的"用法"块补两行**(放在 `chat` 行之后)

```js
${commandLine("deepseek-code ask \"问题\" --semantic-context", "启用符号级语义上下文")}
${commandLine("deepseek-code ask \"问题\" --include-method-hints", "语义上下文 + 方法调用提示(probable)")}
```

- [ ] **Step 4: 跑测试确认通过 + check**

Run: `node --test tests/cli-semantic-flags.test.js`
Expected: PASS
Run: `npm run check`
Expected: 退出 0(cli.js 语法 OK)

- [ ] **Step 5: 提交(含 src → 不加署名)**

```bash
git add src/cli.js tests/cli-semantic-flags.test.js
git commit -m "feat(cli): --semantic-context / --include-method-hints flags"
```

---

## Task 6: 文档 —— README + Phase B spec 标注 + CHANGELOG

**Files:**
- Modify: `README.md`、`README.en.md`、`docs/specs/backend/2026-06-26-v3-phase-b-semantic-context-design.md`(§6)、`docs/CHANGELOG.md`

**Interfaces:**
- Produces:用户文档登记两个 CLI 标志;Phase B spec §6"未来增强"标注为已落地(B+1);CHANGELOG 记一条。

- [ ] **Step 1: README.md 语义上下文特性补标志**

在 `## ✨ 特性` 的"语义级上下文(可选)"一条后补一句(或并入该条):

```markdown
  启用方式:`--semantic-context`(符号级上下文)/ `--include-method-hints`(并开启方法调用提示,`obj.method()` 唯一同名时给出 `probable` 提示);也可在 `config.json` 的 `context.semantic` 配置。
```

- [ ] **Step 2: README.en.md 同步**

```markdown
  Enable with `--semantic-context` (symbol-level context) or `--include-method-hints` (also turns on method-call hints — `obj.method()` yields a `probable` edge when the name is unique); or via `context.semantic` in `config.json`.
```

- [ ] **Step 3: Phase B spec §6 标注已落地**

在 `2026-06-26-v3-phase-b-semantic-context-design.md` §6 的"未来增强(本轮不做,留 flag)"句尾补:

```markdown
**(已于 B+1 落地,见 [phase-b+1 method-hints 设计](2026-06-26-v3-phase-b-plus1-method-hints-design.md))**
```

- [ ] **Step 4: CHANGELOG 追加条目**

`docs/CHANGELOG.md` 的 Unreleased 区加:

```markdown
### 已落地 — Phase B+1 方法消歧(--include-method-hints,opt-in)
- member 调用 `obj.method()` 在项目内**恰好一个同名可调用符号**时升级为 `confidence:"probable"` 边(唯一匹配,低误报);多个/零个维持 `unresolved`。
- `neighbors` 返回 `Map<id,confidence>`;selector 把 probable 邻居置 priority 3 / `graph-neighbor-probable`,预算紧时让位给确定上下文。
- 新增 CLI `--semantic-context` / `--include-method-hints`(后者隐含启用);默认关、关闭时行为逐字节不变。
- 计划:[`plans/backend/2026-06-26-v3-phase-b-plus1-method-hints.md`](plans/backend/2026-06-26-v3-phase-b-plus1-method-hints.md)。
```

- [ ] **Step 5: 全量测试 + check + 提交(纯文档 → 加署名)**

Run: `node --test test/**/*.test.js tests/**/*.test.js`
Expected: 全绿
Run: `npm run check`
Expected: 退出 0

```bash
git add README.md README.en.md docs/specs/backend/2026-06-26-v3-phase-b-semantic-context-design.md docs/CHANGELOG.md
git commit -m "docs: document --semantic-context / --include-method-hints; mark Phase B §6 future-enhancement landed"
```

---

## Self-Review

- **Spec coverage**:§2 行为 → Task 2/3;§3 触点(extractor/graph/selector/engine/CLI)→ Task 1/2/3/4/5;§4 数据结构(member_property、nameIndex 可调用过滤、neighbors Map)→ Task 1/2;§5 CLI(两标志、合并、无 flag 不覆盖)→ Task 4/5;§6 测试(关=不变 / 唯一 / 多个 / 零 / class 排除 / neighbors confidence / CLI 覆盖)→ Task 2/4/5;§9 文档 → Task 6。
- **Placeholder scan**:无 TBD;Task 1 的"若 subscript 文本不符则核对"是真实校准步骤(给了打印命令)。
- **Type consistency**:`member_property`、`buildDependencyGraph({...,methodHints})`、`neighbors -> Map<id,confidence>`、`graph-neighbor-probable`、`semanticOverrideFromFlags`、`createKernelOptions.context.semantic` 在各 Task 间一致;`neighbors` 由 Set 升 Map 的契约在 Task 2 内同时改 graph+selector+selector 测试 mock,无悬空。
- **默认关不变**:Task 2(methodHints 默认 false)、Task 4/5(无 flag 不产生覆盖)、Task 6 全量回归共同守 disabled-parity。
