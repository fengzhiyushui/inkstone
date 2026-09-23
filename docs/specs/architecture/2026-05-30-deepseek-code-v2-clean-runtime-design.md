# DeepSeek Code v2 Clean Runtime 设计

- 类型：架构 spec
- 日期：2026-05-30
- 状态：已实现（后续阶段见 [V3 路线图](2026-06-24-v3-roadmap-design.md)）
- 关联：[v1 架构](2026-05-29-deepseek-code-v1-design.md) · [approval-resume](../backend/2026-05-30-v2-7-approval-resume-design.md) · [durable recovery](../backend/2026-06-01-v2-18-durable-recovery-resume-hardening-design.md)

---

## 问题与目标

v1 资产里 unified diff 管线与事件/会话/权限模块可用，但没有统一的 agent 执行主干：工具执行、权限检查、diff 应用、验证与修复没有接进同一条 runtime，CLI / TUI / GUI 也各走各的。v2 用一条 runtime 脊柱重做内核，所有界面只做 client。

目标：可读可搜可改可测可修可解释的本地编码 agent；DeepSeek 作为一等目标 API（thinking、prefix cache、tool call、FIM）；单一执行路径；保留成熟的 diff 与回滚；安全边界显式（工作区隔离、审批、脱敏、安全 shell、SSRF、可审计日志）；测试覆盖端到端行为。

非目标：保留两套 agent 实现；让 Electron / TUI / CLI 持有业务逻辑；把 `reasoning_content` 暴露到用户日志；为拆包而拆 monorepo；为了「干净」丢掉可用的 diff/回滚。

## 决策

| 决策点 | 选择 | 否决项 | 理由 |
|---|---|---|---|
| 执行主干 | 单一 `createKernel()` + turn-based runtime | v0/v1 并行双码库 | 调用链、权限、事件只维护一份 |
| 界面职责 | 全部为 kernel client | 界面内嵌 agent | 单写、可测、跨界面一致 |
| JSON mode | 仅显式结构化输出 | 默认全程 json_object | 普通对话不该被 JSON 截断 |
| 模型路由 | Flash-first，Pro 升级 | 固定 Pro | 成本与延迟 |
| 编辑 | 统一走 EditService（preview/apply/rollback） | 各工具直接改文件 | 每次写都有 change id 与回滚路径 |
| 布局 | 单仓模块化 `src/*` + 薄 `apps` | 多包 monorepo | 当前无独立发包需求 |

## 设计

### 运行时脊柱

```
User Interface → Kernel API → Agent Runtime
  → DeepSeek Gateway → Tool Execution Plane
  → Edit Service / Workspace / Session / Verification
```

一轮 turn = 一次用户请求及其全部模型调用、工具调用、审批、编辑、验证、修复、产物与最终答复。

```
user input → classify → cache-aware context → plan → approval gate
  → act(tool calls) → execute tools → feed results → apply edits
  → verify → repair if needed → final → persist events/artifacts
```

审批点必须可暂停、可恢复，恢复后不丢 turn 状态。生命周期状态见 `src/core/runtime/lifecycle.js` 的 `RUNTIME_STATES`。

### 模块与依赖方向

```
apps/cli · apps/tui · gui
  → src/index.js (createKernel)
  → src/core
  → src/deepseek · src/context · src/tools · src/edits · src/sessions · src/config.js
  → src/workspace · src/security · src/shared
```

禁止：`src/core` 依赖 `apps/*`；`src/deepseek` 依赖任何 UI/终端渲染；`src/tools` 依赖 UI；`src/context` 执行 shell；renderer 直接依赖 Node runtime；工具绕过 `ToolExecutor` / `PermissionEngine`。

当前目录与设计稿的对应关系：应用层在 `src/apps/{cli,tui}` 与 `gui/`；配置是 `src/config.js`（不是 `src/config/` 目录）；协议在 `src/core/protocol/`；执行与修复在 `src/core/execution/`、`src/core/verification/`。

### Core 协议

```js
AgentTurn  { id, session_id, user_message, status, autonomy, created_at, updated_at, steps, artifacts, usage }
AgentStep  { id, turn_id, type, channel, status, input_ref, output_ref, started_at, ended_at }
ToolCall   { id, name, params, source, requested_by_step_id }
ToolResult { id, call_id, status, content, metadata, duration_ms }
ApprovalRequest { id, turn_id, kind, risk, summary, details_ref, decisions }
Artifact   { id, kind, path, hash, size, ttl, metadata }
```

`TURN_STATUSES` = `running` / `awaiting_approval` / `completed` / `failed` / `interrupted`。`STEP_STATUSES` = `started` / `completed` / `failed` / `skipped`。入口 `src/core/protocol/index.js`。

成本闸：`createCostBudget` 以 `max_tokens` / `max_model_calls` 计量，超限抛 `code = "BUDGET_EXCEEDED"`（`src/core/runtime/cost-budget.js`）。runtime 默认 `maxToolIterations = 5`、`maxRepairAttempts = 2`；`maxToolCallRepairs` / `modelTimeoutMs` / `maxTurnTokens` / `maxModelCalls` 可经配置或 options 注入。

### DeepSeek 适配

- 快路径：`models.act`（默认 `deepseek-v4-flash`），thinking 关闭，低 temperature。
- 规划/评审/修复：`models.think`（默认 `deepseek-v4-pro`），thinking 开启，高 reasoning effort。
- FIM：`models.fim`，局部插入。
- JSON mode：只在显式要 JSON 时开（`src/deepseek/json-mode.js`）。

