# V2-8 Verifier & Repair Loop Implementation Plan

> 完成状态以 [CHANGELOG](../../CHANGELOG.md) 为准。


**Goal:** Turn V2 verification from a terminal gate into a bounded DeepSeek repair loop that can verify edits, ask the repair channel for corrective tool calls, execute repairs through ToolExecutor, and verify again.

**Architecture:** Add a verification policy, repair prompt builder, repair executor, and repair loop under existing V2 runtime modules. Runtime integration extracts the duplicated verification block into `verifyAndMaybeRepair()` while preserving approval resume and the single ToolExecutor security path.

**Tech Stack:** Node.js >=20 ESM, built-in `node:test`, existing V2 DeepSeek gateway, executor-loop helpers, ToolExecutor, PermissionEngine, SessionManager, no new dependencies.

---

## File Structure

Create:

- `src/core/verification/verification-policy.js`
  Normalizes `verifyMode`, `testArgv`, autonomy, and edit-result state into verifier test parameters.
- `src/core/verification/repair-prompt.js`
  Builds compact DeepSeek repair messages without `reasoning_content` or large raw output.
- `src/core/execution/repair-executor.js`
  Executes one repair model/tool pass through `modelGateway.invoke()`, `adaptDeepSeekToolCalls()`, and injected `executeTool()`.
- `src/core/verification/repair-loop.js`
  Owns bounded repair attempts, repair events, verifier re-runs, approval stop, and exhausted failure.
- `tests/unit/core/verification/verification-policy.test.js`
- `tests/unit/core/verification/repair-prompt.test.js`
- `tests/unit/core/verification/repair-loop.test.js`
- `tests/unit/core/execution/repair-executor.test.js`
- `tests/integration/v2-repair-loop.test.js`

Modify:

- `src/core/verification/verifier.js`
  Accept verification policy, map non-zero test exit codes to failed verification.
- `src/core/runtime/agent-runtime.js`
  Add `verifyAndMaybeRepair()`, call `runRepairLoop()`, pass `maxRepairAttempts` and policy options.
- `src/index.js`
  Pass `verifyMode`, `testArgv`, and `maxRepairAttempts` to runtime.
- `src/sessions/event-types.js`
  Register `repair:started`, `repair:attempt`, `repair:result`, `repair:exhausted`.
- `package.json`
  Add new source files to `npm run check`.
- Existing tests:
  - `tests/unit/core/verification/verifier.test.js`
  - `tests/unit/core/agent-runtime.test.js`
  - `tests/unit/sessions/event-types.test.js`

Do not modify V0/V1 legacy files except through existing test/check script references. Do not stage unrelated local files:

- `.claude/settings.local.json`
- `.deepseek-code/chat.json`
- `.tmp-memory-test/`
- `docs/plans/roadmap/2026-05-30-phase-4-gui.md`
- `docs/plans/roadmap/2026-05-30-phase-5-polish.md`
- `gui/node_modules/`
- `gui/package-lock.json`

---

### Task 1: Verification Policy

**Files:**
- Create: `src/core/verification/verification-policy.js`
- Test: `tests/unit/core/verification/verification-policy.test.js`

- [ ] **Step 1: Write failing verification policy tests**

Create `tests/unit/core/verification/verification-policy.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createVerificationPolicy } from "../../../../src/core/verification/verification-policy.js";

test("verification policy auto detects in supervised mode", () => {
  const policy = createVerificationPolicy({ verifyMode: "auto" });
  assert.deepEqual(
    policy.plan({ autonomy: "supervised", hasEditResults: true }),
    { shouldVerify: true, testParams: { detect: true }, mode: "detect" }
  );
});

test("verification policy auto runs tests in gated mode", () => {
  const policy = createVerificationPolicy({ verifyMode: "auto" });
  assert.deepEqual(
    policy.plan({ autonomy: "gated", hasEditResults: true }),
    { shouldVerify: true, testParams: { detect: false }, mode: "run" }
  );
});

test("verification policy accepts explicit argv only as string array", () => {
  const policy = createVerificationPolicy({ verifyMode: "run", testArgv: ["npm", "test"] });
  assert.deepEqual(
    policy.plan({ autonomy: "auto", hasEditResults: true }),
    { shouldVerify: true, testParams: { detect: false, argv: ["npm", "test"] }, mode: "run" }
  );

  assert.throws(
    () => createVerificationPolicy({ verifyMode: "run", testArgv: "npm test" }),
    /testArgv must be an array of strings/
  );
  assert.throws(
    () => createVerificationPolicy({ verifyMode: "run", testArgv: ["npm", 1] }),
    /testArgv must be an array of strings/
  );
});

test("verification policy off or no edit results skips", () => {
  assert.deepEqual(
    createVerificationPolicy({ verifyMode: "off" }).plan({ autonomy: "auto", hasEditResults: true }),
    { shouldVerify: false, reason: "verification disabled", mode: "off" }
  );
  assert.deepEqual(
    createVerificationPolicy({ verifyMode: "run" }).plan({ autonomy: "auto", hasEditResults: false }),
    { shouldVerify: false, reason: "no edit results", mode: "skip" }
  );
});

test("verification policy rejects unknown modes", () => {
  assert.throws(
    () => createVerificationPolicy({ verifyMode: "always" }),
    /unknown verifyMode: always/
  );
});
```

- [ ] **Step 2: Run the failing policy tests**

Run:

```powershell
npm.cmd test -- tests/unit/core/verification/verification-policy.test.js
```

Expected: FAIL with module-not-found for `verification-policy.js`.

- [ ] **Step 3: Implement `createVerificationPolicy()`**

Create `src/core/verification/verification-policy.js`:

```js
const VERIFY_MODES = new Set(["auto", "detect", "run", "off"]);

export function createVerificationPolicy({ verifyMode = "auto", testArgv = null } = {}) {
  if (!VERIFY_MODES.has(verifyMode)) {
    throw new Error(`unknown verifyMode: ${verifyMode}`);
  }
  const explicitArgv = normalizeTestArgv(testArgv);

  function plan({ autonomy = "gated", hasEditResults = false } = {}) {
    if (!hasEditResults) {
      return { shouldVerify: false, reason: "no edit results", mode: "skip" };
    }
    if (verifyMode === "off") {
      return { shouldVerify: false, reason: "verification disabled", mode: "off" };
    }
    if (verifyMode === "detect") {
      return { shouldVerify: true, testParams: { detect: true }, mode: "detect" };
    }
    if (verifyMode === "run") {
      return { shouldVerify: true, testParams: runParams(explicitArgv), mode: "run" };
    }
    if (autonomy === "supervised") {
      return { shouldVerify: true, testParams: { detect: true }, mode: "detect" };
    }
    return { shouldVerify: true, testParams: runParams(explicitArgv), mode: "run" };
  }

  return { plan };
}

function runParams(argv) {
  return argv ? { detect: false, argv } : { detect: false };
}

function normalizeTestArgv(value) {
  if (value == null) return null;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error("testArgv must be an array of strings");
  }
  return [...value];
}
```

