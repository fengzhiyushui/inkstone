# V2-7 Approval Resume

- 类型：实施计划
- 日期：2026-05-30
- 状态：已完成
- 关联：[CHANGELOG](../../CHANGELOG.md)、[设计](../../specs/backend/2026-05-30-v2-7-approval-resume-design.md)

## 目标

让 V2 审批请求可恢复：CLI、TUI、GUI 能批准或拒绝一个暂停中的工具调用，并在同一 agent turn 内跑完。

## 结果

进程内暂停轮次存储落地后，executor loop 会返回并消费可恢复状态。批准后仍走 `ToolExecutor`，只是把已批工具指纹写入 `approvalCache`。内核与界面层公开形状基本不变，`agent.approve()` 改为 async 并返回结果。

### 范围

做：

- 同时一个活跃暂停审批。
- 进程内审批恢复。
- 批准与拒绝。
- runtime、kernel、CLI runner、TUI helper、GUI host 接线。
- 重复批准、中断清理、会话事件、无仓库 session 污染测试。

不做：进程重启后的持久恢复、多暂停并行、GUI 重设计、审批卡富 diff、repair/context 专项、大面积 TUI/README 乱码清理。

### 文件结构

创建：

| 路径 | 职责 |
|------|------|
| `src/core/approval/paused-turn-store.js` | 内存暂停审批记录 |
| `tests/unit/core/approval/paused-turn-store.test.js` | 存储单测 |
| `tests/integration/v2-approval-resume.test.js` | 内核级批准/拒绝/恢复 |

修改：

| 路径 | 变更 |
|------|------|
| `src/tools/registry.js` | 增加 `secureToolCall(toolCall)` |
| `src/tools/executor.js` | 改用 `registry.secureToolCall()` |
| `src/core/execution/executor-loop.js` | 审批时返回 `resume_state`，增加 `resumeExecutorLoop()` |
| `src/core/runtime/agent-runtime.js` | 保存暂停态；`approve()` async；恢复或取消；暂停中拒绝新的 `send()` |
| `src/index.js` | 注入 paused store 与 `grantApprovalForToolCall()` |
| `src/apps/cli/kernel-runner.js` | `awaiting_approval` 时提示一次，调 `kernel.agent.approve()`，渲染最终结果 |
| `src/apps/cli/render-events.js` | 更新审批文案 |
| `src/tui.js` | `sendKernelPrompt()` 最小批准/拒绝提示 |
| `gui/kernel-host.js`、`gui/main.js` | `approve()` async，IPC 等待结果 |
| `package.json` | 新模块进 `npm run check` |

### 契约

`createPausedTurnStore({ now })`：

| 方法 | 语义 |
|------|------|
| `save(record)` | 保存 `{ approval_id, turn_id, approval, turn, resume_state, created_at }`；重复 `approval_id` 抛 `paused approval already exists` |
| `get(approval_id)` | 读记录；不存在返回 `null` |
| `take(approval_id)` | 取出并删除；二次 take 返回 `null` |
| `size()` | 当前条数 |
| 按 turn 清理 / `clear` | 中断与收尾时使用 |

记录由 runtime 在 `approval_required` 时写入，内容覆盖审批请求、原始 turn、以及 executor loop 的 `resume_state`（含 pending tool call 等）。

`registry.secureToolCall(toolCall)` 共享 category/risk 推导，executor 不再本地拼 secured call。权限判定与执行入口看到同一份安全视图。

`resumeExecutorLoop()` 从 `resume_state` 续跑同一 turn：重新进入工具执行或下一次模型调用，而不是新开 turn。

### 错误与状态语义

| 情况 | 结果 |
|------|------|
| 批准恢复同一 turn | 写入仍经 ToolExecutor，最终 `agent:final` |
| 拒绝 | 取消且不写文件 |
| 重复批准 | `APPROVAL_NOT_FOUND` |
| 暂停中再次 `send()` | `AWAITING_APPROVAL` |
| `interrupt` | 清理暂停审批 |
| 缺失 resume 态 | 按未找到处理，不半执行 |

会话时间线包含 `approval:requested`、`approval:resolved`、`tool:result`、`agent:final`。

### 界面接线

- CLI runner 进程内可批准，一次提示后继续同一 turn。
- TUI 最小 prompt 支持批准与拒绝。
- GUI host await 审批结果；`gui/main.js` 的 IPC 等待 `host.approve()` 完成，不提前关闭通道。
- GUI host 对审批恢复错误做捕获，不把未处理 rejection 丢给渲染进程。

### 验收锁定清单（当时完成标准）

- supervised 编辑在写入前暂停。
- 批准恢复同一 turn，并经 ToolExecutor 写入。
- 拒绝取消且不写。
- 重复批准返回 `APPROVAL_NOT_FOUND`。
- 暂停中新的 `send()` 返回 `AWAITING_APPROVAL`。
- interrupt 清理暂停审批。
- GUI host await 审批结果。
- CLI runner 可进程内批准。
- TUI 可最小 prompt 批准/拒绝。
- 时间线含 `approval:requested`、`approval:resolved`、`tool:result`、`agent:final`。
- `npm.cmd test`、`npm.cmd run check`、`git diff --check` 通过。
- 测试不在仓库根创建 `.deepseek-code/v2`。

## 关键决策 / 遗留约束

| 决策 | 选择 | 否决 | 原因 |
|------|------|------|------|
| 批准授权 | `approvalCache.grant()` | executor 内特判放行 | 保持单一权限路径 |
| 恢复范围 | 进程内存 | 立刻落盘 | 先打通语义，durable 在 V2-18 |
| 并发暂停 | 单活跃 | 多暂停并行 | 简化状态机与 UI |
| UI | 最小可用 | 富 diff 审批卡 | 本阶段只要能批/拒并续跑 |
| turn 模型 | 同 turn 续跑 | 批准后新开 turn | 保持步骤/工具调用连续性 |
| 公开 API | `approve` 改 async | 同步假完成 | 恢复是异步写路径 |

遗留约束：

- 批准后仍不绕过 ToolExecutor。
- 不做进程崩溃恢复。
- 不做 GUI 重设计、不做富 diff 预览。
- 不删 V0/V1，不加依赖。
- 测试不得在仓库根创建 `.deepseek-code/v2`。
- 后续 repair 审批暂停复用同一恢复形状。
- 无关本地脏文件不入库。
- Windows 命令统一 `npm.cmd`。

## 验证

| 测试 | 锁定行为 |
|------|----------|
| `tests/unit/core/approval/paused-turn-store.test.js` | save/get/take、重复 id、按 turn 清理 |
| `tests/integration/v2-approval-resume.test.js` | supervised 编辑暂停；批准续写；拒绝不写；重复批准；暂停中 send；interrupt 清理；时间线事件；无仓库污染 |
| GUI host / CLI runner 相关测试 | await 结果与错误捕获 |

当时 `npm.cmd test`、`npm.cmd run check`、`git diff --check` 通过。

现对应入口：

- `src/core/approval/paused-turn-store.js`
- `kernel.agent.approve` / `listPaused` / `cancelPaused`
- 持久化形态 `src/core/recovery/paused-turn-persistence.js`
