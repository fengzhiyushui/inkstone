# V2-0 Skeleton & Protocol Foundation Implementation Plan

> 完成状态以 [CHANGELOG](../../CHANGELOG.md) 为准。


**Goal:** Create the DeepSeek Code v2 directory skeleton, core protocol objects, event names, mock runtime loop, and public kernel facade without changing existing v0/v1 behavior.

**Architecture:** This phase adds a new clean runtime spine beside the current implementation. It creates reusable v2 modules under `src/`, keeps old `src/kernel` and legacy CLI paths intact, and proves the new public API can run a mock agent turn through events. Later plans will fill DeepSeek, tools, edits, sessions, and interface migration.

**Tech Stack:** Node.js >= 20, ESM, `node:test`, `node:assert/strict`, Node built-in modules only.

---

## Scope Boundary

This plan implements only V2-0 from the spec:

- New directory skeleton.
- Shared helpers.
- Core protocol factory functions.
- Session event type registry.
- Minimal classifier and lifecycle state.
- Mock `AgentRuntime`.
- Public `createKernel()` facade in `src/index.js`.
- Tests and script updates so v2 tests run with existing regression.

This plan does not connect real DeepSeek API calls, real tools, diff application, GUI migration, TUI migration, or CLI command migration. Those are separate plans.

## File Structure

Create:

```text
src/index.js
src/shared/id.js
src/shared/time.js
src/shared/event-bus.js
src/core/protocol/agent-turn.js
src/core/protocol/agent-step.js
src/core/protocol/tool-call.js
src/core/protocol/tool-result.js
src/core/protocol/approval-request.js
src/core/protocol/artifact.js
src/core/protocol/index.js
src/core/planning/classifier.js
src/core/runtime/lifecycle.js
src/core/runtime/agent-runtime.js
src/sessions/event-types.js
tests/unit/shared/event-bus.test.js
tests/unit/core/protocol.test.js
tests/unit/core/lifecycle.test.js
tests/unit/core/agent-runtime.test.js
tests/unit/sessions/event-types.test.js
tests/integration/v2-kernel-facade.test.js
```

Modify:

```text
package.json
```

Responsibility map:

- `src/shared/*`: generic helpers with no product-specific side effects.
- `src/core/protocol/*`: pure factory and validation helpers for v2 turn data.
- `src/core/planning/classifier.js`: first-pass deterministic task classification.
- `src/core/runtime/lifecycle.js`: runtime state and transition records.
- `src/core/runtime/agent-runtime.js`: minimal mock turn loop that emits canonical events.
- `src/sessions/event-types.js`: single list of v2 session event names.
- `src/index.js`: stable v2 public kernel entrypoint.

---

### Task 1: Shared Helpers

**Files:**
- Create: `src/shared/id.js`
- Create: `src/shared/time.js`
- Create: `src/shared/event-bus.js`
- Test: `tests/unit/shared/event-bus.test.js`

- [ ] **Step 1: Write the failing shared event bus test**

Create `tests/unit/shared/event-bus.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createEventBus } from "../../../src/shared/event-bus.js";

test("v2 event bus publishes data with metadata", () => {
  const bus = createEventBus();
  const received = [];

  bus.subscribe("agent:step", (data, meta) => {
    received.push({ data, meta });
  });

  bus.publish("agent:step", { step_id: "step_1" });

  assert.equal(received.length, 1);
  assert.equal(received[0].data.step_id, "step_1");
  assert.equal(received[0].meta.event_type, "agent:step");
  assert.ok(received[0].meta.event_id.startsWith("evt_"));
  assert.ok(Date.parse(received[0].meta.timestamp) > 0);
});

test("v2 event bus unsubscribe stops delivery", () => {
  const bus = createEventBus();
  let count = 0;

  const sub = bus.subscribe("agent:final", () => {
    count += 1;
  });

  sub.unsubscribe();
  bus.publish("agent:final", { content: "done" });

  assert.equal(count, 0);
});

test("v2 event bus isolates subscriber failures", () => {
  const bus = createEventBus();
  const received = [];

  bus.subscribe("tool:result", () => {
    throw new Error("subscriber failure");
  });
  bus.subscribe("tool:result", (data) => {
    received.push(data);
  });

  assert.doesNotThrow(() => {
    bus.publish("tool:result", { status: "success" });
  });
  assert.deepEqual(received, [{ status: "success" }]);
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
node --test tests/unit/shared/event-bus.test.js
```

Expected: FAIL with `Cannot find module` for `src/shared/event-bus.js`.

- [ ] **Step 3: Add shared helper implementations**

Create `src/shared/id.js`:

```js
import { randomUUID } from "node:crypto";

export function makeId(prefix) {
  if (!prefix || typeof prefix !== "string") {
    throw new Error("id prefix must be a non-empty string");
  }
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}
```

