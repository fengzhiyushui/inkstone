import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createConsolidator } from "../../../src/core/memory/experience-consolidator.js";
import { createExperienceStore } from "../../../src/core/memory/experience-store.js";
import { mkdtemp } from "../../helpers/tmp.js";

const NOW = () => Date.parse("2026-02-01T00:00:00Z");
const cfg = { maxLessonsPerTask: 5, cap: 200, thresholds: { T1: 0.7, T2: 0.4, T3: 0.2 }, decayPerDay: 0.02, dedupThreshold: 0.6 };
async function tmpDir() { return mkdtemp(path.join(os.tmpdir(), "exp-gated-")); }
const riskLesson = () => JSON.stringify([{ kind: "risk", lesson: "rm -rf wipes the db", cues: ["migrate", "delete"], confidence: 0.5 }]);
const procLesson = () => JSON.stringify([{ kind: "procedural", lesson: "prefer pooled connections", cues: ["pool", "connection"], confidence: 0.5 }]);

test("gated: risk-kind lesson goes to pending (not live), onPending fired", async () => {
  const dir = await tmpDir();
  const store = createExperienceStore({ dir, now: NOW });
  const pendings = [];
  const c = createConsolidator({ callModel: async () => riskLesson(), store, now: NOW, cfg, mode: "gated", onPending: (i) => pendings.push(i) });
  const r = await c.consolidate({ message: "x", outcome: "complete", allCollected: [], taskId: "t" });
  await store.flush();
  assert.equal(store.all().length, 0);
  assert.equal(store.listPending().length, 1);
  assert.equal(pendings.length, 1);
  assert.equal(r.pending, 1);
  assert.equal(r.written, 0);
});

test("gated: procedural lesson goes live directly (only risk is gated)", async () => {
  const dir = await tmpDir();
  const store = createExperienceStore({ dir, now: NOW });
  const c = createConsolidator({ callModel: async () => procLesson(), store, now: NOW, cfg, mode: "gated" });
  await c.consolidate({ message: "x", outcome: "complete", allCollected: [], taskId: "t" });
  await store.flush();
  assert.equal(store.all().length, 1);
  assert.equal(store.listPending().length, 0);
});

test("on mode: risk-kind goes live (no gating)", async () => {
  const dir = await tmpDir();
  const store = createExperienceStore({ dir, now: NOW });
  const c = createConsolidator({ callModel: async () => riskLesson(), store, now: NOW, cfg, mode: "on" });
  await c.consolidate({ message: "x", outcome: "complete", allCollected: [], taskId: "t" });
  await store.flush();
  assert.equal(store.all().length, 1);
  assert.equal(store.all()[0].kind, "risk");
});

test("resolvePending approve commits the staged risk entry to live", async () => {
  const dir = await tmpDir();
  const store = createExperienceStore({ dir, now: NOW });
  const c = createConsolidator({ callModel: async () => riskLesson(), store, now: NOW, cfg, mode: "gated" });
  await c.consolidate({ message: "x", outcome: "complete", allCollected: [], taskId: "t" });
  await store.flush();
  const [p] = store.listPending();
  await store.resolvePending(p.pendingId, "approve");
  await store.flush();
  assert.equal(store.all().length, 1);
  assert.equal(store.listPending().length, 0);
});

test("prunePending auto-denies expired pending (TTL), keeps fresh", async () => {
  const dir = await tmpDir();
  const store = createExperienceStore({ dir, now: () => Date.parse("2026-02-02T00:00:00Z") });
  const entry = { id: "e1", kind: "risk", lesson: "L", cues: ["a", "b"], provenance: { taskId: "t" }, confidence: 0.5, validations: 0, misleads: 0, created: "2026-01-01T00:00:00Z", lastReinforced: "2026-01-01T00:00:00Z", tier: 3 };
  await store.putPending({ pendingId: "old", entry, created: "2026-01-01T00:00:00Z" }); // ~32d old
  await store.putPending({ pendingId: "fresh", entry: { ...entry, id: "e2" }, created: "2026-02-02T00:00:00Z" });
  await store.prunePending(86400000); // 1-day TTL
  await store.flush();
  const ids = store.listPending().map((p) => p.pendingId);
  assert.deepEqual(ids, ["fresh"]);
});
