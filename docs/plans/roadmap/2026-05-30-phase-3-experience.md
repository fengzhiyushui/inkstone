# Phase 3: Experience Layer — Implementation Plan

> 完成状态以 [CHANGELOG](../../CHANGELOG.md) 为准。


**Goal:** Wire SessionLog into the kernel runtime (persist events, timeline query) and upgrade the TUI with event timeline + status bar. Full session resume/replay deferred to a follow-up.

**Architecture:** Session Manager bridges the EventBus to SessionLog — every kernel event is persisted to disk. The `resume` command replays events to reconstruct session state. The enhanced TUI adds a session timeline panel and real-time status bar, all within the existing readline framework (no new dependencies).

**Tech Stack:** Node.js >= 20 (ES modules), existing readline-based TUI, Phase 0 SessionLog, Phase 1 EventBus.

---

## File Structure

```
Create:
  src/kernel/session-manager.js       — Event persistence bridge + resume logic
  test/kernel/session-manager.test.js — Session Manager unit tests

Modify:
  src/kernel/kernel-api.js            — Wire session.subscribe to real persistence
  src/tui.js                          — Add timeline view + status bar
```

---

### Task 1: Session Manager

**Files:**
- Create: `src/kernel/session-manager.js`
- Create: `test/kernel/session-manager.test.js`
- Use: `src/kernel/session-log.js`, `src/kernel/event-bus.js`

#### Step 1: Write test file

```js
// test/kernel/session-manager.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createEventBus } from "../../src/kernel/event-bus.js";
import { createSessionLog } from "../../src/kernel/session-log.js";
import { createSessionManager } from "../../src/kernel/session-manager.js";

const tmpDir = path.join(os.tmpdir(), `dsc-sm-test-${Date.now()}`);

test.before(async () => {
  await fs.mkdir(tmpDir, { recursive: true });
});

test.after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("bridge persists EventBus events to SessionLog", async () => {
  const bus = createEventBus();
  const log = await createSessionLog(tmpDir, "test-project", "sess_sm_001", {
    mode: "cli", cwd: "/fake", git_commit: "abc", config_id: "cfg"
  });

  const manager = createSessionManager({ eventBus: bus, sessionLog: log });
  const sub = manager.bridge(["orchestrator:state", "user:message", "tool:call"]);

  bus.publish("orchestrator:state", {
    state: { entered: "thinkplan", exited: "classify" },
    transition: { reason: "test", autonomy: { level: "gated" }, channel: "think" },
    trace: { id: "trace_001", timestamp: new Date().toISOString() }
  });
  bus.publish("user:message", { content: "hello" });

  await sub.flush();

  const events = await log.tail(10);
  assert.ok(events.length >= 2);
  const types = events.map(e => e.type);
  assert.ok(types.includes("orchestrator:state"));
  assert.ok(types.includes("user:message"));
});

test("bridge ignores unsubscribed event types", async () => {
  const bus = createEventBus();
  const log = await createSessionLog(tmpDir, "test-project", "sess_sm_002", {
    mode: "cli", cwd: "/fake", git_commit: "abc", config_id: "cfg"
  });

  const manager = createSessionManager({ eventBus: bus, sessionLog: log });
  const sub = manager.bridge(["user:message"]);

  bus.publish("orchestrator:state", {
    state: { entered: "classify", exited: "idle" },
    transition: { reason: "test", autonomy: { level: "gated" }, channel: null },
    trace: { id: "trace_x", timestamp: new Date().toISOString() }
  });
  bus.publish("user:message", { content: "bridged" });

  await sub.flush();

  const events = await log.tail(10);
  const types = events.map(e => e.type);
  assert.ok(!types.includes("orchestrator:state"));
  assert.ok(types.includes("user:message"));
});

test("getTimeline returns events from log", async () => {
  const bus = createEventBus();
  const log = await createSessionLog(tmpDir, "test-project", "sess_sm_003", {
    mode: "cli", cwd: "/fake", git_commit: "abc", config_id: "cfg"
  });

  const manager = createSessionManager({ eventBus: bus, sessionLog: log });
  const sub = manager.bridge(["user:message"]);

  bus.publish("user:message", { content: "msg1" });
  bus.publish("user:message", { content: "msg2" });
  bus.publish("user:message", { content: "msg3" });

  await sub.flush();

  const timeline = await manager.getTimeline(2);
  assert.equal(timeline.length, 2);
  assert.equal(timeline[0].content, "msg2");
  assert.equal(timeline[1].content, "msg3");
});

test("getTimeline returns empty for no session", async () => {
  const bus = createEventBus();
  const manager = createSessionManager({ eventBus: bus, sessionLog: null });
  const timeline = await manager.getTimeline(10);
  assert.deepEqual(timeline, []);
});

test("shutdown stops bridging", async () => {
  const bus = createEventBus();
  const log = await createSessionLog(tmpDir, "test-project", "sess_sm_004", {
    mode: "cli", cwd: "/fake", git_commit: "abc", config_id: "cfg"
  });

  const manager = createSessionManager({ eventBus: bus, sessionLog: log });
  const sub = manager.bridge(["user:message"]);

  bus.publish("user:message", { content: "before" });
  await sub.flush();

  sub.unsubscribe();

  bus.publish("user:message", { content: "after" });
  // No flush needed — after unsubscribe, nothing should be bridged
  await new Promise(r => setTimeout(r, 20));

  const events = await log.tail(10);
  const contents = events.filter(e => e.type === "user:message").map(e => e.content);
  assert.ok(contents.includes("before"));
  assert.ok(!contents.includes("after"));
});
```