Create `src/shared/time.js`:

```js
export function nowIso() {
  return new Date().toISOString();
}
```

Create `src/shared/event-bus.js`:

```js
import { EventEmitter } from "node:events";
import { makeId } from "./id.js";
import { nowIso } from "./time.js";

export function createEventBus() {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(200);

  function publish(eventType, data = {}) {
    if (!eventType || typeof eventType !== "string") {
      throw new Error("eventType must be a non-empty string");
    }

    const meta = {
      event_id: makeId("evt"),
      event_type: eventType,
      timestamp: nowIso()
    };

    for (const handler of emitter.rawListeners(eventType)) {
      try {
        handler(data, meta);
      } catch {
        // Event subscribers are isolated so one bad UI/log sink cannot break the runtime.
      }
    }
  }

  function subscribe(eventType, handler) {
    if (typeof handler !== "function") {
      throw new Error("event handler must be a function");
    }
    emitter.on(eventType, handler);
    return {
      unsubscribe() {
        emitter.off(eventType, handler);
      }
    };
  }

  function once(eventType, handler) {
    if (typeof handler !== "function") {
      throw new Error("event handler must be a function");
    }
    emitter.once(eventType, handler);
    return {
      unsubscribe() {
        emitter.off(eventType, handler);
      }
    };
  }

  return { publish, subscribe, once };
}
```

- [ ] **Step 4: Run the shared helper test**

Run:

```bash
node --test tests/unit/shared/event-bus.test.js
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Commit shared helpers**

Run:

```bash
git add src/shared/id.js src/shared/time.js src/shared/event-bus.js tests/unit/shared/event-bus.test.js
git commit -m "feat(v2): add shared runtime helpers"
```

---

### Task 2: Core Protocol Objects

**Files:**
- Create: `src/core/protocol/agent-turn.js`
- Create: `src/core/protocol/agent-step.js`
- Create: `src/core/protocol/tool-call.js`
- Create: `src/core/protocol/tool-result.js`
- Create: `src/core/protocol/approval-request.js`
- Create: `src/core/protocol/artifact.js`
- Create: `src/core/protocol/index.js`
- Test: `tests/unit/core/protocol.test.js`

- [ ] **Step 1: Write the failing protocol tests**

Create `tests/unit/core/protocol.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  createAgentTurn,
  setTurnStatus,
  addTurnStep,
  createAgentStep,
  completeAgentStep,
  createToolCall,
  createToolResult,
  createApprovalRequest,
  createArtifact
} from "../../../src/core/protocol/index.js";

test("createAgentTurn builds a valid turn", () => {
  const turn = createAgentTurn({
    sessionId: "sess_1",
    userMessage: "hello",
    autonomy: "gated"
  });

  assert.ok(turn.id.startsWith("turn_"));
  assert.equal(turn.session_id, "sess_1");
  assert.equal(turn.user_message, "hello");
  assert.equal(turn.status, "running");
  assert.equal(turn.autonomy, "gated");
  assert.deepEqual(turn.steps, []);
  assert.deepEqual(turn.artifacts, []);
  assert.equal(turn.usage.total_tokens, 0);
});

test("turn helpers update status and append steps immutably", () => {
  const turn = createAgentTurn({ sessionId: "sess_1", userMessage: "hello" });
  const step = createAgentStep({ turnId: turn.id, type: "classify", channel: "system" });
  const withStep = addTurnStep(turn, step);
  const completed = setTurnStatus(withStep, "completed");

  assert.equal(turn.steps.length, 0);
  assert.equal(withStep.steps.length, 1);
  assert.equal(completed.status, "completed");
  assert.notEqual(completed.updated_at, undefined);
});

test("createAgentStep and completeAgentStep build step lifecycle records", () => {
  const step = createAgentStep({ turnId: "turn_1", type: "model", channel: "think" });
  const completed = completeAgentStep(step, { outputRef: "artifact_1" });

  assert.ok(step.id.startsWith("step_"));
  assert.equal(step.status, "started");
  assert.equal(completed.status, "completed");
  assert.equal(completed.output_ref, "artifact_1");
  assert.ok(Date.parse(completed.ended_at) > 0);
});

test("tool and approval protocol records use stable field names", () => {
  const call = createToolCall({
    name: "read",
    params: { path: "README.md" },
    requestedByStepId: "step_1"
  });
  const result = createToolResult({
    callId: call.id,
    status: "success",
    content: [{ type: "text", text: "ok" }]
  });
  const approval = createApprovalRequest({
    turnId: "turn_1",
    kind: "tool",
    risk: "medium",
    summary: "Read README"
  });

  assert.equal(call.name, "read");
  assert.equal(call.requested_by_step_id, "step_1");
  assert.equal(result.call_id, call.id);
  assert.equal(result.status, "success");
  assert.equal(approval.kind, "tool");
  assert.deepEqual(approval.decisions, ["approve", "deny"]);
});

