# 运行时与执行（Living Spec）

- 类型：后端 spec
- 状态：Living Spec，随实现更新；v1.19.0 整合自 12 篇历史 spec（实现至 v1.18.0）
- 关联：[系统架构](../architecture/system-architecture.md) · [上下文与记忆](context-and-memory.md) · [编排](orchestration.md) · [编辑/会话/恢复](edits-sessions-recovery.md) · [文档索引](../../README.md)

> 本文是 v1.19.0 整合后的领域 Living Spec，取代原 12 篇碎片化历史 spec（见文末「来源」）。内容以 v1.18.0 行为为准；早期「计划但未做」的叙述已删除。

## 来源与覆盖

| 来源（basename） | 覆盖内容 |
|---|---|
| `2026-05-30-v2-7-approval-resume-design.md` | 审批暂停/续跑、`paused-turn-store`、审批缓存授予、错误语义 |
| `2026-05-31-v2-8-verifier-repair-loop-design.md` | 验证策略、修复提示与执行、repair 事件、`verifyAndMaybeRepair` |
| `2026-05-31-v2-10-context-cache-usage-telemetry-design.md` | 用量遥测 facade（上下文缓存部分见[上下文与记忆](context-and-memory.md)） |
| `2026-05-31-v2-17-chat-kernel-unification-bypass-closure-design.md` | chat/ask/edit/test 统一 kernel 入口、`read-only` 档、git 加固、死代码清理 |
| `2026-06-01-v2-18-durable-recovery-resume-hardening-design.md` | 运行时时序与暂停持久化（跨进程恢复见[编辑/会话/恢复](edits-sessions-recovery.md)） |
| `2026-06-24-v2-20a-runtime-cost-timeout-guardrails.md` | 成本闸与模型/工具超时 |
| `2026-06-25-v2-20b-guardrail-injection-graceful-stop.md` | 护栏注入与优雅停止 |
| `2026-06-25-v2-20c-malformed-toolcall-retry.md` | 畸形 tool-call 有界重试 |
| `2026-06-25-v2-20d-resume-path-guardrail-alignment.md` | resume 路径护栏对齐 |
| `2026-06-25-v2-20e-repair-path-model-timeout.md` | repair 路径模型超时透传 |
| `2026-06-25-v2-20f-guardrail-defaults-config.md` | 护栏默认值与用户配置 |
| `2026-07-12-agent-findings-remediation.md` | 审计发现补救台账 |
| `2026-07-17-v1.2.0-agent-findings-p2-design.md` | P2：grep 双预算超时、shell env 白名单 |
| `2026-07-26-v1.3.0-agent-findings-p3-design.md` | P3：命令策略、语义降级可观测、休眠渲染层 |
| `2026-08-09-v1.6.3-agent-runtime-refactor-design.md` | `agent-runtime` 阶段 1–2 成果、3–4 方案 |
| `2026-10-07-v1.18-r18-01-aggregate-budget-contract.md` | 请求级聚合总预算契约（R18-01） |
| `2026-10-23-v1.18.0-runtime-closure-design.md` | 运行能力闭环（R18-01–R18-04） |

---

## 1. 执行循环与 turn 生命周期

### 1.1 循环结构

```
user input → classify → cache-aware context → plan → approval gate
  → act(tool calls) → execute tools → feed results → apply edits
  → verify → repair if needed → final → persist events/artifacts
```

一轮 turn = 一次用户请求及其全部模型调用、工具调用、审批、编辑、验证、修复、产物与最终答复。生命周期状态以 `src/core/runtime/lifecycle.js` 的 `RUNTIME_STATES` 为唯一权威：`idle` / `classify` / `plan` / `awaiting_approval` / `execute` / `review` / `verify` / `repair` / `complete` / `failed` / `interrupted`。

`agent-runtime.js` 是单 agent 单轮引擎，编排场景复用为 Worker / Reviewer 实例（见[编排](orchestration.md)）。入口 `createAgentRuntime(...)`；`send` 主路径与 `approve` 续跑路径共用 `verifyAndMaybeRepair`。v1.19.2 起，`executor-loop.js` 与 `repair-executor.js` 共用的模型调用、整批预校验、有界语法重试与工具执行循环收敛至 [`src/core/execution/execution-cycle.js`](../../src/core/execution/execution-cycle.js)；普通执行暂停、主验证器暂停、修复期暂停与 `task` 子任务暂停四路续跑逻辑收敛至 [`src/core/runtime/resume-coordinator.js`](../../src/core/runtime/resume-coordinator.js)，大幅解耦了 `agent-runtime.js` 的状态编排样板。

### 1.2 固定执行路径

```
schema 校验 → 参数标准化 → 权限决策 → 必要时审批 → 执行 → 脱敏 → tool:result → 回灌模型
```

工具不自行判权；category 来自注册定义而非模型输入。工具超时结果走标准工具错误形状（`status: "error"` + `metadata.timeout`），不抛到 turn 外，避免一个挂起工具毁掉整轮。

### 1.3 query 快路径

query / simple 类任务跳过 ThinkPlan 与 verify/repair，但仍带 `context.summary`，不进入修复环。

---

## 2. 审批三级流与 paused-turn 持久化

### 2.1 进程内流程（V2-7）

```
模型请求工具 → 权限 ask → approval:requested
  → runtime 存 resume_state → 用户决策
  → approve：写 approvalCache → resumeExecutorLoop → 结果回灌 → 验证/终态
  → deny：agent:final(cancelled) → idle
```

`runExecutorLoop` 暂停时返回可续跑快照：

```js
{
  status: "awaiting_approval",
  approval,
  resume_state: {
    turn_id, message, classification, messages, model_result,
    raw_tool_calls, pending_tool_call, remaining_tool_calls,
    iteration, tool_results, tool_schemas, max_iterations, options
  }
}
```

`resumeExecutorLoop(resumeState, deps)` 先执行 `pending_tool_call`，再按序执行 `remaining_tool_calls`，继续模型调用至终态或 `maxIterations`。它必须调用 `executeTool()`，不得直接调工具实现。

### 2.2 `paused-turn-store`

`src/core/approval/paused-turn-store.js`：

```js
createPausedTurnStore() -> { save, get, take, deleteForTurn, clear, size }
```

