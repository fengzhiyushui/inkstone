# V3 Phase C4 跨任务经验记忆(完整)实施计划

> 完成状态以 [CHANGELOG](../../CHANGELOG.md) 为准。

> **执行说明:** 按 TDD bite-sized 步骤落地,每个 Task 末「跑测试 + 提交」。全程主控内联(模型调用全 mock,无 429/联网依赖)。
>
> 设计 spec:[2026-06-27-v3-phase-c4-experience-memory-design.md](../../specs/backend/2026-06-27-v3-phase-c4-experience-memory-design.md)。

**Goal:** 给编排加**跨任务经验记忆**:次 agent 在任务边界提炼教训 → 独立经验库(三级分化 + Jaccard 聚簇)→ 新任务 planner 检索影响拆派 + 风险经验单调升级权限;默认 `off` 零回归。

**Architecture:** 新子系统 `src/core/memory/`(纯函数 store/scoring/cluster/retrieval + 次 agent consolidator),接进 `orchestrator`(检索 pre-plan / 后台巩固 + flush)与 `permission-engine`(只升不降 escalation pass)。模型只「提炼教训 + 产审核摘要」,程序逻辑控打分/定级/淘汰/检索/升降/升级。

**Tech Stack:** Node ESM(Node≥20)· node:test · 复用 readonly `agent-runtime` 实例(worker-factory,引擎不改)· `modelGateway.invoke`。

## Global Constraints(每 Task 隐含遵守)

