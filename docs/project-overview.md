# Inkstone 项目说明（内部）

面向维护者与贡献者。对外简介、安装与命令速查见根目录 [`README.md`](../README.md)。本文覆盖架构内核、DeepSeek 适配、工具平面、编辑回滚、持久化恢复、安全不变量、会话事件、存储布局与目录地图，内容以当前 `src/` 为准。

---

## 1. 架构与内核

```text
CLI / TUI / GUI
   └─ src/index.js · createKernel()
        ├─ core/runtime     Agent 生命周期 · 执行循环 · 验证-修复
        ├─ deepseek         模型网关 · 路由 · JSON mode · streaming · FIM · 用量
        ├─ tools            注册表 · schema · executor · 权限 · 内置工具
        ├─ edits            diff 预览 / 应用 / 回滚
        ├─ sessions         事件时间线 · 分支 · rewind
        ├─ orchestration    路由 · Planner · Worker · Reviewer · 经验
        └─ workspace · security · shared
```

核心原则是：一套 Agent runtime、一条工具执行路径、一套编辑/回滚服务、一条会话时间线。UI 只负责输入、展示与审批，不持有 agent 业务逻辑。

### `createKernel(root, options)`

[`src/index.js`](../src/index.js) 是组合根。常用 `options`：

| 选项 | 默认 | 说明 |
|------|------|------|
| `sessionRoot` | `<root>/.deepseek-code/v2/sessions` | 会话时间线存储根；测试可注入临时目录 |
| `limits` | 见 [§7](#7-运行护栏与配置) | 超时 / token / 调用次数 / 畸形 tool-call 重试 |
| `recovery.enabled` | `false` | 持久化恢复总开关，opt-in |

kernel facade：

- `agent.send()` 发起 turn（经确定性路由器分单 / 多智能体，见 [§14](#14-多智能体编排)）
- `agent.approve()` 先路由编排暂停 resume / durable resume，再落 `runtime.approve`
- `agent.interrupt()` / `agent.listPaused()` / `agent.cancelPaused()`
- `dispose()` 幂等：flush 经验 + 释放项目锁
- `recovery.*`：list / resume / cancel / clear / report；恢复启用时另有 `abortJournal()` / `commitJournal()`
- `experience.*`（C4，见 §14.4）
- `metrics.*`：用量与上下文统计

### turn 生命周期

```text
user:message
  → 模型调用（model:request / model:response）
  → 工具循环（见 §3）
  → 验证-修复（verification:result → 必要时 repair:*）
  → 终态：agent:final（ok | stopped）或 agent:error
```

命中成本护栏（`maxTurnTokens` / `maxModelCalls`）时 turn 优雅停止：发 `agent:final` 且 `status:"stopped"`，跳过 verify/repair；`send()` 返回 `{ status:"stopped", content, budget }`，不抛错。

---

## 2. DeepSeek 适配

[`src/deepseek/`](../src/deepseek/) 负责 DeepSeek 协议。

### 模型路由（[`model-router.js`](../src/deepseek/model-router.js)）

| 用途 | channel | 模型 | thinking | 流式 | 备注 |
|------|---------|------|----------|------|------|
| `reply` / `act` | `act` | `deepseek-flash` | disabled | 是 | 对话与工具调用 |
| `plan` / `review` / `repair` | `think` | `deepseek-v4-pro` | enabled（`reasoning_effort: high`） | 否 | 规划 / 评审 / 修复 |
| `fim` | `fim` | `deepseek-flash` | — | — | 补全，走 `/beta/completions` |

`reply` 且 `complexity:"high"` 时改走 `plan` 档。模型 id 是默认值，可用 `DEEPSEEK_MODEL` 或 `config.json` 覆盖，也可用顶层 `models.{act,think,fim}` 整体切换。注：`deepseek-v4-flash`（V4-Flash）已退役，旧配置中的该 id 会在加载时静默改写为 `deepseek-flash`（仅内存生效，不重写 `config.json`）。

think 通道**不声明 `temperature`**：官方协议下 thinking 开启时 temperature / presence_penalty / frequency_penalty 静默无效，传了即是死参数；采样控制改走 `reasoning_effort`（合法全集 `none`/`low`/`medium`/`high`/`max`，配置层原样透传不折叠，历史版本的 low/medium→high 折叠已废弃）。FIM 端点根地址可经 `betaBase` 配置覆盖（默认空 = `${baseUrl}/beta`）。

### 其余协议件

- **JSON mode guard**（[`json-mode.js`](../src/deepseek/json-mode.js)）：只有明确要结构化 JSON 的调用才启用 `response_format`；空 content 时按 jsonMode 重试一次（`emptyContent` 标记）。
- **错误分类与退避**（[`api-errors.js`](../src/deepseek/api-errors.js)）：402（余额不足）/ 429 / 5xx / `insufficient_system_resource` / `aborted` 分类；retryable 错误在 `invoke`（与 `stream` 首字节前）按指数退避有限重试（最多 3 次尝试，500ms–8s），402/4xx（除 408/409/425）不重试。
- **SSE streaming**（[`streaming.js`](../src/deepseek/streaming.js)）。
- **tool-call 规范化 + 畸形重试**（[`tool-call-repair.js`](../src/deepseek/tool-call-repair.js)）：参数非法 JSON 时按 `maxToolCallRepairs` 有界重试，发 `model:tool_call_repair`。
- **用量遥测**（[`usage-tracker.js`](../src/deepseek/usage-tracker.js)）：token、reasoning token、cache hit/miss、latency；三端展示（GUI 状态行/检查器、TUI 状态行 `r:N tok`/tps、CLI `INKSTONE_SHOW_USAGE=1` 终局摘要）。
- **超时**（[`model-gateway.js`](../src/deepseek/model-gateway.js)）：`invoke` / `stream` / `fimComplete` 支持 `timeoutMs`，超时抛 `MODEL_TIMEOUT`。定时器在 body 读完之后才解除，SSE 流读与 `response.json()` 悬挂同样受约束；不传 `timeoutMs` 则不设超时。

---

## 3. 工具平面

[`src/tools/`](../src/tools/) 提供注册表、schema、executor 与权限引擎。内置工具（[`builtin/index.js`](../src/tools/builtin/index.js)）：

| 类别 | 工具 |
|------|------|
| 文件 | `read` · `ls` · `grep` · `glob` |
| 编辑 | `diff_preview` · `diff_apply` · `diff_rollback` · `edit` |
| 进程 | `shell` · `test` · `git` |
| 网络 | `web_fetch` |
| 记忆 | `memory` |
| 协作 | `task` · `ask_user` |

编辑类工具延迟绑定（[`builtin/edit-deferred.js`](../src/tools/builtin/edit-deferred.js)），装配时注入 `editService`：`diff_preview → preview`、`diff_apply`/`edit → apply`、`diff_rollback → rollback`。

安全相关工具行为：

- `grep`：每文件 2s + 总 10s 协作式超时，超时优雅返回并在 metadata 标 `timed_out` 等字段。
- `shell` / `test` / `git`：子进程环境白名单继承（`buildChildEnv`：PATH、系统、用户/临时目录、区域键；密钥与代理变量默认不可见）。
- 命令级策略（[`security/command-policy.js`](../src/security/command-policy.js)，v1.3.1）：forbidden（format / mkfs* / diskpart / bcdedit / dd）映射 `destructive`，各档一律拒绝且审批缓存不可放行；dangerous（删除类 / 系统类 / curl / wget / npm publish / git push 强推 / 包装 shell / 解释器执行参数）映射 `execute_dangerous`，supervised–full-auto 一律人工确认。`runProcess` spawn 前兜底拒绝 forbidden。审批 summary 附 argv 预览。

### 固定执行顺序

```text
ToolCall
  → schema validation
  → parameter normalization
  → permission decision
  → approval（若需要）
  → execution
  → result redaction
  → tool:result 事件
  → model feedback
```

工具超时：`executor` 支持 `defaultToolTimeoutMs` / `context.toolTimeoutMs`；超时落为 `status:"error"`（`metadata.timeout = true`），不抛错、不强杀进程。

---

## 4. 编辑与回滚

[`src/edits/`](../src/edits/) 暴露 `EditService`：

- `preview(diff)` — 解析 diff 并生成摘要，不写文件。
- `apply({ diff, prompt, approval_id })` — 预检路径 → 建快照 → 应用 diff → 记录 change id。
- `rollback(change_id)` — 回滚指定变更。
- `describe(change_id)` / `list({ limit })` — 查看变更记录。

记录落在 `.deepseek-code/changes/<id>.json`，回滚记录落在 `.deepseek-code/rollbacks.jsonl`。

### 记录卫生（v1.6.2 / v1.7.x）

- **大小上限**：单文件超过 `maxCaptureBytes`（默认 1 MiB）时只存 `sha256` + 原始大小，不存全文（`before`/`after` 为 `null`，`truncated: true`）。回滚是硬约束：`truncated` 记录缺 before 全文时，`rollbackChange` 与 `applyRollbackRecord` 抛 `ROLLBACK_TRUNCATED`，绝不写 `before ?? ""` 清空文件。`createEditService({ edits })` 可覆盖（`maxCaptureBytes: null` 关闭上限）。
- **保留期**：`finalizeChange` 后按 `changeRetention = { maxRecords, maxAgeDays }` 清理，只删 `.deepseek-code/changes/*.json`。
- **目录限权**：`changes/` 以 `0o700` 创建；Windows 上 `fs.chmod` 基本无效，此条仅在类 Unix 生效。
- **生产接线（v1.7.1）**：`config.edits` 进入 `DEFAULT_CONFIG`，经 `buildKernelOptions` / `createKernel` → `createEditService` 全链路生效。默认 `maxCaptureBytes: 1 MiB`、`changeRetention: { maxRecords: 200, maxAgeDays: 90 }`。

### 敏感文件提醒（v1.7.0）

改 `.env` / `*.pem` / `*.key` / `.npmrc` 等文件前，三端红色告知「完整原文会写入变更记录」，由用户拍板；拒绝则该文件不改动（`SENSITIVE_EDIT_DECLINED`）。走 [`edits/sensitive-notice.js`](../src/edits/sensitive-notice.js) + `editService.apply` 预检回调，不经 permission-engine、不进审批缓存、所有档位一律提问（策略见 [`apps/sensitive-notice-contract.js`](../src/apps/sensitive-notice-contract.js)）。判定只取 `secret-file` / `credential-file`。

展示层脱敏：CLI/TUI 经 `formatChange`、GUI 经 `changes:describe` 桥，显示前过 `redactor`；存储保持原文供回滚。

---

## 5. 会话、分支与 rewind

- **时间线**：append-only JSONL，路径 `.deepseek-code/v2/sessions/<projectId>/<sessionId>.jsonl`（[`sessions/event-log.js`](../src/sessions/event-log.js)）。
- **分支**：可从任意 turn 分叉，`<sessionId>.branches.json`（[`sessions/branch-store.js`](../src/sessions/branch-store.js)）。
- **rewind**：回到历史状态（[`sessions/rewind-service.js`](../src/sessions/rewind-service.js)）。

### 事件全集

类型由 [`sessions/event-types.js`](../src/sessions/event-types.js) 的 `SESSION_EVENT_TYPES` 集中定义。session-manager 只订阅已登记类型；未登记事件不报错，但**静默不入会话时间线**（仍可走 eventBus）。需持久化的新事件必须先登记。

| 前缀 | 覆盖 |
|------|------|
| `session:` | start / resume / branch_created / branch_activated / rewind_* |
| `recovery:` | started / blocked / report |
| `tx:` | opened / committed / recovered |
| `turn:` | paused / rehydrated / resumed / cancelled |
| `takeover:` | requested / completed |
| `user:` / `agent:` | user:message · agent:turn_started / step / final / error |
| `model:` | request / response |
| `tool:` / `permission:` / `approval:` | tool:call / result · permission:decision · approval:requested / resolved |
| `context:` | snapshot / pin / unpin / warm / cache_* / semantic_degraded |
| `file:` | diff_preview / diff_applied / rollback_applied / transaction_* / rollback_conflict |
| `verification:` / `repair:` | verification:result · repair:started / attempt / result / exhausted |
| `orchestration:` | planned / round_started / replanned / subtask_started / subtask_reviewed / completed / routed |

另有 eventBus 级事件（不入时间线）：`experience:*`、`context:symbol_indexed` / `context:graph_built`、`orchestration:route_resolved`（仅模型档路由运行时）。

展示契约见 [§16.1](#161-三端共享事件展示契约)。

---

## 6. 持久化恢复

跨进程崩溃安全恢复，**默认关闭**。开启：`createKernel(root, { recovery: { enabled: true } })`。关闭时 edit/rewind 行为不变。

组成（[`src/core/recovery/`](../src/core/recovery/)）：

- **项目锁 + epoch fencing**：`.deepseek-code/v2/.lock`，防并发写；`dispose()` 幂等释放。
- **暂停 sidecar**：`.deepseek-code/v2/sessions/<projectId>/paused/`。
- **恢复收件箱**：`.deepseek-code/v2/recovery/inbox.json`。
- **事务日志**：`.deepseek-code/v2/journal/`，edit/rewind 写文件前 `open()`、成功 `commit()`、失败 `abort()`（恢复 preimage）。
- **CLI `/recovery`** 与启动扫描：发现 open/aborting/committed/corrupt 日志并入收件箱。
- **编排级 durable 恢复**（C-Durable，依赖 `recovery.enabled`）：编排回合中串行主区 worker 命中审批暂停时，另落 `orchestration-paused/<approvalId>.json`；重启后 `/recovery` 呈现 `orchestration_paused` 项。详见 [§14.5](#145-跨进程编排级-durable-恢复)。

设计见 [`specs/backend/2026-06-01-v2-18-durable-recovery-resume-hardening-design.md`](specs/backend/2026-06-01-v2-18-durable-recovery-resume-hardening-design.md)。

---

## 7. 运行护栏与配置

配置哲学：适配 DeepSeek 的前提下，参数尽量交给用户；默认值是安全起点，每个旋钮都能覆盖。

默认值来自 [`src/config.js`](../src/config.js) 的 `DEFAULT_CONFIG.limits`：

| 参数 | 默认 | 含义 |
|------|------|------|
| `toolTimeoutMs` | `120000` | 单次工具调用超时 |
| `modelTimeoutMs` | `120000` | 单次模型调用超时（工具循环 / 审批 resume / 修复均覆盖） |
| `maxTurnTokens` | `null`（关） | 单 turn token 上限；命中后 `status:"stopped"` |
| `maxModelCalls` | `null`（关） | 单 turn 模型调用次数上限 |
| `maxToolCallRepairs` | `null`（关） | 畸形 tool-call 有界重试次数 |

`maxTurnTokens` / `maxModelCalls` 计数含 repair 阶段。取值语义（`toLimit`）：省略取默认；`null` / `≤0` / 非法关闭；否则取整。

覆盖方式：`config.json` 的 `limits`，或环境变量 `DEEPSEEK_TOOL_TIMEOUT_MS` / `DEEPSEEK_MODEL_TIMEOUT_MS`。`loadConfig` 对用户 `limits` 做 per-field 深合并。

```json
{ "limits": { "toolTimeoutMs": 180000, "maxTurnTokens": 200000, "maxModelCalls": 40, "maxToolCallRepairs": 1 } }
```

配置文件：项目级 `./.deepseek-code/config.json` 优先，用户级 `~/.deepseek-code/config.json` 回退。自 v1.1.0 起 CLI / TUI / GUI 共用 [`src/apps/kernel-options.js`](../src/apps/kernel-options.js) 的 `buildKernelOptions`，统一透传 `config.limits`、`config.orchestration`、`config.context` 与 semantic override。

---

## 8. 安全不变量

- 文件路径以 realpath 校验 workspace 边界，阻断 symlink 逃逸（[`workspace/path-safety.js`](../src/workspace/path-safety.js)）。
- 工具 category 只信任注册表定义，不信任模型传入字段。
- destructive 操作永不被 trust rule 自动放行。
- `shell` 只接受结构化 argv，以 `shell:false` 执行（[`security/shell-policy.js`](../src/security/shell-policy.js)）。
- `web_fetch` 阻断 localhost / 私网 / link-local / CGNAT / 保留与组播网段，以及 IPv4-mapped IPv6；校验全部 DNS A 记录，每跳 redirect 重新校验；默认网络层固定到已验证 IP 直连（原 hostname 作 Host/SNI），避免 DNS rebinding/TOCTOU（[`security/ssrf.js`](../src/security/ssrf.js)）。
- 输出密钥脱敏（[`security/redactor.js`](../src/security/redactor.js)）：Bearer / 常见 key/token/secret/password 赋值、AWS/GitHub/sk- 前缀、多行私钥块；不做易误伤的通用高熵猜测。
- GUI：`nodeIntegration:false` + `contextIsolation:true` + `sandbox:true` + IPC 白名单强制生效（`IPC_CHANNELS` 唯一权威清单，未登记 channel 的 handle 注册即抛错）。
- 敏感文件写入前独立风险提醒（见 [§4](#4-编辑与回滚)），任何自治档位都不能跳过。

---

## 9. 本地存储布局

`.deepseek-code/` 已被 `.gitignore` 忽略：

```text
.deepseek-code/
  config.json                  本地配置（含 API Key）
  gui-api-profiles.json        API 接入列表（GUI/TUI 共享，文件名历史遗留）
  gui-preferences.json         GUI 偏好
  tui-prefs.json               TUI 偏好
  changes/<id>.json            变更记录
  rollbacks.jsonl              回滚记录
  sessions.jsonl               旧版会话日志（resume 读取）
  v2/
    sessions/<projectId>/
      <sessionId>.jsonl
      <sessionId>.branches.json
      paused/                  暂停 sidecar
      orchestration-paused/    编排暂停 sidecar（含 quarantine/）
    context/                   上下文缓存
    experience/                跨任务经验库
    orchestration/iso/<runId>/ 并行 Worker 隔离工作区（瞬态）
    recovery/inbox.json
    recovered/<txId>/          事务恢复 preimage
    journal/                   事务日志
    .lock/                     项目锁
```

---

## 10. 目录地图

```text
src/
  index.js        createKernel() 组合根
  core/
    runtime/      agent-runtime · lifecycle · cost-budget
    execution/    executor-loop · repair-executor · tool-call-adapter · tool-result-router
    verification/ verifier · repair-loop · repair-decision · repair-prompt · verification-policy
    protocol/     agent-turn · agent-step · tool-call · tool-result · approval-request · artifact
    planning/     classifier · keywords
    approval/     paused-turn-store
    recovery/     项目锁 · 收件箱 · 暂停持久化 · 事务日志 · 恢复服务
    orchestration/ router · planner · worker · reviewer · merge · iso · experience 接线
    memory/       experience-* · risk-rules
  deepseek/       model-gateway · model-router · json-mode · streaming · fim-client · usage-tracker · tool-call-repair · prompt-assembler · api-errors
  tools/          registry · schema · executor · builtin/* · permissions/*
  edits/          diff-parser · change-store · rollback-service · edit-transaction · edit-service · sensitive-notice
  sessions/       event-types · event-log · branch-store · checkpoint-index · rewind-* · session-manager
  context/        context-* · token-budget · workspace-indexer · semantic/*
  workspace/      path-safety
  security/       shell-policy · command-policy · ssrf · redactor
  apps/           kernel-options · api-profiles · model-catalog · event-contract · sensitive-notice-contract · project-registry · session-index · cli/ · tui/
  shared/         id · time · event-bus
  (顶层)         cli.js · config.js · context.js · git.js · patch.js · changes.js · provider.js · search.js · theme.js · tui.js
gui/              Electron main/preload/kernel-host + React/Vite 渲染层（v1.8 三列壳）
docs/             specs · plans · CHANGELOG · README
tests/            单元 / 集成 / e2e
```

顶层 `cli.js` / `config.js` / `context.js` / `git.js` / `patch.js` / `changes.js` / `provider.js` / `search.js` / `theme.js` 是 V2 共享工具模块。`tui.js` 是薄入口，实现全在 `src/apps/tui/`。V1 并存内核（`src/kernel/*`、`agent.js`、`chat.js`、`ui.js`）已删除。

---

## 11. 已知限制

- 持久化恢复默认关闭；未开启时会话 / 变更 / 分支无跨进程文件锁，勿在同一项目目录并发运行多个写状态实例。
- repair executor 目前是单轮修复执行器。
- GUI 用量统计在离线或未接入真实模型调用时可能显示零值。
- `src/theme.js` 的 `VERSION` 可能滞后于 `package.json`；发布真源是 `package.json`。
- 模型 id 默认 `deepseek-flash` / `deepseek-v4-pro`（`deepseek-v4-flash` 已退役，旧 id 加载时静默迁移），以配置覆盖为准。

---

## 12. 开发与文档维护

```bash
npm test            # node --test：tests/ 全部用例
npm run check       # node --check 语法校验
git diff --check
```

文档更新顺序见 [`docs/README.md`](README.md#文档维护顺序)。

---

## 13. 语义级上下文引擎（opt-in）

V3 Phase B 引入（B+1 方法消歧、B+3 query 统一抽取 + Python）。默认关闭（`context.semantic.enabled`）。关闭时引擎行为与文件级一致。

启用后：web-tree-sitter（WASM，`optionalDependencies`，懒加载）解析 **JS / TS / Python** → 符号表 + import/export 绑定 + 尽力静态调用图（直接调用 `resolved`；`obj.method()` / 动态调用标 `unresolved`，边带 `confidence` / `reason`）→ symbol-selector 从种子符号沿依赖图扩 N 跳、按预算选符号级片段。解析失败回退文件级；provider 整体不可用则全量退回文件级，永不崩。

| 字段 | 默认 | 含义 |
|------|------|------|
| `enabled` | `false` | 总开关 |
| `hops` | `2` | 依赖图扩展跳数 |
| `maxSymbols` | `200` | 候选符号上限 |
| `includeMethodHints` | `false` | 项目内唯一同名 `obj.method()` → `probable` 边 |
| `languages` | `["js","ts","py"]` | 语言白名单 |
| `importRoots` | `[]` | Python 模块搜索根（追加） |

模块在 [`src/context/semantic/`](../src/context/semantic/)。事件 `context:symbol_indexed` / `context:graph_built` 仅在语义启用时触发。

---

## 14. 多智能体编排

设计见 [C1+C2](specs/backend/2026-06-27-v3-phase-c1-c2-orchestration-design.md)。`kernel.agent.send()` 经确定性路由器（`task-router`，可升级为 C-Router 分层）判复杂度：

```text
kernel.send(message) → task-router
   ├─ lane="single"      → agentRuntime.send()
   └─ lane="orchestrate" → orchestrator.run()
                            Planner → Worker → 两级审核 → Synthesizer
```

不变量：`agent-runtime.js` 不因编排改语义。Worker / Reviewer 都是 `createAgentRuntime` 实例（注入工具子集 + 作用域上下文），编排层只在 `send()` 之上组合。

| 单元 | 职责 |
|------|------|
| `task-router` | 判 `single \| orchestrate`，产出 `RoutingDecision` |
| `subtask-schema` | `Plan` / `SubTask` / `Verdict` 校验 + `topoOrder` |
| `planner` | 模型 → 结构化 `Plan`；schema 校验 + 有界重试 + 降级单子任务 |
| `tool-profiles` | 过滤 `edit` / `readonly` 工具子集 |
| `worker-factory` | 按 `SubTask` 建 Worker / Reviewer runtime |
| `reviewer` | 独立只读复查 → `Verdict` |
| `dispatch-loop` | topo 串行 + 子自审 + 打回重试 + 预算优雅停止 |
| `synthesizer` | 汇总产出；失败诚实汇报 |
| `orchestrator` | 组装 + 成本闸 + `orchestration:*` 事件 + `maxSubtasks` 截断 |

两级审核：关卡1 = Worker 内置 `verifyAndMaybeRepair`；关卡2 = 独立 Reviewer（只读）。成本闸常开（`config.orchestration`）：`maxSubtasks` / `maxWorkerAttempts` / `budget`，命中后部分完成，不抛不崩。

意图分类词表集中在 `core/planning/keywords.js`（v1.1.0），中文 edit/diagnostic/query 与全角问号不再误入 `general`。

### 14.1 并行写隔离（C3）

无依赖且声明文件范围不重叠的子任务可并行。`batch-planner` 切批；批大小 1 或 `maxParallelWorkers=1` 走主区原路。批 >1 时每 Worker 隔离执行后合并。

流程（`iso-worker-runner`）：`createIso` → `fsCopyWorkspace`（排除 `.git`/`node_modules`/`.deepseek-code`）→ `hashTree` 记 `baseManifest` → 隔离 `buildToolPlane` → runtime `send` → Reviewer → `changedPaths`。

合并（`merge-back`）：实际写入范围校验（`actual ⊆ 声明` 且批内不重叠）→ CAS（主区 hash 一致）→ 整文件净 unified diff 一次 `editService.apply`（原子）。冲突/越界则该 subtask 失败，主区不变。批次允许部分成功。

零残留：`removeIso` + 批末删 run 目录 + 启动 `sweepOrphans`（owner pid + TTL）。`config.orchestration.parallel = { maxParallelWorkers:4, maxCopyFiles:5000, sweepTtlMs:1h }`。

### 14.2 重规划 + 同进程续跑（C5）

`orchestrator.run` 是确定性回合循环：`plan → runDispatchLoop → gateAndReplan`，直到 done / 预算 / `maxRounds`（默认 2）。

- 重规划：`planner.replan → {done,subtasks}`，失败子任务变 corrective，不完整则继续。
- 终止闸：`maxRounds` / 预算 / `replan.done` / 空 / 无进展守卫（本轮零新增 completed 且 replan 指纹全已见）。
- 终判：`done:true` 不代表成功；有 failed → `partial`；被 cap 停 → `incomplete`；否则 `complete`。
- 同进程续跑：串行主区 Worker 审批暂停后，`approve` 路由 `orchestrator.resume`，不重 plan、不重复派发。

### 14.3 分层路由（C-Router）

```text
route(message) → router-scoring
   ├─ score==0            → simple    → single
   ├─ score>=阈值(默认3)  → complex   → orchestrate
   └─ 0<score<阈值        → ambiguous → 模型判 lane（失败回退启发式）
```

评分特征：强 marker +2 / 弱 +1 / 文件 token 首个免计其后 +1（封顶 3）/ 长 edit 捕手 +1（`task_type=edit` 且消息 ≥80 字）。模型档默认开；`router.model.enabled=false` 可 opt-out。失败收敛同一启发式兜底。事件 `orchestration:route_resolved` 仅模型档运行时发出。

配置：`config.orchestration.router.model = { enabled:true, channel:"act", timeoutMs:8000, maxRepairs:1, complexThreshold:3 }`。

### 14.4 跨任务经验记忆（C4，默认关）

开关 `config.orchestration.crossTaskLearning = "off"|"on"|"gated"`，默认 `off`。

- 经验库存 `<root>/.deepseek-code/v2/experience/`，与 `tools/builtin/memory.js` 的项目事实库分离。
- 三级分化（`experience-scoring`）：`score = conf + 0.1·ln(1+validations) − decay·age − 0.2·misleads`；跌破 T3 删除，超 `cap`（默认 200）末位淘汰。Jaccard ≥0.6 聚簇去重；`risk`/`procedural` 永不同簇。
- 巩固器（readonly runtime）只提炼 `{kind,lesson,cues,confidence}`，程序逻辑控打分与淘汰。`experience.flush()` / `dispose` 收口。
- 检索注入 planner；`adopted = used ∩ presented` 才参与升降。
- 风险经验单调升级权限：只把 default-matrix 的 `allow` 升 `ask`，绝不降级、不覆盖用户显式 trust/cache。
- `gated` 模式：高影响 risk 写入进 `pending/`，`experience.{listPending,resolvePending}` 带外审批；过期 deny。

事件（非 off）：`experience:retrieved` / `:consolidated` / `:evicted` / `:reinforced` / `:weakened` / `:pending_approval` / `:pending_resolved`。

### 14.5 跨进程编排级 durable 恢复

gated on `recovery.enabled`。关闭时 C5 同进程续跑不变。

- 暂停双写（同 `approvalId`）：worker turn sidecar + `orchestration-paused/<id>.json`（只存可序列化编排状态，无 raw options）。
- 重启扫描交叉校验（schema + 指纹 + 归属）。孤儿（有 worker 标记缺编排 sidecar）一律 `blocked_recovery`，绝不降级单 agent。
- 续跑：重建 worker → 共享 `pausedTurnStore` 重水化 approve → 续 dispatch，不重 plan；预算续扣。
- 组件：[`orchestration-recovery-contract.js`](../src/core/orchestration/orchestration-recovery-contract.js) · [`orchestration-persistence.js`](../src/core/recovery/orchestration-persistence.js)。

---

## 15. 前端 GUI

Electron（`gui/`），React + Vite。当前壳层为 v1.8.x：三列可拖拽 grid + 40px 原生标题栏 overlay + 右栏 dock（文件树 / 改动 / 恢复 / Plan）+ 设置模态。10 套主题经 tokens 四段带 + 对比度闸门（常驻单测）。双语 zh/en，默认中文。

- **数据接入**：GUI 只经 `gui/kernel-host.js` + preload IPC 白名单接内核，kernel（`src/`）零改动。
- **文件与编辑**：真文件树（path-safety 边界）+ Monaco 只读 Diff。手动保存走独立 `editService.apply`（事务 + 回滚 + change 记录）。
- **设置**：通用 / 模型接入 / 运行护栏 / 多智能体 / 语义上下文 / 经验与恢复 / 关于。模型接入 = API 列表管理 + 模型获取（`GET {baseUrl}/models`，不设默认）+ 连接测试。
- **改动跟踪**：SCM「AGENT 改动」分区 + 前后对比 + hunk 跳转。桥 `changes:list` / `changes:describe` 复用 change-store，列表主进程瘦身。
- **安全**：API Key 绝不回渲染层明文（只回 `hasKey` / 掩码）；保存经 editService 过 workspace 边界。
- **测试**：纯逻辑 node:test；组件与壳层走 `vite build` + 门控 Electron smoke。

---

## 16. 终端 TUI

`src/tui.js` 薄入口 + [`src/apps/tui/`](../src/apps/tui/) 十模块（手写 ANSI/VT）。形态是行内滚动流：历史进终端原生滚动区，底部固定输入与状态栏。

- 纯逻辑：`tui-state` reducer · `event-cards` · `input` · `ansi`（CJK 宽 2）· `paint` · `tui-i18n` · `slash` / `config-flow` · `prefs` · `tui-app` 组合根。
- kernel 零改动：流式 `send(..., { stream, onDelta })`；审批 `agent.approve`；busy 态 Esc 调 `agent.interrupt()`。
- `/config` 与 GUI 共享 [`api-profiles.js`](../src/apps/api-profiles.js)；激活后重建 kernel，对话上下文保留。
- 密钥明文只落 `.deepseek-code/`；渲染路径只出现掩码；退出路径恢复终端态。

### 16.1 三端共享事件展示契约

[`src/apps/event-contract.js`](../src/apps/event-contract.js) 的 `describeEvent(event)` 是内核事件到展示语义的唯一映射源，输出 `{ kind, sourceType, severity, quiet, fields }`。CLI `render-events`、TUI `event-cards`、GUI agent-cards 都是薄适配层。任意输入不抛错；`src/core` 不因展示契约改动。
