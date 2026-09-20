import test from "node:test";
import assert from "node:assert/strict";
import { GUI_THEMES, TIERS, themesByTier, isLightTheme } from "../../../gui/src/state/themes.js";
import { TUI_THEMES, DEFAULT_TUI_THEME } from "../../../src/apps/tui/theme-palette.js";
import { NAMES } from "../../../scripts/gen-tui-theme.js";
import { createInitialState, applyWorkbenchAction } from "../../../gui/src/state/workbench-state.js";

const ids = GUI_THEMES.map((x) => x.id);
const RETIRED = { dawn: "lotus", mocha: "sumi", moon: "slate", forest: "ash", clay: "vesper", rose: "sumi" };

test("GUI / TUI palette / generator NAMES share one id set, in order", () => {
  assert.deepEqual(Object.keys(TUI_THEMES), ids);
  assert.deepEqual(Object.keys(NAMES), ids);
  assert.equal(ids.length, 10);
  assert.equal(DEFAULT_TUI_THEME, "sumi");
});
test("tiers are dark3/dim2/tint2/light3 and group is derived from tier", () => {
  const by = themesByTier();
  assert.deepEqual(TIERS.map((t) => by[t].length), [3, 2, 2, 3]);
  for (const th of GUI_THEMES) assert.equal(isLightTheme(th.id), th.tier === "tint" || th.tier === "light", th.id);
});
test("retired ids migrate and never survive normalize", () => {
  for (const [old, next] of Object.entries(RETIRED)) {
    assert.ok(!ids.includes(old), `${old} 仍在集合`);
    const s = applyWorkbenchAction(createInitialState(), { type: "theme_changed", theme: old });
    assert.equal(s.theme, next, `${old}→${next}`);
  }
});
test("theme_changed keeps lastDark / lastLight in sync by group", () => {
  let s = createInitialState();
  s = applyWorkbenchAction(s, { type: "theme_changed", theme: "snow" });
  assert.equal(s.lastLight, "snow"); assert.equal(s.lastDark, "sumi");
  s = applyWorkbenchAction(s, { type: "theme_changed", theme: "ash" });
  assert.equal(s.lastDark, "ash"); assert.equal(s.lastLight, "snow");
});
