# V2-10 Context Cache & Usage Telemetry Implementation Plan

> 完成状态以 [CHANGELOG](../../CHANGELOG.md) 为准。


**Goal:** Add metadata-only context caching, incremental workspace scans, stable context snapshot hydration, and real DeepSeek usage telemetry exposed through the V2 kernel.

**Architecture:** Keep V2-9 public context APIs intact while splitting indexed records into metadata-only manifest records and memory-only hydrated units. Add a context manifest/cache layer under `src/context/`, wire cache stats and usage stats through `kernel.metrics`, and update GUI/TUI consumers to read the metrics facade.

**Tech Stack:** Node.js >=20 ESM, built-in `node:test`, existing V2 context engine, workspace path-safety helpers, DeepSeek usage tracker, Electron CommonJS host, no new dependencies.

---

## File Structure

Create:

- `src/context/context-manifest.js`
  Loads and saves metadata-only context manifests with atomic writes and corrupt-file tolerance.
- `src/context/context-cache.js`
  Performs manifest-backed incremental scans, reuses unchanged metadata, safely reads changed files, and hydrates snippets lazily.
- `tests/unit/context/context-manifest.test.js`
- `tests/unit/context/context-cache.test.js`
- `tests/integration/v2-context-cache-kernel.test.js`
- `tests/integration/v2-usage-metrics.test.js`

Modify:

- `src/context/workspace-indexer.js`
  Export skip helpers and metadata-building helpers needed by the cache layer.
- `src/context/context-unit.js`
  Add helpers to build metadata-only records and hydrate selected records.
- `src/context/context-snapshot.js`
  Keep snapshot shape stable and include cache stats passed from the engine.
- `src/context/index.js`
  Use `scanContextWithCache()` by default, hydrate selected records at snapshot time, publish cache events, and expose richer stats.
- `src/index.js`
  Add `kernel.metrics.getUsage()`, `kernel.metrics.getContext()`, and `kernel.metrics.getSnapshot()`.
- `src/sessions/event-types.js`
  Register `context:cache_loaded`, `context:cache_saved`, and `context:cache_reused`.
- `gui/kernel-host.js`
  Prefer `kernel.metrics.getUsage()` over private gateway access and zero fallback.
- `src/tui.js`
  Render token/cache fields from `kernel.metrics.getUsage()` when available.
- Existing tests:
  - `tests/unit/context/context-engine.test.js`
  - `tests/unit/context/workspace-indexer.test.js`
  - `tests/integration/v2-context-kernel.test.js`
  - `tests/unit/gui/kernel-host.test.js`
  - `tests/unit/sessions/event-types.test.js`
- `package.json`
  Add new context modules to `npm run check`.

Do not modify V0/V1 legacy context files:

- `src/context.js`
- `src/kernel/context-engine.js`

Do not stage unrelated local files:

- `.claude/settings.local.json`
- `.deepseek-code/chat.json`
- `.tmp-memory-test/`
- `docs/plans/roadmap/2026-05-30-phase-4-gui.md`
- `docs/plans/roadmap/2026-05-30-phase-5-polish.md`
- `gui/node_modules/`
- `gui/package-lock.json`

---

### Task 1: Context Manifest

**Files:**
- Create: `src/context/context-manifest.js`
- Test: `tests/unit/context/context-manifest.test.js`

- [ ] **Step 1: Write failing manifest tests**

Create `tests/unit/context/context-manifest.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createEmptyManifest,
  loadContextManifest,
  saveContextManifest,
  sanitizeManifestRecord,
  projectRootHash
} from "../../../src/context/context-manifest.js";

test("createEmptyManifest creates schema v1 metadata container", () => {
  const manifest = createEmptyManifest({ root: "/repo", now: "2026-05-31T00:00:00.000Z" });

  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.project_root_hash, projectRootHash("/repo"));
  assert.equal(manifest.created_at, "2026-05-31T00:00:00.000Z");
  assert.deepEqual(manifest.files, {});
});

test("sanitizeManifestRecord strips snippets content and absolute fields", () => {
  const record = sanitizeManifestRecord({
    path: "src/index.js",
    hash: "sha256:abc",
    bytes: 10,
    token_count: 3,
    priority: 2,
    reason: "source",
    mtime_ms: 123,
    size: 10,
    indexed_at: "2026-05-31T00:00:00.000Z",
    snippet: "secret code",
    content: "secret code",
    absolute: "C:/repo/src/index.js"
  });

  assert.deepEqual(Object.keys(record).sort(), [
    "bytes",
    "hash",
    "indexed_at",
    "mtime_ms",
    "path",
    "priority",
    "reason",
    "size",
    "token_count"
  ]);
  assert.equal(JSON.stringify(record).includes("secret code"), false);
  assert.equal(JSON.stringify(record).includes("C:/repo"), false);
});

test("saveContextManifest writes metadata-only json and loadContextManifest reads it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-manifest-"));
  const manifestPath = path.join(root, "context", "manifest.json");
  const manifest = createEmptyManifest({ root, now: "2026-05-31T00:00:00.000Z" });
  manifest.files["src/index.js"] = sanitizeManifestRecord({
    path: "src/index.js",
    hash: "sha256:abc",
    bytes: 10,
    token_count: 3,
    priority: 2,
    reason: "source",
    mtime_ms: 123,
    size: 10,
    indexed_at: "2026-05-31T00:00:00.000Z",
    snippet: "must not persist"
  });

  await saveContextManifest({ manifestPath, manifest });
  const raw = await readFile(manifestPath, "utf8");
  const loaded = await loadContextManifest({ manifestPath, root });

  assert.equal(raw.includes("must not persist"), false);
  assert.equal(loaded.files["src/index.js"].hash, "sha256:abc");
});

test("loadContextManifest tolerates missing corrupt and root-mismatched manifests", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-manifest-corrupt-"));
  const manifestPath = path.join(root, "manifest.json");

  assert.deepEqual((await loadContextManifest({ manifestPath, root })).files, {});

  await writeFile(manifestPath, "{bad json");
  assert.deepEqual((await loadContextManifest({ manifestPath, root })).files, {});

  await writeFile(manifestPath, JSON.stringify({
    schema_version: 1,
    project_root_hash: projectRootHash("/other"),
    files: { "a.txt": { path: "a.txt" } }
  }));
  assert.deepEqual((await loadContextManifest({ manifestPath, root })).files, {});
});
```

