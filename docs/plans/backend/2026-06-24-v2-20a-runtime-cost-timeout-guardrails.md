# V2-20a 运行时成本与超时护栏 Implementation Plan

> 完成状态以 [CHANGELOG](../../CHANGELOG.md) 为准。

> **状态:✅ 已完成(2026-06-25)** — 全部 5 个任务落地,测试 529 全绿、`npm run check` 通过。
> 提交:`c7fd9e1`(cost-budget)、`0603bd0`(model timeout)、`9bffcc5`(tool timeout)、`b0e6354`(executor-loop budget)、`49f338b`(runtime + kernel limits)。
> 后续见文末「范围说明与后续」(V2-20b)。


**Goal:** 给一个 turn 加上「最大成本闸」(token / 模型调用数上限)和「模型调用 + 工具调用超时」,使单个 turn 不会无界烧 token,也不会因模型或工具挂起而永久阻塞。

**Architecture:** 新增一个与运行时解耦的 `cost-budget` 纯模块,在 `executor-loop` 每次模型调用前 `check()`、调用后 `recordModelResult()`;模型超时在 `model-gateway` 的 `invoke`/`stream` 内把调用方 signal 与一个超时 AbortController 合并;工具超时在 `tools/executor` 内把 `def.execute()` 与计时器 race,超时落为标准 `status:"error"` 工具结果。三者均为纯增量,默认值可关(传 null 即禁用),不改动现有调用方行为。

**Tech Stack:** Node.js ESM、`node:test` + `node:assert/strict`、现有 `AbortController` / `setTimeout`(源码中可用;仅 Workflow 脚本禁用)。

## Global Constraints

- 模块格式:ESM(`import`/`export`),与现有 `src/` 一致;无新增第三方依赖。
- 测试:`node:test`,文件放 `tests/unit/...`,`import test from "node:test"; import assert from "node:assert/strict";`。
- 新增 `src/*.js` 必须加入 `package.json` 的 `check` 脚本(`node --check`)。
- 默认行为不变:所有新参数默认 `null`(护栏关闭)时,现有调用方与测试行为完全不变。
- 错误码约定:成本超限 `BUDGET_EXCEEDED`、模型超时 `MODEL_TIMEOUT`、工具超时 `TOOL_TIMEOUT`(`error.code`)。

---

### Task 1: cost-budget 纯模块

**Files:**
- Create: `src/core/runtime/cost-budget.js`
- Test: `tests/unit/core/runtime/cost-budget.test.js`
- Modify: `package.json`(check 脚本加入新文件)

**Interfaces:**
- Produces:
  - `createCostBudget({ maxTokens = null, maxModelCalls = null }) -> { recordModelResult(modelResult), check(), exceeded(), snapshot() }`
  - `recordModelResult(modelResult)`:从 `modelResult.usage`(形如 `{ prompt_tokens, completion_tokens, total_tokens }`)累加 token,并把 `model_calls` +1。
  - `check()`:若已达上限则抛 `Error`,`error.code === "BUDGET_EXCEEDED"`,`error.details = { reason, ... }`(`reason` 为 `"max_tokens"` 或 `"max_model_calls"`)。
  - `exceeded()`:返回 `null` 或 `{ reason, ... }`(不抛)。
  - `snapshot()`:返回 `{ tokens, model_calls, max_tokens, max_model_calls }`。

- [ ] **Step 1: 写失败测试**