#### Step 2: Run tests to verify they fail

Run: `node --test test/kernel/session-manager.test.js`
Expected: FAIL — "Cannot find module"

#### Step 3: Create the module

```js
// src/kernel/session-manager.js

export function createSessionManager({ eventBus, sessionLog }) {

  function bridge(eventTypes) {
    if (!sessionLog) return { unsubscribe() {}, flush: async () => {} };

    let pending = 0;
    let resolveIdle;
    let idlePromise = Promise.resolve();

    const handlers = [];
    for (const eventType of eventTypes) {
      const sub = eventBus.subscribe(eventType, (data, meta) => {
        pending++;
        idlePromise = new Promise((r) => { resolveIdle = r; });
        sessionLog.append(eventType, data).then(() => {
          pending--;
          if (pending === 0 && resolveIdle) resolveIdle();
        }).catch((err) => {
          pending--;
          if (pending === 0 && resolveIdle) resolveIdle();
          console.error(`SessionManager: failed to persist ${eventType}: ${err.message}`);
        });
      });
      handlers.push(sub);
    }

    return {
      unsubscribe() {
        for (const h of handlers) h.unsubscribe();
      },
      async flush() {
        if (pending === 0) return;
        await idlePromise;
      }
    };
  }

  async function getTimeline(count = 20) {
    if (!sessionLog) return [];
    const events = await sessionLog.tail(count);
    return events;
  }

  return { bridge, getTimeline };
}
```

#### Step 4: Run tests

Run: `node --test test/kernel/session-manager.test.js`
Expected: all 5 tests PASS

#### Step 5: Commit

```bash
git add src/kernel/session-manager.js test/kernel/session-manager.test.js
git commit -m "feat(kernel): add Session Manager with event bridging and timeline"
```

---

### Task 2: Wire Session Manager into KernelAPI

**Files:**
- Modify: `src/kernel/kernel-api.js`

#### Step 1: Update kernel-api.js

Read the current file. Add Session Manager integration:

- Import `createSessionManager` and `createSessionLog`
- Create a SessionLog on kernel startup (one session per kernel instance)
- Bridge key event types (orchestrator:state, user:message, tool:call, tool:result, permission:decision)
- Replace the stub `session.subscribe` with real EventBus subscription
- Replace the stub `session.getTimeline` with real SessionLog query

```js
// Add imports at top:
import { createSessionManager } from "./session-manager.js";
import { createSessionLog, openSessionLog } from "./session-log.js";
import os from "node:os";
import path from "node:path";

// In createKernel(), after creating eventBus and config:
  // Initialize session persistence
  const sessionDir = path.join(os.homedir(), ".deepseek-code");
  const projectId = Buffer.from(root).toString("base64").slice(0, 16).replace(/[/+=]/g, "_");
  const sessionId = `sess_${Date.now()}`;
  
  let sessionLog = null;
  try {
    sessionLog = await createSessionLog(sessionDir, projectId, sessionId, {
      mode: "kernel",
      cwd: root,
      config_id: "cfg_v1"
    });
  } catch (err) {
    console.error(`SessionManager: failed to create session log: ${err.message}`);
  }

  // ... after creating orchestrator ...
  
  const sessionManager = createSessionManager({ eventBus, sessionLog });
  
  // Bridge essential events to persistent log
  sessionManager.bridge([
    "orchestrator:state",
    "user:message",
    "tool:call",
    "tool:result",
    "permission:decision"
  ]);

  // Replace session stub:
  const session = {
    subscribe(handler) {
      const eventTypes = ["orchestrator:state", "user:message", "tool:call", "tool:result", "permission:decision"];
      const unsubs = [];
      for (const eventType of eventTypes) {
        unsubs.push(eventBus.subscribe(eventType, (data) => {
          handler({ type: eventType, ...data });
        }));
      }
      return {
        unsubscribe() {
          for (const u of unsubs) u.unsubscribe();
        }
      };
    },

    async getTimeline(count = 20) {
      return sessionManager.getTimeline(count);
    },

    async resume() {
      eventBus.publish("session:resume", { timestamp: new Date().toISOString() });
    }
  };
```

#### Step 2: Syntax check

Run: `node --check src/kernel/kernel-api.js`
Expected: no output

#### Step 3: Commit

```bash
git add src/kernel/kernel-api.js
git commit -m "feat(kernel): wire Session Manager into KernelAPI with event persistence"
```

---

### Task 3: Enhanced TUI

**Files:**
- Modify: `src/tui.js`

#### Step 1: Add session timeline and status bar to existing TUI