test("createArtifact records durable artifact metadata", () => {
  const artifact = createArtifact({
    kind: "diff",
    path: ".deepseek-code/artifacts/a.diff",
    hash: "sha256:abc",
    size: 42
  });

  assert.ok(artifact.id.startsWith("artifact_"));
  assert.equal(artifact.kind, "diff");
  assert.equal(artifact.ttl, null);
  assert.deepEqual(artifact.metadata, {});
});
```

- [ ] **Step 2: Run the failing protocol tests**

Run:

```bash
node --test tests/unit/core/protocol.test.js
```

Expected: FAIL with `Cannot find module` for `src/core/protocol/index.js`.

- [ ] **Step 3: Add protocol implementations**

Create `src/core/protocol/agent-turn.js`:

```js
import { makeId } from "../../shared/id.js";
import { nowIso } from "../../shared/time.js";

export const TURN_STATUSES = Object.freeze([
  "running",
  "awaiting_approval",
  "completed",
  "failed",
  "interrupted"
]);

export function createAgentTurn({ sessionId, userMessage, autonomy = "gated", id = makeId("turn") }) {
  if (!sessionId) throw new Error("sessionId is required");
  if (typeof userMessage !== "string" || userMessage.length === 0) {
    throw new Error("userMessage must be a non-empty string");
  }

  const now = nowIso();
  return {
    id,
    session_id: sessionId,
    user_message: userMessage,
    status: "running",
    autonomy,
    created_at: now,
    updated_at: now,
    steps: [],
    artifacts: [],
    usage: {
      total_tokens: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      reasoning_tokens: 0,
      cache_hit_tokens: 0,
      cache_miss_tokens: 0
    }
  };
}

export function setTurnStatus(turn, status) {
  if (!TURN_STATUSES.includes(status)) {
    throw new Error(`invalid turn status: ${status}`);
  }
  return { ...turn, status, updated_at: nowIso() };
}

export function addTurnStep(turn, step) {
  return {
    ...turn,
    steps: [...turn.steps, step],
    updated_at: nowIso()
  };
}
```

Create `src/core/protocol/agent-step.js`:

```js
import { makeId } from "../../shared/id.js";
import { nowIso } from "../../shared/time.js";

export const STEP_STATUSES = Object.freeze(["started", "completed", "failed", "skipped"]);

export function createAgentStep({
  turnId,
  type,
  channel = "system",
  status = "started",
  inputRef = null,
  outputRef = null,
  id = makeId("step")
}) {
  if (!turnId) throw new Error("turnId is required");
  if (!type) throw new Error("step type is required");
  if (!STEP_STATUSES.includes(status)) throw new Error(`invalid step status: ${status}`);

  return {
    id,
    turn_id: turnId,
    type,
    channel,
    status,
    input_ref: inputRef,
    output_ref: outputRef,
    started_at: nowIso(),
    ended_at: null
  };
}

export function completeAgentStep(step, { outputRef = step.output_ref, status = "completed" } = {}) {
  if (!STEP_STATUSES.includes(status)) throw new Error(`invalid step status: ${status}`);
  return {
    ...step,
    status,
    output_ref: outputRef,
    ended_at: nowIso()
  };
}
```

Create `src/core/protocol/tool-call.js`:

```js
import { makeId } from "../../shared/id.js";

export function createToolCall({
  name,
  params = {},
  source = "model",
  requestedByStepId,
  id = makeId("toolcall")
}) {
  if (!name) throw new Error("tool call name is required");
  if (!requestedByStepId) throw new Error("requestedByStepId is required");

  return {
    id,
    name,
    params,
    source,
    requested_by_step_id: requestedByStepId
  };
}
```

Create `src/core/protocol/tool-result.js`:

```js
import { makeId } from "../../shared/id.js";

export function createToolResult({
  callId,
  status,
  content = [],
  metadata = {},
  durationMs = 0,
  id = makeId("toolresult")
}) {
  if (!callId) throw new Error("callId is required");
  if (!status) throw new Error("tool result status is required");

  return {
    id,
    call_id: callId,
    status,
    content,
    metadata,
    duration_ms: durationMs
  };
}
```

Create `src/core/protocol/approval-request.js`:

```js
import { makeId } from "../../shared/id.js";

export function createApprovalRequest({
  turnId,
  kind,
  risk = "medium",
  summary,
  detailsRef = null,
  decisions = ["approve", "deny"],
  id = makeId("approval")
}) {
  if (!turnId) throw new Error("turnId is required");
  if (!kind) throw new Error("approval kind is required");
  if (!summary) throw new Error("approval summary is required");

  return {
    id,
    turn_id: turnId,
    kind,
    risk,
    summary,
    details_ref: detailsRef,
    decisions
  };
}
```

Create `src/core/protocol/artifact.js`:

```js
import { makeId } from "../../shared/id.js";

