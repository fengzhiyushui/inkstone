# 上下文与记忆（Living Spec）

- 类型：后端 spec
- 状态：Living Spec，随实现更新；v1.19.0 整合自 5 篇历史 spec（语义上下文实现至 B+3；经验记忆随 Phase C 落地）
- 关联：[运行时与执行](runtime-and-execution.md) · [编排](orchestration.md) · [系统架构](../architecture/system-architecture.md) · [文档索引](../../README.md)

> 本文是 v1.19.0 整合后的领域 Living Spec，取代原 5 篇碎片化历史 spec（见文末「来源」）。

## 来源与覆盖

| 来源（basename） | 覆盖内容 |
|---|---|
| `2026-05-31-v2-9-context-engine-design.md` | ContextUnit、索引与预算、选择与快照、事件与接入 |
| `2026-05-31-v2-10-context-cache-usage-telemetry-design.md` | 上下文缓存与 manifest、增量扫描、懒水合、稳定前缀（用量遥测见[运行时与执行](runtime-and-execution.md)） |
| `2026-06-26-v3-phase-b-semantic-context-design.md` | 语义上下文：WASM tree-sitter、符号表、调用图、配置与缓存、事件 |
| `2026-06-26-v3-phase-b-plus1-method-hints-design.md` | `includeMethodHints` 唯一同名近似解析与 `probable` 边 |
| `2026-06-26-v3-phase-b-plus3-multi-language-design.md` | query 统一抽取、Python 首发、shadow parity 迁移 |
| `2026-06-24-agent-layered-memory-design.md` | 分层映射、巩固与三级分化、卫生原则 |
| `2026-06-27-v3-phase-c4-experience-memory-design.md` | 跨任务经验记忆落地：schema、打分、聚簇、巩固器、检索、风险升权 |

---

## 1. 上下文引擎

### 1.1 模块与入口

```
src/context/
  context-unit.js · workspace-indexer.js · token-budget.js
  context-selector.js · context-snapshot.js · context-manifest.js
  context-cache.js · project-index.js · index.js · semantic/
```

入口 `createContextEngine({ root, eventBus, options })`：`scan` / `snapshot` / `pin` / `unpin` / `warm` / `invalidate` / `getStats`。

### 1.2 ContextUnit

```js
{ id, type: "file", path, hash, bytes, token_count, priority, reason, snippet, updated_at }
```

语义层增加 `type: "symbol"` 的 `SymbolUnit`（含 `defined_in`、`hash`、`token_count`、`priority`）。

优先级：**P0** 稳定清单（`package.json`、`README.md`、`pyproject.toml`、`Cargo.toml`、`go.mod`、`environment.yml`）；**P1** pin 与消息提及；**P2** 测试、入口、配置与 warm；**P3** 默认元数据。同路径同内容的 id/hash 确定。

### 1.3 索引与跳过规则

`workspace-indexer` 用 `walkWorkspaceFiles` / `readWorkspaceTextFile`（遍历忽略规则在 v1.19.0 起统一由 `src/workspace/path-safety.js` 作为单一真源维护）。默认 `maxFiles: 1000`、`maxFileBytes: 64*1024`、`maxSnippetBytes: 4000`。跳过原因（计入 stats）：

| 原因 | 规则 |
|---|---|
| `ignored-directory` | 路径段命中 `.git`、`.deepseek-code`、`node_modules`、`dist`、`build`、`coverage`、`.next`、`.nuxt`、`.turbo`、`.cache`、`target`、`vendor`、`__pycache__` |
| `hidden-tool-dir` | 路径段命中 `.claude`、`.cursor`、`.vscode`、`.idea`、`.codex`、`.gemini` |
| `credential-file` | basename 命中凭据名单（`.npmrc` 等）或匹配凭据模式 |
| `secret-file` | basename 为 `.env` / `.env.*`，或匹配私钥后缀（`*.pem`、`*.key` 等）或匹配密钥模式 |
| `binary` | `readWorkspaceTextFile` 报 `binary file refused` |
| `too-large` | `file too large` |
| `path-escape` | `path escapes project root` |

不可读/二进制/超限跳过并计数，不中断扫描。

### 1.4 token budget

`token-budget.js` 按字节估 token，`budgetForChannel(channel, overrides)` 默认通道预算（设计初值，以代码为准）：