- **`agent-runtime.js` 一行不改**;consolidator/worker 用其现成 readonly runtime;风险升级走 `options.projectRules` 已有转发通道。
- **确定性**:打分/定级/淘汰/聚簇/检索/升降/权限升级全程序逻辑;模型只提炼教训 + 产审核摘要 + `used_experience_ids`。所有时间戳经**注入的 `now`**;遍历/平分按 **id 字典序** tie-break(spec §5.2)。
- **单调权限升级**(spec §9.1):只 `allow→ask`、只覆盖 `default-matrix`、绝不降级/绝不覆盖用户显式 trust/cache;**只作用串行主区 worker**(F8)。
- **默认零回归**:`crossTaskLearning="off"` → 无检索/巩固/升级/事件/目录,`decide()` 输出 byte-equal,现有 **670 全绿不改**。
- **写串行化**:store 内置每实例 async 写队列;唯一 tmp 名(F7/review#2)。
- **强化只认 `adopted = used_experience_ids ∩ presentedIds`**(review#1);`presented\adopted` 不升降。

---

## File Structure

| 文件 | 责任 | 动作 |
|------|------|------|
| `src/core/memory/experience-schema.js` | `ExperienceEntry`/`PendingEntry` 校验 + `FILE_SCHEMA_VERSION` + id 状态流类型注释 | 新建(M0)|
| `src/core/memory/experience-store.js` | 存储 + 写队列 + 原子写 + CRUD/query + pending 待审区 | 新建(M1)|
| `src/core/memory/experience-scoring.js` | 纯:score/tierOf/reinforce/weaken/age | 新建(M2)|
| `src/core/memory/experience-cluster.js` | 纯:cue 归一化 + 护栏 + Jaccard + 合并去重 | 新建(M3)|
| `src/core/memory/experience-upsert.js` | 写管线:聚簇→评分→定级→淘汰→封顶 + eviction 日志 | 新建(M4)|
| `src/core/memory/experience-consolidator.js` | 次 agent 提炼 + adopted 升降 | 新建(M5)|
| `src/core/memory/experience-retrieval.js` | 纯:cues→top-K 简报/presentedIds/riskCues | 新建(M6)|
| `src/core/memory/risk-rules.js` | 纯:riskCues→`escalate_only` projectRules | 新建(M8)|
| `src/core/orchestration/planner.js` | `plan` 收 `experiences`、回 `used_experience_ids` | 改(M6)|
| `src/core/orchestration/subtask-schema.js` | `Plan.used_experience_ids?` 可选 | 改(M6)|
| `src/core/orchestration/dispatch-loop.js` | `worker.send` 加 `projectRules` | 改(M8)|
| `src/core/orchestration/orchestrator.js` | 检索 pre-plan / 后台巩固 + flush / adopted 计算 / 注入风险规则 | 改(M7,M8)|
| `src/tools/permissions/permission-engine.js` | skip `escalate_only` + 单调 escalation pass | 改(M8)|
| `src/config.js` | `crossTaskLearning` + `experience` 归一 | 改(M7)|
| `src/index.js` | 装配 memory 子系统 + `kernel.experience` facade + flush on dispose | 改(M7,M9)|
| `tests/core/memory/*.test.js` · `tests/core/orchestration/c4-*.test.js` · `tests/config-*.test.js` | 各 M 单测 + e2e | 新建 |

---

## Task M0 · 契约 + 状态机 + off-parity 骨架

**Files:** Create `src/core/memory/experience-schema.js`, `tests/core/memory/experience-schema.test.js`

**Interfaces (Produces):** `FILE_SCHEMA_VERSION=1` · `validateEntry(e)->err|null` · `validatePending(p)->err|null` · `clamp01(n)` · 文档注释:`retrieved/presented/adopted` 三态流。

- [ ] **Step 1: 写失败测试**
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateEntry, FILE_SCHEMA_VERSION, clamp01 } from "../../../src/core/memory/experience-schema.js";

test("FILE_SCHEMA_VERSION is file-level constant", () => { assert.equal(FILE_SCHEMA_VERSION, 1); });

test("validateEntry accepts a well-formed entry, rejects bad kind/confidence", () => {
  const ok = { id: "exp_1", kind: "procedural", lesson: "x", cues: ["a","b"], provenance: { taskId: "t1" }, confidence: 0.5, validations: 0, misleads: 0, created: "2026-01-01T00:00:00Z", lastReinforced: "2026-01-01T00:00:00Z", tier: 3 };
  assert.equal(validateEntry(ok), null);
  assert.match(validateEntry({ ...ok, kind: "wat" }), /kind/);
  assert.match(validateEntry({ ...ok, confidence: 2 }), /confidence/);
  assert.match(validateEntry({ ...ok, cues: [] }), /cues/);   // need >=1 stored cue
});

test("clamp01 clamps", () => { assert.equal(clamp01(-1), 0); assert.equal(clamp01(2), 1); assert.equal(clamp01(0.3), 0.3); });
```
- [ ] **Step 2: 跑 → FAIL(模块缺)** — `node --test tests/core/memory/experience-schema.test.js`
- [ ] **Step 3: 实现** `experience-schema.js`
```js
export const FILE_SCHEMA_VERSION = 1;
const KIND = new Set(["procedural", "risk"]);
export function clamp01(n) { const x = Number(n); return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0; }
function isStr(v) { return typeof v === "string" && v.length > 0; }
function isStrArr(v) { return Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0); }
export function validateEntry(e) {
  if (!e || typeof e !== "object") return "entry not an object";
  if (!isStr(e.id)) return "id missing";
  if (!KIND.has(e.kind)) return "bad kind";
  if (!isStr(e.lesson)) return "lesson missing";
  if (!isStrArr(e.cues) || e.cues.length < 1) return "cues must be non-empty string[]";
  if (!e.provenance || typeof e.provenance !== "object") return "provenance missing";
  for (const k of ["confidence"]) if (typeof e[k] !== "number" || e[k] < 0 || e[k] > 1) return `${k} out of [0,1]`;
  for (const k of ["validations", "misleads"]) if (!Number.isInteger(e[k]) || e[k] < 0) return `${k} must be non-neg int`;
  if (![1, 2, 3].includes(e.tier)) return "tier must be 1|2|3";
  return null;
}
export function validatePending(p) {
  if (!p || typeof p !== "object") return "pending not an object";
  if (!isStr(p.pendingId)) return "pendingId missing";
  return validateEntry(p.entry);
}
// id 状态流(运行期,非持久):retrieved(query 命中) ⊇ presented(进 prompt) ⊇ adopted(planner 声明 used ∩ presented)
```
- [ ] **Step 4: 跑 → PASS**
- [ ] **Step 5: 提交** `feat(memory): experience schema + contracts (M0)` + 署名

---

## Task M1 · experience-store(写队列 + 原子写 + pending)

**Files:** Create `src/core/memory/experience-store.js`, `tests/core/memory/experience-store.test.js`

**Interfaces (Produces):** `createExperienceStore({ dir, now })` → `{ all(), get(id), put(entry), remove(id, reason), replaceAll(entries), listPending(), putPending(p), resolvePending(id, decision), flush() }`。所有写经内部 async **mutex 队列**串行;原子 `<unique>.tmp`→rename;文件 `{ schemaVersion, entries }`;schemaVersion 不符 → 起空库。

- [ ] **Step 1: 写失败测试**(用 `node:test` + 临时目录 `fs.mkdtemp`)
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createExperienceStore } from "../../../src/core/memory/experience-store.js";

const mkEntry = (id, over = {}) => ({ id, kind: "procedural", lesson: "L"+id, cues: ["a"+id,"b"], provenance: { taskId: "t" }, confidence: 0.5, validations: 0, misleads: 0, created: "2026-01-01T00:00:00Z", lastReinforced: "2026-01-01T00:00:00Z", tier: 3, ...over });
async function tmpDir() { return fs.mkdtemp(path.join(os.tmpdir(), "exp-")); }

test("put/get/all/remove round-trip + atomic persistence", async () => {
  const dir = await tmpDir();
  const s = createExperienceStore({ dir, now: () => "2026-01-01T00:00:00Z" });
  await s.put(mkEntry("1")); await s.put(mkEntry("2"));
  assert.equal(s.all().length, 2);
  assert.equal(s.get("1").id, "1");
  await s.remove("1", "below_tier3");
  assert.equal(s.all().length, 1);
  const s2 = createExperienceStore({ dir, now: () => "x" });   // reload from disk
  await s2.flush();
  assert.deepEqual(s2.all().map((e) => e.id), ["2"]);
});

test("concurrent writes serialize without lost update", async () => {
  const dir = await tmpDir();
  const s = createExperienceStore({ dir, now: () => "t" });
  await Promise.all(Array.from({ length: 20 }, (_, i) => s.put(mkEntry(String(i)))));
  assert.equal(s.all().length, 20);            // none lost
  const s2 = createExperienceStore({ dir, now: () => "t" }); await s2.flush();
  assert.equal(s2.all().length, 20);
});

test("schemaVersion mismatch loads empty (conservative)", async () => {
  const dir = await tmpDir();
  await fs.writeFile(path.join(dir, "experience.json"), JSON.stringify({ schemaVersion: 999, entries: [mkEntry("z")] }));
  const s = createExperienceStore({ dir, now: () => "t" }); await s.flush();
  assert.equal(s.all().length, 0);
});

test("pending area is separate from the live library", async () => {
  const dir = await tmpDir();
  const s = createExperienceStore({ dir, now: () => "t" });
  await s.putPending({ pendingId: "p1", entry: mkEntry("e1", { kind: "risk" }) });
  assert.equal(s.all().length, 0);             // not in live lib
  assert.equal(s.listPending().length, 1);
  await s.resolvePending("p1", "approve");
  assert.equal(s.all().length, 1);             // committed to live lib
  assert.equal(s.listPending().length, 0);
});
```
- [ ] **Step 2: 跑 → FAIL**
- [ ] **Step 3: 实现** `experience-store.js`(要点:构造时同步 `loadSync` 读盘到内存数组,schemaVersion 校验;`enqueue(fn)` = 链式 `queue = queue.then(fn)` 串行;每次写改内存 + `persist()`(原子 tmp→rename);`flush()` await 队列;pending 存独立 `pending.json`,`resolvePending(approve)` 把 entry 经 `put` 落库 + 删 pending;`remove` 记 `experience-evictions.jsonl`)。
- [ ] **Step 4: 跑 → PASS** · [ ] **Step 5: 提交** `feat(memory): experience-store with write-queue + atomic persist + pending (M1)` + 署名

