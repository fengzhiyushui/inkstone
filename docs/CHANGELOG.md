# Changelog

本文件记录 Inkstone 的版本演进。自 **v1.0.0** 起采用[语义化版本](https://semver.org/lang/zh-CN/) `major.minor.patch`，判定规则见 [`docs/README.md` 版本命名规则](README.md#版本命名规则)。

维护约定：大版本（major）写能力总结；其下 minor / patch 各一条简要日志。大版本收官后只保留能力总结，细节看 [`docs/specs/`](specs/)、[`docs/plans/`](plans/) 与 git 历史。文档更新顺序见 [`docs/README.md`](README.md#文档维护顺序)：代码 → specs/plans → project-overview → 本文件 → 索引。

发布版本号以 [`package.json`](../package.json) 为准；`package.json` / `package-lock.json` / `src/theme.js` / `gui/src/App.jsx` 四处应一致。

---

## [Unreleased]

下一个补丁 / 小版本的变更在此累积；发布时按版本规则定级并移入带版本号小节。

---

## v1.16.0 — 2026-10-06 · MCP 诊断、工具试跑与三端完善（preview）

- **诊断 G1/G4**：结构化帧摘要、延迟和错误分类进入每进程 500 条 / 1 MiB 环形日志，项目内保留最近 8 个运行文件；参数/结果正文、OAuth 交换和原始 stderr 不落帧日志。CLI `mcp logs [server]` 提供过滤、近 N 条和 JSON，fresh 进程读取历史不连接服务；动态脱敏、存储错误提示和 JSON 结构键保护完整接线。
- **GUI/TUI G2/G3**：GUI 日志筛选/刷新/导出与 schema 表单/JSON 工具试跑；试跑走 supervised 权限引擎与 ToolExecutor，原始 inputSchema 子集校验、一次性批准、取消及结果截断。TUI `/mcp list|restart|disable|enable|logs` 不调用模型，管理操作保持 busy 并明确 Esc 边界。
- **事件与取消 G5**：17 类 MCP 事件登记/schema/回放与三端展示统一，正常诊断日志不刷对话流，警告/错误可见。AbortSignal 从工具与资源/提示词传至 JSON-RPC/HTTP，取消结束对应请求、丢弃迟到响应，保留其它并行请求。
- **验证 G6**：全量 **1674 通过、0 失败、0 跳过**；`npm run check` 检查 **623 个 JS 文件**，GUI 构建与 `git diff --check` 通过。覆盖 fresh CLI 历史读取、参数/脱敏/存储边界、TUI、事件回放、GUI host/IPC、试跑审批/生命周期、真实 stdio/HTTP/SSE 取消，以及聊天执行/验证/修复/审批续跑中断。修复 Windows 冒烟测试视口同步，保留真实 Inspector DOM 断言。四处版本同步为 `1.16.0`。
- **边界**：诊断只含结构摘要；试跑 schema 为有界子集，未知约束明确拒绝。待处理试跑最多 32 个、批准 5 分钟有效、参数/显示结果最多 64 KiB。TUI 重启/启停不支持 Esc 取消；请求取消不保证撤销远端已执行的副作用。MRTR 留待 v1.17。

---

## v1.15.0 — 2026-10-06 · MCP OAuth 登录与凭据隔离（preview）

- **OAuth F1–F4**：PR/AS metadata 及首次 401 challenge 发现、CIDM/预注册客户端与 DCR 兼容、S256 PKCE、state/iss 强校验、用户目录加密凭据及刷新；按 issuer/resource/client/scopes 隔离。OAuth 请求禁止重定向并复用 DNS 固定/SSRF；HTTP 仅允许显式放行的回环地址。
- **入口 F5–F6**：CLI `mcp auth <server> [login|status|cancel|logout]`，添加服务支持 `--oauth/--client-id/--scopes`；GUI 登录/取消/退出与完成后自动刷新，浏览器 URL 仅在主进程。状态事件进入 schema/回放契约，动态脱敏覆盖新旧 token 和错误。`mcp check` 改走实际 Hub 鉴权路径。
- **生命周期与接线**：登录自动挂载，注销卸载；取消/退出/切换 issuer 后，旧授权、刷新、连接与列表结果不能复活或覆盖新状态；注销不影响其他资源的同名服务器。传输错误及时结束对应 RPC，401 不再被超时掩盖。四处版本同步为 1.15.0。
- **验证 F7**：全量 `npm test` **1604 通过、零失败、零跳过**；`npm run check` 检查 **608 个 JS 文件**；GUI 构建与 `git diff --check` 通过。包含 26 项 OAuth 核心测试、真实内核/CLI/mock AS 集成和 GUI host/IPC/状态回归。
- **边界**：真实外部 IdP 未验证；用户目录 AES-GCM 密钥不等同系统密钥链；在途 AbortSignal、诊断/TUI `/mcp` 留待 v1.16，MRTR 留待 v1.17。

---

## v1.14.0 — 2026-10-06 · MCP 资源、提示词与输出校验（preview）

- **能力面 E1–E3**：resources list/read/templates、prompts list/get 贯通 Client → Hub → kernel；按已连接服务的 capability 动态挂载 `mcp_resources` / `mcp_prompts`，资源和提示词以普通 tool 内容进入模型上下文，外部 system 角色不会提升权限。能力缺失不发业务请求，内容服务可不提供 tools。
- **边界与缓存**：列表默认 5 页 / 200 项 / 1 MiB，read/get 默认 64 KiB；内存缓存最多 64 项 / 2 MiB / 5 分钟，遵守 ttlMs 并在断开/变更时失效。分页截断可续读，重复游标停止；`inkstone-page:` 仅当前客户端有效，不能跨 CLI 进程复用。
- **输出 E4**：有界 JSON Schema 2020-12 子集校验原始 structuredContent；未知断言、复杂正则、远程引用、缺失内容或不匹配明确报错。挂载 MCP 工具返回 ToolExecutor 的标准对象，修复原先返回字符串导致模型看不到结果的问题，并保留 isError/resultType/脱敏 metadata。
- **CLI / GUI E5**：`mcp resources|prompts` 支持分页上限、资源读取和提示词参数；GUI 增资源树、URI 模板、提示词浏览、预览与「放入对话」草稿，不自动发送。CLI/GUI 默认 1 页 / 50 项 / 64 KiB，按需连接目标服务。共享脱敏覆盖值、对象键、RPC 错误和 binary；异常服务描述符以错误呈现。
- **治理接线修复**：持久授权进入正常 runtime 与公开 tools.execute；工具配置归一化保留 risk；动态 add 保留 headers/allowlist/trust/tools；公开 add/remove 门面与 GUI 添加错误处理补齐。跨新 kernel 的真实批准回归覆盖 project/always、session 不持久化及 destructive 硬拒绝。
- **验证 E6**：本地 stdio mock → 内核 → 模拟模型完整验证资源/提示词上下文、错误脱敏、能力卸载；CLI、GUI host/IPC/草稿及权限/缓存/分页/Schema 回归通过。全量 `npm test` **1549 通过、零失败、零跳过**；`npm run check` 逐一检查 **596 个 JS 文件**，GUI 构建及 `git diff --check` 通过。check 脚本修复旧版 Node 多路径参数漏检。
- **版本边界**：OAuth 留待 v1.15，诊断与 TUI `/mcp` 留待 v1.16，MRTR 留待 v1.17。在途 AbortSignal 尚未接入 JSON-RPC，当前仍依赖请求前检查和既有 RPC 超时；不将其记为即时取消完成。

---

## v1.13.1 — 2026-10-05 · MCP 工具治理闭环与回归修复

> 补丁版本：修复 v1.13.0「三级批准」在产品中不可达的接线断裂，恢复被误改的 `autoApprove` 语义，并补上用户显式风险覆盖的逃生阀。

- **闭环：持久化授权真正生效**。v1.13.0 的 `policyGrants` 在内核里恒为 `null`、`validateApprovalScope` 无生产调用方，导致"本项目/永久"两个作用域在产品里**完全不可达**。现删除引擎中平行造的规则源，由 `mcp/tool-policy.js` 的 `asRules()` 把授权翻译成**引擎已在读取的 `projectRules` 规则形状**（`{id, tool, pattern?, decision}`），经 `createKernel` 的 `mergeProjectRules()` 注入。消掉一条冗余安全路径，同时免费获得与内置 `projectRules` 一致的参数作用域（`pattern` glob）。
- **三级批准入口**：批准请求新增 `category` 字段并经 `approval-request` → `executor` → `event-contract` → `agent-cards` 贯通到三端。GUI 审批卡片由单个「批准」按钮改为**仅本次 / 本项目 / 永久**三枚，破坏性工具时后两枚禁用并提示「destructive 不可持久放行」；CLI 在 TTY 下追问范围（`p`/`a`/其它），非交互调用方默认仅本次；TUI 行内追问 `[p]/[a]/其它`。授权经 `validateApprovalScope` 校验后落盘，被拒绝时**降级为仅本次并说明原因**，而非静默失效。
- **回归修复：`autoApprove` 语义**。v1.13.0 曾错误收紧为"仅 read 类工具才放行"，使存量 `autoApprove: ["write_file"]` 升级后每次都要重新审批（无声行为回退，且与发布说明不符）。现恢复 v1.11.0 语义：**不看类别，列入即放行**；破坏性工具仍由引擎硬拒绝。
- **逃生阀：`tools.risk`**。规格 §4.2 中「用户 policy」本就是最高优先级，但 v1.13.0 未落地，关键词误判只读工具（如 `create_backup`）时用户无从纠正。现支持在 server 配置的 `tools.risk` 中显式指定 `read`/`mutate`/`destructive`，可覆盖 annotations 与关键词推断；非法值忽略，覆盖记录在 `riskOverridden` 字段并透出三端。
- **策略文件**：用户级根可用 `DEEPSEEK_CODE_HOME` 覆盖（便于测试隔离与便携部署）；`always` 与 `project` 分别落 `~/.deepseek-code/mcp-policy.json` 与 `<root>/.deepseek-code/mcp-policy.json`，0600、原子写入、只记录 grant 不写密钥；损坏文件按空表处理（回到默认保守）。
- **测试**：新增 `mcp-policy-closure`（6 项，把「策略存储 → 规则 → 引擎」整条链走通）、`mcp-hub` 补 4 项（autoApprove 回归、tools.risk 覆盖）、`agent-cards` 补 1 项（category 贯通）；更新受 `category` 字段影响的 event-contract/replay 期望表。
- **顺带修复（AppFrame 布局陈旧测量）**：`AppFrame` 仅靠 ResizeObserver 推导 `viewport`，而在 headless / 高负载下程序化 `setSize` 后**元素盒子常常不变化**，RO 不触发，`viewport` 停在旧值 → 右栏拿不到列宽、dock 不渲染（GUI 冒烟的 Inspector 步骤因此偶发失败）。现改为：挂载即量一次、以 `window.innerWidth` 为准、并加 500ms 兜底补量。冒烟从偶发失败变为连续 3 轮稳定通过。

---

## v1.13.0 — 2026-10-04 · MCP 工具治理与权限

> 小版本发布：为 MCP 外部工具建立完整的治理体系 —— annotations 风险推导、服务器信任模型、三级批准与持久放行、破坏性工具硬约束、工具级开关，三端可配置可解释。

- **annotations 解析（D1）**：新增 `src/tools/mcp/annotations.js`。只把显式 `=== true` 的 `readOnlyHint` / `destructiveHint` / `openWorldHint` / `idempotentHint` 视为命中，数组/标量输入安全降级；`title` 仅作展示不参与判定。
- **信任模型（D2，核心安全语义）**：**server 未受信时其自报 annotations 一律不参与判定**，风险只由关键词兜底；受信后 annotations 才参与，且**只向更危险方向升级** —— `destructiveHint` 直接置顶，`readOnlyHint` 不能把已判定为写操作的工具降级（防误放行），`openWorldHint` 令风险 +1 且不越过 destructive。
- **三级批准（D3）**：新增 `src/tools/mcp/tool-policy.js`，支持 `session`（仅本次，不落盘）/ `project`（本项目，`<root>/.deepseek-code/mcp-policy.json`）/ `always`（永久，`~/.deepseek-code/mcp-policy.json`）；用户级可用 `DEEPSEEK_CODE_HOME` 覆盖。策略文件原子写入并收紧为 0600，只记录 grant 不写密钥；损坏文件按空表处理（回到默认保守）。**用户级优先于项目级**。
- **destructive 硬约束（D4）**：`validateApprovalScope` 拒绝为 destructive 授予 project / always，并返回 **fallback 到 session**（界面据此提示原因，而非静默失效）；权限引擎新增兜底安全网 —— 无论决策来自持久化策略、`autoApprove`、approval-cache、trust-store、项目规则还是默认矩阵，destructive 一律 deny。多个测试锁死各路径叠加也不能绕过。
- **工具级开关（D5）**：`tools.enabled` / `tools.disabled` 在挂载期生效，未启用/已禁用的工具**完全不挂载**（既不出现在 Agent 工具表，也不能被 registry 解析）。
- **权限引擎（D6）**：新增持久化策略决策分支（优先级高于 `autoApprove` 与会话缓存），`createPolicyContext` 透传 `policyGrants`；旧 `autoApprove` 行为对非破坏性工具保持不变。
- **三端（D7）**：CLI `mcp add --trust`（写入 `trust` 并提示"请只信任自己部署/审计过的 server"）、`mcp policy list|revoke <tool>`、`mcp list` 展示信任状态并提示持久放行入口；GUI「添加服务」弹窗新增**信任开关**，工具列表展示**风险徽章**（破坏性用 danger 色）、持久放行标记，以及"风险判定来自受信 server 的 annotations / 该 server 未受信，自报 annotations 已忽略"的来源说明。
- **测试（D8）**：新增 `mcp-annotations`（16 项：解析严格性、信任模型矩阵、失败优先、风险封顶）、`mcp-tool-policy`（13 项：开关、scope 归一、destructive 锁定、持久化/revoke/损坏容错）、权限引擎 7 项新不变式、hub 4 项真实挂载行为、CLI 5 项、GUI DOM 契约 1 项。
- **修复的缺陷**：`isToolEnabled`  / `resolveConfiguredScope` 原先直接吃**未归一化**的原始 `tools` 字段，`enabled` 为 `undefined` 会让 `.includes` 抛错，导致**整台 server 的工具全部挂载失败**；`config-loader` 归一化也会削掉 `trust`。均已修正并加回归测试。

---

## v1.12.0 — 2026-10-04 · MCP Streamable HTTP（远程接入）

> 小版本发布：把 MCP 接入从「本地 stdio 子进程」扩展到「远程 HTTP 服务」——统一传输抽象、标准 Streamable HTTP 请求头、请求级 SSE、逐跳 SSRF 校验与私网放行清单，并保留 legacy HTTP+SSE 兼容通道（标注废弃）。三端可配置、可自检。

- **传输抽象（C1）**：新增 `src/tools/mcp/transport.js`，把 stdio / Streamable HTTP / legacy SSE 收敛到同一契约（`start`/`send`/`close`/`getRecentStderr` + `message`/`error`/`close` 事件）。`McpClient` 改经工厂选择传输，**既有 stdio 调用方与测试零改动**。
- **Streamable HTTP 传输（C2）**：新增 `http-transport.js` + `http-client.js`：POST JSON-RPC、`Accept: application/json, text/event-stream`、标准头 `Mcp-Method` / `Mcp-Name` / `MCP-Protocol-Version`（协商后自动回填）、`Mcp-Session-Id` 会话捕获与回填；响应支持 `application/json`（含数组批应答）与 `text/event-stream`（请求级 SSE，一次 POST 可回流多条消息）。
- **断流语义（C3）**：新增 `sse.js`（SSE 解析器，支持多行 `data`、注释 keep-alive、跨 chunk 边界）。流中断判定为可重发错误并按 `retryOnStreamBreak` 重试；**不依赖 Last-Event-ID 续传**，而是发出全新 HTTP 请求，服务端不会命中旧请求状态。
- **legacy SSE（C4）**：新增 `sse-transport.js`，支持长连 `GET` + `event: endpoint` + POST 到 endpoint 的旧协议；标记 `deprecated` 并经 `server_deprecated` 事件、CLI 与 GUI 提示，推荐改用 `streamable-http`。
- **headers 与超时（C5）**：静态请求头与 `${input:*}` 模板（沿用 v1.11.2 的 inputs 体系）均可用于远程服务；请求级超时经 `AbortController` 中止，关闭时统一 abort 在途请求。
- **SSRF 加固（C6）**：`src/security/ssrf.js` 新增**私网放行清单**（精确 IP / CIDR / hostname），未列出目标仍 fail-closed；HTTP 客户端**逐跳校验重定向**，跨 origin 时自动剥离 `Authorization` 等凭据头；出站连接沿用 DNS 固定（pinned lookup）防 rebinding。
- **三端配置与自检（C7）**：`mcp add` 支持 `--url/--type/--headers/--allow-private`；`mcp check` 连通远程服务并显示协商协议；`mcp list` 标注传输类型与 legacy 弃用提示。GUI「添加 MCP 服务」新增**接入方式选择**（本地进程 / 远程 HTTP）与 URL、类型、请求头、私网放行字段，服务卡片展示地址与类型。
- **修复的接线缺陷（重要）**：`src/config.js` 的 `normalizeMcpServers` 原先只认 `command`，会把 `url` 型服务**静默丢弃**（远程 Server 永远到不了 hub）；`config-loader` 的归一化也会削掉 `allowlist`。两者均已修正并加测试锁定。
- **测试（C8）**：新增 `mcp-http-transport`（13 项：标准头、JSON/SSE 应答、通知 202、错误分类、断流重发、SSRF 逐跳与凭据剥离、会话 id、SSE 解析）与 `mcp-http-e2e`（7 项：mock Streamable HTTP 走通 discover→tools/list→tools/call、-32022 版本回退、SSRF 拒绝、工厂契约）；`mcp-hub` 增远程装配用例，`mcp-cli` 增 6 项远程命令用例，`mcp-config-loader` 增 2 项字段保留用例。
- **顺带修复**：`src/theme.js` 的 CLI 标语存在一处**已入库的编码损坏** ——「面向 DeepSeek 的本地 AI 编程 Agent」里「地」字丢失一个末位字节，导致该处渲染为替换字符（U+FFFD）。已按原始语义修复，并全库扫描确认无其它残留替换字符。

---

## v1.11.4 — 2026-10-04 · 测试夹具回收（临时目录零泄漏）

- **根因**：测试普遍用 `mkdtemp` 建夹具后从不回收，每轮全量测试在系统临时目录里堆 **282 个**孤儿目录；仓库历史上已累积 **13,937 个**（31 MB，最早可追到 2026-09-23）。
- **统一出口 `tests/helpers/tmp.js`**：导出与 `node:fs` 同签名的 `mkdtemp` / `mkdtempSync` 包装，创建即登记，进程退出（含 `SIGINT`/`SIGTERM`）统一回收；**仅回收 `os.tmpdir()` 之下的路径**，越界一律跳过，避免误删工作区内容。
- **全量迁移**：90 个测试文件统一改经助手取 `mkdtemp`，覆盖五种导入形态（具名导入 / 命名空间导入 / `promises as fs` / `createRequire` / 同步版）；两个夹具助手（`tests/unit/tui/helpers.js`、`tests/helpers/symlink-capability.js`）改为自清。
- **防回归闸门 `tests/unit/tmp-hygiene-guard.test.js`**：① 子进程实操验证退出回收真的生效（用隔离 `TMPDIR`，断言退出后无残留）；② 静态扫描全部测试，禁止任何文件绕过助手直连 `node:fs` 的 `mkdtemp`。两条都已做**反向验证**（关掉回收后闸门确实失败）。
- **结果**：全量测试临时目录泄漏 **282 → 0**（连续 3 轮实测），测试 1390 全绿。

---

## v1.11.3 — 2026-10-01 · 测试脚手架隔离与项目清单健壮性

- **冒烟测试不再污染真实项目清单**：GUI 冒烟此前用 `mkdtemp` 建临时项目后登记进**开发者真实的** `~/.deepseek-code/projects.json`，导致侧栏堆积大量已失效的 `dsc-gui-smoke-*` 死项目。现新增 `DEEPSEEK_CODE_GUI_PROJECT_REGISTRY_DIR`，冒烟模式默认把登记表落到临时目录（显式 env 优先）。
- **冒烟脚手架退出回收**：新增 `DEEPSEEK_CODE_GUI_SMOKE_CLEANUP_DIRS`，主进程在退出前回收临时项目根与 Electron userData（仅限 `os.tmpdir()` 之内，越界跳过并告警）；测试侧 `t.after` 兜底。
- **项目清单标记目录缺失**：`project-registry.list()` 新增派生字段 `missing`——MRU 历史中目录已被移动/删除的条目不再静默给出死路径，而是标记出来交由用户决定是否移除；目录恢复后标记自动消解。侧栏对缺失项目弱化显示并给出「目录缺失」标签与完整路径提示（中英双语）。
- **测试**：`project-registry` 补 3 项（缺失标记、派生状态消解、空 root 脏条目容错）。

---

## v1.11.2 — 2026-09-29 · MCP 配置作用域与密钥底座

- **多作用域合并**：`mcp/config-loader.js` 支持 session > project > user；兼容 `.mcp.json` 与 VS Code `servers` 键；冲突时项目配置优先并 warn。
- **`${input:*}` 密钥引用**：env/headers/args/url 可引用 `inputs`；`bindInputs` 优先显式 value → 凭据库 → default。
- **密钥卫生**：`auditConfigSecrets` 对项目/user 配置里的高熵字面量告警；凭据库 `~/.deepseek-code/credentials/`（0600），绝不进项目树。
- **Hub**：`loadConfigScopes` 可选装载、`setInputValue`/`listInputs`、工具级 `tools.enabled/disabled` 过滤；`kernel.mcp` 暴露 inputs API。
- **版本**：四处同步 `1.11.2`。

---

## v1.11.1 — 2026-09-29 · MCP dual-era 与可靠性加固

- **协议 dual-era**：`server/discover` 探测 Modern（`2026-07-28`）并自动回退 Legacy（`2025-11-25`…`2024-11-05`）；Modern 请求携带 `_meta` 版本/客户端元数据；处理 `UnsupportedProtocolVersionError` 重试；`clientInfo.version` 读 `package.json`。
- **结果语义**：识别 `resultType`、保留 `structuredContent`、`resource_link` 占位、`input_required` 前缀。
- **可靠性**：`list_changed` 增量 remount；超时发 `notifications/cancelled`；hub 有界并行初始化；曾成功连接后的指数退避重连（主动 stop/remove 不重连）。
- **命名**：工具名按规范 1–128 与 `A-Za-z0-9_.-`；超长 hash 唯一后缀，消除 64 截断碰撞。
- **事件**：`event-contract` 映射 `mcp:*` / `server_*`（status/tools/auth/error）。
- **版本**：四处同步 `1.11.1`。

---

## v1.11.0 — 2026-09-28 · MCP (Model Context Protocol) 外部工具接入体系

> 小版本发布：全面落地行业标准 MCP 协议，构建零外部依赖原生生态扩展底座。支持 stdio 进程管道通道、两级命名空间隔离与 DeepSeek Function Calling Schema 自动转换、外部工具统一接入权限护栏与人工审批挂起、同构 `config.json` 中的 `mcpServers` 配置，并在 GUI 侧边栏落地全新交互式 `McpView` 可视化中枢与 CLI `inkstone mcp` 运维子命令。

- **零依赖原生协议与传输通道（M1）**：
  - 手写实现标准 JSON-RPC 2.0 客户端（`src/tools/mcp/jsonrpc-client.js`），支持 Request/Notification/Response/Error 帧分发、递增序列 ID、超限超时熔断与连接断开自愈。
  - 封装跨平台 Stdio 进程管道传输层（`src/tools/mcp/stdio-transport.js`），通过 `readline` 换行分帧彻底根除粘包/半包；实施跨平台防孤儿进程清理（Windows 下递归清理进程树，POSIX 下 SIGTERM/SIGKILL 退避）；严格隔离系统敏感环境变量，防 API Key 凭证泄露；提供环形缓冲区捕获最近 100 行 `stderr` 诊断日志。
  - 实现标准 MCP 客户端连接实体（`src/tools/mcp/mcp-client.js`），严格遵循 MCP 规范完成 `initialize` 握手与 `notifications/initialized` 确认；提供 `listTools()` 与 `callTool()` 标准操作。
- **宿主管理器与动态工具注册（M2）**：
  - 实现多服务宿主管理器（`src/tools/mcp/mcp-hub.js`），统一调度多个 MCP Server 的生命周期、探活与一键重启，单服务崩溃异常隔离不影响主运行时。
  - 实现 Schema 转换器（`src/tools/mcp/schema-converter.js`）：实行两级命名空间隔离（`mcp__<serverId>__<toolName>`），校验函数名安全正则，清洗非标 JSON Schema 关键字并安全映射为 DeepSeek Function Calling 结构；将 MCP 执行结果清洗提取为 Agent 可读文本。
  - 扩展 `src/tools/registry.js`：提供 `mountExternalTools` 与 `unmountExternalTools` 扩展点，支持外部工具动态装载、查询与无缝执行代理。
- **统一安全护栏收敛与配置加载（M3）**：
  - 统一收敛至 `PermissionEngine` 与 `ApprovalCache`，外部工具严禁旁路运行；
  - 自动词义推导工具风险级别（`read` 自动放行，`mutate` 高危写操作在 `gated` 模式下强制挂起弹出审批卡片）；
  - 支持配置级 `autoApprove` 白名单机制；
  - 扩展 `src/config.js`，无缝兼容 Cursor / Claude Desktop 同构的 `mcpServers` 配置节点；在 `kernel-options.js` 打通配置透传链路。
- **三端协同与 GUI 可视化中枢实装（M4）**：
  - 重构桌面 GUI `McpView`（`gui/src/components/v4/SecondaryViews.jsx`），淘汰占位空态，提供服务卡片列表、健康状态微光灯、命令展示、动态工具目录展开与一键启停/重启交互。
  - 新增 **高端拟态添加服务弹窗（`AddMcpModal`）** 与常用模版快捷芯片（Filesystem, Fetch, Memory, SQLite, GitHub），支持自定义参数、环境变量与白名单直观配置与错误即时诊断。
  - 支持卡片级一键删除服务，配合拟态确认弹窗，实现从内核热卸载与 `.deepseek-code/config.json` 的双向持久化同步。
  - 打通 Electron IPC 全双工契约（`mcp:list`, `mcp:restart`, `mcp:toggle`, `mcp:add`, `mcp:remove`）。
  - 新增 CLI `inkstone mcp [list|check|add|remove|toggle]` 运维子命令，支持快速自检、参数配置写入与状态切换。
- **全量质量与回归验证（M5）**：
  - 新增 30 项 MCP 专项自动化测试（含协议、传输、生命周期、动态热插拔增删与 CLI 命令验证）；
  - 全量 1355 项测试套件 100% 绿灯通过；
  - 版本号四处严格同步至 `1.11.0`（`package.json`, `package-lock.json`, `src/theme.js`, `gui/src/App.jsx`）。

---

## v1.10.0 — 2026-09-26 · 响应式自适应 + 窗控全透明 + Phosphor Icons + 项目与会话安全删除 + 高端拟态确认弹窗 + 全局字体系统升级

> 小版本发布：全面升级 IDE 视觉与交互体验，包含高密度工程级图标体系替换、Windows 原生窗控毛玻璃全透明化、中窄视口布局防挤压防截断、左侧栏与多视图项目/会话删除全链路闭环、高端拟态确认模态框（ConfirmModal）、以及全局中西文排版与基线对齐重构。

- **高端拟态确认弹窗与主进程状态联动（ConfirmModal）**：
  - 彻底淘汰与 IDE 现代设计割裂且阻断渲染主线程的 Win32/Electron 原生灰底 `window.confirm` 弹窗。
  - 基于 `high-end-visual-design` 与 `ui-ux-pro-max` 规范，实现全新 `ConfirmModal.jsx`：
    - **双层卡片材质**：14px 细致圆角、MACHINED 微质感内边框与深度弥散柔和投影（`cm-card`）；
    - **毛玻璃环境遮罩**：`backdrop-filter: blur(8px)`，在全仓 10 套深浅主题下自然透射底层界面光晕；
    - **危险语义与关闭徽标**：半透明红底光晕的 `<Trash />` 危险徽标与右上角静音关闭按钮；
    - **安全交互机制**：默认将焦点安全聚焦于“取消”按钮防止误回车，支持 `Escape` 取消与 `Enter` 快捷确认，支持点击遮罩平滑退出；
    - **原生窗控协同**：弹窗挂载与销毁时全生命周期同步 `window.api.setModalActive(true/false)`，保持无边框顶栏激活态与透明度完美一致。
  - 在 `App.jsx` 顶层统一提供基于 Promise 的 `requestConfirm` 调度接口，侧边栏、项目管理面板全面接入，并配齐中英文双语警告副文本。
- **全局字体栈与排版体系重构**：
  - **消除中西文垂直基线漂移**：重构 `--font-ui`，优先引入微软现代界面字体 `"Segoe UI Variable Text"` 与针对 UI 控件定制字高/内边距的 `"Microsoft YaHei UI"`，彻底解决 Windows 平台英文/数字与中文同排混排时的忽高忽低与晃动感。
  - **杜绝 UI 界面 Monospace 代码字体滥用**：移除侧栏会话计数、事件时间戳、状态角标上宽体 `Cascadia Code` 的滥用，全面改用现代排版标准 `font-variant-numeric: tabular-nums`，在确保数据整齐等宽对齐的同时，字形与中文平顺融合。
  - **高精度排版与平滑渲染**：全局启用 `-moz-osx-font-smoothing: grayscale; text-rendering: optimizeLegibility;` 与 OpenType 字形微调特性 `font-feature-settings: "cv02", "cv03", "cv04", "cv11"`；将主标题套用的西文负字距（`letter-spacing: -0.02em`）修正为符合汉字阅读的舒适正字距 `0.02em`，消除汉字挤压感。
- **项目与会话删除能力全链路落地**：
  - **内核与数据持久化安全保障**：在 `session-index.js` 中新增 `deleteSession(sessionId, { projectRoot })`，安全卸载内存会话、从倒排索引与项目关联列表中解绑，并将磁盘记录物理归档至 `.trash/sessions`，防止误删不可逆；扩展 `removeProject(root)` 契约。
  - **主进程与 IPC 桥接**：在 `kernel-host.js`、`main.js`（IPC 白名单 `sessions:delete`）、`preload.js`、`useKernel.js` 中打通全双工异步调用链。
  - **左侧栏交互与悬浮感知**：在 `Rail.jsx` 项目卡片头与会话列表项中增加低侵入式悬浮操作按钮（`.pdel` 与 `.sdel`），结合 `onRequestConfirm` 实现平滑优雅的删除体验。
- **Windows 原生窗控（titleBarOverlay）全透明化与 100% 主题融合**：
  - 将主进程建窗（`createWindow`）、模态开启关闭（`gui:modal-active`）及主题切换（`gui:preferences-set`）全路径的 `titleBarOverlay.color` 彻底设为全透明（`#00000000`），仅依据明暗主题自适应切换 `symbolColor`（暗色/模态使用 `#f1f5f9`，浅色使用 `#0f1115`）。
  - 彻底根除全屏模态遮罩下右上角突兀的矩形系统色块，让全屏毛玻璃遮罩及顶栏背景色自然透出，原生窗控最小化/最大化/关闭按钮悬浮其上，系统 hover 与关闭红色悬停态完美保留。
- **前端图标全面升级为 Phosphor Icons**：
  - 移除旧有 `lucide-react` 依赖，引入更具现代工程感与高信息密度美感的 `@phosphor-icons/react`。
  - 全面平替覆盖 Rail 侧边栏、Chat 消息流、卡片体系（工具/计划/差异/审批/编排/思考/测试）、Composer 工具行、Dock 五大面板、Diff 对比视图及 Settings 7 大设置面板等 20 个前端视图组件。
- **响应式布局自适应修复**：
  - **输入栏（Composer）操作区防挤压与发送按钮防溢出**：`.row` 统一添加 `width: 100%; max-width: 100%; box-sizing: border-box; flex-wrap: wrap; row-gap: 8px`；`.rightGroup` 添加 `max-width: 100%; min-width: 0; flex-shrink: 1; margin-left: auto;`；`.modelPill` 采用弹性收缩并在 `span` 上优雅单行截断；发送按钮保持 `flex: none; flex-shrink: 0;`。杜绝窄视口下发送按钮脱离卡片溢出悬挂。
  - **右侧 Dock 栏负坐标裁切根治与 Tab 防折行**：`.dock` 升级为 `position: absolute; inset: 0; width: 100%; box-sizing: border-box;`，自适应填满网格列；`.tabbar` 间距紧凑化并支持平滑横向滚动，`.tab` 强制单行不折行；全屏次级视图（项目管理、主页等）自动与会话 Dock 空间解耦。
  - **项目与恢复列表按钮自适应**：全局 `.btn` 强制 `white-space: nowrap; flex-shrink: 0`；引入 `.ai-info` 与 `.ai-actions`，彻底根除操作按钮被挤成 1 字符宽竖列的缺陷。
  - **设置页导航指示条**：修复设置导航切换时激活高亮丢失问题，加入立体 accent 竖条指示槽。
- **全栈版本与测试守护**：
  - `package.json`、`package-lock.json`、`src/theme.js`、`gui/src/App.jsx` 四处版本一致同步至 `1.10.0`。
  - 新增 `v1100-responsive-layout.test.js` 专项回归测试，全量单测 **1325 / 1325 全部 PASS**，GUI 生产构建零警告零报错通过。


---

## v1.9.0 — 2026-09-24 · 契约冻结 + 多智能体可视化 + 模型适配

> 小版本：事件契约三角锁死（schema/守卫/fixtures）、GUI Agent Inspector 与轨迹时间线、TUI 分支/回退对齐、FIM 双端落地，以及 DeepSeek 现网协议适配（默认模型 ID、reasoning_content 回传、thinking 参数、退避重试）。实施计划与 D1–D6 拍板见 [`plans/architecture/2026-09-23-v1.9.0-contract-freeze-and-visualization.md`](plans/architecture/2026-09-23-v1.9.0-contract-freeze-and-visualization.md)。

**契约冻结（M1）**：新增 `src/sessions/event-schemas.js`——64 类登记事件全覆盖的零依赖 schema 注册表（required 只收恒定发射键、`validateEvent` 永不抛错、未知键放行）；覆盖率守卫 14 项（登记表↔schema 双向锁死 + `describeEvent` 非静默回落 + QUIET_TYPES 白名单，**双向变异验证实际执行**）；回放 fixtures 68 样本 ↔ schema ↔ 展示契约 ↔ GUI 派生四向锚定。`model:response` 顶层键集一次定稿：+`reasoning`（500 字截断）/`tps`/`session_id`/`latency_ms`（三处生产点 + 描述符同步，cache/reasoning token 继续走 `usage` 不占顶层键）。fixtures 守卫发现 4 个 `experience:*` 事件有生产者却未登记，已补登记闭环。运行期可选严格模式（`events.strictSchema` 默认关、只告警不阻断落盘）。

**现网燃眉修正（M1-P0）**：默认模型 ID 收敛单一常量源 `model-ids.js`——`act`/`fim` 默认 `deepseek-v4-flash`（已退役）→ **`deepseek-flash`**，`think` 维持 `deepseek-v4-pro`（D4 不临时降档）；退役迁移仅精确键匹配、仅内存归一不重写 config.json、第三方端点 id 原样直通。**`reasoning_content` 回传**（修现网 400）：带 tools 的多轮对话此前 iteration 1 必被官方 API 判 400。GUI 模型下拉移除两个 2026-07 已停用的死 ID；FIM 兜底 id 同步 + max_tokens 钳制 ≤4096。

**GUI Agent Inspector（M2）**：右栏 Dock 第 5 tab「检查器」——纯派生五区（优先条/计划/工具 call↔result 配对/审批/时间线）；会话头「轨迹」tab 接真实 `session:timeline`（共享虚拟列表）；审批区补 `agent:list-paused` IPC 桥；遥测分列（cacheMiss/reasoningTokens/TPS 段 + `tpsDecimals`）；**修 CONTEXT_WINDOW=128000 硬编码** → 按模型推导（现行代际 1M），1M 上下文下用量条不再在 12.8% 处显示 100%。

**TUI 对齐 + FIM 双端（M3）**：新增 `/branch`（list/switch/new）与 `/rewind`（检查点 list/preview/apply）slash 命令，分支/回退经内核事件入时间线、三端同一事件卡；`inkstone fim --prefix/--suffix/--file/--max-tokens/--model` 与 TUI `/fim` 落地（Q3/D3：不进编辑器），组合根 `fim` 门面附加、八目录零改动。

**模型适配（M4）**：think 通道（plan/review/repair）不再发送静默无效的 `temperature`；`reasoning_effort` 归一重构——合法全集 `none/low/medium/high/max` 原样透传，废弃 low/medium→high 折叠；`config.json` 新增 `betaBase`（FIM 端点根可配，默认行为不变）；think 通道 max_tokens 8192→32768，`finish_reason:"length"` 挂 `truncated`；`.retryable` 分类**首次接上退避执行端**（3 次尝试、500ms→1000ms 指数退避、402/4xx/超时不重试、usage 只记最终 attempt）；jsonMode 空 content 重发一次；TUI 状态行 `r:N tok`/`tps` 段、CLI 终局 usage 摘要（`INKSTONE_SHOW_USAGE` 门控）。

**运维**：v1.8.4 / v1.8.5 / v1.8.6 三个漏打版本补齐注解 tag（属 v1.8 线欠账，循 v1.5.2 先例）。

全量回归 **1139 → 1314 单测**（0 失败）；`npm run check`、renderer build、gui-smoke（含 inspector 景）全过；八目录改动全程白名单管控。

---

## v1.8.7 — 2026-09-23 · 文档全量重写与原型存档清理

> 补丁：对照当前代码重写 `docs/` 全部 Markdown，压缩历史实施计划，删除 `docs/prototypes/`；版本号四处对齐 1.8.7。不改功能面。

- **docs 全量重写**（约 2.7MB → 0.58MB）：顶层 `README` / `DEPLOYMENT_AND_USAGE` / `project-overview` / 本文件结构与事实校准；`specs/**` 40 篇统一元信息头与「问题/决策/设计/边界/验收」骨架；`plans/**` 历史计划收成「目标/结果/关键决策/验证」摘要。配置默认值、15 个内置工具、约 65 类会话事件对齐 `src/`。
- **去 AI 腔与压缩**：清理翻案腔、空转冒号、起手式等；历史 plan 去掉逐步 checkbox 流水。
- **清理 `docs/prototypes/`**：删除 v1.4 设计稿、v1.8 截图基线、`DeepSeekCodeIDE.jsx`、`preview-deepseek-code/`（含依赖残留）；文档引用改为「已清理」。
- **删除过时计划**：`future-gui-deepseek-code-ide-redesign`、`gui-frontend-optimization-plan`（被 v1.8 现役壳层取代）。
- **版本四处同步**：`package.json` / `package-lock.json` / `src/theme.js` / `gui/src/App.jsx` → `1.8.7`。

---

## v1.8.6 — 2026-09-23 · 侧栏收放体验修复与对话框系统功能归位

> 补丁: 彻底修复侧栏收起态菜单穿透与逐字折行排版错位，完善双向展开交互；输入对话框底部剥离全局系统级控件，归位至左侧栏底座。

- **左侧栏收放体验修复 (Rail Collapse & Expand Polish)**：
  - 为新会话弹层（`newwrap`）挂载 `mousedown` 点击外部区域与 `Escape` 键自动关闭监听，并在侧栏收起时自动重置 `newMenu` 为 `false`。
  - 样式层强化 `.collapsed` 状态下隐藏未关闭菜单及次级文本，并为弹层增加 `min-width: 220px` 保护，彻底根除 56px 收起态下文字垂直挤压覆盖底部的严重排版错位。
  - 侧栏顶部收起态保留 Logo 与展开按钮（`PanelLeftOpen`），配合底座展开按钮实现顶部与底部双向畅通展开。
- **对话框系统功能剥离与纯粹化 (Composer Layout Refactor)**：
  - `MetricsLine` 引入 `inComposer` 模式，在输入框卡片内彻底过滤「形态切换（`T 文字`）」、「主题切换（`Palette`）」与「语言切换（`Languages`）」，并不重复渲染上方操作区已有模型与分支 Pill。
  - 输入框底部仅保留纯粹的工作区指标与运行状态（检查点数、连接就绪状态、上下文容量占比与缓存命中率），恢复清爽聚焦的输入体验。
  - 严格校验 `statusDisplay.position` 配置，仅在允许在 Composer 展示时渲染该行。
- **系统级功能归位至侧栏底座 (Rail Footer Controls)**：
  - 将主题快速切换（`Palette`）与语言切换（`Languages`）入口标准化归位至左侧栏底部（Rail Footer），展开态（横排）与收起态（竖排）均可一键直达切换，且保持 Settings 为最后一项。
- **文档名实对齐与部署指南完善**：
  - 更新中英文 README、DEPLOYMENT_AND_USAGE 与架构文档，名实对齐 v1.8.6 最新架构。

---

## v1.8.5 — 2026-09-23 · GUI 架构缺陷闭环与烟雾测试 (缺陷报告修复 G1-G9)

> 补丁: 彻底修复评估报告指出的所有 GUI 架构缺陷，打通 Diff 查看、工具卡配对、Plan 计划面板集成与全链路自动化烟雾测试。

- **G1 Diff 变更比对完整闭环**：`ChangesPanel.jsx` 正确挂载 `ChangeDiffView`，修复原本在变更列表中点击文件无法展示 Diff 视图的严重阻断。
- **G2 工具卡严格配对 (Tool Call Pairing)**：`agent-cards.js` 重构为严格按 `call.id` ↔ `result.call_id` 字典配对，彻底根除跨轮次工具卡乱序错配缺陷。
- **G3 Dock 计划面板打通集成 (Plan Panel Route)**：`DOCK_TABS` 与 `GUI_DOCK_TABS` 注册 `"plan"`，创建专属 `PlanPanel.jsx` / `PlanPanel.module.css` 选项卡，恢复计划面板可达性。
- **G4 工具执行结果兼容与耗时遥测**：工具卡状态全面兼容 `ok` 与 `success`，并准确提取 `duration_ms` 耗时遥测指标。
- **G5 跨项目切换重置闭包状态**：项目切换时清空历史活动流、消息列表与卡片集合，防止残留前一项目数据。
- **G6 编排事件注册白名单**：`event-contract.js` 将 `orchestration:*` 事件规范注册进 `SESSION_EVENT_TYPES` 与 `GUI_RECEIVE_CHANNELS`。
- **G7/G8 分支标识与国际化补齐**：`strings.js` 补齐 `dock.branch` 与 Composer 所需的 12 项 i18n 键值，消灭未定义占位。
- **G9 Electron 全链路真实拉起冒烟测试**：`tests/e2e/gui-smoke.test.js` 真实拉起 Electron 实例，自动覆盖并验证 Plan 面板、Diff 预览、工具卡渲染与项目切换等核心路径。

---

## v1.8.4 — 2026-09-23 · 内核与数据完整性保障 (缺陷报告修复 K1-K14)

> 补丁: 彻底修复评估报告指出的所有 P0/P1/P2 级内核缺陷，涵盖事务日志、符号链接、补丁保真、进程超时、缓冲安全与防篡改校验。

- **K1 事务半提交补偿回滚 (Transaction Journal)**：`transaction-journal.js` 在 `commit()` 失败时自动执行快照补偿回滚，避免留下半提交损坏数据。
- **K2/K11 符号链接与目录联接保全 (Symlink Preservation)**：恢复原子写入改为 `lstat` 判断并直接重连符号链接/联接点，严禁将软链接毁损为常规文件。
- **K3/K4 补丁尾换行与 CRLF 换行符字节保真 (Patch EOL Fidelity)**：修复 `patch.js` 的 `joinLines` 拼接条件与 CRLF 字节保真，跨平台应用补丁不增删多余尾换行。
- **K5 子进程超时真正取消 (Process Cancellation)**：`runWithTimeout` 引入 `AbortController` / `AbortSignal`，超时触发时立即强制终止底层子进程树，防止僵尸进程。
- **K6 Shell 标准流缓冲溢出防御 (Stream Buffer Safety)**：Shell 执行器收流时设置 `maxBuffer=64000` 截断，防止大体积命令输出耗尽进程内存 (OOM)。
- **K7 编排器依赖失败跳过 (Orchestration Dependency Guard)**：编排调度循环在子任务失败后，自动将标记为依赖该失败任务的下游子任务标记为跳过，不再盲目派发。
- **K8/K9 路径穿越精准检测 (Path Safety)**：路径安全性检测改为标准路径段解析，杜绝将含 `..` 的合法目录名（如 `test..dir`）误判为目录穿越。
- **K10 事务回滚清理空目录**：在回滚删除新增文件后，递归自底向上清理因回滚产生的孤儿空目录。
- **K12 快照前值回滚允许**：只要存在合法的 `before` 快照，无条件允许执行原子回滚。
- **K13 事件日志 64-hex SHA-256 全量哈希与链式防篡改校验**：全量升级为标准 64 字符 SHA-256 哈希，并通过 `verifyEventLog` 严格校验哈希链。
- **K14 空权限规则拒绝放行**：权限引擎中空模式规则一律拒绝放行，杜绝意外越权。

---

## v1.8.3 — 2026-09-22 · 前端审查修复(生成物一致性 / 样式迁回补完 / 死代码清理)

> 补丁:逐条修复 v1.8.1–v1.8.2 的 code review 问题清单;内核零改动(八目录 diff 为空)。刻意偏离原方案的三处理由见对应条目。

- **生成物一致性**:`src/apps/tui/theme-palette.js` 与 `tokens.css` 失同步——v1.8.2 把 `paper --warn` 改回 `#ad8301` 却未重跑生成器,TUI 仍显示旧色号 214。生成逻辑抽为纯函数 `buildPalette` / `buildPaletteBody`,新增守卫断言**生成物与源逐字节一致**;重生成后为 136。
- **闸门自证**:`check-theme-contrast.mjs` 的 `EXTRA_GATE` 此前导出后从未被引用(死代码,注释理由亦与 v1.8.0 不符)。重构出通用 `checkPairs`,附加两对改由单测守护(20/20);新增「`GATE` 恒为 11 对」用例锁定 110 项口径。`110/110 PASS` 契约不变。
- **样式迁回补完**:v1.8.2 的人工 `REQUIRED` 清单漏掉 `.cz-meta.compact`(**compact 偏好因此整体失效**,含窄窗隐藏规则)、`.api-item .ai-ic`、`.f-in.short`、`.f-in.mid`。改用**自动守卫**(从当前 JSX 反推类名,ALLOW 须给理由),漏项全部迁回;刻意不迁回已无引用的 `.api-item.off .ai-ic` 与恒被内联 style 覆盖的 `.seg.acc`。
- **`undefined` 类名**:`ChatView` 的 `css.mode` 在 `ChatView.module.css` 中不存在 → className 会渲染出字面量 `undefined`。删除 `css.mode` 与失效的 `acc`(外观由内联 style 不变);新增 CSS Module 成员守卫。
- **守卫有效性**:迁移守卫取代人工清单,W1/W2 迁回结果钉为防回退断言;`no-dsh-imports.test.js` 扩展覆盖 `main.js` / `preload.js` / `kernel-host.js`;`dom-contract.test.js` 记录 `.shell` / `.rail-off` 为「无样式结构钩子」。
- **symlink 用例平台门控**:实测本机 junction 可创建但 `realpath`/`stat`/`scandir` 全抛 `UNKNOWN`,测试前提无法建立 → 按仓库既有惯例(无 Electron / 无 node-pty 则 skip)加能力门控,**断言本身未削弱**;`npm test` 由 2 失败转为 0 失败(2 环境性跳过)。
- **死状态清理**:`railMode` / `railView` / `contextCollapsed` 与三个对应 action、`RAIL_MODES` / `RAIL_VIEWS` / `GUI_RAIL_MODES` 仅存在于状态层、零组件引用,随 v1.8.1 三列壳层一并退役;旧偏好文件中的残留键被归一丢弃。
- **文档**:修复 `docs/README.md` 版本行被截断(行首 `当前版本 **v1` 丢失、残留 `.8.2**(...)`);当前版本 → v1.8.3;恢复 `[Unreleased]` 小节。另修 `contrast.js` 残留注释、`theme.js` EOF 换行、本文件 `ode` → `node` 错别字。
- 全量回归 **1139 单测**(0 失败 / 2 环境性跳过)+ `npm run check` + renderer build + gui-smoke(`GUI_SMOKE_READY`)通过。

---

## v1.8.2 — 2026-09-20 · 前端缺陷修复(样式迁回 / 按键 / 溢出)

> 补丁:修复 v1.8.1 code review 问题清单中的前端样式、按键与溢出缺陷;内核零改动。对比度闸门恢复 **110/110**(node scripts/check-theme-contrast.mjs);色值权威为 v1.8.0 plan 附录 A。

- **P0 闸门与列宽**:对比度脚本恢复 11 对 × 10 套 = 110 项;paper 的 warn 按附录 A 改回 #ad8301;clampWidth 在 max < min 时保下限;右栏拖拽/持久化加上限 RIGHTBAR_MAX=1600 与 clampRightbarWidth。
- **P1 样式迁回**:补回 B4 删 shell.css 后丢失的敏感模态 .sn-*、侧栏 .sec-body.closed/.proj-b 收放、项目/会话省略号、.new-menu、.s-body/.s-in、改动双栏、.th-detail、首页问候渐变;守卫测试 shell-styles-restored.test.js。
- **P2 按键交互**:事件卡去掉嵌套 button(操作钮外置);全局快捷键经 hotkeys.js 在输入态/设置/敏感模态下放行;分隔条可键盘微调;分区头/新会话菜单改 button;Composer Esc 失焦、附件钮不再误插 @;首页「改动」改开右栏 dock;VIEWS 与主区路由对齐。
- **P3 溢出布局**:气泡/正文 overflow-wrap:anywhere;stream/composer 内容宽按 920+padding 校正;dock tab 条高度 40px;右栏列宽 <300 时不渲染 Dock;文件树缩进上限;消息流上限 200 条。

---

## v1.8.1 — 2026-09-20 · 壳层重构(三列 dock + 设置模态 + 中性阶梯)

> 小版本:换壳层布局与视觉语言,信息架构保留;内核零改动(八目录 diff 为空)。计划见 [`plans/frontend/2026-09-20-v1.8.1-dsh-shell-plan.md`](plans/frontend/2026-09-20-v1.8.1-dsh-shell-plan.md),设计见 [`specs/frontend/2026-09-20-v1.8.1-dsh-shell-design.md`](specs/frontend/2026-09-20-v1.8.1-dsh-shell-design.md)。**合入 main、打 tag 由维护者完成。**

- **B0 壳层骨架**:三列可拖拽 grid(`columns.js` 纯函数 + `AppFrame`/`DragHandle`)+ 40px 原生 `titleBarOverlay` + 首帧防闪(`?boot=` + `--boot-bg`)+ 零 DSH 引用守卫(`no-dsh-imports.test.js`);偏好新增 `sidebarWidth`/`rightbarWidth`/`rightbarOpen`/`dockTab`。
- **B1 token 重铺(C 变体)**:结构槽明/暗两档中性阶梯(明 `#ffffff` / 暗 `#151517` 等 10 槽);10 主题 id 保留,只贡献 accent/语义色;对比度闸门改为 structure 2×7 + accent 10×4 = **54 项**;`theme.css` 增加派生量(`--hover`/`--border-l*`/`--shadow-*`/`--bubble`)与 `data-dark` 覆盖。
- **B2 侧栏 + 会话页**:Rail/Chat/Composer CSS Modules 数值对齐;会话头 `SessionHeader`(tab 对话|轨迹,轨迹空态占位);滚动条 `scrollbar.css` 双路径;`.cz-meta` 决策①不动。**上下文圆环未做**(计划允许跳过;`STATUS_FORMS` 仍为 5)。
- **B3 右栏 dock**:`Dock` + 文件树/改动/恢复三面板(`treeFromPaths` + `tree_dir_toggled`);侧栏「改动/恢复」改为开右栏;`Ctrl/⌘+J` 正式化;主区 `view===changes|recovery` 路由删除。
- **B4 设置模态 + 收口**:设置从全窗改模态(`settingsOpen` + `settings_toggled`,`Ctrl/⌘+,`);删除自绘 `TitleBar.jsx` 与 `shell.css`(样式迁入 `theme.css`);`ThemeHub.jsx` 并入 `Appearance`;`window:*` IPC 删除;dom-contract/smoke 门重做(AppFrame 8 选择器);版本四处 → `1.8.1`。
- 全量回归通过;`settings.back` 等 TitleBar 专用文案键保留字典(双语 parity),运行时不再引用。

---

## v1.8.0 — 2026-09-20 · 工学换肤(Electron 壳层 v1.8 γ)

> 小版本:**换视觉语言,不换信息架构**。内核零改动(`src/core src/deepseek src/tools src/edits src/sessions src/context src/security src/workspace` 八目录 diff 为空)。计划见 [`plans/frontend/2026-09-17-v1.8.0-ergo-restyle-plan.md`](plans/frontend/2026-09-17-v1.8.0-ergo-restyle-plan.md),设计见 [`specs/frontend/2026-09-17-v1.8.0-ergo-restyle-design.md`](specs/frontend/2026-09-17-v1.8.0-ergo-restyle-design.md)。

- **10 主题重编为四段带**:暗 3(`sumi`/`slate`/`vesper`)· 柔暗 2(`nord`/`ash`)· 柔明 2(`snow`/`sand`)· 明 3(`lotus`/`latte`/`paper`);保留 `sumi`/`nord`/`latte`/`paper` 四套原值,新增 6 套,退役 6 套(`dawn`/`mocha`/`moon`/`forest`/`clay`/`rose`,旧 id 静默迁移)。
- **对比度闸门常驻**:`scripts/check-theme-contrast.mjs` 的 11 对 × 10 套 = 110 项升级为单测(`110/110 PASS`);亮度/对比度实现单一来源 `gui/src/state/contrast.js`,GUI 设置›外观的运行时实测同源复用。
- **三端主题 id 单源**:GUI `themes.js`(新增 `TIERS`/`themesByTier`)、reducer、`kernel-host` 偏好归一(`lastDark`/`lastLight`/`glass` 三键)、TUI `theme-palette.js`(由 `scripts/gen-tui-theme.js` 从 tokens 生成)、i18n 字典全部对齐;新增 `theme-pins.test.js` + `dom-contract.test.js` 冻结 DOM/类名契约。
- **壳层视觉层(P1)**:新增主题中枢 `theme-hub.js`(同组轮换 / 跨模式切换 / 退役 id 归一);标题栏去硬编码色(4 处 `#8884` → `color-mix`、关闭键 → `--err`、下拉阴影令牌化);composer 聚焦柔光;浮层玻璃态(`glass` 偏好 + `[glass="on"]`,冒烟经 `?smoke=1` 强制关);`.sn-*` 模糊 2px → 6px 并补通用模态壳。
- **卡片两段式与推理摘要卡(P2)**:卡片头由 `div` 改 `<button type="button">`(a11y 欠账);工具卡显示真实耗时(`event-contract` 的 `tool-result` 新增 `durationMs`);审批卡按决策染色(`data-decision`);新增推理摘要卡(`model:response` → quiet 的 `thought` 描述符,门控:仅 `purpose`/`reasoningTokens` 存在时出卡)。
- **设置 › 外观 ThemeHub(P2)**:四段分组网格 + 选中卡下方运行时实测色板(5 槽 hex、点击复制、正文对比度)+ 玻璃开关。
- **收口(P3)**:冒烟截图基线曾入库 `docs/prototypes/v1.8.0-ergo-restyle/screenshots/`(`sumi-*` / `paper-*` 各 9 张；现已清理);版本同步为 `1.8.0`;死钩子清扫(`.seg.click`、`.c-src.man`、`.mv-card .demo .t/.cs`、`settings.theme.night|day`、冒烟中设置页静默失败的 Rail 点击)。
- 全量回归 **1107 单测** + `npm run check` + renderer build + gui-smoke(`GUI_SMOKE_READY`)通过。

---

## v1.7.2 — 2026-09-19 · GUI 三处现有缺陷 + 敏感模态截图欠账

> 纯 GUI 补丁,内核零改动;是 v1.8.0 换肤(P2 卡片重排)的硬前置。

- **agent 回复从不进消息流**:`workbench-state` 的 `event_received` 不处理 `agent:final`,`messages` 只在用户发送时写入,`ChatView` 的 `.a-msg` 分支自 v1.4.6 起从未渲染过。现 `agent:final` 追加 `{ role:"assistant", text }`(空 content 不追加;stopped 也入流)。
- **状态行数据首屏一次永不刷新**:`getUsage` / `listCheckpoints` 只在挂载时拉一次。现新增纯函数 `refreshLoadsFor(eventType)`,在 `agent:final / agent:error / turn:cancelled / file:rollback_applied` 后重拉两项(不在 model:*/tool:* 上刷,避免每回合十几次 IPC)。
- **敏感文件模态引用 7 个不存在的 CSS 变量**(v1.7.0 引入):`--bg/--bg-1/--bg-2/--bg-3/--fg-1/--mut/--bdr` 在任何样式表中均无定义,红色提醒模态在所有主题下底色透明、文字无色。按语义映射到 `tokens.css` 18 槽修正;新增 `css-vars.test.js` 通用守卫——`shell.css`/`theme.css` 里任何 `var(--x)` 引用未定义槽位即红。实测守卫列出 10 处 `var()` 引用(覆盖 8 个行号;719 行含 `--bdr/--bg-2/--fg-1` 三处),全部落在方案映射表内,无表外同类 bug。
- **v1.7.0 承诺的模态冒烟截图补上**:smoke 链新增 `shell-sensitive-notice` 一景(主进程 push 构造事件,走与内核相同的 `kernel:event` 通道),截图曾入库 `docs/prototypes/v1.8.0-ergo-restyle/screenshots/`(现已清理)。
- 版本同步为 `1.7.2`(四处);全量回归 **1089 单测** + `npm run check` + renderer build + gui-smoke 通过。

---

## v1.7.1 — 2026-09-15 · changeRetention 生产接线 + D-G7 GUI 恢复中心 + #10 延后定案

> 审阅后挂账清零:补上 v1.6.2 实现了却未接线的变更记录保留期;落地 D-G7 GUI Recovery Center;#10 重构按维护者决定延后到大版本。

- **`changeRetention` 接线到内核生产路径(v1.6.2 遗留)**:此前 `finalizeChange` 已实现保留期清理,但 `createKernel` → `createEditService` 从未注入 `edits`,生产路径**永不 prune**。现:
  - `DEFAULT_CONFIG.edits = { maxCaptureBytes: 1 MiB, changeRetention: { maxRecords: 200, maxAgeDays: 90 } }`,并经 `normalizeEdits` 深归一(部分字段补默认;`null` 显式关闭截断/清理);
  - `loadConfig` / `normalizeConfig` / `buildKernelOptions` 透传 `config.edits`;
  - `createKernel` / `buildToolPlane` 把 `options.edits` 注入 `createEditService` → `createChangeStore`。
  - 覆盖:配置归一化 ×4、editService 直连清理、默认不清理、kernel-options 透传、`createKernel` 全链路清理;全量回归 **1083+**(含 D-G7 新增)。
- **D-G7 GUI Recovery Center(收 V2-18 Task 13)**:`kernel-host` 暴露 list/report/resume/cancel/clear;IPC 白名单 + preload;侧栏「恢复」入口 + RecoveryView(列表/扫描摘要/动作);中英双语。计划见 [`plans/frontend/2026-09-15-d-g7-gui-recovery-center.md`](plans/frontend/2026-09-15-d-g7-gui-recovery-center.md)。kernel recovery 契约零改动。
- **#10 `agent-runtime` 阶段 3–4 延后到大版本(维护者 2026-09-15 拍板)**:不以补丁/小版本做结构重构;阶段 1–2 成果(刻画测试 + 边界分析)继续作为护栏。台账与 design 状态行已同步。
- 版本同步为 `1.7.1`(四处)。

---

## v1.7.0 — 2026-08-09 · 敏感文件风险提醒 + 展示层脱敏(#9.3 收官)

> #9.3(明文变更记录)的最后一片。后端卫生已在 v1.6.2 落地,本版补齐需要三端前端配合的两件事,**#9.3 至此完全闭环**,审计补账单 10 项全清。

- **敏感文件独立风险提醒(三端)**:agent 改 `.env` / `*.pem` / `*.key` / `.npmrc` 等文件时,该文件的**完整原文**会被抄进 `.deepseek-code/changes/`(回滚必需,不可脱敏)。此前用户对此毫无感知,现在**在编辑真正发生之前**红色告知、由用户拍板;拒绝则该文件的改动不发生。
  - **独立于所有权限档位之外**:权限矩阵管的是「agent 能不能做这个动作」,本提醒告知的是「这个动作会在磁盘留下一份你看不见的密钥副本」—— 属副作用告知,不是动作授权。走 `editService.apply` 预检的独立回调,**不经 `permission-engine`**、不进审批缓存。
  - **所有档位一律提问,没有任何档位能跳过**(含 `full-auto`)。这与既有权限矩阵一致 —— `full-auto` 的 `read_secret` 与 `execute_dangerous` 本就是 `ask`,它从来不是「无人值守免打扰」档。策略由 `apps/sensitive-notice-contract.js` 统一,handler **在结构上就拿不到 autonomy**,从根上杜绝「按档位放行」(有测试锁住)。
  - **不缓存选择**:走审批缓存等于把「独立于权限之外」又拉回权限体系;这类告知的价值就在于每次都让人看见。
  - **判定收窄**:复用 `contextSkipReason` 但**只取 `secret-file` / `credential-file` 两类**。该函数对 `node_modules` / `dist` / `.vscode`(`ignored-directory` / `hidden-tool-dir`)也返回非 null,整个复用会让提醒在改 `dist/` 时也弹 —— 提醒一旦成噪音就等于没有。
  - **三端各自呈现,均不复用审批卡片样式**:CLI 全红文本块 + 明写「this is NOT a permission prompt」;TUI 独立 `sensitiveNotice` 态(不复用 `approval` 态)+ 红色底部行 + y/n·Esc;GUI 红色全窗模态(`--err` token,十主题自适配),**拒绝按钮在前且为默认焦点** —— 危险操作不该是顺手可点的那个。
  - **GUI 请求-应答桥**:内核在主进程,提问要到渲染层再回来。主进程 push 带 `request_id` 的事件、挂起 Promise,渲染层经新 IPC 通道 `sensitive:respond`(**已登记进 `IPC_CHANNELS` 白名单**)作答。未知 id 静默忽略(防伪造/重放挂死),`dispose` 把未决提问一律按拒绝收口。只有严格 `true` 才放行。
- **展示层脱敏(三端)**:CLI `changes` / TUI 卡片经 `formatChange`、GUI 经 `changes:describe` 桥,显示前统一过 `redactor`。**存储保持原文** —— 回滚靠逐字节复原;有测试同时断言「显示已脱敏 + 磁盘仍是原文 + 回滚仍能精确复原」,防止有人图省事把 redactor 套到写盘路径上。这是密钥唯一能离开本机的路径(截图、贴 issue)。
- 新增 **31 条测试**(判定层 8 / 共享契约 6 / CLI 6 / TUI 5 / GUI 桥 6 + reducer 5,含展示脱敏 4);`npm run check` 补上此前漏登记的两个新模块。
- 版本同步为 `1.7.0`(四处);全量回归 **1075 单测** + `npm run check` + renderer build 通过。

---

## v1.6.4 — 2026-08-09 · v1.6 收尾:文档漂移修复 + 前端片立项

> 纯文档补丁,不改任何代码。清掉 v1.6 计划的收尾清单。

- **文档漂移修复(又一次)**:`docs/README.md` 的「当前版本」停在 **v1.5.2**,落后三个补丁 —— 讽刺的是 v1.5.2 那一版修的正是这个漂移,v1.6.1–v1.6.3 三片又忘了同步。本版补上并改为 v1.6.4。
- **补救 spec 状态行修正**:顶部仍写「#10 阶段 1–2 **待续**」,而 v1.6.3 已完成 —— 该行是在 v1.6.2 写的,v1.6.3 只更了 #10 条目本身、漏了顶部汇总。现改为「阶段 1–2 已在 v1.6.3 完成,阶段 3–4 定级待拍板」,并给 #9.3 前端片补上 plan 链接。
- **新建前端片 plan**:[`plans/frontend/2026-08-09-sensitive-file-warning-and-display-redaction.md`](plans/frontend/2026-08-09-sensitive-file-warning-and-display-redaction.md)(目标 **v1.7.0**,minor)—— #9.3 剩余的两件事:
  - **敏感文件独立红色提醒**:独立于所有权限档位之外(权限管「能不能做」,本提醒告知「会在磁盘留下一份你看不见的密钥副本」,混进权限档位会被 auto 一键放行);判定复用现成的 `contextSkipReason`;开工前需拍板 `full-auto` 无人值守行为(建议不阻塞、直接拒绝并上报)与「不缓存选择」。
  - **展示层脱敏**:CLI/TUI/GUI 显示 change 详情前过 `redactor`,**存储保持原文供回滚**(须同时断言两侧)。
- v1.6 计划的收尾清单已勾掉三项;剩「合入 main + 推送」与「#10 阶段 3–4 定级」两项待维护者决定。
- 版本同步为 `1.6.4`(四处);全量回归 **1035 单测** + `npm run check` 通过(本版未改代码,基线不变)。

---

## v1.6.3 — 2026-08-09 · agent-runtime 阶段 1–2(刻画测试 + 边界分析)

> v1.6 挂账清零第三片。#10(agent-runtime 可维护性)的**阶段 1–2 only** —— 按维护者 2026-08-09 决定,**本轮不改任何实现**,只补行为刻画与边界分析,供定级再议。

- **阶段 1 · 行为刻画测试(characterization)**:新增 [`tests/unit/core/runtime/agent-runtime-characterization.test.js`](../tests/unit/core/runtime/agent-runtime-characterization.test.js) 共 7 条,锁住:
  - 完整回合的**精确事件发布顺序**(此前测试全是 `events.some(...)` 集合式断言,无顺序断言);
  - 四条审批恢复分支(普通工具 / 主验证器 / 修复期工具 / 修复期验证器)各自的暂停-续跑事件序列与终态;
  - 错误语义的**精确 `code` 与 `message`**(`APPROVAL_NOT_FOUND` / `AWAITING_APPROVAL`)。
  - **变异验证已实际执行**(验收标准,非走过场):改错误码 → 错误语义用例红;交换两个事件发布顺序 → 5 条顺序用例全红。两次变异后均已还原。
- **阶段 2 · 职责/依赖边界分析**:交付 [`specs/backend/2026-08-09-v1.6.3-agent-runtime-refactor-design.md`](specs/backend/2026-08-09-v1.6.3-agent-runtime-refactor-design.md) —— 当前 1160 行结构的功能分区表、四条恢复分支「暂停-保存-清理」样板的重复点(带行号)、纯函数 vs 副作用分离清单、阶段 3–4 候选方案与风险。
- **定级再议**:阶段 3–4(真正的重构)未开工,是否立项、按补丁还是大版本、范围多大,由维护者在读完边界分析后决定。
- 版本同步为 `1.6.3`(四处);全量回归 **1035 单测** + `npm run check` + renderer build 通过。

---

## v1.6.2 — 2026-08-09 · 变更记录后端卫生(#9.3)

> v1.6 挂账清零第二片。#9.3(明文变更记录)的后端部分:展示层脱敏与「敏感文件独立红色提醒」需三端前端配合,单独立前端片。本片只做纯后端卫生,**存储内容一个字节不改**(回滚是硬约束)。

- **大小上限 + 回滚清空洞修补**:`captureChangePlan` / `finalizeChange` 接 `maxCaptureBytes`(默认 1 MiB,`null` 关闭)——超过只存 `sha256` + 原始大小并标 `truncated: true`,不存全文。**同时堵洞**:旧 `rollbackChange` / `applyRollbackRecord` 写 `file.before ?? ""`,截断记录若不拦会把用户文件**清空**;现两处回滚路径都对 `truncated` 记录抛 `ROLLBACK_TRUNCATED`(先全部校验再动手),绝不静默写空。
- **保留期 / 数量上限(此前完全真空)**:`listChanges` 只读不删,全仓无任何清理。现 `finalizeChange` 写新记录后按 `changeRetention = { maxRecords, maxAgeDays }` 确定性清理(新在前排序,超出者删);只删 `.deepseek-code/changes/*.json`,不碰工作区文件。
- **目录限权**:`changes/` 以 `0o700` 创建(Windows 上 `fs.chmod` 基本无效,此条仅在类 Unix 生效,文档已如实说明)。
- 配置入口:`createEditService({ edits })` / `createChangeStore({ edits })` 可覆盖 `maxCaptureBytes` 与 `changeRetention`;未配置用默认值。**刻意不加入 `DEFAULT_CONFIG`** —— 当前内核不把任意 config 透传进 editService,先加是死配置(重蹈 #8 `languages` 空转),留待前端片或明确接线时再说。
- 新增 7 条测试:截断(捕获/落库/两条回滚路径守卫各 1)+ 保留期(maxRecords / maxAgeDays / 工作区不受影响)。
- 版本同步为 `1.6.2`(四处);全量回归 **1028 单测** + `npm run check` 通过。

---

## v1.6.1 — 2026-08-09 · repair 阶段计入每回合预算

> v1.6 挂账清零首片。本版由 v1.5.1 审查发现的「repair 阶段预算不计」修复产出,只改 runtime 护栏的**计数范围**,不改功能面。

- **repair 阶段模型调用计入 `maxTurnTokens` / `maxModelCalls`(v1.5.1 审查遗留)**:`approve()` 四条分支中,此前只有「普通工具」那条持有预算对象;验证器审批与修复期审批走 `runRepairLoop`,而它参数表里根本没有 `budget` —— repair 期的模型调用(`repair-executor` 的 `modelGateway.invoke`)从不计入,`maxTurnTokens` 在最容易失控的路径上失效。现:
  - `runRepairLoop` 接 `budget`,每轮 attempt 顶部查 `exceeded()` —— 命中优雅停止(`status:"stopped"`,reason 同工具循环),不抛错、不继续调模型;
  - `repair-executor` 在 `invoke` 后 `recordModelResult`(与 executor-loop 同语义、同频次:调用后记、下一迭代顶截停);
  - `verifyAndMaybeRepair` 把 `budget` 传给 send 与 approve 两条路径的 repair 入口;
  - 验证器/修复期审批暂停时把 `budget.snapshot()` 写入 `resume_state.budget_spent`(与 executor-loop 的 `withBudgetSpent` 同形状),续跑按 spent 做种子,re-pause 链与 durable 恢复路径自动继承;
  - `budget` 未注入时行为逐字节不变(不内置默认值)。
  - 新增 3 条回归:runtime 层「repair 期调用计入预算、耗尽后不再调模型」+ repair-loop 直接层「不传 budget 照常、已耗尽预算先于模型调用停止」。
- 版本同步为 `1.6.1`(`package.json` / `package-lock.json` / CLI-TUI banner / GUI App.jsx);全量回归 **1021 单测** + `npm run check` 通过。

---

## v1.5.2 — 2026-08-09 · FIM 超时补齐 + 文档漂移修复 + release tag 补录

> 本版由 v1.5.1 的提交审查产出:一处潜在挂起、三处文档/死代码遗留。不改功能面,属补丁级。

- **`fimComplete` 补齐超时(v1.5.1 审查遗留)**:FIM 路径此前完全没有超时 —— `model-gateway.fimComplete` 只把 `options.signal` 透传给 `fim-client`,不接 `timeoutMs`,请求或 body 解析悬挂即永久挂起(该方法在 `src/` 内暂无调用点,故是潜在而非在线的洞)。现与 `invoke` / `stream` 同语义:`withTimeout` 包住整段并在 `finally` 解除,`timeout.signal` 传入 fim-client 的 fetch 故请求与 body 解析同受约束,超时抛 `MODEL_TIMEOUT`、调用方 abort 以 `ABORT_ERR` 传播;不传 `timeoutMs` 则行为逐字节不变(与 `invoke`/`stream` 一致,不内置默认值)。新增 4 条回归。
- **文档漂移修复**:`docs/README.md` 的「当前版本」由 v1.2.0 更新为 v1.5.2 并补 tag 指引;补回 v1.4.8 发布时误删的 `[Unreleased]` 小节(维护规范仍引用它);补回 **v1.3.1 丢失的 CHANGELOG 标题**(其 5 条内容此前裸挂在 v1.3.2 小节下);`project-overview` §2 超时描述补 `fimComplete` 与「cleanup 在 body 读完之后」语义。
- **补齐历史 release tag**:v1.0.0 / v1.1.0 / v1.2.0 / v1.3.1 / v1.3.2 / v1.4.8 / v1.5.1 七个带注解 tag,tagger 日期对齐各自提交 —— 此前项目严格走语义化版本却零 tag,回溯只能靠 commit message。
- **GUI 死字符串清理(v1.5.1 遗留)**:`i18n/strings.js` 中英各删 4 个无引用的 `placeholder.*` 键(`badge`/`files`/`editor`/`terminal`)—— 属 v1.4.6 删除旧 IDE 组件后的残留,其中 `placeholder.terminal` 还写着「xterm 待接」。
- **审查记录的既有缺口(本版未动,留档)**:`approve()` 的四条分支中仅「普通工具」持有预算对象,验证器审批与修复期审批走 `runRepairLoop`(不接 budget 参数),故 **repair 阶段的模型调用从不计入每回合预算** —— 属挂账 #10(`agent-runtime` 可维护性)辖区,需独立立项。
- 版本同步为 `1.5.2`(`package.json` / `package-lock.json` / CLI-TUI banner / GUI App.jsx);全量回归 **1018 单测** + `npm run check` + renderer build 通过。

---

## v1.5.1 — 2026-08-07 · 内核超时/预算修复 + GUI 死代码清理

- **流式/响应超时真正生效(#深读核实)**:`model-gateway.stream` / `invoke` 原在 `fetch` resolve 后立刻 `timeout.cleanup()`(清定时器 + 摘 caller abort),但 SSE body 读取与 `response.json()` 都在其后——超时不再约束 body 读取、调用方 abort 也不传播。现把 cleanup 移到 body 读完后的最外层 `finally`:SSE 流读或 JSON 解析悬挂时按 `MODEL_TIMEOUT` 终止,调用方 abort 以 `ABORT_ERR` 传播;新增 4 条回归测试。
- **每回合预算跨审批续扣(#深读核实)**:`agent-runtime.approve` 续跑时新建的 `createCostBudget` 不带 initial 值,暂停前已耗的 token/调用次数被清零(回合可实际超 `maxTurnTokens`),与 orchestrator 的 `makeResumedBudget` 续扣语义不一致。现 `executor-loop` 在暂停点把 `budget.snapshot()` 写入 `resume_state.budget_spent`,`approve` 续跑时按 spent 做 initial 种子;re-pause 链与 durable 恢复路径自动继承。新增回归测试;旧 sidecar 缺字段则退化为 0(兼容)。
- **GUI 死代码清理**:
  - **xterm/pty 死路径**:删除 `@xterm/xterm` + `@xterm/addon-fit` 依赖、`gui/pty-host.js`、preload `pty*` / `onPtyData` 与 `pty:*` IPC 处理器、`tests/unit/gui/pty-host.test.js`(渲染层从不 import xterm,终端从未接出);`node-pty` 保留供门控 TUI smoke。
  - **遗留 `theme.css` 剪枝**:235→82 行,仅保留 v4 仍引用的标题栏/下拉菜单/按钮/Diff 视图/状态色与全局 reset(被 v1.4.6 删除组件的 Explorer/Editor/Agent/底部面板/modal 等遗留样式已清理);tokens 仍经其 `@import` 加载。
  - **IPC 白名单强制生效**:`IPC_CHANNELS` 从文档常量改为唯一权威清单(补上此前漏登记的 `projects:*` / `sessions:list` / `projects:reveal` / `projects:pick`),`registerIpcHandlers` 内未登记 channel 的 `handle` 注册启动即抛错。
- 版本同步为 `1.5.1`(`package.json` / `package-lock.json` / CLI-TUI banner / GUI App.jsx);全量回归 **1014 单测** + `npm run check` + renderer build + Electron/TUI smoke 通过。

---

## v1.4.8 — 2026-08-07 · 前端重设计收官(feat/v1.4 → main)

> v1.4 系列(前端重设计)v1.4.0–v1.4.7 八个提交一次合入 main。以下为各阶段交付内容与品牌改名。

- **品牌改名**:产品名 **DeepSeek Code → Inkstone(砚)**。显示品牌全面替换(CLI/TUI banner、GUI 窗口与页面标题、system prompt 产品自称、User-Agent、README/docs/设计稿);结构层同步(package/bin 命令 `inkstone` + 保留 `dsc` 别名、gui 包名 `inkstone-gui`、conda 环境名)。**功能契约全部保留**:`.deepseek-code` 存储目录、`DEEPSEEK_*` 环境变量、`api.deepseek.com` 端点与 `deepseek-v4-*` 等模型 id 均不改。方案见 [`plans/architecture/2026-07-31-inkstone-rebrand.md`](plans/architecture/2026-07-31-inkstone-rebrand.md)。
- **v1.4.6 设计稿细节还原(feat/v1.4 分支)**:在 P0–P4 基础上对照 v4 设计稿逐项补齐 ——
  **图标规范**:GUI 全部改用 lucide-react 矢量图标(新增 `lucide-react` 依赖),移除残留的 emoji/几何字形(📎 ⚡ ◆ 等),删除十个旧版 IDE 组件(ActivityBar/AgentPanel/DiffView/EditorGroup/Explorer/Icons/Placeholder/RewindDialog/StatusBar/Terminal)与 `panels-derive` 死模块;
  **七视图还原**:首页改为问候语+输入胶囊+四张快捷卡+最近会话、侧栏项目分区内挂日期分组会话(今天/昨天/本周/更早)+搜索过滤(新 `session-groups.js`)、会话视图补齐五类事件卡(计划带子任务清单/工具带参数/diff 带逐文件增删/审批卡接批准与拒绝/编排卡)、设置页对齐设计稿表单语言(s-nav/f-group/f-row/.sw/主题网格/5 形态卡);
  **状态行还原**:`.cz-meta` 完整实现——分支/检查点/连接标签 + 5 形态比例指标(文字/数值/进度条/点阵/关闭,点按钮可轮换)+ 模型/主题/语言标签,由「状态显示」偏好驱动,空闲淡出;
  **能力补齐**:「打开文件夹…」原生目录选择 IPC(`projects:pick`)、项目页「在文件管理器中显示」(shell.openPath)、会话枚举跨全部登记项目(侧栏每项目分区各自挂载);
  **TUI 对齐**:启动首页菱形品牌行(版本/模型/档位/shell/主题 meta)+ 最近会话列表,状态行加 `th:` 主题标签。
  全量回归 1006 单测 + e2e ×4 通过;GUI 冒烟截图随 smoke 落 `gui/__screenshots__/`。
- **v1.4.7 前端收口(feat/v1.4 分支)**:侧栏可收放 —— Rail 272px⇄52px 图标轨,`Ctrl/⌘+B` 切换、偏好 `railCollapsed` 持久化,折叠态仅保留功能区图标与页脚「展开/设置」两钮;恢复 `DiffView.jsx` 修复 renderer 构建断裂;补齐 `Ctrl/⌘+N` 新建会话;修复 Rail 分区折叠、首页 busy 中断键、标题栏明暗主题图标(改按 `themes.js` group 判定)三处交互问题;设置页全窗化(不再与 Rail 并列,顶部新增「返回/关闭」按钮,返回原视图),窄窗口菜单栏消失修复(≤900px 时 Rail 改为强制 52px 图标轨而非隐藏);构建与测试加固(renderer-dist 门控、Electron 冒烟截图预算兜底),截图复核 8 视图全绿(修复 smoke 设置截图选错按钮、窄屏折叠偏好残留 52px 空列、改动时间原始 ISO 显示),全量回归 1012 单测 + `npm run check` + renderer build + Electron 冒烟通过。
- **v1.4.0 前端界面重设计(已实现,`feat/v1.4` 分支)**:GUI/TUI 界面全部重做,按 [`plans/frontend/2026-07-31-v1.4.0-frontend-redesign-plan.md`](plans/frontend/2026-07-31-v1.4.0-frontend-redesign-plan.md) 的 P0–P4 落地。**设计定稿**(五轮 HTML 稿,终稿曾存 `prototypes/v1.4.0-redesign/v4/`,现已清理;结论见 [spec](specs/frontend/2026-07-28-v1.4.0-frontend-redesign-design.md)):**10 套主题**(3 浅 7 深,色值取自 Flexoki/Rosé Pine/Catppuccin/Kanagawa/Tokyo Night/Nord/Everforest/Gruvbox Material 官方定义源,WCAG 110 项校验全过,默认 `sumi` 墨)——GUI `tokens.css` 单源 + 设置页外观 10 主题网格,TUI 经 `gen-tui-theme` 生成 xterm-256 调色板 + `/theme`。**GUI 会话优先布局**:rail 功能区(主页/项目/改动/MCP/插件)+ 每项目独立分区(内挂该项目会话,新建会话继承项目目录)+ 独立对话;七视图路由;`.cz-meta` 指标 5 形态(文字/数值/进度条/点阵/关闭)+ 全中文「状态显示」设置组;全局项目 MRU + 会话枚举(kernel 零改动)。**TUI**:opencode 式启动首页(垂直居中/单行 meta/最近会话)+ `/theme` + `/shell`(pwsh/powershell/cmd/git-bash)。

**已挂账(待立项,方案见 [`specs/backend/2026-07-12-agent-findings-remediation.md`](specs/backend/2026-07-12-agent-findings-remediation.md)):** 明文变更记录脱敏方案(#9.3,需独立 design)、`agent-runtime.js` 可维护性重构(#10)。

---

## v1.3.2 — 2026-07-29 · 语义降级可观测 & GUI 休眠渲染层删除

- **语义上下文降级可观测化(#8):** `semantic-engine.js` 在降级翻转处恰好发布一次 `context:semantic_degraded` 事件(含 error.message reason,~200 字符截断),经事件类型注册入会话时间线、`event-contract.js` 以非静默 warn kind 展示(CLI/TUI 默认行渲染即可读);粘性降级与文件级回退行为不变。
- **删除 `context.semantic.languages` 空转配置(#8):** 从 `DEFAULT_CONFIG` 与 `normalizeContext` 移除从未被消费的 `languages` 键及 `normalizeLanguages` 函数;含旧键的用户配置静默消失(`normalizeContext` 固定键集重建)。同步删除从未被加载的 `tree-sitter-tsx.wasm`(2.4 MB 死重)及 `wasm-tree-sitter-provider.js` 中的 `tsx` 条目。
- **删除 GUI 休眠渲染层(#9.6):** 整目录 `gui/renderer/`(app.js / event-adapter.js / workbench-state.js / index.html / style.css)已删除——消除问题 #5(事件→展示四份并行实现)的最后残留。`gui/main.js` 加载决策改为:dev URL → renderer-dist,两者皆无→`dialog.showErrorBox` + stderr 报错「请先运行 npm run build:renderer」+ 非零退出。删除 2 个对应单测;`npm run check` 移除了 `gui/renderer/*` 条目。
- 版本同步为 `1.3.2`(`package.json` / `package-lock.json` / CLI-TUI banner);全量回归(978 项)与语法检查通过。
- 本版范围说明:#7 命令策略已在 v1.3.1 发布;#9.3(明文变更记录)、#10(agent-runtime 重构)继续挂账。

---

## v1.3.1 — 2026-07-28 · shell 命令级安全策略

- `shell`/`git` 子进程执行在权限档位之外新增**命令级分类**([`src/security/command-policy.js`](../src/security/command-policy.js),清单硬编码):`classifyCommand(argv)` 将命令分为 safe / dangerous / forbidden 三类,经工具 `resolveCategory` 映射进权限引擎——**forbidden**(format / mkfs* / diskpart / bcdedit / dd)映射到 `destructive`,在所有自治档位一律拒绝且审批缓存不可放行;**dangerous**(rm/del 等删除类、shutdown/reg/taskkill 等系统类、curl/wget、npm publish、git push 强制推送、bash/cmd/powershell 等包装 shell、node -e / python -c 等解释器执行参数)映射到 `execute_dangerous`,在 supervised / gated / auto / **full-auto** 四档一律要求人工确认(read-only 档拒绝,与其余 execute 一致);safe 命令行为不变。命令名归一化覆盖 basename、大小写、`.exe`/`.cmd`/`.bat`/`.com` 扩展名及 Win32 尾部点号变体。
- `runProcess` 兜底:spawn 前对 forbidden 命令直接拒绝(不经审批层),防止绕过工具定义的路径;dangerous 不在此层拦截,保证 `test` 工具的 cmd.exe 嵌套回路不受影响。
- 审批体验:审批请求 summary 现在附带 argv 预览(120 字符截断);事件展示契约 `argHint` 修复为读取 `call.params`(此前读 `call.args`,tool:call 事件 argv 预览始终为空),`ARG_KEYS` 增加 `argv`。
- 版本同步为 `1.3.1`(`package.json` / `package-lock.json` / CLI-TUI banner);全量回归(991 项)与语法检查通过。
- 本版范围说明:对应设计中另两项(语义上下文降级可观测化 #8、GUI 休眠渲染层删除 #9.6)在 `feat/v1.3.0` 分支上继续开发,作为后续版本发布。

---

## v1.2.0 — 2026-07-19 · 工具安全护栏与仓库卫生

- `grep` 工具加超时闸:每文件(默认 2s)+ 总预算(默认 10s)协作式检查,病态正则不再拖死进程;超时不抛错,返回已得匹配并以 metadata(`timed_out` / `timed_out_scope` / `files_skipped_timeout` / `files_searched`)标注,非法 pattern 行为不变。
- `shell` 子进程环境改为**白名单继承**:仅透传 PATH、Windows 系统变量、用户/临时目录与区域设置;`DEEPSEEK_*`、`*_API_KEY` / `*_TOKEN` / `*_SECRET`、代理(`HTTP(S)_PROXY` / `NO_PROXY` / `ALL_PROXY`)与 `NODE_OPTIONS` 默认不可见。`git` 工具子进程走同一 `runProcess`,同样受白名单约束(`GIT_*` 被剥离;只读 git 操作不受影响)。
- 模型 id 可配置:config 顶层 `models.{act,think,fim}` 整体切换路由 CHANNELS 的模型,缺省与现网一致(`deepseek-v4-flash` / `deepseek-v4-pro`);gateway 与 FIM 路径同步透传,`explicitModel` 仍最高优先。
- 仓库卫生:`test/` 并入 `tests/`(npm test 单 glob);删除 `src/index.js` 无引用的 `createPausedRecoveryFacade`(净 -101 行);根目录原型 `DeepSeekCodeIDE.jsx` 与 `preview-deepseek-code` 轻量源码迁入 `docs/prototypes/`(node_modules 与日志不随迁),`.gitignore` 清 stale 行;51 份历史 plan 头部标注「完成状态以 CHANGELOG 为准」,roadmap 补 pivot 注记。
- 版本同步为 `1.2.0`(`package.json` / `package-lock.json` / CLI-TUI banner);全量回归通过、语法检查通过。
- 本版明确未做(仍挂账):#8 语义降级可观测、#9.3 明文变更记录、#9.6 UMD 副本、#10 `agent-runtime` 重构、shell 命令白名单。

---

## v1.1.0 — 2026-07-15 · 可靠性、安全与中文体验修复

- 中文请求不再全落 `general`:classifier 新增中英共享词表(edit / diagnostic / query / 全角问号),复杂度路由共用同一词表来源。
- GUI 删除分叉的 kernel-options 装配逻辑,动态复用 CLI/TUI 的共享实现;`orchestration` / `context.semantic` 配置与 override 语义三端一致。
- TUI busy 态 Esc 与 CLI SIGINT 可中断当前回合;中断收口为可读状态,不退出整个会话,审批续跑链同样受保护。
- `web_fetch` SSRF 加固:校验全部 DNS A 记录、补齐 CGNAT/0/8/benchmark/文档/组播等保留网段,默认网络路径固定到已验证 IP 直连(保留原 hostname 作 Host/SNI),消除校验后再次解析的 DNS rebinding/TOCTOU;网络层按 32KB 上限截断缓冲,重定向/非 2xx 丢弃 body。
- 脱敏扩面:确定性覆盖 AWS/GitHub/sk- token、私钥块及常见 token/secret/password 赋值;不启用易误伤源码的通用高熵猜测。
- 版本同步为 `1.1.0`(`package.json` / `package-lock.json` / CLI-TUI banner);受影响测试与全量回归通过。

---

## v1.0.0 — 2026-07-13 · 首个正式版本

Inkstone 的首个正式发布,**整合此前全部内部迭代**(V1 原型 → V2 干净运行时 → V3 三支柱)为一个统一版本。面向 DeepSeek 的**本地 AI 编程 Agent**:在你的项目目录里读代码、改代码、跑测试,并把每一步模型调用、工具执行、文件改动与审批记录成可回放、可分支、可回退的会话时间线。**CLI · TUI · 桌面 GUI 三端共用同一内核**,核心运行时零依赖(仅可选 WASM tree-sitter),Node ≥ 20 + 一个 API Key 即可运行。

### 统一内核与三端
- **一个内核门面** `createKernel()`:一条 Agent runtime、一条工具执行路径、一套编辑/回滚服务、一条会话时间线;三端只做输入 / 展示 / 审批,不碰 agent 业务逻辑。
- **回合生命周期**:意图分类 → 上下文快照 → 快答 / 工具循环 → 验证 → 按需修复,由 11 态生命周期状态机与事件总线记录(56 种规范会话事件,JSONL 追加 + sha256 哈希链)。
- **五档自治 × 八类别权限矩阵**(read-only/supervised/gated/auto/full-auto);`ask` 判定使回合整体暂停并落盘 resume_state,`approve`/`deny` 从断点精确续跑;审批以参数指纹 + TTL 缓存。
- **DeepSeek 原生适配**:按用途路由模型(reply/act/plan/review/repair/fim)、JSON mode guard、手写 SSE 流式、FIM 代码补全、tool-call 容错解析、用量遥测。
- **三端共享事件展示契约**(`src/apps/event-contract.js`):内核事件 → 归一化展示描述符的唯一语义源,CLI / TUI / GUI 渲染器均为薄适配层,字段兼容逻辑收敛一处。

### 支柱① 语义级上下文(opt-in,默认关)
- 文件级上下文引擎(默认):增量扫描 + manifest 缓存 + 路径优先级分层 + 按通道 token 预算贪心装填 + 快照缓存(KV 前缀命中提示)。
- 语义级(`--semantic-context`):基于 web-tree-sitter(WASM,无原生构建)按符号(函数/类)检索,沿 import / 调用依赖图扩展;**支持 JS / TS / Python**;方法消歧 `--include-method-hints`(唯一同名 → probable)。关闭时与文件级逐字节一致。

### 支柱② 多智能体调度(默认开,简单任务零开销)
- **分层路由器**:明显档免费启发式直判,模糊中间档调一次便宜模型判复杂度(`router.model.enabled=false` 可退回纯启发式)。
- **编排闭环**:Planner 拆子任务 → 串行 Worker 执行 → **两级独立审核**(子自审 + 只读 Reviewer)→ Synthesizer 合成;失败/不完整多回合自适应重规划;成本闸常开。
- **并行写隔离**:无依赖且文件不重叠的子任务在 fs 拷贝隔离工作区并行,快照一致性校验 + 每子任务原子事务合并回主区,零残留。
- **跨任务经验记忆**(`crossTaskLearning`,默认 off):独立经验库 + 三级分化衰减 + Jaccard 去重,风险经验单调升级权限(只 allow→ask)。
- **持久化恢复**(`recovery.enabled`,默认关):进程崩溃后凭项目锁 + 事务日志 + 暂停 sidecar 恢复未完成回合,含**跨进程编排级**续跑。

### 支柱③ 前端三端
- **桌面 GUI**(Electron + React + Vite,**原创手写 VS Code 风格设计系统**,不用成品 UI 套件;双语 zh/en 默认中文):真文件树 · Monaco 编辑器(本地 worker)· node-pty 交互终端 · 设置页(API 列表管理 / 模型获取 / 编辑保存 / 分支切换 / 检查点 rewind)· SCM「AGENT 改动」跟踪(前后对比 + hunk 跳转)。渲染层沙箱化,仅经 preload 白名单 IPC 通信。
- **终端 TUI**(claude code 式行内滚动流):历史进终端原生滚动区,底部固定输入 / 状态栏;流式打字机预览 · 工具/diff/审批/编排卡片 · slash 命令补全 · `/config` 与 GUI 共享 API 列表(激活重建 kernel 保上下文);手写 ANSI/VT,双语。
- **CLI**:`ask / chat / edit / test / scan / search / diff / config / changes / rollback / tui` 子命令;chat REPL 含 `/mode` `/recovery`(resume/cancel/clear);多 agent 编排摘要;`/recovery` 与 TUI 对齐。

### 安全基线
- workspace 边界 realpath 校验 · shell 结构化 argv(无 shell 注入面)· web_fetch SSRF 防护(私网/回环封锁 + 每跳重校验)· 密钥脱敏 · GUI 沙箱化 · API Key 明文只落随仓忽略的 `.deepseek-code/`、渲染路径只出现掩码。

### 运行护栏
- 工具/模型调用超时默认 120s 开启;token、模型调用次数、畸形 tool-call 重试均可配额;命中后优雅停止而非崩溃。

### 质量
- **932 测试全绿**(node:test 原生),`npm run check` 通过;支柱①②③ 前端与编排全程守「kernel 核心 `src/core`/`src/index.js` 零改动」纪律。

> **开发历程**(详见 [`docs/specs/`](specs/) · [`docs/plans/`](plans/) 与 git 历史):
> **V1 原型**(2026-05,ask/edit/chat + 安全基线,已于内部重构删除)→ **V2 干净运行时**(2026-05–06,内核地基 / 审批恢复 / 验证修复 / 上下文引擎 / 事务编辑与分支 rewind / 持久化恢复 / 运行护栏)→ **V3 三支柱**(2026-06–07,语义级上下文 Phase B、多智能体调度 Phase C、前端三端重构 Phase D + CLI 对齐 D-G4)。
>
> 注:内部架构文档中的「V2 内核」指**运行时架构代号**(干净运行时),与本文的**产品版本号 v1.x** 是两条不同的轴,不要混淆。
