# V2-14 GUI Workbench Refresh & Branch Rewind UX Implementation Plan

> 完成状态以 [CHANGELOG](../../CHANGELOG.md) 为准。


**Goal:** Rebuild the Electron GUI into a polished three-column agent workbench with visible usage, speed, cache-hit metrics, and branch/checkpoint/rewind workflows.

**Architecture:** Extend the existing Electron host/preload bridge, add a pure renderer `workbench-state.js` module, then replace the renderer DOM/CSS with a polished three-column workbench layout. Keep app logic framework-free and XSS-safe through `textContent`; executing agents may use `frontend-design` skill for visual design decisions and screenshot/manual QA.

**Tech Stack:** Electron CommonJS main/preload, browser JavaScript renderer, Node.js built-in `node:test`, no new dependencies.

---

## File Structure

Create:

- `gui/renderer/workbench-state.js`
  UMD/CommonJS pure state helpers for GUI state, branch/checkpoint selection, rewind preview/result, activity buffer, and usage/speed/cache metrics.
- `tests/unit/gui/workbench-state.test.js`
  Node tests for the pure renderer state module.
- `tests/unit/gui/renderer-static.test.js`
  Static renderer safety tests for DOM IDs, no `innerHTML`, and no garbled legacy labels.

Modify:

- `gui/kernel-host.js`
  Add `getActiveBranch()` delegate for reliable active-branch lookup.
- `gui/main.js`
  Add IPC channels for branches, checkpoints, rewind preview, and rewind apply.
- `gui/preload.js`
  Expose `listBranches`, `getActiveBranch`, `listCheckpoints`, `rewindPreview`, and `rewindApply`.
- `gui/renderer/event-adapter.js`
  Add branch, rewind, and recovery summaries/status.
- `tests/unit/gui/renderer-event-adapter.test.js`
  Cover new event summaries.
- `tests/unit/gui/kernel-host.test.js`
  Cover active branch delegate.
- `gui/renderer/index.html`
  Replace old three-layer overlay markup with workbench shell.
- `gui/renderer/style.css`
  Refresh visual system and layout.
- `gui/renderer/app.js`
  Rebuild as a DOM controller over `workbench-state.js`.
- `package.json`
  Add new renderer module to `npm run check`.

Do not add a framework, bundler, or runtime dependency. Do not implement diff viewer or branch deletion in V2-14. Preserve the original three-column workbench concept; do not collapse the UI back into a single chat pane.

---

## Task 1: Branch/Rewind IPC Bridge

**Files:**
- Modify: `gui/kernel-host.js`
- Modify: `gui/main.js`
- Modify: `gui/preload.js`
- Test: `tests/unit/gui/kernel-host.test.js`

- [ ] **Step 1: Add failing kernel-host active branch test**

Append to `tests/unit/gui/kernel-host.test.js`:

```js
test("kernel host exposes active branch delegate", async () => {
  const host = createKernelHost({
    projectRoot: "/repo",
    kernelFactory: async () => ({
      session: {
        subscribe: () => ({ unsubscribe() {} }),
        getTimeline: async () => [],
        branches: {
          list: async () => [{ branch_id: "br_main" }, { branch_id: "br_child" }],
          getActive: async () => ({ branch_id: "br_child" })
        }
      },
      agent: { send: async () => ({ status: "complete" }), approve: () => {}, interrupt: () => {} },
      context: { snapshot: async () => ({ units: [] }) },
      metrics: { getUsage: () => zeroUsage() },
      config: { getPublicConfig: () => ({}) },
      runtime: { getState: () => ({ current: "idle" }) }
    }),
    configLoader: async () => ({})
  });
  await host.init();

  assert.deepEqual(await host.getActiveBranch(), { branch_id: "br_child" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm.cmd test -- tests/unit/gui/kernel-host.test.js
```

Expected: FAIL because `host.getActiveBranch` is not defined.

- [ ] **Step 3: Add getActiveBranch to kernel-host.js**

In `gui/kernel-host.js`, add this function near `listBranches()`:

```js
  async function getActiveBranch() {
    return ready() ? requireKernel().session.branches?.getActive?.() || { branch_id: "br_main" } : { branch_id: "br_main" };
  }
```

Add it to the returned host object next to `listBranches`.

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
npm.cmd test -- tests/unit/gui/kernel-host.test.js
```

Expected: PASS.

- [ ] **Step 5: Add IPC channels in main.js**

In `gui/main.js`, extend `IPC_CHANNELS` from:

```js
const IPC_CHANNELS = [
  "agent:send", "agent:approve", "agent:interrupt",
  "session:timeline", "context:snapshot", "model:usage",
  "config:get", "orchestrator:state"
];
```

to:

```js
const IPC_CHANNELS = [
  "agent:send", "agent:approve", "agent:interrupt",
  "session:timeline", "session:branches", "session:branch-active", "session:checkpoints",
  "session:rewind-preview", "session:rewind-apply",
  "context:snapshot", "model:usage",
  "config:get", "orchestrator:state"
];
```

Then add handlers in `registerIpcHandlers()` after `session:timeline`:

```js
  ipcMain.handle("session:branches", async () => {
    try { return await host.listBranches(); }
    catch (error) { return { error: error.message }; }
  });
  ipcMain.handle("session:branch-active", async () => {
    try {
      return await host.getActiveBranch();
    } catch (error) {
      return { error: error.message };
    }
  });
  ipcMain.handle("session:checkpoints", async (_event, options) => {
    try { return await host.listCheckpoints(options || {}); }
    catch (error) { return { error: error.message }; }
  });
  ipcMain.handle("session:rewind-preview", async (_event, options) => {
    try { return await host.rewindPreview(options || {}); }
    catch (error) { return { error: error.message }; }
  });
  ipcMain.handle("session:rewind-apply", async (_event, options) => {
    try { return await host.rewindApply(options || {}); }
    catch (error) { return { error: error.message }; }
  });
