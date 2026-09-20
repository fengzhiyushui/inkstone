# V2-11 Transactional Edit & Dirty Workspace Safety Implementation Plan

> 完成状态以 [CHANGELOG](../../CHANGELOG.md) 为准。


**Goal:** Make V2 edit apply transactional and make rollback dirty-workspace-safe with explicit force support.

**Architecture:** Add a focused edit transaction module under `src/edits/` that snapshots touched files, restores snapshots on apply failure, and computes before/after hashes for change records. Keep the mature legacy diff parser/apply path, but wrap it with transaction safety and conflict-aware rollback behavior exposed through `EditService` and the existing deferred edit tools.

**Tech Stack:** Node.js >=20 ESM, built-in `node:test`, existing `src/patch.js`, V2 `src/workspace/path-safety.js`, V2 edit service, no new dependencies.

---

## File Structure

Create:

- `src/edits/edit-transaction.js`
  Owns hashing, touched-file snapshotting, restoring snapshots, change-record hash enhancement, rollback conflict detection, and force rollback helpers.
- `tests/unit/edits/edit-transaction.test.js`
  Unit tests for transaction snapshots, restore, conflict detection, and force rollback.

Modify:

- `src/edits/edit-service.js`
  Route `apply()` through transaction helpers; route `rollback()` through conflict-aware rollback; publish transaction events.
- `src/edits/rollback-service.js`
  Accept `force` and delegate to conflict-aware rollback helper instead of directly calling legacy rollback.
- `src/tools/builtin/edit-deferred.js`
  Add optional `force` boolean to `diff_rollback`.
- `src/sessions/event-types.js`
  Register transaction and rollback conflict events.
- `tests/unit/edits/edit-service.test.js`
  Add apply failure restore, dirty rollback conflict, force rollback, and event privacy tests.
- `tests/integration/v2-edit-tools-kernel.test.js`
  Add kernel-level rollback conflict and force rollback tests.
- `tests/unit/sessions/event-types.test.js`
  Assert new event types are registered.
- `package.json`
  Add `src/edits/edit-transaction.js` to `npm run check`.

Do not modify V0/V1 legacy files except where V2 wrappers already depend on them. In particular, avoid broad refactors of `src/patch.js` unless a test proves the transaction wrapper cannot meet the requirement.

---

### Task 1: Transaction Hash and Snapshot Helpers

**Files:**
- Create: `src/edits/edit-transaction.js`
- Test: `tests/unit/edits/edit-transaction.test.js`

- [ ] **Step 1: Write failing tests for hashing and touched snapshots**

Create `tests/unit/edits/edit-transaction.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  hashContent,
  restoreSnapshots,
  snapshotTouchedFiles
} from "../../../src/edits/edit-transaction.js";
import { parseDiff } from "../../../src/edits/diff-parser.js";

test("hashContent returns stable sha256 metadata", () => {
  const result = hashContent("hello\n");

  assert.equal(result.hash.startsWith("sha256:"), true);
  assert.equal(result.bytes, Buffer.byteLength("hello\n"));
  assert.equal(hashContent("hello\n").hash, result.hash);
  assert.notEqual(hashContent("other\n").hash, result.hash);
});

test("snapshotTouchedFiles records existing and created file states", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-edit-tx-snapshot-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  const diff = [
    "diff --git a/a.txt b/a.txt",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "diff --git a/new.txt b/new.txt",
    "--- /dev/null",
    "+++ b/new.txt",
    "@@ -0,0 +1 @@",
    "+created"
  ].join("\n");
  const parsed = parseDiff(diff);

  const snapshots = await snapshotTouchedFiles(root, parsed.patches);

  const byPath = Object.fromEntries(snapshots.map((item) => [item.path, item]));
  assert.equal(byPath["a.txt"].status, "modify");
  assert.equal(byPath["a.txt"].existed_before, true);
  assert.equal(byPath["a.txt"].before, "old\n");
  assert.equal(byPath["a.txt"].before_hash, hashContent("old\n").hash);
  assert.equal(byPath["new.txt"].status, "create");
  assert.equal(byPath["new.txt"].existed_before, false);
  assert.equal(byPath["new.txt"].before, null);
  assert.equal(byPath["new.txt"].before_hash, null);
});

test("restoreSnapshots restores modified files and removes created files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-edit-tx-restore-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  const parsed = parseDiff([
    "diff --git a/a.txt b/a.txt",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "diff --git a/new.txt b/new.txt",
    "--- /dev/null",
    "+++ b/new.txt",
    "@@ -0,0 +1 @@",
    "+created"
  ].join("\n"));
  const snapshots = await snapshotTouchedFiles(root, parsed.patches);
  await writeFile(path.join(root, "a.txt"), "new\n");
  await writeFile(path.join(root, "new.txt"), "created\n");

  const restored = await restoreSnapshots(root, snapshots);

  assert.deepEqual(restored.sort(), ["a.txt", "new.txt"]);
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "old\n");
  await assert.rejects(() => readFile(path.join(root, "new.txt"), "utf8"), /ENOENT/);
});

test("snapshotTouchedFiles refuses create patches when target already exists", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-edit-tx-create-exists-"));
  await writeFile(path.join(root, "new.txt"), "user content\n");
  const parsed = parseDiff([
    "diff --git a/new.txt b/new.txt",
    "--- /dev/null",
    "+++ b/new.txt",
    "@@ -0,0 +1 @@",
    "+created"
  ].join("\n"));

  await assert.rejects(
    () => snapshotTouchedFiles(root, parsed.patches),
    /already exists/
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
npm.cmd test -- tests/unit/edits/edit-transaction.test.js
```

