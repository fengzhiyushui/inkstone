# Phase B+3 · 扩语言（query 统一抽取）设计

- 类型：后端 spec
- 日期：2026-06-26
- 状态：已实现（M1–M6，2026-06-27；`query-extractor` 为唯一抽取路径，`js-ts-extractor` 已退役）
- 关联：[Phase B 语义上下文](2026-06-26-v3-phase-b-semantic-context-design.md) · [B+1 方法提示](2026-06-26-v3-phase-b-plus1-method-hints-design.md)

---

## 问题与目标

Phase B 抽取层用硬编码 JS/TS 节点类型，下游只吃 `ParseResult`。B+3 迁到统一 tree-sitter query（.scm）机制，并首发 Python。`ParseResult` 契约不变，dependency-graph / selector 零改。迁移顺序是 JS/TS shadow parity 稳定后再切默认、最后退役旧抽取器。

## 决策

| 决策点 | 选择 | 否决项 | 理由 |
|---|---|---|---|
| 抽取机制 | query-extractor + 每语言 .scm | 继续硬编码节点类型 | 多语言可扩展 |
| 迁移 | shadow parity 全绿再切默认 | 直接替换 | 等价迁移可回滚 |
| 排序 | 字节偏移规范键 | 依赖 match 顺序 | 确定性快照 |
| 组装 | `query.matches` 按 match 分组 | flat captures 后处理 | 复杂 import/export 不被搅乱 |
| Python exported | 模块级 function/class 为 true，method 为 false | 模拟 `_` 约定 | 静态可见，不做命名过滤 |

## 设计

### 架构

```
provider.parseTree + compileQuery
  → query-extractor.extractParseResult({ file, source, provider })
  → languageDef（js / ts / py）组装 ParseResult
  → symbol-indexer / dependency-graph / symbol-selector（契约不变）
```

组件：`query-extractor.js`（通用 runner）、`languages/{javascript,typescript,python}.js`、`wasm-tree-sitter-provider.js`（`compileQuery`）、`module-resolver.js` + `python-module-resolver.js`。

### 硬约束

- Shadow parity：新旧抽取器对 fixture 做 `ParseResult` 多重集对比（symbols/imports/exports/calls/symbol_id）全等后才切默认。
- 规范排序键：`(start_byte, end_byte, start_line, start_column, kind, name)`。`symbol_id` 仍是 `path#kind:name:start_line`。
- 一个 match 产出一个 ParseResult 元素；`export { foo as bar }` 等同 match 绑定。
- enclosing-symbol：包含 call 且范围最小的 symbol；同范围按 `callablePriority`（method > function > variable > class）再按 id。
- JS/TS 等价 checklist：复刻已有建模；匿名 default、`export *`、CJS 导出、TS interface/type 明确不建模。
- 降级：单文件解析/查询失败返回 `ok:false` 空结果，跳过并计数，不拖垮引擎。
- `importRoots` 默认 `[]` 等价 `[projectRoot]`；配置是追加：有效根 = `[projectRoot, ...importRoots]`。

### Python

符号：模块级 `function` / `class`（exported），class 内 method（非 exported）。import 支持 `import x`、`from .mod import y`、绝对 `from pkg.mod import z`。模块解析器处理 dotted specifier、包、`__init__.py`、namespace package；解析不到为 external。callee 分 identifier / member / dynamic。

### 配置

`context.semantic.languages` 含 `js`/`ts`/`py`；`importRoots` 字符串数组。语义默认仍关。

## 边界与不变量

1. `ParseResult` 契约不变。
2. 不做 sys.path、动态 importlib、Go/Rust、`.tsx` 专用 grammar、Python `_` 过滤。
3. M3 只切默认不删旧，M6 才退役 `js-ts-extractor.js`。

## 与现状的差异

语言定义与 query 文件在 `src/context/semantic/languages/`。状态标注已落地。

## 验收

JS/TS shadow parity 全绿；既有 extractor 测试不改仍绿；Python 四类 import 与符号规则有测；语义关闭 parity 不变。入口 `npm test`。
