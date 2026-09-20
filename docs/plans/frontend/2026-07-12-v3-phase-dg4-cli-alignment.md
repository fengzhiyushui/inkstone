# V3 Phase D-G4 · CLI 对齐 Implementation Plan

> 完成状态以 [CHANGELOG](../../CHANGELOG.md) 为准。


**Goal:** 实现路线图 D-G4 完成 V3 支柱③ —— 抽出三端共用的「共享事件展示契约」`describeEvent`,CLI/TUI/GUI-React 三个渲染器改为消费它;补齐 CLI 当前完全缺失的多 agent(orchestration/experience)摘要;TUI `/recovery` 补 `clear` 与 CLI 对齐。

**Architecture:** 新建纯函数模块 `src/apps/event-contract.js`,把三处并行的「事件→展示」字段兼容逻辑收敛为唯一语义源(输出 `{kind, sourceType, severity, quiet, fields}` 描述符);三个渲染器降为薄适配层(只读 `descriptor.*`,措辞/颜色/i18n 各自保留)。kernel `src/core`/`src/index.js` 零改动。

**Tech Stack:** Node.js ≥ 20 原生 ESM;`node:test` + `node:assert/strict`;零新增运行时依赖(手写纯 JS)。

## Global Constraints

以下为全局约束,每个 task 隐含包含(值逐字取自设计文档 §10):

- **kernel 零改动**:`src/core`、`src/index.js`、事件生产层 diff 必须为空。
- **契约是纯函数**:`describeEvent` 无 I/O、无副作用、任意输入(含 null/非对象/缺 type)不抛错。
- **现有 16 条渲染测试原样全绿**:CLI 6 + TUI 6 + GUI 4;已覆盖的 V2 事件逐端输出字节不变。**不删除、不放宽任何现有测试。**
- **编排事件输出有意改变**:Part B 为 CLI 新增编排/经验摘要,不对这些事件宣称「行为零变化」。
- **零新增运行时依赖**:契约手写纯 JS。
- **措辞/颜色/i18n 各端自持**:契约只出 `kind`/`severity`/`quiet`/`fields`,不含任何展示字符串。
- **`fields` 缺失一律 `null`**(不是 `""`、`0`、`"unknown"`);表现层负责 `null → 显示文本`。
- **CLI 文案硬规则**:单复数(`1 subtask` vs `N subtasks`);profile/severity 缺失不留空括号/悬空逗号;review 结果 `passed`/`failed` 二选一,不输出字面 `pass`/`fail`;契约字段名用 `reviewSeverity`(区别顶层 `severity`)。
- **每个 commit 不加 Co-Authored-By 尾注。**
- **验证命令**:`node --test <路径>` 跑单测;`npm run check` 跑语法检查;`npm test` 跑全量。

---

## 文件结构

| 文件 | 责任 | 动作 |
|---|---|---|
| `src/apps/event-contract.js` | 唯一语义源:`describeEvent(event)` → 描述符 | 新建 |
| `tests/unit/apps/event-contract.test.js` | 契约映射/别名/缺失/畸形/未知事件测试 | 新建 |
| `src/apps/cli/render-events.js` | CLI 薄适配:`describeEvent` → 英文单行摘要 + 编排摘要 | 改造 |
| `tests/unit/apps/cli/render-events.test.js` | +CLI 编排摘要断言(现有 6 条不动) | 追加 |
| `src/apps/tui/event-cards.js` | TUI 薄适配:`describeEvent` → 着色卡片 | 改造 |
| `src/apps/tui/tui-i18n.js` | +编排 subtask/plan 等 ev.* 词条(zh/en) | 追加 |
| `tests/unit/tui/event-cards.test.js` | +编排 subtask 卡片断言(现有 6 条不动) | 追加 |
| `gui/src/state/agent-cards.js` | GUI 薄适配:`describeEvent` 归一后折卡 | 改造 |
| `src/apps/tui/tui-app.js` | TUI `/recovery` 加 `clear` 分支 | 改造 |
| `src/apps/tui/tui-i18n.js` | `/recovery` usage 串加 clear(zh/en) | 改造 |
| `tests/unit/tui/recovery-clear.test.js` | TUI `/recovery clear` 用例 | 新建 |
| `package.json` | `check` 脚本加 `event-contract.js` | 改造 |
| `docs/CHANGELOG.md`、roadmap、project-overview | D-G4 落地回写 | 改造 |

**任务顺序:** Task 1(契约)→ Task 2(CLI 适配+编排摘要)→ Task 3(TUI 适配)→ Task 4(GUI 适配)→ Task 5(TUI /recovery clear)→ Task 6(check 脚本+文档回写)。Task 2–4 都依赖 Task 1 的 `describeEvent`。

---

### Task 1: 共享事件展示契约 `describeEvent`

**Files:**
- Create: `src/apps/event-contract.js`
- Test: `tests/unit/apps/event-contract.test.js`

**Interfaces:**
- Consumes: 无(纯输入内核事件对象)。
- Produces: `describeEvent(event) → { kind, sourceType, severity, quiet, fields }`。`kind` 取值见设计 §4.2;`severity ∈ {"info","success","warn","danger"}`;`quiet: boolean`;`fields` 缺失值为 `null`。别名归一:`name = call?.name || tool?.name || tool`;`changeId = change_id || record?.id`;`files` 取 `files` 数组否则 `summary` 数组,逐项 `{status:status||"M", path:path||file||null, added:Number.isFinite(added)?added:null, removed:Number.isFinite(removed)?removed:null}`;`argHint` 取 args 中 `path/file/pattern/command/query/url` 首个非空。畸形输入返回 `{kind:"other", sourceType:"", severity:"info", quiet:true, fields:{}}`。

- [ ] **Step 1: 写失败测试**

创建 `tests/unit/apps/event-contract.test.js`:

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import { describeEvent } from "../../../src/apps/event-contract.js";

test("malformed input never throws, returns other/quiet", () => {
  for (const bad of [null, undefined, 42, "x", {}, { nope: 1 }]) {
    const d = describeEvent(bad);
    assert.equal(d.kind, "other");
    assert.equal(d.quiet, true);
    assert.equal(d.severity, "info");
    assert.deepEqual(d.fields, {});
  }
});

