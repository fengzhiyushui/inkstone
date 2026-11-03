// tests/integration/kernel-context-and-edits.test.js — 内核上下文与编辑工具集成领域测试
//
// v1.19.1 测试归并:本文件由下列历史任务单测试合并而成,每个来源包裹在独立
// describe 块中(异步回调 + 动态 import,来源间零共享绑定),测试语义与拆分前一致。
import { describe } from "node:test";

// ---------------------------------------------------------------------------
// 来源:tests/integration/v2-context-kernel.test.js
// ---------------------------------------------------------------------------
describe("integration/v2-context-kernel", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { createKernel } = await import("../../src/index.js");
  const { mkdtemp } = await import("../helpers/tmp.js");

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
});

// ---------------------------------------------------------------------------
// 来源:tests/integration/v2-context-cache-kernel.test.js
// ---------------------------------------------------------------------------
describe("integration/v2-context-cache-kernel", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { mkdir, readFile, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { createKernel } = await import("../../src/index.js");
  const { mkdtemp } = await import("../helpers/tmp.js");

  test("kernel context cache writes manifest only under injected cache root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-kernel-cache-"));
    const cacheRoot = path.join(root, ".context-cache");
    await writeFile(path.join(root, "README.md"), "# demo\n");
    const kernel = await createKernel(root, {
      sessionRoot: path.join(root, ".sessions"),
      sessionLog: null,
      context: { cacheRoot },
      modelGateway: { reply: async () => ({ content: "ok" }) }
    });

    const stats = kernel.context.getStats();
    const raw = await readFile(path.join(cacheRoot, "manifest.json"), "utf8");

    assert.ok(stats.indexed_paths >= 1);
    assert.equal(raw.includes("# demo"), false);
    assert.equal(raw.includes("snippet"), false);
  });

  test("kernel context cache reuses unchanged records after reopen", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-kernel-cache-reopen-"));
    const cacheRoot = path.join(root, ".context-cache");
    await writeFile(path.join(root, "README.md"), "# demo\n");
    await createKernel(root, {
      sessionRoot: path.join(root, ".sessions-a"),
      sessionLog: null,
      branchStore: null,
      context: { cacheRoot },
      modelGateway: { reply: async () => ({ content: "ok" }) }
    });
    const second = await createKernel(root, {
      sessionRoot: path.join(root, ".sessions-b"),
      sessionLog: null,
      branchStore: null,
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
});

// ---------------------------------------------------------------------------
// 来源:tests/integration/v2-edit-tools-kernel.test.js
// ---------------------------------------------------------------------------
describe("integration/v2-edit-tools-kernel", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { readFile, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { createKernel } = await import("../../src/index.js");
  const { createToolCall } = await import("../../src/core/protocol/index.js");
  const { mkdtemp } = await import("../helpers/tmp.js");

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
    assert.match(result.metadata.change_id, /^\d{14}-[a-f0-9]{6}$/);
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
});
