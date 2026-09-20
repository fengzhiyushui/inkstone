# V2-9 Context Engine Implementation Plan

> 完成状态以 [CHANGELOG](../../CHANGELOG.md) 为准。


**Goal:** Replace the V2 empty context facade with a safe, deterministic, budgeted project context engine that feeds DeepSeek before query, tool-loop, and repair calls.

**Architecture:** Add a focused `src/context/` service that indexes workspace text files through existing V2 path-safety helpers, ranks units by stable prefix, pins, message mentions, and task type, then assembles compact cache-aware snapshots. Wire the engine into `createKernel()` and inject snapshots into `createAgentRuntime()` so runtime code stays filesystem-agnostic.

**Tech Stack:** Node.js >=20 ESM, built-in `node:test`, existing V2 workspace safety helpers, runtime executor loop, repair loop, SessionManager, no new dependencies.

---

## File Structure

Create:

- `src/context/context-unit.js`
  Builds deterministic `ContextUnit` records, estimates tokens, assigns base priority, clips snippets, and hashes file content.
- `src/context/token-budget.js`
  Normalizes channel budgets and selects units without exceeding the token budget.
- `src/context/workspace-indexer.js`
  Walks the workspace through `walkWorkspaceFiles()` and reads safe text files through `readWorkspaceTextFile()`.
- `src/context/context-selector.js`
  Promotes stable prefix files, pinned files, message-mentioned files, warmed files, and task companions into deterministic assembly order.
- `src/context/context-snapshot.js`
  Converts selected units into the public snapshot shape and compact `summary` string consumed by DeepSeek prompts.
- `src/context/index.js`
  Exposes `createContextEngine({ root, eventBus, options })` with `scan()`, `snapshot()`, `pin()`, `unpin()`, `warm()`, `invalidate()`, and `getStats()`.
- `tests/unit/context/context-unit.test.js`
- `tests/unit/context/token-budget.test.js`
- `tests/unit/context/workspace-indexer.test.js`
- `tests/unit/context/context-selector.test.js`
- `tests/unit/context/context-snapshot.test.js`
- `tests/unit/context/context-engine.test.js`
- `tests/integration/v2-context-kernel.test.js`
- `tests/integration/v2-runtime-context.test.js`

Modify:

- `src/core/runtime/agent-runtime.js`
  Accept `createContextSnapshot`, create context after classification, pass it to reply fast path, executor loop, and repair loop.
- `src/core/execution/executor-loop.js`
  Persist context inside `resume_state` so approval resume continues with the same prompt context.
- `src/core/execution/repair-executor.js`
  Persist context in repair approval resume state.
- `src/core/verification/repair-loop.js`
  Accept and pass `context` into repair prompt construction and preserve it through approval resume.
- `src/core/verification/repair-prompt.js`
  Include bounded `context_summary` in the repair payload.
- `src/index.js`
  Create the context engine, expose the kernel context facade, support `context: { disabled: true }`, and inject snapshot creation into runtime.
- `src/sessions/event-types.js`
  Register `context:snapshot`, `context:pin`, `context:unpin`, and `context:warm`.
- `tests/unit/core/agent-runtime.test.js`
- `tests/unit/core/execution/executor-loop.test.js`
- `tests/unit/core/execution/repair-executor.test.js`
- `tests/unit/core/verification/repair-loop.test.js`
- `tests/unit/core/verification/repair-prompt.test.js`
- `tests/unit/sessions/event-types.test.js`
- `package.json`
  Add the new context modules to `npm run check`.

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

### Task 1: Context Unit and Token Budget

**Files:**
- Create: `src/context/context-unit.js`
- Create: `src/context/token-budget.js`
- Test: `tests/unit/context/context-unit.test.js`
- Test: `tests/unit/context/token-budget.test.js`

- [ ] **Step 1: Write failing context unit tests**

Create `tests/unit/context/context-unit.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  createContextUnit,
  estimateTokens,
  priorityForPath,
  clipSnippet
} from "../../../src/context/context-unit.js";

test("createContextUnit returns deterministic id and content hash", () => {
  const first = createContextUnit({
    path: "src/index.js",
    content: "export const value = 1;\n",
    reason: "mentioned",
    now: "2026-05-31T00:00:00.000Z"
  });
  const second = createContextUnit({
    path: "src/index.js",
    content: "export const value = 1;\n",
    reason: "mentioned",
    now: "2026-05-31T00:00:01.000Z"
  });

  assert.equal(first.id, second.id);
  assert.equal(first.hash, second.hash);
  assert.equal(first.path, "src/index.js");
  assert.equal(first.type, "file");
  assert.equal(first.reason, "mentioned");
  assert.equal(first.priority, 2);
  assert.equal(first.bytes, Buffer.byteLength("export const value = 1;\n"));
  assert.ok(first.token_count > 0);
  assert.equal(first.updated_at, "2026-05-31T00:00:00.000Z");
});

test("priorityForPath assigns stable prefix priorities", () => {
  assert.deepEqual(priorityForPath("package.json"), { priority: 0, reason: "project-manifest" });
  assert.deepEqual(priorityForPath("README.md"), { priority: 0, reason: "project-doc" });
  assert.deepEqual(priorityForPath("environment.yml"), { priority: 0, reason: "project-manifest" });
  assert.deepEqual(priorityForPath("src/cli.js"), { priority: 2, reason: "source" });
  assert.deepEqual(priorityForPath("tests/unit/example.test.js"), { priority: 2, reason: "test" });
  assert.deepEqual(priorityForPath("docs/notes.md"), { priority: 3, reason: "cold" });
});

test("estimateTokens is deterministic and never returns zero for content", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("a".repeat(17)), 5);
});

test("clipSnippet bounds text by character count", () => {
  assert.equal(clipSnippet("abcdef", 10), "abcdef");
  assert.equal(clipSnippet("abcdef", 3), "abc");
});
```

- [ ] **Step 2: Run context unit tests to verify they fail**

Run:

```powershell
npm.cmd test -- tests/unit/context/context-unit.test.js
```

Expected: FAIL with a module-not-found error for `src/context/context-unit.js`.

- [ ] **Step 3: Implement context unit helpers**

Create `src/context/context-unit.js`:

```js
import { createHash } from "node:crypto";
import { nowIso } from "../shared/time.js";

const STABLE_MANIFESTS = new Set([
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "environment.yml"
]);

const SOURCE_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".json",
  ".md",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".css",
  ".html",
  ".yml",
  ".yaml",
  ".toml"
]);

export function createContextUnit({
  path,
  content,
  reason = null,
  priority = null,
  maxSnippetBytes = 4000,
  now = nowIso()
} = {}) {
  if (!path || typeof path !== "string") throw new Error("path is required");
  if (typeof content !== "string") throw new Error("content must be a string");

  const base = priorityForPath(path);
  const normalizedPath = normalizeContextPath(path);
  const hash = `sha256:${hashText(content)}`;
  const snippet = clipSnippet(content, maxSnippetBytes);

  return {
    id: `ctx_${hashText(`${normalizedPath}\0${content}`).slice(0, 12)}`,
    type: "file",
    path: normalizedPath,
    hash,
    bytes: Buffer.byteLength(content),
    token_count: estimateTokens(snippet),
    priority: priority ?? base.priority,
    reason: reason || base.reason,
    snippet,
    updated_at: now
  };
}

export function priorityForPath(inputPath) {
  const p = normalizeContextPath(inputPath);
  const lower = p.toLowerCase();
  const base = lower.split("/").pop();
  const ext = extensionOf(lower);

  if (STABLE_MANIFESTS.has(base)) return { priority: 0, reason: "project-manifest" };
  if (base === "readme.md") return { priority: 0, reason: "project-doc" };
  if (lower.includes(".test.") || lower.includes(".spec.") || lower.startsWith("test/") || lower.startsWith("tests/")) {
    return { priority: 2, reason: "test" };
  }
  if (SOURCE_EXTENSIONS.has(ext) && (lower.startsWith("src/") || lower.startsWith("bin/") || lower.startsWith("lib/"))) {
    return { priority: 2, reason: "source" };
  }
  if ([".json", ".yml", ".yaml", ".toml"].includes(ext)) return { priority: 2, reason: "config" };
  return { priority: 3, reason: "cold" };
}

export function estimateTokens(text) {
  const bytes = Buffer.byteLength(String(text || ""));
  return bytes === 0 ? 0 : Math.ceil(bytes / 4);
}

export function clipSnippet(text, maxChars = 4000) {
  const value = String(text || "");
  return value.length > maxChars ? value.slice(0, maxChars) : value;
}

export function normalizeContextPath(inputPath) {
  return String(inputPath || "").replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function hashText(text) {
  return createHash("sha256").update(String(text)).digest("hex");
}

function extensionOf(inputPath) {
  const last = inputPath.split("/").pop() || "";
  const index = last.lastIndexOf(".");
  return index >= 0 ? last.slice(index) : "";
}
```

