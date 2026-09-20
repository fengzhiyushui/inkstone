# DeepSeek Code V3 Phase B · 语义级上下文引擎 设计

> 类型:后端设计 spec(backend)
> 日期:2026-06-26
> 状态:已评审,待转实施计划
> 关联:[V3 路线图](../architecture/2026-06-24-v3-roadmap-design.md) §6 · [Agent 分层记忆系统](2026-06-24-agent-layered-memory-design.md)

---

## 1. 背景与目标

**现状**([src/context/](../../../src/context/)):文件级启发式——`workspace-indexer` 扫文件 → `priorityForPath` 打 P0–P4 → `context-selector` 按路径启发排序 → token 预算塞**整文件**片段。粒度是整文件、相关性靠路径、不懂代码结构。

**目标**:检索粒度从「文件」降到「符号」,相关性从「路径启发」升到「依赖图」。在不破坏现有门面、不改变默认行为的前提下,为后续 Phase C(多智能体,子 agent 按作用域供给上下文)打好质量地基。

**重心**:可靠、确定、增量、可回退。**不追求大而全**,走分层可升级路线。

---

## 2. 首版原则(写死)

```text
首版调用图采用 tree-sitter AST 的尽力静态分析。
只解析可静态确认的 import/export、function/class、直接函数调用。
动态调用、对象方法调用、类型依赖调用统一标记为 unresolved 或 low-confidence。
不引入 TypeScript 编译器作为首轮依赖。
```

一句话路线:**先做 tree-sitter 单解析栈的可靠静态子集,把不可确定的调用显式标 `unresolved`;数据结构预留 `confidence`/`provider` 字段,未来再渐进增强方法调用与类型感知。**

最终交付边界(Accept / Out):

```text
Accept Phase B semantic context design with reliable static subset first.
Ship WASM tree-sitter as opt-in semantic provider.
Resolve only static relative imports and direct local/import-bound calls.
Represent member/dynamic/type-dependent calls as unresolved or low-confidence.
Keep TypeScript compiler, native tree-sitter, method disambiguation,
aliases, and non-JS languages out of the first delivery.
```

---

## 3. 总体架构

在现有 [`createContextEngine`](../../../src/context/index.js) 门面**之下**新增符号层。`scan()` / `snapshot()` 签名与返回契约**不变**。

- **语义上下文 opt-in、默认关。关闭时,引擎行为与今天逐字节一致**(同样的文件级单元、同样的事件、同样的快照)。
- 启用时:`scan()` 在现有文件扫描之后增量解析支持的文件 → 符号表 + import/export 绑定 + 尽力调用图;`snapshot()` 改用 `symbol-selector`,从种子符号沿依赖图扩展,按预算选**符号级**片段,不支持/解析失败的文件回退文件级单元。

```text
createContextEngine (门面不变)
  ├─ scan()      文件扫描(现有) ─┬─ [semantic on] symbol-indexer → dependency-graph
  │                              └─ [semantic off] 到此为止(与今天一致)
  └─ snapshot()  [on] symbol-selector  /  [off] context-selector(现有)
```

---

## 4. 组件(新增于 `src/context/` 之下)

| 单元 | 职责 | 依赖 |
|------|------|------|
| **ParserProvider**(扩展口) | 解析后端抽象:`{ name, supports(ext), load(), parse(file, src) → ParseResult }` | — |
| **language-adapter(JS/TS)** | `wasm-tree-sitter` 下的 JS/TS 适配器,把 AST 抽成 symbols/imports/exports/calls | web-tree-sitter + vendored grammar wasm |
| **symbol-indexer** | 对每个已索引文件选适配器 → per-file `ParseResult`;**增量**(复用 [context-cache](../../../src/context/context-cache.js) 的 hash manifest,只重解析变更文件);汇成符号表 | ParserProvider |
| **dependency-graph** | 模块边 + 符号绑定 + 尽力调用边;`neighbors(symbolId, hops, {direction})` 正/反向 | symbol-indexer |
| **symbol-selector**(升级 [context-selector](../../../src/context/context-selector.js)) | message → 种子符号 → 沿图扩 N 跳(优先级随跳数衰减)→ 预算内选符号片段;回退文件级 | dependency-graph |
| **ContextUnit 扩展**([context-unit.js](../../../src/context/context-unit.js)) | 新增 `type:"symbol"` 变体;file 变体不变 | — |

**ParserProvider 扩展口**(架构留口,本轮只建第一个):

```text
ParserProvider:
  - wasm-tree-sitter   默认,本轮交付
  - typescript-service 未来增强(类型感知),不建
  - native-tree-sitter 未来高性能,不建
默认路径恒为:core CLI 零原生依赖 / semantic context 可选 WASM / 类型级分析以后再说。
```

