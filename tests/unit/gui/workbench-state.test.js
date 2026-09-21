import test from "node:test";
import assert from "node:assert/strict";
import * as state from "../../../gui/src/state/workbench-state.js";

test("createInitialState defines workbench defaults", () => {
  const initial = state.createInitialState();

  assert.deepEqual(initial.branches, []);
  assert.deepEqual(initial.checkpoints, []);
  assert.equal(initial.activeBranchId, "br_main");
  assert.equal(initial.selectedBranchId, "br_main");
  assert.equal(initial.rewindPreview, null);
  assert.equal(initial.rewindResult, null);
  assert.equal(initial.forceRewind, false);
  assert.equal(initial.railMode, "chat");
  assert.equal(initial.contextCollapsed, false);
  assert.equal(initial.railCollapsed, false);
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
  current = state.applyWorkbenchAction(current, { type: "rail_mode_changed", mode: "branches" });
  current = state.applyWorkbenchAction(current, { type: "context_collapsed_changed", collapsed: true });
  current = state.applyWorkbenchAction(current, { type: "inspector_mode_changed", mode: "checkpoints" });
  current = state.applyWorkbenchAction(current, { type: "theme_changed", theme: "slate" });

  assert.equal(current.emptyStateVisible, false);
  assert.equal(current.railMode, "branches");
  assert.equal(current.contextCollapsed, true);
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
  current = state.applyWorkbenchAction(current, { type: "rail_mode_changed", mode: "nonsense" });
  current = state.applyWorkbenchAction(current, { type: "inspector_mode_changed", mode: "nonsense" });
  current = state.applyWorkbenchAction(current, { type: "theme_changed", theme: "neon" });

  assert.equal(current.railMode, "chat");
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
      railMode: "timeline",
      contextCollapsed: true,
      railCollapsed: true,
      messages: [{ role: "user", content: "ignored" }]
    }
  });

  assert.equal(current.theme, "latte");
  assert.equal(current.railMode, "timeline");
  assert.equal(current.contextCollapsed, true);
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
    { type: "rail_mode_changed", mode: "timeline" }
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

// D3-M3: activity-bar viewlet switching (distinct from legacy railMode)
test("rail_view_changed switches the active viewlet; invalid falls back", () => {
  assert.equal(state.createInitialState().railView, "explorer");
  const scm = state.applyWorkbenchAction(state.createInitialState(), { type: "rail_view_changed", view: "scm" });
  assert.equal(scm.railView, "scm");
  const settings = state.applyWorkbenchAction(scm, { type: "rail_view_changed", view: "settings" });
  assert.equal(settings.railView, "settings");
  const bad = state.applyWorkbenchAction(settings, { type: "rail_view_changed", view: "nope" });
  assert.equal(bad.railView, "explorer");
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
