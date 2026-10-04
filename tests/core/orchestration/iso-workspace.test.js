import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os"; import path from "node:path"; import { promises as fs } from "node:fs";
import { createIso, removeIso, sweepOrphans } from "../../../src/core/orchestration/iso-workspace.js";
import { mkdtemp } from "../../helpers/tmp.js";

async function tmp() { return mkdtemp(path.join(os.tmpdir(), "iso-")); }
const exists = (p) => fs.access(p).then(() => true, () => false);

test("createIso makes dir + .owner; removeIso deletes it", async () => {
  const root = await tmp();
  const iso = await createIso({ root, runId: "run1", subtaskId: "st_1" });
  assert.ok(await exists(iso));
  assert.ok(await exists(path.join(root, ".deepseek-code/v2/orchestration/iso/run1/.owner")));
  assert.equal(await removeIso(iso), true);
  assert.equal(await exists(iso), false);
});

test("sweepOrphans removes stale runs but keeps fresh non-owned ones", async () => {
  const root = await tmp();
  await createIso({ root, runId: "old", subtaskId: "st_1" });
  await createIso({ root, runId: "fresh", subtaskId: "st_1" });
  const base = path.join(root, ".deepseek-code/v2/orchestration/iso");
  // old: another pid + stale ts -> removed; fresh: another pid + fresh ts -> kept
  await fs.writeFile(path.join(base, "old/.owner"), JSON.stringify({ pid: 999999, ts: Date.now() - 10 * 3600 * 1000 }));
  await fs.writeFile(path.join(base, "fresh/.owner"), JSON.stringify({ pid: 111111, ts: Date.now() }));
  const swept = await sweepOrphans({ root, ttlMs: 3600000, pid: process.pid });
  assert.equal(await exists(path.join(base, "old")), false);
  assert.equal(await exists(path.join(base, "fresh")), true);
  assert.ok(swept.some((d) => d.includes("old")));
});