- [ ] **Step 4: Run context unit tests to verify they pass**

Run:

```powershell
npm.cmd test -- tests/unit/context/context-unit.test.js
```

Expected: PASS for 4 tests.

- [ ] **Step 5: Write failing token budget tests**

Create `tests/unit/context/token-budget.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  budgetForChannel,
  selectWithinBudget
} from "../../../src/context/token-budget.js";

test("budgetForChannel returns defaults and supports overrides", () => {
  assert.deepEqual(budgetForChannel("think"), { channel: "think", allocated: 12000 });
  assert.deepEqual(budgetForChannel("act"), { channel: "act", allocated: 8000 });
  assert.deepEqual(budgetForChannel("repair"), { channel: "repair", allocated: 10000 });
  assert.deepEqual(budgetForChannel("reply"), { channel: "reply", allocated: 6000 });
  assert.deepEqual(budgetForChannel("unknown", { default: 123 }), { channel: "unknown", allocated: 123 });
  assert.deepEqual(budgetForChannel("act", { act: 200 }), { channel: "act", allocated: 200 });
});

test("selectWithinBudget keeps deterministic order and skips oversized units", () => {
  const units = [
    { path: "a.js", token_count: 4 },
    { path: "b.js", token_count: 10 },
    { path: "c.js", token_count: 3 }
  ];

  const result = selectWithinBudget(units, 7);

  assert.deepEqual(result.selected.map((unit) => unit.path), ["a.js", "c.js"]);
  assert.deepEqual(result.skipped.map((unit) => unit.path), ["b.js"]);
  assert.deepEqual(result.budget, { allocated: 7, used: 7, remaining: 0 });
});

test("selectWithinBudget rejects negative budgets", () => {
  assert.throws(
    () => selectWithinBudget([], -1),
    /budget must be a non-negative number/
  );
});
```

- [ ] **Step 6: Run token budget tests to verify they fail**

Run:

```powershell
npm.cmd test -- tests/unit/context/token-budget.test.js
```

Expected: FAIL with a module-not-found error for `src/context/token-budget.js`.

- [ ] **Step 7: Implement token budget helpers**

Create `src/context/token-budget.js`:

```js
const DEFAULT_BUDGETS = Object.freeze({
  think: 12000,
  act: 8000,
  repair: 10000,
  reply: 6000,
  default: 6000
});

export function budgetForChannel(channel = "reply", overrides = {}) {
  const key = String(channel || "reply");
  const value = overrides[key] ?? DEFAULT_BUDGETS[key] ?? overrides.default ?? DEFAULT_BUDGETS.default;
  if (!Number.isFinite(value) || value < 0) throw new Error("budget must be a non-negative number");
  return { channel: key, allocated: value };
}

export function selectWithinBudget(units = [], allocated = 0) {
  if (!Number.isFinite(allocated) || allocated < 0) throw new Error("budget must be a non-negative number");
  const selected = [];
  const skipped = [];
  let used = 0;

  for (const unit of units) {
    const cost = Number(unit.token_count || 0);
    if (used + cost <= allocated) {
      selected.push(unit);
      used += cost;
    } else {
      skipped.push(unit);
    }
  }

  return {
    selected,
    skipped,
    budget: {
      allocated,
      used,
      remaining: allocated - used
    }
  };
}
```

- [ ] **Step 8: Run Task 1 tests to verify they pass**

Run:

```powershell
npm.cmd test -- tests/unit/context/context-unit.test.js tests/unit/context/token-budget.test.js
```

Expected: PASS for 7 tests.

- [ ] **Step 9: Commit Task 1**

Run:

```powershell
git add src/context/context-unit.js src/context/token-budget.js tests/unit/context/context-unit.test.js tests/unit/context/token-budget.test.js
git commit -m "feat(v2): add context units and token budgets"
```

---

### Task 2: Workspace Indexer

**Files:**
- Create: `src/context/workspace-indexer.js`
- Test: `tests/unit/context/workspace-indexer.test.js`

- [ ] **Step 1: Write failing workspace indexer tests**

Create `tests/unit/context/workspace-indexer.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { indexWorkspace, shouldSkipContextPath } from "../../../src/context/workspace-indexer.js";

test("indexWorkspace indexes safe text files with context units", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-context-index-"));
  await writeFile(path.join(root, "package.json"), "{\"name\":\"demo\"}\n");
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "index.js"), "export const demo = true;\n");

  const result = await indexWorkspace({ root });

  assert.ok(result.units.has("package.json"));
  assert.ok(result.units.has("src/index.js"));
  assert.equal(result.stats.indexed_files, 2);
  assert.equal(result.stats.skipped_files, 0);
});

test("indexWorkspace skips ignored directories and secret-like files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-context-skip-"));
  await writeFile(path.join(root, "README.md"), "# demo\n");
  await writeFile(path.join(root, ".env"), "DEEPSEEK_API_KEY=secret\n");
  await mkdir(path.join(root, "node_modules"), { recursive: true });
  await writeFile(path.join(root, "node_modules", "pkg.js"), "module.exports = 1;\n");
  await mkdir(path.join(root, "dist"), { recursive: true });
  await writeFile(path.join(root, "dist", "bundle.js"), "generated\n");

  const result = await indexWorkspace({ root });

  assert.ok(result.units.has("README.md"));
  assert.equal(result.units.has(".env"), false);
  assert.equal(result.units.has("node_modules/pkg.js"), false);
  assert.equal(result.units.has("dist/bundle.js"), false);
  assert.equal(result.stats.indexed_files, 1);
  assert.ok(result.stats.skipped_files >= 1);
});

test("indexWorkspace skips binary and oversized files without failing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-context-binary-"));
  await writeFile(path.join(root, "README.md"), "# demo\n");
  await writeFile(path.join(root, "image.bin"), Buffer.from([0, 1, 2, 3]));
  await writeFile(path.join(root, "large.txt"), "x".repeat(128));

  const result = await indexWorkspace({
    root,
    options: { maxFileBytes: 32, maxSnippetBytes: 16 }
  });

  assert.ok(result.units.has("README.md"));
  assert.equal(result.units.has("image.bin"), false);
  assert.equal(result.units.has("large.txt"), false);
  assert.ok(result.stats.skipped_files >= 2);
});

test("shouldSkipContextPath blocks generated and secret names", () => {
  assert.equal(shouldSkipContextPath("node_modules/pkg/index.js"), true);
  assert.equal(shouldSkipContextPath("gui/node_modules/electron/index.js"), true);
  assert.equal(shouldSkipContextPath(".deepseek-code/v2/session.jsonl"), true);
  assert.equal(shouldSkipContextPath(".env.local"), true);
  assert.equal(shouldSkipContextPath("certs/server.key"), true);
  assert.equal(shouldSkipContextPath("src/index.js"), false);
});
```

