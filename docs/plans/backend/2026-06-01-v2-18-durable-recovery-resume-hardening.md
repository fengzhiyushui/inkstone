# V2-18 Durable Recovery / Resume Hardening Implementation Plan

> 完成状态以 [CHANGELOG](../../CHANGELOG.md) 为准。


**Goal:** Implement process-crash durable recovery for V2 approval/repair pauses, agent-managed edit/rewind transactions, single-writer takeover, and the shared Recovery Center UX.

**Architecture:** Add a focused `src/core/recovery/` subsystem for atomic sidecars, project locks, transaction journals, inbox state, and startup reconciliation. Wire it through `createKernel()` so CLI/TUI/GUI all use the same kernel recovery API, while edit/rewind/runtime code keep their existing public behavior and add durable persistence behind their existing seams.

**Tech Stack:** Node.js ESM, `node:test`, `node:fs/promises`, existing V2 kernel/event/session/edit/rewind modules, CommonJS GUI host/renderer adapters.

---

## Execution Split Update

After starting implementation, V2-18 proved too large to execute as one uninterrupted milestone. Keep this plan as the full umbrella plan, but execute it in smaller release slices:

### V2-18a: Recovery Infrastructure

Scope:

- Task 1: Recovery atomic writes and fault injection
- Task 2: Recovery event types and safe render summaries
- Task 3: Project lock with takeover and epoch fencing
- Task 4: Recovery Inbox persisted item model

Goal: establish the safe local recovery substrate before wiring paused-turn or transaction recovery deeply into runtime behavior.

### V2-18b: Durable Approval / Repair Resume

Scope:

- Task 5: Paused-turn sidecar persistence and store helpers
- Task 6: Preserve permission context and repair resume shape
- Relevant parts of Task 10/11/12 needed to expose approval/repair recovery through the kernel and CLI

Goal: make approval/repair pauses survive process restart with user resume/cancel semantics.

### V2-18c: Durable Edit / Rewind Transaction Recovery

Scope:

- Task 7: Transaction journal with byte snapshots and recovered artifacts
- Task 8: Journal managed edit transactions
- Task 9: Journal rewind transactions and restore branch state
- Task 14: Recovery end-to-end fault injection coverage
- Remaining parts of Task 10/11/12/13/15 needed for full integration and verification

Goal: roll back interrupted agent-managed edit/rewind transactions and expose recovery state through CLI/GUI.

### Deferred GUI Redesign

The DeepSeek Code IDE visual redesign based on `DeepSeekCodeIDE.jsx` is intentionally deferred until after the V2 runtime/recovery iteration stabilizes. See `docs/plans/frontend/2026-06-01-future-gui-deepseek-code-ide-redesign.md`.

## Scope Check

The spec spans multiple subsystems, but they are not independent products: the lock must guard recovery, recovery must scan sidecars/journals, paused-turn persistence depends on runtime approval resume, and CLI/GUI expose the same kernel recovery model. Keep this as the umbrella plan, but execute it using the V2-18a/V2-18b/V2-18c split above so each slice produces smaller, reviewable, testable software.

## File Structure

### Create

- `src/core/recovery/atomic-file.js` — atomic JSON/blob write helpers, directory-local temp handling, safe path segment helpers.
- `src/core/recovery/recovery-faults.js` — deterministic fault injection used by tests and disabled by default.
- `src/core/recovery/recovery-errors.js` — sanitized recovery error creation and categorization.
- `src/core/recovery/project-lock.js` — lock directory acquisition, heartbeat, takeover request files, epoch ownership checks.
- `src/core/recovery/recovery-inbox.js` — persisted `.deepseek-code/v2/recovery/inbox.json` item model.
- `src/core/recovery/paused-turn-persistence.js` — paused sidecar save/load/delete/quarantine and project-scoped scan.
- `src/core/recovery/transaction-journal.js` — byte-oriented transaction journals, recovered artifact writes, commit matrix helpers.
- `src/core/recovery/recovery-service.js` — boot recovery orchestration and `kernel.recovery.*` API.

### Modify

- `src/sessions/event-types.js` — add V2-18 lifecycle events.
- `src/sessions/session-manager.js` — expose awaited marker persistence helper or rely on `publish` + `flush` in recovery callers.
- `src/core/approval/paused-turn-store.js` — add list/restore/delete helpers and optional persistence callbacks.
- `src/core/runtime/agent-runtime.js` — persist paused records, list/cancel paused, preserve permission context on resume, fix durable repair resume shape.
- `src/core/verification/repair-loop.js` — include `repair_context.initial_tool_results` on repair approval pause.
- `src/core/execution/executor-loop.js` — carry permission context through resume state.
- `src/edits/edit-transaction.js` — add byte snapshot/restore APIs and owner/fault hooks.
- `src/edits/edit-service.js` — open/commit/abort journals around apply.
- `src/sessions/rewind-transaction.js` — add byte snapshot/restore APIs for rewind journal.
- `src/sessions/branch-store.js` — expose branch state snapshot/restore for rewind recovery.
- `src/sessions/rewind-service.js` — open/commit/abort rewind journal and restore branch state.
- `src/index.js` — wire recovery subsystem, lock, recovery scan, and `kernel.recovery` facade.
- `src/apps/cli/render-events.js` — render recovery/takeover lifecycle events safely.
- `src/apps/cli/kernel-runner.js` — add `/recovery` REPL commands and takeover prompt path.
- `gui/kernel-host.js` — expose recovery API methods to GUI.
- `gui/renderer/event-adapter.js` — summarize recovery events and map status channel.
- `package.json` — add new recovery source files to `npm.cmd run check`.
- `README.md` — update known limitations after implementation.

### Test Files

- `tests/unit/core/recovery/atomic-file.test.js`
- `tests/unit/core/recovery/recovery-faults.test.js`
- `tests/unit/core/recovery/project-lock.test.js`
- `tests/unit/core/recovery/recovery-inbox.test.js`
- `tests/unit/core/recovery/paused-turn-persistence.test.js`
- `tests/unit/core/recovery/transaction-journal.test.js`
- `tests/unit/core/recovery/recovery-service.test.js`
- `tests/unit/core/approval/paused-turn-store.test.js`
- `tests/unit/core/verification/repair-loop.test.js`
- `tests/integration/v2-durable-paused-turn.test.js`
- `tests/integration/v2-recovery-edit-journal.test.js`
- `tests/integration/v2-recovery-rewind-journal.test.js`
- `tests/integration/v2-recovery-center-kernel.test.js`
- `tests/unit/apps/cli/kernel-runner.test.js`
- `tests/unit/apps/cli/render-events.test.js`
- `tests/unit/gui/kernel-host.test.js`
- `tests/unit/gui/renderer-event-adapter.test.js`

---

## Task 1: Recovery atomic writes and fault injection

**Files:**
- Create: `src/core/recovery/atomic-file.js`
- Create: `src/core/recovery/recovery-faults.js`
- Test: `tests/unit/core/recovery/atomic-file.test.js`
- Test: `tests/unit/core/recovery/recovery-faults.test.js`
- Modify: `package.json`

- [ ] **Step 1: Write failing atomic-file tests**

Add `tests/unit/core/recovery/atomic-file.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  atomicReadJson,
  atomicWriteBytes,
  atomicWriteJson,
  cleanupAtomicTemps,
  safeRecoverySegment
} from "../../../../src/core/recovery/atomic-file.js";

test("atomicWriteJson writes readable JSON and ignores temp leftovers", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-atomic-json-"));
  const target = path.join(root, "state.json");

  await atomicWriteJson(target, { schema_version: 1, value: "ok" });
  const loaded = await atomicReadJson(target);

  assert.deepEqual(loaded, { schema_version: 1, value: "ok" });
  assert.deepEqual((await readdir(root)).filter((name) => name.includes(".tmp")), []);
});

test("atomicWriteBytes preserves binary bytes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-atomic-bytes-"));
  const target = path.join(root, "blob.bin");
  const bytes = Buffer.from([0, 255, 12, 10, 65]);

  await atomicWriteBytes(target, bytes);

  assert.deepEqual(await readFile(target), bytes);
});

test("cleanupAtomicTemps removes only recovery temp files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-atomic-clean-"));
  await atomicWriteBytes(path.join(root, "keep.txt"), Buffer.from("keep"));
  await atomicWriteBytes(path.join(root, ".recovery-tmp-a"), Buffer.from("tmp"));

  const removed = await cleanupAtomicTemps(root);

  assert.equal(removed.includes(".recovery-tmp-a"), true);
  assert.equal((await readdir(root)).includes("keep.txt"), true);
});

test("safeRecoverySegment rejects traversal and keeps portable ids", () => {
  assert.equal(safeRecoverySegment("tx_123"), "tx_123");
  assert.throws(() => safeRecoverySegment("../evil"), /invalid recovery path segment/);
  assert.throws(() => safeRecoverySegment(""), /invalid recovery path segment/);
});
```

- [ ] **Step 2: Write failing fault-injection tests**

Add `tests/unit/core/recovery/recovery-faults.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createRecoveryFaults } from "../../../../src/core/recovery/recovery-faults.js";

test("recovery faults are no-op by default", async () => {
  const faults = createRecoveryFaults();
  await faults.maybe("after-journal-write");
  assert.equal(faults.hitCount("after-journal-write"), 0);
});

test("recovery faults throw once for configured labels", async () => {
  const faults = createRecoveryFaults({ labels: ["after-journal-write"] });

  await assert.rejects(() => faults.maybe("after-journal-write"), /recovery fault: after-journal-write/);
  await faults.maybe("after-journal-write");
  assert.equal(faults.hitCount("after-journal-write"), 1);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
node --test tests/unit/core/recovery/atomic-file.test.js tests/unit/core/recovery/recovery-faults.test.js
```

