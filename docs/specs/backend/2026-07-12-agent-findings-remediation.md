# agent 审计发现补救计划与处理状态

- 日期:2026-07-12;状态更新:2026-09-15
- 状态:**#1–#5 已在 v1.1.0 解决**;**#6、#7(env 部分)与 #9 易项(9.1/9.2/9.4/9.5/9.7)已在 v1.2.0 解决**(计划 [`../../plans/backend/2026-07-16-v1.2.0-agent-findings-p2.md`](../../plans/backend/2026-07-16-v1.2.0-agent-findings-p2.md));**#7 后半(命令级分类)已在 v1.3.1 解决**;**#8、#9.6 已在 v1.3.2 解决**(计划 [`../../plans/backend/2026-07-26-v1.3.0-agent-findings-p3.md`](../../plans/backend/2026-07-26-v1.3.0-agent-findings-p3.md));**#9.3 后端卫生部分已在 v1.6.2 解决**(大小上限 + 回滚守卫 + 保留期 + 目录限权,见 [`../../plans/backend/2026-08-09-v1.6-backlog-closure.md`](../../plans/backend/2026-08-09-v1.6-backlog-closure.md));**#9.3 已在 v1.7.0 完全闭环**(后端卫生 v1.6.2 + 敏感文件风险提醒与展示层脱敏 v1.7.0);**#10 阶段 1–2 已在 v1.6.3 完成**(刻画测试 + 边界分析)。**阶段 3–4 按维护者 2026-09-15 决定延后到大版本,不在补丁/小版本做结构重构**([design](2026-08-09-v1.6.3-agent-runtime-refactor-design.md));`changeRetention` 生产接线已在 **v1.7.1** 补上。
- 来源:6 个并行只读 agent 对全仓库子系统的审计(docs / kernel / context / model+tools+security / frontends / sessions+edits)
- 关联:D-G4 设计 [`../frontend/2026-07-12-v3-phase-dg4-cli-alignment-design.md`](../frontend/2026-07-12-v3-phase-dg4-cli-alignment-design.md)
- **重要:本文所有条目本轮均不实现**,仅提供根因、改法、影响文件、风险、验证方式、优先级,供后续逐项立项(各自走 spec/plan 或直接小改)。

---

## 优先级总览

| # | 问题 | Tier | 优先级 | 影响面 |
|---|---|---|---|---|
| 1 | 意图分类器只认英文,中文请求全落 general | 快速 bug | **✅ v1.1.0** | 中文用户核心体验 |
| 2 | GUI buildKernelOptions 分叉,丢编排/语义配置 | 快速 bug | **✅ v1.1.0** | GUI 行为与 CLI/TUI 不一致 |
| 3 | TUI/CLI 无法中断运行中的回合 | 快速 bug | **✅ v1.1.0** | 长任务体验 |
| 4 | SSRF:DNS rebinding 窗口 + 黑名单缺网段 | 安全 | **✅ v1.1.0** | web_fetch 内网穿透面 |
| 5 | 脱敏正则覆盖过窄 | 安全 | **✅ v1.1.0** | 密钥泄漏面 |
| 6 | grep 工具 ReDoS | 安全 | **✅ v1.2.0** | 模型正则拖垮进程 |
| 7 | shell 无命令白名单 + 子进程继承含密钥环境 | 安全 | **✅ v1.2.0(env);命令白名单延后** | auto 档执行面 |
| 8 | 语义上下文静默粘性降级 + languages 配置空转 | 健壮性 | **✅ v1.3.2** | 可观测性/文档一致性 |
| 9 | 仓库卫生(遗留原型/双测试目录/明文变更记录/模型名硬编码/死代码/plan 回写) | 清理 | **部分 ✅ v1.2.0(9.1/9.2/9.4/9.5/9.7);9.3 延后;✅ v1.3.2(9.6)** | 维护成本 |
| 10 | `agent-runtime.js` 可维护性(职责混合/依赖集中/测试边界不足) | 可维护性 | **P2(延后)** | 回归风险集中点 |

