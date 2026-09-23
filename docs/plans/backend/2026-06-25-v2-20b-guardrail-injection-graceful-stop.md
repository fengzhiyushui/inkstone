# V2-20b 护栏注入与优雅停止 Implementation Plan

- 类型：实施计划
- 日期：2026-06-25
- 状态：已完成
- 关联：[V2-20a](2026-06-24-v2-20a-runtime-cost-timeout-guardrails.md)、[V2-20d](2026-06-25-v2-20d-resume-path-guardrail-alignment.md)、[CHANGELOG](../../CHANGELOG.md)

## 目标

把 `modelTimeoutMs` 从 kernel 注入每次模型调用，并把成本超限从抛 `BUDGET_EXCEEDED` 改为 turn 干净停止（`status: "stopped"`）。

## 结果

**优雅停止**：executor-loop 由 `budget.check()`（抛）改为 `budget.exceeded()`（返回）。`runExecutorLoop` 与 `resumeExecutorLoop` 在各自循环开头判断：

```text
const over = budget?.exceeded();
if (over) {
  return {
    status: "stopped",
    reason: over,
    content: `Stopped: cost budget exceeded (${over.reason}).`,
    iterations: iteration,
    toolResults
  };
}
```

`agent-runtime` 把 `stopped` 当作 turn 终态：turn 标记 completed，发 `agent:final` status=`stopped`，lifecycle 迁回 idle（reason 为 cost budget stop），清 `currentTurnId` / `currentAbortController`，返回：

```text
{ status: "stopped", state: "idle", content, turn, budget: loop.reason || null }
```

`stopped` 终态不跑 verify/repair，避免把预算停止误判为需要修复的失败。

**超时注入**：`modelTimeoutMs` 经 runtime 透传到 executor-loop 每次 `invoke({ timeoutMs })` 与 `gateway.reply` 内部 invoke。kernel 由 `options.limits.modelTimeoutMs` 注入。`toolTimeoutMs` 注入工具执行路径（`createToolExecutor({ defaultToolTimeoutMs })`）。默认 `null` 时行为不变。

提交记录：`aa90498`（优雅停止·loop）、`927b5b9`（优雅停止·runtime）、`055f426`（modelTimeoutMs 注入）。当时测试 531 全绿、`npm run check` 通过。

## 关键决策 / 遗留约束

- 预算超限是正常终态，不是异常。CLI 不再被 `BUDGET_EXCEEDED` 冒泡打断，用户体验从「报错中断」改为「干净收尾」。
- `budget` 为 `null` 时仍受 `maxIterations` 约束，与改前一致。既有「no budget keeps maxIterations behavior」用例保持不变。
- 优雅停止的说明文案固定为 `Stopped: cost budget exceeded (<reason>).`，reason 含 `max_tokens` 或 `max_model_calls`，便于 CLI/TUI 直接展示。
- `loop.reason` 携带完整 exceeded 对象（含 tokens / max_tokens 等计数），放进返回值的 `budget` 字段供上层展示或记账。
- run 与 resume 两段都改，保证审批续跑后的工具循环同样优雅停止。
- 后续 V2-20d 把同一套 stopped 终态补到 approve() 的 resume 路径（此前 approve 尚未传 budget）。

## 验证

`tests/unit/core/execution/executor-loop-budget.test.js` 断言 `status: "stopped"`、`reason.reason === "max_tokens"`、`budget.snapshot().tokens >= 100`。`tests/unit/core/runtime/agent-runtime-budget.test.js` 断言 edit turn 干净结束返回 `stopped` 而非抛错。`tests/unit/core/execution/*.test.js` 无回归。当前实现在 `src/core/execution/executor-loop.js`（run 与 resume 两段循环开头）、`src/core/runtime/agent-runtime.js`（send 的 stopped 终态分支）、`src/index.js`（limits 注入）。

## 任务覆盖（as-built 映射）

Task 1 executor-loop 成本超限优雅停止（改既有 budget 测试为期望 stopped）→ Task 2 agent-runtime 把 stopped 作为 turn 终态（改既有 runtime budget 测试）→ Task 3 modelTimeoutMs 注入每次模型调用。三个提交分别对应 loop、runtime、timeout 注入。默认 `null` 时行为不变由两处既有测试改造后的对照断言保证。