| channel | 默认 |
|---|---|
| `reply` | 6000 |
| `act` | 8000 |
| `repair` | 10000 |
| `think` | 12000 |

### 1.5 选择与快照

`context-selector` 先 P0，再 pin/提及，再 warm 伙伴，按预算裁剪并记录 `reason`。提及检测：相对路径精确匹配、索引内唯一 basename、带引号路径片段。

快照字段：`snapshot_id`、`channel`、`task_type`、`summary`、`units[]`（id/path/hash/token_count/priority/reason）、`unit_hashes`、`file_revision_hashes`、`assembly_order`、`expected_cache_prefix_offset`、`budget`、`stats`。**模型只收 `summary`**。装配顺序确定：P0 固定序 → P1 → P2 → P3。

### 1.6 接入与事件

runtime 经注入的 `createContextSnapshot()` 取快照，不直接碰文件系统。`prompt-assembler` 与 `repair-prompt` 消费 `context.summary`。query 快路径同样带上下文。Kernel 暴露 `kernel.context.snapshot/pin/unpin/getStats`。

事件：`context:snapshot`、`context:warm`、`context:pin`、`context:unpin`，载荷不含文件内容。

### 1.7 边界

1. 上下文只读，不执行工具、不写项目文件。
2. 禁 symlink 逃逸、二进制、超限、`.env`/凭据类文件。
3. 事件不落 snippet。
4. 测试可用 `context: { disabled: true }` 或注入临时 `cacheRoot`。

---

## 2. 上下文缓存与 manifest

`src/context/context-manifest.js`，默认 `<root>/.deepseek-code/v2/context/manifest.json`：

```js
{
  schema_version: 1,
  project_root_hash, created_at, updated_at,
  files: { "<rel>": { path, hash, bytes, token_count, priority, reason, mtime_ms, size, indexed_at } },
  stats: { indexed_files, skipped_files, reused_files, changed_files }
}
```

**禁止** snippet / content / 原文 / 明文绝对路径。原子写（临时文件 + rename）。损坏即当空；`schema_version` 不匹配起空库。

### 2.1 增量扫描

`context-cache.js`：`load manifest → walk → stat → 未变复用元数据 / 变更安全读并重建 → save`。增量判据是 **path + size + mtime + 策略版本**（不只看 mtime）。统计 `scanned_files`、`indexed_files`、`skipped_files`、`reused_files`、`changed_files`、`manifest_loaded/saved`、`scan_duration_ms`。

### 2.2 懒水合

`ContextRecord`（可进 manifest）与 `HydratedContextUnit`（record + snippet，仅内存）分离。`snapshot()` 先按元数据排序，再只读选中文件。读失败跳过并计 `hydrate_skipped_files`，不中断快照。

### 2.3 稳定前缀

P0 固定顺序：`package.json`、`README.md`、`environment.yml`、`pyproject.toml`、`Cargo.toml`、`go.mod`。P0 标签与分隔稳定；P1/P2 可随消息变化。`expected_cache_prefix_offset` 只计 P0。不保证供应商缓存命中，但提高同项目多轮前缀复用。

### 2.4 事件与配置

事件：`context:cache_loaded`、`context:cache_saved`、`context:cache_reused`，载荷限计数与时长。

`options.context`：`disabled`、`persistent`、`cacheRoot`、`manifestName`、`maxFiles`、`maxFileBytes`、`maxSnippetBytes`、`budgets`。测试必须临时 `cacheRoot` 或 `disabled`，避免污染仓库。

### 2.5 边界

1. Manifest 仅元数据白名单字段。
2. 凭据与隐藏工具配置目录继续跳过。
3. 读文件仍走 `readWorkspaceTextFile`。
4. Cache 文件不写到选定 root 之外。
5. 事件不含文件内容。

---

## 3. 语义上下文（Phase B）

### 3.1 架构与开关

```
createContextEngine（门面不变）
  scan()  文件扫描 → [semantic on] symbol-indexer → dependency-graph
  snapshot()  [on] symbol-selector / [off] context-selector
```

组件（`src/context/semantic/`）：`parser-provider` 抽象、`wasm-tree-sitter-provider`、`language-registry` 与 languages 适配器、`symbol-indexer`、`symbol-cache`、`module-resolver`、`dependency-graph`、`symbol-selector`、`symbol-unit`、`semantic-engine`、`query-extractor`。

