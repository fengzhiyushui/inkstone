# V2-8 Verifier & Repair Loop

- 类型：实施计划
- 日期：2026-05-31
- 状态：已完成
- 关联：[CHANGELOG](../../CHANGELOG.md)、[设计](../../specs/backend/2026-05-31-v2-8-verifier-repair-loop-design.md)

## 目标

把 V2 验证从终态门改成有界的 DeepSeek repair 循环：验证编辑、向 repair 通道要纠正性 tool call、经 ToolExecutor 执行修复，然后再次验证。

## 结果

验证策略、repair prompt 构建、repair 执行器与 repair loop 进入现有 V2 运行时模块。runtime 集成时把重复验证块抽成 `verifyAndMaybeRepair()`，并保留审批恢复与单一 ToolExecutor 安全路径。

### 文件结构

创建：

| 路径 | 职责 |
|------|------|
| `src/core/verification/verification-policy.js` | 归一化 `verifyMode`、`testArgv`、autonomy、编辑结果 → verifier 参数 |
| `src/core/verification/repair-prompt.js` | 紧凑 repair 消息构建 |
| `src/core/execution/repair-executor.js` | 单轮 repair 模型/工具执行 |
| `src/core/verification/repair-loop.js` | 有界尝试、事件、重验、审批停、耗尽失败 |
| `tests/unit/core/verification/verification-policy.test.js` | 策略矩阵 |
| `tests/unit/core/verification/repair-prompt.test.js` | prompt 边界 |
| `tests/unit/core/verification/repair-loop.test.js` | 有界循环 |
| `tests/unit/core/execution/repair-executor.test.js` | 单轮执行 |
| `tests/integration/v2-repair-loop.test.js` | 内核级 repair |

修改：

| 路径 | 变更 |
|------|------|
| `src/core/verification/verifier.js` | 接受 verification policy；非零测试退出码记验证失败 |
| `src/core/runtime/agent-runtime.js` | `verifyAndMaybeRepair()`，调用 `runRepairLoop()`，传 `maxRepairAttempts` 与 policy |
| `src/index.js` | 透传 `verifyMode`、`testArgv`、`maxRepairAttempts` |
| `src/sessions/event-types.js` | 注册 `repair:started`、`repair:attempt`、`repair:result`、`repair:exhausted` |
| `package.json` | 新源文件进 `npm run check` |
| 既有 verifier / agent-runtime / event-types 测试 | 对齐新形状 |

### 验证策略契约

`createVerificationPolicy({ verifyMode, testArgv })`，`plan({ autonomy, hasEditResults })`：

| 输入 | 输出 |
|------|------|
| `verifyMode: "auto"` + supervised + 有编辑 | `{ shouldVerify: true, testParams: { detect: true }, mode: "detect" }` |
| `verifyMode: "auto"` + gated + 有编辑 | `{ shouldVerify: true, testParams: { detect: false }, mode: "run" }` |
| `verifyMode: "run"` + `testArgv: string[]` | 使用显式 argv 真跑 |
| `verifyMode: "off"` | `{ shouldVerify: false, reason: "verification disabled", mode: "off" }` |
| 无编辑结果 | `{ shouldVerify: false, reason: "no edit results", mode: "skip" }` |
| `testArgv` 非字符串数组 | 抛 `testArgv must be an array of strings` |
| 未知 mode | 拒绝 |

### Repair 契约

`runRepairLoop` 关键参数：`turnId`、`userMessage`、`classification`、`modelGateway`、`toolSchemas`、`executeTool`、`createPolicyContext`、`verificationPolicy`、`initialVerification`、`initialToolResults`、`maxRepairAttempts`（默认 2）、`context`、`permissionContext`、`resumeAfterApproval`。

行为锁定：

