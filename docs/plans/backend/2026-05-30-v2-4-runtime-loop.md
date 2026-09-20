# V2-4 Runtime Loop Implementation Plan

> 完成状态以 [CHANGELOG](../../CHANGELOG.md) 为准。


**Goal:** Upgrade `kernel.agent.send()` from a single model reply into a real multi-round DeepSeek tool loop that can plan, execute tools, feed tool results back to the model, stop for approvals, verify edits, and produce final responses.

**Architecture:** V2-4 adds small execution and verification modules under `src/core` and wires them into `src/core/runtime/agent-runtime.js` through dependency injection. Runtime remains the coordinator; tools still execute only through `ToolExecutor`, edit writes still go through `EditService`, and DeepSeek-specific request formatting remains in `src/deepseek`. Query tasks keep the existing fast reply path while edit/general/diagnostic tasks use the new executor loop.

**Tech Stack:** Node.js >= 20, ESM, Node built-ins only, `node:test`, `node:assert/strict`, no new dependencies.

---

## Scope Boundary

Implement V2-4 from `docs/specs/architecture/2026-05-30-deepseek-code-v2-clean-runtime-design.md`:

- Add a real model/tool execution loop for non-query turns.
- Convert DeepSeek normalized tool calls into V2 `ToolCall` protocol records.
- Convert V2 `ToolResult` objects into model feedback messages.
- Route all tool execution through the existing `ToolExecutor`.
- Stop cleanly on `approval_required` and return an awaiting approval result.
- Add max-iteration protection.
- Add a lightweight verifier after successful edit tools.
- Keep query turns compatible with existing `modelGateway.reply()`.

Out of scope for V2-4:

- Persisting resumable pending approvals. Runtime may return awaiting approval, but V2-5/V2-6 can implement full resume.
- Full automatic repair of failed tests. V2-4 reports verification failure clearly and provides repair decision metadata.
- CLI/TUI/GUI migration.
- Replacing legacy V0 CLI paths.
- New dependencies or external services.

## Design Decisions

- **Dependency injection over imports:** Runtime receives `toolSchemas`, `executeTool`, and `createPolicyContext` callbacks from `src/index.js`. `src/core/runtime` must not import `src/tools`.
- **Query fast path stays simple:** Query tasks still use `modelGateway.reply()` so plain chat does not become brittle.
- **Non-query path uses `modelGateway.invoke()` first:** The loop sends assembled messages plus DeepSeek tool schemas. Mock gateways in tests can return `{ content, tool_calls }`.
- **Tool loop max is 5 by default:** Any more is treated as terminal failure with a clear `agent:error`.
- **Approval stops the turn:** A tool result with `status: "approval_required"` sets the returned turn to `awaiting_approval`, publishes state, releases the active runtime lock, and returns `{ status: "awaiting_approval" }`. Full approval resume remains out of scope for V2-4.
- **Verifier is lightweight:** If an edit-like tool succeeds, run `test` in detect-only mode by default. This confirms test command detection without surprising users by executing arbitrary suites. Full execution policies can be added later.
- **No raw reasoning exposure:** Runtime does not publish `reasoning_content` to session events.

## File Structure

Create:

```text
src/core/execution/tool-call-adapter.js
src/core/execution/tool-result-router.js
src/core/execution/executor-loop.js
src/core/verification/verifier.js
src/core/verification/repair-decision.js
tests/unit/core/execution/tool-call-adapter.test.js
tests/unit/core/execution/tool-result-router.test.js
tests/unit/core/execution/executor-loop.test.js
tests/unit/core/verification/verifier.test.js
tests/integration/v2-runtime-loop.test.js
```

Modify:

```text
src/core/runtime/agent-runtime.js
src/index.js
package.json
```

Responsibility map:

- `tool-call-adapter.js`: validate and normalize DeepSeek tool call payloads into `createToolCall()` input.
- `tool-result-router.js`: build compact `role:"tool"` messages for model feedback without leaking oversized metadata.
- `executor-loop.js`: coordinate model invoke, tool execution, approval stops, max iterations, and final content.
- `verifier.js`: detect edit activity and optionally run the `test` tool in detect-only mode.
- `repair-decision.js`: classify whether verification/tool failures should stop or request repair.
- `agent-runtime.js`: lifecycle, interruption, and delegation to query fast path or executor loop.
- `src/index.js`: inject tool schemas and tool execution callbacks into runtime.

---

### Task 1: Tool Call Adapter

