# V2-3 Edit Service Implementation Plan

> 完成状态以 [CHANGELOG](../../CHANGELOG.md) 为准。


**Goal:** Make V2 edit tools real by wrapping the mature legacy unified diff, change record, and rollback pipeline behind a new `src/edits` service boundary.

**Architecture:** V2-3 preserves the legacy `src/patch.js` and `src/changes.js` behavior for the current V0 CLI while exposing a clean V2 `EditService` used by `diff_preview`, `diff_apply`, `diff_rollback`, and `edit`. All writes still flow through the V2 `ToolExecutor` and permission engine; the edit service owns diff normalization, path preflight, preview metadata, change records, rollback, and edit session events.

**Tech Stack:** Node.js >= 20, ESM, Node built-ins only, `node:test`, `node:assert/strict`, no new dependencies.

---

## Scope Boundary

Implement V2-3 from `docs/specs/architecture/2026-05-30-deepseek-code-v2-clean-runtime-design.md`:

- Create `src/edits/*` as the V2 edit domain boundary.
- Reuse, do not delete, these proven legacy functions:
  - `extractUnifiedDiff`
  - `parseUnifiedDiff`
  - `summarizeDiff`
  - `applyUnifiedDiff`
  - `captureChangePlan`
  - `finalizeChange`
  - `listChanges`
  - `describeChange`
  - `rollbackChange`
- Add V2 path preflight before legacy capture/apply/rollback paths run.
- Wire the edit service into `createKernel()` so default builtin edit tools work.
- Publish canonical edit events:
  - `file:diff_preview`
  - `file:diff_applied`
  - `file:rollback_applied`
- Keep complete diff text out of session events; return it only in tool metadata when needed.

Out of scope for V2-3:

- The full DeepSeek multi-round tool loop. V2-4 owns model tool-call feedback.
- CLI/TUI/GUI migration. V2-5 owns interfaces.
- Deleting or moving legacy `src/patch.js` and `src/changes.js`.
- A separate artifact store implementation. V2-3 records diff hash/size metadata and relies on the existing change record file.
- Semantic patch repair. V2-4 owns repair loops.

## Design Decisions

- **Wrap first, refactor later:** Keep V0 stable by leaving `src/patch.js` and `src/changes.js` in place. New V2 files import them.
- **Preflight before legacy writes:** Legacy path resolution is lexical. V2-3 must call `resolveWorkspacePath()` on every old/new diff path before `captureChangePlan()` and `applyUnifiedDiff()`. This preflight checks workspace boundaries with `mustExist:false`; legacy capture/apply remains responsible for reporting missing source files.
- **Tool result shape:** Edit service methods return the raw shape expected by `ToolExecutor`: `{ status?, content, metadata }`.
- **Preview is read-only:** `preview()` parses and validates paths but never writes files or creates change records.
- **Apply is atomic at service boundary only:** V2-3 does not implement transactional multi-file rollback on partial apply failure. It preflights first to reduce risk and lets V2-4 repair/report failures.
- **Rollback category:** `diff_rollback` remains `write_update`, not `destructive`, because it restores a recorded state rather than deleting arbitrary user data.

## File Structure

Create:

```text
src/edits/diff-parser.js
src/edits/change-store.js
src/edits/rollback-service.js
src/edits/edit-service.js
tests/unit/edits/diff-parser.test.js
tests/unit/edits/change-store.test.js
tests/unit/edits/edit-service.test.js
tests/integration/v2-edit-tools-kernel.test.js
```

Modify:

```text
src/index.js
src/sessions/event-types.js
src/tools/builtin/edit-deferred.js
tests/unit/sessions/event-types.test.js
tests/unit/tools/builtin-network-memory.test.js
package.json
```

Responsibility map:

- `src/edits/diff-parser.js`: normalize fenced/plain unified diffs, parse/summarize, and preflight diff paths through V2 workspace safety.
- `src/edits/change-store.js`: V2 wrapper for legacy change capture/finalize/list/describe.
- `src/edits/rollback-service.js`: V2 wrapper for legacy rollback.
- `src/edits/edit-service.js`: public edit service contract consumed by builtin tools.
- `src/tools/builtin/edit-deferred.js`: tool metadata and service dispatch only.
- `src/index.js`: composition root; creates default `EditService`.

