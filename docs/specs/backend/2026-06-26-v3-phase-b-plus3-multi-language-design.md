# DeepSeek Code Phase B+3 · 扩语言(query 统一抽取)设计

> 类型:后端设计 spec(backend)
> 日期:2026-06-26
> 状态:✅ 已落地(M1–M6,2026-06-27;测试 559 全绿)。`js-ts-extractor` 经 shadow-parity 验证后退役,`query-extractor` 为唯一抽取路径。
> 关联:[Phase B 语义级上下文引擎设计](2026-06-26-v3-phase-b-semantic-context-design.md) · [Phase B+1 方法消歧设计](2026-06-26-v3-phase-b-plus1-method-hints-design.md)

---

## 1. 背景与目标

Phase B 的抽取层 `js-ts-extractor.js` 用**硬编码 JS/TS 节点类型**产出 `ParseResult`;下游(`symbol-indexer` / `dependency-graph` / `symbol-selector`)**语言无关、只吃 `ParseResult`**。

**目标**:把抽取层迁到**单一 tree-sitter query(.scm)机制**(query-runner + 每语言一份查询/定义),并**首发 Python**。`ParseResult` 契约不变 → **dependency-graph / selector 零改;symbol-indexer 仅改 extractor 调用签名**(传 `provider` 以便编译查询)。

**策略**:query 统一(连 JS/TS 一起迁,退役 `js-ts-extractor.js`)。**最关键的风险是 JS/TS 等价迁移**——以现有 js-ts 测试 + golden parity 为判据,**先 shadow 并跑、parity 稳定后再切默认、最后才退役旧 extractor**。

**已验证**:web-tree-sitter `0.20.8` 支持 `lang.query(scm)` / `query.captures(root)`。

---

## 2. 架构

```text
provider.parseTree(file, src) -> { ok, language, tree }
  + provider.compileQuery(language, scm) -> Query   // 用已加载 Language 编译并缓存
        ↓
query-extractor.extractParseResult({ file, source, provider })   // indexer 传 provider(parseTree + compileQuery);graph/selector 零改
  ├─ parsed = provider.parseTree(file, source) -> { ok, language, tree }
  ├─ 选 languageDef(by language)
  ├─ 跑 provider.compileQuery(language, languageDef.query) 的 captures
  └─ 用 languageDef 把 captures 组装成 ParseResult(语言无关地算 enclosing-symbol / 排序)
        ↓
ParseResult(契约不变) -> symbol-indexer / dependency-graph / symbol-selector(零改)
```

---

## 3. 组件

| 单元 | 职责 |
|------|------|
| `src/context/semantic/query-extractor.js` | 通用 runner:跑查询、收集 captures、组装 `ParseResult`;**语言无关**地算 enclosing-symbol、规范排序、回退 |
| `src/context/semantic/languages/javascript.js` · `typescript.js` · `python.js` | 每语言定义:`query`(.scm)、`symbolKinds`、`exported(node)`、`classifyCallee(node)`、`normalizeImports/Exports`、`callablePriority` |
| `src/context/semantic/wasm-tree-sitter-provider.js`(改) | 加 `py` 到 `EXT_LANG` + 载 `tree-sitter-python.wasm`;新增 `compileQuery(language, scm)` |
| `src/context/semantic/module-resolver.js`(改) + `python-module-resolver.js`(新) | 按语言派发的解析注册表;JS 用现有,Python 用新解析器 |
| 退役 `js-ts-extractor.js` | parity 稳定后,由 query-extractor + js/ts 定义取代 |

---

## 4. 硬约束(实施判据)

### 4.1 JS/TS 迁移先 shadow parity(不先退役旧 extractor)
- query-extractor 与旧 `js-ts-extractor` **并跑一段测试路径**,对每个 fixture 做 `ParseResult` **golden 多重集对比**:`symbols` / `imports` / `exports` / `calls` / `symbol_id` 全稳定。
- **顺序**:M1 建 runner + JS 定义 → shadow parity 全绿 → 才把默认抽取切到 query → **最后**才删 `js-ts-extractor.js`。
- parity 语料:至少覆盖 §4.4 checklist 的全部形态 + 现有 fixtures。

