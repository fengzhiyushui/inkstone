# Phase B · 语义级上下文引擎 Implementation Plan

- 类型：实施计划
- 日期：2026-06-26
- 状态：已完成
- 关联：[B+1 method-hints](2026-06-26-v3-phase-b-plus1-method-hints.md)、[B+3 multi-language](2026-06-26-v3-phase-b-plus3-multi-language.md)、[CHANGELOG](../../CHANGELOG.md)

## 目标

在现有 `createContextEngine` 门面之下增加 opt-in 的符号级上下文层（符号表 + 依赖图 + 调用图），让检索粒度从「整文件」降到「符号」、相关性从「路径启发」升到「依赖图」。

## 结果

新增 `src/context/semantic/` 子模块，内部分层：ParserProvider（解析后端抽象，首版仅 web-tree-sitter）→ extractor（AST → ParseResult，现为 `query-extractor`）→ symbol-indexer（增量缓存）→ dependency-graph（模块边/绑定/尽力调用边）→ symbol-selector（种子→扩展→预算）。门面 `scan()` / `snapshot()` 签名不变。

Shared data shapes（全任务共用）：

```js
ParseResult = {
  file,                // workspace-relative path, e.g. "src/a.js"
  language: "js" | "ts",
  symbols: [Symbol],
  imports: [Import],
  exports: [Export],
  calls: [RawCall],    // 抽取期的"原始调用", 再解析成 CallEdge
  ok: boolean,         // false = 解析失败(该文件回退文件级)
}

Symbol = { symbol_id, file, name,
           kind: "function"|"class"|"method"|"variable",
           range: { start_line, end_line }, exported: boolean }

Import = { from_file, source_spec, resolved_file: string|null,
           names: [{ imported, local }], default: boolean, namespace: boolean,
           kind: "esm"|"cjs", dynamic: boolean }

Export = { file, name, local_name,
           kind: "named"|"default"|"reexport", source_spec: string|null }

RawCall = { caller_symbol_id, callee_raw,
            kind: "identifier"|"member"|"dynamic", file, line }

CallEdge = { caller_symbol_id, callee_raw, callee_symbol_id: string|null,
             confidence: "resolved"|"probable"|"unresolved",
             reason: "direct-local-call"|"import-binding"|"member-call"|"dynamic-call",
             file, line }

// symbol_id 稳定格式:
//   `${file}#${kind}:${name}:${start_line}`
//   e.g. "src/a.js#function:main:12"
//   稳定边界: 体编辑稳、行移会变、不承诺跨编辑持久身份

SymbolUnit = { id, type: "symbol", path, symbol_id, symbol_kind, name,
               defined_in: { start_line, end_line }, hash, token_count,
               priority, reason, snippet }
```

配置 `context.semantic = { enabled: false, hops: 2, maxSymbols: 200, includeMethodHints: false, importRoots: [] }`。降级事件 `context:semantic_degraded`（v1.3.0 补可观测，exactly-once）。`semantic-engine.js` 对外提供 `createSemanticEngine`，接进 `src/context/index.js`。

## 关键决策 / 遗留约束

- **opt-in 默认关**：`context.semantic.enabled` 默认 `false`；关闭时引擎行为（单元、事件、快照）与今天逐字节一致——每个改动门面/事件的任务都必须有「semantic 关闭 → 旧行为不变」的回归测试。
- **核心零必需依赖**：web-tree-sitter 及 grammar wasm 仅在 `enabled` 时 `await import()` 懒加载；`package.json` 里它放 `optionalDependencies`，核心 CLI 路径不 import 它。
- **单解析栈**：只用 web-tree-sitter；不得引入 TypeScript 编译器或第二套解析器。
- **可靠静态子集**：只把可静态确认的 import/export、function/class、直接调用标 `resolved`；`obj.method()` / `this.x()` / `factory()()` / 动态 `import()` 标 `unresolved`（`member-call` / `dynamic-call`）。
- **`unresolved` 是一等图事实，不是解析失败**：unresolved 调用边照常进图、照常计数。
- **回退永不崩**：provider 加载失败 / grammar 缺失 / 单文件解析报错 → 该文件降级为文件级单元；provider 整体不可用 → 全量退回文件级行为。
- 每个新文件单一职责；`check` 脚本需在新增源码文件后追加对应 `node --check` 条目。
- 后续 B+1 加方法消歧（probable 边 + `includeMethodHints`），B+3 迁 query 统一抽取并扩 Python。方法消歧的 member_property、neighbors Map 语义见 B+1。

## 验证

`tests/context/semantic/` 全套：parser-provider（extensionOf、注册表）、extractor、symbol-indexer、dependency-graph、symbol-selector、semantic-engine、fallback（provider 失败降级文件级）。disabled-parity 回归覆盖门面与事件。`node --test <file>` 单测 + 全量 + `npm run check`。当前入口 `src/context/semantic/semantic-engine.js`、`src/context/index.js`、`src/config.js` 的 `context.semantic`、`src/sessions/event-types.js` 的 `context:semantic_degraded`。

## 任务覆盖（as-built 映射）

Phase B 原计划按 ParserProvider → extractor → symbol-indexer → dependency-graph → symbol-selector → semantic-engine → 模块解析 → 缓存 → 配置 → 事件 → 文档的顺序落地。里程碑 B1–B6 对应：B1 解析抽象与注册表；B2 抽取与符号表；B3 依赖图与调用边；B4 选择器与预算；B5 语义引擎门面接入；B6 配置、事件、缓存与文档。

后续 B+1 在 extractor/graph/selector 上加 method hints，B+3 把 extractor 换成 query 统一路径并扩 Python。三者叠加后 `src/context/semantic/` 最终形态：

| 文件 | 职责 |
|------|------|
| `parser-provider.js` | 解析后端注册表 |
| `wasm-tree-sitter-provider.js` | web-tree-sitter 适配 + compileQuery |
| `query-extractor.js` | query.matches → ParseResult |
| `symbol-id.js` | makeSymbolId |
| `symbol-indexer.js` | 增量缓存 |
| `symbol-unit.js` | SymbolUnit 构造 |
| `symbol-selector.js` | 种子→扩展→预算 |
| `dependency-graph.js` | 模块边/绑定/调用边 |
| `semantic-engine.js` | 门面 |
| `language-registry.js` | 语言定义注册 |
| `languages/{javascript,typescript,python}.js` | 每语言 query + handleMatch |
| `module-resolver.js` / `python-module-resolver.js` | import 解析 |
| `query-extractor.js` / `symbol-cache.js` | 抽取与缓存 |

已知外部不确定点（实施时一次验证后据以校准）：web-tree-sitter 的 `init` / `Language.load` 形态与 grammar 节点字段名，在 provider 加载测试中一次核对，不影响下游纯逻辑任务。
