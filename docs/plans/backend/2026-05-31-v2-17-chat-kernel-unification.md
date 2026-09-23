# V2-17 Chat Kernel Unification

- 类型：实施计划
- 日期：2026-05-31
- 状态：已完成
- 关联：[CHANGELOG](../../CHANGELOG.md)、[设计](../../specs/backend/2026-05-31-v2-17-chat-kernel-unification-bypass-closure-design.md)

## 目标

把 `chat` 接到 V2 内核，补上 `read-only` 自治档，关闭 chat/provider 旁路，并加固 git 进程执行。

## 结果

CLI 持有唯一 kernel-backed chat REPL，实现位于 `src/apps/cli/kernel-runner.js`。会话连续性以显式模型消息历史传递：`agent.send(..., { history })`、`modelGateway.reply`、`runExecutorLoop`；kernel session 仍是事件/时间线来源。shell 与 git 共用 `src/security/shell-policy.js` 的 `runProcess`。

### 主要改动

| 路径 | 契约 |
|------|------|
| `src/tools/permissions/permission-engine.js` | `DEFAULT_POLICY_MATRIX` 增加 `read-only` |
| `src/security/shell-policy.js` | 承载共享 `runProcess(argv, { cwd, timeoutMs })` |
| `src/tools/builtin/shell.js` | import `runProcess` |
| `src/tools/builtin/git.js` | 直接经 `runProcess` 执行；类别 `read`，`side_effect: "process"` |
| `src/deepseek/prompt-assembler.js` | 接受 `history`，净化后插到当前 user message 前 |
| `src/deepseek/model-gateway.js` | 转发 `options.history` |
| `src/core/execution/executor-loop.js` | 首次 model messages 带 history，并写入审批恢复状态 |
| `src/apps/cli/kernel-runner.js` | `resolveApprovals`、`runKernelChatCommand`、REPL 命令、`/mode` 切换 |
| `src/cli.js` | `chat` → `runKernelChatCommand`；移除 `src/chat.js` import 与死代码 `detectTestCommand` |
| `src/tui.js` | 去掉 legacy `agent.js` / `chat.js` import，chat 动作走 kernel runner |
| `src/chat.js` | 兼容包装 `runKernelChatCommand`，不再维护 provider/history JSON |
| `README.md` | 重写「已知限制」 |

### `read-only` 矩阵行

| 类别 | 决策 |
|------|------|
| `read` | allow |
| `read_secret` | ask |
| `write_create` | deny |
| `write_update` | deny |
| `write_delete` | deny |
| `execute` | deny |
| `network` | deny |
| `destructive` | deny |

默认矩阵当时覆盖 8 个类别 × 5 个自治档：`read-only`、`supervised`、`gated`、`auto`、`full-auto`。代码后来增加 `execute_dangerous`，以 `src/tools/permissions/permission-engine.js` 为准。

`runProcess` 返回含 `metadata.exit_code`、`stdout`，失败时可带 `metadata.spawn_error`。git 工具用诚实的 process side-effect 元数据，不再假装无副作用。

### Chat 行为

- `chat` 默认 `read-only`。
- 会话内 `/mode` 可切到 `gated` 或 `auto`。
- 会话历史走显式 `history` 消息数组，审批恢复也保留 history。
- kernel session 仍是唯一事件/时间线来源。

### 边界关闭

- CLI/TUI 不再 import legacy `src/agent.js` / `src/chat.js` 业务路径。
- provider/chat 旁路关闭；统一从 `createKernel` 进入。
- `tests/integration/v2-interface-boundary.test.js` 继续守住入口边界。

README「已知限制」当时改为如实描述：审批/repair/rewind 恢复仍是进程内；崩溃安全恢复留给 V2-18；跨进程文件锁当时未做；legacy `src/kernel/*`、`src/agent.js`、`src/provider.js` 仍保留；GUI usage stats 离线可能显示零值。

## 关键决策 / 遗留约束

| 决策 | 选择 | 否决 | 原因 |
|------|------|------|------|
| 历史载体 | 显式 `history` 消息 | 另造 chat 状态库 | 与模型消息同构，易恢复 |
| git 执行 | 共享 `runProcess` | 各自 spawn | 参数/超时/输出语义一致 |
| 自治默认 | chat 用 `read-only` | 默认可写 | 聊天入口风险更低 |
| 旁路 | 全部收进 kernel | 保留 provider 捷径 | 权限与审计完整 |

遗留约束：

- 不在本阶段做 durable recovery。
- 不做 legacy 全量删除（留给后续清理计划）。
- 不加依赖。
- 矩阵后续扩展以代码为准。

## 验证

| 测试 | 锁定行为 |
|------|----------|
| `tests/unit/tools/permission-engine.test.js` | 5 档矩阵与 read-only 语义 |
| `tests/unit/tools/builtin-process.test.js` | `runProcess` 导出与 git 元数据 |
| `tests/unit/deepseek/model-gateway.test.js` | history 转发 |
| `tests/unit/core/execution/executor-loop.test.js` | history 进入首次 invoke 与 resume state |
| `tests/unit/apps/cli/kernel-runner.test.js` | chat REPL 与 `/mode` |
| `tests/integration/v2-interface-boundary.test.js` | 入口边界 |

当时 `npm.cmd test`、`npm.cmd run check`、`git diff --check` 通过。

现对应入口：

- `src/apps/cli/kernel-runner.js`
- `src/security/shell-policy.js` 的 `runProcess`
- `DEFAULT_POLICY_MATRIX["read-only"]`
