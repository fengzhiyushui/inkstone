# V2-6 Release Closure Implementation Plan

> 完成状态以 [CHANGELOG](../../CHANGELOG.md) 为准。


**Goal:** Close the V2 migration by adding durable V2 session timeline persistence, release smoke tests, legacy boundary guards, and accurate user-facing documentation.

**Architecture:** V2 keeps one public kernel entry (`src/index.js`) and adds a clean `src/sessions` persistence layer instead of reusing `src/kernel/*`. CLI, TUI, and GUI remain thin clients; release tests prove migrated entrypoints do not fall back to old V1 kernel paths.

**Tech Stack:** Node.js >=20 ESM, built-in `node:test`, built-in `fs/path/crypto/child_process`, existing V2 event bus, no new runtime dependencies.

---

## Scope

V2-6 is a release-closure phase, not a new capability phase. It must make the current V2 runtime shippable and understandable without deleting legacy code.

In scope:

- Durable V2 session event log under `src/sessions`.
- `kernel.session.getTimeline(count)` and `kernel.session.flush()` backed by real persisted events.
- Offline smoke tests for CLI/kernel/GUI host release behavior.
- Boundary tests that prevent user-facing migrated interfaces from importing old `src/kernel/kernel-api.js`.
- README rewrite in clean UTF-8 Chinese with V2 architecture, usage, security invariants, and known limits.

Out of scope:

- Approval resume after `awaiting_approval`.
- Automatic repair re-entering the runtime loop.
- Moving `gui/` to `apps/gui/`.
- Deleting V0/V1 files.
- Exposing real GUI usage stats from the V2 DeepSeek usage tracker.

## File Structure

Create:

- `src/sessions/event-log.js`  
  Append-only JSONL event log for V2 session events. Owns record shape, hash chain, path sanitization, reserved field stripping, tail reads, and flush.
- `src/sessions/session-manager.js`  
  Bridges V2 `EventBus` events into `event-log`, exposes `subscribe`, `flush`, `getTimeline`, and `dispose`.
- `tests/unit/sessions/event-log.test.js`  
  Unit coverage for JSONL persistence, reserved field safety, ordering, hash chain, reopen behavior, and corrupt-line tolerance.
- `tests/unit/sessions/session-manager.test.js`  
  Unit coverage for bridge persistence, subscriber event type safety, flush, append failure isolation, and dispose.
- `tests/integration/v2-session-timeline.test.js`  
  Kernel integration proving `agent.send` persists a timeline.
- `tests/e2e/cli-smoke.test.js`  
  Black-box CLI smoke for test exit-code propagation plus offline kernel-runner ask smoke.
- `tests/integration/v2-interface-boundary.test.js`  
  Static boundary guard for migrated CLI/TUI/GUI imports.

Modify:

- `src/index.js`  
  Create and wire V2 session manager. Add `session.flush()` and real `session.getTimeline(count)`.
- `src/cli.js`  
  Remove unused legacy `askCommand` and `editCommand` import from `./agent.js`.
- `tests/integration/v2-kernel-facade.test.js`  
  Update fake-root test to disable persistence with `sessionLog: null`.
- `tests/unit/gui/kernel-host.test.js`  
  Add coverage that `getTimeline()` delegates to the V2 session facade and does not synthesize duplicate final events.
- `package.json`  
  Add `src/sessions/event-log.js` and `src/sessions/session-manager.js` to `npm run check`.
- `README.md`  
  Replace garbled/outdated V0/V1 text with V2 release documentation.

---

### Task 1: V2 Session Event Log

**Files:**
- Create: `src/sessions/event-log.js`
- Test: `tests/unit/sessions/event-log.test.js`

- [ ] **Step 1: Write failing tests for event log persistence**

