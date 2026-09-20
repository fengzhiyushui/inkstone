# V2-7 Approval Resume Implementation Plan

> 完成状态以 [CHANGELOG](../../CHANGELOG.md) 为准。


**Goal:** Make V2 approval requests resumable so CLI, TUI, and GUI can approve or deny a paused tool call and finish the same agent turn.

**Architecture:** Add an in-memory paused turn store, make the executor loop return and consume resumable state, and resume through the existing ToolExecutor by granting the approved tool fingerprint into `approvalCache`. Kernel and UI layers keep the same public API shape but `agent.approve()` becomes async and returns a result.

**Tech Stack:** Node.js >=20 ESM, built-in `node:test`, existing V2 runtime/tool/session modules, no new dependencies.

---

## Scope

In scope:

- One active paused approval at a time.
- In-memory approval resume for the current process.
- Approve and deny decisions.
- Runtime, kernel, CLI runner, TUI helper, and GUI host wiring.
- Tests for duplicate approval, interrupt cleanup, session events, and no repository session pollution.

Out of scope:

- Durable resume after process restart.
- Multiple simultaneous paused turns.
- Full GUI redesign.
- Rich diff preview in approval cards.
- Repair loop and context engine work.
- Broad TUI/README mojibake cleanup.

## File Structure

Create:

- `src/core/approval/paused-turn-store.js`  
  Owns in-memory paused approval records.
- `tests/unit/core/approval/paused-turn-store.test.js`  
  Store unit tests.
- `tests/integration/v2-approval-resume.test.js`  
  Kernel-level approve/deny/resume tests.

Modify:

- `src/tools/registry.js`  
  Add `secureToolCall(toolCall)` so category/risk derivation is shared.
- `src/tools/executor.js`  
  Use `registry.secureToolCall()` instead of local secured-call construction.
- `src/core/execution/executor-loop.js`  
  Return `resume_state` on approval and add `resumeExecutorLoop()`.
- `src/core/runtime/agent-runtime.js`  
  Store paused state, make `approve()` async, resume or cancel turns, reject new send while paused.
- `src/index.js`  
  Inject paused store and `grantApprovalForToolCall()`.
- `src/apps/cli/kernel-runner.js`  
  Prompt once on `awaiting_approval`, call `kernel.agent.approve()`, render final result.
- `src/apps/cli/render-events.js`  
  Update stale V2-5 approval message.
- `src/tui.js`  
  Minimal approval prompt in `sendKernelPrompt()`.
- `gui/kernel-host.js`  
  Make `approve()` async and catch approval resume errors.
- `gui/main.js`  
  Await `host.approve()` IPC result.
- `package.json`  
  Add new approval module to `npm run check`.

---

### Task 1: Paused Turn Store

**Files:**
- Create: `src/core/approval/paused-turn-store.js`
- Test: `tests/unit/core/approval/paused-turn-store.test.js`

- [ ] **Step 1: Write the failing paused store tests**

Create `tests/unit/core/approval/paused-turn-store.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createPausedTurnStore } from "../../../../src/core/approval/paused-turn-store.js";

test("paused turn store saves gets and takes records once", () => {
  const store = createPausedTurnStore({ now: () => "2026-05-30T00:00:00.000Z" });
  const record = {
    approval_id: "approval_1",
    turn_id: "turn_1",
    approval: { id: "approval_1" },
    turn: { id: "turn_1" },
    resume_state: { pending_tool_call: { id: "call_1" } }
  };

  store.save(record);

  assert.equal(store.size(), 1);
  assert.equal(store.get("approval_1").created_at, "2026-05-30T00:00:00.000Z");
  assert.equal(store.take("approval_1").turn_id, "turn_1");
  assert.equal(store.get("approval_1"), null);
  assert.equal(store.take("approval_1"), null);
});

test("paused turn store rejects duplicate approval ids", () => {
  const store = createPausedTurnStore();
  const record = {
    approval_id: "approval_1",
    turn_id: "turn_1",
    approval: { id: "approval_1" },
    turn: { id: "turn_1" },
    resume_state: {}
  };

  store.save(record);

  assert.throws(() => store.save(record), /paused approval already exists/);
});

test("paused turn store deletes records for a turn and clears all", () => {
  const store = createPausedTurnStore();
  store.save({ approval_id: "a1", turn_id: "t1", approval: { id: "a1" }, turn: { id: "t1" }, resume_state: {} });
  store.save({ approval_id: "a2", turn_id: "t2", approval: { id: "a2" }, turn: { id: "t2" }, resume_state: {} });

  assert.equal(store.deleteForTurn("t1"), 1);
  assert.equal(store.get("a1"), null);
  assert.equal(store.get("a2").turn_id, "t2");

  store.clear();
  assert.equal(store.size(), 0);
});

test("paused turn store validates required fields", () => {
  const store = createPausedTurnStore();

  assert.throws(() => store.save({}), /approval_id is required/);
  assert.throws(
    () => store.save({ approval_id: "a", turn_id: "t", approval: { id: "different" }, turn: {}, resume_state: {} }),
    /approval.id must match approval_id/
  );
});
```

- [ ] **Step 2: Run the failing test**

Run:

```powershell
npm.cmd test -- tests/unit/core/approval/paused-turn-store.test.js
```

Expected: FAIL with module-not-found for `src/core/approval/paused-turn-store.js`.

- [ ] **Step 3: Implement `createPausedTurnStore()`**

Create `src/core/approval/paused-turn-store.js`:

```js
import { nowIso } from "../../shared/time.js";

export function createPausedTurnStore({ now = nowIso } = {}) {
  const records = new Map();

  function save(record) {
    validateRecord(record);
    if (records.has(record.approval_id)) {
      throw new Error(`paused approval already exists: ${record.approval_id}`);
    }
    const stored = {
      ...record,
      created_at: record.created_at || now()
    };
    records.set(stored.approval_id, stored);
    return stored;
  }

  function get(approvalId) {
    return records.get(approvalId) || null;
  }

  function take(approvalId) {
    const record = get(approvalId);
    if (!record) return null;
    records.delete(approvalId);
    return record;
  }

  function deleteForTurn(turnId) {
    let removed = 0;
    for (const [approvalId, record] of records.entries()) {
      if (record.turn_id === turnId) {
        records.delete(approvalId);
        removed += 1;
      }
    }
    return removed;
  }

  function clear() {
    records.clear();
  }

  function size() {
    return records.size;
  }

  return { save, get, take, deleteForTurn, clear, size };
}

function validateRecord(record) {
  if (!record || typeof record !== "object") throw new Error("paused record is required");
  if (!record.approval_id) throw new Error("approval_id is required");
  if (!record.turn_id) throw new Error("turn_id is required");
  if (!record.approval || typeof record.approval !== "object") throw new Error("approval is required");
  if (record.approval.id !== record.approval_id) throw new Error("approval.id must match approval_id");
  if (!record.turn || typeof record.turn !== "object") throw new Error("turn is required");
  if (!record.resume_state || typeof record.resume_state !== "object") throw new Error("resume_state is required");
}
```