> **audit 问题 #5(事件→展示逻辑四份并行实现)**:已在 D-G4 随共享事件展示契约**在三个受支持 ESM 渲染器(CLI/TUI/GUI-React)上解决**;休眠 UMD fallback(`gui/renderer/`) 已在 **v1.3.2(#9.6)** 删除。**✅ 完全解决。**

---

## Tier 1 — 快速 bug(高价值、自包含)

### 1. 意图分类器只认英文关键词(P0)

- **根因:** [`src/core/planning/classifier.js`](../../../src/core/planning/classifier.js) 的分类正则只覆盖英文关键词。中文请求(如「修复这个 bug」)几乎必然落入 `general` 走完整工具循环;`query` 类中文问题也进不了快答路径(仅靠句尾 `?`)。这与 `task-router` **特意内置了中文标记词**(「重构整个」等)形成同仓两套语言假设的内部不一致 —— 对一个中文文档为主、中文交互为主的项目,这是最直接的体验损耗。
- **改法:** 给分类正则补中文关键词集,与 `task-router` 的中文标记词**共用一份词表**(抽 `src/core/planning/keywords.js` 或类似,edit/diagnostic/query 各一组中英对照);query 判定除句尾 `?` 外加中文疑问词(「吗/什么/为什么/如何/怎么」)与全角 `?`。
- **影响文件:** `classifier.js`、`task-router.js`(改为引用共享词表)、新增词表模块。
- **风险:** 低。分类只影响上下文通道选择与快答/工具循环分流,错分不产生错误副作用(至多多跑一轮)。共享词表需保证 router 现有 disabled-parity 测试不变。
- **验证:** 新增中文样例分类单测(edit/diagnostic/query 各若干);router 现有启发式测试原样全绿;端到端:中文提问命中快答路径。
- **✅ v1.1.0 已解决:** 新增 `planning/keywords.js` 作为 classifier 与 complexity router 的中英词表唯一来源;覆盖 edit/diagnostic/query、中文疑问语气与全角问号,保留原英文行为。

### 2. GUI buildKernelOptions 分叉,丢编排/语义配置(P0)

- **根因:** [`gui/kernel-host.js`](../../../gui/kernel-host.js) 内嵌了一份 CJS 版 `buildKernelOptions`,只透传 deepseek 凭据 + limits,**丢掉了** [`src/apps/kernel-options.js`](../../../src/apps/kernel-options.js) 会透传的 `config.orchestration` 与 `config.context`(语义上下文)。GUI 内核吃不到这两类项目配置,同一 `config.json` 下 GUI 的多 agent / 语义上下文行为与 CLI/TUI **静默不一致**。根因是「同一装配逻辑两处实现」,ESM/CJS 边界导致复制而非复用。
- **改法:** 让 GUI 复用 `src/apps/kernel-options.js` 单一实现。`kernel-host.js` 已在主进程用 `pathToFileURL` 动态 import ESM 内核,同法动态 import `kernel-options.js` 的 `buildKernelOptions`,删除内嵌 CJS 副本。
- **影响文件:** `gui/kernel-host.js`(删副本、改为动态 import);`src/apps/kernel-options.js`(确认导出契约足够)。
- **风险:** 中。GUI 内核装配路径变更,需门控 Electron smoke 覆盖;注意 GUI 传入的 options 形状与 CLI/TUI 对齐。
- **验证:** 新增单测断言 GUI 装配路径产出的 options 含 orchestration/context 字段;门控 GUI smoke 通过。
- **✅ v1.1.0 已解决:** `gui/kernel-host.js` 动态 import 共享 `src/apps/kernel-options.js`,删除分叉装配逻辑;测试覆盖 limits/orchestration/context 与 semantic override 合并。

### 3. TUI/CLI 无法中断运行中的回合(P1)