---

## Task M2 · experience-scoring(纯)

**Files:** Create `src/core/memory/experience-scoring.js` + 测试。

**Interfaces:** `score(e, now)` · `tierOf(score, {T1,T2,T3})` · `reinforce(e, now)` · `weaken(e)` · `daysSince(iso, now)`(纯,注入 `now`)。

- [ ] **Step 1: 失败测试**
```js
import { test } from "node:test"; import assert from "node:assert/strict";
import { score, tierOf, reinforce, weaken } from "../../../src/core/memory/experience-scoring.js";
const T = { T1: 0.7, T2: 0.4, T3: 0.2 };
const base = { confidence: 0.5, validations: 0, misleads: 0, lastReinforced: "2026-01-01T00:00:00Z" };
const now0 = () => new Date("2026-01-01T00:00:00Z").getTime();

test("validations raise, misleads lower, aging decays", () => {
  assert.ok(score({ ...base, validations: 5 }, now0) > score(base, now0));
  assert.ok(score({ ...base, misleads: 2 }, now0) < score(base, now0));
  const later = () => new Date("2026-02-01T00:00:00Z").getTime();   // ~31d
  assert.ok(score(base, later) < score(base, now0));               // decay 0.02/d
});
test("tierOf boundaries", () => {
  assert.equal(tierOf(0.75, T), 1); assert.equal(tierOf(0.5, T), 2);
  assert.equal(tierOf(0.25, T), 3); assert.equal(tierOf(0.1, T), 0);   // 0 = evict
});
test("reinforce bumps validations + lastReinforced; weaken bumps misleads", () => {
  const r = reinforce({ ...base, validations: 1 }, now0);
  assert.equal(r.validations, 2);
  assert.equal(weaken({ ...base, misleads: 0 }).misleads, 1);
});
```
- [ ] **Step 2–4: 跑红 → 实现(`score=clamp01(confidence+0.1*Math.log1p(validations)-decayPerDay*daysSince-0.2*misleads)`,默认 `decayPerDay=0.02`;`tierOf` 返回 1/2/3/0)→ 跑绿**
- [ ] **Step 5: 提交** `feat(memory): experience-scoring (M2)` + 署名

