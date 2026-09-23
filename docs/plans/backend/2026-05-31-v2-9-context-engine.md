# V2-9 Context Engine

- 类型：实施计划
- 日期：2026-05-31
- 状态：已完成
- 关联：[CHANGELOG](../../CHANGELOG.md)、[设计](../../specs/backend/2026-05-31-v2-9-context-engine-design.md)

## 目标

用安全、确定性、受预算约束的项目上下文引擎替换 V2 空 context 门面，在 query、tool-loop 与 repair 调用前把上下文喂给 DeepSeek。

## 结果

`src/context/` 服务经现有 V2 path-safety 帮助函数索引工作区文本文件，按稳定前缀、pin、消息提及与任务类型排序，组装带缓存感知的紧凑快照。引擎挂进 `createKernel()`，快照注入 `createAgentRuntime()`，runtime 保持文件系统无关。

### 文件结构

创建：

| 路径 | 职责 |
|------|------|
| `src/context/context-unit.js` | 确定性 `ContextUnit`、token 估计、基础优先级、snippet 裁剪、内容 hash |
| `src/context/token-budget.js` | 通道预算归一化与不超预算选取 |
| `src/context/workspace-indexer.js` | `walkWorkspaceFiles()` + `readWorkspaceTextFile()` |
| `src/context/context-selector.js` | 稳定前缀、pin、消息提及、warmed、任务伴随文件的确定性装配顺序 |
| `src/context/context-snapshot.js` | 公开快照形状与紧凑 `summary` |
| `src/context/index.js` | `createContextEngine` 门面 |
| `tests/unit/context/context-unit.test.js` | 确定性 id/hash、token、snippet |
| `tests/unit/context/token-budget.test.js` | 预算内选取 |
| `tests/unit/context/workspace-indexer.test.js` | 安全遍历、跳过规则 |
| `tests/unit/context/context-selector.test.js` | 装配顺序 |
| `tests/unit/context/context-snapshot.test.js` | 快照形状 |
| `tests/unit/context/context-engine.test.js` | 门面 API |
| `tests/integration/v2-context-kernel.test.js` | 内核 context |
| `tests/integration/v2-runtime-context.test.js` | runtime 传递 |

修改：`src/core/runtime/agent-runtime.js`、`src/core/execution/executor-loop.js`、`src/core/execution/repair-executor.js`、`src/core/verification/repair-loop.js`、`src/core/verification/repair-prompt.js`、`src/index.js`、`src/sessions/event-types.js`、相关既有测试、`package.json`。

### 引擎 API

`createContextEngine({ root, eventBus, options })`：

| 方法 | 行为 |
|------|------|
| `scan()` | 索引工作区；`options.disabled` 为真时直接返回 stats |
| `snapshot(input)` | 按 phase/任务组装快照；记录为空时先 `scan()` |
| `pin(inputPath)` / `unpin(inputPath)` | 显式固定/取消，发布对应事件 |
| `warm(inputPath, reason)` | 预热文件 |
| `invalidate(inputPath)` | 失效缓存记录 |
| `getStats()` | 计数与预算统计 |

`createContextUnit({ path, content, reason, now })` 对同一 path+content 给出确定性 `id` 与 `hash`。字段包含 `path`、`type: "file"`、`reason`、`token_count`、`priority`、`hash`。

| 辅助 | 行为 |
|------|------|
| `estimateTokens(text)` | 稳定 token 估计 |
| `priorityForPath(path)` | 基础优先级 |
| `clipSnippet(text)` | 控制进入 prompt 的正文长度 |

`token-budget` 把通道预算归一化，按预算选取 unit，不超窗。`context-selector` 的装配顺序稳定：稳定前缀文件、pinned、消息提及、warmed、任务伴随文件。`context-snapshot` 产出公开快照与 DeepSeek 用的紧凑 `summary`。

### 集成契约

| 调用点 | 传入方式 |
|--------|----------|
| Query 快路径 | `modelGateway.reply()` 带 context |
| 工具循环 | 首次 DeepSeek `invoke()` 经 `prompt-assembler.js` 插入 `context.summary` |
| Repair prompt | 有界 `context_summary` |
| 审批恢复 | `resume_state` 保留同一 context 快照 |
| 内核门面 | `kernel.context.snapshot()` 除非显式 `context: { disabled: true }`，否则不再返回空快照占位 |