**Files:**
- Create: `src/core/execution/tool-call-adapter.js`
- Test: `tests/unit/core/execution/tool-call-adapter.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/unit/core/execution/tool-call-adapter.test.js
import test from "node:test";
import assert from "node:assert/strict";
import {
  adaptDeepSeekToolCall,
  adaptDeepSeekToolCalls
} from "../../../../src/core/execution/tool-call-adapter.js";

test("adaptDeepSeekToolCall converts normalized DeepSeek call to V2 ToolCall", () => {
  const call = adaptDeepSeekToolCall({
    id: "call_read",
    name: "read",
    arguments: { path: "README.md" }
  }, { requestedByStepId: "step_1" });

  assert.equal(call.id, "call_read");
  assert.equal(call.name, "read");
  assert.deepEqual(call.params, { path: "README.md" });
  assert.equal(call.source, "model");
  assert.equal(call.requested_by_step_id, "step_1");
});

test("adaptDeepSeekToolCall rejects missing name and malformed arguments", () => {
  assert.throws(
    () => adaptDeepSeekToolCall({ id: "c1", arguments: {} }, { requestedByStepId: "s1" }),
    /tool call name is required/
  );
  assert.throws(
    () => adaptDeepSeekToolCall({ id: "c2", name: "read", arguments: null, arguments_parse_error: "bad json" }, { requestedByStepId: "s1" }),
    /invalid tool arguments/
  );
});

test("adaptDeepSeekToolCalls maps a list and preserves order", () => {
  const calls = adaptDeepSeekToolCalls([
    { id: "c1", name: "read", arguments: { path: "a.txt" } },
    { id: "c2", name: "grep", arguments: { pattern: "x" } }
  ], { requestedByStepId: "step_1" });

  assert.deepEqual(calls.map((call) => call.name), ["read", "grep"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm.cmd test -- tests/unit/core/execution/tool-call-adapter.test.js
```

Expected:

```text
ERR_MODULE_NOT_FOUND
```

- [ ] **Step 3: Implement `src/core/execution/tool-call-adapter.js`**

```js
// src/core/execution/tool-call-adapter.js
import { createToolCall } from "../protocol/index.js";

export function adaptDeepSeekToolCall(rawCall, { requestedByStepId } = {}) {
  if (!requestedByStepId) throw new Error("requestedByStepId is required");
  if (!rawCall?.name) throw new Error("tool call name is required");
  if (rawCall.arguments_parse_error) {
    throw new Error(`invalid tool arguments for ${rawCall.name}: ${rawCall.arguments_parse_error}`);
  }
  if (rawCall.arguments === null || Array.isArray(rawCall.arguments) || typeof rawCall.arguments !== "object") {
    throw new Error(`invalid tool arguments for ${rawCall.name}`);
  }
  return createToolCall({
    id: rawCall.id,
    name: rawCall.name,
    params: rawCall.arguments || {},
    source: "model",
    requestedByStepId
  });
}

export function adaptDeepSeekToolCalls(rawCalls = [], options = {}) {
  return rawCalls.map((call) => adaptDeepSeekToolCall(call, options));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
npm.cmd test -- tests/unit/core/execution/tool-call-adapter.test.js
```

Expected:

```text
# fail 0
```

- [ ] **Step 5: Commit**

```powershell
git add src/core/execution/tool-call-adapter.js tests/unit/core/execution/tool-call-adapter.test.js
git commit -m "feat(v2): add runtime tool call adapter"
```

---

### Task 2: Tool Result Router

**Files:**
- Create: `src/core/execution/tool-result-router.js`
- Test: `tests/unit/core/execution/tool-result-router.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/unit/core/execution/tool-result-router.test.js
import test from "node:test";
import assert from "node:assert/strict";
import {
  toolResultToMessage,
  toolResultsToMessages,
  summarizeToolResult
} from "../../../../src/core/execution/tool-result-router.js";

test("toolResultToMessage creates DeepSeek-compatible tool feedback", () => {
  const message = toolResultToMessage({
    call_id: "call_1",
    status: "success",
    content: [{ type: "text", text: "hello" }],
    metadata: { path: "README.md" }
  });

  assert.equal(message.role, "tool");
  assert.equal(message.tool_call_id, "call_1");
  assert.match(message.content, /"status":"success"/);
  assert.match(message.content, /hello/);
});

test("summarizeToolResult truncates long content and keeps metadata compact", () => {
  const summary = summarizeToolResult({
    call_id: "call_1",
    status: "success",
    content: [{ type: "text", text: "x".repeat(4000) }],
    metadata: { change_id: "c1", large: "y".repeat(4000) }
  }, { maxContentChars: 100, maxMetadataChars: 80 });

  assert.equal(summary.text.length, 100);
  assert.equal(summary.truncated, true);
  assert.equal(summary.metadata.large, undefined);
  assert.equal(summary.metadata.change_id, "c1");
});

test("toolResultsToMessages maps all results", () => {
  const messages = toolResultsToMessages([
    { call_id: "a", status: "success", content: [{ type: "text", text: "A" }] },
    { call_id: "b", status: "error", content: [{ type: "error", text: "B" }] }
  ]);

  assert.deepEqual(messages.map((message) => message.tool_call_id), ["a", "b"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm.cmd test -- tests/unit/core/execution/tool-result-router.test.js
```

Expected:

```text
ERR_MODULE_NOT_FOUND
```

- [ ] **Step 3: Implement `src/core/execution/tool-result-router.js`**