- [ ] **Step 4: Run policy tests**

Run:

```powershell
npm.cmd test -- tests/unit/core/verification/verification-policy.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```powershell
git add src/core/verification/verification-policy.js tests/unit/core/verification/verification-policy.test.js
git commit -m "feat(v2): add verification policy"
```

---

### Task 2: Verifier Policy Integration

**Files:**
- Modify: `src/core/verification/verifier.js`
- Test: `tests/unit/core/verification/verifier.test.js`

- [ ] **Step 1: Add failing verifier tests**

Append to `tests/unit/core/verification/verifier.test.js`:

```js
test("runVerifier treats non-zero test exit code as failed", async () => {
  const result = await runVerifier({
    turnId: "turn_fail",
    toolResults: [{ status: "success", metadata: { change_id: "chg_1" } }],
    verificationPolicy: { plan: () => ({ shouldVerify: true, testParams: { detect: false }, mode: "run" }) },
    executeTool: async () => ({
      call_id: "call_test",
      status: "success",
      content: [{ type: "text", text: "failing tests" }],
      metadata: { exit_code: 2, argv: ["npm", "test"] }
    }),
    createPolicyContext: () => ({ autonomy: "auto" })
  });

  assert.equal(result.status, "failed");
  assert.equal(result.exit_code, 2);
  assert.match(result.reason, /failing tests/);
});

test("runVerifier uses verification policy test params", async () => {
  const calls = [];
  const result = await runVerifier({
    turnId: "turn_policy",
    toolResults: [{ status: "success", metadata: { change_id: "chg_1" } }],
    verificationPolicy: { plan: () => ({ shouldVerify: true, testParams: { detect: false, argv: ["node", "--test"] }, mode: "run" }) },
    executeTool: async (toolCall) => {
      calls.push(toolCall);
      return {
        call_id: toolCall.id,
        status: "success",
        content: [{ type: "text", text: "ok" }],
        metadata: { exit_code: 0 }
      };
    },
    createPolicyContext: () => ({ autonomy: "auto" })
  });

  assert.equal(result.status, "passed");
  assert.deepEqual(calls[0].params, { detect: false, argv: ["node", "--test"] });
});

test("runVerifier passes caller autonomy to verification policy", async () => {
  let observedAutonomy = null;
  const result = await runVerifier({
    turnId: "turn_autonomy",
    autonomy: "supervised",
    toolResults: [{ status: "success", metadata: { change_id: "chg_1" } }],
    verificationPolicy: {
      plan: ({ autonomy }) => {
        observedAutonomy = autonomy;
        return { shouldVerify: false, reason: "observed", mode: "detect" };
      }
    },
    executeTool: async () => { throw new Error("should not execute test tool"); },
    createPolicyContext: () => ({ autonomy: "auto" })
  });

  assert.equal(observedAutonomy, "supervised");
  assert.deepEqual(result, { status: "skipped", reason: "observed", mode: "detect" });
});

test("runVerifier can skip through verification policy", async () => {
  const result = await runVerifier({
    turnId: "turn_skip_policy",
    toolResults: [{ status: "success", metadata: { change_id: "chg_1" } }],
    verificationPolicy: { plan: () => ({ shouldVerify: false, reason: "verification disabled", mode: "off" }) },
    executeTool: async () => { throw new Error("should not execute test tool"); },
    createPolicyContext: () => ({ autonomy: "auto" })
  });

  assert.deepEqual(result, { status: "skipped", reason: "verification disabled", mode: "off" });
});
```

- [ ] **Step 2: Run failing verifier tests**

Run:

```powershell
npm.cmd test -- tests/unit/core/verification/verifier.test.js
```

Expected: FAIL because `runVerifier()` ignores `verificationPolicy` and maps any `success` to `passed`.

- [ ] **Step 3: Update `runVerifier()`**

Modify `src/core/verification/verifier.js` to:

```js
import { createToolCall } from "../protocol/index.js";
import { createVerificationPolicy } from "./verification-policy.js";

export function shouldVerifyToolResults(toolResults = []) {
  return toolResults.some((result) => result.status === "success" && result.metadata?.change_id);
}

export async function runVerifier({
  turnId,
  autonomy = "gated",
  toolResults = [],
  executeTool,
  createPolicyContext,
  verificationPolicy = createVerificationPolicy(),
  eventBus = null
} = {}) {
  const hasEditResults = shouldVerifyToolResults(toolResults);
  if (!hasEditResults) {
    const skipped = { status: "skipped", reason: "no edit results" };
    eventBus?.publish?.("verification:result", { turn_id: turnId, result: skipped });
    return skipped;
  }

  const plan = verificationPolicy.plan({
    autonomy,
    hasEditResults
  });
  if (!plan.shouldVerify) {
    const skipped = { status: "skipped", reason: plan.reason, mode: plan.mode };
    eventBus?.publish?.("verification:result", { turn_id: turnId, result: skipped });
    return skipped;
  }

  const call = createToolCall({
    name: "test",
    params: plan.testParams,
    source: "runtime",
    requestedByStepId: `verify:${turnId}`
  });
  const result = await executeTool(call, createPolicyContext({ turnId, toolCall: call, phase: "verify" }));
  const verification = mapVerificationResult(result, plan.mode);
  eventBus?.publish?.("verification:result", { turn_id: turnId, result: verification });
  return verification;
}

function mapVerificationResult(result, mode) {
  const reason = result.content?.[0]?.text || "";
  if (result.status === "success") {
    const exitCode = result.metadata?.exit_code;
    if (exitCode != null && exitCode !== 0) {
      return { status: "failed", tool_result: result, reason, exit_code: exitCode, mode };
    }
    return { status: "passed", tool_result: result, reason, mode };
  }
  if (result.status === "approval_required") {
    return { status: "approval_required", tool_result: result, reason, mode };
  }
  if (result.status === "denied") {
    return { status: "failed", tool_result: result, reason, mode };
  }
  return { status: result.status || "error", tool_result: result, reason, mode };
}
```

- [ ] **Step 4: Run verifier tests**

Run:

```powershell
npm.cmd test -- tests/unit/core/verification/verifier.test.js tests/unit/core/verification/verification-policy.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```powershell
git add src/core/verification/verifier.js tests/unit/core/verification/verifier.test.js
git commit -m "feat(v2): apply verification policy"
```

