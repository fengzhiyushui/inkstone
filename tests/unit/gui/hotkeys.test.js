import test from "node:test";
import assert from "node:assert/strict";
import { isTypingTarget, shouldHandleShellShortcut } from "../../../gui/src/state/hotkeys.js";
import { applyWorkbenchAction, createInitialState } from "../../../gui/src/state/workbench-state.js";

test("isTypingTarget covers form controls and contenteditable", () => {
  assert.equal(isTypingTarget({ tagName: "INPUT" }), true);
  assert.equal(isTypingTarget({ tagName: "TEXTAREA" }), true);
  assert.equal(isTypingTarget({ tagName: "SELECT" }), true);
  assert.equal(isTypingTarget({ tagName: "DIV", isContentEditable: true }), true);
  assert.equal(isTypingTarget({ tagName: "BUTTON" }), false);
  assert.equal(isTypingTarget(null), false);
});

test("shouldHandleShellShortcut requires ctrl/meta and blocks typing + modals", () => {
  const base = { ctrlKey: true, metaKey: false, altKey: false, target: { tagName: "DIV" } };
  assert.equal(shouldHandleShellShortcut(base, {}), true);
  assert.equal(shouldHandleShellShortcut({ ...base, ctrlKey: false }, {}), false);
  assert.equal(shouldHandleShellShortcut({ ...base, target: { tagName: "INPUT" } }, {}), false);
  assert.equal(shouldHandleShellShortcut(base, { settingsOpen: true }), false);
  assert.equal(shouldHandleShellShortcut(base, { modalOpen: true }), false);
  assert.equal(shouldHandleShellShortcut({ ...base, altKey: true }, {}), false);
});

test("messages capped at 200", () => {
  let s = createInitialState();
  for (let i = 0; i < 220; i++) {
    s = applyWorkbenchAction(s, { type: "message_added", message: { role: "user", text: String(i) } });
  }
  assert.equal(s.messages.length, 200);
  assert.equal(s.messages[0].text, "20");
});