- [ ] **Step 2: Run manifest tests to verify they fail**

Run:

```powershell
npm.cmd test -- tests/unit/context/context-manifest.test.js
```

Expected: FAIL with module-not-found for `src/context/context-manifest.js`.

- [ ] **Step 3: Implement context manifest**

Create `src/context/context-manifest.js`:

```js
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { nowIso } from "../shared/time.js";

export const CONTEXT_MANIFEST_SCHEMA_VERSION = 1;

const RECORD_KEYS = [
  "path",
  "hash",
  "bytes",
  "token_count",
  "priority",
  "reason",
  "mtime_ms",
  "size",
  "indexed_at",
  "policy_version"
];

export function projectRootHash(root) {
  return `sha256:${createHash("sha256").update(path.resolve(root)).digest("hex")}`;
}

export function createEmptyManifest({ root, now = nowIso() } = {}) {
  if (!root) throw new Error("root is required");
  return {
    schema_version: CONTEXT_MANIFEST_SCHEMA_VERSION,
    project_root_hash: projectRootHash(root),
    created_at: now,
    updated_at: now,
    files: {},
    stats: {
      indexed_files: 0,
      skipped_files: 0,
      reused_files: 0,
      changed_files: 0
    }
  };
}

export async function loadContextManifest({ manifestPath, root } = {}) {
  if (!manifestPath) throw new Error("manifestPath is required");
  if (!root) throw new Error("root is required");
  try {
    const raw = await fs.readFile(manifestPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed.schema_version !== CONTEXT_MANIFEST_SCHEMA_VERSION) return createEmptyManifest({ root });
    if (parsed.project_root_hash !== projectRootHash(root)) return createEmptyManifest({ root });
    const manifest = createEmptyManifest({ root, now: parsed.created_at || nowIso() });
    manifest.updated_at = parsed.updated_at || manifest.created_at;
    manifest.stats = { ...manifest.stats, ...(parsed.stats || {}) };
    for (const [recordPath, record] of Object.entries(parsed.files || {})) {
      const safe = sanitizeManifestRecord({ ...record, path: record.path || recordPath });
      if (safe.path) manifest.files[safe.path] = safe;
    }
    return manifest;
  } catch {
    return createEmptyManifest({ root });
  }
}

export async function saveContextManifest({ manifestPath, manifest } = {}) {
  if (!manifestPath) throw new Error("manifestPath is required");
  if (!manifest) throw new Error("manifest is required");
  const clean = sanitizeManifest(manifest);
  clean.updated_at = nowIso();
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  const tempPath = `${manifestPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(clean, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, manifestPath);
  return clean;
}

export function sanitizeManifest(manifest) {
  const clean = {
    schema_version: CONTEXT_MANIFEST_SCHEMA_VERSION,
    project_root_hash: manifest.project_root_hash,
    created_at: manifest.created_at || nowIso(),
    updated_at: manifest.updated_at || nowIso(),
    files: {},
    stats: { ...(manifest.stats || {}) }
  };
  for (const [recordPath, record] of Object.entries(manifest.files || {})) {
    const safe = sanitizeManifestRecord({ ...record, path: record.path || recordPath });
    if (safe.path) clean.files[safe.path] = safe;
  }
  return clean;
}

export function sanitizeManifestRecord(record = {}) {
  const clean = {};
  for (const key of RECORD_KEYS) {
    if (record[key] !== undefined) clean[key] = record[key];
  }
  return clean;
}
```

- [ ] **Step 4: Run manifest tests to verify they pass**

Run:

```powershell
npm.cmd test -- tests/unit/context/context-manifest.test.js
```

Expected: PASS for 4 tests.

- [ ] **Step 5: Commit Task 1**

Run:

```powershell
git add src/context/context-manifest.js tests/unit/context/context-manifest.test.js
git commit -m "feat(v2): add context manifest"
```

---

### Task 2: Context Cache Scan

**Files:**
- Create: `src/context/context-cache.js`
- Modify: `src/context/context-unit.js`
- Modify: `src/context/workspace-indexer.js`
- Test: `tests/unit/context/context-cache.test.js`
- Test: `tests/unit/context/workspace-indexer.test.js`

- [ ] **Step 1: Write failing context cache tests**

Create `tests/unit/context/context-cache.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  hydrateContextRecords,
  scanContextWithCache
} from "../../../src/context/context-cache.js";

