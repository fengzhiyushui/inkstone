# Inkstone 项目说明(内部)

> 这是面向**维护者 / 贡献者**的深入说明。对外的简介、安装与命令速查见根目录 [`README.md`](../README.md) / [`README.en.md`](../README.en.md);本文件覆盖架构内核、工具平面、编辑回滚、持久化恢复、安全不变量、会话事件全集、存储布局与目录地图。所有内容均以当前 `src/` 代码为准。

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
        └─ workspace · security · shared
```

核心原则:**一个** Agent runtime、**一条** 工具执行路径、**一套** 编辑/回滚服务、**一条** 会话时间线;UI 只负责输入、展示与审批,不持有 agent 业务逻辑。

### `createKernel(root, options)`

[`src/index.js`](../src/index.js) 是组合根。常用 `options`:

| 选项 | 默认 | 说明 |
|------|------|------|
| `sessionRoot` | `<root>/.deepseek-code/v2/sessions` | 会话时间线存储根;测试可注入临时目录 |
| `limits` | 见 [§7](#7-运行护栏与配置) | 运行护栏(超时 / token / 调用次数 / 畸形 tool-call 重试) |
| `recovery.enabled` | `false` | 持久化恢复总开关,**默认关闭**(opt-in,见 [§6](#6-持久化恢复)) |

kernel facade:`agent.send()`(发起 turn,经确定性路由器分单/多智能体通道,见 [§14](#14-多智能体编排v3-phase-c1c2))、`agent.approve()`(先路由编排暂停 resume / durable resume,再落 runtime.approve)、`agent.interrupt()` / `agent.listPaused()` / `agent.cancelPaused()`、`dispose()`(幂等:flush 经验 + 释放项目锁);`recovery.*`(list/resume/cancel/clear/report,恢复启用时另有 `abortJournal()`/`commitJournal()`);`experience.*`(C4,见 §14.4);`metrics.*`(用量 / 上下文统计)。

### turn 生命周期

```text
user:message
  → 模型调用(model:request / model:response)
  → 工具循环(见 §3 固定顺序)
  → 验证-修复(verification:result → 必要时 repair:*)
  → 终态:agent:final(status = ok | stopped)或 agent:error
```

命中成本护栏(`maxTurnTokens` / `maxModelCalls`)时,turn **优雅停止**:发 `agent:final` 且 `status:"stopped"`,跳过 verify/repair,`send()` 正常返回 `{ status:"stopped", content, budget }`,而非抛错。

---

## 2. DeepSeek 适配

[`src/deepseek/`](../src/deepseek/) 负责 DeepSeek 专属协议。

### 模型路由([`model-router.js`](../src/deepseek/model-router.js))

按"用途"路由到不同模型与参数:

| 用途 | channel | 模型 | thinking | 流式 | 备注 |
|------|---------|------|----------|------|------|
| `reply` / `act` | `act` | `deepseek-v4-flash` | disabled | 是 | 日常对话与工具调用 |
| `plan` / `review` / `repair` | `think` | `deepseek-v4-pro` | enabled(`reasoning_effort: high`) | 否 | 规划 / 评审 / 修复 |
| `fim` | `fim` | `deepseek-v4-pro` | — | — | 代码补全,走 `/beta/completions` |

- `reply` 且 `complexity:"high"` 时自动改走 `plan` 档。
- 模型 id 是项目当前的默认值,可经 `DEEPSEEK_MODEL` 或 `config.json` 覆盖。

### 其余协议件

- **JSON mode guard**([`json-mode.js`](../src/deepseek/json-mode.js)):只有明确要求结构化 JSON 的调用才启用 `response_format`。
- **SSE streaming**([`streaming.js`](../src/deepseek/streaming.js)):流式解析。
- **tool-call 规范化 + 畸形重试**([`tool-call-repair.js`](../src/deepseek/tool-call-repair.js)):规范化模型吐出的 tool-call;参数非法 JSON 时按 `maxToolCallRepairs` 有界重试(发 `model:tool_call_repair`)。
- **用量遥测**([`usage-tracker.js`](../src/deepseek/usage-tracker.js)):token、reasoning token、cache hit/miss、latency。
- **超时**([`model-gateway.js`](../src/deepseek/model-gateway.js)):`invoke` / `stream` / `fimComplete` 支持 `timeoutMs`,超时抛 `MODEL_TIMEOUT`(与调用方 signal 合并)。定时器在 **body 读完之后**才解除,故 SSE 流读与 `response.json()` 悬挂同样受约束;不传 `timeoutMs` 则不设超时。

---

## 3. 工具平面

[`src/tools/`](../src/tools/) 提供注册表、schema、executor 与权限引擎。内置工具([`builtin/index.js`](../src/tools/builtin/index.js)):

| 类别 | 工具 |
|------|------|
| 文件 | `read` · `ls` · `grep` · `glob` |
| 编辑 | `diff_preview` · `diff_apply` · `diff_rollback` · `edit` |
| 进程 | `shell` · `test` · `git` |
| 网络 | `web_fetch` |
| 记忆 | `memory` |
| 协作 | `task` · `ask_user` |

编辑类工具是"延迟绑定"的([`builtin/edit-deferred.js`](../src/tools/builtin/edit-deferred.js)),在内核装配时注入 `editService`:`diff_preview → preview`、`diff_apply`/`edit → apply`、`diff_rollback → rollback`。

> **v1.2.0 工具安全加固:** `grep` 带每文件 2s + 总 10s 协作式超时(超时优雅返回,metadata 标注 `timed_out` 等字段,病态正则不再挂死);`shell` / `test` / `git` 子进程环境**白名单继承**(`buildChildEnv`:仅 PATH、系统、用户/临时目录、区域键;密钥与代理变量默认不可见);模型 id 可经 config 顶层 `models.{act,think,fim}` 整体切换,缺省不变。
>
> **v1.3.1 命令级安全策略:** `shell`/`git` 子进程执行在权限档位之外新增**命令级分类**([`src/security/command-policy.js`](../src/security/command-policy.js)):forbidden(format/mkfs*/diskpart/bcdedit/dd)映射 `destructive` 各档一律拒绝且审批缓存不可放行;dangerous(删除类/系统类/curl/wget/npm publish/git push 强推/包装 shell/解释器执行参数)映射 `execute_dangerous`,supervised–full-auto 一律人工确认(read-only 拒绝);`runProcess` spawn 前兜底拒绝 forbidden。审批 summary 附带 argv 预览,事件展示契约 `argHint` 修复读取 `call.params`。

### 固定执行顺序

```text
ToolCall
  → schema validation
  → parameter normalization
  → permission decision
  → approval(若需要)
  → execution
  → result redaction
  → tool:result 事件
  → model feedback