```js
// src/core/execution/tool-result-router.js
const SAFE_METADATA_KEYS = new Set([
  "path",
  "bytes",
  "argv",
  "exit_code",
  "signal",
  "change_id",
  "approval_id",
  "summary",
  "files",
  "diff_hash",
  "diff_size",
  "permission",
  "approval"
]);

export function toolResultToMessage(result, options = {}) {
  const summary = summarizeToolResult(result, options);
  return {
    role: "tool",
    tool_call_id: result.call_id,
    content: JSON.stringify({
      status: result.status,
      text: summary.text,
      metadata: summary.metadata,
      truncated: summary.truncated
    })
  };
}

export function toolResultsToMessages(results = [], options = {}) {
  return results.map((result) => toolResultToMessage(result, options));
}

export function summarizeToolResult(result, { maxContentChars = 2000, maxMetadataChars = 1200 } = {}) {
  const text = (result.content || []).map((item) => item.text || "").join("\n").slice(0, maxContentChars);
  const originalText = (result.content || []).map((item) => item.text || "").join("\n");
  const metadata = compactMetadata(result.metadata || {}, maxMetadataChars);
  return {
    text,
    metadata,
    truncated: originalText.length > maxContentChars
  };
}

function compactMetadata(metadata, maxChars) {
  const result = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!SAFE_METADATA_KEYS.has(key)) continue;
    const encoded = JSON.stringify(value);
    if (encoded && encoded.length <= maxChars) result[key] = value;
  }
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
npm.cmd test -- tests/unit/core/execution/tool-result-router.test.js
```

Expected:

```text
# fail 0
```

- [ ] **Step 5: Commit**

```powershell
git add src/core/execution/tool-result-router.js tests/unit/core/execution/tool-result-router.test.js
git commit -m "feat(v2): add tool result router"
```

---

### Task 3: Executor Loop

**Files:**
- Create: `src/core/execution/executor-loop.js`
- Test: `tests/unit/core/execution/executor-loop.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/unit/core/execution/executor-loop.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { createEventBus } from "../../../../src/shared/event-bus.js";
import { runExecutorLoop } from "../../../../src/core/execution/executor-loop.js";

test("executor loop executes tool calls and feeds results back to model", async () => {
  const calls = [];
  const executed = [];
  const modelGateway = {
    invoke: async (messages, options) => {
      calls.push({ messages, options });
      if (calls.length === 1) {
        return {
          content: "",
          tool_calls: [{ id: "call_read", name: "read", arguments: { path: "README.md" } }]
        };
      }
      return { content: "Read result handled", tool_calls: [] };
    }
  };

  const result = await runExecutorLoop({
    message: "read README",
    classification: { task_type: "diagnostic" },
    turnId: "turn_1",
    modelGateway,
    toolSchemas: [{ type: "function", function: { name: "read" } }],
    executeTool: async (toolCall) => {
      executed.push(toolCall);
      return { call_id: toolCall.id, status: "success", content: [{ type: "text", text: "README content" }], metadata: { path: "README.md" } };
    },
    createPolicyContext: () => ({ autonomy: "gated" })
  });

  assert.equal(result.status, "complete");
  assert.equal(result.content, "Read result handled");
  assert.equal(executed[0].name, "read");
  assert.equal(calls.length, 2);
  assert.ok(calls[1].messages.some((entry) => entry.role === "tool"));
});

test("executor loop stops on approval_required", async () => {
  const result = await runExecutorLoop({
    message: "edit file",
    classification: { task_type: "edit" },
    turnId: "turn_1",
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
      metadata: { approval: { id: "approval_1" } }
    }),
    createPolicyContext: () => ({ autonomy: "supervised" })
  });

  assert.equal(result.status, "awaiting_approval");
  assert.equal(result.approval.id, "approval_1");
});

test("executor loop enforces max iterations", async () => {
  await assert.rejects(
    () => runExecutorLoop({
      message: "loop",
      classification: { task_type: "general" },
      turnId: "turn_1",
      maxIterations: 2,
      modelGateway: {
        invoke: async () => ({
          content: "",
          tool_calls: [{ id: `call_${Date.now()}`, name: "read", arguments: { path: "README.md" } }]
        })
      },
      toolSchemas: [],
      executeTool: async (toolCall) => ({ call_id: toolCall.id, status: "success", content: [{ type: "text", text: "ok" }] }),
      createPolicyContext: () => ({ autonomy: "gated" })
    }),
    /maximum tool iterations exceeded/
  );
});

test("executor loop reports malformed tool arguments", async () => {
  await assert.rejects(
    () => runExecutorLoop({
      message: "bad tool",
      classification: { task_type: "general" },
      turnId: "turn_1",
      modelGateway: {
        invoke: async () => ({
          content: "",
          tool_calls: [{ id: "bad", name: "read", arguments: null, arguments_parse_error: "Unexpected token" }]
        })
      },
      toolSchemas: [],
      executeTool: async () => { throw new Error("should not execute"); },
      createPolicyContext: () => ({ autonomy: "gated" })
    }),
    /invalid tool arguments/
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm.cmd test -- tests/unit/core/execution/executor-loop.test.js
```