---

### Task 3: Repair Prompt Builder

**Files:**
- Create: `src/core/verification/repair-prompt.js`
- Test: `tests/unit/core/verification/repair-prompt.test.js`

- [ ] **Step 1: Write failing repair prompt tests**

Create `tests/unit/core/verification/repair-prompt.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { buildRepairMessages, summarizeRepairToolResults } from "../../../../src/core/verification/repair-prompt.js";

test("buildRepairMessages includes failure reason and excludes reasoning content", () => {
  const messages = buildRepairMessages({
    userMessage: "fix failing test",
    classification: { task_type: "edit" },
    verification: {
      status: "failed",
      reason: "Expected 1, got 2",
      reasoning_content: "hidden chain of thought"
    },
    toolResults: [
      {
        call_id: "call_edit",
        status: "success",
        content: [{ type: "text", text: "applied diff" }],
        metadata: { change_id: "chg_1", diff_hash: "abc", secret: "sk-test" }
      }
    ],
    previousRepairAttempts: [],
    maxRepairAttempts: 2
  });

  const text = JSON.stringify(messages);
  assert.match(text, /Expected 1, got 2/);
  assert.match(text, /fix failing test/);
  assert.doesNotMatch(text, /hidden chain of thought/);
  assert.doesNotMatch(text, /sk-test/);
});

test("summarizeRepairToolResults truncates long tool output", () => {
  const long = "x".repeat(5000);
  const summary = summarizeRepairToolResults([
    { call_id: "call_1", status: "success", content: [{ type: "text", text: long }], metadata: { path: "a.txt" } }
  ], { maxTextChars: 120 });

  assert.equal(summary.length, 1);
  assert.equal(summary[0].text.length, 120);
  assert.equal(summary[0].truncated, true);
  assert.deepEqual(summary[0].metadata, { path: "a.txt" });
});
```

- [ ] **Step 2: Run failing repair prompt tests**

Run:

```powershell
npm.cmd test -- tests/unit/core/verification/repair-prompt.test.js
```

Expected: FAIL with module-not-found for `repair-prompt.js`.

- [ ] **Step 3: Implement repair prompt builder**

Create `src/core/verification/repair-prompt.js`:

```js
const SAFE_METADATA_KEYS = new Set(["path", "bytes", "argv", "exit_code", "signal", "change_id", "summary", "files", "diff_hash", "diff_size"]);

export function buildRepairMessages({
  userMessage,
  classification = {},
  verification = {},
  toolResults = [],
  previousRepairAttempts = [],
  maxRepairAttempts = 2
} = {}) {
  const payload = {
    task: String(userMessage || ""),
    task_type: classification.task_type || "general",
    verification: {
      status: verification.status || "unknown",
      reason: clip(verification.reason || "", 2000),
      exit_code: verification.exit_code ?? verification.tool_result?.metadata?.exit_code ?? null
    },
    tool_results: summarizeRepairToolResults(toolResults),
    previous_repair_attempts: previousRepairAttempts.map((attempt) => ({
      attempt: attempt.attempt,
      status: attempt.status,
      verification_status: attempt.verification_status
    })),
    max_repair_attempts: maxRepairAttempts
  };

  return [
    {
      role: "system",
      content: [
        "You are DeepSeek Code repair mode.",
        "The previous edit failed verification.",
        "Use the smallest safe corrective change.",
        "Prefer read, grep, glob, and edit tools.",
        "Do not expose hidden reasoning.",
        "Return tool calls when repair is needed; return a final answer only when no tool call is needed."
      ].join(" ")
    },
    {
      role: "user",
      content: JSON.stringify(payload)
    }
  ];
}

export function summarizeRepairToolResults(results = [], { maxTextChars = 2000 } = {}) {
  return results.map((result) => {
    const text = (result.content || []).map((item) => item.text || "").join("\n");
    return {
      call_id: result.call_id,
      status: result.status,
      text: clip(text, maxTextChars),
      truncated: text.length > maxTextChars,
      metadata: safeMetadata(result.metadata || {})
    };
  });
}

function safeMetadata(metadata) {
  const safe = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (SAFE_METADATA_KEYS.has(key)) safe[key] = value;
  }
  return safe;
}

function clip(value, max) {
  const text = String(value || "");
  return text.length > max ? text.slice(0, max) : text;
}
```

- [ ] **Step 4: Run repair prompt tests**

Run:

```powershell
npm.cmd test -- tests/unit/core/verification/repair-prompt.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit Task 3**

```powershell
git add src/core/verification/repair-prompt.js tests/unit/core/verification/repair-prompt.test.js
git commit -m "feat(v2): add repair prompt builder"
```

---

### Task 4: Repair Executor

**Files:**
- Create: `src/core/execution/repair-executor.js`
- Test: `tests/unit/core/execution/repair-executor.test.js`

- [ ] **Step 1: Write failing repair executor tests**

Create `tests/unit/core/execution/repair-executor.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { runRepairExecutor } from "../../../../src/core/execution/repair-executor.js";

test("repair executor invokes repair model and executes tool calls through executeTool", async () => {
  const executed = [];
  const modelCalls = [];
  const result = await runRepairExecutor({
    turnId: "turn_repair",
    messages: [{ role: "user", content: "repair" }],
    modelGateway: {
      invoke: async (messages, options) => {
        modelCalls.push({ messages, options });
        return {
          content: "",
          tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: "d" } }]
        };
      }
    },
    toolSchemas: [{ type: "function", function: { name: "edit" } }],
    executeTool: async (toolCall) => {
      executed.push(toolCall);
      return { call_id: toolCall.id, status: "success", content: [{ type: "text", text: "applied" }], metadata: { change_id: "chg_1" } };
    },
    createPolicyContext: ({ phase }) => ({ autonomy: "gated", phase })
  });

  assert.equal(result.status, "complete");
  assert.equal(modelCalls[0].options.purpose, "repair");
  assert.equal(executed[0].name, "edit");
  assert.equal(result.toolResults.length, 1);
});