Create `tests/unit/sessions/event-log.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createSessionEventLog,
  openSessionEventLog,
  projectIdFromRoot
} from "../../../src/sessions/event-log.js";

test("event log creates session start and strips reserved data fields", async () => {
  const sessionRoot = await mkdtemp(path.join(tmpdir(), "dsc-session-log-"));
  const log = await createSessionEventLog({
    sessionRoot,
    projectId: "proj:unsafe",
    sessionId: "sess/unsafe",
    meta: { root: "/repo", type: "payload_type", seq: 99 }
  });

  await log.append(
    "user:message",
    { content: "hello", type: "fake_type", seq: 777, event_hash: "bad" },
    { event_id: "evt_meta", timestamp: "2026-05-30T00:00:00.000Z" }
  );
  await log.flush();

  const events = await log.tail(10);
  assert.equal(events.length, 2);
  assert.equal(events[0].type, "session:start");
  assert.equal(events[0].session_id, "sess/unsafe");
  assert.equal(events[0].root, "/repo");
  assert.equal(events[0].seq, 1);
  assert.equal(events[1].type, "user:message");
  assert.equal(events[1].event_id, "evt_meta");
  assert.equal(events[1].timestamp, "2026-05-30T00:00:00.000Z");
  assert.equal(events[1].content, "hello");
  assert.equal(events[1].seq, 2);
  assert.equal(events[1].prev_hash, events[0].event_hash);
  assert.match(events[1].event_hash, /^sha256:/);
});

test("event log serializes concurrent appends in seq order", async () => {
  const sessionRoot = await mkdtemp(path.join(tmpdir(), "dsc-session-log-"));
  const log = await createSessionEventLog({ sessionRoot, projectId: "proj", sessionId: "sess" });

  await Promise.all([
    log.append("agent:step", { step: { id: "a" } }),
    log.append("agent:step", { step: { id: "b" } }),
    log.append("agent:step", { step: { id: "c" } })
  ]);
  await log.flush();

  const events = await log.tail(10);
  assert.deepEqual(events.map((event) => event.seq), [1, 2, 3, 4]);
  for (let index = 1; index < events.length; index += 1) {
    assert.equal(events[index].prev_hash, events[index - 1].event_hash);
  }
});

test("event log reopens existing file without duplicating session start", async () => {
  const sessionRoot = await mkdtemp(path.join(tmpdir(), "dsc-session-log-"));
  const first = await createSessionEventLog({ sessionRoot, projectId: "proj", sessionId: "sess" });
  await first.append("user:message", { content: "first" });
  await first.flush();

  const reopened = await openSessionEventLog({ sessionRoot, projectId: "proj", sessionId: "sess" });
  await reopened.append("agent:final", { content: "done" });
  await reopened.flush();

  const events = await reopened.tail(10);
  assert.deepEqual(events.map((event) => event.type), ["session:start", "user:message", "agent:final"]);
  assert.deepEqual(events.map((event) => event.seq), [1, 2, 3]);
});

test("event log tail skips corrupt jsonl lines", async () => {
  const sessionRoot = await mkdtemp(path.join(tmpdir(), "dsc-session-log-"));
  const log = await createSessionEventLog({ sessionRoot, projectId: "proj", sessionId: "sess" });
  await log.append("user:message", { content: "before" });
  await log.flush();
  await appendFile(log.filePath, "{not json}\n", "utf8");

  const reopened = await openSessionEventLog({ sessionRoot, projectId: "proj", sessionId: "sess" });
  await reopened.append("agent:final", { content: "after" });

  const events = await reopened.tail(10);
  assert.deepEqual(events.map((event) => event.type), ["session:start", "user:message", "agent:final"]);
});

test("projectIdFromRoot is stable and filesystem safe", () => {
  const first = projectIdFromRoot("D:\\person studio\\deepseek code");
  const second = projectIdFromRoot("D:\\person studio\\deepseek code");

  assert.equal(first, second);
  assert.match(first, /^proj_[a-f0-9]{12}$/);
});
```

- [ ] **Step 2: Run the failing test**

Run:

```powershell
npm.cmd test -- tests/unit/sessions/event-log.test.js
```

Expected: FAIL with module-not-found for `src/sessions/event-log.js`.

- [ ] **Step 3: Implement the event log**

Create `src/sessions/event-log.js`:

```js
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { makeId } from "../shared/id.js";
import { nowIso } from "../shared/time.js";

const SCHEMA_VERSION = 2;

const RESERVED_KEYS = new Set([
  "schema_version",
  "event_id",
  "prev_hash",
  "event_hash",
  "type",
  "timestamp",
  "seq",
  "session_id"
]);

export function projectIdFromRoot(root) {
  const normalized = path.resolve(String(root || process.cwd())).toLowerCase();
  return `proj_${createHash("sha256").update(normalized).digest("hex").slice(0, 12)}`;
}

export async function createSessionEventLog({ sessionRoot, projectId, sessionId, meta = {} } = {}) {
  assertLogOptions({ sessionRoot, projectId, sessionId });
  await fs.mkdir(sessionDirectory(sessionRoot, projectId), { recursive: true });
  const log = new SessionEventLog(sessionFilePath(sessionRoot, projectId, sessionId), sessionId);
  const existing = await readJsonl(log.filePath);
  if (existing.length > 0) {
    log.seq = Number(existing.at(-1).seq) || 0;
    log.lastHash = existing.at(-1).event_hash || null;
    return log;
  }
  await log.append("session:start", meta);
  return log;
}

export async function openSessionEventLog({ sessionRoot, projectId, sessionId } = {}) {
  assertLogOptions({ sessionRoot, projectId, sessionId });
  await fs.mkdir(sessionDirectory(sessionRoot, projectId), { recursive: true });
  const log = new SessionEventLog(sessionFilePath(sessionRoot, projectId, sessionId), sessionId);
  const existing = await readJsonl(log.filePath);
  const validEvents = existing.filter((event) => event && typeof event === "object");
  if (validEvents.length > 0) {
    log.seq = Number(validEvents.at(-1).seq) || 0;
    log.lastHash = validEvents.at(-1).event_hash || null;
  }
  return log;
}

class SessionEventLog {
  constructor(filePath, sessionId) {
    this.filePath = filePath;
    this.sessionId = sessionId;
    this.seq = 0;
    this.lastHash = null;
    this.queue = Promise.resolve();
  }

  append(type, data = {}, meta = {}) {
    if (!type || typeof type !== "string") {
      throw new Error("session event type must be a non-empty string");
    }
    const write = this.queue.then(async () => {
      const event = {
        schema_version: SCHEMA_VERSION,
        event_id: typeof meta.event_id === "string" ? meta.event_id : makeId("evt"),
        prev_hash: this.lastHash,
        event_hash: null,
        type,
        timestamp: typeof meta.timestamp === "string" ? meta.timestamp : nowIso(),
        seq: this.seq + 1,
        session_id: this.sessionId,
        ...stripReservedKeys(data)
      };
      event.event_hash = hashEvent(event);
      await fs.appendFile(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
      this.seq = event.seq;
      this.lastHash = event.event_hash;
      return event;
    });
    this.queue = write.catch(() => {});
    return write;
  }

  async flush() {
    await this.queue;
  }

  async tail(count = 20) {
    const safeCount = Number.isFinite(Number(count)) && Number(count) > 0 ? Number(count) : 20;
    const events = await readJsonl(this.filePath);
    return events.slice(-safeCount);
  }
}

function assertLogOptions({ sessionRoot, projectId, sessionId }) {
  if (!sessionRoot || typeof sessionRoot !== "string") throw new Error("sessionRoot is required");
  if (!projectId || typeof projectId !== "string") throw new Error("projectId is required");
  if (!sessionId || typeof sessionId !== "string") throw new Error("sessionId is required");
}

function sessionDirectory(sessionRoot, projectId) {
  return path.join(sessionRoot, sanitize(projectId));
}

function sessionFilePath(sessionRoot, projectId, sessionId) {
  return path.join(sessionDirectory(sessionRoot, projectId), `${sanitize(sessionId)}.jsonl`);
}

async function readJsonl(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const events = [];
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        // Ignore corrupt lines so one bad append does not hide the usable timeline.
      }
    }
    return events;
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function stripReservedKeys(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const cleaned = {};
  for (const [key, value] of Object.entries(data)) {
    if (!RESERVED_KEYS.has(key) && value !== undefined) cleaned[key] = value;
  }
  return cleaned;
}

function hashEvent(event) {
  const { event_hash, ...hashable } = jsonSafe(event);
  return `sha256:${createHash("sha256").update(stableStringify(hashable)).digest("hex").slice(0, 16)}`;
}

function jsonSafe(value) {
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(jsonSafe);
  const safe = {};
  for (const key of Object.keys(value)) {
    if (value[key] !== undefined) safe[key] = jsonSafe(value[key]);
  }
  return safe;
}

function stableStringify(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function sanitize(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
}
```

- [ ] **Step 4: Run the event log tests**

Run:

```powershell
npm.cmd test -- tests/unit/sessions/event-log.test.js
```

Expected: PASS, all tests in `event-log.test.js` pass.

- [ ] **Step 5: Commit Task 1**

```powershell
git add src/sessions/event-log.js tests/unit/sessions/event-log.test.js
git commit -m "feat(v2): add session event log"
```

---

### Task 2: V2 Session Manager

**Files:**
- Create: `src/sessions/session-manager.js`
- Test: `tests/unit/sessions/session-manager.test.js`

- [ ] **Step 1: Write failing tests for the session manager**

Create `tests/unit/sessions/session-manager.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createEventBus } from "../../../src/shared/event-bus.js";
import { createSessionManager } from "../../../src/sessions/session-manager.js";

test("session manager subscribes to events without allowing payload type overwrite", () => {
  const eventBus = createEventBus();
  const session = createSessionManager({ eventBus, eventLog: null });
  const events = [];
  const sub = session.subscribe((event) => events.push(event));

  eventBus.publish("agent:final", { content: "done", type: "fake" });
  sub.unsubscribe();

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "agent:final");
  assert.equal(events[0].content, "done");
});

test("session manager persists bridged events and flush waits for writes", async () => {
  const eventBus = createEventBus();
  const writes = [];
  const eventLog = {
    append: async (type, data, meta) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      writes.push({ type, data, meta });
    },
    flush: async () => {},
    tail: async (count) => writes.slice(-count).map((entry) => ({ type: entry.type, ...entry.data }))
  };
  const session = createSessionManager({ eventBus, eventLog });

  eventBus.publish("user:message", { content: "hi" });
  eventBus.publish("agent:final", { content: "done" });
  await session.flush();

  assert.deepEqual(writes.map((write) => write.type), ["user:message", "agent:final"]);
  const timeline = await session.getTimeline(2);
  assert.deepEqual(timeline.map((event) => event.type), ["user:message", "agent:final"]);
});

test("session manager isolates persistence failures from live subscribers", async () => {
  const eventBus = createEventBus();
  const errors = [];
  const events = [];
  const session = createSessionManager({
    eventBus,
    eventLog: {
      append: async () => { throw new Error("disk full"); },
      flush: async () => {},
      tail: async () => []
    },
    onError: (error, type) => errors.push(`${type}:${error.message}`)
  });
  const sub = session.subscribe((event) => events.push(event));

  eventBus.publish("user:message", { content: "hi" });
  await session.flush();
  sub.unsubscribe();

  assert.deepEqual(errors, ["user:message:disk full"]);
  assert.equal(events[0].type, "user:message");
});

test("session manager dispose stops bridge writes", async () => {
  const eventBus = createEventBus();
  const writes = [];
  const session = createSessionManager({
    eventBus,
    eventLog: {
      append: async (type) => writes.push(type),
      flush: async () => {},
      tail: async () => []
    }
  });

  eventBus.publish("user:message", { content: "before" });
  await session.flush();
  session.dispose();
  eventBus.publish("agent:final", { content: "after" });
  await session.flush();

  assert.deepEqual(writes, ["user:message"]);
});
```