记录 `{ approval_id, turn_id, approval, turn, resume_state, created_at }`。`take()` 只成功一次，天然拒绝重复审批；拒绝重复 `approval_id`。

### 2.3 审批缓存授予

续跑仍走权限重评估。`grantApprovalForToolCall` 用 `secureToolCall` 得到规范调用，算指纹后 `approvalCache.grant(fp, { decision: "allow" })`。`ToolRegistry.secureToolCall` 与 `ToolExecutor` 共用同一 category 推导。缓存只存 allow，TTL 默认 300000ms（`src/tools/permissions/approval-cache.js`）。TTL 指纹绑定到具体操作 + 具体目标 + 具体项目，不按 category 粗放行。

### 2.4 Runtime / Kernel 语义

- 暂停时 `send()` 落库后释放 `currentTurnId`；已有暂停记录时新 `send()` 抛 `AWAITING_APPROVAL`。
- `approve(approvalId, decision)` 为 async；未知 id 视为已消费或不存在；重复审批失败。
- deny 发 `agent:final`，状态 `cancelled`，不抛错。
- `interrupt()` 清 abort 与暂停记录，不发残留 final。
- Kernel API 仍为 `kernel.agent.approve(approvalId, decision)`。GUI host 改为 async；CLI 进程内提示后调用；TUI 最小确认提示。
- 同时只允许一个暂停 turn；重复 `send` 直接拒绝。
- 决策词：allow = `approve`/`allow`；deny = `deny`/`reject`。

### 2.5 错误

| 情形 | 行为 |
|---|---|
| 未知 approval id | `APPROVAL_NOT_FOUND` |
| 重复审批 | 同未知（已被 `take`） |
| 执行中再批 | `BUSY` |
| 暂停中再 `send` | `AWAITING_APPROVAL` |
| 拒绝 | 确定性 cancelled，不抛 |
| 续跑中再次 ask | 新暂停记录，返回 `awaiting_approval` |

会话侧持久化 `approval:requested` / `approval:resolved` / `tool:result` / `agent:final`（见 `SESSION_EVENT_TYPES`）。

### 2.6 跨进程暂停持久化（V2-18 运行时部分）

路径 `.deepseek-code/v2/sessions/<projectId>/paused/<approvalId>.json`。存 `schema_version`、ids、`surface`、`permission_context`（自治、指纹用 project_id、信任规则、verify_mode 等）、`approval`、`turn`、`resume_state`。`permission_context` 供重启后续跑复原安全语义；repair 暂停必须含 `resume_state.repair_context.initial_tool_results`。

暂停顺序：写侧车 → 追加并 flush `turn:paused` → 入内存 store → 返回。续跑/取消消费后删或隔离侧车，并发 `turn:resumed` / `turn:cancelled`。扫描按侧车与项目内全部 JSONL 的 `turn:*` 标记对账：有效侧车缺标记可 rehydrate 并补 `turn:rehydrated`；有标记无侧车或侧车损坏 → blocked 项；重复 approval id → blocked/隔离。Recovery Center 与启动扫描见[编辑/会话/恢复](edits-sessions-recovery.md)。

---

## 3. 验证-修复循环

### 3.1 流程

```
工具环 → runVerifier(policy)
  → passed/skipped → complete
  → approval_required → awaiting_approval
  → failed/error → runRepairLoop
       → repair 模型调用 → adapt 工具调用 → executeTool → 再验证
       → 通过 complete / 再失败重复 / 耗尽 failed
```

返回状态词与 runtime 一致：`complete` / `failed` / `awaiting_approval`（外加 content、toolResults、verification、repair、approval、resume_state）。

### 3.2 `verification-policy.js`

`verifyMode`：`auto`（默认）/ `detect` / `run` / `off`。

- `detect`：始终 `test` + `{ detect: true }`。
- `run`：真跑测试（可显式 `testArgv`，必须是 `string[]`）。
- `auto`：gated/auto/full-auto 跑测试，supervised 只 detect。
- `off`：跳过。

无编辑类成功结果时直接 `skipped`。`runVerifier` 映射：`success` + 无/0 退出码 → `passed`；`success` + 非 0 → `failed`；`approval_required` 保留；`denied` → `failed`；`error` → `error`。发布 `verification:result`。

### 3.3 `repair-prompt.js` 与 `repair-executor.js`

`repair-prompt.js` 构建紧凑提示：说明验证失败原因、要求最小纠正、优先 `read`/`grep`/`glob`/`edit`、无工具调用即无法修复。不含 `reasoning_content`、密钥、无界工具输出。

`repair-executor.js` 复用执行助手：`adaptDeepSeekToolCalls` → `executeTool` → `toolResultsToMessages`。修复通道用 `purpose: "repair"` + `models.think`，不用 reply 通道。需要审批时返回与 V2-7 同形的 `resume_state`，批准后仍走 `resumeExecutorLoop` 再 `verifyAndMaybeRepair`。

### 3.4 `repair-decision.js`

passed/skipped 停止，failed/error 可修，approval_required 等用户。修复循环轮数受 `maxRepairAttempts`（默认 2）约束；工具调用修复次数另受 `limits.maxToolCallRepairs` 约束（两层计数严格分离，见 §5.3）。

### 3.5 事件

```
repair:started → repair:attempt → model:request/response
  → tool:call / permission:decision / tool:result
  → verification:result → repair:result
  耗尽时 repair:exhausted
```

均在 `SESSION_EVENT_TYPES`。`repair:result` 只含 attempt/status/verification_status/计数。

### 3.6 边界

1. 修复工具全部经 ToolExecutor。
2. 不暴露 `reasoning_content`。
3. 不自动做破坏性动作。
4. 耗尽后进明确终态，清 `currentTurnId` 与 abort。
5. 进程重启持久化修复、长期修复记忆、部分 diff 自动回滚不在范围内。

---

## 4. 运行护栏

### 4.1 `limits` 五参与默认值（`src/config.js` 的 `DEFAULT_CONFIG.limits`）

| 键 | 默认 | 语义 |
|---|---|---|
| `toolTimeoutMs` | 120000 | 开 |
| `modelTimeoutMs` | 120000 | 开 |
| `maxTurnTokens` | null | 关 |
| `maxModelCalls` | null | 关 |
| `maxToolCallRepairs` | null | 关 |

