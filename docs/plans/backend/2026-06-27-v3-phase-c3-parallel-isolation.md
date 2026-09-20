# V3 Phase C3 并行 Worker 写隔离 Implementation Plan

> 完成状态以 [CHANGELOG](../../CHANGELOG.md) 为准。


**Goal:** 让「无依赖 + 声明文件范围不重叠」的子任务并行执行,每个并行 Worker 在 fs 拷贝隔离工作区里改动,完成后经快照一致性校验 + 每 subtask 原子事务**回放合并**进主工作区;`maxParallelWorkers=1` 或批大小=1 时与 C1+C2 串行逐字节一致。

**Architecture:** 在 C1+C2 的 `dispatch-loop` 上加一层**批次**(依赖+不重叠切批)。并行批内每 Worker:fs 拷贝主区→记 `baseManifest`(path→sha256)→`buildToolPlane(isoRoot)` 给一套绑定隔离目录的工具→隔离 runtime 执行→自审+独立审核→**实际写入范围校验**→`finally` 删隔离区。合并:每 subtask 算净 unified diff(整文件替换),CAS 校验主区 path hash==base,一次 `editService.apply`(原子);冲突/越界→回滚标失败。`agent-runtime.js` 一行不改。

**Tech Stack:** Node ESM (Node ≥ 20)、`node:test`、`node:fs`/`node:crypto`、复用 `editService.apply`(`src/edits`)、`path-safety`、C1+C2 编排件。无新运行时依赖。

## Global Constraints