```

- [ ] **Step 6: Expose methods in preload.js**

In `gui/preload.js`, add these methods to the object passed to `contextBridge.exposeInMainWorld("deepseek", ...)`:

```js
  listBranches: () => ipcRenderer.invoke("session:branches"),
  getActiveBranch: () => ipcRenderer.invoke("session:branch-active"),
  listCheckpoints: (options) => ipcRenderer.invoke("session:checkpoints", options || {}),
  rewindPreview: (options) => ipcRenderer.invoke("session:rewind-preview", options || {}),
  rewindApply: (options) => ipcRenderer.invoke("session:rewind-apply", options || {}),
```

Keep existing methods unchanged.

- [ ] **Step 7: Run syntax check for touched GUI files**

Run:

```powershell
node --check gui/main.js gui/preload.js gui/kernel-host.js
```

Expected: PASS.

- [ ] **Step 8: Commit Task 1**

Run:

```powershell
git add gui/kernel-host.js gui/main.js gui/preload.js tests/unit/gui/kernel-host.test.js
git commit -m "feat(v2): expose branch rewind ipc to gui renderer"
```

---

## Task 2: Workbench State Module

**Files:**
- Create: `gui/renderer/workbench-state.js`
- Test: `tests/unit/gui/workbench-state.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/unit/gui/workbench-state.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const state = require("../../../gui/renderer/workbench-state.js");

test("createInitialState defines workbench defaults", () => {
  const initial = state.createInitialState();

  assert.deepEqual(initial.branches, []);
  assert.deepEqual(initial.checkpoints, []);
  assert.equal(initial.activeBranchId, "br_main");
  assert.equal(initial.selectedBranchId, "br_main");
  assert.equal(initial.rewindPreview, null);
  assert.equal(initial.rewindResult, null);
  assert.equal(initial.forceRewind, false);
});

test("applyWorkbenchAction stores branches active branch and selected branch", () => {
  const initial = state.createInitialState();
  const next = state.applyWorkbenchAction(initial, {
    type: "branches_loaded",
    branches: [{ branch_id: "br_main" }, { branch_id: "br_child" }],
    activeBranchId: "br_child"
  });

  assert.equal(next.activeBranchId, "br_child");
  assert.equal(next.selectedBranchId, "br_child");
  assert.deepEqual(next.branches.map((branch) => branch.branch_id), ["br_main", "br_child"]);
  assert.notEqual(next, initial);
});

test("applyWorkbenchAction caps activity buffer without mutating previous state", () => {
  let current = state.createInitialState();
  for (let i = 0; i < 60; i++) {
    current = state.applyWorkbenchAction(current, { type: "event_received", event: { type: "tool:call", seq: i } });
  }

  assert.equal(current.activity.length, 50);
  assert.equal(current.activity[0].seq, 10);
  assert.equal(state.createInitialState().activity.length, 0);
});

test("checkpoint target and rewind preview/result are stored predictably", () => {
  const cp = { checkpoint_id: "cp_1", turn_id: "turn_1", event_id: "evt_1", seq: 7 };
  const preview = { status: "success", rollback_count: 2, files: ["a.txt"], target: { turn_id: "turn_1" } };
  const result = { status: "failed_restored", reason: "branch_create_failed" };
  const selected = state.applyWorkbenchAction(state.createInitialState(), { type: "checkpoint_selected", checkpoint: cp });
  const withPreview = state.applyWorkbenchAction(selected, { type: "rewind_preview_loaded", preview });
  const withResult = state.applyWorkbenchAction(withPreview, { type: "rewind_result_loaded", result });

  assert.deepEqual(selected.selectedTarget, { turn_id: "turn_1" });
  assert.equal(withPreview.rewindPreview.rollback_count, 2);
  assert.equal(withResult.rewindResult.status, "failed_restored");
});