The current TUI is a single-menu with direction keys. Enhance it to:

1. **Status bar**: Show autonomy level, current channel, token usage at bottom
2. **Session timeline**: After each action, show a compact event log (last 5 events)
3. **Output area**: Keep the existing pause-with-output pattern, but add token count display

Since we're staying with readline (no Ink dep), the enhancements are:

```js
// Add to the TUI module:

// --- Status Bar Helpers ---

function renderStatusBar(kernel) {
  const orchestrator = kernel.orchestrator;
  const state = orchestrator ? orchestrator.getState() : { current: "idle", autonomy: "gated", channel: null };
  
  const parts = [
    color.dim("│"),
    ` ${state.autonomy || "gated"} `,
    color.dim("│"),
    ` ${state.channel || "—"} `,
    color.dim("│"),
  ];

  // Token usage from model provider
  if (kernel.modelProvider) {
    const usage = kernel.modelProvider.getUsageStats();
    parts.push(` ${formatTokens(usage.total_prompt_tokens + usage.total_completion_tokens)} tokens `);
    parts.push(color.dim("│"));
    if (usage.requests > 0) {
      const hitRate = usage.cache_hit_tokens + usage.cache_miss_tokens > 0
        ? Math.round(usage.cache_hit_tokens / (usage.cache_hit_tokens + usage.cache_miss_tokens) * 100)
        : 0;
      parts.push(` cache ${hitRate}% `);
      parts.push(color.dim("│"));
    }
  }

  return parts.join("");
}

function formatTokens(n) {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

// --- Timeline Display ---

const timelineBuffer = [];

function recordTimelineEvent(event) {
  timelineBuffer.push({ time: new Date().toISOString(), ...event });
  if (timelineBuffer.length > 50) timelineBuffer.shift();
}

function renderTimeline(count = 5) {
  const recent = timelineBuffer.slice(-count);
  if (!recent.length) return "";
  
  return [
    "",
    color.dim("── Session Timeline ──"),
    ...recent.map(e => {
      const icon = eventIcon(e.type);
      const time = new Date(e.time).toLocaleTimeString();
      return color.dim(`${time} ${icon} ${eventSummary(e)}`);
    }),
  ].join("\n");
}

function eventIcon(type) {
  const icons = {
    "user:message": "💬",
    "orchestrator:state": "🔄",
    "tool:call": "🔧",
    "tool:result": "✓",
    "permission:decision": "🔐",
    "model:response": "🤖"
  };
  return icons[type] || "•";
}

function eventSummary(event) {
  if (event.type === "user:message") return event.content?.slice(0, 60) || "";
  if (event.type === "orchestrator:state") return `${event.state?.exited} → ${event.state?.entered}`;
  if (event.type === "tool:call") return `${event.tool}`;
  if (event.type === "permission:decision") return `${event.decision}`;
  return "";
}
```

#### Step 2: Integrate into runAction

After each action completes (both success and error paths), call:
- `recordTimelineEvent()` for each relevant event
- Display `renderTimeline()` before the status bar

In the main render loop, add the status bar and timeline before the message line.

#### Step 3: Update package.json check

Add `src/kernel/session-manager.js` to the check script.

#### Step 4: Run tests

Run: `node --test test/patch.test.js test/kernel/*.test.js`
Expected: all PASS (114 + 5 = 119)

#### Step 5: Run npm check

Run: `npm run check`
Expected: no output

#### Step 6: Commit

```bash
git add src/tui.js package.json
git commit -m "feat(tui): add session timeline and status bar with token/cache display"
```

---

### Phase 3 Completion Checklist

```
- [ ] src/kernel/session-manager.js created and tested (5 tests, using flush())
- [ ] src/kernel/kernel-api.js wired: session persistence + agent.send publishes user:message
- [ ] src/tui.js enhanced with timeline + status bar (accepts kernel via runTui(root, kernel))
- [ ] package.json "check" updated with session-manager.js
- [ ] npm run check passes
- [ ] All 119 tests pass
```

### Pre-Execution Notes (apply during implementation)

1. **agent.send() MUST publish user:message**: Before calling `orchestrator.submit()`, call `eventBus.publish("user:message", { content: message })`. This ensures user messages appear in the timeline and session log.

2. **TUI accepts kernel**: Change `runTui(root)` to `runTui(root, kernel)`. The main CLI entry point creates the kernel via `createKernel(root)` and passes it to both CLI and TUI paths. The TUI uses `kernel.orchestrator.getState()` for status bar info and `kernel.modelProvider.getUsageStats()` for token display. If no kernel is passed, TUI falls back to local state tracking.

3. **Bridge event types aligned**: Both `sessionManager.bridge()` and `session.subscribe()` must use the same event type list: `["orchestrator:state", "user:message", "tool:call", "tool:result", "permission:decision"]`.

4. **KernelAPI integration tests** (add to `test/kernel/session-manager.test.js`):
   - Test that `agent.send("hello")` publishes `user:message` on the EventBus
   - Test that `session.subscribe()` receives orchestrator state events after `agent.send()`