export function createArtifact({
  kind,
  path,
  hash,
  size,
  ttl = null,
  metadata = {},
  id = makeId("artifact")
}) {
  if (!kind) throw new Error("artifact kind is required");
  if (!path) throw new Error("artifact path is required");
  if (!hash) throw new Error("artifact hash is required");
  if (!Number.isFinite(size) || size < 0) throw new Error("artifact size must be a non-negative number");

  return { id, kind, path, hash, size, ttl, metadata };
}
```

Create `src/core/protocol/index.js`:

```js
export { createAgentTurn, setTurnStatus, addTurnStep, TURN_STATUSES } from "./agent-turn.js";
export { createAgentStep, completeAgentStep, STEP_STATUSES } from "./agent-step.js";
export { createToolCall } from "./tool-call.js";
export { createToolResult } from "./tool-result.js";
export { createApprovalRequest } from "./approval-request.js";
export { createArtifact } from "./artifact.js";
```

- [ ] **Step 4: Run the protocol tests**

Run:

```bash
node --test tests/unit/core/protocol.test.js
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit protocol objects**

Run:

```bash
git add src/core/protocol tests/unit/core/protocol.test.js
git commit -m "feat(v2): add core protocol records"
```

---

### Task 3: Session Event Type Registry

**Files:**
- Create: `src/sessions/event-types.js`
- Test: `tests/unit/sessions/event-types.test.js`

- [ ] **Step 1: Write the failing event type tests**

Create `tests/unit/sessions/event-types.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  SESSION_EVENT_TYPES,
  isSessionEventType,
  assertSessionEventType
} from "../../../src/sessions/event-types.js";

test("session event registry contains the v2 canonical events", () => {
  for (const type of [
    "session:start",
    "session:resume",
    "user:message",
    "agent:turn_started",
    "agent:step",
    "model:request",
    "model:response",
    "tool:call",
    "tool:result",
    "permission:decision",
    "approval:requested",
    "approval:resolved",
    "file:diff_preview",
    "file:diff_applied",
    "verification:result",
    "agent:final",
    "agent:error"
  ]) {
    assert.ok(SESSION_EVENT_TYPES.includes(type), `${type} missing`);
    assert.equal(isSessionEventType(type), true);
  }
});

test("assertSessionEventType rejects unknown events", () => {
  assert.doesNotThrow(() => assertSessionEventType("agent:step"));
  assert.throws(
    () => assertSessionEventType("unknown:event"),
    /unknown session event type/
  );
});
```

- [ ] **Step 2: Run the failing event type tests**

Run:

```bash
node --test tests/unit/sessions/event-types.test.js
```

Expected: FAIL with `Cannot find module` for `src/sessions/event-types.js`.

- [ ] **Step 3: Add the event type registry**

Create `src/sessions/event-types.js`:

```js
export const SESSION_EVENT_TYPES = Object.freeze([
  "session:start",
  "session:resume",
  "user:message",
  "agent:turn_started",
  "agent:step",
  "model:request",
  "model:response",
  "tool:call",
  "tool:result",
  "permission:decision",
  "approval:requested",
  "approval:resolved",
  "file:diff_preview",
  "file:diff_applied",
  "verification:result",
  "agent:final",
  "agent:error"
]);

export function isSessionEventType(type) {
  return SESSION_EVENT_TYPES.includes(type);
}

export function assertSessionEventType(type) {
  if (!isSessionEventType(type)) {
    throw new Error(`unknown session event type: ${type}`);
  }
}
```

- [ ] **Step 4: Run the event type tests**

Run:

```bash
node --test tests/unit/sessions/event-types.test.js
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Commit event types**

Run:

```bash
git add src/sessions/event-types.js tests/unit/sessions/event-types.test.js
git commit -m "feat(v2): define session event types"
```

---

### Task 4: Classifier and Runtime Lifecycle

**Files:**
- Create: `src/core/planning/classifier.js`
- Create: `src/core/runtime/lifecycle.js`
- Test: `tests/unit/core/lifecycle.test.js`

- [ ] **Step 1: Write the failing lifecycle tests**

Create `tests/unit/core/lifecycle.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { classifyMessage } from "../../../src/core/planning/classifier.js";
import {
  createLifecycleState,
  transitionLifecycle,
  RUNTIME_STATES
} from "../../../src/core/runtime/lifecycle.js";

test("classifyMessage separates query, edit, diagnostic, and general tasks", () => {
  assert.equal(classifyMessage("what does this project do?").task_type, "query");
  assert.equal(classifyMessage("fix the login bug").task_type, "edit");
  assert.equal(classifyMessage("debug the failing test").task_type, "diagnostic");
  assert.equal(classifyMessage("continue").task_type, "general");
});