---

### Task 1: Diff Parser and Path Preflight

**Files:**
- Create: `src/edits/diff-parser.js`
- Test: `tests/unit/edits/diff-parser.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/unit/edits/diff-parser.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  normalizeUnifiedDiff,
  parseDiff,
  formatDiffSummary,
  assertDiffPathsSafe
} from "../../../src/edits/diff-parser.js";

test("normalizeUnifiedDiff extracts fenced unified diff", () => {
  const diff = normalizeUnifiedDiff("```diff\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n```");
  assert.equal(diff, "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new");
});

test("parseDiff returns patches summary and files", () => {
  const parsed = parseDiff("--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new");

  assert.equal(parsed.patches.length, 1);
  assert.deepEqual(parsed.summary, [{ path: "a.txt", status: "modify" }]);
  assert.deepEqual(parsed.files, ["a.txt"]);
  assert.match(formatDiffSummary(parsed.summary), /modify a\.txt/);
});

test("parseDiff rejects empty or non-diff input", () => {
  assert.throws(() => normalizeUnifiedDiff("plain text"), /unified diff is required/);
  assert.throws(() => parseDiff(""), /unified diff is required/);
});

test("assertDiffPathsSafe rejects lexical traversal", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-edit-safe-"));
  const parsed = parseDiff("--- a/../outside.txt\n+++ b/../outside.txt\n@@ -1 +1 @@\n-old\n+new");

  await assert.rejects(
    () => assertDiffPathsSafe(root, parsed.patches),
    /escapes project root/
  );
});

test("assertDiffPathsSafe rejects symlink escape before legacy apply", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-edit-safe-"));
  const outside = await mkdtemp(path.join(tmpdir(), "dsc-edit-out-"));
  await writeFile(path.join(outside, "secret.txt"), "secret\n");
  await symlink(outside, path.join(root, "link"), "junction");
  const parsed = parseDiff("--- a/link/secret.txt\n+++ b/link/secret.txt\n@@ -1 +1 @@\n-secret\n+changed");

  await assert.rejects(
    () => assertDiffPathsSafe(root, parsed.patches),
    /escapes project root/
  );
});

test("assertDiffPathsSafe allows creating a new file under safe ancestor", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-edit-safe-"));
  await mkdir(path.join(root, "src"));
  const parsed = parseDiff("--- /dev/null\n+++ b/src/new.js\n@@ -0,0 +1 @@\n+console.log(1);");

  await assert.doesNotReject(() => assertDiffPathsSafe(root, parsed.patches));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm.cmd test -- tests/unit/edits/diff-parser.test.js
```

Expected:

```text
ERR_MODULE_NOT_FOUND
```

- [ ] **Step 3: Implement `src/edits/diff-parser.js`**

```js
// src/edits/diff-parser.js
import {
  extractUnifiedDiff,
  parseUnifiedDiff,
  summarizeDiff
} from "../patch.js";
import { resolveWorkspacePath } from "../workspace/path-safety.js";

export function normalizeUnifiedDiff(input) {
  const raw = typeof input === "string" ? input : "";
  const extracted = extractUnifiedDiff(raw);
  const diff = (extracted || raw).trimEnd();
  if (!diff || (!diff.includes("--- ") && !diff.includes("diff --git "))) {
    throw new Error("unified diff is required");
  }
  return diff;
}

export function parseDiff(input) {
  const diff = normalizeUnifiedDiff(input);
  const patches = parseUnifiedDiff(diff);
  if (!patches.length) {
    throw new Error("unified diff contains no file patches");
  }
  const summary = summarizeDiff(diff);
  return {
    diff,
    patches,
    summary,
    files: summary.map((item) => item.path)
  };
}

export async function assertDiffPathsSafe(projectRoot, patches) {
  if (!projectRoot) throw new Error("projectRoot is required");
  for (const patch of patches) {
    if (patch.oldPath && patch.oldPath !== "/dev/null") {
      await resolveWorkspacePath(projectRoot, patch.oldPath, { mustExist: false });
    }
    if (patch.newPath && patch.newPath !== "/dev/null") {
      await resolveWorkspacePath(projectRoot, patch.newPath, { mustExist: false });
    }
  }
}

export function formatDiffSummary(summary) {
  if (!summary.length) return "No file changes.";
  return summary.map((item) => `${item.status} ${item.path}`).join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
npm.cmd test -- tests/unit/edits/diff-parser.test.js
```