Expected: FAIL with module-not-found for `src/edits/edit-transaction.js`.

- [ ] **Step 3: Implement hash and snapshot helpers**

Create `src/edits/edit-transaction.js`:

```js
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveWorkspacePath } from "../workspace/path-safety.js";

export function hashContent(content) {
  const value = String(content ?? "");
  return {
    hash: `sha256:${createHash("sha256").update(value).digest("hex")}`,
    bytes: Buffer.byteLength(value, "utf8")
  };
}

export async function snapshotTouchedFiles(projectRoot, patches = []) {
  if (!projectRoot) throw new Error("projectRoot is required");
  const snapshots = [];
  for (const patch of patches) {
    const filePath = patch.newPath === "/dev/null" ? patch.oldPath : patch.newPath;
    const status = patch.oldPath === "/dev/null"
      ? "create"
      : patch.newPath === "/dev/null"
        ? "delete"
        : "modify";
    const existedBefore = patch.oldPath !== "/dev/null";
    let before = null;
    let beforeHash = null;
    let beforeBytes = 0;
    let beforeMtimeMs = null;

    if (existedBefore) {
      const resolved = await resolveWorkspacePath(projectRoot, patch.oldPath, { mustExist: true });
      const stat = await fs.stat(resolved.real);
      before = stripBom(await fs.readFile(resolved.real, "utf8"));
      const hashed = hashContent(before);
      beforeHash = hashed.hash;
      beforeBytes = hashed.bytes;
      beforeMtimeMs = stat.mtimeMs;
    } else {
      const resolved = await resolveWorkspacePath(projectRoot, filePath, { mustExist: false });
      if (await fileExists(resolved.absolute)) {
        throw new Error(`create patch target already exists: ${filePath}`);
      }
    }

    snapshots.push({
      path: filePath,
      oldPath: patch.oldPath,
      newPath: patch.newPath,
      status,
      existed_before: existedBefore,
      before,
      before_hash: beforeHash,
      before_bytes: beforeBytes,
      before_mtime_ms: beforeMtimeMs
    });
  }
  return snapshots;
}

export async function restoreSnapshots(projectRoot, snapshots = []) {
  const restored = [];
  for (const snapshot of snapshots) {
    const targetPath = snapshot.newPath === "/dev/null" ? snapshot.oldPath : snapshot.newPath;
    const resolved = await resolveWorkspacePath(projectRoot, targetPath, { mustExist: false });
    if (!snapshot.existed_before) {
      await fs.rm(resolved.absolute, { force: true });
    } else {
      await fs.mkdir(path.dirname(resolved.absolute), { recursive: true });
      await fs.writeFile(resolved.absolute, snapshot.before ?? "", "utf8");
    }
    restored.push(snapshot.path);
  }
  return restored;
}

function stripBom(value) {
  return value.charCodeAt(0) === 0xFEFF ? value.slice(1) : value;
}

async function fileExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```powershell
npm.cmd test -- tests/unit/edits/edit-transaction.test.js
```

Expected: PASS for 4 tests.

- [ ] **Step 5: Commit Task 1**

Run:

```powershell
git add src/edits/edit-transaction.js tests/unit/edits/edit-transaction.test.js
git commit -m "feat(v2): add edit transaction snapshots"
```

---

### Task 2: Transactional Apply Failure Restore

**Files:**
- Modify: `src/edits/edit-transaction.js`
- Modify: `src/edits/edit-service.js`
- Test: `tests/unit/edits/edit-service.test.js`

- [ ] **Step 1: Add failing edit-service test for multi-file partial failure**

Append to `tests/unit/edits/edit-service.test.js`:

```js
test("apply restores earlier writes when a later patch fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-edit-service-tx-fail-"));
  await writeFile(path.join(root, "a.txt"), "old a\n");
  await writeFile(path.join(root, "b.txt"), "old b\n");
  const service = createEditService({ projectRoot: root });
  const diff = [
    "diff --git a/a.txt b/a.txt",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1 +1 @@",
    "-old a",
    "+new a",
    "diff --git a/b.txt b/b.txt",
    "--- a/b.txt",
    "+++ b/b.txt",
    "@@ -1 +1 @@",
    "-not the current content",
    "+new b"
  ].join("\n");

  await assert.rejects(() => service.apply({ diff, prompt: "partial failure" }), /context|mismatch/i);

  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "old a\n");
  assert.equal(await readFile(path.join(root, "b.txt"), "utf8"), "old b\n");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm.cmd test -- tests/unit/edits/edit-service.test.js