`normalizeLimits(raw)` 导出，内部 `toLimit(value, fallback)`：省略 → 默认；`null` → 显式关闭；非有限数或 `≤0` → 关闭；否则 `Math.trunc(n)`。数值字符串强制转换（`"3000"` → 3000），小数截断（`4.9` → 4）。

环境变量覆盖经 `limitsFromEnv(limits)`：**仅** `DEEPSEEK_TOOL_TIMEOUT_MS`、`DEEPSEEK_MODEL_TIMEOUT_MS` 两个超时可被 env 覆盖，预算项走配置文件。

`loadConfig` 返回值含 `limits: limitsFromEnv(normalizeLimits(fileConfig.limits))`；`normalizeConfig` 返回值含 `limits: normalizeLimits(config.limits)`。CLI `src/apps/kernel-options.js` 与 GUI `gui/kernel-host.js` 的 `buildKernelOptions` 在 `config.limits` 存在时转发，缺省时不附加以保持既有返回形状。

配置哲学：在适配 DeepSeek 前提下，参数尽量交给用户配置。默认值只提供安全合理的起点（如超时 120s），不锁死；每个旋钮都能经 `.deepseek-code/config.json` 的 `limits`（`config show` 可见）或环境变量覆盖，`null` / `≤0` 显式关闭。kernel 原语保持「未配即关」，策略（默认开）由配置层决定。

用户配置示例：

```json
{
  "limits": {
    "toolTimeoutMs": 180000,
    "modelTimeoutMs": 120000,
    "maxTurnTokens": 200000,
    "maxModelCalls": 40,
    "maxToolCallRepairs": 1
  }
}
```

### 4.2 成本闸（V2-20a）

`src/core/runtime/cost-budget.js`，与运行时解耦的纯模块：

```text
createCostBudget({ maxTokens = null, maxModelCalls = null, initialTokens = 0, initialModelCalls = 0 })
  -> { recordModelResult(modelResult), check(), exceeded(), snapshot() }

recordModelResult(modelResult):
  从 modelResult.usage 累加 token，model_calls +1
  usage 形如 { prompt_tokens, completion_tokens, total_tokens }
  优先 total_tokens，否则 prompt_tokens + completion_tokens
  无 usage 仍计一次模型调用

check():   达上限则抛 Error，error.code === "BUDGET_EXCEEDED"，
           error.details = { reason, ... }，reason 为 "max_tokens" 或 "max_model_calls"
exceeded(): 返回 null 或 { reason, ... }（不抛）
snapshot(): 返回 { tokens, model_calls, max_tokens, max_model_calls }
```

`initialTokens` / `initialModelCalls` 供跨进程恢复续扣使用。

### 4.3 超时（V2-20a）

模型超时落在 `src/deepseek/model-gateway.js`，`invoke` / `stream` / `fim` 三条路径都用 `withTimeout(callerSignal, timeoutMs)` 把调用方 signal 与超时 AbortController 合并：

```text
withTimeout(callerSignal, timeoutMs) -> { signal, cleanup, didTimeout }
modelTimeoutError(timeoutMs) -> Error, error.code === "MODEL_TIMEOUT"
```

`stream` 路径在 SSE body 读取期间保持超时武装（fetch 在 headers 即 resolve，body 之后才消费，abort 必须同时约束请求与 body 解析）；`fim` 路径同语义，不传 `timeoutMs` 则不设超时。

工具超时落在 `src/tools/executor.js`：

```text
createToolExecutor({ registry, permissionEngine, eventBus, defaultToolTimeoutMs })
runWithTimeout(promiseFactory, timeoutMs)
  超时 -> 标准 status:"error" 工具结果
  metadata: error.code === "TOOL_TIMEOUT" ? { timeout: true } : {}
```

错误码约定固定写在 `error.code`：`BUDGET_EXCEEDED`、`MODEL_TIMEOUT`、`TOOL_TIMEOUT`，下游据此分支，不靠 message 字符串匹配。

### 4.4 注入与优雅停止（V2-20b/d/e）

**优雅停止**：`executor-loop` 由 `budget.check()`（抛）改为 `budget.exceeded()`（返回）。`runExecutorLoop` 与 `resumeExecutorLoop` 在各自循环开头判断：

```text
const over = budget?.exceeded();
if (over) {
  return {
    status: "stopped",
    reason: over,
    content: `Stopped: cost budget exceeded (${over.reason}).`,
    iterations: iteration,
    toolResults
  };
}
```

`agent-runtime` 把 `stopped` 当作 turn 终态：turn 标记 completed，发 `agent:final` status=`stopped`，lifecycle 迁回 idle（reason 为 cost budget stop），清 `currentTurnId` / `currentAbortController`，返回 `{ status: "stopped", state: "idle", content, turn, budget: loop.reason || null }`。`stopped` 终态不跑 verify/repair，避免把预算停止误判为需要修复的失败。

**注入面**：`modelTimeoutMs` 经 runtime 透传到 executor-loop 每次 `invoke({ timeoutMs })` 与 `gateway.reply` 内部 invoke；`toolTimeoutMs` 注入工具执行路径（`createToolExecutor({ defaultToolTimeoutMs })`）；`executor-loop` 每次模型调用前 `budget.check()`、调用后 `recordModelResult()`；`createKernel` 由 `options.limits` 注入到 `createAgentRuntime` 与 `createToolExecutor`。默认 `null` 时行为不变。

**resume 路径对齐（V2-20d）**：`approve()` 在 `resumeExecutorLoop` 前新建成本预算（审批暂停是天然边界，故该 resume 段新建而非继承暂停前已花费的 token），并把三参数传入：

```text
const resumeOptions = record.resume_state.options || {};
const budget = createCostBudget({
  maxTokens: resumeOptions.maxTurnTokens ?? maxTurnTokens,
  maxModelCalls: resumeOptions.maxModelCalls ?? maxModelCalls
});
const loop = await resumeExecutorLoop({
  resumeState: record.resume_state,
  modelGateway, executeTool, createPolicyContext, eventBus,
  signal: currentAbortController.signal,
  budget,
  modelTimeoutMs: resumeOptions.modelTimeoutMs ?? modelTimeoutMs,
  maxToolCallRepairs: resumeOptions.maxToolCallRepairs ?? maxToolCallRepairs
});
```