创建 `tests/unit/core/runtime/cost-budget.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createCostBudget } from "../../../../src/core/runtime/cost-budget.js";

test("null limits never exceed", () => {
  const b = createCostBudget({});
  b.recordModelResult({ usage: { total_tokens: 999999 } });
  assert.equal(b.exceeded(), null);
  b.check(); // 不抛
  assert.deepEqual(b.snapshot(), { tokens: 999999, model_calls: 1, max_tokens: null, max_model_calls: null });
});

test("max_tokens trips after accumulation", () => {
  const b = createCostBudget({ maxTokens: 100 });
  b.recordModelResult({ usage: { total_tokens: 60 } });
  assert.equal(b.exceeded(), null);
  b.recordModelResult({ usage: { total_tokens: 60 } }); // 累计 120 >= 100
  assert.equal(b.exceeded().reason, "max_tokens");
  assert.throws(() => b.check(), (e) => e.code === "BUDGET_EXCEEDED" && e.details.reason === "max_tokens");
});

test("total_tokens falls back to prompt+completion", () => {
  const b = createCostBudget({ maxTokens: 50 });
  b.recordModelResult({ usage: { prompt_tokens: 30, completion_tokens: 25 } }); // 55
  assert.equal(b.exceeded().reason, "max_tokens");
});

test("max_model_calls trips after N calls", () => {
  const b = createCostBudget({ maxModelCalls: 2 });
  b.recordModelResult({ usage: { total_tokens: 1 } });
  b.check();
  b.recordModelResult({ usage: { total_tokens: 1 } });
  assert.throws(() => b.check(), (e) => e.code === "BUDGET_EXCEEDED" && e.details.reason === "max_model_calls");
});

test("missing usage still counts a model call", () => {
  const b = createCostBudget({ maxModelCalls: 1 });
  b.recordModelResult({});
  assert.equal(b.snapshot().model_calls, 1);
  assert.throws(() => b.check(), (e) => e.code === "BUDGET_EXCEEDED");
});
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `node --test tests/unit/core/runtime/cost-budget.test.js`
Expected: FAIL,`Cannot find module .../cost-budget.js`。

- [ ] **Step 3: 实现模块**

创建 `src/core/runtime/cost-budget.js`:

```js
export function createCostBudget({ maxTokens = null, maxModelCalls = null } = {}) {
  let tokens = 0;
  let modelCalls = 0;

  function recordModelResult(modelResult) {
    const usage = modelResult?.usage;
    if (usage) {
      const total = usage.total_tokens
        || ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0));
      tokens += total;
    }
    modelCalls += 1;
  }

  function exceeded() {
    if (maxTokens != null && tokens >= maxTokens) {
      return { reason: "max_tokens", tokens, max_tokens: maxTokens };
    }
    if (maxModelCalls != null && modelCalls >= maxModelCalls) {
      return { reason: "max_model_calls", model_calls: modelCalls, max_model_calls: maxModelCalls };
    }
    return null;
  }

  function check() {
    const over = exceeded();
    if (over) {
      const err = new Error(`cost budget exceeded: ${over.reason}`);
      err.code = "BUDGET_EXCEEDED";
      err.details = over;
      throw err;
    }
  }

  function snapshot() {
    return { tokens, model_calls: modelCalls, max_tokens: maxTokens, max_model_calls: maxModelCalls };
  }

  return { recordModelResult, check, exceeded, snapshot };
}
```

- [ ] **Step 4: 把新文件加入 check 脚本**

在 `package.json` 的 `check` 脚本里,把 `src/core/runtime/lifecycle.js` 一段所在的 `node --check ...` 列表中,`src/core/runtime/lifecycle.js` 后面追加 `src/core/runtime/cost-budget.js`(同一 `node --check` 调用内,空格分隔)。

- [ ] **Step 5: 运行测试与语法检查,确认通过**

Run: `node --test tests/unit/core/runtime/cost-budget.test.js`
Expected: PASS(5 个测试)。
Run: `npm run check`
Expected: 退出码 0。

- [ ] **Step 6: 提交**

```bash
git add src/core/runtime/cost-budget.js tests/unit/core/runtime/cost-budget.test.js package.json
git commit -m "feat(runtime): add cost-budget primitive (token/model-call ceiling)

```

---

### Task 2: 模型调用超时(gateway)

**Files:**
- Modify: `src/deepseek/model-gateway.js`
- Test: `tests/unit/deepseek/model-gateway-timeout.test.js`

**Interfaces:**
- Consumes:`createDeepSeekGateway({ fetchImpl })`(已存在,可注入假 fetch)。
- Produces:`invoke(messages, options)` 与 `stream(messages, options)` 新增 `options.timeoutMs`(毫秒,默认 `undefined`=不超时)。超时时拒绝,`error.code === "MODEL_TIMEOUT"`,`error.message` 含超时毫秒数。调用方已有的 `options.signal` 仍生效(与超时合并)。

- [ ] **Step 1: 写失败测试**

创建 `tests/unit/deepseek/model-gateway-timeout.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createDeepSeekGateway } from "../../../src/deepseek/model-gateway.js";

