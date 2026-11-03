# Inkstone 系统架构（Living Spec）

- 类型：架构 spec
- 状态：Living Spec，随实现更新；v1.19.0 整合自 4 篇历史 spec
- 关联：[MCP 子系统](mcp-subsystem.md) · [运行时与执行](../backend/runtime-and-execution.md) · [上下文与记忆](../backend/context-and-memory.md) · [编排](../backend/orchestration.md) · [编辑/会话/恢复](../backend/edits-sessions-recovery.md) · [工作台与三端](../frontend/workbench-and-surfaces.md) · [文档索引](../../README.md)

> 本文是 v1.19.0 整合后的领域 Living Spec，取代原 4 篇碎片化历史 spec（见文末「来源」）。它描述 Inkstone 的架构演进脉络、当前内核契约与路线图处置；运行时事实（路径、事件名、错误码、常量）以 `src/` 与 `package.json` 为准。

## 来源与覆盖

| 来源（basename） | 覆盖内容 |
|---|---|
| `2026-05-29-deepseek-code-v1-design.md` | V1 原型的架构意图、决策表、与现状差异 |
| `2026-05-30-deepseek-code-v2-clean-runtime-design.md` | V2 干净运行时的脊柱、模块依赖方向、内核契约 |
| `2026-06-24-v3-roadmap-design.md` | V3 四阶段 / 三支柱 / 三层多 agent 路线图 |
| `2026-09-17-post-v3-roadmap-design.md` | post-V3 处置表、装箱阶梯、拍板结论 |

---

## 1. 演进脉络

| 阶段 | 代号 | 时间 | 一句话 |
|---|---|---|---|
| 原型 | V1 | 2026-05-29 | 定稿双通道推理、三层上下文、多级自治、append-only 事件日志；CLI/TUI/GUI 三界面共用 Agent Kernel 的意图 |
| 内核统一 | V2 干净运行时 | 2026-05-30 | 用一条 runtime 脊柱重做内核：单一执行路径、统一工具平面、事务编辑、验证修复、分支 rewind、持久化恢复、成本/超时护栏 |
| 能力跃迁 | V3 三支柱 | 2026-06-24 | 在干净内核上抬升：语义级上下文（Phase B）、多智能体调度（Phase C）、三端前端重构（Phase D） |
| 产品化 | v1.x | 2026-07 起 | 审计补账驱动：契约冻结、Inspector、MCP 接入、工学换肤、壳层重构、请求级总预算与运行闭环 |

V3 不推倒重来：复用 `createKernel()` 组合根、事件时间线、工具执行路径、编辑/回滚、持久化恢复，只替换子系统内部与界面，不换骨架。

### 1.1 V1 原型的核心决策（已被 V2+ 取代或保留）

| 决策点 | 选择 | 现状 |
|---|---|---|
| 界面与内核关系 | CLI / TUI / GUI 均为薄壳，只经 Kernel API | 保留，且 GUI 也收敛到 `gui/kernel-host.js` 单一宿主 |
| 推理路由 | Think + Act 双通道 | 保留（`models.think` / `models.act` / `models.fim`） |
| 上下文组织 | 冷/温/热三层 + cache-aware 前缀 | 演进为 ContextEngine + context-cache + 语义层 |
| 权限 | 用户策略 > 信任项目 JS > 项目声明式 > 默认矩阵 | 保留，另加 `read-only` 档与三级批准 |
| 会话 | append-only JSONL + hash chain | 保留（`schema_version` 2 + `prev_hash`/`event_hash`） |
| MCP / 插件扩展点 | v1 保留为方向 | v1.11 起 MCP 落地；插件市场仍延后 |

### 1.2 与现状的差异（V1/V2 设计稿 → 当前）