并补 `stopped` 终态处理（镜像 `send`，插在 `awaiting_approval` 分支之后、repair-phase approval 之前）。`resume_state.options` 可覆盖工厂级配置。

**repair 路径超时（V2-20e）**：`runRepairExecutor` 的 `modelGateway.invoke` 选项改为 `timeoutMs: modelTimeoutMs ?? options.timeoutMs`；`runRepairLoop({ ..., modelTimeoutMs = null })` 解构加参并透传；`agent-runtime` 两处调用点注入（`verifyAndMaybeRepair` 用 `options.modelTimeoutMs ?? modelTimeoutMs`；approve 的 repair_context 用 `record.resume_state.options?.modelTimeoutMs ?? modelTimeoutMs`）。至此 `modelTimeoutMs` 覆盖全部三条模型调用路径：正常工具循环（run/resume）、审批 resume、验证-修复。

---

## 5. 畸形 tool-call 有界重试

### 5.1 双层计数严格分离（v1.18.0 起）

| 配置项 | 作用域 | 语义 |
|---|---|---|
| `maxRepairAttempts` | `src/core/verification/repair-loop.js` | 验证（测试）失败后最多执行几轮修复循环（既有能力，默认 2） |
| `maxToolCallRepairs` | `src/core/execution/executor-loop.js` + `repair-executor.js` | 单次模型响应的 tool-call JSON 解析失败或结构畸形时，在产生任何工具副作用前最多额外请求几次语法纠正（v1.18.0 补齐 `repair` 路径） |

默认 `maxToolCallRepairs = 0`（或未配置）时保持旧行为，畸形 tool-call 直接报错退出，不额外发起模型调用。

### 5.2 executor-loop 路径（V2-20c）

`runExecutorLoop` / `resumeExecutorLoop` 新增 `maxToolCallRepairs = 0`（放在 `modelTimeoutMs` 旁）。两段循环各自维护 `let toolCallRepairs = 0`，不跨段累计（审批暂停续跑后额度重新起算）。把 `adaptDeepSeekToolCalls(rawToolCalls, { requestedByStepId })` 包进 try/catch：

```text
catch (error) {
  if (toolCallRepairs >= maxToolCallRepairs) throw error;
  toolCallRepairs += 1;
  eventBus?.publish?.("model:tool_call_repair", {
    turn_id, iteration, attempt: toolCallRepairs, reason: error.message
  });
  messages = [
    ...messages,
    assistantToolCallMessage(modelResult, rawToolCalls),
    { role: "user", content:
      `Your previous tool call had invalid arguments (${error.message}). ` +
      `Re-issue the tool call with valid JSON arguments.` }
  ];
  continue;
}
```

`createAgentRuntime` 接受 `maxToolCallRepairs = 0`，`runToolLoopPath` 的 `runExecutorLoop` 调用透传 `options.maxToolCallRepairs ?? maxToolCallRepairs`。`createKernel` 由 `options.limits?.maxToolCallRepairs ?? 0` 注入。kernel `limits` 五参至此全部接线，默认关闭 opt-in。

只修「参数 JSON 畸形」这一类（`arguments_parse_error` / `invalid tool arguments`）。工具名不存在等其它错误不走此路径。事件 `model:tool_call_repair` 不在 `event-types.js` 注册表（session 事件另册），由 eventBus 直发。

### 5.3 repair 路径整批预校验（v1.18.0 R18-03）

1. **三阶段严格切分**：`模型调用 → 整批 tool-call 语法/结构预校验（validateRepairToolCallsBatch） → 顺序执行工具`。
2. **零前置副作用保证**：只要批次中任意一项存在 `arguments_parse_error`、非对象参数、缺失工具名或批次内重复 `tool_call.id`，**整批拒绝执行**（即使排在前面的工具调用语法合法且为写操作，也绝不先执行）。
3. **错误分类边界**：仅模型输出本身的 tool-call 语法/结构错误触发纠正重试；工具权限拒绝（`denied`）、未知工具名、工具 schema 业务参数校验失败、文件冲突、网络认证错误、预算耗尽或取消**不进入**语法重试。
4. **回灌与协议保持**：重试时保留有效 assistant 消息的 `reasoning_content`（满足 DeepSeek thinking 历史回传协议），对错误原因执行 `redactSecrets` 脱敏与长度截断，并发出 `model:tool_call_repair` 事件。
5. **暂停与跨进程恢复**：语法纠正成功后的工具批次中某工具触发 `awaiting_approval` 时，`resume_state` 与 `repair_context` 完整持久化已规范化的剩余批次、已完成工具结果及累计 `tool_call_repairs` / `prior_tool_call_repairs` 计数；批准恢复后从 pending 工具继续，不重做已完成工具、不重置语法重试配额。

---

## 6. 用量遥测

`src/deepseek/usage-tracker.js` 每次请求记录：prompt / completion / reasoning tokens、cache hit / cache miss tokens、latency、model、channel。

出口是单一 facade `kernel.metrics`：

- `getUsage()` → `modelGateway.getUsageStats()`（含 `cache_hit_tokens`、`cache_miss_tokens`、hit rate）。
- `getContext()` → 上下文统计。
- `getSnapshot()` → 当前上下文快照。

不暴露密钥、原始请求、snippet。GUI host 优先 `kernel.metrics.getUsage()`，TUI 同源。三端展示形态见[工作台与三端](../frontend/workbench-and-surfaces.md)。

语义边界：`model_calls` 与 `tokens` 是运行护栏与配额控制指标，**不等同于云端精确财务账单**。

---

## 7. 聚合总预算契约（R18-01）

### 7.1 核心原则与架构分层

