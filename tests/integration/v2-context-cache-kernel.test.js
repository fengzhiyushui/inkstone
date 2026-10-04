import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createKernel } from "../../src/index.js";
import { mkdtemp } from "../helpers/tmp.js";

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