| 设计稿 | 当前 |
|---|---|
| 事件名含 `orchestrator:state` / `channel:invoke` / `file:diff` / `session:pause` | 白名单收敛为 `src/sessions/event-types.js` 的 `SESSION_EVENT_TYPES`，以上名称不再使用 |
| 内置工具含 `web_search` / `write` / `delete` | 现为 `read`/`ls`/`grep`/`glob`/`shell`/`test`/`git`/`web_fetch`/`memory`/`task`/`ask_user` + deferred edit 四件（`diff_preview`/`diff_apply`/`diff_rollback`/`edit`）+ MCP 动态工具 |
| TUI 计划用 Ink | 自研 TUI（`src/apps/tui/`） |
| 目录名 `deepseek-code` / bin `deepseek-code.js` | 产品名 Inkstone，bin 为 `inkstone` / `dsc` |
| 存储 `~/.deepseek-code/sessions/` | 项目内 `.deepseek-code/v2/sessions/` |
| `bin/deepseek-code.js` | `bin/inkstone.js` |
| `apps/gui` | 仓库根 `gui/`（Electron main/preload/renderer） |
| `src/config/` 目录 | `src/config.js` |
| `turn-loop.js` / `approval-flow.js` / `errors/` | 合并进 `agent-runtime.js` 与 `core/execution` / `core/recovery` |
| `diff-preview.js` / `diff-apply.js` | 收敛为 `edit-service.js` + `edit-transaction.js` |
| 版本号写在架构叙述中 | 以 `package.json` 为准（四处同步：`package.json`、`package-lock.json`、`src/theme.js` 的 `VERSION`、`gui/src/App.jsx` 的 `VERSION`） |

---

## 2. 一核三端原则

「一核」= 一套 runtime、一条工具执行路径、一套编辑回滚服务、一条会话时间线；「三端」CLI / TUI / GUI 只做输入、展示与审批。

```
apps/cli · apps/tui · gui
  → src/index.js (createKernel)
  → src/core
  → src/deepseek · src/context · src/tools · src/edits · src/sessions · src/config.js
  → src/workspace · src/security · src/shared
```

禁止的依赖方向：

- `src/core` 依赖 `apps/*`；
- `src/deepseek` 依赖任何 UI / 终端渲染；
- `src/tools` 依赖 UI；
- renderer 直接依赖 Node runtime；
- 工具绕过 `ToolExecutor` / `PermissionEngine`。

固定调用链：`Channel → Tool Gateway → Permission Engine → Tool Executor`，工具实现自身不做权限判断。UI 侧经 `Session Event Log → UI State Adapter → ViewModel` 消费事件，渲染层不直接读原始日志；三端展示统一走 `src/apps/event-contract.js` 的 `describeEvent`（见[工作台与三端](../frontend/workbench-and-surfaces.md)）。

边界不变量：

1. Session Event Log 单 writer；界面均为 client。
2. 工具不自行判权；所有调用过 Permission Engine。
3. `destructive` 永不自动 allow（任何自治级、任何信任规则、任何审批缓存）。
4. 密钥不进日志、不进 GUI IPC 明文（`src/security/redactor.js`）。
5. 工作区路径强制 realpath 边界，防 symlink 逃逸。
6. 事件类型必须在 `SESSION_EVENT_TYPES` 白名单内。
7. 每次写文件产生 change id 与回滚路径。
8. 危险动作（删除、付款、发消息、改库等）必须人工确认；模型只提工具请求，系统执行。
9. JSON / tool call 做 schema 校验与有界修复；失败进入终态而不是死循环。
10. `.deepseek-code` 下用户数据不删；既有 change record 保持可读。
11. `reasoning_content` 不进普通 UI、不进可读 timeline、不作长期记忆。

---

## 3. `createKernel` 组合根与 facade 概览

`src/index.js` 导出 `createKernel(root, options)` 与 `buildToolPlane`。Kernel 面向界面提供 agent 发送/审批/取消、session 订阅与时间线、context 快照、config 读写、recovery / mcp / metrics 门面，以及 `dispose()` 释放锁与会话资源。CLI / TUI / GUI 只依赖该 API。