- **全局编排总预算**：由 `createRequestBudget({ maxTokens, maxModelCalls, fallbackTokensPerUnknown, executionId })` 创建，依托于 `RequestScope`（`src/core/runtime/request-budget.js`）在编排请求生命周期内统一管理。
- **作用域绑定**：由 `src/index.js` 的 `routedSend` 在路由决策前预先创建全局 `rootBudget` 与 `baseScope`，确保分流阶段（`router`）的模型调用已直接在同一 `executionId` 账本中计量。当判定为 `orchestrate` 泳道时，直接继承该 `rootBudget` 作为编排总预算，并通过 `scope.bindGateway(modelGateway, { role, subtaskId })` 注入到所有编排参与者；若判定为 `single` 泳道，则普通单任务对话不挂载该编排总预算。
- **与局部 Limits 的兼容关系**：`orchestration.budget` 专属于多代理编排泳道（`decision.lane === "orchestrate"`）。普通单任务请求绝不挂载 `orchestration.budget`，不干预其多轮工具调用循环。单任务请求仍遵守其自有的 `options.limits`（如 `maxTurnTokens`、`maxModelCalls`）。默认 `orchestration.budget = { maxTokens: null, maxModelCalls: 40 }`。

### 7.2 预留与结算流程

1. **预留阶段（`reserveCall`）**：出站前由 `estimateRequestTokens(request, options)` 计算本次请求的预估输入 + 输出 token 数；`check(estimatedTokens)` 原子排他检查 `effective_tokens` 是否超限、调用次数是否超限；锁定额度 `reservedCalls += 1`、`reservedTokens += estimatedTokens`。
2. **发送确认（`markStarted`）**：真实出站 HTTP 发起前调用，将预留调用名额原子转换为实际调用名额（`reservedCalls - 1`、`modelCalls + 1`）。**网络故障不可退还**：一旦发送开始，无论后续网络是否超时或断开，本次物理调用名额均不退还，防止服务商已扣费但本地账本漏记。
3. **结算阶段（`settle`）**：释放预留 token（`reservedTokens = Math.max(0, reservedTokens - estimatedTokens)`）；用 `normalizeUsageTokens(usage)` 严格校验，有效则累加至 `tokens` 与角色对应账本，无效/缺失则计入 `unknownUsageAttempts`；基于 `settledAttempts` 集合保障同一 `attemptId` 不发生二次重复计费。

### 7.3 角色 × 调用入口覆盖表

| 角色 | 调用入口与所属模块 | Scope / Signal 获取路径 | 记账与网关行为 |
|---|---|---|---|
| router | `src/index.js` 的 `routerCallModel` | `routedSend` 初始化的 `baseScope` | 模糊分流调用模型时按 `role: "router"` 预留与结算，计入 executionId 账本 |
| planner | `src/core/orchestration/planner.js` | `orchestrator.run` 传入的 `orchScope` | 生成初始计划，`role: "planner"` 预留（默认 1000 tokens）；预算耗尽抛 `BUDGET_EXCEEDED` 不吞错 |
| worker | `src/core/orchestration/worker-factory.js` / `iso-worker-runner.js` | 隔离/常规 Worker 运行期的 `scopedGateway` | 执行子任务分析与工具调用，`role: "worker"`（默认 1500 tokens）；Worker 内部 verify/repair 同样在同一 scope 内记账 |
| reviewer | `src/core/orchestration/reviewer.js` / `iso-worker-runner.js` | `makeReviewer` 注入的 `scopedGateway` | 独立审查 Worker 成果，`role: "reviewer"`（默认 500 tokens） |
| replan | `src/core/orchestration/planner.js` 的 `replan` | `gateAndReplan` 传入的 `orchScope` | 成果打回重规划，`role: "replan"` 预留与结算 |
| synthesizer | `src/core/orchestration/synthesizer.js` | `finishPartial` 传入的 `orchScope` 与 `signal` | 汇总全任务结果，`role: "synthesizer"`（默认 800 tokens）；若预算耗尽，直接返回确定性摘要，不发起额外模型调用 |
| task | `src/core/orchestration/task-delegation-service.js` | 父回合传入的 `scope`（`scope.bindGateway(..., { role: "task" })`）与局部 `parentBudget` | 子 Worker 委派执行，`role: "task"` 共享父请求总预算与局部回合预算；在途取消随父 `signal` 与 `scope` 联动传播 |
| experience | `src/core/memory/experience-consolidator.js` | `kickConsolidation` 传入的 `orchScope` 与 `signal` | 后台经验蒸馏，`role: "experience"`；若预算已超限或已被取消，主动跳过，不产生未受控的幽灵费用 |

### 7.4 未知费用策略

1. **输入验证（`normalizeUsageTokens`）**：接受非负有限的 `total_tokens`（`Number.isFinite(v) && v >= 0`，支持合法的零消耗 `0`），或从非负有限的 `prompt_tokens + completion_tokens` 计算总和。包含负值（如 `prompt_tokens: -50`）、NaN、Infinity 或缺失对象的响应一律判定为非法，返回 `null`。
2. **逐请求累计与有效 token 占额（`effectiveTokens`）**：收到缺失或非法 usage 时 `unknownUsageAttempts` 递增；单次未知费用产生时按 `max(fallbackTokensPerUnknown, estimatedTokens)` 计入累计未知占额 `unknownUsageTokens`。`effectiveTokens = tokens + reservedTokens + unknownUsageTokens`；下一请求准入检查验证 `effectiveTokens + estimatedTokens ≤ maxTokens`。默认每个未知请求保留有界保底占额 `fallbackTokensPerUnknown = 500`（可配置，并在快照中持久化记录）。
3. **跨进程与跨会话恢复契约**：`unknownUsageTokens` 与 `fallbackTokensPerUnknown` 在 snapshot、序列化（`serializeOrchestrationState`）、反序列化、`budgetContinuation` 及 `makeResumedBudget` 全链路完整贯穿传递。新格式记录恢复后继承完整的未知占额负债（例如 4020 tokens 恢复后依然严格为 4020 tokens）。旧记录若有未知请求、有有限 token 配额，却缺少可验证的完整未知占额，则阻断恢复并保留原记录。

### 7.5 Token 并发估算与预留契约

`estimateRequestTokens`：将出站请求中的消息正文（`content`、`reasoning_content`、`tool_calls` 序列化文本）与工具定义 schema（`tools` JSON 长度）字符数累加后，统一按 `max(20, ceil(totalChars / 2.5))` 保守估算输入 token（不统计 `m.role` 字段本身）。输出估算优先采用明确写入出站 HTTP body 的服务端上限参数 `options.maxTokens`；未显式传入时采用各角色本地输出估值（router 200、planner 1000、worker 1500、reviewer 500、synthesizer 800、默认 500）。

