# MCP Client v2 架构设计规格 — 对齐市面主流 Agent 的接入体系重构

- 类型：架构设计规格 (Spec)
- 日期：2026-09-29
- 状态：实现至 v1.17.0（2026-10-06）；Modern MRTR 表单与列表变更订阅默认关闭，显式开启
- 关联：[v1.11.0 MCP 首版](2026-09-28-v1.11.0-mcp-integration-design.md) · [post-V3 路线图](2026-09-17-post-v3-roadmap-design.md) (B1) · [权限引擎](../backend/2026-05-30-v2-7-approval-resume-design.md) · [GUI 壳层](../frontend/2026-09-20-v1.8.1-dsh-shell-design.md) · [实施计划](../../plans/architecture/2026-09-29-mcp-client-v2-multi-version-plan.md)

> **取证说明**：MCP 协议事实以 [modelcontextprotocol.io](https://modelcontextprotocol.io/specification) **2026-07-28** 现行规范为准（2026-09-29 联网核对）。产品配置/交互形态综合官方文档与公开资料；调研副本见 `tmp/mcp-market-research.md`。

---

## 一、 问题背景与目标

### 1.1 v1.11.0 现状（已落地能力）

v1.11.0 在零依赖约束下打通了 MCP 最小闭环，可运行 stdio Server 并挂载 tools：

| 模块 | 现状 |
|------|------|
| `jsonrpc-client.js` | JSON-RPC 2.0 请求/通知、pending Map、超时 |
| `stdio-transport.js` | spawn + readline 分帧、stderr 缓冲、防孤儿 |
| `mcp-client.js` | Legacy `initialize` / `notifications/initialized` / `tools/list` / `tools/call` |
| `mcp-hub.js` | 多服务启停、restart/toggle/add/remove、挂载注册表 |
| `schema-converter.js` | `mcp__<server>__<tool>` 命名、schema 清洗、关键词推导 read/mutate |
| 配置 | `config.json` 顶层 `mcpServers`（command/args/env/disabled/autoApprove） |
| 三端 | GUI `McpView` 服务卡；CLI `inkstone mcp list/check/add/remove/toggle` |
| 权限 | `autoApprove` 白名单直通；其余进既有审批流 |

协议面钉死 **`2024-11-05` + initialize 握手 + 仅 stdio + 仅 tools**——已是 **Legacy 时代**实现。

### 1.2 协议现实（2026-09-29 联网核对）

MCP 现行版本为 **`2026-07-28`（Modern）**，与 **`2025-11-25` 及更早（Legacy）** 双时代并存：

| 时代 | 版本 | 握手 | 版本协商 |
|------|------|------|----------|
| **Modern** | `2026-07-28`+ | **无** `initialize`；每请求 `_meta` 带 `protocolVersion` / `clientInfo` / `clientCapabilities` | `server/discover` 预探测；不支持则 `UnsupportedProtocolVersionError`（-32022）并回退重试 |
| **Legacy** | `2025-11-25` / `2025-06-18` / `2025-03-26` / `2024-11-05` | `initialize` + `notifications/initialized` | 握手时交换 `protocolVersion` |
| **Dual-era Client** | — | 先探 Modern，失败回退 Legacy | **Inkstone 必须做成 dual-era** |

**Transport（规范）**：标准仅 **stdio** + **Streamable HTTP**。旧 **HTTP+SSE 已 Deprecated**（兼容读）。

**能力面（Server）**：tools / resources / prompts。  
**客户端能力（Client）**：elicitation（经 **MRTR** `input_required` 往返，不再以 server-initiated request 实现）。  
**已 Deprecated（新实现不建议再做）**：Roots、Sampling、Logging（迁移：工具参数/资源 URI/直连 LLM API/OTel）。  
**扩展（opt-in）**：Tasks、Skills over MCP、MCP Apps、OAuth 扩展。

**Tools 语义要点**：annotations（须视为不可信，除非 server 受信）、`title`/`icons`、`inputSchema`/`outputSchema`（JSON Schema 2020-12）、`structuredContent`、`resource_link`、工具名 **1–128** 字符（`A-Za-z0-9_-.`）、`list_changed` 经 `subscriptions/listen` 订阅、列表结果带 `ttlMs`/`cacheScope`。

**鉴权**：OAuth 2.1；动态客户端注册（RFC7591）已倾向 **Client ID Metadata Documents**；`iss` 校验（RFC 9207）。

### 1.3 与市面主流 Agent 的差距

| 差距维度 | 主流做法 | Inkstone v1.11.0 | 影响 |
|----------|----------|------------------|------|
| **协议时代** | Dual-era（Modern `2026-07-28` + Legacy） | 仅 Legacy `2024-11-05` | 新 Server 直接不可用 |
| **Transport** | stdio + Streamable HTTP | 仅 stdio | 连不上远程/托管 MCP |
| **能力面** | tools + resources + prompts（+ MRTR elicitation） | 仅 tools | 生态能力空洞 |
| **工具元数据** | annotations + outputSchema 驱动治理 | 关键词猜 read/mutate | 误放行/误审批 |
| **配置作用域** | 项目 / 用户 / 本地 + 兼容文件 | 单层 `config.mcpServers` | 团队共享与个人覆盖难 |
| **密钥** | inputs/secret、OAuth、凭据不进仓库 | env 字面量写 config | 密钥进 Git 风险 |
| **热更新** | `list_changed` + 订阅/缓存 ttl | 无 | 工具表陈旧 |
| **可靠性** | 退避重连、取消、故障隔离 | 断线即 ERROR | 长会话脆弱 |
| **审批粒度** | 逐工具 × 会话/项目/永久 | 服务级 autoApprove | 粒度过粗 |
| **可观测** | 日志/Inspector 级诊断 | status/stderr | 排障难 |

### 1.4 目标

在 **不引入官方 SDK、不破坏零运行时依赖** 前提下，把 MCP 客户端升级为 **dual-era、对齐主流** 的接入体系：

1. **协议**：优先 Modern `2026-07-28`，自动回退 Legacy（`2025-11-25`…`2024-11-05`）；`server/discover` + `UnsupportedProtocolVersionError` 重试。
2. **Transport**：stdio 保持零依赖；新增 **Streamable HTTP**（SSE 仅兼容）；OAuth 2.1 + headers。
3. **能力面**：tools 一等（annotations / structuredContent / list_changed）；resources / prompts；elicitation 走 **MRTR**（opt-in）。
4. **配置与密钥**：三级作用域 + `.mcp.json` 兼容 + secret inputs；密钥不进可提交文件。
5. **工具治理**：命名稳定、逐工具三级批准、annotations 优先于关键词、destructive 硬约束。
6. **可靠性**：并行初始化、退避重连、取消、故障隔离。
7. **可观测**：统一 `mcp:*` 事件、诊断日志、三端 `/mcp` 对齐。

### 1.5 非目标

- Inkstone **作为** MCP Server 对外暴露。
- MCP Server 市场 / 一键安装分发。
- 引入 `@modelcontextprotocol/sdk`（维持 0 runtime deps）。
- **Sampling / Roots / Logging**（规范已 Deprecated，不再新做）。
- WebSocket transport。

---

## 二、 目标架构总览

```text
                         三端展示 (GUI McpView / TUI /mcp / CLI inkstone mcp)
                                    │  mcp:* IPC / 内核 facade
┌───────────────────────────────────▼───────────────────────────────────┐
│                         McpHost (宿主编排层)                           │
│  · 配置合并（session > project > user）+ 密钥 resolve                 │
│  · 生命周期：parallel init · health · backoff reconnect · hot reload  │
│  · 能力缓存：tools / resources / prompts · list_changed / ttlMs       │
│  · 治理：tool policy（enable / auto-approve / annotations 推导）      │
└───────────────┬─────────────────────────────┬─────────────────────────┘
                │                             │
                ▼                             ▼
┌───────────────────────────┐   ┌───────────────────────────────────────┐
│  McpClient (dual-era)      │   │  ToolRegistry.mountExternalTools     │
│  Modern: server/discover   │   │  mcp__<server>__<tool>               │
│    + per-request _meta     │   │  DeepSeek Function Schema            │
│  Legacy: initialize 握手   │   └───────────────────┬───────────────────┘
└───────────┬───────────────┘                       │
            │                                       ▼
            ▼                       ┌───────────────────────────────────────┐
┌───────────────────────────┐       │  PermissionEngine + ApprovalCache     │
│  Transport 抽象            │       │  annotations + policy ≫ 关键词         │
│  · StdioTransport          │       │  三级批准：session / project / always │
│  · HttpTransport           │       └───────────────────────────────────────┘
│    (Streamable HTTP；SSE 兼容)
│  · Auth: env | headers | OAuth 2.1
└───────────────────────────┘
```

### 2.1 分层职责

| 层 | 模块（目标） | 职责 |
|----|--------------|------|
| 配置 | `mcp/config-loader.js` | 多作用域合并、schema 校验、secret 解析、兼容 `mcpServers`/`servers`/`.mcp.json` |
| 宿主 | `mcp/mcp-host.js`（由 hub 演进） | 生命周期、健康、重连、热更新、事件 |
| 客户端 | `mcp/mcp-client.js` | **era 探测**、discover、tools/resources/prompts、MRTR、取消 |
| 传输 | `mcp/transports/*` | stdio / streamable-http / legacy-sse；统一帧接口 |
| 鉴权 | `mcp/auth/*` | env/headers；OAuth 2.1 + CIDM 注册、refresh |
| 转换 | `mcp/schema-converter.js` | 命名空间、schema 2020-12、annotations、structuredContent |
| 治理 | `mcp/tool-policy.js` | enable/auto-approve/风险（annotations 优先） |
| 可观测 | `mcp/diagnostics.js` | 帧日志、延迟、错误分类；脱敏 |
| 人工输入 | `mcp/input-broker.js` + `mcp/elicitation-schema.js` | 内存表单、显式确认、校验、超时与生命周期绑定 |
| 订阅 | `mcp/subscriptions.js` | Modern 列表变更过滤、确认与关联 ID、断流清理 |

### 2.2 配置模型（三级作用域）

```text
优先级（高→低）：session 覆盖 > 项目 > 用户
  项目: .deepseek-code/config.json 的 mcpServers
        + 兼容读取 .mcp.json（Claude 同构）
  用户: ~/.deepseek-code/config.json 的 mcpServers
  会话: 运行时 add/toggle/remove（可选持久化）
```

单服务配置（超集，兼容 v1.11.0）：

```json
{
  "mcpServers": {
    "github": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${input:github_token}" },
      "timeoutMs": 60000,
      "disabled": false,
      "autoApprove": ["search_code"],
      "tools": { "enabled": ["*"], "disabled": [] }
    },
    "remote-db": {
      "type": "streamable-http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${input:db_token}" },
      "oauth": { "enabled": true, "scopes": ["mcp:read"] },
      "timeoutMs": 60000,
      "elicitation": { "enabled": false, "timeoutMs": 120000 },
      "subscriptions": { "enabled": false }
    }
  },
  "inputs": {
    "github_token": { "type": "promptString", "password": true },
    "db_token": { "type": "promptString", "password": true }
  }
}
```

- `${input:name}` 加载时解析；**明文 secret 不得写入可提交项目配置**。
- 兼容：只有 `command` → stdio；只有 `url` → streamable-http（可回退 sse）。
- `elicitation.enabled` 与 `subscriptions.enabled` 是相互独立的服务级布尔开关，缺省均为 `false`。表单超时 `elicitation.timeoutMs` 默认 120000 ms，允许整数 1000–300000；它不会延长外围工具执行超时。开关与 `autoApprove`、`trust` 无关，工具批准不能代替用户提交表单。

---

## 三、 协议与传输详细设计

### 3.1 Dual-era 探测与协商

```text
connect(server)
  → (stdio) probe server/discover
  → Modern?  → 用 2026-07-28 per-request _meta
  → UnsupportedProtocolVersionError? → 按 data.supported 重试
  → 其它错误/超时? → Legacy initialize（2025-11-25…2024-11-05）
  → 缓存 era（进程生命周期内）
```

| 步骤 | Modern | Legacy |
|------|--------|--------|
| 发现 | `server/discover` | （无） |
| 版本 | `_meta.io.modelcontextprotocol/protocolVersion`；HTTP 头 `MCP-Protocol-Version` | `initialize.params.protocolVersion` |
| 能力 | `_meta.…/clientCapabilities`；结果可带 `serverInfo` | `initialize` 交换 capabilities |
| 不支持 | `-32022` + `data.supported` | 握手失败 |

`clientInfo.version` **单一源**取 `package.json`。工具名按规范 1–128、`A-Za-z0-9_-.`；跨 server 冲突用 `mcp__<server>__` 前缀消歧（规范明确建议）。

### 3.2 消息面

| 方向 | 方法 | 时代 | 用途 |
|------|------|------|------|
| C→S | `server/discover` | Modern | 版本/能力/身份 |
| C→S | `initialize` / `notifications/initialized` | Legacy | 握手 |
| C→S | `tools/list` · `tools/call` | 两者 | 工具 |
| C→S | `resources/list` · `resources/read` · Modern `templates/list` / Legacy `resources/templates/list` | 两者 | 资源 |
| C→S | `prompts/list` · `prompts/get` | 两者 | 提示词 |
| C→S | `subscriptions/listen` | Modern | 变更订阅 |
| S→C | `notifications/tools/list_changed` 等 | 两者 | 热更新 |
| S→C | `notifications/progress` | 两者 | 进度 |
| C→S | `notifications/cancelled` | Legacy；HTTP 关流 | 取消 |
| S→C | `resultType:"input_required"` + `inputRequests` | Modern MRTR | elicitation 等补充输入 |
| C→S | 重试同操作 + `inputResponses` + `requestState` | Modern MRTR | 回填输入 |

**明确不做（Deprecated）**：Sampling、Roots、Logging 客户端实现。

### 3.3 Streamable HTTP

- 单 endpoint `POST` JSON-RPC；响应为 JSON 或请求级 SSE。
- 标准头：`Mcp-Method`、`Mcp-Name`、`MCP-Protocol-Version`；可选 `x-mcp-header` 参数镜像（校验后采用）。
- **无** `Mcp-Session-Id`（Modern 已移除协议级 session）；跨调用状态用 server 侧 handle（工具参数传递）。
- 断流 **不** 可恢复（无 Last-Event-ID）；in-flight 以**新 id 重发**。
- SSRF：复用 [`security/ssrf.js`](../../../src/security/ssrf.js)，每跳 redirect 重验；私网默认拒 + allowlist。

### 3.4 OAuth 2.1（远程）

- 发现：Protected Resource Metadata / AS metadata；**校验 `iss`**。
- 注册：优先 **Client ID Metadata Documents**；RFC7591 DCR 仅兼容。
- 流程：授权码 + PKCE；token 存 `~/.deepseek-code/credentials/`（0600）；按 issuer 键控，禁止跨 AS 复用。
- 刷新与 `mcp:auth_required` 三端引导。

#### 3.4.1 v1.15 实际契约（2026-10-06）

- `auth/discovery.js`、`auth/oauth-client.js`、`auth/credential-store.js` 实现零依赖的原生公共客户端授权。配置 `oauth:{enabled:true,clientId?,scopes?,issuer?,resourceMetadataUrl?,timeoutMs?}`；不接受配置内的 token、client secret 或 PKCE verifier，stdio 不接受 OAuth。
- 发现先按 Protected Resource well-known 路径与 origin 回退，再按 RFC 8414 / OIDC 获取 AS metadata。默认 PR metadata 均为 404/405 时，匿名 POST 原 MCP endpoint 的 `server/discover`，仅从 401 的 `WWW-Authenticate` 读取 `resource_metadata`；不发送静态凭据头。资源标识、AS issuer 必须严格匹配，必须声明 S256 支持。
- 显式 HTTPS `clientId` 在 AS 声明支持时作为 Client ID Metadata Document URL；普通 ID 支持预注册公共客户端。不提供 ID 时，兼容 AS 的动态注册接口，注册 native / public client。Inkstone 不托管客户端 metadata 文档，真实服务所需 ID/文档由服务方配置。
- 浏览器授权使用随机 state、S256 PKCE、资源指示参数及 `127.0.0.1` 随机端口回调。严格检查回调 Host、路径、state、`iss` 和重复参数，code/verifier 仅提交给该待授权流程固定的 AS。metadata 身份变化、取消、禁用、移除、退出均使旧流程失效。
- 凭据按 serverId、issuer、resource、clientId、scopes 绑定。默认保存在 `~/.deepseek-code/credentials/mcp-oauth/`；`DEEPSEEK_CODE_HOME` 与现有 policy 一致，替代用户 home 后仍追加 `.deepseek-code`。文件使用 AES-256-GCM 与原子写入，文件权限 0600、目录 0700；Windows 使用账户 ACL。本地密钥同目录存放，作用是避免明文落盘，不等同操作系统密钥链。
- token 过期前刷新；同一客户端合并并发刷新。每次 MCP HTTP 请求最多一次 401 刷新重试，第二次拒绝清凭据并要求重新登录；刷新失败、旧刷新迟到、issuer 切换不能复活或覆盖新授权。注销按 serverId + resource 清理，保留其他资源的同名服务。OAuth metadata、注册、token 和带 OAuth 的资源请求均禁止重定向，仍经 DNS 固定与 SSRF 校验；HTTP 仅允许显式放行的本机回环。
- `kernel.mcp` 提供 `getAuthStatus/startAuth/cancelAuth/logoutAuth`。安全状态为 disabled/unauthenticated/pending/authenticated/error。Hub 登录完成自动重连；`mcp:auth_required`、`mcp:auth_status` 已登记会话 schema 与回放样本，authenticated 事件在重连结束后发出。
- GUI 只由主进程打开授权 URL，IPC 仅返回安全状态；CLI `mcp auth <server> [login|status|cancel|logout]` 显示授权 URL 并等待回调。该专用授权 URL 保留 state，普通内容/错误/日志动态脱敏新旧 token、code 和 verifier；它们不进入 IPC 或会话事件。
- 传输错误及时拒绝对应 JSON-RPC pending，401 不再被掩盖成超时。v1.15 当时未包含的在途 AbortSignal 取消已于 v1.16 补齐，见 §6.1。
- 验收使用真实本地 HTTP mock AS 与 MCP、完整内核、CLI、GUI host/IPC/状态测试；未验证真实外部 IdP。legacy SSE 复用同一 HTTP 鉴权层，建议新服务使用 Streamable HTTP。

---

## 四、 工具治理与权限

### 4.1 命名空间

- 保持 `mcp__<serverId>__<toolName>`；server 冲突消歧（规范建议前缀）。
- 超长改为可读前缀 + `hash8`，保证唯一；映射表永久保留 `originalName`。
- 工具名校验放宽至规范字符集（含 `.`），仍禁止空格/逗号。

### 4.1.1 v1.14 能力面实际契约（2026-10-06）

- `McpClient` 提供 `listResources` / `listResourceTemplates` / `readResource` / `listPrompts` / `getPrompt`；`McpHub` 与 `kernel.mcp` 同名门面首参为 `serverId`。仅显式声明为 `true` 或对象的 capability 生效，未声明时列表返回 `supported:false`、读取抛 `MCP_CAPABILITY_UNSUPPORTED`，均不发业务 RPC。只声明 resources/prompts 的服务不会被探测 `tools/list`。
- 列表默认最多 5 页 / 200 项 / 1 MiB，上限 20 页 / 1000 项 / 1 MiB；read/get 默认 64 KiB，最多 1 MiB。截断保留 `truncated` / 原因 / 可用的 `nextCursor`。单页内部截断用 `inkstone-page:` 本地游标保存偏移，有效期最多 5 分钟，不能跨客户端或 CLI 进程使用。重复游标和单项超限均停止；UTF-8 文本按 JSON 序列化字节预算截取，二进制块超限则省略。
- `capability-cache.js` 仅在当前客户端内缓存，最多 64 项 / 2 MiB / 5 分钟；没有正数 `ttlMs` 不缓存，`cacheScope:none/request` 不缓存，其余提示也不扩大到跨服务器、凭据或进程共享。断开、身份变化、`list_changed` 清缓存与游标；在途旧响应不能重新写入失效缓存。列表缓存与游标都不落盘。
- `capability-tools.js` 按已连接且有对应能力的服务动态挂载 `mcp_resources` / `mcp_prompts`，使用现有 read 类权限及参数校验。资源、提示词均作为带来源说明的普通 tool 文本送入模型，返回数据中的 `role:system` 不会变成系统消息。URI 只提交给配置中的 MCP 服务，客户端不会直接抓取该 URI。界面「放入对话」只填入引用草稿，由用户发送。
- `security/mcp-content.js` 是 CLI、GUI、内容工具与 Hub 共享的展示脱敏边界：清理已配置的密钥值、敏感字段与对象键，省略 binary，并限制深度 / 节点。输出结构保留普通 `data` 字段；脱敏后重名不会静默覆盖已有字段。RPC 错误也必须经过相同脱敏边界。
- `output-schema.js` 是**有界 JSON Schema 2020-12 子集**，不是完整实现：支持类型 / 枚举 / const、数值和字符串边界、对象字段 / required / additionalProperties / dependentRequired / dependentSchemas、数组 / prefixItems / contains / uniqueItems、组合 / 条件及本地 JSON Pointer `$ref`。不支持远程引用、锚点、`format`、`unevaluated*` 或任意正则；未知断言、复杂正则、超出预算、缺少或不匹配的 structuredContent 都明确返回校验错误，不静默通过。校验发生在原始 structuredContent 上，随后脱敏进入 metadata。
- 挂载的 MCP 工具返回标准 `{status,content,metadata}`，修复文本返回值在 ToolExecutor 中丢失的问题；`isError`、校验失败与尚未支持的 `input_required` 均呈 error。`kernel.mcp.callTool` 兼容原有字符串返回。
- CLI/GUI 默认浏览预算为 1 页 / 50 项 / 64 KiB，按需连接目标服务，失败不拖住其它服务器。资源/提示词的强制刷新可用 API `forceRefresh:true`；v1.14 的取消检查仅覆盖请求前与分页间，v1.16 已将 signal 透传到在途 JSON-RPC 与 HTTP 请求。OAuth、诊断事件收口、MRTR 不在 v1.14 当时的范围内。

### 4.2 风险推导优先级

```text
1. 用户 policy（enabled/disabled、autoApprove、三级批准）
2. tool annotations（readOnlyHint / destructiveHint / openWorldHint）
   ※ 规范：annotations 不可信，除非 server 受信 → 默认偏保守
3. 启发式关键词（兜底）
4. 默认：mutate → 需审批
```

| annotations（受信 server） | 默认 category | 默认策略 |
|---------------------------|---------------|----------|
| `readOnlyHint: true` | `read` | 可配置自动放行 |
| `destructiveHint: true` | `destructive` | 永不自动放行 |
| `openWorldHint: true` | 风险 +1 | 倾向 ask |
| 无 / 不受信 | 关键词 / 默认 | mutate → ask |

### 4.3 三级批准

**仅本次 / 本项目 / 永久**。destructive **不可**永久自动放行。

### 4.4 结果映射

- `text`：拼接；`structuredContent`：保留 JSON 进 metadata（并校验 `outputSchema`，若有）。
- `resource_link` / embedded `resource`：可解析引用。
- `input_required`：Modern 且显式启用时转为三端人工表单，经内存 broker 确认后重试回填（新 JSON-RPC id）；模型不能代填。未启用或 Legacy 路径只返回需要输入的状态，不暴露原始表单或继续状态。
- `isError`：`[MCP Error]` 前缀；协议错误 vs 工具执行错误分流（后者可给模型自纠）。

---

## 五、 可靠性与生命周期

| 能力 | 设计 |
|------|------|
| 初始化 | 有界并发（默认 4）；单服务失败隔离 |
| 重连 | 指数退避 + 抖动；连续失败 → `DEGRADED` |
| 健康 | 心跳或轻量 list；GUI 反映 last_ok |
| 取消 | 超时/`interrupt` → `notifications/cancelled`（stdio）或关 HTTP 流 |
| 热更新 | `list_changed`（含 tools/resources/prompts）→ 增量 remount；尊重 `ttlMs` 缓存 |
| 配置热加载 | add/remove/toggle 保持；可选 watch 项目 config |
| 故障隔离 | 单 Server 崩溃不影响内核 |
| 进程 | stdio 防孤儿；HTTP dispose 关连接 |

---

## 六、 可观测与三端契约

| 事件 | 说明 |
|------|------|
| `mcp:server_status` / `mcp:server_error` / `mcp:server_disconnected` | 连接、重连、错误与断开 |
| `mcp:server_added` / `mcp:server_removed` / `mcp:server_deprecated` | 配置生命周期与废弃传输提示 |
| `mcp:protocol_mode` | 保留规格事件；实际协议模式由 `server_status` 携带 |
| `mcp:tools_mounted` / `mcp:tools_changed` | 挂载与 list_changed |
| `mcp:resources_changed` / `mcp:prompts_changed` | 内容列表失效 |
| `mcp:auth_required` / `mcp:auth_status` | OAuth 介入与状态变化 |
| `mcp:config_warn` | 配置警告，可不含 serverId |
| `mcp:log` | 脱敏诊断 `entry`，含方法、请求 ID、耗时与错误分类 |
| `mcp:tool_test` | runId、toolName、status、durationMs；不包含参数或结果正文 |
| `mcp:input_required` / `mcp:input_resolved` | 表单请求 ID、serverId、method、status；正文与输入值不进入事件 |
| `mcp:subscription_status` | connecting/active/closed/error/cancelled、通知计数与安全提示 |

| 端 | 目标形态 |
|----|----------|
| GUI | 服务卡 + 工具树 + 试跑 + 日志抽屉 + 逐工具批准 + OAuth/inputs |
| TUI | `/mcp` 列表/重启/启停/历史日志；模型回合与管理操作互斥 |
| CLI | `list\|check\|add\|remove\|toggle\|logs\|auth` |

### 6.1 v1.16 实际契约（2026-10-06）

- **诊断存储**：`diagnostics.js` 每进程环形缓冲最多 500 条 / 1 MiB，落在项目 `.deepseek-code/mcp-logs/`，保留最近 8 个运行文件。100 ms 合并写入，停止时 flush；JSON 原子替换，拒绝符号链接目录/文件。存储失败通过 `storageError` 显示，不阻止正常 MCP 操作。内核查询默认 100 条、最多 4000 条；CLI/TUI 默认 50 条、最多 500 条。
- **采集内容**：仅保留帧结构摘要、方向、方法、请求 ID、耗时、状态和分类；参数、结果正文、OAuth 交换、HTTP 头和原始 stderr 不写帧日志。已知配置值和动态 OAuth 密钥在采集、读取与显示边界脱敏；JSON 导出遵守相同边界。level 为 debug/info/warn/error，category 为 transport/protocol/auth/permission/timeout/cancelled/tool/lifecycle。
- **查看入口**：CLI `mcp logs [server]` 支持 limit/level/category/method/search 与 JSON；创建内核时 `autoInitMcp:false`，可读取已移除服务器的历史。TUI `/mcp [list|restart <server>|disable <server>|enable <server>|logs [server] [limit]]` 不调用模型。GUI 日志按需加载、过滤、刷新、导出。
- **工具试跑**：`kernel.mcp.listTools/startToolTest/approveToolTest/cancelToolTest` 经同一 ToolExecutor 和权限引擎，固定 supervised。先校验原始 inputSchema 的有界 JSON Schema 子集；不支持的约束明确拒绝。GUI 简单 schema 生成字段，复杂 schema 可输入 JSON，仍受服务端校验。参数与可见结果限制 64 KiB；二进制省略，过长结果提示截断。批准只用于当前调用及固定参数，不写永久授权；最多 32 个待处理任务、批准有效期 5 分钟，重启/禁用/移除/身份变化使旧操作失效。destructive 仍拒绝。
- **试跑权限与显示**：既有 autoApprove、用户信任和项目授权仍按权限引擎生效；需要新批准时，该批准只绑定当前试跑。批准前重新检查权限、工具定义及配置，取消后清除参数引用。参数内敏感字段在批准后的返回结果中仍脱敏。Schema 的关键字、类型与参数标识保持调用契约，描述/default/examples 等自由内容脱敏；日志不保留可能回显参数的远端 RPC 错误正文。
- **真实取消**：工具执行、资源/提示词与 JSON-RPC 透传 AbortSignal；取消及时结束对应 pending，请求发出后发送 `notifications/cancelled`，HTTP 同时关闭该请求而保留其它并行请求。超时与用户取消分别记为 timeout/cancelled，迟到响应不能重新结算或触发重试。GUI 试跑取消与模型中断接入此路径。取消不承诺撤销服务端已经完成的副作用；TUI restart/enable/disable 等管理操作不支持 Esc 中断，会保持忙碌并明确提示等待。
- **事件一致性**：v1.16 的 17 类 MCP 事件进入登记、schema、回放 fixtures 和同一展示描述符；CLI/TUI/GUI 使用统一 serverId/status/method/requestId/durationMs 等字段。普通 debug/info 诊断默认不刷对话流，warn/error 可见；完整历史保留在诊断入口。该版本的 `input_required` 是预留事件；v1.17 实际表单契约见下节。

### 6.2 v1.17 MRTR、人工表单与订阅（2026-10-06）

**协议依据**：本次重新核对官方 [MRTR](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr.md)、[订阅](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions.md)、[Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http.md)、[stdio](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md) 与 [2026-07-28 schema](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/2026-07-28/schema.ts)。不使用独立的 `subscriptions` 服务能力位；订阅过滤来自各类能力的 `listChanged`。

- **MRTR 范围**：仅允许 `tools/call`、`resources/read`、`prompts/get`。Modern 请求按配置宣告 `clientCapabilities.elicitation.form`，Legacy initialize 不宣告此能力。收到 `resultType:"input_required"` 后，broker 先校验全部 `inputRequests`；每份仅支持 `elicitation/create` 的 form 模式。每次确认重试使用新的 RPC ID、保留最初业务参数，`requestState` 仅回送当前轮服务端给出的字符串；不接受调用方自行注入的 `inputResponses`/`requestState`。仅有 `requestState` 的继续请求也必须显示空表单并确认。
- **有界等待**：每次调用最多 4 轮追加输入，每轮最多 8 份表单，内核最多同时保留 32 个待处理表单；表单逐份确认。每份默认等待 120 秒，配置范围 1–300 秒；工具执行的总超时、AbortSignal 或连接生命周期可先终止等待。禁用、移除、重启、注销、连接/配置/工具挂载身份变化、过期和重复响应均不能重放旧确认；工具目录变更立即取消旧表单。内核开始关闭时同步取消表单并拒绝新输入，不等待异步存储清理。输入流程只在当前内核进程存活，重启后需重新发起操作。
- **严格表单 schema**：顶层为 `type:"object"`、`properties`、可选 `required`/`$schema`，最多 64 个字段。字段支持 string、number、integer、boolean；单选支持 string `enum`、带 `const/title` 的 `oneOf`、旧 `enumNames`；多选仅支持字符串枚举数组（`items.enum` 或带 `const/title` 的 `items.anyOf`）。支持字符串长度、数值范围、数组项数及 email/uri/date/date-time 格式；拒绝嵌套对象、任意数组、未知约束和额外响应字段。显式 `$schema` 仅接受 2020-12 URI，default 保留为描述但不会自动填充。schema 与输入内容各最多 64 KiB UTF-8，每个输入字符串最多 16 KiB；MRTR 的整个 input_required 结果也受 64 KiB 限制。先做有界 JSON 深度/节点检查，再复制和校验，错误仅返回安全 `MCP_INPUT_INVALID`。
- **三端操作**：`kernel.mcp.listInputRequests()` 返回当前表单描述，`respondInputRequest(requestId,{action,content?})` 仅回应指定待处理请求；action 为 accept/decline/cancel，返回不含内容的状态确认。CLI/TUI 在 `agent.send`/批准续跑仍等待时处理表单；CLI 非交互输入立即 decline，交互终端隐藏输入并再次确认。TUI 使用独立于聊天历史的隐藏输入区，Enter 下一项、y 确认、n 拒绝、Esc 取消。GUI 在应用层显示来源明确的弹窗，适用于聊天和工具试跑；必须勾选确认才能提交，支持拒绝与取消。schema 校验失败可重新填写。
- **隐私与事件**：原始 `requestState`、输入内容只留内存，不进入会话事件、诊断文件、恢复记录或聊天草稿。描述字段经共享脱敏器处理；私有表单保留 schema 结构、字段标识、枚举值和校验边界，避免短答案脱敏改变后续表单的可选值。已提交输入及不透明状态加入当前内核的动态脱敏集合，覆盖原文与 JSON 转义回显；外部结构化内容中的布尔答案也脱敏，框架状态布尔值保持类型。该集合最多 4096 个值 / 512 KiB，达到上限需新建内核，不静默丢弃脱敏记录。新增 `input_resolved`、`subscription_status` 后，共 19 类 MCP 事件登记/schema/回放/三端描述符一致；输入事件仅携带 ID、serverId、method 和状态，内核生成的表单 UUID 不因短答案脱敏而改变。
- **Modern 订阅**：`subscriptions.enabled:true` 后，仅为服务端声明 `tools/prompts/resources.listChanged:true` 的类别发送一个 `subscriptions/listen` 长请求。10 秒内必须收到 `notifications/subscriptions/acknowledged`；通知和最终结果的 `_meta.io.modelcontextprotocol/subscriptionId` 需与该请求 ID 一致，通知还必须命中服务接受的过滤项。有效通知沿既有路径使列表缓存失效、重挂载工具；不订阅单个资源内容更新。HTTP 订阅必须使用 SSE，解析按单帧 64 KiB 上限处理长流，不累计无限正文；拒绝错误关联、提前通知、错误帧与无完成结果的断流。
- **取消与兼容**：Modern HTTP 取消关闭对应 HTTP 请求；stdio 发送 `notifications/cancelled`，均不影响其它请求。订阅在断线/注销/禁用/停止时清理；断流或确认失败不会自动循环重试，需用户重启该服务后重新订阅。两开关默认关闭，保留既有普通工具/内容与 Legacy 行为；不实现 URL-mode elicitation、Sampling、Roots 或 Logging，也不添加运行时依赖。取消不撤销服务端已经完成的副作用。

---

## 七、 架构决策与边界取舍

| 决策维度 | 选定方案 | 否决项 | 理由 |
|----------|----------|--------|------|
| 协议栈 | 手写 dual-era JSON-RPC | `@modelcontextprotocol/sdk` | 零运行时依赖铁律 |
| 协议目标 | **Modern 2026-07-28 + Legacy 回退** | 只做 2024-11-05 | 生态已双时代，单时代必被抛弃 |
| Transport | stdio + Streamable HTTP | 优先 SSE/WS | SSE 已 Deprecated；WS 非标准 |
| 能力顺序 | tools+治理+可靠性 → resources/prompts → MRTR elicitation | 一次做全 / 重做 Sampling | Sampling 已 Deprecated |
| 风险推导 | annotations（受信）≫ 关键词 | 只靠关键词 | 降误判；不受信仍保守 |
| 密钥 | `${input:*}` + 用户凭据文件 | 明文 env 进项目 | 防泄漏 |
| OAuth | 2.1 + CIDM + iss 校验 | 自造 token；只靠 DCR | 对齐现行鉴权 |
| Inkstone 作 Server | 非目标 | 本轮暴露工具 | 范围与权限面控制 |

---

## 八、 关键约束与安全考量

1. **零运行时依赖**不变（原生 `fetch`/`crypto`/`events`/`child_process`）。
2. **密钥**：不进日志/事件/IPC；redactor 覆盖 MCP 帧。
3. **SSRF**：远程 URL 与重定向全量校验。
4. **stdio**：`shell:false` + 环境白名单。
5. **destructive 不可永久自动放行**。
6. **annotations 不可信**：默认偏保守，受信 server 才可放宽只读自动放行。
7. **故障隔离**：单服务崩溃不击穿内核。
8. **MRTR / elicitation**：必须用户可见确认后回填；默认不启用。

---

## 九、 版本装箱总览（详见实施计划）

| 版本 | 主题 | 级别 |
|------|------|------|
| **v1.11.1** | Dual-era 探测 + Modern 最小握手面 + 可靠性/命名/结果修正 | patch |
| **v1.11.2** | 配置兼容与密钥输入（`.mcp.json`、`${input:*}`、三级作用域） | patch |
| **v1.12.0** | Streamable HTTP + SSRF/headers + 取消/重发 | minor |
| **v1.13.0** | tool annotations 治理 + 三级批准 + policy | minor |
| **v1.14.0** | resources + prompts + structuredContent/outputSchema | minor |
| **v1.15.0** | OAuth 2.1（CIDM + iss + refresh） | minor |
| **v1.16.0** | 可观测与三端收口 | minor |
| **v1.17.0** | MRTR elicitation（opt-in）+ 协议收齐 2026-07-28 | minor |

**口诀**：先 dual-era 保连通（11.x），再开远程（12），再收权限（13），再扩能力面（14），再上 OAuth（15），最后可观测与 MRTR（16–17）。