- [ ] **Step 2: Run indexer tests to verify they fail**

Run:

```powershell
npm.cmd test -- tests/unit/context/workspace-indexer.test.js
```

Expected: FAIL with a module-not-found error for `src/context/workspace-indexer.js`.

- [ ] **Step 3: Implement workspace indexer**

Create `src/context/workspace-indexer.js`:

```js
import { createContextUnit } from "./context-unit.js";
import {
  normalizeRelativePath,
  readWorkspaceTextFile,
  walkWorkspaceFiles
} from "../workspace/path-safety.js";

const DEFAULT_OPTIONS = Object.freeze({
  maxFiles: 1000,
  maxFileBytes: 64 * 1024,
  maxSnippetBytes: 4000
});

const IGNORED_SEGMENTS = new Set([
  ".git",
  ".deepseek-code",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "target",
  "vendor",
  "__pycache__"
]);

const SECRET_SUFFIXES = [".pem", ".key", ".p12", ".pfx"];

export async function indexWorkspace({ root, options = {} } = {}) {
  if (!root) throw new Error("root is required");
  const settings = { ...DEFAULT_OPTIONS, ...options };
  const units = new Map();
  const stats = {
    scanned_files: 0,
    indexed_files: 0,
    skipped_files: 0,
    skipped_reasons: {}
  };

  const files = await walkWorkspaceFiles(root, ".", { maxFiles: settings.maxFiles });
  for (const file of files) {
    stats.scanned_files += 1;
    const skip = skipReason(file);
    if (skip) {
      recordSkip(stats, skip);
      continue;
    }

    try {
      const text = await readWorkspaceTextFile(root, file, { maxBytes: settings.maxFileBytes });
      const unit = createContextUnit({
        path: text.path,
        content: text.content,
        maxSnippetBytes: settings.maxSnippetBytes
      });
      units.set(unit.path, unit);
      stats.indexed_files += 1;
    } catch (error) {
      recordSkip(stats, classifyReadError(error));
    }
  }

  return { units, stats };
}

export function shouldSkipContextPath(inputPath) {
  return Boolean(skipReason(inputPath));
}

function skipReason(inputPath) {
  const p = normalizeRelativePath(inputPath);
  const lower = p.toLowerCase();
  const segments = lower.split("/");
  const base = segments[segments.length - 1] || "";

  if (segments.some((segment) => IGNORED_SEGMENTS.has(segment))) return "ignored-directory";
  if (base === ".env" || base.startsWith(".env.")) return "secret-file";
  if (SECRET_SUFFIXES.some((suffix) => base.endsWith(suffix))) return "secret-file";
  if (base.includes("secret") && (base.endsWith(".json") || base.endsWith(".txt") || base.endsWith(".yml") || base.endsWith(".yaml"))) {
    return "secret-file";
  }
  return null;
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

- [ ] **Step 4: Run indexer tests to verify they pass**

Run:

```powershell
npm.cmd test -- tests/unit/context/workspace-indexer.test.js
```

Expected: PASS for 4 tests.

- [ ] **Step 5: Commit Task 2**

Run:

```powershell
git add src/context/workspace-indexer.js tests/unit/context/workspace-indexer.test.js
git commit -m "feat(v2): add workspace context indexer"
```

---

### Task 3: Context Selector

**Files:**
- Create: `src/context/context-selector.js`
- Test: `tests/unit/context/context-selector.test.js`

- [ ] **Step 1: Write failing context selector tests**

Create `tests/unit/context/context-selector.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createContextUnit } from "../../../src/context/context-unit.js";
import {
  detectMentionedPaths,
  rankContextUnits,
  selectContextUnits
} from "../../../src/context/context-selector.js";

function unit(path, content = `${path}\n`) {
  return createContextUnit({
    path,
    content,
    now: "2026-05-31T00:00:00.000Z"
  });
}

test("detectMentionedPaths resolves exact paths and unique basenames", () => {
  const index = new Map([
    ["README.md", unit("README.md")],
    ["src/index.js", unit("src/index.js")],
    ["lib/index.js", unit("lib/index.js")],
    ["src/tui.js", unit("src/tui.js")]
  ]);

  assert.deepEqual(
    detectMentionedPaths("please inspect README.md and tui.js", index),
    new Set(["README.md", "src/tui.js"])
  );
  assert.deepEqual(
    detectMentionedPaths("look at index.js", index),
    new Set()
  );
});

test("rankContextUnits puts stable prefix before pinned and mentioned files", () => {
  const index = new Map([
    ["src/z.js", unit("src/z.js")],
    ["README.md", unit("README.md")],
    ["src/a.js", unit("src/a.js")],
    ["package.json", unit("package.json")]
  ]);

  const ranked = rankContextUnits({
    units: index,
    message: "update src/z.js",
    pinned: new Set(["src/a.js"]),
    warmed: new Map([["src/z.js", "manual-warm"]]),
    classification: { task_type: "edit" }
  });

  assert.deepEqual(ranked.map((item) => [item.path, item.reason, item.priority]), [
    ["package.json", "project-manifest", 0],
    ["README.md", "project-doc", 0],
    ["src/a.js", "pinned", 1],
    ["src/z.js", "mentioned", 1]
  ]);
});

test("selectContextUnits respects budget after ranking", () => {
  const index = new Map([
    ["package.json", { ...unit("package.json", "x".repeat(8)), token_count: 2 }],
    ["README.md", { ...unit("README.md", "x".repeat(8)), token_count: 2 }],
    ["src/big.js", { ...unit("src/big.js", "x".repeat(80)), token_count: 20 }]
  ]);

  const result = selectContextUnits({
    units: index,
    message: "modify src/big.js",
    classification: { task_type: "edit" },
    budget: 4
  });

  assert.deepEqual(result.selected.map((item) => item.path), ["package.json", "README.md"]);
  assert.deepEqual(result.skipped.map((item) => item.path), ["src/big.js"]);
  assert.equal(result.budget.used, 4);
});
```

- [ ] **Step 2: Run selector tests to verify they fail**

Run:

```powershell
npm.cmd test -- tests/unit/context/context-selector.test.js
```

Expected: FAIL with a module-not-found error for `src/context/context-selector.js`.

- [ ] **Step 3: Implement context selector**

Create `src/context/context-selector.js`:

```js
import { normalizeContextPath } from "./context-unit.js";
import { selectWithinBudget } from "./token-budget.js";

export function detectMentionedPaths(message = "", units = new Map()) {
  const text = String(message || "");
  const paths = [...units.keys()].sort();
  const byBase = new Map();

  for (const p of paths) {
    const base = basename(p);
    byBase.set(base, [...(byBase.get(base) || []), p]);
  }

  const mentioned = new Set();
  for (const p of paths) {
    if (containsPathToken(text, p)) mentioned.add(p);
  }
  for (const [base, candidates] of byBase.entries()) {
    if (candidates.length === 1 && containsPathToken(text, base)) mentioned.add(candidates[0]);
  }
  return mentioned;
}

export function rankContextUnits({
  units = new Map(),
  message = "",
  pinned = new Set(),
  warmed = new Map(),
  classification = {}
} = {}) {
  const mentioned = detectMentionedPaths(message, units);
  const taskType = classification?.task_type || "general";
  const ranked = [];

  for (const unit of units.values()) {
    let priority = unit.priority;
    let reason = unit.reason;
    if (pinned.has(unit.path)) {
      priority = 1;
      reason = "pinned";
    } else if (mentioned.has(unit.path)) {
      priority = 1;
      reason = "mentioned";
    } else if (warmed.has(unit.path)) {
      priority = Math.min(priority, 2);
      reason = warmed.get(unit.path) || "warm";
    } else if ((taskType === "edit" || taskType === "diagnostic") && isCompanion(unit.path)) {
      priority = Math.min(priority, 2);
      reason = unit.reason === "cold" ? "task-companion" : unit.reason;
    }

    if (priority <= 2) ranked.push({ ...unit, priority, reason });
  }

  return ranked.sort(compareUnits);
}