并发争抢拦截：并发启动并行 Worker 时，出站前通过 `reserveCall` 原子增加 `reservedTokens` 与 `reservedCalls`。当多个 Worker 竞争剩余配额时，超出限额的 Worker 在发起出站 HTTP 之前被直接拦截（抛 `BUDGET_EXCEEDED`），不存在先发 HTTP 后补扣超支。

### 7.6 取消与 Dispose 生命周期

1. **分层作用域生命周期管理**：
   - 前台请求作用域（`activeScopes: Set<RequestScope>`）：`createKernel` 内部维护，由 `routedSend` 挂载，`finally` 离开时安全移除。
   - 编排活跃运行作用域（`activeRunningScope`）：`orchestrator` 内部维护，严格对应当前正在前台调度的编排轮次。
   - 后台异步任务作用域（`backgroundScopes`）：`orchestrator` 内部维护，追踪前台已返回后仍需在后台执行的异步操作（如 `kickConsolidation`）。
   - 暂停审批作用域：通过持久化机制（`pausedTurnStore` / recovery sidecar）落地保存，不纳入在途活跃中断集合，防止重启或中断销毁审批现场。
2. **中断通知（`agent.interrupt()`）**：遍历 `activeScopes` 执行 `scope.abort("turn was interrupted")`；触发 `orchestrator.interrupt()` 中止 `activeRunningScope` 与 `backgroundScopes`；触发 `runtime.interrupt()` 中止单任务运行。
3. **内核销毁（`kernel.dispose()`）**：标记 `kernelDisposed = true`；遍历 `activeScopes` 执行 `scope.abort("kernel disposed")`；触发 `orchestrator.interrupt()`。**注意**：`dispose()` 不调用 `runtime.interrupt()`，以保留磁盘上供跨进程重启恢复使用的 `pausedTurnStore` 与持久化 sidecars。
4. **轮内及最终汇总收口与取消终态**：每轮派发结束的 `finishPartial` 与最终 `orchestrator.finalize` 都处理汇总期间的 `AbortError` 或已取消 signal，并在 await 后再次检查取消，避免模型迟到返回覆盖取消状态。`interrupt()` 或 `dispose()` 触发取消时保留已收集的子任务结果，由编排层返回 `{ status: "cancelled", outcome: "cancelled" }` 并发布一次 `orchestration:cancelled`，不发布 `orchestration:completed`。审批恢复后的轮内汇总遵守相同约定。未被取消时，预算不足或普通模型异常仍可由 synthesizer 降级为确定性摘要；轮内收口不吞掉其他意外异常。
5. **隔离工作区无迟到合并（`dispatch-loop.js`）**：派发前、并行等待后、以及调用 `mergeSubtask` 前严格检查 `signal.aborted`。若已被取消，已在隔离目录产出修改的 Worker 成果**绝不**合入主工作区；临时隔离目录经 `removeIso` 彻底清理，终态返回 `status: "cancelled"`。

### 7.7 旧恢复记录迁移与兼容

- **有限配额且历史未记账**：若 sidecar 属于旧版本（缺少 `settledAttempts`、`unknownUsageAttempts` 元数据），且配置了有限配额（`quotaCalls` 或 `quotaTokens` 为有限数值），`orchestrationResumeGate` fail-closed 严格拒绝恢复（报错 `legacy unmetered budget: cannot safely verify remaining quota`），保留磁盘现场并防止配额重置失控。
- **已有未知次数但金额不完整**：若 `quotaTokens` 为有限数值、`unknownUsageAttempts > 0`，且 `unknownUsageTokens` 缺失或不是有限正数，扫描门禁将记录标为 blocked；恢复或直接构造 continuation 抛 `ORCH_RECOVERY_BLOCKED`，原因是 `unknown usage amount missing or invalid: cannot safely verify remaining token quota`。即使有 `byRole` 也不能放行。拒绝时不消费两份 sidecar，不执行审批编辑或模型请求。
- **新门禁的兼容边界**：未知次数为 0 的已计量记录不必补金额字段；含完整正数未知金额的新记录正常恢复。只有调用次数限制、没有 token 限制的已计量旧记录仍可沿用兼容估值，恢复后的 token 上限继续取原记录。
- **未设配额历史记录**：若为无限额历史记录（`quotaCalls: null, quotaTokens: null`），允许恢复并标记 `legacyUnmetered = true`，按已完成 subtask 数量保守估算起步消费（每完成一个 subtask 预估至少 2 次调用），保留 `initialUnknownUsageAttempts = 1`。
- **稳定恢复 ExecutionId 与 ByRole**：从持久化 sidecar 准确还原历史 `executionId`、`initialByRole` 与 `unknownUsageTokens`，经 `makeResumedBudget` 注入新预算实例。
- **有界 Settled Attempts**：`settledAttempts` 采用有界滑动窗口（Set，容量上限 1000 条），淘汰最早条目，防止长期连续运行导致内存无界泄漏。

### 7.8 行为级验收矩阵（摘要）

B01 模型 router 在同一 scope 内开始记账；B02 plan/worker/reviewer/replan/synth 全角色求和等于物理出站总数；B03 Worker 内 verify/repair 和 task 契约同 scope 记账；B04 网关 429 和 JSON 空回复重试物理计数，配额剩 1 时抑制 429 重试；B05 最后一名额 4 个 Worker 争抢，仅 1 个发起出站；B06 预留后出站前取消释放且不计 spent；B07 发送后超时/取消/网络断开，`model_calls` 正常扣除不退还并标记 `unknownUsageAttempts`；B08 缺失与非法 usage 均规范化拒绝；B09 响应后处理异常在 finally 中恰好结算一次，SSE 多 chunk usage 不双计；B10 预算为 0 时 planner/router 直接抛 `BUDGET_EXCEEDED` 不吞错；B11 预算不足跑 synthesizer 时返回确定性摘要无额外模型调用；B12 全树取消与隔离工作区零合并；B13 双 kernel 并发账本隔离；B14 非零消耗后暂停→dispose→新 kernel 恢复精确核算差额；B15 旧 schema/未计量记录门禁 blocked；B16 single 请求不受 `orchestration.budget` 限制；B17 后台经验蒸馏检查预算并跳过；B18/B19 自定义 gateway 全角色计费与防击穿；B20 恢复后保留 4020 unknown_usage_tokens 并在出站前精确拦截；B21 轮内/最终 × interrupt/dispose 统一返回 cancelled 且只发一次取消事件。

