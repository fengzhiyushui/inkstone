import test from "node:test";
import assert from "node:assert/strict";
import { applyWorkbenchAction, createInitialState } from "../../../gui/src/state/workbench-state.js";

test("messages capped at 200", () => {
  let s = createInitialState();
  for (let i = 0; i < 220; i++) {
    s = applyWorkbenchAction(s, { type: "message_added", message: { role: "user", text: String(i) } });
  }
  assert.equal(s.messages.length, 200);
  assert.equal(s.messages[0].text, "20");
});