Expected:

```text
ERR_MODULE_NOT_FOUND
```

- [ ] **Step 3: Implement `src/core/execution/executor-loop.js`**

```js
// src/core/execution/executor-loop.js
import { assembleReplyMessages } from "../../deepseek/prompt-assembler.js";
import { adaptDeepSeekToolCalls } from "./tool-call-adapter.js";
import { toolResultsToMessages } from "./tool-result-router.js";

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
  options = {}
} = {}) {
  if (!modelGateway || typeof modelGateway.invoke !== "function") {
    throw new Error("modelGateway.invoke is required for executor loop");
  }
  if (typeof executeTool !== "function") throw new Error("executeTool is required");
  if (typeof createPolicyContext !== "function") throw new Error("createPolicyContext is required");

  let messages = assembleReplyMessages({
    message,
    classification,
    context,
    systemAddendum: "Use tools when needed. When tool results are sufficient, answer normally."
  });
  const toolResults = [];

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    eventBus?.publish?.("model:request", { turn_id: turnId, purpose: "act", iteration });
    const modelResult = await modelGateway.invoke(messages, {
      purpose: iteration === 0 ? "plan" : "act",
      tools: toolSchemas,
      toolChoice: "auto",
      signal,
      ...options
    });
    eventBus?.publish?.("model:response", {
      turn_id: turnId,
      purpose: iteration === 0 ? "plan" : "act",
      iteration,
      content: modelResult.content || "",
      tool_call_count: modelResult.tool_calls?.length || 0,
      usage: modelResult.usage || null,
      model: modelResult.model,
      channel: modelResult.channel
    });

    const rawToolCalls = modelResult.tool_calls || [];
    if (!rawToolCalls.length) {
      return {
        status: "complete",
        content: modelResult.content || "",
        iterations: iteration + 1,
        toolResults
      };
    }

    const toolCalls = adaptDeepSeekToolCalls(rawToolCalls, { requestedByStepId: `model:${turnId}:${iteration}` });
    const iterationResults = [];
    for (const toolCall of toolCalls) {
      const policyContext = createPolicyContext({ turnId, toolCall });
      const result = await executeTool(toolCall, policyContext);
      iterationResults.push(result);
      toolResults.push(result);
      if (result.status === "approval_required") {
        return {
          status: "awaiting_approval",
          content: result.content?.[0]?.text || "Approval required",
          approval: result.metadata?.approval || null,
          toolResults,
          iterations: iteration + 1
        };
      }
    }

    messages = [
      ...messages,
      assistantToolCallMessage(modelResult, rawToolCalls),
      ...toolResultsToMessages(iterationResults)
    ];
  }

  throw new Error(`maximum tool iterations exceeded: ${maxIterations}`);
}

function assistantToolCallMessage(modelResult, rawToolCalls) {
  return {
    role: "assistant",
    content: modelResult.content || "",
    tool_calls: rawToolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: {
        name: call.name,
        arguments: call.raw_arguments || JSON.stringify(call.arguments || {})
      }
    }))
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
npm.cmd test -- tests/unit/core/execution/executor-loop.test.js
```

Expected:

```text
# fail 0
```

- [ ] **Step 5: Commit**

```powershell
git add src/core/execution/executor-loop.js tests/unit/core/execution/executor-loop.test.js
git commit -m "feat(v2): add runtime executor loop"
```

---

### Task 4: Lightweight Verifier and Repair Decision

**Files:**
- Create: `src/core/verification/verifier.js`
- Create: `src/core/verification/repair-decision.js`
- Test: `tests/unit/core/verification/verifier.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/unit/core/verification/verifier.test.js
import test from "node:test";
import assert from "node:assert/strict";
import {
  shouldVerifyToolResults,
  runVerifier
} from "../../../../src/core/verification/verifier.js";
import { decideRepair } from "../../../../src/core/verification/repair-decision.js";

test("shouldVerifyToolResults detects successful edit-like tools", () => {
  assert.equal(shouldVerifyToolResults([
    { status: "success", metadata: { change_id: "c1" } }
  ]), true);
  assert.equal(shouldVerifyToolResults([
    { status: "success", metadata: { path: "README.md" } }
  ]), false);
});

test("runVerifier executes detect-only test tool when edits occurred", async () => {
  const calls = [];
  const result = await runVerifier({
    turnId: "turn_1",
    toolResults: [{ status: "success", metadata: { change_id: "c1" } }],
    executeTool: async (toolCall) => {
      calls.push(toolCall);
      return { call_id: toolCall.id, status: "success", content: [{ type: "text", text: "Detected: npm test" }], metadata: { argv: ["npm", "test"] } };
    },
    createPolicyContext: () => ({ autonomy: "gated" })
  });

  assert.equal(result.status, "passed");
  assert.equal(calls[0].name, "test");
  assert.deepEqual(calls[0].params, { detect: true });
});

test("runVerifier skips when there are no edit results", async () => {
  const result = await runVerifier({
    turnId: "turn_1",
    toolResults: [],
    executeTool: async () => { throw new Error("should not run"); },
    createPolicyContext: () => ({})
  });

  assert.equal(result.status, "skipped");
});

test("decideRepair asks for repair on failed verification and stops on approval", () => {
  assert.equal(decideRepair({ status: "failed" }).decision, "repair");
  assert.equal(decideRepair({ status: "approval_required" }).decision, "stop");
  assert.equal(decideRepair({ status: "passed" }).decision, "none");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm.cmd test -- tests/unit/core/verification/verifier.test.js
```

