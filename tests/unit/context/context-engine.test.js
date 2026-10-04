import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEventBus } from "../../../src/shared/event-bus.js";
import { createContextEngine } from "../../../src/context/index.js";
import { mkdtemp } from "../../helpers/tmp.js";

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