test("scanContextWithCache saves metadata-only manifest and reuses unchanged files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-context-cache-"));
  const cacheRoot = path.join(root, ".cache");
  await writeFile(path.join(root, "README.md"), "# demo\n");
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "index.js"), "export const demo = true;\n");

  const first = await scanContextWithCache({ root, options: { cacheRoot } });
  const second = await scanContextWithCache({ root, options: { cacheRoot } });
  const raw = await readFile(path.join(cacheRoot, "manifest.json"), "utf8");

  assert.equal(first.stats.changed_files, 2);
  assert.equal(first.stats.reused_files, 0);
  assert.equal(second.stats.changed_files, 0);
  assert.equal(second.stats.reused_files, 2);
  assert.equal(raw.includes("export const demo"), false);
  assert.equal(raw.includes("snippet"), false);
});

test("scanContextWithCache re-reads modified files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-context-cache-change-"));
  const cacheRoot = path.join(root, ".cache");
  await writeFile(path.join(root, "README.md"), "# demo\n");
  const first = await scanContextWithCache({ root, options: { cacheRoot } });

  await new Promise((resolve) => setTimeout(resolve, 10));
  await writeFile(path.join(root, "README.md"), "# changed\n");
  const second = await scanContextWithCache({ root, options: { cacheRoot } });

  assert.notEqual(second.records.get("README.md").hash, first.records.get("README.md").hash);
  assert.equal(second.stats.changed_files, 1);
});

test("scanContextWithCache does not persist hidden config or credential files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-context-cache-secret-"));
  const cacheRoot = path.join(root, ".cache");
  await writeFile(path.join(root, "README.md"), "# demo\n");
  await mkdir(path.join(root, ".claude"), { recursive: true });
  await writeFile(path.join(root, ".claude", "settings.local.json"), "{\"allow\":[\"secret\"]}");
  await writeFile(path.join(root, ".npmrc"), "//registry/:_authToken=secret\n");

  const result = await scanContextWithCache({ root, options: { cacheRoot } });
  const raw = await readFile(path.join(cacheRoot, "manifest.json"), "utf8");

  assert.ok(result.records.has("README.md"));
  assert.equal(result.records.has(".claude/settings.local.json"), false);
  assert.equal(result.records.has(".npmrc"), false);
  assert.equal(raw.includes("_authToken"), false);
});

test("hydrateContextRecords reads snippets lazily and skips unreadable selected files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-context-hydrate-"));
  await writeFile(path.join(root, "README.md"), "# demo\n");
  const scanned = await scanContextWithCache({ root, options: { persistent: false } });
  const missing = { ...scanned.records.get("README.md"), path: "missing.md" };

  const result = await hydrateContextRecords({
    root,
    records: [scanned.records.get("README.md"), missing],
    options: { maxFileBytes: 1024, maxSnippetBytes: 10 }
  });

  assert.equal(result.units.length, 1);
  assert.equal(result.units[0].path, "README.md");
  assert.equal(result.units[0].snippet, "# demo\n");
  assert.equal(result.stats.hydrate_skipped_files, 1);
});
```

- [ ] **Step 2: Run context cache tests to verify they fail**

Run:

```powershell
npm.cmd test -- tests/unit/context/context-cache.test.js
```

Expected: FAIL with module-not-found for `src/context/context-cache.js`.

- [ ] **Step 3: Add metadata helpers to context-unit**

Modify `src/context/context-unit.js`. Add exports after `createContextUnit()`:

```js
export function createContextRecord({
  path,
  content,
  stat = {},
  reason = null,
  priority = null,
  maxSnippetBytes = 4000,
  now = nowIso(),
  policyVersion = "v2-10"
} = {}) {
  const unit = createContextUnit({ path, content, reason, priority, maxSnippetBytes, now });
  const { snippet, ...record } = unit;
  return {
    ...record,
    mtime_ms: stat.mtimeMs ?? stat.mtime_ms ?? 0,
    size: stat.size ?? record.bytes,
    indexed_at: now,
    policy_version: policyVersion
  };
}

export function hydrateContextUnit(record, content, { maxSnippetBytes = 4000, now = nowIso() } = {}) {
  return {
    ...record,
    bytes: Buffer.byteLength(content),
    token_count: estimateTokens(clipSnippet(content, maxSnippetBytes)),
    snippet: clipSnippet(content, maxSnippetBytes),
    updated_at: now
  };
}
```

Then update `clipSnippet()` so `maxChars <= 0` returns an empty string:

```js
export function clipSnippet(text, maxChars = 4000) {
  const value = String(text || "");
  if (maxChars <= 0) return "";
  return value.length > maxChars ? value.slice(0, maxChars) : value;
}
```

- [ ] **Step 4: Export skip reason from workspace indexer**

Modify `src/context/workspace-indexer.js`:

```js
export function contextSkipReason(inputPath) {
  return skipReason(inputPath);
}
```

Keep `shouldSkipContextPath()` unchanged:

```js
export function shouldSkipContextPath(inputPath) {
  return Boolean(skipReason(inputPath));
}
```

- [ ] **Step 5: Implement context cache scan and hydration**

Create `src/context/context-cache.js`:

```js
import { promises as fs } from "node:fs";
import path from "node:path";
import { nowIso } from "../shared/time.js";
import {
  normalizeRelativePath,
  readWorkspaceTextFile,
  resolveWorkspacePath,
  walkWorkspaceFiles
} from "../workspace/path-safety.js";
import { createContextRecord, hydrateContextUnit } from "./context-unit.js";
import { contextSkipReason } from "./workspace-indexer.js";
import {
  createEmptyManifest,
  loadContextManifest,
  sanitizeManifestRecord,
  saveContextManifest
} from "./context-manifest.js";