Expected:

```text
# fail 0
```

- [ ] **Step 5: Commit**

```powershell
git add src/edits/diff-parser.js tests/unit/edits/diff-parser.test.js
git commit -m "feat(v2): add edit diff parser"
```

---

### Task 2: Change Store and Rollback Wrappers

**Files:**
- Create: `src/edits/change-store.js`
- Create: `src/edits/rollback-service.js`
- Test: `tests/unit/edits/change-store.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/unit/edits/change-store.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyUnifiedDiff } from "../../../src/patch.js";
import { createChangeStore } from "../../../src/edits/change-store.js";
import { createRollbackService } from "../../../src/edits/rollback-service.js";

const MODIFY_DIFF = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new";

test("change store captures finalizes lists and describes legacy change records", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-change-store-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  const store = createChangeStore({ projectRoot: root });

  const plan = await store.capture({ diff: MODIFY_DIFF, prompt: "update a" });
  await applyUnifiedDiff(MODIFY_DIFF, root);
  const record = await store.finalize(plan);
  const list = await store.list({ limit: 5 });
  const described = await store.describe({ change_id: record.id });

  assert.equal(record.prompt, "update a");
  assert.equal(record.summary[0].path, "a.txt");
  assert.equal(record.files[0].before, "old\n");
  assert.equal(record.files[0].after, "new\n");
  assert.equal(list[0].id, record.id);
  assert.equal(described.id, record.id);
});

test("rollback service restores a finalized change record", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-change-store-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  const store = createChangeStore({ projectRoot: root });
  const rollback = createRollbackService({ projectRoot: root });

  const plan = await store.capture({ diff: MODIFY_DIFF, prompt: "update a" });
  await applyUnifiedDiff(MODIFY_DIFF, root);
  const record = await store.finalize(plan);
  const rolledBack = await rollback.rollback({ change_id: record.id });

  assert.equal(rolledBack.id, record.id);
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "old\n");
});

test("change store requires projectRoot", () => {
  assert.throws(() => createChangeStore(), /projectRoot is required/);
  assert.throws(() => createRollbackService(), /projectRoot is required/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm.cmd test -- tests/unit/edits/change-store.test.js
```

Expected:

```text
ERR_MODULE_NOT_FOUND
```

- [ ] **Step 3: Implement wrappers**

```js
// src/edits/change-store.js
import {
  captureChangePlan,
  finalizeChange,
  listChanges,
  describeChange
} from "../changes.js";

export function createChangeStore({ projectRoot } = {}) {
  if (!projectRoot) throw new Error("projectRoot is required");

  return {
    capture({ diff, prompt = "" } = {}) {
      return captureChangePlan(projectRoot, diff, prompt);
    },
    finalize(plan) {
      return finalizeChange(projectRoot, plan);
    },
    list({ limit = 20 } = {}) {
      return listChanges(projectRoot, limit);
    },
    describe({ change_id = "latest" } = {}) {
      return describeChange(projectRoot, change_id || "latest");
    }
  };
}
```

```js
// src/edits/rollback-service.js
import { rollbackChange } from "../changes.js";

export function createRollbackService({ projectRoot } = {}) {
  if (!projectRoot) throw new Error("projectRoot is required");

  return {
    rollback({ change_id = "latest" } = {}) {
      return rollbackChange(projectRoot, change_id || "latest");
    }
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
npm.cmd test -- tests/unit/edits/change-store.test.js
```

Expected:

```text
# fail 0
```

- [ ] **Step 5: Commit**

```powershell
git add src/edits/change-store.js src/edits/rollback-service.js tests/unit/edits/change-store.test.js
git commit -m "feat(v2): wrap legacy change store"
```

---

### Task 3: Edit Service Core