---

## Task M3 · experience-cluster(纯 + cue 护栏)

**Files:** Create `src/core/memory/experience-cluster.js` + 测试。

**Interfaces:** `normalizeCues(raw)->string[]`(小写/去标点/去停用词/代码 token 整体/去重排序)· `effectiveCues(cues)`(过滤低信息)· `jaccard(a,b)` · `cluster(entries,{dedupThreshold})`(按 `kind` 分桶 + id 序遍历 + 合并留最高 tier)。

- [ ] **Step 1: 失败测试**(钉死 spec §5.3 护栏 + F5/F6)
```js
import { test } from "node:test"; import assert from "node:assert/strict";
import { normalizeCues, jaccard, cluster, effectiveCues } from "../../../src/core/memory/experience-cluster.js";

test("normalizeCues: lowercase, dedupe, sort, drop stopwords/low-info", () => {
  assert.deepEqual(normalizeCues(["Test", "Auth", "auth", "the"]), ["auth"]);   // test/the dropped, auth deduped
});
test("code path/command kept as single cue", () => {
  assert.ok(normalizeCues(["src/index.js"]).includes("src/index.js"));          // not split on / .
});
test("jaccard symmetric + bounds", () => {
  assert.equal(jaccard(["a","b"], ["a","b"]), 1);
  assert.equal(jaccard(["a"], ["b"]), 0);
  assert.equal(jaccard(["a","b","c"], ["b","c"]), jaccard(["b","c"], ["a","b","c"]));
});
test("effectiveCues guard: <2 effective cues => not clusterable", () => {
  assert.ok(effectiveCues(["auth","login"]).length >= 2);
  assert.equal(effectiveCues(["test"]).length, 0);   // single low-info => empty
});
test("cluster never merges across kind, keeps highest tier, sums validations", () => {
  const A = { id:"a", kind:"procedural", cues:["auth","login"], tier:3, validations:1 };
  const B = { id:"b", kind:"procedural", cues:["auth","login","session"], tier:1, validations:2 };
  const R = { id:"r", kind:"risk", cues:["auth","login"], tier:2, validations:0 };
  const out = cluster([A,B,R], { dedupThreshold: 0.6 });
  // A,B merge (>=0.6, same kind) -> 1 procedural (tier1, validations 3); R stays separate (risk)
  const proc = out.filter((e) => e.kind === "procedural");
  assert.equal(proc.length, 1); assert.equal(proc[0].tier, 1); assert.equal(proc[0].validations, 3);
  assert.equal(out.filter((e) => e.kind === "risk").length, 1);
});
```
- [ ] **Step 2–4: 跑红 → 实现 → 跑绿**(停用词最小集中英;`effectiveCues` 滤低信息词;`cluster` 先按 kind 分桶、id 序遍历、贪心并簇)
- [ ] **Step 5: 提交** `feat(memory): experience-cluster with cue guards + kind-bucketed Jaccard (M3)` + 署名