配置 `context.semantic`（`src/config.js`）：`enabled: false`、`hops: 2`、`maxSymbols: 200`、`includeMethodHints: false`、`importRoots: []`（等价 `[projectRoot]`，配置是追加：有效根 = `[projectRoot, ...importRoots]`）、`languages` 含 `js`/`ts`/`py`。CLI 可用 `--semantic-context` / `--include-method-hints` 覆盖（`--include-method-hints` 隐含 semantic on；未传 flag 不创建 semantic 覆盖，完全走 config；合并规则 CLI 覆盖 config）。

**默认关 = 行为逐字节一致。**

### 3.2 数据结构

- `Symbol`：`symbol_id`、`file`、`name`、`kind`（function/class/method/variable）、`range`、`exported`。
- `Import` / `Export`：specifier、绑定名、`esm|cjs`、`dynamic`。
- `CallEdge`：caller/callee、`confidence: resolved|probable|unresolved`、`reason`（`direct-local-call` / `import-binding` / `member-call` / `dynamic-call`）。
- `symbol_id = path#kind:name:start_line`。对函数体编辑稳定，行号位移会变；跨编辑持久 id 非目标。

`confidence` / `reason` 是一等字段。

### 3.3 可靠子集与解析

- `resolved` 只覆盖：静态 import/require 字面量、named/default/namespace 导出、function/class 与顶层具名函数表达式、直接本地或 import 绑定调用。
- `obj.method()`、`this.run()` → `unresolved` + `member-call`；动态 import、计算调用 → `unresolved` + `dynamic-call`。**unresolved 边照常进图**，不是解析失败，是一等图事实。
- 模块解析：`./x` `../x` 到 workspace 文件；`.js .jsx .ts .tsx .mjs .cjs`（含 index）；bare specifier 标 external 不展开。CJS：`require()` 导入边可解析；`module.exports` 导出绑定 best-effort。
- grammar `.wasm` 随仓 vendored，**懒加载**。per-file 缓存（`symbol-cache.js`）按内容 hash，对齐 context-cache manifest。
- **降级**：单文件解析/查询失败返回 `ok:false` 空结果，跳过并计数，不拖垮引擎；解析失败降级文件级；**provider 不可用则全量退回文件级**。

### 3.4 方法提示（B+1）

`context.semantic.includeMethodHints` 点亮后，对 `obj.method()`：取属性名 → 项目符号表查可调用同名符号。**恰好 1 个** → `confidence:"probable"`、`reason:"member-call"`、连到该符号；0 或 ≥2 → 仍 `unresolved`，不连边。

- 索引范围只含 function/method/variable（函数值），不含 class，避免误连到类。
- `probable` 边参与 `neighbors` 扩展但 confidence 不丢：`neighbors` 返回 `Map<symbol_id, confidence>`。selector 中 resolved 邻居 priority 2 / `graph-neighbor`，probable 邻居 priority 3 / `graph-neighbor-probable`。
- `probable` 不参与任何硬决策，只作上下文提示。
- 调用抽取增加 `member_property`（最近一层 property 名）；`obj["run"]()` 归 dynamic，不提示；`a.b.c()` → `"c"`（`callee_raw` 为 `a.b.c`）。
- `dependency-graph` 构建 `nameIndex: Map<name, symbol_id[]>`（只索引可调用 kind），`methodHints` 开时对 member 做唯一匹配。
- 默认关时不产生任何 probable 边，邻接表不变。

### 3.5 多语言扩展（B+3）

统一 tree-sitter query（`.scm`）机制，首发 Python：

```
provider.parseTree + compileQuery
  → query-extractor.extractParseResult({ file, source, provider })
  → languageDef（js / ts / py）组装 ParseResult
  → symbol-indexer / dependency-graph / symbol-selector（契约不变）
```

组件：`query-extractor.js`（通用 runner）、`languages/{javascript,typescript,python}.js`、`wasm-tree-sitter-provider.js`（`compileQuery`）、`module-resolver.js` + `python-module-resolver.js`。`query-extractor` 为唯一抽取路径，`js-ts-extractor.js` 已退役。