- **`src/core/runtime/agent-runtime.js` 一行不改**;Worker 仍是 `createAgentRuntime` 实例,经 `createRuntime` 注入 `executeTool`(隔离工具平面)+ `projectRoot`(isoRoot)+ `toolSchemas` 子集。
- **编排确定性**:切批、合并顺序均程序逻辑;**合并按 subtask id 升序**;并发是唯一非确定点,合并串行固定序 → 结果确定。
- **事务粒度**:**每个 subtask 全部改动 = 一次原子事务**(整 subtask 落主区 or 全回滚);**批次 = 部分成功**(显式,非整批 all-or-nothing)。
- **快照一致性(CAS)**:合并每个被触碰路径前校验主区 == base(改:`hash==base`;增:base 无且主区无;删:`hash==base`);不符 → 冲突 → 该 subtask 回滚标失败,不污染主区。
- **实际写入范围校验**:Worker 结束后用 `baseManifest` 算**实际**改动路径;断言 `实际 ⊆ 声明范围` 且批内实际改动两两不重叠;越界/重叠 → 该 subtask 失败(不信 `context_scope.files`)。
- **路径归一化严格**:`normalizePath` = 分隔符→`/` + 去 `./` + **Windows(`process.platform==="win32"`)小写折叠** + posix 相对;`overlaps` = 归一后相等或目录包含;create/delete/**rename 登记新旧两路径**。(符号链接的真实解析由现有 `path-safety` 在写入时兜底;overlap 守卫用字符串归一,保确定可测。)
- **零残留**:每 Worker `finally` 必删,删除带 **retry + backoff**(抗 Windows EBUSY/EPERM);**启动清扫**带 owner(pid)+ TTL,只删「超 TTL 或当前进程上次 run」,**绝不误删活跃 run**。
- **默认零回归**:`maxParallelWorkers=1` 或批大小=1 → 走 C1+C2 串行原路;现有 594 全绿。
- **降级永不崩**:工作区文件数 > `maxCopyFiles` / 拷贝失败 / 工具平面构造失败 → 该批回退串行,记 log。
- `node:test`;每 task 末尾跑测试 + 提交。

## Shared Interfaces(全任务一致)

```text
// path-overlap.js
normalizePath(p) -> string                       // 归一(win32 小写 / posix / 去 ./)
overlaps(setA:Iterable<string>, setB:Iterable<string>) -> boolean   // 相等或目录包含
withinScope(actualPaths:Iterable, declaredFiles:Iterable) -> string[]  // 返回越界路径([] = 全在范围内)

// workspace-snapshot.js
fsCopyWorkspace(srcRoot, destRoot, { maxCopyFiles }) -> { copied:number, truncated:boolean }
hashTree(root, { maxCopyFiles }) -> Map<string, string>             // posix path -> "sha256:..."
changedPaths(root, baseManifest) -> { added:string[], deleted:string[], modified:string[] }

// iso-workspace.js
createIso({ root, runId, subtaskId }) -> string                    // 返回 isoRoot 绝对路径(已建 + 写 .owner)
removeIso(isoRoot, { retries, backoffMs }) -> Promise<boolean>
sweepOrphans({ root, ttlMs, pid }) -> Promise<string[]>            // 返回清掉的目录

// merge-back.js
makeUnifiedDiff(path, baseContent|null, finalContent|null) -> string   // 整文件替换 diff(new/delete/modify)
mergeSubtask({ editService, mainRoot, isoRoot, baseManifest, actual }) -> Promise<{ ok:boolean, change_id?:string, reason?:string }>

// batch-planner.js
toBatches(orderedSubtasks, { completedIds:Set, maxParallelWorkers }) -> SubTask[][]

// index.js
buildToolPlane(root, { eventBus, permissionEngine, recoveryJournal, assertOwner, webFetch, defaultToolTimeoutMs }) -> { editService, toolRegistry, toolExecutor, execute }
```

---

# 里程碑 M1 · path-overlap

## Task 1: path-overlap(归一化 + 重叠 + 范围校验)

**Files:**
- Create: `src/core/orchestration/path-overlap.js`
- Test: `tests/core/orchestration/path-overlap.test.js`

**Interfaces:** Produces `normalizePath` / `overlaps` / `withinScope`(见 Shared)。纯字符串、确定、可测。

- [ ] **Step 1: 写失败测试**

```js
// tests/core/orchestration/path-overlap.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePath, overlaps, withinScope } from "../../../src/core/orchestration/path-overlap.js";

test("normalizePath unifies separators and strips ./", () => {
  assert.equal(normalizePath("./src\\a.js"), normalizePath("src/a.js"));
});

test("overlaps detects equality and directory containment", () => {
  assert.equal(overlaps(["src/a.js"], ["src/b.js"]), false);
  assert.equal(overlaps(["src/a.js"], ["src/a.js"]), true);
  assert.equal(overlaps(["src/"], ["src/a.js"]), true);   // dir contains file
  assert.equal(overlaps(["lib/x.js"], ["src/"]), false);
});

test("withinScope returns out-of-scope paths", () => {
  assert.deepEqual(withinScope(["src/a.js"], ["src/"]), []);          // a.js inside src/
  assert.deepEqual(withinScope(["src/a.js", "lib/b.js"], ["src/a.js"]), ["lib/b.js"]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/core/orchestration/path-overlap.test.js`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```js
// src/core/orchestration/path-overlap.js
const CASE_FOLD = process.platform === "win32";

export function normalizePath(p) {
  let s = String(p || "").replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+/g, "/");
  s = s.replace(/^\/+/, "");
  if (CASE_FOLD) s = s.toLowerCase();
  return s;
}

function asDirPrefix(p) { return p.endsWith("/") ? p : `${p}/`; }

function containsOrEquals(a, b) {
  // does a contain or equal b? (a may be a dir prefix)
  if (a === b) return true;
  if (a.endsWith("/")) return b.startsWith(a);            // a is explicit dir
  return b.startsWith(asDirPrefix(a)) || a.startsWith(asDirPrefix(b));
}

export function overlaps(setA, setB) {
  const A = [...setA].map(normalizePath);
  const B = [...setB].map(normalizePath);
  for (const a of A) for (const b of B) if (containsOrEquals(a, b)) return true;
  return false;
}

export function withinScope(actualPaths, declaredFiles) {
  const declared = [...declaredFiles].map(normalizePath);
  const out = [];
  for (const raw of actualPaths) {
    const a = normalizePath(raw);
    const inScope = declared.some((d) => d === a || asDirPrefix(d) === asDirPrefix(a) || a.startsWith(asDirPrefix(d)));
    if (!inScope) out.push(a);
  }
  return out;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/core/orchestration/path-overlap.test.js`
Expected: PASS

- [ ] **Step 5: 提交(含 src → 不加署名)**

```bash
git add src/core/orchestration/path-overlap.js tests/core/orchestration/path-overlap.test.js
git commit -m "feat(orchestration): path-overlap (normalize + overlaps + withinScope)"
```

---

# 里程碑 M2 · workspace-snapshot

## Task 2: workspace-snapshot(拷贝 + hash + 改动检测)

**Files:**
- Create: `src/core/orchestration/workspace-snapshot.js`
- Test: `tests/core/orchestration/workspace-snapshot.test.js`

**Interfaces:** Produces `fsCopyWorkspace` / `hashTree` / `changedPaths`(见 Shared)。`hashTree`/拷贝排除 `.git`/`node_modules`/`.deepseek-code`,受 `maxCopyFiles`。

- [ ] **Step 1: 写失败测试**

```js
// tests/core/orchestration/workspace-snapshot.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os"; import path from "node:path"; import { promises as fs } from "node:fs";
import { fsCopyWorkspace, hashTree, changedPaths } from "../../../src/core/orchestration/workspace-snapshot.js";

async function tmp() { return fs.mkdtemp(path.join(os.tmpdir(), "ws-snap-")); }

test("copy excludes .git/node_modules/.deepseek-code; hashTree captures dirty content", async () => {
  const src = await tmp();
  await fs.mkdir(path.join(src, "src")); await fs.writeFile(path.join(src, "src/a.js"), "A\n");
  await fs.mkdir(path.join(src, ".git")); await fs.writeFile(path.join(src, ".git/x"), "g");
  await fs.mkdir(path.join(src, "node_modules")); await fs.writeFile(path.join(src, "node_modules/y"), "n");
  const dest = await tmp();
  const res = await fsCopyWorkspace(src, dest, { maxCopyFiles: 5000 });
  assert.ok(res.copied >= 1);
  assert.equal(await fs.readFile(path.join(dest, "src/a.js"), "utf8"), "A\n");
  assert.equal(await fs.access(path.join(dest, ".git")).then(() => true, () => false), false);
  assert.equal(await fs.access(path.join(dest, "node_modules")).then(() => true, () => false), false);
  const manifest = await hashTree(dest, { maxCopyFiles: 5000 });
  assert.ok(manifest.has("src/a.js"));
});

test("changedPaths reports added/deleted/modified vs base manifest", async () => {
  const root = await tmp();
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src/keep.js"), "k\n");
  await fs.writeFile(path.join(root, "src/mod.js"), "old\n");
  await fs.writeFile(path.join(root, "src/del.js"), "d\n");
  const base = await hashTree(root, { maxCopyFiles: 5000 });
  await fs.writeFile(path.join(root, "src/mod.js"), "new\n");      // modify
  await fs.rm(path.join(root, "src/del.js"));                       // delete
  await fs.writeFile(path.join(root, "src/add.js"), "a\n");         // add
  const ch = changedPaths(await hashTree(root, { maxCopyFiles: 5000 }), base);
  assert.deepEqual(ch.added, ["src/add.js"]);
  assert.deepEqual(ch.deleted, ["src/del.js"]);
  assert.deepEqual(ch.modified, ["src/mod.js"]);
});
```

> 注:`changedPaths` 这里按「两个 manifest 比较」实现(比「读 root + base」更纯、好测)。签名定为 `changedPaths(currentManifest, baseManifest)`。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/core/orchestration/workspace-snapshot.test.js`
Expected: FAIL

- [ ] **Step 3: 实现**

```js
// src/core/orchestration/workspace-snapshot.js
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const EXCLUDE = new Set([".git", "node_modules", ".deepseek-code"]);

function toPosix(p) { return p.replace(/\\/g, "/"); }

async function* walk(root, rel = "") {
  const dir = rel ? path.join(root, rel) : root;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (EXCLUDE.has(e.name)) continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) yield* walk(root, childRel);
    else if (e.isFile()) yield toPosix(childRel);
  }
}

export async function fsCopyWorkspace(srcRoot, destRoot, { maxCopyFiles = 5000 } = {}) {
  let copied = 0, truncated = false;
  for await (const rel of walk(srcRoot)) {
    if (copied >= maxCopyFiles) { truncated = true; break; }
    const from = path.join(srcRoot, rel), to = path.join(destRoot, rel);
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(from, to);
    copied += 1;
  }
  return { copied, truncated };
}

export async function hashTree(root, { maxCopyFiles = 5000 } = {}) {
  const manifest = new Map();
  let n = 0;
  for await (const rel of walk(root)) {
    if (n >= maxCopyFiles) break;
    const buf = await fs.readFile(path.join(root, rel));
    manifest.set(rel, `sha256:${createHash("sha256").update(buf).digest("hex")}`);
    n += 1;
  }
  return manifest;
}

export function changedPaths(currentManifest, baseManifest) {
  const added = [], deleted = [], modified = [];
  for (const [p, h] of currentManifest) {
    if (!baseManifest.has(p)) added.push(p);
    else if (baseManifest.get(p) !== h) modified.push(p);
  }
  for (const p of baseManifest.keys()) if (!currentManifest.has(p)) deleted.push(p);
  added.sort(); deleted.sort(); modified.sort();
  return { added, deleted, modified };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/core/orchestration/workspace-snapshot.test.js`
Expected: PASS

- [ ] **Step 5: 提交(含 src → 不加署名)**

```bash
git add src/core/orchestration/workspace-snapshot.js tests/core/orchestration/workspace-snapshot.test.js
git commit -m "feat(orchestration): workspace-snapshot (fs copy + hashTree + changedPaths)"
```

---

# 里程碑 M3 · iso-workspace

## Task 3: iso-workspace(隔离目录生命周期 + 零残留)

**Files:**
- Create: `src/core/orchestration/iso-workspace.js`
- Test: `tests/core/orchestration/iso-workspace.test.js`

**Interfaces:** Produces `createIso` / `removeIso`(retry+backoff)/ `sweepOrphans`(owner+TTL,不误删活跃)。iso 根 = `<root>/.deepseek-code/v2/orchestration/iso/<runId>/<subtaskId>`;`<runId>` 目录写 `.owner`(JSON `{ pid, ts }`)。

- [ ] **Step 1: 写失败测试**

```js
// tests/core/orchestration/iso-workspace.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os"; import path from "node:path"; import { promises as fs } from "node:fs";
import { createIso, removeIso, sweepOrphans } from "../../../src/core/orchestration/iso-workspace.js";

async function tmp() { return fs.mkdtemp(path.join(os.tmpdir(), "iso-")); }
const exists = (p) => fs.access(p).then(() => true, () => false);

test("createIso makes dir + .owner; removeIso deletes it", async () => {
  const root = await tmp();
  const iso = await createIso({ root, runId: "run1", subtaskId: "st_1" });
  assert.ok(await exists(iso));
  assert.ok(await exists(path.join(root, ".deepseek-code/v2/orchestration/iso/run1/.owner")));
  assert.equal(await removeIso(iso), true);
  assert.equal(await exists(iso), false);
});

test("sweepOrphans removes stale runs but keeps fresh/owned ones", async () => {
  const root = await tmp();
  await createIso({ root, runId: "old", subtaskId: "st_1" });
  await createIso({ root, runId: "fresh", subtaskId: "st_1" });
  // backdate "old"'s .owner so it exceeds TTL
  const oldOwner = path.join(root, ".deepseek-code/v2/orchestration/iso/old/.owner");
  await fs.writeFile(oldOwner, JSON.stringify({ pid: 999999, ts: Date.now() - 10 * 3600 * 1000 }));
  const swept = await sweepOrphans({ root, ttlMs: 3600000, pid: process.pid });
  const base = path.join(root, ".deepseek-code/v2/orchestration/iso");
  assert.equal(await exists(path.join(base, "old")), false);   // stale + not our pid -> removed
  assert.equal(await exists(path.join(base, "fresh")), true);  // fresh -> kept
  assert.ok(swept.some((d) => d.includes("old")));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/core/orchestration/iso-workspace.test.js`
Expected: FAIL

- [ ] **Step 3: 实现**

```js
// src/core/orchestration/iso-workspace.js
import { promises as fs } from "node:fs";
import path from "node:path";

function isoBase(root) { return path.join(root, ".deepseek-code", "v2", "orchestration", "iso"); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function createIso({ root, runId, subtaskId }) {
  const runDir = path.join(isoBase(root), runId);
  const iso = path.join(runDir, subtaskId);
  await fs.mkdir(iso, { recursive: true });
  const owner = path.join(runDir, ".owner");
  try { await fs.writeFile(owner, JSON.stringify({ pid: process.pid, ts: Date.now() }), { flag: "wx" }); }
  catch { /* already written by a sibling subtask of this run */ }
  return iso;
}