export function selectContextUnits({
  units = new Map(),
  message = "",
  pinned = new Set(),
  warmed = new Map(),
  classification = {},
  budget = 6000
} = {}) {
  const ranked = rankContextUnits({ units, message, pinned, warmed, classification });
  return selectWithinBudget(ranked, budget);
}

function compareUnits(a, b) {
  return (a.priority - b.priority) || stablePrefixRank(a.path) - stablePrefixRank(b.path) || a.path.localeCompare(b.path);
}

function stablePrefixRank(path) {
  const p = normalizeContextPath(path).toLowerCase();
  const order = ["package.json", "readme.md", "environment.yml", "pyproject.toml", "cargo.toml", "go.mod"];
  const index = order.indexOf(p);
  return index === -1 ? 100 : index;
}

function isCompanion(path) {
  const p = normalizeContextPath(path).toLowerCase();
  return p.includes(".test.") || p.includes(".spec.") || p.startsWith("test/") || p.startsWith("tests/") || p.endsWith(".json");
}

function basename(path) {
  return normalizeContextPath(path).split("/").pop();
}

function containsPathToken(text, token) {
  const escaped = escapeRegExp(token);
  return new RegExp(`(^|[^A-Za-z0-9_./-])${escaped}($|[^A-Za-z0-9_./-])`).test(text);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
```

- [ ] **Step 4: Run selector tests to verify they pass**

Run:

```powershell
npm.cmd test -- tests/unit/context/context-selector.test.js
```

Expected: PASS for 3 tests.

- [ ] **Step 5: Commit Task 3**

Run:

```powershell
git add src/context/context-selector.js tests/unit/context/context-selector.test.js
git commit -m "feat(v2): add context selector"
```

---

### Task 4: Context Snapshot and Engine Facade

**Files:**
- Create: `src/context/context-snapshot.js`
- Create: `src/context/index.js`
- Test: `tests/unit/context/context-snapshot.test.js`
- Test: `tests/unit/context/context-engine.test.js`

- [ ] **Step 1: Write failing context snapshot tests**

Create `tests/unit/context/context-snapshot.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createContextUnit } from "../../../src/context/context-unit.js";
import { buildContextSnapshot } from "../../../src/context/context-snapshot.js";

function unit(path, content, reason = undefined) {
  return createContextUnit({
    path,
    content,
    reason,
    now: "2026-05-31T00:00:00.000Z"
  });
}

test("buildContextSnapshot returns public metadata and compact summary", () => {
  const selected = [
    unit("package.json", "{\"name\":\"demo\"}\n", "project-manifest"),
    unit("src/index.js", "export const demo = true;\n", "mentioned")
  ];

  const snapshot = buildContextSnapshot({
    root: "/repo",
    channel: "act",
    taskType: "edit",
    selected,
    budget: { allocated: 100, used: 20, remaining: 80 },
    stats: { indexed_files: 2, skipped_files: 0 }
  });

  assert.match(snapshot.snapshot_id, /^ctxsnap_/);
  assert.equal(snapshot.root, "/repo");
  assert.equal(snapshot.channel, "act");
  assert.equal(snapshot.task_type, "edit");
  assert.deepEqual(snapshot.units.map((u) => u.path), ["package.json", "src/index.js"]);
  assert.deepEqual(snapshot.assembly_order, ["package.json", "src/index.js"]);
  assert.equal(snapshot.stats.selected_files, 2);
  assert.ok(snapshot.summary.includes("Project files:"));
  assert.ok(snapshot.summary.includes("- package.json (P0 project-manifest)"));
  assert.ok(snapshot.summary.includes("--- src/index.js"));
  assert.equal(snapshot.expected_cache_prefix_offset, selected[0].token_count);
  assert.equal(snapshot.units[0].snippet, undefined);
});

test("buildContextSnapshot handles empty selection", () => {
  const snapshot = buildContextSnapshot({
    root: "/repo",
    channel: "reply",
    taskType: "query",
    selected: [],
    budget: { allocated: 10, used: 0, remaining: 10 },
    stats: { indexed_files: 0, skipped_files: 0 }
  });

  assert.equal(snapshot.summary, "Project files:\n(none selected)");
  assert.deepEqual(snapshot.units, []);
  assert.equal(snapshot.expected_cache_prefix_offset, 0);
});
```

- [ ] **Step 2: Run snapshot tests to verify they fail**

Run:

```powershell
npm.cmd test -- tests/unit/context/context-snapshot.test.js
```

Expected: FAIL with a module-not-found error for `src/context/context-snapshot.js`.

- [ ] **Step 3: Implement context snapshot builder**

Create `src/context/context-snapshot.js`:

```js
import { makeId } from "../shared/id.js";

export function buildContextSnapshot({
  root,
  channel = "reply",
  taskType = "general",
  selected = [],
  budget = { allocated: 0, used: 0, remaining: 0 },
  stats = {}
} = {}) {
  const units = selected.map((unit) => ({
    id: unit.id,
    path: unit.path,
    hash: unit.hash,
    token_count: unit.token_count,
    priority: unit.priority,
    reason: unit.reason
  }));
  const assemblyOrder = units.map((unit) => unit.path);
  const stablePrefixUnits = selected.filter((unit) => unit.priority === 0);

  return {
    snapshot_id: makeId("ctxsnap"),
    root,
    channel,
    task_type: taskType,
    summary: buildSummary(selected),
    units,
    unit_hashes: units.map((unit) => unit.hash),
    file_revision_hashes: Object.fromEntries(units.map((unit) => [unit.path, unit.hash])),
    assembly_order: assemblyOrder,
    expected_cache_prefix_offset: stablePrefixUnits.reduce((sum, unit) => sum + unit.token_count, 0),
    budget,
    stats: {
      indexed_files: stats.indexed_files || 0,
      skipped_files: stats.skipped_files || 0,
      selected_files: units.length
    }
  };
}

export function buildSummary(selected = []) {
  if (!selected.length) return "Project files:\n(none selected)";

  const files = selected.map((unit) => `- ${unit.path} (P${unit.priority} ${unit.reason})`);
  const snippets = selected.map((unit) => [
    `--- ${unit.path}`,
    unit.snippet || ""
  ].join("\n"));
  return [
    "Project files:",
    ...files,
    "",
    "Relevant snippets:",
    ...snippets
  ].join("\n");
}
```

- [ ] **Step 4: Run snapshot tests to verify they pass**

Run:

```powershell
npm.cmd test -- tests/unit/context/context-snapshot.test.js
```

Expected: PASS for 2 tests.

- [ ] **Step 5: Write failing context engine tests**

Create `tests/unit/context/context-engine.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEventBus } from "../../../src/shared/event-bus.js";
import { createContextEngine } from "../../../src/context/index.js";

test("context engine scans and snapshots real workspace files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-context-engine-"));
  await writeFile(path.join(root, "package.json"), "{\"name\":\"demo\"}\n");
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "index.js"), "export const demo = true;\n");
  const events = [];
  const bus = createEventBus();
  bus.subscribe("context:snapshot", (event) => events.push(event));

  const engine = createContextEngine({ root, eventBus: bus, options: { budgets: { act: 1000 } } });
  await engine.scan();
  const snapshot = await engine.snapshot({
    message: "modify src/index.js",
    classification: { task_type: "edit" },
    channel: "act"
  });

  assert.notEqual(snapshot.snapshot_id, "v2_empty_snapshot");
  assert.ok(snapshot.units.some((unit) => unit.path === "package.json"));
  assert.ok(snapshot.units.some((unit) => unit.path === "src/index.js"));
  assert.ok(snapshot.summary.includes("src/index.js"));
  assert.equal(events.length, 1);
  assert.equal(events[0].snapshot_id, snapshot.snapshot_id);
  assert.equal(events[0].summary, undefined);
});