`agent-runtime` 在分类后创建 context，并传给 reply 快路径、executor loop 与 repair loop。runtime 代码不直接碰文件系统。

### 事件与隐私

| 事件 | 允许内容 |
|------|----------|
| `context:snapshot` | 路径、计数、预算、统计 |
| `context:pin` | 路径 |
| `context:unpin` | 路径 |
| `context:warm` | 路径与 reason |

`context:snapshot` 不含 snippet 或文件正文。

### 安全过滤

跳过：

- `.env` 与密钥形态文件
- `.git`
- `.deepseek-code`
- `node_modules`
- 构建产物
- 二进制文件
- 超大文件

索引只经 `walkWorkspaceFiles()` 与 `readWorkspaceTextFile()`，不执行 shell。这两条帮助函数来自 `src/context/workspace-indexer.js`，内部继续走 V2 path-safety。

### 验收锁定清单（当时完成标准）

- `kernel.context.snapshot()` 不再返回空快照占位，除非显式 disabled。
- 索引只用 `walkWorkspaceFiles()` 与 `readWorkspaceTextFile()`，不执行 shell。
- `.env`、密钥形态文件、`.git`、`.deepseek-code`、`node_modules`、构建产物、二进制、超大文件全部跳过。
- `context:snapshot` 事件只含路径、计数、预算、统计，不含 snippet 或正文。
- Query 快路径把 context 传给 `modelGateway.reply()`。
- 工具循环首次 `invoke()` 经 `prompt-assembler.js` 带 `context.summary`。
- Repair prompt 含有界 `context_summary`。
- 普通与 repair 审批恢复都保留同一 context 快照。
- `npm.cmd test`、`npm.cmd run check`、`git diff --check` 与 `.deepseek-code/v2` 污染检查通过。

## 关键决策 / 遗留约束

| 决策 | 选择 | 否决 | 原因 |
|------|------|------|------|
| 注入方式 | 快照数据注入 runtime | runtime 直接读盘 | 分层、可 mock |
| 排序 | 确定性规则 | 每次随机/启发式漂移 | 可重复、可测 |
| 预算 | token budget 硬约束 | 尽量塞 | 保护上下文窗口 |
| 事件隐私 | 只发路径与统计 | 发正文 | 时间线可持久化 |
| 禁用开关 | `context: { disabled: true }` | 隐式空实现 | 调用方可显式关闭 |
| 与 V0 关系 | 新模块并行 | 改写 `src/context.js` | legacy 不动 |

遗留约束：

- 不改 V0/V1 的 `src/context.js` 与 `src/kernel/context-engine.js`。
- 批准恢复必须继续带同一 context，避免恢复后 prompt 漂移。
- V2-10 在本引擎上叠加 manifest 缓存与 lazy hydration。
- 语义索引/多语言在后续 V3 再扩。
- 不加依赖。
- 测试用临时 root，不污染仓库 `.deepseek-code/`。
- Windows 命令统一 `npm.cmd`。

## 验证

| 测试 | 锁定行为 |
|------|----------|
| `tests/unit/context/context-unit.test.js` | 确定性 id/hash、token 估计、snippet 裁剪 |
| `tests/unit/context/token-budget.test.js` | 预算内选取 |
| `tests/unit/context/workspace-indexer.test.js` | 安全遍历与读取、跳过规则 |
| `tests/unit/context/context-selector.test.js` | 稳定装配顺序 |
| `tests/unit/context/context-snapshot.test.js` | 快照形状与 summary |
| `tests/unit/context/context-engine.test.js` | pin/unpin/warm/invalidate/scan |
| `tests/integration/v2-context-kernel.test.js` | 内核 context 门面不再返回空占位 |
| `tests/integration/v2-runtime-context.test.js` | runtime/审批/receive 保留 context |

当时全量 `npm.cmd test`、`npm.cmd run check`、`git diff --check` 通过。测试数量应高于 V2-8 基线（371），因为新增 context 测试。

现对应入口：

- `src/context/index.js`
- `src/context/context-snapshot.js`
- `src/context/workspace-indexer.js`
- `src/context/context-selector.js`