---

## 8. v1.18.0 运行闭环与统一 kernel 入口

### 8.1 真实 `task` 子任务委派（R18-02）

详见[编排](orchestration.md) §「`task` 委派」。运行时侧要点：子 Worker 共享父回合局部 `CostBudget`（双向同步增量）与编排 `RequestScope`（`role: "task"` 记账）；父回合 `interrupt()`、超时或 `kernel.dispose()` 立即中止在途子 Worker。

### 8.2 安全加固（v1.18.0）

1. **未受信工作区 MCP 持久化授权隔离**：`workspaceTrusted === false` 时拒绝授予 `project` / `always` 持久化审批作用域（强制降级为 `session`），且不加载工作区本地 `.deepseek-code/mcp-policy.json`，阻断恶意仓库预置策略自动放行。
2. **多记录 DNS 固定与 SSRF 防护**：`src/security/ssrf.js` 的 `createPinnedLookup` 支持 `options.all === true`（Node `http`/`https` Happy Eyeballs 路径），返回全部已校验的安全地址列表，确保多 A/AAAA 记录场景下无未校验 IP 漏出。
3. **Electron 渲染层导航锁死**：`gui/main.js` 在 `will-navigate` 与 `setWindowOpenHandler` 上拦截非本地应用入口的外部跳转。

### 8.3 chat/ask/edit/test 统一 kernel 入口与 bypass 封闭（V2-17）

- **chat 形态**：kernel 多轮 REPL，默认 `read-only` 自治级。入口 `dsc chat` 与 TUI chat 动作创建长寿命 kernel 进入 REPL。每行：`/` 前缀走命令，否则 `kernel.agent.send(line, { autonomy: currentMode })`，用共享渲染器消费事件与终态；`awaiting_approval` 走共享 `resolveApprovals`（自 kernel-runner 抽出）。
- **命令**：`/mode [read-only|gated|auto]`（无参循环三档，提示符显示当前档）、`/clear` 新会话、`/history` 打印当前时间线规模、`/exit` / `/quit` 退出。
- **`read-only` 自治级**：`DEFAULT_POLICY_MATRIX` 追加（不改既有四级）：

```js
"read-only": {
  read: "allow", read_secret: "ask",
  write_create: "deny", write_update: "deny", write_delete: "deny",
  execute: "deny", execute_dangerous: "deny", network: "deny", destructive: "deny"
}
```

`destructive` 仍硬编码 deny，`read_secret` 仍 ask。
- **移除的旁路**：chat 单发分支与 `sendChatMessage` 直调 `askDeepSeek`；`.deepseek-code/chat.json` 读写；界面到 `provider.askDeepSeek` 的一切路径。会话连续性来自 kernel session。
- **git 加固**：`runProcess` 从 `src/tools/builtin/shell.js` 移到 `src/security/shell-policy.js`，shell 与 git 共用。`git.js` 经 `resolveWorkspacePath` 后直接 `runProcess`，不再构造 shell 工具。元数据 `side_effect: "process"`、`category: "read"`（四只读操作：status/diff/log/show）。
- **死代码与边界测试**：删除 `src/tui.js` 无用的 `./agent.js` 导入；删除 `src/cli.js` 的 `detectTestCommand`（活路径在 `tools/builtin/test.js`）。边界测试（现收敛至 `tests/unit/apps-cli-and-tui.test.js` 与 `tests/integration/kernel-and-mcp.test.js`）钉住：cli/tui 不含 `provider`/`askDeepSeek`/`./agent.js`；chat 路径构造 kernel 而非 legacy chat 命令。
- 不变量：界面不得触达 `provider.askDeepSeek`；`read-only` 为增量矩阵行，破坏性仍硬 deny；git 读操作无审批。

---

## 9. 审计发现补救台账

六个并行只读审计覆盖 docs / kernel / context / model+tools+security / frontends / sessions+edits。处置总表：

| # | 问题 | 处置 |
|---|---|---|
| 1 | 分类器只认英文，中文落 general | v1.1.0：`src/core/planning/keywords.js` 中英共表 |
| 2 | GUI `buildKernelOptions` 分叉丢编排/语义配置 | v1.1.0：动态 import 共享实现（`src/apps/kernel-options.js`） |
| 3 | TUI/CLI 无法中断回合 | v1.1.0：TUI Esc / CLI SIGINT → `interrupt` |
| 4 | SSRF DNS rebinding + 黑名单缺口 | v1.1.0：全 A 记录校验 + IP pin + 补保留网段 |
| 5 | 脱敏正则过窄 | v1.1.0：确定性规则表（token/私钥块）；四份事件展示实现随 D-G4 共享契约完全解决 |
| 6 | grep ReDoS | v1.2.0：每文件 2s + 总 10s 协作超时 |
| 7 | shell 环境泄漏 + 无命令分类 | env v1.2.0；命令分类 v1.3.1 |
| 8 | 语义静默降级 + `languages` 空转 | v1.3.2：`context:semantic_degraded` + 删空转键 |
| 9 | 仓库卫生 | 9.1/9.2/9.4/9.5/9.7 v1.2.0；9.3 v1.6.2 后端 + v1.7.0 前端；9.6 v1.3.2 |
| 10 | `agent-runtime` 可维护性 | 阶段 1–2 v1.6.3；3–4 延后 v2.0 |

### 9.1 P2（v1.2.0）细节

