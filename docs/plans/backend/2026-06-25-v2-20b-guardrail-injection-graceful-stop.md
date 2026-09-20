# V2-20b 护栏注入与优雅停止 Implementation Plan

> 完成状态以 [CHANGELOG](../../CHANGELOG.md) 为准。

> **状态:✅ 已完成(2026-06-25)** — 3 个任务落地,测试 531 全绿、`npm run check` 通过。
> 提交:`aa90498`(优雅停止·loop)、`927b5b9`(优雅停止·runtime)、`055f426`(modelTimeoutMs 注入)。

> 承接 [V2-20a](2026-06-24-v2-20a-runtime-cost-timeout-guardrails.md);约定(ESM、`node:test`、check 脚本、默认关闭零回归）沿用 V2-20a 的 Global Constraints,不再重复。

**Goal:** (A) 把 `modelTimeoutMs` 从 kernel 注入每次模型调用(executor-loop 与 reply 快路径);(B) 成本超限从抛 `BUDGET_EXCEEDED` 改为让一个 turn **干净停止**(`status:"stopped"` + 说明),而非异常冒泡到 CLI。

**Architecture:** executor-loop 由 `budget.check()`(抛)改为 `budget.exceeded()`(返回),命中即 `return { status:"stopped", ... }`;agent-runtime 把 `stopped` 当作 turn 终态(发 `agent:final` status=stopped,不跑 verify/repair);`modelTimeoutMs` 经 runtime 透传到 executor-loop 的每次 `invoke({ timeoutMs })` 和 `gateway.reply` 内部 invoke;kernel 由 `options.limits.modelTimeoutMs` 注入。默认 `null` 时行为不变。

---

### Task 1: executor-loop 成本超限优雅停止

**Files:**
- Modify: `src/core/execution/executor-loop.js`
- Modify: `tests/unit/core/execution/executor-loop-budget.test.js`(改既有断言:由 reject 改为返回 `stopped`)

**Interfaces:**
- Produces:`runExecutorLoop`/`resumeExecutorLoop` 命中预算时返回 `{ status: "stopped", reason: <exceeded对象>, content: string, iterations, toolResults }`,**不再抛** `BUDGET_EXCEEDED`。`budget` 为 null 时行为不变(仍受 maxIterations 约束)。

- [ ] **Step 1: 改既有测试为期望 stopped**

把 `tests/unit/core/execution/executor-loop-budget.test.js` 的第一个用例(原 "budget stops the loop with BUDGET_EXCEEDED")整体替换为:

```js
test("budget stops the loop with status stopped", async () => {
  const budget = createCostBudget({ maxTokens: 100 });
  const result = await runExecutorLoop({
    message: "go",
    classification: { task_type: "edit" },
    turnId: "t1",
    modelGateway: toolLoopingGateway(),
    toolSchemas: [],
    executeTool: noopExecute,
    createPolicyContext: policy,
    maxIterations: 50,
    budget
  });
  assert.equal(result.status, "stopped");
  assert.equal(result.reason.reason, "max_tokens");
  assert.ok(budget.snapshot().tokens >= 100);
});
```

(第二个用例 "no budget keeps maxIterations behavior" 保持不变。)

- [ ] **Step 2: 运行测试,确认失败**

Run: `node --test tests/unit/core/execution/executor-loop-budget.test.js`
Expected: 新用例 FAIL(当前 `budget.check()` 抛错而非返回 stopped)。

- [ ] **Step 3: 改 executor-loop 用 exceeded() 返回**

在 `runExecutorLoop` 的 `for` 循环开头,把:

```js
    if (budget) budget.check();
```

替换为:

```js
    const over = budget?.exceeded();
    if (over) {
      return { status: "stopped", reason: over, content: `Stopped: cost budget exceeded (${over.reason}).`, iterations: iteration, toolResults };
    }
```

在 `resumeExecutorLoop` 的第二个 `for`(模型循环)开头,把:

```js
    if (budget) budget.check();
```

替换为:

```js
    const over = budget?.exceeded();
    if (over) {
      return { status: "stopped", reason: over, content: `Stopped: cost budget exceeded (${over.reason}).`, iterations: iteration, toolResults };
    }
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `node --test tests/unit/core/execution/executor-loop-budget.test.js`
Expected: PASS(2)。
Run: `node --test tests/unit/core/execution/*.test.js`
Expected: PASS(无回归)。

- [ ] **Step 5: 提交**

```bash
git add src/core/execution/executor-loop.js tests/unit/core/execution/executor-loop-budget.test.js
git commit -m "feat(execution): budget overrun returns status:stopped (no throw)

```

---

### Task 2: agent-runtime 把 stopped 作为 turn 终态

**Files:**
- Modify: `src/core/runtime/agent-runtime.js`
- Modify: `tests/unit/core/runtime/agent-runtime-budget.test.js`(改断言:由 reject 改为返回 `stopped`)

**Interfaces:**
- Consumes:Task 1 的 `loop.status === "stopped"`。
- Produces:`send()` 命中预算时**正常返回** `{ status: "stopped", state: "idle", content, turn, budget }`,turn 标记 completed,发 `agent:final`(status=`stopped`),**不跑** verify/repair。

- [ ] **Step 1: 改既有测试为期望 stopped**

把 `tests/unit/core/runtime/agent-runtime-budget.test.js` 的用例替换为:

```js
test("runtime ends an edit turn cleanly when maxTurnTokens is exceeded", async () => {
  const runtime = createAgentRuntime({
    sessionId: "s1",
    modelGateway: gateway,
    executeTool,
    toolSchemas: () => [{ type: "function", function: { name: "noop" } }],
    createPolicyContext: () => ({}),
    maxToolIterations: 50,
    maxTurnTokens: 120
  });
  const r = await runtime.send("update the file", { autonomy: "auto" });
  assert.equal(r.status, "stopped");
  assert.equal(r.state, "idle");
  assert.match(r.content, /budget/i);
});
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `node --test tests/unit/core/runtime/agent-runtime-budget.test.js`
Expected: FAIL(当前 stopped 未被 send 处理,会落入 verifyAndMaybeRepair 或抛错)。

- [ ] **Step 3: runToolLoopPath 短路 stopped**

在 `src/core/runtime/agent-runtime.js` 的 `runToolLoopPath` 里,把:

```js
    if (loop.status === "awaiting_approval") return loop;

    return verifyAndMaybeRepair({ turn, message, classification, loop, options, signal, context });
```

改为:

```js
    if (loop.status === "awaiting_approval") return loop;
    if (loop.status === "stopped") return loop;

    return verifyAndMaybeRepair({ turn, message, classification, loop, options, signal, context });
```

- [ ] **Step 4: send() 处理 stopped 终态**

在 `send()` 里,`if (response.status === "awaiting_approval") {...}` 块之后、`if (response.status === "failed") {...}` 之前,插入:

```js
      if (response.status === "stopped") {
        turn = setTurnStatus(turn, "completed");
        publish(eventBus, "agent:final", { turn_id: turn.id, content: response.content, status: "stopped" });
        lifecycle = transitionLifecycle(lifecycle, { to: "idle", reason: "cost budget stop", channel: null });
        currentTurnId = null;
        currentAbortController = null;
        return { status: "stopped", state: "idle", content: response.content, turn, budget: response.reason || null };
      }
```

- [ ] **Step 5: 运行测试 + 回归**

Run: `node --test tests/unit/core/runtime/agent-runtime-budget.test.js`
Expected: PASS。
Run: `node --test tests/unit/core/runtime/*.test.js`
Expected: PASS(无回归)。

- [ ] **Step 6: 提交**

```bash
git add src/core/runtime/agent-runtime.js tests/unit/core/runtime/agent-runtime-budget.test.js
git commit -m "feat(runtime): surface budget stop as clean turn end (status:stopped)

```

---

### Task 3: modelTimeoutMs 注入(loop + reply + kernel)

**Files:**
- Modify: `src/core/execution/executor-loop.js`
- Modify: `src/deepseek/model-gateway.js`(`reply` 转发 `timeoutMs`)
- Modify: `src/core/runtime/agent-runtime.js`
- Modify: `src/index.js`
- Test: `tests/unit/core/execution/executor-loop-timeout.test.js`

**Interfaces:**
- Produces:
  - `runExecutorLoop`/`resumeExecutorLoop` 新增可选 `modelTimeoutMs = null`,把它作为 `timeoutMs` 传入每次 `modelGateway.invoke`。
  - `gateway.reply(...)` 内部 invoke 转发 `timeoutMs: options.timeoutMs`。
  - `createAgentRuntime` 新增 `modelTimeoutMs = null`:工具循环传给 `runExecutorLoop`,reply 快路径经 `options.timeoutMs` 注入。
  - `createKernel` 由 `options.limits?.modelTimeoutMs` 注入 runtime。默认 `null` 时不传超时,行为不变。

- [ ] **Step 1: 写失败测试(loop 把 modelTimeoutMs 传给 invoke)**

创建 `tests/unit/core/execution/executor-loop-timeout.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { runExecutorLoop } from "../../../../src/core/execution/executor-loop.js";

test("runExecutorLoop forwards modelTimeoutMs as invoke timeoutMs", async () => {
  let seen = null;
  const gateway = {
    invoke: async (_messages, opts) => {
      seen = opts.timeoutMs;
      return { content: "done", tool_calls: [], usage: { total_tokens: 1 } };
    }
  };
  const result = await runExecutorLoop({
    message: "hi",
    classification: { task_type: "edit" },
    turnId: "t1",
    modelGateway: gateway,
    toolSchemas: [],
    executeTool: async () => ({ status: "success", content: [] }),
    createPolicyContext: () => ({}),
    maxIterations: 3,
    modelTimeoutMs: 1234
  });
  assert.equal(result.status, "complete");
  assert.equal(seen, 1234);
});

test("no modelTimeoutMs leaves timeoutMs undefined", async () => {
  let seen = "unset";
  const gateway = {
    invoke: async (_messages, opts) => {
      seen = opts.timeoutMs;
      return { content: "done", tool_calls: [], usage: { total_tokens: 1 } };
    }
  };
  await runExecutorLoop({
    message: "hi",
    classification: { task_type: "edit" },
    turnId: "t1",
    modelGateway: gateway,
    toolSchemas: [],
    executeTool: async () => ({ status: "success", content: [] }),
    createPolicyContext: () => ({}),
    maxIterations: 3
  });
  assert.equal(seen, undefined);
});
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `node --test tests/unit/core/execution/executor-loop-timeout.test.js`
Expected: 第一个 FAIL(`seen` 为 undefined,未注入)。

- [ ] **Step 3: executor-loop 注入 timeoutMs**

`runExecutorLoop` 解构加 `modelTimeoutMs = null`(放在 `budget = null` 旁)。把其 `modelGateway.invoke(messages, { purpose: ..., tools, toolChoice, signal, ...options })` 改为在末尾追加 `timeoutMs`:

```js
    const modelResult = await modelGateway.invoke(messages, {
      purpose: iteration === 0 ? "plan" : "act",
      tools: toolSchemas,
      toolChoice: "auto",
      signal,
      ...options,
      timeoutMs: modelTimeoutMs ?? options.timeoutMs
    });
```

`resumeExecutorLoop` 解构加 `modelTimeoutMs = null`;其 `modelGateway.invoke(messages, { purpose: "act", tools, toolChoice, signal, ...(resumeState.options||{}) })` 末尾追加:

```js
      ...(resumeState.options || {}),
      timeoutMs: modelTimeoutMs ?? resumeState.options?.timeoutMs
```

- [ ] **Step 4: gateway.reply 转发 timeoutMs**

在 `src/deepseek/model-gateway.js` 的 `reply(...)` 内,把 `const result = await invoke(messages, { purpose, signal });` 改为:

```js
    const result = await invoke(messages, { purpose, signal, timeoutMs: options.timeoutMs });
```

- [ ] **Step 5: agent-runtime 透传 modelTimeoutMs**

在 `src/core/runtime/agent-runtime.js`:

1) 工厂解构加(放在 `maxModelCalls = null` 旁):

```js
  modelTimeoutMs = null,
```

2) `runToolLoopPath` 的 `runExecutorLoop({...})` 调用里新增(在 `budget,` 旁):

```js
      modelTimeoutMs: options.modelTimeoutMs ?? modelTimeoutMs,
```

3) `runReplyFastPath` 里把 reply 调用的 `options` 注入超时。把:

```js
      ? await modelGateway.reply({ message, classification, turn, options, signal, context })
```

改为:

```js
      ? await modelGateway.reply({ message, classification, turn, options: { ...options, timeoutMs: options.timeoutMs ?? modelTimeoutMs }, signal, context })
```

- [ ] **Step 6: kernel 注入 limits.modelTimeoutMs**

在 `src/index.js` 的 `createAgentRuntime({...})` 调用里,`maxModelCalls` 行后新增:

```js
    maxModelCalls: options.limits?.maxModelCalls ?? null,
    modelTimeoutMs: options.limits?.modelTimeoutMs ?? null,
```

- [ ] **Step 7: 运行测试 + 全量回归 + 语法检查**

Run: `node --test tests/unit/core/execution/executor-loop-timeout.test.js`
Expected: PASS(2)。
Run: `npm test`
Expected: 全绿。
Run: `npm run check`
Expected: 退出码 0。

- [ ] **Step 8: 提交**

```bash
git add src/core/execution/executor-loop.js src/deepseek/model-gateway.js src/core/runtime/agent-runtime.js src/index.js tests/unit/core/execution/executor-loop-timeout.test.js
git commit -m "feat(runtime): inject modelTimeoutMs into model calls (loop + reply + kernel)

```

---

## 范围说明与后续

- 本计划完成后,kernel `limits` 四参齐全:`maxTurnTokens` / `maxModelCalls` / `toolTimeoutMs` / `modelTimeoutMs`。
- 仍属 Phase A 的后续:**V2-19**(删 V1 legacy)、**V2-18 收口**(worktree 合并 + `/recovery` CLI 入口 + Task 13/14)。
- `context.toolTimeoutMs` 的逐调用覆盖路径已在 V2-20a 支持(executor 读 `context.toolTimeoutMs`),如需 agent 级动态调节再单列。

> 依据:[V3 路线图 §5](../../specs/architecture/2026-06-24-v3-roadmap-design.md)。