const DEFAULT_OPTIONS = Object.freeze({
  persistent: true,
  manifestName: "manifest.json",
  maxFiles: 1000,
  maxFileBytes: 64 * 1024,
  maxSnippetBytes: 4000,
  policyVersion: "v2-10"
});

export async function scanContextWithCache({ root, options = {}, eventBus = null } = {}) {
  if (!root) throw new Error("root is required");
  const started = Date.now();
  const settings = normalizeCacheOptions(root, options);
  const manifestPath = path.join(settings.cacheRoot, settings.manifestName);
  const manifest = settings.persistent
    ? await loadContextManifest({ manifestPath, root })
    : createEmptyManifest({ root });
  const records = new Map();
  const stats = {
    scanned_files: 0,
    indexed_files: 0,
    skipped_files: 0,
    reused_files: 0,
    changed_files: 0,
    skipped_reasons: {},
    manifest_loaded: settings.persistent,
    manifest_saved: false,
    scan_duration_ms: 0
  };

  if (settings.persistent) {
    eventBus?.publish?.("context:cache_loaded", { files: Object.keys(manifest.files || {}).length });
  }

  const files = await walkWorkspaceFiles(root, ".", { maxFiles: settings.maxFiles });
  for (const file of files) {
    stats.scanned_files += 1;
    const skip = contextSkipReason(file);
    if (skip) {
      recordSkip(stats, skip);
      continue;
    }

    try {
      const stat = await statWorkspaceFile(root, file);
      const previous = manifest.files?.[normalizeRelativePath(file)];
      if (canReuseRecord(previous, stat, settings.policyVersion)) {
        records.set(previous.path, previous);
        stats.reused_files += 1;
        stats.indexed_files += 1;
        continue;
      }

      const text = await readWorkspaceTextFile(root, file, { maxBytes: settings.maxFileBytes });
      const record = sanitizeManifestRecord(createContextRecord({
        path: text.path,
        content: text.content,
        stat,
        maxSnippetBytes: settings.maxSnippetBytes,
        now: nowIso(),
        policyVersion: settings.policyVersion
      }));
      records.set(record.path, record);
      stats.changed_files += 1;
      stats.indexed_files += 1;
    } catch (error) {
      recordSkip(stats, classifyReadError(error));
    }
  }

  stats.scan_duration_ms = Date.now() - started;
  if (settings.persistent) {
    const nextManifest = createEmptyManifest({ root });
    nextManifest.files = Object.fromEntries(records);
    nextManifest.stats = {
      indexed_files: stats.indexed_files,
      skipped_files: stats.skipped_files,
      reused_files: stats.reused_files,
      changed_files: stats.changed_files
    };
    await saveContextManifest({ manifestPath, manifest: nextManifest });
    stats.manifest_saved = true;
    eventBus?.publish?.("context:cache_saved", {
      files: records.size,
      reused_files: stats.reused_files,
      changed_files: stats.changed_files,
      skipped_files: stats.skipped_files,
      duration_ms: stats.scan_duration_ms
    });
    if (stats.reused_files > 0) {
      eventBus?.publish?.("context:cache_reused", {
        files: records.size,
        reused_files: stats.reused_files,
        changed_files: stats.changed_files,
        duration_ms: stats.scan_duration_ms
      });
    }
  }

  return { records, stats, manifestPath: settings.persistent ? manifestPath : null };
}

export async function hydrateContextRecords({ root, records = [], options = {} } = {}) {
  const settings = { ...DEFAULT_OPTIONS, ...options };
  const units = [];
  const stats = { hydrated_files: 0, hydrate_skipped_files: 0 };
  for (const record of records) {
    try {
      const text = await readWorkspaceTextFile(root, record.path, { maxBytes: settings.maxFileBytes });
      units.push(hydrateContextUnit(record, text.content, { maxSnippetBytes: settings.maxSnippetBytes }));
      stats.hydrated_files += 1;
    } catch {
      stats.hydrate_skipped_files += 1;
    }
  }
  return { units, stats };
}

export function normalizeCacheOptions(root, options = {}) {
  const settings = { ...DEFAULT_OPTIONS, ...options };
  return {
    ...settings,
    cacheRoot: settings.cacheRoot || path.join(root, ".deepseek-code", "v2", "context")
  };
}

function canReuseRecord(record, stat, policyVersion) {
  return Boolean(
    record &&
    record.size === stat.size &&
    record.mtime_ms === stat.mtimeMs &&
    record.policy_version === policyVersion
  );
}

async function statWorkspaceFile(root, file) {
  const resolved = await resolveWorkspacePath(root, file, { mustExist: true });
  const stat = await fs.stat(resolved.real);
  return { size: stat.size, mtimeMs: stat.mtimeMs };
}

function classifyReadError(error) {
  const message = String(error?.message || "");
  if (message.includes("binary file refused")) return "binary";
  if (message.includes("file too large")) return "too-large";
  if (message.includes("path escapes project root")) return "path-escape";
  return "unreadable";
}