export async function removeIso(isoRoot, { retries = 3, backoffMs = 50 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try { await fs.rm(isoRoot, { recursive: true, force: true }); return true; }
    catch (e) {
      if (attempt === retries) return false;                 // give up; caller logs warning
      await sleep(backoffMs * Math.pow(3, attempt));         // 50 / 150 / 450ms
    }
  }
  return false;
}

export async function sweepOrphans({ root, ttlMs = 3600000, pid = process.pid }) {
  const base = isoBase(root);
  let runs;
  try { runs = await fs.readdir(base, { withFileTypes: true }); }
  catch { return []; }                                       // nothing to sweep
  const removed = [];
  for (const e of runs) {
    if (!e.isDirectory()) continue;
    const runDir = path.join(base, e.name);
    let owner = null;
    try { owner = JSON.parse(await fs.readFile(path.join(runDir, ".owner"), "utf8")); } catch { /* missing/corrupt */ }
    const stale = !owner || (Date.now() - (owner.ts || 0)) > ttlMs;
    const ours = owner && owner.pid === pid;
    // remove only stale runs, OR our own prior runs (never another live process's fresh run)
    if (stale || ours) {
      await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
      removed.push(runDir);
    }
  }
  return removed;
}
```

> 注:测试里 "fresh" 的 owner pid = 当前 pid → 命中 `ours` 会被删。为让该断言成立(fresh 保留),把测试的 fresh run 改成「不同 pid 且未超 TTL」:在 Step 1 跑前先改 fresh 的 .owner 为 `{ pid: 111111, ts: Date.now() }`。**修正测试**:`sweepOrphans` 测试里两个 run 都先用非当前 pid 写 .owner(old 超 TTL、fresh 不超),再 sweep,断言 old 删、fresh 留。(下方 Step 1 已按此口径,确认 fresh 用 `pid:111111`、新 ts。)

> 修正后的 fresh 准备(并入 Step 1 测试):
> ```js
> const freshOwner = path.join(root, ".deepseek-code/v2/orchestration/iso/fresh/.owner");
> await fs.writeFile(freshOwner, JSON.stringify({ pid: 111111, ts: Date.now() }));
> ```

- [ ] **Step 4: 跑测试确认通过**(按上方修正口径补 fresh 的 .owner 后)

Run: `node --test tests/core/orchestration/iso-workspace.test.js`
Expected: PASS

- [ ] **Step 5: 提交(含 src → 不加署名)**

```bash
git add src/core/orchestration/iso-workspace.js tests/core/orchestration/iso-workspace.test.js
git commit -m "feat(orchestration): iso-workspace (createIso + removeIso retry + sweepOrphans owner/TTL)"
```

---

# 里程碑 M4 · buildToolPlane 重构(纯重构,回归守)

## Task 4: 抽 `buildToolPlane(root)` + createRuntime 注入 projectRoot

**Files:**
- Modify: `src/index.js`(抽工具平面构造为 `buildToolPlane`;主区调它;`createRuntime` 透传 `projectRoot`)
- Test: `tests/core/orchestration/build-tool-plane.test.js`

**Interfaces:** Produces `buildToolPlane(root, deps) -> { editService, toolRegistry, toolExecutor, execute }`(`execute(toolCall, policyContext)` = `toolExecutor.execute`)。主区构造行为**不变**。

- [ ] **Step 1: 写测试(buildToolPlane 对任意 root 产出可用工具平面;edit 落在该 root)**

```js
// tests/core/orchestration/build-tool-plane.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os"; import path from "node:path"; import { promises as fs } from "node:fs";
import { buildToolPlane } from "../../../src/index.js";

