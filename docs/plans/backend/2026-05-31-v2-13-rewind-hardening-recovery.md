# V2-13 Rewind Hardening & Recovery Implementation Plan

> 完成状态以 [CHANGELOG](../../CHANGELOG.md) 为准。


**Goal:** Make branching rewind recover workspace files when rollback succeeds but branch creation, activation, or later rollback fails.

**Architecture:** Add a focused `rewind-transaction.js` helper for snapshot/restore, then update `rewind-service.js` to wrap apply in compensation logic. Register recovery events and keep UI changes limited to event summaries.

**Tech Stack:** Node.js >=20 ESM, built-in `node:test`, existing V2 session/event/edit services, no new dependencies.

---

## File Structure

Create:

- `src/sessions/rewind-transaction.js`
  In-memory snapshot and restore helper for files touched by a rewind rollback plan.
- `tests/unit/sessions/rewind-transaction.test.js`
  Unit coverage for snapshot/restore and safe error categories.

Modify:

- `src/sessions/rewind-service.js`
  Add transactional compensation to `apply()`, safe error categories, and recovery event publishing.
- `src/index.js`
  Pass `projectRoot: root` to `createRewindService()`.
- `src/sessions/event-types.js`
  Register recovery events.
- `src/apps/cli/render-events.js`
  Render short summaries for recovery events.
- `package.json`
  Add `src/sessions/rewind-transaction.js` to `npm run check`.
- `tests/unit/sessions/rewind-service.test.js`
  Add branch-create, branch-activate, rollback-failure, rollback-conflict recovery tests.
- `tests/unit/sessions/event-types.test.js`
  Assert new recovery events.
- `tests/unit/apps/cli/render-events.test.js`
  Assert recovery summaries.
- `tests/integration/v2-branching-rewind.test.js`
  Add kernel-level recovery tests with temp roots.

Do not add GUI branch panels in V2-13. Do not mutate existing JSONL events. Do not publish file contents or raw diffs in recovery events.

---

## Task 1: Rewind Transaction Snapshot Helper

**Files:**
- Create: `src/sessions/rewind-transaction.js`
- Test: `tests/unit/sessions/rewind-transaction.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/unit/sessions/rewind-transaction.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  captureRewindSnapshots,
  restoreRewindSnapshots,
  safeRewindError
} from "../../../src/sessions/rewind-transaction.js";

test("captureRewindSnapshots captures existing and missing files without leaking content in metadata", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-rewind-tx-"));
  await writeFile(path.join(root, "a.txt"), "before a\n", "utf8");

  const snapshots = await captureRewindSnapshots(root, ["a.txt", "new/created.txt"]);

  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[0].path, "a.txt");
  assert.equal(snapshots[0].existed_before, true);
  assert.equal(snapshots[0].before, "before a\n");
  assert.match(snapshots[0].before_hash, /^sha256:/);
  assert.equal(snapshots[1].path, "new/created.txt");
  assert.equal(snapshots[1].existed_before, false);
  assert.equal(snapshots[1].before, null);
  assert.equal(JSON.stringify(snapshots.map(({ before, ...safe }) => safe)).includes("before a"), false);
});

test("restoreRewindSnapshots restores modified files and removes files created during rewind", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-rewind-restore-"));
  await writeFile(path.join(root, "a.txt"), "before a\n", "utf8");
  const snapshots = await captureRewindSnapshots(root, ["a.txt", "nested/new.txt"]);

  await writeFile(path.join(root, "a.txt"), "after rewind\n", "utf8");
  await mkdir(path.join(root, "nested"), { recursive: true });
  await writeFile(path.join(root, "nested", "new.txt"), "created\n", "utf8");

  const restored = await restoreRewindSnapshots(root, snapshots);

  assert.deepEqual(restored.sort(), ["a.txt", "nested/new.txt"].sort());
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "before a\n");
  await assert.rejects(() => readFile(path.join(root, "nested", "new.txt"), "utf8"), /ENOENT/);
});

test("captureRewindSnapshots rejects path traversal", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-rewind-unsafe-"));
  await assert.rejects(
    () => captureRewindSnapshots(root, ["../outside.txt"]),
    /outside workspace|path traversal|outside project/i
  );
});

test("safeRewindError returns category only and never raw message", () => {
  const error = new Error("disk failed while writing secret-token-123");
  assert.equal(safeRewindError(error, "create_branch"), "branch_create_failed");
  assert.equal(safeRewindError(error, "activate_branch"), "branch_activate_failed");
  assert.equal(safeRewindError(error, "rollback"), "rollback_failed");
  assert.equal(safeRewindError(error, "restore"), "restore_failed");
  assert.equal(safeRewindError(error, "other"), "rewind_failed");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
npm.cmd test -- tests/unit/sessions/rewind-transaction.test.js
```