**Files:**
- Create: `src/edits/edit-service.js`
- Test: `tests/unit/edits/edit-service.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/unit/edits/edit-service.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEventBus } from "../../../src/shared/event-bus.js";
import { createEditService } from "../../../src/edits/edit-service.js";

const MODIFY_DIFF = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new";

test("preview parses validates and does not write files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-edit-service-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  const service = createEditService({ projectRoot: root });

  const result = await service.preview({ diff: MODIFY_DIFF });

  assert.equal(result.status, "success");
  assert.match(result.content[0].text, /modify a\.txt/);
  assert.equal(result.metadata.summary[0].path, "a.txt");
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "old\n");
});

test("apply writes files finalizes change and publishes event without raw diff", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-edit-service-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  const eventBus = createEventBus();
  const events = [];
  eventBus.subscribe("file:diff_applied", (data) => events.push(data));
  const service = createEditService({ projectRoot: root, eventBus });

  const result = await service.apply({ diff: MODIFY_DIFF, prompt: "update a", approval_id: "appr_1" });

  assert.equal(result.status, "success");
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "new\n");
  assert.match(result.metadata.change_id, /^\d{14}$/);
  assert.equal(result.metadata.approval_id, "appr_1");
  assert.equal(events.length, 1);
  assert.equal(events[0].change_id, result.metadata.change_id);
  assert.equal(events[0].diff, undefined);
});

test("rollback restores change and publishes rollback event", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-edit-service-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  const eventBus = createEventBus();
  const rollbacks = [];
  eventBus.subscribe("file:rollback_applied", (data) => rollbacks.push(data));
  const service = createEditService({ projectRoot: root, eventBus });

  const applied = await service.apply({ diff: MODIFY_DIFF, prompt: "update a" });
  const rolledBack = await service.rollback({ change_id: applied.metadata.change_id });

  assert.equal(rolledBack.status, "success");
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "old\n");
  assert.equal(rollbacks.length, 1);
  assert.equal(rollbacks[0].change_id, applied.metadata.change_id);
});

test("apply rejects unsafe diff before writing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-edit-service-"));
  const service = createEditService({ projectRoot: root });
  const diff = "--- a/../outside.txt\n+++ b/../outside.txt\n@@ -1 +1 @@\n-old\n+new";

  await assert.rejects(() => service.apply({ diff, prompt: "escape" }), /escapes project root/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm.cmd test -- tests/unit/edits/edit-service.test.js
```

Expected:

```text
ERR_MODULE_NOT_FOUND
```

- [ ] **Step 3: Implement `src/edits/edit-service.js`**