- [ ] **Step 2: Run the failing tests**

Run:

```powershell
npm.cmd test -- tests/unit/sessions/session-manager.test.js
```

Expected: FAIL with module-not-found for `src/sessions/session-manager.js`.

- [ ] **Step 3: Implement the session manager**

Create `src/sessions/session-manager.js`:

```js
import { SESSION_EVENT_TYPES } from "./event-types.js";

export function createSessionManager({
  eventBus,
  eventLog = null,
  eventTypes = SESSION_EVENT_TYPES,
  onError = defaultOnError
} = {}) {
  if (!eventBus || typeof eventBus.subscribe !== "function") {
    throw new Error("eventBus with subscribe() is required");
  }

  const pending = new Set();
  const bridgeSubscriptions = eventLog
    ? eventTypes.map((type) => eventBus.subscribe(type, (data, meta) => {
        const write = eventLog.append(type, data, meta).catch((error) => {
          try {
            onError(error, type);
          } catch {
            // Error handlers must not break runtime event flow.
          }
        });
        pending.add(write);
        write.finally(() => pending.delete(write));
      }))
    : [];

  function subscribe(handler) {
    if (typeof handler !== "function") throw new Error("session subscriber must be a function");
    const subscriptions = eventTypes.map((type) => eventBus.subscribe(type, (data, meta) => {
      handler({ ...data, type, meta });
    }));
    return {
      unsubscribe() {
        for (const sub of subscriptions) sub.unsubscribe();
      }
    };
  }

  async function flush() {
    while (pending.size > 0) {
      await Promise.allSettled([...pending]);
    }
    if (eventLog && typeof eventLog.flush === "function") {
      await eventLog.flush();
    }
  }

  async function getTimeline(count = 20) {
    if (!eventLog || typeof eventLog.tail !== "function") return [];
    await flush();
    return eventLog.tail(count);
  }

  function dispose() {
    for (const sub of bridgeSubscriptions) sub.unsubscribe();
  }

  return { subscribe, flush, getTimeline, dispose };
}

function defaultOnError(error, type) {
  console.error(`SessionManager: failed to persist ${type}: ${error.message}`);
}
```

- [ ] **Step 4: Run the session manager tests**

Run:

```powershell
npm.cmd test -- tests/unit/sessions/session-manager.test.js
```

Expected: PASS, all tests in `session-manager.test.js` pass.

- [ ] **Step 5: Commit Task 2**

```powershell
git add src/sessions/session-manager.js tests/unit/sessions/session-manager.test.js
git commit -m "feat(v2): add session manager"
```

---

### Task 3: Wire V2 Kernel Session Persistence

**Files:**
- Modify: `src/index.js`
- Modify: `tests/integration/v2-kernel-facade.test.js`
- Test: `tests/integration/v2-session-timeline.test.js`

- [ ] **Step 1: Write failing integration tests for real timeline persistence**

