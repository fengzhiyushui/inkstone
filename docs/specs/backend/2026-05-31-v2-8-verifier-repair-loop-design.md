# V2-8 验证与修复环设计

- 类型：后端 spec
- 日期：2026-05-31
- 状态：已实现
- 关联：[V2-7 审批续跑](2026-05-30-v2-7-approval-resume-design.md) · [V2-9 上下文](2026-05-31-v2-9-context-engine-design.md)

---

## 问题与目标

验证失败原先直接抛 `verification failed` 结束 turn，agent 无法用 DeepSeek repair 通道改自己的编辑。V2-8 把验证从终态门变成有界修复环，同时保持全部安全不变量。修复沿用模型引导的普通工具环，不授予额外权限。

## 决策

| 决策点 | 选择 | 否决项 | 理由 |
|---|---|---|---|
| 验证策略 | `verifyMode`: `auto`/`detect`/`run`/`off` | 固定 detect | 要能跑真测试，也要能保守跳过 |
| 修复通道 | `purpose: "repair"` + `models.think` | 用 reply 通道修 | 参数与角色分离 |
| 执行路径 | 修复工具仍走 `executeTool` | 专用修复执行器旁路 | 权限/脱敏/审计一致 |
| 退出 | `maxRepairAttempts`（默认 2） | 无限重试 | 成本与稳定性 |
| exit code | metadata 非 0 即 failed | 只看 `status: "success"` | 修掉 test 工具成功但退出码非 0 的歧义 |

## 设计

### 流程

```
工具环 → runVerifier(policy)
  → passed/skipped → complete
  → approval_required → awaiting_approval
  → failed/error → runRepairLoop
       → repair 模型调用 → adapt 工具调用 → executeTool → 再验证
       → 通过 complete / 再失败重复 / 耗尽 failed
```

返回状态词与 runtime 一致：`complete` / `failed` / `awaiting_approval`（外加 content、toolResults、verification、repair、approval、resume_state）。

### 验证策略

`src/core/verification/verification-policy.js`：

- `detect`：始终 `test` + `{ detect: true }`。
- `run`：真跑测试（可显式 `testArgv`，必须是 string[]）。
- `auto`（默认）：gated/auto/full-auto 跑测试，supervised 只 detect。
- `off`：跳过。

无编辑类成功结果时直接 `skipped`。`runVerifier` 映射：`success` + 无/0 退出码 → `passed`；`success` + 非 0 → `failed`；`approval_required` 保留；`denied` → `failed`；`error` → `error`。发布 `verification:result`。

### 修复提示与执行

`repair-prompt.js` 构建紧凑提示：说明验证失败原因、要求最小纠正、优先 `read`/`grep`/`glob`/`edit`、无工具调用即无法修复。不含 `reasoning_content`、密钥、无界工具输出。

`repair-executor.js` 复用执行助手：`adaptDeepSeekToolCalls` → `executeTool` → `toolResultsToMessages`。需要审批时返回与 V2-7 同形的 `resume_state`，批准后仍走 `resumeExecutorLoop` 再 `verifyAndMaybeRepair`。

### 事件

```
repair:started → repair:attempt → model:request/response
  → tool:call / permission:decision / tool:result
  → verification:result → repair:result
  耗尽时 repair:exhausted
```

均在 `SESSION_EVENT_TYPES`。`repair:result` 只含 attempt/status/verification_status/计数。

### Runtime

抽出 `verifyAndMaybeRepair(...)`，供 `send` 与 `approve` 共用。生命周期：`execute → verify → repair → verify → complete`，或进入 `awaiting_approval` / `failed`。query 快路径不动。

Kernel 选项：`verifyMode`、`testArgv`、`maxRepairAttempts`（默认 2）。

## 边界与不变量

1. 修复工具全部经 ToolExecutor。
2. 不暴露 `reasoning_content`。
3. 不自动做破坏性动作。
4. 耗尽后进明确终态，清 `currentTurnId` 与 abort。
5. 进程重启持久化修复、长期修复记忆、部分 diff 自动回滚不在本轮。

## 与现状的差异

实现文件集中在 `src/core/verification/` 与 `src/core/execution/repair-executor.js`。`decideRepair` 见 `repair-decision.js`：passed/skipped 停止，failed/error 可修，approval_required 等用户。工具调用修复次数另受 `limits.maxToolCallRepairs` 约束。

## 验收

验证失败可触发修复；修复成功可 complete；修复工具发正常工具事件；修复可停在审批；`maxRepairAttempts` 生效；非 0 退出码算失败；query 不进修复环；事件进时间线；提示与事件无 `reasoning_content`。回归入口 `npm test`、`npm run check`。