test("classifyMessage carries autonomy and route metadata", () => {
  const result = classifyMessage("fix the bug", { autonomy: "supervised" });

  assert.equal(result.autonomy, "supervised");
  assert.equal(result.risk, "medium");
  assert.equal(result.channel, "think");
  assert.equal(result.requires_plan, true);
});

test("lifecycle starts idle and transitions immutably", () => {
  const initial = createLifecycleState();
  const next = transitionLifecycle(initial, {
    to: "classify",
    reason: "user message received",
    channel: "think"
  });

  assert.deepEqual(RUNTIME_STATES.includes("idle"), true);
  assert.equal(initial.current, "idle");
  assert.equal(next.current, "classify");
  assert.equal(next.previous, "idle");
  assert.equal(next.channel, "think");
  assert.equal(next.reason, "user message received");
  assert.ok(next.trace_id.startsWith("trace_"));
});

test("transitionLifecycle rejects invalid states", () => {
  const initial = createLifecycleState();
  assert.throws(
    () => transitionLifecycle(initial, { to: "missing", reason: "bad" }),
    /invalid runtime state/
  );
});
```

- [ ] **Step 2: Run the failing lifecycle tests**

Run:

```bash
node --test tests/unit/core/lifecycle.test.js
```

Expected: FAIL with `Cannot find module` for `classifier.js` or `lifecycle.js`.

- [ ] **Step 3: Add classifier and lifecycle implementations**

Create `src/core/planning/classifier.js`:

```js
const EDIT_PATTERN = /\b(fix|change|modify|edit|delete|remove|add|create|write|update|refactor|implement)\b/i;
const DIAGNOSTIC_PATTERN = /\b(debug|diagnose|analyze|investigate|inspect|check)\b/i;
const QUERY_PATTERN = /\b(what|how|why|explain|describe|show|list|who|where|when|can|could|tell|find|get)\b/i;

export function classifyMessage(message, options = {}) {
  const text = String(message || "").trim();
  const autonomy = options.autonomy || "gated";

  if (EDIT_PATTERN.test(text)) {
    return {
      task_type: "edit",
      risk: "medium",
      channel: "think",
      autonomy,
      requires_plan: true,
      reason: "code modification request"
    };
  }

  if (DIAGNOSTIC_PATTERN.test(text)) {
    return {
      task_type: "diagnostic",
      risk: "low",
      channel: "think",
      autonomy,
      requires_plan: false,
      reason: "diagnostic request"
    };
  }

  if (QUERY_PATTERN.test(text) || text.endsWith("?")) {
    return {
      task_type: "query",
      risk: "low",
      channel: "think",
      autonomy,
      requires_plan: false,
      reason: "question or explanation request"
    };
  }

  return {
    task_type: "general",
    risk: "medium",
    channel: "think",
    autonomy,
    requires_plan: true,
    reason: "general agent request"
  };
}
```

Create `src/core/runtime/lifecycle.js`:

```js
import { makeId } from "../../shared/id.js";
import { nowIso } from "../../shared/time.js";

export const RUNTIME_STATES = Object.freeze([
  "idle",
  "classify",
  "plan",
  "awaiting_approval",
  "execute",
  "review",
  "verify",
  "repair",
  "complete",
  "failed",
  "interrupted"
]);

export function createLifecycleState() {
  return {
    current: "idle",
    previous: null,
    channel: null,
    reason: "runtime created",
    trace_id: makeId("trace"),
    updated_at: nowIso()
  };
}

export function transitionLifecycle(state, { to, reason, channel = state.channel }) {
  if (!RUNTIME_STATES.includes(to)) {
    throw new Error(`invalid runtime state: ${to}`);
  }
  if (!reason) {
    throw new Error("transition reason is required");
  }

  return {
    current: to,
    previous: state.current,
    channel,
    reason,
    trace_id: makeId("trace"),
    updated_at: nowIso()
  };
}
```

- [ ] **Step 4: Run the lifecycle tests**

Run:

```bash
node --test tests/unit/core/lifecycle.test.js
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit classifier and lifecycle**

Run:

```bash
git add src/core/planning/classifier.js src/core/runtime/lifecycle.js tests/unit/core/lifecycle.test.js
git commit -m "feat(v2): add classifier and runtime lifecycle"
```

---

### Task 5: Mock Agent Runtime

**Files:**
- Create: `src/core/runtime/agent-runtime.js`
- Test: `tests/unit/core/agent-runtime.test.js`

- [ ] **Step 1: Write the failing runtime tests**