Create `tests/integration/v2-session-timeline.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createKernel } from "../../src/index.js";

test("kernel session timeline persists events from an agent turn", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-v2-session-"));
  const sessionRoot = path.join(root, ".sessions");
  const kernel = await createKernel(root, {
    sessionRoot,
    sessionId: "sess_timeline",
    modelGateway: {
      reply: async () => ({ content: "timeline response" })
    }
  });

  const result = await kernel.agent.send("what is this?", { autonomy: "auto" });
  await kernel.session.flush();
  const timeline = await kernel.session.getTimeline(20);

  assert.equal(result.status, "complete");
  assert.ok(timeline.some((event) => event.type === "session:start"));
  assert.ok(timeline.some((event) => event.type === "user:message" && event.content === "what is this?"));
  assert.ok(timeline.some((event) => event.type === "agent:turn_started"));
  assert.ok(timeline.some((event) => event.type === "agent:step"));
  assert.ok(timeline.some((event) => event.type === "agent:final" && event.content === "timeline response"));
});

test("kernel session timeline can reopen an existing session", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-v2-session-"));
  const sessionRoot = path.join(root, ".sessions");
  const first = await createKernel(root, {
    sessionRoot,
    sessionId: "sess_reopen",
    modelGateway: { reply: async () => ({ content: "first" }) }
  });
  await first.agent.send("first question", { autonomy: "auto" });
  await first.session.flush();

  const second = await createKernel(root, {
    sessionRoot,
    sessionId: "sess_reopen",
    modelGateway: { reply: async () => ({ content: "second" }) }
  });
  await second.agent.send("second question", { autonomy: "auto" });
  await second.session.flush();

  const timeline = await second.session.getTimeline(50);
  assert.equal(timeline.filter((event) => event.type === "session:start").length, 1);
  assert.ok(timeline.some((event) => event.type === "user:message" && event.content === "first question"));
  assert.ok(timeline.some((event) => event.type === "user:message" && event.content === "second question"));
  assert.ok(timeline.at(-1).seq > 1);
});
```

Update `tests/integration/v2-kernel-facade.test.js` so the fake Windows-style root test does not try to create a session directory on `C:`:

```js
test("v2 kernel context and config return safe public data", async () => {
  const kernel = await createKernel("C:/example/project", {
    sessionId: "sess_safe",
    sessionLog: null
  });

  const snapshot = await kernel.context.snapshot();
  const publicConfig = kernel.config.getPublicConfig();

  assert.equal(snapshot.snapshot_id, "v2_empty_snapshot");
  assert.deepEqual(snapshot.units, []);
  assert.equal(publicConfig.runtime, "v2");
  assert.equal(publicConfig.has_api_key, false);
});
```

- [ ] **Step 2: Run the failing integration tests**

Run:

```powershell
npm.cmd test -- tests/integration/v2-session-timeline.test.js tests/integration/v2-kernel-facade.test.js
```

Expected: FAIL because `kernel.session.getTimeline()` still returns `[]` and `session.flush()` does not exist.

- [ ] **Step 3: Wire session manager into `src/index.js`**

Modify `src/index.js` imports:

```js
import path from "node:path";
import { createEventBus } from "./shared/event-bus.js";
import { createAgentRuntime } from "./core/runtime/agent-runtime.js";
import { SESSION_EVENT_TYPES } from "./sessions/event-types.js";
import { createSessionEventLog, projectIdFromRoot } from "./sessions/event-log.js";
import { createSessionManager } from "./sessions/session-manager.js";
```

Add this after `const sessionId = options.sessionId || ...`:

```js
  const projectId = options.projectId || projectIdFromRoot(root);
  const sessionRoot = options.sessionRoot || path.join(root, ".deepseek-code", "v2", "sessions");
  const sessionLog = options.sessionLog === null
    ? null
    : options.sessionLog || await createSessionEventLog({
        sessionRoot,
        projectId,
        sessionId,
        meta: { root, runtime: "v2" }
      });
  const sessionManager = options.sessionManager || createSessionManager({
    eventBus,
    eventLog: sessionLog,
    eventTypes: SESSION_EVENT_TYPES
  });
```

Replace the current `session` facade in `src/index.js` with:

```js
  const session = {
    subscribe: sessionManager.subscribe,
    getTimeline: sessionManager.getTimeline,
    flush: sessionManager.flush,
    async resume(id = sessionId) {
      eventBus.publish("session:resume", { session_id: id, root });
      await sessionManager.flush();
    },
    dispose: sessionManager.dispose
  };
```

Add `sessionManager` to the returned kernel object so GUI/TUI cleanup can call it if needed:

```js
    sessionManager,
```

- [ ] **Step 4: Run the timeline integration tests**

Run:

```powershell
npm.cmd test -- tests/integration/v2-session-timeline.test.js tests/integration/v2-kernel-facade.test.js
```

Expected: PASS, timeline contains persisted V2 events.

- [ ] **Step 5: Commit Task 3**

```powershell
git add src/index.js tests/integration/v2-kernel-facade.test.js tests/integration/v2-session-timeline.test.js
git commit -m "feat(v2): persist kernel session timeline"
```

---

### Task 4: Release Smoke Tests and Legacy Boundary Guards

**Files:**
- Create: `tests/e2e/cli-smoke.test.js`
- Create: `tests/integration/v2-interface-boundary.test.js`
- Modify: `tests/unit/gui/kernel-host.test.js`
- Modify: `src/cli.js`

- [ ] **Step 1: Write CLI release smoke tests**