Expected:

```text
ERR_MODULE_NOT_FOUND
```

- [ ] **Step 3: Implement verifier modules**

```js
// src/core/verification/verifier.js
import { createToolCall } from "../protocol/index.js";

export function shouldVerifyToolResults(toolResults = []) {
  return toolResults.some((result) => result.status === "success" && result.metadata?.change_id);
}

export async function runVerifier({
  turnId,
  toolResults = [],
  executeTool,
  createPolicyContext,
  eventBus = null
} = {}) {
  if (!shouldVerifyToolResults(toolResults)) {
    const skipped = { status: "skipped", reason: "no edit results" };
    eventBus?.publish?.("verification:result", { turn_id: turnId, result: skipped });
    return skipped;
  }
  const call = createToolCall({
    name: "test",
    params: { detect: true },
    source: "runtime",
    requestedByStepId: `verify:${turnId}`
  });
  const result = await executeTool(call, createPolicyContext({ turnId, toolCall: call, phase: "verify" }));
  const verification = {
    status: result.status === "success" ? "passed" : result.status,
    tool_result: result,
    reason: result.content?.[0]?.text || ""
  };
  eventBus?.publish?.("verification:result", { turn_id: turnId, result: verification });
  return verification;
}
```

```js
// src/core/verification/repair-decision.js
export function decideRepair(verification) {
  if (!verification || verification.status === "skipped" || verification.status === "passed") {
    return { decision: "none", reason: "verification did not require repair" };
  }
  if (verification.status === "approval_required") {
    return { decision: "stop", reason: "verification requires approval" };
  }
  if (verification.status === "failed" || verification.status === "error") {
    return { decision: "repair", reason: "verification failed" };
  }
  return { decision: "stop", reason: `unhandled verification status: ${verification.status}` };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
npm.cmd test -- tests/unit/core/verification/verifier.test.js
```

Expected:

```text
# fail 0
```

- [ ] **Step 5: Commit**

```powershell
git add src/core/verification/verifier.js src/core/verification/repair-decision.js tests/unit/core/verification/verifier.test.js
git commit -m "feat(v2): add lightweight verifier"
```

---

### Task 5: Wire Runtime Loop Into Agent Runtime

**Files:**
- Modify: `src/core/runtime/agent-runtime.js`
- Modify: `src/index.js`
- Test: `tests/integration/v2-runtime-loop.test.js`
- Test: `tests/unit/core/agent-runtime.test.js`

- [ ] **Step 1: Write the failing integration test**

```js
// tests/integration/v2-runtime-loop.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createKernel } from "../../src/index.js";

test("runtime loop executes read tool and feeds result back to model", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-loop-"));
  await writeFile(path.join(root, "README.md"), "hello runtime loop");
  let invokeCount = 0;
  const kernel = await createKernel(root, {
    sessionId: "sess_loop_read",
    modelGateway: {
      invoke: async (messages) => {
        invokeCount++;
        if (invokeCount === 1) {
          return { content: "", tool_calls: [{ id: "call_read", name: "read", arguments: { path: "README.md" } }] };
        }
        assert.ok(messages.some((message) => message.role === "tool" && message.content.includes("hello runtime loop")));
        return { content: "README says hello runtime loop", tool_calls: [] };
      },
      reply: async () => ({ content: "query fast path" })
    }
  });

  const result = await kernel.agent.send("inspect README", { autonomy: "gated" });

  assert.equal(result.status, "complete");
  assert.equal(result.content, "README says hello runtime loop");
  assert.equal(invokeCount, 2);
});

test("runtime loop executes edit tool and verifier after edit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-loop-edit-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  let invokeCount = 0;
  const diff = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new";
  const events = [];
  const kernel = await createKernel(root, {
    sessionId: "sess_loop_edit",
    modelGateway: {
      invoke: async () => {
        invokeCount++;
        if (invokeCount === 1) {
          return { content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff, prompt: "update a" } }] };
        }
        return { content: "updated a.txt", tool_calls: [] };
      },
      reply: async () => ({ content: "query fast path" })
    }
  });
  const sub = kernel.session.subscribe((event) => events.push(event));

  const result = await kernel.agent.send("modify a.txt", { autonomy: "gated" });
  sub.unsubscribe();

  assert.equal(result.status, "complete");
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "new\n");
  assert.ok(events.some((event) => event.type === "file:diff_applied"));
  assert.ok(events.some((event) => event.type === "verification:result"));
});

test("runtime loop stops for approval and does not write", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-loop-approval-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  const diff = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new";
  const kernel = await createKernel(root, {
    sessionId: "sess_loop_approval",
    modelGateway: {
      invoke: async () => ({ content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff } }] }),
      reply: async () => ({ content: "query fast path" })
    }
  });

  const result = await kernel.agent.send("modify a.txt", { autonomy: "supervised" });

  assert.equal(result.status, "awaiting_approval");
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "old\n");
});
```