| 场景 | 行为 |
|------|------|
| 验证失败 | 至少一次 repair 尝试 |
| repair 模型调用 | `purpose: "repair"` |
| repair 工具 | 经注入 `executeTool()`，内核集成即 ToolExecutor |
| 修复后验证通过 | `status: "complete"` |
| repair 遇审批 | `awaiting_approval`，不写未授权改动 |
| 达到上限 | `repair:exhausted` |
| query 快路径 | 不进 repair |
| resume | `resumeAfterApproval` 续 attempts / verification / all_tool_results |

`repair-prompt.js` 构建消息时排除 `reasoning_content` 与过大原始输出，可带有限 `context_summary`。

`repair-executor.js` 走 `modelGateway.invoke()` + `adaptDeepSeekToolCalls()` + `executeTool()`，是单轮修复执行器，不做多轮自动诊断。

### 事件契约

| 事件 | 载荷边界 |
|------|----------|
| `repair:started` | `turn_id`、`max_attempts`、`verification_status` |
| `repair:attempt` | 尝试序号与摘要元数据 |
| `repair:result` | 单次结果状态 |
| `repair:exhausted` | 耗尽标记 |

全部 repair 事件不暴露 `reasoning_content`。

### 验收锁定清单（当时完成标准）

- 编辑后验证失败触发至少一次 repair 尝试。
- repair 模型调用使用 `purpose: "repair"`。
- repair 工具经注入 `executeTool()`，内核集成即 ToolExecutor。
- repair 可在验证通过后返回 `status: "complete"`。
- repair 可停在 `awaiting_approval`，不写未授权改动。
- 最大 repair 尝试数受控，耗尽发布 `repair:exhausted`。
- 非零测试退出码记为验证失败。
- query 快路径不进 repair。
- 时间线包含 repair 事件。
- `npm.cmd test`、`npm.cmd run check`、`git diff --check` 通过。
- 测试不在仓库根创建 `.deepseek-code/v2`。

## 关键决策 / 遗留约束

| 决策 | 选择 | 否决 | 原因 |
|------|------|------|------|
| 循环边界 | 有界尝试，默认 2 | 无限自修 | 成本可控、失败可解释 |
| 验证策略 | 显式 policy 对象 | 散落 if/else | detect/run/off 可测 |
| 修复执行 | 复用 executor 注入 | 另开写路径 | 安全路径唯一 |
| 测试替身 | 只换 `test` 工具 | 连 edit 一起 mock | 要证明生产写路径 |
| 非零退出码 | 记验证失败 | 只看是否有测试命令 | 真实信号才可信 |
| 暂停恢复 | 保留 attempts 状态 | 每次从零开始 | 不浪费已完成尝试 |

遗留约束：

- 不暴露 `reasoning_content` 到 prompt、事件、日志或 UI。
- repair 批准后仍不绕过 ToolExecutor。
- 不删 V0/V1，不加依赖。
- 集成测试自定义验证时只替换 `test` 工具，`edit` 保持真实延迟编辑工具。
- V2-18 后 repair 审批暂停可 durable 恢复，并保留 `repair_context.initial_tool_results`。
- 更复杂的验证策略与多轮诊断仍待扩展。
- Windows 命令统一 `npm.cmd`。

## 验证

| 测试 | 锁定行为 |
|------|----------|
| `tests/unit/core/verification/verification-policy.test.js` | auto/run/off、argv 校验、无编辑跳过 |
| `tests/unit/core/verification/repair-prompt.test.js` | 无 reasoning、有界输出 |
| `tests/unit/core/execution/repair-executor.test.js` | invoke + tool 适配 + executeTool |
| `tests/unit/core/verification/repair-loop.test.js` | 有界尝试、事件、审批停、耗尽 |
| `tests/integration/v2-repair-loop.test.js` | 失败验证触发 repair；通过后 complete；审批不越权 |

当时全量 `npm.cmd test`、`npm.cmd run check`、`git diff --check` 通过，且无 `.deepseek-code/v2` 污染。

现对应入口：

- `src/core/verification/repair-loop.js`
- `src/core/verification/verification-policy.js`
- `src/core/execution/repair-executor.js`
- `src/core/verification/repair-prompt.js`