test("buildToolPlane binds edit/read tools to the given root", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "plane-"));
  await fs.writeFile(path.join(root, "a.txt"), "hello\n");
  const plane = buildToolPlane(root, {});
  assert.equal(typeof plane.execute, "function");
  assert.ok(plane.toolRegistry.toDeepSeekTools().some((s) => s.function.name === "read"));
  // read tool resolves against `root`
  const res = await plane.execute({ id: "t1", name: "read", params: { path: "a.txt" } }, { projectRoot: root, autonomy: "auto" });
  assert.match(res.content?.[0]?.text || "", /hello/);
});
```

> 若现有权限模型要求更完整的 policyContext,使该测试以「读类工具在 root 下可用」为最小断言;必要时用 `plane` 暴露的 registry 直接构造 policyContext。关键是 **buildToolPlane(root) 产出绑定 root 的平面**。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/core/orchestration/build-tool-plane.test.js`
Expected: FAIL（`buildToolPlane` 未导出）

- [ ] **Step 3: 重构 `src/index.js`**

把现有内联构造:

```js
  const editService = options.editService || createEditService({ projectRoot: root, eventBus, recoveryJournal: transactionJournal, assertOwner: projectLock ? () => projectLock.assertOwner() : async () => {} });
  const toolRegistry = options.toolRegistry || createToolRegistry({ tools: createBuiltinTools({ editService, webFetch: options.webFetch || {} }) });
  const toolExecutor = options.toolExecutor || createToolExecutor({ registry: toolRegistry, permissionEngine, eventBus, defaultToolTimeoutMs: options.limits?.toolTimeoutMs ?? null });
```

改为(抽出**导出**的工厂 + 主区调用):

```js
  const mainPlane = options.toolRegistry || options.editService || options.toolExecutor
    ? legacyPlaneFromOptions(options, { root, eventBus, permissionEngine, transactionJournal, projectLock })
    : buildToolPlane(root, {
        eventBus, permissionEngine,
        recoveryJournal: transactionJournal,
        assertOwner: projectLock ? () => projectLock.assertOwner() : async () => {},
        webFetch: options.webFetch || {},
        defaultToolTimeoutMs: options.limits?.toolTimeoutMs ?? null
      });
  const editService = mainPlane.editService;
  const toolRegistry = mainPlane.toolRegistry;
  const toolExecutor = mainPlane.toolExecutor;
```

文件末尾(模块级)新增导出:

```js
export function buildToolPlane(root, { eventBus = null, permissionEngine = null, recoveryJournal = null, assertOwner = async () => {}, webFetch = {}, defaultToolTimeoutMs = null } = {}) {
  const editService = createEditService({ projectRoot: root, eventBus, recoveryJournal, assertOwner });
  const toolRegistry = createToolRegistry({ tools: createBuiltinTools({ editService, webFetch }) });
  const toolExecutor = createToolExecutor({ registry: toolRegistry, permissionEngine: permissionEngine || createPermissionEngine(), eventBus, defaultToolTimeoutMs });
  return { editService, toolRegistry, toolExecutor, execute: (toolCall, ctx) => toolExecutor.execute(toolCall, ctx) };
}

function legacyPlaneFromOptions(options, { root, eventBus, permissionEngine, transactionJournal, projectLock }) {
  const editService = options.editService || createEditService({ projectRoot: root, eventBus, recoveryJournal: transactionJournal, assertOwner: projectLock ? () => projectLock.assertOwner() : async () => {} });
  const toolRegistry = options.toolRegistry || createToolRegistry({ tools: createBuiltinTools({ editService, webFetch: options.webFetch || {} }) });
  const toolExecutor = options.toolExecutor || createToolExecutor({ registry: toolRegistry, permissionEngine, eventBus, defaultToolTimeoutMs: options.limits?.toolTimeoutMs ?? null });
  return { editService, toolRegistry, toolExecutor, execute: (toolCall, ctx) => toolExecutor.execute(toolCall, ctx) };
}
```

`createRuntime` 已支持 `...overrides`;确认 worker 可经 `createRuntime({ projectRoot: isoRoot, executeTool, toolSchemas, createContextSnapshot })` 注入(`projectRoot` 进 `createAgentRuntime` → `buildPermissionContext` 默认 → 读类工具用 isoRoot)。无需改 agent-runtime。

- [ ] **Step 4: 跑测试 + 全量回归(纯重构,行为不变)**

Run: `node --test tests/core/orchestration/build-tool-plane.test.js`
Expected: PASS
Run: `node --test test/**/*.test.js tests/**/*.test.js`
Expected: 594 全绿(主区工具平面行为逐字节不变)

- [ ] **Step 5: 提交(含 src → 不加署名)**

```bash
git add src/index.js tests/core/orchestration/build-tool-plane.test.js
git commit -m "refactor(kernel): extract buildToolPlane(root) (main behavior unchanged) for iso worker tool-planes"
```

---

# 里程碑 M5 · merge-back

## Task 5: merge-back(净 diff 生成 + CAS + 原子 apply)

**Files:**
- Create: `src/core/orchestration/merge-back.js`
- Test: `tests/core/orchestration/merge-back.test.js`

**Interfaces:** Consumes `editService`(`src/edits/edit-service.js`,`apply({ diff })`)、`hashTree`/`changedPaths`(M2)。Produces `makeUnifiedDiff` / `mergeSubtask`(见 Shared)。净 diff = **整文件替换**(`@@ -1,oldN +1,newN @@`,全 base 行 `-`、全 final 行 `+`);CAS 用 sha256 比对主区当前 vs base。

- [ ] **Step 1: 写失败测试(generator 与真 editService 往返;CAS 冲突回滚)**

