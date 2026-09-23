# Phase B · 语义级上下文引擎设计

- 类型：后端 spec
- 日期：2026-06-26
- 状态：已实现
- 关联：[V3 路线图](../architecture/2026-06-24-v3-roadmap-design.md) · [B+1 方法提示](2026-06-26-v3-phase-b-plus1-method-hints-design.md) · [B+3 多语言](2026-06-26-v3-phase-b-plus3-multi-language-design.md) · [分层记忆](2026-06-24-agent-layered-memory-design.md)

---

## 问题与目标

文件级上下文不懂结构：整文件片段、路径启发排序。Phase B 把粒度降到符号、相关性升到依赖图，在 `createContextEngine` 门面不变的前提下增量加语义层。语义默认关闭，关闭时行为与文件级路径一致。

## 决策

| 决策点 | 选择 | 否决项 | 理由 |
|---|---|---|---|
| 解析栈 | tree-sitter WASM 尽力静态分析 | 先上 TS 编译器 | 确定性、零原生构建 |
| 不确定调用 | 一等 `unresolved` 边 | 猜或丢 | 图完整且不假 |
| 方法调用 | 默认 unresolved，B+1 可选 probable | 首版消歧 | 无类型系统 |
| 依赖 | 相对路径 + 明确扩展名 | tsconfig alias / bare 深解析 | 范围可控 |
| 开关 | `context.semantic.enabled` 默认 false | 默认开 | 关闭时零成本零扰动 |
| 缓存 | per-file ParseResult，按内容 hash | 全量重解析 | 增量 |

## 设计

### 架构

```
createContextEngine（门面不变）
  scan()  文件扫描 → [semantic on] symbol-indexer → dependency-graph
  snapshot()  [on] symbol-selector / [off] context-selector
```

组件（`src/context/semantic/`）：`parser-provider` 抽象、`wasm-tree-sitter-provider`、`language-registry` 与 languages 适配器、`symbol-indexer`、`symbol-cache`、`module-resolver`、`dependency-graph`、`symbol-selector`、`symbol-unit`、`semantic-engine`。`ContextUnit` 增加 `type:"symbol"`。

### 数据结构要点

- `Symbol`：symbol_id、file、name、kind（function/class/method/variable）、range、exported。
- `Import` / `Export`：specifier、绑定名、esm|cjs、dynamic。
- `CallEdge`：caller/callee、`confidence: resolved|probable|unresolved`、`reason`（direct-local-call / import-binding / member-call / dynamic-call）。
- `SymbolUnit`：符号片段单元，含 defined_in、hash、token_count、priority。

`confidence` / `reason` 是一等字段。

### 可靠子集

`resolved` 只覆盖：静态 import/require 字面量、named/default/namespace 导出、function/class 与顶层具名函数表达式、直接本地或 import 绑定调用。

`obj.method()`、`this.run()` → `unresolved` + `member-call`；动态 import、计算调用 → `unresolved` + `dynamic-call`。unresolved 边照常进图。

模块解析：`./x` `../x` 到 workspace 文件；`.js .jsx .ts .tsx .mjs .cjs`（含 index）；bare specifier 标 external 不展开。CJS：`require()` 导入边可解析；`module.exports` 导出绑定 best-effort。

`symbol_id = path#kind:name:start_line`。对函数体编辑稳定，行号位移会变；跨编辑持久 id 非目标。

### 配置与缓存

`context.semantic`：`enabled: false`、`hops: 2`、`maxSymbols: 200`、`includeMethodHints: false`、`importRoots: []`（以 `src/config.js` 为准）。CLI 可用 `--semantic-context` / `--include-method-hints` 覆盖。

grammar `.wasm` 随仓 vendored，懒加载。per-file 缓存对齐 context-cache manifest；解析失败降级文件级；provider 不可用则全量退回文件级。

### 事件

仅语义开启时经 eventBus 发布 `context:symbol_indexed`、`context:graph_built`（不入 `SESSION_EVENT_TYPES`，与 `orchestration:*` 同级）。`context:snapshot` 附带 file/symbol 分布。降级事件 `context:semantic_degraded` 在 `SESSION_EVENT_TYPES` 内，入会话时间线。关闭语义时行为与文件级路径一致。

## 边界与不变量

1. 默认关 = 行为逐字节一致。
2. 核心 CLI 无必需运行时依赖；语义为可选懒加载 WASM，不引入原生构建。
3. unresolved 不是解析失败，是一等图事实。
4. 本轮不做 embedding、TS 类型分析、native tree-sitter、跨语言扩展（另见 B+3）、增量图差分。

## 与现状的差异

方法提示见 [B+1](2026-06-26-v3-phase-b-plus1-method-hints-design.md)。语言扩展见 [B+3](2026-06-26-v3-phase-b-plus3-multi-language-design.md)。实现文件名以 `src/context/semantic/` 为准（如 query 抽取在 `query-extractor.js`）。

## 验收

适配器 fixture 断言 symbols/imports/exports/calls；增量只重解析变更文件；unresolved 边可测；selector 做 N 跳扩展与文件级回退；provider 失败不抛错；semantic 关闭时与现有用例一致。入口 `npm test`。
