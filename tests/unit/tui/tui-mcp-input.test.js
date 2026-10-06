import test from "node:test";
import assert from "node:assert/strict";
import { createTuiApp } from "../../../src/apps/tui/tui-app.js";
import { makeIO, makeFakeKernel, until, tmpRoot } from "./helpers.js";

async function boot({ properties = { answer: { type: "string", minLength: 1 } } } = {}) {
  const io = makeIO();
  const calls = [];
  const answers = [];
  let finish;
  let pending = [];
  const kernel = makeFakeKernel({ onSend: ({ text, options, emit }) => {
    calls.push({ text, options });
    if (text === "again") return Promise.resolve({ status: "complete", content: "done" });
    return new Promise((resolve) => {
      finish = resolve;
      pending = [{ requestId: "input_1", serverId: "remote", method: "elicitation/create", message: "Please provide input", requestedSchema: { type: "object", properties, required: Object.keys(properties) }, expiresAt: Date.now() + 10000 }];
      emit({ type: "mcp:input_required", requestId: "input_1", serverId: "remote", method: "elicitation/create", status: "pending" });
    });
  } });
  kernel.mcp = {
    listInputRequests: async () => pending,
    respondInputRequest: async (id, response) => {
      answers.push({ id, response });
      pending = [];
      kernel.emit({ type: "mcp:input_resolved", requestId: id, serverId: "remote", method: "elicitation/create", status: response.action });
      finish?.({ status: "complete", content: "Resumed" });
      return { status: response.action };
    }
  };
  const app = createTuiApp({ root: await tmpRoot(), kernel, input: io.input, output: io.output });
  const done = app.run();
  await until(() => io.text().includes("❯"));
  const stop = async () => { io.input.write("\x03"); io.input.write("\x03"); await done; };
  return { io, kernel, stop, calls, answers };
}

test("TUI services MCP form while model waits, masks values, and keeps them out of history", async () => {
  const f = await boot();
  try {
    f.io.input.write("call MCP\r");
    await until(() => f.io.text().includes("输入已隐藏"));
    f.io.input.write("private-response-123\r");
    await until(() => f.io.text().includes("发送 1 项"));
    assert.equal(f.answers.length, 0, "entering the final field does not approve submission");
    assert.doesNotMatch(f.io.text(), /private-response-123/);
    f.io.input.write("y");
    await until(() => f.io.text().includes("Resumed"));
    assert.equal(f.answers[0].response.content.answer, "private-response-123");
    f.io.input.write("again\r");
    await until(() => f.calls.length === 2);
    assert.doesNotMatch(JSON.stringify(f.calls), /private-response-123/);
    assert.equal(f.calls[1].options.history[0].content, "call MCP");
    assert.doesNotMatch(f.io.text(), /private-response-123/);
  } finally { await f.stop(); }
});

test("TUI Esc cancels a pending MCP form and drops its private draft", async () => {
  const f = await boot();
  try {
    f.io.input.write("call MCP\r");
    await until(() => f.io.text().includes("输入已隐藏"));
    f.io.input.write("draft-never-sent");
    f.io.input.write("\x1b");
    await until(() => f.answers.length === 1);
    assert.deepEqual(f.answers[0], { id: "input_1", response: { action: "cancel" } });
    assert.doesNotMatch(f.io.text(), /draft-never-sent/);
  } finally { await f.stop(); }
});

test("TUI empty continuation form requires explicit confirmation and supports decline", async () => {
  const f = await boot({ properties: {} });
  try {
    f.io.input.write("call MCP\r");
    await until(() => f.io.text().includes("发送 0 项"));
    f.io.input.write("\r");
    assert.equal(f.answers.length, 0);
    f.io.input.write("n");
    await until(() => f.answers.length === 1);
    assert.deepEqual(f.answers[0].response, { action: "decline" });
  } finally { await f.stop(); }
});

test("TUI exit cancels active input even when the supplied kernel is not owned", async () => {
  const f = await boot();
  f.io.input.write("call MCP\r");
  await until(() => f.io.text().includes("输入已隐藏"));
  await f.stop();
  assert.equal(f.answers[0].response.action, "cancel");
});