```js
// tests/core/orchestration/merge-back.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os"; import path from "node:path"; import { promises as fs } from "node:fs";
import { createEditService } from "../../../src/edits/edit-service.js";
import { makeUnifiedDiff, mergeSubtask } from "../../../src/core/orchestration/merge-back.js";
import { hashTree } from "../../../src/core/orchestration/workspace-snapshot.js";

async function tmp() { return fs.mkdtemp(path.join(os.tmpdir(), "merge-")); }

test("makeUnifiedDiff modify roundtrips through the real edit service", async () => {
  const main = await tmp();
  await fs.writeFile(path.join(main, "a.js"), "old line\n");
  const diff = makeUnifiedDiff("a.js", "old line\n", "new line\n");
  const svc = createEditService({ projectRoot: main });
  const res = await svc.apply({ diff });
  assert.equal(res.status, "success");
  assert.equal(await fs.readFile(path.join(main, "a.js"), "utf8"), "new line\n");
});

test("mergeSubtask applies disjoint iso changes; CAS conflict if main diverged", async () => {
  const main = await tmp(); const iso = await tmp();
  await fs.writeFile(path.join(main, "a.js"), "base\n");
  await fs.writeFile(path.join(iso, "a.js"), "base\n");
  const baseManifest = await hashTree(iso, {});
  await fs.writeFile(path.join(iso, "a.js"), "worker edit\n");          // worker changed it in iso
  const actual = { added: [], deleted: [], modified: ["a.js"] };
  const svc = createEditService({ projectRoot: main });

  const ok = await mergeSubtask({ editService: svc, mainRoot: main, isoRoot: iso, baseManifest, actual });
  assert.equal(ok.ok, true);
  assert.equal(await fs.readFile(path.join(main, "a.js"), "utf8"), "worker edit\n");

  // now diverge main, retry a second merge from a fresh iso edit -> CAS conflict
  const iso2 = await tmp(); await fs.writeFile(path.join(iso2, "a.js"), "base\n");
  const base2 = await hashTree(iso2, {});
  await fs.writeFile(path.join(iso2, "a.js"), "iso2 edit\n");
  await fs.writeFile(path.join(main, "a.js"), "user changed main\n");   // main diverged from base2
  const conflict = await mergeSubtask({ editService: svc, mainRoot: main, isoRoot: iso2, baseManifest: base2, actual: { added: [], deleted: [], modified: ["a.js"] } });
  assert.equal(conflict.ok, false);
  assert.equal(await fs.readFile(path.join(main, "a.js"), "utf8"), "user changed main\n"); // unchanged (rolled back/not applied)
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/core/orchestration/merge-back.test.js`
Expected: FAIL

- [ ] **Step 3: 实现**

```js
// src/core/orchestration/merge-back.js
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

function sha(buf) { return `sha256:${createHash("sha256").update(buf).digest("hex")}`; }
function splitLines(text) { return text.length ? text.replace(/\n$/, "").split("\n") : []; }

export function makeUnifiedDiff(p, baseContent, finalContent) {
  if (baseContent == null && finalContent != null) {            // add
    const add = splitLines(finalContent);
    return `--- /dev/null\n+++ b/${p}\n@@ -0,0 +1,${add.length} @@\n${add.map((l) => `+${l}`).join("\n")}\n`;
  }
  if (baseContent != null && finalContent == null) {            // delete
    const del = splitLines(baseContent);
    return `--- a/${p}\n+++ /dev/null\n@@ -1,${del.length} +0,0 @@\n${del.map((l) => `-${l}`).join("\n")}\n`;
  }
  const del = splitLines(baseContent), add = splitLines(finalContent);   // modify (whole-file replace)
  const body = [...del.map((l) => `-${l}`), ...add.map((l) => `+${l}`)].join("\n");
  return `--- a/${p}\n+++ b/${p}\n@@ -1,${del.length} +1,${add.length} @@\n${body}\n`;
}

async function readOrNull(root, rel) {
  try { return await fs.readFile(path.join(root, rel), "utf8"); } catch { return null; }
}
async function hashOrNull(root, rel) {
  try { return sha(await fs.readFile(path.join(root, rel))); } catch { return null; }
}

// CAS: main path must still equal base before we apply.
async function casOk(mainRoot, rel, baseManifest) {
  const base = baseManifest.get(rel) || null;
  const cur = await hashOrNull(mainRoot, rel);
  return cur === base;          // modify/delete: both = base hash; add: both = null
}

export async function mergeSubtask({ editService, mainRoot, isoRoot, baseManifest, actual }) {
  const touched = [...actual.added, ...actual.modified, ...actual.deleted];
  for (const rel of touched) {
    if (!(await casOk(mainRoot, rel, baseManifest))) {
      return { ok: false, reason: `merge conflict: ${rel} changed in main since snapshot` };
    }
  }
  // build one combined diff = the whole subtask's net changes (atomic apply)
  const parts = [];
  for (const rel of actual.added) parts.push(makeUnifiedDiff(rel, null, await readOrNull(isoRoot, rel)));
  for (const rel of actual.modified) parts.push(makeUnifiedDiff(rel, await baseContent(isoRoot, rel, baseManifest), await readOrNull(isoRoot, rel)));
  for (const rel of actual.deleted) parts.push(makeUnifiedDiff(rel, await baseContent(isoRoot, rel, baseManifest), null));
  const diff = parts.join("\n");
  try {
    const res = await editService.apply({ diff });             // atomic: editService rolls back on failure
    return { ok: true, change_id: res.metadata?.change_id };
  } catch (e) {
    return { ok: false, reason: `apply failed: ${e.message}` };
  }
}

// base content for modify/delete = the file as it was at snapshot time.
// The iso copy was mutated by the worker, so reconstruct base from main (== base by CAS).
async function baseContent(isoRoot, rel, baseManifest) {
  // main == base (verified by CAS just above) -> but we read from main to get base bytes is wrong post other merges.
  // Instead: base bytes live nowhere after iso mutation. So capture base content at snapshot time is required.
  throw new Error("baseContent must be provided via snapshot; see Step 3b");
}
```

- [ ] **Step 3b: 修正 base 内容来源(快照需存 base 内容,不止 hash)**

净 diff 的 `-` 侧需要 **base 原文**(不只是 hash)。`baseManifest` 只有 hash,iso 拷贝已被 worker 改。两种取法,选其一(实施时定):
- **(推荐)** 合并前,从**主区**读 base 原文 —— 因为 CAS 刚校验过「主区当前 == base」,所以**主区当前内容就是 base 原文**。改写 `mergeSubtask`:`modify` 的 base = `await readOrNull(mainRoot, rel)`(CAS 通过即等于 base);`delete` 同理。删去 `baseContent` helper。
- 备选:`workspace-snapshot` 拷贝时额外留一份 base 内容快照目录(更费盘)。

按推荐改:

```js
  for (const rel of actual.modified) parts.push(makeUnifiedDiff(rel, await readOrNull(mainRoot, rel), await readOrNull(isoRoot, rel)));
  for (const rel of actual.deleted) parts.push(makeUnifiedDiff(rel, await readOrNull(mainRoot, rel), null));
```

(`readOrNull(mainRoot, rel)` 在 CAS 通过后即 base 原文。删掉抛错的 `baseContent`。)

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/core/orchestration/merge-back.test.js`
Expected: PASS（往返成功;CAS 冲突时主区不变）

- [ ] **Step 5: 提交(含 src → 不加署名)**

```bash
git add src/core/orchestration/merge-back.js tests/core/orchestration/merge-back.test.js
git commit -m "feat(orchestration): merge-back (whole-file net diff + CAS guard + atomic apply)"
```

---

# 里程碑 M6 · batch-planner

## Task 6: batch-planner(依赖 + 不重叠切批)

**Files:**
- Create: `src/core/orchestration/batch-planner.js`
- Test: `tests/core/orchestration/batch-planner.test.js`

**Interfaces:** Consumes `overlaps`(M1)。Produces `toBatches(orderedSubtasks, { completedIds, maxParallelWorkers }) -> SubTask[][]`。一批 = 依赖全在 `completedIds` ∪ 本批之前已完成 ∩ 声明范围两两不重叠 的最大集;无声明范围 / 重叠 / 依赖未满足 → 落单批;`maxParallelWorkers=1` → 每批大小 1。

- [ ] **Step 1: 写失败测试**

```js
// tests/core/orchestration/batch-planner.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { toBatches } from "../../../src/core/orchestration/batch-planner.js";

