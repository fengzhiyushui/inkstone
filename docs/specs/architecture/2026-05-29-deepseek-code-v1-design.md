# DeepSeek Code v1 架构设计

- 类型：架构 spec
- 日期：2026-05-29
- 状态：已完成（v1 基线；v2 起由 [v2 Clean Runtime](2026-05-30-deepseek-code-v2-clean-runtime-design.md) 接替实现路径）
- 关联：[v2 Clean Runtime](2026-05-30-deepseek-code-v2-clean-runtime-design.md) · [V3 路线图](2026-06-24-v3-roadmap-design.md)

> 本文记录 v1 定稿的架构意图与契约方向。路径、事件名、错误码等运行时事实以当前 `src/` 为准；v1 与现状的差异见文末。

---

## 问题与目标

本地编程助手需要适配 DeepSeek API 的双通道参数、长上下文、prefix cache、thinking、tool call 与 FIM，同时让 CLI / TUI / GUI 共享同一套 Agent Kernel。v1 定稿的目标包括双通道推理、冷热温三层上下文、多级自治、可编程权限、三层工具系统，以及 append-only 事件日志。

## 决策

| 决策点 | 选择 | 否决项 | 理由 |
|---|---|---|---|
| 界面与内核关系 | CLI / TUI / GUI 均为薄壳，只经 Kernel API | 各界面自持 agent 逻辑 | 单写原则，事件日志只有一个 writer |
| 推理路由 | Think + Act 双通道 | 单模型一刀切 | 计划与执行的延迟、成本、参数需求不同 |
| 上下文组织 | 冷 / 温 / 热三层 + cache-aware 前缀 | 每次全量重装 prompt | 命中 prefix cache，控制 token |
| 权限 | 用户策略 > 信任项目 JS > 项目声明式 > 默认矩阵 | 纯默认矩阵 | 项目差异大，需要可编程覆盖 |
| 工具接入 | 内置 + MCP + 插件（声明式 wrapper） | 全部写死在内核 | 保留扩展点，v1 插件不执行任意 JS |
| 会话 | append-only JSONL + hash chain | 可改写的会话数据库 | 可审计、可恢复、跨界面共享 |

## 设计

### 整体分层

```
用户界面层  CLI REPL / TUI / GUI(Electron)
     │  Kernel API（IPC 或直接调用）
     ▼
Agent Kernel
  ├─ Task Orchestrator   状态机：Idle → Classify → ThinkPlan → ActExecute
  │                      → ThinkReview → Verify → Complete
  ├─ Think Channel / Act Channel
  ├─ Context Engine      selection → compression → cache boundary → assembly
  ├─ Permission Engine   策略匹配 + 自治门控 + 审计
  ├─ Tool System         ToolDefinition → ToolCall → ToolResult
  ├─ Session Manager     append-only event log + snapshot ref
  └─ Model Provider      DeepSeek 双通道参数、FIM、重试、用量
```

调用链固定为 `Channel → Tool Gateway → Permission Engine → Tool Executor`，工具实现自身不做权限判断。

UI 侧经 `Session Event Log → UI State Adapter → ViewModel` 消费事件，渲染层不直接读原始日志。

### Task Orchestrator

状态机职责：

| 状态 | 职责 | 默认通道 | 退出 |
|---|---|---|---|
| Idle | 等待输入 | — | → Classify |
| Classify | 判任务类型 / 自治级 / 初始通道 | Think | → ThinkPlan 或 Fast path |
| ThinkPlan | 产出 plan / risks / targets | Think | → ActExecute |
| ThinkReply | 解释诊断，不产 diff | Think | → Complete |
| ActExecute | 按 plan 执行 | Act | → ThinkReview 或 Complete |
| ThinkReview | 审 diff 与风险 | Think | 通过 → Verify；否则 → ActRepair |
| ActRepair | 按 review 反馈修复 | Act | → ThinkReview；大修 → ThinkPlan |
| Verify | 执行验证 + 结果解读 | Act+Think | 通过 → Complete；失败 → ActRepair |
| Complete | 写结果入 event log | — | → Idle |
| AwaitApproval | 等用户决策 | — | 确认后回中断点 |
| Terminal | 可恢复阻塞：缺信息 / 权限 / 外部失败 | — | 用户补充 → Classify |

Fast path：query / simple 类任务跳过 ThinkPlan。当前运行时的生命周期状态以 `src/core/runtime/lifecycle.js` 的 `RUNTIME_STATES` 为准：`idle` / `classify` / `plan` / `awaiting_approval` / `execute` / `review` / `verify` / `repair` / `complete` / `failed` / `interrupted`。

自治级别：