Prompt 组装最大化前缀缓存（`src/deepseek/prompt-assembler.js`）：稳定前缀含 system prompt、工具协议、项目规则、紧凑项目索引、记忆摘要；volatile 后缀含当前请求、文件片段、工具结果、验证输出。

每次请求记录 prompt / completion / reasoning tokens、cache hit / miss、latency、model、channel（`usage-tracker.js`）。

`reasoning_content` 策略：不进普通 UI、不进可读 timeline；必要时作脱敏内部产物以支持 resume；tool-call 轮次间按协议保留。

### 工具平面

```
src/tools/
  registry.js · executor.js · schema.js
  builtin/  read ls grep glob shell test git web_fetch memory task ask_user edit-deferred
  permissions/  permission-engine.js policy-loader.js approval-cache.js
```

固定执行路径：schema 校验 → 参数标准化 → 权限决策 → 必要时审批 → 执行 → 脱敏 → `tool:result` → 回灌模型。

内置工具名以 `src/tools/builtin/` 为准：`read` `ls` `grep` `glob` `shell` `test` `git` `web_fetch` `memory` `task` `ask_user`，以及 `diff_preview` `diff_apply` `diff_rollback` `edit`（`edit-deferred.js` 委托 EditService）。

权限不变量：category 来自注册定义而非模型输入；destructive 不可被信任规则自动放行；密钥必审批且脱敏；shell 只收结构化 argv；网络工具校验协议、主机名、DNS、重定向与输出体积；文件系统工具解析 symlink 并强制 workspace 边界。

编排子集见 `src/core/orchestration/tool-profiles.js`（`readonly` / `edit`）。

### 编辑服务

```
src/edits/
  edit-service.js · diff-parser.js · edit-transaction.js
  rollback-service.js · change-store.js · sensitive-notice.js
```

对外契约：

```js
EditService.preview({ diff })
EditService.apply({ diff, prompt, approval_id })
EditService.rollback({ change_id, force })
EditService.describe(change_id)
EditService.list({ limit })
```

每次写入产生 diff 摘要、change id、前后快照、会话事件与回滚路径。敏感路径（`secret-file` / `credential-file`）触发 `sensitive-notice`。事务事件：`file:diff_preview`、`file:transaction_started`、`file:transaction_committed`、`file:diff_applied`、`file:transaction_failed`、`file:transaction_rolled_back`、`file:rollback_applied`、`file:rollback_conflict`（见 `SESSION_EVENT_TYPES`）。

### 上下文 / 工作区 / 会话 / 安全

- `src/context/`：索引、选择、快照、缓存、token 预算。分层为稳定项目索引、热文件、温文件、冷元数据、项目记忆。只决定模型看见什么，不改文件。
- `src/workspace/path-safety.js`：realpath 边界、symlink 逃逸防护、二进制/大文件检测、相对路径规范化。
- `src/sessions/`：唯一会话系统。事件白名单见 `event-types.js`；日志 schema_version 2 + hash chain；分支 `BR_MAIN` / rewind / checkpoint。
- `src/security/`：`redactor.js`、`ssrf.js`、`shell-policy.js`、`command-policy.js`。可复用 helper，禁止散落 ad-hoc 检查。
- 持久化恢复（v2-18）：`src/core/recovery/`，项目锁、事务日志、暂停侧车、恢复收件箱。错误码 `RECOVERY_LOCK_*`、`RECOVERY_FAULT`、`RECOVERY_BLOCKED` 等，见 `recovery-errors.js` 与 `project-lock.js`。

### 公共 Kernel API

`src/index.js` 导出 `createKernel(root, options)` / `buildToolPlane`。Kernel 面向界面提供 agent 发送/审批/取消、session 订阅与时间线、context 快照、config 读写，以及 `dispose()` 释放锁与会话资源。CLI / TUI / GUI 只依赖该 API。

事件渲染契约在 `src/apps/event-contract.js`，三端共用。

## 边界与不变量

1. 一条 agent runtime、一条工具执行路径、一条会话系统、一条编辑管线；界面只是 client。
2. 危险动作（删除、付款、发消息、改库等）必须人工确认。
3. 模型只提工具请求，系统执行。
4. JSON / tool call 做 schema 校验与有界修复；失败进入终态而不是死循环。
5. `.deepseek-code` 下用户数据不删；既有 change record 保持可读。
6. `reasoning_content` 不进用户可见日志。

## 与现状的差异

| 设计稿 | 当前 |
|---|---|
| `bin/deepseek-code.js` | `bin/inkstone.js`（bin 名 `inkstone` / `dsc`） |
| `apps/gui` | 实际在仓库根 `gui/`（Electron main/preload/renderer） |
| `src/config/` 目录 | `src/config.js` |
| `turn-loop.js` / `approval-flow.js` / `errors/` | 合并进 `agent-runtime.js` 与 `core/execution` / `core/recovery` |
| `diff-preview.js` / `diff-apply.js` | 收敛为 `edit-service.js` + `edit-transaction.js` |
| 产品名 DeepSeek Code | Inkstone（`package.json` name `inkstone`） |

## 验收

v2 验收线（已达成）：`ask` 不误开 JSON mode；`edit` 与 GUI/TUI 同一 runtime；GUI 可发送、流式展示、审批、预览并应用 diff；工具调用真实或安全拒绝；写操作有 change id 与回滚；测试失败进修复环或明确终态；时间线覆盖消息、步骤、工具、审批、diff、验证与最终答复；用量显示 model / tokens / cache / latency；界面不引入 legacy agent 逻辑。回归入口 `npm test`、`npm run check`。
