import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { runKernelAgentCommand, runKernelChatCommand } from "../../../../src/apps/cli/kernel-runner.js";
import { createCliMcpInputPrompt } from "../../../../src/apps/cli/mcp-input.js";
import { createMcpInputResponder, inputFields, parseInputField } from "../../../../src/apps/mcp-input-form.js";

function pendingKernel(requests) {
  const listeners = new Set();
  const answers = [];
  const pending = [];
  let finish;
  const emit = (event) => { for (const listener of listeners) listener(event); };
  const kernel = {
    config: { apiKey: "known-private-token" },
    session: { subscribe: (fn) => { listeners.add(fn); return { unsubscribe: () => listeners.delete(fn) }; } },
    agent: {
      send: () => new Promise((resolve) => {
        finish = resolve;
        for (const request of requests) {
          pending.push(request);
          emit({ type: "mcp:input_required", serverId: request.serverId, requestId: request.requestId, status: "pending", method: request.method });
        }
      })
    },
    mcp: {
      listInputRequests: async () => [...pending],
      respondInputRequest: async (id, response) => {
        answers.push({ id, response });
        pending.splice(pending.findIndex((item) => item.requestId === id), 1);
        emit({ type: "mcp:input_resolved", requestId: id, serverId: "remote", status: response.action, method: "elicitation/create" });
        if (!pending.length) finish?.({ status: "complete", content: "Resumed" });
        return { status: response.action };
      }
    }
  };
  return { kernel, answers, pending, emit };
}

const request = (id = "input_1") => ({ requestId: id, serverId: "remote", method: "elicitation/create", message: "Please choose", requestedSchema: { type: "object", properties: { color: { type: "string", enum: ["blue", "green"] } }, required: ["color"] }, expiresAt: Date.now() + 5000 });

test("CLI input services a waiting send in process and does not echo its response", async () => {
  const fixture = pendingKernel([request()]);
  const lines = [];
  let prompts = 0;
  const result = await runKernelAgentCommand({ root: "/repo", prompt: "Call MCP", createKernelImpl: async () => fixture.kernel,
    write: (line) => lines.push(line), promptMcpInput: async () => { prompts++; return { action: "accept", content: { color: "user-private-answer" } }; } });
  assert.equal(result.content, "Resumed");
  assert.equal(prompts, 1);
  assert.deepEqual(fixture.answers, [{ id: "input_1", response: { action: "accept", content: { color: "user-private-answer" } } }]);
  assert.doesNotMatch(lines.join("\n"), /user-private-answer/);
});

test("CLI noninteractive input declines promptly while chat send is pending", async () => {
  const fixture = pendingKernel([request()]);
  const lines = [];
  const prompt = createCliMcpInputPrompt({ kernel: fixture.kernel, input: { isTTY: false }, write: (line) => lines.push(line) });
  const result = await runKernelChatCommand({ root: "/repo", prompt: "Call MCP", createKernelImpl: async () => fixture.kernel,
    write: (line) => lines.push(line), promptMcpInput: prompt });
  assert.equal(result.status, "complete");
  assert.equal(fixture.answers[0].response.action, "decline");
  assert.match(lines.join("\n"), /interactive terminal is required/);
});

test("CLI form validates fields, hides answers, and requires separate confirmation", async () => {
  const lines = [];
  const questions = [];
  const responses = ["purple", "blue", "y"];
  const fixture = pendingKernel([]);
  const prompt = createCliMcpInputPrompt({ kernel: fixture.kernel, write: (line) => lines.push(line),
    question: async (label) => { questions.push(label); return responses.shift(); } });
  const value = await prompt({ ...request(), message: "Continue known-private-token\x1b]0;injected\x07" });
  assert.equal(value.action, "accept");
  assert.equal(value.content.color, "blue");
  assert.match(questions.at(-1), /Send 1 field\(s\).*y\/N/);
  assert.match(lines.join("\n"), /Choose a listed value/);
  assert.doesNotMatch(lines.join("\n"), /purple|known-private-token|\x1b|\x07/);
  const decline = createCliMcpInputPrompt({ question: async () => "", write: () => {} });
  assert.deepEqual(await decline({ ...request(), requestedSchema: { type: "object", properties: {} } }), { action: "decline" });
});