硬约束：

- **Shadow parity**：新旧抽取器对 fixture 做 `ParseResult` 多重集对比（symbols/imports/exports/calls/symbol_id）全等后才切默认。
- **规范排序键**：`(start_byte, end_byte, start_line, start_column, kind, name)`。
- 一个 match 产出一个 ParseResult 元素；`export { foo as bar }` 等同 match 绑定。
- `enclosing-symbol`：包含 call 且范围最小的 symbol；同范围按 `callablePriority`（method > function > variable > class）再按 id。
- JS/TS 等价 checklist：复刻已有建模；匿名 default、`export *`、CJS 导出、TS interface/type 明确不建模。
- Python：符号为模块级 `function`/`class`（`exported`），class 内 method（非 exported）；import 支持 `import x`、`from .mod import y`、绝对 `from pkg.mod import z`；模块解析器处理 dotted specifier、包、`__init__.py`、namespace package，解析不到为 external；callee 分 identifier / member / dynamic。
- 迁移顺序 M1–M6：JS/TS shadow parity 稳定后再切默认、最后退役旧抽取器。

### 3.6 事件

仅语义开启时经 eventBus 发布 `context:symbol_indexed`、`context:graph_built`（**不入** `SESSION_EVENT_TYPES`，与 `orchestration:*` 同级）。`context:snapshot` 附带 file/symbol 分布。降级事件 `context:semantic_degraded` **在** `SESSION_EVENT_TYPES` 内，入会话时间线，`event-contract` 出非静默 warn（审计 #8）。关闭语义时行为与文件级路径一致。

### 3.7 边界

1. 默认关 = 行为逐字节一致。
2. 核心 CLI 无必需运行时依赖；语义为可选懒加载 WASM，不引入原生构建。
3. unresolved 不是解析失败，是一等图事实。
4. 不做 embedding、TS 类型分析、native tree-sitter、Go/Rust、`.tsx` 专用 grammar、Python `_` 过滤、sys.path、动态 importlib、增量图差分、跨文件类型推断、类内 `this` 专门消歧、置信度细分。

---

## 4. 分层记忆

### 4.1 分层映射

| 层 | 存储 | 归属 | 写 | 读 |
|---|---|---|---|---|
| 情景 | 事件时间线 | 既有 | 系统 | 巩固回放 |
| 语义 | 事实库 | 主记忆 | worker（`memory` 工具） | worker |
| 偏好 | 偏好库 | 主记忆 | worker / 用户 | worker、planner |
| 程序 | 经验库 | 经验记忆 | 仅次 agent | planner |
| 风险 | 风险库 | 经验记忆 | 仅次 agent | planner + 权限层 |
| 反思 | 反思缓冲 | 经验记忆 | 次 agent | 巩固后丢弃 |
| 风险显著度 | 标记 | 横切 | 次 agent | 检索权重 + 权限 |

**双记忆分离**：主记忆（`src/tools/builtin/memory.js` 的 `memory` 工具，事实/偏好，高信任）与经验记忆（`.deepseek-code/v2/experience/`，教训，带置信度的启发）在目录、信任级、消费者上全分离。经验是投影，必须可回溯 source task/turn；经验可删，事实与原始日志不动；经验可一键清空。

### 4.2 巩固与三级分化

次 agent 在任务边界回放事件 → 写反思 → 将反复有效的提炼为程序/风险 → 打分定级。

| 级 | 含义 | 检索权重 |
|---|---|---|
| T1 核心 | 高置信、近期反复有效 | 强 |
| T2 候选 | 中置信/中等老化 | 中 |
| T3 观察 | 低置信/偏旧/未验证 | 弱 |
| 低于 T3 | 过低/过旧/屡误导 | 删除 |

打分（`src/core/memory/experience-scoring.js`）：

```text
score = clamp01(confidence + 0.1*ln(1+validations)
                - decayPerDay*daysSince(lastReinforced) - 0.2*misleads)
```

默认 `T1/T2/T3 = 0.7/0.4/0.2`，`decayPerDay = 0.02`，`cap = 200`。低于 T3 删除并写 `experience-evictions.jsonl`；超 cap 末位淘汰（确定性 tie-break）。新经验 confidence 夹在 `[0.2, 0.6]`。被采纳且后续审核有效则强化升级；误导或与新事实冲突则削弱；久未强化则衰减下沉。

