import test from "node:test";
import assert from "node:assert/strict";
import {
  computeColumns, clampWidth, computeKeyboardDelta,
  SIDEBAR_MIN, SIDEBAR_MAX, SIDEBAR_DEFAULT, SIDEBAR_COLLAPSED,
  RIGHTBAR_MIN, RIGHTBAR_MAX, CENTER_MIN
} from "../../../gui/src/state/columns.js";

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