```

Expected: FAIL because `a.txt` remains `new a\n`.

- [ ] **Step 3: Add transactional apply helper**

In `src/edits/edit-transaction.js`, add imports:

```js
import { applyUnifiedDiff } from "../patch.js";
```

Then add:

```js
export async function applyDiffTransaction({
  projectRoot,
  parsed,
  transaction_id = makeTransactionId(),
  applyDiff = applyUnifiedDiff
} = {}) {
  if (!projectRoot) throw new Error("projectRoot is required");
  if (!parsed?.diff || !Array.isArray(parsed.patches)) throw new Error("parsed diff is required");
  const snapshots = await snapshotTouchedFiles(projectRoot, parsed.patches);
  try {
    const applied = await applyDiff(parsed.diff, projectRoot);
    return {
      transaction_id,
      snapshots,
      applied,
      restored_on_failure: false
    };
  } catch (error) {
    const restoredFiles = await restoreSnapshots(projectRoot, snapshots);
    error.transaction_id = transaction_id;
    error.restored = true;
    error.restored_files = restoredFiles;
    error.failed_files = parsed.files || snapshots.map((item) => item.path);
    throw error;
  }
}

export function makeTransactionId() {
  return `tx_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`;
}
```

- [ ] **Step 4: Route EditService.apply through applyDiffTransaction and publish safe failure events**

In `src/edits/edit-service.js`, add import:

```js
import {
  applyDiffTransaction,
  makeTransactionId,
  restoreSnapshots
} from "./edit-transaction.js";
```

Replace:

```js
await applyUnifiedDiff(parsed.diff, projectRoot);
const record = await store.finalize(plan);
```

with:

```js
let transaction;
const transaction_id = makeTransactionId();
publish("file:transaction_started", {
  transaction_id,
  files: parsed.files,
  summary: parsed.summary,
  diff_hash: hashText(parsed.diff),
  diff_size: Buffer.byteLength(parsed.diff, "utf8")
});
try {
  transaction = await applyDiffTransaction({ projectRoot, parsed, transaction_id });
} catch (error) {
  publish("file:transaction_failed", {
    transaction_id: error.transaction_id || null,
    files: parsed.files,
    restored_files: error.restored_files || [],
    restored: Boolean(error.restored),
    message: String(error.message || error).slice(0, 500)
  });
  throw error;
}
let record;
try {
  record = await store.finalize(plan, { transaction });
} catch (error) {
  const restoredFiles = await restoreSnapshots(projectRoot, transaction.snapshots);
  publish("file:transaction_failed", {
    transaction_id,
    files: parsed.files,
    restored_files: restoredFiles,
    restored: true,
    message: String(error.message || error).slice(0, 500)
  });
  throw error;
}
```

Remove the existing `applyUnifiedDiff` import from `edit-service.js` if it is no longer used.

- [ ] **Step 5: Run test to verify it passes**

Run:

```powershell
npm.cmd test -- tests/unit/edits/edit-service.test.js
```

Expected: PASS and `a.txt` restored to `old a\n`.

- [ ] **Step 6: Commit Task 2**

Run:

```powershell
git add src/edits/edit-transaction.js src/edits/edit-service.js tests/unit/edits/edit-service.test.js
git commit -m "feat(v2): restore edit transaction on apply failure"
```

---

### Task 3: Enhanced Change Records with Before/After Hashes

**Files:**
- Modify: `src/edits/edit-transaction.js`
- Modify: `src/edits/change-store.js`
- Test: `tests/unit/edits/edit-transaction.test.js`
- Test: `tests/unit/edits/edit-service.test.js`

- [ ] **Step 1: Add failing tests for enhanced records**

Update the existing `edit-transaction.js` import in `tests/unit/edits/edit-transaction.test.js` to include `enhanceChangeRecord`, then append this test:

```js
test("enhanceChangeRecord adds before and after hashes to each file", () => {
  const record = {
    id: "change_1",
    files: [
      {
        path: "a.txt",
        oldPath: "a.txt",
        newPath: "a.txt",
        status: "modify",
        before: "old\n",
        after: "new\n"
      }
    ]
  };
  const enhanced = enhanceChangeRecord(record, { transaction_id: "tx_1" });

  assert.equal(enhanced.transaction_id, "tx_1");
  assert.equal(enhanced.files[0].before_hash, hashContent("old\n").hash);
  assert.equal(enhanced.files[0].after_hash, hashContent("new\n").hash);
  assert.equal(enhanced.files[0].before_bytes, Buffer.byteLength("old\n"));
  assert.equal(enhanced.files[0].after_bytes, Buffer.byteLength("new\n"));
});
```

Append to `tests/unit/edits/edit-service.test.js`:

```js
test("apply records before and after hashes in change metadata", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-edit-service-hashes-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  const service = createEditService({ projectRoot: root });

  const applied = await service.apply({ diff: MODIFY_DIFF, prompt: "hashes" });
  const described = await service.describe({ change_id: applied.metadata.change_id });

  assert.equal(described.metadata.files.includes("a.txt"), true);
  const record = JSON.parse(await readFile(path.join(root, ".deepseek-code", "changes", `${applied.metadata.change_id}.json`), "utf8"));
  assert.equal(record.files[0].before_hash?.startsWith("sha256:"), true);
  assert.equal(record.files[0].after_hash?.startsWith("sha256:"), true);
  assert.notEqual(record.files[0].before_hash, record.files[0].after_hash);
  assert.equal(record.transaction_id?.startsWith("tx_"), true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
npm.cmd test -- tests/unit/edits/edit-transaction.test.js tests/unit/edits/edit-service.test.js
```

Expected: FAIL because `enhanceChangeRecord` is missing and records do not include hashes.

- [ ] **Step 3: Implement enhanceChangeRecord**

In `src/edits/edit-transaction.js`, add:

```js
export function enhanceChangeRecord(record, { transaction_id = null } = {}) {
  const files = (record.files || []).map((file) => {
    const beforeMeta = file.before == null ? { hash: null, bytes: 0 } : hashContent(file.before);
    const afterMeta = file.after == null ? { hash: null, bytes: 0 } : hashContent(file.after);
    return {
      ...file,
      before_hash: file.before_hash ?? beforeMeta.hash,
      after_hash: file.after_hash ?? afterMeta.hash,
      before_bytes: file.before_bytes ?? beforeMeta.bytes,
      after_bytes: file.after_bytes ?? afterMeta.bytes,
      transaction_id: file.transaction_id || transaction_id
    };
  });
  return {
    ...record,
    transaction_id: record.transaction_id || transaction_id,
    files
  };
}
```

- [ ] **Step 4: Modify change-store finalize to enhance records**

In `src/edits/change-store.js`, add import:

```js
import { promises as fs } from "node:fs";
import path from "node:path";
import { enhanceChangeRecord } from "./edit-transaction.js";
```

Change `finalize(plan)` to:

```js
    async finalize(plan, { transaction = null } = {}) {
      const record = await finalizeChange(projectRoot, plan);
      if (!transaction) return record;
      const enhanced = enhanceChangeRecord(record, { transaction_id: transaction.transaction_id });
      const target = path.join(projectRoot, ".deepseek-code", "changes", `${enhanced.id}.json`);
      await fs.writeFile(target, `${JSON.stringify(enhanced, null, 2)}\n`, "utf8");
      return enhanced;
    },
```

This intentionally rewrites the just-finalized legacy record with hash metadata while preserving the existing file layout.

- [ ] **Step 5: Run tests to verify they pass**

Run:

```powershell
npm.cmd test -- tests/unit/edits/edit-transaction.test.js tests/unit/edits/edit-service.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit Task 3**

Run:

```powershell
git add src/edits/edit-transaction.js src/edits/change-store.js tests/unit/edits/edit-transaction.test.js tests/unit/edits/edit-service.test.js
git commit -m "feat(v2): record edit transaction hashes"
```

---

### Task 4: Dirty Rollback Conflict Detection

**Files:**
- Modify: `src/edits/edit-transaction.js`
- Modify: `src/edits/rollback-service.js`
- Modify: `src/edits/edit-service.js`
- Test: `tests/unit/edits/edit-transaction.test.js`
- Test: `tests/unit/edits/edit-service.test.js`

- [ ] **Step 1: Add failing tests for rollback conflict**

Append to `tests/unit/edits/edit-service.test.js`:

```js
test("rollback blocks dirty files and writes nothing by default", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-edit-service-dirty-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  const eventBus = createEventBus();
  const conflicts = [];
  eventBus.subscribe("file:rollback_conflict", (data) => conflicts.push(data));
  const service = createEditService({ projectRoot: root, eventBus });

  const applied = await service.apply({ diff: MODIFY_DIFF, prompt: "update a" });
  await writeFile(path.join(root, "a.txt"), "manual change\n");
  const result = await service.rollback({ change_id: applied.metadata.change_id });

  assert.equal(result.status, "conflict");
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "manual change\n");
  assert.equal(result.metadata.conflicts.length, 1);
  assert.equal(result.metadata.conflicts[0].path, "a.txt");
  assert.equal(result.metadata.force_available, true);
  assert.equal(conflicts.length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm.cmd test -- tests/unit/edits/edit-service.test.js
```

Expected: FAIL because current rollback overwrites dirty file.

- [ ] **Step 3: Implement conflict detection and rollback application helpers**

In `src/edits/edit-transaction.js`, add:

```js
export async function detectRollbackConflicts(projectRoot, record) {
  const conflicts = [];
  for (const file of record.files || []) {
    const current = await readCurrentFile(projectRoot, file);
    const expectedAfterHash = file.after_hash ?? (file.after == null ? null : hashContent(file.after).hash);
    if (current.hash !== expectedAfterHash) {
      conflicts.push({
        path: file.path,
        status: file.status,
        expected_after_hash: expectedAfterHash,
        current_hash: current.hash,
        reason: "dirty"
      });
    }
  }
  return conflicts;
}

export async function applyRollbackRecord(projectRoot, record) {
  const restored = [];
  for (const file of record.files || []) {
    const filePath = file.newPath === "/dev/null" ? file.oldPath : file.newPath;
    const resolved = await resolveWorkspacePath(projectRoot, filePath, { mustExist: false });
    if (file.status === "create") {
      await fs.rm(resolved.absolute, { force: true });
    } else {
      await fs.mkdir(path.dirname(resolved.absolute), { recursive: true });
      await fs.writeFile(resolved.absolute, file.before ?? "", "utf8");
    }
    restored.push(file.path);
  }
  return restored;
}

async function readCurrentFile(projectRoot, file) {
  const filePath = file.newPath === "/dev/null" ? file.oldPath : file.newPath;
  try {
    const resolved = await resolveWorkspacePath(projectRoot, filePath, { mustExist: true });
    const content = stripBom(await fs.readFile(resolved.real, "utf8"));
    return hashContent(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      return { hash: null, bytes: 0 };
    }
    throw error;
  }
}
```

- [ ] **Step 4: Modify rollback service to return conflict or success records**

Replace `src/edits/rollback-service.js` with:

```js
import { promises as fs } from "node:fs";
import path from "node:path";
import { describeChange } from "../changes.js";
import {
  applyRollbackRecord,
  detectRollbackConflicts
} from "./edit-transaction.js";

export function createRollbackService({ projectRoot } = {}) {
  if (!projectRoot) throw new Error("projectRoot is required");

  return {
    async rollback({ change_id = "latest", force = false } = {}) {
      const record = await describeChange(projectRoot, change_id || "latest");
      const conflicts = await detectRollbackConflicts(projectRoot, record);
      if (conflicts.length && !force) {
        return {
          status: "conflict",
          record,
          conflicts,
          restored_files: [],
          forced: false
        };
      }
      const restoredFiles = await applyRollbackRecord(projectRoot, record);
      const rollbackPath = path.join(projectRoot, ".deepseek-code", "rollbacks.jsonl");
      await fs.mkdir(path.dirname(rollbackPath), { recursive: true });
      await fs.appendFile(rollbackPath, `${JSON.stringify({
        time: new Date().toISOString(),
        id: record.id,
        forced: Boolean(force),
        conflicts
      })}\n`, "utf8");
      return {
        status: "success",
        record,
        conflicts,
        restored_files: restoredFiles,
        forced: Boolean(force)
      };
    }
  };
}
```

- [ ] **Step 5: Modify EditService.rollback to handle conflict result**

In `src/edits/edit-service.js`, replace `rollbackChangeRecord()` with:

```js
  async function rollbackChangeRecord({ change_id = "latest", force = false } = {}) {
    const outcome = await rollback.rollback({ change_id, force: Boolean(force) });
    const record = outcome.record;
    const files = record.summary.map((item) => item.path);
    if (outcome.status === "conflict") {
      publish("file:rollback_conflict", {
        change_id: record.id,
        files,
        conflicts: outcome.conflicts,
        force_available: true
      });
      return {
        status: "conflict",
        content: [{ type: "text", text: `Rollback blocked by dirty files for change ${record.id}` }],
        metadata: {
          change_id: record.id,
          conflicts: outcome.conflicts,
          force_available: true,
          files
        }
      };
    }
    publish("file:transaction_rolled_back", {
      change_id: record.id,
      files,
      restored_files: outcome.restored_files,
      forced: outcome.forced,
      conflicts: outcome.conflicts
    });
    publish("file:rollback_applied", {
      change_id: record.id,
      summary: record.summary,
      files,
      forced: outcome.forced,
      conflicts: outcome.conflicts
    });
    return {
      status: "success",
      content: [{ type: "text", text: `Rolled back change ${record.id}` }],
      metadata: {
        change_id: record.id,
        summary: record.summary,
        files,
        restored_files: outcome.restored_files,
        forced: outcome.forced,
        conflicts: outcome.conflicts
      }
    };
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run:

```powershell
npm.cmd test -- tests/unit/edits/edit-service.test.js tests/unit/edits/edit-transaction.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit Task 4**

Run:

```powershell
git add src/edits/edit-transaction.js src/edits/rollback-service.js src/edits/edit-service.js tests/unit/edits/edit-service.test.js tests/unit/edits/edit-transaction.test.js
git commit -m "feat(v2): block dirty rollback conflicts"
```

---

### Task 5: Force Rollback and Tool Schema

**Files:**
- Modify: `src/tools/builtin/edit-deferred.js`
- Test: `tests/unit/edits/edit-service.test.js`
- Test: `tests/integration/v2-edit-tools-kernel.test.js`

- [ ] **Step 1: Add failing force rollback unit test**

Append to `tests/unit/edits/edit-service.test.js`:

```js
test("force rollback overwrites dirty files and reports conflicts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-edit-service-force-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  const service = createEditService({ projectRoot: root });

  const applied = await service.apply({ diff: MODIFY_DIFF, prompt: "update a" });
  await writeFile(path.join(root, "a.txt"), "manual change\n");
  const result = await service.rollback({ change_id: applied.metadata.change_id, force: true });

  assert.equal(result.status, "success");
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "old\n");
  assert.equal(result.metadata.forced, true);
  assert.equal(result.metadata.conflicts.length, 1);
});
```

- [ ] **Step 2: Add failing kernel tool tests**

Append to `tests/integration/v2-edit-tools-kernel.test.js`:

```js
test("kernel diff_rollback blocks dirty file without force", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-kernel-edit-dirty-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  const kernel = await createKernel(root, {
    sessionId: "sess_edit_dirty",
    sessionLog: null,
    context: { disabled: true }
  });
  const applied = await kernel.tools.execute(
    createToolCall({ name: "edit", params: { diff: MODIFY_DIFF, prompt: "update a" }, requestedByStepId: "step_1" }),
    { autonomy: "gated", turnId: "turn_1" }
  );
  await writeFile(path.join(root, "a.txt"), "manual change\n");

  const rolledBack = await kernel.tools.execute(
    createToolCall({ name: "diff_rollback", params: { change_id: applied.metadata.change_id }, requestedByStepId: "step_2" }),
    { autonomy: "gated", turnId: "turn_1" }
  );

  assert.equal(rolledBack.status, "conflict");
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "manual change\n");
  assert.equal(rolledBack.metadata.conflicts.length, 1);
});

test("kernel diff_rollback force restores dirty file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-kernel-edit-force-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  const kernel = await createKernel(root, {
    sessionId: "sess_edit_force",
    sessionLog: null,
    context: { disabled: true }
  });
  const applied = await kernel.tools.execute(
    createToolCall({ name: "edit", params: { diff: MODIFY_DIFF, prompt: "update a" }, requestedByStepId: "step_1" }),
    { autonomy: "gated", turnId: "turn_1" }
  );
  await writeFile(path.join(root, "a.txt"), "manual change\n");

  const rolledBack = await kernel.tools.execute(
    createToolCall({
      name: "diff_rollback",
      params: { change_id: applied.metadata.change_id, force: true },
      requestedByStepId: "step_2"
    }),
    { autonomy: "gated", turnId: "turn_1" }
  );

  assert.equal(rolledBack.status, "success");
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "old\n");
  assert.equal(rolledBack.metadata.forced, true);
});
```

- [ ] **Step 3: Run tests to verify they fail or partially fail**

Run:

```powershell
npm.cmd test -- tests/unit/edits/edit-service.test.js tests/integration/v2-edit-tools-kernel.test.js
```

Expected: FAIL until `force` is accepted by tool schema.

- [ ] **Step 4: Add force param to diff_rollback schema**

In `src/tools/builtin/edit-deferred.js`, replace the `diff_rollback` params:

```js
    deferred("diff_rollback", "Rollback a previous change", "write_update", {
      change_id: { type: "string", required: false, default: "latest" },
      force: { type: "boolean", required: false, default: false }
    }, editService, "rollback"),
```

- [ ] **Step 5: Run tests to verify they pass**

Run:

```powershell
npm.cmd test -- tests/unit/edits/edit-service.test.js tests/integration/v2-edit-tools-kernel.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit Task 5**

Run:

```powershell
git add src/tools/builtin/edit-deferred.js tests/unit/edits/edit-service.test.js tests/integration/v2-edit-tools-kernel.test.js
git commit -m "feat(v2): support force rollback"
```

---

### Task 6: Event Types and Event Privacy

**Files:**
- Modify: `src/sessions/event-types.js`
- Test: `tests/unit/sessions/event-types.test.js`
- Test: `tests/unit/edits/edit-service.test.js`

- [ ] **Step 1: Add failing event type assertions**

In `tests/unit/sessions/event-types.test.js`, add these canonical event names near existing file events:

```js
    "file:transaction_started",
    "file:transaction_committed",
    "file:transaction_failed",
    "file:transaction_rolled_back",
    "file:rollback_conflict",
```

- [ ] **Step 2: Add failing event privacy test**

Append to `tests/unit/edits/edit-service.test.js`:

```js
test("transaction events do not include raw diff or file content", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-edit-service-event-privacy-"));
  await writeFile(path.join(root, "a.txt"), "old secret text\n");
  const eventBus = createEventBus();
  const events = [];
  for (const type of [
    "file:transaction_started",
    "file:transaction_committed",
    "file:transaction_failed",
    "file:transaction_rolled_back",
    "file:rollback_conflict",
    "file:diff_applied",
    "file:rollback_applied"
  ]) {
    eventBus.subscribe(type, (data) => events.push({ type, data }));
  }
  const service = createEditService({ projectRoot: root, eventBus });

  const applied = await service.apply({
    diff: "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old secret text\n+new secret text",
    prompt: "privacy"
  });
  await writeFile(path.join(root, "a.txt"), "manual secret text\n");
  await service.rollback({ change_id: applied.metadata.change_id });

  const raw = JSON.stringify(events);
  assert.equal(raw.includes("old secret text"), false);
  assert.equal(raw.includes("new secret text"), false);
  assert.equal(raw.includes("manual secret text"), false);
  assert.equal(raw.includes("@@ -1 +1 @@"), false);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```powershell
npm.cmd test -- tests/unit/sessions/event-types.test.js tests/unit/edits/edit-service.test.js
```

Expected: FAIL until event types are registered and committed event exists.

- [ ] **Step 4: Register event types**

In `src/sessions/event-types.js`, add:

```js
  "file:transaction_started",
  "file:transaction_committed",
  "file:transaction_failed",
  "file:transaction_rolled_back",
  "file:rollback_conflict",
```

near the other `file:*` events.

- [ ] **Step 5: Publish committed event in EditService.apply**

In `src/edits/edit-service.js`, after `const record = await store.finalize(plan, { transaction });` and before `file:diff_applied`, add:

```js
    publish("file:transaction_committed", {
      transaction_id: transaction.transaction_id,
      change_id: record.id,
      summary: record.summary,
      files: record.summary.map((item) => item.path),
      diff_hash: hashText(parsed.diff),
      diff_size: Buffer.byteLength(parsed.diff, "utf8")
    });
```

- [ ] **Step 6: Run tests to verify they pass**

Run:

```powershell
npm.cmd test -- tests/unit/sessions/event-types.test.js tests/unit/edits/edit-service.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit Task 6**

Run:

```powershell
git add src/sessions/event-types.js tests/unit/sessions/event-types.test.js src/edits/edit-service.js tests/unit/edits/edit-service.test.js
git commit -m "feat(v2): add safe edit transaction events"
```

---

### Task 7: Package Check and Full Regression

**Files:**
- Modify: `package.json`
- Test: full suite

- [ ] **Step 1: Add edit transaction module to syntax check**

In `package.json`, update the edits check segment from:

```json
"node --check src/edits/diff-parser.js src/edits/change-store.js src/edits/rollback-service.js src/edits/edit-service.js"
```

to:

```json
"node --check src/edits/diff-parser.js src/edits/change-store.js src/edits/rollback-service.js src/edits/edit-transaction.js src/edits/edit-service.js"
```

- [ ] **Step 2: Run focused V2-11 tests**

Run:

```powershell
npm.cmd test -- tests/unit/edits/edit-transaction.test.js tests/unit/edits/edit-service.test.js tests/integration/v2-edit-tools-kernel.test.js tests/unit/sessions/event-types.test.js
```

Expected: PASS.

- [ ] **Step 3: Run full test suite**

Run:

```powershell
npm.cmd test
```

Expected: all tests pass. Total test count should be greater than the V2-10 baseline of 427.

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

Expected: PASS. If warnings mention pre-existing user-local files, verify no V2-11 files are listed with whitespace errors.

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
git commit -m "chore(v2): include transactional edit checks"
```

---

## Final Review Checklist

- [ ] Multi-file apply failure restores earlier file writes.
- [ ] Apply failure does not publish `file:diff_applied`.
- [ ] Successful change records include `before_hash` and `after_hash`.
- [ ] Default rollback detects dirty files and writes nothing.
- [ ] Force rollback overwrites dirty files only when `force: true`.
- [ ] `diff_rollback(change_id)` remains backward compatible.
- [ ] Transaction and rollback events do not include raw diff or file content.
- [ ] Tool permission path still treats rollback as `write_update`.
- [ ] Full tests, syntax check, whitespace check, and pollution check pass.

## Execution Notes

Use one commit per task. If a test fails unexpectedly, diagnose the root cause before changing code. If review feedback arrives, verify it before applying it.