| 级别 | Plan 确认 | Execute 确认 | Review 确认 | 适用 |
|---|---|---|---|---|
| supervised | 必须 | 每步 | 必须 | 破坏性 / 网络 / 安装 |
| gated（默认） | 必须 | 自动 | 必须 | 写文件类任务 |
| auto | 自动 | 自动 | 必须 | 读 / 问类任务 |
| full-auto | 自动 | 自动 | 自动 | 用户显式开启 |

Turn 协议对象见 `src/core/protocol/`：`AgentTurn`（`TURN_STATUSES`：`running` / `awaiting_approval` / `completed` / `failed` / `interrupted`）、`AgentStep`（`STEP_STATUSES`：`started` / `completed` / `failed` / `skipped`）、`ToolCall`、`ToolResult`、`ApprovalRequest`、`Artifact`。

### Context Engine

ContextUnit 抽象：`id`、`type`（file / diff / search_result / test_output / conversation / project_index / tool_output）、`source`、`content_ref`、`token_count`、`hash`、`freshness`、`priority`（P0–P4）、`dependencies`。

三层记忆：

- 热层：始终在窗口内，受 budget 截断。P0 系统与工具 schema，P1 当前请求与活跃 diff，P2 目标文件，P3 项目骨架与配置摘要，P4 用户 pin（上限 5）。
- 温层：按 scoring 换入换出。`score = relevance + recency + dependency_distance + active_edit_bonus + pinned_bonus + test_failure_bonus - token_cost_penalty`，LRU 仅作 tie-breaker。
- 冷层：磁盘按需加载后升入温层。

通道预算（v1 设计值，当前以 `src/context/token-budget.js` 与配置为准）：Think 默认 500K（可配至 1M），Act 默认 64K（repair loop 内可放宽）。

Cache-aware 前缀：稳定前缀为 system prompt、channel policy、tool schemas、stable project index、config 摘要；volatile tail 为当前请求、近期对话、选中文件、diff 与工具输出。

失效触发：文件 hash 变化使该 unit 及依赖方失效；依赖图变化使 project index 失效；package/config 变化使运行时假设 unit 失效；早于最后一次 edit 的 test output 失效；切换 channel 清空对方 volatile tail。

快照只存 content-addressed 引用与 `file_revision_hashes`，文件后续变更仍可复现当时上下文。实现入口 `createContextEngine`（`src/context/index.js`）。

### Permission Engine

信任层级从高到低：全局用户策略 → 已信任项目 JS 规则 → 项目声明式规则 → 默认矩阵。未信任项目的 JS 规则不执行；未信任执行结果里 allow 降级为 ask。

资源类别：`read`、`read_secret`、`write_create`、`write_update`、`write_delete`、`execute`、`execute_dangerous`、`network`、`destructive`。

默认矩阵以 `src/tools/permissions/permission-engine.js` 的 `DEFAULT_POLICY_MATRIX` 为准，自治级键为 `read-only` / `supervised` / `gated` / `auto` / `full-auto`。要点：

- `read_secret` 一律 `ask`，通过后也走脱敏，默认不写入模型持久层。
- `destructive` 硬编码 `deny`，任何自治级都不可自动放行。
- `execute_dangerous` 在 `auto` / `full-auto` 仍为 `ask`。

Shell 命令以结构化 `argv` 匹配，优先精确匹配，避免字符串正则放行。约束包括 `shell:false`、cwd 限 workspace、超时杀进程树、stdout/stderr 分流、输出截断（`limitOutput`，当前 32000 字符）、环境变量白名单。

TTL 指纹绑定到具体操作 + 具体目标 + 具体项目，不按 category 粗放行。审批缓存只存 allow，TTL 默认 300000ms（`src/tools/permissions/approval-cache.js`）。

路径规范化：`raw_path → realpath → workspace 边界检查 → normalize → glob 展开 → 规则匹配`（`src/workspace/path-safety.js`）。

### Tool System

统一接口 `ToolDefinition → ToolCall → ToolResult`。执行链：查定义 → 参数标准化 → 权限决策 → 必要时审批 → 执行 → 脱敏 → `tool:result` 回灌模型。

当前内置工具（`src/tools/builtin/`）：`read`、`ls`、`grep`、`glob`、`shell`、`test`、`git`、`web_fetch`、`memory`、`task`、`ask_user`，以及经 `edit-deferred.js` 注册的 `diff_preview`、`diff_apply`、`diff_rollback`、`edit`。

编排工具子集（`src/core/orchestration/tool-profiles.js`）：

| profile | 工具 |
|---|---|
| readonly | `read` `ls` `grep` `glob` `test` `diff_preview` |
| edit | readonly + `edit` `diff_apply` `diff_rollback` `git` |

安全不变量：

- `web_fetch` 禁 localhost、私有/保留 IPv4、IPv6（`src/security/ssrf.js`）。
- `shell` 只接受结构化 argv；命令分类见 `src/security/command-policy.js`。
- `memory` 落项目记忆目录，不进仓库。
- `task` 子代理工具受限、预算独立、自治不超父级，权限决策重走 Permission Engine。
- 编辑类走 `EditService`（preview → apply → rollback），见 `src/edits/`。