```
User Interface → Kernel API → Agent Runtime
  → DeepSeek Gateway → Tool Execution Plane
  → Edit Service / Workspace / Session / Verification
```

模块与目录（当前）：

| 目录 | 职责 |
|---|---|
| `src/core/protocol/` | `AgentTurn` / `AgentStep` / `ToolCall` / `ToolResult` / `ApprovalRequest` / `Artifact` |
| `src/core/runtime/` | `agent-runtime.js`（回合编排）、`lifecycle.js`、`cost-budget.js`、`request-budget.js` |
| `src/core/execution/` | `executor-loop.js`、`repair-executor.js`、`tool-call-adapter.js`、`tool-result-router.js` |
| `src/core/verification/` | `verifier.js`、`verification-policy.js`、`repair-loop.js`、`repair-decision.js`、`repair-prompt.js` |
| `src/core/approval/` | `paused-turn-store.js` |
| `src/core/recovery/` | 项目锁、事务日志、暂停侧车、恢复收件箱、编排/task 暂停持久化 |
| `src/core/orchestration/` | 路由、Planner、Worker、Reviewer、隔离合并、重规划、`task` 委派 |
| `src/core/memory/` | 经验记忆（schema / store / scoring / cluster / upsert / retrieval / consolidator / risk-rules） |
| `src/core/planning/` | `classifier.js` + `keywords.js`（中英意图词表） |
| `src/deepseek/` | 网关、双通道参数、FIM、JSON mode、prompt 组装、用量追踪 |
| `src/tools/` | `registry.js`、`executor.js`、`schema.js`、`builtin/`、`permissions/`、`mcp/` |
| `src/edits/` | `edit-service.js`、`edit-transaction.js`、`change-store.js`、`rollback-service.js`、`sensitive-notice.js` |
| `src/sessions/` | 事件日志、分支、检查点、rewind |
| `src/context/` | 索引、选择、快照、缓存、token 预算、`semantic/` |
| `src/workspace/` `src/security/` `src/shared/` | path-safety、redactor / ssrf / shell-policy / command-policy、公共 helper |

---

## 4. turn 生命周期

一轮 turn = 一次用户请求及其全部模型调用、工具调用、审批、编辑、验证、修复、产物与最终答复。

```
user input → classify → cache-aware context → plan → approval gate
  → act(tool calls) → execute tools → feed results → apply edits
  → verify → repair if needed → final → persist events/artifacts
```

生命周期状态以 `src/core/runtime/lifecycle.js` 的 `RUNTIME_STATES` 为唯一权威：
`idle` / `classify` / `plan` / `awaiting_approval` / `execute` / `review` / `verify` / `repair` / `complete` / `failed` / `interrupted`。

Turn 协议对象（`src/core/protocol/`）：

- `AgentTurn`：`TURN_STATUSES` = `running` / `awaiting_approval` / `completed` / `failed` / `interrupted`。
- `AgentStep`：`STEP_STATUSES` = `started` / `completed` / `failed` / `skipped`。
- `ToolCall` / `ToolResult` / `ApprovalRequest` / `Artifact`。

审批点必须可暂停、可恢复，恢复后不丢 turn 状态；暂停/续跑、跨进程恢复的细节见[运行时与执行](../backend/runtime-and-execution.md)与[编辑/会话/恢复](../backend/edits-sessions-recovery.md)。

自治级别（`DEFAULT_POLICY_MATRIX` 行）：`read-only` / `supervised` / `gated`（默认）/ `auto` / `full-auto`。`read-only` 由 V2-17 追加：`read` allow、`read_secret` ask、全部写/执行/网络/破坏 deny；`destructive` 在任何档位都是硬编码 deny，`execute_dangerous` 在 `auto` / `full-auto` 仍为 ask。

DeepSeek 双通道参数（默认模型见 `src/deepseek/model-router.js` / `src/config.js`）：

| 参数 | Think（plan/review/repair） | Act（reply/act） |
|---|---|---|
| model | `models.think` | `models.act` |
| thinking | enabled | disabled（必传） |
| reasoning_effort | high | 不传 |
| temperature | 见 channel 表 | 低 |
| stream | false | true |