- **根因:** `kernel.agent.interrupt`(内核已提供,GUI 已接 interrupt IPC)在 **TUI/CLI 完全未接线**。TUI busy 时按 Esc 只弹 `hint.busy`,长任务只能 Ctrl+C 双击整体退出(丢会话);CLI 更是无中断入口。
- **改法:** TUI:busy 态 Esc(或专用键)调 `kernel.agent.interrupt()`,渲染中断卡片,回合回到 idle 保留滚动区。CLI:agent 命令运行时捕获一次 SIGINT → `interrupt()` 而非直接退出(二次 SIGINT 才退)。
- **影响文件:** `src/apps/tui/tui-app.js`(键路由 + interrupt 接线)、`src/apps/tui/tui-i18n.js`(中断词条)、`src/apps/cli/kernel-runner.js`(SIGINT 处理)。
- **风险:** 中。中断时序与流式 onDelta / 审批暂停态交互需小心(中断应清当前回合但不误清暂停审批);CLI 的 SIGINT 双击语义要与现有 readline 协调。
- **验证:** TUI 组合根注入 mock kernel,断言 busy+Esc 触发 interrupt 且回 idle;CLI 注入可中断的 fake send,断言首次 SIGINT 调 interrupt。
- **✅ v1.1.0 已解决:** TUI busy 态 Esc 调 `agent.interrupt()`并渲染稳定中断行;CLI 在 send/approve 运行期注册可清理的 SIGINT handler,首次信号中断当前回合并收敛为 `status:"interrupted"`,chat 保持可继续输入。

---

## Tier 2 — 安全加固

### 4. SSRF:DNS rebinding 窗口 + 黑名单缺网段(P1)

- **根因:** [`src/security/ssrf.js`](../../../src/security/ssrf.js) `validateFetchUrl` 只在请求前 lookup **一次** A 记录,实际 fetch 由运行时**再次**解析 —— 短 TTL 或多 A 记录轮换可在两次解析之间切到内网地址(TOCTOU / DNS rebinding);且 lookup 只取单条记录。另黑名单不完整:`100.64.0.0/10`(CGNAT)、`0.0.0.0/8` 中除 `0.0.0.0` 外地址、`192.0.0.0/24`、`198.18.0.0/15` 等保留网段未封。
- **改法:** ① 消除 TOCTOU:解析所有 A/AAAA 记录并全部校验,再**用已校验的 IP 直连**(fetch 时 pin 该 IP、Host 头保留原域名),或用一次解析结果同时驱动校验与连接。② 补全保留网段黑名单(引 CIDR 判定,含 CGNAT/benchmark/保留段)。③ 每一跳重定向沿用同一严格解析(现已每跳重校验,保持)。
- **影响文件:** `src/security/ssrf.js`、`src/tools/builtin/web-fetch.js`(连接层 pin IP)。
- **风险:** 中。IP-pinning 改连接方式,需处理 HTTPS SNI/证书校验仍按原域名;IPv6 现全拒(保持)。
- **验证:** 单测:多 A 记录/私网记录被拒;mock resolver 模拟 rebinding(两次解析不同)被拦;新增 CIDR 网段逐个拒绝用例。
- **✅ v1.1.0 已解决:** DNS `all:true` 校验全部 A 记录;补 CGNAT/0/8/protocol/TEST-NET/benchmark/组播等保留网段;默认 http/https 网络层固定 socket 到已验证 IP,原 hostname 保留作 Host/SNI,每跳重定向重做同一流程。

### 5. 脱敏正则覆盖过窄(P1)