Expected: FAIL with module-not-found errors for `src/core/recovery/atomic-file.js` and `src/core/recovery/recovery-faults.js`.

- [ ] **Step 4: Implement `atomic-file.js`**

Create `src/core/recovery/atomic-file.js` with these exports and behavior:

```js
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export async function atomicWriteJson(filePath, value) {
  const json = `${JSON.stringify(value, null, 2)}\n`;
  await atomicWriteBytes(filePath, Buffer.from(json, "utf8"));
}

export async function atomicReadJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

export async function atomicWriteBytes(filePath, bytes) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = path.join(path.dirname(filePath), `.recovery-tmp-${process.pid}-${randomUUID()}`);
  await fs.writeFile(temp, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
  await fs.rename(temp, filePath);
}

export async function cleanupAtomicTemps(directory) {
  let entries;
  try {
    entries = await fs.readdir(directory);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const removed = [];
  for (const entry of entries) {
    if (!entry.startsWith(".recovery-tmp-")) continue;
    await fs.rm(path.join(directory, entry), { force: true, recursive: true });
    removed.push(entry);
  }
  return removed;
}

export function safeRecoverySegment(value) {
  const text = String(value || "");
  if (!/^[a-zA-Z0-9._-]{1,120}$/.test(text)) {
    throw new Error(`invalid recovery path segment: ${value}`);
  }
  return text;
}
```

- [ ] **Step 5: Implement `recovery-faults.js`**

Create `src/core/recovery/recovery-faults.js`:

```js
export function createRecoveryFaults(input = {}) {
  const labels = new Set(Array.isArray(input.labels) ? input.labels : []);
  const hits = new Map();
  return {
    async maybe(label) {
      if (!labels.has(label)) return;
      const count = hits.get(label) || 0;
      if (count > 0) return;
      hits.set(label, count + 1);
      const error = new Error(`recovery fault: ${label}`);
      error.code = "RECOVERY_FAULT";
      error.label = label;
      throw error;
    },
    hitCount(label) {
      return hits.get(label) || 0;
    }
  };
}
```

- [ ] **Step 6: Update `package.json` syntax check**

Add the two new files to the V2 `node --check` group in `package.json`:

```text
src/core/recovery/atomic-file.js src/core/recovery/recovery-faults.js
```

- [ ] **Step 7: Run tests to verify they pass**

Run:

```bash
node --test tests/unit/core/recovery/atomic-file.test.js tests/unit/core/recovery/recovery-faults.test.js
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add package.json src/core/recovery/atomic-file.js src/core/recovery/recovery-faults.js tests/unit/core/recovery/atomic-file.test.js tests/unit/core/recovery/recovery-faults.test.js
git commit -m "feat(v2): add recovery atomic writes and faults"
```

---

## Task 2: Recovery event types and safe render summaries

**Files:**
- Modify: `src/sessions/event-types.js`
- Modify: `src/apps/cli/render-events.js`
- Modify: `gui/renderer/event-adapter.js`
- Test: `tests/unit/sessions/event-types.test.js`
- Test: `tests/unit/apps/cli/render-events.test.js`
- Test: `tests/unit/gui/renderer-event-adapter.test.js`

- [ ] **Step 1: Add failing event-type assertions**

Append to `tests/unit/sessions/event-types.test.js`:

```js
test("V2-18 recovery lifecycle events are registered", () => {
  for (const type of [
    "recovery:started",
    "recovery:blocked",
    "recovery:report",
    "tx:opened",
    "tx:committed",
    "tx:recovered",
    "turn:paused",
    "turn:rehydrated",
    "turn:resumed",
    "turn:cancelled",
    "takeover:requested",
    "takeover:completed"
  ]) {
    assert.equal(isSessionEventType(type), true, `${type} should be registered`);
  }
});
```

- [ ] **Step 2: Add failing CLI renderer test**

Append to `tests/unit/apps/cli/render-events.test.js`:

```js
test("renderer summarizes recovery events without payload leaks", () => {
  const lines = [
    ...renderEvent({ type: "recovery:report", found_count: 2, done_count: 1, blocked_count: 0 }),
    ...renderEvent({ type: "tx:recovered", tx_id: "tx_123", kind: "edit", preserved_count: 1 }),
    ...renderEvent({ type: "turn:rehydrated", approval_id: "approval_456", marker_status: "ok" })
  ];

  assert.ok(lines.some((line) => line.includes("recovery report: found 2, done 1, blocked 0")));
  assert.ok(lines.some((line) => line.includes("recovered edit tx_123")));
  assert.ok(lines.some((line) => line.includes("rehydrated approval approval_456")));
  assert.equal(lines.join("\n").includes("resume_state"), false);
});
```

If the existing helper is named `renderKernelEvent` instead of `renderEvent`, use the exported renderer function already imported in that file and keep the assertions identical.

- [ ] **Step 3: Add failing GUI adapter test**

Append to `tests/unit/gui/renderer-event-adapter.test.js`:

```js
test("renderer adapter summarizes recovery events", () => {
  assert.equal(adapter.eventIcon("recovery:blocked"), "!");
  assert.equal(adapter.eventIcon("tx:recovered"), "R");
  assert.equal(
    adapter.summarizeEvent({ type: "recovery:report", found_count: 2, done_count: 1, blocked_count: 0 }),
    "recovery report 2 found, 1 done, 0 blocked"
  );
  assert.equal(
    adapter.summarizeEvent({ type: "turn:rehydrated", approval_id: "approval_1" }),
    "approval rehydrated approval_1"
  );
  assert.deepEqual(adapter.statusFromEvent({ type: "recovery:started" }), { channel: "recovery" });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run:

```bash
node --test tests/unit/sessions/event-types.test.js tests/unit/apps/cli/render-events.test.js tests/unit/gui/renderer-event-adapter.test.js
```

Expected: FAIL because new event types and summaries are missing.

- [ ] **Step 5: Add recovery event types**

In `src/sessions/event-types.js`, add these entries to `SESSION_EVENT_TYPES` near related session/tool events:

```js
"recovery:started",
"recovery:blocked",
"recovery:report",
"tx:opened",
"tx:committed",
"tx:recovered",
"turn:paused",
"turn:rehydrated",
"turn:resumed",
"turn:cancelled",
"takeover:requested",
"takeover:completed",
```

- [ ] **Step 6: Add safe CLI rendering**

In `src/apps/cli/render-events.js`, add cases that render only IDs/counts/statuses:

```js
case "recovery:report":
  return [`recovery report: found ${event.found_count || 0}, done ${event.done_count || 0}, blocked ${event.blocked_count || 0}`];
case "recovery:blocked":
  return [`recovery blocked: ${event.reason || "unknown"} (${event.item_id || event.source_id || "unknown"})`];
case "tx:recovered":
  return [`recovered ${event.kind || "transaction"} ${event.tx_id || "unknown"}, preserved ${event.preserved_count || 0}`];
case "turn:rehydrated":
  return [`rehydrated approval ${event.approval_id || "unknown"}`];
case "turn:cancelled":
  return [`cancelled approval ${event.approval_id || "unknown"}`];
case "takeover:requested":
  return [`takeover requested ${event.request_id || "unknown"}`];
case "takeover:completed":
  return [`takeover completed ${event.request_id || "unknown"}`];
```

Use the existing renderer's switch/if style and avoid printing prompts, diffs, file contents, or raw errors.

- [ ] **Step 7: Add GUI event adapter summaries**

In `gui/renderer/event-adapter.js`, add icons and summaries:

```js
"recovery:started": "R",
"recovery:blocked": "!",
"recovery:report": "R",
"tx:opened": "T",
"tx:committed": "T",
"tx:recovered": "R",
"turn:paused": "A",
"turn:rehydrated": "A",
"turn:resumed": "A",
"turn:cancelled": "A",
"takeover:requested": "!",
"takeover:completed": "R"
```

Add summaries:

```js
if (event.type === "recovery:report") return "recovery report " + (event.found_count || 0) + " found, " + (event.done_count || 0) + " done, " + (event.blocked_count || 0) + " blocked";
if (event.type === "recovery:blocked") return "recovery blocked " + (event.reason || event.item_id || "unknown");
if (event.type === "tx:recovered") return "recovered " + (event.kind || "tx") + " " + (event.tx_id || "unknown");
if (event.type === "turn:rehydrated") return "approval rehydrated " + (event.approval_id || "unknown");
if (event.type === "turn:cancelled") return "approval cancelled " + (event.approval_id || "unknown");
if (event.type === "takeover:requested") return "takeover requested " + (event.request_id || "unknown");
if (event.type === "takeover:completed") return "takeover completed " + (event.request_id || "unknown");
```

Add recovery channel in `statusFromEvent()` for `recovery:*`, `tx:recovered`, and `takeover:*` events.

- [ ] **Step 8: Run tests to verify they pass**

Run:

```bash
node --test tests/unit/sessions/event-types.test.js tests/unit/apps/cli/render-events.test.js tests/unit/gui/renderer-event-adapter.test.js
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/sessions/event-types.js src/apps/cli/render-events.js gui/renderer/event-adapter.js tests/unit/sessions/event-types.test.js tests/unit/apps/cli/render-events.test.js tests/unit/gui/renderer-event-adapter.test.js
git commit -m "feat(v2): register recovery lifecycle events"
```

---

## Task 3: Project lock with takeover and epoch fencing

**Files:**
- Create: `src/core/recovery/project-lock.js`
- Test: `tests/unit/core/recovery/project-lock.test.js`
- Modify: `package.json`

- [ ] **Step 1: Write failing lock acquire/release tests**

Create `tests/unit/core/recovery/project-lock.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireProjectLock } from "../../../../src/core/recovery/project-lock.js";