FIM 走 `models.fim`，用于小范围补中间代码；大范围修改仍用 unified diff。Prompt 组装最大化前缀缓存：稳定前缀含 system prompt、工具协议、项目规则、紧凑项目索引、记忆摘要；volatile 后缀含当前请求、文件片段、工具结果、验证输出。JSON mode 只在显式要 JSON 时开。

---

## 5. V2 内核契约冻结要点

1. **单写原则**：一条 agent runtime、一条工具执行路径、一条会话系统、一条编辑管线；界面只是 client。
2. **固定执行路径**：schema 校验 → 参数标准化 → 权限决策 → 必要时审批 → 执行 → 脱敏 → `tool:result` → 回灌模型。
3. **category 来自注册定义**，不信模型输入；destructive 不可被信任规则自动放行；密钥必审批且脱敏；shell 只收结构化 argv；网络工具校验协议、主机名、DNS、重定向与输出体积；文件系统工具解析 symlink 并强制 workspace 边界。
4. **每次写入产生** diff 摘要、change id、前后快照、会话事件与回滚路径。
5. **成本闸**：`createCostBudget` 以 `max_tokens` / `max_model_calls` 计量，超限抛 `code = "BUDGET_EXCEEDED"`；runtime 默认 `maxToolIterations = 5`、`maxRepairAttempts = 2`；`maxToolCallRepairs` / `modelTimeoutMs` / `maxTurnTokens` / `maxModelCalls` 可经配置或 options 注入（详见[运行时与执行](../backend/runtime-and-execution.md)）。
6. **事件无 payload 约束**：事件日志保持 payload-free，不含 raw diff、文件内容、snippet、密钥、`reasoning_content`。
7. **安全 helper 收敛**：`src/security/` 的 `redactor.js`、`ssrf.js`、`shell-policy.js`、`command-policy.js` 是可复用 helper，禁止散落 ad-hoc 检查。

V2 验收线（已达成）：`ask` 不误开 JSON mode；`edit` 与 GUI/TUI 同一 runtime；GUI 可发送、流式展示、审批、预览并应用 diff；工具调用真实或安全拒绝；写操作有 change id 与回滚；测试失败进修复环或明确终态；时间线覆盖消息、步骤、工具、审批、diff、验证与最终答复；用量显示 model / tokens / cache / latency。

---

## 6. V3 路线图（四阶段 / 三支柱 / 三层多 agent）

目标 Agent 闭环：

```
用户请求
  → ① 任务路由器（复杂度/风险/是否 plan）
  → ② 上下文管理器（语义检索 + cache-aware prefix）
  → ③ Planner（thinking 产出结构化计划）
  → ④ 工具执行层（系统执行，模型只提请求）
  → ⑤ Verifier（规则/测试/二次模型审核）
  → ⑥ 权限层（高风险人工确认）
  → 结构化结果 + 事件时间线可追溯
```

横切硬约束：`reasoning_content` 不当长期记忆；轮数、修复次数、成本预算都有上限；工具由系统执行；危险动作人工确认；JSON/tool call schema 校验 + 有界重试 + 超时。

### 6.1 四阶段

| 阶段 | 内容 | 状态 |
|---|---|---|
| Phase A · V2 收尾 | V2-18 持久化恢复 → V2-19 删 V1 legacy → V2-20 稳定化（`/recovery` CLI、护栏、文档） | 已完成 |
| Phase B · 语义级上下文 | `symbol-indexer` / `dependency-graph` / `symbol-selector`，AST-first，embedding 延后 | 已完成 |
| Phase C · 多智能体调度 | 三层角色 + 两级审核 + 成本闸 + 写冲突隔离 + 持久化复用 Phase A | 已完成 |
| Phase D · 三端前端重构 | Agent 操作系统可视化层 + Agent-aware 编辑器；三端只负责输入、展示、审批 | 已完成（编辑器收窄为只读 diff） |