function recordSkip(stats, reason) {
  stats.skipped_files += 1;
  stats.skipped_reasons[reason] = (stats.skipped_reasons[reason] || 0) + 1;
}
```

- [ ] **Step 6: Run Task 2 tests to verify they pass**

Run:

```powershell
npm.cmd test -- tests/unit/context/context-cache.test.js tests/unit/context/workspace-indexer.test.js tests/unit/context/context-unit.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit Task 2**

Run:

```powershell
git add src/context/context-cache.js src/context/context-unit.js src/context/workspace-indexer.js tests/unit/context/context-cache.test.js tests/unit/context/workspace-indexer.test.js
git commit -m "feat(v2): add manifest-backed context cache"
```

---

### Task 3: Context Engine Lazy Hydration

**Files:**
- Modify: `src/context/index.js`
- Modify: `src/context/context-snapshot.js`
- Test: `tests/unit/context/context-engine.test.js`
- Test: `tests/unit/context/context-snapshot.test.js`

- [ ] **Step 1: Add failing engine cache tests**

Append to `tests/unit/context/context-engine.test.js`:

```js
test("context engine reuses manifest metadata and hydrates snippets lazily", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-context-engine-cache-"));
  const cacheRoot = path.join(root, ".context-cache");
  await writeFile(path.join(root, "README.md"), "# demo\n");
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "index.js"), "export const demo = true;\n");

  const first = createContextEngine({ root, options: { cacheRoot, budgets: { act: 1000 } } });
  await first.scan();
  const second = createContextEngine({ root, options: { cacheRoot, budgets: { act: 1000 } } });
  const stats = await second.scan();
  const snapshot = await second.snapshot({
    message: "modify src/index.js",
    classification: { task_type: "edit" },
    channel: "act"
  });

  assert.ok(stats.reused_files >= 2);
  assert.ok(snapshot.summary.includes("export const demo"));
  assert.equal(snapshot.stats.hydrated_files > 0, true);
});

test("context engine cache events do not contain snippets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-context-cache-events-"));
  await writeFile(path.join(root, "README.md"), "# secret text must stay out of events\n");
  const bus = createEventBus();
  const events = [];
  for (const type of ["context:cache_loaded", "context:cache_saved", "context:cache_reused"]) {
    bus.subscribe(type, (event) => events.push({ type, event }));
  }

  const engine = createContextEngine({
    root,
    eventBus: bus,
    options: { cacheRoot: path.join(root, ".context-cache") }
  });
  await engine.scan();
  await engine.scan();

  const raw = JSON.stringify(events);
  assert.ok(events.some((entry) => entry.type === "context:cache_saved"));
  assert.equal(raw.includes("secret text"), false);
  assert.equal(raw.includes("Relevant snippets"), false);
});
```

- [ ] **Step 2: Run engine tests to verify they fail**

Run:

```powershell
npm.cmd test -- tests/unit/context/context-engine.test.js
```

Expected: FAIL because `createContextEngine()` still uses full in-memory units and does not expose cache reuse/hydration stats.

- [ ] **Step 3: Modify context engine to use cache records and lazy hydration**

Modify `src/context/index.js` imports:

```js
import { hydrateContextRecords, scanContextWithCache } from "./context-cache.js";
```

Replace:

```js
let units = new Map();
let stats = { indexed_files: 0, skipped_files: 0 };
```

with:

```js
let records = new Map();
let stats = { indexed_files: 0, skipped_files: 0, reused_files: 0, changed_files: 0 };
```

Replace `scan()`:

```js
async function scan() {
  if (disabled) return getStats();
  const scanned = await scanContextWithCache({ root, options, eventBus });
  records = scanned.records;
  stats = scanned.stats;
  return getStats();
}
```

In `snapshot()`, replace `units` references:

```js
if (records.size === 0) await scan();
```

Call selector with records:

```js
const selected = selectContextUnits({
  units: records,
  message: input.message || "",
  pinned,
  warmed,
  classification: input.classification || {},
  budget: channelBudget.allocated
});
const hydrated = await hydrateContextRecords({
  root,
  records: selected.selected,
  options
});
const snap = buildContextSnapshot({
  root,
  channel: channelBudget.channel,
  taskType: input.classification?.task_type || "general",
  selected: hydrated.units,
  budget: {
    ...selected.budget,
    used: hydrated.units.reduce((sum, unit) => sum + unit.token_count, 0),
    remaining: Math.max(0, selected.budget.allocated - hydrated.units.reduce((sum, unit) => sum + unit.token_count, 0))
  },
  stats: { ...stats, ...hydrated.stats }
});
```

Update `invalidate()`:

```js
records.delete(relative);
```

Update `getStats()`:

```js
indexed_paths: records.size
```

- [ ] **Step 4: Update context snapshot stats**

Modify `src/context/context-snapshot.js` stats object:

```js
stats: {
  indexed_files: stats.indexed_files || 0,
  skipped_files: stats.skipped_files || 0,
  reused_files: stats.reused_files || 0,
  changed_files: stats.changed_files || 0,
  hydrated_files: stats.hydrated_files || 0,
  hydrate_skipped_files: stats.hydrate_skipped_files || 0,
  selected_files: units.length
}
```

- [ ] **Step 5: Run context engine tests to verify they pass**

Run:

```powershell
npm.cmd test -- tests/unit/context/context-engine.test.js tests/unit/context/context-snapshot.test.js tests/unit/context/context-selector.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit Task 3**

Run:

```powershell
git add src/context/index.js src/context/context-snapshot.js tests/unit/context/context-engine.test.js tests/unit/context/context-snapshot.test.js
git commit -m "feat(v2): hydrate context snapshots lazily"
```

---

### Task 4: Kernel Integration and Context Cache Events

**Files:**
- Modify: `src/index.js`
- Modify: `src/sessions/event-types.js`
- Test: `tests/integration/v2-context-cache-kernel.test.js`
- Test: `tests/unit/sessions/event-types.test.js`

- [ ] **Step 1: Add failing event type assertions**

Modify `tests/unit/sessions/event-types.test.js`. Add these to the canonical event list after `context:warm`:

```js
    "context:cache_loaded",
    "context:cache_saved",
    "context:cache_reused",
```

- [ ] **Step 2: Run session event test to verify it fails**

Run:

```powershell
npm.cmd test -- tests/unit/sessions/event-types.test.js
```

Expected: FAIL because cache events are not registered.

- [ ] **Step 3: Register cache event types**

Modify `src/sessions/event-types.js`. Add:

```js
  "context:cache_loaded",
  "context:cache_saved",
  "context:cache_reused",
```

after `"context:warm"`.

- [ ] **Step 4: Add failing kernel cache integration tests**

Create `tests/integration/v2-context-cache-kernel.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createKernel } from "../../src/index.js";

test("kernel context cache writes manifest only under injected cache root", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-kernel-cache-"));
  const cacheRoot = path.join(root, ".context-cache");
  await writeFile(path.join(root, "README.md"), "# demo\n");
  const kernel = await createKernel(root, {
    sessionRoot: path.join(root, ".sessions"),
    context: { cacheRoot },
    modelGateway: { reply: async () => ({ content: "ok" }) }
  });

  const stats = kernel.context.getStats();
  const raw = await readFile(path.join(cacheRoot, "manifest.json"), "utf8");

  assert.equal(stats.indexed_paths, 1);
  assert.equal(raw.includes("# demo"), false);
  assert.equal(raw.includes("snippet"), false);
});

test("kernel context cache reuses unchanged records after reopen", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-kernel-cache-reopen-"));
  const cacheRoot = path.join(root, ".context-cache");
  await writeFile(path.join(root, "README.md"), "# demo\n");
  await createKernel(root, {
    sessionRoot: path.join(root, ".sessions-a"),
    context: { cacheRoot },
    modelGateway: { reply: async () => ({ content: "ok" }) }
  });
  const second = await createKernel(root, {
    sessionRoot: path.join(root, ".sessions-b"),
    context: { cacheRoot },
    modelGateway: { reply: async () => ({ content: "ok" }) }
  });

  assert.equal(second.context.getStats().reused_files, 1);
});

test("kernel context cache timeline persists safe cache events", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-kernel-cache-events-"));
  const cacheRoot = path.join(root, ".context-cache");
  await writeFile(path.join(root, "README.md"), "# event content must not persist\n");
  const kernel = await createKernel(root, {
    sessionRoot: path.join(root, ".sessions"),
    context: { cacheRoot },
    modelGateway: { reply: async () => ({ content: "ok" }) }
  });
  await kernel.context.snapshot({ channel: "reply", classification: { task_type: "query" } });
  await kernel.session.flush();
  const timeline = await kernel.session.getTimeline(50);
  const cacheEvents = timeline.filter((event) => event.type.startsWith("context:cache_"));

  assert.ok(cacheEvents.some((event) => event.type === "context:cache_saved"));
  assert.equal(JSON.stringify(cacheEvents).includes("event content"), false);
});
```

- [ ] **Step 5: Run kernel cache tests to verify they fail**

Run:

```powershell
npm.cmd test -- tests/unit/sessions/event-types.test.js tests/integration/v2-context-cache-kernel.test.js
```

Expected: FAIL until event types and context cache integration are complete.

- [ ] **Step 6: Ensure createKernel passes context options and exposes metrics facade**

`src/index.js` already passes `options.context` to `createContextEngine()`. Add `metrics` after the `tools` facade:

```js
  const metrics = {
    getUsage() {
      return modelGateway?.getUsageStats?.() || zeroUsage();
    },
    getContext() {
      return contextEngine.getStats();
    },
    getSnapshot(input = {}) {
      return contextEngine.snapshot(input);
    }
  };
```

Add `metrics` to the returned kernel object:

```js
    metrics,
```

Add this helper near the bottom of `src/index.js`:

```js
function zeroUsage() {
  return {
    requests: 0,
    total_prompt_tokens: 0,
    total_completion_tokens: 0,
    total_reasoning_tokens: 0,
    total_tokens: 0,
    cache_hit_tokens: 0,
    cache_miss_tokens: 0,
    cache_hit_rate: 0,
    avg_latency_ms: 0,
    by_channel: {},
    by_model: {}
  };
}
```

- [ ] **Step 7: Run kernel cache integration tests to verify they pass**

Run:

```powershell
npm.cmd test -- tests/unit/sessions/event-types.test.js tests/integration/v2-context-cache-kernel.test.js tests/integration/v2-context-kernel.test.js
```

Expected: PASS.

- [ ] **Step 8: Commit Task 4**

Run:

```powershell
git add src/index.js src/sessions/event-types.js tests/unit/sessions/event-types.test.js tests/integration/v2-context-cache-kernel.test.js
git commit -m "feat(v2): expose context cache through kernel"
```

---

### Task 5: Usage Metrics Facade

**Files:**
- Modify: `src/index.js`
- Modify: `gui/kernel-host.js`
- Test: `tests/integration/v2-usage-metrics.test.js`
- Test: `tests/unit/gui/kernel-host.test.js`

- [ ] **Step 1: Write failing usage metrics integration tests**

Create `tests/integration/v2-usage-metrics.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createKernel } from "../../src/index.js";

