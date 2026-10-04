import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { upsert } from "../../../src/core/memory/experience-upsert.js";
import { createExperienceStore } from "../../../src/core/memory/experience-store.js";
import { mkdtemp } from "../../helpers/tmp.js";

const T = { T1: 0.7, T2: 0.4, T3: 0.2 };
const NOW = () => Date.parse("2026-01-01T00:00:00Z");
const cfg = (over = {}) => ({ now: NOW, cap: 200, thresholds: T, decayPerDay: 0.02, dedupThreshold: 0.6, ...over });
async function tmpDir() { return mkdtemp(path.join(os.tmpdir(), "exp-up-")); }
const cand = (id, over = {}) => ({
  id, kind: "procedural", lesson: "L" + id, cues: ["c" + id, "common"], provenance: { taskId: "t" },
  confidence: 0.5, validations: 0, misleads: 0, created: "2026-01-01T00:00:00Z", lastReinforced: "2026-01-01T00:00:00Z", tier: 3, ...over
});
const evLog = (dir) => fs.readFile(path.join(dir, "experience-evictions.jsonl"), "utf8").catch(() => "");

test("new candidate enters at the tier its score maps to", async () => {
  const dir = await tmpDir();
  const s = createExperienceStore({ dir, now: NOW });
  await upsert(s, cand("1", { confidence: 0.5 }), cfg());
  await s.flush();
  assert.equal(s.all().length, 1);
  assert.equal(s.get("1").tier, 2); // 0.5 -> tier2
});

test("near-duplicate merges: one survivor, summed validations, highest tier", async () => {
  const dir = await tmpDir();
  const s = createExperienceStore({ dir, now: NOW });
  await upsert(s, cand("1", { cues: ["auth", "login"], confidence: 0.5, validations: 1, tier: 3 }), cfg());
  await upsert(s, cand("2", { cues: ["auth", "login", "session"], confidence: 0.75, validations: 2, tier: 1 }), cfg());
  await s.flush();
  assert.equal(s.all().length, 1);
  assert.equal(s.all()[0].validations, 3);
  assert.equal(s.all()[0].tier, 1);
});

test("candidate scoring below T3 is rejected and logged", async () => {
  const dir = await tmpDir();
  const s = createExperienceStore({ dir, now: NOW });
  await upsert(s, cand("1", { confidence: 0.1, cues: ["x1", "y1"] }), cfg());
  await s.flush();
  assert.equal(s.all().length, 0);
  assert.match(await evLog(dir), /below_tier3/);
});

test("over cap evicts lowest score, logs over_cap, keeps top", async () => {
  const dir = await tmpDir();
  const s = createExperienceStore({ dir, now: NOW });
  const c = cfg({ cap: 2 });
  await upsert(s, cand("1", { confidence: 0.9, cues: ["a1", "z"] }), c);
  await upsert(s, cand("2", { confidence: 0.8, cues: ["a2", "z"] }), c);
  await upsert(s, cand("3", { confidence: 0.3, cues: ["a3", "z"] }), c);
  await s.flush();
  assert.equal(s.all().length, 2);
  assert.equal(s.get("3"), null);          // lowest score evicted
  assert.match(await evLog(dir), /over_cap/);
});