// 一个永不解决、但响应 abort 的假 fetch
function hangingFetch() {
  return (url, init = {}) => new Promise((_resolve, reject) => {
    const signal = init.signal;
    if (signal) {
      if (signal.aborted) return reject(abortError());
      signal.addEventListener("abort", () => reject(abortError()), { once: true });
    }
  });
}
function abortError() {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

test("invoke rejects with MODEL_TIMEOUT after timeoutMs", async () => {
  const gateway = createDeepSeekGateway({ apiKey: "k", fetchImpl: hangingFetch() });
  await assert.rejects(
    () => gateway.invoke([{ role: "user", content: "hi" }], { timeoutMs: 20 }),
    (e) => e.code === "MODEL_TIMEOUT"
  );
});

test("invoke without timeoutMs is unaffected (resolves normally)", async () => {
  const okFetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { total_tokens: 3 } })
  });
  const gateway = createDeepSeekGateway({ apiKey: "k", fetchImpl: okFetch });
  const r = await gateway.invoke([{ role: "user", content: "hi" }], {});
  assert.equal(r.content, "ok");
});
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `node --test tests/unit/deepseek/model-gateway-timeout.test.js`
Expected: 第一个测试 FAIL(当前无超时,Promise 永挂 → 测试超时或不抛 MODEL_TIMEOUT)。

- [ ] **Step 3: 实现超时包装**

在 `src/deepseek/model-gateway.js`,文件末尾(`authHeaders` 旁)新增辅助函数:

```js
function withTimeout(callerSignal, timeoutMs) {
  if (!timeoutMs) return { signal: callerSignal, cleanup: () => {}, didTimeout: () => false };
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      if (callerSignal) callerSignal.removeEventListener("abort", onAbort);
    },
    didTimeout: () => timedOut
  };
}

function modelTimeoutError(timeoutMs) {
  const err = new Error(`model request timed out after ${timeoutMs}ms`);
  err.code = "MODEL_TIMEOUT";
  return err;
}
```

把 `invoke` 改为(用 timeout 合并后的 signal,并在超时时抛 MODEL_TIMEOUT):

```js
  async function invoke(messages, options = {}) {
    const request = buildChatRequest(messages, { ...options, stream: false });
    const started = Date.now();
    const timeout = withTimeout(options.signal, options.timeoutMs);
    let response;
    try {
      response = await fetchImpl(request.url, { method: "POST", headers: authHeaders(apiKey), body: JSON.stringify(request.body), signal: timeout.signal });
    } catch (error) {
      if (timeout.didTimeout()) throw modelTimeoutError(options.timeoutMs);
      throw error;
    } finally {
      timeout.cleanup();
    }
    const latencyMs = Date.now() - started;
    if (!response.ok) throw createDeepSeekApiError(response.status, await response.text().catch(() => ""));
    const payload = await response.json();
    const processed = processChatPayload(payload, request.route, latencyMs);
    usageTracker.recordUsage({ usage: processed.usage, channel: request.route.channel, model: request.body.model, latency_ms: latencyMs });
    if (isRetryableDeepSeekError({ finish_reason: processed.finish_reason })) processed.retryable = true;
    return processed;
  }
```

把 `stream` 同样处理(把 `fetchImpl(...)` 包进 try/catch/finally,超时抛 `modelTimeoutError`):

