import test from "node:test";
import assert from "node:assert/strict";
import { GUI_THEMES, isLightTheme, themeLabel } from "../../../gui/src/state/themes.js";

test("themes: light group themes are flagged light", () => {
  for (const theme of GUI_THEMES.filter((x) => x.group === "light")) {
    assert.equal(isLightTheme(theme.id), true, theme.id);
  }
});

test("themes: dark and unknown themes are not light", () => {
  for (const theme of GUI_THEMES.filter((x) => x.group === "dark")) {
    assert.equal(isLightTheme(theme.id), false, theme.id);
  }
  assert.equal(isLightTheme("not-a-theme"), false);
});

test("themes: themeLabel returns display name with sumi fallback", () => {
  assert.equal(themeLabel("paper"), "宣");
  assert.equal(themeLabel("vesper"), "烬");
  assert.equal(themeLabel("missing"), "墨");
});