test("format helpers produce compact labels", () => {
  assert.equal(state.shortId("br_abcdef123456"), "br_abcd");
  assert.equal(state.formatRewindStatus({ status: "success" }), "Rewind applied. New branch active.");
  assert.equal(state.formatRewindStatus({ status: "conflict_restored" }), "Rewind blocked; previous changes were restored.");
  assert.equal(state.formatRewindStatus({ status: "failed_unrestorable" }), "Rewind recovery failed. Manual check required.");
  assert.equal(state.formatTokenCount(1250), "1.3K");
  assert.equal(state.formatCacheRate({ cache_hit_rate: 0.456 }), "46%");
  assert.equal(state.formatLatency({ avg_latency_ms: 1234 }), "1.2s");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
npm.cmd test -- tests/unit/gui/workbench-state.test.js
```

Expected: FAIL with module-not-found for `gui/renderer/workbench-state.js`.

- [ ] **Step 3: Implement workbench-state.js**

Create `gui/renderer/workbench-state.js`:

```js
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.DeepSeekWorkbenchState = factory();
  }
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function createInitialState() {
    return {
      messages: [],
      activity: [],
      branches: [],
      checkpoints: [],
      activeBranchId: "br_main",
      selectedBranchId: "br_main",
      selectedCheckpoint: null,
      selectedTarget: null,
      rewindPreview: null,
      rewindResult: null,
      forceRewind: false,
      usage: null,
      metrics: {
        tokens: "0",
        cacheRate: "0%",
        latency: "0ms",
        requests: "0"
      },
      runtime: { current: "idle", channel: null },
      statusChannel: "idle"
    };
  }

  function applyWorkbenchAction(state, action) {
    var current = state || createInitialState();
    if (!action || !action.type) return current;
    if (action.type === "message_added") {
      return copy(current, { messages: current.messages.concat([action.message]) });
    }
    if (action.type === "event_received") {
      return copy(current, { activity: current.activity.concat([action.event]).slice(-50) });
    }
    if (action.type === "branches_loaded") {
      var active = action.activeBranchId || current.activeBranchId || "br_main";
      return copy(current, {
        branches: Array.isArray(action.branches) ? action.branches.slice() : [],
        activeBranchId: active,
        selectedBranchId: action.selectedBranchId || active
      });
    }
    if (action.type === "branch_selected") {
      return copy(current, {
        selectedBranchId: action.branch_id || "br_main",
        selectedCheckpoint: null,
        selectedTarget: null,
        rewindPreview: null,
        rewindResult: null
      });
    }
    if (action.type === "checkpoints_loaded") {
      return copy(current, { checkpoints: Array.isArray(action.checkpoints) ? action.checkpoints.slice() : [] });
    }
    if (action.type === "checkpoint_selected") {
      var checkpoint = action.checkpoint || null;
      return copy(current, {
        selectedCheckpoint: checkpoint,
        selectedTarget: targetFromCheckpoint(checkpoint),
        rewindPreview: null,
        rewindResult: null
      });
    }
    if (action.type === "rewind_preview_loaded") {
      return copy(current, { rewindPreview: action.preview || null, rewindResult: null });
    }
    if (action.type === "rewind_result_loaded") {
      return copy(current, { rewindResult: action.result || null });
    }
    if (action.type === "force_rewind_changed") {
      return copy(current, { forceRewind: Boolean(action.force) });
    }
    if (action.type === "usage_loaded") {
      return copy(current, {
        usage: action.usage || null,
        metrics: metricsFromUsage(action.usage || {})
      });
    }
    if (action.type === "runtime_loaded") {
      return copy(current, { runtime: action.runtime || { current: "idle", channel: null } });
    }
    if (action.type === "status_channel_changed") {
      return copy(current, { statusChannel: action.channel || current.statusChannel });
    }
    return current;
  }

  function targetFromCheckpoint(checkpoint) {
    if (!checkpoint) return null;
    if (checkpoint.turn_id) return { turn_id: checkpoint.turn_id };
    if (checkpoint.event_id) return { event_id: checkpoint.event_id };
    return { seq: checkpoint.seq };
  }

  function shortId(value) {
    var text = String(value || "");
    if (text.indexOf("br_") === 0) return text.slice(0, 7);
    if (text.length <= 10) return text;
    return text.slice(0, 10);
  }

  function formatRewindStatus(result) {
    if (!result) return "";
    if (result.status === "success") return "Rewind applied. New branch active.";
    if (result.status === "conflict") return "Rewind blocked by dirty files.";
    if (result.status === "conflict_restored") return "Rewind blocked; previous changes were restored.";
    if (result.status === "failed_restored") return "Rewind failed; workspace was restored.";
    if (result.status === "failed_unrestorable") return "Rewind recovery failed. Manual check required.";
    return "Rewind status: " + (result.status || "unknown");
  }

  function metricsFromUsage(usage) {
    return {
      tokens: formatTokenCount(usage.total_tokens || ((usage.total_prompt_tokens || 0) + (usage.total_completion_tokens || 0))),
      cacheRate: formatCacheRate(usage),
      latency: formatLatency(usage),
      requests: String(usage.requests || 0)
    };
  }

  function formatTokenCount(value) {
    var count = Number(value || 0);
    return count >= 1000 ? (count / 1000).toFixed(1) + "K" : String(count);
  }

  function formatCacheRate(usage) {
    if (typeof usage.cache_hit_rate === "number") return Math.round(usage.cache_hit_rate * 100) + "%";
    var hits = usage.cache_hit_tokens || 0;
    var misses = usage.cache_miss_tokens || 0;
    var denom = hits + misses;
    return denom > 0 ? Math.round(hits / denom * 100) + "%" : "0%";
  }

  function formatLatency(usage) {
    var ms = Number(usage.avg_latency_ms || 0);
    if (ms >= 1000) return (ms / 1000).toFixed(1) + "s";
    return Math.round(ms) + "ms";
  }

  function copy(base, patch) {
    var next = {};
    Object.keys(base).forEach(function (key) { next[key] = base[key]; });
    Object.keys(patch).forEach(function (key) { next[key] = patch[key]; });
    return next;
  }

  return {
    createInitialState: createInitialState,
    applyWorkbenchAction: applyWorkbenchAction,
    targetFromCheckpoint: targetFromCheckpoint,
    shortId: shortId,
    formatRewindStatus: formatRewindStatus,
    metricsFromUsage: metricsFromUsage,
    formatTokenCount: formatTokenCount,
    formatCacheRate: formatCacheRate,
    formatLatency: formatLatency
  };
}));
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```powershell
npm.cmd test -- tests/unit/gui/workbench-state.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

Run:

```powershell
git add gui/renderer/workbench-state.js tests/unit/gui/workbench-state.test.js
git commit -m "feat(v2): add gui workbench state model"
```

---

## Task 3: Event Adapter Branch/Rewind Summaries

**Files:**
- Modify: `gui/renderer/event-adapter.js`
- Test: `tests/unit/gui/renderer-event-adapter.test.js`

- [ ] **Step 1: Add failing adapter tests**

Append to `tests/unit/gui/renderer-event-adapter.test.js`:

```js
test("renderer adapter summarizes branch rewind and recovery events", () => {
  assert.equal(adapter.eventIcon("session:branch_created"), "B");
  assert.equal(adapter.eventIcon("session:rewind_applied"), "W");
  assert.equal(adapter.eventIcon("session:rewind_recovery_failed"), "!");
  assert.equal(
    adapter.summarizeEvent({ type: "session:branch_activated", branch_id: "br_child" }),
    "branch active br_child"
  );
  assert.equal(
    adapter.summarizeEvent({ type: "session:rewind_preview", rollback_count: 2 }),
    "rewind preview 2 changes"
  );
  assert.equal(
    adapter.summarizeEvent({ type: "session:rewind_restored", restored_files: ["a.txt"] }),
    "rewind restored 1 files"
  );
});