test("tool:call name alias resolves from three shapes", () => {
  assert.equal(describeEvent({ type: "tool:call", call: { name: "read" } }).fields.name, "read");
  assert.equal(describeEvent({ type: "tool:call", tool: { name: "grep" } }).fields.name, "grep");
  assert.equal(describeEvent({ type: "tool:call", tool: "shell" }).fields.name, "shell");
});

test("tool:call argHint picks first non-empty key in order", () => {
  const d = describeEvent({ type: "tool:call", call: { name: "edit", args: { path: "src/a.js" } } });
  assert.equal(d.fields.argHint, "src/a.js");
  assert.equal(describeEvent({ type: "tool:call", call: { name: "x", args: {} } }).fields.argHint, null);
});

test("tool:result severity maps ok->success else warn", () => {
  assert.equal(describeEvent({ type: "tool:result", result: { status: "ok" } }).severity, "success");
  assert.equal(describeEvent({ type: "tool:result", status: "error" }).severity, "warn");
});

test("file:diff_applied normalizes files, changeId dual source", () => {
  const d = describeEvent({
    type: "file:diff_applied", change_id: "chg_1",
    files: [{ path: "src/a.js", status: "M", added: 2, removed: 1 }]
  });
  assert.equal(d.kind, "diff");
  assert.equal(d.severity, "success");
  assert.equal(d.fields.changeId, "chg_1");
  assert.deepEqual(d.fields.files[0], { status: "M", path: "src/a.js", added: 2, removed: 1 });
  const alt = describeEvent({ type: "file:diff_applied", record: { id: "chg_2" }, summary: [{ path: "b.js" }] });
  assert.equal(alt.fields.changeId, "chg_2");
  assert.deepEqual(alt.fields.files[0], { status: "M", path: "b.js", added: null, removed: null });
});

test("orchestration events map to prefixed kinds with fields", () => {
  assert.deepEqual(describeEvent({ type: "orchestration:routed", lane: "orchestrate" }),
    { kind: "orchestration-route", sourceType: "orchestration:routed", severity: "info", quiet: false, fields: { lane: "orchestrate", score: null } });
  assert.equal(describeEvent({ type: "orchestration:planned", subtasks: 3 }).kind, "orchestration-plan");
  assert.equal(describeEvent({ type: "orchestration:planned", subtasks: 3 }).fields.subtasks, 3);
  assert.equal(describeEvent({ type: "orchestration:round_started", round: 2, subtasks: 4 }).kind, "orchestration-round-start");
  const ss = describeEvent({ type: "orchestration:subtask_started", subtask_id: "s1", attempt: 1, tool_profile: "edit" });
  assert.equal(ss.kind, "orchestration-subtask-start");
  assert.deepEqual(ss.fields, { subtaskId: "s1", attempt: 1, toolProfile: "edit" });
  const sr = describeEvent({ type: "orchestration:subtask_reviewed", subtask_id: "s1", pass: false, severity: "high" });
  assert.equal(sr.kind, "orchestration-subtask-review");
  assert.equal(sr.severity, "warn");
  assert.deepEqual(sr.fields, { subtaskId: "s1", pass: false, reviewSeverity: "high" });
  const done = describeEvent({ type: "orchestration:completed", rounds: 2, completed: 3, failed: 1, status: "partial" });
  assert.equal(done.kind, "orchestration-complete");
  assert.equal(done.severity, "warn");
  assert.deepEqual(done.fields, { rounds: 2, completed: 3, failed: 1, status: "partial" });
});

test("experience:retrieved quiet when count zero", () => {
  assert.equal(describeEvent({ type: "experience:retrieved", count: 0 }).quiet, true);
  assert.equal(describeEvent({ type: "experience:retrieved", count: 2, tiers: ["T1"] }).quiet, false);
});

test("noisy + context events are quiet", () => {
  for (const type of ["model:request", "model:response", "agent:step", "agent:turn_started",
                      "context:snapshot", "context:cache_loaded", "context:warm"]) {
    assert.equal(describeEvent({ type }).quiet, true, type);
  }
});