test("project lock acquires releases and rejects stale owner mutation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-lock-basic-"));
  const lock = await acquireProjectLock({ root, surface: "cli", sessionId: "sess_1" });

  assert.equal(lock.owner.surface, "cli");
  await lock.assertOwner();
  await lock.release();
  await assert.rejects(() => lock.assertOwner(), /lock not owned/);
});

test("second live lock fails closed without takeover", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-lock-live-"));
  const first = await acquireProjectLock({ root, surface: "cli", sessionId: "sess_1" });

  await assert.rejects(
    () => acquireProjectLock({ root, surface: "cli", sessionId: "sess_2", interactive: false }),
    /project is already locked/
  );

  await first.release();
});
```

- [ ] **Step 2: Write failing takeover tests**

Append to `tests/unit/core/recovery/project-lock.test.js`:

```js
test("takeover request file is created and earliest request wins", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-lock-takeover-"));
  const first = await acquireProjectLock({ root, surface: "gui", sessionId: "sess_owner" });

  const requestA = await first.createTakeoverRequestForTest({ requesterToken: "req_a", requestedAt: "2026-06-01T00:00:02.000Z" });
  const requestB = await first.createTakeoverRequestForTest({ requesterToken: "req_b", requestedAt: "2026-06-01T00:00:03.000Z" });
  const winner = await first.readWinningTakeoverRequest();

  assert.equal(requestA.request_id, winner.request_id);
  assert.notEqual(requestB.request_id, winner.request_id);
  await first.release();
});

test("force takeover increments epoch and old owner fails fencing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-lock-force-"));
  const first = await acquireProjectLock({ root, surface: "cli", sessionId: "sess_1" });
  const second = await acquireProjectLock({ root, surface: "cli", sessionId: "sess_2", takeover: "force" });

  assert.equal(second.epoch, first.epoch + 1);
  await second.assertOwner();
  await assert.rejects(() => first.assertOwner(), /lock not owned/);
  await second.release();
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
node --test tests/unit/core/recovery/project-lock.test.js
```

Expected: FAIL because `project-lock.js` does not exist.

- [ ] **Step 4: Implement `project-lock.js`**

Create `src/core/recovery/project-lock.js` with this API:

```js
export async function acquireProjectLock({ root, surface, sessionId, interactive = false, takeover = null, now = () => new Date(), pid = process.pid, host = hostname(), faults = createRecoveryFaults() })
```

Implement these exact behaviors:

1. `lockDir = path.join(root, ".deepseek-code", "v2", ".lock")`.
2. Try `fs.mkdir(lockDir, { recursive: false })`.
3. On success, write `owner.json` with `epoch: 1`, token from `randomUUID()`, `pid`, `host`, `surface`, `session_id`, `heartbeat_at`, `phase: "idle"`, `released_at: null`.
4. On `EEXIST`, read `owner.json`; if missing/corrupt, throw `RECOVERY_LOCK_CORRUPT` unless `takeover: "force"`.
5. Treat same-host owner as live when `pid` exists and heartbeat age `< 10000` ms.
6. Treat owner as stale when PID dead, `released_at` is non-null, same-host heartbeat age `>= 10000` ms, or cross-host heartbeat age `>= 30000` ms.
7. If live and no force, throw `RECOVERY_LOCK_HELD` with safe owner metadata.
8. If force or stale, write a new `owner.json` with `epoch = oldEpoch + 1`, then read it back; only return ownership if token/epoch match.
9. `assertOwner()` reloads `owner.json` and checks token/epoch.
10. `release()` writes `released_at`, removes `owner.json`, removes takeover request files, and removes `.lock/` when empty.
11. `heartbeat()` calls `assertOwner()`, then updates `heartbeat_at` with the same token/epoch.
12. `createTakeoverRequestForTest()` and `readWinningTakeoverRequest()` are exported only as methods on the lock object for tests; production callers use `requestTakeover()`.

Use `process.kill(pid, 0)` for same-host liveness and catch errors to classify dead PIDs.

- [ ] **Step 5: Add package syntax entry**

Add to `package.json` check script:

```text
src/core/recovery/project-lock.js
```

- [ ] **Step 6: Run tests to verify they pass**

Run:

```bash
node --test tests/unit/core/recovery/project-lock.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add package.json src/core/recovery/project-lock.js tests/unit/core/recovery/project-lock.test.js
git commit -m "feat(v2): add recovery project lock"
```

---

## Task 4: Recovery Inbox persisted item model

**Files:**
- Create: `src/core/recovery/recovery-inbox.js`
- Test: `tests/unit/core/recovery/recovery-inbox.test.js`
- Modify: `package.json`

- [ ] **Step 1: Write failing inbox tests**

Create `tests/unit/core/recovery/recovery-inbox.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRecoveryInbox } from "../../../../src/core/recovery/recovery-inbox.js";

test("recovery inbox upserts lists and clears safe items", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-inbox-"));
  const inbox = createRecoveryInbox({ root });

  await inbox.upsert({
    id: "rec_tx_tx_1",
    type: "recovered_tx",
    status: "done",
    source_id: "tx_1",
    summary: "rolled back edit",
    evidence: { recovered_path: ".deepseek-code/v2/recovered/tx_1" },
    allowed_actions: ["clear"]
  });

  assert.equal((await inbox.list()).length, 1);
  await inbox.clear("rec_tx_tx_1");
  assert.equal((await inbox.list()).length, 0);
  assert.equal((await inbox.list({ includeCleared: true }))[0].status, "cleared");
});