```js
  async function stream(messages, options = {}) {
    const request = buildChatRequest(messages, { ...options, stream: true });
    const started = Date.now();
    const timeout = withTimeout(options.signal, options.timeoutMs);
    let response;
    try {
      response = await fetchImpl(request.url, { method: "POST", headers: authHeaders(apiKey), body: JSON.stringify(request.body), signal: timeout.signal });
    } catch (error) {
      if (timeout.didTimeout()) throw modelTimeoutError(options.timeoutMs);
      throw error;
    } finally {
      timeout.cleanup();
    }
    const latencyMs = Date.now() - started;
    if (!response.ok) throw createDeepSeekApiError(response.status, await response.text().catch(() => ""));
    const streamed = await readDeepSeekStream(response.body, { onDelta: options.onDelta, signal: timeout.signal });
    const result = { ...streamed, model: request.body.model, channel: request.route.channel, latency_ms: latencyMs, tool_calls: normalizeToolCalls(streamed.tool_calls) };
    usageTracker.recordUsage({ usage: result.usage, channel: request.route.channel, model: request.body.model, latency_ms: latencyMs });
    return result;
  }
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `node --test tests/unit/deepseek/model-gateway-timeout.test.js`
Expected: PASS(2 个测试)。
Run: `node --test tests/unit/deepseek/*.test.js`(确认网关既有测试无回归)
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/deepseek/model-gateway.js tests/unit/deepseek/model-gateway-timeout.test.js
git commit -m "feat(gateway): add model-call timeout (MODEL_TIMEOUT)

```

---

### Task 3: 工具调用超时(executor)

**Files:**
- Modify: `src/tools/executor.js`
- Test: `tests/unit/tools/executor-timeout.test.js`

**Interfaces:**
- Consumes:`createToolExecutor({ registry, permissionEngine, eventBus })`(已存在)。
- Produces:`createToolExecutor` 新增可选 `defaultToolTimeoutMs = null`;`execute(toolCall, context)` 的 `context.toolTimeoutMs` 可覆盖。超时时返回标准工具结果 `status:"error"`,`content[0].text` 含 `timed out`,`metadata.timeout === true`(不抛,交回模型继续)。`timeoutMs` 为 null 时行为不变。
  - 说明:超时只「上报错误」,**不强杀**底层进程(真正取消长任务需把 signal 透传给工具,列为后续)。

- [ ] **Step 1: 写失败测试**

创建 `tests/unit/tools/executor-timeout.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createToolExecutor } from "../../../src/tools/executor.js";

function fakeRegistry(execFn) {
  const def = {
    name: "slow",
    category: "read",
    risk_level: "low",
    execute: execFn,
    normalizeParams: (p) => p,
    resolveCategory: () => "read"
  };
  return {
    resolve: (name) => (name === "slow" ? def : null),
    secureToolCall: (call) => ({ ...call, category: "read", params: call.params || {} })
  };
}
const allowEngine = { decide: () => ({ decision: "allow", matched_rule: "test" }) };
const call = { id: "tc_1", name: "slow", params: {} };

test("tool exec times out into an error result", async () => {
  const registry = fakeRegistry(() => new Promise(() => {})); // 永不解决
  const executor = createToolExecutor({ registry, permissionEngine: allowEngine, defaultToolTimeoutMs: 20 });
  const result = await executor.execute(call, { turnId: "t1" });
  assert.equal(result.status, "error");
  assert.equal(result.metadata.timeout, true);
  assert.match(result.content[0].text, /timed out/i);
});

test("fast tool under timeout succeeds", async () => {
  const registry = fakeRegistry(async () => ({ status: "success", content: [{ type: "text", text: "done" }] }));
  const executor = createToolExecutor({ registry, permissionEngine: allowEngine, defaultToolTimeoutMs: 1000 });
  const result = await executor.execute(call, { turnId: "t1" });
  assert.equal(result.status, "success");
});

test("no timeout configured keeps current behavior", async () => {
  const registry = fakeRegistry(async () => ({ status: "success", content: [] }));
  const executor = createToolExecutor({ registry, permissionEngine: allowEngine });
  const result = await executor.execute(call, { turnId: "t1" });
  assert.equal(result.status, "success");
});
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `node --test tests/unit/tools/executor-timeout.test.js`
Expected: 第一个测试 FAIL(当前 `def.execute` 永挂,无超时)。

- [ ] **Step 3: 实现工具超时**

在 `src/tools/executor.js`,把工厂签名改为:

```js
export function createToolExecutor({ registry, permissionEngine, eventBus = null, defaultToolTimeoutMs = null } = {}) {
```

在文件内新增辅助:

```js
function runWithTimeout(promiseFactory, timeoutMs) {
  if (!timeoutMs) return promiseFactory();
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const err = new Error(`tool timed out after ${timeoutMs}ms`);
      err.code = "TOOL_TIMEOUT";
      reject(err);
    }, timeoutMs);
    Promise.resolve()
      .then(promiseFactory)
      .then((value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } })
      .catch((error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
  });
}
```

把执行 try 块(当前 `const raw = await def.execute(...)`)改为带超时,并区分超时错误:

```js
    try {
      const timeoutMs = context.toolTimeoutMs ?? defaultToolTimeoutMs;
      const raw = await runWithTimeout(() => def.execute(securedCall.params, context), timeoutMs);
      return publishResult(createToolResult({
        callId: toolCall.id,
        status: raw.status || "success",
        content: redactToolContent(raw.content || []),
        metadata: raw.metadata || {},
        durationMs: Date.now() - started
      }));
    } catch (error) {
      return publishResult(createToolResult({
        callId: toolCall.id,
        status: "error",
        content: [{ type: "error", text: error.message }],
        metadata: error.code === "TOOL_TIMEOUT" ? { timeout: true } : {},
        durationMs: Date.now() - started
      }));
    }
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `node --test tests/unit/tools/executor-timeout.test.js`
Expected: PASS(3 个测试)。
Run: `node --test tests/unit/tools/*.test.js`(确认 executor 既有测试无回归)
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/tools/executor.js tests/unit/tools/executor-timeout.test.js
git commit -m "feat(tools): add tool-call timeout surfacing as error result

```

---

### Task 4: 成本闸接入 executor-loop

**Files:**
- Modify: `src/core/execution/executor-loop.js`
- Test: `tests/unit/core/execution/executor-loop-budget.test.js`

**Interfaces:**
- Consumes:Task 1 的 `createCostBudget`;`runExecutorLoop`/`resumeExecutorLoop` 现有签名。
- Produces:`runExecutorLoop` 与 `resumeExecutorLoop` 新增可选参数 `budget = null`。每轮模型调用**前** `budget?.check()`(可抛 `BUDGET_EXCEEDED` 上抛给调用方),调用**后** `budget?.recordModelResult(modelResult)`。`budget` 为 null 时行为不变。

- [ ] **Step 1: 写失败测试**

创建 `tests/unit/core/execution/executor-loop-budget.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { runExecutorLoop } from "../../../../src/core/execution/executor-loop.js";
import { createCostBudget } from "../../../../src/core/runtime/cost-budget.js";

// 假 gateway:每轮都要求再调一次工具,从不自然结束 → 必须靠 budget 截停
function toolLoopingGateway() {
  return {
    invoke: async () => ({
      content: "",
      tool_calls: [{ id: "c1", type: "function", function: { name: "noop", arguments: "{}" } }],
      usage: { total_tokens: 40 }
    })
  };
}
const noopExecute = async () => ({ call_id: "c1", status: "success", content: [], metadata: {} });
const policy = () => ({});

test("budget stops the loop with BUDGET_EXCEEDED", async () => {
  const budget = createCostBudget({ maxTokens: 100 }); // 第 3 轮前累计 80→120 触发
  await assert.rejects(
    () => runExecutorLoop({
      message: "go",
      classification: { task_type: "edit" },
      turnId: "t1",
      modelGateway: toolLoopingGateway(),
      toolSchemas: [],
      executeTool: noopExecute,
      createPolicyContext: policy,
      maxIterations: 50,
      budget
    }),
    (e) => e.code === "BUDGET_EXCEEDED"
  );
  assert.ok(budget.snapshot().tokens >= 100);
});

test("no budget keeps maxIterations behavior", async () => {
  await assert.rejects(
    () => runExecutorLoop({
      message: "go",
      classification: { task_type: "edit" },
      turnId: "t1",
      modelGateway: toolLoopingGateway(),
      toolSchemas: [],
      executeTool: noopExecute,
      createPolicyContext: policy,
      maxIterations: 2
    }),
    /maximum tool iterations exceeded/
  );
});
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `node --test tests/unit/core/execution/executor-loop-budget.test.js`
Expected: 第一个测试 FAIL(当前不认识 `budget`,会一直循环到 maxIterations=50 抛 iterations 错)。

- [ ] **Step 3: 接入 budget**

在 `src/core/execution/executor-loop.js`,`runExecutorLoop` 参数解构里加入 `budget = null`(放在 `options = {}` 之前任意位置):

```js
export async function runExecutorLoop({
  message,
  classification,
  turnId,
  modelGateway,
  toolSchemas = [],
  executeTool,
  createPolicyContext,
  eventBus = null,
  signal = null,
  maxIterations = 5,
  context = null,
  budget = null,
  options = {}
} = {}) {
```

在 `for` 循环体最开头(`eventBus?.publish?.("model:request"...)` 之前)加入:

```js
    if (budget) budget.check();
```

在 `const modelResult = await modelGateway.invoke(...)` 之后、`eventBus?.publish?.("model:response"...)` 之前加入:

```js
    if (budget) budget.recordModelResult(modelResult);
```

对 `resumeExecutorLoop` 同样处理:解构加 `budget = null`;在其 `for` 循环体开头加 `if (budget) budget.check();`,在 `const modelResult = await modelGateway.invoke(...)` 之后加 `if (budget) budget.recordModelResult(modelResult);`。

- [ ] **Step 4: 运行测试,确认通过**

Run: `node --test tests/unit/core/execution/executor-loop-budget.test.js`
Expected: PASS(2 个测试)。
Run: `node --test tests/unit/core/execution/*.test.js`(无回归)
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/core/execution/executor-loop.js tests/unit/core/execution/executor-loop-budget.test.js
git commit -m "feat(execution): enforce cost budget in executor loop

```

---

### Task 5: 在 agent-runtime 装配护栏 + kernel 透传配置

**Files:**
- Modify: `src/core/runtime/agent-runtime.js`
- Modify: `src/index.js`
- Test: `tests/unit/core/runtime/agent-runtime-budget.test.js`

**Interfaces:**
- Consumes:Task 1 `createCostBudget`、Task 4 的 `runExecutorLoop({ budget })`。
- Produces:
  - `createAgentRuntime` 新增可选 `maxTurnTokens = null`、`maxModelCalls = null`(仅这两个,供成本闸使用)。
  - 走工具循环时为该 turn 创建 `createCostBudget({ maxTokens, maxModelCalls })` 并传给 `runExecutorLoop`;`options.maxTurnTokens` / `options.maxModelCalls` 可逐次覆盖工厂默认。
  - `createKernel(root, options)` 把 `options.limits?.maxTurnTokens` / `options.limits?.maxModelCalls` 透传给 `createAgentRuntime`,把 `options.limits?.toolTimeoutMs` 透传给 `createToolExecutor({ defaultToolTimeoutMs })`。默认全 `null`(护栏关闭),现有行为不变。
  - 注:`modelTimeoutMs` 注入模型调用属 V2-20b,本任务不让 agent-runtime 接收该参数(避免未用参数)。

- [ ] **Step 1: 写失败测试**

创建 `tests/unit/core/runtime/agent-runtime-budget.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createAgentRuntime } from "../../../../src/core/runtime/agent-runtime.js";

// gateway 永远要求继续调工具,带 usage → 必须靠 budget 截停
const gateway = {
  invoke: async () => ({
    content: "",
    tool_calls: [{ id: "c1", type: "function", function: { name: "noop", arguments: "{}" } }],
    usage: { total_tokens: 50 }
  })
};
const executeTool = async () => ({ call_id: "c1", status: "success", content: [], metadata: {} });

test("runtime stops an edit turn when maxTurnTokens is exceeded", async () => {
  const runtime = createAgentRuntime({
    sessionId: "s1",
    modelGateway: gateway,
    executeTool,
    toolSchemas: () => [{ type: "function", function: { name: "noop" } }],
    createPolicyContext: () => ({}),
    maxToolIterations: 50,
    maxTurnTokens: 120
  });
  await assert.rejects(
    () => runtime.send("update the file", { autonomy: "auto" }),
    (e) => e.code === "BUDGET_EXCEEDED" || /cost budget exceeded/.test(e.message)
  );
});
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `node --test tests/unit/core/runtime/agent-runtime-budget.test.js`
Expected: FAIL(当前无 budget,循环到 maxToolIterations=50 抛 iterations 错,而非 BUDGET_EXCEEDED)。

- [ ] **Step 3: agent-runtime 装配 budget**

在 `src/core/runtime/agent-runtime.js`:

1) 顶部 import 加:

```js
import { createCostBudget } from "./cost-budget.js";
```

2) 工厂解构新增默认(放在 `createContextSnapshot` 旁):

```js
  maxTurnTokens = null,
  maxModelCalls = null,
```

3) `runToolLoopPath` 内,创建 budget 并传给 `runExecutorLoop`(在 `const loop = await runExecutorLoop({` 调用里新增 `budget`):

```js
  async function runToolLoopPath({ message, classification, turn, options, signal, context = null }) {
    lifecycle = transitionLifecycle(lifecycle, { to: "execute", reason: "tool loop started", channel: "act" });
    const budget = createCostBudget({
      maxTokens: options.maxTurnTokens ?? maxTurnTokens,
      maxModelCalls: options.maxModelCalls ?? maxModelCalls
    });
    const loop = await runExecutorLoop({
      message,
      classification,
      turnId: turn.id,
      context,
      modelGateway,
      toolSchemas: typeof toolSchemas === "function" ? toolSchemas() : toolSchemas,
      executeTool,
      createPolicyContext: ({ turnId, toolCall, phase }) => createPolicyContext({
        ...options,
        autonomy: options.autonomy || turn.autonomy,
        turnId,
        toolCall,
        phase
      }),
      eventBus,
      signal,
      maxIterations: options.maxToolIterations || maxToolIterations,
      budget,
      options
    });
    if (loop.status === "awaiting_approval") return loop;

    return verifyAndMaybeRepair({ turn, message, classification, loop, options, signal, context });
  }
```

> 说明:本任务 agent-runtime 只接成本闸两参(`maxTurnTokens` / `maxModelCalls`),可测断言是「成本闸生效」。工具超时由 kernel 直接传给 `createToolExecutor`(Task 3 已实现);模型超时注入(`modelTimeoutMs` → 每次 `modelGateway.invoke` 的 `options.timeoutMs`)属 V2-20b,不在本任务。

- [ ] **Step 4: kernel 透传配置**

在 `src/index.js` 的 `createKernel` 内,`createToolExecutor({...})` 调用新增 `defaultToolTimeoutMs`:

```js
  const toolExecutor = options.toolExecutor || createToolExecutor({
    registry: toolRegistry,
    permissionEngine,
    eventBus,
    defaultToolTimeoutMs: options.limits?.toolTimeoutMs ?? null
  });
```

`createAgentRuntime({...})` 调用新增两个 limits 透传(放在现有参数末尾):

```js
    createContextSnapshot: (input) => contextEngine.snapshot(input),
    maxTurnTokens: options.limits?.maxTurnTokens ?? null,
    maxModelCalls: options.limits?.maxModelCalls ?? null,
```

(若该 `createAgentRuntime` 调用中已存在 `grantApprovalForToolCall` 等后续键,把上面两行插在解构对象内任意合法位置即可,注意逗号。)

- [ ] **Step 5: 运行测试 + 全量回归 + 语法检查**

Run: `node --test tests/unit/core/runtime/agent-runtime-budget.test.js`
Expected: PASS。
Run: `npm test`
Expected: 全绿(无回归)。
Run: `npm run check`
Expected: 退出码 0。

- [ ] **Step 6: 提交**

```bash
git add src/core/runtime/agent-runtime.js src/index.js tests/unit/core/runtime/agent-runtime-budget.test.js
git commit -m "feat(runtime): wire cost budget into agent runtime and kernel limits

```

---

## 范围说明与后续

本计划聚焦 Phase A · V2-20 中**最先可落地、无依赖**的「成本闸 + 超时」护栏。以下属于 Phase A 但**另立计划**:

- **V2-20b**:把 `modelTimeoutMs` 注入每次 `modelGateway.invoke`(经 executor-loop 的 `options.timeoutMs`),把 `context.toolTimeoutMs` 注入工具执行路径;成本闸超限改为返回干净的 `status:"stopped"` 而非抛错(更好的 UX)。
- **V2-19**:迁移 `scan/search/diff/config/changes/rollback/resume/tui` 到 V2 kernel 后删除 V1 legacy(`src/agent.js`、`src/provider.js`、`src/kernel/*`),收敛 `apps/`。
- **V2-18 收口**:worktree `v2-18-durable-recovery` 合并;`/recovery` CLI 入口;Task 13 GUI Recovery Center(随 Phase D D-G7)、Task 14 端到端故障注入。

> 依据:[V3 路线图 §5](../../specs/architecture/2026-06-24-v3-roadmap-design.md)。