Create `tests/e2e/cli-smoke.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runKernelAgentCommand } from "../../src/apps/cli/kernel-runner.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const binPath = path.join(repoRoot, "bin", "deepseek-code.js");

test("CLI test command propagates child process exit code", () => {
  const child = spawnSync(
    process.execPath,
    [binPath, "test", process.execPath, "-e", "process.exit(7)"],
    { cwd: repoRoot, encoding: "utf8" }
  );

  assert.equal(child.status, 7, `stdout:\n${child.stdout}\nstderr:\n${child.stderr}`);
});

test("CLI ask runner can complete offline without JSON mode failure", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-cli-ask-"));
  const lines = [];
  const result = await runKernelAgentCommand({
    root,
    prompt: "你好",
    write: (line) => lines.push(line),
    createKernelImpl: async () => ({
      session: {
        subscribe(handler) {
          handler({ type: "agent:final", content: "你好，我是 DeepSeek Code。" });
          return { unsubscribe() {} };
        }
      },
      agent: {
        send: async () => ({ status: "complete", content: "你好，我是 DeepSeek Code。" })
      }
    })
  });

  assert.equal(result.status, "complete");
  assert.equal(lines.some((line) => /response_format|json_object|Prompt must contain/i.test(line)), false);
  assert.ok(lines.some((line) => line.includes("你好，我是 DeepSeek Code。")));
});
```

- [ ] **Step 2: Write interface boundary tests**

Create `tests/integration/v2-interface-boundary.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function source(file) {
  return readFile(file, "utf8");
}

test("migrated CLI ask edit test entrypoints use V2 kernel runner", async () => {
  const cli = await source("src/cli.js");

  assert.match(cli, /runKernelAgentCommand/);
  assert.match(cli, /runKernelTestCommand/);
  assert.doesNotMatch(cli, /askCommand/);
  assert.doesNotMatch(cli, /editCommand/);
  assert.doesNotMatch(cli, /from "\.\/agent\.js"/);
});

test("TUI and GUI host do not import the old V1 kernel api", async () => {
  const tui = await source("src/tui.js");
  const guiMain = await source("gui/main.js");
  const guiHost = await source("gui/kernel-host.js");

  assert.match(tui, /from "\.\/index\.js"/);
  assert.doesNotMatch(tui, /kernel-api/);
  assert.doesNotMatch(guiMain, /src[\\/]+kernel[\\/]+kernel-api|kernel-api/);
  assert.doesNotMatch(guiHost, /src[\\/]+kernel[\\/]+kernel-api|kernel-api/);
});
```

- [ ] **Step 3: Add GUI host timeline delegation test**

Append this test to `tests/unit/gui/kernel-host.test.js`:

```js
test("kernel host delegates timeline to V2 session facade", async () => {
  const host = createKernelHost({
    projectRoot: "/repo",
    kernelFactory: async () => ({
      session: {
        subscribe: () => ({ unsubscribe() {} }),
        getTimeline: async (count) => [{ type: "agent:final", count }]
      },
      agent: { send: async () => ({ status: "complete" }), approve: () => {}, interrupt: () => {} },
      context: { snapshot: async () => ({ units: [] }) },
      config: { getPublicConfig: () => ({ runtime: "v2" }) },
      runtime: { getState: () => ({ current: "idle", channel: null }) }
    })
  });

  await host.init();
  assert.deepEqual(await host.getTimeline(3), [{ type: "agent:final", count: 3 }]);
});
```

- [ ] **Step 4: Run tests and observe boundary failure**

Run:

```powershell
npm.cmd test -- tests/e2e/cli-smoke.test.js tests/integration/v2-interface-boundary.test.js tests/unit/gui/kernel-host.test.js
```

Expected: FAIL because `src/cli.js` still imports `askCommand` and `editCommand` from `./agent.js`.

- [ ] **Step 5: Remove unused legacy CLI imports**

Modify the top of `src/cli.js` from:

```js
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { askCommand, editCommand } from "./agent.js";
```

to:

```js
import { promises as fs } from "node:fs";
import path from "node:path";
```

Do not remove `chatCommand`, `searchProject`, `changes`, or rollback imports in V2-6. Those commands are still compatibility paths.

- [ ] **Step 6: Run release smoke and boundary tests**

Run:

```powershell
npm.cmd test -- tests/e2e/cli-smoke.test.js tests/integration/v2-interface-boundary.test.js tests/unit/gui/kernel-host.test.js
```

Expected: PASS, CLI smoke exits as expected and migrated interfaces stay on V2 paths.

- [ ] **Step 7: Commit Task 4**

```powershell
git add src/cli.js tests/e2e/cli-smoke.test.js tests/integration/v2-interface-boundary.test.js tests/unit/gui/kernel-host.test.js
git commit -m "test(v2): add release smoke and boundary guards"
```

---

### Task 5: README Release Rewrite

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace README with clean V2 documentation**

Replace `README.md` with this UTF-8 Chinese content:

```markdown
# DeepSeek Code

DeepSeek Code 是一个面向 DeepSeek 的本地编程 Agent。它提供 CLI、TUI 和 Electron GUI 三种入口，并通过同一个 V2 Kernel 完成模型调用、工具执行、编辑应用、测试验证、权限控制和会话事件记录。

## 当前状态

V2 已经成为主要运行路径：

- `deepseek-code ask` 使用 V2 runtime。
- `deepseek-code edit` 使用 V2 runtime、V2 tool plane 和 V2 edit service。
- `deepseek-code test` 使用 V2 test tool，并传播真实退出码。
- TUI 和 GUI 订阅 V2 session events。
- Legacy 命令仍保留：`chat`、`scan`、`search`、`diff`、`config`、`changes`、`rollback`、`resume`。

运行验证：

```powershell
npm.cmd test
npm.cmd run check
git diff --check
```

## 快速开始

```powershell
npm install
node ./bin/deepseek-code.js help
```

配置 DeepSeek API Key：

```powershell
$env:DEEPSEEK_API_KEY="sk-..."
```

或写入项目配置：

```powershell
node ./bin/deepseek-code.js config init --api-key sk-...
```

常用命令：

```powershell
node ./bin/deepseek-code.js ask "解释这个项目的架构"
node ./bin/deepseek-code.js edit "修复 README 中的拼写问题" --dry-run
node ./bin/deepseek-code.js edit "修复 README 中的拼写问题" --yes
node ./bin/deepseek-code.js test
node ./bin/deepseek-code.js tui
```

GUI：

```powershell
cd gui
npm install
npm start
```

## V2 架构

```text
CLI / TUI / GUI
  -> src/index.js createKernel()
  -> src/core/runtime
  -> src/deepseek
  -> src/tools
  -> src/edits
  -> src/sessions
  -> src/workspace / src/security / src/shared
```

关键原则：

- 一个 Agent runtime。
- 一个 ToolExecutor 执行路径。
- 一个 EditService 编辑和回滚路径。
- 一个 V2 session timeline。
- UI 只负责输入、展示和审批，不拥有 agent 业务逻辑。

## DeepSeek 适配

`src/deepseek/` 负责 DeepSeek 专属协议：

- 模型路由：reply、act、plan、review、repair、fim。
- JSON mode guard：只有明确要求 JSON 的结构化调用才启用 `response_format`。
- SSE streaming parser。
- tool call normalization 和安全 JSON parse。
- usage tracker：token、reasoning token、cache hit/miss、latency。
- FIM client 使用 `deepseek-v4-pro`。

## 工具平面

V2 内置工具包括：

- 文件：`read`、`ls`、`grep`、`glob`
- 编辑：`diff_preview`、`diff_apply`、`diff_rollback`、`edit`
- 进程：`shell`、`test`、`git`
- 网络和记忆：`web_fetch`、`memory`
- 协作：`task`、`ask_user`

工具执行顺序固定：

```text
ToolCall
  -> schema validation
  -> parameter normalization
  -> permission decision
  -> approval if required
  -> execution
  -> result redaction
  -> tool result event
  -> model feedback
```

## 编辑与回滚

V2 复用成熟的 legacy diff pipeline，并通过 `src/edits/` 暴露成服务：

- `preview(diff)`：解析 diff 并生成摘要，不写文件。
- `apply({ diff, prompt, approval_id })`：预检路径、创建快照、应用 diff、记录 change id。
- `rollback(change_id)`：回滚指定变更。
- `describe(change_id)` / `list({ limit })`：查看变更记录。

## 安全不变量

- 文件路径使用 realpath 检查 workspace 边界，防止 symlink 逃逸。
- 工具 category 只信任注册表定义，不信任模型传入字段。
- destructive 操作永不被 trust rule 自动放行。
- shell 只接受结构化 argv，并使用 `shell:false`。
- `web_fetch` 阻断 localhost、私网、link-local、IPv4-mapped IPv6、IPv6 literal，并在每一跳 redirect 后重新校验。
- secret 输出会被 redaction。
- GUI 使用 `nodeIntegration:false`、`contextIsolation:true`、`sandbox:true` 和 IPC whitelist。

## 会话时间线

V2 session timeline 记录以下事件：

- `session:start`
- `session:resume`
- `user:message`
- `agent:turn_started`
- `agent:step`
- `model:request`
- `model:response`
- `tool:call`
- `tool:result`
- `permission:decision`
- `approval:requested`
- `approval:resolved`
- `file:diff_preview`
- `file:diff_applied`
- `file:rollback_applied`
- `verification:result`
- `agent:final`
- `agent:error`

默认存储位置是项目内 `.deepseek-code/v2/sessions/`。测试可以通过 `createKernel(root, { sessionRoot })` 注入临时目录。

## 已知限制

- 审批恢复流程尚未贯通：当前可以进入 `awaiting_approval`，批准后继续同一轮 tool loop 仍未实现。
- verifier 当前以 detect-only 为主，不默认运行完整测试套件。
- verification repair 会终止当前 turn，不会自动重新进入修复循环。
- V2 context snapshot 仍是最小实现。
- GUI usage stats 当前可能显示零值，真实 usage tracker 尚未接入 GUI 状态栏。
- legacy 文件仍保留，用于兼容未迁移命令和旧变更记录。

## 目录导览

```text
src/
  core/        Agent lifecycle, protocol, execution loop, verification
  deepseek/    DeepSeek model gateway, router, JSON mode, streaming, FIM
  tools/       Tool registry, schema, executor, permissions, builtin tools
  edits/       Diff preview/apply/rollback service
  sessions/    V2 event types, event log, session manager
  workspace/   Path safety and workspace guards
  security/    Shell policy, SSRF guard, redaction
  apps/        CLI runner/render helpers
  shared/      ID, time, event bus helpers
