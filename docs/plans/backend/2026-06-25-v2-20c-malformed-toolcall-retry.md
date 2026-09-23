# V2-20c 畸形 tool-call 有界重试 Implementation Plan

- 类型：实施计划
- 日期：2026-06-25
- 状态：已完成
- 关联：[V2-20a](2026-06-24-v2-20a-runtime-cost-timeout-guardrails.md)、[V2-20b](2026-06-25-v2-20b-guardrail-injection-graceful-stop.md)、[V2-20d](2026-06-25-v2-20d-resume-path-guardrail-alignment.md)、[CHANGELOG](../../CHANGELOG.md)

## 目标

模型吐出畸形 tool-call（参数非合法 JSON，`adaptDeepSeekToolCalls` 抛 `invalid tool arguments`）时不再让整个 turn 直接失败，而是有界重试：回灌纠正消息并重新请求模型，最多 `maxToolCallRepairs` 次；超出才报错。补完坑「JSON / tool calling 失败重试」。

## 结果

`runExecutorLoop` / `resumeExecutorLoop` 新增 `maxToolCallRepairs = 0`（放在 `modelTimeoutMs` 旁）。两段循环各自维护 `let toolCallRepairs = 0`。把 `adaptDeepSeekToolCalls(rawToolCalls, { requestedByStepId })` 包进 try/catch：

```text
catch (error) {
  if (toolCallRepairs >= maxToolCallRepairs) throw error;
  toolCallRepairs += 1;
  eventBus?.publish?.("model:tool_call_repair", {
    turn_id, iteration, attempt: toolCallRepairs, reason: error.message
  });
  messages = [
    ...messages,
    assistantToolCallMessage(modelResult, rawToolCalls),
    { role: "user", content:
      `Your previous tool call had invalid arguments (${error.message}). ` +
      `Re-issue the tool call with valid JSON arguments.` }
  ];
  continue;
}
```

`createAgentRuntime` 接受 `maxToolCallRepairs = 0`，`runToolLoopPath` 的 `runExecutorLoop` 调用透传 `options.maxToolCallRepairs ?? maxToolCallRepairs`。`createKernel` 由 `options.limits?.maxToolCallRepairs ?? 0` 注入。

kernel `limits` 五参至此全部接线：`maxTurnTokens`、`maxModelCalls`、`toolTimeoutMs`、`modelTimeoutMs`、`maxToolCallRepairs`，默认关闭 opt-in。

## 关键决策 / 遗留约束

- 默认 `maxToolCallRepairs = 0`，畸形即抛，与改前一致。既有「executor loop reports malformed tool arguments」用例仍绿。
- 重试计数在 run 与 resume 两段各自独立，不跨段累计。审批暂停续跑后额度重新起算。
- 纠正消息把 assistant 的畸形调用原文与 user 纠正提示都写进 messages，让模型看到自己刚才错在哪。
- 只修「参数 JSON 畸形」这一类（`arguments_parse_error` / `invalid tool arguments`）。工具名不存在等其它错误不走此路径。
- 事件 `model:tool_call_repair` 不在 `event-types.js` 注册表（session 事件另册），由 eventBus 直发，便于调试观测。
- 后续 V2-20d 把三参数对齐到 approve resume；V2-20e 把 `modelTimeoutMs` 透传到 repair 路径；V2-20f 在配置层设默认值让护栏真正生效。

## 验证

`tests/unit/core/execution/executor-loop-toolrepair.test.js` 三用例：畸形后修复完成（`gw.calls() === 2`，status complete）、额度耗尽抛 `/invalid tool arguments/`（`maxToolCallRepairs: 2`）、默认立即抛（不传参数）。`tests/unit/core/runtime/agent-runtime-toolrepair.test.js` 覆盖 runtime 透传后 `send` 可 complete。`tests/unit/core/execution/*.test.js` 无回归。当前实现在 `src/core/execution/executor-loop.js`（run 与 resume 两段 try/catch）、`src/core/runtime/agent-runtime.js`、`src/index.js`。

## 任务覆盖（as-built 映射）

Task 1 executor-loop 有界 tool-call 重试（run + resume 两段）→ Task 2 透传 maxToolCallRepairs（agent-runtime + kernel）。fake gateway 第一次返回畸形 tool-call（`arguments: null, arguments_parse_error`），第二次返回干净完成。kernel `limits` 五参至此全部接线，默认关闭 opt-in。