test("recovery inbox refuses to clear blocked items", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-inbox-blocked-"));
  const inbox = createRecoveryInbox({ root });
  await inbox.upsert({ id: "rec_block_journal", type: "blocked_recovery", status: "blocked", source_id: "journal", summary: "corrupt journal", allowed_actions: [] });

  await assert.rejects(() => inbox.clear("rec_block_journal"), /cannot clear blocked recovery item/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test tests/unit/core/recovery/recovery-inbox.test.js
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement `recovery-inbox.js`**

Create `src/core/recovery/recovery-inbox.js` with:

```js
export function createRecoveryInbox({ root })
```

Implement:

- path: `path.join(root, ".deepseek-code", "v2", "recovery", "inbox.json")`;
- schema: `{ schema_version: 1, items: [] }`;
- `list({ includeCleared = false } = {})` returns items sorted by `created_at`, excluding `status: "cleared"` by default;
- `upsert(item)` validates `id`, `type`, `status`, `source_id`, `summary`, sets `created_at` if new, always updates `updated_at`, and writes atomically;
- `clear(id)` only clears items with `status` in `done`, `cancelled`, or `quarantined`; blocked/pending items throw sanitized errors;
- `mark(id, patch)` updates status/evidence/allowed_actions safely.

Use `atomicReadJson` and `atomicWriteJson`.

- [ ] **Step 4: Add package syntax entry**

Add to `package.json` check script:

```text
src/core/recovery/recovery-inbox.js
```

- [ ] **Step 5: Run tests to verify they pass**

Run:

```bash
node --test tests/unit/core/recovery/recovery-inbox.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json src/core/recovery/recovery-inbox.js tests/unit/core/recovery/recovery-inbox.test.js
git commit -m "feat(v2): add recovery inbox state"
```

---

## Task 5: Paused-turn sidecar persistence and store helpers

**Files:**
- Create: `src/core/recovery/paused-turn-persistence.js`
- Modify: `src/core/approval/paused-turn-store.js`
- Test: `tests/unit/core/recovery/paused-turn-persistence.test.js`
- Test: `tests/unit/core/approval/paused-turn-store.test.js`
- Modify: `package.json`

- [ ] **Step 1: Write failing sidecar persistence tests**

Create `tests/unit/core/recovery/paused-turn-persistence.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPausedTurnPersistence } from "../../../../src/core/recovery/paused-turn-persistence.js";

test("paused turn sidecar saves scans loads and deletes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-paused-sidecar-"));
  const store = createPausedTurnPersistence({ root, projectId: "proj_1" });
  const record = {
    approval_id: "approval_1",
    turn_id: "turn_1",
    session_id: "sess_1",
    created_at: "2026-06-01T00:00:00.000Z",
    surface: "cli",
    permission_context: { schema_version: 1, autonomy: "supervised", project_id: "sess_1", project_root: root, trust_store_rules: [], project_rules: [], memory_root: null, verify_mode: "auto", test_argv: null },
    approval: { id: "approval_1", summary: "edit" },
    turn: { id: "turn_1", autonomy: "supervised" },
    resume_state: { pending_tool_call: { id: "call_1", name: "edit", params: {} } }
  };

  await store.save(record);
  assert.deepEqual((await store.scan()).map((item) => item.approval_id), ["approval_1"]);
  assert.equal((await store.load("approval_1")).permission_context.autonomy, "supervised");
  await store.delete("approval_1");
  assert.deepEqual(await store.scan(), []);
});

test("paused turn sidecar quarantines corrupt JSON", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-paused-corrupt-"));
  const store = createPausedTurnPersistence({ root, projectId: "proj_1" });
  await store.writeRawForTest("approval_bad", "{not json");

  const scanned = await store.scan();

  assert.equal(scanned[0].status, "corrupt");
  assert.equal(scanned[0].approval_id, "approval_bad");
});
```

- [ ] **Step 2: Add failing paused-turn-store helper test**

Append to `tests/unit/core/approval/paused-turn-store.test.js`:

```js
test("paused turn store can restore list and cancel durable records", () => {
  const store = createPausedTurnStore();
  store.restore({ approval_id: "approval_1", turn_id: "turn_1", approval: { id: "approval_1" }, turn: { id: "turn_1" }, resume_state: { pending_tool_call: { id: "call_1" } } });

  assert.deepEqual(store.list().map((item) => item.approval_id), ["approval_1"]);
  assert.equal(store.delete("approval_1"), true);
  assert.deepEqual(store.list(), []);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
node --test tests/unit/core/recovery/paused-turn-persistence.test.js tests/unit/core/approval/paused-turn-store.test.js
```

Expected: FAIL because the persistence module and helper methods do not exist.

- [ ] **Step 4: Implement `paused-turn-persistence.js`**

Create `src/core/recovery/paused-turn-persistence.js` with:

```js
export function createPausedTurnPersistence({ root, projectId })
```

Implement:

- base directory: `.deepseek-code/v2/sessions/<projectId>/paused/`;
- `save(record)` validates required fields and writes `<approvalId>.json` atomically;
- `load(approvalId)` reads and validates one record;
- `delete(approvalId)` removes the sidecar;
- `quarantine(approvalId, reason)` moves it to `paused/quarantine/<approvalId>.json` when possible;
- `scan()` returns valid records plus `{ status: "corrupt", approval_id, path, reason }` entries for corrupt files;
- `writeRawForTest(approvalId, raw)` writes invalid JSON for tests.

- [ ] **Step 5: Extend `paused-turn-store.js`**

Add methods to the returned store:

```js
list() {
  return [...records.values()].map((record) => ({ ...record }));
},
restore(record) {
  validateRecord(record);
  records.set(record.approval_id, normalizeRecord(record));
},
delete(approvalId) {
  return records.delete(approvalId);
}
```

Keep existing `save/get/take/deleteForTurn/clear/size` behavior unchanged.

- [ ] **Step 6: Add package syntax entry**

Add to `package.json` check script:

```text
src/core/recovery/paused-turn-persistence.js
```

- [ ] **Step 7: Run tests to verify they pass**

Run:

```bash
node --test tests/unit/core/recovery/paused-turn-persistence.test.js tests/unit/core/approval/paused-turn-store.test.js
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add package.json src/core/recovery/paused-turn-persistence.js src/core/approval/paused-turn-store.js tests/unit/core/recovery/paused-turn-persistence.test.js tests/unit/core/approval/paused-turn-store.test.js
git commit -m "feat(v2): persist paused approval records"
```

---

## Task 6: Preserve permission context and repair resume shape

**Files:**
- Modify: `src/core/runtime/agent-runtime.js`
- Modify: `src/core/execution/executor-loop.js`
- Modify: `src/core/verification/repair-loop.js`
- Test: `tests/unit/core/verification/repair-loop.test.js`
- Test: `tests/integration/v2-durable-paused-turn.test.js`

- [ ] **Step 1: Add failing repair context test**

Append to `tests/unit/core/verification/repair-loop.test.js`:

```js
test("repair approval pause includes initial_tool_results for durable resume", async () => {
  const loop = await runRepairLoop({
    turnId: "turn_1",
    userMessage: "fix file",
    classification: { task_type: "edit" },
    modelGateway: { invoke: async () => ({ content: "", tool_calls: [{ id: "call_1", name: "edit", arguments: { diff: "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new" } }] }) },
    toolSchemas: [],
    executeTool: async () => ({ status: "approval_required", content: [], metadata: { approval: { id: "approval_repair", summary: "edit" } } }),
    createPolicyContext: () => ({ autonomy: "supervised" }),
    verificationPolicy: { plan: () => ({ should_verify: false }) },
    initialVerification: { status: "failed" },
    initialToolResults: [{ call_id: "initial", status: "success" }],
    eventBus: null,
    maxRepairAttempts: 1,
    options: { autonomy: "supervised" },
    context: null
  });

  assert.equal(loop.status, "awaiting_approval");
  assert.deepEqual(loop.resume_state.repair_context.initial_tool_results, [{ call_id: "initial", status: "success" }]);
});
```

Adjust the fixture only if the existing `runRepairLoop` test helpers already provide a cleaner fake model/tool setup.

- [ ] **Step 2: Add failing durable permission context integration test**

Create `tests/integration/v2-durable-paused-turn.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createKernel } from "../../src/index.js";

const DIFF = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new";

test("paused sidecar stores original autonomy and project id for resume", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-durable-pause-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  const kernel = await createKernel(root, {
    sessionRoot: path.join(root, ".deepseek-code", "v2", "sessions"),
    sessionId: "sess_original",
    projectId: "proj_test",
    recovery: { enabled: true, surface: "cli" },
    modelGateway: {
      invoke: async () => ({ content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: DIFF, prompt: "update" } }] }),
      reply: async () => ({ content: "fast" })
    }
  });

  const paused = await kernel.agent.send("modify", { autonomy: "supervised" });
  const items = await kernel.recovery.list();

  assert.equal(paused.status, "awaiting_approval");
  assert.equal(items[0].type, "paused_turn");
  assert.equal(items[0].source_id, paused.approval.id);
  assert.equal(items[0].metadata.autonomy, "supervised");
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
node --test tests/unit/core/verification/repair-loop.test.js tests/integration/v2-durable-paused-turn.test.js
```

Expected: FAIL because repair context lacks `initial_tool_results` and kernel recovery integration is missing.

- [ ] **Step 4: Fix repair context shape**

In `src/core/verification/repair-loop.js`, when returning `awaiting_approval`, add:

```js
initial_tool_results: initialToolResults || [],
```

to `resume_state.repair_context`.

- [ ] **Step 5: Preserve permission metadata in runtime resume state**

In `src/core/runtime/agent-runtime.js`, when creating a turn in `send()`, compute a serializable `permission_context`:

```js
const permissionContext = {
  schema_version: 1,
  autonomy: options.autonomy || turn.autonomy,
  project_id: options.projectId || sessionId,
  project_root: options.projectRoot || null,
  trust_store_rules: options.trustStore?.rules || [],
  project_rules: options.projectRules || [],
  memory_root: options.memoryRoot || null,
  verify_mode: options.verifyMode || verifyMode,
  test_argv: options.testArgv || testArgv
};
```

Thread it into every `resume_state` created by executor-loop or repair-loop by passing it in `options.permission_context` and copying it when paused. On resume, create policy contexts from `record.permission_context || record.resume_state.permission_context || record.resume_state.options` and keep verifier phase override to `auto`.

- [ ] **Step 6: Add runtime list/cancel paused methods**

In `src/core/runtime/agent-runtime.js`, return methods:

```js
listPaused() {
  return pausedTurnStore.list();
},
cancelPaused(approvalId, reason = "cancelled") {
  const record = pausedTurnStore.get(approvalId);
  if (!record) return null;
  pausedTurnStore.delete(approvalId);
  publish(eventBus, "turn:cancelled", { approval_id: approvalId, turn_id: record.turn_id, original_session_id: record.turn?.session_id || sessionId, reason });
  return record;
},
restorePaused(record) {
  pausedTurnStore.restore(record);
}
```

Expose them later through `createKernel` in Task 11.

- [ ] **Step 7: Run tests to verify repair context passes**

Run:

```bash
node --test tests/unit/core/verification/repair-loop.test.js
```

Expected: PASS.

- [ ] **Step 8: Leave durable integration failure for Task 11**

Run:

```bash
node --test tests/integration/v2-durable-paused-turn.test.js
```

Expected: still FAIL until recovery service and kernel wiring are implemented. Keep this test as the integration target for Tasks 10-11.

- [ ] **Step 9: Commit**

```bash
git add src/core/runtime/agent-runtime.js src/core/execution/executor-loop.js src/core/verification/repair-loop.js tests/unit/core/verification/repair-loop.test.js tests/integration/v2-durable-paused-turn.test.js
git commit -m "feat(v2): preserve paused turn policy context"
```

---

## Task 7: Transaction journal with byte snapshots and recovered artifacts

**Files:**
- Create: `src/core/recovery/transaction-journal.js`
- Create: `src/core/recovery/recovery-errors.js`
- Test: `tests/unit/core/recovery/transaction-journal.test.js`
- Modify: `package.json`

- [ ] **Step 1: Write failing transaction journal tests**

Create `tests/unit/core/recovery/transaction-journal.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTransactionJournal } from "../../../../src/core/recovery/transaction-journal.js";

test("transaction journal captures binary preimage before mutation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-journal-binary-"));
  await writeFile(path.join(root, "a.bin"), Buffer.from([0, 255, 10]));
  const journal = createTransactionJournal({ root, projectId: "proj_1" });

  const tx = await journal.open({ kind: "edit", tx_id: "tx_1", session_id: "sess_1", turn_id: "turn_1", owner_epoch: 1, paths: ["a.bin"] });

  assert.equal(tx.state, "open");
  assert.equal(tx.paths[0].pre_hash.startsWith("sha256:"), true);
  assert.deepEqual(await readFile(path.join(root, ".deepseek-code", "v2", "journal", "tx_1", tx.paths[0].blob)), Buffer.from([0, 255, 10]));
});

test("transaction journal abort restores modified and created files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-journal-abort-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  const journal = createTransactionJournal({ root, projectId: "proj_1" });
  await journal.open({ kind: "edit", tx_id: "tx_2", session_id: "sess_1", turn_id: "turn_1", owner_epoch: 1, paths: ["a.txt", "new.txt"] });
  await writeFile(path.join(root, "a.txt"), "new\n");
  await writeFile(path.join(root, "new.txt"), "created\n");

  const result = await journal.abort("tx_2");

  assert.equal(result.status, "rolled_back");
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "old\n");
  await assert.rejects(() => readFile(path.join(root, "new.txt"), "utf8"), /ENOENT/);
});

test("transaction journal blocks symlink escape", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-journal-symlink-"));
  const outside = await mkdtemp(path.join(tmpdir(), "dsc-journal-outside-"));
  await symlink(outside, path.join(root, "escape"), "dir").catch(() => null);
  const journal = createTransactionJournal({ root, projectId: "proj_1" });

  await assert.rejects(
    () => journal.open({ kind: "edit", tx_id: "tx_3", session_id: "sess_1", turn_id: "turn_1", owner_epoch: 1, paths: ["escape/file.txt"] }),
    /path escapes workspace|symlink/
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test tests/unit/core/recovery/transaction-journal.test.js
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement `recovery-errors.js`**

Create `src/core/recovery/recovery-errors.js`:

```js
export function recoveryError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = sanitizeDetails(details);
  return error;
}

export function sanitizeDetails(details = {}) {
  const safe = {};
  for (const [key, value] of Object.entries(details || {})) {
    if (key.toLowerCase().includes("content") || key.toLowerCase().includes("resume")) continue;
    safe[key] = value;
  }
  return safe;
}
```

- [ ] **Step 4: Implement `transaction-journal.js`**

Create `src/core/recovery/transaction-journal.js` with:

```js
export function createTransactionJournal({ root, projectId, faults = createRecoveryFaults() })
```

Implement methods:

- `open({ kind, tx_id, session_id, turn_id, owner_epoch, paths, rewind_branch_state = null, target = {} })`;
- `commit(txId, final_state = {})`;
- `abort(txId)`;
- `scan()`;
- `preserveCurrent(txId, entry, reason)`;
- `readManifest(txId)`.

Implement exact semantics:

1. Journal root is `.deepseek-code/v2/journal/<txId>/`.
2. `open()` canonicalizes paths, rejects absolute/traversal/symlink escape/duplicate Windows-lowercase path keys, captures preimages, writes blobs, writes `manifest.json`, then returns the manifest.
3. Missing paths are stored as `kind: "missing"` with no blob.
4. Regular files use `Buffer` bytes and `sha256:` hashes.
5. Directories are recorded as `kind: "directory"`; abort only removes empty directories created by the transaction.
6. Symlinks record `symlink_target`; if symlink recreation fails, abort blocks with `RECOVERY_BLOCKED`.
7. `commit()` atomically updates `state: "committed"` and `commit_id`.
8. `abort()` sets `state: "aborting"`, restores every preimage, preserves unknown current state under `.deepseek-code/v2/recovered/<txId>/`, deletes the journal only after successful rollback, and returns `{ status: "rolled_back", tx_id, preserved_count }`.
9. Corrupt/missing manifests or missing blobs throw `RECOVERY_BLOCKED`.

- [ ] **Step 5: Add package syntax entries**

Add to `package.json` check script:

```text
src/core/recovery/recovery-errors.js src/core/recovery/transaction-journal.js
```

- [ ] **Step 6: Run tests to verify they pass**

Run:

```bash
node --test tests/unit/core/recovery/transaction-journal.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add package.json src/core/recovery/recovery-errors.js src/core/recovery/transaction-journal.js tests/unit/core/recovery/transaction-journal.test.js
git commit -m "feat(v2): add transaction recovery journal"
```

---

## Task 8: Journal managed edit transactions

**Files:**
- Modify: `src/edits/edit-transaction.js`
- Modify: `src/edits/edit-service.js`
- Test: `tests/unit/edits/edit-transaction.test.js`
- Test: `tests/unit/edits/edit-service.test.js`
- Test: `tests/integration/v2-recovery-edit-journal.test.js`

- [ ] **Step 1: Add failing edit-service journal test**

Append to `tests/unit/edits/edit-service.test.js`:

```js
test("edit service opens and commits recovery journal around apply", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-edit-journal-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  const calls = [];
  const recoveryJournal = {
    open: async (input) => { calls.push(["open", input.kind, input.paths]); return { tx_id: input.tx_id, state: "open" }; },
    commit: async (txId, finalState) => { calls.push(["commit", txId, finalState.files?.length || 0]); },
    abort: async (txId) => { calls.push(["abort", txId]); }
  };
  const service = createEditService({ projectRoot: root, recoveryJournal });

  await service.apply({ diff: "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new", prompt: "update" });

  assert.equal(calls[0][0], "open");
  assert.equal(calls.at(-1)[0], "commit");
});
```

- [ ] **Step 2: Add failing fault integration test**

Create `tests/integration/v2-recovery-edit-journal.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEditService } from "../../src/edits/edit-service.js";
import { createTransactionJournal } from "../../src/core/recovery/transaction-journal.js";
import { createRecoveryFaults } from "../../src/core/recovery/recovery-faults.js";

