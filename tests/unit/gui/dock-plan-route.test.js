import test from "node:test";
import assert from "node:assert/strict";
import { DOCK_TABS, createInitialState, applyWorkbenchAction } from "../../../gui/src/state/workbench-state.js";
import kernelHostPkg from "../../../gui/kernel-host.js";
const { GUI_DOCK_TABS } = kernelHostPkg;

test("DOCK_TABS and GUI_DOCK_TABS include 'plan'", () => {
  assert.ok(DOCK_TABS.includes("plan"), "workbench-state DOCK_TABS must include 'plan'");
  assert.ok(GUI_DOCK_TABS.has("plan"), "kernel-host GUI_DOCK_TABS must include 'plan'");
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