### 4.2 确定性排序(规范键,用字节偏移)
match 返回顺序不保证稳定 → runner 对每类输出**按规范键排序**后产出。键用**字节偏移**(同一行多个符号/调用也稳定):

```text
排序键(取自捕获节点):(start_byte, end_byte, start_line, start_column, kind, name)
  start_byte = node.startIndex;start_column = node.startPosition.column(已验证 0.20.8 可取)
```

- 排序键仅用于**输出数组排序**(确定快照);**`symbol_id` 仍 = `${file}#${kind}:${name}:${start_line}`**(Phase B 契约,**不改**——同行同名同 kind 的罕见碰撞维持 Phase B 现状)。
- parity 用**多重集相等**比较(顺序无关);下游按 `symbol_id` 建 Map、不依赖数组序;现有 js-ts 测试断言前已 `.sort()` → 规范排序不破坏它们。

### 4.2b captures 按 match 分组(不做脆弱的 flat 后处理)
组装用 **`query.matches(root)`**(已验证 0.20.8 支持),每个 match 的 captures 天然按模式分组——如 `export { foo as bar }` 的 `@imp.name=foo` 与 `@imp.alias=bar` 落在**同一 match**。语言定义按"**一个 match → 一个 `ParseResult` 元素**(symbol / import / export / call)"组装。**不**用 `captures(root)` 的扁平列表再按父节点/range 聚合(复杂 import/export 易被搅乱)。

### 4.3 enclosing-symbol 规则(写死)
对一个 call 节点,enclosing symbol = **包含该 call 且行范围最小**的 symbol;若多个范围相同,按 `languageDef.callablePriority`(`method > function > variable > class`)再按 `symbol_id` 字典序 tie-break。方法 / 类 / 箭头 / 嵌套函数统一走此规则。

### 4.4 JS/TS 等价 checklist(modeled / 维持不建模)

| 形态 | 现有是否建模 | 本轮 |
|------|------|------|
| `function` / `class` / `method` 声明 | 是(symbol) | 复刻 |
| 顶层 `const x = () => {}` / `function expr` | 是(`variable`) | 复刻 |
| `export function/class`(具名) | 是(`exported:true`) | 复刻 |
| `export default function/class`(**具名**) | 是(kind `default`) | 复刻 |
| `export default function/class`(**匿名**) | 否(无 name → 非 symbol) | **维持不建模** |
| `export { foo as bar }` | 是(export_specifier alias) | 复刻 |
| `export * from "m"` | 否 | **维持不建模**(future) |
| `module.exports` / `exports.x`(CJS 导出) | 否 | **维持不建模**(Phase B §8:best-effort/none) |
| `import` default / named / namespace | 是 | 复刻 |
| `require("m")`(CJS 导入边) | 是 | 复刻 |
| 动态 `import()` | 是(`dynamic:true`) | 复刻 |
| `obj.run()` → member_property | 是(B+1) | 复刻 |
| `obj["x"]()` → dynamic 无 property | 是(B+1) | 复刻 |
| TS `interface` / `type` 别名 | 否(不入 symbolTable) | **维持不建模**(future `type` kind) |
| `.jsx`(js grammar)/ `.tsx`(ts grammar) | 现状 | **不变**(tsx 专用 grammar 加载留 future) |

### 4.5 Python `exported` 规则
- 模块级 `function` / `class` → `exported: true`(模块导入目标)。
- class 内 `method` → **symbol 但 `exported: false`**(不是 `from m import method` 的目标)。
- `_private` → 本轮仍 `exported: true`,**显式注明**:静态可见,**不模拟** Python `_` 命名约定过滤(留 future)。
- `exports: []`(Python 无 export 语句;跨文件绑定靠 `exported` 符号回退,见 dependency-graph 的 `buildImportBinding`)。

### 4.6 降级行为(具体)
- 单文件无 languageDef / 查询编译失败 / parse 失败 → 该文件返回 `ok:false` 的空 `ParseResult`,`symbol-indexer` 计 `stats.failed` 并**跳过**,记 debug/warning。
- **不影响其他文件**;**不让 semantic engine 失败**;provider 整体不可用仍走 Phase B 的全量回退(降级文件级)。