Expected: FAIL with module-not-found for `src/sessions/rewind-transaction.js`.

- [ ] **Step 3: Implement rewind-transaction.js**

Create `src/sessions/rewind-transaction.js`:

```js
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveWorkspacePath } from "../workspace/path-safety.js";

export async function captureRewindSnapshots(projectRoot, files = []) {
  if (!projectRoot) throw new Error("projectRoot is required");
  const uniqueFiles = [...new Set((files || []).filter(Boolean))];
  const snapshots = [];
  for (const file of uniqueFiles) {
    const resolved = await resolveWorkspacePath(projectRoot, file, { mustExist: false });
    try {
      const stat = await fs.stat(resolved.absolute);
      if (!stat.isFile()) {
        snapshots.push(emptySnapshot(file));
        continue;
      }
      const before = stripBom(await fs.readFile(resolved.absolute, "utf8"));
      const meta = hashContent(before);
      snapshots.push({
        path: file,
        existed_before: true,
        before,
        before_hash: meta.hash,
        before_bytes: meta.bytes
      });
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      snapshots.push(emptySnapshot(file));
    }
  }
  return snapshots;
}

export async function restoreRewindSnapshots(projectRoot, snapshots = []) {
  if (!projectRoot) throw new Error("projectRoot is required");
  const restored = [];
  const createdDirs = new Set();
  for (const snapshot of snapshots) {
    const resolved = await resolveWorkspacePath(projectRoot, snapshot.path, { mustExist: false });
    if (snapshot.existed_before) {
      await fs.mkdir(path.dirname(resolved.absolute), { recursive: true });
      await fs.writeFile(resolved.absolute, snapshot.before ?? "", "utf8");
    } else {
      await fs.rm(resolved.absolute, { force: true });
      let dir = path.dirname(resolved.absolute);
      const root = path.resolve(projectRoot);
      while (dir !== root && dir.startsWith(root) && !createdDirs.has(dir)) {
        createdDirs.add(dir);
        dir = path.dirname(dir);
      }
    }
    restored.push(snapshot.path);
  }
  for (const dir of [...createdDirs].sort((a, b) => b.length - a.length)) {
    try {
      await fs.rmdir(dir);
    } catch {
      // Best-effort cleanup of empty directories created during failed rewind.
    }
  }
  return restored;
}

export function safeRewindError(_error, phase = "rewind") {
  if (phase === "rollback") return "rollback_failed";
  if (phase === "create_branch") return "branch_create_failed";
  if (phase === "activate_branch") return "branch_activate_failed";
  if (phase === "restore") return "restore_failed";
  return "rewind_failed";
}

export function redactRewindSnapshots(snapshots = []) {
  return snapshots.map(({ before, ...safe }) => safe);
}

function emptySnapshot(file) {
  return {
    path: file,
    existed_before: false,
    before: null,
    before_hash: null,
    before_bytes: 0
  };
}

function hashContent(content) {
  const value = String(content ?? "");
  return {
    hash: `sha256:${createHash("sha256").update(value).digest("hex")}`,
    bytes: Buffer.byteLength(value, "utf8")
  };
}

function stripBom(value) {
  return value.charCodeAt(0) === 0xFEFF ? value.slice(1) : value;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```powershell
npm.cmd test -- tests/unit/sessions/rewind-transaction.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

Run:

```powershell
git add src/sessions/rewind-transaction.js tests/unit/sessions/rewind-transaction.test.js
git commit -m "feat(v2): add rewind transaction snapshots"
```

---

## Task 2: Compensate Branch Create and Activate Failures

**Files:**
- Modify: `src/sessions/rewind-service.js`
- Test: `tests/unit/sessions/rewind-service.test.js`

- [ ] **Step 1: Add failing branch finalization recovery tests**

Append to `tests/unit/sessions/rewind-service.test.js`:

```js
test("rewind apply restores files when createBranch fails after rollback", async () => {
  const eventBus = createEventBus();
  const restored = [];
  eventBus.subscribe("session:rewind_restored", (data) => restored.push(data));
  let fileState = "after edit";
  const service = createRewindService({
    eventBus,
    projectRoot: "/virtual",
    getTimeline: async () => [
      { seq: 1, event_id: "evt_user_1", type: "user:message", turn_id: "turn_1", branch_id: "br_main" },
      { seq: 2, event_id: "evt_apply_1", type: "file:diff_applied", change_id: "change_1", files: ["a.txt"], branch_id: "br_main" }
    ],
    getActiveBranchId: async () => "br_main",
    captureSnapshots: async () => [{ path: "a.txt", existed_before: true, before: "after edit" }],
    restoreSnapshots: async () => { fileState = "after edit"; return ["a.txt"]; },
    createBranch: async () => { throw new Error("secret branch store failure"); },
    activateBranch: async () => { throw new Error("should not activate"); },
    rollback: async () => { fileState = "before edit"; return { status: "success", metadata: { change_id: "change_1" } }; }
  });

  const result = await service.apply({ target: { turn_id: "turn_1" } });

  assert.equal(result.status, "failed_restored");
  assert.equal(result.phase, "create_branch");
  assert.equal(result.reason, "branch_create_failed");
  assert.equal(fileState, "after edit");
  assert.deepEqual(result.restored_files, ["a.txt"]);
  assert.equal(restored.length, 1);
  assert.equal(JSON.stringify(restored).includes("secret branch store failure"), false);
});

test("rewind apply restores files when activateBranch fails after branch creation", async () => {
  const eventBus = createEventBus();
  let activeBranch = "br_main";
  let fileState = "after edit";
  const service = createRewindService({
    eventBus,
    projectRoot: "/virtual",
    getTimeline: async () => [
      { seq: 1, event_id: "evt_user_1", type: "user:message", turn_id: "turn_1", branch_id: "br_main" },
      { seq: 2, event_id: "evt_apply_1", type: "file:diff_applied", change_id: "change_1", files: ["a.txt"], branch_id: "br_main" }
    ],
    getActiveBranchId: async () => activeBranch,
    captureSnapshots: async () => [{ path: "a.txt", existed_before: true, before: "after edit" }],
    restoreSnapshots: async () => { fileState = "after edit"; return ["a.txt"]; },
    createBranch: async (input) => ({ branch_id: input.branch_id, parent_branch_id: "br_main" }),
    activateBranch: async () => { throw new Error("cannot activate secret branch"); },
    rollback: async () => { fileState = "before edit"; return { status: "success", metadata: { change_id: "change_1" } }; }
  });

  const result = await service.apply({ target: { turn_id: "turn_1" } });

  assert.equal(result.status, "failed_restored");
  assert.equal(result.phase, "activate_branch");
  assert.equal(result.reason, "branch_activate_failed");
  assert.equal(fileState, "after edit");
  assert.equal(activeBranch, "br_main");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
npm.cmd test -- tests/unit/sessions/rewind-service.test.js
```

Expected: FAIL because `createRewindService()` does not accept injected snapshot helpers and does not compensate branch finalization failure.

- [ ] **Step 3: Update rewind-service imports and constructor options**

At the top of `src/sessions/rewind-service.js`, add:

```js
import {
  captureRewindSnapshots,
  restoreRewindSnapshots,
  safeRewindError
} from "./rewind-transaction.js";
```

Change the constructor signature:

```js
export function createRewindService({
  eventBus = null,
  projectRoot = null,
  getTimeline,
  getActiveBranchId,
  createBranch = null,
  activateBranch = null,
  rollback,
  captureSnapshots = captureRewindSnapshots,
  restoreSnapshots = restoreRewindSnapshots
} = {}) {
```

- [ ] **Step 4: Add recovery helpers inside createRewindService**

Inside `createRewindService()`, before `apply()`, add:

```js
  async function restoreAfterFailure({
    previewResult,
    snapshots,
    appliedRollbacks,
    phase,
    reason,
    force
  }) {
    const base = {
      current_branch_id: previewResult.current_branch_id,
      attempted_branch_id: previewResult.planned_branch_id,
      phase,
      applied_rollbacks: appliedRollbacks,
      forced: Boolean(force),
      reason
    };
    publish("session:rewind_restore_started", base);
    try {
      const restoredFiles = await restoreSnapshots(projectRoot, snapshots);
      const restored = {
        status: "failed_restored",
        ...base,
        restored_files: restoredFiles
      };
      publish("session:rewind_restored", restored);
      publish("session:rewind_failed", restored);
      return restored;
    } catch (restoreError) {
      const failed = {
        status: "failed_unrestorable",
        ...base,
        restored_files: [],
        restore_error: safeRewindError(restoreError, "restore")
      };
      publish("session:rewind_recovery_failed", failed);
      publish("session:rewind_failed", failed);
      return failed;
    }
  }
```

- [ ] **Step 5: Wrap branch finalization in compensation**

In `apply()`, after `previewResult` and before the rollback loop, add:

```js
    const snapshots = projectRoot
      ? await captureSnapshots(projectRoot, previewResult.files)
      : [];
```

Replace branch creation and activation block with:

```js
    let branch;
    try {
      branch = await createBranch({
        parent_branch_id: currentBranchId,
        forked_from_event_id: previewResult.target.event_id,
        forked_from_seq: previewResult.target.seq,
        forked_from_turn_id: previewResult.target.turn_id,
        label: label || `rewind to ${previewResult.target.turn_id || previewResult.target.event_id || previewResult.target.seq}`,
        branch_id: previewResult.planned_branch_id
      });
    } catch (error) {
      return restoreAfterFailure({
        previewResult,
        snapshots,
        appliedRollbacks,
        phase: "create_branch",
        reason: safeRewindError(error, "create_branch"),
        force
      });
    }
    publish("session:branch_created", {
      branch_id: branch.branch_id,
      parent_branch_id: branch.parent_branch_id,
      forked_from_event_id: branch.forked_from_event_id,
      forked_from_seq: branch.forked_from_seq,
      forked_from_turn_id: branch.forked_from_turn_id
    });
    try {
      await activateBranch(branch.branch_id);
    } catch (error) {
      return restoreAfterFailure({
        previewResult,
        snapshots,
        appliedRollbacks,
        phase: "activate_branch",
        reason: safeRewindError(error, "activate_branch"),
        force
      });
    }
```

Keep the existing `session:branch_activated` and `session:rewind_applied` success publish after this block.

- [ ] **Step 6: Run tests to verify they pass**

Run:

```powershell
npm.cmd test -- tests/unit/sessions/rewind-service.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit Task 2**

Run:

```powershell
git add src/sessions/rewind-service.js tests/unit/sessions/rewind-service.test.js
git commit -m "feat(v2): restore rewind files on branch finalization failure"
```

---

## Task 3: Compensate Mid-Rollback Failure and Conflict

**Files:**
- Modify: `src/sessions/rewind-service.js`
- Test: `tests/unit/sessions/rewind-service.test.js`

- [ ] **Step 1: Add failing mid-rollback recovery tests**

Append to `tests/unit/sessions/rewind-service.test.js`:

```js
test("rewind apply restores earlier rollbacks when later rollback fails", async () => {
  let fileA = "after a";
  let fileB = "after b";
  const service = createRewindService({
    projectRoot: "/virtual",
    getTimeline: async () => [
      { seq: 1, event_id: "evt_user_1", type: "user:message", turn_id: "turn_1", branch_id: "br_main" },
      { seq: 2, event_id: "evt_apply_1", type: "file:diff_applied", change_id: "change_1", files: ["a.txt"], branch_id: "br_main" },
      { seq: 3, event_id: "evt_apply_2", type: "file:diff_applied", change_id: "change_2", files: ["b.txt"], branch_id: "br_main" }
    ],
    getActiveBranchId: async () => "br_main",
    captureSnapshots: async () => [
      { path: "a.txt", existed_before: true, before: "after a" },
      { path: "b.txt", existed_before: true, before: "after b" }
    ],
    restoreSnapshots: async () => { fileA = "after a"; fileB = "after b"; return ["a.txt", "b.txt"]; },
    createBranch: async () => ({ branch_id: "br_unused" }),
    activateBranch: async () => {},
    rollback: async ({ change_id }) => {
      if (change_id === "change_2") {
        fileB = "before b";
        return { status: "success", metadata: { change_id } };
      }
      return { status: "failed", content: [{ text: "raw secret rollback error" }] };
    }
  });

  const result = await service.apply({ target: { turn_id: "turn_1" } });

  assert.equal(result.status, "failed_restored");
  assert.equal(result.phase, "rollback");
  assert.equal(result.reason, "rollback_failed");
  assert.deepEqual(result.applied_rollbacks, ["change_2"]);
  assert.equal(fileA, "after a");
  assert.equal(fileB, "after b");
  assert.equal(JSON.stringify(result).includes("raw secret"), false);
});