```

**工具超时**:`executor` 支持 `defaultToolTimeoutMs` / `context.toolTimeoutMs`;超时落为标准 `status:"error"` 结果(`metadata.timeout = true`),**不抛错、不强杀进程**。

---

## 4. 编辑与回滚

[`src/edits/`](../src/edits/) 把成熟的 diff pipeline 暴露为 `EditService`:

- `preview(diff)` —— 解析 diff 并生成摘要,不写文件。
- `apply({ diff, prompt, approval_id })` —— 预检路径 → 建快照 → 应用 diff → 记录 change id。
- `rollback(change_id)` —— 回滚指定变更。
- `describe(change_id)` / `list({ limit })` —— 查看变更记录。

变更记录落在 `.deepseek-code/changes/<id>.json`,回滚记录落在 `.deepseek-code/rollbacks.jsonl`。

> **v1.6.2 记录卫生(#9.3 后端部分):**
> - **大小上限**:单文件超过 `maxCaptureBytes`(默认 1 MiB)时只存 `sha256` + 原始大小,不存全文(`before`/`after` 为 `null` 并标 `truncated: true`)。**回滚是硬约束**:`truncated` 记录缺 before 全文,`rollbackChange` 与 `applyRollbackRecord`(GUI/edit-service 路径)都会抛 `ROLLBACK_TRUNCATED`,**绝不写 `before ?? ""` 把文件清空**。经 `createEditService({ edits })` 可覆盖(`maxCaptureBytes: null` 关闭上限)。
> - **保留期 / 数量上限**:`finalizeChange` 写新记录后按 `changeRetention = { maxRecords, maxAgeDays }` 做确定性清理(超出者删),只删 `.deepseek-code/changes/*.json`,不碰工作区文件。
> - **目录限权**:`changes/` 目录以 `0o700` 创建;Windows 上 `fs.chmod` 基本无效,此条仅在类 Unix 生效。
> - **展示层脱敏与敏感文件提醒**属前端片,另行立项。
>
> **v1.7.0(#9.3 收官):**
> - **敏感文件独立风险提醒**:改 `.env` / `*.pem` / `*.key` / `.npmrc` 等文件前,三端红色告知「完整原文会写入变更记录」并由用户拍板;拒绝则该文件不改动(`SENSITIVE_EDIT_DECLINED`)。走 [`edits/sensitive-notice.js`](../src/edits/sensitive-notice.js) 判定 + `editService.apply` 预检的独立回调,**不经 permission-engine、不进审批缓存、所有档位一律提问**(策略见 [`apps/sensitive-notice-contract.js`](../src/apps/sensitive-notice-contract.js))。判定只取 `secret-file` / `credential-file`,不含 `ignored-directory` / `hidden-tool-dir`。
> - **展示层脱敏**:CLI/TUI 经 `formatChange`、GUI 经 `changes:describe` 桥,显示前过 `redactor`;**存储保持原文供回滚**。
>
> **v1.7.1(生产接线):**
> - `config.edits` 进入 `DEFAULT_CONFIG` 并经 `buildKernelOptions` / `createKernel` → `createEditService` 全链路生效。默认 `maxCaptureBytes: 1 MiB`、`changeRetention: { maxRecords: 200, maxAgeDays: 90 }`;传 `null` 可分别关闭截断与清理。**此前内核不注入 `edits`,保留期代码虽在、生产路径永不 prune** —— 本版堵上。

---

## 5. 会话、分支与 rewind

- **时间线**:每个会话是一个 append-only JSONL,存于 `.deepseek-code/v2/sessions/<projectId>/<sessionId>.jsonl`([`sessions/event-log.js`](../src/sessions/event-log.js))。
- **分支**:可从任意 turn 分叉,记录于同目录 `<sessionId>.branches.json`([`sessions/branch-store.js`](../src/sessions/branch-store.js))。
- **rewind**:回到历史状态([`sessions/rewind-service.js`](../src/sessions/rewind-service.js))。

### 事件全集

事件类型由 [`sessions/event-types.js`](../src/sessions/event-types.js) 集中定义(`SESSION_EVENT_TYPES`,当前约 56 种),按前缀分类:

| 前缀 | 覆盖 |
|------|------|
| `session:` | start / resume / branch_created / branch_activated / rewind_*(preview/started/applied/conflict/failed/restore_started/restored/recovery_failed) |
| `recovery:` | started / blocked / report |
| `tx:` | opened / committed / recovered |
| `turn:` | paused / rehydrated / resumed / cancelled |
| `takeover:` | requested / completed |
| `user:` / `agent:` | user:message · agent:turn_started / step / final / error |
| `model:` | request / response |
| `tool:` / `permission:` / `approval:` | tool:call / result · permission:decision · approval:requested / resolved |
| `context:` | snapshot / pin / unpin / warm / cache_loaded / cache_saved / cache_reused |
| `file:` | diff_preview / diff_applied / rollback_applied / transaction_*(started/committed/failed/rolled_back) / rollback_conflict |
| `verification:` / `repair:` | verification:result · repair:started / attempt / result / exhausted |

> 以代码为准:session-manager 只订阅 `SESSION_EVENT_TYPES` 中登记的类型——未登记的事件不会报错,而是**静默不入会话时间线**(仅走 eventBus);需持久化的新事件必须先登记。另有刻意的 eventBus 级事件(不入时间线):`orchestration:*`(§14/§14.3)、`experience:*`(§14.4)、`context:symbol_indexed` / `context:graph_built`(§13)。

---

## 6. 持久化恢复

跨进程崩溃安全恢复(V2-18 引入),**默认关闭**;开启:`createKernel(root, { recovery: { enabled: true } })`。**关闭时,edit/rewind 行为逐字节不变。**

组成([`src/core/recovery/`](../src/core/recovery/)):

- **项目锁 + epoch fencing**:`.deepseek-code/v2/.lock`,防并发写;`kernel.dispose()` 幂等释放。
- **暂停 sidecar 持久化**:`.deepseek-code/v2/sessions/<projectId>/paused/`,审批暂停的 turn 落盘以便重水化。
- **恢复收件箱**:`.deepseek-code/v2/recovery/inbox.json`,启动扫描登记待恢复项。
- **事务日志**:`.deepseek-code/v2/journal/`,edit/rewind 写文件前 `open()`、成功 `commit()`、失败 `abort()`(恢复 preimage)。
- **CLI `/recovery`** 与启动扫描:发现 open/aborting/committed/corrupt 日志并入收件箱。
- **编排级 durable 恢复**(C-Durable,`recovery.enabled` 开启时):编排回合中串行主区 worker 命中审批暂停 → 除 worker turn sidecar 外另落 `orchestration-paused/<approvalId>.json`;重启后 `/recovery` 呈现 `orchestration_paused` 项,resume 精确重水化被暂停的 worker turn 并续编排回合。详见 [§14.5](#145-跨进程编排级-durable-恢复c-durable默认关)。

详见设计文档 [`specs/backend/2026-06-01-v2-18-durable-recovery-resume-hardening-design.md`](specs/backend/2026-06-01-v2-18-durable-recovery-resume-hardening-design.md)。

---

## 7. 运行护栏与配置

> 配置哲学:**在适配 DeepSeek 的前提下,参数尽量交给用户。** 默认值只给"安全合理的起点",不锁死;每个旋钮都能覆盖。

护栏经 `createKernel(root, { limits })` 生效,默认值来自配置([`src/config.js`](../src/config.js) 的 `DEFAULT_CONFIG.limits`,是默认值的单一来源):

| 参数 | 默认 | 含义 |
|------|------|------|
| `toolTimeoutMs` | `120000`(开) | 单次工具调用超时;超时落为 `status:"error"`,不强杀进程 |
| `modelTimeoutMs` | `120000`(开) | 单次模型调用超时(工具循环 / 审批 resume / 修复三路径均覆盖) |
| `maxTurnTokens` | `null`(关) | 单个 turn 的 token 上限;命中后优雅停止(`status:"stopped"`) |
| `maxModelCalls` | `null`(关) | 单个 turn 的模型调用次数上限 |
| `maxToolCallRepairs` | `null`(关) | 模型吐出畸形 tool-call 时的有界重试次数 |

> **v1.6.1:** `maxTurnTokens` / `maxModelCalls` 的计数范围含 **repair 阶段**——`runRepairLoop` 接入 `budget`,repair 期模型调用经 `recordModelResult` 计入;命中时 repair 优雅停止(`status:"stopped"`,reason 同工具循环),不抛错、不继续调模型。`budget` 未注入时行为与此前一致。

**取值语义**(`toLimit`):省略 → 取默认;`null` → 关闭;`≤0` 或非法 → 关闭;否则取整。

**覆盖方式**:① 编辑 `config.json` 的 `limits`;② 环境变量 `DEEPSEEK_TOOL_TIMEOUT_MS` / `DEEPSEEK_MODEL_TIMEOUT_MS`。`loadConfig` 对用户 `limits` 做 per-field 深合并。

```json
{ "limits": { "toolTimeoutMs": 180000, "maxTurnTokens": 200000, "maxModelCalls": 40, "maxToolCallRepairs": 1 } }
```

**配置文件位置**:项目级 `./.deepseek-code/config.json`(优先)与用户级 `~/.deepseek-code/config.json`(回退);本地覆盖用户级。自 v1.1.0 起 CLI / TUI / GUI **共用 `src/apps/kernel-options.js` 的同一 `buildKernelOptions` 实现**,统一透传 `config.limits`、`config.orchestration`、`config.context` 与 semantic override,不再有 GUI CJS 副本漂移。

---

## 8. 安全不变量

- 文件路径以 realpath 校验 workspace 边界,阻断 symlink 逃逸([`workspace/path-safety.js`](../src/workspace/path-safety.js))。
- 工具 category 只信任注册表定义,不信任模型传入字段。
- destructive 操作永不被 trust rule 自动放行。
- `shell` 只接受结构化 argv,以 `shell:false` 执行([`security/shell-policy.js`](../src/security/shell-policy.js))。
- `web_fetch` 阻断 localhost / 私网 / link-local / CGNAT / benchmark / 文档保留 / 组播等保留网段与 IPv4-mapped IPv6 / IPv6 literal;校验**全部 DNS A 记录**,每跳 redirect 重新校验;默认网络层固定到已验证 IP 直连(原 hostname 保留作 Host/SNI),避免 DNS rebinding/TOCTOU([`security/ssrf.js`](../src/security/ssrf.js))。
- 输出中的密钥会被脱敏([`security/redactor.js`](../src/security/redactor.js)):Bearer/常见 key/token/secret/password 赋值、AWS/GitHub/sk- 确定性 token 前缀与多行私钥块;不做易误伤 hash/base64/源码常量的通用高熵猜测。
- GUI 采用 `nodeIntegration:false` + `contextIsolation:true` + `sandbox:true` + IPC 白名单(强制生效:`IPC_CHANNELS` 唯一权威清单,未登记 channel 的 handle 注册即抛错)。
- **敏感文件写入前的独立风险提醒(v1.7.0)**:agent 改 `.env` / `*.pem` / `*.key` / `.npmrc` 等文件时,因回滚需要,其**完整原文**会落进 `.deepseek-code/changes/`(不可脱敏)。此事在**编辑发生之前**红色告知用户并由其拍板。**该提醒独立于权限矩阵之外** —— 不经 `permission-engine`、不进审批缓存、**没有任何自治档位能跳过**(含 `full-auto`,与其 `read_secret`/`execute_dangerous` 恒为 `ask` 的既有立场一致)。

---

## 9. 本地存储布局

整个 `.deepseek-code/` 已被 `.gitignore` 忽略,不入库:

```text
.deepseek-code/
  config.json                  本地配置(含 API Key)
  gui-api-profiles.json        API 接入列表(GUI/TUI 共享,文件名历史遗留)
  gui-preferences.json         GUI 偏好(语言/主题/状态显示/railCollapsed 等)
  tui-prefs.json               TUI 偏好(/lang 等)
  changes/<id>.json            变更记录
  rollbacks.jsonl              回滚记录
  sessions.jsonl               旧版会话日志(resume 命令读取)
  v2/
    sessions/<projectId>/
      <sessionId>.jsonl        V2 会话时间线
      <sessionId>.branches.json 分支
      paused/                  暂停 sidecar(恢复启用时)
      orchestration-paused/    编排暂停 sidecar(C-Durable,含 quarantine/)
    context/                   上下文缓存
    experience/                跨任务经验库(C4:experience.json · experience-evictions.jsonl · pending.json)
    orchestration/iso/<runId>/ C3 并行 Worker 隔离工作区(瞬态,任务后清理)
    recovery/inbox.json        恢复收件箱
    recovered/<txId>/          事务恢复保全的 preimage(恢复启用时)
    journal/                   事务日志
    .lock/                     项目锁
```

---

## 10. 目录地图

```text
src/
  index.js        createKernel() 组合根
  core/
    runtime/      agent-runtime(见 #10:阶段 1–2 刻画测试 + 边界分析已落,v1.6.3)· lifecycle · cost-budget
    execution/    executor-loop · repair-executor · tool-call-adapter · tool-result-router
    verification/ verifier · repair-loop · repair-decision · repair-prompt · verification-policy
    protocol/     agent-turn · agent-step · tool-call · tool-result · approval-request · artifact
    planning/     classifier
    approval/     paused-turn-store
    recovery/     项目锁 · 收件箱 · 暂停持久化 · 事务日志 · 恢复服务(opt-in)
  deepseek/       model-gateway · model-router · json-mode · streaming · fim-client · usage-tracker · tool-call-repair · prompt-assembler · api-errors
  tools/          registry · schema · executor · builtin/* · permissions/*
  edits/          diff-parser · change-store · rollback-service · edit-transaction · edit-service
  sessions/       event-types · event-log · branch-store · checkpoint-index · rewind-transaction · rewind-service · session-manager
  context/        context-unit · token-budget · workspace-indexer · context-selector · context-snapshot · context-manifest · context-cache
  workspace/      path-safety
  security/       shell-policy · ssrf · redactor
  apps/           kernel-options · api-profiles(GUI/TUI 共享 API 列表)· model-catalog · event-contract(三端共享事件展示契约,见 §16)· cli/(render-events · kernel-runner)· tui/(D-5 行内滚动流 TUI 十模块,见 §16)
  shared/         id · time · event-bus
  (顶层)         cli.js · config.js · context.js · git.js · patch.js · changes.js · provider.js · search.js · theme.js · tui.js(D-5 薄入口)
gui/              Electron:main.js · preload.js · kernel-host.js(+ 文件桥 listTree/readFile)· src/(React+Vite v1.4 会话优先渲染层:components/v4/ + hooks/state/i18n,lucide-react 图标,Monaco 只读 Diff,**无交互终端**——xterm/node-pty 死路径已清理,node-pty 仅保留供门控 TUI smoke)· styles/(tokens.css v4 十套主题 + shell.css + theme.css 存活子集:标题栏/按钮/Diff)· renderer-dist/(构建产物,gitignore)· vite.renderer.config.mjs
docs/             specs/ · plans/ · CHANGELOG.md · README.md(文档中心)
tests/ + test/    单元 / 集成 / e2e
preview-deepseek-code/ · DeepSeekCodeIDE.jsx   前端原型(V3 Phase D,未接入运行时)
```

> 顶层 `cli.js`/`config.js`/`context.js`/`git.js`/`patch.js`/`changes.js`/`provider.js`/`search.js`/`theme.js` 是 V1 时代保留、现作为 V2 共享依赖的工具模块,**不属 legacy**;`tui.js` 已在 D-5 重写为薄入口,实现全在 `src/apps/tui/`(见 §16);V1 并存内核(`src/kernel/*`、`agent.js`、`chat.js`、`ui.js`)已于 V2-19 删除。

---

## 11. 已知限制

- 持久化恢复默认关闭(opt-in);未开启时,会话 / 变更 / 分支**无跨进程文件锁**——勿在同一项目目录并发运行多个会写状态的实例。
- repair executor 目前是单轮修复执行器;多轮自动诊断与更复杂的验证策略待扩展。
- GUI 用量统计在离线或未接入真实模型调用时可能显示零值。
- 模型 id(`deepseek-v4-flash` / `deepseek-v4-pro`)是项目当前默认值,以 `config.json` / `DEEPSEEK_MODEL` 为准覆盖。

---

## 12. 开发与文档维护

```bash
npm test            # node --test:test/ 与 tests/ 下全部用例
npm run check       # node --check:全部源码语法校验
git diff --check
```

文档更新顺序与规范(代码 → specs/plans → project-overview → CHANGELOG → README 中+英 → 索引)见 [`docs/README.md`](README.md#文档维护规范与更新顺序)。

---

## 13. 语义级上下文引擎(可选,opt-in)

> V3 Phase B 引入(B+1 方法消歧、B+3 query 统一抽取 + 扩 Python)。设计见 [Phase B](specs/backend/2026-06-26-v3-phase-b-semantic-context-design.md) · [B+1](specs/backend/2026-06-26-v3-phase-b-plus1-method-hints-design.md) · [B+3](specs/backend/2026-06-26-v3-phase-b-plus3-multi-language-design.md);实施见 [Phase B plan](plans/backend/2026-06-26-v3-phase-b-semantic-context.md) · [B+3 plan](plans/backend/2026-06-26-v3-phase-b-plus3-multi-language.md)。

在现有文件级上下文之上增加**符号层**,**默认关闭**(`context.semantic.enabled`);关闭时引擎行为(单元、事件、快照)与文件级**逐字节一致**。

启用后:web-tree-sitter(WASM,随仓 vendored grammar,放 `optionalDependencies`,仅启用时懒加载)解析 **JS / TS / Python**(tree-sitter query 统一抽取,每语言一份定义)→ 符号表 + import/export 绑定 + **尽力静态调用图**(直接调用 `resolved`;`obj.method()` / 动态调用标 `unresolved`,每条边带 `confidence` / `reason`)→ symbol-selector 从种子符号沿依赖图扩 N 跳、按预算选**符号级**片段;不支持 / 解析失败的文件回退文件级单元;provider 整体不可用则全量退回文件级,**永不崩**。

配置(`config.json` 或 `createKernel(root, { context: { semantic: { enabled: true } } })`):

| 字段 | 默认 | 含义 |
|------|------|------|
| `enabled` | `false` | 总开关 |
| `hops` | `2` | 依赖图扩展跳数 |
| `maxSymbols` | `200` | 候选符号上限(成本闸) |
| `includeMethodHints` | `false` | 方法调用消歧(B+1):`obj.method()` 项目内唯一同名 → `probable` 边 |
| `languages` | `["js","ts","py"]` | 启用的语言(白名单 js/ts/py,去重) |
| `importRoots` | `[]` | Python 模块搜索根(**追加**非替换;`[]` ≡ 仅项目根) |

模块位于 [`src/context/semantic/`](../src/context/semantic/):parser-provider · wasm-tree-sitter-provider · **query-extractor**(通用 runner:query.matches 组装 + 字节序排序 + enclosing + 降级)· **language-registry** + **languages/{javascript,typescript,python}**(每语言 query + 处理器)· **symbol-id** · symbol-cache · symbol-indexer · module-resolver · **python-module-resolver** · dependency-graph · symbol-unit · symbol-selector · semantic-engine。新事件 `context:symbol_indexed` / `context:graph_built` **仅在语义启用时**触发。

---

## 14. 多智能体编排(V3 Phase C1+C2)

> **v1.1.0 意图分类修复:** `core/planning/keywords.js` 集中维护 classifier 与 complexity router 的中英词表;中文 edit/diagnostic/query、疑问语气与全角问号不再落入 `general`,路由层与分类层不再各持一套语言假设。
>
> 设计见 [C1+C2 spec](specs/backend/2026-06-27-v3-phase-c1-c2-orchestration-design.md);实施见 [C1+C2 plan](plans/backend/2026-06-27-v3-phase-c1-c2-orchestration.md)。

**单 / 多 agent 合并为一条路**:`kernel.agent.send()` 内部经**确定性路由器**(`task-router.js`,升级 `classifier`,启发式、无模型调用、无 on/off 开关)判复杂度 ——

```
kernel.send(message) → task-router
   ├─ lane="single"      → agentRuntime.send()   今天的路径,逐字节零回归、不发新事件
   └─ lane="orchestrate" → orchestrator.run()     Planner → 串行 Worker → 两级审核 → Synthesizer
```

**关键不变量**:`agent-runtime.js` **一行未改** —— Worker / Reviewer 都是 `createAgentRuntime` 实例(经 `createRuntime` 覆盖工厂注入**工具子集** + **作用域上下文**),编排层只在公开边界 `send()` 之上组合。

**组件**([`src/core/orchestration/`](../src/core/orchestration/)):

| 单元 | 职责 |
|------|------|
| `task-router` | 启发式判 `single \| orchestrate`(markers + 文件数信号),产出 `RoutingDecision` |
| `subtask-schema` | `Plan` / `SubTask` / `Verdict` 校验 + `topoOrder`(环检测) |
| `planner` | 模型(thinking)→ 结构化 `Plan`;schema 校验 + 有界重试 + 环检测 + **降级单子任务** |
| `tool-profiles` | 从 registry 过滤 `edit` / `readonly` 工具子集 |
| `worker-factory` | 按 `SubTask` 建 Worker(`edit`)/ Reviewer(`readonly`)runtime |
| `reviewer` | **独立**只读复查 Worker 产出 → `Verdict`;不可解析则保守 `pass:false/warn` |
| `dispatch-loop` | 确定性循环:topo 串行 + 关卡1 子自审重试 + 关卡2 打回重试 + `maxWorkerAttempts` 有界 + 预算命中→部分完成 |
| `synthesizer` | 汇总子任务产出 + 失败诚实汇报(模型,失败回退确定性摘要) |
| `orchestrator` | 组装上述 + 聚合成本闸 + 发 `orchestration:*` 事件 + `maxSubtasks` 截断 |

**两级审核**:关卡1 = Worker 内置 `verifyAndMaybeRepair`(局部、便宜);关卡2 = 独立 Reviewer(全局、只读工具物理不可改)。确定性 gate 读 `verdict.pass` 决定收 / 打回。

**成本闸常开**(`config.orchestration`,无 on/off):`maxSubtasks` / `maxWorkerAttempts` / `budget`(聚合 token + 调用数,planner/worker/reviewer/synth 全计入)。命中→**优雅停止 + 部分完成**,不抛不崩。

**事件**:`orchestration:routed` / `:planned` / `:subtask_started` / `:subtask_reviewed` / `:completed`,**仅 `orchestrate` 档触发**(`single` 档与今天一致)。

**非目标(留后续片)**:C3 并行 Worker 的 worktree 写隔离、C4 跨任务经验记忆、C5 Reviewer 打回触发重规划 / 持续派发、编排级 durable 恢复、模型驱动路由(已规划为 router 的分层增强:明显档免费启发式,模糊档才调模型)。

### 14.1 并行写隔离(C3)

**无依赖 + 声明文件范围不重叠**的子任务**并行**执行;`dispatch-loop` 把 topo 序切成**批**(`batch-planner`:依赖已完成 ∩ 范围两两不重叠 的最大集)。批大小 1 或 `maxParallelWorkers=1` → 走 C1+C2 在主区的原路(零拷贝、零回归);批 >1 → 每 Worker 隔离执行后合并。

并行 Worker 流程(`iso-worker-runner`):`createIso`(`.deepseek-code/v2/orchestration/iso/<runId>/<subtaskId>` + `.owner`)→ `fsCopyWorkspace`(排除 `.git`/`node_modules`/`.deepseek-code`,受 `maxCopyFiles`)→ `hashTree` 记 `baseManifest`(path→sha256)→ `buildToolPlane(isoRoot)` 给一套绑定隔离目录的工具(`agent-runtime` 不改)→ 隔离 runtime `send` → 独立 Reviewer(只读)→ `changedPaths` 算实际改动。

合并(`merge-back`,按 subtask id 序):**实际写入范围校验**(`actual ⊆ 声明` 且批内实际不重叠,`path-overlap` 归一化判定)→ **CAS**(主区每路径 hash==base/create 不存在/delete==base)→ 整文件净 unified diff **一次 `editService.apply`**(原子:整 subtask 落主区 or 全回滚)。冲突/越界 → 该 subtask 失败,主区不变。**批次部分成功**(非整批 all-or-nothing)。

**零残留**:每 Worker `finally` 删拷贝(`removeIso` retry+backoff 抗 Windows 句柄)+ 批末删 run 目录;kernel 启动 `sweepOrphans`(owner pid + TTL,只清超时/本进程旧 run,不误删活跃)。**降级**:`maxCopyFiles` 超阈值 → 该子任务失败诚实上报。`config.orchestration.parallel = { maxParallelWorkers:4, maxCopyFiles:5000, sweepTtlMs:1h }`,`maxParallelWorkers=1` 即关并行。

组件:[`src/core/orchestration/`](../src/core/orchestration/) 的 `batch-planner` · `path-overlap` · `workspace-snapshot` · `iso-workspace` · `iso-worker-runner` · `merge-back`;`index.js` 的 `buildToolPlane(root)`。

### 14.2 重规划 + 持续派发回合循环 + 同进程续跑(C5)

`orchestrator.run` 由「规划一次→派发一次」一般化为**确定性回合循环**(`driveFrom`):`plan → runDispatchLoop → gateAndReplan → 下一轮`,直到 done / 预算 / `maxRounds`(默认 2,`=1` 退化 C1+C2)。

- **重规划**:`planner.replan({message,done_when,completed,failed}) → {done,subtasks}`(模型 + `validateReplan` 严格校验 + 有界重试 + 保守收尾)。失败子任务 → corrective 子任务;不完整 → 继续子任务;真完成 → `done:true`。
- **终止闸 `gateAndReplan`**(程序逻辑,非模型):`round>=maxRounds` / `budget.exceeded()` / `replan.done` / 空 / **无进展守卫**(本轮零新增 completed 且 replan 指纹全已见,`fingerprint=goal+sorted(files)+profile`,防换 id 原地打转)任一 → 停。两套集合 `seenSubtaskIds`(id 跨轮唯一)/ `seenFp`(无进展)**不混用**。
- **终判 `classifyOutcome`**(`synthesizer.js`):`done:true` 仅停派发**不代表成功**;有 failed → `partial`;被 cap 停且无 failed → `incomplete`;否则 `complete`。
- **同进程编排级续跑**:回合中串行主区 Worker 命中审批暂停 → `dispatch-loop` 返回 `RoundResume{pausedWorker,pausedApprovalId,pausedSubtask,remaining,deps}`;orchestrator 存内存 `orchPaused`(键=approvalId)连同编排状态;`kernel.agent.approve` 路由 `orchestrator.hasPaused(id) ? orchestrator.resume : runtime.approve`。`resume`:消费旧条目 → `resumeDispatchLoop`(approve/deny 被暂停 worker → 续本回合 `remaining`)→ `driveFrom(afterPausedRound)` 续后续回合,**不重 plan、不重复派发**;再次暂停以新 id 入表。**结算单一来源 `allCollected`**;`agent-runtime` 不改(orchestrator 持 worker 实例引用续其 turn)。暂停只发生在串行主区 Worker(并行 iso 仍 `auto`)。跨进程崩溃恢复留「编排级 durable 恢复」后续片。
- 新增/改:`subtask-schema`(`validateReplan`/`fingerprint`)· `planner.replan` · `synthesizer.classifyOutcome` · `dispatch-loop`(`RoundResume`/`resumeDispatchLoop`)· `orchestrator`(回合循环 + `resume`/`hasPaused`)· `config.orchestration.maxRounds` · `index.js`(approve 路由)。

### 14.3 分层路由(C-Router,模型辅助复杂度判定)

> 设计见 [C-Router spec](specs/backend/2026-06-27-v3-phase-c-router-tiered-design.md);实施见 [C-Router plan](plans/backend/2026-06-27-v3-phase-c-router-tiered.md)。

把确定性路由器从「纯关键词启发式」升级为**分层**:启发式按特征算 `score` → 三档,只有**模糊中间档**才花一次便宜模型调用判复杂度。

```
route(message) → 启发式评分(router-scoring,纯)
   ├─ score==0           → simple     → single        免费(无模型调用)
   ├─ score>=阈值(默认3) → complex    → orchestrate    免费(无模型调用)
   └─ 0<score<阈值        → ambiguous  → 模型档判 lane(失败回退启发式)
```

- **评分特征**:强 marker +2 / 弱 marker +1 / 文件 token 首个免计其后 +1(封顶 3,与 `minComplexFiles` 对齐)/ **长 edit 捕手** +1(`task_type=edit` 且消息 ≥80 字 —— 修「无关键词长编辑被漏判」)。文件 token 归一化(`\`→`/`、去 `./`、小写、去重)防分数飘。
- **模型档默认开**(首次主动打破默认零回归);**opt-out**:`router.model.enabled=false` → 逐字节回到今天(`signals`-only),且**裸构造无 `callModel` 亦回退今天**(`modelActive = enabled 且真注入 callModel`)。`signals`(今天 marker+文件)与 `score`(含长 edit 捕手)**严格分离**,长 edit 捕手永不进 `signals` → disabled-parity。
- **模型档**(复刻 planner):`gateway.invoke({purpose: 配置 channel,默认 act/flash})`;**总调用 ≤ `maxRepairs+1`**、**总超时 = `timeoutMs`(默认 8000ms)跨重试**;畸形/超时/空网关/抛错**全收敛同一启发式兜底**,带短码 `reason`(`router_model_timeout`/`_invalid`/`_empty`/`_error`)。**`route()` 启发式档同步、仅模糊档返回 Promise**(`index.js` 已 await)。
- **事件**:`orchestration:route_resolved`(eventBus 级、不入 `SESSION_EVENT_TYPES`,同现有 `orchestration:routed`)**仅模型档运行时**发,载 `score`/`features`(脱敏:短 token+计数,无完整消息)/`band`/`tier`/`reason`。
- 配置:`config.orchestration.router.model = { enabled:true, channel:"act", timeoutMs:8000, maxRepairs:1, complexThreshold:3 }`。组件:[`src/core/orchestration/`](../src/core/orchestration/) 的 `router-scoring`(新)+ `task-router`(分层);`index.js` 注入 `routerCallModel`。`agent-runtime.js` / `classifier.js` **不改**。

### 14.4 跨任务经验记忆(C4,默认关)

> 设计见 [C4 spec](specs/backend/2026-06-27-v3-phase-c4-experience-memory-design.md);实施见 [C4 plan](plans/backend/2026-06-27-v3-phase-c4-experience-memory.md)。

在编排之上加**跨任务经验沉淀**:次 agent 在任务边界提炼教训 → 独立经验库 → 新任务 planner 检索影响拆派 + 风险经验联动权限。**开关 `config.orchestration.crossTaskLearning = "off"|"on"|"gated"`,默认 `off`**——关闭时无检索/巩固/升级/事件/目录,与 C1–C5 逐字节一致。

```
新任务: 检索经验(retrieval) → planner 拆派(prompt 注入判断简报)
任务边界: 巩固器(次 agent,后台异步) → 提炼教训 → 经验库(三级分化)
                                       └ adopted 经验按 task outcome 强化/削弱
```

- **彻底分开主记忆**:经验库存 `<root>/.deepseek-code/v2/experience/`(独立目录、富 schema:置信度/层级/出处/验证次数),与 `tools/builtin/memory.js` 的项目事实库互不污染;可一键清空而不碰事实与事件时间线。
- **三级分化**(`experience-scoring`,纯):`score = conf + 0.1·ln(1+validations) − decay·age − 0.2·misleads`,`tierOf` 按 `T1/T2/T3`(默认 .7/.4/.2);跌破 T3 即删、超 `cap`(默认 200)末位淘汰(确定性 tie-break:score→lastReinforced→created→id)。**聚簇去重**用 token-集 **Jaccard ≥.6**(`experience-cluster`,非 Phase B 符号图);`risk`/`procedural` 永不同簇;cue 护栏(停用词/低信息/最少 2 有效 cue)。
- **巩固器**(`experience-consolidator` = readonly `agent-runtime` 实例):模型**只提炼** `{kind,lesson,cues,confidence}`,程序逻辑控聚簇/打分/定级/淘汰/升降。后台 tracked promise(`pendingConsolidations`),用户结果**不等**巩固;`kernel.experience.flush()` / `dispose` 收口不丢写。
- **检索注入**(`experience-retrieval`,纯读):cue 重叠 × tier 权重取 top-K → planner prompt;**「读到≠用到」**:planner 回 `used_experience_ids`,`adopted = used ∩ presented` 才参与升降(防错误强化)。
- **风险经验 → 权限(单调升级)**:retrieval 的 `riskCues` → `risk-rules` 生成 `escalate_only` projectRules → orchestrator 注入**串行主区** worker 的 `options.projectRules`(并行 iso `auto` worker 不施加,F8)→ `permission-engine` **只把 default-matrix 的 `allow` 升 `ask`**,绝不降级 / 绝不覆盖用户显式 trust/cache(§9.1)。**`agent-runtime.js` 不改**(走已有 `options.projectRules` 转发通道)。
- **`gated` 模式**:risk-kind 高影响写入先入 `pending/` 待审区(发 `experience:pending_approval`,不影响检索/权限)→ `kernel.experience.{listPending,resolvePending}` 带外审批;`pendingTtlMs`(默认 24h)过期自动 deny;`dispose` 未决保留磁盘、绝不自动落库。
- **事件**(eventBus 级,仅非 off):`experience:retrieved` / `:consolidated` / `:evicted` / `:reinforced` / `:weakened` / `:pending_approval` / `:pending_resolved`。
- 组件:[`src/core/memory/`](../src/core/memory/) 的 `experience-schema` · `experience-store`(写队列 + 原子写 + pending)· `experience-scoring` · `experience-cluster` · `experience-upsert` · `experience-consolidator` · `experience-retrieval` · `risk-rules`;接线 `orchestrator` / `dispatch-loop` / `permission-engine` / `planner` / `config` / `index.js`(`kernel.experience` facade)。

### 14.5 跨进程编排级 durable 恢复(C-Durable,默认关)

> 设计见 [C-Durable spec](specs/backend/2026-06-27-v3-phase-c-durable-orchestration-recovery-design.md);实施见 [C-Durable plan](plans/backend/2026-06-27-v3-phase-c-durable-orchestration-recovery.md)。

C5 的**同进程**编排续跑之上,增加**跨进程**恢复:崩溃/重启后从暂停的编排回合续跑(Option B「完整 worker turn 重水化」)。**gated on `recovery.enabled`(默认关)**——关闭时 C5 同进程续跑逐字节不变、不落编排 sidecar、不注入共享 store。

- **暂停时双写**(同 `approvalId` 关联):worker turn sidecar(既有机制,worker 继承 `pausedTurnPersistence` 自动落 `paused/<id>.json`,含 `resume_state.pending_tool_call` + orchestrator 注入的 `__orchestration` 归属标记)+ 编排 sidecar(新 `orchestration-paused/<id>.json`,只存**白名单可序列化**编排状态:plan/round/allCollected/两套 seen/budget 配额+已花/pausedSubtask/remaining;**绝无** raw options / 活对象)。
- **重启扫描**:`recovery-service` 新扫 `orchestration-paused/`,与 worker sidecar 交叉过**校验门**(schema + 指纹 + 归属)→ 登记 `orchestration_paused` inbox(resume/cancel)。**孤儿一律 blocked**:带 `__orchestration` 标记的 worker sidecar 缺其编排 sidecar(或版本/归属不符)→ `blocked_recovery`,绝不降级单 agent。
- **续跑**:`recovery.resume(rec_orch_<id>)` → 校验门 → 反序列化状态(budget「配额−已花」续扣,绝不重置)→ `worker-factory` 确定性重建 worker → 经**共享 `pausedTurnStore`** 重水化其 turn 的 `approve`(审批落到待执行写工具)→ 结算 → `resumeDispatchLoop` 续本回合 → `driveFrom` 续后续回合,**不重 plan**。
- **`agent-runtime.js` 一行未改**:worker 持久化/重水化全靠既有注入依赖(`pausedTurnPersistence` + 可注入共享 `pausedTurnStore`)。
- 5 边界钉死:孤儿 blocked / 不存 raw options / 版本指纹门 / approval 归属校验 / 预算续扣。
- 组件:[`src/core/orchestration/orchestration-recovery-contract.js`](../src/core/orchestration/orchestration-recovery-contract.js)(纯契约:serialize/deserialize/validate/fingerprint/ownership 门)· [`src/core/recovery/orchestration-persistence.js`](../src/core/recovery/orchestration-persistence.js)(原子写 + 隔离);接线 `orchestrator`(`resumeDurable`/`serializeState`)· `dispatch-loop`(`__orchestration` 标记)· `recovery-service`(扫描 + 孤儿 blocked)· `cost-budget`(续扣种子)· `index.js`(共享 store + 注入 + durable approve 路由)。

## 15. 前端 GUI(v1.4.0 会话优先 · v4 tokens + lucide + 双语)

Electron 桌面端(`gui/`),React + Vite 渲染层,**v1.4 会话优先布局**:左侧 Rail(功能区/项目分区/独立对话)可收放为 272px⇄52px 图标轨(`Ctrl/⌘+B`,偏好 `railCollapsed` 持久化),主区七视图(首页/会话/项目/改动/MCP/插件/设置)。**原创 v4 CSS 设计系统 + lucide-react 图标**(界面零 emoji;第三方库只用 Monaco 只读 Diff 与 lucide;**无交互终端**——xterm/node-pty 死路径已清理,node-pty 仅保留供门控 TUI smoke)。**双语 zh/en 默认中文**,经 `gui-preferences.json` 持久化。**kernel(`src/`)零改动**:GUI 只经 `gui/kernel-host.js`(CommonJS,动态 import 复用 `src` 工具)+ preload IPC 白名单(强制生效)接内核。

- **外壳与状态**:自绘标题栏(菜单/语言/主题/窗口控件经 IPC)+ 会话优先 Rail;`Ctrl/⌘+N` 新建会话、`Ctrl/⌘+B` 收放侧栏。状态是纯 reducer `workbench-state.js`(`useReducer`,不可变返回,node:test 全测);取数/派生/过滤/归一全抽纯函数。
- **文件与编辑(D-2/D-3)**:真文件树(`listTree`/`readFile` 复用 `path-safety.js` realpath 边界,拒目录/超大/二进制/symlink 逃逸)+ Monaco 编辑器(本地 worker 离线,不走 CDN;v4 壳内仅作**只读 Diff**,无代码编辑表面、无交互终端)。**D-3 起可编辑**:改动标脏,`Ctrl/⌘+S` 经 `kernel-host.writeFile` = 整文件 unified diff → **独立 `editService.apply`**(事务 + 回滚 + change 记录 + workspace 边界,不复用内核那只带 recoveryJournal 的实例,agent 回合不受影响);`DiffView`(v1.4.7 自历史恢复)与 `ChangeDiffView` 看原↔改。
- **设置页(D-3,活动栏齿轮 → 主区)**:七组二级菜单(通用/模型接入/运行护栏/多智能体/语义上下文/经验与恢复/关于)。`settings-schema.js` 纯定义字段 + 归一;config 表单整段回写 `configureProject`。**模型接入 = API 列表管理**(增/删/改/激活,经 `src/apps/api-profiles.js`(D-5 起 GUI/TUI 共享,kernel-host 动态 import)原子存 `.deepseek-code/`;激活写 `config.json` 供内核读)+ **模型获取**(`GET {baseUrl}/models`,不设默认、失败报错)+ 连接测试。
- **改动跟踪(D-4,源代码管理视图内「AGENT 改动」分区)**:看 agent(及 GUI 手动保存)改了哪些文件/位置 → 点文件行看该次改动「修改前 vs 修改后」→ 从对比里跳编辑器对应行。数据经**只读桥** `changes:list` / `changes:describe`(`kernel-host` 动态 import 复用 `src/edits/change-store.js` 的 `list`/`describe` + `src/patch.js` 的 `parseUnifiedDiff`,**kernel 零改动**):列表**主进程瘦身**(剥 `before/after` 与 diff 全文,只回 `id/time/prompt/rolledBack` + 每文件 `added/removed/hunkStarts`);`describe` 单文件切片才回 `before/after` 全文(**方案 C**:记录里 `captureChangePlan`/`finalizeChange` 已持久化前后全文,直喂 `DiffView` 的 Monaco DiffEditor,零反推、时点精确)。来源标签(prompt 前缀 `"GUI edit "` → 手动,否则 agent)、已回滚标(读 `.deepseek-code/rollbacks.jsonl`)。`ChangeDiffView` 头部 hunk chips(`@@ 12`)+「跳到编辑器」→ `openFile` + `revealLineInCenter`(行号 clamp,越界不崩);Agent 面板 diff 卡片带 `change_id` 可点开同一对比。实时刷新:reducer 收 `file:diff_applied`/`file:rollback_applied` 自增 `changesTick` 触发重拉(历史为底、`change_id` 对齐)。**并修**:`file:diff_applied` 事件真实字段是 `{change_id, summary, files}`,旧派生读不存在的 `e.path/e.added` 使卡片恒显空路径 +0−0,已改。
- **安全不变量**:**API Key 绝不回渲染层明文**——只回 `hasKey` / 掩码(`sk-…abcd`);明文仅落盘 `.deepseek-code/`(随仓忽略)。保存经 `editService`(非裸 fs 写)且过 workspace 边界。改动跟踪对 `changes/` 与 `rollbacks.jsonl` 只读且列表不回大文本。GUI 进程 `nodeIntegration:false` + `contextIsolation:true` + `sandbox:true` + **IPC 白名单强制生效**(`main.js` 的 `IPC_CHANNELS` 是唯一权威清单,未登记 channel 的 `handle` 注册启动即抛错;见 §8)。
- **测试策略**:纯逻辑(reducer / `settings-schema` / `file-filter` / `menu-model` / `panels-derive` / `save-diff` / `api-profiles` / `changes-derive` / `kernel-host` 桥与 `writeFile`/`listChanges`/`describeChange`)全 node:test;React 组件 / Monaco / 真切换走 `vite build` + **门控 Electron smoke**(装 gui deps 才跑,硬断言外壳渲染;设置页 + **SCM 改动分区与前后对比**为截图留档、未渲染记 `SKIPPED` 日志不判红),无 gui deps 时优雅 skip,核心 `npm test` 不受影响。**注**:IPC 频道注册属主进程接线,单测不覆盖,靠门控 smoke 把关——核截图与 `SKIPPED` 日志(D-4 即由 smoke 逮出 `changes:list` 漏注册)。
- **v1.4.7 收口**:Rail 分区折叠改引用 `collapsedSections`、折叠态页脚适配 52px 轨;HomeView busy 判定与 ChatView 对齐;TitleBar 明暗图标按 `themes.js` group 判定;DiffView 恢复 + Ctrl+N;**设置页全窗化**(不渲染 Rail,顶部返回/关闭按钮,返回原视图)+ **窄窗口 Rail 不再消失**(900px 以下强制 52px 图标轨);renderer build / Electron 冒烟加固;mimo-v2.5 截图复核 8 视图全绿(修复 smoke 设置选择器、窄屏 rail-off 空列、改动时间格式化);全量回归 1012 单测 + Electron 冒烟通过。
- **v1.5.1 内核修复 + GUI 死代码清理**:① 流式/响应超时真正生效(`model-gateway.stream/invoke` 的 `timeout.cleanup()` 移到 body 读完之后,SSE 流读或 `response.json()` 悬挂都会按 `MODEL_TIMEOUT` 终止、调用方 abort 传播);② 每回合预算跨审批续扣(`executor-loop` 暂停时把 `budget.snapshot()` 写入 `resume_state.budget_spent`,`agent-runtime.approve` 续跑时按 spent 做 initial 种子,不再清零);③ GUI 死代码清理:`@xterm/xterm` + `@xterm/addon-fit` 依赖与 `pty-host.js`/preload `pty*`/`pty:*` IPC 全删(渲染层从不使用),遗留 `theme.css` 剪枝 235→82 行(仅保留 v4 仍引用的标题栏/下拉菜单/按钮/Diff 视图规则;tokens 仍经其 @import 加载),`IPC_CHANNELS` 白名单从文档常量改为**强制生效**(registerIpcHandlers 内未登记 channel 抛错)。全量回归 1014 单测 + `npm run check` + renderer build + Electron/TUI smoke 通过。
- **v1.7.2 GUI 缺陷补丁(消息流 / 数据新鲜度 / CSS token)**:**消息流**——`workbench-state` 此前只在 `message_added` 写 `messages`,`agent:final` 从不入流,`ChatView` 的 `.a-msg` 自 v1.4.6 起从未渲染;现终态事件追加 `{role:"assistant",text}`(空 content 不追加,`stopped` 也入流)。**状态行**——`getUsage`/`listCheckpoints` 此前只在挂载拉一次;现 `refreshLoadsFor` 在 `agent:final`/`agent:error`/`turn:cancelled`/`file:rollback_applied` 后重拉。**敏感模态**——`.sn-*` 此前引用 7 个未定义 CSS 变量,已按 tokens 18 槽映射修正,并新增 `css-vars.test.js` 通用守卫。冒烟链补 `shell-sensitive-notice` 截图。内核零改动。

## 16. 终端 TUI(V3 Phase D-5 · 行内滚动流 agent 会话)

`src/tui.js` 薄入口 + `src/apps/tui/` 十模块(手写 ANSI/VT;需支持 VT 序列的终端)。**形态 = claude code 式行内滚动流**:历史(用户行 `❯`/流式回复/工具对/diff 卡/审批卡/编排与验证进度行)println 进终端**原生滚动区**(滚轮/复制/搜索原生可用),仅底部(流式预览 ≤3 行 + 分隔线 + slash 补全菜单 + 输入行 + 状态栏)为固定重绘区(painter 爬升→清除→重画,光标停靠输入列;reducer 判定无变化不重绘)。

- **纯逻辑 + 薄 IO**:`tui-state.js` 纯 reducer(光标编辑/输入历史/流缓冲/审批/菜单/overlay)· `event-cards.js` 事件→卡片行(QUIET 静默集;`user:message`/`agent:final`/`agent:error` 走 send 结果路径防重复)· `input.js` 按键解码(CSI/SS3/括号粘贴,跨 chunk 缓冲 + 孤立 ESC 延时 flush)· `ansi.js` 序列构造 + CJK 显示宽度(2 列)· `paint.js` computeBottom + painter(`write` 可注入)· `tui-i18n.js` zh/en 字典(key 集对齐测试)· `slash.js`/`config-flow.js` 纯注册表与状态机 · `prefs.js` tui-prefs.json 偏好读写(/lang 持久化)· `tui-app.js` 组合根(io/kernel/git/changes/profiles/fetch 全可注入)。
- **kernel(`src/` 核心)零改动**:流式走既有 `kernel.agent.send(text, { autonomy, history, stream, onDelta })` 的 options 透传;会话 history 由 TUI 持有(同 chat REPL 的 10 轮裁剪);`awaiting_approval` 循环 `agent.approve`(y/n/Esc 行内答复);编排通道无顶层流式时降级为 spinner + 事件进度行。autonomy 默认 `gated`,`/mode` 切 `read-only|gated|auto`;`/lang` 双语切换持久化 `.deepseek-code/tui-prefs.json`。**v1.1.0 起 busy 态 Esc 调 `agent.interrupt()`中断当前回合、保留会话后继续输入;CLI 在 send/approve 运行期以 SIGINT 走同一 interrupt,不直接退出整个会话。**
- **/config 与 GUI 共享一套 API 列表**:`src/apps/api-profiles.js`(原 `gui/api-profiles.js` ESM 化迁入,存储文件名 `gui-api-profiles.json` 保留兼容)+ `src/apps/model-catalog.js`(`GET {baseUrl}/models`,fetch 可注入),GUI kernel-host 改动态 import 复用、行为不变。TUI 内增/删/改/激活/拉模型(**不设默认、失败红字**)/连接测试;**激活 = activate → `configureProject` 写 config.json → dispose 旧自建 kernel → 重建 → 重订阅,对话上下文保留**,状态栏模型名即时刷新。
- **安全不变量**:密钥明文只落 `.deepseek-code/`(随仓忽略);TUI 渲染路径(滚动区/状态栏/卡片/编辑回显)只出现掩码(`maskKey` 列表掩码、编辑框 `•` 逐字符),密钥不进对话 history;任何退出路径(含异常)恢复终端态(cooked mode/光标/颜色/括号粘贴关闭)。
- **测试策略**:纯层全 node:test;`tui-app` 以注入 PassThrough 流 + mock kernel 做全链路测试(流式回合/审批 y·Esc/slash 补全/config 增改激活重建/双语/Ctrl+C 退出与终端恢复),**不依赖真 pty**;**门控真 pty smoke**(检测 `gui/node_modules/node-pty`,未装优雅 skip):启动 offline → `/help` 渲染 → `/quit`,以 pasteOff 序列断言终端态恢复。

### 16.1 三端共享事件展示契约(D-G4)

`src/apps/event-contract.js` 的 `describeEvent(event)` 是**内核事件 → 展示语义**的唯一映射源(明确**非** core 的事件生产契约,后者由 `src/sessions/event-types.js` 负责),输出归一化描述符 `{ kind, sourceType, severity, quiet, fields }`:`kind` 为展示类别(编排类带 `orchestration-` 前缀)、`sourceType` 保原始 `type` 供 `other` 忠实回退、`quiet` 是默认可见性提示(非丢弃)、`fields` 按 kind 区分且缺失一律 `null`。三端渲染器(CLI `render-events`、TUI `event-cards`、GUI `agent-cards`)均降为薄适配层,只读描述符字段、各自决定措辞/颜色/i18n——所有 `call?.name || tool?.name`、`change_id || record?.id`、`files ?? summary` 的防御式读法收敛一处。CLI 由此补齐此前缺失的多 agent(orchestration/experience)摘要;TUI `/recovery` 补 `clear` 与 CLI 平齐。**边界**:纯函数、任意输入不抛错、`src/core`/`src/index.js` 零改动;休眠 UMD 渲染层 `gui/renderer/` 未纳入契约(不消费编排事件,列后续项)。