### 6.2 Phase D 里程碑与落地状态

| 里程碑 | 内容 | 状态 |
|---|---|---|
| D-0 | 共享契约冻结 + 运行时 schema + 事件回放 fixtures | 部分落地（event-contract）；完整 schema/fixtures 归 post-V3 |
| D-G1 | GUI 外壳 + Status Bar | 已落地 |
| D-G2 | Agent Inspector（priority strip、计划/工具/审批/时间线） | v1.9 装箱落地 |
| D-G3 | Agent-aware 编辑器（真编辑 / 行内 patch / FIM / 选中即问） | v1.4 起收窄为只读 diff；重开与否见 post-V3 Q3 |
| D-G4 | CLI 对齐：render-events 同契约、`/recovery`、多 agent 摘要 | 2026-07-12 |
| D-G5 | xterm 输出终端 | 不做（依赖已删；post-V3 改为后续大版本候选） |
| D-G6 | TUI 对齐分支/检查点/审批/恢复 | v1.9 装箱落地 |
| D-G7 | Recovery Center 完整检查器 | 2026-09-15（v1.7.1） |

三种 diff 来源态必须严格区分：用户脏改（只提示）、Agent 提议 preview（逐块接受/拒绝）、Agent 已应用 committed（可回滚）。

流畅度硬规则：首屏不载编辑器重模块；大文件默认只读并提示局部加载；diff 阈值分页；timeline 与文件树虚拟列表；输入延迟 < 50ms；模型输出禁 `innerHTML`；深浅色一致。

### 6.3 Phase C 三层多 agent

| 角色 | 职责 |
|---|---|
| Orchestrator | 拆任务、派活、收活、决策；唯一可改计划与最终答复 |
| Reviewer | 独立审核子产出，提炼摘要，可否决打回，不改主计划 |
| Worker ×N | 执行子任务，受限上下文与工具子集，可并行 |

子 agent 就是可多开的 `agent-runtime` 实例（依赖注入不同工具子集与上下文作用域）。两级审核：关卡 1 子自审（测试 + 验收标准，复用 `verifyAndMaybeRepair` / `repair-loop`）；关卡 2 次 agent 独立复查，不因「子说审过了」放行。细节见[编排](../backend/orchestration.md)。

自主优化两层：本次任务内用审核摘要调后续派发（始终开）；跨任务沉淀进经验记忆（开关 `off | on | gated`，默认 off）。

必守约束：成本闸（最大派发轮数、最大子 agent 数、最大成本）；派发/打回/再派是程序逻辑读结构化审核结果，不甩给模型即兴；写冲突隔离（隔离工作副本 + 合并 + 项目锁）；持久化复用 Phase A，子 agent 事件嵌套进会话时间线。

---

## 7. post-V3 路线图

V3 落地后，v1.1.0–v1.7.1 主要由审计补账驱动，台账项已基本清零。后续需求收拢为一张处置表：

### 7.1 已完成装箱（v1.7.1 – v1.10.0）

- **v1.7.1**：推送 tag、清理 dependabot 死分支（F1）。
- **v1.7.2**：GUI 缺陷补丁——assistant 回复入流、usage 刷新、未定义变量（E3）+ 敏感模态冒烟截图（F2）。
- **v1.8.0 / v1.8.1**：工学换肤（E1）+ 三列 Dock 壳层。
- **v1.9.0**：契约冻结 + 多智能体可视化 + 模型适配（A1 + A2 + A6 + E2）。
- **v1.10.0**：响应式自适应 + 窗控全透明 + Phosphor Icons + 项目与会话安全删除 + 高端拟态确认弹窗 + 全局字体系统升级。
- **v1.11.0–v1.17.0**：MCP 工具接入体系（B1）分版本落地，见 [MCP 子系统](mcp-subsystem.md)。
- **v1.18.0**：请求级聚合预算、真实 `task` 委派、`repair` 有界语法重试与安全加固。

