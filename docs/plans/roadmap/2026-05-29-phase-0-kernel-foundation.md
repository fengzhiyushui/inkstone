# Phase 0: Kernel Foundation — Implementation Plan

> 完成状态以 [CHANGELOG](../../CHANGELOG.md) 为准。


**Goal:** Build the minimal kernel foundation — EventBus, SessionLog, KernelAPI, and ConfigProvider with ModelProfile — that all later phases depend on. Zero breaking changes to existing CLI flow.

**Architecture:** Four independent kernel modules under `src/kernel/`, each testable in isolation. EventBus provides typed publish/subscribe for inter-module communication. SessionLog writes append-only JSONL with schema version and SHA-256 hash chaining. KernelAPI defines the public interface contract. ConfigProvider extends the existing `src/config.js` with ModelProfile support.

**Tech Stack:** Node.js >= 20 (ES modules), `node:events`, `node:crypto`, `node:path`, `node:fs/promises`, `node:test` + `node:assert/strict`.

---

## File Structure

```
Create:
  src/kernel/event-bus.js          — Typed EventBus (publish/subscribe)
  src/kernel/session-log.js        — Append-only JSONL + hash chain
  src/kernel/kernel-api.js         — Kernel public interface definition
  src/kernel/config-provider.js    — Enhanced config with ModelProfile
  test/kernel/event-bus.test.js    — EventBus unit tests
  test/kernel/session-log.test.js  — SessionLog unit tests
  test/kernel/config-provider.test.js — ConfigProvider unit tests

Modify:
  src/config.js                    — Add ModelProfile export, keep backward compat
  package.json                     — Add "check:kernel" script entry
```

---

### Task 1: EventBus

**Files:**
- Create: `src/kernel/event-bus.js`
- Create: `test/kernel/event-bus.test.js`

- [ ] **Step 1: Write the EventBus test file**

```js
// test/kernel/event-bus.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { createEventBus } from "../src/kernel/event-bus.js";

test("subscribe receives published events", () => {
  const bus = createEventBus();
  const received = [];
  bus.subscribe("test:event", (data) => received.push(data));
  bus.publish("test:event", { value: 42 });
  assert.equal(received.length, 1);
  assert.equal(received[0].value, 42);
});

test("unsubscribe stops receiving events", () => {
  const bus = createEventBus();
  const received = [];
  const sub = bus.subscribe("test:event", (data) => received.push(data));
  sub.unsubscribe();
  bus.publish("test:event", { value: 1 });
  assert.equal(received.length, 0);
});

test("multiple subscribers on same event type all receive", () => {
  const bus = createEventBus();
  let a = 0, b = 0;
  bus.subscribe("e", () => a++);
  bus.subscribe("e", () => b++);
  bus.publish("e", {});
  assert.equal(a, 1);
  assert.equal(b, 1);
});

test("publish to event with no subscribers does not throw", () => {
  const bus = createEventBus();
  assert.doesNotThrow(() => bus.publish("no.listeners", {}));
});

test("once receives event exactly once then auto-unsubscribes", () => {
  const bus = createEventBus();
  const received = [];
  bus.once("once:event", (data) => received.push(data));
  bus.publish("once:event", { first: true });
  bus.publish("once:event", { second: true });
  assert.equal(received.length, 1);
  assert.equal(received[0].first, true);
});

test("different event types are isolated", () => {
  const bus = createEventBus();
  const typeA = [];
  const typeB = [];
  bus.subscribe("a", (d) => typeA.push(d));
  bus.subscribe("b", (d) => typeB.push(d));
  bus.publish("a", { n: 1 });
  assert.equal(typeA.length, 1);
  assert.equal(typeB.length, 0);
});

test("events carry timestamp and event_id", () => {
  const bus = createEventBus();
  const events = [];
  bus.subscribe("typed", (data, meta) => events.push(meta));
  bus.publish("typed", { x: 1 });
  assert.equal(events.length, 1);
  assert.ok(typeof events[0].timestamp === "string");
  assert.ok(events[0].event_id.startsWith("evt_"));
  assert.ok(events[0].event_type === "typed");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/kernel/event-bus.test.js`
Expected: FAIL — "Cannot find module" (file does not exist yet)

- [ ] **Step 3: Create the EventBus module**