const DIFF = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new";

test("interrupted edit journal rolls back only the open transaction", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-edit-recovery-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  const journal = createTransactionJournal({ root, projectId: "proj_1", faults: createRecoveryFaults({ labels: ["after-first-file-write"] }) });
  const service = createEditService({ projectRoot: root, recoveryJournal: journal });

  await assert.rejects(() => service.apply({ diff: DIFF, prompt: "update" }), /recovery fault: after-first-file-write/);
  await journal.abort((await journal.scan())[0].tx_id);

  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "old\n");
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
node --test tests/unit/edits/edit-service.test.js tests/integration/v2-recovery-edit-journal.test.js
```

Expected: FAIL because edit service does not accept/use `recoveryJournal`.

- [ ] **Step 4: Add byte snapshot helper exports**

In `src/edits/edit-transaction.js`, add byte-safe helpers or wrap the new journal helpers so edit-service can pass parsed patch paths to the journal. Keep existing UTF-8 snapshot tests passing.

Required export shape:

```js
export function pathsFromParsedDiff(parsed) {
  return parsed.files;
}
```

If `parsed.files` already contains exact workspace-relative paths, return it. If not, derive from `parsed.patches` using each patch `newPath || oldPath` and normalize away `a/`/`b/` prefixes consistently with `diff-parser.js`.

- [ ] **Step 5: Wire `recoveryJournal` into edit service**

In `src/edits/edit-service.js`:

1. Extend factory signature:

```js
export function createEditService({ projectRoot, eventBus = null, changeStore = null, rollbackService = null, recoveryJournal = null, assertOwner = async () => {}, faults = null } = {})
```

2. Before `publish("file:transaction_started")`, create `transaction_id` and open the journal when provided:

```js
const journalEntry = recoveryJournal ? await recoveryJournal.open({
  kind: "edit",
  tx_id: transaction_id,
  session_id: approval_id || "edit",
  turn_id: approval_id || "edit",
  owner_epoch: 0,
  paths: pathsFromParsedDiff(parsed),
  target: { type: "edit", description: "apply diff" }
}) : null;
```

3. Before each managed write or immediately before `applyDiffTransaction`, call `await assertOwner()`.
4. After successful `store.finalize()`, call:

```js
await recoveryJournal?.commit(transaction_id, { files: record.summary });
```

5. On any failure after journal open, call `await recoveryJournal.abort(transaction_id)` before publishing sanitized failure events.
6. After `commit()`, publish existing `file:transaction_committed` and `file:diff_applied` as before.

- [ ] **Step 6: Run tests to verify they pass**

Run:

```bash
node --test tests/unit/edits/edit-transaction.test.js tests/unit/edits/edit-service.test.js tests/integration/v2-recovery-edit-journal.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/edits/edit-transaction.js src/edits/edit-service.js tests/unit/edits/edit-transaction.test.js tests/unit/edits/edit-service.test.js tests/integration/v2-recovery-edit-journal.test.js
git commit -m "feat(v2): journal managed edit transactions"
```

---

## Task 9: Journal rewind transactions and restore branch state

**Files:**
- Modify: `src/sessions/branch-store.js`
- Modify: `src/sessions/rewind-transaction.js`
- Modify: `src/sessions/rewind-service.js`
- Test: `tests/unit/sessions/branch-store.test.js`
- Test: `tests/unit/sessions/rewind-transaction.test.js`
- Test: `tests/unit/sessions/rewind-service.test.js`
- Test: `tests/integration/v2-recovery-rewind-journal.test.js`

- [ ] **Step 1: Add failing branch-store snapshot test**

Append to `tests/unit/sessions/branch-store.test.js`:

```js
test("branch store snapshots and restores full branch state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-branch-snapshot-"));
  const store = await createBranchStore({ sessionRoot: root, projectId: "proj_1", sessionId: "sess_1" });
  const child = await store.createBranch({ parent_branch_id: "br_main", forked_from_seq: 1, label: "child" });
  await store.activateBranch(child.branch_id);
  const before = await store.snapshotState();
  await store.activateBranch("br_main");

  await store.restoreState(before);

  assert.equal(await store.getActiveBranchId(), child.branch_id);
});
```

- [ ] **Step 2: Add failing rewind journal test**

Create `tests/integration/v2-recovery-rewind-journal.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBranchStore } from "../../src/sessions/branch-store.js";
import { createRewindService } from "../../src/sessions/rewind-service.js";
import { createTransactionJournal } from "../../src/core/recovery/transaction-journal.js";