- **根因:** [`src/security/redactor.js`](../../../src/security/redactor.js) 仅 3 个正则(`Bearer` / `api_key` / `deepseek_api_key`)。AWS/GitHub token、SSH 私钥、通用高熵 secret 均不脱敏 —— 工具输出(shell/read/grep)里出现这些会原样进模型上下文与事件流展示。
- **改法:** 扩充脱敏规则集:常见云厂商 token 前缀(`AKIA…`、`ghp_/gho_/ghs_`、`sk-…`)、`-----BEGIN … PRIVATE KEY-----` 块、高熵长串启发式(可选,注意误伤代码)。规则表化,便于增补与测试。
- **影响文件:** `src/security/redactor.js`。
- **风险:** 低-中。高熵启发式可能误脱敏正常内容(如 hash/base64 资源),建议先只加**确定性前缀/块**规则,高熵项单列可选开关。
- **验证:** 单测逐规则命中/不误伤;确认 executor 对所有工具输出 text 统一套用。
- **✅ v1.1.0 已解决:** 规则表确定性覆盖 Bearer、常见 key/token/secret/password 赋值、AWS/GitHub/sk- 前缀与多行私钥块;特意不做通用高熵猜测,并以普通 hash/短源码字面量不误伤测试钉死。

### 6. grep 工具 ReDoS(P2)

- **根因:** [`src/tools/builtin/grep.js`](../../../src/tools/builtin/grep.js) 直接 `new RegExp(模型提供的 pattern)`,无复杂度或执行时间限制。恶意/病态正则(如 `(a+)+$`)可在大文件上指数回溯,拖垮或挂起进程。
- **改法:** ① 加单次匹配超时/迭代上限(逐文件、逐行设预算,超时中止并标记);或 ② 换用线性时间正则引擎子集 / 预校验 pattern 复杂度并拒绝危险构造。最小改动是给每文件搜索包超时闸(与 shell/web_fetch 的超时护栏一致)。
- **影响文件:** `src/tools/builtin/grep.js`。
- **风险:** 低。加超时不改正常搜索语义,仅对病态输入优雅失败。
- **验证:** 单测:已知病态正则在超时内返回错误而非挂起;正常搜索结果不变。
- **✅ v1.2.0 已解决:** 每文件(默认 2s)+ 总预算(默认 10s)协作式超时,注入式时钟可测;超时优雅返回已得匹配并以 metadata(`timed_out` / `timed_out_scope` / `files_skipped_timeout` / `files_searched`)标注;非法 pattern 行为不变。

### 7. shell 无命令白名单 + 子进程继承含密钥环境(P2)

- **根因:** [`src/tools/builtin/shell.js`](../../../src/tools/builtin/shell.js) 已做 argv-only + `shell:false` + 超时 + 输出截断,但**无命令白/黑名单**,安全性完全靠权限引擎档位 —— auto/full-auto 下模型可执行任意二进制;且子进程**原样继承父进程环境变量**(含 `DEEPSEEK_API_KEY`),存在通过 `env`/子命令回显泄露密钥的面。
- **改法:** ① 子进程环境**白名单化**:默认剥离敏感变量(`DEEPSEEK_API_KEY`、`*_API_KEY`、`*_TOKEN`、`*_SECRET`),只透传必要的 PATH/系统变量,可配显式放行。② (可选,分档)高危命令黑名单或 auto 档下的命令确认。先做 env 剥离(收益高、风险低)。
- **影响文件:** `src/tools/builtin/shell.js`、`src/security/shell-policy.js`。
- **风险:** 中。剥离环境可能影响依赖特定 env 的合法命令(如需要代理变量),需保留可配放行。
- **验证:** 单测:子进程 env 不含密钥变量;放行清单生效;现有 shell 执行测试不回归。
- **✅ v1.2.0 已解决(env 部分):** `buildChildEnv` 白名单继承(PATH / Windows 系统变量 / 用户与临时目录 / 区域设置),密钥类与代理键、`NODE_OPTIONS` 默认剥离;`allowExtra` 仅供测试注入,不暴露用户配置面。**命令白名单(改法 ②)延后挂账。**

---

## Tier 3 — 健壮性 / 可观测性

### 8. 语义上下文静默粘性降级 + languages 配置空转(P2)