test("context engine pin warm and unpin affect later snapshots", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-context-pin-"));
  await writeFile(path.join(root, "README.md"), "# demo\n");
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "a.js"), "export const a = 1;\n");
  await writeFile(path.join(root, "src", "b.js"), "export const b = 1;\n");
  const events = [];
  const bus = createEventBus();
  for (const type of ["context:pin", "context:unpin", "context:warm"]) {
    bus.subscribe(type, (event) => events.push([type, event]));
  }

  const engine = createContextEngine({ root, eventBus: bus, options: { budgets: { act: 1000 } } });
  await engine.scan();
  engine.pin("src/b.js");
  engine.warm("src/a.js", "manual-warm");
  const pinned = await engine.snapshot({
    message: "change code",
    classification: { task_type: "edit" },
    channel: "act"
  });
  engine.unpin("src/b.js");
  const unpinned = await engine.snapshot({
    message: "change code",
    classification: { task_type: "edit" },
    channel: "act"
  });

  assert.ok(pinned.units.some((unit) => unit.path === "src/b.js" && unit.reason === "pinned"));
  assert.ok(pinned.units.some((unit) => unit.path === "src/a.js" && unit.reason === "manual-warm"));
  assert.equal(unpinned.units.some((unit) => unit.path === "src/b.js" && unit.reason === "pinned"), false);
  assert.deepEqual(events.map(([type]) => type), ["context:pin", "context:warm", "context:unpin"]);
});

test("disabled context engine returns empty disabled snapshot", async () => {
  const engine = createContextEngine({ root: process.cwd(), options: { disabled: true } });
  await engine.scan();
  const snapshot = await engine.snapshot({ channel: "act", classification: { task_type: "edit" } });

  assert.equal(snapshot.snapshot_id, "v2_context_disabled");
  assert.deepEqual(snapshot.units, []);
  assert.equal(snapshot.summary, "");
});

test("context engine rejects unsafe control paths", async () => {
  const engine = createContextEngine({ root: process.cwd(), options: { disabled: true } });

  assert.throws(() => engine.pin("../secret.txt"), /context path escapes project root/);
  assert.throws(() => engine.warm("/tmp/secret.txt"), /context path must be relative/);
});
```

- [ ] **Step 6: Run context engine tests to verify they fail**

Run:

```powershell
npm.cmd test -- tests/unit/context/context-engine.test.js
```

Expected: FAIL with a module-not-found error for `src/context/index.js`.

- [ ] **Step 7: Implement context engine facade**

Create `src/context/index.js`:

```js
import { resolveWorkspacePath } from "../workspace/path-safety.js";
import path from "node:path";
import { budgetForChannel } from "./token-budget.js";
import { indexWorkspace } from "./workspace-indexer.js";
import { selectContextUnits } from "./context-selector.js";
import { buildContextSnapshot } from "./context-snapshot.js";

export function createContextEngine({ root, eventBus = null, options = {} } = {}) {
  if (!root) throw new Error("root is required");
  const disabled = options.disabled === true;
  let units = new Map();
  let stats = { indexed_files: 0, skipped_files: 0 };
  const pinned = new Set();
  const warmed = new Map();

  async function scan() {
    if (disabled) return getStats();
    const indexed = await indexWorkspace({ root, options });
    units = indexed.units;
    stats = indexed.stats;
    return getStats();
  }

  async function snapshot(input = {}) {
    if (disabled) {
      return {
        snapshot_id: "v2_context_disabled",
        root,
        channel: input.channel || "reply",
        task_type: input.classification?.task_type || "general",
        summary: "",
        units: [],
        budget: { allocated: 0, used: 0, remaining: 0 },
        stats: { ...stats, selected_files: 0 }
      };
    }
    if (units.size === 0) await scan();
    const channelBudget = budgetForChannel(input.channel || "reply", { ...(options.budgets || {}), ...(input.budget ? { [input.channel || "reply"]: input.budget } : {}) });
    const selected = selectContextUnits({
      units,
      message: input.message || "",
      pinned,
      warmed,
      classification: input.classification || {},
      budget: channelBudget.allocated
    });
    const snap = buildContextSnapshot({
      root,
      channel: channelBudget.channel,
      taskType: input.classification?.task_type || "general",
      selected: selected.selected,
      budget: selected.budget,
      stats
    });
    eventBus?.publish?.("context:snapshot", {
      snapshot_id: snap.snapshot_id,
      channel: snap.channel,
      task_type: snap.task_type,
      unit_count: snap.units.length,
      unit_paths: snap.units.map((unit) => unit.path),
      budget: snap.budget,
      stats: snap.stats
    });
    return snap;
  }

  function pin(inputPath) {
    const relative = normalizeControlPath(inputPath);
    pinned.add(relative);
    eventBus?.publish?.("context:pin", { path: relative });
  }

  function unpin(inputPath) {
    const relative = normalizeControlPath(inputPath);
    pinned.delete(relative);
    eventBus?.publish?.("context:unpin", { path: relative });
  }

  function warm(inputPath, reason = "warm") {
    const relative = normalizeControlPath(inputPath);
    warmed.set(relative, reason);
    eventBus?.publish?.("context:warm", { path: relative, reason });
  }

  function invalidate(inputPath) {
    const relative = normalizeControlPath(inputPath);
    units.delete(relative);
    warmed.delete(relative);
    pinned.delete(relative);
  }

  function getStats() {
    return {
      ...stats,
      pinned_files: pinned.size,
      warmed_files: warmed.size,
      indexed_paths: units.size
    };
  }

  function normalizeControlPath(inputPath) {
    const relative = String(inputPath || "").replace(/\\/g, "/").replace(/^\.\/+/, "");
    if (!relative) throw new Error("context path is required");
    if (path.isAbsolute(relative)) throw new Error("context path must be relative");
    if (relative.split("/").includes("..")) throw new Error("context path escapes project root");
    return relative;
  }

  return { scan, snapshot, pin, unpin, warm, invalidate, getStats };
}

