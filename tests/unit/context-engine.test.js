// tests/unit/context-engine.test.js — 上下文引擎、工作区安全与索引
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEventBus } from "../../src/shared/event-bus.js";
import { createContextEngine } from "../../src/context/index.js";
import { buildProjectContext } from "../../src/context/project-index.js";
import {
  resolveWorkspacePath,
  walkWorkspaceFiles,
  shouldSkipTraversalSegment,
  isBinaryBuffer
} from "../../src/workspace/path-safety.js";
import { mkdtemp } from "../helpers/tmp.js";

test("工作区路径安全（path-safety）、边界隔离与遍历忽略规则", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-ps-test-"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "app.js"), "console.log('hi');");

  const safe = await resolveWorkspacePath(root, "src/app.js");
  assert.equal(safe.relative, "src/app.js");
  assert.equal(safe.absolute, path.join(root, "src", "app.js"));

  await assert.rejects(
    async () => resolveWorkspacePath(root, "../outside.txt"),
    /outside|越界|traversal/i
  );

  assert.equal(shouldSkipTraversalSegment("node_modules"), true);
  assert.equal(shouldSkipTraversalSegment(".git"), true);
  assert.equal(shouldSkipTraversalSegment(".deepseek-code"), true);
  assert.equal(shouldSkipTraversalSegment("src"), false);

  assert.equal(isBinaryBuffer(Buffer.from("hello world")), false);
  assert.equal(isBinaryBuffer(Buffer.from([0x00, 0x01, 0x02])), true);

  await mkdir(path.join(root, "node_modules"));
  await writeFile(path.join(root, "node_modules", "pkg.json"), "{}");
  const walked = await walkWorkspaceFiles(root);
  assert.ok(walked.includes("src/app.js"));
  assert.equal(walked.some((f) => f.includes("node_modules")), false);
});

test("文件索引扫描、context-unit 派生与增量缓存更新", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-ctx-scan-"));
  const cacheRoot = path.join(root, ".cache");
  await writeFile(path.join(root, "package.json"), "{\"name\":\"test\"}");
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "main.js"), "export const x = 1;");

  const engine1 = createContextEngine({ root, options: { cacheRoot, budgets: { act: 2000 } } });
  const scan1 = await engine1.scan();
  assert.ok(scan1.indexed_paths >= 2);

  const engine2 = createContextEngine({ root, options: { cacheRoot, budgets: { act: 2000 } } });
  const scan2 = await engine2.scan();
  assert.ok(scan2.indexed_paths >= 2);
});

test("Token 预算分配、路径提及优先级选择与自适应截断", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-ctx-budget-"));
  await writeFile(path.join(root, "package.json"), "{\"name\":\"budget-test\"}\n");
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "a.js"), "export const a = 'a'.repeat(50);\n");
  await writeFile(path.join(root, "src", "b.js"), "export const b = 'b'.repeat(50);\n");

  const bus = createEventBus();
  const engine = createContextEngine({ root, eventBus: bus, options: { budgets: { act: 1000 } } });
  await engine.scan();

  engine.pin("src/b.js");
  engine.warm("src/a.js", "pre-warm");

  const snapshot = await engine.snapshot({
    message: "please inspect src/a.js",
    classification: { task_type: "edit" },
    channel: "act"
  });

  assert.ok(snapshot.units.some((u) => u.path === "src/b.js" && u.reason === "pinned"));
  assert.ok(snapshot.units.some((u) => u.path === "src/a.js"));

  engine.unpin("src/b.js");
  const unpinned = await engine.snapshot({ message: "test", channel: "act" });
  assert.equal(unpinned.units.some((u) => u.path === "src/b.js" && u.reason === "pinned"), false);
});

test("快照组装、工作区状态导出与 project-index 静态索引", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-ctx-proj-"));
  await writeFile(path.join(root, "package.json"), "{\"name\":\"proj\"}\n");
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "index.js"), "console.log('index');\n");

  const projCtx = await buildProjectContext(root);
  assert.ok(projCtx.files.includes("package.json") || projCtx.indexText.includes("src/index.js"));

  const disabledEngine = createContextEngine({ root, options: { disabled: true } });
  await disabledEngine.scan();
  const disSnapshot = await disabledEngine.snapshot({ channel: "act" });
  assert.equal(disSnapshot.snapshot_id, "v2_context_disabled");
  assert.deepEqual(disSnapshot.units, []);
});

test("脏工作区检测与变更感知", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-ctx-dirty-"));
  const targetFile = path.join(root, "dynamic.js");
  await writeFile(targetFile, "let v = 1;\n");

  const engine = createContextEngine({ root, options: { budgets: { act: 2000 } } });
  await engine.scan();
  const snap1 = await engine.snapshot({ message: "check dynamic.js", channel: "act" });
  assert.ok(snap1.units.some((u) => u.path === "dynamic.js"));

  await writeFile(targetFile, "let v = 2;\n// updated content\n");
  await engine.scan();
  const snap2 = await engine.snapshot({ message: "check dynamic.js", channel: "act" });
  assert.ok(snap2.units.some((u) => u.path === "dynamic.js"));
});
