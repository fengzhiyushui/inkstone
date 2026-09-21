import test from "node:test";
import assert from "node:assert/strict";
import { createInitialState, applyWorkbenchAction } from "../../../gui/src/state/workbench-state.js";

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