```js
// src/edits/edit-service.js
import { createHash } from "node:crypto";
import { applyUnifiedDiff } from "../patch.js";
import {
  assertDiffPathsSafe,
  formatDiffSummary,
  parseDiff
} from "./diff-parser.js";
import { createChangeStore } from "./change-store.js";
import { createRollbackService } from "./rollback-service.js";

export function createEditService({ projectRoot, eventBus = null, changeStore = null, rollbackService = null } = {}) {
  if (!projectRoot) throw new Error("projectRoot is required");

  const store = changeStore || createChangeStore({ projectRoot });
  const rollback = rollbackService || createRollbackService({ projectRoot });

  async function preview({ diff } = {}) {
    const parsed = parseDiff(diff);
    await assertDiffPathsSafe(projectRoot, parsed.patches);
    const metadata = previewMetadata(parsed);
    publish("file:diff_preview", {
      summary: parsed.summary,
      files: parsed.files,
      diff_hash: metadata.diff_hash,
      diff_size: metadata.diff_size
    });
    return {
      status: "success",
      content: [{ type: "text", text: formatDiffSummary(parsed.summary) }],
      metadata
    };
  }

  async function apply({ diff, prompt = "", approval_id = null } = {}) {
    const parsed = parseDiff(diff);
    await assertDiffPathsSafe(projectRoot, parsed.patches);
    const plan = await store.capture({ diff: parsed.diff, prompt });
    await applyUnifiedDiff(parsed.diff, projectRoot);
    const record = await store.finalize(plan);
    const metadata = {
      change_id: record.id,
      approval_id,
      summary: record.summary,
      files: record.summary.map((item) => item.path),
      diff_hash: hashText(parsed.diff),
      diff_size: Buffer.byteLength(parsed.diff, "utf8"),
      change_record_path: `.deepseek-code/changes/${record.id}.json`
    };
    publish("file:diff_applied", {
      change_id: record.id,
      approval_id,
      summary: record.summary,
      files: metadata.files,
      diff_hash: metadata.diff_hash,
      diff_size: metadata.diff_size
    });
    return {
      status: "success",
      content: [{ type: "text", text: `Applied change ${record.id}\n${formatDiffSummary(record.summary)}` }],
      metadata
    };
  }

  async function rollbackChangeRecord({ change_id = "latest" } = {}) {
    const record = await rollback.rollback({ change_id });
    const files = record.summary.map((item) => item.path);
    publish("file:rollback_applied", {
      change_id: record.id,
      summary: record.summary,
      files
    });
    return {
      status: "success",
      content: [{ type: "text", text: `Rolled back change ${record.id}` }],
      metadata: {
        change_id: record.id,
        summary: record.summary,
        files
      }
    };
  }

  async function describe({ change_id = "latest" } = {}) {
    const record = await store.describe({ change_id });
    return {
      status: "success",
      content: [{ type: "text", text: `Change ${record.id}\n${formatDiffSummary(record.summary)}` }],
      metadata: {
        change_id: record.id,
        prompt: record.prompt,
        time: record.time,
        summary: record.summary,
        files: record.summary.map((item) => item.path)
      }
    };
  }

  async function list({ limit = 20 } = {}) {
    const records = await store.list({ limit });
    return {
      status: "success",
      content: [{ type: "text", text: records.map((record) => `${record.id} ${record.prompt}`).join("\n") }],
      metadata: {
        changes: records.map((record) => ({
          change_id: record.id,
          prompt: record.prompt,
          time: record.time,
          summary: record.summary
        }))
      }
    };
  }

  function publish(type, data) {
    eventBus?.publish?.(type, data);
  }

  return { preview, apply, rollback: rollbackChangeRecord, describe, list };
}

function previewMetadata(parsed) {
  return {
    summary: parsed.summary,
    files: parsed.files,
    patch_count: parsed.patches.length,
    diff_hash: hashText(parsed.diff),
    diff_size: Buffer.byteLength(parsed.diff, "utf8")
  };
}

function hashText(text) {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
npm.cmd test -- tests/unit/edits/edit-service.test.js
```

Expected:

```text
# fail 0
```

- [ ] **Step 5: Commit**

```powershell
git add src/edits/edit-service.js tests/unit/edits/edit-service.test.js
git commit -m "feat(v2): add edit service"
```

---

### Task 4: Session Event Registry and Edit Tool Metadata

**Files:**
- Modify: `src/sessions/event-types.js`
- Modify: `src/tools/builtin/edit-deferred.js`
- Modify: `tests/unit/sessions/event-types.test.js`
- Modify: `tests/unit/tools/builtin-network-memory.test.js`

- [ ] **Step 1: Update tests first**

In `tests/unit/sessions/event-types.test.js`, ensure the canonical event test includes rollback:

```js
assert.ok(SESSION_EVENT_TYPES.includes("file:diff_preview"));
assert.ok(SESSION_EVENT_TYPES.includes("file:diff_applied"));
assert.ok(SESSION_EVENT_TYPES.includes("file:rollback_applied"));
```

In `tests/unit/tools/builtin-network-memory.test.js`, replace the deferred edit test with:

```js
test("deferred edit tools dispatch to configured editService", async () => {
  const calls = [];
  const editService = {
    preview: async (params) => {
      calls.push(["preview", params]);
      return { content: [{ type: "text", text: "previewed" }], metadata: { ok: true } };
    },
    apply: async (params) => {
      calls.push(["apply", params]);
      return { content: [{ type: "text", text: "applied" }], metadata: { ok: true } };
    },
    rollback: async (params) => {
      calls.push(["rollback", params]);
      return { content: [{ type: "text", text: "rolled back" }], metadata: { ok: true } };
    }
  };

  const [preview, apply, rollback, edit] = createDeferredEditTools({ editService });
  assert.equal((await preview.execute({ diff: "d" }, {})).content[0].text, "previewed");
  assert.equal((await apply.execute({ diff: "d", prompt: "p", approval_id: "a" }, {})).content[0].text, "applied");
  assert.equal((await rollback.execute({ change_id: "c" }, {})).content[0].text, "rolled back");
  assert.equal((await edit.execute({ diff: "d", prompt: "p" }, {})).content[0].text, "applied");

  assert.deepEqual(calls.map(([name]) => name), ["preview", "apply", "rollback", "apply"]);
});

test("deferred edit tools fail clearly without editService", async () => {
  const [preview] = createDeferredEditTools();
  await assert.rejects(
    () => preview.execute({ diff: "--- a\n" }, {}),
    /Edit service is not configured/
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
npm.cmd test -- tests/unit/sessions/event-types.test.js tests/unit/tools/builtin-network-memory.test.js
```