- **根因(两个相关缺陷):**
  - **静默粘性降级:** [`src/context/semantic/semantic-engine.js`](../../../src/context/semantic/semantic-engine.js) `index()` 中任一异常(如 wasm 缺失)将 `degraded=true`,本引擎实例**此后永久回落文件级,且不发布任何降级事件**,用户无从感知「语义上下文没生效」。
  - **配置空转:** `config.context.semantic.languages` 被 `normalizeLanguages` 归一化但引擎**从未消费** —— provider 与 language-registry 硬编码 js/ts/py。README 宣称「可配 `context.semantic.languages`」,属文档/配置与代码不一致。
- **改法:** ① 降级时发布一次 `context:semantic_degraded` 事件(含 reason),三端展示契约加对应 kind(降权提示);降级仍可粘性,但**可观测**。② 要么让引擎真正消费 `languages`(按配置裁剪加载的 grammar),要么从 config 与 README 移除该项、明确「当前固定 js/ts/py」。二选一消除不一致。
- **影响文件:** `semantic-engine.js`、`src/config.js`、`src/context/semantic/language-registry.js`、README(中英)、D-G4 展示契约(加 kind)。
- **风险:** 低。加事件不改降级行为;languages 决策取「移除文档宣称」路线则零代码风险。
- **验证:** 单测:注入 wasm 加载失败 → 发降级事件且回落文件级;languages 配置行为与文档一致(测其一)。
- **✅ v1.3.2已解决:** 降级事件 exactly-once + reason(`clipReason` 截断 ~200 字符);`languages` 键从 `DEFAULT_CONFIG` 与 `normalizeContext` 移除,`normalizeLanguages` 函数删除;含旧键配置正常加载键静默消失;`tree-sitter-tsx.wasm`(2.4 MB)与 `wasm-tree-sitter-provider.js` tsx 条目同步删除。

---

## Tier 4 — 仓库卫生(P2/P3)

### 9. 卫生集合(逐项独立、可零散清理)

- **9.1 遗留原型物(P3):** 根目录 [`DeepSeekCodeIDE.jsx`](../../../DeepSeekCodeIDE.jsx)(1278 行静态原型,未接运行时)与 `preview-deepseek-code/`(独立 node_modules + 残留 `vite.err.log`/`vite.out.log`)位于仓库根,易与现役 GUI 混淆。**改法:** 移入 `docs/prototypes/` 或删除;清残留日志。**风险:** 极低。**✅ v1.2.0:** 轻量源码迁入 `docs/prototypes/`(node_modules 与 `*.log` 不随迁),原目录删除。
- **9.2 双测试目录(P3):** `test/` 仅剩 1 个 V1 遗留 `patch.test.js` 与 `tests/` 并存,`npm test` 维护两个 glob。**改法:** 迁 `patch.test.js` 入 `tests/unit/`,删 `test/`,`package.json` test 脚本单 glob。**风险:** 极低(纯移动 + 脚本改)。**✅ v1.2.0:** 已迁移,`npm test` 单 glob。
- **9.3 明文变更记录(P2):** `.deepseek-code/changes/<id>.json` 存文件 before/after **全文明文**(事件流已脱敏只发 hash/size,但磁盘记录未脱敏),含密钥文件会全量落盘。**硬约束:回滚依赖存储的 before/after 与 after_hash 复原文件,任何改动存储内容的方案都会破坏回滚,故不能对落盘内容套 `redactor`。** **改法(不碰存储内容):** ① 敏感路径跳过捕获(`.env*`/`*.pem`/`*.key` 等,与 context 扫描的忽略集共用一份),这些文件本就不该进变更记录;② 文件大小上限,超限只存 hash + 摘要不存全文;③ 目录整体限权(收紧 `.deepseek-code/changes/` 权限位)与「展示层脱敏」(GUI/CLI 显示 change 详情时套 redactor,存储保持原文供回滚)。**影响:** `src/edits/change-store.js`、展示侧。**风险:** 中(跳过敏感路径会导致这些文件的 agent 改动无法回滚 —— 但敏感文件本不应被 agent 编辑,属可接受取舍;需与 edit-service 的路径安全集对齐)。**注:此项需单独设计,回滚正确性是硬约束。**
  - **✅ v1.6.2 后端卫生部分:** ②大小上限(默认 1 MiB,超限只存 sha256 + 标 `truncated`,回滚对截断记录抛 `ROLLBACK_TRUNCATED` 而非静默写空,`rollbackChange` 与 `applyRollbackRecord` 双路径)+ ③目录 `0o700`。**另加 ①的替代方案(记录保留期)**:`changeRetention = { maxRecords, maxAgeDays }` 清理旧记录。
  - **⏳ 挂前端片:** ①敏感路径**独立红色风险提醒**(独立于权限档位之外,允许才继续 / 不允许不改,`full-auto` 无人值守建议直接拒绝)与「展示层脱敏」(GUI/CLI 显示时套 redactor)。设计要点见 [`../../plans/backend/2026-08-09-v1.6-backlog-closure.md`](../../plans/backend/2026-08-09-v1.6-backlog-closure.md)「延后项」。
  - **✅ v1.7.0 收官:** ①**敏感文件独立红色风险提醒**三端落地 —— 走 `editService.apply` 预检的独立回调,**不经 permission-engine**、不进审批缓存;**所有档位一律提问(含 full-auto)**,handler 结构上拿不到 autonomy 以杜绝「按档位放行」;判定收窄为 `secret-file` / `credential-file` 两类(全量复用 `contextSkipReason` 会让提醒在改 `dist/` 时也弹,沦为噪音)。②**展示层脱敏**三端落地,存储保持原文,测试同时断言「显示脱敏 + 磁盘原文 + 回滚精确复原」。
    **注:开工时发现原「`full-auto` 无人值守建议直接拒绝」的前提有误** —— 权限矩阵里 `full-auto` 的 `read_secret` / `execute_dangerous` 本就是 `ask`,full-auto 从来不是免打扰档,故改为一律提问,与既有立场一致。