- **grep 双预算超时**：`createGrepTool({ now, totalTimeoutMs, perFileTimeoutMs })`，默认总 10000ms、每文件 2000ms。协作检测：文件前查总预算，行循环定期查双预算。单文件超时跳过并计数；总预算尽则返回已有 matches。metadata：`matches`、`timed_out`、`timed_out_scope: file|total|null`、`files_skipped_timeout`、`files_searched`。非法 pattern 仍按构造错误上抛；不换外部正则引擎。
- **shell env 白名单**：`buildChildEnv(baseEnv, { allowExtra })` + `runProcess(..., { env })`。白名单：`PATH`、Windows 系统键、用户/临时目录、区域变量。不放行密钥类、`HTTP(S)_PROXY`/`NO_PROXY`/`ALL_PROXY`、`NODE_OPTIONS`。`allowExtra` 仅供测试。
- **卫生易项**：原型迁 `docs/prototypes/`；`test/` 迁入 `tests/`；模型 id 可被 config 覆盖；删除无引用的 `createPausedRecoveryFacade`；plan 头标注「完成状态以 CHANGELOG 为准」。

### 9.2 P3（v1.3.0）细节

- **命令策略**：`src/security/command-policy.js` 的 `classifyCommand(argv) → safe|dangerous|forbidden`。归一化 basename、小写、剥可执行后缀，部分规则看后续 argv（如 `git push --force`）。
  - 第 1 层：shell/git 的 `resolveCategory` 把 forbidden 映射 `destructive`（硬拒且不可被审批缓存放行），dangerous 映射 `execute_dangerous`（全档 ask），safe 仍 `execute` / git read 仍 `read`。
  - 第 2 层：`runProcess` spawn 前拦 forbidden，不 spawn；dangerous 不在此层拦（避免打断 test 的 `cmd.exe /c` 验证回路）。
  - 清单要点：forbidden 含 `format`/`mkfs*`/`diskpart`/`bcdedit`/`dd`；dangerous 含删除与系统命令、包装 shell（bash/sh/cmd/powershell/pwsh）、解释器执行参数（`node -e`、`python -c` 等）、`npm publish`、`git push --force` 等。
  - 审批 summary 加截断 argv 预览；修 `event-contract.argHint` 读 `call.params` 并支持 `argv`。
- **语义降级可观测**：`semantic-engine` 在 degraded 翻转处发一次 `context:semantic_degraded { reason }`，注册进 `SESSION_EVENT_TYPES`，`event-contract` 出非静默 warn。删除 `context.semantic.languages` 与 `normalizeLanguages`；语言固定 js/ts/py。删除未使用的 tsx wasm。
- **休眠渲染层**：删除 `gui/renderer/`。`gui/main.js` 顺序改为 dev URL → `renderer-dist`，两者皆无则报错退出并提示先 `npm run build:renderer`，不自动构建。
- 实现期修正：权限矩阵为五档（含 `read-only`）；`DEFAULT_POLICY_MATRIX` 全档显式含 `execute_dangerous`；归一化加 Win32 尾点/空白剥离；解释器规则用 `flag=` 前缀；git push 短选项用打包正则。

### 9.3 `agent-runtime` 可维护性（v1.6.3）

**阶段 1：行为刻画测试**（现收敛至 `tests/unit/agent-runtime.test.js`，包含 7 条核心刻画用例）：

| 刻画点 | 锁定内容 |
|---|---|
| 完整回合 | `user:message → agent:turn_started → agent:step → model:* → verification:result → agent:final` |
| 普通工具审批 | `turn:paused` / `approval:resolved` / `turn:resumed` 位置 |
| 主验证器审批 | 先 `verification:result` 再 pause；续跑重跑验证器 |
| 修复期工具审批 | 续跑继续 repair 循环；耗尽 → `agent:error` |
| 修复期验证器审批 | 续跑后 `repair:result` → `agent:final` |
| 未知审批 | `code = "APPROVAL_NOT_FOUND"` |
| 暂停中再 send | `code = "AWAITING_APPROVAL"` |

变异验证已执行：改错误码或交换事件顺序会使用例变红，还原后恢复。`tool:call`/`tool:result` 由 executor 发布，不在该序列内。

**阶段 2：职责边界**：

| 区域 | 职责 | 性质 |
|---|---|---|
| `send` / 快答 / 工具环 / `verifyAndMaybeRepair` | 回合编排 | 副作用主导 |
| `approve` + 两条 verifier resume | 四条恢复分支 | 最复杂编排 |
| `savePausedRecord` 等 | sidecar 持久化 | 副作用封装 |
| `verifierApprovalResumeState` 等 | resume_state / 参数映射 | 纯函数 |
| 顶层 helpers | 决策归一、预算快照 | 纯函数 |

公共样板：重建 pending → grant → `publishTurnResumed` → 执行差异点 operation → 再暂停则 `savePausedRecord` + 清理返回；完成则 clear + idle。

**阶段 3–4 候选（未开工，延后 v2.0）**：① 抽纯函数族迁出（风险极低）；② `resume-strategies` 参数化四分支样板（风险中，刻画测试可拦）；③ 生命周期状态机与阶段执行拆分（风险高，单独评估）。硬约束逐条验收：公开 API、事件顺序（刻画 + 集成测试）、错误语义 code/message、暂停–续跑时序不变。根因是职责混合与四条审批恢复样板重复，行数只是表征；补丁/小版本不做结构重构。

---

## 来源

- `2026-05-30-v2-7-approval-resume-design.md`
- `2026-05-31-v2-8-verifier-repair-loop-design.md`
- `2026-05-31-v2-10-context-cache-usage-telemetry-design.md`
- `2026-05-31-v2-17-chat-kernel-unification-bypass-closure-design.md`
- `2026-06-01-v2-18-durable-recovery-resume-hardening-design.md`
- `2026-06-24-v2-20a-runtime-cost-timeout-guardrails.md`
- `2026-06-25-v2-20b-guardrail-injection-graceful-stop.md`
- `2026-06-25-v2-20c-malformed-toolcall-retry.md`
- `2026-06-25-v2-20d-resume-path-guardrail-alignment.md`
- `2026-06-25-v2-20e-repair-path-model-timeout.md`
- `2026-06-25-v2-20f-guardrail-defaults-config.md`
- `2026-07-12-agent-findings-remediation.md`
- `2026-07-17-v1.2.0-agent-findings-p2-design.md`
- `2026-07-26-v1.3.0-agent-findings-p3-design.md`
- `2026-08-09-v1.6.3-agent-runtime-refactor-design.md`
- `2026-10-07-v1.18-r18-01-aggregate-budget-contract.md`
- `2026-10-23-v1.18.0-runtime-closure-design.md`