test("rewind journal captures branch state before apply", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-rewind-journal-"));
  const sessionRoot = path.join(root, ".deepseek-code", "v2", "sessions");
  const branchStore = await createBranchStore({ sessionRoot, projectId: "proj_1", sessionId: "sess_original" });
  const journal = createTransactionJournal({ root, projectId: "proj_1" });
  const service = createRewindService({
    projectRoot: root,
    recoveryJournal: journal,
    getBranchState: () => branchStore.snapshotState(),
    restoreBranchState: (state) => branchStore.restoreState(state),
    branchStorePath: branchStore.filePath,
    getTimeline: async () => [
      { seq: 1, event_id: "evt_user", type: "user:message", turn_id: "turn_1", branch_id: "br_main" },
      { seq: 2, event_id: "evt_change", type: "file:diff_applied", change_id: "change_1", files: ["a.txt"], branch_id: "br_main" }
    ],
    getActiveBranchId: () => branchStore.getActiveBranchId(),
    createBranch: (input) => branchStore.createBranch(input),
    activateBranch: (id) => branchStore.activateBranch(id),
    rollback: async () => ({ status: "success", metadata: { change_id: "change_1" } }),
    captureSnapshots: async () => [],
    restoreSnapshots: async () => []
  });

  const result = await service.apply({ target: { turn_id: "turn_1" } });

  assert.equal(result.status, "success");
  assert.deepEqual(await journal.scan(), []);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
node --test tests/unit/sessions/branch-store.test.js tests/integration/v2-recovery-rewind-journal.test.js
```

Expected: FAIL because branch-store snapshot/restore and rewind journal hooks are missing.

- [ ] **Step 4: Add branch-store state snapshot/restore**

In `src/sessions/branch-store.js`, expose:

```js
snapshotState() {
  return snapshot(state);
},
async restoreState(nextState) {
  state = normalizeState(nextState, sessionId);
  await saveState(filePath, state);
  return snapshot(state);
}
```

Ensure `filePath` is already returned; if not, continue returning it as currently done.

- [ ] **Step 5: Add rewind byte snapshot wrapper**

In `src/sessions/rewind-transaction.js`, keep current functions and add byte-safe exports that call transaction-journal capture when a journal is provided. Existing tests must keep passing.

- [ ] **Step 6: Wire journal into rewind service**

In `src/sessions/rewind-service.js`, extend factory signature:

```js
recoveryJournal = null,
getBranchState = null,
restoreBranchState = null,
branchStorePath = null,
assertOwner = async () => {}
```

At the start of `apply()` after `previewResult` and before `session:rewind_started`:

1. capture branch state via `await getBranchState()`;
2. open a `kind: "rewind"` journal with `paths: previewResult.files`, `rewind_branch_state` containing `branchStorePath`, original session id, and state before;
3. call `assertOwner()` before rollback loop, branch creation, branch activation, and journal commit;
4. on successful rewind, call `recoveryJournal.commit(txId, { files: previewResult.files, branch_id: branch.branch_id })`;
5. on failure, call existing in-process restore path and leave journal abort to recovery service only if the process dies; for normal in-process failure, call `recoveryJournal.abort(txId)` after existing restore succeeds.

- [ ] **Step 7: Run tests to verify they pass**

Run:

```bash
node --test tests/unit/sessions/branch-store.test.js tests/unit/sessions/rewind-transaction.test.js tests/unit/sessions/rewind-service.test.js tests/integration/v2-recovery-rewind-journal.test.js
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/sessions/branch-store.js src/sessions/rewind-transaction.js src/sessions/rewind-service.js tests/unit/sessions/branch-store.test.js tests/unit/sessions/rewind-transaction.test.js tests/unit/sessions/rewind-service.test.js tests/integration/v2-recovery-rewind-journal.test.js
git commit -m "feat(v2): journal rewind recovery state"
```

---

## Task 10: Recovery service boot reconciliation

**Files:**
- Create: `src/core/recovery/recovery-service.js`
- Test: `tests/unit/core/recovery/recovery-service.test.js`
- Modify: `package.json`

- [ ] **Step 1: Write failing recovery-service tests**

Create `tests/unit/core/recovery/recovery-service.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createRecoveryService } from "../../../../src/core/recovery/recovery-service.js";

test("recovery service rolls back open journals and reports found done next", async () => {
  const calls = [];
  const service = createRecoveryService({
    projectId: "proj_1",
    lock: { assertOwner: async () => {}, epoch: 1 },
    journal: {
      scan: async () => [{ tx_id: "tx_1", state: "open", kind: "edit", paths: [{ path: "a.txt" }] }],
      abort: async (txId) => { calls.push(["abort", txId]); return { status: "rolled_back", tx_id: txId, preserved_count: 0 }; }
    },
    paused: { scan: async () => [] },
    inbox: { upsert: async (item) => calls.push(["inbox", item.type, item.status]), list: async () => [] },
    appendMarker: async (type, data) => calls.push(["event", type, data.tx_id || data.recovery_id])
  });

  const report = await service.recoverOnStartup();

  assert.deepEqual(calls.map((call) => call[0]), ["event", "abort", "inbox", "event", "event"]);
  assert.equal(report.found.length, 1);
  assert.equal(report.done.length, 1);
});