- **9.4 模型名硬编码(P2):** `deepseek-v4-flash`/`deepseek-v4-pro` 硬编码在 [`src/deepseek/model-router.js`](../../../src/deepseek/model-router.js) `CHANNELS` 表,无法经 config 整体切换,只能逐调用 `explicitModel` 覆盖。**改法:** CHANNELS 的模型名改为从 `config.deepseek.models.{act,think,fim}` 读取,保留现值为默认。**影响:** `model-router.js`、`src/config.js`。**风险:** 低-中(需保证默认值与今天一致、覆盖路径测试)。**✅ v1.2.0:** config 顶层 `models.{act,think,fim}` 可配,gateway/FIM 同步透传,缺省与现网一致。
- **9.5 死代码(P3):** [`src/index.js`](../../../src/index.js) `createPausedRecoveryFacade`(约 544-604 行)无任何调用点(实际用 `createRecoveryServiceFacade`/`disabledRecoveryFacade`)。**改法:** 删除或标注。**风险:** 低(需确认确无动态引用)。**注:属 `src/index.js`,若删需与「kernel 零改动」纪律分开立项。** **✅ v1.2.0:** 已删除(净 -101 行,含仅被其使用的 helpers;全仓无引用,回归全绿)。
- **9.6 UMD fallback 第 4 份渲染副本(P2):** `gui/renderer/event-adapter.js` 的 `summarizeEvent`/`eventIcon` 是问题 #5 的残留副本(D-G4 已收敛另三份)。fallback 属受支持的未构建态(`renderer-dist` 是 gitignore 构建产物),但该层不消费 orchestration 事件。**改法:** 改为由共享事件展示契约生成,或在 renderer-dist 构建常态化后删除休眠层。**风险:** 低(休眠层不在主路径)。
- **✅ v1.3.2 已解决:** 整目录 `gui/renderer/` 已删除;`gui/main.js` 加载决策改为 dev URL → renderer-dist,两者皆无→报错退出;删除 2 个对应单测;`npm run check` 移除 `gui/renderer/*` 条目。审计问题 #5 标**完全解决**。
- **9.7 plan checkbox 与 roadmap 回写(P3):** 实施计划 checkbox 全未勾(完成状态只在 CHANGELOG),roadmap spec 未回写已发生的 pivot(Semi UI→手写、CodeMirror→Monaco、xterm→node-pty、D-0/D-G*→D-1~D-5)。**改法:** 文档维护动作 —— 勾掉已完成 plan 项或在 plan 头标「完成状态以 CHANGELOG 为准」;roadmap 补 pivot 注记。**风险:** 无(纯文档)。**✅ v1.2.0:** 51 份历史 plan 头部已标注,roadmap 已补 pivot 注记。