test("repair executor returns awaiting_approval with V2-7 resume_state", async () => {
  const result = await runRepairExecutor({
    turnId: "turn_repair_approval",
    messages: [{ role: "user", content: "repair" }],
    modelGateway: {
      invoke: async () => ({
        content: "",
        tool_calls: [
          { id: "call_shell", name: "shell", arguments: { argv: ["npm", "test"] } },
          { id: "call_edit", name: "edit", arguments: { diff: "d" } }
        ]
      })
    },
    toolSchemas: [],
    executeTool: async (toolCall) => ({
      call_id: toolCall.id,
      status: "approval_required",
      content: [{ type: "text", text: "needs approval" }],
      metadata: { approval: { id: "approval_repair" } }
    }),
    createPolicyContext: () => ({ autonomy: "supervised" })
  });

  assert.equal(result.status, "awaiting_approval");
  assert.equal(result.approval.id, "approval_repair");
  assert.equal(result.resume_state.pending_tool_call.name, "shell");
  assert.equal(result.resume_state.turn_id, "turn_repair_approval");
  assert.equal(result.resume_state.options.purpose, "repair");
});

test("repair executor returns final content when model has no tool calls", async () => {
  const result = await runRepairExecutor({
    turnId: "turn_repair_final",
    messages: [{ role: "user", content: "repair" }],
    modelGateway: {
      invoke: async () => ({ content: "cannot repair", tool_calls: [] })
    },
    executeTool: async () => { throw new Error("should not execute tools"); },
    createPolicyContext: () => ({ autonomy: "gated" })
  });

  assert.equal(result.status, "complete");
  assert.equal(result.content, "cannot repair");
  assert.deepEqual(result.toolResults, []);
});
```

- [ ] **Step 2: Run failing repair executor tests**

Run:

```powershell
npm.cmd test -- tests/unit/core/execution/repair-executor.test.js
```

Expected: FAIL with module-not-found for `repair-executor.js`.

- [ ] **Step 3: Implement `runRepairExecutor()`**

Create `src/core/execution/repair-executor.js`:

```js
import { adaptDeepSeekToolCalls } from "./tool-call-adapter.js";
import { toolResultsToMessages } from "./tool-result-router.js";

export async function runRepairExecutor({
  turnId,
  messages = [],
  modelGateway,
  toolSchemas = [],
  executeTool,
  createPolicyContext,
  eventBus = null,
  signal = null,
  options = {}
} = {}) {
  if (!modelGateway || typeof modelGateway.invoke !== "function") {
    throw new Error("modelGateway.invoke is required for repair executor");
  }
  if (typeof executeTool !== "function") throw new Error("executeTool is required");
  if (typeof createPolicyContext !== "function") throw new Error("createPolicyContext is required");

  eventBus?.publish?.("model:request", { turn_id: turnId, purpose: "repair", iteration: 0 });
  const modelResult = await modelGateway.invoke(messages, {
    ...options,
    purpose: "repair",
    tools: toolSchemas,
    toolChoice: "auto",
    signal
  });
  eventBus?.publish?.("model:response", {
    turn_id: turnId,
    purpose: "repair",
    iteration: 0,
    content: modelResult.content || "",
    tool_call_count: modelResult.tool_calls?.length || 0,
    usage: modelResult.usage || null,
    model: modelResult.model,
    channel: modelResult.channel
  });

  const rawToolCalls = modelResult.tool_calls || [];
  if (!rawToolCalls.length) {
    return { status: "complete", content: modelResult.content || "", toolResults: [], messages };
  }

  const toolCalls = adaptDeepSeekToolCalls(rawToolCalls, { requestedByStepId: `repair:${turnId}:0` });
  const toolResults = [];
  for (let index = 0; index < toolCalls.length; index += 1) {
    const toolCall = toolCalls[index];
    const result = await executeTool(toolCall, createPolicyContext({ turnId, toolCall, phase: "repair" }));
    toolResults.push(result);
    if (result.status === "approval_required") {
      return {
        status: "awaiting_approval",
        content: result.content?.[0]?.text || "Approval required",
        approval: result.metadata?.approval || null,
        toolResults,
        resume_state: {
          turn_id: turnId,
          message: options.message || "repair",
          classification: options.classification || { task_type: "edit" },
          messages,
          model_result: modelResult,
          raw_tool_calls: rawToolCalls,
          pending_tool_call: toolCall,
          remaining_tool_calls: toolCalls.slice(index + 1),
          iteration: 0,
          tool_results: toolResults.slice(0, -1),
          tool_schemas: toolSchemas,
          max_iterations: options.maxToolIterations || 5,
          options: { ...options, purpose: "repair" }
        }
      };
    }
  }

  return {
    status: "complete",
    content: modelResult.content || "Repair tools executed.",
    toolResults,
    messages: [...messages, assistantToolCallMessage(modelResult, rawToolCalls), ...toolResultsToMessages(toolResults)]
  };
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

- [ ] **Step 4: Run repair executor tests**

Run:

```powershell
npm.cmd test -- tests/unit/core/execution/repair-executor.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit Task 4**

```powershell
git add src/core/execution/repair-executor.js tests/unit/core/execution/repair-executor.test.js
git commit -m "feat(v2): add repair executor"
```

---

### Task 5: Repair Loop

**Files:**
- Create: `src/core/verification/repair-loop.js`
- Test: `tests/unit/core/verification/repair-loop.test.js`

- [ ] **Step 1: Write failing repair loop tests**

Create `tests/unit/core/verification/repair-loop.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createEventBus } from "../../../../src/shared/event-bus.js";
import { runRepairLoop } from "../../../../src/core/verification/repair-loop.js";

test("repair loop repairs failed verification and returns complete when verification passes", async () => {
  const bus = createEventBus();
  const events = [];
  for (const type of ["repair:started", "repair:attempt", "repair:result"]) {
    bus.subscribe(type, (data) => events.push([type, data]));
  }
  let verifierCalls = 0;
  const result = await runRepairLoop({
    turnId: "turn_repair",
    userMessage: "fix bug",
    classification: { task_type: "edit" },
    modelGateway: {
      invoke: async () => ({ content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: "d" } }] })
    },
    toolSchemas: [],
    executeTool: async (toolCall) => ({ call_id: toolCall.id, status: "success", content: [{ type: "text", text: "applied" }], metadata: { change_id: "chg_2" } }),
    createPolicyContext: () => ({ autonomy: "gated" }),
    verificationPolicy: { plan: () => ({ shouldVerify: true, testParams: { detect: false }, mode: "run" }) },
    runVerifierImpl: async () => {
      verifierCalls += 1;
      return { status: "passed", reason: "ok" };
    },
    initialVerification: { status: "failed", reason: "tests failed" },
    initialToolResults: [{ call_id: "call_old", status: "success", content: [], metadata: { change_id: "chg_1" } }],
    eventBus: bus,
    maxRepairAttempts: 2
  });

  assert.equal(result.status, "complete");
  assert.equal(verifierCalls, 1);
  assert.ok(events.some(([type]) => type === "repair:started"));
  assert.ok(events.some(([type]) => type === "repair:attempt"));
  assert.ok(events.some(([type]) => type === "repair:result"));
});