test("MCP form parser preserves JSON types, optional omission and enum arrays", () => {
  const fields = inputFields({ requestedSchema: { type: "object", properties: {
    enabled: { type: "boolean" }, count: { type: "integer", minimum: 1, maximum: 3 },
    tags: { type: "array", items: { anyOf: [{ const: "a" }, { const: "b" }] }, maxItems: 2 },
    text: { type: "string" }
  }, required: ["text"] } });
  assert.deepEqual(parseInputField(fields[0], "false"), { value: false });
  assert.deepEqual(parseInputField(fields[1], "2"), { value: 2 });
  assert.throws(() => parseInputField(fields[1], "4"), /permitted range/);
  assert.deepEqual(parseInputField(fields[2], '["a","b"]'), { value: ["a", "b"] });
  assert.throws(() => parseInputField(fields[2], '["c"]'), /listed values/);
  assert.deepEqual(parseInputField(fields[0], ""), { omitted: true });
  assert.deepEqual(parseInputField(fields[3], ""), { value: "" });
});

test("CLI readline hides raw terminal input and releases raw mode after acceptance and Esc", async () => {
  const input = new PassThrough();
  input.isTTY = true;
  const modes = [];
  input.setRawMode = (enabled) => modes.push(enabled);
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => { text += String(chunk); });
  const prompt = createCliMcpInputPrompt({ input, output, write: () => {} });
  const descriptor = { ...request(), requestedSchema: { type: "object", properties: { text: { type: "string" } } } };
  const first = prompt(descriptor);
  input.write("hidden-terminal-value\r");
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(text, /Send 1 field/);
  input.write("y\r");
  assert.equal((await first).content.text, "hidden-terminal-value");
  assert.doesNotMatch(text, /hidden-terminal-value/);
  const second = prompt(descriptor);
  input.write("\x1b");
  assert.equal((await second).action, "cancel");
  assert.equal(modes.at(-1), false);
  assert.equal(input.listenerCount("keypress"), 0);
  input.destroy();
  output.destroy();
});

test("Responder serializes multiple requests and aborts an expired form", async () => {
  const first = request("input_1"), second = request("input_2");
  const fixture = pendingKernel([first, second]);
  const prompts = [];
  let release;
  let firstSignal;
  const responder = createMcpInputResponder({ kernel: fixture.kernel, prompt: async (entry, { signal }) => {
    prompts.push(entry.requestId);
    if (entry.requestId === "input_1") {
      firstSignal = signal;
      await new Promise((resolve) => { release = resolve; signal.addEventListener("abort", resolve, { once: true }); });
    }
    return { action: "decline" };
  } });
  const sub = fixture.kernel.session.subscribe((event) => responder.handle(event));
  const completion = fixture.kernel.agent.send();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(prompts, ["input_1"]);
  await fixture.kernel.mcp.respondInputRequest("input_1", { action: "cancel" });
  await completion;
  assert.equal(firstSignal.aborted, true);
  assert.deepEqual(prompts, ["input_1", "input_2"]);
  assert.equal(fixture.answers.length, 2);
  release();
  sub.unsubscribe();
  await responder.close();
});

test("Responder retries safe backend validation errors without logging field contents", async () => {
  const fixture = pendingKernel([request()]);
  const original = fixture.kernel.mcp.respondInputRequest;
  const lines = [];
  let attempts = 0;
  fixture.kernel.mcp.respondInputRequest = async (id, response) => {
    if (++attempts === 1) throw Object.assign(new Error("private-backend-detail"), { code: "MCP_INPUT_INVALID" });
    return original(id, response);
  };
  const result = await runKernelAgentCommand({ root: "/repo", prompt: "Call MCP", createKernelImpl: async () => fixture.kernel,
    write: (line) => lines.push(line), promptMcpInput: async () => ({ action: "accept", content: { color: "blue" } }) });
  assert.equal(result.status, "complete");
  assert.equal(attempts, 2);
  assert.match(lines.join("\n"), /please enter it again/);
  assert.doesNotMatch(lines.join("\n"), /private-backend-detail/);
});
