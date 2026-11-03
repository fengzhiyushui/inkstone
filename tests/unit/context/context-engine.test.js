// tests/unit/context/context-engine.test.js — 上下文引擎(缓存/清单/选择器/快照/单元/令牌预算/工作区索引)领域测试
//
// v1.19.1 测试归并:本文件由下列历史任务单测试合并而成,每个来源包裹在独立
// describe 块中(异步回调 + 动态 import,来源间零共享绑定),测试语义与拆分前一致。
import { describe } from "node:test";

// ---------------------------------------------------------------------------
// 来源:tests/unit/context/context-engine.test.js
// ---------------------------------------------------------------------------
describe("unit/context/context-engine", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { createEventBus } = await import("../../../src/shared/event-bus.js");
  const { createContextEngine } = await import("../../../src/context/index.js");
  const { mkdtemp } = await import("../../helpers/tmp.js");

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

  test("context engine rejects unsafe control paths", async () => {
    const engine = createContextEngine({ root: process.cwd(), options: { disabled: true } });

    assert.throws(() => engine.pin("../secret.txt"), /context path escapes project root/);
    assert.throws(() => engine.warm("/tmp/secret.txt"), /context path must be relative/);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/context/context-cache.test.js
// ---------------------------------------------------------------------------
describe("unit/context/context-cache", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { mkdir, readFile, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { hydrateContextRecords, scanContextWithCache } = await import("../../../src/context/context-cache.js");
  const { mkdtemp } = await import("../../helpers/tmp.js");

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

  test("scanContextWithCache skips its own manifest and cache root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-context-cache-self-"));
    const cacheRoot = path.join(root, ".context-cache");
    await writeFile(path.join(root, "README.md"), "# demo\n");

    // First scan writes manifest inside cacheRoot
    await scanContextWithCache({ root, options: { cacheRoot } });
    // Second scan must NOT include the manifest as a context file
    const second = await scanContextWithCache({ root, options: { cacheRoot } });

    const paths = [...second.records.keys()];
    assert.ok(paths.includes("README.md"));
    assert.equal(paths.some((p) => p.includes("manifest.json")), false);
    assert.equal(paths.some((p) => p.includes(".context-cache")), false);
  });

  test("scanContextWithCache resolves relative cacheRoot against project root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-context-relroot-"));
    await writeFile(path.join(root, "README.md"), "# demo\n");

    // Pass a relative cacheRoot — must resolve under root, not cwd
    const result = await scanContextWithCache({ root, options: { cacheRoot: ".context-cache-rel" } });

    assert.ok(result.records.has("README.md"));
    assert.ok(result.manifestPath);
    assert.ok(result.manifestPath.startsWith(root));
    assert.equal(result.manifestPath.includes(".context-cache-rel"), true);
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
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/context/context-manifest.test.js
// ---------------------------------------------------------------------------
describe("unit/context/context-manifest", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { readFile, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { createEmptyManifest, loadContextManifest, saveContextManifest, sanitizeManifestRecord, projectRootHash } = await import("../../../src/context/context-manifest.js");
  const { mkdtemp } = await import("../../helpers/tmp.js");

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
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/context/context-selector.test.js
// ---------------------------------------------------------------------------
describe("unit/context/context-selector", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createContextUnit } = await import("../../../src/context/context-unit.js");
  const { detectMentionedPaths, rankContextUnits, selectContextUnits } = await import("../../../src/context/context-selector.js");

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
      ["src/apps/tui/tui-app.js", unit("src/apps/tui/tui-app.js")]
    ]);

    assert.deepEqual(
      detectMentionedPaths("please inspect README.md and tui-app.js", index),
      new Set(["README.md", "src/apps/tui/tui-app.js"])
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
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/context/context-snapshot.test.js
// ---------------------------------------------------------------------------
describe("unit/context/context-snapshot", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createContextUnit } = await import("../../../src/context/context-unit.js");
  const { buildContextSnapshot } = await import("../../../src/context/context-snapshot.js");

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
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/context/context-unit.test.js
// ---------------------------------------------------------------------------
describe("unit/context/context-unit", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createContextUnit, estimateTokens, priorityForPath, clipSnippet } = await import("../../../src/context/context-unit.js");

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
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/context/token-budget.test.js
// ---------------------------------------------------------------------------
describe("unit/context/token-budget", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { budgetForChannel, selectWithinBudget } = await import("../../../src/context/token-budget.js");

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
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/context/workspace-indexer.test.js
// ---------------------------------------------------------------------------
describe("unit/context/workspace-indexer", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { indexWorkspace, shouldSkipContextPath } = await import("../../../src/context/workspace-indexer.js");
  const { mkdtemp } = await import("../../helpers/tmp.js");

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

  test("shouldSkipContextPath blocks hidden config dirs and credential-like files", () => {
    assert.equal(shouldSkipContextPath(".claude/settings.local.json"), true);
    assert.equal(shouldSkipContextPath(".cursor/rules.md"), true);
    assert.equal(shouldSkipContextPath(".vscode/settings.json"), true);
    assert.equal(shouldSkipContextPath(".idea/workspace.xml"), true);
    assert.equal(shouldSkipContextPath(".codex/config.toml"), true);
    assert.equal(shouldSkipContextPath(".gemini/settings.yaml"), true);
    assert.equal(shouldSkipContextPath(".npmrc"), true);
    assert.equal(shouldSkipContextPath(".pypirc"), true);
    assert.equal(shouldSkipContextPath("config/credentials.json"), true);
    assert.equal(shouldSkipContextPath("secrets/token.txt"), true);
    assert.equal(shouldSkipContextPath("auth/apikey.yml"), true);
    assert.equal(shouldSkipContextPath(".github/workflows/ci.yml"), false);
    assert.equal(shouldSkipContextPath(".config/app.yaml"), false);
  });

  test("indexWorkspace skips hidden tool directories", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-context-hidden-"));
    await writeFile(path.join(root, "README.md"), "# demo\n");
    await mkdir(path.join(root, ".claude"), { recursive: true });
    await writeFile(path.join(root, ".claude", "settings.local.json"), "{}");
    await mkdir(path.join(root, ".vscode"), { recursive: true });
    await writeFile(path.join(root, ".vscode", "settings.json"), "{}");

    const result = await indexWorkspace({ root });

    assert.ok(result.units.has("README.md"));
    assert.equal(result.units.has(".claude/settings.local.json"), false);
    assert.equal(result.units.has(".vscode/settings.json"), false);
    // v1.19.0 起隐藏工具目录由遍历层（walkWorkspaceFiles 的 shouldSkipTraversalSegment）
    // 直接排除，索引器根本不会看到它们，因此 scanned_files 只剩 README.md，
    // skipped_files 也不再为它们记账（跳过原因分类仍由 shouldSkipContextPath 覆盖）。
    assert.equal(result.stats.scanned_files, 1);
    assert.equal(result.stats.skipped_files, 0);
  });
});