test("kernel metrics exposes real DeepSeek usage stats", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-usage-metrics-"));
  await writeFile(path.join(root, "README.md"), "# demo\n");
  const usage = {
    requests: 1,
    total_prompt_tokens: 100,
    total_completion_tokens: 20,
    total_reasoning_tokens: 5,
    total_tokens: 120,
    cache_hit_tokens: 40,
    cache_miss_tokens: 60,
    cache_hit_rate: 0.4,
    avg_latency_ms: 33,
    by_channel: { act: { requests: 1, prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } },
    by_model: {}
  };
  const kernel = await createKernel(root, {
    sessionRoot: path.join(root, ".sessions"),
    context: { cacheRoot: path.join(root, ".context-cache") },
    modelGateway: {
      getUsageStats: () => usage,
      reply: async () => ({ content: "ok" })
    }
  });

  assert.deepEqual(kernel.metrics.getUsage(), usage);
  assert.equal(kernel.metrics.getContext().indexed_paths, 1);
  const snapshot = await kernel.metrics.getSnapshot({ channel: "reply", classification: { task_type: "query" } });
  assert.ok(snapshot.summary.includes("README.md"));
});

test("kernel metrics returns zero usage when gateway has no stats", async () => {
  const kernel = await createKernel(process.cwd(), {
    sessionLog: null,
    context: { disabled: true },
    modelGateway: { reply: async () => ({ content: "ok" }) }
  });

  assert.equal(kernel.metrics.getUsage().cache_hit_rate, 0);
  assert.equal(kernel.metrics.getUsage().requests, 0);
});
```

- [ ] **Step 2: Run usage metrics tests to verify they fail**

Run:

```powershell
npm.cmd test -- tests/integration/v2-usage-metrics.test.js
```

Expected: FAIL if `kernel.metrics` is not exposed yet.

- [ ] **Step 3: Add GUI host metrics test**

Append to `tests/unit/gui/kernel-host.test.js`:

```js
test("kernel host getUsage prefers kernel metrics facade", async () => {
  const usage = {
    requests: 1,
    total_prompt_tokens: 10,
    total_completion_tokens: 2,
    total_reasoning_tokens: 0,
    total_tokens: 12,
    cache_hit_tokens: 7,
    cache_miss_tokens: 3,
    cache_hit_rate: 0.7,
    avg_latency_ms: 5,
    by_channel: {},
    by_model: {}
  };
  const host = createKernelHost({
    projectRoot: "/repo",
    kernelFactory: async () => ({
      session: { subscribe: () => ({ unsubscribe() {} }), getTimeline: async () => [] },
      agent: { send: async () => ({ status: "complete" }), approve: () => {}, interrupt: () => {} },
      context: { snapshot: async () => ({ units: [] }) },
      metrics: { getUsage: () => usage },
      config: { getPublicConfig: () => ({ runtime: "v2" }) },
      runtime: { getState: () => ({ current: "idle", channel: null }) }
    })
  });

  await host.init();

  assert.deepEqual(host.getUsage(), usage);
});
```

- [ ] **Step 4: Modify GUI host usage lookup**

In `gui/kernel-host.js`, replace `getUsage()`:

```js
function getUsage() {
  return kernel?.metrics?.getUsage?.() || kernel?.modelGateway?.getUsageStats?.() || zeroUsage();
}
```

- [ ] **Step 5: Run usage tests to verify they pass**

Run:

```powershell
npm.cmd test -- tests/integration/v2-usage-metrics.test.js tests/unit/gui/kernel-host.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit Task 5**

Run:

```powershell
git add src/index.js gui/kernel-host.js tests/integration/v2-usage-metrics.test.js tests/unit/gui/kernel-host.test.js
git commit -m "feat(v2): expose usage telemetry metrics"
```

---

### Task 6: TUI Metrics Display

**Files:**
- Modify: `src/tui.js`
- Test: `tests/unit/apps/tui-metrics.test.js`

- [ ] **Step 1: Export and test TUI status rendering**

Create `tests/unit/apps/tui-metrics.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { renderTuiStatusLine } from "../../../src/tui.js";

test("renderTuiStatusLine includes usage cache metrics when available", () => {
  const line = renderTuiStatusLine({
    runtime: { getState: () => ({ current: "idle", channel: "act" }) },
    config: { getPublicConfig: () => ({ runtime: "v2" }) },
    metrics: {
      getUsage: () => ({
        total_tokens: 1234,
        cache_hit_rate: 0.4567,
        cache_hit_tokens: 400,
        cache_miss_tokens: 476
      })
    }
  });

  assert.ok(line.includes("idle"));
  assert.ok(line.includes("act"));
  assert.ok(line.includes("tokens:1234"));
  assert.ok(line.includes("cache:45.7%"));
});

test("renderTuiStatusLine falls back to zero usage", () => {
  const line = renderTuiStatusLine({
    runtime: { getState: () => ({ current: "idle", channel: null }) },
    config: { getPublicConfig: () => ({ runtime: "v2" }) }
  });

  assert.ok(line.includes("tokens:0"));
  assert.ok(line.includes("cache:0.0%"));
});
```