- [ ] **Step 4: Run the paused store tests**

Run:

```powershell
npm.cmd test -- tests/unit/core/approval/paused-turn-store.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```powershell
git add src/core/approval/paused-turn-store.js tests/unit/core/approval/paused-turn-store.test.js
git commit -m "feat(v2): add paused approval store"
```

---

### Task 2: Shared Secured Tool Call Helper

**Files:**
- Modify: `src/tools/registry.js`
- Modify: `src/tools/executor.js`
- Test: `tests/unit/tools/registry.test.js`
- Test: `tests/unit/tools/executor.test.js`

- [ ] **Step 1: Add failing tests for shared secured call derivation**

Append to `tests/unit/tools/registry.test.js`:

```js
test("registry secureToolCall normalizes params and uses definition category", () => {
  const registry = createToolRegistry({
    tools: [{
      name: "memory",
      description: "memory",
      category: "read",
      risk_level: "medium",
      side_effect: "none",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string" },
          key: { type: "string" }
        },
        required: ["action"]
      },
      resolveCategory: (params) => params.action === "write" ? "write_update" : "read",
      execute: async () => ({ status: "success", content: [] })
    }]
  });

  const secured = registry.secureToolCall({
    id: "call_1",
    name: "memory",
    params: { action: "write", key: "style" },
    category: "read_secret",
    requested_by_step_id: "step_1"
  });

  assert.equal(secured.name, "memory");
  assert.equal(secured.category, "write_update");
  assert.equal(secured.risk_level, "medium");
  assert.equal(secured.requested_by_step_id, "step_1");
  assert.deepEqual(secured.params, { action: "write", key: "style" });
});
```

Append to `tests/unit/tools/executor.test.js`:

```js
test("executor uses registry secureToolCall helper for permission and events", async () => {
  const calls = [];
  const registry = {
    resolve: () => ({
      name: "custom",
      description: "custom",
      category: "read",
      risk_level: "low",
      side_effect: "none",
      execute: async () => ({ status: "success", content: [{ type: "text", text: "ok" }] })
    }),
    secureToolCall(toolCall) {
      calls.push(toolCall);
      return {
        id: toolCall.id,
        name: "custom",
        params: { path: "safe.txt" },
        category: "write_update",
        risk_level: "low",
        side_effect: "none",
        requested_by_step_id: toolCall.requested_by_step_id
      };
    }
  };
  const decisions = [];
  const executor = createToolExecutor({
    registry,
    permissionEngine: {
      decide: (call) => {
        decisions.push(call);
        return { decision: "allow", matched_rule: "test", source: "test" };
      }
    }
  });

  const result = await executor.execute(
    createToolCall({ id: "call_1", name: "custom", params: {}, requestedByStepId: "step_1" }),
    { autonomy: "gated" }
  );

  assert.equal(result.status, "success");
  assert.equal(calls.length, 1);
  assert.equal(decisions[0].category, "write_update");
});
```

- [ ] **Step 2: Run the failing tests**

Run:

```powershell
npm.cmd test -- tests/unit/tools/registry.test.js tests/unit/tools/executor.test.js
```

Expected: FAIL because `secureToolCall()` does not exist.

- [ ] **Step 3: Implement `registry.secureToolCall()`**

In `src/tools/registry.js`, add a function to the returned registry object:

```js
function secureToolCall(toolCall) {
  const def = resolve(toolCall.name);
  if (!def) throw new Error(`Unknown tool: ${toolCall.name}`);
  const params = normalizeParams(def.name, toolCall.params || {});
  const category = typeof def.resolveCategory === "function" ? def.resolveCategory(params) : def.category;
  return {
    id: toolCall.id,
    name: def.name,
    params,
    category,
    risk_level: def.risk_level,
    side_effect: def.side_effect,
    requested_by_step_id: toolCall.requested_by_step_id
  };
}
```

Ensure the registry return object includes `secureToolCall`.

In `src/tools/executor.js`, replace the local `params/category/securedCall` construction with:

```js
let securedCall;
try {
  securedCall = registry.secureToolCall(toolCall);
} catch (error) {
  return publishResult(createToolResult({
    callId: toolCall.id,
    status: "error",
    content: [{ type: "error", text: error.message }],
    durationMs: Date.now() - started
  }));
}
const params = securedCall.params;
const category = securedCall.category;
```

Keep the existing `def = registry.resolve(toolCall.name)` at the top because the executor still needs `def.execute()`.

- [ ] **Step 4: Run tool registry and executor tests**

Run:

```powershell
npm.cmd test -- tests/unit/tools/registry.test.js tests/unit/tools/executor.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```powershell
git add src/tools/registry.js src/tools/executor.js tests/unit/tools/registry.test.js tests/unit/tools/executor.test.js
git commit -m "feat(v2): share secured tool call derivation"
```

---

### Task 3: Resumable Executor Loop

**Files:**
- Modify: `src/core/execution/executor-loop.js`
- Test: `tests/unit/core/execution/executor-loop.test.js`

- [ ] **Step 1: Add failing executor resume tests**

Append to `tests/unit/core/execution/executor-loop.test.js`:

```js
import { resumeExecutorLoop } from "../../../../src/core/execution/executor-loop.js";
```

If the file already imports `runExecutorLoop`, change the import to:

```js
import { runExecutorLoop, resumeExecutorLoop } from "../../../../src/core/execution/executor-loop.js";
```

Append these tests:

```js
test("executor loop returns resume_state when approval is required", async () => {
  const result = await runExecutorLoop({
    message: "edit file",
    classification: { task_type: "edit" },
    turnId: "turn_approval",
    modelGateway: {
      invoke: async () => ({
        content: "",
        tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: "--- a/a.txt\n+++ b/a.txt" } }]
      })
    },
    toolSchemas: [],
    executeTool: async (toolCall) => ({
      call_id: toolCall.id,
      status: "approval_required",
      content: [{ type: "text", text: "edit requires approval" }],
      metadata: { approval: { id: "approval_1", summary: "edit requires approval" } }
    }),
    createPolicyContext: () => ({ autonomy: "supervised" })
  });

  assert.equal(result.status, "awaiting_approval");
  assert.equal(result.resume_state.pending_tool_call.name, "edit");
  assert.equal(result.resume_state.iteration, 0);
  assert.equal(result.resume_state.tool_results.length, 0);
});

test("resumeExecutorLoop executes pending and remaining tools then finishes", async () => {
  const modelCalls = [];
  const executed = [];
  const modelGateway = {
    invoke: async (messages) => {
      modelCalls.push(messages);
      return { content: "done after approval", tool_calls: [] };
    }
  };
  const resumeState = {
    turn_id: "turn_resume",
    message: "edit and read",
    classification: { task_type: "edit" },
    messages: [{ role: "user", content: "edit and read" }],
    model_result: { content: "", tool_calls: [
      { id: "call_edit", name: "edit", arguments: { diff: "d" } },
      { id: "call_read", name: "read", arguments: { path: "a.txt" } }
    ] },
    raw_tool_calls: [
      { id: "call_edit", name: "edit", arguments: { diff: "d" } },
      { id: "call_read", name: "read", arguments: { path: "a.txt" } }
    ],
    pending_tool_call: { id: "call_edit", name: "edit", params: { diff: "d" }, requested_by_step_id: "model:turn_resume:0" },
    remaining_tool_calls: [{ id: "call_read", name: "read", params: { path: "a.txt" }, requested_by_step_id: "model:turn_resume:0" }],
    iteration: 0,
    tool_results: [],
    tool_schemas: [],
    max_iterations: 5,
    options: {}
  };

  const result = await resumeExecutorLoop({
    resumeState,
    modelGateway,
    executeTool: async (toolCall) => {
      executed.push(toolCall.name);
      return { call_id: toolCall.id, status: "success", content: [{ type: "text", text: `${toolCall.name} ok` }], metadata: {} };
    },
    createPolicyContext: () => ({ autonomy: "supervised" })
  });

  assert.equal(result.status, "complete");
  assert.equal(result.content, "done after approval");
  assert.deepEqual(executed, ["edit", "read"]);
  assert.equal(modelCalls.length, 1);
  assert.ok(modelCalls[0].some((message) => message.role === "tool"));
});

test("resumeExecutorLoop can pause again on a remaining tool approval", async () => {
  const resumeState = {
    turn_id: "turn_resume_again",
    message: "edit then shell",
    classification: { task_type: "edit" },
    messages: [{ role: "user", content: "edit then shell" }],
    model_result: { content: "", tool_calls: [
      { id: "call_edit", name: "edit", arguments: { diff: "d" } },
      { id: "call_shell", name: "shell", arguments: { argv: ["npm", "test"] } }
    ] },
    raw_tool_calls: [
      { id: "call_edit", name: "edit", arguments: { diff: "d" } },
      { id: "call_shell", name: "shell", arguments: { argv: ["npm", "test"] } }
    ],
    pending_tool_call: { id: "call_edit", name: "edit", params: { diff: "d" }, requested_by_step_id: "model:turn_resume_again:0" },
    remaining_tool_calls: [{ id: "call_shell", name: "shell", params: { argv: ["npm", "test"] }, requested_by_step_id: "model:turn_resume_again:0" }],
    iteration: 0,
    tool_results: [],
    tool_schemas: [],
    max_iterations: 5,
    options: {}
  };

  const result = await resumeExecutorLoop({
    resumeState,
    modelGateway: { invoke: async () => ({ content: "should not call model", tool_calls: [] }) },
    executeTool: async (toolCall) => {
      if (toolCall.name === "shell") {
        return {
          call_id: toolCall.id,
          status: "approval_required",
          content: [{ type: "text", text: "shell requires approval" }],
          metadata: { approval: { id: "approval_shell" } }
        };
      }
      return { call_id: toolCall.id, status: "success", content: [{ type: "text", text: "edit ok" }] };
    },
    createPolicyContext: () => ({ autonomy: "supervised" })
  });

  assert.equal(result.status, "awaiting_approval");
  assert.equal(result.approval.id, "approval_shell");
  assert.equal(result.resume_state.pending_tool_call.name, "shell");
  assert.equal(result.resume_state.tool_results.length, 1);
});
```

- [ ] **Step 2: Run the failing executor tests**

Run:

```powershell
npm.cmd test -- tests/unit/core/execution/executor-loop.test.js
```

Expected: FAIL because `resumeExecutorLoop` and `resume_state` are missing.

- [ ] **Step 3: Refactor executor loop to return resumable state**

In `src/core/execution/executor-loop.js`:

1. Export `resumeExecutorLoop`.
2. When `result.status === "approval_required"` in `runExecutorLoop()`, return:

```js
return approvalPauseResult({
  result,
  turnId,
  message,
  classification,
  messages,
  modelResult,
  rawToolCalls,
  toolCalls,
  pendingIndex: toolCalls.indexOf(toolCall),
  iteration,
  toolResults,
  toolSchemas,
  maxIterations,
  options
});
```

3. Add helpers:

```js
function approvalPauseResult({
  result,
  turnId,
  message,
  classification,
  messages,
  modelResult,
  rawToolCalls,
  toolCalls,
  pendingIndex,
  iteration,
  toolResults,
  toolSchemas,
  maxIterations,
  options
}) {
  const pendingToolCall = toolCalls[pendingIndex];
  return {
    status: "awaiting_approval",
    content: result.content?.[0]?.text || "Approval required",
    approval: result.metadata?.approval || null,
    toolResults,
    iterations: iteration + 1,
    resume_state: {
      turn_id: turnId,
      message,
      classification,
      messages,
      model_result: modelResult,
      raw_tool_calls: rawToolCalls,
      pending_tool_call: pendingToolCall,
      remaining_tool_calls: toolCalls.slice(pendingIndex + 1),
      iteration,
      tool_results: toolResults,
      tool_schemas: toolSchemas,
      max_iterations: maxIterations,
      options
    }
  };
}
```

4. Implement `resumeExecutorLoop()`:

```js
export async function resumeExecutorLoop({
  resumeState,
  modelGateway,
  executeTool,
  createPolicyContext,
  eventBus = null,
  signal = null
} = {}) {
  if (!resumeState) throw new Error("resumeState is required");
  if (!modelGateway || typeof modelGateway.invoke !== "function") {
    throw new Error("modelGateway.invoke is required for executor loop resume");
  }
  if (typeof executeTool !== "function") throw new Error("executeTool is required");
  if (typeof createPolicyContext !== "function") throw new Error("createPolicyContext is required");

  const iterationResults = [];
  const toolResults = [...(resumeState.tool_results || [])];
  const pendingAndRemaining = [
    resumeState.pending_tool_call,
    ...(resumeState.remaining_tool_calls || [])
  ].filter(Boolean);

  for (let index = 0; index < pendingAndRemaining.length; index += 1) {
    const toolCall = pendingAndRemaining[index];
    const policyContext = createPolicyContext({ turnId: resumeState.turn_id, toolCall, phase: "resume" });
    const result = await executeTool(toolCall, policyContext);
    iterationResults.push(result);
    toolResults.push(result);
    if (result.status === "approval_required") {
      return approvalPauseResult({
        result,
        turnId: resumeState.turn_id,
        message: resumeState.message,
        classification: resumeState.classification,
        messages: resumeState.messages,
        modelResult: resumeState.model_result,
        rawToolCalls: resumeState.raw_tool_calls,
        toolCalls: pendingAndRemaining,
        pendingIndex: index,
        iteration: resumeState.iteration,
        toolResults,
        toolSchemas: resumeState.tool_schemas || [],
        maxIterations: resumeState.max_iterations || 5,
        options: resumeState.options || {}
      });
    }
  }

  let messages = [
    ...resumeState.messages,
    assistantToolCallMessage(resumeState.model_result, resumeState.raw_tool_calls),
    ...toolResultsToMessages(iterationResults)
  ];

  for (let iteration = resumeState.iteration + 1; iteration < (resumeState.max_iterations || 5); iteration += 1) {
    eventBus?.publish?.("model:request", { turn_id: resumeState.turn_id, purpose: "act", iteration });
    const modelResult = await modelGateway.invoke(messages, {
      purpose: "act",
      tools: resumeState.tool_schemas || [],
      toolChoice: "auto",
      signal,
      ...(resumeState.options || {})
    });
    eventBus?.publish?.("model:response", {
      turn_id: resumeState.turn_id,
      purpose: "act",
      iteration,
      content: modelResult.content || "",
      tool_call_count: modelResult.tool_calls?.length || 0,
      usage: modelResult.usage || null,
      model: modelResult.model,
      channel: modelResult.channel
    });
    const rawToolCalls = modelResult.tool_calls || [];
    if (!rawToolCalls.length) {
      return { status: "complete", content: modelResult.content || "", iterations: iteration + 1, toolResults };
    }
    const toolCalls = adaptDeepSeekToolCalls(rawToolCalls, { requestedByStepId: `model:${resumeState.turn_id}:${iteration}` });
    const next = await continueToolIteration({
      turnId: resumeState.turn_id,
      message: resumeState.message,
      classification: resumeState.classification,
      messages,
      modelResult,
      rawToolCalls,
      toolCalls,
      iteration,
      toolResults,
      toolSchemas: resumeState.tool_schemas || [],
      maxIterations: resumeState.max_iterations || 5,
      options: resumeState.options || {},
      executeTool,
      createPolicyContext
    });
    if (next.status === "awaiting_approval") return next;
    messages = [...messages, assistantToolCallMessage(modelResult, rawToolCalls), ...toolResultsToMessages(next.iterationResults)];
  }

  throw new Error(`maximum tool iterations exceeded: ${resumeState.max_iterations || 5}`);
}
```

5. To keep DRY, extract the per-iteration tool execution from `runExecutorLoop()` into `continueToolIteration()` and use it in both paths. The helper must return either `awaiting_approval` or `{ status: "continued", iterationResults }`.

- [ ] **Step 4: Run executor loop tests**

Run:

```powershell
npm.cmd test -- tests/unit/core/execution/executor-loop.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit Task 3**

```powershell
git add src/core/execution/executor-loop.js tests/unit/core/execution/executor-loop.test.js
git commit -m "feat(v2): add resumable executor loop"
```

---

### Task 4: Runtime Approval Resume

**Files:**
- Modify: `src/core/runtime/agent-runtime.js`
- Test: `tests/unit/core/agent-runtime.test.js`

- [ ] **Step 1: Add failing runtime approval resume tests**

Append to `tests/unit/core/agent-runtime.test.js`:

```js
test("agent runtime resumes a paused tool call after approval", async () => {
  const bus = createEventBus();
  const events = [];
  for (const type of ["approval:requested", "approval:resolved", "tool:result", "agent:final"]) {
    bus.subscribe(type, (data) => events.push([type, data]));
  }
  let approved = false;
  let invokeCount = 0;
  const runtime = createAgentRuntime({
    eventBus: bus,
    sessionId: "sess_resume",
    modelGateway: {
      invoke: async () => {
        invokeCount += 1;
        if (invokeCount === 1) {
          return { content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: "d" } }] };
        }
        return { content: "done after approve", tool_calls: [] };
      },
      reply: async () => ({ content: "fast" })
    },
    toolSchemas: () => [],
    executeTool: async (toolCall) => {
      if (!approved) {
        return {
          call_id: toolCall.id,
          status: "approval_required",
          content: [{ type: "text", text: "edit requires approval" }],
          metadata: { approval: { id: "approval_edit", summary: "edit requires approval" } }
        };
      }
      return { call_id: toolCall.id, status: "success", content: [{ type: "text", text: "applied" }], metadata: { change_id: "chg_1" } };
    },
    createPolicyContext: () => ({ autonomy: "supervised" }),
    grantApprovalForToolCall: async (toolCall) => {
      assert.equal(toolCall.name, "edit");
      approved = true;
    }
  });

  const first = await runtime.send("modify a.txt", { autonomy: "supervised" });
  assert.equal(first.status, "awaiting_approval");

  const resumed = await runtime.approve("approval_edit", "approve");

  assert.equal(resumed.status, "complete");
  assert.equal(resumed.content, "done after approve");
  assert.ok(events.some(([type]) => type === "approval:resolved"));
  assert.ok(events.some(([type]) => type === "agent:final"));
});