Create `tests/unit/core/agent-runtime.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createEventBus } from "../../../src/shared/event-bus.js";
import { createAgentRuntime } from "../../../src/core/runtime/agent-runtime.js";

test("agent runtime completes a mock query turn", async () => {
  const bus = createEventBus();
  const events = [];
  bus.subscribe("agent:turn_started", (data) => events.push(["turn", data]));
  bus.subscribe("agent:step", (data) => events.push(["step", data]));
  bus.subscribe("agent:final", (data) => events.push(["final", data]));

  const runtime = createAgentRuntime({
    eventBus: bus,
    sessionId: "sess_test",
    modelGateway: {
      reply: async ({ classification }) => ({
        content: `mock ${classification.task_type} response`
      })
    }
  });

  const result = await runtime.send("what does this project do?", { autonomy: "auto" });

  assert.equal(result.status, "complete");
  assert.equal(result.state, "idle");
  assert.equal(result.content, "mock query response");
  assert.equal(result.turn.session_id, "sess_test");
  assert.ok(events.some(([type]) => type === "turn"));
  assert.ok(events.some(([type]) => type === "step"));
  assert.ok(events.some(([type]) => type === "final"));
});

test("agent runtime rejects concurrent turns", async () => {
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });

  const runtime = createAgentRuntime({
    sessionId: "sess_test",
    modelGateway: {
      reply: async () => {
        await blocked;
        return { content: "released" };
      }
    }
  });

  const first = runtime.send("what is this?");

  await assert.rejects(
    () => runtime.send("second"),
    /another turn is in progress/
  );

  release();
  await first;
});

test("agent runtime interrupt returns to idle", async () => {
  const runtime = createAgentRuntime({ sessionId: "sess_test" });

  const before = runtime.getState();
  runtime.interrupt("turn_missing");
  const after = runtime.getState();

  assert.equal(before.current, "idle");
  assert.equal(after.current, "idle");
});

test("agent runtime approve publishes approval resolution", () => {
  const bus = createEventBus();
  const approvals = [];
  bus.subscribe("approval:resolved", (data) => approvals.push(data));

  const runtime = createAgentRuntime({ eventBus: bus, sessionId: "sess_test" });
  runtime.approve("approval_1", "approve");

  assert.deepEqual(approvals, [{ approval_id: "approval_1", decision: "approve" }]);
});
```

- [ ] **Step 2: Run the failing runtime tests**

Run:

```bash
node --test tests/unit/core/agent-runtime.test.js
```

Expected: FAIL with `Cannot find module` for `src/core/runtime/agent-runtime.js`.

- [ ] **Step 3: Add the mock runtime implementation**

Create `src/core/runtime/agent-runtime.js`:

```js
import { createAgentTurn, addTurnStep, setTurnStatus } from "../protocol/agent-turn.js";
import { createAgentStep, completeAgentStep } from "../protocol/agent-step.js";
import { classifyMessage } from "../planning/classifier.js";
import { createLifecycleState, transitionLifecycle } from "./lifecycle.js";

function publish(eventBus, eventType, data) {
  if (eventBus && typeof eventBus.publish === "function") {
    eventBus.publish(eventType, data);
  }
}

export function createAgentRuntime({ eventBus = null, sessionId = `sess_${Date.now()}`, modelGateway = null } = {}) {
  let lifecycle = createLifecycleState();
  let activeTurn = null;

  function getState() {
    return { ...lifecycle };
  }

  async function send(message, options = {}) {
    if (activeTurn) {
      const err = new Error("another turn is in progress");
      err.code = "BUSY";
      throw err;
    }

    let turn = createAgentTurn({
      sessionId,
      userMessage: message,
      autonomy: options.autonomy || "gated"
    });
    activeTurn = turn;

    publish(eventBus, "user:message", {
      turn_id: turn.id,
      content: message,
      options
    });
    publish(eventBus, "agent:turn_started", { turn });

    try {
      lifecycle = transitionLifecycle(lifecycle, {
        to: "classify",
        reason: "user message received",
        channel: "think"
      });

      const classifyStep = createAgentStep({
        turnId: turn.id,
        type: "classify",
        channel: "think"
      });
      const classification = classifyMessage(message, options);
      const completedClassifyStep = completeAgentStep(classifyStep, {
        outputRef: `classification:${classification.task_type}`
      });
      turn = addTurnStep(turn, completedClassifyStep);
      publish(eventBus, "agent:step", {
        turn_id: turn.id,
        step: completedClassifyStep,
        classification
      });

      lifecycle = transitionLifecycle(lifecycle, {
        to: "complete",
        reason: "V2-0 mock runtime completed",
        channel: "system"
      });

      const finalStep = completeAgentStep(createAgentStep({
        turnId: turn.id,
        type: "final",
        channel: "system"
      }));
      turn = addTurnStep(turn, finalStep);

      const response = modelGateway && typeof modelGateway.reply === "function"
        ? await modelGateway.reply({ message, classification, turn })
        : { content: `V2-0 mock ${classification.task_type} response` };

      turn = setTurnStatus(turn, "completed");
      publish(eventBus, "agent:final", {
        turn_id: turn.id,
        content: response.content,
        status: "complete"
      });

      lifecycle = transitionLifecycle(lifecycle, {
        to: "idle",
        reason: "turn complete",
        channel: null
      });
      activeTurn = null;

      return {
        status: "complete",
        state: "idle",
        content: response.content,
        turn
      };
    } catch (error) {
      lifecycle = transitionLifecycle(lifecycle, {
        to: "failed",
        reason: error.message,
        channel: lifecycle.channel
      });
      publish(eventBus, "agent:error", {
        turn_id: turn.id,
        message: error.message
      });
      activeTurn = null;
      throw error;
    }
  }

  function approve(approvalId, decision) {
    publish(eventBus, "approval:resolved", {
      approval_id: approvalId,
      decision
    });
  }

  function interrupt(turnId = null) {
    activeTurn = null;
    lifecycle = transitionLifecycle(lifecycle, {
      to: "idle",
      reason: turnId ? `turn interrupted: ${turnId}` : "interrupt requested",
      channel: null
    });
  }

  return { send, approve, interrupt, getState };
}
```