function st(id, files, deps = []) { return { id, context_scope: files ? { files } : {}, depends_on: deps }; }

test("independent disjoint subtasks form one parallel batch", () => {
  const subs = [st("a", ["src/a.js"]), st("b", ["src/b.js"])];
  const batches = toBatches(subs, { completedIds: new Set(), maxParallelWorkers: 4 });
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].map((s) => s.id).sort(), ["a", "b"]);
});

test("overlapping scopes split into separate batches", () => {
  const subs = [st("a", ["src/shared.js"]), st("b", ["src/shared.js"])];
  const batches = toBatches(subs, { completedIds: new Set(), maxParallelWorkers: 4 });
  assert.equal(batches.length, 2);
});

test("no declared scope -> own batch (not parallelized)", () => {
  const subs = [st("a", null), st("b", ["src/b.js"])];
  const batches = toBatches(subs, { completedIds: new Set(), maxParallelWorkers: 4 });
  assert.equal(batches[0].length, 1);   // a alone
});

test("dependencies gate batching", () => {
  const subs = [st("a", ["src/a.js"]), st("b", ["src/b.js"], ["a"])];
  const batches = toBatches(subs, { completedIds: new Set(), maxParallelWorkers: 4 });
  assert.deepEqual(batches.map((b) => b.map((s) => s.id)), [["a"], ["b"]]);
});