test("repair loop stops on approval_required", async () => {
  const result = await runRepairLoop({
    turnId: "turn_repair_approval",
    userMessage: "fix bug",
    classification: { task_type: "edit" },
    modelGateway: {
      invoke: async () => ({ content: "", tool_calls: [{ id: "call_shell", name: "shell", arguments: { argv: ["npm", "test"] } }] })
    },
    toolSchemas: [],
    executeTool: async (toolCall) => ({
      call_id: toolCall.id,
      status: "approval_required",
      content: [{ type: "text", text: "approval" }],
      metadata: { approval: { id: "approval_repair" } }
    }),
    createPolicyContext: () => ({ autonomy: "supervised" }),
    verificationPolicy: { plan: () => ({ shouldVerify: true, testParams: { detect: false }, mode: "run" }) },
    initialVerification: { status: "failed", reason: "tests failed" },
    initialToolResults: [],
    maxRepairAttempts: 2
  });

  assert.equal(result.status, "awaiting_approval");
  assert.equal(result.approval.id, "approval_repair");
});

test("repair loop exhausts max attempts", async () => {
  const bus = createEventBus();
  const exhausted = [];
  bus.subscribe("repair:exhausted", (data) => exhausted.push(data));
  let verifierCalls = 0;
  const result = await runRepairLoop({
    turnId: "turn_exhaust",
    userMessage: "fix bug",
    classification: { task_type: "edit" },
    modelGateway: {
      invoke: async () => ({ content: "no repair", tool_calls: [] })
    },
    toolSchemas: [],
    executeTool: async () => { throw new Error("should not execute"); },
    createPolicyContext: () => ({ autonomy: "gated" }),
    verificationPolicy: { plan: () => ({ shouldVerify: true, testParams: { detect: false }, mode: "run" }) },
    runVerifierImpl: async () => {
      verifierCalls += 1;
      return { status: "failed", reason: `still failing ${verifierCalls}` };
    },
    initialVerification: { status: "failed", reason: "tests failed" },
    initialToolResults: [],
    eventBus: bus,
    maxRepairAttempts: 2
  });

  assert.equal(result.status, "failed");
  assert.equal(result.repair.attempts, 2);
  assert.equal(exhausted.length, 1);
});
```

- [ ] **Step 2: Run failing repair loop tests**

Run:

```powershell
npm.cmd test -- tests/unit/core/verification/repair-loop.test.js
```

Expected: FAIL with module-not-found for `repair-loop.js`.

- [ ] **Step 3: Implement `runRepairLoop()`**

Create `src/core/verification/repair-loop.js`:

```js
import { runRepairExecutor } from "../execution/repair-executor.js";
import { runVerifier } from "./verifier.js";
import { buildRepairMessages } from "./repair-prompt.js";

export async function runRepairLoop({
  turnId,
  userMessage,
  classification = {},
  modelGateway,
  toolSchemas = [],
  executeTool,
  createPolicyContext,
  verificationPolicy,
  initialVerification,
  initialToolResults = [],
  eventBus = null,
  signal = null,
  maxRepairAttempts = 2,
  options = {},
  runVerifierImpl = runVerifier,
  runRepairExecutorImpl = runRepairExecutor
} = {}) {
  const attempts = [];
  let verification = initialVerification;
  let allToolResults = [...initialToolResults];
  eventBus?.publish?.("repair:started", { turn_id: turnId, max_attempts: maxRepairAttempts, verification_status: verification?.status });

  for (let attempt = 1; attempt <= maxRepairAttempts; attempt += 1) {
    eventBus?.publish?.("repair:attempt", { turn_id: turnId, attempt, verification_status: verification?.status });
    const messages = buildRepairMessages({
      userMessage,
      classification,
      verification,
      toolResults: allToolResults,
      previousRepairAttempts: attempts,
      maxRepairAttempts
    });
    const repairExec = await runRepairExecutorImpl({
      turnId,
      messages,
      modelGateway,
      toolSchemas,
      executeTool,
      createPolicyContext,
      eventBus,
      signal,
      options: { ...options, message: userMessage, classification }
    });
    if (repairExec.status === "awaiting_approval") {
      return { ...repairExec, repair: { attempts: attempt, status: "awaiting_approval" }, verification };
    }

    allToolResults = [...allToolResults, ...(repairExec.toolResults || [])];
    verification = await runVerifierImpl({
      turnId,
      autonomy: options.autonomy || "gated",
      toolResults: allToolResults,
      executeTool,
      createPolicyContext,
      verificationPolicy,
      eventBus
    });
    const repairResult = {
      turn_id: turnId,
      attempt,
      status: verification.status === "passed" || verification.status === "skipped" ? "complete" : "failed",
      verification_status: verification.status,
      tool_result_count: repairExec.toolResults?.length || 0
    };
    attempts.push(repairResult);
    eventBus?.publish?.("repair:result", repairResult);

    if (verification.status === "passed" || verification.status === "skipped") {
      return {
        status: "complete",
        content: repairExec.content || "Repair complete.",
        toolResults: allToolResults,
        verification,
        repair: { attempts: attempt, status: "complete", history: attempts }
      };
    }
    if (verification.status === "approval_required") {
      return {
        status: "awaiting_approval",
        content: verification.reason || "Verification requires approval",
        approval: verification.tool_result?.metadata?.approval || null,
        toolResults: allToolResults,
        verification,
        repair: { attempts: attempt, status: "awaiting_approval", history: attempts }
      };
    }
  }

  eventBus?.publish?.("repair:exhausted", { turn_id: turnId, attempts: maxRepairAttempts, verification_status: verification?.status });
  return {
    status: "failed",
    content: verification?.reason || "Repair attempts exhausted",
    toolResults: allToolResults,
    verification,
    repair: { attempts: maxRepairAttempts, status: "exhausted", history: attempts }
  };
}
```

- [ ] **Step 4: Run repair loop tests**

Run:

```powershell
npm.cmd test -- tests/unit/core/verification/repair-loop.test.js tests/unit/core/execution/repair-executor.test.js tests/unit/core/verification/repair-prompt.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit Task 5**

```powershell
git add src/core/verification/repair-loop.js tests/unit/core/verification/repair-loop.test.js
git commit -m "feat(v2): add bounded repair loop"
```

---

### Task 6: Runtime and Kernel Integration

**Files:**
- Modify: `src/core/runtime/agent-runtime.js`
- Modify: `src/index.js`
- Test: `tests/unit/core/agent-runtime.test.js`

- [ ] **Step 1: Add failing runtime integration tests**