test("agent runtime runs verifier after approval resume edit results", async () => {
  let approved = false;
  let verifierRan = false;
  let invokeCount = 0;
  const runtime = createAgentRuntime({
    sessionId: "sess_resume_verify",
    modelGateway: {
      invoke: async () => {
        invokeCount += 1;
        if (invokeCount === 1) {
          return { content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: "d" } }] };
        }
        return { content: "done after verify", tool_calls: [] };
      },
      reply: async () => ({ content: "fast" })
    },
    toolSchemas: () => [],
    executeTool: async (toolCall) => {
      if (toolCall.name === "test") {
        verifierRan = true;
        return { call_id: toolCall.id, status: "success", content: [{ type: "text", text: "detect only" }], metadata: { detect_only: true } };
      }
      if (!approved) {
        return {
          call_id: toolCall.id,
          status: "approval_required",
          content: [{ type: "text", text: "edit requires approval" }],
          metadata: { approval: { id: "approval_edit", summary: "edit requires approval" } }
        };
      }
      return { call_id: toolCall.id, status: "success", content: [{ type: "text", text: "applied" }], metadata: { change_id: "chg_1" } };
    },
    createPolicyContext: () => ({ autonomy: "supervised" }),
    grantApprovalForToolCall: async () => { approved = true; }
  });

  const paused = await runtime.send("modify a.txt", { autonomy: "supervised" });
  const resumed = await runtime.approve(paused.approval.id, "approve");

  assert.equal(resumed.status, "complete");
  assert.equal(verifierRan, true);
  assert.equal(resumed.verification.status, "passed");
});

test("agent runtime denies a paused approval without executing the tool", async () => {
  let executions = 0;
  const runtime = createAgentRuntime({
    sessionId: "sess_deny",
    modelGateway: {
      invoke: async () => ({ content: "", tool_calls: [{ id: "call_shell", name: "shell", arguments: { argv: ["npm", "test"] } }] }),
      reply: async () => ({ content: "fast" })
    },
    executeTool: async (toolCall) => {
      executions += 1;
      return {
        call_id: toolCall.id,
        status: "approval_required",
        content: [{ type: "text", text: "shell requires approval" }],
        metadata: { approval: { id: "approval_shell" } }
      };
    },
    createPolicyContext: () => ({ autonomy: "supervised" })
  });

  const first = await runtime.send("run tests", { autonomy: "supervised" });
  assert.equal(first.status, "awaiting_approval");

  const denied = await runtime.approve("approval_shell", "deny");

  assert.equal(denied.status, "cancelled");
  assert.equal(executions, 1, "deny should not execute the pending tool again");
});

test("agent runtime rejects duplicate or unknown approval ids", async () => {
  const runtime = createAgentRuntime({ sessionId: "sess_unknown" });

  await assert.rejects(
    () => runtime.approve("missing", "approve"),
    /approval not found/
  );
});

test("agent runtime rejects new send while approval is paused", async () => {
  const runtime = createAgentRuntime({
    sessionId: "sess_paused_busy",
    modelGateway: {
      invoke: async () => ({ content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: "d" } }] }),
      reply: async () => ({ content: "fast" })
    },
    executeTool: async (toolCall) => ({
      call_id: toolCall.id,
      status: "approval_required",
      content: [{ type: "text", text: "edit requires approval" }],
      metadata: { approval: { id: "approval_edit" } }
    }),
    createPolicyContext: () => ({ autonomy: "supervised" })
  });

  const first = await runtime.send("modify a.txt", { autonomy: "supervised" });
  assert.equal(first.status, "awaiting_approval");

  await assert.rejects(
    () => runtime.send("second request"),
    /approval is awaiting resolution/
  );
});

test("agent runtime interrupt clears paused approvals", async () => {
  const runtime = createAgentRuntime({
    sessionId: "sess_interrupt_paused",
    modelGateway: {
      invoke: async () => ({ content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: "d" } }] }),
      reply: async () => ({ content: "fast" })
    },
    executeTool: async (toolCall) => ({
      call_id: toolCall.id,
      status: "approval_required",
      content: [{ type: "text", text: "edit requires approval" }],
      metadata: { approval: { id: "approval_edit" } }
    }),
    createPolicyContext: () => ({ autonomy: "supervised" })
  });

  await runtime.send("modify a.txt", { autonomy: "supervised" });
  runtime.interrupt();

  await assert.rejects(
    () => runtime.approve("approval_edit", "approve"),
    /approval not found/
  );
});
```

- [ ] **Step 2: Run failing runtime tests**

Run:

```powershell
npm.cmd test -- tests/unit/core/agent-runtime.test.js
```

Expected: FAIL because runtime does not store/resume paused approvals.

- [ ] **Step 3: Implement runtime approval resume**

Modify imports in `src/core/runtime/agent-runtime.js`:

```js
import { runExecutorLoop, resumeExecutorLoop } from "../execution/executor-loop.js";
import { createPausedTurnStore } from "../approval/paused-turn-store.js";
```

Add options:

```js
  pausedTurnStore = createPausedTurnStore(),
  grantApprovalForToolCall = async () => {}
