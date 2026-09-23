# V2-17 Chat 内核统一与旁路封堵

- 类型：后端 spec
- 日期：2026-05-31
- 状态：已实现
- 关联：[v2 Clean Runtime](../architecture/2026-05-30-deepseek-code-v2-clean-runtime-design.md) · [V2-18 持久化恢复](2026-06-01-v2-18-durable-recovery-resume-hardening-design.md)

---

## 问题与目标

`chat` 走 `chat.js → provider.askDeepSeek`，绕过内核的工具、权限、会话时间线与验证，是第二套未测 agent 路径。V2-17 把 chat 收成单一 kernel 的多轮 REPL，顺带加固 git 工具进程执行、删死代码、补界面边界测试、重写 README 已知限制。本轮不做 V2-18 持久恢复与 V2-19 删 legacy。

## 决策

| 决策点 | 选择 | 否决项 | 理由 |
|---|---|---|---|
| chat 形态 | kernel 多轮 REPL，默认 `read-only` | 独立 chat runtime | 对齐「一条 agent 环」 |
| 自治级 | 新增 `read-only` 矩阵行 | 复用 supervised | 咨询式 chat 需要「不碰」而非「每步问」 |
| 历史 | 会话时间线 | `.deepseek-code/chat.json` | 与 kernel 会话同源 |
| git 进程 | 共用 `runProcess`，元数据如实 | 嵌套调 shell 工具 | 消除一层门控错位 |
| 模式切换 | `/mode` 会话内升权 | 重启才能写 | 对齐 Codex/plan-mode 先例 |

## 设计

### `read-only` 自治级

`DEFAULT_POLICY_MATRIX` 追加（不改既有四级）：

```js
"read-only": {
  read: "allow", read_secret: "ask",
  write_create: "deny", write_update: "deny", write_delete: "deny",
  execute: "deny", execute_dangerous: "deny", network: "deny", destructive: "deny"
}
```

`destructive` 仍硬编码 deny，`read_secret` 仍 ask。

### Chat REPL

入口 `dsc chat` 与 TUI chat 动作创建长寿命 kernel 进入 REPL。每行：`/` 前缀走命令，否则 `kernel.agent.send(line, { autonomy: currentMode })`，用共享渲染器消费事件与终态；`awaiting_approval` 走共享 `resolveApprovals`（自 kernel-runner 抽出）。

命令：`/mode [read-only|gated|auto]`（无参循环三档，提示符显示当前档）；`/clear` 新会话；`/history` 打印当前时间线规模；`/exit` / `/quit` 退出。

会话连续性来自 kernel session。实现需确认 prompt assembler 是否跨 `send` 串联既有轮次；若否，本阶段把对话历史接进 chat 发送路径。

移除：chat 单发分支与 `sendChatMessage` 直调 `askDeepSeek`；`.deepseek-code/chat.json` 读写；界面到 `provider.askDeepSeek` 的一切路径。

### git 加固

`runProcess` 从 `src/tools/builtin/shell.js` 移到 `src/security/shell-policy.js`，shell 与 git 共用。`git.js` 经 `resolveWorkspacePath` 后直接 `runProcess`，不再构造 shell 工具。元数据：`side_effect: "process"`，`category: "read"`（四只读操作：status/diff/log/show）。行为不变。

### 死代码与边界测试

删除 `src/tui.js` 无用的 `./agent.js` 导入；删除 `src/cli.js` 的 `detectTestCommand`（活路径在 `tools/builtin/test.js`）。

扩展 `tests/integration/v2-interface-boundary.test.js`：cli/tui 不含 `provider`/`askDeepSeek`/`./agent.js`；chat 路径构造 kernel 而非 legacy chat 命令。

README「已知限制」按实况重写：去掉 V2-7/V2-8 已实现却仍写未完成的条目；写明进程内恢复限制、单轮修复执行器、无跨进程锁（当时）、待 V2-19 删除的 legacy、GUI 用量离线回零；并说明 chat 默认只读、可 `/mode` 升权。

## 边界与不变量

1. 界面不得触达 `provider.askDeepSeek`。
2. `read-only` 为增量矩阵行，破坏性仍硬 deny。
3. git 读操作无审批；写操作不在本轮。
4. 不删 `provider.js` / `src/kernel/*`（归 V2-19）。
5. 测试用临时根，不污染 `.deepseek-code/v2` 或 `chat.json`。

## 与现状的差异

产品命令前缀现为 `inkstone` / `dsc`。`askDeepSeek` 是否仍存在于 `src/provider.js` 以代码为准；界面边界测试文件路径以 `tests/` 为准。

## 验收

`dsc chat` 只读回答且不改文件；`/mode` 升权后编辑可走审批并有 change id；chat 不再直调 provider；git 四只读操作仍可用且无嵌套工具；边界测试锁住旁路；README 与实况一致。入口 `npm test`、`npm run check`。
