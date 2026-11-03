// tests/unit/gui/workbench-state.test.js — 工作台状态机(列/停靠/路由/会话分组)领域测试
//
// v1.19.1 测试归并:本文件由下列历史任务单测试合并而成,每个来源包裹在独立
// describe 块中(异步回调 + 动态 import,来源间零共享绑定),测试语义与拆分前一致。
import { describe } from "node:test";

// ---------------------------------------------------------------------------
// 来源:tests/unit/gui/workbench-state.test.js
// ---------------------------------------------------------------------------
describe("unit/gui/workbench-state", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const state = await import("../../../gui/src/state/workbench-state.js");

  test("createInitialState defines workbench defaults", () => {
    const initial = state.createInitialState();

    assert.deepEqual(initial.branches, []);
    assert.deepEqual(initial.checkpoints, []);
    assert.equal(initial.activeBranchId, "br_main");
    assert.equal(initial.selectedBranchId, "br_main");
    assert.equal(initial.rewindPreview, null);
    assert.equal(initial.rewindResult, null);
    assert.equal(initial.forceRewind, false);
    assert.equal(initial.railCollapsed, false);
    // v1.8.3:railMode / railView / contextCollapsed 随 v1.8.1 三列壳层退役,不得复活
    assert.equal("railMode" in initial, false);
    assert.equal("railView" in initial, false);
    assert.equal("contextCollapsed" in initial, false);
    assert.equal(initial.sidebarWidth, 280);
    assert.equal(initial.rightbarWidth, 0);
    assert.equal(initial.rightbarOpen, false);
    assert.equal(initial.dockTab, "files");
    assert.equal(initial.inspectorMode, "activity");
    assert.equal(initial.theme, "sumi");
    assert.equal(initial.emptyStateVisible, true);
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

  test("runtime error and loading actions expose degraded workbench state", () => {
    const initial = state.createInitialState();
    const loading = state.applyWorkbenchAction(initial, { type: "loading_changed", key: "branches", value: true });
    const failed = state.applyWorkbenchAction(loading, { type: "error_reported", area: "branches", message: "branch api failed" });

    assert.deepEqual(loading.loading, { branches: true });
    assert.equal(failed.loading.branches, false);
    assert.deepEqual(failed.errors, [{ area: "branches", message: "branch api failed" }]);
    assert.equal(failed.degraded, true);
  });

  test("error_reported caps errors and redacts empty messages", () => {
    let current = state.createInitialState();
    for (let i = 0; i < 8; i++) {
      current = state.applyWorkbenchAction(current, { type: "error_reported", area: "api", message: i === 0 ? "" : `error ${i}` });
    }

    assert.equal(current.errors.length, 5);
    assert.equal(current.errors[0].message, "error 3");
    assert.equal(current.degraded, true);
  });

  test("message activity and presentation actions update workbench state", () => {
    let current = state.createInitialState();
    current = state.applyWorkbenchAction(current, { type: "message_added", message: { role: "user", content: "inspect README" } });
    current = state.applyWorkbenchAction(current, { type: "inspector_mode_changed", mode: "checkpoints" });
    current = state.applyWorkbenchAction(current, { type: "theme_changed", theme: "slate" });

    assert.equal(current.emptyStateVisible, false);
    assert.equal(current.inspectorMode, "checkpoints");
    assert.equal(current.theme, "slate");
    assert.equal(state.statusSummary(current).runtime, "idle");
    assert.equal(state.statusSummary(current).branch, "br_main");
  });

  test("traffic helpers map runtime health to a small traffic-light vocabulary with labels", () => {
    assert.equal(state.trafficTone({ runtime: { current: "idle" } }), "ready");
    assert.equal(state.trafficTone({ runtime: { current: "complete" } }), "ready");
    assert.equal(state.trafficTone({ runtime: { current: "acting" } }), "working");
    assert.equal(state.trafficTone({ runtime: { current: "awaiting_approval" } }), "working");
    assert.equal(state.trafficTone({ runtime: { current: "error" } }), "error");
    assert.equal(state.trafficTone({ degraded: true, runtime: { current: "idle" } }), "error");
    assert.equal(state.trafficTone({ runtime: { current: "offline" } }), "offline");
    assert.equal(state.trafficLabel("ready", { runtime: { current: "idle" } }), "Ready");
    assert.equal(state.trafficLabel("working", { runtime: { current: "awaiting_approval" } }), "Approval");
    assert.equal(state.trafficLabel("error", { degraded: true }), "Error");
    assert.equal(state.trafficLabel("offline", {}), "Offline");
  });

  test("risk events move focus to contextual inspector modes", () => {
    let current = state.createInitialState();
    current = state.applyWorkbenchAction(current, { type: "event_received", event: { type: "approval:requested", approval: { id: "ap_1" } } });
    assert.equal(current.inspectorMode, "approval");

    current = state.applyWorkbenchAction(current, { type: "checkpoint_selected", checkpoint: { turn_id: "turn_1", seq: 3 } });
    assert.equal(current.inspectorMode, "rewind");

    current = state.applyWorkbenchAction(current, { type: "event_received", event: { type: "agent:error", message: "failed" } });
    assert.equal(current.inspectorMode, "details");
  });

  test("invalid presentation choices fall back to safe defaults", () => {
    let current = state.createInitialState();
    current = state.applyWorkbenchAction(current, { type: "inspector_mode_changed", mode: "nonsense" });
    current = state.applyWorkbenchAction(current, { type: "theme_changed", theme: "neon" });

    assert.equal(current.inspectorMode, "activity");
    assert.equal(current.theme, "sumi");
    assert.equal(state.themeLabel("sumi"), "墨");
    assert.equal(state.themeLabel("lotus"), "荷");
    assert.equal(state.themeLabel("nonsense"), "墨");
  });

  test("preferences_loaded hydrates only safe presentation fields", () => {
    const current = state.applyWorkbenchAction(state.createInitialState(), {
      type: "preferences_loaded",
      preferences: {
        theme: "day",
        railMode: "timeline",       // 退役键:必须被忽略
        contextCollapsed: true,     // 退役键:必须被忽略
        railCollapsed: true,
        messages: [{ role: "user", content: "ignored" }]
      }
    });

    assert.equal(current.theme, "latte");
    assert.equal("railMode" in current, false);
    assert.equal("contextCollapsed" in current, false);
    assert.equal(current.railCollapsed, true);
    assert.deepEqual(current.messages, []);
  });

  test("preferences_loaded hydrates lastDark / lastLight / glass", () => {
    const current = state.applyWorkbenchAction(state.createInitialState(), {
      type: "preferences_loaded",
      preferences: { lastDark: "ash", lastLight: "sand", glass: false }
    });
    assert.equal(current.lastDark, "ash");
    assert.equal(current.lastLight, "sand");
    assert.equal(current.glass, false);
  });

  test("rail_collapsed_changed toggles the sidebar and persists via preferences round-trip", () => {
    const initial = state.createInitialState();
    const folded = state.applyWorkbenchAction(initial, { type: "rail_collapsed_changed", collapsed: true });
    assert.equal(folded.railCollapsed, true);
    assert.notEqual(folded, initial);
    const restored = state.applyWorkbenchAction(folded, {
      type: "preferences_loaded",
      preferences: { railCollapsed: false }
    });
    assert.equal(restored.railCollapsed, false);
    const nonBoolean = state.applyWorkbenchAction(initial, { type: "rail_collapsed_changed", collapsed: "yes" });
    assert.equal(nonBoolean.railCollapsed, true); // Boolean("yes") === true
    assert.equal(state.applyWorkbenchAction(initial, { type: "rail_collapsed_changed", collapsed: null }).railCollapsed, false);
  });

  test("inspector_closed returns to activity without clearing selected checkpoint", () => {
    const cp = { turn_id: "turn_1", seq: 4 };
    const selected = state.applyWorkbenchAction(state.createInitialState(), { type: "checkpoint_selected", checkpoint: cp });
    const closed = state.applyWorkbenchAction(selected, { type: "inspector_closed" });

    assert.equal(selected.inspectorMode, "rewind");
    assert.equal(closed.inspectorMode, "activity");
    assert.deepEqual(closed.selectedCheckpoint, cp);
  });

  // D1-M1: immutability guards (React useReducer relies on new references)
  test("state-changing actions return a NEW reference", () => {
    const s0 = state.createInitialState();
    const mutating = [
      { type: "message_added", message: { role: "user", text: "hi" } },
      { type: "event_received", event: { type: "agent:step" } },
      { type: "theme_changed", theme: "day" },
      { type: "branch_selected", branch_id: "br_x" },
      { type: "dock_tab_changed", tab: "changes" }
    ];
    let prev = s0;
    for (const a of mutating) {
      const next = state.applyWorkbenchAction(prev, a);
      assert.notEqual(next, prev, a.type + " must return new ref");
      prev = next;
    }
  });

  test("does not mutate the previous state in place", () => {
    const s0 = state.createInitialState();
    const before = JSON.stringify(s0);
    state.applyWorkbenchAction(s0, { type: "message_added", message: { text: "x" } });
    assert.equal(JSON.stringify(s0), before);
  });

  test("unknown/no-op action returns the SAME reference", () => {
    const s0 = state.createInitialState();
    assert.equal(state.applyWorkbenchAction(s0, { type: "___nope___" }), s0);
    assert.equal(state.applyWorkbenchAction(s0, {}), s0);
  });

  // D-1 rebuild: bilingual language state (default zh, switchable, from preferences)
  test("language defaults to zh and switches via action + preferences", () => {
    assert.equal(state.createInitialState().language, "zh");
    const en = state.applyWorkbenchAction(state.createInitialState(), { type: "language_changed", language: "en" });
    assert.equal(en.language, "en");
    const bad = state.applyWorkbenchAction(en, { type: "language_changed", language: "fr" });
    assert.equal(bad.language, "zh"); // invalid falls back to default
    const fromPrefs = state.applyWorkbenchAction(state.createInitialState(), { type: "preferences_loaded", preferences: { language: "en" } });
    assert.equal(fromPrefs.language, "en");
  });

  // D2-M2: file tree + open-files state
  test("tree_loaded / file open / activate / close", () => {
    let s = state.createInitialState();
    s = state.applyWorkbenchAction(s, { type: "tree_loaded", files: ["a.js", "b.js"] });
    assert.deepEqual(s.fileTree, ["a.js", "b.js"]);
    s = state.applyWorkbenchAction(s, { type: "file_opened", file: { path: "a.js", content: "x", language: "javascript" } });
    assert.equal(s.activeFile, "a.js");
    assert.equal(s.openFiles.length, 1);
    s = state.applyWorkbenchAction(s, { type: "file_opened", file: { path: "a.js", content: "x2" } });
    assert.equal(s.openFiles.length, 1);                 // dedupe by path
    assert.equal(s.openFiles[0].content, "x2");          // content updated
    s = state.applyWorkbenchAction(s, { type: "file_opened", file: { path: "b.js", content: "y" } });
    assert.equal(s.openFiles.length, 2);
    assert.equal(s.activeFile, "b.js");
    s = state.applyWorkbenchAction(s, { type: "file_activated", path: "a.js" });
    assert.equal(s.activeFile, "a.js");
    s = state.applyWorkbenchAction(s, { type: "file_closed", path: "a.js" });
    assert.equal(s.openFiles.length, 1);
    assert.equal(s.activeFile, "b.js");                  // fallback to remaining
  });

  // D3-M10: per-file dirty tracking for editable Monaco + save
  test("file edit marks dirty; save/close clears it", () => {
    let s = state.createInitialState();
    s = state.applyWorkbenchAction(s, { type: "file_opened", file: { path: "a.js", content: "x", language: "javascript" } });
    assert.deepEqual(s.dirty, {});
    s = state.applyWorkbenchAction(s, { type: "file_edited", path: "a.js", content: "x2" });
    assert.equal(s.dirty["a.js"], true);
    assert.equal(s.openFiles[0].content, "x2");          // draft content tracked on the tab
    s = state.applyWorkbenchAction(s, { type: "file_saved", path: "a.js", content: "x2" });
    assert.equal(s.dirty["a.js"], undefined);            // saved → no longer dirty
    s = state.applyWorkbenchAction(s, { type: "file_edited", path: "a.js", content: "x3" });
    assert.equal(s.dirty["a.js"], true);
    s = state.applyWorkbenchAction(s, { type: "file_closed", path: "a.js" });
    assert.equal(s.dirty["a.js"], undefined);            // closing drops dirty flag
  });

  // D3-M5: cursor position + config slice feed the status bar
  test("cursor_moved clamps to >=1; settings_loaded stores model/hasApiKey", () => {
    let s = state.createInitialState();
    assert.deepEqual(s.cursor, { line: 1, column: 1 });
    s = state.applyWorkbenchAction(s, { type: "cursor_moved", position: { line: 12, column: 5 } });
    assert.deepEqual(s.cursor, { line: 12, column: 5 });
    s = state.applyWorkbenchAction(s, { type: "cursor_moved", position: { line: 0, column: -3 } });
    assert.deepEqual(s.cursor, { line: 1, column: 1 });   // clamped
    s = state.applyWorkbenchAction(s, { type: "settings_loaded", config: { model: "deepseek-chat", hasApiKey: true } });
    assert.deepEqual(s.config, { model: "deepseek-chat", hasApiKey: true });
  });

  test("D4: changesTick increments only on diff/rollback events", () => {
    let s = state.createInitialState();
    assert.equal(s.changesTick, 0);
    s = state.applyWorkbenchAction(s, { type: "event_received", event: { type: "file:diff_applied", change_id: "c1" } });
    assert.equal(s.changesTick, 1);
    s = state.applyWorkbenchAction(s, { type: "event_received", event: { type: "tool:call", id: "t" } });
    assert.equal(s.changesTick, 1);
    s = state.applyWorkbenchAction(s, { type: "event_received", event: { type: "file:rollback_applied", change_id: "c1" } });
    assert.equal(s.changesTick, 2);
  });

  test("D4: changes/changeDiff/pendingReveal actions", () => {
    let s = state.createInitialState();
    s = state.applyWorkbenchAction(s, { type: "changes_loaded", changes: [{ id: "c1" }] });
    assert.equal(s.changes.length, 1);
    s = state.applyWorkbenchAction(s, { type: "change_diff_loaded", diff: { meta: { id: "c1" }, file: { path: "a" }, error: null } });
    assert.equal(s.changeDiff.meta.id, "c1");
    s = state.applyWorkbenchAction(s, { type: "reveal_requested", path: "a", line: 7 });
    assert.deepEqual(s.pendingReveal, { path: "a", line: 7 });
    s = state.applyWorkbenchAction(s, { type: "reveal_requested", path: "a", line: 0 });
    assert.equal(s.pendingReveal.line, 1);
    s = state.applyWorkbenchAction(s, { type: "reveal_consumed" });
    assert.equal(s.pendingReveal, null);
    s = state.applyWorkbenchAction(s, { type: "change_diff_dismissed" });
    assert.equal(s.changeDiff, null);
  });

  test("agent:final appends an assistant message to the stream", () => {
    let s = state.createInitialState();
    s = state.applyWorkbenchAction(s, { type: "message_added", message: { role: "user", text: "hi" } });
    s = state.applyWorkbenchAction(s, { type: "event_received", event: { type: "agent:final", content: "done", status: "complete" } });
    assert.equal(s.messages.length, 2);
    assert.deepEqual(s.messages[1], { role: "assistant", text: "done" });
    // stopped(预算截停)同样入流——用户要看到"为什么停了"
    s = state.applyWorkbenchAction(s, { type: "event_received", event: { type: "agent:final", content: "Stopped: budget", status: "stopped" } });
    assert.equal(s.messages[2].text, "Stopped: budget");
  });

  test("agent:final with empty content does not append a blank bubble", () => {
    const s0 = state.createInitialState();
    const s = state.applyWorkbenchAction(s0, { type: "event_received", event: { type: "agent:final", content: "" } });
    assert.equal(s.messages.length, 0);
  });

  // B0:壳层四 action
  test("sidebar/rightbar/dock actions update workbench state", () => {
    let s = state.createInitialState();
    s = state.applyWorkbenchAction(s, { type: "sidebar_resized", width: 320 });
    assert.equal(s.sidebarWidth, 320);
    s = state.applyWorkbenchAction(s, { type: "sidebar_resized", width: 99 });
    assert.equal(s.sidebarWidth, 320); // 非法宽度忽略

    s = state.applyWorkbenchAction(s, { type: "rightbar_toggled", viewport: 1280 });
    assert.equal(s.rightbarOpen, true);
    assert.ok(s.rightbarWidth >= 300, "首次打开应给出默认宽度");
    s = state.applyWorkbenchAction(s, { type: "rightbar_toggled", viewport: 1280 });
    assert.equal(s.rightbarOpen, false);

    s = state.applyWorkbenchAction(s, { type: "rightbar_resized", width: 360 });
    assert.equal(s.rightbarWidth, 360);
    s = state.applyWorkbenchAction(s, { type: "dock_tab_changed", tab: "changes" });
    assert.equal(s.dockTab, "changes");
    s = state.applyWorkbenchAction(s, { type: "dock_tab_changed", tab: "nope" });
    assert.equal(s.dockTab, "changes"); // 白名单外忽略
  });

  test("preferences_loaded hydrates column prefs; invalid values fall back", () => {
    const good = state.applyWorkbenchAction(state.createInitialState(), {
      type: "preferences_loaded",
      preferences: { sidebarWidth: 360, rightbarWidth: 400, rightbarOpen: true, dockTab: "recovery" }
    });
    assert.equal(good.sidebarWidth, 360);
    assert.equal(good.rightbarWidth, 400);
    assert.equal(good.rightbarOpen, true);
    assert.equal(good.dockTab, "recovery");

    const bad = state.applyWorkbenchAction(state.createInitialState(), {
      type: "preferences_loaded",
      preferences: { sidebarWidth: 10, rightbarWidth: 12, rightbarOpen: "yes", dockTab: "zzz" }
    });
    assert.equal(bad.sidebarWidth, 280);
    assert.equal(bad.rightbarWidth, 0);
    assert.equal(bad.rightbarOpen, false);
    assert.equal(bad.dockTab, "files");
  });

  test("chat_tab_changed toggles chat/trajectory; invalid ignored", () => {
    let s = state.createInitialState();
    assert.equal(s.chatTab, "chat");
    s = state.applyWorkbenchAction(s, { type: "chat_tab_changed", tab: "trajectory" });
    assert.equal(s.chatTab, "trajectory");
    s = state.applyWorkbenchAction(s, { type: "chat_tab_changed", tab: "nope" });
    assert.equal(s.chatTab, "trajectory");
    s = state.applyWorkbenchAction(s, { type: "chat_tab_changed", tab: "chat" });
    assert.equal(s.chatTab, "chat");
  });

  test("settings_toggled opens and closes the settings modal", () => {
    let s = state.createInitialState();
    assert.equal(s.settingsOpen, false);
    s = state.applyWorkbenchAction(s, { type: "settings_toggled", open: true });
    assert.equal(s.settingsOpen, true);
    s = state.applyWorkbenchAction(s, { type: "settings_toggled", open: false });
    assert.equal(s.settingsOpen, false);
    s = state.applyWorkbenchAction(s, { type: "settings_toggled" });
    assert.equal(s.settingsOpen, true);
  });

  test("project_switched switches project and resets fileTree and dockFiles", () => {
    let s = state.createInitialState();
    s = state.applyWorkbenchAction(s, { type: "tree_loaded", files: ["src/index.js"] });
    s = state.applyWorkbenchAction(s, { type: "tree_dir_toggled", path: "src" });
    assert.equal(s.fileTree.length, 1);
    assert.equal(s.dockFiles.expanded["src"], true);

    s = state.applyWorkbenchAction(s, { type: "project_switched", root: "/path/to/new-proj" });
    assert.equal(s.currentProject, "/path/to/new-proj");
    assert.equal(s.view, "chat");
    assert.deepEqual(s.fileTree, []);
    assert.deepEqual(s.dockFiles.expanded, {});
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/gui/columns.test.js
// ---------------------------------------------------------------------------
describe("unit/gui/columns", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { computeColumns, clampWidth, computeKeyboardDelta, SIDEBAR_MIN, SIDEBAR_MAX, SIDEBAR_DEFAULT, SIDEBAR_COLLAPSED, RIGHTBAR_MIN, RIGHTBAR_MAX, CENTER_MIN } = await import("../../../gui/src/state/columns.js");

  test("clampWidth rounds and clamps", () => {
    assert.equal(clampWidth(263.6, 264, 420), 264);
    assert.equal(clampWidth(999, 264, 420), 420);
    assert.equal(clampWidth(300.4, 264, 420), 300);
  });

  test("clampWidth never returns below min when max < min", () => {
    assert.equal(clampWidth(100, 300, 250), 300);
    assert.equal(clampWidth(400, 300, 250), 300);
  });

  test("sidebar 0 means collapsed rail; otherwise clamped", () => {
    assert.equal(computeColumns(1280, 0, 0).sidebar, SIDEBAR_COLLAPSED);
    assert.equal(computeColumns(1280, 100, 0).sidebar, 264);
    assert.equal(computeColumns(1280, SIDEBAR_DEFAULT, 0).sidebar, 280);
    assert.equal(computeColumns(1280, 9999, 0).sidebar, SIDEBAR_MAX);
  });

  test("right column drops its track before center goes below CENTER_MIN", () => {
    assert.deepEqual(computeColumns(1280, 280, 350), { sidebar: 280, center: 650, rightbar: 350 });
    assert.deepEqual(computeColumns(900, 280, 350), { sidebar: 280, center: 620, rightbar: 0 });
  });

  test("rightbar clamps to 70% of viewport and never exceeds RIGHTBAR_MAX", () => {
    assert.equal(computeColumns(2000, 280, 5000).rightbar, Math.min(2000 - 280 - CENTER_MIN, 1400));
    assert.ok(computeColumns(4000, 280, 90000).rightbar <= RIGHTBAR_MAX);
  });

  test("rightbar never lands between 0 and RIGHTBAR_MIN-1 via clamp inversion", () => {
    // viewport*0.7 can theoretically undercut RIGHTBAR_MIN on tiny widths
    const r = computeColumns(420, 56, 5000).rightbar;
    assert.ok(r === 0 || r >= RIGHTBAR_MIN, `rightbar=${r}`);
  });

  test("collapsedWidth 0 hides the sidebar column entirely", () => {
    assert.equal(computeColumns(1280, 0, 0, 0).sidebar, 0);
  });

  test("columns sum to viewport (no horizontal overflow)", () => {
    for (const vp of [880, 1024, 1280, 1600, 2560]) {
      for (const sb of [0, 280, 420]) {
        for (const rb of [0, 300, 450, 2000]) {
          const c = computeColumns(vp, sb, rb);
          assert.equal(c.sidebar + c.center + c.rightbar, vp, `vp=${vp} sb=${sb} rb=${rb} → ${JSON.stringify(c)}`);
          assert.ok(c.center >= 0);
          assert.ok(c.rightbar === 0 || c.rightbar >= RIGHTBAR_MIN);
        }
      }
    }
  });

  test("computeKeyboardDelta computes screen deltas for arrow keys", () => {
    assert.equal(computeKeyboardDelta("ArrowLeft", false), -8);
    assert.equal(computeKeyboardDelta("ArrowLeft", true), -32);
    assert.equal(computeKeyboardDelta("ArrowRight", false), 8);
    assert.equal(computeKeyboardDelta("ArrowRight", true), 32);
    assert.equal(computeKeyboardDelta("ArrowUp", false), 0);
    assert.equal(computeKeyboardDelta("Escape", false), 0);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/gui/dock-state.test.js
// ---------------------------------------------------------------------------
describe("unit/gui/dock-state", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createInitialState, applyWorkbenchAction } = await import("../../../gui/src/state/workbench-state.js");

  test("rightbar_toggled flips open and seeds default width on first open", () => {
    let s = createInitialState();
    assert.equal(s.rightbarOpen, false);
    s = applyWorkbenchAction(s, { type: "rightbar_toggled", viewport: 1280 });
    assert.equal(s.rightbarOpen, true);
    assert.equal(s.rightbarWidth, Math.round(1280 * 0.45));
    s = applyWorkbenchAction(s, { type: "rightbar_toggled", viewport: 1280 });
    assert.equal(s.rightbarOpen, false);
    // 再次打开时已有合法宽度 → 保持
    s = applyWorkbenchAction(s, { type: "rightbar_resized", width: 360 });
    s = applyWorkbenchAction(s, { type: "rightbar_toggled", viewport: 1280 });
    assert.equal(s.rightbarOpen, true);
    assert.equal(s.rightbarWidth, 360);
  });

  test("dock_tab_changed ignores values outside the whitelist", () => {
    let s = createInitialState();
    s = applyWorkbenchAction(s, { type: "dock_tab_changed", tab: "changes" });
    assert.equal(s.dockTab, "changes");
    s = applyWorkbenchAction(s, { type: "dock_tab_changed", tab: "zzz" });
    assert.equal(s.dockTab, "changes");
  });

  test("tree_dir_toggled adds and removes paths in dockFiles.expanded", () => {
    let s = createInitialState();
    assert.deepEqual(s.dockFiles.expanded, {});
    s = applyWorkbenchAction(s, { type: "tree_dir_toggled", path: "src" });
    assert.equal(s.dockFiles.expanded.src, true);
    s = applyWorkbenchAction(s, { type: "tree_dir_toggled", path: "src/lib" });
    assert.equal(s.dockFiles.expanded["src/lib"], true);
    s = applyWorkbenchAction(s, { type: "tree_dir_toggled", path: "src" });
    assert.equal(s.dockFiles.expanded.src, undefined);
    assert.equal(s.dockFiles.expanded["src/lib"], true);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/gui/dock-plan-route.test.js
// ---------------------------------------------------------------------------
describe("unit/gui/dock-plan-route", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { DOCK_TABS, createInitialState, applyWorkbenchAction } = await import("../../../gui/src/state/workbench-state.js");
  const { default: kernelHostPkg } = await import("../../../gui/kernel-host.js");

  const { GUI_DOCK_TABS } = kernelHostPkg;

  test("DOCK_TABS and GUI_DOCK_TABS include 'plan' and 'inspector'", () => {
    assert.ok(DOCK_TABS.includes("plan"), "workbench-state DOCK_TABS must include 'plan'");
    assert.ok(GUI_DOCK_TABS.has("plan"), "kernel-host GUI_DOCK_TABS must include 'plan'");
    assert.ok(DOCK_TABS.includes("inspector"), "workbench-state DOCK_TABS must include 'inspector'");
    assert.ok(GUI_DOCK_TABS.has("inspector"), "kernel-host GUI_DOCK_TABS must include 'inspector'");
  });

  test("dock_tab_changed allows switching to 'plan'", () => {
    let s = createInitialState();
    assert.equal(s.dockTab, "files");

    s = applyWorkbenchAction(s, { type: "dock_tab_changed", tab: "plan" });
    assert.equal(s.dockTab, "plan");
  });

  test("project_switched resets session-scoped state including messages, activity, cards, and changeDiff", () => {
    let s = createInitialState();
    s = applyWorkbenchAction(s, {
      type: "message_added",
      message: { id: "m1", role: "user", text: "hi" }
    });
    s = applyWorkbenchAction(s, {
      type: "event_received",
      event: { type: "tool:call", seq: 1 }
    });
    s = {
      ...s,
      cards: [{ id: "c1" }],
      openFiles: [{ path: "src/index.js" }],
      changeDiff: { path: "src/index.js", before: "a", after: "b" }
    };

    assert.equal(s.messages.length, 1);
    assert.equal(s.activity.length, 1);
    assert.equal(s.cards.length, 1);
    assert.equal(s.openFiles.length, 1);
    assert.ok(s.changeDiff);

    const switched = applyWorkbenchAction(s, {
      type: "project_switched",
      root: "/path/to/p2"
    });

    assert.deepEqual(switched.messages, []);
    assert.deepEqual(switched.activity, []);
    assert.deepEqual(switched.cards, []);
    assert.deepEqual(switched.openFiles, []);
    assert.equal(switched.changeDiff, null);
    assert.equal(switched.currentProject, "/path/to/p2");
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/gui/session-groups.test.js
// ---------------------------------------------------------------------------
describe("unit/gui/session-groups", async () => {

  // 固定「现在」= 2026-07-31 15:00 本地时间,避免测试随真实时钟漂移。

  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { DAY_BUCKETS, dayBucket, sessionStamp, groupSessionsByDate, matchesQuery, filterProjectTree, recentSessions } = await import("../../../gui/src/state/session-groups.js");

  const NOW = new Date(2026, 6, 31, 15, 0, 0).getTime();
  const at = (y, m, d, hh = 12, mm = 0) => new Date(y, m, d, hh, mm, 0).getTime();

  test("dayBucket:今天/昨天/本周/更早四段边界", () => {
    assert.equal(DAY_BUCKETS.length, 4);
    assert.equal(dayBucket(at(2026, 6, 31, 0, 1), NOW), "today");
    assert.equal(dayBucket(at(2026, 6, 30, 23, 59), NOW), "yesterday");
    assert.equal(dayBucket(at(2026, 6, 27), NOW), "thisWeek");
    assert.equal(dayBucket(at(2026, 6, 20), NOW), "earlier");
    assert.equal(dayBucket(0, NOW), "earlier");
    assert.equal(dayBucket(undefined, NOW), "earlier");
  });

  test("sessionStamp:今天给时:分,本周给星期序号,更早给月-日", () => {
    assert.deepEqual(sessionStamp(at(2026, 6, 31, 9, 5), NOW), { kind: "time", bucket: "today", text: "09:05" });
    assert.equal(sessionStamp(at(2026, 6, 30, 18, 22), NOW).text, "18:22");
    const week = sessionStamp(at(2026, 6, 28, 10, 0), NOW); // 2026-07-28 是周二
    assert.equal(week.kind, "weekday");
    assert.equal(week.weekday, new Date(2026, 6, 28).getDay());
    assert.deepEqual(sessionStamp(at(2026, 5, 9, 8, 0), NOW), { kind: "date", bucket: "earlier", text: "06-09" });
  });

  test("groupSessionsByDate:空段不出现,段内顺序保持", () => {
    const sessions = [
      { id: "a", mtime: at(2026, 6, 31, 12, 40) },
      { id: "b", mtime: at(2026, 6, 31, 11, 2) },
      { id: "c", mtime: at(2026, 6, 20) }
    ];
    const groups = groupSessionsByDate(sessions, NOW);
    assert.deepEqual(groups.map((g) => g.bucket), ["today", "earlier"]);
    assert.deepEqual(groups[0].sessions.map((s) => s.id), ["a", "b"]);
    assert.deepEqual(groupSessionsByDate([], NOW), []);
    assert.deepEqual(groupSessionsByDate(null, NOW), []);
  });

  test("matchesQuery:空查询恒真,大小写不敏感", () => {
    assert.equal(matchesQuery("Login.jsx", ""), true);
    assert.equal(matchesQuery("Login.jsx", "  "), true);
    assert.equal(matchesQuery("重构登录页", "登录"), true);
    assert.equal(matchesQuery("Login.jsx", "LOGIN"), true);
    assert.equal(matchesQuery(null, "x"), false);
  });

  const PROJECTS = [
    { id: "proj_a", name: "inkstone", root: "D:\\studio\\inkstone" },
    { id: "proj_b", name: "shop-frontend", root: "D:\\work\\shop-frontend" }
  ];
  const SESSIONS = [
    { projectDir: "proj_a", sessions: [{ id: "1", summary: "重构登录页", mtime: at(2026, 6, 31, 12, 40) }] },
    { projectDir: "proj_b", sessions: [{ id: "2", summary: "购物车结算", mtime: at(2026, 6, 31, 14, 5) }] }
  ];

  test("filterProjectTree:无查询返回全部;命中项目名保留整项目", () => {
    const all = filterProjectTree(PROJECTS, SESSIONS, "");
    assert.equal(all.length, 2);
    assert.equal(all[0].sessions.length, 1);

    const byProject = filterProjectTree(PROJECTS, SESSIONS, "shop");
    assert.equal(byProject.length, 1);
    assert.equal(byProject[0].project.id, "proj_b");
    assert.equal(byProject[0].matchedProject, true);
  });

  test("filterProjectTree:只命中会话时只留命中的会话;全不命中则丢弃", () => {
    const bySession = filterProjectTree(PROJECTS, SESSIONS, "登录");
    assert.equal(bySession.length, 1);
    assert.equal(bySession[0].project.id, "proj_a");
    assert.equal(bySession[0].matchedProject, false);
    assert.deepEqual(bySession[0].sessions.map((s) => s.id), ["1"]);

    assert.deepEqual(filterProjectTree(PROJECTS, SESSIONS, "不存在的关键词"), []);
  });

  test("filterProjectTree:路径命中也算项目命中", () => {
    const hit = filterProjectTree(PROJECTS, SESSIONS, "D:\\work");
    assert.equal(hit.length, 1);
    assert.equal(hit[0].project.id, "proj_b");
  });

  test("recentSessions:跨项目按 mtime 倒序,带项目名,受 limit 约束", () => {
    const recent = recentSessions(PROJECTS, SESSIONS, 5);
    assert.deepEqual(recent.map((s) => s.id), ["2", "1"]);
    assert.equal(recent[0].projectName, "shop-frontend");
    assert.equal(recentSessions(PROJECTS, SESSIONS, 1).length, 1);
    assert.deepEqual(recentSessions(PROJECTS, SESSIONS, 0), []);
    assert.deepEqual(recentSessions(null, null, 3), []);
  });
});