export async function assertContextPathInside(root, inputPath) {
  return resolveWorkspacePath(root, inputPath, { mustExist: true });
}
```

- [ ] **Step 8: Run Task 4 tests to verify they pass**

Run:

```powershell
npm.cmd test -- tests/unit/context/context-snapshot.test.js tests/unit/context/context-engine.test.js
```

Expected: PASS for 5 tests.

- [ ] **Step 9: Commit Task 4**

Run:

```powershell
git add src/context/context-snapshot.js src/context/index.js tests/unit/context/context-snapshot.test.js tests/unit/context/context-engine.test.js
git commit -m "feat(v2): add context snapshot engine"
```

---

### Task 5: Prompt and Runtime Integration

**Files:**
- Modify: `src/core/runtime/agent-runtime.js`
- Modify: `src/core/execution/executor-loop.js`
- Modify: `src/core/execution/repair-executor.js`
- Modify: `src/core/verification/repair-loop.js`
- Modify: `src/core/verification/repair-prompt.js`
- Test: `tests/unit/core/agent-runtime.test.js`
- Test: `tests/unit/core/execution/executor-loop.test.js`
- Test: `tests/unit/core/execution/repair-executor.test.js`
- Test: `tests/unit/core/verification/repair-loop.test.js`
- Test: `tests/unit/core/verification/repair-prompt.test.js`

- [ ] **Step 1: Write failing repair prompt context test**

Append to `tests/unit/core/verification/repair-prompt.test.js`:

```js
test("repair prompt includes bounded context summary", () => {
  const messages = buildRepairMessages({
    userMessage: "fix a bug",
    classification: { task_type: "edit" },
    verification: { status: "failed", reason: "tests failed" },
    toolResults: [],
    context: { summary: "Project files:\n- src/index.js (P1 mentioned)\n--- src/index.js\nexport const x = 1;" }
  });

  const payload = JSON.parse(messages[1].content);
  assert.equal(payload.context_summary.includes("src/index.js"), true);
});
```

- [ ] **Step 2: Run repair prompt test to verify it fails**

Run:

```powershell
npm.cmd test -- tests/unit/core/verification/repair-prompt.test.js
```

Expected: FAIL because `payload.context_summary` is undefined.

- [ ] **Step 3: Modify repair prompt to include context summary**

In `src/core/verification/repair-prompt.js`, change the function signature and payload construction:

```js
export function buildRepairMessages({
  userMessage,
  classification = {},
  verification = {},
  toolResults = [],
  previousRepairAttempts = [],
  maxRepairAttempts = 2,
  context = null
} = {}) {
  const payload = {
    task: String(userMessage || ""),
    task_type: classification.task_type || "general",
    context_summary: clip(context?.summary || "", 6000),
    verification: {
      status: verification.status || "unknown",
      reason: clip(verification.reason || "", 2000),
      exit_code: verification.exit_code ?? verification.tool_result?.metadata?.exit_code ?? null
    },
    tool_results: summarizeRepairToolResults(toolResults),
    previous_repair_attempts: previousRepairAttempts.map((attempt) => ({
      attempt: attempt.attempt,
      status: attempt.status,
      verification_status: attempt.verification_status
    })),
    max_repair_attempts: maxRepairAttempts
  };
```

Do not change `summarizeRepairToolResults()` or `SAFE_METADATA_KEYS`.

- [ ] **Step 4: Run repair prompt test to verify it passes**

Run:

```powershell
npm.cmd test -- tests/unit/core/verification/repair-prompt.test.js
```

Expected: PASS.

- [ ] **Step 5: Write failing runtime context tests**

Append to `tests/unit/core/agent-runtime.test.js`:

```js
test("agent runtime passes context to query fast path", async () => {
  let receivedContext = null;
  const runtime = createAgentRuntime({
    sessionId: "sess_context_query",
    createContextSnapshot: async ({ message, classification, channel }) => ({
      snapshot_id: "ctxsnap_query",
      message,
      task_type: classification.task_type,
      channel,
      summary: "Project files:\n- README.md (P0 project-doc)"
    }),
    modelGateway: {
      reply: async ({ context }) => {
        receivedContext = context;
        return { content: "answer" };
      }
    }
  });

  const result = await runtime.send("what is this project?");

  assert.equal(result.status, "complete");
  assert.equal(receivedContext.snapshot_id, "ctxsnap_query");
  assert.equal(receivedContext.channel, "reply");
});

test("agent runtime passes context to executor loop model messages", async () => {
  let firstMessages = null;
  const runtime = createAgentRuntime({
    sessionId: "sess_context_loop",
    createContextSnapshot: async () => ({
      snapshot_id: "ctxsnap_act",
      channel: "act",
      summary: "Project files:\n- src/index.js (P1 mentioned)"
    }),
    modelGateway: {
      invoke: async (messages) => {
        firstMessages = messages;
        return { content: "done", tool_calls: [] };
      },
      reply: async () => ({ content: "fast" })
    },
    executeTool: async () => { throw new Error("no tools expected"); },
    createPolicyContext: () => ({ autonomy: "gated" })
  });

  const result = await runtime.send("modify src/index.js");

  assert.equal(result.status, "complete");
  assert.ok(firstMessages[0].content.includes("Project context:"));
  assert.ok(firstMessages[0].content.includes("src/index.js"));
});
```

- [ ] **Step 6: Run runtime context tests to verify they fail**

Run:

```powershell
npm.cmd test -- tests/unit/core/agent-runtime.test.js
```

Expected: FAIL because `createAgentRuntime()` does not accept or call `createContextSnapshot`.

- [ ] **Step 7: Modify runtime to create and pass context**

In `src/core/runtime/agent-runtime.js`, add `createContextSnapshot` to the destructured parameters:

```js
  createContextSnapshot = async () => null,
```

After classification and before choosing the response path in `send()`, add:

```js
      const context = await createContextSnapshot({
        message,
        classification,
        channel: classification.task_type === "query" ? "reply" : "act",
        phase: "execute",
        options
      });
      assertNotInterrupted(generation);

      let response;
      if (classification.task_type === "query" || !modelGateway?.invoke || !executeTool) {
        response = await runReplyFastPath({ message, classification, turn, options, signal: currentAbortController.signal, context });
      } else {
        response = await runToolLoopPath({ message, classification, turn, options, signal: currentAbortController.signal, context });
      }
```

Replace the existing `let response; if (...)` block with the code above.

Change `runReplyFastPath()` signature and gateway call:

```js
  async function runReplyFastPath({ message, classification, turn, options, signal, context = null }) {
    lifecycle = transitionLifecycle(lifecycle, { to: "complete", reason: "reply fast path", channel: "system" });
    const finalStep = completeAgentStep(createAgentStep({ turnId: turn.id, type: "final", channel: "system" }));
    const updatedTurn = addTurnStep(turn, finalStep);
    const response = modelGateway && typeof modelGateway.reply === "function"
      ? await modelGateway.reply({ message, classification, turn, options, signal, context })
      : { content: `V2-0 mock ${classification.task_type} response` };
    return { status: "complete", content: response.content, turn: updatedTurn, context };
  }
```

Change `runToolLoopPath()` signature and `runExecutorLoop()` call:

```js
  async function runToolLoopPath({ message, classification, turn, options, signal, context = null }) {
```

Inside `runExecutorLoop({ ... })`, add:

```js
      context,
```

Change the final call in `runToolLoopPath()`:

```js
    return verifyAndMaybeRepair({ turn, message, classification, loop, options, signal, context });
```

Change `verifyAndMaybeRepair()` signature:

```js
  async function verifyAndMaybeRepair({ turn, message, classification, loop, options, signal, context = null }) {
```

Inside the `runRepairLoop({ ... })` call, add:

```js
        context,
```

In `approve()`, when calling `verifyAndMaybeRepair()` after `resumeExecutorLoop()`, add:

```js
        context: record.resume_state.context || null
```

In the repair-phase approval `runRepairLoop({ ... })` call, add:

```js
          context: record.resume_state.context || record.resume_state.repair_context?.context || null,
```

- [ ] **Step 8: Persist context through executor resume states**

In `src/core/execution/executor-loop.js`, inside the `resume_state` object returned from `continueToolIteration()`, add:

```js
          context,
```

Update the call to `continueToolIteration()` in `runExecutorLoop()` so it passes `context` as its own argument:

```js
      options,
      context,
```

Add `context` to the `continueToolIteration()` destructuring:

```js
  context,
```

In `resumeExecutorLoop()`, when building a new `resume_state` for a second pause, add:

```js
          context: resumeState.context || null,
```

- [ ] **Step 9: Persist context through repair loop and repair executor**

In `src/core/verification/repair-loop.js`, add `context = null` to the destructured parameters.

In `buildRepairMessages({ ... })`, add:

```js
        context,
```

In the `runRepairExecutorImpl({ ... })` call, change `options` to:

```js
        options: { ...options, message: userMessage, classification, context }
```

When creating `repair_context`, add:

```js
              context,
```

In `src/core/execution/repair-executor.js`, inside the `resume_state` object, add:

```js
          context: options.context || null,
```

- [ ] **Step 10: Add focused resume-state regression tests**

Append to `tests/unit/core/execution/executor-loop.test.js`:

```js
test("executor loop stores context in approval resume state", async () => {
  const result = await runExecutorLoop({
    message: "modify a.txt",
    classification: { task_type: "edit" },
    turnId: "turn_context_resume",
    context: { snapshot_id: "ctxsnap_1", summary: "Project files:\n- a.txt" },
    modelGateway: {
      invoke: async () => ({
        content: "",
        tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: "d" } }]
      })
    },
    toolSchemas: [],
    executeTool: async (toolCall) => ({
      call_id: toolCall.id,
      status: "approval_required",
      content: [{ type: "text", text: "approval" }],
      metadata: { approval: { id: "approval_ctx" } }
    }),
    createPolicyContext: () => ({})
  });

  assert.equal(result.status, "awaiting_approval");
  assert.equal(result.resume_state.context.snapshot_id, "ctxsnap_1");
});
```

Append to `tests/unit/core/execution/repair-executor.test.js`:

```js
test("repair executor stores context in approval resume state", async () => {
  const result = await runRepairExecutor({
    turnId: "turn_repair_context",
    messages: [{ role: "user", content: "{}" }],
    modelGateway: {
      invoke: async () => ({
        content: "",
        tool_calls: [{ id: "call_shell", name: "shell", arguments: { argv: ["npm", "test"] } }]
      })
    },
    toolSchemas: [],
    executeTool: async (toolCall) => ({
      call_id: toolCall.id,
      status: "approval_required",
      content: [{ type: "text", text: "approval" }],
      metadata: { approval: { id: "approval_repair_ctx" } }
    }),
    createPolicyContext: () => ({}),
    options: { context: { snapshot_id: "ctxsnap_repair", summary: "Project files:\n- a.txt" } }
  });

  assert.equal(result.status, "awaiting_approval");
  assert.equal(result.resume_state.context.snapshot_id, "ctxsnap_repair");
});
```

Append to `tests/unit/core/verification/repair-loop.test.js`:

```js
test("repair loop passes context into repair messages", async () => {
  let receivedMessages = null;
  const result = await runRepairLoop({
    turnId: "turn_repair_context",
    userMessage: "modify a.txt",
    classification: { task_type: "edit" },
    modelGateway: {},
    toolSchemas: [],
    executeTool: async () => { throw new Error("no tools expected"); },
    createPolicyContext: () => ({}),
    verificationPolicy: { plan: () => ({ shouldVerify: false, mode: "off" }) },
    initialVerification: { status: "failed", reason: "tests failed" },
    initialToolResults: [],
    context: { snapshot_id: "ctxsnap_repair", summary: "Project files:\n- a.txt" },
    maxRepairAttempts: 1,
    runRepairExecutorImpl: async ({ messages }) => {
      receivedMessages = messages;
      return { status: "complete", content: "no fix", toolResults: [] };
    },
    runVerifierImpl: async () => ({ status: "skipped", reason: "off" })
  });

  assert.equal(result.status, "complete");
  const payload = JSON.parse(receivedMessages[1].content);
  assert.equal(payload.context_summary.includes("a.txt"), true);
});
```

- [ ] **Step 11: Run Task 5 tests to verify they pass**

Run:

```powershell
npm.cmd test -- tests/unit/core/agent-runtime.test.js tests/unit/core/execution/executor-loop.test.js tests/unit/core/execution/repair-executor.test.js tests/unit/core/verification/repair-loop.test.js tests/unit/core/verification/repair-prompt.test.js
```

Expected: PASS.

- [ ] **Step 12: Commit Task 5**

Run:

```powershell
git add src/core/runtime/agent-runtime.js src/core/execution/executor-loop.js src/core/execution/repair-executor.js src/core/verification/repair-loop.js src/core/verification/repair-prompt.js tests/unit/core/agent-runtime.test.js tests/unit/core/execution/executor-loop.test.js tests/unit/core/execution/repair-executor.test.js tests/unit/core/verification/repair-loop.test.js tests/unit/core/verification/repair-prompt.test.js
git commit -m "feat(v2): pass context through runtime prompts"
```

---

### Task 6: Kernel Integration and Session Events

**Files:**
- Modify: `src/index.js`
- Modify: `src/sessions/event-types.js`
- Test: `tests/integration/v2-context-kernel.test.js`
- Test: `tests/integration/v2-runtime-context.test.js`
- Test: `tests/unit/sessions/event-types.test.js`

- [ ] **Step 1: Write failing session event type test**

Modify the canonical event list in `tests/unit/sessions/event-types.test.js` to include context events:

```js
    "context:snapshot",
    "context:pin",
    "context:unpin",
    "context:warm",
