# V2-20e repair 路径模型超时透传 Implementation Plan

> 完成状态以 [CHANGELOG](../../CHANGELOG.md) 为准。

> 承接 V2-20a–d;约定沿用(ESM、`node:test`、默认关闭零回归）。

**Goal:** 让验证-修复路径(`runRepairLoop` → `runRepairExecutor`)的模型调用也受 `modelTimeoutMs` 约束——堵住"repair 模型调用可永久挂起"这一可靠性缺口。

**Architecture:** `runRepairExecutor` 单次 `modelGateway.invoke` 增加 `timeoutMs: modelTimeoutMs ?? options.timeoutMs`;`runRepairLoop` 新增 `modelTimeoutMs` 形参并透传给执行器;`agent-runtime` 两处 `runRepairLoop` 调用点注入 `modelTimeoutMs`。默认 `null`(无超时,行为不变)。

**范围界定(YAGNI):** repair 路径的**成本预算**透传**显式延后**——repair 已被 `maxRepairAttempts`(默认 2)限轮,预算缺口至多 2 次调用,而把"预算 + 优雅 stopped"塞进单次执行器需不成比例的控制流改动。tool-call 重试同理(repair 执行器为单发结构)。本切片只补**超时**这一真实挂起风险。

## Global Constraints

- `modelTimeoutMs` 默认 `null` → repair 调用不带超时,现有行为不变。
- 不改 repair 的控制流/终态;仅透传一个 invoke 选项。

---

### Task 1: modelTimeoutMs 贯穿 repair 执行器与循环

**Files:**
- Modify: `src/core/execution/repair-executor.js`
- Modify: `src/core/verification/repair-loop.js`
- Modify: `src/core/runtime/agent-runtime.js`
- Test: `tests/unit/core/verification/repair-loop-timeout.test.js`

**Interfaces:**
- Produces:`runRepairExecutor({ ..., modelTimeoutMs = null })` 在 `invoke` 选项中加 `timeoutMs: modelTimeoutMs ?? options.timeoutMs`;`runRepairLoop({ ..., modelTimeoutMs = null })` 透传给 `runRepairExecutorImpl`;`agent-runtime` 两处调用注入 `modelTimeoutMs`。

- [ ] **Step 1: 写失败测试**

创建 `tests/unit/core/verification/repair-loop-timeout.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { runRepairExecutor } from "../../../../src/core/execution/repair-executor.js";
import { runRepairLoop } from "../../../../src/core/verification/repair-loop.js";

test("runRepairExecutor forwards modelTimeoutMs as timeoutMs to gateway.invoke", async () => {
  let seen = null;
  const modelGateway = { invoke: async (messages, options) => { seen = options; return { content: "fixed", tool_calls: [] }; } };
  const result = await runRepairExecutor({
    turnId: "t1",
    messages: [{ role: "user", content: "fix" }],
    modelGateway,
    toolSchemas: [],
    executeTool: async () => ({ status: "success", content: [] }),
    createPolicyContext: () => ({}),
    modelTimeoutMs: 1234
  });
  assert.equal(result.status, "complete");
  assert.equal(seen.timeoutMs, 1234);
});

test("runRepairLoop threads modelTimeoutMs into the repair executor", async () => {
  let seenTimeout;
  const fakeExecutor = async (args) => { seenTimeout = args.modelTimeoutMs; return { status: "complete", content: "x", toolResults: [] }; };
  const fakeVerifier = async () => ({ status: "passed" });
  await runRepairLoop({
    turnId: "t1",
    userMessage: "fix",
    modelGateway: { invoke: async () => ({ content: "", tool_calls: [] }) },
    executeTool: async () => ({ status: "success", content: [] }),
    createPolicyContext: () => ({}),
    verificationPolicy: {},
    initialVerification: { status: "failed" },
    initialToolResults: [],
    maxRepairAttempts: 1,
    modelTimeoutMs: 777,
    runRepairExecutorImpl: fakeExecutor,
    runVerifierImpl: fakeVerifier
  });
  assert.equal(seenTimeout, 777);
});
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `node --test tests/unit/core/verification/repair-loop-timeout.test.js`
Expected: 两个 FAIL(执行器未设 `timeoutMs`;循环未透传 `modelTimeoutMs`)。

- [ ] **Step 3: repair-executor 设置 timeoutMs**

`src/core/execution/repair-executor.js`:函数解构加 `modelTimeoutMs = null`(放在 `options = {}` 前);`modelGateway.invoke` 选项改为:

```js
  const modelResult = await modelGateway.invoke(messages, {
    ...options,
    purpose: "repair",
    tools: toolSchemas,
    toolChoice: "auto",
    timeoutMs: modelTimeoutMs ?? options.timeoutMs,
    signal
  });
```

- [ ] **Step 4: repair-loop 透传**

`src/core/verification/repair-loop.js`:解构加 `modelTimeoutMs = null`(放在 `options = {}` 后);`runRepairExecutorImpl({...})` 调用里加 `modelTimeoutMs,`(在 `signal,` 旁)。

- [ ] **Step 5: agent-runtime 两处注入**

`src/core/runtime/agent-runtime.js`:
- `verifyAndMaybeRepair` 的 `runRepairLoop({...})`(约 226 行)在 `maxRepairAttempts:` 行后加:
  ```js
        modelTimeoutMs: options.modelTimeoutMs ?? modelTimeoutMs,
  ```
- approve() 的 repair_context `runRepairLoop({...})`(约 334 行)在 `maxRepairAttempts: ctx.max_repair_attempts,` 行后加:
  ```js
          modelTimeoutMs: record.resume_state.options?.modelTimeoutMs ?? modelTimeoutMs,
  ```

- [ ] **Step 6: 运行测试 + 回归 + 检查**

Run: `node --test tests/unit/core/verification/repair-loop-timeout.test.js`
Expected: PASS(2)。
Run: `node --test tests/unit/core/verification/*.test.js tests/unit/core/execution/*.test.js tests/unit/core/runtime/*.test.js`
Expected: PASS(无回归)。
Run: `npm test` → 全绿;`npm run check` → 退出码 0。

- [ ] **Step 7: 提交**

```bash
git add src/core/execution/repair-executor.js src/core/verification/repair-loop.js src/core/runtime/agent-runtime.js tests/unit/core/verification/repair-loop-timeout.test.js
git commit -m "feat(verification): thread modelTimeoutMs into the repair path

```

---

## 范围说明与后续(护栏 plumbing 收尾)

- 至此 `modelTimeoutMs` 覆盖**全部三条模型调用路径**:正常工具循环(run/resume)、审批 resume、验证-修复。
- **deliberately deferred**:repair 路径的成本预算 / tool-call 重试(已被 attempts 限轮,价值边际);若日后需要再开 V2-20f。
- **护栏 plumbing epic 到此完整**。下一步建议转向:① 在 CLI/kernel-options 设保守默认值让护栏**真正生效**(需定值);② Phase A 的 **V2-19**(删 legacy)/ **V2-18 合并**(较大较险,建议有人在场)。

> 依据:[V3 路线图 §5](../../specs/architecture/2026-06-24-v3-roadmap-design.md);承接 V2-20a–d。