---

## Task M4 · experience-upsert 管线

**Files:** Create `src/core/memory/experience-upsert.js` + 测试。

**Interfaces:** `upsert(store, candidate, { now, scoring, cluster, cap, thresholds })`:候选 → 入库 → 重聚簇 → 重算每条 score/tier → 跌破 T3 删(日志)→ 超 cap 末位淘汰(§5.2 tie-break)。

- [ ] **Step 1: 失败测试** — 新条目入三级;同簇合并;低分跌破 T3 即删 + eviction 日志;超 cap 删 score 最低(tie-break: lastReinforced→created→id)。
- [ ] **Step 2–4: 跑红 → 实现 → 跑绿**
- [ ] **Step 5: 提交** `feat(memory): experience-upsert pipeline (M4)` + 署名

---

## Task M5 · experience-consolidator(次 agent + adopted 升降)

**Files:** Create `src/core/memory/experience-consolidator.js` + 测试(mock `callModel`)。

**Interfaces:** `createConsolidator({ callModel, store, upsert, scoring, now })` → `consolidate({ message, done_when, allCollected, outcome, adoptedExperienceIds })`:
- 调 `callModel`(提炼 prompt)→ 取 JSON `[{kind,lesson,cues,confidence}]` → schema 校验 + 有界重试 + 保守收尾(畸形→不沉淀)→ 每条 normalizeCues + 低信息丢弃 → `upsert`。
- **adopted 升降**(程序):对 `adoptedExperienceIds` 中存在的条目,按 `outcome`/相关 subtask 成败 `reinforce`/`weaken` → 经 store 写。

- [ ] **Step 1: 失败测试** — 合法输出→写库;畸形→不写不崩;`adopted + outcome=complete`→validations++;`adopted + 相关 failed`→misleads++;`adopted=[]`→库不动;空/低信息 cue→不入库。
- [ ] **Step 2–4: 跑红 → 实现 → 跑绿**
- [ ] **Step 5: 提交** `feat(memory): experience-consolidator (distill + adopted reinforce/weaken) (M5)` + 署名

---

## Task M6 · retrieval + planner 注入

**Files:** Create `src/core/memory/experience-retrieval.js` + 测试;改 `planner.js`(`plan` 收 `experiences`、回 `used_experience_ids`)、`subtask-schema.js`(`Plan.used_experience_ids?` 可选,不破 `validatePlan`)。

**Interfaces:** `query(store, { message }, { retrieveK, thresholds, now })` → `{ procedural:[{id,lesson,tier,confidence}], presentedIds:string[], riskCues:Set<string> }`(cue 重叠 × tier 权重排序,top-K;有效 cue<2 的条目不匹配)。

