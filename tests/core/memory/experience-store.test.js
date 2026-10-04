import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createExperienceStore } from "../../../src/core/memory/experience-store.js";
import { mkdtemp } from "../../helpers/tmp.js";

const mkEntry = (id, over = {}) => ({
  id, kind: "procedural", lesson: "L" + id, cues: ["a" + id, "b"],
  provenance: { taskId: "t" }, confidence: 0.5, validations: 0, misleads: 0,
  created: "2026-01-01T00:00:00Z", lastReinforced: "2026-01-01T00:00:00Z", tier: 3, ...over
});
async function tmpDir() { return mkdtemp(path.join(os.tmpdir(), "exp-")); }
const nowIso = () => "2026-01-01T00:00:00Z";

test("put/get/all/remove round-trip + atomic persistence reloads", async () => {
  const dir = await tmpDir();
  const s = createExperienceStore({ dir, now: nowIso });
  await s.put(mkEntry("1"));
  await s.put(mkEntry("2"));
  assert.equal(s.all().length, 2);
  assert.equal(s.get("1").id, "1");
  await s.remove("1", "below_tier3");
  assert.equal(s.all().length, 1);

  const s2 = createExperienceStore({ dir, now: nowIso });
  await s2.flush();
  assert.deepEqual(s2.all().map((e) => e.id), ["2"]);
});

test("put replaces by id (no duplicate)", async () => {
  const dir = await tmpDir();
  const s = createExperienceStore({ dir, now: nowIso });
  await s.put(mkEntry("1", { lesson: "first" }));
  await s.put(mkEntry("1", { lesson: "second" }));
  assert.equal(s.all().length, 1);
  assert.equal(s.get("1").lesson, "second");
});

test("concurrent writes serialize without lost update", async () => {
  const dir = await tmpDir();
  const s = createExperienceStore({ dir, now: nowIso });
  await Promise.all(Array.from({ length: 20 }, (_, i) => s.put(mkEntry(String(i)))));
  assert.equal(s.all().length, 20);
  const s2 = createExperienceStore({ dir, now: nowIso });
  await s2.flush();
  assert.equal(s2.all().length, 20);
});

test("schemaVersion mismatch loads empty (conservative)", async () => {
  const dir = await tmpDir();
  await fs.writeFile(path.join(dir, "experience.json"), JSON.stringify({ schemaVersion: 999, entries: [mkEntry("z")] }));
  const s = createExperienceStore({ dir, now: nowIso });
  await s.flush();
  assert.equal(s.all().length, 0);
});

test("invalid entry rejected", async () => {
  const dir = await tmpDir();
  const s = createExperienceStore({ dir, now: nowIso });
  await assert.rejects(() => s.put({ id: "x", kind: "bad" }), /invalid/);
});

test("pending area is separate from live library", async () => {
  const dir = await tmpDir();
  const s = createExperienceStore({ dir, now: nowIso });
  await s.putPending({ pendingId: "p1", entry: mkEntry("e1", { kind: "risk" }) });
  assert.equal(s.all().length, 0);
  assert.equal(s.listPending().length, 1);
  await s.resolvePending("p1", "approve");
  assert.equal(s.all().length, 1);
  assert.equal(s.listPending().length, 0);
  assert.equal(s.get("e1").kind, "risk");
});

test("resolvePending deny drops without committing", async () => {
  const dir = await tmpDir();
  const s = createExperienceStore({ dir, now: nowIso });
  await s.putPending({ pendingId: "p2", entry: mkEntry("e2") });
  await s.resolvePending("p2", "deny");
  assert.equal(s.all().length, 0);
  assert.equal(s.listPending().length, 0);
});