```js
// src/kernel/event-bus.js
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

export function createEventBus() {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(200);

  function publish(eventType, data) {
    const meta = {
      event_id: `evt_${randomUUID().slice(0, 12)}`,
      event_type: eventType,
      timestamp: new Date().toISOString()
    };
    emitter.emit(eventType, data, meta);
  }

  function subscribe(eventType, handler) {
    emitter.on(eventType, handler);
    return {
      unsubscribe() {
        emitter.off(eventType, handler);
      }
    };
  }

  function once(eventType, handler) {
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/kernel/event-bus.test.js`
Expected: all 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/kernel/event-bus.js test/kernel/event-bus.test.js
git commit -m "feat(kernel): add EventBus with typed publish/subscribe"
```

---

### Task 2: SessionLog

**Files:**
- Create: `src/kernel/session-log.js`
- Create: `test/kernel/session-log.test.js`
- Use: `src/kernel/event-bus.js` (import)

- [ ] **Step 1: Write the SessionLog test file**

```js
// test/kernel/session-log.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createSessionLog, openSessionLog } from "../src/kernel/session-log.js";

const tmpDir = path.join(os.tmpdir(), `dsc-test-${Date.now()}`);

test.before(async () => {
  await fs.mkdir(tmpDir, { recursive: true });
});

test.after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("creates a new session log with session:start event", async () => {
  const log = await createSessionLog(tmpDir, "test-project", "sess_001", {
    mode: "cli",
    cwd: "/fake/project",
    git_commit: "abc1234",
    config_id: "cfg_v1"
  });
  assert.ok(log.sessionId === "sess_001");

  const events = await log.tail(10);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "session:start");
  assert.equal(events[0].schema_version, 1);
  assert.ok(events[0].event_id.startsWith("evt_"));
  assert.ok(typeof events[0].event_hash === "string");
  assert.equal(events[0].prev_hash, null); // first event has no prev
});

test("appends events with hash chain", async () => {
  const log = await createSessionLog(tmpDir, "test-project", "sess_002", {
    mode: "cli",
    cwd: "/fake"
  });

  await log.append("user:message", { content: "hello" });
  await log.append("model:response", { content: "hi" });

  const events = await log.tail(5);
  assert.equal(events.length, 3); // session:start + 2 new

  // hash chain: each event has prev_hash pointing to previous event_hash
  assert.equal(events[1].prev_hash, events[0].event_hash);
  assert.equal(events[2].prev_hash, events[1].event_hash);
});

test("tail respects count limit", async () => {
  const log = await createSessionLog(tmpDir, "test-project", "sess_003", {
    mode: "cli", cwd: "/fake"
  });

  for (let i = 0; i < 10; i++) {
    await log.append("user:message", { content: `msg ${i}` });
  }

  const tail = await log.tail(5);
  assert.equal(tail.length, 5);
});

test("reopens existing session log and appends", async () => {
  const log1 = await createSessionLog(tmpDir, "test-project", "sess_004", {
    mode: "cli", cwd: "/fake"
  });
  await log1.append("user:message", { content: "first" });

  // Reopen
  const log2 = await openSessionLog(tmpDir, "test-project", "sess_004");
  await log2.append("user:message", { content: "second" });

  const events = await log2.tail(10);
  const types = events.map((e) => e.type);
  // session:start, user:message, user:message
  assert.equal(events.length, 3);
  assert.deepEqual(types, ["session:start", "user:message", "user:message"]);
});

test("events carry the defined schema_version", async () => {
  const log = await createSessionLog(tmpDir, "test-project", "sess_005", {
    mode: "cli", cwd: "/fake"
  });
  await log.append("tool:call", { tool: "read", params: { path: "a.js" } });

  const events = await log.tail(5);
  for (const evt of events) {
    assert.equal(evt.schema_version, 1);
  }
});

