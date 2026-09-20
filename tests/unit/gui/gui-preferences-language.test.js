import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { normalizeGuiPreferences } = require("../../../gui/kernel-host.js");

test("normalizeGuiPreferences persists language (default zh)", () => {
  assert.equal(normalizeGuiPreferences({}).language, "zh");
  assert.equal(normalizeGuiPreferences({ language: "en" }).language, "en");
  assert.equal(normalizeGuiPreferences({ language: "fr" }).language, "zh");
});

test("normalizeGuiPreferences keeps existing fields (no regression)", () => {
  const p = normalizeGuiPreferences({ theme: "day", railMode: "branches", contextCollapsed: true });
  assert.equal(p.theme, "latte");
  assert.equal(p.railMode, "branches");
  assert.equal(p.contextCollapsed, true);
  assert.equal(p.language, "zh");
});

test("normalizeGuiPreferences persists railCollapsed (default false)", () => {
  assert.equal(normalizeGuiPreferences({}).railCollapsed, false);
  assert.equal(normalizeGuiPreferences({ railCollapsed: true }).railCollapsed, true);
  assert.equal(normalizeGuiPreferences({ railCollapsed: "yes" }).railCollapsed, false);
});

test("normalizeGuiPreferences resets cross-group and non-boolean theme memory to defaults", () => {
  const p = normalizeGuiPreferences({ lastDark: "snow", lastLight: "sumi", glass: "yes" });
  assert.equal(p.lastDark, "sumi");
  assert.equal(p.lastLight, "latte");
  assert.equal(p.glass, true);
});