```

Place them after `"approval:resolved"` and before `"file:diff_preview"`.

- [ ] **Step 2: Run session event test to verify it fails**

Run:

```powershell
npm.cmd test -- tests/unit/sessions/event-types.test.js
```

Expected: FAIL because the context event types are not registered.

- [ ] **Step 3: Register context event types**

Modify `src/sessions/event-types.js` and add the events after `"approval:resolved"`:

```js
  "context:snapshot",
  "context:pin",
  "context:unpin",
  "context:warm",
```

- [ ] **Step 4: Run session event test to verify it passes**

Run:

```powershell
npm.cmd test -- tests/unit/sessions/event-types.test.js
```

Expected: PASS.

- [ ] **Step 5: Write failing kernel context integration tests**

Create `tests/integration/v2-context-kernel.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createKernel } from "../../src/index.js";

test("kernel context snapshot returns real workspace units", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-kernel-context-"));
  await writeFile(path.join(root, "package.json"), "{\"name\":\"demo\"}\n");
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "index.js"), "export const demo = true;\n");
  const kernel = await createKernel(root, {
    sessionRoot: path.join(root, ".sessions"),
    modelGateway: { reply: async () => ({ content: "ok" }) }
  });

  const snapshot = await kernel.context.snapshot({
    message: "modify src/index.js",
    classification: { task_type: "edit" },
    channel: "act"
  });

  assert.notEqual(snapshot.snapshot_id, "v2_empty_snapshot");
  assert.ok(snapshot.units.some((unit) => unit.path === "package.json"));
  assert.ok(snapshot.units.some((unit) => unit.path === "src/index.js"));
  assert.ok(snapshot.summary.includes("src/index.js"));
});

test("kernel context pin affects next snapshot and persists safe events", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-kernel-context-events-"));
  await writeFile(path.join(root, "README.md"), "# demo\n");
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "a.js"), "export const a = 1;\n");
  const kernel = await createKernel(root, {
    sessionRoot: path.join(root, ".sessions"),
    modelGateway: { reply: async () => ({ content: "ok" }) }
  });

  kernel.context.pin("src/a.js");
  const snapshot = await kernel.context.snapshot({
    message: "change code",
    classification: { task_type: "edit" },
    channel: "act"
  });
  await kernel.session.flush();
  const timeline = await kernel.session.getTimeline(20);

  assert.ok(snapshot.units.some((unit) => unit.path === "src/a.js" && unit.reason === "pinned"));
  const contextEvents = timeline.filter((event) => event.type.startsWith("context:"));
  assert.ok(contextEvents.some((event) => event.type === "context:pin"));
  assert.ok(contextEvents.some((event) => event.type === "context:snapshot"));
  assert.equal(JSON.stringify(contextEvents).includes("export const a"), false);
  assert.equal(JSON.stringify(contextEvents).includes("Relevant snippets"), false);
});

test("kernel can disable context for focused tests", async () => {
  const kernel = await createKernel(process.cwd(), {
    sessionLog: null,
    context: { disabled: true },
    modelGateway: { reply: async () => ({ content: "ok" }) }
  });

  const snapshot = await kernel.context.snapshot({ channel: "act", classification: { task_type: "edit" } });

  assert.equal(snapshot.snapshot_id, "v2_context_disabled");
  assert.deepEqual(snapshot.units, []);
});
```

- [ ] **Step 6: Write failing runtime context integration tests**

Create `tests/integration/v2-runtime-context.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createKernel } from "../../src/index.js";

