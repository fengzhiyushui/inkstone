# V2-9 上下文引擎设计

- 类型：后端 spec
- 日期：2026-05-31
- 状态：已实现
- 关联：[V2-8 修复环](2026-05-31-v2-8-verifier-repair-loop-design.md) · [V2-10 缓存与用量](2026-05-31-v2-10-context-cache-usage-telemetry-design.md) · [语义上下文](2026-06-26-v3-phase-b-semantic-context-design.md)

---

## 问题与目标

首个模型调用几乎不带项目上下文，规划与修复提示偏盲。V2-9 在 `src/context/` 建最小可用引擎：安全扫描、确定性 ContextUnit、预算内选片、可注入 prompt 的 `summary`，并保持 cache-friendly 稳定前缀顺序。本轮不做语义索引。

## 决策

| 决策点 | 选择 | 否决项 | 理由 |
|---|---|---|---|
| 代码位置 | 新建 `src/context/` | 直接搬 V1 `context-engine.js` | 概念可复用，V1 形状与安全规则不复用 |
| 粒度 | 文件级 + 有界 snippet | AST / 向量 | 先稳定、便宜、可测 |
| 提及检测 | 确定性路径匹配 | 模糊搜索 | 可复现 |
| 预算 | 通道预算（thousands 级） | 顶满模型窗口 | 先可靠后扩张 |
| 事件 | 只发元数据 | 带 snippet | 会话日志不泄内容 |

## 设计

### 模块

```
src/context/
  context-unit.js · workspace-indexer.js · token-budget.js
  context-selector.js · context-snapshot.js · index.js
```

入口 `createContextEngine({ root, eventBus, options })`：`scan` / `snapshot` / `pin` / `unpin` / `warm` / `invalidate` / `getStats`。

### ContextUnit

```js
{ id, type: "file", path, hash, bytes, token_count, priority, reason, snippet, updated_at }
```

优先级：P0 稳定清单（package.json、README.md、pyproject.toml、Cargo.toml、go.mod、environment.yml）；P1 pin 与消息提及；P2 测试、入口、配置与 warm；P3 默认元数据。同路径同内容的 id/hash 确定。

### 索引与预算

`workspace-indexer` 用 `walkWorkspaceFiles` / `readWorkspaceTextFile`，跳过 `.git`、`.deepseek-code`、`node_modules`、`dist`、`build`、`coverage`、`.next`、`.nuxt`、`.turbo`、`.cache`、`target`、`vendor`、`__pycache__`、`gui/node_modules` 等。默认 `maxFiles: 1000`、`maxFileBytes: 64*1024`、`maxSnippetBytes: 4000`。不可读/二进制/超限跳过并计数。

`token-budget` 按字节估 token，默认通道预算（当前以 `budgetForChannel` 为准，设计初值 reply 6000 / act 8000 / repair 10000 / think 12000）。

### 选择与快照

`context-selector` 先 P0，再 pin/提及，再 warm 伙伴，按预算裁剪并记录 reason。提及检测：相对路径精确匹配、索引内唯一 basename、带引号路径片段。

快照字段：`snapshot_id`、`channel`、`task_type`、`summary`、`units[]`（id/path/hash/token_count/priority/reason）、`unit_hashes`、`file_revision_hashes`、`assembly_order`、`expected_cache_prefix_offset`、`budget`、`stats`。模型只收 `summary`。装配顺序确定：P0 固定序 → P1 → P2 → P3。

### 接入

runtime 经注入的 `createContextSnapshot()` 取快照，不直接碰文件系统。`prompt-assembler` 与 `repair-prompt` 消费 `context.summary`。query 快路径同样带上下文。Kernel 暴露 `kernel.context.snapshot/pin/unpin/getStats`。

事件：`context:snapshot`、`context:warm`、`context:pin`、`context:unpin`，载荷不含文件内容。

## 边界与不变量

1. 上下文只读，不执行工具、不写项目文件。
2. 禁 symlink 逃逸、二进制、超限、`.env`/凭据类文件。
3. 事件不落 snippet。
4. 测试可用 `context: { disabled: true }` 或注入临时 `cacheRoot`。

## 与现状的差异

持久化 manifest 与增量扫描见 [V2-10](2026-05-31-v2-10-context-cache-usage-telemetry-design.md)。符号级检索见 [Phase B 语义上下文](2026-06-26-v3-phase-b-semantic-context-design.md)。当前语义开关为 `context.semantic.enabled`（默认 false）。

## 验收

`snapshot()` 返回真实单元；尊重预算与路径安全；pin/提及优先；工具环首调、query、repair 均带 `summary`；事件无内容；既有测试不回归。入口 `npm test`、`npm run check`。