Expected:

```text
At least one assertion fails because file:rollback_applied is missing or tool params do not match.
```

- [ ] **Step 3: Modify `src/sessions/event-types.js`**

Add `"file:rollback_applied"` immediately after `"file:diff_applied"`:

```js
  "file:diff_preview",
  "file:diff_applied",
  "file:rollback_applied",
  "verification:result",
```

- [ ] **Step 4: Replace `src/tools/builtin/edit-deferred.js`**

```js
// src/tools/builtin/edit-deferred.js
export function createDeferredEditTools({ editService = null } = {}) {
  return [
    deferred("diff_preview", "Preview a unified diff without writing files", "read", {
      diff: { type: "string" }
    }, editService, "preview"),
    deferred("diff_apply", "Apply an approved unified diff", "write_update", {
      diff: { type: "string" },
      prompt: { type: "string", required: false, default: "" },
      approval_id: { type: "string", required: false, default: "" }
    }, editService, "apply"),
    deferred("diff_rollback", "Rollback a previous change", "write_update", {
      change_id: { type: "string", required: false, default: "latest" }
    }, editService, "rollback"),
    deferred("edit", "Apply a unified diff through the edit service", "write_update", {
      diff: { type: "string" },
      prompt: { type: "string", required: false, default: "" },
      approval_id: { type: "string", required: false, default: "" }
    }, editService, "apply")
  ];
}

function deferred(name, description, category, params, editService, method) {
  return {
    name,
    description,
    category,
    side_effect: category === "read" ? "none" : "filesystem",
    risk_level: category === "read" ? "low" : "medium",
    source: "builtin",
    version: "2.0",
    params,
    execute: async (toolParams) => {
      if (!editService) throw new Error("Edit service is not configured");
      if (typeof editService[method] !== "function") {
        throw new Error(`Edit service method is not configured: ${method}`);
      }
      return editService[method](toolParams);
    }
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run:

```powershell
npm.cmd test -- tests/unit/sessions/event-types.test.js tests/unit/tools/builtin-network-memory.test.js
```

Expected:

```text
# fail 0
```

- [ ] **Step 6: Commit**

```powershell
git add src/sessions/event-types.js src/tools/builtin/edit-deferred.js tests/unit/sessions/event-types.test.js tests/unit/tools/builtin-network-memory.test.js
git commit -m "feat(v2): register edit events and tool metadata"
```

---

### Task 5: Kernel Integration for Edit Tools

**Files:**
- Modify: `src/index.js`
- Test: `tests/integration/v2-edit-tools-kernel.test.js`

- [ ] **Step 1: Write the failing integration test**

```js
// tests/integration/v2-edit-tools-kernel.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createKernel } from "../../src/index.js";
import { createToolCall } from "../../src/core/protocol/index.js";

const MODIFY_DIFF = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new";

test("kernel diff_preview parses diff without modifying files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-kernel-edit-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  const kernel = await createKernel(root, { sessionId: "sess_edit_preview" });

  const result = await kernel.tools.execute(
    createToolCall({ name: "diff_preview", params: { diff: MODIFY_DIFF }, requestedByStepId: "step_1" }),
    { autonomy: "gated", turnId: "turn_1" }
  );

  assert.equal(result.status, "success");
  assert.match(result.content[0].text, /modify a\.txt/);
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "old\n");
});

