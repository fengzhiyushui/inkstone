# Phase B+1 · 方法消歧（--include-method-hints）Implementation Plan

- 类型：实施计划
- 日期：2026-06-26
- 状态：已完成
- 关联：[Phase B semantic](2026-06-26-v3-phase-b-semantic-context.md)、[B+3 multi-language](2026-06-26-v3-phase-b-plus3-multi-language.md)、[CHANGELOG](../../CHANGELOG.md)

## 目标

点亮 `includeMethodHints`：开启后 `obj.method()`（member 调用）在项目内恰好一个同名可调用符号时升级为 `confidence: "probable"` 边，并新增 CLI `--semantic-context` / `--include-method-hints`。默认关，关闭时行为逐字节不变。

## 结果

纯增量，改动 5 个现有文件（extractor / dependency-graph / symbol-selector / semantic-engine / config 入口）+ docs。无新文件、无新依赖。

Shared shapes（本轮新增/变更）：

```text
RawCall(member 情形新增 member_property):
  { caller_symbol_id, callee_raw:"obj.run", kind:"member", member_property:"run", file, line }
  // identifier / dynamic 情形不带 member_property

buildDependencyGraph({ byFile, symbolTable, methodHints=false })
  -> { callEdges, neighbors }
  neighbors(symbolId, { hops, direction })
    -> Map<symbol_id, "resolved"|"probable">   // 最强 confidence
  member 唯一匹配命中
    -> CallEdge{ confidence:"probable", reason:"member-call", callee_symbol_id }

selector 邻居优先级:
  resolved -> priority 2 / reason "graph-neighbor"
  probable -> priority 3 / reason "graph-neighbor-probable"
```

extractor：member 调用的 `RawCall` 增 `member_property`（`member_expression` 的 property 字段文本）；computed（`subscript_expression`）归 `kind: "dynamic"` 不带该字段。`a.b.c()` 取最近 property（`c`）。

dependency-graph：`methodHints` 开时对 member 调用查 nameIndex，恰好一个可调用同名符号则连 probable 边。`neighbors` 返回从 `Set<id>` 升为 `Map<id, confidence>`（`Map.has` 兼容现有断言），`callEdges` 始终保留完整 confidence。

symbol-selector：probable 邻居进 priority 3，预算紧时让位给确定上下文。

config：`context.semantic.includeMethodHints` 默认 false。CLI `--semantic-context` 开符号级，`--include-method-hints` 隐含启用并开方法提示；无 flag 不产生覆盖。

## 关键决策 / 遗留约束

- **默认关**：`context.semantic.includeMethodHints` 默认 false；关闭时不产生任何 probable 边，邻接表/选择与今天逐字节一致——每个改动都要有「关 → 不变」的回归。
- **probable 不作硬决策**：probable 边仅供 selector 邻居扩展；唯一消费者无硬判定。`probable` / `resolved` / `unresolved` 三档不变。
- **唯一匹配**：member 属性名在项目里恰好一个可调用同名符号才连；多个 / 零个维持 `unresolved`。
- **nameIndex 只索引可调用 kind**：`{function, method, variable}`，排除 class（`variable` 在 extractor 中仅指函数值赋名箭头 / 函数）。
- 单解析栈、无新依赖。Tech stack：Node ESM (Node ≥ 20)、`node:test`、web-tree-sitter（已有，opt-in 懒加载）。
- 后续 B+3 把硬编码 extractor 迁到 query 统一抽取后 `js-ts-extractor` 退役，member_property 能力由 `query-extractor` + `languages/*.js` 承接。

## 验证

extractor member 测试：member 带 property、identifier/computed 不带、`a.b.c` 取最近 property。dependency-graph methodHints 测试：唯一匹配 probable、多/零 unresolved、class 排除、关闭时无 probable。selector probable 邻居测试（priority 3 / `graph-neighbor-probable`）。CLI flag 覆盖与无 flag 不产生覆盖。全量 `node --test test/**/*.test.js tests/**/*.test.js` + `npm run check`。当前能力在 `src/context/semantic/query-extractor.js`、`dependency-graph.js`、`symbol-selector.js`、`semantic-engine.js`、`config.js` 的 `includeMethodHints`。

## 任务覆盖（as-built 映射）

Task 1 extractor 抓 `member_property` → Task 2 dependency-graph methodHints → Task 3 symbol-selector probable 邻居 → Task 4 semantic-engine / config 入口 → Task 5 CLI 两标志 → Task 6 文档（README 中英 + Phase B spec §6 标注已落地 + CHANGELOG）。Self-review 覆盖：§2 行为 → Task 2/3；§3 触点 → Task 1–5；§4 数据结构 → Task 1/2；§5 CLI → Task 4/5；§6 测试 → Task 2/4/5；§9 文档 → Task 6。默认关不可漂移由 Task 2/4/5/6 共同兜底。