- [ ] **Step 2: Add a unit test for query fast path compatibility**

Append to `tests/unit/core/agent-runtime.test.js`:

```js
test("agent runtime keeps query tasks on reply fast path", async () => {
  let invokeCalled = false;
  const runtime = createAgentRuntime({
    sessionId: "sess_query_fast",
    modelGateway: {
      reply: async () => ({ content: "fast reply" }),
      invoke: async () => {
        invokeCalled = true;
        return { content: "slow path" };
      }
    },
    toolSchemas: () => [],
    executeTool: async () => { throw new Error("query should not execute tools"); },
    createPolicyContext: () => ({ autonomy: "gated" })
  });

  const result = await runtime.send("what is this?");

  assert.equal(result.content, "fast reply");
  assert.equal(invokeCalled, false);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```powershell
npm.cmd test -- tests/integration/v2-runtime-loop.test.js tests/unit/core/agent-runtime.test.js
```

Expected:

```text
The runtime loop integration tests fail because agent-runtime still calls reply for every task.
```

- [ ] **Step 4: Modify `src/core/runtime/agent-runtime.js`**

Replace the file with:

```js
// src/core/runtime/agent-runtime.js
import { createAgentTurn, addTurnStep, setTurnStatus } from "../protocol/agent-turn.js";
import { createAgentStep, completeAgentStep } from "../protocol/agent-step.js";
import { classifyMessage } from "../planning/classifier.js";
import { runExecutorLoop } from "../execution/executor-loop.js";
import { runVerifier } from "../verification/verifier.js";
import { decideRepair } from "../verification/repair-decision.js";
import { createLifecycleState, transitionLifecycle } from "./lifecycle.js";

function publish(eventBus, eventType, data) {
  if (eventBus && typeof eventBus.publish === "function") eventBus.publish(eventType, data);
}

class InterruptedError extends Error {
  constructor(reason = "turn was interrupted") {
    super(reason);
    this.name = "InterruptedError";
    this.code = "INTERRUPTED";
  }
}