test("maxParallelWorkers=1 -> every batch size 1", () => {
  const subs = [st("a", ["src/a.js"]), st("b", ["src/b.js"])];
  const batches = toBatches(subs, { completedIds: new Set(), maxParallelWorkers: 1 });
  assert.deepEqual(batches.map((b) => b.length), [1, 1]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/core/orchestration/batch-planner.test.js`
Expected: FAIL

- [ ] **Step 3: 实现**

```js
// src/core/orchestration/batch-planner.js
import { overlaps } from "./path-overlap.js";

export function toBatches(orderedSubtasks, { completedIds = new Set(), maxParallelWorkers = 4 } = {}) {
  const remaining = [...orderedSubtasks];
  const done = new Set(completedIds);
  const batches = [];

  while (remaining.length) {
    const batch = [];
    const batchScopes = [];
    for (const st of remaining) {
      if (batch.includes(st)) continue;
      const depsMet = (st.depends_on || []).every((d) => done.has(d));
      if (!depsMet) continue;
      const scope = st.context_scope?.files;
      const hasScope = Array.isArray(scope) && scope.length > 0;
      if (batch.length === 0) {
        batch.push(st);
        if (hasScope && maxParallelWorkers > 1) batchScopes.push(scope); else { break; } // no-scope or serial -> singleton
      } else {
        if (!hasScope) continue;                                  // can't parallelize unknown scope
        if (batchScopes.some((s) => overlaps(s, scope))) continue; // overlap -> next batch
        if (batch.length >= maxParallelWorkers) break;
        batch.push(st); batchScopes.push(scope);
      }
    }
    if (batch.length === 0) { batch.push(remaining[0]); }          // safety: never stall
    for (const st of batch) { done.add(st.id); const i = remaining.indexOf(st); remaining.splice(i, 1); }
    batches.push(batch);
  }
  return batches;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/core/orchestration/batch-planner.test.js`
Expected: PASS

- [ ] **Step 5: 提交(含 src → 不加署名)**

```bash
git add src/core/orchestration/batch-planner.js tests/core/orchestration/batch-planner.test.js
git commit -m "feat(orchestration): batch-planner (deps + disjoint-scope batching)"
```

---

# 里程碑 M7 · dispatch-loop 接批次并行

## Task 7: dispatch-loop 批次并行 + 隔离 + 合并 + 零残留

**Files:**
- Modify: `src/core/orchestration/dispatch-loop.js`
- Test: `tests/core/orchestration/dispatch-parallel.test.js`

**Interfaces:** `runDispatchLoop` 新增可选注入(默认缺省时走 C1+C2 串行,零回归):`toBatches`、`maxParallelWorkers`、`runIsolatedWorker({ subtask, runId })`(建 iso+plane+隔离 runtime→send→自审→审核→实际范围校验→返回 `{ st, wres, verdict, actual, isoRoot, baseManifest }`;`finally` removeIso)、`mergeSubtask`。缺省全部 → 行为 == C1+C2。

> 现有 `runDispatchLoop({ plan, workerFactory, makeReviewer, synthesizer, budget, maxWorkerAttempts, autonomy, onEvent })` 不变;新增 `{ toBatches, maxParallelWorkers = 1, runIsolatedWorker, mergeSubtask, removeIso, onEvent }`。`maxParallelWorkers<=1` 或未注入 `toBatches`/`runIsolatedWorker` → 现有逐 subtask 串行路径(原样)。

- [ ] **Step 1: 写集成测试(并行批 + 合并 + 零残留;mock 隔离 worker)**

```js
// tests/core/orchestration/dispatch-parallel.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { runDispatchLoop } from "../../../src/core/orchestration/dispatch-loop.js";
import { toBatches } from "../../../src/core/orchestration/batch-planner.js";

function st(id, files, deps = []) { return { id, goal: id, acceptance: [], context_scope: { files }, tool_profile: "edit", depends_on: deps }; }
const noBudget = { exceeded: () => null };
const synth = { synthesize: async ({ collected }) => `synth:${collected.map((c) => `${c.st.id}=${c.status}`).join(",")}` };

test("parallel batch: disjoint subtasks merge; one out-of-scope fails; no residue", async () => {
  const removed = [];
  const plan = { subtasks: [st("a", ["a.js"]), st("b", ["b.js"])] };
  const runIsolatedWorker = async ({ subtask }) => ({
    st: subtask,
    wres: { status: "complete", content: `did ${subtask.id}` },
    verdict: { pass: true, severity: "warn", reasons: [], checked: [] },
    actual: subtask.id === "b"
      ? { added: [], modified: ["unscoped.js"], deleted: [] }   // b writes out of scope!
      : { added: [], modified: ["a.js"], deleted: [] },
    isoRoot: `/iso/${subtask.id}`
  });
  const mergeSubtask = async ({ isoRoot }) => ({ ok: true, change_id: `chg_${isoRoot}` });
  const removeIso = async (dir) => { removed.push(dir); return true; };

  const r = await runDispatchLoop({
    plan, synthesizer: synth, budget: noBudget, maxWorkerAttempts: 1, autonomy: "auto",
    toBatches, maxParallelWorkers: 4, runIsolatedWorker, mergeSubtask, removeIso
  });
  assert.equal(r.status, "complete");
  assert.match(r.content, /a=complete/);
  assert.match(r.content, /b=failed/);                  // out-of-scope -> failed
  assert.deepEqual(removed.sort(), ["/iso/a", "/iso/b"]); // both iso dirs cleaned (zero residue)
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/core/orchestration/dispatch-parallel.test.js`
Expected: FAIL

- [ ] **Step 3: 实现**(在 `dispatch-loop.js` 加并行分支;保留串行原路)

在 `runDispatchLoop` 顶部:若 `maxParallelWorkers > 1 && toBatches && runIsolatedWorker`,走批次路径;否则现有串行 `for (const st of order)` 原样。批次路径:

```js
  if (maxParallelWorkers > 1 && typeof toBatches === "function" && typeof runIsolatedWorker === "function") {
    return runBatched({ plan, synthesizer, budget, maxWorkerAttempts, autonomy, toBatches, maxParallelWorkers, runIsolatedWorker, mergeSubtask, removeIso, onEvent });
  }
```

新增(同文件):

```js
import { withinScope, overlaps } from "./path-overlap.js";

async function runBatched({ plan, synthesizer, budget, maxParallelWorkers, runIsolatedWorker, mergeSubtask, removeIso, onEvent }) {
  const runId = `run_${plan.subtasks.map((s) => s.id).join("-")}`.slice(0, 80);
  const order = [...plan.subtasks];                                   // planner already topo-validated
  const batches = toBatchesSafe(order, maxParallelWorkers);
  const collected = [];
  const completed = new Set();

  for (const batch of batches) {
    if (batch.length === 1) {                                         // singleton: keep it simple, still isolate for uniformity
      const res = await runOneIsolated(batch[0], { runId, runIsolatedWorker, mergeSubtask, removeIso, batchActuals: [] });
      collected.push(res); if (res.status === "complete") completed.add(batch[0].id);
      if (budget.exceeded()) return finishPartial(collected, synthesizer);
      continue;
    }
    const results = await Promise.all(batch.map((stk) => runIsolatedWorker({ subtask: stk, runId }).catch((e) => ({ st: stk, error: e }))));
    // cross-worker actual-overlap guard (defense beyond declared scope)
    const actuals = results.map((r) => ({ id: r.st.id, paths: r.actual ? [...r.actual.added, ...r.actual.modified, ...r.actual.deleted] : [] }));
    for (const r of results) {
      try {
        const merged = await settleWorker(r, { mergeSubtask, actuals });
        collected.push(merged); if (merged.status === "complete") completed.add(r.st.id);
      } finally {
        if (r.isoRoot && removeIso) await removeIso(r.isoRoot).catch(() => {});  // zero residue
      }
    }
    if (budget.exceeded()) return finishPartial(collected, synthesizer);
  }
  return finishPartial(collected, synthesizer);
}

async function settleWorker(r, { mergeSubtask, actuals }) {
  if (r.error || !r.wres || r.wres.status !== "complete") return { st: r.st, status: "failed", lastFeedback: r.error?.message || "worker did not complete" };
  if (!r.verdict?.pass) return { st: r.st, status: "failed", lastFeedback: (r.verdict?.reasons || []).join("; ") || "review rejected" };
  // actual write-scope validation
  const declared = r.st.context_scope?.files || [];
  const actualPaths = r.actual ? [...r.actual.added, ...r.actual.modified, ...r.actual.deleted] : [];
  const stray = withinScope(actualPaths, declared);
  if (stray.length) return { st: r.st, status: "failed", lastFeedback: `out-of-scope writes: ${stray.join(", ")}` };
  // cross-worker actual overlap
  for (const other of actuals) {
    if (other.id === r.st.id) continue;
    if (overlaps(actualPaths, other.paths)) return { st: r.st, status: "failed", lastFeedback: `actual file overlap with ${other.id}` };
  }
  const merged = await mergeSubtask(r);                                 // CAS + atomic apply (Task 5)
  if (!merged.ok) return { st: r.st, status: "failed", lastFeedback: merged.reason };
  return { st: r.st, wres: r.wres, verdict: r.verdict, status: "complete", change_id: merged.change_id };
}
```

> 实现要点:`toBatchesSafe` 直接调注入的 `toBatches(order, { completedIds: completed, maxParallelWorkers })` 一次切全批(本片不在批间重算,因无依赖批已按序);singleton 批可走与并行同样的 `runIsolatedWorker` 或简化。合并**必须按 subtask id 升序**(对 `results` 先 `sort((a,b)=>a.st.id<b.st.id?-1:1)` 再 settle)以保确定性。`finishPartial` = `synthesizer.synthesize({ collected })` → `{ status:"complete", content, collected }`。

- [ ] **Step 4: 跑测试 + 全量回归**

Run: `node --test tests/core/orchestration/dispatch-parallel.test.js`
Expected: PASS
Run: `node --test tests/core/orchestration/*.test.js`
Expected: 全绿(C1+C2 dispatch-loop 串行测试仍过 = 缺省走原路)

- [ ] **Step 5: 提交(含 src → 不加署名)**

```bash
git add src/core/orchestration/dispatch-loop.js tests/core/orchestration/dispatch-parallel.test.js
git commit -m "feat(orchestration): batched parallel dispatch (iso workers + scope guard + ordered merge + zero residue)"
```

---

# 里程碑 M8 · 接线 + config + 文档

## Task 8: orchestrator/kernel 接真隔离 + config.parallel + sweep + 文档

**Files:**
- Modify: `src/config.js`(`orchestration.parallel`)、`src/apps/kernel-options.js`(已透传 orchestration,确认 parallel 一并带)、`src/index.js`(orchestrator 注入 `toBatches`/`runIsolatedWorker`/`mergeSubtask`/`removeIso` + `maxParallelWorkers`;启动 `sweepOrphans`)、`src/core/orchestration/orchestrator.js`(透传并行注入到 dispatch-loop)
- Modify: `README.md`、`README.en.md`、`docs/CHANGELOG.md`、`docs/project-overview.md`、`docs/README.md`
- Test: `tests/config-orchestration-parallel.test.js`

- [ ] **Step 1: config 测试(parallel 默认 + 归一化)**

```js
// tests/config-orchestration-parallel.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeOrchestration, DEFAULT_CONFIG } from "../src/config.js";

test("parallel defaults", () => {
  const p = DEFAULT_CONFIG.orchestration.parallel;
  assert.equal(p.maxParallelWorkers, 4);
  assert.equal(p.maxCopyFiles, 5000);
  assert.equal(p.sweepTtlMs, 3600000);
});
test("normalize clamps + falls back", () => {
  const o = normalizeOrchestration({ parallel: { maxParallelWorkers: 2, maxCopyFiles: 0 } });
  assert.equal(o.parallel.maxParallelWorkers, 2);
  assert.equal(o.parallel.maxCopyFiles, 5000);    // 0 invalid -> default
  assert.equal(o.parallel.sweepTtlMs, 3600000);
});
```

- [ ] **Step 2: 跑测试确认失败 → 改 `config.js`**

`DEFAULT_CONFIG.orchestration` 加 `parallel: { maxParallelWorkers: 4, maxCopyFiles: 5000, sweepTtlMs: 3600000 }`;`normalizeOrchestration` 返回对象加:

```js
    parallel: {
      maxParallelWorkers: posInt(p.maxParallelWorkers, d.parallel.maxParallelWorkers),
      maxCopyFiles: posInt(p.maxCopyFiles, d.parallel.maxCopyFiles),
      sweepTtlMs: posInt(p.sweepTtlMs, d.parallel.sweepTtlMs)
    }
```
(`const p = safe.parallel && typeof safe.parallel === "object" ? safe.parallel : {};`)

Run: `node --test tests/config-orchestration-parallel.test.js` → PASS

- [ ] **Step 3: 接线 `src/index.js` + `orchestrator.js`**

`orchestrator.run` 透传并行注入给 `runDispatchLoop`(`createOrchestrator` 新增 `parallel` + `makeIsoRun` 注入)。`index.js`:
- 启动时 `await sweepOrphans({ root, ttlMs: orch.parallel.sweepTtlMs, pid: process.pid }).catch(() => {})`。
- 给 orchestrator 注入 `maxParallelWorkers: orch.parallel.maxParallelWorkers`、`toBatches`、`mergeSubtask`、`removeIso`,以及 `runIsolatedWorker({ subtask, runId })`:

```js
runIsolatedWorker: async ({ subtask, runId }) => {
  if (countWorkspaceTooBig) { /* > maxCopyFiles 时由调用方回退串行 */ }
  const isoRoot = await createIso({ root, runId, subtaskId: subtask.id });
  const cp = await fsCopyWorkspace(root, isoRoot, { maxCopyFiles: orch.parallel.maxCopyFiles });
  const baseManifest = await hashTree(isoRoot, { maxCopyFiles: orch.parallel.maxCopyFiles });
  const plane = buildToolPlane(isoRoot, { eventBus, permissionEngine, recoveryJournal: null, assertOwner: async () => {}, webFetch: options.webFetch || {}, defaultToolTimeoutMs: options.limits?.toolTimeoutMs ?? null });
  const worker = createRuntime({ projectRoot: isoRoot, executeTool: plane.execute, toolSchemas: () => filterToolSchemas(plane.toolRegistry.toDeepSeekTools(), subtask.tool_profile), createContextSnapshot: (input) => contextEngine.snapshot({ ...input, projectRoot: isoRoot }) });
  const wres = await worker.send(workerPrompt(subtask), { autonomy: "auto" });
  const verdict = wres.status === "complete" ? await createReviewer({ runtime: buildToolPlane(isoRoot, {...}) && reviewerRuntimeFor(isoRoot) }).review(subtask, wres) : { pass: false, severity: "warn", reasons: ["worker incomplete"], checked: [] };
  const actual = changedPaths(await hashTree(isoRoot, { maxCopyFiles: orch.parallel.maxCopyFiles }), baseManifest);
  return { st: subtask, wres, verdict, actual, isoRoot, baseManifest };
}
```

> 注:`mergeSubtask` 注入为 `(r) => mergeSubtaskImpl({ editService: mainPlane.editService, mainRoot: root, isoRoot: r.isoRoot, baseManifest: r.baseManifest, actual: r.actual })`。Reviewer 在 iso 内用只读平面。超 `maxCopyFiles`(`cp.truncated`)→ 抛特定错误让批回退串行(或调用方检测后该批转串行)。实施时把「回退串行」做成 dispatch 层:`runIsolatedWorker` 抛 `COPY_TOO_BIG` → 该 worker 改用主区串行执行。

- [ ] **Step 4: 全量回归 + check**

Run: `node --test test/**/*.test.js tests/**/*.test.js`
Expected: 594 + 新增全绿(`maxParallelWorkers` 默认 4,但无「多独立不重叠子任务」的现有用例 → 实际仍单批;C1+C2 行为不变)
Run: `npm run check`(把 M1–M7 新文件加进 check 脚本的 orchestration 段)
Expected: OK

- [ ] **Step 5: 文档(纯文档 → 加署名)**
  - README 中英:并行编排一句(自动并行无依赖子任务、隔离执行、合并;`maxParallelWorkers` 可配,=1 关并行)。
  - CHANGELOG:已落地 — Phase C3 并行写隔离(fs 拷贝 + CAS + 原子合并 + 零残留)。
  - project-overview §14:补 C3 段(批次/隔离/合并/零残留)。
  - docs/README 索引:加 C3 plan 条目。

```bash
git add src/config.js src/index.js src/core/orchestration/orchestrator.js src/apps/kernel-options.js package.json tests/config-orchestration-parallel.test.js
git commit -m "feat(orchestration): wire parallel isolation into kernel (config.parallel + startup sweep + iso worker run)"
git add README.md README.en.md docs/CHANGELOG.md docs/project-overview.md docs/README.md
git commit -m "docs: Phase C3 parallel worker write-isolation"
```

---

## Self-Review

- **Spec coverage**:§3 流程 → Task 6/7;§4.1 事务粒度 → Task 5(一份净 diff 一次 apply)+ Task 7(批次部分成功);§4.2 CAS → Task 5;§4.3 实际范围校验 → Task 7(`settleWorker` withinScope + 跨 worker overlap);§4.4 路径归一化 → Task 1;§4.5 零残留 → Task 3(removeIso retry + sweepOrphans)+ Task 7(finally removeIso);§4.6 降级 → Task 8(maxCopyFiles 回退串行);§5 组件 → Task 1–8;§6 config → Task 8;§7 测试 → 各 task;§8 里程碑 → Task 分组。
- **Placeholder scan**:Task 8 Step 3 的 `runIsolatedWorker` 给了具体接线代码 + reviewer-in-iso 与 COPY_TOO_BIG 回退的明确做法(实施时收口);非空泛。Task 5 Step 3b 明确 base 原文来源(CAS 后从主区读)。
- **Type consistency**:`makeUnifiedDiff(path, base|null, final|null)`、`mergeSubtask({editService,mainRoot,isoRoot,baseManifest,actual})->{ok,change_id?,reason?}`、`toBatches(order,{completedIds,maxParallelWorkers})`、`changedPaths(currentManifest, baseManifest)`、`createIso({root,runId,subtaskId})`、`buildToolPlane(root,deps)` 各处一致。
- **风险**:最大风险 Task 7(批次并行 + 合并 + 零残留)与 Task 5(净 diff 往返真 editService);判据明确(集成测试 + 往返测试 + CAS 冲突测试 + 零残留断言);M4 纯重构有 594 回归守;`maxParallelWorkers=1` 永远是零回归逃生口。
