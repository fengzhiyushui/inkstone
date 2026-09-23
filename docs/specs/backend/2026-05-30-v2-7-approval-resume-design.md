# V2-7 审批续跑设计

- 类型：后端 spec
- 日期：2026-05-30
- 状态：已实现
- 关联：[v2 Clean Runtime](../architecture/2026-05-30-deepseek-code-v2-clean-runtime-design.md) · [V2-8 修复环](2026-05-31-v2-8-verifier-repair-loop-design.md)

---

## 问题与目标

审批在 V2 里曾是终态暂停：`agent.send()` 返回 `awaiting_approval` 后，`approve()` 只发 `approval:resolved`，不继续原工具环。V2-7 让同一 turn 在用户批准或拒绝后续跑或取消，审批卡片在 CLI / TUI / GUI 上真正可用。本轮只做进程内续跑，不做跨进程持久化恢复。

## 决策

| 决策点 | 选择 | 否决项 | 理由 |
|---|---|---|---|
| 暂停态存放 | 进程内 `PausedTurnStore` | 先序列化到会话日志 | 避免把模型消息与工具态写进日志 |
| 续跑安全 | 批准写入 `approvalCache`，再走原 `executeTool` | 续跑旁路权限 | 单一 ToolExecutor 路径不破 |
| 并发策略 | 同时只允许一个暂停 turn | 多审批队列 | 控制流清晰，重复 `send` 直接拒绝 |
| 决策词 | allow：`approve`/`allow`；deny：`deny`/`reject` | 单一布尔 | 与 UI 文案对齐 |

## 设计

### 流程

```
模型请求工具 → 权限 ask → approval:requested
  → runtime 存 resume_state → 用户决策
  → approve：写 approvalCache → resumeExecutorLoop → 结果回灌 → 验证/终态
  → deny：agent:final(cancelled) → idle
```

### `paused-turn-store`

`src/core/approval/paused-turn-store.js`：

```js
createPausedTurnStore() -> { save, get, take, deleteForTurn, clear, size }
```

记录：`{ approval_id, turn_id, approval, turn, resume_state, created_at }`。`take()` 只成功一次，天然拒绝重复审批。拒绝重复 `approval_id`。

### Executor 环

`runExecutorLoop` 暂停时返回可续跑快照：

```js
{
  status: "awaiting_approval",
  approval,
  resume_state: {
    turn_id, message, classification, messages, model_result,
    raw_tool_calls, pending_tool_call, remaining_tool_calls,
    iteration, tool_results, tool_schemas, max_iterations, options
  }
}
```

`resumeExecutorLoop(resumeState, deps)` 先执行 `pending_tool_call`，再按序执行 `remaining_tool_calls`，继续模型调用至终态或 `maxIterations`。它必须调用 `executeTool()`，不得直接调工具实现。

### 审批缓存授予

续跑仍走权限重评估。`grantApprovalForToolCall` 用 `secureToolCall` 得到规范调用，算指纹后 `approvalCache.grant(fp, { decision: "allow" })`。`ToolRegistry.secureToolCall` 与 `ToolExecutor` 共用同一 category 推导。缓存只存 allow，TTL 默认 300000ms。

### Runtime / Kernel

- 暂停时 `send()` 落库后释放 `currentTurnId`；已有暂停记录时新 `send()` 抛 `AWAITING_APPROVAL`。
- `approve(approvalId, decision)` 为 async；未知 id 视为已消费或不存在；重复审批失败。
- deny 发 `agent:final`，状态 `cancelled`。
- `interrupt()` 清 abort 与暂停记录，不发残留 final。
- Kernel API 仍为 `kernel.agent.approve(approvalId, decision)`。GUI host 改为 async；CLI 进程内提示后调用；TUI 最小确认提示。

### 错误

| 情形 | 行为 |
|---|---|
| 未知 approval id | `APPROVAL_NOT_FOUND` |
| 重复审批 | 同未知（已被 `take`） |
| 执行中再批 | `BUSY` |
| 暂停中再 `send` | `AWAITING_APPROVAL` |
| 拒绝 | 确定性 cancelled，不抛 |
| 续跑中再次 ask | 新暂停记录，返回 `awaiting_approval` |

会话侧持久化 `approval:requested` / `approval:resolved` / `tool:result` / `agent:final`（见 `SESSION_EVENT_TYPES`）。

## 边界与不变量

1. 审批不绕过 schema 校验、权限、执行、脱敏、工具事件。
2. 一次只暂停一个 turn。
3. `take()` 保证不双写。
4. 中断与续跑竞态靠 generation/abort 与清空暂停库处理。
5. 本轮不做进程重启后续跑、不做多审批队列。

## 与现状的差异

持久化恢复后来由 [V2-18](2026-06-01-v2-18-durable-recovery-resume-hardening-design.md) 覆盖；暂停侧车路径见 `.deepseek-code/v2/sessions/<project>/paused/`。错误与生命周期常量以 `src/core/recovery/`、`src/core/runtime/lifecycle.js` 为准。

## 验收

监督编辑 `send` 返回 `awaiting_approval` 且未写文件；`approve` 续跑同一 turn 并经原工具写入；`deny` 文件不变；事件序列含 resolved / tool / final；重复审批拒绝；暂停中 `send` 拒绝；`interrupt` 清暂停；CLI 可进程内批一次并打印终态。回归入口 `npm test`、`npm run check`。