test("unknown event falls back to other with sourceType preserved", () => {
  const d = describeEvent({ type: "some:new_thing" });
  assert.equal(d.kind, "other");
  assert.equal(d.sourceType, "some:new_thing");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/unit/apps/event-contract.test.js`
Expected: FAIL —— `Cannot find module '.../src/apps/event-contract.js'`。

- [ ] **Step 3: 写最小实现**

创建 `src/apps/event-contract.js`:

```javascript
// src/apps/event-contract.js — 共享事件展示契约(display contract)。
// 唯一语义源:内核事件 → 归一化展示描述符 { kind, sourceType, severity, quiet, fields }。
// 纯函数:无 I/O、无副作用、任意输入不抛错。表现层(CLI/TUI/GUI)只读描述符,不直接读 event.*。
// 明确边界:这不是 core 的事件生产契约(那由 src/sessions/event-types.js 负责),只做「已产出事件 → 展示语义」的单向映射。

const NOISY = new Set(["model:request", "model:response", "agent:step", "agent:turn_started"]);
const ARG_KEYS = ["path", "file", "pattern", "command", "query", "url"];

function num(v) { return Number.isFinite(v) ? v : null; }
function str(v) { return typeof v === "string" && v.length ? v : null; }

function toolName(event) {
  return str(event.call?.name) || str(event.tool?.name) || str(event.tool) || null;
}
function argHint(event) {
  const args = event.call?.args || event.call?.arguments || event.args;
  if (!args || typeof args !== "object") return null;
  for (const k of ARG_KEYS) { if (args[k]) return String(args[k]); }
  return null;
}
function changeId(event) {
  return str(event.change_id) || str(event.record?.id) || null;
}
function normFiles(event) {
  const raw = (Array.isArray(event.files) && event.files.length) ? event.files
    : (Array.isArray(event.summary) ? event.summary : []);
  return raw.map((e) => ({
    status: str(e?.status) || "M",
    path: str(e?.path) || str(e?.file) || null,
    added: num(e?.added),
    removed: num(e?.removed)
  }));
}
function d(kind, sourceType, severity, quiet, fields) {
  return { kind, sourceType, severity, quiet, fields };
}

export function describeEvent(event) {
  if (!event || typeof event !== "object" || typeof event.type !== "string") {
    return d("other", "", "info", true, {});
  }
  const type = event.type;
  const src = type;

  if (NOISY.has(type)) return d("other", src, "info", true, {});
  if (type.startsWith("context:")) return d("context", src, "info", true, {});

  if (type === "user:message") return d("user", src, "info", true, { text: str(event.content) });
  if (type === "agent:final") return d("final", src, "success", true, { content: str(event.content) });
  if (type === "agent:error") return d("error", src, "danger", true, { message: str(event.message) || str(event.error) });

  if (type === "tool:call") return d("tool-call", src, "info", false, { name: toolName(event), argHint: argHint(event) });
  if (type === "tool:result") {
    const status = str(event.result?.status) || str(event.status);
    return d("tool-result", src, status === "ok" ? "success" : "warn", false, { status });
  }
  if (type === "permission:decision") return d("permission", src, "info", false, { decision: str(event.permission?.decision) || str(event.decision) });
  if (type === "approval:requested") return d("approval", src, "warn", false, { id: str(event.approval?.id), summary: str(event.approval?.summary) });
  if (type === "approval:resolved") return d("approval-resolved", src, "info", false, { decision: str(event.decision) || str(event.approval?.decision) });

  if (type === "file:diff_preview") return d("diff-preview", src, "info", false, { summaryText: str(event.summary_text), diffHash: str(event.diff_hash) });
  if (type === "file:diff_applied") return d("diff", src, "success", false, { changeId: changeId(event), files: normFiles(event) });
  if (type === "file:rollback_applied") return d("rollback", src, "warn", false, { changeId: changeId(event) });
  if (type === "verification:result") {
    const status = str(event.result?.status) || str(event.status);
    const pass = typeof event.pass === "boolean" ? event.pass : (status === "passed" || status === "pass");
    return d("verification", src, (status === "passed" || pass) ? "success" : "warn", false, { status, pass });
  }
  if (type.startsWith("repair:")) return d("repair", src, "info", false, { phase: type.slice("repair:".length) });

  if (type === "orchestration:routed") return d("orchestration-route", src, "info", false, { lane: str(event.lane), score: num(event.score) });
  if (type === "orchestration:route_resolved") return d("orchestration-route", src, "info", false, { lane: str(event.lane) || str(event.route), score: num(event.score) });
  if (type === "orchestration:planned") return d("orchestration-plan", src, "info", false, { subtasks: num(event.subtasks), doneWhen: str(event.done_when) });
  if (type === "orchestration:round_started") return d("orchestration-round-start", src, "info", false, { round: num(event.round), subtasks: num(event.subtasks) });
  if (type === "orchestration:subtask_started") return d("orchestration-subtask-start", src, "info", false, { subtaskId: str(event.subtask_id), attempt: num(event.attempt), toolProfile: str(event.tool_profile) });
  if (type === "orchestration:subtask_reviewed") return d("orchestration-subtask-review", src, event.pass ? "success" : "warn", false, { subtaskId: str(event.subtask_id), pass: Boolean(event.pass), reviewSeverity: str(event.severity) });
  if (type === "orchestration:replanned") return d("orchestration-replan", src, "info", false, { round: num(event.round), newSubtasks: num(event.new_subtasks) });
  if (type === "orchestration:completed") {
    const failed = num(event.failed) || 0;
    return d("orchestration-complete", src, failed > 0 ? "warn" : "success", false, { rounds: num(event.rounds), completed: num(event.completed), failed: num(event.failed), status: str(event.status) });
  }
  if (type.startsWith("orchestration:")) return d("other", src, "info", false, {});

  if (type === "experience:retrieved") {
    const count = num(event.count) || 0;
    return d("experience-retrieved", src, "info", count === 0, { count: num(event.count), tiers: Array.isArray(event.tiers) ? event.tiers : null });
  }

  if (type === "recovery:report") return d("recovery-report", src, "info", false, { found: num(event.found_count), done: num(event.done_count), blocked: num(event.blocked_count) });
  if (type === "recovery:blocked") return d("recovery-blocked", src, "warn", false, { reason: str(event.reason), itemId: str(event.item_id) || str(event.source_id) });

  if (type.startsWith("session:rewind_")) {
    const phase = type.slice("session:rewind_".length);
    const danger = phase === "conflict" || phase === "failed" || phase === "recovery_failed";
    const success = phase === "applied" || phase === "restored";
    return d("rewind", src, danger ? "danger" : (success ? "success" : "info"), false, {
      phase,
      branchId: str(event.branch_id),
      changeCount: num(event.rollback_count) ?? (Array.isArray(event.rollback_change_ids) ? event.rollback_change_ids.length : (Array.isArray(event.applied_rollbacks) ? event.applied_rollbacks.length : (Array.isArray(event.restored_files) ? event.restored_files.length : null))),
      failedChangeId: str(event.failed_change_id),
      reason: str(event.reason) || str(event.restore_error)
    });
  }
  if (type === "session:branch_created" || type === "session:branch_activated") return d("branch", src, "info", false, { branchId: str(event.branch_id) });
  if (type === "tx:recovered") return d("tx-recovered", src, "info", false, { kind: str(event.kind), txId: str(event.tx_id), preservedCount: num(event.preserved_count) });
  if (type === "turn:rehydrated" || type === "turn:cancelled") return d("turn", src, "info", false, { approvalId: str(event.approval_id) });
  if (type === "takeover:requested" || type === "takeover:completed") return d("takeover", src, "info", false, { requestId: str(event.request_id) });

  return d("other", src, "info", type === "user:message" ? true : false, {});
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/unit/apps/event-contract.test.js`
Expected: PASS(全部用例)。

- [ ] **Step 5: 提交**

```bash
git add src/apps/event-contract.js tests/unit/apps/event-contract.test.js
git commit -m "feat(apps): 共享事件展示契约 describeEvent(D-G4 契约)"
```

---

### Task 2: CLI 渲染器消费契约 + 多 agent 摘要

**Files:**
- Modify: `src/apps/cli/render-events.js`
- Test: `tests/unit/apps/cli/render-events.test.js`(追加,现有 6 条不动)

**Interfaces:**
- Consumes: Task 1 `describeEvent(event)`。
- Produces: `summarizeKernelEvent(event) → string`(现有 V2 输出字节不变;新增编排/经验行)。`renderKernelResult`、`createEventRenderer` 签名不变。

- [ ] **Step 1: 写失败测试(追加,不动现有 6 条)**

在 `tests/unit/apps/cli/render-events.test.js` 末尾追加:

```javascript
test("summarizeKernelEvent renders multi-agent orchestration summaries", () => {
  assert.equal(summarizeKernelEvent({ type: "orchestration:routed", lane: "orchestrate" }), "routing: multi-agent");
  assert.equal(summarizeKernelEvent({ type: "orchestration:planned", subtasks: 1 }), "plan: 1 subtask");
  assert.equal(summarizeKernelEvent({ type: "orchestration:planned", subtasks: 3 }), "plan: 3 subtasks");
  assert.equal(summarizeKernelEvent({ type: "orchestration:round_started", round: 2, subtasks: 1 }), "round 2: 1 subtask");
  assert.equal(summarizeKernelEvent({ type: "orchestration:round_started", round: 2, subtasks: 4 }), "round 2: 4 subtasks");
  assert.equal(summarizeKernelEvent({ type: "orchestration:replanned", round: 3, new_subtasks: 1 }), "replan round 3: 1 new subtask");
  assert.equal(summarizeKernelEvent({ type: "orchestration:replanned", round: 3, new_subtasks: 2 }), "replan round 3: 2 new subtasks");
  assert.equal(summarizeKernelEvent({ type: "orchestration:completed", completed: 3, failed: 1, status: "partial" }), "orchestration complete: 3 succeeded, 1 failed (status: partial)");
});

test("subtask start/review: no dangling parens/commas, passed|failed literal", () => {
  assert.equal(summarizeKernelEvent({ type: "orchestration:subtask_started", subtask_id: "s1", attempt: 1, tool_profile: "edit" }), "subtask s1: starting (attempt 1, profile edit)");
  assert.equal(summarizeKernelEvent({ type: "orchestration:subtask_started", subtask_id: "s2", attempt: 2 }), "subtask s2: starting (attempt 2)");
  assert.equal(summarizeKernelEvent({ type: "orchestration:subtask_reviewed", subtask_id: "s1", pass: true }), "subtask s1: review passed");
  assert.equal(summarizeKernelEvent({ type: "orchestration:subtask_reviewed", subtask_id: "s1", pass: false, severity: "high" }), "subtask s1: review failed (severity: high)");
  assert.equal(summarizeKernelEvent({ type: "orchestration:subtask_reviewed", subtask_id: "s1", pass: false }), "subtask s1: review failed");
});

test("experience:retrieved printed only when count>0", () => {
  const lines = [];
  const renderer = createEventRenderer({ write: (l) => lines.push(l) });
  renderer({ type: "experience:retrieved", count: 0 });
  renderer({ type: "experience:retrieved", count: 2, tiers: ["T1", "T2"] });
  assert.deepEqual(lines, ["- experience: 2 recalled"]);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/unit/apps/cli/render-events.test.js`
Expected: FAIL —— 新用例报错(现有编排事件走兜底返回类型串,如 `"orchestration:planned"` ≠ `"plan: 3 subtasks"`)。

- [ ] **Step 3: 改造实现**

改写 `src/apps/cli/render-events.js`。`summarizeKernelEvent` 顶部接入契约并处理编排/经验 kind,其余保留现有分支(保证 V2 输出字节不变);`createEventRenderer` 用契约 `quiet` 决定是否打印:

```javascript
import { describeEvent } from "../event-contract.js";

const QUIET_EVENTS = new Set(["model:request", "model:response", "agent:step", "agent:turn_started"]);

function plural(n, unit) {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

function orchestrationSummary(d) {
  const f = d.fields;
  switch (d.kind) {
    case "orchestration-route": return "routing: multi-agent";
    case "orchestration-plan": return `plan: ${plural(f.subtasks ?? 0, "subtask")}`;
    case "orchestration-round-start": return `round ${f.round ?? 0}: ${plural(f.subtasks ?? 0, "subtask")}`;
    case "orchestration-replan": return `replan round ${f.round ?? 0}: ${plural(f.newSubtasks ?? 0, "new subtask")}`;
    case "orchestration-complete": return `orchestration complete: ${f.completed ?? 0} succeeded, ${f.failed ?? 0} failed (status: ${f.status ?? "unknown"})`;
    case "orchestration-subtask-start": {
      const attempt = `attempt ${f.attempt ?? 1}`;
      const parts = f.toolProfile ? `${attempt}, profile ${f.toolProfile}` : attempt;
      return `subtask ${f.subtaskId ?? "?"}: starting (${parts})`;
    }
    case "orchestration-subtask-review": {
      const verdict = f.pass ? "passed" : "failed";
      const sev = (!f.pass && f.reviewSeverity) ? ` (severity: ${f.reviewSeverity})` : "";
      return `subtask ${f.subtaskId ?? "?"}: review ${verdict}${sev}`;
    }
    default: return null;
  }
}

export function summarizeKernelEvent(event = {}) {
  const d = describeEvent(event);
  const orch = orchestrationSummary(d);
  if (orch) return orch;
  if (d.kind === "experience-retrieved") return `experience: ${d.fields.count ?? 0} recalled`;

  if (event.type === "user:message") return `user ${clip(event.content || "")}`;
  if (event.type === "tool:call") return `tool ${event.call?.name || event.tool?.name || event.tool || "unknown"}`;
  if (event.type === "tool:result") return `tool result ${event.result?.status || event.status || "unknown"}`;
  if (event.type === "permission:decision") return `permission ${event.permission?.decision || event.decision || "unknown"}`;
  if (event.type === "approval:requested") return `approval ${event.approval?.id || "unknown"} ${clip(event.approval?.summary || "")}`.trim();
  if (event.type === "file:diff_preview") return `diff preview ${event.summary || event.diff_hash || ""}`.trim();
  if (event.type === "file:diff_applied") return `diff applied ${event.change_id || event.record?.id || ""}`.trim();
  if (event.type === "file:rollback_applied") return `rollback ${event.change_id || event.record?.id || ""}`.trim();
  if (event.type === "verification:result") return `verification ${event.result?.status || event.status || "unknown"}`;
  if (event.type === "agent:final") return `final ${clip(event.content || "")}`.trim();
  if (event.type === "agent:error") return `error ${clip(event.message || event.error || "")}`.trim();
  if (event.type === "session:branch_created") return `branch created ${event.branch_id || "unknown"}`;
  if (event.type === "session:branch_activated") return `branch active ${event.branch_id || "unknown"}`;
  if (event.type === "session:rewind_preview") return `rewind preview ${event.rollback_count || event.rollback_change_ids?.length || 0} changes`;
  if (event.type === "session:rewind_applied") return `rewind applied ${event.branch_id || "unknown"} ${(event.rollback_change_ids || []).length} changes`;
  if (event.type === "session:rewind_conflict") return `rewind conflict ${event.failed_change_id || "unknown"}`;
  if (event.type === "session:rewind_failed") return `rewind failed ${event.failed_change_id || event.reason || "unknown"}`;
  if (event.type === "session:rewind_restore_started") return `rewind restoring ${(event.applied_rollbacks || []).length} changes`;
  if (event.type === "session:rewind_restored") return `rewind restored ${(event.restored_files || []).length} files`;
  if (event.type === "session:rewind_recovery_failed") return `rewind recovery failed ${event.reason || event.restore_error || "unknown"}`;
  if (event.type === "recovery:report") return `recovery report: found ${event.found_count || 0}, done ${event.done_count || 0}, blocked ${event.blocked_count || 0}`;
  if (event.type === "recovery:blocked") return `recovery blocked: ${event.reason || "unknown"} (${event.item_id || event.source_id || "unknown"})`;
  if (event.type === "tx:recovered") return `recovered ${event.kind || "transaction"} ${event.tx_id || "unknown"}, preserved ${event.preserved_count || 0}`;
  if (event.type === "turn:rehydrated") return `rehydrated approval ${event.approval_id || "unknown"}`;
  if (event.type === "turn:cancelled") return `cancelled approval ${event.approval_id || "unknown"}`;
  if (event.type === "takeover:requested") return `takeover requested ${event.request_id || "unknown"}`;
  if (event.type === "takeover:completed") return `takeover completed ${event.request_id || "unknown"}`;
  return event.type || "event";
}

export function renderKernelResult(result = {}) {
  if (result.status === "awaiting_approval") {
    return [
      "",
      `Approval required: ${result.approval?.id || "unknown"}`,
      "Approve? y/N"
    ];
  }
  if (result.status === "error") {
    return ["", `Error: ${result.error || result.message || "unknown error"}`];
  }
  return ["", result.content || ""];
}

export function createEventRenderer({ write = console.log } = {}) {
  return function renderEvent(event) {
    if (!event?.type || QUIET_EVENTS.has(event.type)) return;
    const d = describeEvent(event);
    if (d.quiet) return;
    write(`- ${summarizeKernelEvent(event)}`);
  };
}

function clip(value, max = 120) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}
```

> 注:`createEventRenderer` 原本只跳过 `QUIET_EVENTS`(4 个 model/step 事件),现改为同时跳过契约 `quiet` 项。现有测试 `createEventRenderer writes only useful progress events` 断言 `user:message` **会**打印(`"- user hi"`)—— 但契约把 `user:message` 标 `quiet:true`。**冲突!** 见 Step 3b 修正。

- [ ] **Step 3b: 修正 quiet 与现有测试的冲突**

现有测试要求 `createEventRenderer` 打印 `user:message` 为 `"- user hi"`,而契约标 `user:message` 为 `quiet:true`。为不放宽现有测试,`createEventRenderer` 的过滤**只用 `QUIET_EVENTS` 集合(原行为),不引入契约 quiet**。把 Step 3 中 `createEventRenderer` 改回:

```javascript
export function createEventRenderer({ write = console.log } = {}) {
  return function renderEvent(event) {
    if (!event?.type || QUIET_EVENTS.has(event.type)) return;
    const line = summarizeKernelEvent(event);
    // experience:retrieved 在 count===0 时不打印(契约 quiet);其余照原行为。
    const d = describeEvent(event);
    if (d.kind === "experience-retrieved" && d.quiet) return;
    write(`- ${line}`);
  };
}
```

这样:现有 `user:message → "- user hi"` 行为保留;新增 `experience:retrieved count:0` 被跳过、`count:2` 打印。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/unit/apps/cli/render-events.test.js`
Expected: PASS(现有 6 条 + 新增 3 条)。

- [ ] **Step 5: 提交**

```bash
git add src/apps/cli/render-events.js tests/unit/apps/cli/render-events.test.js
git commit -m "feat(cli): 消费共享契约 + 多 agent 摘要(D-G4 Part B)"
```

---

### Task 3: TUI 事件卡片消费契约 + 编排 subtask 卡片

**Files:**
- Modify: `src/apps/tui/event-cards.js`
- Modify: `src/apps/tui/tui-i18n.js`(追加 ev.* 词条)
- Test: `tests/unit/tui/event-cards.test.js`(追加,现有 6 条不动)

**Interfaces:**
- Consumes: Task 1 `describeEvent(event)`;`makeT` i18n;`theme.color`。
- Produces: `eventToLines(event, t) → string[]`(现有输出字节不变;新增 subtask start/review 卡片行)。`QUIET` 集合不变。

- [ ] **Step 1: 补 i18n 词条(zh + en)**

在 `src/apps/tui/tui-i18n.js` 的 zh 区块(ev.* 附近)加:

```javascript
    "ev.subtaskStart": "子任务",
    "ev.subtaskReview": "审核",
    "ev.reviewPass": "通过",
    "ev.reviewFail": "未通过",
```

en 区块对应加:

```javascript
    "ev.subtaskStart": "subtask",
    "ev.subtaskReview": "review",
    "ev.reviewPass": "passed",
    "ev.reviewFail": "failed",
```

- [ ] **Step 2: 写失败测试(追加)**

在 `tests/unit/tui/event-cards.test.js` 末尾追加:

```javascript
test("orchestration subtask start/review render distinct cards", () => {
  assert.match(flat({ type: "orchestration:subtask_started", subtask_id: "s1", attempt: 1, tool_profile: "edit" }), /子任务 s1/);
  assert.match(flat({ type: "orchestration:subtask_reviewed", subtask_id: "s1", pass: true }), /审核.*通过/);
  assert.match(flat({ type: "orchestration:subtask_reviewed", subtask_id: "s1", pass: false, severity: "high" }), /审核.*未通过/);
});

test("existing orchestration one-liners still render (planned/replanned)", () => {
  assert.match(flat({ type: "orchestration:planned", subtasks: 3 }), /orch|plan|子任务|round|3/);
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `node --test tests/unit/tui/event-cards.test.js`
Expected: FAIL —— subtask_started 走 `orchestration:` 前缀兜底显示 `orch ▸ subtask_started`,不含 `子任务 s1`。

- [ ] **Step 4: 改造实现**

在 `src/apps/tui/event-cards.js` 的 `eventToLines` 中,在 `if (type === "orchestration:route_resolved")` 之后、`if (type.startsWith("orchestration:"))` 之前插入两个专项分支(用契约取字段):

```javascript
import { describeEvent } from "../event-contract.js";
```

（顶部 import 追加;`color` import 保留）

在 route_resolved 分支后插入:

```javascript
  if (type === "orchestration:subtask_started") {
    const f = describeEvent(event).fields;
    const prof = f.toolProfile ? color.dim(` (${f.toolProfile})`) : "";
    return [` ${color.dim(`· ${t("ev.subtaskStart")} ${f.subtaskId || "?"}`)}${prof}`];
  }
  if (type === "orchestration:subtask_reviewed") {
    const f = describeEvent(event).fields;
    const verdict = f.pass ? color.green(t("ev.reviewPass")) : color.red(t("ev.reviewFail"));
    return [` ${color.dim(`· ${t("ev.subtaskReview")} ${f.subtaskId || "?"} `)}${verdict}`];
  }
```

其余分支(含 `orchestration:` 前缀兜底、route_resolved)保持不变,保证现有 6 条测试字节不变。

- [ ] **Step 5: 运行测试确认通过**

Run: `node --test tests/unit/tui/event-cards.test.js tests/unit/tui/tui-i18n.test.js`
Expected: PASS(event-cards 现有 6 + 新增 2;i18n parity 测试通过,因 zh/en 同步加了 4 个 key)。

- [ ] **Step 6: 提交**

```bash
git add src/apps/tui/event-cards.js src/apps/tui/tui-i18n.js tests/unit/tui/event-cards.test.js
git commit -m "feat(tui): 消费共享契约 + 编排 subtask 卡片(D-G4)"
```

---

### Task 4: GUI agent-cards 消费契约

**Files:**
- Modify: `gui/src/state/agent-cards.js`
- Test: `tests/unit/gui/agent-cards.test.js`(现有 4 条必须原样全绿;可追加 1 条断言归一一致)

**Interfaces:**
- Consumes: Task 1 `describeEvent(event)`(相对路径 `../../../src/apps/event-contract.js`)。
- Produces: `deriveAgentCards(activity) → card[]`(现有卡片形状与字段不变:plan/tool/diff/test)。

- [ ] **Step 1: 确认现有测试是基线(先跑一次)**

Run: `node --test tests/unit/gui/agent-cards.test.js`
Expected: PASS(4 条)—— 这是改造后必须保持的基线。

- [ ] **Step 2: 改造实现(用契约归一 diff 字段,卡片形状不变)**

改写 `gui/src/state/agent-cards.js`,把 diff 分支的字段抽取改为经 `describeEvent`,其余逻辑不变:

```javascript
// Fold the workbench activity event stream into agent-panel card view-models.
// Pure — node:test-covered. 字段归一走共享事件展示契约(src/apps/event-contract.js),避免第 4 份并行读法。
import { describeEvent } from "../../../src/apps/event-contract.js";

export function deriveAgentCards(activity) {
  const cards = [];
  const toolIndex = new Map();
  let planCard = null;
  for (const e of activity || []) {
    const type = e && e.type;
    if (type === "orchestration:planned" || type === "orchestration:round_started" || type === "orchestration:replanned") {
      if (!planCard) { planCard = { kind: "plan", subtasks: 0, round: 0 }; cards.push(planCard); }
      if (typeof e.subtasks === "number") planCard.subtasks = e.subtasks;
      if (typeof e.new_subtasks === "number") planCard.subtasks = e.new_subtasks;
      if (typeof e.round === "number") planCard.round = e.round;
    } else if (type === "tool:call") {
      const card = { kind: "tool", id: e.id, tool: e.tool || e.name || "tool", status: "running" };
      toolIndex.set(e.id, card);
      cards.push(card);
    } else if (type === "tool:result") {
      const card = toolIndex.get(e.id);
      if (card) card.status = e.status === "error" ? "error" : "ok";
    } else if (type === "file:diff_applied" || type === "file:diff_preview") {
      const f = describeEvent(e).fields;
      const paths = (f.files || []).map((x) => x.path).filter(Boolean);
      cards.push({
        kind: "diff",
        changeId: f.changeId,
        path: paths[0] || "",
        fileCount: paths.length,
        applied: type === "file:diff_applied"
      });
    } else if (type === "verification:result") {
      cards.push({ kind: "test", pass: Boolean(e.pass) });
    }
  }
  return cards;
}
```

> 注:现有 diff 测试用 `files: ["src/a.js", "src/b.js"]`(字符串数组)+ `summary:[{path,...}]`。契约 `normFiles` 对字符串元素取 `str(e?.path)` = null(字符串无 `.path`),会导致 `paths` 为空。**必须处理字符串元素。** 见 Step 2b。

- [ ] **Step 2b: 契约 normFiles 兼容字符串元素**

现有 GUI 测试传 `files: ["src/a.js", "src/b.js"]`(字符串数组),但 kernel 真实 `file:diff_applied` 的 `files` 是对象数组(`{path,status,...}`,见 TUI 测试与 D-4 CHANGELOG)。字符串数组仅存在于旧 GUI 测试 fixture。为让契约同时兼容,修改 Task 1 的 `normFiles`:

```javascript
function normFiles(event) {
  const raw = (Array.isArray(event.files) && event.files.length) ? event.files
    : (Array.isArray(event.summary) ? event.summary : []);
  return raw.map((e) => {
    if (typeof e === "string") return { status: "M", path: e, added: null, removed: null };
    return {
      status: str(e?.status) || "M",
      path: str(e?.path) || str(e?.file) || null,
      added: num(e?.added),
      removed: num(e?.removed)
    };
  });
}
```

回 Task 1 测试补一条断言字符串元素归一:

```javascript
test("normFiles accepts string path elements (legacy gui fixture)", () => {
  const d = describeEvent({ type: "file:diff_applied", change_id: "c", files: ["src/a.js"] });
  assert.deepEqual(d.fields.files[0], { status: "M", path: "src/a.js", added: null, removed: null });
});
```

先跑 Task 1 测试确认新断言通过:`node --test tests/unit/apps/event-contract.test.js` → PASS。

- [ ] **Step 3: 运行 GUI 测试确认通过**

Run: `node --test tests/unit/gui/agent-cards.test.js`
Expected: PASS(现有 4 条)—— `diff` 卡的 `path`/`fileCount`/`changeId`/`applied` 与改造前一致。

- [ ] **Step 4: 提交**

```bash
git add gui/src/state/agent-cards.js src/apps/event-contract.js tests/unit/apps/event-contract.test.js
git commit -m "refactor(gui): agent-cards diff 字段走共享契约(D-G4 收敛 #5)"
```

---

### Task 5: TUI `/recovery clear` 与 CLI 对齐

**Files:**
- Modify: `src/apps/tui/tui-app.js`(recovery handler)
- Modify: `src/apps/tui/tui-i18n.js`(usage 串 + slash.recovery.desc)
- Test: `tests/unit/tui/recovery-clear.test.js`(新建)

**Interfaces:**
- Consumes: `kernel.recovery.clear(id) → { status }`(facade 已存在,见 `src/index.js:537`)。
- Produces: TUI `/recovery clear <id>` 分支;无 id 时打印 usage 且不调 facade;失败渲染错误不崩。

- [ ] **Step 1: 更新 usage/desc 词条(zh + en)**

`src/apps/tui/tui-i18n.js`:
- zh `"slash.recovery.desc"` 改为 `"恢复中心:列表/resume/cancel/clear"`。
- en `"slash.recovery.desc"` 改为 `"recovery center: list/resume/cancel/clear"`。

- [ ] **Step 2: 写失败测试(新建)**

创建 `tests/unit/tui/recovery-clear.test.js`。**复用现有 harness** `tests/unit/tui/helpers.js`(`makeIO`/`makeFakeKernel`/`until`/`tmpRoot`)—— 与 `tui-app-slash.test.js` 同款驱动:`createTuiApp` 返回 `{ run }`,经 `io.input.write("...\r")` 注入按键,`io.text()` 读输出。`makeFakeKernel` 默认不含 `recovery`,本测试注入带 `recovery` 的 kernel。**因 recovery handler 需要 `kernel.recovery`,不能直接用 `makeFakeKernel`**,故本测试自建含 recovery 的 fakeKernel(结构对齐 helpers 的 subscribe/agent/dispose):

```javascript
// tests/unit/tui/recovery-clear.test.js — /recovery clear 与 CLI 对齐(facade/校验/成功/失败)。
import test from "node:test";
import assert from "node:assert/strict";
import { createTuiApp } from "../../../src/apps/tui/tui-app.js";
import { makeIO, until } from "./helpers.js";

function kernelWithRecovery(recovery) {
  const subs = new Set();
  return {
    session: { subscribe(fn) { subs.add(fn); return { unsubscribe: () => subs.delete(fn) }; } },
    runtime: { getState: () => ({ current: "idle", channel: null }) },
    metrics: { getUsage: () => ({ total_tokens: 0, cache_hit_rate: 0 }) },
    agent: { send: async () => ({ status: "complete", content: "" }), approve: async () => ({}) },
    recovery,
    async dispose() {}
  };
}

async function boot(recovery) {
  const io = makeIO();
  const app = createTuiApp({
    input: io.input, output: io.output,
    createKernelImpl: async () => kernelWithRecovery(recovery),
    buildKernelOptionsImpl: async () => ({})
  });
  const done = app.run();
  await until(() => io.text().includes("❯"));
  const quit = async () => { io.input.write("\x03"); io.input.write("\x03"); await done; };
  return { io, quit };
}

test("/recovery clear <id> calls facade and renders status", async () => {
  const calls = [];
  const { io, quit } = await boot({
    report: async () => ({ found: [], done: [], blocked: [] }),
    list: async () => [],
    clear: async (id) => { calls.push(id); return { status: "cleared" }; }
  });
  io.input.write("/recovery clear rec_1\r");
  await until(() => io.text().includes("rec_1"));
  assert.deepEqual(calls, ["rec_1"]);
  assert.match(io.text(), /rec_1.*cleared/);
  await quit();
});

test("/recovery clear without id prints usage, no facade call", async () => {
  let called = false;
  const { io, quit } = await boot({
    report: async () => ({ found: [], done: [], blocked: [] }),
    list: async () => [],
    clear: async () => { called = true; return {}; }
  });
  io.input.write("/recovery clear\r");
  await until(() => io.text().includes("resume|cancel|clear"));
  assert.equal(called, false);
  await quit();
});

test("/recovery clear failure renders error, no crash", async () => {
  const { io, quit } = await boot({
    report: async () => ({ found: [], done: [], blocked: [] }),
    list: async () => [],
    clear: async () => { throw new Error("cannot clear blocked recovery item"); }
  });
  io.input.write("/recovery clear rec_2\r");
  await until(() => io.text().includes("cannot clear blocked"));
  assert.match(io.text(), /cannot clear blocked/);
  await quit();
});
```

> **实现者注**:`createTuiApp` 参数名(`createKernelImpl`/`buildKernelOptionsImpl`/`input`/`output`)取自 `tests/unit/tui/tui-app-config.test.js` 实证;`run()` 返回 promise、`❯` 是就绪提示符、`\x03\x03` 双 Ctrl+C 退出,均与现有测试一致。若 recovery handler 输出的成功串格式与 `/rec_1.*cleared/` 不完全匹配,以实现的 `pushLines` 文案为准调断言(语义:调 clear / 打 usage / 错误不崩 不变)。

- [ ] **Step 3: 运行测试确认失败**

Run: `node --test tests/unit/tui/recovery-clear.test.js`
Expected: FAIL —— clear 分支不存在,`clear rec_1` 落到 else 打印 usage(旧串无 clear),`calls` 为空。

- [ ] **Step 4: 加 clear 分支**

在 `src/apps/tui/tui-app.js` 的 `recovery` handler 中,`cancel` 分支后、else 前插入:

```javascript
        } else if (action === "clear" && id) {
          const res = await kernel.recovery.clear(id);
          pushLines([` ${T("ev.recovery")} clear ${id}: ${res?.status || "ok"}`, ""]);
```

并把末尾 else 的 usage 串更新为含 clear:

```javascript
        } else {
          pushLines([` ${color.dim("/recovery [resume|cancel|clear] <id>")}`, ""]);
        }
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node --test tests/unit/tui/recovery-clear.test.js tests/unit/tui/tui-i18n.test.js`
Expected: PASS(clear 用例 + i18n parity 仍绿)。

- [ ] **Step 6: 提交**

```bash
git add src/apps/tui/tui-app.js src/apps/tui/tui-i18n.js tests/unit/tui/recovery-clear.test.js
git commit -m "feat(tui): /recovery clear 与 CLI 对齐(D-G4 Part C)"
```

---

### Task 6: check 脚本接入 + 全量验证 + 文档回写

**Files:**
- Modify: `package.json`(`check` 脚本加 `event-contract.js`)
- Modify: `docs/CHANGELOG.md`、`docs/specs/architecture/2026-06-24-v3-roadmap-design.md`、`docs/project-overview.md`

**Interfaces:** 无(收尾)。

- [ ] **Step 1: check 脚本加新模块**

在 `package.json` 的 `check` 脚本里,`src/apps/api-profiles.js src/apps/model-catalog.js` 附近追加 `src/apps/event-contract.js`(保持既有 `node --check` 链式风格)。

- [ ] **Step 2: 跑 check**

Run: `npm run check`
Expected: 无输出、退出码 0(全部 `node --check` 通过)。

- [ ] **Step 3: 跑全量测试**

Run: `npm test`
Expected: `pass` 数 = 旧基线(912)+ 本轮新增(event-contract ~10 + CLI 3 + TUI event-cards 2 + TUI recovery 3 ≈ 18);`fail 0`。验收标准:**现有测试无删除/放宽;fail 为 0;check 通过。**

- [ ] **Step 4: CHANGELOG 回写**

在 `docs/CHANGELOG.md` Unreleased 区:
- 「支柱③前端三端重构」行:把「余 CLI 打磨」改为「✅ 已落地(D-1–D-5 + D-G4 CLI 对齐)」。
- 新增「已落地 — Phase D-G4 CLI 对齐」条目,列:共享事件展示契约 `describeEvent`(三端共用、收敛问题 #5 于受支持 ESM 路径)、CLI 多 agent 摘要、TUI `/recovery clear` 对齐;标测试全绿、check OK、kernel `src/core`/`src/index.js` diff 为空;链接设计 `specs/frontend/2026-07-12-v3-phase-dg4-cli-alignment-design.md`、plan `plans/frontend/2026-07-12-v3-phase-dg4-cli-alignment.md`(本文件)、补救 `specs/backend/2026-07-12-agent-findings-remediation.md`。

- [ ] **Step 5: roadmap 回写**

在 `docs/specs/architecture/2026-06-24-v3-roadmap-design.md` 的 `D-G4` 行下(第 216 行附近)加一行注记:`# ✅ 2026-07-12 落地:共享事件展示契约三端共用 + CLI 多 agent 摘要 + /recovery CLI/TUI 对齐;GUI recovery UI 仍属 D-G7。`

- [ ] **Step 6: project-overview 回写**

在 `docs/project-overview.md` 相关章节(前端/三端展示或事件时间线处)加一段:三端事件展示经 `src/apps/event-contract.js` 共享契约归一,渲染器为薄适配层。

- [ ] **Step 7: 提交**

```bash
git add package.json docs/CHANGELOG.md docs/specs/architecture/2026-06-24-v3-roadmap-design.md docs/project-overview.md
git commit -m "chore: D-G4 check 接线 + 文档回写(V3 支柱③收官)"
```

---

## Self-Review

**1. Spec coverage(逐节核对设计文档):**
- §3 契约模块 → Task 1 ✓
- §4.1 结构 / §4.2 映射表 / §4.3 归一规则 → Task 1(含 sourceType、quiet、null 归一、别名、畸形)✓
- §5 Part B CLI 编排摘要(单复数/无空括号/passed-failed/experience 零不打印/reviewSeverity)→ Task 2 ✓
- §6 Part C /recovery CLI/TUI(help/补全/参数校验/成功/失败/双语)→ Task 5(usage+desc 词条=help/补全;三用例=校验/成功/失败;zh/en=双语)✓
- §7 UMD fallback 不改 → 无任务触碰 `gui/renderer/` ✓;kernel 零改动 → 无任务碰 `src/core`/`src/index.js`(Task 4 只 add `event-contract.js`,非 core)✓
- §8 测试策略(新契约测试 + 三端旧测试不动 + 编排新断言 + TUI clear)→ Task 1–5 ✓
- §9/§10 → 补救文档已单独产出;Global Constraints 已含 §10 全部硬约束 ✓
- Task 3(TUI 契约消费)对应 §3 三端薄适配 ✓

**2. Placeholder 扫描:** 无 TBD/TODO;每个 code step 均有完整代码。Task 5 Step 2 标注了「须先读 tui-app.js 确认 harness」的实现者注 —— 这是对现有测试形态的合理适配指引,非占位(断言语义已完整给出)。

**3. Type 一致性:** `describeEvent` 返回结构 `{kind, sourceType, severity, quiet, fields}` 在 Task 1 定义,Task 2/3/4 消费字段名一致(`fields.subtaskId`/`reviewSeverity`/`toolProfile`/`changeId`/`files[].path`)。CLI `orchestrationSummary` 的 kind 分支名与 Task 1 输出的 kind(`orchestration-plan` 等)逐一对应。GUI Task 4 依赖 `fields.files[].path` 与 `fields.changeId`,Task 1(经 Step 2b)保证字符串/对象元素都产出 `.path`。

**发现并已内联修正的问题:**
- Task 2 的 `createEventRenderer`:契约把 `user:message` 标 `quiet:true`,但现有测试要求它打印。已在 Step 3b 修正为「过滤只用 `QUIET_EVENTS` 原集合 + 仅 experience 零值走契约 quiet」,不放宽现有测试。
- Task 4 的 GUI diff fixture 用字符串数组 `files`,契约 `normFiles` 初版对字符串取 `.path`=null。已在 Step 2b 让 `normFiles` 兼容字符串元素,并回补 Task 1 断言。