test("runtime first tool-loop model call receives context summary", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-runtime-context-"));
  await writeFile(path.join(root, "package.json"), "{\"name\":\"demo\"}\n");
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "index.js"), "export const demo = true;\n");
  let firstMessages = null;
  const kernel = await createKernel(root, {
    sessionRoot: path.join(root, ".sessions"),
    modelGateway: {
      invoke: async (messages) => {
        firstMessages = firstMessages || messages;
        return { content: "done", tool_calls: [] };
      },
      reply: async () => ({ content: "query" })
    }
  });

  const result = await kernel.agent.send("modify src/index.js", { autonomy: "gated" });

  assert.equal(result.status, "complete");
  assert.ok(firstMessages[0].content.includes("Project context:"));
  assert.ok(firstMessages[0].content.includes("src/index.js"));
});

test("runtime query fast path receives context summary", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-runtime-query-context-"));
  await writeFile(path.join(root, "README.md"), "# query context\n");
  let receivedContext = null;
  const kernel = await createKernel(root, {
    sessionRoot: path.join(root, ".sessions"),
    modelGateway: {
      reply: async ({ context }) => {
        receivedContext = context;
        return { content: "answer" };
      },
      invoke: async () => ({ content: "slow", tool_calls: [] })
    }
  });

  const result = await kernel.agent.send("what is this project?");

  assert.equal(result.status, "complete");
  assert.ok(receivedContext.summary.includes("README.md"));
  assert.equal(receivedContext.channel, "reply");
});

test("repair prompt receives context summary from runtime", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-runtime-repair-context-"));
  await writeFile(path.join(root, "package.json"), "{\"scripts\":{\"test\":\"node --test\"}}\n");
  await writeFile(path.join(root, "a.txt"), "old\n");
  let repairPayload = null;
  let invokeCount = 0;
  const diff = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+broken";
  const kernel = await createKernel(root, {
    sessionRoot: path.join(root, ".sessions"),
    verifyMode: "run",
    maxRepairAttempts: 1,
    modelGateway: {
      invoke: async (messages, options = {}) => {
        if (options.purpose === "repair") {
          repairPayload = JSON.parse(messages[1].content);
          return { content: "no repair", tool_calls: [] };
        }
        invokeCount += 1;
        if (invokeCount === 1) {
          return { content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff, prompt: "break a" } }] };
        }
        return { content: "done", tool_calls: [] };
      },
      reply: async () => ({ content: "query" })
    },
    testArgv: ["node", "-e", "process.exit(1)"]
  });

  await assert.rejects(
    () => kernel.agent.send("modify a.txt", { autonomy: "gated", verifyMode: "run" }),
    /verification failed|repair/i
  );

  assert.ok(repairPayload.context_summary.includes("package.json"));
});
```

- [ ] **Step 7: Run kernel/runtime integration tests to verify they fail**

Run:

```powershell
npm.cmd test -- tests/integration/v2-context-kernel.test.js tests/integration/v2-runtime-context.test.js
```

Expected: FAIL because `createKernel()` still returns `v2_empty_snapshot` and runtime does not receive a context engine from the kernel.

- [ ] **Step 8: Integrate context engine into kernel**

In `src/index.js`, add an import:

```js
import { createContextEngine } from "./context/index.js";
```

Before `const runtime = createAgentRuntime({ ... })`, create and scan the engine:

```js
  const contextEngine = options.contextEngine || createContextEngine({
    root,
    eventBus,
    options: options.context || {}
  });
  if (!options.contextEngine) {
    await contextEngine.scan();
  }
```

Inside the `createAgentRuntime({ ... })` options, add:

```js
    createContextSnapshot: (input) => contextEngine.snapshot(input),
```

Replace the old `const context = { ... }` facade with:

```js
  const context = {
    snapshot: (input = {}) => contextEngine.snapshot(input),
    pin: (p) => contextEngine.pin(p),
    unpin: (p) => contextEngine.unpin(p),
    warm: (p, reason) => contextEngine.warm(p, reason),
    getStats: () => contextEngine.getStats()
  };
```

- [ ] **Step 9: Run integration tests to verify they pass**

Run:

```powershell
npm.cmd test -- tests/unit/sessions/event-types.test.js tests/integration/v2-context-kernel.test.js tests/integration/v2-runtime-context.test.js
```

Expected: PASS.

- [ ] **Step 10: Commit Task 6**

Run:

```powershell
git add src/index.js src/sessions/event-types.js tests/unit/sessions/event-types.test.js tests/integration/v2-context-kernel.test.js tests/integration/v2-runtime-context.test.js
git commit -m "feat(v2): wire context engine into kernel"
```

---

### Task 7: Package Check and Regression

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Update syntax check script**

In `package.json`, add the new context files to the `check` script. Insert this segment after the existing `src/index.js src/shared/...` segment and before `src/core/protocol/...`:

```json
"&& node --check src/context/context-unit.js src/context/token-budget.js src/context/workspace-indexer.js src/context/context-selector.js src/context/context-snapshot.js src/context/index.js"
```

Keep the script as one JSON string and preserve valid JSON quoting.

- [ ] **Step 2: Run all V2-9 focused tests**

Run:

```powershell
npm.cmd test -- tests/unit/context/context-unit.test.js tests/unit/context/token-budget.test.js tests/unit/context/workspace-indexer.test.js tests/unit/context/context-selector.test.js tests/unit/context/context-snapshot.test.js tests/unit/context/context-engine.test.js tests/integration/v2-context-kernel.test.js tests/integration/v2-runtime-context.test.js
```

Expected: PASS.

- [ ] **Step 3: Run runtime regression tests touched by context integration**

Run:

```powershell
npm.cmd test -- tests/unit/core/agent-runtime.test.js tests/unit/core/execution/executor-loop.test.js tests/unit/core/execution/repair-executor.test.js tests/unit/core/verification/repair-loop.test.js tests/unit/core/verification/repair-prompt.test.js tests/integration/v2-runtime-loop.test.js tests/integration/v2-repair-loop.test.js
```

Expected: PASS.

- [ ] **Step 4: Run full test suite**

Run:

```powershell
npm.cmd test
```

Expected: all tests pass. The total count should be greater than the V2-8 baseline of 371 because V2-9 adds new context tests.

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

Expected: PASS. If PowerShell prints warnings for pre-existing CRLF-only local files, confirm no V2-9 files are listed with whitespace errors.

- [ ] **Step 7: Check for session pollution**

Run:

```powershell
if (Test-Path -LiteralPath ".deepseek-code\v2") { throw ".deepseek-code/v2 should not be created by tests" } else { "no v2 session pollution" }
```

Expected: `no v2 session pollution`.

- [ ] **Step 8: Commit Task 7**

Run:

```powershell
git add package.json
git commit -m "chore(v2): include context engine checks"
```

---

## Final Review Checklist

- [ ] `kernel.context.snapshot()` no longer returns `v2_empty_snapshot` unless context is explicitly disabled.
- [ ] Context indexing uses `walkWorkspaceFiles()` and `readWorkspaceTextFile()` only; it does not execute shell commands.
- [ ] `.env`, secret-like files, `.git`, `.deepseek-code`, `node_modules`, build outputs, binary files, and oversized files are skipped.
- [ ] `context:snapshot` events contain paths, counts, budget, and stats but no snippets or file contents.
- [ ] Query fast path passes context to `modelGateway.reply()`.
- [ ] Tool-loop path includes `context.summary` in the first DeepSeek `invoke()` messages through `prompt-assembler.js`.
- [ ] Repair prompt includes bounded `context_summary`.
- [ ] Approval resume preserves the same context snapshot through normal and repair pauses.
- [ ] `npm.cmd test`, `npm.cmd run check`, `git diff --check`, and the `.deepseek-code/v2` pollution check pass.

## Execution Notes

Use one commit per task. If a test fails after implementation, diagnose the root cause before changing code. If code review feedback arrives after a task, verify it before applying fixes.