- [ ] **Step 4: Run the runtime tests**

Run:

```bash
node --test tests/unit/core/agent-runtime.test.js
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit mock runtime**

Run:

```bash
git add src/core/runtime/agent-runtime.js tests/unit/core/agent-runtime.test.js
git commit -m "feat(v2): add mock agent runtime"
```

---

### Task 6: Public Kernel Facade

**Files:**
- Create: `src/index.js`
- Test: `tests/integration/v2-kernel-facade.test.js`

- [ ] **Step 1: Write the failing kernel facade integration test**

Create `tests/integration/v2-kernel-facade.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createKernel } from "../../src/index.js";

test("v2 createKernel exposes agent, session, context, and config facades", async () => {
  const kernel = await createKernel(process.cwd(), {
    sessionId: "sess_integration",
    modelGateway: {
      reply: async () => ({ content: "facade response" })
    }
  });

  assert.equal(typeof kernel.agent.send, "function");
  assert.equal(typeof kernel.agent.approve, "function");
  assert.equal(typeof kernel.agent.interrupt, "function");
  assert.equal(typeof kernel.session.subscribe, "function");
  assert.equal(typeof kernel.session.getTimeline, "function");
  assert.equal(typeof kernel.context.snapshot, "function");
  assert.equal(typeof kernel.config.getPublicConfig, "function");
});

test("v2 kernel facade sends a turn and streams events to subscribers", async () => {
  const kernel = await createKernel(process.cwd(), {
    sessionId: "sess_integration",
    modelGateway: {
      reply: async ({ classification }) => ({
        content: `facade ${classification.task_type}`
      })
    }
  });

  const events = [];
  const sub = kernel.session.subscribe((event) => events.push(event));

  const result = await kernel.agent.send("what is this?", { autonomy: "auto" });
  sub.unsubscribe();

  assert.equal(result.content, "facade query");
  assert.ok(events.some((event) => event.type === "user:message"));
  assert.ok(events.some((event) => event.type === "agent:turn_started"));
  assert.ok(events.some((event) => event.type === "agent:step"));
  assert.ok(events.some((event) => event.type === "agent:final"));
});

test("v2 kernel context and config return safe public data", async () => {
  const kernel = await createKernel("C:/example/project", { sessionId: "sess_safe" });

  const snapshot = await kernel.context.snapshot();
  const publicConfig = kernel.config.getPublicConfig();

  assert.equal(snapshot.snapshot_id, "v2_empty_snapshot");
  assert.deepEqual(snapshot.units, []);
  assert.equal(publicConfig.runtime, "v2");
  assert.equal(publicConfig.has_api_key, false);
});
```

- [ ] **Step 2: Run the failing kernel facade test**

Run:

```bash
node --test tests/integration/v2-kernel-facade.test.js
```

Expected: FAIL with `Cannot find module` for `src/index.js`.

- [ ] **Step 3: Add the public kernel facade**

Create `src/index.js`:

```js
import { createEventBus } from "./shared/event-bus.js";
import { createAgentRuntime } from "./core/runtime/agent-runtime.js";
import { SESSION_EVENT_TYPES } from "./sessions/event-types.js";