### 7.2 后续大版本（v2.0+）候选梯队

| 梯次 | 项 |
|---|---|
| 架构核心重构 | D1（`agent-runtime.js` 深度解耦）+ C2（WASM tree-sitter → Native + Worker） |
| 扩展能力 | B2（插件市场体系）+ B3（多模型供应商接入）+ B4（客户端打包分发） |
| 第二低优先级 | A5（xterm 输出终端）、C3（内核 daemon 化）、D2（Shell 命令严格白名单） |
| 最低优先级 | A3（FIM ghost text 行内补全）、A4（Monaco 真编辑 / 行内 patch / 选中即问） |

依赖链：`v1.7.1 推送/tag → v1.7.2 缺陷补丁 → v1.8.0 换肤 ↔ 分发 → v1.9.0 契约冻结 + Inspector → v2.0.0 内核重构`。

### 7.3 拍板结论

| # | 问题 | 结论 |
|---|---|---|
| Q1 | npm 包名 | 暂缓；项目后续可能改名，包名随改名定。GitHub Release 不受影响 |
| Q2 | MCP 规划 | 推进，定为 v1.11.0 核心实施任务 |
| Q3 | 编辑器与 FIM 落点 | 守 v1.4 只读 diff；FIM 落 TUI `/fim` / CLI `inkstone fim`；GUI 交互（A3/A4）延后至最低优先级 |
| Q4 | v1.8.0 `lastLight` 默认 | `latte` |
| Q5 | v1.8.0 是否含时间线抽屉 | 否，推 v1.9.0 |
| Q6 | 分发节奏 | 1.0 版本不再推进，延后至大版本 |
| Q7 | A5 / C3 / D2 处置 | 撤销原有否决，移入后续大版本候选体系，优先级第二低 |
| Q8 | 多模型供应商（B3） | 移出永久否决，1.0 不考虑，留待后续大版本 |

Inkstone 定位是 agent 代改，不是 IDE 自改；把可编辑面做回来会与 IDE 正面竞争。FIM 需要光标编辑面时改为 TUI/CLI 位置补全，不引入编辑器依赖。

「kernel 零改动」纪律：v1.7.2 / v1.8.0 / 分发继续守；v1.9 有条件放开事件负载；v1.11 放开动态工具装配扩展点；v2.0 全面放开。

---

## 8. 版本命名规则与内部架构代号的区分

自 **v1.0.0**（2026-07-13）起采用语义化版本 `major.minor.patch`：

| 级别 | 示例 | 触发条件 | 由谁启动 |
|---|---|---|---|
| major | `v1.x` → `v2.0.0` | 大功能、DeepSeek 模型代际适配、支柱级能力、触及核心运行时 / 内核契约的破坏性重构 | 维护者拍板 |
| minor | `v1.9.0` → `v1.10.0` | 大版本规划内的小功能：slash 命令、内置工具、配置档、一门语言的语义支持、一次前端对齐 | 规划内可直接推进 |
| patch | `v1.10.0` → `v1.10.1` | 文档更新、小漏洞修复、测试补齐、依赖小升级；不改功能面 | 随手推进 |

判定口诀：大能力 / 换模型代际 / 破坏性重构 → major（等拍板）；规划内小功能 → minor；文档 / 小修 / 测试 → patch。

**与内部架构代号的区分**：文档里的「V2 内核 / V3 支柱」是运行时架构与开发阶段，不是产品版本号。产品版本自 v1.0.0 起单独演进。发布时同步四处代码版本（`package.json`、`package-lock.json`、`src/theme.js`、`gui/src/App.jsx`）与 `CHANGELOG.md` 版本小节，git 中每个已发布版本有对应带注解 tag。

---

## 来源

- `2026-05-29-deepseek-code-v1-design.md`
- `2026-05-30-deepseek-code-v2-clean-runtime-design.md`
- `2026-06-24-v3-roadmap-design.md`
- `2026-09-17-post-v3-roadmap-design.md`