test("rewind apply restores earlier rollbacks when later rollback conflicts", async () => {
  let fileB = "after b";
  const eventBus = createEventBus();
  const restored = [];
  eventBus.subscribe("session:rewind_restored", (data) => restored.push(data));
  const service = createRewindService({
    eventBus,
    projectRoot: "/virtual",
    getTimeline: async () => [
      { seq: 1, event_id: "evt_user_1", type: "user:message", turn_id: "turn_1", branch_id: "br_main" },
      { seq: 2, event_id: "evt_apply_1", type: "file:diff_applied", change_id: "change_1", files: ["a.txt"], branch_id: "br_main" },
      { seq: 3, event_id: "evt_apply_2", type: "file:diff_applied", change_id: "change_2", files: ["b.txt"], branch_id: "br_main" }
    ],
    getActiveBranchId: async () => "br_main",
    captureSnapshots: async () => [{ path: "b.txt", existed_before: true, before: "after b" }],
    restoreSnapshots: async () => { fileB = "after b"; return ["b.txt"]; },
    createBranch: async () => ({ branch_id: "br_unused" }),
    activateBranch: async () => {},
    rollback: async ({ change_id }) => {
      if (change_id === "change_2") {
        fileB = "before b";
        return { status: "success", metadata: { change_id } };
      }
      return { status: "conflict", metadata: { change_id, conflicts: [{ path: "a.txt", reason: "dirty" }] } };
    }
  });

  const result = await service.apply({ target: { turn_id: "turn_1" } });

  assert.equal(result.status, "conflict_restored");
  assert.deepEqual(result.applied_rollbacks, ["change_2"]);
  assert.equal(fileB, "after b");
  assert.equal(restored.length, 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
npm.cmd test -- tests/unit/sessions/rewind-service.test.js
```

Expected: FAIL because rollback failure/conflict paths return immediately without restore.

- [ ] **Step 3: Add conflict restore helper**

Inside `createRewindService()`, after `restoreAfterFailure()`, add:

```js
  async function restoreAfterConflict({
    previewResult,
    snapshots,
    appliedRollbacks,
    failedChangeId,
    conflicts,
    force
  }) {
    if (appliedRollbacks.length === 0) {
      const conflict = {
        status: "conflict",
        current_branch_id: previewResult.current_branch_id,
        attempted_branch_id: previewResult.planned_branch_id,
        failed_change_id: failedChangeId,
        applied_rollbacks: appliedRollbacks,
        remaining_change_ids: previewResult.rollback_change_ids.slice(appliedRollbacks.length),
        conflicts,
        forced: Boolean(force)
      };
      publish("session:rewind_conflict", conflict);
      return conflict;
    }
    const restored = await restoreAfterFailure({
      previewResult,
      snapshots,
      appliedRollbacks,
      phase: "rollback",
      reason: "rollback_failed",
      force
    });
    const conflictRestored = {
      ...restored,
      status: restored.status === "failed_unrestorable" ? "failed_unrestorable" : "conflict_restored",
      failed_change_id: failedChangeId,
      conflicts
    };
    publish("session:rewind_conflict", conflictRestored);
    return conflictRestored;
  }
```

- [ ] **Step 4: Update rollback loop failure branches**

In the rollback loop in `apply()`, replace the conflict block with:

```js
      if (result.status === "conflict") {
        return restoreAfterConflict({
          previewResult,
          snapshots,
          appliedRollbacks,
          failedChangeId: changeId,
          conflicts: result.metadata?.conflicts || [],
          force
        });
      }
```

Replace the non-success block with:

```js
      if (result.status !== "success") {
        return restoreAfterFailure({
          previewResult,
          snapshots,
          appliedRollbacks,
          phase: "rollback",
          reason: safeRewindError(new Error("rollback failed"), "rollback"),
          force
        });
      }
```

- [ ] **Step 5: Run tests to verify they pass**

Run:

```powershell
npm.cmd test -- tests/unit/sessions/rewind-service.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit Task 3**

Run:

```powershell
git add src/sessions/rewind-service.js tests/unit/sessions/rewind-service.test.js
git commit -m "feat(v2): restore rewind files on rollback failure"
```

---

## Task 4: Event Registry and CLI Summaries

**Files:**
- Modify: `src/sessions/event-types.js`
- Modify: `src/apps/cli/render-events.js`
- Test: `tests/unit/sessions/event-types.test.js`
- Test: `tests/unit/apps/cli/render-events.test.js`

- [ ] **Step 1: Add failing event registry assertions**

In `tests/unit/sessions/event-types.test.js`, add these to the canonical event list:

```js
    "session:rewind_restore_started",
    "session:rewind_restored",
    "session:rewind_recovery_failed",
```

- [ ] **Step 2: Add failing CLI summary assertions**

Append to `tests/unit/apps/cli/render-events.test.js`:

```js
test("summarizeKernelEvent renders rewind recovery events", () => {
  assert.equal(
    summarizeKernelEvent({ type: "session:rewind_restore_started", applied_rollbacks: ["a", "b"] }),
    "rewind restoring 2 changes"
  );
  assert.equal(
    summarizeKernelEvent({ type: "session:rewind_restored", restored_files: ["a.txt"] }),
    "rewind restored 1 files"
  );
  assert.equal(
    summarizeKernelEvent({ type: "session:rewind_recovery_failed", reason: "restore_failed" }),
    "rewind recovery failed restore_failed"
  );
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```powershell
npm.cmd test -- tests/unit/sessions/event-types.test.js tests/unit/apps/cli/render-events.test.js
```

Expected: FAIL because events and summaries are missing.

- [ ] **Step 4: Register event types**

In `src/sessions/event-types.js`, add after `"session:rewind_failed"`:

```js
  "session:rewind_restore_started",
  "session:rewind_restored",
  "session:rewind_recovery_failed",
```

- [ ] **Step 5: Add CLI summaries**

In `src/apps/cli/render-events.js`, near existing rewind summaries, add:

```js
  if (event.type === "session:rewind_restore_started") {
    return `rewind restoring ${(event.applied_rollbacks || []).length} changes`;
  }
  if (event.type === "session:rewind_restored") {
    return `rewind restored ${(event.restored_files || []).length} files`;
  }
  if (event.type === "session:rewind_recovery_failed") {
    return `rewind recovery failed ${event.reason || event.restore_error || "unknown"}`;
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run:

```powershell
npm.cmd test -- tests/unit/sessions/event-types.test.js tests/unit/apps/cli/render-events.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit Task 4**

Run:

```powershell
git add src/sessions/event-types.js src/apps/cli/render-events.js tests/unit/sessions/event-types.test.js tests/unit/apps/cli/render-events.test.js
git commit -m "feat(v2): add rewind recovery events"
```

---

## Task 5: Kernel Integration Recovery Tests

**Files:**
- Modify: `src/index.js`
- Modify: `tests/integration/v2-branching-rewind.test.js`

- [ ] **Step 1: Add failing integration test for branch create failure**

Append to `tests/integration/v2-branching-rewind.test.js`:

```js
test("kernel rewind restores files when branch creation fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-v2-rewind-create-fail-"));
  await writeFile(path.join(root, "a.txt"), "old a\n");
  await writeFile(path.join(root, "b.txt"), "old b\n");
  const kernel = await createKernel(root, {
    sessionRoot: path.join(root, ".sessions"),
    sessionId: "sess_rewind_create_fail",
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
  kernel.eventBus.publish("agent:final", { turn_id: "turn_2", content: "done b" });
  await kernel.session.flush();

  const originalCreate = kernel.session.branches.create;
  kernel.session.branches.create = async () => { throw new Error("simulated branch create failure with secret content"); };

  const result = await kernel.session.rewind.apply({ target: { turn_id: "turn_1" } });

  assert.equal(result.status, "failed_restored");
  assert.equal(result.reason, "branch_create_failed");
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "new a\n");
  assert.equal(await readFile(path.join(root, "b.txt"), "utf8"), "new b\n");
  assert.equal((await kernel.session.branches.getActive()).branch_id, "br_main");
  assert.equal(JSON.stringify(result).includes("secret content"), false);

  kernel.session.branches.create = originalCreate;
});
```

- [ ] **Step 2: Add failing integration test for branch activation failure**

Append to `tests/integration/v2-branching-rewind.test.js`:

```js
test("kernel rewind restores files when branch activation fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-v2-rewind-activate-fail-"));
  await writeFile(path.join(root, "a.txt"), "old a\n");
  await writeFile(path.join(root, "b.txt"), "old b\n");
  const kernel = await createKernel(root, {
    sessionRoot: path.join(root, ".sessions"),
    sessionId: "sess_rewind_activate_fail",
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
  kernel.eventBus.publish("agent:final", { turn_id: "turn_2", content: "done b" });
  await kernel.session.flush();

  const originalActivate = kernel.session.branches.activate;
  kernel.session.branches.activate = async () => { throw new Error("simulated activation failure with raw details"); };

  const result = await kernel.session.rewind.apply({ target: { turn_id: "turn_1" } });

  assert.equal(result.status, "failed_restored");
  assert.equal(result.reason, "branch_activate_failed");
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "new a\n");
  assert.equal(await readFile(path.join(root, "b.txt"), "utf8"), "new b\n");
  assert.equal((await kernel.session.branches.getActive()).branch_id, "br_main");
  assert.equal(JSON.stringify(result).includes("raw details"), false);

  kernel.session.branches.activate = originalActivate;
});
```

- [ ] **Step 3: Run integration tests to verify they fail**

Run:

```powershell
npm.cmd test -- tests/integration/v2-branching-rewind.test.js
```

Expected: FAIL until `src/index.js` injects rewired branch facade methods into rewind service or exposes testable DI.

- [ ] **Step 4: Wire projectRoot and branch facade into rewind service**

In `src/index.js`, change rewind service creation from:

```js
  const rewind = branchStore ? createRewindService({
    eventBus,
    getTimeline: (input) => sessionManager.getTimeline(input),
    getActiveBranchId: async () => activeBranchId,
    createBranch: (input) => branchStore.createBranch(input),
    activateBranch: async (branchId) => {
      const branch = await branchStore.activateBranch(branchId);
      activeBranchId = branch.branch_id;
      return branch;
    },
    rollback: (input) => editService.rollback(input)
  }) : {
```

to:

```js
  const rewind = branchStore ? createRewindService({
    eventBus,
    projectRoot: root,
    getTimeline: (input) => sessionManager.getTimeline(input),
    getActiveBranchId: async () => activeBranchId,
    createBranch: (input) => branches.create(input),
    activateBranch: (branchId) => branches.activate(branchId),
    rollback: (input) => editService.rollback(input)
  }) : {
```

This lets integration tests monkey-patch `kernel.session.branches.create` and `activate`.

- [ ] **Step 5: Run integration tests to verify they pass**

Run:

```powershell
npm.cmd test -- tests/integration/v2-branching-rewind.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit Task 5**

Run:

```powershell
git add src/index.js tests/integration/v2-branching-rewind.test.js
git commit -m "feat(v2): wire rewind recovery into kernel"
```

---

## Task 6: Event Privacy Regression

**Files:**
- Modify: `tests/unit/sessions/rewind-service.test.js`

- [ ] **Step 1: Add failing event privacy test**

Append to `tests/unit/sessions/rewind-service.test.js`:

```js
test("rewind recovery events do not include raw file content diff or exception text", async () => {
  const eventBus = createEventBus();
  const events = [];
  for (const type of [
    "session:rewind_restore_started",
    "session:rewind_restored",
    "session:rewind_failed",
    "session:rewind_recovery_failed"
  ]) {
    eventBus.subscribe(type, (data) => events.push({ type, data }));
  }
  const service = createRewindService({
    eventBus,
    projectRoot: "/virtual",
    getTimeline: async () => [
      { seq: 1, event_id: "evt_user_1", type: "user:message", turn_id: "turn_1", branch_id: "br_main" },
      { seq: 2, event_id: "evt_apply_1", type: "file:diff_applied", change_id: "change_1", files: ["secret.txt"], branch_id: "br_main" }
    ],
    getActiveBranchId: async () => "br_main",
    captureSnapshots: async () => [{ path: "secret.txt", existed_before: true, before: "TOP_SECRET_CONTENT\n" }],
    restoreSnapshots: async () => ["secret.txt"],
    createBranch: async () => { throw new Error("diff --git a/secret.txt b/secret.txt @@ TOP_SECRET_CONTENT"); },
    activateBranch: async () => {},
    rollback: async () => ({ status: "success", metadata: { change_id: "change_1" } })
  });

  await service.apply({ target: { turn_id: "turn_1" } });

  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes("TOP_SECRET_CONTENT"), false);
  assert.equal(serialized.includes("diff --git"), false);
  assert.equal(serialized.includes("@@"), false);
  assert.equal(serialized.includes("before"), false);
});
```

- [ ] **Step 2: Run test to verify it fails or passes honestly**

Run:

```powershell
npm.cmd test -- tests/unit/sessions/rewind-service.test.js
```

Expected: PASS if Tasks 2-3 already avoided raw messages and snapshots; FAIL if recovery event payloads leaked snapshot content.

- [ ] **Step 3: Fix leaks if needed**

If the test fails, remove any `snapshots`, `error.message`, raw `result.content`, or unredacted rollback metadata from recovery event payloads. Keep only:

```js
{
  status,
  current_branch_id,
  attempted_branch_id,
  phase,
  applied_rollbacks,
  restored_files,
  failed_change_id,
  conflicts,
  reason,
  restore_error,
  forced
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
npm.cmd test -- tests/unit/sessions/rewind-service.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit Task 6**

Run:

```powershell
git add src/sessions/rewind-service.js tests/unit/sessions/rewind-service.test.js
git commit -m "test(v2): guard rewind recovery event privacy"
```

---

## Task 7: Package Check and Full Regression

**Files:**
- Modify: `package.json`
- Test: full suite

- [ ] **Step 1: Add new module to syntax check**

In `package.json`, update the session check segment from:

```json
"src/sessions/event-types.js src/sessions/event-log.js src/sessions/branch-store.js src/sessions/checkpoint-index.js src/sessions/rewind-service.js src/sessions/session-manager.js"
```

to:

```json
"src/sessions/event-types.js src/sessions/event-log.js src/sessions/branch-store.js src/sessions/checkpoint-index.js src/sessions/rewind-transaction.js src/sessions/rewind-service.js src/sessions/session-manager.js"
```

- [ ] **Step 2: Run focused V2-13 tests**

Run:

```powershell
npm.cmd test -- tests/unit/sessions/rewind-transaction.test.js tests/unit/sessions/rewind-service.test.js tests/unit/sessions/event-types.test.js tests/unit/apps/cli/render-events.test.js tests/integration/v2-branching-rewind.test.js
```

Expected: PASS.

- [ ] **Step 3: Run full test suite**

Run:

```powershell
npm.cmd test
```

Expected: all tests pass. Total count should be greater than the V2-12 baseline of 465.

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

Expected: PASS. If warnings mention pre-existing user-local files, confirm no V2-13 files are listed.

- [ ] **Step 6: Run pollution check**

Run:

```powershell
if (Test-Path -LiteralPath ".deepseek-code\v2") { throw ".deepseek-code/v2 should not be created by tests" } else { "no v2 session pollution" }
```

Expected: `no v2 session pollution`.

- [ ] **Step 7: Commit Task 7**

Run:

```powershell
git add package.json
git commit -m "chore(v2): include rewind recovery checks"
```

---

## Final Review Checklist

- [ ] `rewind.preview()` remains read-only.
- [ ] Successful rewind still creates and activates a child branch.
- [ ] Branch creation failure after rollback returns `failed_restored`.
- [ ] Branch activation failure after rollback returns `failed_restored`.
- [ ] Later rollback failure after earlier rollback returns `failed_restored`.
- [ ] Later rollback conflict after earlier rollback returns `conflict_restored`.
- [ ] If restore itself fails, result is `failed_unrestorable`.
- [ ] Active branch remains unchanged on failed/restored rewind.
- [ ] Recovery events are registered and summarized.
- [ ] Recovery events do not include raw diff, hunk content, file content, snippets, or raw exception text.
- [ ] Full tests, syntax check, whitespace check, and pollution check pass.

## Execution Notes

Use one commit per task. If integration tests reveal that monkey-patching `kernel.session.branches.create` cannot affect the already-created rewind service, prefer rewiring `createRewindService()` through the branch facade as described in Task 5 rather than adding test-only hooks. Keep recovery in memory only; durable crash recovery is deferred.