---

## 5. 数据结构

```text
Symbol:    { symbol_id, file, name, kind: function|class|method|variable,
             range:{ start_line, end_line }, exported }

Import:    { from_file, source_spec, resolved_file|null,
             names:[{ imported, local }], default, namespace, kind: esm|cjs, dynamic }

Export:    { file, name, local_name, kind: named|default|reexport, source_spec? }

CallEdge:  { caller_symbol_id, callee_raw, callee_symbol_id|null,
             confidence: "resolved" | "probable" | "unresolved",
             reason: "direct-local-call" | "import-binding" | "member-call" | "dynamic-call",
             file, line }

SymbolUnit:{ id, type:"symbol", path, symbol_id, symbol_kind, name,
             defined_in:{ start_line, end_line }, hash, token_count, priority, reason, snippet }
```

`confidence` / `reason` 是**一等字段**,首版即写入;未来增强方法/类型解析只升级取值,不改结构。

---

## 6. 可靠子集与 `unresolved` 语义

**首版 `confidence:"resolved"` 仅覆盖**:
- ✅ 静态 import/require(字符串字面量 specifier)、named / default / namespace 导出
- ✅ function / class 声明 + 顶层赋名的箭头函数 / 函数表达式
- ✅ 直接调用 `foo()`:解析到本地定义(`reason:"direct-local-call"`)或 import 绑定(`reason:"import-binding"`)

**显式降级(不猜)**:
- ⬜ `obj.method()` / `this.run()` → `confidence:"unresolved"`, `reason:"member-call"`
- ⬜ `factory()()` / 动态 `import()` / 计算调用 → `confidence:"unresolved"`, `reason:"dynamic-call"`

**关键语义**:

```text
unresolved edges are first-class graph facts, not parser failures.
```

`unresolved` 调用边照常进图、照常计数,只是不连到具体 callee 符号。调用图**不会因为"不确定"而看起来像坏了**。

**未来增强(本轮不做,留 flag)**:`--semantic-context --include-method-hints` → 把 `member-call` 升级为 `confidence:"probable"` 的提示(表示"可能调用",**非确定依赖**),不得当成硬依赖参与关键决策。 **(已于 B+1 落地,见 [phase-b+1 method-hints 设计](2026-06-26-v3-phase-b-plus1-method-hints-design.md)。)**

---

## 7. 模块解析范围(首版)

```text
relative specifiers:      ./x, ../x                         → 解析到 workspace 文件
known JS/TS extensions:   .js .jsx .ts .tsx .mjs .cjs       → 含 index 解析
package/bare specifiers:  react, lodash, @scope/pkg, ...    → unresolved external(不展开)
tsconfig paths/aliases:   @/foo, ~/bar, workspace package   → non-goal(本轮不解析)
```

不被 `@/foo`、`react`、workspace package 搞乱:无法解析到 workspace 内文件的 specifier 一律标 external,不进 N 跳扩展的"可读符号"集合。

---

## 8. CommonJS 口径(首版)

项目自身是纯 ESM(`type:"module"`);CJS 仅在索引外部项目时遇到。首版收窄为:

```text
ESM import/export:        full support
CJS require(string):      import edge resolved(字符串字面量 specifier)
CJS export binding:       best-effort; module.exports / exports.x 可为 unresolved in B1
```

即:`require()` 的**导入边**首版即解析;`module.exports = …` / `exports.foo = …` 的**导出绑定**首版 best-effort,常见形态尽力抽,抽不准则 `unresolved`,不铺 CJS 长尾。

---

## 9. `symbol_id` 稳定性