gui/           Electron shell and renderer
tests/         Unit, integration, and e2e tests
```
```

- [ ] **Step 2: Verify README has no mojibake**

Run:

```powershell
rg "�|鈥|鍛|俙|鏈|涓" README.md
```

Expected: no matches.

- [ ] **Step 3: Commit Task 5**

```powershell
git add README.md
git commit -m "docs: rewrite readme for v2 release"
```

---

### Task 6: Package Check and Full Regression

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add new session files to syntax check**

In `package.json`, update the `check` script segment that currently contains:

```json
"src/sessions/event-types.js"
```

to include:

```json
"src/sessions/event-types.js src/sessions/event-log.js src/sessions/session-manager.js"
```

Keep the rest of the command unchanged.

- [ ] **Step 2: Run targeted session tests**

Run:

```powershell
npm.cmd test -- tests/unit/sessions/event-log.test.js tests/unit/sessions/session-manager.test.js tests/integration/v2-session-timeline.test.js
```

Expected: command exits 0 and reports `fail 0`.

- [ ] **Step 3: Run release smoke tests**

Run:

```powershell
npm.cmd test -- tests/e2e/cli-smoke.test.js tests/integration/v2-interface-boundary.test.js tests/unit/gui/kernel-host.test.js
```

Expected: command exits 0 and reports `fail 0`.

- [ ] **Step 4: Run full regression**

Run:

```powershell
npm.cmd test
```

Expected: command exits 0 and reports `fail 0`.

- [ ] **Step 5: Run syntax check**

Run:

```powershell
npm.cmd run check
```

Expected: command exits 0 and every `node --check` segment succeeds.

- [ ] **Step 6: Run whitespace check**

Run:

```powershell
git diff --check
```

Expected: command exits 0 with no whitespace errors.

- [ ] **Step 7: Commit Task 6**

```powershell
git add package.json
git commit -m "chore(v2): include release closure checks"
```

- [ ] **Step 8: Record final release closure summary**

Run:

```powershell
git log --oneline -8
git status --short
```

Expected:

- The latest commits include the six V2-6 commits from this plan.
- `git status --short` may still show pre-existing user-local files such as `.deepseek-code/`, `.tmp-memory-test/`, `gui/node_modules/`, or `gui/package-lock.json`; do not stage those unless the user explicitly asks.

---

## Final Acceptance Criteria

V2-6 is accepted when all of these are true:

- `kernel.session.getTimeline(count)` returns persisted V2 events, not an empty array.
- `kernel.session.flush()` waits for fire-and-forget event persistence.
- `agent.send()` timeline includes `session:start`, `user:message`, `agent:turn_started`, `agent:step`, and `agent:final`.
- Reopening the same `{ sessionRoot, projectId, sessionId }` continues the JSONL log without duplicating `session:start`.
- CLI `test` black-box smoke propagates a child exit code.
- CLI ask runner can complete through an injected offline V2 kernel without JSON mode failure text.
- GUI host does not emit duplicate `agent:result` final messages.
- Migrated CLI/TUI/GUI entrypoints do not import `src/kernel/kernel-api.js`.
- README is readable UTF-8 Chinese and accurately describes V2 state and known limits.
- `npm.cmd test`, `npm.cmd run check`, and `git diff --check` all exit 0.

## Implementation Notes

- Do not stage or delete unrelated dirty files:
  - `.claude/settings.local.json`
  - `.deepseek-code/config.json`
  - `.deepseek-code/chat.json`
  - `.tmp-memory-test/`
  - `docs/plans/roadmap/2026-05-30-phase-4-gui.md`
  - `docs/plans/roadmap/2026-05-30-phase-5-polish.md`
  - `gui/node_modules/`
  - `gui/package-lock.json`
- Use `npm.cmd` on Windows PowerShell.
- Keep V2 session code in `src/sessions`; do not import `src/kernel/session-log.js` or `src/kernel/session-manager.js`.
- Keep user-facing migrated interfaces pointed at `src/index.js`.
- If a test needs a fake project root, pass `sessionLog: null` or `sessionRoot` pointing at a temp directory.
