# V2-20d resume 路径护栏对齐 Implementation Plan

> 完成状态以 [CHANGELOG](../../CHANGELOG.md) 为准。

> 承接 V2-20a/b/c;约定沿用(ESM、`node:test`、默认关闭零回归）。

**Goal:** 让审批后续(`approve()` → `resumeExecutorLoop`)与正常工具循环**享有同一套护栏**:成本预算、模型调用超时、畸形 tool-call 重试。当前 `runToolLoopPath` 全部透传,但 `approve()` 的 resume 调用一个都没传,导致审批恢复后的那段执行**裸跑**。

**Architecture:** 在 `approve()` 里(`resumeExecutorLoop` 前)新建一个成本预算(取 `resume_state.options` 覆盖 + 工厂配置),把 `budget` / `modelTimeoutMs` / `maxToolCallRepairs` 传入 `resumeExecutorLoop`;并在其后补一个 `status:"stopped"` 终态处理(镜像 `send()`),否则预算停止会错误流入 verify/repair。预算为该 resume 段**新建**(审批暂停是天然边界)。

**Tech Stack:** 现有 `src/core/runtime/agent-runtime.js`、`createCostBudget`(已导入)、`resumeExecutorLoop`(已支持三参与 `stopped` 返回)。

## Global Constraints

- 默认关闭:`maxTurnTokens`/`maxModelCalls`/`modelTimeoutMs` 默认 `null`、`maxToolCallRepairs` 默认 `0` → resume 行为不变。
- 不改 `resumeExecutorLoop`(已具备能力);只改 `approve()` 的调用与终态处理。

---

### Task 1: approve() resume 透传护栏 + stopped 终态

**Files:**
- Modify: `src/core/runtime/agent-runtime.js`
- Test: `tests/unit/core/runtime/agent-runtime-resume-guardrails.test.js`

**Interfaces:**
- Consumes:`createCostBudget`(已导入)、工厂级 `maxTurnTokens/maxModelCalls/modelTimeoutMs/maxToolCallRepairs`、`record.resume_state.options`。
- Produces:`approve()` 在 resume 段创建并传入 `budget`、`modelTimeoutMs`、`maxToolCallRepairs`;`resumeExecutorLoop` 返回 `status:"stopped"` 时,`approve()` 作为 turn 终态返回 `{ status:"stopped", state:"idle", content, turn, budget }` 并发 `agent:final` status=`stopped`。

- [ ] **Step 1: 写失败测试**

创建 `tests/unit/core/runtime/agent-runtime-resume-guardrails.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createAgentRuntime } from "../../../../src/core/runtime/agent-runtime.js";

// 模型每次都要求再调一次工具,以驱动多轮;send 阶段工具需审批,approve 后成功
function buildRuntime(overrides = {}) {
  let invokeCount = 0;
  let approvalConsumed = false;
  const modelGateway = {
    invoke: async () => {
      invokeCount += 1;
      return {
        content: "",
        tool_calls: [{ id: `c${invokeCount}`, type: "function", function: { name: "noop", arguments: "{}" } }],
        usage: { total_tokens: 1 }
      };
    }
  };
  const executeTool = async (toolCall) => {
    if (!approvalConsumed) {
      approvalConsumed = true;
      return { call_id: toolCall.id, status: "approval_required", content: [{ type: "text", text: "need ok" }], metadata: { approval: { id: "appr_1" } } };
    }
    return { call_id: toolCall.id, status: "success", content: [] };
  };
  const runtime = createAgentRuntime({
    sessionId: "s1",
    modelGateway,
    executeTool,
    toolSchemas: () => [{ type: "function", function: { name: "noop" } }],
    createPolicyContext: () => ({}),
    grantApprovalForToolCall: async () => {},
    ...overrides
  });
  return { runtime, invokes: () => invokeCount };
}

test("approve() resume enforces cost budget and stops the turn", async () => {
  const { runtime } = buildRuntime({ maxModelCalls: 1 });
  const paused = await runtime.send("go", { autonomy: "gated" });
  assert.equal(paused.status, "awaiting_approval");

  const resumed = await runtime.approve("appr_1", "approve");
  assert.equal(resumed.status, "stopped"); // 预算在 resume 段生效 → 干净停止(而非裸跑/抛错)
});
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `node --test tests/unit/core/runtime/agent-runtime-resume-guardrails.test.js`
Expected: FAIL —— 当前 resume 不带 budget,会一路 invoke 到 `maximum tool iterations exceeded` 抛错,而非返回 `stopped`。

- [ ] **Step 3: 实现 —— 在 approve() 创建预算并透传**

在 `src/core/runtime/agent-runtime.js` 的 `approve()` 里,把:

```js
      const loop = await resumeExecutorLoop({
        resumeState: record.resume_state,
        modelGateway,
        executeTool,
        createPolicyContext: ({ turnId, toolCall, phase }) => createPolicyContext({
          ...(record.resume_state.options || {}),
          autonomy: record.turn.autonomy,
          turnId,
          toolCall,
          phase
        }),
        eventBus,
        signal: currentAbortController.signal
      });
```

替换为:

```js
      const resumeOptions = record.resume_state.options || {};
      const budget = createCostBudget({
        maxTokens: resumeOptions.maxTurnTokens ?? maxTurnTokens,
        maxModelCalls: resumeOptions.maxModelCalls ?? maxModelCalls
      });
      const loop = await resumeExecutorLoop({
        resumeState: record.resume_state,
        modelGateway,
        executeTool,
        createPolicyContext: ({ turnId, toolCall, phase }) => createPolicyContext({
          ...resumeOptions,
          autonomy: record.turn.autonomy,
          turnId,
          toolCall,
          phase
        }),
        eventBus,
        signal: currentAbortController.signal,
        budget,
        modelTimeoutMs: resumeOptions.modelTimeoutMs ?? modelTimeoutMs,
        maxToolCallRepairs: resumeOptions.maxToolCallRepairs ?? maxToolCallRepairs
      });
```

- [ ] **Step 4: 实现 —— 补 stopped 终态处理**

紧接 `approve()` 里 `if (loop.status === "awaiting_approval") { ... }` 块之后(在 `// Repair-phase approval:` 注释之前)插入:

```js
      if (loop.status === "stopped") {
        const stoppedTurn = setTurnStatus(record.turn, "completed");
        publish(eventBus, "agent:final", { turn_id: record.turn_id, content: loop.content, status: "stopped" });
        lifecycle = transitionLifecycle(lifecycle, { to: "idle", reason: "cost budget stop", channel: null });
        currentTurnId = null;
        currentAbortController = null;
        return { status: "stopped", state: "idle", content: loop.content, turn: stoppedTurn, budget: loop.reason || null };
      }
```

- [ ] **Step 5: 运行测试 + 回归 + 语法检查**

Run: `node --test tests/unit/core/runtime/agent-runtime-resume-guardrails.test.js`
Expected: PASS。
Run: `node --test tests/unit/core/runtime/*.test.js tests/unit/core/execution/*.test.js`
Expected: PASS(无回归;既有审批 resume 测试仍绿)。
Run: `npm test`
Expected: 全绿。
Run: `npm run check`
Expected: 退出码 0。

- [ ] **Step 6: 提交**

```bash
git add src/core/runtime/agent-runtime.js tests/unit/core/runtime/agent-runtime-resume-guardrails.test.js
git commit -m "feat(runtime): apply cost/timeout/tool-repair guardrails to approval resume

```

---

## 范围说明与后续

- 预算为 resume 段**新建**(不继承暂停前已花费的 token);审批暂停是天然边界,够用。若日后要严格累计,可在 pause 时把 `budget.snapshot()` 写进 `resume_state` 并在此处恢复 —— 单列后续。
- 至此正常路径与审批 resume 路径**护栏一致**。repair-context 子路径(`runRepairLoop`)的预算透传仍未覆盖,可单列「V2-20e:repair-loop 预算对齐」。
- 仍属 Phase A 的较大项:**V2-19**(删 V1 legacy)、**V2-18 收口**(worktree 合并 + `/recovery` CLI)。

> 依据:[V3 路线图 §5](../../specs/architecture/2026-06-24-v3-roadmap-design.md);承接 V2-20a/b/c。