```text
symbol_id = `${workspaceRelativePath}#${kind}:${exportedNameOrLocalName}:${start_line}`
```

不只靠内容 hash(否则函数体小改会让整图抖动)。稳定性边界**明确**:

- ✅ 对**纯函数体编辑稳定**(改 body 不改 id)。
- ⚠️ 对**行号位移会变**(在符号上方增删行 → `start_line` 变 → id 变)。
- 因调用图**每次 scan 由当前文件内容重建**,`symbol_id` 只需"**单次 scan 内确定 + 可读**",**不承诺跨编辑持久身份**(跨编辑追踪是未来诉求,届时另设持久 id)。

---

## 10. opt-in 配置与接线

```text
context.semantic = {
  enabled: false,                 // 默认关
  provider: "wasm-tree-sitter",
  languages: ["js", "ts"],
  hops: 2,                        // 依赖图扩展跳数
  maxSymbols: <n>,                // 候选符号上限(成本闸)
  includeMethodHints: false       // 未来增强;member-call → probable
}
```

- kernel:`createKernel(root, { context: { semantic: { enabled: true } } })`
- 配置文件:`config.json` 的 `context.semantic`(per-field 深合并,沿用现有 limits 模式)
- CLI:`--semantic-context` 开启(未来 `--include-method-hints`)
- grammar `.wasm`:**vendored 入仓**(离线、确定),首次语义 scan **懒加载**

与 recovery / 运行护栏的 opt-in 一致:默认行为零变化,启用才付出解析成本。

---

## 11. 缓存与回退

**缓存**:
- per-file `ParseResult` 缓存于 `.deepseek-code/v2/context/symbols/`,按文件内容 hash 为键(对齐 context-cache manifest)。
- 只重解析**变更文件**;依赖图在每次 scan 由缓存的 per-file 结果**内存装配**(解析才是贵的;增量图差分留作未来)。

**回退(永不崩)**:
- provider 加载失败 / grammar 缺失 / 单文件解析报错 → 该文件**降级为文件级单元**,记 stat。
- provider 整体不可用 → **全量退回今天的文件级行为**。

---

## 12. 事件

新增事件 **仅在 `context.semantic.enabled` 时触发**,以保证「关闭时行为逐字节一致」:

- `context:symbol_indexed` —— `{ files_parsed, symbols, reused }`
- `context:graph_built` —— `{ symbols, edges, resolved, probable, unresolved }`
- 现有 `context:snapshot` 在语义开启时附带单元类型分布(file / symbol 计数);关闭时载荷不变。

---

## 13. 零依赖口径与 README 影响

精确措辞(进 README 与 spec,避免被理解成 native 依赖):

```text
Core CLI has no required runtime dependencies. Optional semantic context
lazily loads web-tree-sitter and vendored WASM grammars; it introduces no
native build dependency.
```

中文对应:**核心 CLI 无必需运行时依赖;可选的语义上下文按需懒加载 web-tree-sitter 与随仓 vendored 的 WASM grammar,不引入任何原生构建依赖。**

> 「零运行时依赖」自此从硬性原则降级为默认路径的一种描述。README 的**绝对化措辞已在 2026-06-26 一致性梳理中软化**为「核心 CLI 无必需运行时依赖」;待 Phase B 落地、web-tree-sitter 实际入仓时,再补全为上述完整口径(含 WASM/可选语义上下文)。

---

## 14. 测试策略

确定性优先(tree-sitter 解析确定 → 可复现快照):
- **适配器**:fixture `.js`/`.ts`/`.mjs`/`.cjs` 源码 → 期望 symbols / imports / exports / calls(含 `confidence` + `reason`)。
- **indexer 增量**:改一个文件 → 仅该文件重解析,其余命中缓存。
- **dependency-graph**:期望模块边 / 绑定 / 调用边;`unresolved` 边作为一等事实被断言存在。
- **selector**:种子定位 → N 跳扩展 → 预算内选符号 + 文件级回退混合。
- **回退**:provider 不可用 / grammar 缺失 → 退回文件级,不抛错。
- **provider seam**:mock provider 验证抽象边界。
- **opt-in 不变性**:semantic 关闭时,快照与事件与现有用例逐字节一致(回归)。

---

## 15. 非目标(本轮)

- ❌ embedding / 向量语义检索
- ❌ tsconfig 路径别名 / 裸 specifier 深解析
- ❌ 方法调用消歧(留 `includeMethodHints` flag,默认关)
- ❌ TypeScript 编译器 / 类型级分析
- ❌ JS/TS 以外语言(架构留适配器口)
- ❌ 增量图差分(每次由缓存 per-file 结果重建)
- ❌ 原生 tree-sitter / 跨编辑持久 symbol id

---

## 16. 里程碑(供拆实施计划)

```text
B1  ParserProvider + JS/TS wasm 适配器 → ParseResult(symbols/imports/exports/calls)
B2  symbol-indexer + per-file 增量缓存 + 符号表
B3  dependency-graph(模块边 + import/export 绑定 + 尽力调用边 + confidence/reason)
B4  symbol-selector 升级 + ContextUnit symbol 变体
B5  门面 / kernel / config 接线(opt-in)+ 事件 + 回退
B6  README 零依赖口径软化 + 文档
```

---

## 17. 开放问题(实施前再定)

- `hops` 与 `maxSymbols` 的默认值(随 fixture 实测调,默认给安全起点,沿用配置哲学交给用户)。
- vendored grammar wasm 的体积与放置路径(`src/context/grammars/`?),以及 web-tree-sitter 版本锁定。
- 符号片段的 snippet 边界:是否带 leading 注释 / 装饰器 / 签名上下文。
- `.deepseek-code/v2/context/symbols/` 缓存与现有 `context/` 缓存是否合并 manifest。