Append to `tests/unit/core/agent-runtime.test.js`:

```js
test("agent runtime repairs failed verification and completes", async () => {
  let invokeCount = 0;
  let testRuns = 0;
  const runtime = createAgentRuntime({
    sessionId: "sess_repair_runtime",
    maxRepairAttempts: 1,
    verifyMode: "run",
    modelGateway: {
      invoke: async (_messages, options = {}) => {
        invokeCount += 1;
        if (options.purpose === "repair") {
          return { content: "", tool_calls: [{ id: "call_repair_edit", name: "edit", arguments: { diff: "repair" } }] };
        }
        if (invokeCount === 1) {
          return { content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: "broken" } }] };
        }
        return { content: "done", tool_calls: [] };
      },
      reply: async () => ({ content: "fast" })
    },
    toolSchemas: () => [],
    executeTool: async (toolCall) => {
      if (toolCall.name === "test") {
        testRuns += 1;
        return {
          call_id: toolCall.id,
          status: "success",
          content: [{ type: "text", text: testRuns === 1 ? "failed" : "passed" }],
          metadata: { exit_code: testRuns === 1 ? 1 : 0 }
        };
      }
      return { call_id: toolCall.id, status: "success", content: [{ type: "text", text: "applied" }], metadata: { change_id: `chg_${toolCall.id}` } };
    },
    createPolicyContext: () => ({ autonomy: "gated" })
  });

  const result = await runtime.send("modify a.txt", { autonomy: "gated", verifyMode: "run" });

  assert.equal(result.status, "complete");
  assert.equal(result.verification.status, "passed");
  assert.equal(result.repair.status, "complete");
  assert.equal(testRuns, 2);
});

test("agent runtime returns awaiting_approval when repair tool asks", async () => {
  let testRuns = 0;
  const runtime = createAgentRuntime({
    sessionId: "sess_repair_approval",
    maxRepairAttempts: 1,
    verifyMode: "run",
    modelGateway: {
      invoke: async (_messages, options = {}) => {
        if (options.purpose === "repair") {
          return { content: "", tool_calls: [{ id: "call_shell", name: "shell", arguments: { argv: ["npm", "test"] } }] };
        }
        return { content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: "broken" } }] };
      },
      reply: async () => ({ content: "fast" })
    },
    toolSchemas: () => [],
    executeTool: async (toolCall) => {
      if (toolCall.name === "test") {
        testRuns += 1;
        return { call_id: toolCall.id, status: "success", content: [{ type: "text", text: "failed" }], metadata: { exit_code: 1 } };
      }
      if (toolCall.name === "shell") {
        return {
          call_id: toolCall.id,
          status: "approval_required",
          content: [{ type: "text", text: "shell requires approval" }],
          metadata: { approval: { id: "approval_repair_shell" } }
        };
      }
      return { call_id: toolCall.id, status: "success", content: [{ type: "text", text: "applied" }], metadata: { change_id: "chg_1" } };
    },
    createPolicyContext: () => ({ autonomy: "supervised" })
  });

  const result = await runtime.send("modify a.txt", { autonomy: "gated", verifyMode: "run" });

  assert.equal(result.status, "awaiting_approval");
  assert.equal(result.approval.id, "approval_repair_shell");
});

test("agent runtime throws when repair attempts are exhausted", async () => {
  let testRuns = 0;
  const runtime = createAgentRuntime({
    sessionId: "sess_repair_exhausted",
    maxRepairAttempts: 1,
    verifyMode: "run",
    modelGateway: {
      invoke: async (_messages, options = {}) => {
        if (options.purpose === "repair") {
          return { content: "no fix", tool_calls: [] };
        }
        return { content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: "broken" } }] };
      },
      reply: async () => ({ content: "fast" })
    },
    toolSchemas: () => [],
    executeTool: async (toolCall) => {
      if (toolCall.name === "test") {
        testRuns += 1;
        return {
          call_id: toolCall.id,
          status: "success",
          content: [{ type: "text", text: `failed ${testRuns}` }],
          metadata: { exit_code: 1 }
        };
      }
      return { call_id: toolCall.id, status: "success", content: [{ type: "text", text: "applied" }], metadata: { change_id: "chg_1" } };
    },
    createPolicyContext: () => ({ autonomy: "gated" })
  });

  await assert.rejects(
    () => runtime.send("modify a.txt", { autonomy: "gated", verifyMode: "run" }),
    /verification failed|repair/i
  );
});
```

- [ ] **Step 2: Run failing runtime tests**

Run:

```powershell
npm.cmd test -- tests/unit/core/agent-runtime.test.js
```

Expected: FAIL because runtime still throws on repair decision and does not accept repair options.

- [ ] **Step 3: Modify runtime imports and options**

In `src/core/runtime/agent-runtime.js`, add imports:

```js
import { createVerificationPolicy } from "../verification/verification-policy.js";
import { runRepairLoop } from "../verification/repair-loop.js";
```

Update `createAgentRuntime()` options:

```js
export function createAgentRuntime({
  eventBus = null,
  sessionId = `sess_${Date.now()}`,
  modelGateway = null,
  toolSchemas = () => [],
  executeTool = null,
  createPolicyContext = () => ({}),
  maxToolIterations = 5,
  maxRepairAttempts = 2,
  verifyMode = "auto",
  testArgv = null,
  pausedTurnStore = createPausedTurnStore(),
  grantApprovalForToolCall = async () => {}
} = {}) {
```

- [ ] **Step 4: Add `verifyAndMaybeRepair()` helper**

Inside `createAgentRuntime()`, add:

```js
async function verifyAndMaybeRepair({ turn, message, classification, loop, options, signal }) {
  lifecycle = transitionLifecycle(lifecycle, { to: "verify", reason: "tool loop complete", channel: "system" });
  const verificationPolicy = createVerificationPolicy({
    verifyMode: options.verifyMode || verifyMode,
    testArgv: options.testArgv || testArgv
  });
  const verification = await runVerifier({
    turnId: turn.id,
    autonomy: options.autonomy || turn.autonomy,
    toolResults: loop.toolResults,
    executeTool,
    createPolicyContext: ({ turnId, toolCall, phase }) => createPolicyContext({
      autonomy: "auto",
      turnId,
      toolCall,
      phase
    }),
    verificationPolicy,
    eventBus
  });
  const repair = decideRepair(verification);
  if (repair.decision === "none") return { ...loop, verification, repair: null };
  if (repair.decision === "stop" && verification.status === "approval_required") {
    return {
      status: "awaiting_approval",
      content: verification.reason || "Verification requires approval",
      approval: verification.tool_result?.metadata?.approval || null,
      toolResults: loop.toolResults,
      iterations: loop.iterations,
      verification
    };
  }
if (repair.decision === "repair") {
    lifecycle = transitionLifecycle(lifecycle, { to: "repair", reason: repair.reason, channel: "think" });
    const repairLoop = await runRepairLoop({
      turnId: turn.id,
      userMessage: message,
      classification,
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
      verificationPolicy,
      initialVerification: verification,
      initialToolResults: loop.toolResults,
      eventBus,
      signal,
      maxRepairAttempts: options.maxRepairAttempts || maxRepairAttempts,
      options
    });
    return repairLoop;
  }
  return { status: "failed", content: repair.reason, verification, toolResults: loop.toolResults };
}
```

