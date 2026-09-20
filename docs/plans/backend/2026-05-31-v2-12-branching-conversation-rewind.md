# V2-12 Branching Conversation Rewind Implementation Plan

> 完成状态以 [CHANGELOG](../../CHANGELOG.md) 为准。


**Goal:** Add heavy-route conversation rewind: branch-aware timelines, checkpoints, preview/apply rewind, and active-branch continuation.

**Architecture:** Implement V2-12 in four staged increments. `branch-store.js` owns durable branch metadata and active branch state; `session-manager.js` stamps events and filters timelines by branch; `checkpoint-index.js` derives rewind targets and change ranges from the append-only event log; `rewind-service.js` creates child branches and uses V2-11 rollback to restore files safely.

**Tech Stack:** Node.js >=20 ESM, built-in `node:test`, V2 session JSONL, V2 edit service rollback, no new dependencies.

---

## File Structure

Create:

- `src/sessions/branch-store.js`
  Durable metadata store for `br_main`, child branches, active branch, branch activation, and inherited branch ancestry.
- `src/sessions/checkpoint-index.js`
  Pure functions that normalize branchless events, derive checkpoints, resolve target events/turns/seqs, and compute rollback plans.
- `src/sessions/rewind-service.js`
  Preview/apply service that reads timeline, computes rollback change IDs, calls `editService.rollback()`, creates child branches, and publishes safe rewind events.
- `tests/unit/sessions/branch-store.test.js`
- `tests/unit/sessions/checkpoint-index.test.js`
- `tests/unit/sessions/rewind-service.test.js`
- `tests/integration/v2-branching-rewind.test.js`

Modify:

- `src/sessions/session-manager.js`
  Add active-branch event stamping and branch-aware `getTimeline()` options.
- `src/sessions/event-types.js`
  Register branch and rewind events.
- `src/index.js`
  Wire branch store and rewind service into `kernel.session`.
- `gui/kernel-host.js`
  Expose branch/rewind methods for future GUI use.
- `src/apps/cli/render-events.js`
  Render branch/rewind events in CLI/TUI logs.
- `package.json`
  Add new session modules to `npm run check`.
- Existing tests that instantiate `createSessionManager()` or fake `kernel.session` may need small option updates.

Do not implement a GUI branch panel in V2-12. Do not mutate existing JSONL events. Do not write files directly during rewind; always call V2-11 rollback.

---

## V2-12A: Branch Foundation

### Task 1: Durable Branch Store

**Files:**
- Create: `src/sessions/branch-store.js`
- Test: `tests/unit/sessions/branch-store.test.js`

- [ ] **Step 1: Write failing branch store tests**

Create `tests/unit/sessions/branch-store.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BR_MAIN,
  createBranchStore
} from "../../../src/sessions/branch-store.js";

test("branch store creates br_main lazily", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-branch-store-"));
  const store = await createBranchStore({
    sessionRoot: path.join(root, ".sessions"),
    projectId: "proj_test",
    sessionId: "sess_test"
  });

  assert.equal(await store.getActiveBranchId(), BR_MAIN);
  const branches = await store.listBranches();
  assert.equal(branches.length, 1);
  assert.equal(branches[0].branch_id, BR_MAIN);
  assert.equal(branches[0].parent_branch_id, null);
});

test("branch store persists child branch and active branch", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-branch-store-persist-"));
  const options = {
    sessionRoot: path.join(root, ".sessions"),
    projectId: "proj_test",
    sessionId: "sess_test"
  };
  const first = await createBranchStore(options);
  const child = await first.createBranch({
    parent_branch_id: BR_MAIN,
    forked_from_event_id: "evt_1",
    forked_from_seq: 10,
    forked_from_turn_id: "turn_1",
    label: "rewind to turn_1"
  });
  await first.activateBranch(child.branch_id);

  const second = await createBranchStore(options);
  assert.equal(await second.getActiveBranchId(), child.branch_id);
  const branches = await second.listBranches();
  assert.equal(branches.length, 2);
  assert.equal(branches[1].parent_branch_id, BR_MAIN);

  const raw = JSON.parse(await readFile(path.join(options.sessionRoot, "proj_test", "sess_test.branches.json"), "utf8"));
  assert.equal(raw.active_branch_id, child.branch_id);
});

test("branch store rejects unknown branch activation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-branch-store-unknown-"));
  const store = await createBranchStore({
    sessionRoot: path.join(root, ".sessions"),
    projectId: "proj_test",
    sessionId: "sess_test"
  });

  await assert.rejects(() => store.activateBranch("br_missing"), /unknown branch/);
});

test("branch ancestry includes parent chain from root to child", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-branch-store-ancestry-"));
  const store = await createBranchStore({
    sessionRoot: path.join(root, ".sessions"),
    projectId: "proj_test",
    sessionId: "sess_test"
  });
  const first = await store.createBranch({ parent_branch_id: BR_MAIN, forked_from_seq: 5 });
  const second = await store.createBranch({ parent_branch_id: first.branch_id, forked_from_seq: 8 });

  assert.deepEqual(
    (await store.getAncestry(second.branch_id)).map((branch) => branch.branch_id),
    [BR_MAIN, first.branch_id, second.branch_id]
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
npm.cmd test -- tests/unit/sessions/branch-store.test.js
```

Expected: FAIL with module-not-found for `src/sessions/branch-store.js`.

- [ ] **Step 3: Implement branch-store.js**

Create `src/sessions/branch-store.js`:

```js
import { promises as fs } from "node:fs";
import path from "node:path";
import { makeId } from "../shared/id.js";
import { nowIso } from "../shared/time.js";

export const BRANCH_SCHEMA_VERSION = 1;
export const BR_MAIN = "br_main";

export async function createBranchStore({ sessionRoot, projectId, sessionId } = {}) {
  if (!sessionRoot) throw new Error("sessionRoot is required");
  if (!projectId) throw new Error("projectId is required");
  if (!sessionId) throw new Error("sessionId is required");
  const filePath = branchFilePath(sessionRoot, projectId, sessionId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  let state = await loadState(filePath, sessionId);
  await saveState(filePath, state);

  async function persist(next) {
    state = normalizeState(next, sessionId);
    await saveState(filePath, state);
    return snapshot(state);
  }

  async function listBranches() {
    return snapshot(state).branches;
  }

  async function getActiveBranchId() {
    return state.active_branch_id || BR_MAIN;
  }

  async function getBranch(branchId = state.active_branch_id) {
    const branch = state.branches.find((item) => item.branch_id === branchId);
    if (!branch) throw new Error(`unknown branch: ${branchId}`);
    return { ...branch };
  }

  async function createBranch({
    parent_branch_id = state.active_branch_id || BR_MAIN,
    forked_from_event_id = null,
    forked_from_seq = 0,
    forked_from_turn_id = null,
    label = ""
  } = {}) {
    await getBranch(parent_branch_id);
    const branch = {
      branch_id: makeId("br"),
      parent_branch_id,
      forked_from_event_id,
      forked_from_seq: Number(forked_from_seq || 0),
      forked_from_turn_id,
      created_at: nowIso(),
      label: label || `rewind from ${parent_branch_id}`
    };
    await persist({ ...state, branches: [...state.branches, branch] });
    return { ...branch };
  }

  async function activateBranch(branchId) {
    await getBranch(branchId);
    await persist({ ...state, active_branch_id: branchId });
    return getBranch(branchId);
  }

  async function getAncestry(branchId = state.active_branch_id || BR_MAIN) {
    const byId = new Map(state.branches.map((branch) => [branch.branch_id, branch]));
    const chain = [];
    let cursor = byId.get(branchId);
    if (!cursor) throw new Error(`unknown branch: ${branchId}`);
    while (cursor) {
      chain.push({ ...cursor });
      cursor = cursor.parent_branch_id ? byId.get(cursor.parent_branch_id) : null;
    }
    return chain.reverse();
  }

  return {
    filePath,
    listBranches,
    getActiveBranchId,
    getBranch,
    createBranch,
    activateBranch,
    getAncestry
  };
}

function branchFilePath(sessionRoot, projectId, sessionId) {
  return path.join(sessionRoot, sanitize(projectId), `${sanitize(sessionId)}.branches.json`);
}

async function loadState(filePath, sessionId) {
  try {
    const raw = JSON.parse(await fs.readFile(filePath, "utf8"));
    return normalizeState(raw, sessionId);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return normalizeState({}, sessionId);
  }
}

function normalizeState(raw, sessionId) {
  const branches = Array.isArray(raw.branches) ? raw.branches.filter(Boolean).map(normalizeBranch) : [];
  if (!branches.some((branch) => branch.branch_id === BR_MAIN)) {
    branches.unshift({
      branch_id: BR_MAIN,
      parent_branch_id: null,
      forked_from_event_id: null,
      forked_from_seq: 0,
      forked_from_turn_id: null,
      created_at: nowIso(),
      label: "main"
    });
  }
  const active = branches.some((branch) => branch.branch_id === raw.active_branch_id)
    ? raw.active_branch_id
    : BR_MAIN;
  return {
    schema_version: BRANCH_SCHEMA_VERSION,
    session_id: raw.session_id || sessionId,
    active_branch_id: active,
    branches
  };
}

function normalizeBranch(branch) {
  return {
    branch_id: sanitizeBranchId(branch.branch_id || makeId("br")),
    parent_branch_id: branch.parent_branch_id || null,
    forked_from_event_id: branch.forked_from_event_id || null,
    forked_from_seq: Number(branch.forked_from_seq || 0),
    forked_from_turn_id: branch.forked_from_turn_id || null,
    created_at: branch.created_at || nowIso(),
    label: String(branch.label || "")
  };
}

async function saveState(filePath, state) {
  const temp = `${filePath}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await fs.rename(temp, filePath);
}

function snapshot(state) {
  return JSON.parse(JSON.stringify(state));
}

function sanitize(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
}