export function createAgentRuntime({
  eventBus = null,
  sessionId = `sess_${Date.now()}`,
  modelGateway = null,
  toolSchemas = () => [],
  executeTool = null,
  createPolicyContext = () => ({}),
  maxToolIterations = 5
} = {}) {
  let lifecycle = createLifecycleState();
  let currentTurnId = null;
  let currentAbortController = null;
  let turnGeneration = 0;

  function getState() { return { ...lifecycle }; }
  function assertNotInterrupted(generation) { if (turnGeneration !== generation) throw new InterruptedError(); }

  async function send(message, options = {}) {
    if (currentTurnId) { const err = new Error("another turn is in progress"); err.code = "BUSY"; throw err; }
    const generation = ++turnGeneration;
    currentAbortController = new AbortController();
    let turn = createAgentTurn({ sessionId, userMessage: message, autonomy: options.autonomy || "gated" });
    currentTurnId = turn.id;
    publish(eventBus, "user:message", { turn_id: turn.id, content: message, options });
    publish(eventBus, "agent:turn_started", { turn });
    try {
      lifecycle = transitionLifecycle(lifecycle, { to: "classify", reason: "user message received", channel: "think" });
      assertNotInterrupted(generation);
      const classifyStep = createAgentStep({ turnId: turn.id, type: "classify", channel: "think" });
      const classification = classifyMessage(message, options);
      const completedClassifyStep = completeAgentStep(classifyStep, { outputRef: `classification:${classification.task_type}` });
      turn = addTurnStep(turn, completedClassifyStep);
      publish(eventBus, "agent:step", { turn_id: turn.id, step: completedClassifyStep, classification });
      assertNotInterrupted(generation);

      let response;
      if (classification.task_type === "query" || !modelGateway?.invoke || !executeTool) {
        response = await runReplyFastPath({ message, classification, turn, options, signal: currentAbortController.signal });
      } else {
        response = await runToolLoopPath({ message, classification, turn, options, signal: currentAbortController.signal });
      }
      assertNotInterrupted(generation);

      if (response.status === "awaiting_approval") {
        lifecycle = transitionLifecycle(lifecycle, { to: "awaiting_approval", reason: "tool approval required", channel: "system" });
        turn = setTurnStatus(turn, "awaiting_approval");
        currentTurnId = null;
        currentAbortController = null;
        return { status: "awaiting_approval", state: "awaiting_approval", content: response.content, approval: response.approval, turn };
      }

      turn = setTurnStatus(turn, "completed");
      publish(eventBus, "agent:final", { turn_id: turn.id, content: response.content, status: "complete" });
      lifecycle = transitionLifecycle(lifecycle, { to: "idle", reason: "turn complete", channel: null });
      currentTurnId = null;
      currentAbortController = null;
      return { status: "complete", state: "idle", content: response.content, turn, verification: response.verification || null };
    } catch (error) {
      if (currentTurnId !== turn.id) throw error;
      if (error instanceof InterruptedError || error.name === "AbortError") {
        currentTurnId = null;
        currentAbortController = null;
        lifecycle = transitionLifecycle(lifecycle, { to: "idle", reason: error.message, channel: null });
        throw error instanceof InterruptedError ? error : new InterruptedError(error.message);
      }
      lifecycle = transitionLifecycle(lifecycle, { to: "failed", reason: error.message, channel: lifecycle.channel });
      publish(eventBus, "agent:error", { turn_id: turn.id, message: error.message });
      currentTurnId = null;
      currentAbortController = null;
      throw error;
    }
  }

  async function runReplyFastPath({ message, classification, turn, options, signal }) {
    lifecycle = transitionLifecycle(lifecycle, { to: "complete", reason: "reply fast path", channel: "system" });
    const finalStep = completeAgentStep(createAgentStep({ turnId: turn.id, type: "final", channel: "system" }));
    const updatedTurn = addTurnStep(turn, finalStep);
    const response = modelGateway && typeof modelGateway.reply === "function"
      ? await modelGateway.reply({ message, classification, turn, options, signal })
      : { content: `V2-0 mock ${classification.task_type} response` };
    return { status: "complete", content: response.content, turn: updatedTurn };
  }

  async function runToolLoopPath({ message, classification, turn, options, signal }) {
    lifecycle = transitionLifecycle(lifecycle, { to: "execute", reason: "tool loop started", channel: "act" });
    const loop = await runExecutorLoop({
      message,
      classification,
      turnId: turn.id,
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
      options
    });
    if (loop.status === "awaiting_approval") return loop;

    lifecycle = transitionLifecycle(lifecycle, { to: "verify", reason: "tool loop complete", channel: "system" });
    const verification = await runVerifier({
      turnId: turn.id,
      toolResults: loop.toolResults,
      executeTool,
      createPolicyContext: ({ turnId, toolCall, phase }) => createPolicyContext({
        ...options,
        autonomy: options.autonomy || turn.autonomy,
        turnId,
        toolCall,
        phase
      }),
      eventBus
    });
    const repair = decideRepair(verification);
    if (repair.decision === "repair") {
      lifecycle = transitionLifecycle(lifecycle, { to: "failed", reason: repair.reason, channel: "system" });
      throw new Error(`verification failed: ${verification.reason}`);
    }
    return { ...loop, verification };
  }

  function approve(approvalId, decision) { publish(eventBus, "approval:resolved", { approval_id: approvalId, decision }); }

  function interrupt(turnId = null) {
    turnGeneration += 1;
    if (currentAbortController) currentAbortController.abort();
    currentTurnId = null;
    currentAbortController = null;
    lifecycle = transitionLifecycle(lifecycle, { to: "idle", reason: turnId ? `turn interrupted: ${turnId}` : "interrupt requested", channel: null });
  }

  return { send, approve, interrupt, getState };
}
```

- [ ] **Step 5: Modify `src/index.js`**

Pass tool loop callbacks into runtime. Replace the runtime construction with this block after `toolExecutor` is created:

```js
  const runtime = createAgentRuntime({
    eventBus,
    sessionId,
    modelGateway,
    toolSchemas: () => toolRegistry.toDeepSeekTools(),
    executeTool: (toolCall, policyContext) => toolExecutor.execute(toolCall, policyContext),
    createPolicyContext: (executionOptions = {}) => createPolicyContext({
      autonomy: executionOptions.autonomy || "gated",
      projectId: executionOptions.projectId || sessionId,
      projectRoot: root,
      trustStore: options.trustStore || { rules: [] },
      projectRules: options.projectRules || [],
      approvalCache,
      memoryRoot: options.memoryRoot || null,
      turnId: executionOptions.turnId
    })
  });