test("kernel diff_apply writes a file and emits edit events", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-kernel-edit-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  const kernel = await createKernel(root, { sessionId: "sess_edit_apply" });
  const events = [];
  const sub = kernel.session.subscribe((event) => events.push(event));

  const result = await kernel.tools.execute(
    createToolCall({
      name: "diff_apply",
      params: { diff: MODIFY_DIFF, prompt: "update a", approval_id: "appr_1" },
      requestedByStepId: "step_1"
    }),
    { autonomy: "gated", turnId: "turn_1" }
  );
  sub.unsubscribe();

  assert.equal(result.status, "success");
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "new\n");
  assert.match(result.metadata.change_id, /^\d{14}$/);
  assert.ok(events.some((event) => event.type === "tool:call"));
  assert.ok(events.some((event) => event.type === "file:diff_applied"));
  assert.ok(events.some((event) => event.type === "tool:result"));
});

test("kernel diff_rollback restores an applied change", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-kernel-edit-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  const kernel = await createKernel(root, { sessionId: "sess_edit_rollback" });

  const applied = await kernel.tools.execute(
    createToolCall({ name: "edit", params: { diff: MODIFY_DIFF, prompt: "update a" }, requestedByStepId: "step_1" }),
    { autonomy: "gated", turnId: "turn_1" }
  );
  const rolledBack = await kernel.tools.execute(
    createToolCall({ name: "diff_rollback", params: { change_id: applied.metadata.change_id }, requestedByStepId: "step_2" }),
    { autonomy: "gated", turnId: "turn_1" }
  );

  assert.equal(rolledBack.status, "success");
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "old\n");
});

test("kernel edit tool returns approval_required under supervised autonomy", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-kernel-edit-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  const kernel = await createKernel(root, { sessionId: "sess_edit_approval" });

  const result = await kernel.tools.execute(
    createToolCall({ name: "diff_apply", params: { diff: MODIFY_DIFF }, requestedByStepId: "step_1" }),
    { autonomy: "supervised", turnId: "turn_1" }
  );

  assert.equal(result.status, "approval_required");
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "old\n");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm.cmd test -- tests/integration/v2-edit-tools-kernel.test.js
```

Expected:

```text
The first edit execution fails with "Edit service is not configured".
```

- [ ] **Step 3: Modify `src/index.js`**

Add the import:

```js
import { createEditService } from "./edits/edit-service.js";
```

Create the default service before builtin tools are created:

```js
  const editService = options.editService || createEditService({
    projectRoot: root,
    eventBus
  });
```

Pass the service into builtins:

```js
  const toolRegistry = options.toolRegistry || createToolRegistry({
    tools: createBuiltinTools({
      editService,
      webFetch: options.webFetch || {}
    })
  });
