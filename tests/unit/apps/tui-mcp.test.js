// tests/unit/apps/tui-mcp.test.js — TUI 侧 MCP(输入/CLI 输入)领域测试
//
// v1.19.1 测试归并:本文件由下列历史任务单测试合并而成,每个来源包裹在独立
// describe 块中(异步回调 + 动态 import,来源间零共享绑定),测试语义与拆分前一致。
import { describe } from "node:test";

// ---------------------------------------------------------------------------
// 来源:tests/unit/tui/tui-mcp.test.js
// ---------------------------------------------------------------------------
describe("unit/tui/tui-mcp", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createTuiApp } = await import("../../../src/apps/tui/tui-app.js");
  const { parseMcpArgs } = await import("../../../src/apps/tui/mcp-actions.js");
  const { eventToLines } = await import("../../../src/apps/tui/event-cards.js");
  const { makeT } = await import("../../../src/apps/tui/tui-i18n.js");
  const { makeIO, makeFakeKernel, until, tmpRoot } = await import("./helpers.js");

  async function boot(mcp = {}, overrides = {}) {
    const io = makeIO();
    let sends = 0, interrupts = 0;
    const kernel = makeFakeKernel({ onSend: async () => { sends++; return { status: "complete", content: "model reply" }; }, onInterrupt: () => interrupts++ });
    kernel.config = { apiKey: "test-configured-secret" };
    kernel.mcp = { hub: { oauthSecrets: new Set(["rotated-oauth-secret"]) }, ...mcp };
    const app = createTuiApp({ root: await tmpRoot(), kernel, input: io.input, output: io.output, ...overrides });
    const done = app.run();
    await until(() => io.text().includes("❯"));
    const stop = async () => { io.input.write("\x03"); io.input.write("\x03"); await done; };
    return { io, kernel, done, stop, sends: () => sends, interrupts: () => interrupts };
  }

  test("MCP slash parsing validates verbs, arity, ids and log bounds", () => {
    assert.deepEqual(parseMcpArgs(""), { action: "list" });
    assert.deepEqual(parseMcpArgs("logs"), { action: "logs", serverId: null, limit: 50 });
    assert.deepEqual(parseMcpArgs("logs removed-server 500"), { action: "logs", serverId: "removed-server", limit: 500 });
    for (const arg of ["list extra", "restart", "restart srv extra", "disable", "enable srv extra", "delete srv", "logs srv 501", "logs srv 0", "logs srv 1.5", "logs srv 1e2", "logs srv 3 extra", "restart x/y"]) assert.equal(parseMcpArgs(arg).action, "invalid", arg);
  });

  test("/mcp lists all server states without invoking a model or connecting", async () => {
    let lists = 0;
    const f = await boot({ listServers: async () => { lists++; return [
      { serverId: "local", status: "CONNECTED", type: "stdio", protocolMode: "modern", toolCount: 3 },
      { serverId: "remote", status: "AUTH_REQUIRED", type: "streamable-http", toolCount: 0 },
      { serverId: "disabled", status: "DISABLED", toolCount: 0 },
      { serverId: "degraded", status: "DEGRADED", toolCount: 0 }
    ]; } });
    try {
      f.io.input.write("/mcp\r");
      await until(() => f.io.text().includes("AUTH_REQUIRED"));
      assert.match(f.io.text(), /CONNECTED.*stdio.*modern.*3/);
      assert.match(f.io.text(), /DISABLED/);
      assert.match(f.io.text(), /DEGRADED/);
      assert.equal(lists, 1);
      assert.equal(f.sends(), 0);
    } finally { await f.stop(); }
  });

  test("/mcp restarts and toggles through facade; histories accept removed servers", async () => {
    const calls = [];
    const f = await boot({
      restartServer: async (id) => { calls.push(["restart", id]); return { status: "CONNECTED" }; },
      toggleServer: async (id, enabled) => { calls.push(["toggle", id, enabled]); return { status: enabled ? "CONNECTED" : "DISABLED" }; },
      getLogs: async (id, options) => { calls.push(["logs", id, options]); return { entries: [{ serverId: id, message: "historical test-configured-secret rotated-oauth-secret" }], total: 8, truncated: true }; }
    });
    try {
      for (const [command, count] of [["restart srv", 1], ["disable srv", 2], ["enable srv", 3], ["logs removed 10", 4]]) {
        f.io.input.write(`/mcp ${command}\r`);
        await until(() => calls.length === count);
        await new Promise((resolve) => setImmediate(resolve));
      }
      await until(() => f.io.text().includes("historical"));
      assert.deepEqual(calls, [["restart", "srv"], ["toggle", "srv", false], ["toggle", "srv", true], ["logs", "removed", { limit: 10 }]]);
      assert.match(f.io.text(), /1 \/ 8.*已截断/);
      assert.doesNotMatch(f.io.text(), /test-configured-secret|rotated-oauth-secret/);
      assert.equal(f.sends(), 0);
    } finally { await f.stop(); }
  });

  test("/mcp errors, empty results and unavailable interfaces remain local and recover", async () => {
    const f = await boot({ listServers: async () => [], getLogs: async () => ({ entries: [] }), restartServer: async () => { throw new Error("test-configured-secret rotated-oauth-secret"); } });
    try {
      for (const [command, message] of [["list", "未配置 MCP 服务"], ["logs", "没有匹配的 MCP 历史日志"], ["restart srv", "REDACTED"], ["enable srv", "MCP 接口不可用"], ["restart", "用法:/mcp"]]) {
        f.io.input.write(`/mcp ${command}\r`);
        await until(() => f.io.text().includes(message));
      }
      assert.doesNotMatch(f.io.text(), /test-configured-secret|rotated-oauth-secret/);
      assert.equal(f.sends(), 0);
    } finally { await f.stop(); }
  });

  test("MCP busy state prevents concurrent model sends and Esc does not claim cancellation", async () => {
    let finish;
    const f = await boot({ restartServer: async () => {
      await new Promise((resolve) => { finish = resolve; });
      return { status: "CONNECTED" };
    } });
    try {
      f.io.input.write("/mcp restart srv\r");
      await until(() => finish);
      f.io.input.write("not sent\r");
      assert.equal(f.sends(), 0);
      f.io.input.write("\x1b");
      await until(() => f.io.text().includes("MCP 管理操作正在完成"));
      assert.equal(f.interrupts(), 0);
      finish();
      await until(() => f.io.text().includes("srv: CONNECTED"));
      f.io.input.write("\r");
      await until(() => f.sends() === 1);
    } finally { await f.stop(); }
  });

  test("MCP session events display safe states and errors without terminal controls", async () => {
    const f = await boot();
    try {
      f.kernel.emit({ type: "mcp:server_error", serverId: "remote", error: { message: "failed test-configured-secret rotated-oauth-secret\x1b]0;owned\x07" } });
      await until(() => f.io.text().includes("failed"));
      assert.match(f.io.text(), /remote.*REDACTED/);
      assert.doesNotMatch(f.io.text(), /test-configured-secret|rotated-oauth-secret|\x1b\]0;owned|\x07/);
      const lines = eventToLines({ type: "mcp:auth_required", serverId: "remote", status: "AUTH_REQUIRED" }, makeT("en"));
      assert.match(lines.join("\n"), /remote.*AUTH_REQUIRED/);
      assert.deepEqual(eventToLines({ type: "mcp:server_status", serverId: "remote", status: "CONNECTED" }, makeT("en")), []);
    } finally { await f.stop(); }
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/tui/tui-mcp-input.test.js
// ---------------------------------------------------------------------------
describe("unit/tui/tui-mcp-input", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createTuiApp } = await import("../../../src/apps/tui/tui-app.js");
  const { makeIO, makeFakeKernel, until, tmpRoot } = await import("./helpers.js");

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
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/apps/cli/mcp-input.test.js
// ---------------------------------------------------------------------------
describe("unit/apps/cli/mcp-input", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { PassThrough } = await import("node:stream");
  const { runKernelAgentCommand, runKernelChatCommand } = await import("../../../src/apps/cli/kernel-runner.js");
  const { createCliMcpInputPrompt } = await import("../../../src/apps/cli/mcp-input.js");
  const { createMcpInputResponder, inputFields, parseInputField } = await import("../../../src/apps/mcp-input-form.js");

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
});