```

Keep `kernel.tools.execute()` unchanged except for sharing the same policy context shape.

- [ ] **Step 6: Run tests to verify they pass**

Run:

```powershell
npm.cmd test -- tests/integration/v2-runtime-loop.test.js tests/unit/core/agent-runtime.test.js tests/integration/v2-kernel-facade.test.js tests/integration/v2-deepseek-gateway-runtime.test.js
```

Expected:

```text
# fail 0
```

- [ ] **Step 7: Commit**

```powershell
git add src/core/runtime/agent-runtime.js src/index.js tests/integration/v2-runtime-loop.test.js tests/unit/core/agent-runtime.test.js
git commit -m "feat(v2): wire runtime tool loop"
```

---

### Task 6: Package Check and Full Regression

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Update `package.json` check script**

Append these files to the V2 `node --check` chain:

```text
src/core/execution/tool-call-adapter.js src/core/execution/tool-result-router.js src/core/execution/executor-loop.js src/core/verification/verifier.js src/core/verification/repair-decision.js
```

Keep the command style as one continuous chain matching the current `package.json`.

- [ ] **Step 2: Run V2-4 targeted tests**

Run:

```powershell
npm.cmd test -- tests/unit/core/execution/tool-call-adapter.test.js tests/unit/core/execution/tool-result-router.test.js tests/unit/core/execution/executor-loop.test.js tests/unit/core/verification/verifier.test.js tests/integration/v2-runtime-loop.test.js
```

Expected:

```text
# fail 0
```

- [ ] **Step 3: Run full regression**

Run:

```powershell
npm.cmd test
```

Expected:

```text
# fail 0
```

The test count must be greater than 263 because V2-4 adds runtime loop tests.

- [ ] **Step 4: Run syntax check**

Run:

```powershell
npm.cmd run check
```

Expected:

```text
No SyntaxError output and exit code 0.
```

- [ ] **Step 5: Run whitespace check**

Run:

```powershell
git diff --check
```

Expected:

```text
Exit code 0.
```

- [ ] **Step 6: Commit**

```powershell
git add package.json
git commit -m "chore(v2): include runtime loop checks"
```

---

## Acceptance Criteria

V2-4 is complete only when all items are true:

- Query tasks still use the existing `modelGateway.reply()` fast path.
- Non-query tasks use `modelGateway.invoke()` with DeepSeek tool schemas.
- Model-returned tool calls are converted into V2 `ToolCall` records.
- Tool calls execute only through `ToolExecutor`.
- Tool results are fed back into the next model call as `role:"tool"` messages.
- `read` tool loop integration works with a mock model.
- `edit` tool loop integration can really modify a file through V2 `EditService`.
- Supervised edit requests stop at `approval_required` and do not write files.
- Malformed tool arguments fail clearly and do not execute tools.
- Runtime enforces a max iteration limit.
- Edit success triggers a `verification:result` event.
- Verification failure returns a clear terminal failure; full repair is deferred.
- `reasoning_content` is not published to session events.
- `npm.cmd test` passes.
- `npm.cmd run check` passes.
- `git diff --check` passes.

## Review Checklist

Before reporting completion:

- Inspect `src/core/runtime/agent-runtime.js` and confirm query tasks still use `reply()`.
- Inspect `src/core/runtime/agent-runtime.js` and confirm non-query tasks call `runExecutorLoop()`.
- Inspect `src/index.js` and confirm runtime receives `toolSchemas`, `executeTool`, and `createPolicyContext`.
- Inspect `src/core/execution/executor-loop.js` and confirm tools execute through the injected `executeTool` callback.
- Inspect event publishing and confirm no `reasoning_content` is included in `model:response`.
- Manually smoke-test a read loop:

```powershell
node --input-type=module -e "import { mkdtemp, writeFile } from 'node:fs/promises'; import { tmpdir } from 'node:os'; import path from 'node:path'; import { createKernel } from './src/index.js'; const root=await mkdtemp(path.join(tmpdir(),'dsc-loop-smoke-')); await writeFile(path.join(root,'README.md'),'hello loop'); let n=0; const k=await createKernel(root,{sessionId:'sess_smoke',modelGateway:{invoke:async(messages)=>{n++; return n===1 ? {content:'',tool_calls:[{id:'call_read',name:'read',arguments:{path:'README.md'}}]} : {content:'done '+messages.at(-1).content,tool_calls:[]};},reply:async()=>({content:'fast'})}}); const r=await k.agent.send('inspect README',{autonomy:'gated'}); console.log(JSON.stringify({status:r.status, content:r.content, invokes:n}));"
```

Expected output includes:

```text
"status":"complete"
"invokes":2
```

## Commit Order

Use this order:

1. `feat(v2): add runtime tool call adapter`
2. `feat(v2): add tool result router`
3. `feat(v2): add runtime executor loop`
4. `feat(v2): add lightweight verifier`
5. `feat(v2): wire runtime tool loop`
6. `chore(v2): include runtime loop checks`

## Handoff Notes

- Use `npm.cmd` on Windows PowerShell.
- Keep unrelated dirty files untouched.
- Do not implement CLI/TUI/GUI migration in this phase.
- Do not add dependencies.
- Do not bypass `ToolExecutor`.
- Do not expose DeepSeek `reasoning_content`.
- If the exact DeepSeek tool-call wire format differs in mocks, adapt at the gateway boundary, not in tool implementations.