- [ ] **Step 5: Replace duplicated verification blocks**

In `runToolLoopPath()`, replace the block from `lifecycle = transitionLifecycle(... verify ...)` through `return { ...loop, verification };` with:

```js
return verifyAndMaybeRepair({ turn, message, classification, loop, options, signal });
```

In `approve()`, after `resumeExecutorLoop()` returns and after the `loop.status === "awaiting_approval"` block, replace the duplicated verifier block with:

```js
const repaired = await verifyAndMaybeRepair({
  turn: record.turn,
  message: record.turn.user_message,
  classification: record.resume_state.classification || { task_type: "edit" },
  loop,
  options: record.resume_state.options || {},
  signal: currentAbortController.signal
});
if (repaired.status === "awaiting_approval") {
  lifecycle = transitionLifecycle(lifecycle, { to: "awaiting_approval", reason: "repair approval required", channel: "system" });
  currentTurnId = null;
  currentAbortController = null;
  return {
    status: "awaiting_approval",
    state: "awaiting_approval",
    content: repaired.content,
    approval: repaired.approval,
    turn: setTurnStatus(record.turn, "awaiting_approval"),
    verification: repaired.verification
  };
}
if (repaired.status === "failed") {
  throw new Error(`verification failed: ${repaired.content || repaired.verification?.reason || "repair failed"}`);
}
const finalTurn = setTurnStatus(record.turn, "completed");
publish(eventBus, "agent:final", { turn_id: record.turn_id, content: repaired.content, status: "complete" });
lifecycle = transitionLifecycle(lifecycle, { to: "idle", reason: "turn complete", channel: null });
currentTurnId = null;
currentAbortController = null;
return { status: "complete", state: "idle", content: repaired.content, turn: finalTurn, verification: repaired.verification, repair: repaired.repair || null };
```

In `send()`, after the existing `awaiting_approval` block and before marking the turn completed, add the same failed repair guard:

```js
if (response.status === "failed") {
  throw new Error(`verification failed: ${response.content || response.verification?.reason || "repair failed"}`);
}
```

Ensure the normal `send()` completion return includes `repair: response.repair || null`:

```js
return { status: "complete", state: "idle", content: response.content, turn, verification: response.verification || null, repair: response.repair || null };
```

- [ ] **Step 6: Pass kernel options to runtime**

Modify `src/index.js` runtime creation:

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
    }),
    verifyMode: options.verifyMode || "auto",
    testArgv: options.testArgv || null,
    maxRepairAttempts: options.maxRepairAttempts ?? 2,
    grantApprovalForToolCall: async (toolCall, approvalContext = {}) => {
```

- [ ] **Step 7: Run runtime tests**

Run:

```powershell
npm.cmd test -- tests/unit/core/agent-runtime.test.js tests/unit/core/verification/repair-loop.test.js
```

Expected: PASS.

- [ ] **Step 8: Commit Task 6**

```powershell
git add src/core/runtime/agent-runtime.js src/index.js tests/unit/core/agent-runtime.test.js
git commit -m "feat(v2): wire verifier repair loop into runtime"
```

---

### Task 7: Session Events and Integration Tests

**Files:**
- Modify: `src/sessions/event-types.js`
- Test: `tests/unit/sessions/event-types.test.js`
- Test: `tests/integration/v2-repair-loop.test.js`

- [ ] **Step 1: Add failing session event registry test**

Modify `tests/unit/sessions/event-types.test.js` to assert repair events are registered:

```js
for (const type of ["repair:started", "repair:attempt", "repair:result", "repair:exhausted"]) {
  assert.ok(SESSION_EVENT_TYPES.includes(type), `${type} should be registered`);
}
```

Place this inside the existing registry test or add:

```js
test("session event registry contains repair events", () => {
  for (const type of ["repair:started", "repair:attempt", "repair:result", "repair:exhausted"]) {
    assert.ok(SESSION_EVENT_TYPES.includes(type), `${type} should be registered`);
  }
});
```

- [ ] **Step 2: Add failing integration tests**

Create `tests/integration/v2-repair-loop.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createKernel } from "../../src/index.js";
import { createEventBus } from "../../src/shared/event-bus.js";
import { createEditService } from "../../src/edits/edit-service.js";
import { createBuiltinTools } from "../../src/tools/builtin/index.js";
import { createToolRegistry } from "../../src/tools/registry.js";

const BROKEN_DIFF = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+broken";
const REPAIR_DIFF = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-broken\n+fixed";

function createKernelWithFakeTest(root, { modelGateway, testResults, sessionId }) {
  const eventBus = createEventBus();
  let testRuns = 0;
  const editService = createEditService({ projectRoot: root, eventBus });
  const fakeTestTool = {
    name: "test",
    description: "Fake integration test runner",
    category: "execute",
    side_effect: "process",
    risk_level: "low",
    source: "test",
    version: "2.0",
    params: {
      detect: { type: "boolean", required: false, default: true },
      argv: { type: "array", required: false }
    },
    execute: async () => {
      const next = testResults[Math.min(testRuns, testResults.length - 1)];
      testRuns += 1;
      return {
        status: "success",
        content: [{ type: "text", text: next.text }],
        metadata: { exit_code: next.exit_code, run: testRuns }
      };
    }
  };
  const tools = createBuiltinTools({ editService }).filter((tool) => tool.name !== "test");
  const toolRegistry = createToolRegistry({ tools: [...tools, fakeTestTool] });

  return createKernel(root, {
    eventBus,
    editService,
    toolRegistry,
    sessionRoot: path.join(root, ".sessions"),
    sessionId,
    verifyMode: "run",
    maxRepairAttempts: 1,
    modelGateway
  });
}