test("session:start includes metadata fields", async () => {
  const meta = {
    mode: "tui",
    cwd: "/home/user/project",
    git_commit: "def5678",
    config_id: "cfg_prod"
  };
  const log = await createSessionLog(tmpDir, "test-project", "sess_006", meta);

  const events = await log.tail(1);
  const start = events[0];
  assert.equal(start.mode, "tui");
  assert.equal(start.cwd, "/home/user/project");
  assert.equal(start.git_commit, "def5678");
  assert.equal(start.config_id, "cfg_prod");
  assert.ok(typeof start.session_id === "string");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/kernel/session-log.test.js`
Expected: FAIL — "Cannot find module"

- [ ] **Step 3: Create the SessionLog module**

```js
// src/kernel/session-log.js
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const SCHEMA_VERSION = 1;

export async function createSessionLog(baseDir, projectId, sessionId, meta) {
  const dir = sessionDir(baseDir, projectId);
  await fs.mkdir(dir, { recursive: true });
  const filePath = sessionFilePath(dir, sessionId);

  const log = new SessionLogWriter(filePath, sessionId);

  const startEvent = {
    schema_version: SCHEMA_VERSION,
    event_id: makeEventId(),
    prev_hash: null,
    event_hash: null,
    type: "session:start",
    timestamp: new Date().toISOString(),
    seq: 1,
    session_id: sessionId,
    ...meta
  };
  startEvent.event_hash = hashEvent(startEvent);

  await appendLine(filePath, startEvent);
  log.lastHash = startEvent.event_hash;
  log.seq = 1;

  return log;
}

export async function openSessionLog(baseDir, projectId, sessionId) {
  const dir = sessionDir(baseDir, projectId);
  const filePath = sessionFilePath(dir, sessionId);

  // Read existing events to recover last_hash and seq
  const existing = await readAllLines(filePath);
  const lastEvent = existing.length > 0 ? existing[existing.length - 1] : null;

  const log = new SessionLogWriter(filePath, sessionId);
  log.lastHash = lastEvent?.event_hash ?? null;
  log.seq = lastEvent?.seq ?? 0;

  return log;
}

class SessionLogWriter {
  constructor(filePath, sessionId) {
    this.filePath = filePath;
    this.sessionId = sessionId;
    this.lastHash = null;
    this.seq = 0;
  }

  async append(eventType, data) {
    this.seq += 1;
    const event = {
      schema_version: SCHEMA_VERSION,
      event_id: makeEventId(),
      prev_hash: this.lastHash,
      event_hash: null,
      type: eventType,
      timestamp: new Date().toISOString(),
      seq: this.seq,
      ...data
    };
    event.event_hash = hashEvent(event);

    await appendLine(this.filePath, event);
    this.lastHash = event.event_hash;

    return event;
  }

  async tail(count) {
    const all = await readAllLines(this.filePath);
    return all.slice(-count);
  }
}

// -- internal helpers --

function sessionDir(baseDir, projectId) {
  return path.join(baseDir, "sessions", sanitize(projectId));
}

function sessionFilePath(dir, sessionId) {
  return path.join(dir, `${sanitize(sessionId)}.jsonl`);
}

async function appendLine(filePath, event) {
  await fs.appendFile(filePath, JSON.stringify(event) + "\n", "utf8");
}

async function readAllLines(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return content
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function hashEvent(event) {
  const { event_hash, ...rest } = event;
  const canonical = JSON.stringify(rest, Object.keys(rest).sort());
  return `sha256:${createHash("sha256").update(canonical).digest("hex").slice(0, 16)}`;
}

function makeEventId() {
  return `evt_${randomUUID().slice(0, 12)}`;
}

function sanitize(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/kernel/session-log.test.js`
Expected: all 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/kernel/session-log.js test/kernel/session-log.test.js
git commit -m "feat(kernel): add SessionLog with append-only JSONL and hash chain"
```

---

### Task 3: ConfigProvider with ModelProfile

**Files:**
- Create: `src/kernel/config-provider.js`
- Create: `test/kernel/config-provider.test.js`
- Read: `src/config.js` (reference existing patterns)

- [ ] **Step 1: Write the ConfigProvider test file**

```js
// test/kernel/config-provider.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadConfig, DEFAULT_MODEL_PROFILES } from "../src/kernel/config-provider.js";

const tmpDir = path.join(os.tmpdir(), `dsc-config-test-${Date.now()}`);
const localConfigDir = path.join(tmpDir, ".deepseek-code");

test.before(async () => {
  await fs.mkdir(localConfigDir, { recursive: true });
});

test.after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("loads defaults when no config files exist and no env vars", async () => {
  const config = await loadConfig(tmpDir);
  assert.equal(config.baseUrl, "https://api.deepseek.com");
  assert.equal(config.model, "deepseek-v4-flash");
  assert.equal(config.apiKey, "");
  assert.equal(config.thinking.type, "disabled");
  assert.equal(config.reasoningEffort, "high");
});

test("merges project-local config over defaults", async () => {
  await fs.writeFile(
    path.join(localConfigDir, "config.json"),
    JSON.stringify({ model: "custom-model", temperature: 0.5 })
  );

  const config = await loadConfig(tmpDir);
  assert.equal(config.model, "custom-model");
  assert.equal(config.temperature, 0.5);
  // defaults still present
  assert.equal(config.baseUrl, "https://api.deepseek.com");
});

test("env vars override file config", async () => {
  process.env.DEEPSEEK_MODEL = "env-model";
  process.env.DEEPSEEK_API_KEY = "env-key-123";

  await fs.writeFile(
    path.join(localConfigDir, "config.json"),
    JSON.stringify({ model: "file-model", apiKey: "file-key" })
  );

  try {
    const config = await loadConfig(tmpDir);
    assert.equal(config.model, "env-model");
    assert.equal(config.apiKey, "env-key-123");
  } finally {
    delete process.env.DEEPSEEK_MODEL;
    delete process.env.DEEPSEEK_API_KEY;
  }
});

test("throws when apiKey is missing and allowMissingKey is not set", async () => {
  // ensure no env var
  delete process.env.DEEPSEEK_API_KEY;
  try {
    await assert.rejects(
      () => loadConfig(tmpDir),
      /缺少 DeepSeek API 密钥/
    );
  } finally {
    // cleanup
  }
});

test("returns config without apiKey when allowMissingKey is set", async () => {
  delete process.env.DEEPSEEK_API_KEY;
  const config = await loadConfig(tmpDir, { allowMissingKey: true });
  assert.equal(config.apiKey, "");
});

test("ModelProfiles are included in config", async () => {
  const config = await loadConfig(tmpDir, { allowMissingKey: true });
  assert.ok(typeof config.profiles === "object");
  assert.ok(config.profiles.reasoning);
  assert.ok(config.profiles.fast);
  assert.ok(config.profiles.fim);
  assert.ok(Array.isArray(config.profiles.reasoning.models));
  assert.ok(Array.isArray(config.profiles.fast.models));
});

test("profile's resolve picks first available model", async () => {
  const config = await loadConfig(tmpDir, { allowMissingKey: true });
  const resolved = config.profiles.reasoning.resolve();
  assert.equal(typeof resolved, "string");
  assert.ok(resolved.length > 0);
});

test("thinking=disabled is explicit in config, not undefined", async () => {
  await fs.writeFile(
    path.join(localConfigDir, "config.json"),
    JSON.stringify({ thinking: { type: "disabled" } })
  );
  const config = await loadConfig(tmpDir);
  assert.equal(config.thinking.type, "disabled");
});

test("thinking=enabled is normalized correctly", async () => {
  await fs.writeFile(
    path.join(localConfigDir, "config.json"),
    JSON.stringify({ thinking: { type: "enabled" }, reasoningEffort: "max" })
  );
  const config = await loadConfig(tmpDir);
  assert.equal(config.thinking.type, "enabled");
  assert.equal(config.reasoningEffort, "max");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/kernel/config-provider.test.js`
Expected: FAIL — "Cannot find module"

- [ ] **Step 3: Create the ConfigProvider module**

```js
// src/kernel/config-provider.js
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_MODEL_PROFILES = {
  reasoning: {
    profile: "reasoning",
    models: ["deepseek-v4-pro", "deepseek-v4-flash"],
    default: "deepseek-v4-pro",
    thinking: { type: "enabled" },
    reasoning_effort: "high",
    resolve() {
      return this.models[0] || this.default;
    }
  },
  fast: {
    profile: "fast",
    models: ["deepseek-v4-flash", "deepseek-v4-pro"],
    default: "deepseek-v4-flash",
    thinking: { type: "disabled" },
    reasoning_effort: null,
    resolve() {
      return this.models[0] || this.default;
    }
  },
  fim: {
    profile: "fim",
    models: ["deepseek-v4-pro", "deepseek-v4-flash"],
    default: "deepseek-v4-pro",
    thinking: { type: "disabled" },
    reasoning_effort: null,
    resolve() {
      return this.models[0] || this.default;
    }
  }
};

export const DEFAULT_CONFIG = {
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-flash",
  apiKey: "",
  temperature: 0.2,
  maxTokens: 4096,
  thinking: { type: "disabled" },
  reasoningEffort: "high",
  profiles: DEFAULT_MODEL_PROFILES
};

export async function loadConfig(root, options = {}) {
  const localPath = path.join(root, ".deepseek-code", "config.json");
  const homePath = path.join(os.homedir(), ".deepseek-code", "config.json");
  const fileConfig = {
    ...(await readJsonIfExists(homePath)),
    ...(await readJsonIfExists(localPath))
  };

  const profiles = {
    ...DEFAULT_MODEL_PROFILES,
    ...(fileConfig.profiles || {})
  };

  const config = {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    profiles,
    apiKey: fileConfig.apiKey || process.env.DEEPSEEK_API_KEY || "",
    baseUrl: process.env.DEEPSEEK_BASE_URL || fileConfig.baseUrl || DEFAULT_CONFIG.baseUrl,
    model: process.env.DEEPSEEK_MODEL || fileConfig.model || DEFAULT_CONFIG.model,
    thinking: normalizeThinking(fileConfig.thinking ?? DEFAULT_CONFIG.thinking),
    reasoningEffort: process.env.DEEPSEEK_REASONING_EFFORT || fileConfig.reasoningEffort || DEFAULT_CONFIG.reasoningEffort
  };

  if (!config.apiKey && !options.allowMissingKey) {
    throw new Error("缺少 DeepSeek API 密钥。请运行 config init --api-key <key>，或设置 DEEPSEEK_API_KEY。");
  }

  return config;
}

export async function saveLocalConfig(root, config) {
  const dir = path.join(root, ".deepseek-code");
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, "config.json");
  const { profiles, ...persisted } = config;
  await fs.writeFile(target, `${JSON.stringify({ ...persisted, profiles }, null, 2)}\n`, "utf8");
  return target;
}

export async function configureProject(root, updates) {
  const current = await loadConfig(root, { allowMissingKey: true });
  const config = normalizeConfig({
    ...current,
    ...updates
  });
  const target = await saveLocalConfig(root, config);
  return { target, config };
}

export function normalizeConfig(config) {
  return {
    ...DEFAULT_CONFIG,
    ...config,
    baseUrl: stripTrailingSlash(config.baseUrl || DEFAULT_CONFIG.baseUrl),
    model: config.model || DEFAULT_CONFIG.model,
    apiKey: config.apiKey || "",
    temperature: toNumber(config.temperature, DEFAULT_CONFIG.temperature),
    maxTokens: Math.trunc(toNumber(config.maxTokens, DEFAULT_CONFIG.maxTokens)),
    thinking: normalizeThinking(config.thinking ?? DEFAULT_CONFIG.thinking),
    reasoningEffort: normalizeReasoningEffort(config.reasoningEffort),
    profiles: { ...DEFAULT_MODEL_PROFILES, ...(config.profiles || {}) }
  };
}

// -- internal helpers --

async function readJsonIfExists(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error(`读取 ${file} 失败：${error.message}`);
  }
}

function normalizeThinking(value) {
  if (value === true || value === "enabled") return { type: "enabled" };
  if (value === false || value === "disabled" || value === undefined || value === null) {
    return { type: "disabled" };
  }
  if (typeof value === "object" && value.type) {
    return { type: value.type === "enabled" ? "enabled" : "disabled" };
  }
  return DEFAULT_CONFIG.thinking;
}

function normalizeReasoningEffort(value) {
  if (value === "max" || value === "xhigh") return "max";
  if (value === "minimal") return "minimal";
  if (["low", "medium", "high"].includes(value)) return "high";
  return DEFAULT_CONFIG.reasoningEffort;
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/kernel/config-provider.test.js`
Expected: all 9 tests PASS

- [ ] **Step 5: Update existing `src/config.js` to re-export from kernel**

```js
// Add to end of src/config.js (keep all existing code, just add re-export):
export { DEFAULT_MODEL_PROFILES } from "./kernel/config-provider.js";
```

- [ ] **Step 6: Verify existing tests still pass**

Run: `node --test test/patch.test.js`
Expected: all 3 tests PASS

- [ ] **Step 7: Verify existing code is not broken (syntax check)**

Run: `node --check bin/deepseek-code.js && node --check src/*.js && node --check src/kernel/*.js`
Expected: no output (all files parse successfully)

- [ ] **Step 8: Commit**

```bash
git add src/kernel/config-provider.js test/kernel/config-provider.test.js src/config.js
git commit -m "feat(kernel): add ConfigProvider with ModelProfile support"
```

---

### Task 4: KernelAPI Interface Definition

**Files:**
- Create: `src/kernel/kernel-api.js`

- [ ] **Step 1: Create the KernelAPI interface module**

```js
// src/kernel/kernel-api.js
import { createEventBus } from "./event-bus.js";
import { loadConfig } from "./config-provider.js";

/**
 * Create the Kernel instance — the single entry point for CLI, TUI, and GUI.
 *
 * The Kernel composes the EventBus, loads configuration, and exposes
 * the public API contract that all UI shells consume.
 *
 * Phase 0 scope:
 *   - EventBus (inter-module communication)
 *   - Config (three-tier merge with ModelProfiles)
 *   - Session subscription (pass-through to SessionLog, wired in Phase 1+)
 *
 * Later phases extend this Kernel with:
 *   - agent: { send, approve, interrupt }
 *   - context: { getSnapshot, pin, unpin }
 *   - session: { getTimeline, resume }
 */
export async function createKernel(root, options = {}) {
  const eventBus = createEventBus();
  const config = await loadConfig(root, options.config);

  // Phase 0: session subscription is a pass-through to EventBus.
  // Phase 1+ will wire in SessionLog persistence.
  const session = {
    subscribe(handler) {
      // Phase 3+: wire to SessionLog event stream via a subscriber registry.
      // EventBus does not have wildcards; session subscriber will be
      // explicitly called from each event publish site in Phase 1+.
      // For now, return a no-op unsubscribe handle.
      return { unsubscribe() {} };
    },

    getTimeline(count = 20) {
      // Phase 1+: read from SessionLog
      return Promise.resolve([]);
    },

    async resume() {
      // Phase 3+: replay event log and restore state
      eventBus.publish("session:resume", { timestamp: new Date().toISOString() });
    }
  };

  // agent stub — full implementation in Phase 1 (Task Orchestrator)
  const agent = {
    async send(message, opts = {}) {
      eventBus.publish("user:message", {
        content: message,
        options: opts
      });
      throw new Error("Agent not yet implemented. Coming in Phase 1.");
    },

    approve(id, decision) {
      eventBus.publish("permission:decision", {
        tool_call_id: id,
        decision
      });
    },

    interrupt() {
      eventBus.publish("agent:interrupt", {
        timestamp: new Date().toISOString()
      });
    }
  };

  // context stub — full implementation in Phase 1 (Context Engine)
  const context = {
    async getSnapshot() {
      return { units: [], budget: { allocated: 0, used: 0 } };
    },

    pin(filePath) {
      eventBus.publish("context:pin", { path: filePath });
    },

    unpin(filePath) {
      eventBus.publish("context:unpin", { path: filePath });
    }
  };

  return {
    eventBus,
    config,
    session,
    agent,
    context
  };
}
```

- [ ] **Step 2: Syntax check**

Run: `node --check src/kernel/kernel-api.js`
Expected: no output (parse success)

- [ ] **Step 3: Commit**

```bash
git add src/kernel/kernel-api.js
git commit -m "feat(kernel): add KernelAPI interface with Phase 0 stubs"
```

---

### Task 5: Wire Phase 0 into package.json and verify integration

- [ ] **Step 1: Add kernel check script to package.json**

```json
// Modify the "check" script in package.json:
// from: "check": "node --check bin/deepseek-code.js && node --check src/*.js"
// to:
"check": "node --check bin/deepseek-code.js && node --check src/*.js && node --check src/kernel/*.js"
```

- [ ] **Step 2: Run full project check**

Run: `npm run check`
Expected: no output (all files parse successfully)

- [ ] **Step 3: Run all tests**

Run: `node --test test/patch.test.js test/kernel/*.test.js`
Expected: all tests PASS (3 patch + 7 event-bus + 7 session-log + 9 config-provider = 26 PASS)

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "chore: add kernel source check to npm run check"
```

---

### Phase 0 Completion Checklist

```
- [ ] src/kernel/event-bus.js created and tested (7 tests)
- [ ] src/kernel/session-log.js created and tested (7 tests)
- [ ] src/kernel/config-provider.js created and tested (9 tests)
- [ ] src/kernel/kernel-api.js created (syntax check)
- [ ] src/config.js updated with ModelProfile re-export
- [ ] package.json "check" script covers src/kernel/
- [ ] npm run check passes
- [ ] All 26 tests pass
- [ ] Existing CLI functionality unbroken (syntax check on all old files)
```