export async function createKernel(root, options = {}) {
  const eventBus = options.eventBus || createEventBus();
  const sessionId = options.sessionId || `sess_${Date.now()}`;
  const runtime = createAgentRuntime({
    eventBus,
    sessionId,
    modelGateway: options.modelGateway || null
  });

  const session = {
    subscribe(handler) {
      if (typeof handler !== "function") {
        throw new Error("session subscriber must be a function");
      }

      const subscriptions = SESSION_EVENT_TYPES.map((type) =>
        eventBus.subscribe(type, (data, meta) => {
          handler({ type, ...data, meta });
        })
      );

      return {
        unsubscribe() {
          for (const sub of subscriptions) {
            sub.unsubscribe();
          }
        }
      };
    },

    async getTimeline() {
      return [];
    },

    async resume(resumeSessionId = sessionId) {
      eventBus.publish("session:resume", {
        session_id: resumeSessionId,
        root
      });
    }
  };

  const context = {
    async snapshot() {
      return {
        snapshot_id: "v2_empty_snapshot",
        root,
        units: [],
        budget: { allocated: 0, used: 0 }
      };
    },
    pin(path) {
      eventBus.publish("context:pin", { path });
    },
    unpin(path) {
      eventBus.publish("context:unpin", { path });
    }
  };

  const config = {
    getPublicConfig() {
      return {
        runtime: "v2",
        root,
        has_api_key: false
      };
    },
    updateProjectConfig() {
      throw new Error("project config updates are not available in V2-0");
    }
  };

  return {
    root,
    eventBus,
    runtime,
    agent: {
      send: runtime.send,
      approve: runtime.approve,
      interrupt: runtime.interrupt
    },
    session,
    context,
    config
  };
}
```

- [ ] **Step 4: Run the kernel facade test**

Run:

```bash
node --test tests/integration/v2-kernel-facade.test.js
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Commit kernel facade**

Run:

```bash
git add src/index.js tests/integration/v2-kernel-facade.test.js
git commit -m "feat(v2): add public kernel facade"
```

---

### Task 7: Script Integration and Full Regression

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Update package scripts**

Modify `package.json` scripts to include both existing `test/` and new `tests/` suites, and include the new v2 source files in `npm run check`.

Set the `scripts` object to:

```json
{
  "test": "node --test test/**/*.test.js tests/**/*.test.js",
  "check": "node --check bin/deepseek-code.js && node --check src/cli.js src/agent.js src/chat.js src/config.js src/context.js src/git.js src/patch.js src/changes.js src/provider.js src/search.js src/ui.js src/theme.js src/tui.js && node --check src/kernel/event-bus.js src/kernel/session-log.js src/kernel/config-provider.js src/kernel/kernel-api.js src/kernel/model-provider.js src/kernel/context-engine.js src/kernel/task-orchestrator.js src/kernel/permission-engine.js src/kernel/tool-registry.js src/kernel/session-manager.js && node --check src/index.js src/shared/id.js src/shared/time.js src/shared/event-bus.js src/core/protocol/agent-turn.js src/core/protocol/agent-step.js src/core/protocol/tool-call.js src/core/protocol/tool-result.js src/core/protocol/approval-request.js src/core/protocol/artifact.js src/core/protocol/index.js src/core/planning/classifier.js src/core/runtime/lifecycle.js src/core/runtime/agent-runtime.js src/sessions/event-types.js && node --check gui/main.js gui/preload.js gui/renderer/app.js"
}
```

- [ ] **Step 2: Run all v2 tests**

Run:

```bash
node --test tests/**/*.test.js
```

Expected: PASS with these v2 tests:

- `tests/unit/shared/event-bus.test.js`
- `tests/unit/core/protocol.test.js`
- `tests/unit/core/lifecycle.test.js`
- `tests/unit/core/agent-runtime.test.js`
- `tests/unit/sessions/event-types.test.js`
- `tests/integration/v2-kernel-facade.test.js`

- [ ] **Step 3: Run full regression**

Run:

```bash
npm.cmd test
```

Expected: PASS. Existing 130 tests plus the new V2-0 tests should pass.

- [ ] **Step 4: Run syntax check**

Run:

```bash
npm.cmd run check
```

Expected: PASS.

- [ ] **Step 5: Commit script integration**

Run:

```bash
git add package.json
git commit -m "chore(v2): include skeleton tests and checks"
```

---

## Final Verification

- [ ] **Step 1: Verify clean V2-0 regression**

Run:

```bash
npm.cmd test
npm.cmd run check
```

Expected:

- `npm.cmd test`: all tests pass.
- `npm.cmd run check`: exits with status 0.

- [ ] **Step 2: Verify git status**

Run:

```bash
git status --short
```

Expected:

- No unstaged V2-0 implementation files.
- Pre-existing unrelated user files may still appear and must not be reverted.

- [ ] **Step 3: Final commit if verification changed files**

If a formatting or script correction was needed during verification, commit only those V2-0 files:

```bash
git add package.json src/index.js src/shared src/core src/sessions tests/unit tests/integration
git commit -m "chore(v2): finalize skeleton protocol foundation"
```

If no files changed, do not create an empty commit.

## Handoff Notes

After this plan is executed, the next plan should be **V2-1 DeepSeek Gateway**. It will replace the current default JSON mode behavior with explicit JSON mode, add DeepSeek model routing, streaming parsing, usage tracking, FIM client scaffolding, and request-body tests for Flash/Pro/thinking/cache behavior.
