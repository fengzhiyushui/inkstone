# MCP Client v2 分版本实施计划（v1.11.1 → v1.17.0）

- 类型：实施计划 (Plan)
- 日期：2026-09-29
- 状态：进行中（已推进至 v1.16.0，2026-10-06；v1.17.0 未开工）
- 关联：[MCP Client v2 设计规格](../../specs/architecture/2026-09-29-mcp-client-v2-design.md) · [v1.11.0 MCP 首版](../../specs/architecture/2026-09-28-v1.11.0-mcp-integration-design.md) · [post-V3 路线图](../../specs/architecture/2026-09-17-post-v3-roadmap-design.md) · [权限引擎](../../specs/backend/2026-05-30-v2-7-approval-resume-design.md)

> 协议事实以 modelcontextprotocol.io **2026-07-28** 为准（2026-09-29 联网核对）：Modern 无握手、per-request `_meta`；Legacy `initialize`；标准 transport = stdio + Streamable HTTP。

---

## 一、 目标与版本阶梯

### 1.1 总体目标

把 v1.11.0 的「Legacy stdio + tools 最小闭环」演进为 **dual-era（Modern 2026-07-28 + Legacy 回退）** 的完整 MCP 客户端：Streamable HTTP、annotations 治理、resources/prompts、OAuth 2.1、可观测与 MRTR elicitation。**每版本可独立发布、独立验收、可回退**。

### 1.2 版本阶梯

| 版本 | 级别 | 一句话 | 主要交付 |
|------|------|--------|----------|
| **v1.11.1** | patch | Dual-era 与可靠性 | era 探测、`server/discover`、Modern `_meta`、Legacy 回退、取消、命名、structuredContent、clientInfo 同步 |
| **v1.11.2** | patch | 配置与密钥底座 | 三级作用域、`.mcp.json`、`${input:*}`、env 审计 |
| **v1.12.0** | minor | Streamable HTTP | HttpTransport、标准头、SSRF、断流重发、SSE 兼容 |
| **v1.13.0** | minor | 工具治理与权限 | annotations 优先、三级批准、policy、destructive 约束 |
| **v1.14.0** | minor | 能力面 | resources、prompts、outputSchema 校验、ttlMs 缓存 |
| **v1.15.0** | minor | OAuth 2.1 | CIDM 注册、PKCE、iss 校验、凭据、刷新 |
| **v1.16.0** | minor | 可观测与三端 | 诊断、试跑、日志、`/mcp`、事件契约 |
| **v1.17.0** | minor | MRTR 与收齐 | elicitation/`input_required`（opt-in）、`subscriptions/listen`、协议面收齐 |

依赖：`11.1 → 11.2 → 12 → 13 → 14`；`15` 依赖 `12`；`16` 可穿插；`17` 依赖 `11.1` + `16` 确认 UI。  
**不做**：Sampling / Roots / Logging（规范 Deprecated）。

---

## 二、 关键设计约束（全程有效）