```

The resulting top section of `createKernel()` must read:

```js
export async function createKernel(root, options = {}) {
  const eventBus = options.eventBus || createEventBus();
  const sessionId = options.sessionId || `sess_${Date.now()}`;
  const modelGateway = resolveModelGateway(options);
  const approvalCache = options.approvalCache || createApprovalCache();
  const permissionEngine = options.permissionEngine || createPermissionEngine();
  const editService = options.editService || createEditService({
    projectRoot: root,
    eventBus
  });
  const toolRegistry = options.toolRegistry || createToolRegistry({
    tools: createBuiltinTools({
      editService,
      webFetch: options.webFetch || {}
    })
  });
  const toolExecutor = options.toolExecutor || createToolExecutor({
    registry: toolRegistry,
    permissionEngine,
    eventBus
  });
  const runtime = createAgentRuntime({ eventBus, sessionId, modelGateway });
```

- [ ] **Step 4: Run integration test to verify it passes**

Run:

```powershell
npm.cmd test -- tests/integration/v2-edit-tools-kernel.test.js tests/integration/v2-tool-plane-kernel.test.js
```

Expected:

```text
# fail 0
```

- [ ] **Step 5: Commit**

```powershell
git add src/index.js tests/integration/v2-edit-tools-kernel.test.js
git commit -m "feat(v2): wire edit service into kernel"
```

---

### Task 6: Package Check and Full Regression

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Update `package.json` check script**

Append the new edit files to the existing V2 check segment:

```text
src/edits/diff-parser.js src/edits/change-store.js src/edits/rollback-service.js src/edits/edit-service.js
```

Keep the command style as one `node --check ...` chain matching the current `package.json`.

- [ ] **Step 2: Run all V2-3 targeted tests**

Run:

```powershell
npm.cmd test -- tests/unit/edits/diff-parser.test.js tests/unit/edits/change-store.test.js tests/unit/edits/edit-service.test.js tests/unit/sessions/event-types.test.js tests/unit/tools/builtin-network-memory.test.js tests/integration/v2-edit-tools-kernel.test.js
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

The test count must be greater than 245 because V2-3 adds edit service tests.

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
git commit -m "chore(v2): include edit service checks"
```

---

## Acceptance Criteria

V2-3 is complete only when all items are true:

- `createEditService({ projectRoot })` exposes `preview`, `apply`, `rollback`, `describe`, and `list`.
- `preview()` parses fenced or plain unified diffs and does not write files.
- `apply()` validates every old/new diff path through V2 workspace safety before legacy capture/apply runs.
- Diff path preflight uses `mustExist:false` so boundary violations are rejected consistently before missing-file errors.
- `apply()` writes files through the mature legacy `applyUnifiedDiff()` path.
- `apply()` finalizes a legacy change record under `.deepseek-code/changes/<change_id>.json`.
- `rollback()` restores a recorded change id.
- `diff_preview`, `diff_apply`, `diff_rollback`, and `edit` work through `kernel.tools.execute()`.
- `diff_apply` and `edit` still pass through ToolExecutor permission decisions.
- Supervised autonomy returns `approval_required` for write edit tools and does not write files.
- Gated autonomy can apply update diffs.
- Path traversal and symlink escape diffs are rejected before any write.
- Edit events are published:
  - `file:diff_preview`
  - `file:diff_applied`
  - `file:rollback_applied`
- Edit events do not include raw diff text.
- `npm.cmd test` passes.
- `npm.cmd run check` passes.
- `git diff --check` passes.

## Review Checklist

Before reporting completion:

- Inspect `src/edits/edit-service.js` and confirm `assertDiffPathsSafe()` runs before `capture()` and `applyUnifiedDiff()`.
- Inspect `src/index.js` and confirm a default `EditService` is created when `options.editService` is absent.
- Inspect `src/tools/builtin/edit-deferred.js` and confirm it dispatches to configured service methods rather than returning the old V2-2 placeholder error.
- Inspect `src/sessions/event-types.js` and confirm `file:rollback_applied` is registered.
- Run a manual kernel edit smoke test if full tests pass but behavior is suspicious:

```powershell
node --input-type=module -e "import { mkdtemp, writeFile, readFile } from 'node:fs/promises'; import { tmpdir } from 'node:os'; import path from 'node:path'; import { createKernel } from './src/index.js'; import { createToolCall } from './src/core/protocol/index.js'; const root=await mkdtemp(path.join(tmpdir(),'dsc-edit-smoke-')); await writeFile(path.join(root,'a.txt'),'old\n'); const k=await createKernel(root,{sessionId:'sess_smoke'}); const diff='--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new'; const r=await k.tools.execute(createToolCall({name:'edit',params:{diff,prompt:'smoke'},requestedByStepId:'s'}),{autonomy:'gated',turnId:'t'}); console.log(JSON.stringify({status:r.status, change_id:r.metadata.change_id, file:await readFile(path.join(root,'a.txt'),'utf8')}));"
```

Expected manual output includes:

```text
"status":"success"
"file":"new\n"
```

## Commit Order

Use this order:

1. `feat(v2): add edit diff parser`
2. `feat(v2): wrap legacy change store`
3. `feat(v2): add edit service`
4. `feat(v2): register edit events and tool metadata`
5. `feat(v2): wire edit service into kernel`
6. `chore(v2): include edit service checks`

## Handoff Notes

- Use `npm.cmd` on Windows PowerShell.
- Keep unrelated dirty files untouched.
- Do not modify `src/patch.js` or `src/changes.js` behavior unless a failing V2-3 test proves a wrapper cannot protect it.
- Do not delete legacy V0 files.
- Do not connect the model runtime loop in this phase.
- Do not add dependencies.
- Keep raw diffs out of session events; tool metadata may include hashes, sizes, summaries, file lists, and change ids.