### 4.7 `importRoots` 语义
- `context.semantic.importRoots` 默认 `[]`,**实现上等价 `[projectRoot]`**。
- 配置项是**追加不是替换**:有效根 = `[projectRoot, ...importRoots]`(去重)。
- 文档须写明"空数组 = 仅项目根",避免误读成"不解析"。

---

## 5. Python 特化

- **符号**:`function_definition` / `class_definition` / class 内 `function_definition`(method)。`exported` 按 §4.5。
- **import 形态 → `Import`**:
  - `import os` / `import os.path as p` → `names:[]`,`namespace`-ish;裸/绝对包,`resolved_file` 经解析器(多半 external)。
  - `from .mod import x` / `from ..pkg.bar import y as z` → `names:[{imported, local}]`,相对解析。
  - `from pkg.mod import x` → 绝对,按 import roots 解析。
- **Python 模块解析器**(§4.7 口径):dotted specifier + 当前模块所在包 + 有效 import roots → workspace `.py` / `__init__.py` / namespace package(无 `__init__` 的目录);解析不到 → `null`(external)。
- **`classifyCallee`**:`call` 的 function 为 `identifier`→`identifier`、`attribute`→`member`(`member_property` = attribute 名)、其它→`dynamic`。

---

## 6. 配置

```text
context.semantic.languages   ["js","ts"] -> 加 "py"
context.semantic.importRoots []          -> 默认 [projectRoot];配置追加(§4.7)
```

`normalizeContext`(config.js)归一化 `languages`(白名单数组)与 `importRoots`(字符串数组,去空)。默认行为不变(语义默认关)。

---

## 7. 测试

- **JS/TS shadow parity**(§4.1):语料逐 fixture 多重集对比 old vs query 输出,全等才算迁移成功。
- **JS/TS 既有 extractor 测试**:不改、全绿(切默认后仍绿 = 等价)。
- **query-runner 单元**:captures → ParseResult 组装、规范排序、enclosing-symbol(嵌套/同范围 tie-break)、回退(缺定义/查询错 → ok:false 不崩)。
- **Python 新测**:模块级 symbol(`exported:true`)、method(`exported:false`)、import 四形态、相对/绝对/`__init__`/namespace 解析、importRoots 追加、调用(direct + member hint)。
- **disabled-parity**:语义关闭仍逐字节一致(回归)。

---

## 8. 里程碑(供拆实施计划)

```text
M1  query-extractor runner + provider.compileQuery + JS 语言定义 + js.scm
     + shadow-parity 测试(old vs query,多重集);旧 extractor 仍在
M2  TS 语言定义 + ts.scm;扩 parity 语料过 TS 行为
M3  切默认抽取到 query(JS/TS 既有测试全绿);**保留 js-ts-extractor + parity flag**
     (测试仍可 old vs query 对跑,便于回滚)——本步不删旧实现
M4  vendor tree-sitter-python.wasm + python 语言定义 + python.scm
     + Python 模块解析器 + importRoots 配置 + Python 测试
M5  语言注册表接入 indexer/engine(按语言派发解析器)+ 文档(README 语言支持、CHANGELOG)
M6  Python 接入稳定后,**真正退役 js-ts-extractor.js**(移除 parity flag 与旧实现)
```

> M1–M3 是"等价迁移"(零行为变化,judge=parity);M4–M5 才是新能力(Python);**M3 只切默认不删旧、M6 才删**——给回滚留缓冲。严格分段,降低回归风险。

---

## 9. 非目标(本轮)

- ❌ `sys.path` / 已安装包 / 动态 `importlib` / 条件 import(静态不可达 → external)。
- ❌ Go / Rust(后续按同一 runner 加语言定义)。
- ❌ TS `interface`/`type` 入表、`export *`、CJS 导出建模、匿名 default 符号(维持不建模)。
- ❌ `.tsx` 专用 grammar 加载、Python `_` 命名约定过滤(留 future)。
- ❌ 增量图差分(B+2)。