1. **零外部运行时依赖**：禁止官方 SDK。
2. **安全不变量**：destructive 永不永久自动放行；密钥不进项目树/日志/IPC；stdio `shell:false`；远程 SSRF；**annotations 默认不可信**。
3. **故障隔离**：单 Server 失败不影响内核。
4. **兼容**：v1.11.0 `mcpServers` 与 `mcp__*` 名保持可用。
5. **Git/版本**：按当前 [文档中心开发规范](../../README.md#开发分支与版本管理规范预览探索期--方式-a-版) 执行：本地 `codex/v1.14` 等短分支，冲刺内普通 feat/fix/test 提交；完成后 `--no-ff` 合入 main，仅一个 minor 预览里程碑 tag，远端不推临时分支；根 README 仅大版本改。
6. **测试**：`npm test`、`npm run check`、`git diff --check`；修改 GUI 时再过 `npm run build:gui`。基线只增不减。

---

## 三、 改动范围白名单

| 区域 | 路径 | 11.1 | 11.2 | 12 | 13 | 14 | 15 | 16 | 17 |
|------|------|:---:|:---:|:--:|:--:|:--:|:--:|:--:|:--:|
| MCP 栈 | `src/tools/mcp/**` | ● | ● | ● | ● | ● | ● | ● | ● |
| 注册表 | `src/tools/registry.js` | ● | | | ● | | | | |
| 权限 | `src/tools/permissions/**` | | | | ● | | | | |
| 配置 | `src/config.js` · `src/apps/kernel-options.js` | | ● | ● | ● | | ● | | |
| 组合根 | `src/index.js` | ● | ● | ● | ● | ● | ● | ● | |
| CLI | `src/cli.js` | ● | ● | ● | | ● | ● | ● | |
| 事件契约 | `src/apps/event-contract.js` | ● | | | | | | ● | ● |
| GUI | `gui/src/**` · host/preload | | ● | | ● | ● | ● | ● | ● |
| TUI | `src/apps/tui/**` | ● | | | | | | ● | |
| 安全 | `src/security/**` | | | ● | | | ● | | |
| 测试 | `tests/unit/mcp-*.test.js` 等 | ● | ● | ● | ● | ● | ● | ● | ● |
| 文档 | specs/plans/overview/CHANGELOG/索引 | ● | ● | ● | ● | ● | ● | ● | ● |

---

## 四、 分版本任务拆解

### v1.11.1 — Dual-era 与可靠性（patch）

**目标**：不扩 HTTP/能力面，让现有 stdio tools 路径能连 **Modern 与 Legacy** Server，并修生产可靠性。

| ID | 任务 | 产出 |
|----|------|------|
| A1 | **Era 探测** | stdio 先发 `server/discover`；成功 → Modern；识别错误/超时 → Legacy `initialize`；缓存 era |
| A2 | Modern 请求元数据 | 每请求 `_meta`：`io.modelcontextprotocol/protocolVersion`、`clientInfo`、`clientCapabilities` |
| A3 | 版本回退 | 处理 `UnsupportedProtocolVersionError`（-32022）+ `data.supported` 重试 |
| A4 | Legacy 保持 | `2024-11-05`…`2025-11-25` initialize 路径不回退；握手失败可诊断 |
| A5 | clientInfo 单一源 | 版本读 `package.json`，删硬编码 `1.11.0` |
| A6 | 结果语义 | 识别 `resultType`（缺省视 `complete`）；`structuredContent`；`isError` 分流 |
| A7 | `list_changed` | 订阅/通知 → 增量 remount；`mcp:tools_changed` |
| A8 | 取消 | 超时/`interrupt` → `notifications/cancelled`（stdio）；错误码 |
| A9 | 重连/并行 init | 退避重连；`DEGRADED`；`initAll` 并发 4 |
| A10 | 命名 | 1–128 规范字符；超长 hash 唯一；防 64 截断碰撞 |
| A11 | 事件 | `mcp:protocol_mode`、`mcp:server_status` 进 event-contract |
| A12 | 测试 | discover/回退/取消/命名/structuredContent 单测 + 回归 |

**结果（2026-09-29）**：A1–A12 已落地（`src/tools/mcp/protocol.js` 新增；`mcp-client.js` / `mcp-hub.js` / `jsonrpc-client.js` / `schema-converter.js` / `event-contract.js` 改造）。关键决策：discover 探测默认 500ms；仅曾成功连接才自动重连；主动 stop/remove 不重连。验证：`npm test` 1365 全绿；`npm run check` 通过。

**验收**：Legacy mock 与 Modern mock 均可 tools/call；拔进程后自动重连；工具名碰撞用例过。

---

### v1.11.2 — 配置与密钥底座（patch）

| ID | 任务 | 产出 |
|----|------|------|
| B1 | `mcp/config-loader.js` | session > project > user 合并与校验 |
| B2 | `.mcp.json` 兼容 | 项目根可读；冲突 warn + 自有配置优先 |
| B3 | `servers` 键 | 可选映射 VS Code 风格（只读） |
| B4 | `${input:*}` | `inputs` + GUI 密码框 / CLI prompt / TUI |
| B5 | 密钥策略 | 内存或 `~/.deepseek-code/credentials/`（0600）；项目配置高熵串警告 |
| B6 | env 白名单复审 | PATH + 显式 env |
| B7 | GUI inputs 表单 | password 型引用 |
| B8 | 测试 | 优先级、兼容、input 解析、密钥不进事件 |

**结果（2026-09-29 落地 / 2026-09-30 收口）**：B1–B6、B8 落地于 `src/tools/mcp/config-loader.js`（新增）；B7 于收口时补齐（`gui/kernel-host.js` 增 `listMcpInputs`/`setMcpInput`，`gui/main.js` 增 `mcp:inputs`/`mcp:set-input` IPC，`preload.js` + `useKernel.js` 桥接，`McpView` 增密钥面板）。

**收口时发现并修复的接线缺陷（重要）**：B1–B5 原本在真实入口中是**死代码** —— `buildKernelOptions` 透传了 `mcpServers` 却丢弃 `config.inputs`，且没有任何产品入口传 `loadMcpConfigScopes`（仅 `src/index.js` 认这个选项）。修法：`kernel-options.js` 新增 `withMcpScopes()`，在三条返回路径（显式 gateway 早返回 / 无 apiKey 早返回 / 正常）统一注入 `loadMcpConfigScopes`（入口默认 on，显式 `false` 可关），`config.inputs` 随 `mcpServers` 一同透传。关键决策：作用域加载的默认值放在**入口**（GUI/CLI）而非 `createKernel`，以免影响既有内核单测的隔离性。验证：新增 `tests/unit/mcp-config-scope-e2e.test.js` 覆盖 `buildKernelOptions → createKernel → kernel.mcp` 全链路（正是原先漏掉的一段）；`npm test` 1382 全绿；`npm run check` 通过；GUI 冒烟通过。

**验收**：两层覆盖可测；`.mcp.json` 样例可驱动 host。（已达成，见上）

---

### v1.12.0 — Streamable HTTP（minor）

| ID | 任务 | 产出 |
|----|------|------|
| C1 | Transport 抽象 | stdio 迁移不破 |
| C2 | `HttpTransport` | POST JSON-RPC、请求级 SSE、标准头 `Mcp-Method`/`Mcp-Name`/`MCP-Protocol-Version` |
| C3 | 断流语义 | **不**依赖 Last-Event-ID；in-flight 新 id 重发 |
| C4 | legacy SSE | `type:"sse"` 兼容映射，标 deprecated |
| C5 | headers | 静态 / `${input:*}`；timeout/abort |
| C6 | SSRF | 扩展 `security/ssrf.js`；redirect 每跳；私网 allowlist |
| C7 | CLI/GUI | 远程 `check`；url/type 字段 |
| C8 | 测试 | mock HTTP、重发、SSRF 拒绝 |

**结果（2026-10-04）**：C1–C8 全部落地。新增 `transport.js`（统一传输工厂）、`http-client.js`（DNS 固定 + 逐跳校验 + 跨 origin 剥凭据头）、`http-transport.js`（POST JSON-RPC + 请求级 SSE + 标准头 + 断流重发）、`sse.js`（SSE 解析器）、`sse-transport.js`（legacy 兼容，标记 deprecated）；`ssrf.js` 增私网放行清单（精确 IP / CIDR / hostname，未列出仍 fail-closed）。

**收口时发现并修复的接线缺陷（重要）**：`src/config.js` 的 `normalizeMcpServers` 只认 `command`，会把 `url` 型服务**静默丢弃** —— 远程 Server 永远到不了 McpHub；`config-loader.normalizeServerConfig` 也会削掉 `allowlist`（现象是"被安全策略拒绝"，难以定位）。两者已改为委托统一归一化并加测试锁定。关键决策：断流重发**不**用 Last-Event-ID 续传，而是发全新 HTTP 请求（服务端不命中旧请求状态）；legacy SSE 保留但明确标废弃。

**验收**：连 mock Streamable HTTP 完成 discover/tools/call；恶意 URL 被拒。（已达成：`mcp-http-e2e` 覆盖 JSON 与 SSE 两种应答、-32022 版本回退、SSRF 拒绝；全量测试 1424 通过）

---

### v1.13.0 — 工具治理与权限（minor）

| ID | 任务 | 产出 |
|----|------|------|
| D1 | annotations 解析 | readOnly/destructive/openWorld/idempotent |
| D2 | 信任模型 | **不受信 server 的 annotations 不放宽**；受信才可只读自动放行 |
| D3 | 三级批准 | session/project/always；`mcp-policy.json` |
| D4 | destructive 硬约束 | 测试锁死不可 always-allow |
| D5 | 工具级开关 | enabled/disabled + GUI |
| D6 | PermissionEngine | policy 优先；旧 autoApprove 兼容 |
| D7 | GUI 风险徽章与批准菜单 | |
| D8 | 测试 | annotations 矩阵、持久化、destructive |

**结果（2026-10-04）**：D1–D8 全部落地。新增 `mcp/annotations.js`（解析 + 风险推导）与 `mcp/tool-policy.js`（工具开关、三级批准、策略持久化）；`permission-engine.js` 增加持久化策略分支与 destructive 兜底安全网，`policy-loader.js` 透传 `policyGrants`；hub 在挂载期完成信任判定并把风险元数据（badge / riskSource / riskEscalatedBy / approvalScope）透给三端；CLI 增 `--trust` 与 `mcp policy list|revoke`，GUI 增风险徽章与信任开关。

关键决策：**annotations 只向更危险方向升级，不得降级** —— 受信 server 的 `readOnlyHint` 不能把关键词已判定为写操作的工具讲成只读；`destructiveHint` 与 `readOnlyHint` 并存时按失败优先定为 destructive；未受信 server 的 annotations 一律忽略（仅关键词兜底）。持久化策略**用户级优先于项目级**，且文件收紧 0600、只记 grant 不写密钥。破坏性工具的 project/always 授权被拒绝时**返回 fallback 到 session**，让界面能说明原因而不是静默失效。

**收口时发现并修复的缺陷**：`isToolEnabled` / `resolveConfiguredScope` 原先直接消费未归一化的原始 `tools` 字段（`enabled` 为 `undefined`），`.includes` 抛错会令**整台 server 的工具全部挂载失败**；`config-loader` 归一化也会削掉 `trust`。两者已改为宽容归一化并加回归测试。

**验收**：只读可配置放行；destructive 始终审批；旧行为不回退。（已达成：`mcp-annotations` 16 项、`mcp-tool-policy` 13 项、权限引擎不变式 7 项、hub 真实挂载 4 项、CLI 5 项、DOM 契约 1 项；全量测试 1470 通过，0 失败）

---

### v1.14.0 — resources + prompts（minor）

| ID | 任务 | 产出 |
|----|------|------|
| E1 | resources | list/read/templates；`ttlMs`/`cacheScope` 缓存提示 |
| E2 | prompts | list/get |
| E3 | 内核桥 | 上下文注入或 `mcp_resources`/`mcp_prompts` 工具 |
| E4 | outputSchema | `structuredContent` 校验（有则校验） |
| E5 | GUI/CLI | 资源树、提示词浏览；`mcp resources\|prompts` |
| E6 | 测试 | 能力位关闭不请求；分页/截断 |

**验收**：带 resources 的 mock 可浏览并读入上下文。

**结果（2026-10-06）**：E1–E6 已落地。资源/模板/提示词经 Client → Hub → kernel → CLI/GUI 贯通，并由 `mcp_resources` / `mcp_prompts` 进入模型工具上下文；缓存、分页和字节上限见规格 §4.1.1。outputSchema 采用零依赖的有界 2020-12 子集，unsupported 明确报错。

**同步修复**：正常 runtime 和公开 tools.execute 真正消费持久授权；统一工具配置归一化保留 risk；动态 add 保留 HTTP headers/allowlist/trust/tools；kernel 暴露 add/remove，GUI 显示真实添加错误。另修复 Hub 工具返回字符串造成执行结果丢失，以及资源/工具结果和 RPC 错误的已知密钥脱敏。

**验证**：真实 stdio mock + createKernel + 本地模拟模型，覆盖资源列表→读取→提示词→后续 role:tool 消息、脱敏、权限参数校验及禁用/重启/删除；Client 单测覆盖 capability gate、Modern/Legacy、分页/截断/缓存失效；GUI host/IPC/草稿和 CLI mock 回归。全量测试与 GUI 构建通过，精确计数见本次 CHANGELOG。语法检查改为逐一检查 JS 文件，避免旧脚本多路径参数只检查首文件的遗漏。

**后续**：v1.15 F1–F7 已完成，见下节。v1.16 同时登记在途 AbortSignal 接入 JSON-RPC 的既有缺口，不能以当前请求前检查或传输错误及时拒绝代替完整取消验收。

---

### v1.15.0 — OAuth 2.1（minor）

**目标**：远程 MCP 走通授权 → 调用 → 刷新，并提供 CLI/GUI 登录入口。

**结果（2026-10-06）**：F1–F7 完成。PR/AS metadata 与首次 401 challenge 发现、显式 CIDM/预注册 ID、DCR 兼容、S256 PKCE、state/iss 回调校验、加密凭据和并发刷新接入真实 HTTP 传输。`kernel.mcp` 登录/状态/取消/注销与 CLI、GUI 贯通；登录完成自动挂载工具，注销卸载；会话事件 schema 与回放契约补齐。

**关键决策**：公共客户端，不接受配置内 client secret；token 按 issuer/resource/client/scopes 隔离，注销限定 serverId+resource；OAuth 请求禁止重定向。待授权固定上下文，旧 refresh/连接/列表响应不能在注销或禁用后复活。普通输出动态脱敏，CLI 专用浏览器授权 URL 保留 state；GUI URL 只留主进程。详细配置与安全边界见规格 §3.4.1。

**验证**：26 项 OAuth 核心测试；真实 kernel + HTTP AS + MCP 覆盖登录、401 刷新、token 脱敏、重启恢复、注销、停止/移除竞态；fresh CLI 直接登录非默认 metadata 服务器；GUI host/IPC/浏览器与状态控制回归。全量 **1604 通过、0 失败、0 跳过**；`npm run check` 检查 **608 个 JS 文件**；GUI 构建与 `git diff --check` 通过。未调用真实外部 IdP。

**后续衔接**：诊断环形日志、工具试跑、TUI `/mcp`、事件一致性及在途请求取消已在下节 v1.16 落地。

---

### v1.16.0 — 可观测与三端收口（minor）

**目标**：在三端查看同源诊断与服务状态，GUI 按权限安全试跑单个工具，补齐在途取消。

**结果（2026-10-06）**：G1–G6 实现完成。Hub 采集结构化帧摘要、请求耗时、错误分类与生命周期，按进程持久化环形日志；CLI 历史查询、TUI list/restart/disable/enable/logs、GUI 日志过滤/导出和 schema 表单试跑贯通。17 类 MCP 事件登记、schema、回放与三端展示统一；工具/内容请求的 signal 到达 JSON-RPC 与 HTTP 传输。

**关键决策**：诊断每进程 500 条 / 1 MiB、保留 8 个运行文件；不记录参数/结果正文、OAuth 交换和原始 stderr，失败显示 storageError。内核历史查询默认 100、最多 4000 条，CLI/TUI 默认 50、最多 500 条；CLI 读取不初始化服务器。试跑固定 supervised，复用权限引擎和 ToolExecutor，原始 inputSchema 子集校验先于调用；32 个待处理上限、5 分钟一次性批准、64 KiB 参数/输出边界。取消只结束相应请求；TUI 管理操作仍等待完成，不宣称 Esc 可撤销重启。

**验证**：CLI 参数前验与 fresh 子进程读取、stdio 不启动、日志动态脱敏及结构键保护、TUI busy/状态/错误回归、事件 schema 与 fixtures 回放、GUI 状态和 host/IPC、工具审批/重复批准/生命周期、真实 stdio/HTTP/SSE 取消及聊天执行/验证/修复/审批续跑中断均已覆盖。全量 **1674 通过、0 失败、0 跳过**；`npm run check` 检查 **623 个 JS 文件**；GUI 构建与 `git diff --check` 通过。Windows 冒烟测试在 native 尺寸与 renderer 视口不同步时恢复视口，保留真实 Inspector DOM 断言。

**下一步**：v1.17 MRTR、elicitation 与订阅；默认关闭，显式开启，不属于本版交付。

---

### v1.17.0 — MRTR 与协议收齐（minor，opt-in）

| ID | 任务 | 产出 |
|----|------|------|
| H1 | MRTR | `input_required` → 三端表单 → `inputResponses`+`requestState` 重试（**新 id**） |
| H2 | elicitation | 默认关；开启必经确认 |
| H3 | `subscriptions/listen` | tools/prompts/resources 变更订阅收齐 |
| H4 | 协议面收齐 | 对齐 2026-07-28 文档与错误码（-32020…） |
| H5 | 安全审查 | 不做 Sampling/Roots/Logging；表单输入脱敏 |
| H6 | 测试与文档 | 默认与 16.x 行为一致 |

**验收**：默认无 MRTR 副作用；显式开启后完整确认流。

---

## 五、 里程碑依赖图

```text
v1.11.1 ──► v1.11.2 ──► v1.12.0 ──► v1.13.0 ──► v1.14.0
                │           │           │
                │           ▼           │
                │       v1.15.0         │
                │           │           │
                └─────► v1.16.0 ◄───────┘
                            │
                            ▼
                        v1.17.0
```

---

## 六、 验收与质量闸门（每版本必过）

```bash
npm test
npm run check
npm run build:gui        # 根目录执行；凡改 gui/ 必过
git diff --check
```

- 测试基线只增不减。
- 文档顺序：代码 → specs/plans → project-overview → CHANGELOG → 索引。
- 发布四处同步：`package.json` · `src/theme.js` VERSION · `CHANGELOG` · git tag。

---

## 七、 风险与回退

| 风险 | 缓解 |
|------|------|
| Dual-era 探测误判 | era 缓存 + 可诊断 `mcp:protocol_mode`；Legacy mock 锁回归 |
| Modern 无 session 语义 | 状态走 server handle，不造本地会话幻觉 |
| Streamable HTTP 复杂度 | 12.x 独立 minor；可 flag `mcp.http.enabled` |
| annotations 误信 | 不受信默认保守；destructive 硬约束 |
| OAuth 平台差 | CIDM+iss 标准路径；真实 IdP 延后验证 |
| 跨版本夹带 | 一版本一分支 |

---

## 八、 本计划状态

| 版本 | 状态 |
|------|------|
| v1.11.1 | **已完成**（2026-09-29，dual-era + 可靠性） |
| v1.11.2 | **已完成**（2026-09-29 落地 / 2026-09-30 收口补齐 B7 + 入口接线） |
| v1.12.0 | **已完成**（2026-10-04，Streamable HTTP + 逐跳 SSRF + legacy SSE 兼容） |
| v1.13.0 | **已完成**（2026-10-04，annotations 治理 + 三级批准 + destructive 硬约束） |
| v1.14.0 | **已完成**（2026-10-06，resources/prompts 上下文闭环 + outputSchema 子集校验 + CLI/GUI） |
| v1.15.0 | **已完成**（2026-10-06，OAuth 发现/PKCE/issuer 隔离/刷新 + CLI/GUI 登录） |
| v1.16.0 | **已完成**（2026-10-06，诊断/试跑/CLI/TUI/三端事件/在途取消） |
| v1.17.0 | 未开工 |

每版本落地后，将本文件对应小节收成「目标 / 结果 / 关键决策 / 验证」摘要，并在 CHANGELOG 记录。
