# V2-20e repair 路径模型超时透传 Implementation Plan

- 类型：实施计划
- 日期：2026-06-25
- 状态：已完成
- 关联：[V2-20a](2026-06-24-v2-20a-runtime-cost-timeout-guardrails.md)、[V2-20d](2026-06-25-v2-20d-resume-path-guardrail-alignment.md)、[V2-20f](2026-06-25-v2-20f-guardrail-defaults-config.md)、[CHANGELOG](../../CHANGELOG.md)

## 目标

让验证-修复路径（`runRepairLoop` → `runRepairExecutor`）的模型调用也受 `modelTimeoutMs` 约束，堵住「repair 模型调用可永久挂起」这一可靠性缺口。

## 结果

`runRepairExecutor({ ..., modelTimeoutMs = null })` 的 `modelGateway.invoke` 选项改为：

```text
const modelResult = await modelGateway.invoke(messages, {
  ...options,
  purpose: "repair",
  tools: toolSchemas,
  toolChoice: "auto",
  timeoutMs: modelTimeoutMs ?? options.timeoutMs,
  signal
});
```

`runRepairLoop({ ..., modelTimeoutMs = null })` 解构加参（放在 `options` 后），`runRepairExecutorImpl({...})` 调用里透传 `modelTimeoutMs`（在 `signal` 旁）。

`agent-runtime` 两处 `runRepairLoop` 调用点注入：

| 调用点 | 注入值 |
|--------|--------|
| `verifyAndMaybeRepair` | `options.modelTimeoutMs ?? modelTimeoutMs` |
| approve 的 repair_context | `record.resume_state.options?.modelTimeoutMs ?? modelTimeoutMs` |

至此 `modelTimeoutMs` 覆盖全部三条模型调用路径：正常工具循环（run/resume）、审批 resume、验证-修复。

## 关键决策 / 遗留约束

- `modelTimeoutMs` 默认 `null`，不带超时时行为不变。
- repair 路径的成本预算与 tool-call 重试显式延后（YAGNI）。repair 已被 `maxRepairAttempts`（默认 2）限轮，预算缺口至多 2 次调用；把「预算 + 优雅 stopped」塞进单发执行器需不成比例的控制流改动。tool-call 重试同理（repair 执行器为单发结构）。
- 只透传一个 invoke 选项，不改 repair 的控制流与终态。
- 优先 `modelTimeoutMs` 形参，回退 `options.timeoutMs`，与 executor-loop 的合并语义一致。
- 护栏 plumbing epic 到此完整。下一步 V2-20f 在 CLI/kernel-options 设保守默认值让护栏真正生效。

## 验证

`tests/unit/core/verification/repair-loop-timeout.test.js` 两用例：执行器收到 `timeoutMs === 1234`（fake gateway 记录 options，断言 `result.status === "complete"`）；循环透传 `modelTimeoutMs === 777`（fake executor 记录 args，fake verifier 返回 passed）。相关目录 `tests/unit/core/verification/`、`tests/unit/core/execution/`、`tests/unit/core/runtime/` 无回归。`npm test` + `npm run check`。当前实现在 `src/core/execution/repair-executor.js`、`src/core/verification/repair-loop.js`、`src/core/runtime/agent-runtime.js`。
