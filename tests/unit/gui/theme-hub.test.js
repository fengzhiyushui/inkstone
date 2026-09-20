import test from "node:test";
import assert from "node:assert/strict";
import { nextInGroup, otherModeTheme, groupOf } from "../../../gui/src/state/theme-hub.js";

test("nextInGroup cycles inside the same group and wraps at the end", () => {
  assert.equal(nextInGroup("sumi"), "slate");
  assert.equal(nextInGroup("ash"), "sumi");   // 暗组末尾回绕
  assert.equal(nextInGroup("paper"), "snow"); // 明组末尾回绕
});

test("otherModeTheme returns the most recent theme of the opposite mode", () => {
  assert.equal(otherModeTheme({ theme: "sumi", lastDark: "sumi", lastLight: "sand" }), "sand");
  assert.equal(otherModeTheme({ theme: "snow", lastDark: "ash", lastLight: "snow" }), "ash");
});

test("groupOf maps dim to dark and tint to light", () => {
  assert.equal(groupOf("nord"), "dark");
  assert.equal(groupOf("snow"), "light");
});

test("retired ids are normalized instead of throwing", () => {
  assert.equal(nextInGroup("rose"), "slate"); // rose → sumi → dark 组下一个
});