```

At the start of `send()` before BUSY check:

```js
if (pausedTurnStore.size() > 0) {
  const err = new Error("approval is awaiting resolution");
  err.code = "AWAITING_APPROVAL";
  throw err;
}
```

When `response.status === "awaiting_approval"`, before returning:

```js
if (response.approval?.id && response.resume_state) {
  pausedTurnStore.save({
    approval_id: response.approval.id,
    turn_id: turn.id,
    approval: response.approval,
    turn,
    resume_state: response.resume_state
  });
}
```

Replace `approve()` with async logic:

```js
async function approve(approvalId, decision = "approve") {
  const normalized = normalizeApprovalDecision(decision);
  const record = pausedTurnStore.take(approvalId);
  if (!record) {
    const err = new Error(`approval not found: ${approvalId}`);
    err.code = "APPROVAL_NOT_FOUND";
    throw err;
  }
  publish(eventBus, "approval:resolved", { approval_id: approvalId, decision: normalized });

  if (normalized === "deny") {
    lifecycle = transitionLifecycle(lifecycle, { to: "idle", reason: "approval denied", channel: null });
    publish(eventBus, "agent:final", { turn_id: record.turn_id, content: "Approval denied.", status: "cancelled" });
    return { status: "cancelled", state: "idle", content: "Approval denied.", approval: record.approval, turn: setTurnStatus(record.turn, "cancelled") };
  }

  if (currentTurnId) {
    const err = new Error("another turn is in progress");
    err.code = "BUSY";
    throw err;
  }

  currentTurnId = record.turn_id;
  currentAbortController = new AbortController();
    lifecycle = transitionLifecycle(lifecycle, { to: "execute", reason: "approval resolved", channel: "act" });
  try {
    await grantApprovalForToolCall(record.resume_state.pending_tool_call, {
      turnId: record.turn_id,
      toolCall: record.resume_state.pending_tool_call,
      options: record.resume_state.options || {}
    });
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
    if (loop.status === "awaiting_approval") {
      pausedTurnStore.save({
        approval_id: loop.approval.id,
        turn_id: record.turn_id,
        approval: loop.approval,
        turn: record.turn,
        resume_state: loop.resume_state
      });
      lifecycle = transitionLifecycle(lifecycle, { to: "awaiting_approval", reason: "tool approval required", channel: "system" });
      currentTurnId = null;
      currentAbortController = null;
      return { status: "awaiting_approval", state: "awaiting_approval", content: loop.content, approval: loop.approval, turn: setTurnStatus(record.turn, "awaiting_approval") };
    }
    lifecycle = transitionLifecycle(lifecycle, { to: "verify", reason: "tool loop complete", channel: "system" });
    const verification = await runVerifier({
      turnId: record.turn_id,
      toolResults: loop.toolResults,
      executeTool,
      createPolicyContext: ({ turnId, toolCall, phase }) => createPolicyContext({
        autonomy: "auto",
        turnId,
        toolCall,
        phase
      }),
      eventBus
    });
    const repair = decideRepair(verification);
    if (repair.decision === "stop" && verification.status === "approval_required") {
      lifecycle = transitionLifecycle(lifecycle, { to: "awaiting_approval", reason: "verification approval required", channel: "system" });
      currentTurnId = null;
      currentAbortController = null;
      return {
        status: "awaiting_approval",
        state: "awaiting_approval",
        content: verification.reason || "Verification requires approval",
        approval: verification.tool_result?.metadata?.approval || null,
        turn: setTurnStatus(record.turn, "awaiting_approval"),
        verification
      };
    }
    if (repair.decision === "repair") {
      throw new Error(`verification failed: ${verification.reason}`);
    }
    const finalTurn = setTurnStatus(record.turn, "completed");
    publish(eventBus, "agent:final", { turn_id: record.turn_id, content: loop.content, status: "complete" });
    lifecycle = transitionLifecycle(lifecycle, { to: "idle", reason: "turn complete", channel: null });
    currentTurnId = null;
    currentAbortController = null;
    return { status: "complete", state: "idle", content: loop.content, turn: finalTurn, verification };
  } catch (error) {
    lifecycle = transitionLifecycle(lifecycle, { to: "failed", reason: error.message, channel: lifecycle.channel });
    publish(eventBus, "agent:error", { turn_id: record.turn_id, message: error.message });
    currentTurnId = null;
    currentAbortController = null;
    throw error;
  }
}
```

Add helper:

```js
function normalizeApprovalDecision(decision) {
  const value = String(decision || "").toLowerCase();
  if (value === "approve" || value === "allow" || value === "yes") return "approve";
  if (value === "deny" || value === "reject" || value === "no") return "deny";
  throw new Error(`unknown approval decision: ${decision}`);
}
```

In `interrupt()` add:

```js
pausedTurnStore.clear();
```

- [ ] **Step 4: Run runtime tests**

Run:

```powershell
npm.cmd test -- tests/unit/core/agent-runtime.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit Task 4**

```powershell
git add src/core/runtime/agent-runtime.js tests/unit/core/agent-runtime.test.js
git commit -m "feat(v2): resume runtime after approval"
```

---

### Task 5: Kernel Approval Grant Integration

**Files:**
- Modify: `src/index.js`
- Test: `tests/integration/v2-approval-resume.test.js`

- [ ] **Step 1: Write failing kernel integration tests**

Create `tests/integration/v2-approval-resume.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createKernel } from "../../src/index.js";

const DIFF = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new";

test("kernel approval resumes supervised edit and applies file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-approval-resume-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  let invokeCount = 0;
  const events = [];
  const kernel = await createKernel(root, {
    sessionRoot: path.join(root, ".sessions"),
    sessionId: "sess_approval_resume",
    modelGateway: {
      invoke: async () => {
        invokeCount += 1;
        if (invokeCount === 1) {
          return { content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: DIFF, prompt: "update a" } }] };
        }
        return { content: "updated a.txt", tool_calls: [] };
      },
      reply: async () => ({ content: "fast" })
    }
  });
  const sub = kernel.session.subscribe((event) => events.push(event));

  const paused = await kernel.agent.send("modify a.txt", { autonomy: "supervised" });
  assert.equal(paused.status, "awaiting_approval");
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "old\n");

  const resumed = await kernel.agent.approve(paused.approval.id, "approve");
  sub.unsubscribe();

  assert.equal(resumed.status, "complete");
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "new\n");
  assert.ok(events.some((event) => event.type === "approval:requested"));
  assert.ok(events.some((event) => event.type === "approval:resolved"));
  assert.ok(events.some((event) => event.type === "tool:result" && event.result?.status === "success"));
  assert.ok(events.some((event) => event.type === "agent:final"));
});

test("kernel approval deny leaves file unchanged", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-approval-deny-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  const kernel = await createKernel(root, {
    sessionRoot: path.join(root, ".sessions"),
    sessionId: "sess_approval_deny",
    modelGateway: {
      invoke: async () => ({ content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: DIFF, prompt: "update a" } }] }),
      reply: async () => ({ content: "fast" })
    }
  });

  const paused = await kernel.agent.send("modify a.txt", { autonomy: "supervised" });
  const denied = await kernel.agent.approve(paused.approval.id, "deny");

  assert.equal(denied.status, "cancelled");
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "old\n");
});

test("kernel rejects duplicate approval", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-approval-duplicate-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  let approved = false;
  const kernel = await createKernel(root, {
    sessionRoot: path.join(root, ".sessions"),
    sessionId: "sess_approval_duplicate",
    modelGateway: {
      invoke: async () => approved
        ? { content: "done", tool_calls: [] }
        : { content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: DIFF, prompt: "update a" } }] },
      reply: async () => ({ content: "fast" })
    }
  });

  const paused = await kernel.agent.send("modify a.txt", { autonomy: "supervised" });
  approved = true;
  await kernel.agent.approve(paused.approval.id, "approve");

  await assert.rejects(
    () => kernel.agent.approve(paused.approval.id, "approve"),
    /approval not found/
  );
});
```

- [ ] **Step 2: Run failing integration tests**

Run:

```powershell
npm.cmd test -- tests/integration/v2-approval-resume.test.js
```

Expected: FAIL because `createKernel()` does not grant approval fingerprints.

- [ ] **Step 3: Implement approval grant in `src/index.js`**

When creating `runtime`, pass:

```js
    grantApprovalForToolCall: async (toolCall, approvalContext = {}) => {
      const securedCall = toolRegistry.secureToolCall(toolCall);
      const policyContext = createPolicyContext({
        autonomy: approvalContext.options?.autonomy || "supervised",
        projectId: approvalContext.options?.projectId || sessionId,
        projectRoot: root,
        trustStore: options.trustStore || { rules: [] },
        projectRules: options.projectRules || [],
        approvalCache,
        memoryRoot: options.memoryRoot || null,
        turnId: approvalContext.turnId
      });
      const fp = permissionEngine.fingerprint(securedCall, policyContext);
      approvalCache.grant(fp, { decision: "allow" });
    }
```

Ensure `toolRegistry.secureToolCall` exists from Task 2.

- [ ] **Step 4: Run approval resume integration tests**

Run:

```powershell
npm.cmd test -- tests/integration/v2-approval-resume.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit Task 5**

```powershell
git add src/index.js tests/integration/v2-approval-resume.test.js
git commit -m "feat(v2): wire kernel approval resume"
```

---

### Task 6: GUI Host Approval Resume

**Files:**
- Modify: `gui/kernel-host.js`
- Modify: `gui/main.js`
- Test: `tests/unit/gui/kernel-host.test.js`

- [ ] **Step 1: Add failing GUI host approval test**

Append to `tests/unit/gui/kernel-host.test.js`:

```js
test("kernel host approve awaits V2 runtime approval result", async () => {
  const calls = [];
  const host = createKernelHost({
    projectRoot: "/repo",
    kernelFactory: async () => ({
      session: { subscribe: () => ({ unsubscribe() {} }), getTimeline: async () => [] },
      agent: {
        send: async () => ({ status: "awaiting_approval" }),
        approve: async (id, decision) => {
          calls.push([id, decision]);
          return { status: "complete", content: "resumed" };
        },
        interrupt: () => {}
      },
      context: { snapshot: async () => ({ units: [] }) },
      config: { getPublicConfig: () => ({ runtime: "v2" }) },
      runtime: { getState: () => ({ current: "idle", channel: null }) }
    })
  });

  await host.init();
  const result = await host.approve("approval_1", "approve");

  assert.deepEqual(calls, [["approval_1", "approve"]]);
  assert.deepEqual(result, { ok: true, result: { status: "complete", content: "resumed" } });
});
```

- [ ] **Step 2: Run failing GUI host test**

Run:

```powershell
npm.cmd test -- tests/unit/gui/kernel-host.test.js
```

Expected: FAIL because `host.approve()` does not await or return runtime result.

- [ ] **Step 3: Update GUI host and main IPC**

In `gui/kernel-host.js`, change:

```js
  function approve(id, decision) {
    requireKernel().agent.approve(id, decision);
    return { ok: true };
  }
```

to:

```js
  async function approve(id, decision) {
    const result = await requireKernel().agent.approve(id, decision);
    return { ok: true, result };
  }
```

In `gui/main.js`, change:

```js
  ipcMain.handle("agent:approve", (_event, id, decision) => {
    try { return host.approve(id, decision); }
    catch (error) { return { error: error.message }; }
  });
```

to:

```js
  ipcMain.handle("agent:approve", async (_event, id, decision) => {
    try { return await host.approve(id, decision); }
    catch (error) { return { error: error.message }; }
  });
```

- [ ] **Step 4: Run GUI host tests**

Run:

```powershell
npm.cmd test -- tests/unit/gui/kernel-host.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit Task 6**

```powershell
git add gui/kernel-host.js gui/main.js tests/unit/gui/kernel-host.test.js
git commit -m "feat(v2): await GUI approval resume"
```

---

### Task 7: CLI Approval Resume

**Files:**
- Modify: `src/apps/cli/kernel-runner.js`
- Modify: `src/apps/cli/render-events.js`
- Test: `tests/unit/apps/cli/kernel-runner.test.js`
- Test: `tests/unit/apps/cli/render-events.test.js`

- [ ] **Step 1: Add failing CLI approval tests**

Append to `tests/unit/apps/cli/kernel-runner.test.js`:

```js
test("runKernelAgentCommand prompts and resumes approval in process", async () => {
  const writes = [];
  const approvals = [];
  const result = await runKernelAgentCommand({
    root: "/repo",
    prompt: "modify a",
    write: (line) => writes.push(line),
    createKernelImpl: async () => ({
      session: { subscribe: () => ({ unsubscribe() {} }) },
      agent: {
        send: async () => ({ status: "awaiting_approval", approval: { id: "approval_1" }, content: "approval needed" }),
        approve: async (id, decision) => {
          approvals.push([id, decision]);
          return { status: "complete", content: "resumed final" };
        }
      }
    }),
    promptApproval: async () => "y"
  });

  assert.equal(result.status, "complete");
  assert.deepEqual(approvals, [["approval_1", "approve"]]);
  assert.ok(writes.some((line) => line.includes("resumed final")));
});
```

Update `tests/unit/apps/cli/render-events.test.js` expected approval message from the current stale text:

```js
"V2-5 CLI only displays approval requests. Approval resume is not wired yet."
```

to:

```js
"Approve? y/N"
```

- [ ] **Step 2: Run failing CLI tests**

Run:

```powershell
npm.cmd test -- tests/unit/apps/cli/kernel-runner.test.js tests/unit/apps/cli/render-events.test.js
```

Expected: FAIL because `promptApproval` is not implemented and stale approval text remains.

- [ ] **Step 3: Implement CLI approval prompt**

In `src/apps/cli/render-events.js`, change `renderKernelResult()` awaiting approval output to:

```js
return [
  "",
  `Approval required: ${result.approval?.id || "unknown"}`,
  "Approve? y/N"
];
```

In `src/apps/cli/kernel-runner.js`, update function signature:

```js
  promptApproval = defaultPromptApproval
```

After initial `kernel.agent.send()`:

```js
    let result = await kernel.agent.send(message, { autonomy, ...sendOptions });
    for (const line of renderKernelResult(result)) write(line);
    if (result.status === "awaiting_approval" && result.approval?.id) {
      const answer = await promptApproval(result.approval);
      const decision = isApprovalYes(answer) ? "approve" : "deny";
      result = await kernel.agent.approve(result.approval.id, decision);
      for (const line of renderKernelResult(result)) write(line);
    }
    return result;
```

Add helpers:

