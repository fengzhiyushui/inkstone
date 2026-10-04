import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { query, cuesFromText } from "../../../src/core/memory/experience-retrieval.js";
import { createExperienceStore } from "../../../src/core/memory/experience-store.js";
import { mkdtemp } from "../../helpers/tmp.js";

const NOW = () => Date.parse("2026-01-01T00:00:00Z");
async function tmpDir() { return mkdtemp(path.join(os.tmpdir(), "exp-ret-")); }
const entry = (id, over = {}) => ({
  id, kind: "procedural", lesson: "L" + id, cues: ["auth", "login"], provenance: { taskId: "t" },
  confidence: 0.5, validations: 0, misleads: 0, created: "2026-01-01T00:00:00Z", lastReinforced: "2026-01-01T00:00:00Z", tier: 2, ...over
});

test("cuesFromText normalizes a sentence into cues", () => {
  assert.ok(cuesFromText("Fix the AUTH login flow").includes("auth"));
  assert.ok(!cuesFromText("Fix the auth login").includes("the")); // stopword
});

test("ranks by cue overlap × tier weight, excludes non-overlapping", async () => {
  const dir = await tmpDir();
  const s = createExperienceStore({ dir, now: NOW });
  await s.put(entry("e1", { tier: 1, cues: ["auth", "login"] }));
  await s.put(entry("e2", { tier: 3, cues: ["auth", "login"] }));
  await s.put(entry("e3", { tier: 1, cues: ["deploy", "pipeline"] }));
  const r = query(s, { message: "fix the auth login flow" }, { retrieveK: 5 });
  assert.deepEqual(r.presentedIds, ["e1", "e2"]); // e1 (2*3) > e2 (2*1); e3 no overlap
  assert.equal(r.procedural[0].lesson, "Le1");
});

test("top-K caps the brief", async () => {
  const dir = await tmpDir();
  const s = createExperienceStore({ dir, now: NOW });
  for (let i = 0; i < 5; i++) await s.put(entry("e" + i, { cues: ["auth", "login", "x" + i] }));
  const r = query(s, { message: "auth login" }, { retrieveK: 2 });
  assert.equal(r.presentedIds.length, 2);
});

test("risk entries feed riskCues, not the procedural brief", async () => {
  const dir = await tmpDir();
  const s = createExperienceStore({ dir, now: NOW });
  await s.put(entry("r1", { kind: "risk", cues: ["migrate", "schema"] }));
  const r = query(s, { message: "migrate the schema now" }, { retrieveK: 5 });
  assert.equal(r.procedural.length, 0);
  assert.ok(r.riskCues.has("migrate"));
  assert.ok(r.riskCues.has("schema"));
});

test("entries with <2 effective cues are skipped", async () => {
  const dir = await tmpDir();
  const s = createExperienceStore({ dir, now: NOW });
  await s.put(entry("e1", { cues: ["test", "auth"] })); // only 'auth' effective => skipped
  const r = query(s, { message: "auth" }, { retrieveK: 5 });
  assert.equal(r.presentedIds.length, 0);
});

test("query is read-only (store unchanged)", async () => {
  const dir = await tmpDir();
  const s = createExperienceStore({ dir, now: NOW });
  await s.put(entry("e1"));
  query(s, { message: "auth login" }, { retrieveK: 5 });
  assert.equal(s.all().length, 1);
  assert.equal(s.get("e1").validations, 0);
});