v1 设计的 MCP 与插件扩展点保留为方向；当前 `src/tools/registry.js` 仅内置装配，扩展点以后续 spec 为准。

### Session Manager

事件日志为 append-only JSONL，每条带 `schema_version`（当前 2）与 hash chain（`prev_hash` + `event_hash`），损坏行不阻断读取，`verifyEventLog` 可校验链（`src/sessions/event-log.js`）。

会话事件类型以 `src/sessions/event-types.js` 的 `SESSION_EVENT_TYPES` 为唯一清单，覆盖会话/分支/rewind、恢复、事务、turn 生命周期、消息与模型、工具与权限、上下文缓存、文件事务、验证与修复、编排、终态。写入前经 `assertSessionEventType` 校验。

存储形态（当前）：

```
.deepseek-code/
  config.json                 项目配置
  v2/
    .lock/                    项目锁
    sessions/<project_id>/
      <session_id>.jsonl      事件流
      <session_id>.branches.json
      paused/                 暂停侧车
      orchestration-paused/   编排暂停侧车
```

分支模型：`BR_MAIN = "br_main"`，`BRANCH_SCHEMA_VERSION = 1`，分支 id 形如 `br_*`。rewind 先 preview 再创建/激活分支并回滚文件（`src/sessions/rewind-service.js`）。

恢复策略：终态可 safe resume；`awaiting_approval` 恢复确认界面；执行中断标记 `interrupted` 并询问是否重试。温层从 snapshot refs 恢复并校验 `file_revision_hashes`，不做 event replay。

### Model Provider（DeepSeek）

双通道参数（默认模型见 `src/deepseek/model-router.js` / `src/config.js`）：

| 参数 | Think（plan/review/repair） | Act（reply/act） |
|---|---|---|
| model | `models.think`（默认 `deepseek-v4-pro`） | `models.act`（默认 `deepseek-v4-flash`） |
| thinking | enabled | disabled（必传） |
| reasoning_effort | high | 不传 |
| temperature | 见 channel 表 | 低 |
| stream | false | true |

FIM 走 `models.fim`（默认 `deepseek-v4-pro`），用于小范围补中间代码；大范围修改仍用 unified diff。

`reasoning_content` 不进普通 UI、不进可读 timeline；tool-call 轮次内作为 hidden protocol state 保留并按协议回传。

错误处理：`createDeepSeekApiError` 产生 `code = "DEEPSEEK_API_ERROR"`；`isRetryableDeepSeekError` 对 408/409/425/429/500/502/503/504 与 `insufficient_system_resource` 判定可重试（`src/deepseek/api-errors.js`）。JSON mode 仅在显式结构化输出时开启（`src/deepseek/json-mode.js`）。

用量追踪字段：prompt / completion / reasoning / cache hit / cache miss tokens、latency、model、channel（`src/deepseek/usage-tracker.js`）。

## 边界与不变量

1. Session Event Log 单 writer；界面均为 client。
2. 工具不自行判权；所有调用过 Permission Engine。
3. `destructive` 永不自动 allow。
4. 密钥不进日志、不进 GUI IPC 明文（`src/security/redactor.js`）。
5. 工作区路径强制 realpath 边界，防 symlink 逃逸。
6. 事件类型必须在 `SESSION_EVENT_TYPES` 白名单内。
7. 每次写文件产生 change id 与回滚路径。

## 与现状的差异

| v1 设计 | 当前实现 |
|---|---|
| 事件名含 `orchestrator:state` / `channel:invoke` / `file:diff` / `session:pause` 等 | 白名单已收敛为 `SESSION_EVENT_TYPES`，以上名称不再使用 |
| 内置工具含 `web_search` / `write` / `delete` | 现为 `read/ls/grep/glob/shell/test/git/web_fetch/memory/task/ask_user` + deferred edit 四件 |
| TUI 计划用 Ink | 现为自研 TUI（`src/apps/tui/`） |
| 目录名 `deepseek-code` / bin `deepseek-code.js` | 产品名 Inkstone，`package.json` bin 为 `inkstone` / `dsc` |
| 存储 `~/.deepseek-code/sessions/` | 项目内 `.deepseek-code/v2/sessions/` |
| MCP / 插件运行时 | 未实现；`tools/registry.js` 无扩展点 |
| 版本号写在架构叙述中 | 以 `package.json` 为准（撰写时 1.8.6；`src/theme.js` 的 `VERSION` 常量可能滞后） |

## 验收

v1 阶段验收关注：三界面共用 Kernel；工具调用真实执行或安全拒绝；写操作可回滚；事件日志可校验；权限矩阵与脱敏链路生效。现状回归入口为 `npm test` 与 `npm run check`。
