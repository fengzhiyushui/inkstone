import test from "node:test";
import assert from "node:assert/strict";
import { computeColumns, clampWidth, SIDEBAR_DEFAULT, SIDEBAR_COLLAPSED, RIGHTBAR_MIN, CENTER_MIN } from "../../../gui/src/state/columns.js";

test("clampWidth rounds and clamps", () => {
  assert.equal(clampWidth(263.6, 264, 420), 264);
  assert.equal(clampWidth(999, 264, 420), 420);
  assert.equal(clampWidth(300.4, 264, 420), 300);
});
test("sidebar 0 means collapsed rail; otherwise clamped", () => {
  assert.equal(computeColumns(1280, 0, 0).sidebar, SIDEBAR_COLLAPSED);
  assert.equal(computeColumns(1280, 100, 0).sidebar, 264);
  assert.equal(computeColumns(1280, SIDEBAR_DEFAULT, 0).sidebar, 280);
});
test("right column drops its track before center goes below CENTER_MIN", () => {
  // 1280 - 280 - 400 = 600 available → rightbar 350 fits
  assert.deepEqual(computeColumns(1280, 280, 350), { sidebar: 280, center: 650, rightbar: 350 });
  // 900 - 280 - 400 = 220 < RIGHTBAR_MIN → track removed, center takes all
  assert.deepEqual(computeColumns(900, 280, 350), { sidebar: 280, center: 620, rightbar: 0 });
});
test("rightbar clamps to 70% of viewport", () => {
  assert.equal(computeColumns(2000, 280, 5000).rightbar, Math.min(2000 - 280 - CENTER_MIN, 1400));
});
test("collapsedWidth 0 hides the sidebar column entirely", () => {
  assert.equal(computeColumns(1280, 0, 0, 0).sidebar, 0);
});
