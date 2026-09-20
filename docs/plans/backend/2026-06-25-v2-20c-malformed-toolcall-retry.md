# V2-20c 畸形 tool-call 有界重试 Implementation Plan

> 完成状态以 [CHANGELOG](../../CHANGELOG.md) 为准。

> 承接 [V2-20a](2026-06-24-v2-20a-runtime-cost-timeout-guardrails.md) / [V2-20b](2026-06-25-v2-20b-guardrail-injection-graceful-stop.md);约定沿用(ESM、`node:test`、默认关闭零回归）。

**Goal:** 当模型吐出**畸形 tool-call**(参数非合法 JSON,`adaptDeepSeekToolCalls` 抛 `invalid tool arguments`)时,执行器不再让整个 turn 直接失败,而是**有界重试**:回灌一条纠正消息并重新请求模型,最多 `maxToolCallRepairs` 次;超出才报错。补完坑 #5「JSON / tool calling 失败重试」。

**Architecture:** `executor-loop` 把 `adaptDeepSeekToolCalls` 包进 try/catch;命中畸形且重试额度未尽时,追加 `assistant`(畸形调用)+ `user`(纠正提示)消息并 `continue` 重发;计数到上限再 rethrow。默认 `maxToolCallRepairs = 0`(立即抛错,与现状一致),经 `createKernel({ limits: { maxToolCallRepairs } })` 选开。

---

### Task 1: executor-loop 有界 tool-call 重试

**Files:**
- Modify: `src/core/execution/executor-loop.js`
- Test: `tests/unit/core/execution/executor-loop-toolrepair.test.js`

**Interfaces:**
- Produces:`runExecutorLoop`/`resumeExecutorLoop` 新增可选 `maxToolCallRepairs = 0`。畸形 tool-call 时:额度未尽 → 追加纠正消息并重发(发 `model:tool_call_repair` 事件),额度耗尽 → rethrow 原错。默认 0 时立即抛错(行为不变)。

- [ ] **Step 1: 写失败测试**

创建 `tests/unit/core/execution/executor-loop-toolrepair.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { runExecutorLoop } from "../../../../src/core/execution/executor-loop.js";

// 第 1 次返回畸形 tool-call,第 2 次返回干净完成
function malformedThenDone() {
  let n = 0;
  return {
    invoke: async () => {
      n += 1;
      if (n === 1) {
        return { content: "", tool_calls: [{ id: "bad", name: "read", arguments: null, arguments_parse_error: "Unexpected token" }] };
      }
      return { content: "done", tool_calls: [], usage: { total_tokens: 1 } };
    },
    calls: () => n
  };
}

test("repairs a malformed tool call then completes", async () => {
  const gw = malformedThenDone();
  const result = await runExecutorLoop({
    message: "go",
    classification: { task_type: "edit" },
    turnId: "t1",
    modelGateway: gw,
    toolSchemas: [],
    executeTool: async () => ({ status: "success", content: [] }),
    createPolicyContext: () => ({}),
    maxIterations: 5,
    maxToolCallRepairs: 1
  });
  assert.equal(result.status, "complete");
  assert.equal(result.content, "done");
  assert.equal(gw.calls(), 2); // 初次 + 1 次重试
});

test("gives up after maxToolCallRepairs and throws", async () => {
  const alwaysBad = {
    invoke: async () => ({ content: "", tool_calls: [{ id: "bad", name: "read", arguments: null, arguments_parse_error: "boom" }] })
  };
  await assert.rejects(
    () => runExecutorLoop({
      message: "go",
      classification: { task_type: "edit" },
      turnId: "t1",
      modelGateway: alwaysBad,
      toolSchemas: [],
      executeTool: async () => ({ status: "success", content: [] }),
      createPolicyContext: () => ({}),
      maxIterations: 10,
      maxToolCallRepairs: 2
    }),
    /invalid tool arguments/
  );
});

test("default (no repairs) throws immediately", async () => {
  const alwaysBad = {
    invoke: async () => ({ content: "", tool_calls: [{ id: "bad", name: "read", arguments: null, arguments_parse_error: "boom" }] })
  };
  await assert.rejects(
    () => runExecutorLoop({
      message: "go",
      classification: { task_type: "edit" },
      turnId: "t1",
      modelGateway: alwaysBad,
      toolSchemas: [],
      executeTool: async () => ({ status: "success", content: [] }),
      createPolicyContext: () => ({}),
      maxIterations: 10
    }),
    /invalid tool arguments/
  );
});
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `node --test tests/unit/core/execution/executor-loop-toolrepair.test.js`
Expected: 第一个用例 FAIL(当前畸形即抛,不会重试到完成)。其余两个本就应通过。

- [ ] **Step 3: 实现重试(run + resume)**

`runExecutorLoop` 解构加 `maxToolCallRepairs = 0`(放在 `modelTimeoutMs = null` 旁)。在 `let messages = ...; const toolResults = [];` 之后加计数器:

```js
  let toolCallRepairs = 0;
```

把 run 循环里的:

```js
    const toolCalls = adaptDeepSeekToolCalls(rawToolCalls, { requestedByStepId: `model:${turnId}:${iteration}` });
```

替换为:

```js
    let toolCalls;
    try {
      toolCalls = adaptDeepSeekToolCalls(rawToolCalls, { requestedByStepId: `model:${turnId}:${iteration}` });
    } catch (error) {
      if (toolCallRepairs >= maxToolCallRepairs) throw error;
      toolCallRepairs += 1;
      eventBus?.publish?.("model:tool_call_repair", { turn_id: turnId, iteration, attempt: toolCallRepairs, reason: error.message });
      messages = [
        ...messages,
        assistantToolCallMessage(modelResult, rawToolCalls),
        { role: "user", content: `Your previous tool call had invalid arguments (${error.message}). Re-issue the tool call with valid JSON arguments.` }
      ];
      continue;
    }
```

`resumeExecutorLoop` 解构加 `maxToolCallRepairs = 0`;在其第二个(模型)循环前加 `let toolCallRepairs = 0;`;把该循环里的:

```js
    const toolCalls = adaptDeepSeekToolCalls(rawToolCalls, { requestedByStepId: `model:${resumeState.turn_id}:${iteration}` });
```

替换为(纠正块同上,仅 requestedByStepId 与 turn id 用 `resumeState.turn_id`):

```js
    let toolCalls;
    try {
      toolCalls = adaptDeepSeekToolCalls(rawToolCalls, { requestedByStepId: `model:${resumeState.turn_id}:${iteration}` });
    } catch (error) {
      if (toolCallRepairs >= maxToolCallRepairs) throw error;
      toolCallRepairs += 1;
      eventBus?.publish?.("model:tool_call_repair", { turn_id: resumeState.turn_id, iteration, attempt: toolCallRepairs, reason: error.message });
      messages = [
        ...messages,
        assistantToolCallMessage(modelResult, rawToolCalls),
        { role: "user", content: `Your previous tool call had invalid arguments (${error.message}). Re-issue the tool call with valid JSON arguments.` }
      ];
      continue;
    }
```

- [ ] **Step 4: 运行测试 + 回归**

Run: `node --test tests/unit/core/execution/executor-loop-toolrepair.test.js`
Expected: PASS(3)。
Run: `node --test tests/unit/core/execution/*.test.js`
Expected: PASS(含既有 "executor loop reports malformed tool arguments" 仍绿)。

- [ ] **Step 5: 提交**

```bash
git add src/core/execution/executor-loop.js tests/unit/core/execution/executor-loop-toolrepair.test.js
git commit -m "feat(execution): bounded retry on malformed tool-call output

```

---

### Task 2: 透传 maxToolCallRepairs(agent-runtime + kernel)

**Files:**
- Modify: `src/core/runtime/agent-runtime.js`
- Modify: `src/index.js`
- Test: `tests/unit/core/runtime/agent-runtime-toolrepair.test.js`

**Interfaces:**
- Produces:`createAgentRuntime` 新增 `maxToolCallRepairs = 0`,工具循环传给 `runExecutorLoop`;`createKernel` 由 `options.limits?.maxToolCallRepairs ?? 0` 注入。默认 0 不变。

- [ ] **Step 1: 写失败测试**

创建 `tests/unit/core/runtime/agent-runtime-toolrepair.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createAgentRuntime } from "../../../../src/core/runtime/agent-runtime.js";

function malformedThenDone() {
  let n = 0;
  return {
    invoke: async () => {
      n += 1;
      if (n === 1) return { content: "", tool_calls: [{ id: "bad", name: "noop", arguments: null, arguments_parse_error: "bad" }] };
      return { content: "done", tool_calls: [], usage: { total_tokens: 1 } };
    }
  };
}

test("runtime repairs a malformed tool call when maxToolCallRepairs > 0", async () => {
  const runtime = createAgentRuntime({
    sessionId: "s1",
    modelGateway: malformedThenDone(),
    executeTool: async () => ({ status: "success", content: [] }),
    toolSchemas: () => [{ type: "function", function: { name: "noop" } }],
    createPolicyContext: () => ({}),
    maxToolCallRepairs: 1
  });
  const r = await runtime.send("do it", { autonomy: "auto" });
  assert.equal(r.status, "complete");
  assert.equal(r.content, "done");
});
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `node --test tests/unit/core/runtime/agent-runtime-toolrepair.test.js`
Expected: FAIL(当前 runtime 不传 `maxToolCallRepairs`,畸形即抛 → send 抛错)。

- [ ] **Step 3: agent-runtime 透传**

在 `src/core/runtime/agent-runtime.js`:

1) 工厂解构加(放在 `modelTimeoutMs = null` 旁):

```js
  maxToolCallRepairs = 0,
```

2) `runToolLoopPath` 的 `runExecutorLoop({...})` 调用里新增(在 `modelTimeoutMs: ...,` 旁):

```js
      maxToolCallRepairs: options.maxToolCallRepairs ?? maxToolCallRepairs,
```

- [ ] **Step 4: kernel 注入**

在 `src/index.js` 的 `createAgentRuntime({...})` 调用里,`modelTimeoutMs` 行后新增:

```js
    modelTimeoutMs: options.limits?.modelTimeoutMs ?? null,
    maxToolCallRepairs: options.limits?.maxToolCallRepairs ?? 0,
```

- [ ] **Step 5: 运行测试 + 全量回归 + 语法检查**

Run: `node --test tests/unit/core/runtime/agent-runtime-toolrepair.test.js`
Expected: PASS。
Run: `npm test`
Expected: 全绿。
Run: `npm run check`
Expected: 退出码 0。

- [ ] **Step 6: 提交**

```bash
git add src/core/runtime/agent-runtime.js src/index.js tests/unit/core/runtime/agent-runtime-toolrepair.test.js
git commit -m "feat(runtime): thread maxToolCallRepairs through runtime and kernel limits

```

---

## 范围说明与后续

- 至此 kernel `limits` 五参:`maxTurnTokens` / `maxModelCalls` / `toolTimeoutMs` / `modelTimeoutMs` / `maxToolCallRepairs`,全部默认关闭(opt-in)。
- **已知后续**:approve() 的 resume(审批后续跑)路径目前未透传 `budget` / `modelTimeoutMs` / `maxToolCallRepairs`(resumeExecutorLoop 已支持参数,但 `approve()` 未传);可单列「V2-20d:resume 路径护栏对齐」。
- **建议**:V2-20 系列护栏均 plumbed-but-off,后续在 CLI/kernel-options 层设一组**保守默认值**(如 `toolTimeoutMs`/`modelTimeoutMs` 各 120s),让护栏真正生效。
- 仍属 Phase A 的较大项:**V2-19**(删 V1 legacy)、**V2-18 收口**(worktree 合并 + `/recovery` CLI)——风险较高,建议有人盯着时再做。

> 依据:[V3 路线图 §5](../../specs/architecture/2026-06-24-v3-roadmap-design.md)。