function sanitizeBranchId(value) {
  const id = String(value || "");
  if (!/^br_[a-zA-Z0-9._-]+$/.test(id)) throw new Error(`invalid branch id: ${value}`);
  return id.slice(0, 80);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```powershell
npm.cmd test -- tests/unit/sessions/branch-store.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

Run:

```powershell
git add src/sessions/branch-store.js tests/unit/sessions/branch-store.test.js
git commit -m "feat(v2): add session branch store"
```

---

### Task 2: Session Manager Branch Stamping and Timeline Filtering

**Files:**
- Modify: `src/sessions/session-manager.js`
- Test: `tests/unit/sessions/session-manager.test.js`

- [ ] **Step 1: Add failing tests for branch stamping and filtering**

Append to `tests/unit/sessions/session-manager.test.js`:

```js
test("session manager stamps active branch id on live and persisted events", async () => {
  const eventBus = createEventBus();
  const writes = [];
  const session = createSessionManager({
    eventBus,
    eventLog: {
      append: async (type, data) => writes.push({ type, data }),
      flush: async () => {},
      tail: async () => writes.map((entry, index) => ({ seq: index + 1, type: entry.type, ...entry.data }))
    },
    getActiveBranchId: () => "br_feature"
  });
  const events = [];
  const sub = session.subscribe((event) => events.push(event));

  eventBus.publish("user:message", { content: "hi" });
  await session.flush();
  sub.unsubscribe();

  assert.equal(events[0].branch_id, "br_feature");
  assert.equal(writes[0].data.branch_id, "br_feature");
});

test("session getTimeline filters active branch while keeping br_main ancestors", async () => {
  const eventBus = createEventBus();
  const timeline = [
    { seq: 1, type: "session:start", branch_id: "br_main" },
    { seq: 2, type: "agent:final", branch_id: "br_main" },
    { seq: 3, type: "session:branch_created", branch_id: "br_child", parent_branch_id: "br_main" },
    { seq: 4, type: "agent:final", branch_id: "br_child" },
    { seq: 5, type: "agent:final", branch_id: "br_other" }
  ];
  const session = createSessionManager({
    eventBus,
    eventLog: {
      append: async () => {},
      flush: async () => {},
      tail: async () => timeline
    },
    getActiveBranchId: () => "br_child",
    getBranchAncestry: async () => [
      { branch_id: "br_main", forked_from_seq: 0 },
      { branch_id: "br_child", forked_from_seq: 2 }
    ]
  });

  const active = await session.getTimeline({ count: 20 });
  assert.deepEqual(active.map((event) => event.seq), [1, 2, 3, 4]);

  const all = await session.getTimeline({ count: 20, all_branches: true });
  assert.deepEqual(all.map((event) => event.seq), [1, 2, 3, 4, 5]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
npm.cmd test -- tests/unit/sessions/session-manager.test.js
```

Expected: FAIL because `createSessionManager()` does not stamp branch IDs or accept object timeline options.

- [ ] **Step 3: Modify session-manager.js**

Update `src/sessions/session-manager.js` to:

```js
import { SESSION_EVENT_TYPES } from "./event-types.js";
import { BR_MAIN } from "./branch-store.js";

export function createSessionManager({
  eventBus,
  eventLog = null,
  eventTypes = SESSION_EVENT_TYPES,
  onError = defaultOnError,
  getActiveBranchId = () => BR_MAIN,
  getBranchAncestry = async (branchId) => [{ branch_id: branchId || BR_MAIN, forked_from_seq: 0 }]
} = {}) {
  if (!eventBus || typeof eventBus.subscribe !== "function") {
    throw new Error("eventBus with subscribe() is required");
  }

  const pending = new Set();
  const bridgeSubscriptions = eventLog
    ? eventTypes.map((type) => eventBus.subscribe(type, (data, meta) => {
        const stamped = stampBranch(data, getActiveBranchId);
        const write = eventLog.append(type, stamped, meta).catch((error) => {
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
      handler({ ...stampBranch(data, getActiveBranchId), type, meta });
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

  async function getTimeline(input = 20) {
    if (!eventLog || typeof eventLog.tail !== "function") return [];
    await flush();
    const options = normalizeTimelineOptions(input);
    const events = await eventLog.tail(options.scanCount);
    const normalized = events.map(normalizeBranchlessEvent);
    if (options.all_branches) return normalized.slice(-options.count);
    const branchId = options.branch_id || getActiveBranchId();
    const ancestry = await getBranchAncestry(branchId);
    return filterTimelineForBranch(normalized, ancestry).slice(-options.count);
  }

  function dispose() {
    for (const sub of bridgeSubscriptions) sub.unsubscribe();
  }

  return { subscribe, flush, getTimeline, dispose };
}

export function normalizeTimelineOptions(input) {
  if (typeof input === "number") {
    const count = safeCount(input);
    return { count, scanCount: Math.max(count * 5, count), all_branches: false, branch_id: null };
  }
  const count = safeCount(input?.count ?? 20);
  return {
    count,
    scanCount: safeCount(input?.scan_count ?? Math.max(count * 5, count)),
    all_branches: Boolean(input?.all_branches),
    branch_id: input?.branch_id || null
  };
}

export function normalizeBranchlessEvent(event) {
  if (!event || typeof event !== "object") return event;
  return { ...event, branch_id: event.branch_id || BR_MAIN };
}

export function filterTimelineForBranch(events, ancestry = []) {
  const chain = ancestry.length ? ancestry : [{ branch_id: BR_MAIN, forked_from_seq: 0 }];
  const allowed = new Set(chain.map((branch) => branch.branch_id));
  const forkSeqByBranch = new Map(chain.map((branch) => [branch.branch_id, Number(branch.forked_from_seq || 0)]));
  return events.filter((event) => {
    const branchId = event.branch_id || BR_MAIN;
    if (!allowed.has(branchId)) return false;
    const child = chain.find((item) => item.parent_branch_id === branchId);
    if (child && Number(event.seq || 0) > Number(child.forked_from_seq || 0)) return false;
    const ownForkSeq = forkSeqByBranch.get(branchId) || 0;
    return Number(event.seq || 0) >= ownForkSeq || branchId === BR_MAIN;
  });
}

function stampBranch(data, getActiveBranchId) {
  const branchId = safeBranchId(getActiveBranchId());
  return { ...data, branch_id: branchId };
}

function safeBranchId(value) {
  return typeof value === "string" && value ? value : BR_MAIN;
}

function safeCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? count : 20;
}

function defaultOnError(error, type) {
  console.error(`SessionManager: failed to persist ${type}: ${error.message}`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```powershell
npm.cmd test -- tests/unit/sessions/session-manager.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

Run:

```powershell
git add src/sessions/session-manager.js tests/unit/sessions/session-manager.test.js
git commit -m "feat(v2): stamp session events with branch ids"
```

---

### Task 3: Kernel Branch Facade

**Files:**
- Modify: `src/index.js`
- Test: `tests/integration/v2-kernel-facade.test.js`

- [ ] **Step 1: Add failing kernel branch facade test**

In `tests/integration/v2-kernel-facade.test.js`, add these imports near the top if they are not already present:

```js
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
```

Then append this test:

```js
test("v2 kernel exposes branch facade and stamps active branch events", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-v2-branch-facade-"));
  const kernel = await createKernel(root, {
    sessionId: "sess_branch_facade",
    sessionRoot: path.join(root, ".sessions"),
    sessionLog: null,
    context: { disabled: true },
    modelGateway: { reply: async () => ({ content: "ok" }) }
  });

  assert.equal(typeof kernel.session.branches.list, "function");
  assert.equal(typeof kernel.session.branches.getActive, "function");
  const active = await kernel.session.branches.getActive();
  assert.equal(active.branch_id, "br_main");

  const child = await kernel.session.branches.create({
    parent_branch_id: "br_main",
    forked_from_seq: 1,
    label: "test branch"
  });
  await kernel.session.branches.activate(child.branch_id);

  const events = [];
  const sub = kernel.session.subscribe((event) => events.push(event));
  await kernel.agent.send("hello?", { autonomy: "auto" });
  sub.unsubscribe();

  assert.ok(events.some((event) => event.type === "user:message" && event.branch_id === child.branch_id));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm.cmd test -- tests/integration/v2-kernel-facade.test.js
```

Expected: FAIL because `kernel.session.branches` is missing.

- [ ] **Step 3: Wire branch store into createKernel**

In `src/index.js`, add import:

```js
import { createBranchStore } from "./sessions/branch-store.js";
```

After session log creation, add branch store and an active branch cache:

```js
  const branchStore = options.branchStore || await createBranchStore({
    sessionRoot,
    projectId,
    sessionId
  });
  let activeBranchId = await branchStore.getActiveBranchId();
```

Pass branch callbacks into `createSessionManager()`:

```js
  const sessionManager = options.sessionManager || createSessionManager({
    eventBus,
    eventLog: sessionLog,
    eventTypes: SESSION_EVENT_TYPES,
    getActiveBranchId: () => activeBranchId,
    getBranchAncestry: (branchId) => branchStore.getAncestry(branchId)
  });
```

Then expose:

```js
  const branches = {
    list: () => branchStore.listBranches(),
    async getActive() {
      return branchStore.getBranch(activeBranchId);
    },
    async create(input = {}) {
      return branchStore.createBranch(input);
    },
    async activate(branch_id) {
      const branch = await branchStore.activateBranch(branch_id);
      activeBranchId = branch.branch_id;
      eventBus.publish("session:branch_activated", {
        branch_id: branch.branch_id,
        parent_branch_id: branch.parent_branch_id
      });
      await sessionManager.flush();
      return branch;
    }
  };
```

Add `branches` under `session`:

```js
    branches,
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
npm.cmd test -- tests/integration/v2-kernel-facade.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit Task 3**

Run:

```powershell
git add src/index.js tests/integration/v2-kernel-facade.test.js
git commit -m "feat(v2): expose session branch facade"
```

---

## V2-12B: Checkpoint Index

### Task 4: Checkpoint Derivation and Target Resolution

**Files:**
- Create: `src/sessions/checkpoint-index.js`
- Test: `tests/unit/sessions/checkpoint-index.test.js`

- [ ] **Step 1: Write failing checkpoint index tests**

Create `tests/unit/sessions/checkpoint-index.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCheckpointIndex,
  computeRollbackPlan,
  resolveRewindTarget
} from "../../../src/sessions/checkpoint-index.js";

const EVENTS = [
  { seq: 1, event_id: "evt_start", type: "session:start", branch_id: "br_main" },
  { seq: 2, event_id: "evt_user_1", type: "user:message", turn_id: "turn_1", branch_id: "br_main" },
  { seq: 3, event_id: "evt_final_1", type: "agent:final", turn_id: "turn_1", branch_id: "br_main" },
  { seq: 4, event_id: "evt_apply_1", type: "file:diff_applied", change_id: "change_1", files: ["a.txt"], branch_id: "br_main" },
  { seq: 5, event_id: "evt_user_2", type: "user:message", turn_id: "turn_2", branch_id: "br_main" },
  { seq: 6, event_id: "evt_apply_2", type: "file:transaction_committed", change_id: "change_2", files: ["b.txt"], branch_id: "br_main" },
  { seq: 7, event_id: "evt_final_2", type: "agent:final", turn_id: "turn_2", branch_id: "br_main" }
];

test("buildCheckpointIndex derives turn checkpoints with cumulative changes", () => {
  const index = buildCheckpointIndex(EVENTS, { branch_id: "br_main" });

  assert.equal(index.checkpoints.length >= 2, true);
  const turn2 = index.checkpoints.find((checkpoint) => checkpoint.turn_id === "turn_2");
  assert.equal(turn2.seq, 7);
  assert.deepEqual(turn2.cumulative_change_ids, ["change_1", "change_2"]);
});

test("resolveRewindTarget finds target by turn id event id or seq", () => {
  const index = buildCheckpointIndex(EVENTS, { branch_id: "br_main" });

  assert.equal(resolveRewindTarget(index, { turn_id: "turn_1" }).turn_id, "turn_1");
  assert.equal(resolveRewindTarget(index, { event_id: "evt_apply_1" }).event_id, "evt_apply_1");
  assert.equal(resolveRewindTarget(index, { seq: 3 }).seq, 3);
});

test("computeRollbackPlan returns changes after target in reverse order", () => {
  const index = buildCheckpointIndex(EVENTS, { branch_id: "br_main" });
  const target = resolveRewindTarget(index, { turn_id: "turn_1" });

  const plan = computeRollbackPlan(index, target);

  assert.deepEqual(plan.change_ids, ["change_2", "change_1"]);
  assert.deepEqual(plan.files.sort(), ["a.txt", "b.txt"]);
});

test("checkpoint index treats branchless events as br_main", () => {
  const index = buildCheckpointIndex(EVENTS.map(({ branch_id, ...event }) => event), { branch_id: "br_main" });

  assert.equal(index.events.every((event) => event.branch_id === "br_main"), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm.cmd test -- tests/unit/sessions/checkpoint-index.test.js
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement checkpoint-index.js**

Create `src/sessions/checkpoint-index.js`:

```js
import { makeId } from "../shared/id.js";
import { BR_MAIN } from "./branch-store.js";

const CHANGE_EVENTS = new Set(["file:diff_applied", "file:transaction_committed"]);

export function buildCheckpointIndex(events = [], { branch_id = BR_MAIN } = {}) {
  const normalized = events.map((event) => ({ ...event, branch_id: event.branch_id || BR_MAIN }));
  const branchEvents = normalized.filter((event) => (event.branch_id || BR_MAIN) === branch_id);
  const changes = [];
  const checkpoints = [];
  for (const event of branchEvents) {
    if (CHANGE_EVENTS.has(event.type) && event.change_id) {
      changes.push({
        change_id: event.change_id,
        seq: Number(event.seq || 0),
        event_id: event.event_id || null,
        turn_id: event.turn_id || null,
        files: event.files || []
      });
    }
    if (event.type === "agent:final" || event.type === "user:message") {
      checkpoints.push({
        checkpoint_id: makeId("cp"),
        branch_id,
        event_id: event.event_id || null,
        seq: Number(event.seq || 0),
        turn_id: event.turn_id || null,
        type: event.turn_id ? "turn" : "event",
        label: event.turn_id ? `after ${event.turn_id}` : event.type,
        cumulative_change_ids: changes.map((change) => change.change_id)
      });
    }
  }
  return { branch_id, events: branchEvents, changes, checkpoints };
}

export function resolveRewindTarget(index, target = {}) {
  if (!index) throw new Error("checkpoint index is required");
  if (target.event_id) {
    const event = index.events.find((item) => item.event_id === target.event_id);
    if (!event) throw new Error(`rewind target event not found: ${target.event_id}`);
    return eventToTarget(event);
  }
  if (target.turn_id) {
    const checkpoint = [...index.checkpoints].reverse().find((item) => item.turn_id === target.turn_id);
    if (!checkpoint) throw new Error(`rewind target turn not found: ${target.turn_id}`);
    return checkpoint;
  }
  if (target.seq != null) {
    const seq = Number(target.seq);
    const event = [...index.events].reverse().find((item) => Number(item.seq || 0) <= seq);
    if (!event) throw new Error(`rewind target seq not found: ${target.seq}`);
    return eventToTarget(event);
  }
  throw new Error("rewind target requires event_id, turn_id, or seq");
}

export function computeRollbackPlan(index, target) {
  const targetSeq = Number(target.seq || 0);
  const selected = index.changes.filter((change) => Number(change.seq || 0) > targetSeq).reverse();
  const files = [...new Set(selected.flatMap((change) => change.files || []))];
  return {
    branch_id: index.branch_id,
    target,
    change_ids: selected.map((change) => change.change_id),
    changes: selected,
    files,
    rollback_count: selected.length
  };
}

function eventToTarget(event) {
  return {
    branch_id: event.branch_id || BR_MAIN,
    event_id: event.event_id || null,
    seq: Number(event.seq || 0),
    turn_id: event.turn_id || null,
    type: event.type || "event",
    label: event.turn_id ? `after ${event.turn_id}` : event.type
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
npm.cmd test -- tests/unit/sessions/checkpoint-index.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit Task 4**

Run:

```powershell
git add src/sessions/checkpoint-index.js tests/unit/sessions/checkpoint-index.test.js
git commit -m "feat(v2): derive session rewind checkpoints"
```

---

## V2-12C: Rewind Preview and Apply

### Task 5: Rewind Service Preview

**Files:**
- Create: `src/sessions/rewind-service.js`
- Test: `tests/unit/sessions/rewind-service.test.js`

- [ ] **Step 1: Write failing preview test**

Create `tests/unit/sessions/rewind-service.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createEventBus } from "../../../src/shared/event-bus.js";
import { createRewindService } from "../../../src/sessions/rewind-service.js";

test("rewind preview computes reverse rollback plan without writing", async () => {
  const eventBus = createEventBus();
  const events = [];
  eventBus.subscribe("session:rewind_preview", (data) => events.push(data));
  const rollbacks = [];
  const service = createRewindService({
    eventBus,
    getTimeline: async () => [
      { seq: 1, event_id: "evt_user_1", type: "user:message", turn_id: "turn_1", branch_id: "br_main" },
      { seq: 2, event_id: "evt_apply_1", type: "file:diff_applied", change_id: "change_1", files: ["a.txt"], branch_id: "br_main" },
      { seq: 3, event_id: "evt_user_2", type: "user:message", turn_id: "turn_2", branch_id: "br_main" },
      { seq: 4, event_id: "evt_apply_2", type: "file:diff_applied", change_id: "change_2", files: ["b.txt"], branch_id: "br_main" }
    ],
    getActiveBranchId: async () => "br_main",
    rollback: async (input) => rollbacks.push(input)
  });

  const result = await service.preview({ target: { turn_id: "turn_1" } });

  assert.equal(result.status, "success");
  assert.deepEqual(result.rollback_change_ids, ["change_2", "change_1"]);
  assert.deepEqual(rollbacks, []);
  assert.equal(events.length, 1);
  assert.equal(JSON.stringify(events).includes("diff --git"), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm.cmd test -- tests/unit/sessions/rewind-service.test.js
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement preview in rewind-service.js**

Create `src/sessions/rewind-service.js`:

```js
import { makeId } from "../shared/id.js";
import {
  buildCheckpointIndex,
  computeRollbackPlan,
  resolveRewindTarget
} from "./checkpoint-index.js";

export function createRewindService({
  eventBus = null,
  getTimeline,
  getActiveBranchId,
  createBranch = null,
  activateBranch = null,
  rollback
} = {}) {
  if (typeof getTimeline !== "function") throw new Error("getTimeline is required");
  if (typeof getActiveBranchId !== "function") throw new Error("getActiveBranchId is required");
  if (typeof rollback !== "function") throw new Error("rollback is required");

  async function preview({ target, branch_id = null } = {}) {
    const branchId = branch_id || await getActiveBranchId();
    const timeline = await getTimeline({ count: 10000, branch_id: branchId });
    const index = buildCheckpointIndex(timeline, { branch_id: branchId });
    const resolvedTarget = resolveRewindTarget(index, target);
    const plan = computeRollbackPlan(index, resolvedTarget);
    const plannedBranchId = makeId("br");
    const result = {
      status: "success",
      target: resolvedTarget,
      current_branch_id: branchId,
      planned_branch_id: plannedBranchId,
      rollback_change_ids: plan.change_ids,
      rollback_count: plan.rollback_count,
      files: plan.files,
      force_required: false
    };
    publish("session:rewind_preview", safeRewindPayload(result));
    return result;
  }

  async function apply() {
      throw new Error("rewind apply unavailable before V2-12C");
  }

  function publish(type, data) {
    eventBus?.publish?.(type, data);
  }

  return { preview, apply };
}

function safeRewindPayload(result) {
  return {
    target: result.target,
    current_branch_id: result.current_branch_id,
    planned_branch_id: result.planned_branch_id,
    rollback_change_ids: result.rollback_change_ids,
    rollback_count: result.rollback_count,
    files: result.files,
    force_required: result.force_required
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
npm.cmd test -- tests/unit/sessions/rewind-service.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit Task 5**

Run:

```powershell
git add src/sessions/rewind-service.js tests/unit/sessions/rewind-service.test.js
git commit -m "feat(v2): preview branching rewind plans"
```

---

### Task 6: Rewind Apply, Conflict, and Branch Activation

**Files:**
- Modify: `src/sessions/rewind-service.js`
- Test: `tests/unit/sessions/rewind-service.test.js`

- [ ] **Step 1: Add failing apply and conflict tests**

Append to `tests/unit/sessions/rewind-service.test.js`:

```js
test("rewind apply rolls back changes creates and activates child branch", async () => {
  const eventBus = createEventBus();
  const published = [];
  for (const type of ["session:rewind_started", "session:branch_created", "session:branch_activated", "session:rewind_applied"]) {
    eventBus.subscribe(type, (data) => published.push({ type, data }));
  }
  const rollbackCalls = [];
  let activeBranch = "br_main";
  const service = createRewindService({
    eventBus,
    getTimeline: async () => [
      { seq: 1, event_id: "evt_user_1", type: "user:message", turn_id: "turn_1", branch_id: "br_main" },
      { seq: 2, event_id: "evt_apply_1", type: "file:diff_applied", change_id: "change_1", files: ["a.txt"], branch_id: "br_main" },
      { seq: 3, event_id: "evt_apply_2", type: "file:diff_applied", change_id: "change_2", files: ["b.txt"], branch_id: "br_main" }
    ],
    getActiveBranchId: async () => activeBranch,
    createBranch: async (input) => ({ branch_id: "br_child", ...input }),
    activateBranch: async (branchId) => { activeBranch = branchId; return { branch_id: branchId }; },
    rollback: async (input) => {
      rollbackCalls.push(input);
      return { status: "success", metadata: { change_id: input.change_id, files: [] } };
    }
  });

  const result = await service.apply({ target: { turn_id: "turn_1" } });

  assert.equal(result.status, "success");
  assert.deepEqual(rollbackCalls.map((call) => call.change_id), ["change_2", "change_1"]);
  assert.equal(activeBranch, "br_child");
  assert.equal(published.some((event) => event.type === "session:rewind_applied"), true);
});

test("rewind apply stops on conflict and does not activate child branch", async () => {
  const eventBus = createEventBus();
  const conflicts = [];
  eventBus.subscribe("session:rewind_conflict", (data) => conflicts.push(data));
  let activeBranch = "br_main";
  const service = createRewindService({
    eventBus,
    getTimeline: async () => [
      { seq: 1, event_id: "evt_user_1", type: "user:message", turn_id: "turn_1", branch_id: "br_main" },
      { seq: 2, event_id: "evt_apply_1", type: "file:diff_applied", change_id: "change_1", files: ["a.txt"], branch_id: "br_main" },
      { seq: 3, event_id: "evt_apply_2", type: "file:diff_applied", change_id: "change_2", files: ["b.txt"], branch_id: "br_main" }
    ],
    getActiveBranchId: async () => activeBranch,
    createBranch: async () => { throw new Error("should not create branch on conflict"); },
    activateBranch: async () => { throw new Error("should not activate branch on conflict"); },
    rollback: async ({ change_id }) => change_id === "change_2"
      ? { status: "conflict", metadata: { change_id, conflicts: [{ path: "b.txt", reason: "dirty" }] } }
      : { status: "success", metadata: { change_id } }
  });

  const result = await service.apply({ target: { turn_id: "turn_1" } });

  assert.equal(result.status, "conflict");
  assert.equal(activeBranch, "br_main");
  assert.equal(result.failed_change_id, "change_2");
  assert.equal(conflicts.length, 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
npm.cmd test -- tests/unit/sessions/rewind-service.test.js
```

Expected: FAIL because `apply()` throws `rewind apply unavailable before V2-12C`.

- [ ] **Step 3: Implement apply in rewind-service.js**

Replace `apply()` in `src/sessions/rewind-service.js`:

```js
  async function apply({ target, branch_id = null, force = false, label = "" } = {}) {
    if (typeof createBranch !== "function") throw new Error("createBranch is required");
    if (typeof activateBranch !== "function") throw new Error("activateBranch is required");
    const previewResult = await preview({ target, branch_id });
    const currentBranchId = previewResult.current_branch_id;
    publish("session:rewind_started", {
      current_branch_id: currentBranchId,
      target: previewResult.target,
      rollback_change_ids: previewResult.rollback_change_ids,
      forced: Boolean(force)
    });

    const appliedRollbacks = [];
    for (const changeId of previewResult.rollback_change_ids) {
      const result = await rollback({ change_id: changeId, force: Boolean(force) });
      if (result.status === "conflict") {
        const conflict = {
          status: "conflict",
          current_branch_id: currentBranchId,
          attempted_branch_id: previewResult.planned_branch_id,
          failed_change_id: changeId,
          applied_rollbacks: appliedRollbacks,
          remaining_change_ids: previewResult.rollback_change_ids.slice(appliedRollbacks.length),
          conflicts: result.metadata?.conflicts || [],
          forced: Boolean(force)
        };
        publish("session:rewind_conflict", conflict);
        return conflict;
      }
      if (result.status !== "success") {
        const failed = {
          status: "failed",
          current_branch_id: currentBranchId,
          failed_change_id: changeId,
          applied_rollbacks: appliedRollbacks,
          reason: result.content?.[0]?.text || result.status || "rollback failed"
        };
        publish("session:rewind_failed", failed);
        return failed;
      }
      appliedRollbacks.push(changeId);
    }

    const branch = await createBranch({
      parent_branch_id: currentBranchId,
      forked_from_event_id: previewResult.target.event_id,
      forked_from_seq: previewResult.target.seq,
      forked_from_turn_id: previewResult.target.turn_id,
      label: label || `rewind to ${previewResult.target.turn_id || previewResult.target.event_id || previewResult.target.seq}`
    });
    publish("session:branch_created", {
      branch_id: branch.branch_id,
      parent_branch_id: branch.parent_branch_id,
      forked_from_event_id: branch.forked_from_event_id,
      forked_from_seq: branch.forked_from_seq,
      forked_from_turn_id: branch.forked_from_turn_id
    });
    await activateBranch(branch.branch_id);
    publish("session:branch_activated", {
      branch_id: branch.branch_id,
      parent_branch_id: branch.parent_branch_id
    });
    const success = {
      status: "success",
      previous_branch_id: currentBranchId,
      branch_id: branch.branch_id,
      target: previewResult.target,
      rollback_change_ids: previewResult.rollback_change_ids,
      applied_rollbacks: appliedRollbacks,
      files: previewResult.files,
      forced: Boolean(force)
    };
    publish("session:rewind_applied", success);
    return success;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```powershell
npm.cmd test -- tests/unit/sessions/rewind-service.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit Task 6**

Run:

```powershell
git add src/sessions/rewind-service.js tests/unit/sessions/rewind-service.test.js
git commit -m "feat(v2): apply branching conversation rewind"
```

---

### Task 7: Kernel Rewind Integration

**Files:**
- Modify: `src/index.js`
- Modify: `src/sessions/event-types.js`
- Test: `tests/unit/sessions/event-types.test.js`
- Test: `tests/integration/v2-branching-rewind.test.js`

- [ ] **Step 1: Add failing event type assertions**

In `tests/unit/sessions/event-types.test.js`, add these event types to the canonical list:

```js
    "session:branch_created",
    "session:branch_activated",
    "session:rewind_preview",
    "session:rewind_started",
    "session:rewind_applied",
    "session:rewind_conflict",
    "session:rewind_failed",
```

- [ ] **Step 2: Add failing integration tests**

Create `tests/integration/v2-branching-rewind.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createKernel } from "../../src/index.js";
import { createToolCall } from "../../src/core/protocol/index.js";

const DIFF_A = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old a\n+new a";
const DIFF_B = "diff --git a/b.txt b/b.txt\n--- a/b.txt\n+++ b/b.txt\n@@ -1 +1 @@\n-old b\n+new b";

test("kernel rewind preview and apply create child branch and rollback later edits", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-v2-rewind-"));
  await writeFile(path.join(root, "a.txt"), "old a\n");
  await writeFile(path.join(root, "b.txt"), "old b\n");
  const kernel = await createKernel(root, {
    sessionRoot: path.join(root, ".sessions"),
    sessionId: "sess_rewind",
    context: { disabled: true }
  });

  kernel.eventBus.publish("user:message", { turn_id: "turn_1", content: "edit a" });
  await kernel.tools.execute(
    createToolCall({ name: "edit", params: { diff: DIFF_A, prompt: "edit a" }, requestedByStepId: "step_1" }),
    { autonomy: "gated", turnId: "turn_1" }
  );
  kernel.eventBus.publish("agent:final", { turn_id: "turn_1", content: "done a" });
  kernel.eventBus.publish("user:message", { turn_id: "turn_2", content: "edit b" });
  await kernel.tools.execute(
    createToolCall({ name: "edit", params: { diff: DIFF_B, prompt: "edit b" }, requestedByStepId: "step_2" }),
    { autonomy: "gated", turnId: "turn_2" }
  );
  await kernel.session.flush();

  const preview = await kernel.session.rewind.preview({ target: { turn_id: "turn_1" } });
  assert.equal(preview.rollback_count, 1);

  const result = await kernel.session.rewind.apply({ target: { turn_id: "turn_1" } });

  assert.equal(result.status, "success");
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "new a\n");
  assert.equal(await readFile(path.join(root, "b.txt"), "utf8"), "old b\n");
  assert.notEqual((await kernel.session.branches.getActive()).branch_id, "br_main");
});

test("kernel rewind conflict leaves active branch unchanged", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-v2-rewind-conflict-"));
  await writeFile(path.join(root, "a.txt"), "old a\n");
  await writeFile(path.join(root, "b.txt"), "old b\n");
  const kernel = await createKernel(root, {
    sessionRoot: path.join(root, ".sessions"),
    sessionId: "sess_rewind_conflict",
    context: { disabled: true }
  });

  kernel.eventBus.publish("user:message", { turn_id: "turn_1", content: "edit a" });
  await kernel.tools.execute(
    createToolCall({ name: "edit", params: { diff: DIFF_A, prompt: "edit a" }, requestedByStepId: "step_1" }),
    { autonomy: "gated", turnId: "turn_1" }
  );
  kernel.eventBus.publish("agent:final", { turn_id: "turn_1", content: "done a" });
  kernel.eventBus.publish("user:message", { turn_id: "turn_2", content: "edit b" });
  await kernel.tools.execute(
    createToolCall({ name: "edit", params: { diff: DIFF_B, prompt: "edit b" }, requestedByStepId: "step_2" }),
    { autonomy: "gated", turnId: "turn_2" }
  );
  await writeFile(path.join(root, "b.txt"), "manual b\n");
  await kernel.session.flush();

  const result = await kernel.session.rewind.apply({ target: { turn_id: "turn_1" } });

  assert.equal(result.status, "conflict");
  assert.equal((await kernel.session.branches.getActive()).branch_id, "br_main");
  assert.equal(await readFile(path.join(root, "b.txt"), "utf8"), "manual b\n");
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```powershell
npm.cmd test -- tests/unit/sessions/event-types.test.js tests/integration/v2-branching-rewind.test.js
```

Expected: FAIL because events and `kernel.session.rewind` are missing.

- [ ] **Step 4: Register event types**

In `src/sessions/event-types.js`, add:

```js
  "session:branch_created",
  "session:branch_activated",
  "session:rewind_preview",
  "session:rewind_started",
  "session:rewind_applied",
  "session:rewind_conflict",
  "session:rewind_failed",
```

near `session:start` and `session:resume`.

- [ ] **Step 5: Wire rewind service into kernel session facade**

In `src/index.js`, add import:

```js
import { createRewindService } from "./sessions/rewind-service.js";
```

After `branches` is created, add:

```js
  const rewind = createRewindService({
    eventBus,
    getTimeline: (input) => sessionManager.getTimeline(input),
    getActiveBranchId: () => Promise.resolve(activeBranchId),
    createBranch: (input) => branchStore.createBranch(input),
    activateBranch: async (branchId) => {
      const branch = await branchStore.activateBranch(branchId);
      activeBranchId = branch.branch_id;
      return branch;
    },
    rollback: (input) => editService.rollback(input)
  });
```

Expose in `session`:

```js
    rewind,
    checkpoints: {
      async list({ branch_id = activeBranchId } = {}) {
        const timeline = await sessionManager.getTimeline({ count: 10000, branch_id });
        return buildCheckpointIndex(timeline, { branch_id }).checkpoints;
      }
    },
```

Also import:

```js
import { buildCheckpointIndex } from "./sessions/checkpoint-index.js";
```

- [ ] **Step 6: Run tests to verify they pass**

Run:

```powershell
npm.cmd test -- tests/unit/sessions/event-types.test.js tests/integration/v2-branching-rewind.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit Task 7**

Run:

```powershell
git add src/index.js src/sessions/event-types.js tests/unit/sessions/event-types.test.js tests/integration/v2-branching-rewind.test.js
git commit -m "feat(v2): wire branching rewind into kernel"
```

---

## V2-12D: Interface Hooks and Checks

### Task 8: GUI Host and CLI Event Summaries

**Files:**
- Modify: `gui/kernel-host.js`
- Modify: `src/apps/cli/render-events.js`
- Test: `tests/unit/gui/kernel-host.test.js`
- Test: `tests/unit/apps/cli/render-events.test.js`

- [ ] **Step 1: Add failing GUI host tests**

Append to `tests/unit/gui/kernel-host.test.js`:

```js
test("kernel host exposes branch and rewind delegates", async () => {
  const host = createKernelHost({
    kernelFactory: async () => ({
      session: {
        subscribe: () => ({ unsubscribe() {} }),
        getTimeline: async () => [],
        branches: {
          list: async () => [{ branch_id: "br_main" }],
          getActive: async () => ({ branch_id: "br_main" })
        },
        checkpoints: { list: async () => [{ checkpoint_id: "cp_1" }] },
        rewind: {
          preview: async () => ({ status: "success" }),
          apply: async () => ({ status: "success" })
        }
      },
      context: { snapshot: async () => ({ units: [] }) },
      metrics: { getUsage: () => zeroUsage() },
      config: { getPublicConfig: () => ({}) },
      runtime: { getState: () => ({ current: "idle" }) },
      agent: { send: async () => {}, approve: async () => {}, interrupt: () => {} }
    }),
    configLoader: async () => ({})
  });
  await host.init();

  assert.deepEqual(await host.listBranches(), [{ branch_id: "br_main" }]);
  assert.deepEqual(await host.listCheckpoints(), [{ checkpoint_id: "cp_1" }]);
  assert.equal((await host.rewindPreview({ target: { seq: 1 } })).status, "success");
  assert.equal((await host.rewindApply({ target: { seq: 1 } })).status, "success");
});
```

- [ ] **Step 2: Add failing CLI render tests**

Append to `tests/unit/apps/cli/render-events.test.js`:

```js
test("summarizeKernelEvent renders branch and rewind events", () => {
  assert.equal(summarizeKernelEvent({ type: "session:branch_created", branch_id: "br_child" }), "branch created br_child");
  assert.equal(summarizeKernelEvent({ type: "session:branch_activated", branch_id: "br_child" }), "branch active br_child");
  assert.equal(summarizeKernelEvent({ type: "session:rewind_applied", branch_id: "br_child", rollback_change_ids: ["a", "b"] }), "rewind applied br_child 2 changes");
  assert.equal(summarizeKernelEvent({ type: "session:rewind_conflict", failed_change_id: "change_1" }), "rewind conflict change_1");
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```powershell
npm.cmd test -- tests/unit/gui/kernel-host.test.js tests/unit/apps/cli/render-events.test.js
```

Expected: FAIL because delegates and summaries are missing.

- [ ] **Step 4: Add GUI host delegates**

In `gui/kernel-host.js`, add functions:

```js
  async function listBranches() {
    return ready() ? requireKernel().session.branches?.list?.() || [] : [];
  }

  async function listCheckpoints(options = {}) {
    return ready() ? requireKernel().session.checkpoints?.list?.(options) || [] : [];
  }

  async function rewindPreview(options = {}) {
    return requireKernel().session.rewind.preview(options);
  }

  async function rewindApply(options = {}) {
    return requireKernel().session.rewind.apply(options);
  }
```

Add them to the returned object:

```js
  return {
    init,
    ready,
    send,
    approve,
    interrupt,
    getTimeline,
    getSnapshot,
    getUsage,
    getConfig,
    getState,
    listBranches,
    listCheckpoints,
    rewindPreview,
    rewindApply,
    dispose
  };
```

- [ ] **Step 5: Add CLI event summaries**

In `src/apps/cli/render-events.js`, add:

```js
  if (event.type === "session:branch_created") return `branch created ${event.branch_id || "unknown"}`;
  if (event.type === "session:branch_activated") return `branch active ${event.branch_id || "unknown"}`;
  if (event.type === "session:rewind_preview") return `rewind preview ${event.rollback_count || event.rollback_change_ids?.length || 0} changes`;
  if (event.type === "session:rewind_applied") return `rewind applied ${event.branch_id || "unknown"} ${(event.rollback_change_ids || []).length} changes`;
  if (event.type === "session:rewind_conflict") return `rewind conflict ${event.failed_change_id || "unknown"}`;
  if (event.type === "session:rewind_failed") return `rewind failed ${event.failed_change_id || event.reason || "unknown"}`;
```

near the other session/file event cases.

- [ ] **Step 6: Run tests to verify they pass**

Run:

```powershell
npm.cmd test -- tests/unit/gui/kernel-host.test.js tests/unit/apps/cli/render-events.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit Task 8**

Run:

```powershell
git add gui/kernel-host.js src/apps/cli/render-events.js tests/unit/gui/kernel-host.test.js tests/unit/apps/cli/render-events.test.js
git commit -m "feat(v2): expose rewind interface hooks"
```

---

### Task 9: Package Check and Full Regression

**Files:**
- Modify: `package.json`
- Test: full suite

- [ ] **Step 1: Add new session modules to syntax check**

In `package.json`, update the session check segment from:

```json
"src/sessions/event-types.js src/sessions/event-log.js src/sessions/session-manager.js"
```

to:

```json
"src/sessions/event-types.js src/sessions/event-log.js src/sessions/branch-store.js src/sessions/checkpoint-index.js src/sessions/rewind-service.js src/sessions/session-manager.js"
```

- [ ] **Step 2: Run focused V2-12 tests**

Run:

```powershell
npm.cmd test -- tests/unit/sessions/branch-store.test.js tests/unit/sessions/session-manager.test.js tests/unit/sessions/checkpoint-index.test.js tests/unit/sessions/rewind-service.test.js tests/integration/v2-branching-rewind.test.js tests/unit/sessions/event-types.test.js tests/unit/gui/kernel-host.test.js tests/unit/apps/cli/render-events.test.js
```

Expected: PASS.

- [ ] **Step 3: Run full test suite**

Run:

```powershell
npm.cmd test
```

Expected: all tests pass. Total test count should be greater than the V2-11 baseline of 443.

- [ ] **Step 4: Run syntax check**

Run:

```powershell
npm.cmd run check
```

Expected: PASS with no `SyntaxError`.

- [ ] **Step 5: Run whitespace check**

Run:

```powershell
git diff --check
```

Expected: PASS. If warnings mention pre-existing user-local files, verify no V2-12 files are listed.

- [ ] **Step 6: Run pollution check**

Run:

```powershell
if (Test-Path -LiteralPath ".deepseek-code\v2") { throw ".deepseek-code/v2 should not be created by tests" } else { "no v2 session pollution" }
```

Expected: `no v2 session pollution`.

- [ ] **Step 7: Commit Task 9**

Run:

```powershell
git add package.json
git commit -m "chore(v2): include branching rewind checks"
```

---

## Final Review Checklist

- [ ] Branch metadata persists and reopens.
- [ ] `br_main` is created lazily for old sessions.
- [ ] Runtime events are stamped with active `branch_id`.
- [ ] `getTimeline(count)` remains backward compatible.
- [ ] Branch timeline filtering includes ancestor events up to fork points.
- [ ] Checkpoint index resolves targets by `event_id`, `seq`, and `turn_id`.
- [ ] Rewind preview is read-only.
- [ ] Rewind apply rolls back changes in reverse order.
- [ ] Successful rewind creates and activates a child branch.
- [ ] Dirty conflict leaves active branch unchanged.
- [ ] Future turns after rewind use the child branch id.
- [ ] GUI host exposes branch/rewind delegates.
- [ ] Rewind events do not include raw diffs or file contents.
- [ ] Full tests, syntax check, whitespace check, and pollution check pass.

## Execution Notes

Use one commit per task. If this feels too large, stop cleanly after V2-12A, V2-12B, or V2-12C and report the completed phase plus remaining phases. Do not collapse this into a light rewind implementation; the branch data model must exist from V2-12A onward.
