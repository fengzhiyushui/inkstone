# V2-20a 运行时成本与超时护栏 Implementation Plan

- 类型：实施计划
- 日期：2026-06-24
- 状态：已完成
- 关联：[V2-20b](2026-06-25-v2-20b-guardrail-injection-graceful-stop.md)、[V2-20c](2026-06-25-v2-20c-malformed-toolcall-retry.md)、[V2-20f](2026-06-25-v2-20f-guardrail-defaults-config.md)、[CHANGELOG](../../CHANGELOG.md)

## 目标

给一个 turn 加上最大成本闸（token / 模型调用数上限）与模型调用、工具调用超时，避免单 turn 无界烧 token，也避免因模型或工具挂起而永久阻塞。

## 结果

新增与运行时解耦的纯模块 `src/core/runtime/cost-budget.js`。接口契约：

```text
createCostBudget({ maxTokens = null, maxModelCalls = null, initialTokens = 0, initialModelCalls = 0 })
  -> { recordModelResult(modelResult), check(), exceeded(), snapshot() }

recordModelResult(modelResult):
  从 modelResult.usage 累加 token，model_calls +1
  usage 形如 { prompt_tokens, completion_tokens, total_tokens }
  优先 total_tokens，否则 prompt_tokens + completion_tokens
  无 usage 仍计一次模型调用

check():
  达上限则抛 Error
  error.code === "BUDGET_EXCEEDED"
  error.details = { reason, ... }
  reason 为 "max_tokens" 或 "max_model_calls"

exceeded(): 返回 null 或 { reason, ... }（不抛）
snapshot(): 返回 { tokens, model_calls, max_tokens, max_model_calls }
```

模型超时落在 `src/deepseek/model-gateway.js`。`invoke` / `stream` / `fim` 三条路径都用 `withTimeout(callerSignal, timeoutMs)` 把调用方 signal 与超时 AbortController 合并：

```text
withTimeout(callerSignal, timeoutMs) -> { signal, cleanup, didTimeout }
modelTimeoutError(timeoutMs) -> Error, error.code === "MODEL_TIMEOUT"
```

stream 路径在 SSE body 读取期间保持超时武装（fetch 在 headers 即 resolve，body 之后才消费，abort 必须同时约束请求与 body 解析）。fim 路径同语义，不传 `timeoutMs` 则不设超时。

工具超时落在 `src/tools/executor.js`：

```text
createToolExecutor({ registry, permissionEngine, eventBus, defaultToolTimeoutMs })
runWithTimeout(promiseFactory, timeoutMs)
  超时 -> 标准 status:"error" 工具结果
  metadata: error.code === "TOOL_TIMEOUT" ? { timeout: true } : {}
```

接线：`executor-loop` 每次模型调用前 `budget.check()`、调用后 `recordModelResult()`；`createKernel` 由 `options.limits` 注入四个参数到 `createAgentRuntime` 与 `createToolExecutor`。`createCostBudget` 后续被 C-Durable 用 `initialTokens` / `initialModelCalls` 做恢复续扣。

## 关键决策 / 遗留约束

- 所有新参数默认 `null`（护栏关闭），现有调用方与测试行为完全不变。每个 Task 都带「默认关 → 不变」回归。
- 错误码约定固定写在 `error.code`：`BUDGET_EXCEEDED`、`MODEL_TIMEOUT`、`TOOL_TIMEOUT`。下游可据此分支，不靠 message 字符串匹配。
- cost-budget 与运行时解耦，纯模块可单测；记账从 `usage` 取数，缺失 usage 仍计次，保证 `maxModelCalls` 不被绕过。
- 工具超时结果走标准工具错误形状（`status: "error"` + `metadata.timeout`），不抛到 turn 外，避免一个挂起工具毁掉整轮。
- 模型超时的 AbortController 与调用方 signal 合并，任一 abort 都生效；cleanup 在 finally 调用，避免 timer 泄漏。
- Tech stack：Node.js ESM、`node:test` + `node:assert/strict`、现有 `AbortController` / `setTimeout`，无新增第三方依赖。新增 `src/*.js` 必须加入 `package.json` 的 `check` 脚本。
- 后续切片：V2-20b 预算超限改优雅停止 + `modelTimeoutMs` 注入每次调用；V2-20c 畸形 tool-call 有界重试；V2-20d resume 路径对齐；V2-20e repair 路径超时；V2-20f 默认值与用户配置点亮超时。

## 验证

`tests/unit/core/runtime/cost-budget.test.js` 覆盖：null 上限永不超、`max_tokens` 累计后触发、`prompt+completion` 回退、`max_model_calls` N 次后触发、无 usage 仍计次。executor-loop 预算检查测试、model-gateway 超时测试（invoke/stream/fim 三路径）、tools/executor 超时落 `status:"error"` 测试。`npm test` 全绿 + `npm run check` 退出码 0。当时测试 529 全绿。当前入口 `src/core/runtime/cost-budget.js`、`src/core/execution/executor-loop.js`、`src/deepseek/model-gateway.js`、`src/tools/executor.js`、`src/index.js`。提交：`c7fd9e1`（cost-budget）、`0603bd0`（model timeout）、`9bffcc5`（tool timeout）、`b0e6354`（executor-loop budget）、`49f338b`（runtime + kernel limits）。
