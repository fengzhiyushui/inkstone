# DeepSeek Code Phase B+1 · 方法消歧(--include-method-hints)设计

> 类型:后端设计 spec(backend)
> 日期:2026-06-26
> 状态:已评审,待转实施计划
> 关联:[Phase B 语义级上下文引擎设计](2026-06-26-v3-phase-b-semantic-context-design.md) §6 · [Phase B 实施计划](../../plans/backend/2026-06-26-v3-phase-b-semantic-context.md)

---

## 1. 背景与目标

Phase B 首版把 `obj.method()` 一律标 `confidence:"unresolved"`, `reason:"member-call"`(无类型系统,member 调用无法静态确认 callee)。Phase B spec §6 预留了一个**未来增强**:`--semantic-context --include-method-hints` 把 member-call 升级为 `confidence:"probable"` 的**提示**(表示"可能调用",非确定依赖)。`config.semantic.includeMethodHints` 标志在 Phase B Task 11 已落入配置并归一化,但**当前无人消费**(dead flag)。

**目标**:点亮该标志——为 member 调用提供**低误报的近似解析**,并新增 CLI 开关使其 CLI 即开即用。

**核心原则不变**:默认关;关闭时行为逐字节一致;`probable` 是一等图事实,**非确定依赖,不作硬决策**。

---

## 2. 行为

开启 `includeMethodHints` 后,对每个 member 调用 `obj.method()`:

```text
取属性名 method → 在项目符号表按名查同名符号:
  恰好 1 个  → confidence:"probable", reason:"member-call", callee_symbol_id = 该符号
  ≥ 2 个     → confidence:"unresolved", reason:"member-call", callee_symbol_id = null(太歧义,不连)
  0 个       → confidence:"unresolved", reason:"member-call", callee_symbol_id = null
```

- **唯一匹配策略**:只在项目内**恰好一个**同名符号时连边。`obj.toString()` / `obj.run()` 这类常见名通常匹配多个 → 维持 unresolved,避免边爆炸与误报。
- **probable 边参与 `neighbors` 扩展,但 confidence 不丢**:`callEdges` 始终保留完整边(含 `confidence`);`neighbors(id, {hops})` 返回 `Map<symbol_id, "resolved"|"probable">`(到达该邻居的最强 confidence;`Map.has` 兼容现有用例)。selector 据此区分:**resolved 邻居 priority 2 / reason `graph-neighbor`;probable 邻居 priority 3 / reason `graph-neighbor-probable`**(更可能但更靠后,预算紧时先让位给确定上下文)。
- **唯一消费者无硬决策**:上下文引擎里 probable 边仅用于 selector 的邻居扩展(供给上下文),不参与任何硬判定,满足 §6"不作硬依赖"。
- **默认关 = 不变**:`includeMethodHints` 为 false 时**不产生任何 probable 边**,邻接表与今天完全一致。

---

## 3. 组件与触点

| 单元 | 变更 |
|------|------|
| [js-ts-extractor.js](../../../src/context/semantic/js-ts-extractor.js) | member 调用的 `RawCall` 增 `member_property`(取 `member_expression` 的 `property` 字段 `property_identifier` 文本)。纯新增字段,不破坏现有抽取。 |
| [dependency-graph.js](../../../src/context/semantic/dependency-graph.js) | `buildDependencyGraph({ byFile, symbolTable, methodHints = false })`;建 `nameIndex: Map<name, symbol_id[]>`;`resolveCall` 对 member 启用唯一匹配;邻接表纳入 `resolved` + `probable`。 |
| [semantic-engine.js](../../../src/context/semantic/semantic-engine.js) | 把 `methodHints: cfg.includeMethodHints === true` 传给 `buildDependencyGraph`。 |
| [cli.js](../../../src/cli.js) | 在 `ask`/`chat`/`edit` 解析 `--semantic-context` / `--include-method-hints`,产出 semantic 覆盖对象。 |
| [kernel-runner.js](../../../src/apps/cli/kernel-runner.js) | 接收 CLI 覆盖,合并进 kernel `options.context.semantic`(CLI 覆盖 config)。 |

---

## 4. 数据结构变更

```text
RawCall(member 情形)新增字段:
  { caller_symbol_id, callee_raw: "obj.run", kind: "member",
    member_property: "run",            // 新增:property_identifier 文本
    file, line }

CallEdge:形状不变;member 调用在 methodHints 开+唯一匹配时取
  { confidence: "probable", reason: "member-call", callee_symbol_id: <符号> }
```

