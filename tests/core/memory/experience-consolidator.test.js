import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createConsolidator } from "../../../src/core/memory/experience-consolidator.js";
import { createExperienceStore } from "../../../src/core/memory/experience-store.js";
import { mkdtemp } from "../../helpers/tmp.js";

const NOW = () => Date.parse("2026-02-01T00:00:00Z");
async function tmpDir() { return mkdtemp(path.join(os.tmpdir(), "exp-con-")); }
const cfg = { maxLessonsPerTask: 5, cap: 200, thresholds: { T1: 0.7, T2: 0.4, T3: 0.2 }, decayPerDay: 0.02, dedupThreshold: 0.6 };
const entry = (id, over = {}) => ({
  id, kind: "procedural", lesson: "L" + id, cues: ["auth", "login"], provenance: { taskId: "t" },
  confidence: 0.5, validations: 0, misleads: 0, created: "2026-01-01T00:00:00Z", lastReinforced: "2026-01-01T00:00:00Z", tier: 2, ...over
});

test("distills valid lessons into the store", async () => {
  const dir = await tmpDir();
  const store = createExperienceStore({ dir, now: NOW });
  const callModel = async () => JSON.stringify([{ kind: "procedural", lesson: "prefer X over Y", cues: ["auth", "login"], confidence: 0.5 }]);
  const c = createConsolidator({ callModel, store, now: NOW, cfg });
  await c.consolidate({ message: "do X", outcome: "complete", allCollected: [], adoptedExperienceIds: [], taskId: "task1" });
  await store.flush();
  assert.equal(store.all().length, 1);
  assert.equal(store.all()[0].lesson, "prefer X over Y");
});

test("malformed model output → no consolidation, no crash", async () => {
  const dir = await tmpDir();
  const store = createExperienceStore({ dir, now: NOW });
  let calls = 0;
  const callModel = async () => { calls += 1; return "not json at all"; };
  const c = createConsolidator({ callModel, store, now: NOW, cfg, maxRepairs: 1 });
  await c.consolidate({ message: "x", outcome: "complete", allCollected: [], taskId: "t" });
  await store.flush();
  assert.equal(store.all().length, 0);
  assert.equal(calls, 2); // maxRepairs+1
});

test("low-info-only cues lesson is skipped", async () => {
  const dir = await tmpDir();
  const store = createExperienceStore({ dir, now: NOW });
  const callModel = async () => JSON.stringify([{ kind: "procedural", lesson: "vague", cues: ["test", "file"], confidence: 0.5 }]);
  const c = createConsolidator({ callModel, store, now: NOW, cfg });
  await c.consolidate({ message: "x", outcome: "complete", allCollected: [], taskId: "t" });
  await store.flush();
  assert.equal(store.all().length, 0);
});

test("adopted + outcome complete reinforces (validations++)", async () => {
  const dir = await tmpDir();
  const store = createExperienceStore({ dir, now: NOW });
  await store.put(entry("e1", { validations: 1 }));
  const callModel = async () => "[]";
  const c = createConsolidator({ callModel, store, now: NOW, cfg });
  await c.consolidate({ message: "x", outcome: "complete", allCollected: [], adoptedExperienceIds: ["e1"], taskId: "t" });
  await store.flush();
  assert.equal(store.get("e1").validations, 2);
  assert.equal(store.get("e1").lastReinforced, "2026-02-01T00:00:00.000Z");
});

test("adopted + non-complete outcome weakens (misleads++)", async () => {
  const dir = await tmpDir();
  const store = createExperienceStore({ dir, now: NOW });
  await store.put(entry("e1", { misleads: 0 }));
  const callModel = async () => "[]";
  const c = createConsolidator({ callModel, store, now: NOW, cfg });
  await c.consolidate({ message: "x", outcome: "partial", allCollected: [], adoptedExperienceIds: ["e1"], taskId: "t" });
  await store.flush();
  assert.equal(store.get("e1").misleads, 1);
});

test("adopted=[] leaves library untouched", async () => {
  const dir = await tmpDir();
  const store = createExperienceStore({ dir, now: NOW });
  await store.put(entry("e1", { validations: 5 }));
  const callModel = async () => "[]";
  const c = createConsolidator({ callModel, store, now: NOW, cfg });
  await c.consolidate({ message: "x", outcome: "complete", allCollected: [], adoptedExperienceIds: [], taskId: "t" });
  await store.flush();
  assert.equal(store.get("e1").validations, 5);
});

test("confidence is clamped into [0.2, 0.6]", async () => {
  const dir = await tmpDir();
  const store = createExperienceStore({ dir, now: NOW });
  const callModel = async () => JSON.stringify([{ kind: "procedural", lesson: "overconfident", cues: ["auth", "login"], confidence: 0.99 }]);
  const c = createConsolidator({ callModel, store, now: NOW, cfg });
  await c.consolidate({ message: "x", outcome: "complete", allCollected: [], taskId: "t" });
  await store.flush();
  assert.equal(store.all()[0].confidence, 0.6);
});