---

## Tier 2 · 可维护性(P2)

### 10. `agent-runtime.js` 可维护性

- **根因(非症状):** 不是「文件有 1150 行」—— 行数只是表征。真正问题是:
  - **职责混合:** 单文件承载回合生命周期编排、四条审批恢复分支(普通工具 / 主验证器 / 修复期工具 / 修复期验证器)、快答/工具循环分流、验证-修复驱动。
  - **依赖集中:** 大量子系统(gateway/executor/verifier/repair/pausedTurnStore/lifecycle)在此汇聚,改一处易牵连。
  - **测试边界不足:** 四条恢复分支存在近似重复的「暂停-保存-清理」样板,缺独立行为刻画,是回归风险集中点(C5/C-Durable 均强调「agent-runtime 一行未改」正因动它风险高)。
- **改法(分阶段,严守不变量):**
  1. **补行为刻画测试(characterization):** 先为 approve 四分支、事件发布顺序、错误语义补足端到端断言,锁住当前行为。
  2. **绘职责/依赖边界:** 标出哪些是纯函数(状态迁移决策、resume_state 组装)、哪些是副作用(发事件、写 sidecar)。
  3. **优先抽纯函数与策略模块:** 把恢复分支的公共「暂停-保存-清理」样板抽成策略/helper,四分支收敛到一处参数化实现。
  4. **再拆状态管理 / 编排 / 适配层:** 分离生命周期状态机驱动与具体阶段执行。
- **硬约束:** 公开 API(`send`/`approve`/`interrupt`)、**事件发布顺序**、**错误语义(code/message)**、审批暂停-续跑时序**全部不变**。
- **影响文件:** `src/core/runtime/agent-runtime.js` 及其测试;可能新增 `src/core/runtime/resume-strategies.js` 等。
- **风险:** 高(内核核心、多恢复路径)。故列 P2、需独立 spec/plan、TDD 全程,不可顺手做。
- **验证(不看行数):** 现有全部 runtime/approval/recovery 集成测试原样全绿;新增刻画测试通过;**边界清晰度**(每模块单一职责、可独立测)与**测试可独立性**为验收标准,而非文件行数下降。
- **✅ 阶段 1–2 已在 v1.6.3 完成(2026-08-09)**:行为刻画测试(`tests/unit/core/runtime/agent-runtime-characterization.test.js` 7 条,含精确事件顺序、四分支续跑序列、错误语义 code/message;变异验证已实际执行确认测试有效)+ 职责/依赖边界分析([`2026-08-09-v1.6.3-agent-runtime-refactor-design.md`](2026-08-09-v1.6.3-agent-runtime-refactor-design.md))。**未改任何实现。**
- **阶段 3–4(抽纯函数 / resume-strategies / 状态机拆分)未开工**,定级再议。

---

## 说明

- 本文覆盖 6 个审计 agent 的全部风险发现,去重归并为 10 个可立项条目(卫生类合并为 #9 的子项以保持 audit 链完整而不膨胀)。
- 未纳入「已知设计取舍」类观察(如恢复默认 opt-in 的多实例锁、隔离 worker 强制 auto、编排 sidecar 有损序列化)—— 这些是文档已自认的有意取舍,非缺陷,若要改属产品决策而非补救。
- 每条独立可立项:P0/P1 建议先行,P2 按容量排期,P3 随手清理。#9.3(明文变更记录)与 #10(agent-runtime)因涉及正确性硬约束,须各自独立 spec。
