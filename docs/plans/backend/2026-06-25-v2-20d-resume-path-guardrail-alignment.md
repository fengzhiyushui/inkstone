# V2-20d resume 路径护栏对齐 Implementation Plan

- 类型：实施计划
- 日期：2026-06-25
- 状态：已完成
- 关联：[V2-20a](2026-06-24-v2-20a-runtime-cost-timeout-guardrails.md)、[V2-20b](2026-06-25-v2-20b-guardrail-injection-graceful-stop.md)、[V2-20c](2026-06-25-v2-20c-malformed-toolcall-retry.md)、[V2-20e](2026-06-25-v2-20e-repair-path-model-timeout.md)、[CHANGELOG](../../CHANGELOG.md)

## 目标

让审批后续（`approve()` → `resumeExecutorLoop`）与正常工具循环享有同一套护栏：成本预算、模型调用超时、畸形 tool-call 重试。此前 `runToolLoopPath` 全部透传，但 `approve()` 的 resume 调用一个都没传，导致审批恢复后的那段执行裸跑。

## 结果

`approve()` 在 `resumeExecutorLoop` 前新建成本预算（审批暂停是天然边界，故该 resume 段新建而非继承暂停前已花费的 token），并把三参数传入：

```text
const resumeOptions = record.resume_state.options || {};
const budget = createCostBudget({
  maxTokens: resumeOptions.maxTurnTokens ?? maxTurnTokens,
  maxModelCalls: resumeOptions.maxModelCalls ?? maxModelCalls
});
const loop = await resumeExecutorLoop({
  resumeState: record.resume_state,
  modelGateway, executeTool, createPolicyContext, eventBus,
  signal: currentAbortController.signal,
  budget,
  modelTimeoutMs: resumeOptions.modelTimeoutMs ?? modelTimeoutMs,
  maxToolCallRepairs: resumeOptions.maxToolCallRepairs ?? maxToolCallRepairs
});
```

补 stopped 终态处理（镜像 send，插在 `awaiting_approval` 分支之后、repair-phase approval 之前）：

```text
if (loop.status === "stopped") {
  const stoppedTurn = setTurnStatus(record.turn, "completed");
  publish(eventBus, "agent:final", { turn_id: record.turn_id, content: loop.content, status: "stopped" });
  lifecycle = transitionLifecycle(lifecycle, { to: "idle", reason: "cost budget stop", channel: null });
  currentTurnId = null; currentAbortController = null;
  return { status: "stopped", state: "idle", content: loop.content, turn: stoppedTurn, budget: loop.reason || null };
}
```

## 关键决策 / 遗留约束

- 预算为 resume 段新建，不继承暂停前已花费的 token。审批暂停是天然边界，够用。若日后要严格累计，可在 pause 时把 `budget.snapshot()` 写进 `resume_state` 并在此恢复，单列后续。
- 默认关闭（`maxTurnTokens` / `maxModelCalls` / `modelTimeoutMs` 为 `null`、`maxToolCallRepairs` 默认 0）时 resume 行为不变。
- 不改 `resumeExecutorLoop` 本身（已支持三参与 `stopped` 返回）；只改 `approve()` 调用与终态处理。
- `resume_state.options` 可覆盖工厂级配置，与 `createPolicyContext` 的展开语义一致。
- 至此正常路径与审批 resume 路径护栏一致。repair-context 子路径（`runRepairLoop`）的预算透传仍未覆盖，由 v1.6.1 补齐；超时透传由 V2-20e 补齐。

## 验证

`tests/unit/core/runtime/agent-runtime-resume-guardrails.test.js` 断言 `maxModelCalls: 1` 时 approve 返回 `stopped`（而非一路 invoke 到 `maximum tool iterations exceeded` 抛错）。测试构造：模型每次要求再调工具驱动多轮，send 阶段工具需审批，approve 后成功；fake gateway 记 invoke 次数，fake executeTool 第一次返回 `approval_required` 带 `metadata.approval.id`，之后 success。`tests/unit/core/runtime/*.test.js`、`tests/unit/core/execution/*.test.js` 无回归，既有审批 resume 测试仍绿。`npm test` + `npm run check`。当前实现在 `src/core/runtime/agent-runtime.js` 的 `approve()`。