- [ ] **Step 2: Run TUI metrics test to verify it fails**

Run:

```powershell
npm.cmd test -- tests/unit/apps/tui-metrics.test.js
```

Expected: FAIL because `renderTuiStatusLine` is not exported.

- [ ] **Step 3: Export TUI status renderer and include metrics**

In `src/tui.js`, rename:

```js
function renderStatusLine(kernel) {
```

to:

```js
export function renderTuiStatusLine(kernel) {
```

Add usage lookup after `publicConfig`:

```js
  const usage = kernel.metrics?.getUsage?.() || {
    total_tokens: 0,
    cache_hit_rate: 0,
    cache_hit_tokens: 0,
    cache_miss_tokens: 0
  };
  const cachePercent = `${((usage.cache_hit_rate || 0) * 100).toFixed(1)}%`;
```

Add parts before final separator:

```js
    color.dim("|"),
    ` tokens:${usage.total_tokens || 0} `,
    color.dim("|"),
    ` cache:${cachePercent} `,
```

Update the render call:

```js
console.log(renderTuiStatusLine(kernel));
```

- [ ] **Step 4: Run TUI metrics test to verify it passes**

Run:

```powershell
npm.cmd test -- tests/unit/apps/tui-metrics.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit Task 6**

Run:

```powershell
git add src/tui.js tests/unit/apps/tui-metrics.test.js
git commit -m "feat(v2): show usage metrics in tui"
```

---

### Task 7: Package Check and Full Regression

**Files:**
- Modify: `package.json`
- Modify: existing tests that call `createKernel(process.cwd(), ...)` without `context.disabled`

- [ ] **Step 1: Update package check script**

In `package.json`, add the new context files to the context `node --check` segment:

```text
src/context/context-manifest.js src/context/context-cache.js
```

The context check segment should include:

```text
node --check src/context/context-unit.js src/context/token-budget.js src/context/workspace-indexer.js src/context/context-selector.js src/context/context-snapshot.js src/context/context-manifest.js src/context/context-cache.js src/context/index.js
```

- [ ] **Step 2: Prevent repository context-cache pollution in existing tests**

Search for tests that create a kernel with `process.cwd()` and no explicit context option:

```powershell
rg -n "createKernel\\(process\\.cwd\\(\\)" tests
```

For every match that does not need real context cache persistence, add:

```js
context: { disabled: true },
```

The known V2-9-era examples should include:

```js
const kernel = await createKernel(process.cwd(), {
  sessionLog: null,
  context: { disabled: true },
  modelGateway: {
    reply: async () => ({ content: "query answer" }),
    invoke: async () => {
      invokeCalled = true;
      return { content: "tool path" };
    }
  }
});
```

Do not change tests that already use a temporary `root` and pass `context: { cacheRoot: path.join(root, ".context-cache") }`.

- [ ] **Step 3: Run focused V2-10 tests**

Run:

```powershell
npm.cmd test -- tests/unit/context/context-manifest.test.js tests/unit/context/context-cache.test.js tests/unit/context/context-engine.test.js tests/integration/v2-context-cache-kernel.test.js tests/integration/v2-usage-metrics.test.js tests/unit/gui/kernel-host.test.js tests/unit/apps/tui-metrics.test.js
```

Expected: PASS.

- [ ] **Step 4: Run full test suite**

Run:

```powershell
npm.cmd test
```

Expected: all tests pass. Total test count should be greater than the V2-9 baseline of 406.

- [ ] **Step 5: Run syntax check**

Run:

```powershell
npm.cmd run check
```

Expected: PASS with no `SyntaxError`.

- [ ] **Step 6: Run whitespace check**

Run:

```powershell
git diff --check
```

Expected: PASS. If warnings mention pre-existing user-local files, verify no V2-10 files are listed with whitespace errors.

- [ ] **Step 7: Run pollution check**

Run:

```powershell
if (Test-Path -LiteralPath ".deepseek-code\v2") { throw ".deepseek-code/v2 should not be created by tests" } else { "no v2 session pollution" }
```

Expected: `no v2 session pollution`.

- [ ] **Step 8: Commit Task 7**

Run:

```powershell
git add package.json tests
git commit -m "chore(v2): include context cache checks"
```

---

## Final Review Checklist

- [ ] Manifest files contain no `snippet`, `content`, raw source code, API keys, or absolute paths.
- [ ] Unchanged files are reused on second scan.
- [ ] Modified files are re-read and update manifest metadata.
- [ ] Snapshot summary still contains bounded snippets for selected files.
- [ ] Hidden IDE/tool config dirs and credential-like files are absent from manifest and snapshots.
- [ ] `kernel.metrics.getUsage()` returns gateway usage stats when available.
- [ ] `gui/kernel-host.js` reads usage through `kernel.metrics`.
- [ ] `src/tui.js` can render token/cache metrics without throwing when metrics are missing.
- [ ] Cache events are registered and contain only counts/durations.
- [ ] Full tests, syntax check, whitespace check, and pollution check pass.

## Execution Notes

Use one commit per task. If any verification fails, diagnose the root cause before changing code. If review feedback arrives, verify it before applying it.
