# Phase B+1 · 方法提示（include-method-hints）设计

- 类型：后端 spec
- 日期：2026-06-26
- 状态：已实现
- 关联：[Phase B 语义上下文](2026-06-26-v3-phase-b-semantic-context-design.md)

---

## 问题与目标

Phase B 把 `obj.method()` 一律标 `unresolved`。配置键 `context.semantic.includeMethodHints` 已归一化但无人消费。B+1 点亮该键：member 调用在低误报前提下做唯一同名近似解析，并提供 CLI 开关。默认关；`probable` 只作上下文提示，不作硬决策。

## 决策

| 决策点 | 选择 | 否决项 | 理由 |
|---|---|---|---|
| 匹配策略 | 项目内恰好 1 个同名可调用符号才连 | 多匹配也连 | 防边爆炸与误报 |
| 置信 | `probable` | 直接 `resolved` | 无类型系统，只能是提示 |
| 索引范围 | function/method/variable（函数值） | 含 class | 避免误连到类 |
| 消费者 | 仅 selector 邻居扩展 | 进硬判定 | 「不作硬依赖」 |
| CLI | `--include-method-hints` 隐含 semantic on | 隐式全开 | 显式 opt-in |

## 设计

### 行为

开启后对 `obj.method()`：取属性名 → 项目符号表查可调用同名符号。恰好 1 个 → `confidence:"probable"`、`reason:"member-call"`、连到该符号；0 或 ≥2 → 仍 `unresolved`，不连边。

`probable` 边参与 `neighbors` 扩展但 confidence 不丢：`neighbors` 返回 `Map<symbol_id, confidence>`。selector 中 resolved 邻居 priority 2 / `graph-neighbor`，probable 邻居 priority 3 / `graph-neighbor-probable`。默认关时不产生任何 probable 边。

### 触点

- 调用抽取：member 调用增加 `member_property`（最近一层 property 名）。`obj["run"]()` 归 dynamic，不提示。
- `dependency-graph`：构建 `nameIndex: Map<name, symbol_id[]>`（只索引可调用 kind），`methodHints` 开时对 member 做唯一匹配。
- `semantic-engine`：把 `cfg.includeMethodHints === true` 传入建图。
- CLI：`--semantic-context` → `{ enabled: true }`；`--include-method-hints` → `{ enabled: true, includeMethodHints: true }`。未传 flag 不创建 semantic 覆盖，完全走 config。合并规则 CLI 覆盖 config。

### 抽取边界

`obj.run()` → `"run"`；`a.b.c()` → `"c"`（callee_raw 为 `a.b.c`）。计算成员归 dynamic。可选链与私有字段按实际 AST 落 member 或 dynamic；私有名通常不匹配符号，自然 unresolved。

## 边界与不变量

1. 默认关零行为变化。
2. `probable` 不参与任何硬决策。
3. 不做跨文件类型推断、类内 `this` 专门消歧、置信度细分。
4. 不加新依赖。

## 与现状的差异

抽取实现可能在 `query-extractor.js` 等模块，以代码为准。CLI 覆盖助手见 `src/cli.js` 的 `semanticOverrideFromFlags`。

## 验收

extractor 抓到 `member_property`；methodHints 关时邻接表不变；开 + 唯一同名连 probable；多/零匹配不连；class 不进 nameIndex；selector 对 probable 降优先级；CLI 覆盖正确；默认关回归全绿。入口 `npm test`。