`nameIndex` 在 `buildDependencyGraph` 内由 `symbolTable` 一次性构建,**只索引可调用符号**:`kind ∈ {function, method, variable}`(`variable` 在 extractor 中仅指**函数值的赋名箭头/函数**,故可调用),**排除 `class`**——避免 `obj.run()` 误连到同名类/非可调用符号。`name → [symbol_id...]`;仅当 `methodHints` 为真时用于 member 解析。

> **`member_property` 抽取边界**(写死,避免测试被 AST 细节拖住):
> - `obj.run()` → `"run"`;`a.b.c()` → `"c"`(取最近一层 `property`,callee_raw `"a.b.c"`)。
> - `obj["run"]()`(计算成员)是 `subscript_expression`,callFromNode 归 `kind:"dynamic"`,**不出 `member_property`、不提示**。
> - `obj?.run()`(可选链)若 grammar 仍给 `member_expression` 则取 `"run"`,否则归 dynamic——**实施时按实际 AST 验证**(打印节点确认)。
> - `obj.#run()`(私有)取到的 property 文本(含 `#`)通常不匹配任何符号名 → 自然落 `unresolved`,不特殊处理。

---

## 5. CLI 接口

```text
--semantic-context        启用符号级语义上下文(等价 context.semantic.enabled = true)
--include-method-hints    启用语义并开启方法提示(隐含 --semantic-context;
                          等价 enabled = true + includeMethodHints = true)
```

- 合并规则:`options.context.semantic = { ...config.context.semantic, ...cliOverride }`,**CLI 覆盖 config**。
- 覆盖对象:`--semantic-context` → `{ enabled: true }`;`--include-method-hints` → `{ enabled: true, includeMethodHints: true }`。
- **仅在传了相关 flag 时才产生 override**:两个 flag 都没传 → **不创建任何 `context.semantic` 覆盖**,kernel options 原样走 config——避免无意把 config 结构归一化成新对象、扰动 disabled-parity。
- 未给任何标志 → 完全走 config(现状),CLI 行为不变。

---

## 6. 测试策略

- **extractor**:member 调用抓到 `member_property`(`obj.run()` → `"run"`);identifier 调用不带该字段。
- **dependency-graph**(情形):
  - methodHints **关** → member-call `unresolved`、无 probable 边、邻接表不变(回归)。
  - 开 + **唯一**同名(可调用)→ `probable` 边连到该符号;`neighbors` 含它且 confidence 为 `probable`。
  - 开 + **多个**同名 → `unresolved`、不连边。
  - 开 + **零**匹配 → `unresolved`。
  - 开 + 唯一同名但该符号是 **class** → 不命中(nameIndex 只索引可调用 kind)。
  - `neighbors` 返回 `Map<id, confidence>`;selector 把 probable 邻居置 priority 3 / reason `graph-neighbor-probable`。
- **semantic-engine**:`includeMethodHints:true` → 图中出现 probable 边(经注入 provider 端到端)。
- **CLI**:`--semantic-context` / `--include-method-hints` → 产出正确的 `options.context.semantic` 覆盖(单测选项构建,mock config);无标志 → 不引入 context 覆盖。
- **兼容**:默认关 → 现有 dependency-graph 测试与 disabled-parity 全绿。

---

## 7. 兼容与约束

- `includeMethodHints` 默认 false → 零行为变化(probable 边仅在显式开启时存在)。
- 单解析栈不变;不引入任何新依赖。
- `probable` 不得被任何"硬决策"消费(本轮唯一消费者是 selector 邻居扩展,安全)。

---

## 8. 非目标(本轮)

- ❌ 跨文件类型推断 / 真正的方法解析(仍是名字唯一匹配的近似)。
- ❌ `this.method()` 的类内解析(`this` 仍按 member 处理;类内方法名若全局唯一可被唯一匹配命中,但不专门做类作用域消歧)。
- ❌ 置信度分级细化(只有 resolved/probable/unresolved 三档)。
- ❌ 增量图差分、扩语言(B+2 / B+3,独立子项)。

---

## 9. 文档影响

- README 中英:在语义上下文处补 `--semantic-context` / `--include-method-hints` 两个标志。
- [Phase B spec §6](2026-06-26-v3-phase-b-semantic-context-design.md) 的"未来增强"标注为**已落地(B+1)**。
- CHANGELOG 记一条。