test("recovery service rehydrates valid paused records", async () => {
  const restored = [];
  const service = createRecoveryService({
    projectId: "proj_1",
    lock: { assertOwner: async () => {}, epoch: 1 },
    journal: { scan: async () => [] },
    paused: { scan: async () => [{ approval_id: "approval_1", turn_id: "turn_1", session_id: "sess_1", permission_context: { autonomy: "supervised" }, resume_state: {} }] },
    pausedTurnStore: { restore: (record) => restored.push(record) },
    inbox: { upsert: async () => {}, list: async () => [] },
    appendMarker: async () => {}
  });

  await service.recoverOnStartup();

  assert.equal(restored[0].approval_id, "approval_1");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test tests/unit/core/recovery/recovery-service.test.js
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement `recovery-service.js`**

Create `src/core/recovery/recovery-service.js` with:

```js
export function createRecoveryService({ projectId, lock, journal, paused, pausedTurnStore, inbox, appendMarker })
```

Implement methods:

- `recoverOnStartup()`;
- `list({ includeCleared = false } = {})`;
- `resume(id, { decision } = {})` placeholder delegate to injected runtime in Task 11;
- `cancel(id)` placeholder delegate to injected runtime in Task 11;
- `clear(id)` delegates to inbox;
- `report()` returns the latest structured report.

Startup algorithm:

1. `lock.assertOwner()`;
2. append/flush `recovery:started`;
3. `journal.scan()`;
4. for each `state: open` or `state: aborting`, call `journal.abort(txId)`, write inbox `recovered_tx/done`, append `tx:recovered`;
5. for each `state: committed` with missing marker, append `tx:committed`, then let journal cleanup run;
6. for corrupt/blocked journals, write `blocked_recovery/blocked`, append `recovery:blocked`, and mark report blocked;
7. scan paused sidecars, restore valid records, write `paused_turn/pending`, append `turn:rehydrated`;
8. write a `recovery:report` marker and return `{ found, done, blocked, next }`.

- [ ] **Step 4: Add package syntax entry**

Add to `package.json` check script:

```text
src/core/recovery/recovery-service.js
```

- [ ] **Step 5: Run tests to verify they pass**

Run:

```bash
node --test tests/unit/core/recovery/recovery-service.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json src/core/recovery/recovery-service.js tests/unit/core/recovery/recovery-service.test.js
git commit -m "feat(v2): add startup recovery service"
```

---

## Task 11: Kernel recovery wiring and durable paused resume

**Files:**
- Modify: `src/index.js`
- Modify: `src/core/runtime/agent-runtime.js`
- Test: `tests/integration/v2-durable-paused-turn.test.js`
- Test: `tests/integration/v2-recovery-center-kernel.test.js`
- Test: `tests/integration/v2-kernel-facade.test.js`

- [ ] **Step 1: Add failing recovery facade tests**

Create `tests/integration/v2-recovery-center-kernel.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createKernel } from "../../src/index.js";

test("kernel exposes recovery list clear and report", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-recovery-kernel-"));
  const kernel = await createKernel(root, {
    sessionRoot: path.join(root, ".deepseek-code", "v2", "sessions"),
    recovery: { enabled: true, surface: "cli" },
    modelGateway: { invoke: async () => ({ content: "done", tool_calls: [] }), reply: async () => ({ content: "reply" }) }
  });

  assert.equal(Array.isArray(await kernel.recovery.list()), true);
  assert.equal(typeof kernel.recovery.report, "function");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test tests/integration/v2-durable-paused-turn.test.js tests/integration/v2-recovery-center-kernel.test.js
```

Expected: FAIL because `kernel.recovery` is missing and durable paused sidecars are not wired.

- [ ] **Step 3: Wire recovery dependencies in `createKernel()`**

In `src/index.js`:

1. Import recovery modules.
2. Build `recoveryRoot = path.join(root, ".deepseek-code", "v2")`.
3. If `options.recovery?.enabled !== false`, acquire project lock unless `options.recovery?.lock === false` for unit tests.
4. Build `pausedPersistence`, `transactionJournal`, `recoveryInbox`, and `recoveryService`.
5. Pass `recoveryJournal`, `assertOwner`, and `faults` into edit and rewind services.
6. Pass paused persistence callbacks and permission metadata defaults into runtime.
7. Run `await recoveryService.recoverOnStartup()` before returning the kernel, unless `options.recovery?.skipStartupRecovery === true` for focused unit tests.

Keep tests isolated by honoring `options.sessionRoot`, `options.projectId`, and temp `root`.

- [ ] **Step 4: Expose recovery and paused agent facade**

In `src/index.js`, extend return object:

```js
agent: {
  send: runtime.send,
  approve: runtime.approve,
  interrupt: runtime.interrupt,
  listPaused: runtime.listPaused,
  cancelPaused: runtime.cancelPaused
},
recovery: recoveryService ? {
  list: recoveryService.list,
  resume: recoveryService.resume,
  cancel: recoveryService.cancel,
  clear: recoveryService.clear,
  report: recoveryService.report
} : disabledRecoveryFacade()
```

`disabledRecoveryFacade()` returns empty list/report and throws `RECOVERY_DISABLED` for mutating actions.

- [ ] **Step 5: Implement recovery resume/cancel delegates**

In `recovery-service.js`, accept injected `runtime` or callbacks:

```js
resumePaused: async (approvalId, decision) => runtime.approve(approvalId, decision),
cancelPaused: async (approvalId) => runtime.cancelPaused(approvalId)
```

`resume(id, { decision } = {})` maps `rec_pause_<approvalId>` to the approval id, calls resume, updates inbox, and returns `{ status: "resumed", item, result }`.

`cancel(id)` maps paused items to `runtime.cancelPaused`, updates inbox, deletes/quarantines sidecar through paused persistence, appends `turn:cancelled`, and returns `{ status: "cancelled", item }`.

- [ ] **Step 6: Run tests to verify they pass**

Run:

```bash
node --test tests/integration/v2-durable-paused-turn.test.js tests/integration/v2-recovery-center-kernel.test.js tests/integration/v2-kernel-facade.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/index.js src/core/runtime/agent-runtime.js src/core/recovery/recovery-service.js tests/integration/v2-durable-paused-turn.test.js tests/integration/v2-recovery-center-kernel.test.js tests/integration/v2-kernel-facade.test.js
git commit -m "feat(v2): wire durable recovery into kernel"
```

---

## Task 12: CLI Recovery Center commands and takeover prompt

**Files:**
- Modify: `src/apps/cli/kernel-runner.js`
- Test: `tests/unit/apps/cli/kernel-runner.test.js`

- [ ] **Step 1: Add failing `/recovery` command tests**

Append to `tests/unit/apps/cli/kernel-runner.test.js`:

```js
test("chat repl renders recovery inbox", async () => {
  const questions = ["/recovery", "/exit"];
  const writes = [];
  await runKernelChatCommand({
    root: "/repo",
    write: (line) => writes.push(line),
    question: async () => questions.shift(),
    createKernelImpl: async () => ({
      session: { subscribe: () => ({ unsubscribe() {} }), getTimeline: async () => [] },
      agent: { send: async () => ({ status: "complete", content: "unused" }) },
      recovery: {
        list: async () => [{ id: "rec_pause_approval_1", type: "paused_turn", status: "pending", summary: "Approval required", allowed_actions: ["resume", "cancel"] }],
        report: async () => ({ found: [{ summary: "Approval required" }], done: [], blocked: [], next: ["/recovery resume rec_pause_approval_1"] })
      }
    })
  });

  assert.ok(writes.some((line) => line.includes("Recovery")));
  assert.ok(writes.some((line) => line.includes("rec_pause_approval_1")));
});

test("chat repl recovery cancel delegates to kernel", async () => {
  const questions = ["/recovery cancel rec_pause_approval_1", "/exit"];
  const calls = [];
  await runKernelChatCommand({
    root: "/repo",
    write: () => {},
    question: async () => questions.shift(),
    createKernelImpl: async () => ({
      session: { subscribe: () => ({ unsubscribe() {} }), getTimeline: async () => [] },
      agent: { send: async () => ({ status: "complete", content: "unused" }) },
      recovery: {
        cancel: async (id) => { calls.push(id); return { status: "cancelled" }; },
        list: async () => [],
        report: async () => ({ found: [], done: [], blocked: [], next: [] })
      }
    })
  });

  assert.deepEqual(calls, ["rec_pause_approval_1"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test tests/unit/apps/cli/kernel-runner.test.js
```

Expected: FAIL because `/recovery` is unknown.

- [ ] **Step 3: Implement recovery command handling**

In `src/apps/cli/kernel-runner.js`, add to `handleChatCommand()`:

```js
if (command === "recovery") {
  return handleRecoveryCommand({ rawArg, kernel, write, mode, history });
}
```

Implement `handleRecoveryCommand()` in the same file:

- no arg: call `kernel.recovery.report()` and `kernel.recovery.list()`, render Found/Done/Blocked/Next and item id/type/status/actions;
- `resume <id>`: call `kernel.recovery.resume(id, {})`, render status/result;
- `cancel <id>`: call `kernel.recovery.cancel(id)`, render status;
- `clear <id>`: call `kernel.recovery.clear(id)`, render status;
- invalid command: print `usage: /recovery [resume|cancel|clear] <id>`.

Keep return shape `{ mode, history, exit: false }`.

- [ ] **Step 4: Add takeover prompt wiring for CLI runners**

Extend `runKernelAgentCommand` and `runKernelChatCommand` options with:

```js
promptTakeover = defaultPromptTakeover
```

Pass it to `createKernelOptions.recovery` when building kernel options:

```js
recovery: { ...(createKernelOptions.recovery || {}), surface: "cli", interactive: true, promptTakeover }
```

Implement `defaultPromptTakeover(owner)` using readline and return `"takeover"` only for yes/takeover responses. Noninteractive test paths can pass `recovery: { interactive: false }`.

- [ ] **Step 5: Run tests to verify they pass**

Run:

```bash
node --test tests/unit/apps/cli/kernel-runner.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/apps/cli/kernel-runner.js tests/unit/apps/cli/kernel-runner.test.js
git commit -m "feat(v2): add CLI recovery commands"
```

---

## Task 13: GUI Recovery Center exposure

**Files:**
- Modify: `gui/kernel-host.js`
- Modify: `gui/renderer/event-adapter.js`
- Test: `tests/unit/gui/kernel-host.test.js`
- Test: `tests/unit/gui/renderer-event-adapter.test.js`

- [ ] **Step 1: Add failing GUI host tests**

Append to `tests/unit/gui/kernel-host.test.js`:

```js
test("kernel host exposes recovery delegates", async () => {
  const calls = [];
  const host = createKernelHost({
    projectRoot: "/repo",
    kernelFactory: async () => ({
      session: { subscribe: () => ({ unsubscribe() {} }), getTimeline: async () => [] },
      agent: { send: async () => ({ status: "complete" }), approve: () => {}, interrupt: () => {} },
      recovery: {
        list: async () => [{ id: "rec_tx_tx_1" }],
        report: async () => ({ found: [], done: [], blocked: [], next: [] }),
        resume: async (id) => { calls.push(["resume", id]); return { status: "resumed" }; },
        cancel: async (id) => { calls.push(["cancel", id]); return { status: "cancelled" }; },
        clear: async (id) => { calls.push(["clear", id]); return { status: "cleared" }; }
      },
      context: { snapshot: async () => ({ units: [] }) },
      config: { getPublicConfig: () => ({ runtime: "v2" }) },
      runtime: { getState: () => ({ current: "idle" }) }
    })
  });

  await host.init();
  assert.deepEqual(await host.getRecoveryItems(), [{ id: "rec_tx_tx_1" }]);
  assert.deepEqual(await host.recoveryResume("rec_pause_1"), { status: "resumed" });
  assert.deepEqual(await host.recoveryCancel("rec_pause_1"), { status: "cancelled" });
  assert.deepEqual(await host.recoveryClear("rec_tx_1"), { status: "cleared" });
  assert.deepEqual(calls, [["resume", "rec_pause_1"], ["cancel", "rec_pause_1"], ["clear", "rec_tx_1"]]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test tests/unit/gui/kernel-host.test.js tests/unit/gui/renderer-event-adapter.test.js
```

Expected: FAIL because kernel-host lacks recovery methods.

- [ ] **Step 3: Add GUI host recovery methods**

In `gui/kernel-host.js`, add:

```js
async function getRecoveryItems(options = {}) {
  return ready() ? requireKernel().recovery?.list?.(options) || [] : [];
}

async function getRecoveryReport() {
  return ready() ? requireKernel().recovery?.report?.() || { found: [], done: [], blocked: [], next: [] } : { found: [], done: [], blocked: [], next: [] };
}

async function recoveryResume(id, options = {}) {
  return requireKernel().recovery.resume(id, options);
}

async function recoveryCancel(id) {
  return requireKernel().recovery.cancel(id);
}

async function recoveryClear(id) {
  return requireKernel().recovery.clear(id);
}
```

Return these methods from `createKernelHost()`.

- [ ] **Step 4: Keep renderer adapter recovery summaries passing**

Run the GUI adapter tests from Task 2. If the event adapter already passes, no change is needed. If it fails, add the recovery event icon/summary/status code from Task 2.

- [ ] **Step 5: Run tests to verify they pass**

Run:

```bash
node --test tests/unit/gui/kernel-host.test.js tests/unit/gui/renderer-event-adapter.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add gui/kernel-host.js gui/renderer/event-adapter.js tests/unit/gui/kernel-host.test.js tests/unit/gui/renderer-event-adapter.test.js
git commit -m "feat(gui): expose V2 recovery center"
```

---

## Task 14: Recovery end-to-end fault injection coverage

**Files:**
- Modify: `tests/integration/v2-recovery-edit-journal.test.js`
- Modify: `tests/integration/v2-recovery-rewind-journal.test.js`
- Modify: `tests/integration/v2-durable-paused-turn.test.js`
- Modify: `tests/integration/v2-recovery-center-kernel.test.js`

- [ ] **Step 1: Add edit crash matrix tests**

Append to `tests/integration/v2-recovery-edit-journal.test.js`:

```js
for (const label of ["after-journal-write", "after-tx-opened-marker", "after-first-file-write", "after-manifest-committed", "after-tx-committed-marker", "before-journal-delete"]) {
  test(`edit recovery handles fault ${label}`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), `dsc-edit-fault-${label.replaceAll(":", "-")}-`));
    await writeFile(path.join(root, "a.txt"), "old\n");
    const kernel = await createKernel(root, {
      sessionRoot: path.join(root, ".deepseek-code", "v2", "sessions"),
      recovery: { enabled: true, surface: "cli" },
      recoveryFaults: { labels: [label] },
      modelGateway: {
        invoke: async () => ({ content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: DIFF, prompt: "update" } }] }),
        reply: async () => ({ content: "reply" })
      }
    });

    const result = await kernel.agent.send("edit", { autonomy: "auto" }).catch((error) => ({ error }));
    const restarted = await createKernel(root, {
      sessionRoot: path.join(root, ".deepseek-code", "v2", "sessions"),
      recovery: { enabled: true, surface: "cli" },
      modelGateway: { invoke: async () => ({ content: "done", tool_calls: [] }), reply: async () => ({ content: "reply" }) }
    });

    assert.ok(result.error || result.status === "complete");
    assert.ok(Array.isArray(await restarted.recovery.list()));
  });
}
```

- [ ] **Step 2: Add paused sidecar crash tests**

Append to `tests/integration/v2-durable-paused-turn.test.js`:

```js
test("valid paused sidecar with missing marker is rehydrated on restart", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-pause-missing-marker-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  const kernel = await createKernel(root, {
    sessionRoot: path.join(root, ".deepseek-code", "v2", "sessions"),
    projectId: "proj_test",
    recovery: { enabled: true, surface: "cli" },
    recoveryFaults: { labels: ["after-paused-sidecar-write"] },
    modelGateway: { invoke: async () => ({ content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: DIFF, prompt: "update" } }] }), reply: async () => ({ content: "reply" }) }
  });

  await assert.rejects(() => kernel.agent.send("modify", { autonomy: "supervised" }), /recovery fault: after-paused-sidecar-write/);

  const restarted = await createKernel(root, {
    sessionRoot: path.join(root, ".deepseek-code", "v2", "sessions"),
    projectId: "proj_test",
    recovery: { enabled: true, surface: "cli" },
    modelGateway: { invoke: async () => ({ content: "done", tool_calls: [] }), reply: async () => ({ content: "reply" }) }
  });
  const items = await restarted.recovery.list();

  assert.equal(items.some((item) => item.type === "paused_turn" && item.status === "pending"), true);
});
```

- [ ] **Step 3: Add takeover fault test**

Append to `tests/integration/v2-recovery-center-kernel.test.js`:

```js
test("noninteractive second kernel fails closed when lock is live", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-lock-kernel-"));
  const first = await createKernel(root, { recovery: { enabled: true, surface: "cli" }, modelGateway: { invoke: async () => ({ content: "done", tool_calls: [] }), reply: async () => ({ content: "reply" }) } });

  await assert.rejects(
    () => createKernel(root, { recovery: { enabled: true, surface: "cli", interactive: false }, modelGateway: { invoke: async () => ({ content: "done", tool_calls: [] }), reply: async () => ({ content: "reply" }) } }),
    /project is already locked/
  );

  await first.recovery?.shutdown?.();
});
```

If the implemented shutdown method is on `kernel.session.dispose()` plus lock release, assert and call that exact method instead.

- [ ] **Step 4: Run fault-injection tests**

Run:

```bash
node --test tests/integration/v2-recovery-edit-journal.test.js tests/integration/v2-durable-paused-turn.test.js tests/integration/v2-recovery-center-kernel.test.js
```

Expected: PASS after filling the recovery fault labels into implementation code.

- [ ] **Step 5: Add rewind branch restore fault test**

Append to `tests/integration/v2-recovery-rewind-journal.test.js`:

```js
test("recovery restores original branch store for interrupted rewind", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-rewind-restore-"));
  const sessionRoot = path.join(root, ".deepseek-code", "v2", "sessions");
  const branchStore = await createBranchStore({ sessionRoot, projectId: "proj_1", sessionId: "sess_original" });
  const before = await branchStore.snapshotState();
  const journal = createTransactionJournal({ root, projectId: "proj_1" });
  await journal.open({ kind: "rewind", tx_id: "tx_rewind", session_id: "sess_original", turn_id: "turn_1", owner_epoch: 1, paths: [], rewind_branch_state: { branch_store_path: branchStore.filePath, original_session_id: "sess_original", state_before: before, created_branch_id: null, activated_branch_id: null } });

  await journal.abort("tx_rewind");

  assert.deepEqual(await branchStore.snapshotState(), before);
});
```

- [ ] **Step 6: Run rewind fault test**

Run:

```bash
node --test tests/integration/v2-recovery-rewind-journal.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add tests/integration/v2-recovery-edit-journal.test.js tests/integration/v2-recovery-rewind-journal.test.js tests/integration/v2-durable-paused-turn.test.js tests/integration/v2-recovery-center-kernel.test.js
git commit -m "test(v2): cover durable recovery fault injection"
```

---

## Task 15: Syntax check coverage, README, and full verification

**Files:**
- Modify: `package.json`
- Modify: `README.md`
- Possibly modify: `docs/specs/backend/2026-06-01-v2-18-durable-recovery-resume-hardening-design.md` only if implementation changes a public contract from the approved spec.

- [ ] **Step 1: Ensure all new files are in `npm.cmd run check`**

In `package.json`, the `check` script must include:

```text
src/core/recovery/atomic-file.js
src/core/recovery/recovery-faults.js
src/core/recovery/recovery-errors.js
src/core/recovery/project-lock.js
src/core/recovery/recovery-inbox.js
src/core/recovery/paused-turn-persistence.js
src/core/recovery/transaction-journal.js
src/core/recovery/recovery-service.js
```

- [ ] **Step 2: Update README known limitations**

In `README.md`, update the V2 known limitations section so it no longer says crash-safe recovery is deferred to V2-18. The new text should say:

```md
- V2-18 adds process-crash durable recovery for paused approval/repair records and agent-managed edit/rewind transactions. It is not power-loss durable, does not replace Git, and does not roll back arbitrary shell commands or external editor changes.
- V2 recovery state is local/private under `.deepseek-code/v2/`; recovery events are payload-free and the Recovery Center reports only summaries and artifact paths.
```

Keep any remaining V2-19 legacy cleanup limitation intact.

- [ ] **Step 3: Run focused V2 recovery tests**

Run:

```bash
node --test tests/unit/core/recovery/*.test.js tests/integration/v2-durable-paused-turn.test.js tests/integration/v2-recovery-edit-journal.test.js tests/integration/v2-recovery-rewind-journal.test.js tests/integration/v2-recovery-center-kernel.test.js
```

Expected: PASS.

- [ ] **Step 4: Run full test suite**

Run:

```bash
npm.cmd test
```

Expected: PASS with all tests.

- [ ] **Step 5: Run syntax check**

Run:

```bash
npm.cmd run check
```

Expected: PASS.

- [ ] **Step 6: Run whitespace check**

Run:

```bash
git diff --check
```

Expected: PASS or only the pre-existing CRLF warning for `.claude/settings.local.json` if it remains unrelated.

- [ ] **Step 7: Check for test pollution**

Run:

```bash
git status --short .deepseek-code docs/specs/backend/2026-06-01-v2-18-durable-recovery-resume-hardening-design.md docs/plans/backend/2026-06-01-v2-18-durable-recovery-resume-hardening.md
```

Expected: no new `.deepseek-code/v2` pollution from tests; spec and plan remain as intended.

- [ ] **Step 8: Commit**

```bash
git add package.json README.md docs/plans/backend/2026-06-01-v2-18-durable-recovery-resume-hardening.md
git commit -m "docs(v2): add durable recovery implementation plan"
```

If implementation tasks were committed separately, this commit should only contain README/package cleanup and the plan. If the user asked not to commit, skip the commit and report that it was intentionally skipped.

---

## Self-Review Checklist

**Spec coverage:**
- Approval/repair durable pause sidecars: Tasks 5, 6, 10, 11, 14.
- Original autonomy/permission semantics: Task 6, Task 11.
- Edit transaction journal and rollback: Tasks 7, 8, 10, 14.
- Rewind transaction journal and branch restore: Tasks 7, 9, 10, 14.
- Single active writer and takeover/cancel: Task 3, Task 12, Task 14.
- Recovery Center UX and API: Tasks 4, 10, 11, 12, 13.
- Payload-free lifecycle events: Task 2, Task 10, Task 12, Task 13.
- Security/privacy redaction: Tasks 2, 4, 5, 7, 10, 11, 15.
- Fault injection and no `.deepseek-code/v2` pollution: Tasks 1, 14, 15.

**Placeholder scan:** No task says TBD/TODO/fill later. Each task names exact files, commands, expected failures, implementation contracts, and commit commands.

**Type consistency:** Plan consistently uses `kernel.recovery.list/resume/cancel/clear/report`, `paused_turn`, `recovered_tx`, `blocked_recovery`, `takeover`, `quarantined_state`, `rec_pause_<approvalId>`, `rec_tx_<txId>`, `tx:opened`, `tx:committed`, `tx:recovered`, `turn:paused`, `turn:rehydrated`, `turn:resumed`, and `turn:cancelled`.