```js
async function defaultPromptApproval(approval) {
  const { createInterface } = await import("node:readline/promises");
  const { stdin, stdout } = await import("node:process");
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return await rl.question(`Approve ${approval.id}? y/N `);
  } finally {
    rl.close();
  }
}

function isApprovalYes(answer) {
  const value = String(answer || "").trim().toLowerCase();
  return value === "y" || value === "yes" || value === "approve" || value === "allow";
}
```

- [ ] **Step 4: Run CLI tests**

Run:

```powershell
npm.cmd test -- tests/unit/apps/cli/kernel-runner.test.js tests/unit/apps/cli/render-events.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit Task 7**

```powershell
git add src/apps/cli/kernel-runner.js src/apps/cli/render-events.js tests/unit/apps/cli/kernel-runner.test.js tests/unit/apps/cli/render-events.test.js
git commit -m "feat(v2): resume approvals from CLI runner"
```

---

### Task 8: TUI Minimal Approval Resume

**Files:**
- Modify: `src/tui.js`

- [ ] **Step 1: Update TUI helper behavior**

Modify `sendKernelPrompt()` in `src/tui.js` from:

```js
  const result = await kernel.agent.send(prompt, options);
  if (result.status === "awaiting_approval") {
    return `Approval required: ${result.approval?.id || "unknown"}\nV2-5 TUI only displays approval requests. Approval resume is not wired yet.`;
  }
  return result.content || "";
```

to:

```js
  let result = await kernel.agent.send(prompt, options);
  if (result.status === "awaiting_approval") {
    const answer = await promptLine(`Approval required ${result.approval?.id || "unknown"}. Approve? y/N`);
    const normalized = String(answer || "").trim().toLowerCase();
    const decision = normalized === "y" || normalized === "yes" || normalized === "approve" || normalized === "allow"
      ? "approve"
      : "deny";
    result = await kernel.agent.approve(result.approval.id, decision);
  }
  return result.content || "";
```

This uses existing TUI cooked-input helpers. Do not redesign the TUI layout in V2-7.

- [ ] **Step 2: Run syntax check for TUI**

Run:

```powershell
node --check src/tui.js
```

Expected: PASS.

- [ ] **Step 3: Commit Task 8**

```powershell
git add src/tui.js
git commit -m "feat(v2): resume approvals from TUI"
```

---

### Task 9: Regression, Session Events, and Package Check

**Files:**
- Modify: `package.json`
- Test: `tests/integration/v2-approval-resume.test.js`

- [ ] **Step 1: Add session timeline assertion to approval integration**

Append to `tests/integration/v2-approval-resume.test.js`:

```js
test("approval resume timeline persists requested resolved tool and final events", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-approval-timeline-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  let invokeCount = 0;
  const kernel = await createKernel(root, {
    sessionRoot: path.join(root, ".sessions"),
    sessionId: "sess_approval_timeline",
    modelGateway: {
      invoke: async () => {
        invokeCount += 1;
        if (invokeCount === 1) {
          return { content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: DIFF, prompt: "update a" } }] };
        }
        return { content: "updated", tool_calls: [] };
      },
      reply: async () => ({ content: "fast" })
    }
  });

  const paused = await kernel.agent.send("modify a.txt", { autonomy: "supervised" });
  await kernel.agent.approve(paused.approval.id, "approve");
  await kernel.session.flush();
  const timeline = await kernel.session.getTimeline(50);
  const types = timeline.map((event) => event.type);

  assert.ok(types.includes("approval:requested"));
  assert.ok(types.includes("approval:resolved"));
  assert.ok(types.includes("tool:result"));
  assert.ok(types.includes("agent:final"));
});
```

- [ ] **Step 2: Add new approval module to check script**

In `package.json`, add:

```text
src/core/approval/paused-turn-store.js
```

to the `node --check` segment that checks core files.

- [ ] **Step 3: Run targeted V2-7 tests**

Run:

```powershell
npm.cmd test -- tests/unit/core/approval/paused-turn-store.test.js tests/unit/core/execution/executor-loop.test.js tests/unit/core/agent-runtime.test.js tests/integration/v2-approval-resume.test.js tests/unit/apps/cli/kernel-runner.test.js tests/unit/gui/kernel-host.test.js
```

Expected: PASS.

- [ ] **Step 4: Verify no repository V2 session pollution**

Run:

```powershell
if (Test-Path -LiteralPath ".deepseek-code\v2") { throw ".deepseek-code/v2 should not be created by tests" } else { "no v2 session pollution" }
```

Expected: prints `no v2 session pollution`.

- [ ] **Step 5: Run full regression**

Run:

```powershell
npm.cmd test
```

Expected: exits 0 with `fail 0`.

- [ ] **Step 6: Run syntax check**

Run:

```powershell
npm.cmd run check
```

Expected: exits 0.

- [ ] **Step 7: Run whitespace check**

Run:

```powershell
git diff --check
```

Expected: exits 0. Existing unrelated CRLF warnings may still appear for user-local files.

- [ ] **Step 8: Commit Task 9**

```powershell
git add package.json tests/integration/v2-approval-resume.test.js
git commit -m "chore(v2): include approval resume checks"
```

---

## Final Acceptance Criteria

V2-7 is complete when:

- Supervised edit pauses before writing.
- Approving resumes the same turn and writes through ToolExecutor.
- Denying cancels without writing.
- Duplicate approval returns `APPROVAL_NOT_FOUND`.
- New `send()` while paused returns `AWAITING_APPROVAL`.
- Interrupt clears paused approvals.
- GUI host awaits approval result.
- CLI runner can approve in-process.
- TUI can approve or deny with a minimal prompt.
- Session timeline includes `approval:requested`, `approval:resolved`, `tool:result`, and `agent:final`.
- `npm.cmd test`, `npm.cmd run check`, and `git diff --check` pass.
- Running tests does not create `.deepseek-code/v2` in the repository root.

## Implementation Notes

- Do not delete V0/V1 legacy files.
- Do not introduce dependencies.
- Do not bypass ToolExecutor after approval.
- Use `approvalCache.grant()` instead of special-casing permission allow inside executor.
- Keep approval resume in memory only.
- Use `npm.cmd` on Windows PowerShell.
- Do not stage unrelated local files:
  - `.claude/settings.local.json`
  - `.deepseek-code/config.json`
  - `.deepseek-code/chat.json`
  - `.tmp-memory-test/`
  - `docs/plans/roadmap/2026-05-30-phase-4-gui.md`
  - `docs/plans/roadmap/2026-05-30-phase-5-polish.md`
  - `gui/node_modules/`
  - `gui/package-lock.json`