- [ ] **Step 1: 失败测试** — cue 重叠×tier 排序、top-K、riskCues 抽取、纯读不改库;planner prompt 含简报;planner 回 `used_experience_ids`;`validatePlan` 容忍 `used_experience_ids` 字段;无 experiences → planner prompt 与今天一致。
- [ ] **Step 2–4: 跑红 → 实现 → 跑绿**(planner `plannerPrompt` 追加 experiences 段;解析 `used_experience_ids`,缺省 `[]`)
- [ ] **Step 5: 提交** `feat(memory): experience-retrieval + planner experiences/used_experience_ids (M6)` + 署名

---

## Task M7 · config + orchestrator 接线(检索/后台巩固/flush/adopted)

**Files:** 改 `config.js`(`DEFAULT_CONFIG.orchestration.crossTaskLearning="off"` + `experience` 子块 + 归一)、`orchestrator.js`(检索 pre-plan、`adopted=used∩presented`、`finalize` 后台巩固 + `pendingConsolidations` + `flushExperience()`)、`index.js`(装配 store/consolidator/retrieval 注入 orchestrator、`crossTaskLearning="off"` 时全不注入、`kernel.dispose` 调 `flushExperience`)、新建 `tests/config-orchestration-experience.test.js` + orchestrator 接线测试。

**Interfaces:** `normalizeOrchestration(raw).crossTaskLearning ∈ {off,on,gated}`(默认 off)+ `.experience = { cap, decayPerDay, thresholds:{T1,T2,T3}, dedupThreshold, maxLessonsPerTask, retrieveK, pendingTtlMs }`(posInt/0..1 归一)。

- [ ] **Step 1: 失败测试** — config 归一(默认 off + experience 默认值 + 非法回退);orchestrator:`off`→不检索/不巩固/无 `experience:*` 事件/`planner.plan` 无 experiences(**零回归**);`on`→检索注入 + `finalize` 后 `flushExperience()` 后库有写入;`adopted=used∩presented`(planner 谎报未 presented id 被滤);后台巩固不阻塞 `run()` 返回。
- [ ] **Step 2–4: 跑红 → 实现 → 跑绿**(orchestrator 仅在 `crossTaskLearning!=="off"` 走新路;巩固 promise 入 `pendingConsolidations`,`flushExperience` await 之;`run` 不 await 巩固)
- [ ] **Step 5: 提交** `feat(orchestration): wire experience memory (retrieve/consolidate/flush, default off) (M7)` + 署名

---

## Task M8 · risk-rules + permission 单调升级 + dispatch 注入

**Files:** Create `src/core/memory/risk-rules.js` + 测试;改 `permission-engine.js`(skip `escalate_only` + escalation pass)、`dispatch-loop.js`(`worker.send` 加 `projectRules`)、`orchestrator.js`(把 riskCues→risk-rules 注入**串行主区** worker 的 send options)。

**Interfaces:** `riskRules(riskCues)->[{ escalate_only:true, tool?|pattern? , id }]`;`permission-engine.decide` 新增:普通 projectRules 循环 `if (rule.escalate_only) continue;`;default-matrix 分支后 escalation pass(`allow && source==="default-matrix" && matchesEscalate(riskRules, call)` → `ask`)。

