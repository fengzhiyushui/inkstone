# Changelog

本文件记录 Inkstone 的版本演进。**自 v1.0.0 起采用[语义化版本](https://semver.org/lang/zh-CN/)** `major.minor.patch`,命名规则与升级判定见 [`docs/README.md` 版本命名规则](README.md#版本命名规则)。

维护约定:
- **每个大版本(major)**给出该版本交付能力的**总结**;其下每个**小版本(minor)/ 补丁(patch)**各追加一条**简要日志**。
- **大版本收官后仅保留其能力总结**,不保留内部里程碑级细节——细节见 [`docs/specs/`](specs/) · [`docs/plans/`](plans/) 与 git 历史。
- 文档更新顺序见 [`docs/README.md` 文档维护规范](README.md#文档维护规范与更新顺序):代码 → specs/plans → project-overview → **本文件** → README(中+英)→ 索引。

---

## [Unreleased]

> 下一个补丁 / 小版本的变更在此累积;发布时按[版本命名规则](README.md#版本命名规则)定级、移入带版本号的小节。

---

## v1.7.2 — 2026-09-19 · GUI 三处现有缺陷 + 敏感模态截图欠账

> 纯 GUI 补丁,内核零改动;是 v1.8.0 换肤(P2 卡片重排)的硬前置。

- **agent 回复从不进消息流**:`workbench-state` 的 `event_received` 不处理 `agent:final`,`messages` 只在用户发送时写入,`ChatView` 的 `.a-msg` 分支自 v1.4.6 起从未渲染过。现 `agent:final` 追加 `{ role:"assistant", text }`(空 content 不追加;stopped 也入流)。
- **状态行数据首屏一次永不刷新**:`getUsage` / `listCheckpoints` 只在挂载时拉一次。现新增纯函数 `refreshLoadsFor(eventType)`,在 `agent:final / agent:error / turn:cancelled / file:rollback_applied` 后重拉两项(不在 model:*/tool:* 上刷,避免每回合十几次 IPC)。
- **敏感文件模态引用 7 个不存在的 CSS 变量**(v1.7.0 引入):`--bg/--bg-1/--bg-2/--bg-3/--fg-1/--mut/--bdr` 在任何样式表中均无定义,红色提醒模态在所有主题下底色透明、文字无色。按语义映射到 `tokens.css` 18 槽修正;新增 `css-vars.test.js` 通用守卫——`shell.css`/`theme.css` 里任何 `var(--x)` 引用未定义槽位即红。实测守卫列出 10 处 `var()` 引用(覆盖 8 个行号;719 行含 `--bdr/--bg-2/--fg-1` 三处),全部落在方案映射表内,无表外同类 bug。
- **v1.7.0 承诺的模态冒烟截图补上**:smoke 链新增 `shell-sensitive-notice` 一景(主进程 push 构造事件,走与内核相同的 `kernel:event` 通道),截图入库 `docs/prototypes/v1.8.0-ergo-restyle/screenshots/`。
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

- **阶段 1 · 行为刻画测试(characterization)**:新增 [`tests/unit/core/runtime/agent-runtime-characterization.test.js`](../../tests/unit/core/runtime/agent-runtime-characterization.test.js) 共 7 条,锁住:
  - 完整回合的**精确事件发布顺序**(此前测试全是 `events.some(...)` 集合式断言,无顺序断言);
  - 四条审批恢复分支(普通工具 / 主验证器 / 修复期工具 / 修复期验证器)各自的暂停-续跑事件序列与终态;
  - 错误语义的**精确 `code` 与 `message`**(`APPROVAL_NOT_FOUND` / `AWAITING_APPROVAL`)。
  - **变异验证已实际执行**(验收标准,非走过场):改错误码 → 错误语义用例红;交换两个事件发布顺序 → 5 条顺序用例全红。两次变异后均已还原。
- **阶段 2 · 职责/依赖边界分析**:交付 [`docs/specs/backend/2026-08-09-v1.6.3-agent-runtime-refactor-design.md`](../../docs/specs/backend/2026-08-09-v1.6.3-agent-runtime-refactor-design.md) —— 当前 1160 行结构的功能分区表、四条恢复分支「暂停-保存-清理」样板的重复点(带行号)、纯函数 vs 副作用分离清单、阶段 3–4 候选方案与风险。
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
- **v1.4.7 前端收口(feat/v1.4 分支)**:侧栏可收放 —— Rail 272px⇄52px 图标轨,`Ctrl/⌘+B` 切换、偏好 `railCollapsed` 持久化,折叠态仅保留功能区图标与页脚「展开/设置」两钮;恢复 `DiffView.jsx` 修复 renderer 构建断裂;补齐 `Ctrl/⌘+N` 新建会话;修复 Rail 分区折叠、首页 busy 中断键、标题栏明暗主题图标(改按 `themes.js` group 判定)三处交互问题;设置页全窗化(不再与 Rail 并列,顶部新增「返回/关闭」按钮,返回原视图),窄窗口菜单栏消失修复(≤900px 时 Rail 改为强制 52px 图标轨而非隐藏);构建与测试加固(renderer-dist 门控、Electron 冒烟截图预算兜底),mimo-v2.5 截图复核 8 视图全绿(修复 smoke 设置截图选错按钮、窄屏折叠偏好残留 52px 空列、改动时间原始 ISO 显示),全量回归 1012 单测 + `npm run check` + renderer build + Electron 冒烟通过。
- **v1.4.0 前端界面重设计(已实现,`feat/v1.4` 分支)**:GUI/TUI 界面全部重做,按 [`plans/frontend/2026-07-31-v1.4.0-frontend-redesign-plan.md`](plans/frontend/2026-07-31-v1.4.0-frontend-redesign-plan.md) 的 P0–P4 落地。**设计定稿**(五轮 HTML 稿,终稿 = [`prototypes/v1.4.0-redesign/v4/`](prototypes/v1.4.0-redesign/v4/)):**10 套主题**(3 浅 7 深,色值取自 Flexoki/Rosé Pine/Catppuccin/Kanagawa/Tokyo Night/Nord/Everforest/Gruvbox Material 官方定义源,WCAG 110 项校验全过,默认 `sumi` 墨)——GUI `tokens.css` 单源 + 设置页外观 10 主题网格,TUI 经 `gen-tui-theme` 生成 xterm-256 调色板 + `/theme`。**GUI 会话优先布局**:rail 功能区(主页/项目/改动/MCP/插件)+ 每项目独立分区(内挂该项目会话,新建会话继承项目目录)+ 独立对话;七视图路由;`.cz-meta` 指标 5 形态(文字/数值/进度条/点阵/关闭)+ 全中文「状态显示」设置组;全局项目 MRU + 会话枚举(kernel 零改动)。**TUI**:opencode 式启动首页(垂直居中/单行 meta/最近会话)+ `/theme` + `/shell`(pwsh/powershell/cmd/git-bash)。

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