### 4.3 Schema 与存储

`ExperienceEntry`：`id`、`kind`（`procedural|risk`）、`lesson`、`cues[]`、`provenance`、`confidence`、`validations`、`misleads`、`created`、`lastReinforced`、`tier`。**不存 `reasoning_content`**。

单文件原子写 + 实例内写队列防 lost-update；`schemaVersion` 不匹配起空库。

### 4.4 聚簇去重

cue 归一化（去停用词、代码路径整段保留），**有效 cue ≥2 才参与**；相似度用 token 集 **Jaccard**，`dedupThreshold = 0.6`（Jaccard ≥0.6 同簇）。**risk 与 procedural 永不同簇**；同簇保留最高 tier 并合并证据。聚簇不用 Phase B 代码符号图。

### 4.5 巩固器

挂在 `orchestrator.finalize()` 之后异步跑（tracked promise，`flushExperience` / `dispose` 收口）。readonly runtime 提炼 ≤ `maxLessonsPerTask`（默认 5）条，只提炼 `{kind, lesson, cues, confidence}`。仅 `crossTaskLearning !== "off"` 且 orchestrate 档触发。强化/削弱按 `adopted = used_experience_ids ∩ presentedIds` 与任务 outcome 程序判定——只认 adopted，读到 ≠ 用到。

### 4.6 检索与注入

`experience-retrieval.js`：cue 重叠 × tier 权重取 top-`retrieveK`（默认 5）。产出 procedural 简报、`presentedIds`、`riskCues`。简报进 `planner.plan({ experiences })`；Planner 回 `used_experience_ids`。检索只读；检索合成简报而非贴原文。

### 4.7 风险 → 权限

`risk-rules.js` 生成 `escalate_only` 规则。`permission-engine` 在 default-matrix 的 `allow` 上做**单调升级**为 `ask`（source `risk-experience`）；绝不覆盖 trust-store / approval-cache / project-rules 的显式决策，绝不 `deny/ask` 变松，只升不降。升级只作用串行主区 worker，不作用 C3 iso worker。风险 cue 单独收集驱动权限升级。

### 4.8 开关与 gated

`autonomy.crossTaskLearning` / `config.orchestration.crossTaskLearning`：`off` | `on` | `gated`，默认 `off`。

- `off` 时无目录、无事件、无 prompt 注入，decide 输出与今天一致。
- `gated` 下高影响条目（risk 或拟升 T1）进 `pending/` 待审区，`kernel.experience.listPending/resolvePending` 带外审批；TTL 默认 24h（`pendingTtlMs: 86400000`）过期自动 deny；进程退出保留待审不自动落库。

配置块见 `src/config.js` 的 `orchestration.experience`（`cap`、`decayPerDay`、`thresholds`、`dedupThreshold`、`maxLessonsPerTask`、`retrieveK`、`pendingTtlMs`）。

### 4.9 事件（eventBus 级，7 类）

`experience:retrieved` / `experience:consolidated` / `experience:evicted` / `experience:reinforced` / `experience:weakened` / `experience:pending_approval` / `experience:pending_resolved`。

### 4.10 自主优化两层

- 任务内：审核摘要立刻改后续派发（始终开）。
- 跨任务：提炼进经验记忆，供后续 planner（默认 off）。

### 4.11 边界

1. `agent-runtime.js` 不改。
2. 模型只提炼与读简报；打分/定级/淘汰/升级是程序逻辑。
3. 权限只升不降。
4. `off` 时零回归。
5. 清空经验不影响主记忆与时间线。
6. 不把 `reasoning_content` 原文写入记忆；`reasoning_content` 不作长期记忆，只存提炼后的判断摘要。

---

## 来源

- `2026-05-31-v2-9-context-engine-design.md`
- `2026-05-31-v2-10-context-cache-usage-telemetry-design.md`
- `2026-06-24-agent-layered-memory-design.md`
- `2026-06-26-v3-phase-b-semantic-context-design.md`
- `2026-06-26-v3-phase-b-plus1-method-hints-design.md`
- `2026-06-26-v3-phase-b-plus3-multi-language-design.md`
- `2026-06-27-v3-phase-c4-experience-memory-design.md`
