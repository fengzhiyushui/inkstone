import test from "node:test";
import assert from "node:assert/strict";
import { promptMentionsJson, applyJsonMode, parseJsonContent } from "../../../src/deepseek/json-mode.js";

test("detects json in system or user messages case-insensitively", () => {
  assert.equal(promptMentionsJson([{ role: "system", content: "Return JSON only." }]), true);
  assert.equal(promptMentionsJson([{ role: "user", content: "plain chat" }]), false);
});

test("does not add response_format when JSON mode is disabled", () => {
  const body = applyJsonMode({ body: { model: "deepseek-flash" }, messages: [{ role: "user", content: "hello" }], jsonMode: false });
  assert.equal(body.response_format, undefined);
});

test("adds response_format only when prompt includes json", () => {
  const body = applyJsonMode({ body: { model: "deepseek-v4-pro" }, messages: [{ role: "user", content: "Return a json object with key answer." }], jsonMode: true });
  assert.deepEqual(body.response_format, { type: "json_object" });
});

test("throws a clear error when JSON mode prompt lacks json", () => {
  assert.throws(() => applyJsonMode({ body: { model: "deepseek-v4-pro" }, messages: [{ role: "user", content: "Return an object." }], jsonMode: true }), /JSON mode requires/);
});

test("does not add response_format when only assistant mentions json", () => {
  assert.throws(() => applyJsonMode({
    body: { model: "deepseek-v4-pro" },
    messages: [{ role: "assistant", content: "I will return a json object now." }],
    jsonMode: true
  }), /JSON mode requires/);
});

test("parseJsonContent parses object and annotates invalid JSON errors", () => {
  assert.deepEqual(parseJsonContent("{\"answer\":42}"), { answer: 42 });
  assert.throws(() => parseJsonContent("{bad"), /invalid DeepSeek JSON content/);
});