- [ ] **Step 1: 失败测试**(钉死 spec §9.1,最高优先)
```js
// permission-engine 测试
import { createPermissionEngine } from "../../../src/tools/permissions/permission-engine.js";
const pe = createPermissionEngine();
const esc = [{ escalate_only: true, pattern: "src/**", id: "r1" }];
// default-matrix allow + risk match -> ask
test("escalate allow->ask only for default-matrix + match", () => {
  const d = pe.decide({ name:"edit", category:"write_update", params:{ path:"src/a.js" } }, { autonomy:"gated", projectRules: esc });
  assert.equal(d.decision, "ask"); assert.equal(d.source, "risk-experience");
});
test("never downgrade: read-only deny stays deny; escalate_only never returned by normal loop", () => {
  const d = pe.decide({ name:"edit", category:"write_update", params:{ path:"src/a.js" } }, { autonomy:"read-only", projectRules: esc });
  assert.equal(d.decision, "deny");
});
test("does NOT override explicit user trust allow", () => {
  const trust = { rules: [{ id:"t", tool:"edit", decision:"allow" }] };
  const d = pe.decide({ name:"edit", category:"write_update", params:{ path:"src/a.js" } }, { autonomy:"gated", projectRules: esc, trustStore: trust });
  assert.equal(d.decision, "allow"); assert.equal(d.source, "user-trust-store");
});
test("no risk rules => decide byte-identical to today", () => {
  const a = pe.decide({ name:"edit", category:"write_update", params:{ path:"src/a.js" } }, { autonomy:"gated" });
  assert.equal(a.decision, "allow"); assert.equal(a.source, "default-matrix");
});
```
- [ ] **Step 2–4: 跑红 → 实现 → 跑绿**(escalation pass 仅在 default-matrix 分支内、仅 allow;dispatch-loop `processSubtask` 的 `worker.send(prompt,{autonomy})`→`{autonomy, projectRules}`,projectRules 由 orchestrator 经 deps 传、**仅串行主区**;并行 iso 路径不传)
- [ ] **Step 5: 提交** `feat(orchestration): risk-experience monotonic permission escalation (M8)` + 署名

---

## Task M9 · gated 生命周期 + e2e + 回归 + 文档

**Files:** 改 `experience-store.js`/`consolidator.js`(gated:高影响→pending、TTL、不落库)、`index.js`(`kernel.experience = { listPending, resolvePending, flushExperience }`);新建 `tests/core/orchestration/c4-e2e.test.js`;文档。

- [ ] **Step 1: gated 失败测试** — 高影响(risk / 拟升 tier-1)→ 入 pending + 发 `experience:pending_approval`、不影响检索/权限;`resolvePending(approve)`→落库;`deny`→删+日志;TTL 过期自动 deny;`dispose` 未决 pending 保留磁盘、不落库。
- [ ] **Step 2: e2e(mock gateway)** — `on` 下 task1 完成→`flushExperience`→库有经验→task2 检索注入 plan(断言 planner prompt 含简报)+ 风险 `allow→ask`;`crossTaskLearning="off"` 全链路逐字节同今天(无目录/无事件/decide byte-equal)。装配范式照搬 `tests/core/orchestration/c5-rounds-e2e.test.js`。
- [ ] **Step 3: 实现到通过**(接线缺口在此补)
- [ ] **Step 4: 全量回归** — `npm test`(期望 **≥700 全绿**)+ `npm run check` + `git diff --check`。
- [ ] **Step 5: 文档**(overview §14.4 经验记忆 / CHANGELOG / README 中英一句「跨任务经验记忆,默认关」/ docs/README 索引加 spec+plan)。
- [ ] **Step 6: 提交** e2e 与文档(`test(...)` / `docs: ...`,均署名)

---

## Self-Review

- **Spec 覆盖**:§4 组件→M0–M6/M8;§5 三级分化→M2/M4;§5.3 护栏→M3;§6 巩固器→M5;§7 检索/三态 id→M6/M7;§8/§8.1 开关/gated→M7/M9;§9 风险升级→M8;§10 事件→各 M;§11 硬约束→Global Constraints;§12 里程碑↔M0–M9;§13 测试→各 Step1。**无遗漏**。
- **类型一致**:`ExperienceEntry`(M0)被 store/scoring/cluster/upsert/consolidator/retrieval 一致消费;`{procedural,presentedIds,riskCues}`(M6)→orchestrator(M7)→risk-rules(M8)一致;`escalate_only` projectRules 形状 M8 产/permission-engine 消费一致。
- **零回归口**:`off` 在 M7 短路全部新路;permission-engine 无 risk 规则时 byte-equal(M8 测试钉死);现有 670 不改。
- **F1–F8 对抗发现**全部反映在对应 Step 测试(F5 tie-break→M4;F6 cues 排序→M3;F7 dispatch 注入→M8;F8 仅串行主区→M8;F1 消歧→实现注释;F2 事件→M9;F3 schemaVersion→M0/M1;F4 resolvePending→M9)。
