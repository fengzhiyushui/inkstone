# V2-4 Runtime Loop

- 类型：实施计划
- 日期：2026-05-30
- 状态：已完成
- 关联：[CHANGELOG](../../CHANGELOG.md)、[V2-3 Edit Service](2026-05-30-v2-3-edit-service.md)

## 目标

把 `kernel.agent.send()` 从单次模型回复升级成真正的多轮 DeepSeek 工具循环：能计划、执行工具、把结果回灌模型、在审批处停下、验证编辑并产出最终回复。

## 结果

`src/core` 下新增执行与验证小模块，经依赖注入挂进 `src/core/runtime/agent-runtime.js`。Runtime 只做协调。工具仍只经 `ToolExecutor` 执行，编辑写仍经 `EditService`，DeepSeek 请求格式仍留在 `src/deepseek`。

### 文件结构

```text
src/core/execution/tool-call-adapter.js
src/core/execution/tool-result-router.js
src/core/execution/executor-loop.js
src/core/verification/verifier.js
src/core/verification/repair-decision.js
tests/unit/core/execution/tool-call-adapter.test.js
tests/unit/core/execution/tool-result-router.test.js
tests/unit/core/execution/executor-loop.test.js
tests/unit/core/verification/verifier.test.js
tests/integration/v2-runtime-loop.test.js
```

修改：`src/core/runtime/agent-runtime.js`、`src/index.js`、`package.json`。

### 模块契约

| 模块 | 行为 |
|------|------|
| `tool-call-adapter.js` | `adaptDeepSeekToolCall` / `adaptDeepSeekToolCalls`。把 DeepSeek 规范化 tool call 转成 `createToolCall()` 输入。缺 name 抛 `tool call name is required`；坏 arguments 抛 `invalid tool arguments`。 |
| `tool-result-router.js` | `toolResultsToMessages`。`ToolResult` → 紧凑 `role:"tool"` 消息，不泄漏过大 metadata。 |
| `executor-loop.js` | `runExecutorLoop`。协调 invoke、工具执行、审批停止、最大轮次与最终 content。 |
| `verifier.js` | 识别编辑活动，默认 detect-only 跑 `test`。 |
| `repair-decision.js` | 判定验证/工具失败是停止还是请求修复。 |

`runExecutorLoop` 关键参数：`message`、`classification`、`turnId`、`modelGateway`、`toolSchemas`、`executeTool`、`createPolicyContext`、`eventBus`、`signal`、`maxIterations`（默认 5）、`context`、`options`。缺 `modelGateway.invoke` / `executeTool` / `createPolicyContext` 时直接抛错。

### 行为锁定

| 场景 | 行为 |
|------|------|
| Query 任务 | 继续 `modelGateway.reply()` 快路径，不进工具循环 |
| 非 query | `modelGateway.invoke()` + DeepSeek tool schemas |
| 模型 tool call | `adaptDeepSeekToolCalls` → `ToolCall`，经注入的 `executeTool` 执行 |
| 工具结果 | `role:"tool"` 回灌下一次模型调用 |
| `approval_required` | 本轮置 `awaiting_approval`，发布状态，释放 runtime 锁，返回 `{ status: "awaiting_approval" }` |
| 最大迭代 | 默认 5；超限明确 `agent:error` |
| 畸形 tool 参数 | 明确失败，不执行工具 |
| 编辑成功 | 触发 `verification:result` |
| 验证失败 | 明确终态失败；完整 repair 留给 V2-8 |
| reasoning | `reasoning_content` 不发布到 session 事件 |

模型调用时首轮 `purpose` 为 `plan`，后续为 `act`；`toolChoice: "auto"`。`read` 工具回环与 `edit` 真实改文件都在集成测试里验证。

### 依赖注入边界

`src/core/runtime` 不 import `src/tools`。由 `src/index.js` 注入：

- `toolSchemas`
- `executeTool`
- `createPolicyContext`

这样 runtime 可测、可 mock，也保证工具执行仍汇聚到 ToolExecutor。

### 与验证/repair 的边界

V2-4 的 verifier 是轻量门：编辑类工具成功后跑 detect-only `test`，确认测试命令存在即可。`repair-decision` 只给出「停」或「需要修复」的分类元数据。真正有界的 DeepSeek repair 循环在 V2-8。

### 验收锁定清单（当时完成标准）

- query 任务仍走 `modelGateway.reply()` 快路径。
- 非 query 任务走 `modelGateway.invoke()` 与 DeepSeek tool schemas。
- 模型返回的 tool call 转成 V2 `ToolCall` 记录。
- 工具调用只经 `ToolExecutor`。
- 工具结果以 `role:"tool"` 回灌。
- `read` 工具回环与 mock 模型可集成。
- `edit` 工具回环可经 V2 `EditService` 真实改文件。
- supervised 编辑请求停在 `approval_required`，不写文件。
- 畸形 tool 参数明确失败，不执行工具。
- runtime 强制最大迭代上限。
- 编辑成功触发 `verification:result`。
- 验证失败返回明确终态失败。
- `reasoning_content` 不进 session 事件。
- `npm.cmd test`、`npm.cmd run check`、`git diff --check` 通过。

## 关键决策 / 遗留约束

| 决策 | 选择 | 否决 | 原因 |
|------|------|------|------|
| 协作方式 | 依赖注入 | runtime 直接 import tools | 保持分层与可测性 |
| 查询路径 | 留快路径 | 一律进工具循环 | 普通聊天不被工具流程拖垮 |
| 验证强度 | 轻量 detect-only | 默认狂跑测试套件 | 避免意外执行任意命令 |
| 审批处理 | 停轮返回 | 本阶段自动恢复 | 完整 resume 在 V2-7 |
| wire format | 网关边界适配 | 改工具实现 | 工具与厂商格式解耦 |
| 迭代上限 | 默认 5 | 无界循环 | 成本与失控风险可控 |

遗留约束：

- 不持久化可恢复审批；V2-7/V2-18 负责。
- 不自动修测试失败；V2-8 负责 repair 循环。
- 不迁移 CLI/TUI/GUI。
- 不替换 legacy V0 CLI。
- 不加依赖、不加外部服务。
- 不暴露 DeepSeek `reasoning_content`。
- Windows 命令统一 `npm.cmd`。

## 验证

| 测试 | 锁定行为 |
|------|----------|
| `tests/unit/core/execution/tool-call-adapter.test.js` | 规范化与拒绝畸形载荷 |
| `tests/unit/core/execution/tool-result-router.test.js` | `role:"tool"` 紧凑回灌 |
| `tests/unit/core/execution/executor-loop.test.js` | 多轮 invoke、审批停、迭代上限 |
| `tests/unit/core/verification/verifier.test.js` | 编辑检测与 verification 结果 |
| `tests/integration/v2-runtime-loop.test.js` | mock 模型下 `read` 回环；真实 EditService 下 `edit` 改文件；supervised 审批停且不写 |

当时全量 `npm.cmd test`、`npm.cmd run check`、`git diff --check` 通过。

现对应入口：

- `src/core/execution/executor-loop.js`
- `src/core/runtime/agent-runtime.js`
- repair 扩展 `src/core/verification/repair-loop.js`
- context 注入见 V2-9
