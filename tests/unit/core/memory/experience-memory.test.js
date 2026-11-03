// tests/unit/core/memory/experience-memory.test.js — 经验记忆(schema/评分/聚类/存储/检索/整合)领域测试
//
// v1.19.1 测试归并:本文件由下列历史任务单测试合并而成,每个来源包裹在独立
// describe 块中(异步回调 + 动态 import,来源间零共享绑定),测试语义与拆分前一致。
import { describe } from "node:test";

// ---------------------------------------------------------------------------
// 来源:tests/core/memory/experience-schema.test.js
// ---------------------------------------------------------------------------
describe("core/memory/experience-schema", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { validateEntry, validatePending, FILE_SCHEMA_VERSION, clamp01 } = await import("../../../../src/core/memory/experience-schema.js");

  const mkEntry = (over = {}) => ({
    id: "exp_1", kind: "procedural", lesson: "x", cues: ["a", "b"],
    provenance: { taskId: "t1" }, confidence: 0.5, validations: 0, misleads: 0,
    created: "2026-01-01T00:00:00Z", lastReinforced: "2026-01-01T00:00:00Z", tier: 3, ...over
  });

  test("FILE_SCHEMA_VERSION is file-level constant", () => {
    assert.equal(FILE_SCHEMA_VERSION, 1);
  });

  test("validateEntry accepts a well-formed entry, rejects bad kind/confidence/cues", () => {
    assert.equal(validateEntry(mkEntry()), null);
    assert.match(validateEntry(mkEntry({ kind: "wat" })), /kind/);
    assert.match(validateEntry(mkEntry({ confidence: 2 })), /confidence/);
    assert.match(validateEntry(mkEntry({ cues: [] })), /cues/);
    assert.match(validateEntry(mkEntry({ tier: 4 })), /tier/);
    assert.match(validateEntry(mkEntry({ validations: -1 })), /validations/);
  });

  test("validatePending requires pendingId + valid entry", () => {
    assert.equal(validatePending({ pendingId: "p1", entry: mkEntry() }), null);
    assert.match(validatePending({ entry: mkEntry() }), /pendingId/);
    assert.match(validatePending({ pendingId: "p1", entry: mkEntry({ kind: "x" }) }), /kind/);
  });

  test("clamp01 clamps to [0,1]", () => {
    assert.equal(clamp01(-1), 0);
    assert.equal(clamp01(2), 1);
    assert.equal(clamp01(0.3), 0.3);
    assert.equal(clamp01("nan"), 0);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/core/memory/experience-scoring.test.js
// ---------------------------------------------------------------------------
describe("core/memory/experience-scoring", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { score, tierOf, reinforce, weaken, daysSince } = await import("../../../../src/core/memory/experience-scoring.js");

  const T = { T1: 0.7, T2: 0.4, T3: 0.2 };
  const base = { confidence: 0.5, validations: 0, misleads: 0, lastReinforced: "2026-01-01T00:00:00Z" };
  const now0 = () => new Date("2026-01-01T00:00:00Z").getTime();
  const later = () => new Date("2026-02-01T00:00:00Z").getTime(); // +31d

  test("validations raise score, misleads lower it", () => {
    assert.ok(score({ ...base, validations: 5 }, now0) > score(base, now0));
    assert.ok(score({ ...base, misleads: 2 }, now0) < score(base, now0));
  });

  test("aging decays score over time (decayPerDay default 0.02)", () => {
    assert.ok(score(base, later) < score(base, now0));
  });

  test("score is clamped to [0,1]", () => {
    assert.equal(score({ confidence: 1, validations: 50, misleads: 0, lastReinforced: "2026-01-01T00:00:00Z" }, now0), 1);
    assert.equal(score({ confidence: 0, validations: 0, misleads: 10, lastReinforced: "2026-01-01T00:00:00Z" }, now0), 0);
  });

  test("decayPerDay is configurable", () => {
    const fast = score(base, later, { decayPerDay: 0.05 });
    const slow = score(base, later, { decayPerDay: 0.001 });
    assert.ok(fast < slow);
  });

  test("tierOf boundaries: T1/T2/T3 and evict(0)", () => {
    assert.equal(tierOf(0.75, T), 1);
    assert.equal(tierOf(0.7, T), 1);
    assert.equal(tierOf(0.5, T), 2);
    assert.equal(tierOf(0.4, T), 2);
    assert.equal(tierOf(0.25, T), 3);
    assert.equal(tierOf(0.2, T), 3);
    assert.equal(tierOf(0.1, T), 0); // below T3 => evict
  });

  test("reinforce bumps validations + lastReinforced; weaken bumps misleads", () => {
    const r = reinforce({ ...base, validations: 1 }, now0);
    assert.equal(r.validations, 2);
    assert.equal(r.lastReinforced, "2026-01-01T00:00:00.000Z");
    assert.equal(weaken({ ...base, misleads: 0 }).misleads, 1);
  });

  test("daysSince computes whole-day delta", () => {
    assert.equal(daysSince("2026-01-01T00:00:00Z", later), 31);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/core/memory/experience-cluster.test.js
// ---------------------------------------------------------------------------
describe("core/memory/experience-cluster", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { normalizeCues, jaccard, cluster, effectiveCues } = await import("../../../../src/core/memory/experience-cluster.js");

  test("normalizeCues: lowercase, dedupe, sort, drop stopwords/low-info", () => {
    assert.deepEqual(normalizeCues(["Test", "Auth", "auth", "the"]), ["auth"]);
    assert.deepEqual(normalizeCues(["zebra", "apple"]), ["apple", "zebra"]); // sorted
  });

  test("code path/command kept as a single cue (not split, not dropped)", () => {
    assert.ok(normalizeCues(["src/index.js"]).includes("src/index.js"));
    assert.ok(normalizeCues(["npm run build"]).length >= 1);
  });

  test("jaccard symmetric + bounds", () => {
    assert.equal(jaccard(["a", "b"], ["a", "b"]), 1);
    assert.equal(jaccard(["a"], ["b"]), 0);
    assert.equal(jaccard(["a", "b", "c"], ["b", "c"]), jaccard(["b", "c"], ["a", "b", "c"]));
    assert.equal(jaccard([], []), 0);
  });

  test("effectiveCues guard: low-info excluded, <2 effective => not clusterable", () => {
    assert.deepEqual(effectiveCues(["auth", "login"]).sort(), ["auth", "login"]);
    assert.equal(effectiveCues(["test"]).length, 0);
    assert.equal(effectiveCues(["file", "error"]).length, 0);
  });

  test("cluster never merges across kind, keeps highest tier, sums validations", () => {
    const A = { id: "a", kind: "procedural", lesson: "LA", cues: ["auth", "login"], tier: 3, validations: 1, provenance: { taskId: "tA" } };
    const B = { id: "b", kind: "procedural", lesson: "LB", cues: ["auth", "login", "session"], tier: 1, validations: 2, provenance: { taskId: "tB" } };
    const R = { id: "r", kind: "risk", lesson: "LR", cues: ["auth", "login"], tier: 2, validations: 0, provenance: { taskId: "tR" } };
    const out = cluster([A, B, R], { dedupThreshold: 0.6 });
    const proc = out.filter((e) => e.kind === "procedural");
    assert.equal(proc.length, 1);
    assert.equal(proc[0].tier, 1);          // highest tier (B) survives
    assert.equal(proc[0].lesson, "LB");
    assert.equal(proc[0].validations, 3);   // 1 + 2
    assert.ok(proc[0].cues.includes("session")); // union
    assert.equal(out.filter((e) => e.kind === "risk").length, 1); // risk never merged into procedural
  });

  test("cluster leaves low-effective-cue entries as singletons", () => {
    const X = { id: "x", kind: "procedural", lesson: "LX", cues: ["test"], tier: 3, validations: 0, provenance: {} };
    const Y = { id: "y", kind: "procedural", lesson: "LY", cues: ["test"], tier: 3, validations: 0, provenance: {} };
    const out = cluster([X, Y], { dedupThreshold: 0.6 });
    assert.equal(out.length, 2); // not merged (each <2 effective cues)
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/core/memory/experience-store.test.js
// ---------------------------------------------------------------------------
describe("core/memory/experience-store", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { promises: fs } = await import("node:fs");
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { createExperienceStore } = await import("../../../../src/core/memory/experience-store.js");
  const { mkdtemp } = await import("../../../helpers/tmp.js");

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
});

// ---------------------------------------------------------------------------
// 来源:tests/core/memory/experience-upsert.test.js
// ---------------------------------------------------------------------------
describe("core/memory/experience-upsert", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { promises: fs } = await import("node:fs");
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { upsert } = await import("../../../../src/core/memory/experience-upsert.js");
  const { createExperienceStore } = await import("../../../../src/core/memory/experience-store.js");
  const { mkdtemp } = await import("../../../helpers/tmp.js");

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
});

// ---------------------------------------------------------------------------
// 来源:tests/core/memory/experience-retrieval.test.js
// ---------------------------------------------------------------------------
describe("core/memory/experience-retrieval", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { promises: fs } = await import("node:fs");
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { query, cuesFromText } = await import("../../../../src/core/memory/experience-retrieval.js");
  const { createExperienceStore } = await import("../../../../src/core/memory/experience-store.js");
  const { mkdtemp } = await import("../../../helpers/tmp.js");

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
});

// ---------------------------------------------------------------------------
// 来源:tests/core/memory/experience-consolidator.test.js
// ---------------------------------------------------------------------------
describe("core/memory/experience-consolidator", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { promises: fs } = await import("node:fs");
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { createConsolidator } = await import("../../../../src/core/memory/experience-consolidator.js");
  const { createExperienceStore } = await import("../../../../src/core/memory/experience-store.js");
  const { mkdtemp } = await import("../../../helpers/tmp.js");

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
});

// ---------------------------------------------------------------------------
// 来源:tests/core/memory/experience-gated.test.js
// ---------------------------------------------------------------------------
describe("core/memory/experience-gated", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { promises: fs } = await import("node:fs");
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { createConsolidator } = await import("../../../../src/core/memory/experience-consolidator.js");
  const { createExperienceStore } = await import("../../../../src/core/memory/experience-store.js");
  const { mkdtemp } = await import("../../../helpers/tmp.js");

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
});