test("renderer adapter maps rewind statuses to status channel", () => {
  assert.deepEqual(adapter.statusFromEvent({ type: "session:rewind_applied" }), { channel: "rewind" });
  assert.deepEqual(adapter.statusFromEvent({ type: "session:rewind_recovery_failed" }), { channel: "recovery" });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
npm.cmd test -- tests/unit/gui/renderer-event-adapter.test.js
```

Expected: FAIL because branch/rewind events are not summarized.

- [ ] **Step 3: Extend event-adapter.js**

In `gui/renderer/event-adapter.js`, add icons to the `icons` map:

```js
      "session:branch_created": "B",
      "session:branch_activated": "B",
      "session:rewind_preview": "W",
      "session:rewind_started": "W",
      "session:rewind_applied": "W",
      "session:rewind_conflict": "!",
      "session:rewind_failed": "!",
      "session:rewind_restore_started": "W",
      "session:rewind_restored": "W",
      "session:rewind_recovery_failed": "!",
```

Add summary cases in `summarizeEvent(event)` before the final fallback:

```js
    if (event.type === "session:branch_created") return "branch created " + (event.branch_id || "unknown");
    if (event.type === "session:branch_activated") return "branch active " + (event.branch_id || "unknown");
    if (event.type === "session:rewind_preview") return "rewind preview " + (event.rollback_count || event.rollback_change_ids?.length || 0) + " changes";
    if (event.type === "session:rewind_started") return "rewind started " + ((event.rollback_change_ids || []).length) + " changes";
    if (event.type === "session:rewind_applied") return "rewind applied " + (event.branch_id || "unknown");
    if (event.type === "session:rewind_conflict") return "rewind conflict " + (event.failed_change_id || "unknown");
    if (event.type === "session:rewind_failed") return "rewind failed " + (event.reason || event.failed_change_id || "unknown");
    if (event.type === "session:rewind_restore_started") return "rewind restoring " + ((event.applied_rollbacks || []).length) + " changes";
    if (event.type === "session:rewind_restored") return "rewind restored " + ((event.restored_files || []).length) + " files";
    if (event.type === "session:rewind_recovery_failed") return "rewind recovery failed " + (event.reason || event.restore_error || "unknown");
```

Add status cases in `statusFromEvent(event)`:

```js
    if (event.type === "session:rewind_preview" || event.type === "session:rewind_started" || event.type === "session:rewind_applied") return { channel: "rewind" };
    if (event.type === "session:rewind_conflict" || event.type === "session:rewind_failed" || event.type === "session:rewind_recovery_failed") return { channel: "recovery" };
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```powershell
npm.cmd test -- tests/unit/gui/renderer-event-adapter.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit Task 3**

Run:

```powershell
git add gui/renderer/event-adapter.js tests/unit/gui/renderer-event-adapter.test.js
git commit -m "feat(v2): summarize rewind events in gui renderer"
```

---

## Task 4: Workbench Markup and Static Safety Tests

**Files:**
- Modify: `gui/renderer/index.html`
- Create: `tests/unit/gui/renderer-static.test.js`

- [ ] **Step 1: Write failing static tests**

Create `tests/unit/gui/renderer-static.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("renderer workbench html exposes required panels and controls", async () => {
  const html = await readFile("gui/renderer/index.html", "utf8");

  for (const id of [
    "branch-list",
    "checkpoint-list",
    "rewind-preview",
    "rewind-apply",
    "rewind-force",
    "activity-log",
    "messages",
    "msg-input",
    "status-branch",
    "metric-tokens",
    "metric-cache",
    "metric-latency",
    "metric-requests"
  ]) {
    assert.ok(html.includes(`id="${id}"`), `${id} missing`);
  }
});

test("renderer files avoid unsafe html injection and garbled legacy labels", async () => {
  const html = await readFile("gui/renderer/index.html", "utf8");
  const app = await readFile("gui/renderer/app.js", "utf8");

  assert.equal(app.includes("innerHTML"), false);
  assert.equal(html.includes("馃"), false);
  assert.equal(html.includes("鉁"), false);
  assert.equal(html.includes("杈"), false);
  assert.equal(html.includes("鍙"), false);
});
```

- [ ] **Step 2: Run static tests to verify they fail**

Run:

```powershell
npm.cmd test -- tests/unit/gui/renderer-static.test.js
```

Expected: FAIL because the current HTML does not contain the required workbench IDs and has garbled labels.

- [ ] **Step 3: Replace index.html markup**

Replace `gui/renderer/index.html` body content with:

```html
  <div id="app" class="workbench">
    <aside id="sidebar" class="panel sidebar">
      <header class="panel-header">
        <div>
          <div class="brand">DeepSeek Code</div>
          <div class="subtle">Local agent workbench</div>
        </div>
      </header>
      <section class="panel-section">
        <div class="section-title">Branches</div>
        <div id="branch-list" class="branch-list"></div>
      </section>
      <section class="panel-section metrics">
        <div class="section-title">Metrics</div>
        <div class="metric-grid">
          <div class="metric-tile"><span>Tokens</span><strong id="metric-tokens">0</strong></div>
          <div class="metric-tile"><span>Cache hit</span><strong id="metric-cache">0%</strong></div>
          <div class="metric-tile"><span>Avg latency</span><strong id="metric-latency">0ms</strong></div>
          <div class="metric-tile"><span>Requests</span><strong id="metric-requests">0</strong></div>
        </div>
      </section>
    </aside>

    <main id="conversation" class="conversation">
      <header class="topbar">
        <div>
          <div class="view-title">Conversation</div>
          <div id="status-branch" class="subtle">br_main</div>
        </div>
        <button id="btn-refresh" class="ghost-button" type="button">Refresh</button>
      </header>
      <div id="messages" class="messages"></div>
      <div id="approval-box" class="hidden"></div>
      <form id="composer" class="composer">
        <input type="text" id="msg-input" placeholder="Ask the local agent..." autocomplete="off" autofocus>
        <button id="btn-send" type="submit">Send</button>
      </form>
    </main>

    <aside id="inspector" class="panel inspector">
      <section class="panel-section">
        <div class="section-title">Activity</div>
        <div id="activity-log" class="activity-log"></div>
      </section>
      <section class="panel-section checkpoints">
        <div class="section-title">Checkpoints</div>
        <div id="checkpoint-list" class="checkpoint-list"></div>
      </section>
      <section class="panel-section rewind">
        <div class="section-title">Rewind</div>
        <div id="rewind-preview" class="rewind-preview empty">Select a checkpoint to preview rewind.</div>
        <label class="force-row">
          <input id="rewind-force" type="checkbox">
          <span>Force dirty rollback</span>
        </label>
        <button id="rewind-apply" class="danger-button" type="button" disabled>Apply rewind</button>
      </section>
    </aside>

    <footer id="status-bar" class="status-bar">
      <span id="status-autonomy">gated</span>
      <span id="status-channel">idle</span>
      <span id="status-runtime">idle</span>
    </footer>
  </div>
```

Keep the existing `<script src="event-adapter.js"></script>` and add:

```html
  <script src="workbench-state.js"></script>
```

before `app.js`.

- [ ] **Step 4: Run static tests to verify they pass**

Run:

```powershell
npm.cmd test -- tests/unit/gui/renderer-static.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit Task 4**

Run:

```powershell
git add gui/renderer/index.html tests/unit/gui/renderer-static.test.js
git commit -m "feat(v2): add gui workbench markup"
```

---

## Task 5: Workbench CSS Refresh

**Files:**
- Modify: `gui/renderer/style.css`
- Test: `tests/unit/gui/renderer-static.test.js`

Executing agents may use `frontend-design` skill for this task. The intended result is a polished developer workbench, not a light color tweak.

- [ ] **Step 1: Add static CSS expectations**

Append to `tests/unit/gui/renderer-static.test.js`:

```js
test("renderer css defines stable workbench layout without decorative gradients", async () => {
  const css = await readFile("gui/renderer/style.css", "utf8");

  assert.ok(css.includes(".workbench"));
  assert.ok(css.includes("grid-template-columns"));
  assert.ok(css.includes(".metric-grid"));
  assert.ok(css.includes(".metric-tile"));
  assert.ok(css.includes(".branch-item"));
  assert.ok(css.includes(".checkpoint-item"));
  assert.ok(css.includes(".rewind-preview"));
  assert.equal(css.includes("radial-gradient"), false);
  assert.equal(css.includes("linear-gradient"), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm.cmd test -- tests/unit/gui/renderer-static.test.js
```

Expected: FAIL if CSS does not yet define the workbench classes.

- [ ] **Step 3: Replace style.css with workbench styles**

Replace `gui/renderer/style.css` with:

```css
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: 100%; height: 100%; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #0f1115;
  color: #d8dee9;
  overflow: hidden;
}
button, input { font: inherit; }
button { cursor: pointer; }
.hidden { display: none !important; }
.workbench {
  height: 100vh;
  display: grid;
  grid-template-columns: 240px minmax(360px, 1fr) 320px;
  grid-template-rows: 1fr 28px;
  background: #0f1115;
}
.panel {
  min-width: 0;
  background: #151922;
  border-right: 1px solid #252b36;
  overflow: hidden;
}
.sidebar { grid-column: 1; grid-row: 1; }
.inspector { grid-column: 3; grid-row: 1; border-right: 0; border-left: 1px solid #252b36; }
.conversation {
  grid-column: 2;
  grid-row: 1;
  min-width: 0;
  display: grid;
  grid-template-rows: 58px minmax(0, 1fr) auto auto;
  background: #10141b;
}
.panel-header, .topbar {
  height: 58px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid #252b36;
}
.brand, .view-title { font-weight: 650; font-size: 14px; color: #f3f6fb; }
.subtle { margin-top: 2px; font-size: 11px; color: #7d8796; }
.panel-section { padding: 12px; border-bottom: 1px solid #252b36; }
.section-title {
  margin-bottom: 8px;
  font-size: 11px;
  font-weight: 650;
  color: #9aa4b2;
  text-transform: uppercase;
}
.branch-list, .checkpoint-list, .activity-log { display: flex; flex-direction: column; gap: 6px; }
.branch-item, .checkpoint-item, .activity-item {
  width: 100%;
  border: 1px solid #27303d;
  border-radius: 6px;
  background: #111720;
  color: #d8dee9;
  padding: 8px;
  text-align: left;
}
.branch-item.active { border-color: #5aa9e6; }
.branch-title, .checkpoint-title { font-size: 12px; font-weight: 600; color: #eef3f8; }
.branch-meta, .checkpoint-meta, .activity-meta { margin-top: 3px; font-size: 11px; color: #7d8796; }
.messages {
  min-height: 0;
  overflow-y: auto;
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.message {
  max-width: min(760px, 88%);
  padding: 10px 12px;
  border-radius: 8px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 13px;
  line-height: 1.5;
}
.message.user { align-self: flex-end; background: #1e3a52; color: #f5f9fc; }
.message.assistant { align-self: flex-start; background: #151922; border: 1px solid #252b36; }
#approval-box { padding: 0 18px 12px; }
.approval-card {
  border: 1px solid #d7a94b;
  border-radius: 8px;
  background: #231d12;
  padding: 12px;
}
.approval-title { font-size: 13px; font-weight: 650; color: #f0c36a; }
.approval-type { margin-top: 4px; font-size: 12px; color: #c9b58b; }
.approval-actions { display: flex; gap: 8px; margin-top: 10px; }
.approval-actions button, .ghost-button, #btn-send, .danger-button {
  border: 1px solid #334155;
  border-radius: 6px;
  padding: 7px 10px;
  background: #172033;
  color: #e5edf7;
}
#btn-send { background: #1f6feb; border-color: #2b7fff; color: #ffffff; }
.danger-button { width: 100%; background: #6e2633; border-color: #9f3347; }
.danger-button:disabled { opacity: 0.45; cursor: default; }
.composer {
  display: flex;
  gap: 8px;
  padding: 12px 14px;
  border-top: 1px solid #252b36;
  background: #111720;
}
#msg-input {
  min-width: 0;
  flex: 1;
  border: 1px solid #303949;
  border-radius: 6px;
  background: #0f141d;
  color: #e5edf7;
  padding: 8px 10px;
  outline: none;
}
#msg-input:focus { border-color: #5aa9e6; }
.metrics { display: block; }
.metric-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.metric-tile {
  min-width: 0;
  border: 1px solid #27303d;
  border-radius: 6px;
  background: #101720;
  padding: 8px;
}
.metric-tile span {
  display: block;
  font-size: 10px;
  color: #7d8796;
}
.metric-tile strong {
  display: block;
  margin-top: 4px;
  font-size: 14px;
  color: #f3f6fb;
  font-weight: 650;
  overflow-wrap: anywhere;
}
.status-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-size: 11px;
  color: #8993a3;
}
.rewind-preview {
  min-height: 74px;
  border: 1px solid #27303d;
  border-radius: 6px;
  padding: 9px;
  background: #111720;
  font-size: 12px;
  color: #d8dee9;
  overflow-wrap: anywhere;
}
.rewind-preview.empty { color: #7d8796; }
.force-row {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 10px 0;
  font-size: 12px;
  color: #aab4c2;
}
.status-bar {
  grid-column: 1 / 4;
  grid-row: 2;
  justify-content: flex-start;
  padding: 0 12px;
  border-top: 1px solid #252b36;
  background: #0b0d11;
}
@media (max-width: 920px) {
  .workbench { grid-template-columns: 210px minmax(320px, 1fr); }
  .inspector { display: none; }
  .conversation { grid-column: 2; }
}
```

- [ ] **Step 4: Run static tests**

Run:

```powershell
npm.cmd test -- tests/unit/gui/renderer-static.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit Task 5**

Run:

```powershell
git add gui/renderer/style.css tests/unit/gui/renderer-static.test.js
git commit -m "feat(v2): refresh gui workbench styling"
```

---

## Task 6: Renderer Controller for Branches, Checkpoints, and Rewind

**Files:**
- Modify: `gui/renderer/app.js`
- Test: `tests/unit/gui/renderer-static.test.js`

- [ ] **Step 1: Add static app expectations**

Append to `tests/unit/gui/renderer-static.test.js`:

```js
test("renderer app wires branch checkpoint and rewind api methods", async () => {
  const app = await readFile("gui/renderer/app.js", "utf8");

  for (const token of [
    "listBranches",
    "getActiveBranch",
    "listCheckpoints",
    "rewindPreview",
    "rewindApply",
    "renderBranches",
    "renderCheckpoints",
    "renderRewindPreview"
  ]) {
    assert.ok(app.includes(token), `${token} missing`);
  }
});
```

- [ ] **Step 2: Run static tests to verify they fail**

Run:

```powershell
npm.cmd test -- tests/unit/gui/renderer-static.test.js
```

Expected: FAIL because `app.js` does not yet wire those methods.

- [ ] **Step 3: Replace app.js with workbench controller**

Replace `gui/renderer/app.js` with:

```js
// gui/renderer/app.js - Workbench DOM controller
(function () {
  "use strict";

  var api = window.deepseek;
  var adapter = window.DeepSeekEventAdapter;
  var model = window.DeepSeekWorkbenchState;
  var state = model.createInitialState();

  function dispatch(action) {
    state = model.applyWorkbenchAction(state, action);
    render();
  }

  function init() {
    bindDom();
    refreshWorkbench();
    api.onKernelEvent(function (event) {
      dispatch({ type: "event_received", event: event });
      var status = adapter.statusFromEvent(event);
      if (status.channel) dispatch({ type: "status_channel_changed", channel: status.channel });
      checkApprovalState(event);
      if (event.type === "agent:final") addMessage("assistant", event.content || "Done.");
      if (event.type === "agent:error") addMessage("assistant", "Error: " + (event.error || event.message || "Unknown error"));
    });
    setInterval(refreshMetrics, 2000);
  }

  function bindDom() {
    document.getElementById("composer").onsubmit = function (event) {
      event.preventDefault();
      sendMessage();
    };
    document.getElementById("btn-refresh").onclick = refreshWorkbench;
    document.getElementById("rewind-force").onchange = function (event) {
      dispatch({ type: "force_rewind_changed", force: event.target.checked });
      renderRewindPreview();
    };
    document.getElementById("rewind-apply").onclick = applyRewind;
  }

  function refreshWorkbench() {
    Promise.all([api.listBranches(), api.getActiveBranch()]).then(function (values) {
      var branches = values[0];
      var activeBranch = values[1];
      if (branches && branches.error) throw new Error(branches.error);
      if (activeBranch && activeBranch.error) throw new Error(activeBranch.error);
      var active = activeBranch?.branch_id || "br_main";
      dispatch({ type: "branches_loaded", branches: branches || [], activeBranchId: active });
      return loadCheckpoints(active);
    }).catch(function (error) {
      addMessage("assistant", "GUI refresh failed: " + error.message);
    });
    refreshMetrics();
  }

  function loadCheckpoints(branchId) {
    return api.listCheckpoints({ branch_id: branchId || state.selectedBranchId }).then(function (checkpoints) {
      if (checkpoints && checkpoints.error) throw new Error(checkpoints.error);
      dispatch({ type: "checkpoints_loaded", checkpoints: checkpoints || [] });
    });
  }

  function refreshMetrics() {
    api.getUsage().then(function (usage) {
      dispatch({ type: "usage_loaded", usage: usage || {} });
      return api.getState();
    }).then(function (runtime) {
      dispatch({ type: "runtime_loaded", runtime: runtime || { current: "idle" } });
    }).catch(function () {});
  }

  function sendMessage() {
    var input = document.getElementById("msg-input");
    var message = input.value.trim();
    if (!message) return;
    input.value = "";
    addMessage("user", message);
    api.send(message, {}).then(function (response) {
      if (response && response.error) addMessage("assistant", "Error: " + response.error);
    }).catch(function (error) {
      addMessage("assistant", "Error: " + error.message);
    });
  }

  function previewCheckpoint(checkpoint) {
    dispatch({ type: "checkpoint_selected", checkpoint: checkpoint });
    api.rewindPreview({ target: model.targetFromCheckpoint(checkpoint) }).then(function (preview) {
      if (preview && preview.error) throw new Error(preview.error);
      dispatch({ type: "rewind_preview_loaded", preview: preview });
    }).catch(function (error) {
      dispatch({ type: "rewind_result_loaded", result: { status: "error", reason: error.message } });
    });
  }

  function applyRewind() {
    if (!state.rewindPreview || !state.selectedTarget) return;
    api.rewindApply({ target: state.selectedTarget, force: state.forceRewind }).then(function (result) {
      if (result && result.error) throw new Error(result.error);
      dispatch({ type: "rewind_result_loaded", result: result });
      refreshWorkbench();
    }).catch(function (error) {
      dispatch({ type: "rewind_result_loaded", result: { status: "error", reason: error.message } });
    });
  }

  function addMessage(role, content) {
    dispatch({ type: "message_added", message: { role: role, content: content } });
  }

  function render() {
    renderBranches();
    renderCheckpoints();
    renderMessages();
    renderActivity();
    renderRewindPreview();
    renderStatus();
  }

  function renderBranches() {
    var list = document.getElementById("branch-list");
    clearChildren(list);
    if (!state.branches.length) {
      appendText(list, "div", "branch-meta", "No branches yet");
      return;
    }
    state.branches.forEach(function (branch) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "branch-item" + (branch.branch_id === state.activeBranchId ? " active" : "");
      button.onclick = function () {
        dispatch({ type: "branch_selected", branch_id: branch.branch_id });
        loadCheckpoints(branch.branch_id);
      };
      appendText(button, "div", "branch-title", model.shortId(branch.branch_id));
      appendText(button, "div", "branch-meta", branch.label || branch.parent_branch_id || "main");
      list.appendChild(button);
    });
  }

  function renderCheckpoints() {
    var list = document.getElementById("checkpoint-list");
    clearChildren(list);
    if (!state.checkpoints.length) {
      appendText(list, "div", "checkpoint-meta", "No checkpoints yet");
      return;
    }
    state.checkpoints.slice().reverse().slice(0, 30).forEach(function (checkpoint) {
      var item = document.createElement("button");
      item.type = "button";
      item.className = "checkpoint-item";
      item.onclick = function () { previewCheckpoint(checkpoint); };
      appendText(item, "div", "checkpoint-title", checkpoint.turn_id || checkpoint.event_id || ("seq " + checkpoint.seq));
      appendText(item, "div", "checkpoint-meta", (checkpoint.cumulative_change_ids || []).length + " changes");
      list.appendChild(item);
    });
  }

  function renderMessages() {
    var box = document.getElementById("messages");
    clearChildren(box);
    state.messages.forEach(function (message) {
      var div = document.createElement("div");
      div.className = "message " + message.role;
      div.textContent = message.content;
      box.appendChild(div);
    });
    box.scrollTop = box.scrollHeight;
  }

  function renderActivity() {
    var log = document.getElementById("activity-log");
    clearChildren(log);
    state.activity.slice(-12).forEach(function (event) {
      var div = document.createElement("div");
      div.className = "activity-item";
      appendText(div, "div", "branch-title", adapter.eventIcon(event.type) + " " + adapter.summarizeEvent(event));
      appendText(div, "div", "activity-meta", event.branch_id || "");
      log.appendChild(div);
    });
  }

  function renderRewindPreview() {
    var box = document.getElementById("rewind-preview");
    clearChildren(box);
    if (state.rewindPreview) {
      box.className = "rewind-preview";
      appendText(box, "div", "branch-title", "Preview: " + (state.rewindPreview.rollback_count || 0) + " changes");
      appendText(box, "div", "checkpoint-meta", "Branch " + (state.rewindPreview.planned_branch_id || "planned"));
      appendText(box, "div", "checkpoint-meta", "Files: " + ((state.rewindPreview.files || []).join(", ") || "none"));
    } else {
      box.className = "rewind-preview empty";
      box.textContent = "Select a checkpoint to preview rewind.";
    }
    if (state.rewindResult) {
      appendText(box, "div", "checkpoint-meta", model.formatRewindStatus(state.rewindResult));
    }
    document.getElementById("rewind-apply").disabled = !state.rewindPreview;
  }

  function renderStatus() {
    var metrics = state.metrics || {};
    setText("metric-tokens", metrics.tokens || "0");
    setText("metric-cache", metrics.cacheRate || "0%");
    setText("metric-latency", metrics.latency || "0ms");
    setText("metric-requests", metrics.requests || "0");
    setText("status-branch", state.activeBranchId || "br_main");
    setText("status-autonomy", state.runtime?.autonomy || "gated");
    setText("status-channel", state.statusChannel || state.runtime?.channel || "idle");
    setText("status-runtime", state.runtime?.current || "idle");
  }

  function showApprovalBox(approval) {
    var box = document.getElementById("approval-box");
    box.className = "";
    clearChildren(box);
    var card = document.createElement("div");
    card.className = "approval-card";
    appendText(card, "div", "approval-title", "Approval required");
    appendText(card, "div", "approval-type", approval.summary || approval.id);
    var actions = document.createElement("div");
    actions.className = "approval-actions";
    var allow = document.createElement("button");
    allow.type = "button";
    allow.textContent = "Allow";
    allow.onclick = function () { resolveApproval(approval.id, "allow"); };
    var deny = document.createElement("button");
    deny.type = "button";
    deny.textContent = "Deny";
    deny.onclick = function () { resolveApproval(approval.id, "deny"); };
    actions.appendChild(allow);
    actions.appendChild(deny);
    card.appendChild(actions);
    box.appendChild(card);
  }

  function resolveApproval(id, decision) {
    api.approve(id, decision).finally(function () {
      var box = document.getElementById("approval-box");
      box.className = "hidden";
      clearChildren(box);
    });
  }

  function checkApprovalState(event) {
    var approval = adapter.getApproval(event);
    if (approval) showApprovalBox(approval);
  }

  function appendText(parent, tag, className, text) {
    var el = document.createElement(tag);
    el.className = className;
    el.textContent = text;
    parent.appendChild(el);
    return el;
  }

  function setText(id, text) {
    var el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function clearChildren(el) {
    while (el && el.firstChild) el.removeChild(el.firstChild);
  }

  init();
})();
```

- [ ] **Step 4: Run static tests**

Run:

```powershell
npm.cmd test -- tests/unit/gui/renderer-static.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit Task 6**

Run:

```powershell
git add gui/renderer/app.js tests/unit/gui/renderer-static.test.js
git commit -m "feat(v2): wire gui branch rewind workbench"
```

---

## Task 7: Package Check and GUI Regression

**Files:**
- Modify: `package.json`
- Test: full suite

- [ ] **Step 1: Add workbench-state.js to syntax check**

In `package.json`, update the GUI check segment from:

```json
"gui/main.js gui/preload.js gui/renderer/app.js gui/kernel-host.js gui/renderer/event-adapter.js"
```

to:

```json
"gui/main.js gui/preload.js gui/renderer/app.js gui/renderer/workbench-state.js gui/kernel-host.js gui/renderer/event-adapter.js"
```

- [ ] **Step 2: Run focused GUI tests**

Run:

```powershell
npm.cmd test -- tests/unit/gui/kernel-host.test.js tests/unit/gui/renderer-event-adapter.test.js tests/unit/gui/workbench-state.test.js tests/unit/gui/renderer-static.test.js
```

Expected: PASS.

- [ ] **Step 3: Run full test suite**

Run:

```powershell
npm.cmd test
```

Expected: all tests pass. Total count should be greater than the V2-13 baseline of 477.

- [ ] **Step 4: Run syntax check**

Run:

```powershell
npm.cmd run check
```

Expected: PASS with no `SyntaxError`.

- [ ] **Step 5: Run whitespace check**

Run:

```powershell
git diff --check
```

Expected: PASS. If warnings mention pre-existing user-local files, confirm no V2-14 files are listed.

- [ ] **Step 6: Run pollution check**

Run:

```powershell
if (Test-Path -LiteralPath ".deepseek-code\v2") { throw ".deepseek-code/v2 should not be created by tests" } else { "no v2 session pollution" }
```

Expected: `no v2 session pollution`.

- [ ] **Step 7: Optional manual GUI smoke**

If Electron is available locally, run:

```powershell
npm.cmd --prefix gui start
```

Expected: app opens, workbench layout appears, no renderer crash. Do not block completion if Electron dependencies are not available; report that manual smoke was skipped.

- [ ] **Step 8: Visual QA checklist**

Inspect the GUI manually or through screenshots if the environment supports it. Confirm:

- Three columns are visible on desktop width.
- The center conversation is visually primary.
- Metrics for tokens, average latency, cache hit rate, and request count are visible without an overlay.
- Branch and checkpoint panels do not crowd the composer.
- No garbled characters or emoji fallback boxes are visible.
- Text stays inside controls at 900px width.
- The UI does not look like a generic purple gradient dashboard.

- [ ] **Step 9: Commit Task 7**

Run:

```powershell
git add package.json
git commit -m "chore(v2): include gui workbench checks"
```

---

## Final Review Checklist

- [ ] GUI has three-column workbench layout.
- [ ] Garbled old UI labels are gone.
- [ ] Chat send still calls `api.send()`.
- [ ] Approval card still uses real approval IDs.
- [ ] Branch list loads through preload IPC.
- [ ] Checkpoints load for selected branch.
- [ ] Usage, speed/latency, cache hit rate, and request count are visible in the workbench.
- [ ] Rewind preview displays rollback count, planned branch, and files.
- [ ] Rewind apply calls kernel API and refreshes workbench state.
- [ ] Recovery statuses are displayed clearly.
- [ ] `innerHTML` is not used in renderer files.
- [ ] Focused GUI tests pass.
- [ ] Full tests, syntax check, whitespace check, and pollution check pass.
- [ ] Visual QA is completed or explicitly reported as skipped because Electron cannot run.

## Execution Notes

Use one commit per task. Do not infer the active branch from `listBranches()` ordering; use `getActiveBranch()` from preload. Do not add visual diff viewing or branch deletion during V2-14.