test("kernel repair loop applies repair edit after failed verification", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-repair-loop-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  let invokeCount = 0;
  const kernel = await createKernelWithFakeTest(root, {
    sessionId: "sess_repair_loop",
    testResults: [
      { exit_code: 1, text: "failed" },
      { exit_code: 0, text: "passed" }
    ],
    modelGateway: {
      invoke: async (_messages, options = {}) => {
        if (options.purpose === "repair") {
          return { content: "", tool_calls: [{ id: "call_repair", name: "edit", arguments: { diff: REPAIR_DIFF, prompt: "repair a" } }] };
        }
        invokeCount += 1;
        if (invokeCount === 1) {
          return { content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: BROKEN_DIFF, prompt: "break a" } }] };
        }
        return { content: "done", tool_calls: [] };
      },
      reply: async () => ({ content: "fast" })
    }
  });

  const result = await kernel.agent.send("modify a.txt", { autonomy: "gated", verifyMode: "run" });

  assert.equal(result.status, "complete");
  assert.equal(result.verification.status, "passed");
  assert.equal(result.repair.status, "complete");
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "fixed\n");
});

test("repair timeline persists repair events", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-repair-timeline-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  const kernel = await createKernelWithFakeTest(root, {
    sessionId: "sess_repair_timeline",
    testResults: [
      { exit_code: 1, text: "failed" },
      { exit_code: 1, text: "still failed" }
    ],
    modelGateway: {
      invoke: async (_messages, options = {}) => {
        if (options.purpose === "repair") {
          return { content: "no repair", tool_calls: [] };
        }
        return { content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: BROKEN_DIFF, prompt: "break a" } }] };
      },
      reply: async () => ({ content: "fast" })
    }
  });

  await assert.rejects(
    () => kernel.agent.send("modify a.txt", { autonomy: "gated", verifyMode: "run" }),
    /verification failed|repair/i
  );
  await kernel.session.flush();
  const types = (await kernel.session.getTimeline(50)).map((event) => event.type);

  assert.ok(types.includes("repair:started"));
  assert.ok(types.includes("repair:attempt"));
  assert.ok(types.includes("repair:result"));
  assert.ok(types.includes("repair:exhausted"));
});

test("query fast path does not enter repair loop", async () => {
  let invokeCalled = false;
  const kernel = await createKernel(process.cwd(), {
    sessionLog: null,
    modelGateway: {
      reply: async () => ({ content: "query answer" }),
      invoke: async () => {
        invokeCalled = true;
        return { content: "tool path" };
      }
    }
  });

  const result = await kernel.agent.send("what is this project?");

  assert.equal(result.status, "complete");
  assert.equal(result.content, "query answer");
  assert.equal(invokeCalled, false);
});
```

The fake test tool controls verification outcomes only. The edit tool remains the real built-in deferred edit tool, so the integration still exercises ToolRegistry, ToolExecutor, PermissionEngine, and EditService for repair file writes. All tests use `mkdtemp()` roots or `sessionLog: null`, so they must not create `.deepseek-code/v2` in the repository root.

- [ ] **Step 3: Run failing event and integration tests**

Run:

```powershell
npm.cmd test -- tests/unit/sessions/event-types.test.js tests/integration/v2-repair-loop.test.js
```

Expected: FAIL because repair events are not registered and runtime repair loop is not fully wired.

- [ ] **Step 4: Register repair events**

Modify `src/sessions/event-types.js`:

```js
  "verification:result",
  "repair:started",
  "repair:attempt",
  "repair:result",
  "repair:exhausted",
  "agent:final",
```

- [ ] **Step 5: Run integration tests**

Run:

```powershell
npm.cmd test -- tests/unit/sessions/event-types.test.js tests/integration/v2-repair-loop.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit Task 7**

```powershell
git add src/sessions/event-types.js tests/unit/sessions/event-types.test.js tests/integration/v2-repair-loop.test.js
git commit -m "test(v2): cover repair loop integration"
```

---

### Task 8: Package Check and Regression

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Update check script**

Modify `package.json` `scripts.check` to include the new files in the existing `node --check src/core/...` section:

```text
src/core/execution/repair-executor.js
src/core/verification/verification-policy.js
src/core/verification/repair-prompt.js
src/core/verification/repair-loop.js
```

Keep the existing script structure. Do not add dependencies.

- [ ] **Step 2: Run targeted V2-8 tests**

Run:

```powershell
npm.cmd test -- tests/unit/core/verification/verification-policy.test.js tests/unit/core/verification/verifier.test.js tests/unit/core/verification/repair-prompt.test.js tests/unit/core/execution/repair-executor.test.js tests/unit/core/verification/repair-loop.test.js tests/unit/core/agent-runtime.test.js tests/integration/v2-repair-loop.test.js
```

Expected: PASS.

- [ ] **Step 3: Verify no repository V2 session pollution**

Run:

```powershell
if (Test-Path -LiteralPath ".deepseek-code\v2") { throw ".deepseek-code/v2 should not be created by tests" } else { "no v2 session pollution" }
```

Expected: prints `no v2 session pollution`.

- [ ] **Step 4: Run full regression**

Run:

```powershell
npm.cmd test
```

Expected: exits 0 with `fail 0`.

- [ ] **Step 5: Run syntax check**

Run:

```powershell
npm.cmd run check
```

Expected: exits 0.

- [ ] **Step 6: Run whitespace check**

Run:

```powershell
git diff --check
```

Expected: exits 0. Existing unrelated CRLF warnings may still appear for user-local files.

- [ ] **Step 7: Commit Task 8**

```powershell
git add package.json
git commit -m "chore(v2): include repair loop checks"
```

---

## Final Acceptance Criteria

V2-8 is complete when:

- Failed post-edit verification triggers at least one repair attempt.
- Repair model calls use `purpose: "repair"`.
- Repair tool calls execute through injected `executeTool()` and therefore through ToolExecutor in kernel integration.
- Repair can produce final `status: "complete"` after verification passes.
- Repair can stop at `awaiting_approval` without writing unauthorized changes.
- Max repair attempts are enforced and publish `repair:exhausted`.
- Non-zero test exit codes are verification failures.
- Query fast path does not enter repair.
- Session timeline includes repair events.
- `npm.cmd test`, `npm.cmd run check`, and `git diff --check` pass.
- Tests do not create `.deepseek-code/v2` in the repository root.

## Implementation Notes

- Do not delete V0/V1 legacy files.
- Do not introduce dependencies.
- Do not expose `reasoning_content` in prompts, events, logs, or UI.
- Do not bypass ToolExecutor after repair approval.
- Keep repair attempts bounded; default `maxRepairAttempts` is `2`.
- Use `npm.cmd` on Windows PowerShell.
- Integration tests that need custom verification must replace only the `test` tool through `toolRegistry` injection. Keep `edit` as the real built-in deferred edit tool so repair writes still prove the production tool path.
