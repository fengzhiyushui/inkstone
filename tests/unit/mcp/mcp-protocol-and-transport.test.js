// tests/unit/mcp/mcp-protocol-and-transport.test.js — MCP 协议与传输(JSON-RPC/stdio/HTTP/取消)领域测试
//
// v1.19.1 测试归并:本文件由下列历史任务单测试合并而成,每个来源包裹在独立
// describe 块中(异步回调 + 动态 import,来源间零共享绑定),测试语义与拆分前一致。
import { describe } from "node:test";

// ---------------------------------------------------------------------------
// 来源:tests/unit/mcp-jsonrpc.test.js
// ---------------------------------------------------------------------------
describe("unit/mcp-jsonrpc", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { EventEmitter } = await import("node:events");
  const { JsonRpcClient, JSONRPC_ERRORS } = await import("../../../src/tools/mcp/jsonrpc-client.js");

  class MockTransport extends EventEmitter {
    constructor() {
      super();
      this.sent = [];
    }

    send(msg) {
      this.sent.push(msg);
    }
  }

  test("JsonRpcClient handles request and response successfully", async () => {
    const transport = new MockTransport();
    const client = new JsonRpcClient({ transport });

    const promise = client.request("testMethod", { foo: "bar" });
    assert.equal(transport.sent.length, 1);
    const sent = transport.sent[0];
    assert.equal(sent.jsonrpc, "2.0");
    assert.equal(sent.method, "testMethod");
    assert.deepEqual(sent.params, { foo: "bar" });
    assert.ok(sent.id > 0);

    // Simulate server response
    transport.emit("message", {
      jsonrpc: "2.0",
      id: sent.id,
      result: { answer: 42 }
    });

    const result = await promise;
    assert.deepEqual(result, { answer: 42 });
    assert.equal(client.getPendingCount(), 0);
  });

  test("JsonRpcClient rejects when server returns an error response", async () => {
    const transport = new MockTransport();
    const client = new JsonRpcClient({ transport });

    const promise = client.request("failMethod", {});
    const sent = transport.sent[0];

    transport.emit("message", {
      jsonrpc: "2.0",
      id: sent.id,
      error: {
        code: JSONRPC_ERRORS.METHOD_NOT_FOUND,
        message: "Method not found",
        data: { hint: "check method name" }
      }
    });

    await assert.rejects(
      async () => await promise,
      (err) => {
        assert.equal(err.code, JSONRPC_ERRORS.METHOD_NOT_FOUND);
        assert.equal(err.message, "Method not found");
        assert.deepEqual(err.data, { hint: "check method name" });
        return true;
      }
    );
    assert.equal(client.getPendingCount(), 0);
  });

  test("JsonRpcClient times out when no response is received", async () => {
    const transport = new MockTransport();
    const client = new JsonRpcClient({ transport, defaultTimeoutMs: 50 });

    await assert.rejects(
      async () => await client.request("hangingMethod", {}, { timeoutMs: 30 }),
      (err) => {
        assert.equal(err.code, JSONRPC_ERRORS.TIMEOUT);
        assert.match(err.message, /timed out after 30ms/);
        return true;
      }
    );
    assert.equal(client.getPendingCount(), 0);
  });

  test("JsonRpcClient sends and receives notifications", async () => {
    const transport = new MockTransport();
    const client = new JsonRpcClient({ transport });

    // Outgoing notification
    client.notify("status/update", { ready: true });
    assert.equal(transport.sent.length, 1);
    const sent = transport.sent[0];
    assert.equal(sent.jsonrpc, "2.0");
    assert.equal(sent.method, "status/update");
    assert.equal(sent.id, undefined);
    assert.deepEqual(sent.params, { ready: true });

    // Incoming notification
    let receivedNotification = null;
    client.on("notification:ping", (params) => {
      receivedNotification = params;
    });

    transport.emit("message", {
      jsonrpc: "2.0",
      method: "ping",
      params: { time: 12345 }
    });

    assert.deepEqual(receivedNotification, { time: 12345 });
  });

  test("JsonRpcClient aborts pending requests on transport close", async () => {
    const transport = new MockTransport();
    const client = new JsonRpcClient({ transport });

    const promise1 = client.request("req1", {});
    const promise2 = client.request("req2", {});
    assert.equal(client.getPendingCount(), 2);

    transport.emit("close", { code: 1, signal: null });

    await assert.rejects(
      async () => await promise1,
      (err) => {
        assert.equal(err.code, JSONRPC_ERRORS.SERVER_DISCONNECTED);
        return true;
      }
    );
    await assert.rejects(
      async () => await promise2,
      (err) => {
        assert.equal(err.code, JSONRPC_ERRORS.SERVER_DISCONNECTED);
        return true;
      }
    );
    assert.equal(client.getPendingCount(), 0);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/mcp-protocol-era.test.js
// ---------------------------------------------------------------------------
describe("unit/mcp-protocol-era", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { formatExternalToolName, parseExternalToolName, MAX_TOOL_NAME_LENGTH, formatToolResult, summarizeToolResult } = await import("../../../src/tools/mcp/schema-converter.js");

  test("formatExternalToolName stays within 128 chars and is unique on overflow", () => {
    const longName = "a".repeat(200);
    const n1 = formatExternalToolName("server", longName);
    const n2 = formatExternalToolName("server", longName + "b");
    const n3 = formatExternalToolName("server", longName);

    assert.ok(n1.length <= MAX_TOOL_NAME_LENGTH);
    assert.ok(n2.length <= MAX_TOOL_NAME_LENGTH);
    assert.notEqual(n1, n2);
    assert.equal(n1, n3); // stable
  });

  test("formatExternalToolName keeps short names as mcp__server__tool", () => {
    assert.equal(formatExternalToolName("fs", "read_file"), "mcp__fs__read_file");
    assert.deepEqual(
      parseExternalToolName("mcp__fs__read_file"),
      { serverId: "fs", originalName: "read_file" }
    );
  });

  test("formatToolResult handles structuredContent and input_required", () => {
    const structured = formatToolResult({
      resultType: "complete",
      content: [{ type: "text", text: "" }],
      structuredContent: { ok: true },
      isError: false
    });
    assert.match(structured, /"ok":true/);

    const inputRequired = formatToolResult({
      resultType: "input_required",
      content: [{ type: "text", text: "need name" }]
    });
    assert.match(inputRequired, /Input Required/);
  });

  test("summarizeToolResult exposes meta", () => {
    const { text, meta } = summarizeToolResult({
      resultType: "complete",
      content: [{ type: "text", text: "hi" }],
      structuredContent: { x: 1 },
      isError: false
    });
    assert.equal(text, "hi");
    assert.equal(meta.resultType, "complete");
    assert.deepEqual(meta.structuredContent, { x: 1 });
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/mcp-v117-protocol.test.js
// ---------------------------------------------------------------------------
describe("unit/mcp-v117-protocol", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { default: http } = await import("node:http");
  const { EventEmitter, once } = await import("node:events");
  const { McpClient } = await import("../../../src/tools/mcp/mcp-client.js");
  const { META_KEYS, MCP_SERVER_ERRORS, isUnsupportedProtocolVersionError } = await import("../../../src/tools/mcp/protocol.js");
  const { SseParser } = await import("../../../src/tools/mcp/sse.js");

  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const input = (requestState = "opaque-state") => ({ resultType: "input_required", requestState, inputRequests: {
    choice: { method: "elicitation/create", params: { mode: "form", message: "Choose", requestedSchema: { type: "object", properties: { choice: { type: "string" } } } } }
  } });
  const answer = { inputResponses: { choice: { action: "accept", content: { choice: "yes" } } } };

  class Mock extends EventEmitter {
    constructor(onRequest = () => {}) { super(); this.sent = []; this.onRequest = onRequest; }
    send(frame, options) {
      this.sent.push({ ...frame, options });
      if (frame.method === "server/discover") queueMicrotask(() => this.reply(frame.id, {
        supportedVersions: ["2026-07-28"], capabilities: { tools: { listChanged: true }, resources: { listChanged: true }, prompts: { listChanged: true } }
      }));
      else this.onRequest(frame, this);
    }
    reply(id, result) { this.emit("message", { jsonrpc: "2.0", id, result }); }
    notify(method, id, params = {}) { this.emit("message", { jsonrpc: "2.0", method, params: { ...params, _meta: { [META_KEYS.SUBSCRIPTION_ID]: id } } }); }
    close() {}
  }
  async function connected(options = {}, handler) {
    const transport = new Mock(handler);
    const client = new McpClient({ serverId: "mock", transport, ...options });
    await client.connect();
    return { client, transport };
  }

  test("MCP default capabilities are empty; no implicit MRTR or subscriptions", async () => {
    let handled = 0;
    const { client, transport } = await connected({ inputHandler: () => { handled++; } }, (frame, mock) => mock.reply(frame.id, input()));
    assert.deepEqual(client.clientCapabilities, {});
    assert.equal((await client.callTool("read" )).resultType, "input_required");
    assert.equal(handled, 0);
    assert.equal(transport.sent.some((frame) => frame.method === "subscriptions/listen"), false);
    await client.disconnect();
  });

  test("legacy initialization never advertises Modern-only elicitation and never subscribes", async () => {
    const transport = new Mock((frame, mock) => {
      if (frame.method === "initialize") mock.reply(frame.id, { protocolVersion: "2025-11-25", capabilities: { tools: { listChanged: true } } });
    });
    const client = new McpClient({ serverId: "legacy", transport, protocolMode: "legacy", elicitation: { enabled: true }, subscriptions: { enabled: true }, inputHandler: () => answer });
    await client.connect();
    assert.deepEqual(transport.sent.find((frame) => frame.method === "initialize").params.capabilities, {});
    assert.equal(transport.sent.some((frame) => frame.method === "subscriptions/listen"), false);
    await client.disconnect();
  });

  test("disabled input_required never exposes accompanying state, schemas or payloads to tools or content readers", async () => {
    const payload = { ...input("hidden-state"), structuredContent: { private: "hidden-structured" }, content: [{ type: "text", text: "hidden-content" }], contents: [{ uri: "file:///a", text: "hidden-resource" }], messages: [{ role: "user", content: { type: "text", text: "hidden-prompt" } }] };
    const { client } = await connected({}, (frame, mock) => mock.reply(frame.id, payload));
    assert.deepEqual(await client.callTool("read"), { resultType: "input_required" });
    for (const request of [() => client.readResource("file:///a"), () => client.getPrompt("a")]) {
      await assert.rejects(request(), (error) => error.code === "MCP_INPUT_REQUIRED" && !JSON.stringify(error).includes("hidden"));
    }
    await client.disconnect();
  });

  test("callers cannot inject continuation fields and completed results omit private MRTR fields", async () => {
    let handled = 0;
    const { client, transport } = await connected({ elicitation: { enabled: true }, inputHandler: () => { handled++; return answer; } }, (frame, mock) => {
      if (!frame.params.inputResponses) mock.reply(frame.id, input("authorized-state"));
      else mock.reply(frame.id, { resultType: "complete", content: [], requestState: "private-state", inputRequests: input().inputRequests, inputResponses: answer.inputResponses });
    });
    const result = await client._request("tools/call", { name: "read", arguments: {}, requestState: "forged", inputResponses: { choice: { action: "accept" } } });
    assert.deepEqual(result, { resultType: "complete", content: [] });
    const first = transport.sent.find((frame) => frame.method === "tools/call");
    assert.equal(Object.hasOwn(first.params, "requestState"), false);
    assert.equal(Object.hasOwn(first.params, "inputResponses"), false);
    assert.equal(handled, 1);
    await client.disconnect();
  });

  test("MRTR snapshots original params, retries with new IDs and latest opaque state only", async () => {
    const calls = [];
    const seen = [];
    let args = { nested: { value: "original" } };
    const { client } = await connected({ elicitation: { enabled: true }, inputHandler: (request) => {
      seen.push(request.round);
      args.nested.value = "changed";
      request.params.arguments.nested.value = "handler-changed";
      request.result.requestState = "do-not-trust-handler-state";
      return { ...answer, requestState: "also-ignored" };
    } }, (frame, mock) => {
      if (frame.method !== "tools/call") return;
      calls.push(frame);
      if (calls.length === 1) mock.reply(frame.id, input("untouched-state"));
      else if (calls.length === 2) { const next = input(); delete next.requestState; mock.reply(frame.id, next); }
      else mock.reply(frame.id, { content: [] });
    });
    await client.callTool("read", args);
    assert.deepEqual(client.clientCapabilities, { elicitation: { form: {} } });
    assert.deepEqual(seen, [1, 2]);
    assert.equal(new Set(calls.map((frame) => frame.id)).size, 3);
    assert.equal(calls[1].params.arguments.nested.value, "original");
    assert.equal(calls[1].params.requestState, "untouched-state");
    assert.equal(Object.hasOwn(calls[2].params, "requestState"), false);
    assert.deepEqual(calls[2].params.inputResponses, answer.inputResponses);
    await client.disconnect();
  });

  test("MRTR bounds repeated input to four confirmations and rejects non-MRTR methods", async () => {
    let rounds = 0;
    const { client } = await connected({ elicitation: { enabled: true }, inputHandler: () => { rounds++; return answer; } }, (frame, mock) => mock.reply(frame.id, input()));
    await assert.rejects(client.callTool("read"), { code: "MCP_MRTR_LIMIT" });
    assert.equal(rounds, 4);
    await assert.rejects(client.listTools(), { code: "MCP_MRTR_METHOD" });
    assert.equal(rounds, 4);
    await client.disconnect();
  });

  for (const mode of ["abort", "disconnect"]) test(`MRTR ${mode} ends pending input and cannot retry a late answer`, async () => {
    let release;
    let started;
    const ready = new Promise((resolve) => { started = resolve; });
    const { client, transport } = await connected({ elicitation: { enabled: true }, inputHandler: () => {
      started(); return new Promise((resolve) => { release = resolve; });
    } }, (frame, mock) => mock.reply(frame.id, input()));
    const controller = new AbortController();
    const call = client.callTool("read", {}, { signal: controller.signal });
    const rejected = assert.rejects(call);
    await ready;
    if (mode === "abort") controller.abort(); else await client.disconnect();
    await rejected;
    release(answer);
    await tick();
    assert.equal(transport.sent.filter((frame) => frame.method === "tools/call").length, 1);
    await client.disconnect();
  });

  test("MRTR confirmations are request-local when responses complete out of order", async () => {
    const releases = new Map();
    const { client, transport } = await connected({ elicitation: { enabled: true }, inputHandler: ({ params }) => new Promise((resolve) => releases.set(params.name, resolve)) }, (frame, mock) => {
      if (!frame.params.inputResponses) mock.reply(frame.id, input(frame.params.name));
      else mock.reply(frame.id, { content: [{ type: "text", text: frame.params.requestState }] });
    });
    const a = client.callTool("a"), b = client.callTool("b");
    await tick();
    releases.get("b")(answer); releases.get("a")(answer);
    assert.equal((await a).content[0].text, "a");
    assert.equal((await b).content[0].text, "b");
    const calls = transport.sent.filter((frame) => frame.method === "tools/call");
    assert.equal(new Set(calls.map((frame) => frame.id)).size, 4);
    await client.disconnect();
  });

  for (const kind of ["resource", "prompt"]) test(`Modern ${kind} MRTR preserves arguments and caches only final complete content`, async () => {
    const calls = [];
    let confirmations = 0;
    const method = kind === "resource" ? "resources/read" : "prompts/get";
    const field = kind === "resource" ? "contents" : "messages";
    const content = kind === "resource" ? [{ uri: "file:///selected", text: "done" }] : [{ role: "user", content: { type: "text", text: "done" } }];
    const { client } = await connected({ elicitation: { enabled: true }, inputHandler: ({ method: requestedMethod, params }) => {
      confirmations++;
      assert.equal(requestedMethod, method);
      if (kind === "resource") assert.equal(params.uri, "file:///selected");
      else assert.deepEqual(params, { name: "selected", arguments: { language: "zh" } });
      return answer;
    } }, (frame, mock) => {
      calls.push(frame);
      if (!frame.params.inputResponses) mock.reply(frame.id, input(`${kind}-state`));
      else mock.reply(frame.id, { resultType: "complete", [field]: content, ttlMs: 60000 });
    });
    const read = () => kind === "resource" ? client.readResource("file:///selected") : client.getPrompt("selected", { language: "zh" });
    assert.deepEqual((await read())[field], content);
    assert.deepEqual((await read())[field], content);
    assert.equal(confirmations, 1);
    assert.equal(calls.length, 2);
    assert.notEqual(calls[0].id, calls[1].id);
    assert.equal(calls[1].params.requestState, `${kind}-state`);
    assert.deepEqual(calls[1].params.inputResponses, answer.inputResponses);
    await client.disconnect();
  });

  test("subscription listens with a supported filter, validates ack and only routes matching notifications", async () => {
    const { client, transport } = await connected({ subscriptions: { enabled: true } });
    const frame = transport.sent.find((entry) => entry.method === "subscriptions/listen");
    assert.deepEqual(frame.params.notifications, { toolsListChanged: true, promptsListChanged: true, resourcesListChanged: true });
    assert.equal(frame.options.timeoutMs, Infinity);
    assert.equal(frame.options.retries, 0);
    const changed = [];
    client.on("list_changed", (event) => changed.push(event.method));
    transport.notify("notifications/subscriptions/acknowledged", frame.id, { notifications: { toolsListChanged: true } });
    transport.notify("notifications/tools/list_changed", frame.id + 999);
    transport.notify("notifications/prompts/list_changed", frame.id);
    transport.emit("message", { method: "notifications/tools/list_changed" });
    transport.notify("notifications/tools/list_changed", frame.id);
    assert.deepEqual(changed, ["notifications/tools/list_changed"]);
    assert.equal(client.subscriptions.current.status, "active");
    await client.disconnect();
    assert.equal(client.rpc.getPendingCount(), 0);
    assert.equal(transport.sent.filter((entry) => entry.method === "notifications/cancelled" && entry.params.requestId === frame.id).length, 1);
  });

  for (const invalid of ["before_ack", "extra_filter"]) test(`subscription rejects ${invalid} without reconnecting or harming client`, async () => {
    const { client, transport } = await connected({ subscriptions: { enabled: true } });
    const frame = transport.sent.find((entry) => entry.method === "subscriptions/listen");
    const states = [];
    client.on("subscription_status", (event) => states.push(event.status));
    if (invalid === "before_ack") transport.notify("notifications/tools/list_changed", frame.id);
    else transport.notify("notifications/subscriptions/acknowledged", frame.id, { notifications: { resourceSubscriptions: ["file:///private"] } });
    await tick();
    assert.equal(client.status, "CONNECTED");
    assert.deepEqual(states, ["error"]);
    assert.equal(client.rpc.getPendingCount(), 0);
    assert.equal(transport.sent.filter((entry) => entry.method === "subscriptions/listen").length, 1);
    await client.disconnect();
  });

  test("subscription ack timeout is bounded and graceful server closure does not restart", async () => {
    const { client, transport } = await connected({ subscriptions: { enabled: true, ackTimeoutMs: 10 } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(client.subscriptions.current, null);
    assert.equal(client.rpc.getPendingCount(), 0);
    client.subscriptions.start();
    const frame = transport.sent.filter((entry) => entry.method === "subscriptions/listen").at(-1);
    transport.notify("notifications/subscriptions/acknowledged", frame.id, { notifications: {} });
    transport.reply(frame.id, { resultType: "complete", _meta: { [META_KEYS.SUBSCRIPTION_ID]: frame.id } });
    await tick();
    assert.equal(client.subscriptions.current, null);
    assert.equal(transport.sent.filter((entry) => entry.method === "subscriptions/listen").length, 2);
    await client.disconnect();
  });

  test("stdio server cancellation terminates only its own subscription without echo cancellation", async () => {
    const { client, transport } = await connected({ subscriptions: { enabled: true } });
    const frame = transport.sent.find((entry) => entry.method === "subscriptions/listen");
    transport.emit("message", { method: "notifications/cancelled", params: { requestId: frame.id } });
    await tick();
    assert.equal(client.rpc.getPendingCount(), 0);
    assert.equal(transport.sent.filter((entry) => entry.method === "notifications/cancelled").length, 0);
    assert.equal(client.status, "CONNECTED");
    await client.disconnect();
  });

  test("protocol reserved errors match 2026-07-28 and implementation codes are not version errors", () => {
    assert.deepEqual(MCP_SERVER_ERRORS, { HEADER_MISMATCH: -32020, MISSING_REQUIRED_CLIENT_CAPABILITY: -32021, UNSUPPORTED_PROTOCOL_VERSION: -32022 });
    assert.equal(isUnsupportedProtocolVersionError({ code: -32004 }), false);
    assert.equal(isUnsupportedProtocolVersionError({ code: -32022 }), true);
  });

  test("real stdio re-establishes list subscriptions after reconnect and carries MRTR responses", async () => {
    const script = `const rl=require('node:readline').createInterface({input:process.stdin});
      const send=frame=>process.stdout.write(JSON.stringify(frame)+'\\n');
      rl.on('line',line=>{const m=JSON.parse(line);const reply=result=>send({jsonrpc:'2.0',id:m.id,result});
        if(m.method==='server/discover')reply({supportedVersions:['2026-07-28'],capabilities:{tools:{listChanged:true},prompts:{listChanged:true},resources:{listChanged:true}}});
        else if(m.method==='subscriptions/listen') {
          const params={_meta:{'io.modelcontextprotocol/subscriptionId':m.id}};
          send({jsonrpc:'2.0',method:'notifications/subscriptions/acknowledged',params:{...params,notifications:m.params.notifications}});
          for(const kind of ['tools','resources','prompts'])send({jsonrpc:'2.0',method:'notifications/'+kind+'/list_changed',params});
        } else if(m.method==='tools/call') {
          if(m.params.inputResponses)reply({content:[{type:'text',text:m.params.requestState+':'+m.params.inputResponses.choice.action}]});
          else reply(${JSON.stringify(input("stdio-state"))});
        }
      });`;
    const client = new McpClient({ serverId: "stdio", command: process.execPath, args: ["-e", script], protocolMode: "modern", subscriptions: { enabled: true }, elicitation: { enabled: true }, inputHandler: () => answer, discoverTimeoutMs: 5000 });
    const changed = [];
    client.on("list_changed", (event) => changed.push(event.method));
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const active = new Promise((resolve) => client.once("list_changed", resolve));
        await client.connect();
        await active;
        assert.equal((await client.callTool("read")).content[0].text, "stdio-state:accept");
        assert.equal(client.subscriptions.current.status, "active");
        await client.disconnect();
        assert.equal(client.rpc.getPendingCount(), 0);
      }
      for (const kind of ["tools", "resources", "prompts"]) assert.equal(changed.filter((method) => method === `notifications/${kind}/list_changed`).length, 2);
    } finally { await client.disconnect(); }
  });

  test("bounded SSE parser limits unfinished frames but permits indefinitely many small events", () => {
    let count = 0;
    const parser = new SseParser({ maxEventBytes: 64, onEvent: () => count++ });
    for (let i = 0; i < 1000; i++) parser.feed('data: {}\n\n');
    assert.equal(count, 1000);
    assert.throws(() => parser.feed('data: ' + 'x'.repeat(65)), { code: "MCP_SSE_EVENT_LIMIT" });
  });

  for (const ending of ["graceful", "drop", "cancel", "oversize"]) test(`real HTTP subscription ${ending} is isolated, bounded and never automatically retried`, async () => {
    const calls = [];
    let stream;
    let streamClosed = false;
    const server = http.createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const frame = JSON.parse(Buffer.concat(chunks));
      calls.push(frame);
      const reply = (result) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result })); };
      if (frame.method === "server/discover") reply({ supportedVersions: ["2026-07-28"], capabilities: { tools: { listChanged: true } } });
      else if (frame.method === "subscriptions/listen") {
        stream = response;
        response.on("close", () => { streamClosed = true; });
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ method: "notifications/subscriptions/acknowledged", params: { notifications: { toolsListChanged: true }, _meta: { [META_KEYS.SUBSCRIPTION_ID]: frame.id } } })}\n\n`);
      } else reply({ tools: [] });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const client = new McpClient({ serverId: "http", url: `http://127.0.0.1:${server.address().port}/mcp`, allowlist: ["127.0.0.1"], subscriptions: { enabled: true }, timeoutMs: 2000 });
    try {
      const active = new Promise((resolve) => client.on("subscription_status", (event) => { if (event.status === "active") resolve(); }));
      await client.connect();
      await active;
      const listen = calls.find((frame) => frame.method === "subscriptions/listen");
      const ended = new Promise((resolve) => client.on("subscription_status", (event) => { if (["closed", "cancelled", "error"].includes(event.status)) resolve(event.status); }));
      if (ending === "graceful") stream.write(`data: ${JSON.stringify({ id: listen.id, result: { resultType: "complete", _meta: { [META_KEYS.SUBSCRIPTION_ID]: listen.id } } })}\n\n`);
      else if (ending === "drop") stream.end();
      else if (ending === "oversize") stream.write('data: ' + 'x'.repeat(65537));
      else client.subscriptions.stop();
      const status = await ended;
      assert.equal(status, ending === "graceful" ? "closed" : ending === "cancel" ? "cancelled" : "error");
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(streamClosed, true);
      assert.equal(client.status, "CONNECTED");
      assert.deepEqual(await client.listTools(), []);
      assert.equal(calls.filter((frame) => frame.method === "subscriptions/listen").length, 1);
      assert.equal(calls.filter((frame) => frame.method === "notifications/cancelled").length, 0);
    } finally {
      await client.disconnect();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/mcp-stdio-transport.test.js
// ---------------------------------------------------------------------------
describe("unit/mcp-stdio-transport", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { default: process } = await import("node:process");
  const { StdioTransport } = await import("../../../src/tools/mcp/stdio-transport.js");

  test("StdioTransport filters sensitive environment variables while retaining system paths", () => {
    const origKey = process.env.DEEPSEEK_API_KEY;
    try {
      process.env.DEEPSEEK_API_KEY = "sk-super-secret-key-that-should-not-leak";
      const transport = new StdioTransport({
        command: "node",
        env: { CUSTOM_VAR: "allowed_value" }
      });

      const env = transport.getSafeEnvironment();
      assert.equal(env.DEEPSEEK_API_KEY, undefined, "Sensitive API key must not be passed");
      assert.equal(env.CUSTOM_VAR, "allowed_value", "Configured environment variable must be passed");
      assert.ok(env.PATH || env.Path, "System PATH must be preserved");
    } finally {
      if (origKey !== undefined) {
        process.env.DEEPSEEK_API_KEY = origKey;
      } else {
        delete process.env.DEEPSEEK_API_KEY;
      }
    }
  });

  test("StdioTransport communicates with a live child process over stdio line protocol", async () => {
    // A small Node.js echo worker that parses JSON from stdin and echoes back a response
    const workerScript = `
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin, terminal: false });
      rl.on('line', (line) => {
        try {
          const msg = JSON.parse(line);
          if (msg.method === 'ping') {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: 'pong' }) + '\\n');
          }
        } catch (e) {}
      });
    `;

    const transport = new StdioTransport({
      command: process.execPath,
      args: ["-e", workerScript]
    });

    const receivedMessages = [];
    transport.on("message", (msg) => {
      receivedMessages.push(msg);
    });

    transport.start();
    assert.equal(transport.state, "running");

    transport.send({ jsonrpc: "2.0", id: 1, method: "ping" });

    // Wait for response
    for (let i = 0; i < 50; i++) {
      if (receivedMessages.length > 0) break;
      await new Promise((r) => setTimeout(r, 20));
    }

    assert.equal(receivedMessages.length, 1);
    assert.deepEqual(receivedMessages[0], { jsonrpc: "2.0", id: 1, result: "pong" });

    await transport.close();
    assert.equal(transport.state, "stopped");
  });

  test("StdioTransport buffers stderr output for diagnostics", async () => {
    const workerScript = `
      console.error('stderr diagnostic line 1');
      console.error('stderr diagnostic line 2');
      setTimeout(() => process.exit(0), 50);
    `;

    const transport = new StdioTransport({
      command: process.execPath,
      args: ["-e", workerScript]
    });

    transport.start();

    await new Promise((resolve) => transport.on("close", resolve));

    const recentStderr = transport.getRecentStderr();
    assert.match(recentStderr, /stderr diagnostic line 1/);
    assert.match(recentStderr, /stderr diagnostic line 2/);

    await transport.close();
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/mcp-http-transport.test.js
// ---------------------------------------------------------------------------
describe("unit/mcp-http-transport", async () => {
  /**
   * v1.12.0 Streamable HTTP:用真实本地 HTTP server 起 mock,只把 SSRF 的
   * loopback 判定经 allowlist 放行 —— 其余安全路径(DNS 固定、逐跳校验)全走真实现。
   */

  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { default: http } = await import("node:http");
  const { once } = await import("node:events");
  const { HttpTransport, isStreamBreak } = await import("../../../src/tools/mcp/http-transport.js");
  const { SseParser, isEventStream } = await import("../../../src/tools/mcp/sse.js");

  const ALLOW_LOOPBACK = ["127.0.0.1"];

  async function startServer(handler) {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address();
    return {
      server,
      port,
      url: `http://127.0.0.1:${port}/mcp`,
      close: () => new Promise((resolve) => server.close(resolve))
    };
  }

  function jsonReply(res, payload, status = 200, extraHeaders = {}) {
    const body = JSON.stringify(payload);
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), ...extraHeaders });
    res.end(body);
  }

  function sseHead(res, extraHeaders = {}) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...extraHeaders });
  }

  /** 收集 transport 上收到的消息,直到 predicate 满足或超时。 */
  function collector(transport, { timeoutMs = 5000 } = {}) {
    const messages = [];
    const waiters = [];
    transport.on("message", (m) => {
      messages.push(m);
      for (const w of [...waiters]) w();
    });
    return {
      messages,
      until: (predicate) => new Promise((resolve, reject) => {
        if (predicate(messages)) { resolve(messages); return; }
        const timer = setTimeout(() => reject(new Error(`timeout waiting for message; got ${JSON.stringify(messages)}`)), timeoutMs);
        const check = () => {
          if (predicate(messages)) { clearTimeout(timer); resolve(messages); }
        };
        waiters.push(check);
      })
    };
  }

  test("POST JSON-RPC 携带标准头(Mcp-Method / Mcp-Name / MCP-Protocol-Version)", async () => {
    let seen = null;
    const srv = await startServer((req, res) => {
      seen = { method: req.method, headers: req.headers, body: "" };
      req.setEncoding("utf8");
      req.on("data", (c) => { seen.body += c; });
      req.on("end", () => jsonReply(res, { jsonrpc: "2.0", id: 1, result: { ok: true } }));
    });

    const transport = new HttpTransport({ url: srv.url, allowlist: ALLOW_LOOPBACK, protocolVersion: "2026-07-28" });
    transport.start();
    transport.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: {} } });
    await once(transport, "message");

    assert.equal(seen.method, "POST");
    assert.equal(seen.headers["content-type"], "application/json");
    assert.match(seen.headers.accept, /application\/json/);
    assert.match(seen.headers.accept, /text\/event-stream/);
    assert.equal(seen.headers["mcp-method"], "tools/call");
    assert.equal(seen.headers["mcp-name"], "echo");
    assert.equal(seen.headers["mcp-protocol-version"], "2026-07-28");
    assert.deepEqual(JSON.parse(seen.body), {
      jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: {} }
    });
    await transport.close();
    await srv.close();
  });

  test("application/json 响应经 message 事件回流", async () => {
    const srv = await startServer((req, res) => {
      req.resume();
      req.on("end", () => jsonReply(res, { jsonrpc: "2.0", id: 7, result: { tools: [] } }));
    });
    const transport = new HttpTransport({ url: srv.url, allowlist: ALLOW_LOOPBACK });
    const sink = collector(transport);
    transport.start();
    transport.send({ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} });

    const [msg] = await sink.until((m) => m.length >= 1);
    assert.deepEqual(msg, { jsonrpc: "2.0", id: 7, result: { tools: [] } });
    await transport.close();
    await srv.close();
  });

  test("请求级 SSE:一次 POST 可回流多条消息,且跨 chunk 边界不丢", async () => {
    const srv = await startServer((req, res) => {
      req.resume();
      req.on("end", () => {
        sseHead(res);
        // 分片写入,故意在 data 中间切开
        res.write("event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"res");
        res.write("ult\":{\"step\":1}}\n\n");
        res.write(": keep-alive comment\n\n");
        res.write("data: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/tools/list_changed\"}\n\n");
        res.write("data: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"step\":2}}\n\n");
        res.end();
      });
    });

    const transport = new HttpTransport({ url: srv.url, allowlist: ALLOW_LOOPBACK });
    const sink = collector(transport);
    transport.start();
    transport.send({ jsonrpc: "2.0", id: 1, method: "server/discover", params: {} });

    const msgs = await sink.until((m) => m.length >= 3);
    assert.deepEqual(msgs[0], { jsonrpc: "2.0", id: 1, result: { step: 1 } });
    assert.deepEqual(msgs[1], { jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    assert.deepEqual(msgs[2], { jsonrpc: "2.0", id: 2, result: { step: 2 } });
    await transport.close();
    await srv.close();
  });

  test("通知回 202 不解析 body,且不产生 message", async () => {
    let posted = 0;
    const srv = await startServer((req, res) => {
      posted += 1;
      req.resume();
      req.on("end", () => { res.writeHead(202); res.end(); });
    });
    const transport = new HttpTransport({ url: srv.url, allowlist: ALLOW_LOOPBACK });
    let msgCount = 0;
    transport.on("message", () => { msgCount += 1; });
    transport.start();
    transport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await new Promise((r) => setTimeout(r, 300));

    assert.equal(posted, 1);
    assert.equal(msgCount, 0);
    await transport.close();
    await srv.close();
  });

  test("HTTP 4xx/5xx 归类为不可重发的错误(含状态码)", async () => {
    const srv = await startServer((req, res) => {
      req.resume();
      req.on("end", () => jsonReply(res, { error: "nope" }, 401));
    });
    const transport = new HttpTransport({ url: srv.url, allowlist: ALLOW_LOOPBACK });
    const failure = once(transport, "error");
    transport.start();
    transport.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

    const [err] = await failure;
    assert.equal(err.status, 401);
    assert.equal(err.code, "MCP_HTTP_UNAUTHORIZED");
    assert.equal(isStreamBreak(err), false, "鉴权失败不得触发重发");
    await transport.close();
    await srv.close();
  });

  test("断流重发:服务端首次直接切断连接,重发后成功收到响应", async () => {
    let attempts = 0;
    const srv = await startServer((req, res) => {
      req.resume();
      req.on("end", () => {
        attempts += 1;
        if (attempts === 1) {
          // 声明 SSE 后立刻切断 → 客户端应判定为流中断并重发
          sseHead(res);
          res.flushHeaders?.();
          res.socket?.destroy();
          return;
        }
        jsonReply(res, { jsonrpc: "2.0", id: 5, result: { recovered: true } });
      });
    });

    const transport = new HttpTransport({ url: srv.url, allowlist: ALLOW_LOOPBACK, retryOnStreamBreak: 1 });
    const retries = [];
    transport.on("retry", (info) => retries.push(info));
    const sink = collector(transport);
    transport.start();
    transport.send({ jsonrpc: "2.0", id: 5, method: "tools/list", params: {} });

    const msgs = await sink.until((m) => m.length >= 1);
    assert.deepEqual(msgs[0], { jsonrpc: "2.0", id: 5, result: { recovered: true } });
    assert.equal(attempts, 2, "应恰好重发一次");
    assert.equal(retries.length, 1);
    assert.equal(retries[0].method, "tools/list");
    await transport.close();
    await srv.close();
  });

  test("关闭后 send 立即抛错(不静默丢帧)", async () => {
    const srv = await startServer((req, res) => { req.resume(); res.writeHead(202); res.end(); });
    const transport = new HttpTransport({ url: srv.url, allowlist: ALLOW_LOOPBACK });
    transport.start();
    await transport.close();
    assert.throws(() => transport.send({ jsonrpc: "2.0", method: "notifications/initialized" }), /cannot send/);
    await srv.close();
  });

  test("SSRF:未列入 allowlist 的私网目标被拒(不发出请求)", async () => {
    const transport = new HttpTransport({ url: "http://10.0.0.5/mcp", allowlist: ALLOW_LOOPBACK });
    const failure = once(transport, "error");
    transport.start();
    transport.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const [err] = await failure;
    assert.match(err.message, /blocked private network/);
    assert.equal(err.code, "SSRF_BLOCKED");
    await transport.close();
  });

  test("SSRF:重定向每一跳都重新校验(302 → 私网被拒)", async () => {
    const srv = await startServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" });
        res.end();
      });
    });
    const transport = new HttpTransport({ url: srv.url, allowlist: ALLOW_LOOPBACK });
    const failure = once(transport, "error");
    transport.start();
    transport.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

    const [err] = await failure;
    assert.match(err.message, /blocked/i, "重定向目标必须经 SSRF 校验");
    await transport.close();
    await srv.close();
  });

  test("SSRF:重定向到允许的地址时跨 origin 剥离凭据头", async () => {
    let finalAuth = "unset";
    const target = await startServer((req, res) => {
      finalAuth = req.headers.authorization ?? null;
      req.resume();
      req.on("end", () => jsonReply(res, { jsonrpc: "2.0", id: 1, result: { ok: true } }));
    });
    const front = await startServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(307, { Location: target.url });
        res.end();
      });
    });

    const transport = new HttpTransport({
      url: front.url,
      allowlist: ALLOW_LOOPBACK,
      headers: { Authorization: "Bearer secret-token" }
    });
    const sink = collector(transport);
    transport.start();
    transport.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    await sink.until((m) => m.length >= 1);

    assert.equal(finalAuth, null, "跨 origin 重定向不得携带 Authorization");
    await transport.close();
    await front.close();
    await target.close();
  });

  test("会话 id 从响应头捕获并回填后续请求", async () => {
    const seen = [];
    const srv = await startServer((req, res) => {
      seen.push(req.headers["mcp-session-id"] ?? null);
      req.resume();
      req.on("end", () => jsonReply(res, { jsonrpc: "2.0", id: 1, result: {} }, 200, { "Mcp-Session-Id": "sess-123" }));
    });
    const transport = new HttpTransport({ url: srv.url, allowlist: ALLOW_LOOPBACK });
    const sink = collector(transport);
    transport.start();
    transport.send({ jsonrpc: "2.0", id: 1, method: "server/discover", params: {} });
    await sink.until((m) => m.length >= 1);

    assert.equal(transport.sessionId, "sess-123");
    transport.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    await sink.until((m) => m.length >= 2);
    assert.deepEqual(seen, [null, "sess-123"], "第二次请求应带上会话 id");
    await transport.close();
    await srv.close();
  });

  // ── SSE 解析器单测 ──────────────────────────────────────────────────────────
  test("SseParser:多行 data 拼接、注释忽略、跨 chunk 边界", () => {
    const events = [];
    const parser = new SseParser({ onEvent: (e) => events.push(e) });
    parser.feed("data: line1\ndata: line2\n\n");
    parser.feed(": keep-alive\n\n");
    parser.feed("event: custom\nid: 42\ndata: {\"a\":1}\n\n");
    parser.feed("data: tail");
    parser.end();

    assert.deepEqual(events[0], { data: "line1\nline2", event: null, id: null });
    assert.deepEqual(events[1], { data: "{\"a\":1}", event: "custom", id: "42" });
    assert.deepEqual(events[2], { data: "tail", event: null, id: "42" });
  });

  test("isEventStream 判定大小写与参数", () => {
    assert.equal(isEventStream("text/event-stream"), true);
    assert.equal(isEventStream("text/event-stream; charset=utf-8"), true);
    assert.equal(isEventStream("TEXT/EVENT-STREAM"), true);
    assert.equal(isEventStream("application/json"), false);
    assert.equal(isEventStream(undefined), false);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/mcp-http-e2e.test.js
// ---------------------------------------------------------------------------
describe("unit/mcp-http-e2e", async () => {

  /**
   * v1.12.0 验收:连真实 mock Streamable HTTP Server 走通 discover → tools/list → tools/call。
   * 只用 SSRF allowlist 放行 loopback;传输、握手、工具调用全部走真实实现。
   */

  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { default: http } = await import("node:http");
  const { once } = await import("node:events");
  const { McpClient } = await import("../../../src/tools/mcp/mcp-client.js");
  const { createTransport, resolveTransportType, TRANSPORT_TYPES } = await import("../../../src/tools/mcp/transport.js");

  const ALLOW_LOOPBACK = ["127.0.0.1"];

  /** Modern(2026-07-28)mock:server/discover + tools/*,JSON 与 SSE 两种应答。 */
  function modernMockServer({ sse = false } = {}) {
    const calls = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        let msg = null;
        try { msg = JSON.parse(body); } catch { /* notify */ }
        calls.push({ method: msg?.method, headers: req.headers, msg });

        const reply = (payload) => {
          const text = JSON.stringify(payload);
          if (sse) {
            res.writeHead(200, { "Content-Type": "text/event-stream" });
            res.write(`data: ${text}\n\n`);
            res.end();
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
          res.end(text);
        };

        if (!msg || msg.id === undefined) { res.writeHead(202); res.end(); return; }

        switch (msg.method) {
          case "server/discover":
            reply({
              jsonrpc: "2.0", id: msg.id,
              result: {
                era: "modern",
                protocolVersion: "2026-07-28",
                supportedVersions: ["2026-07-28"],
                serverInfo: { name: "mock-http", version: "1.0.0" },
                capabilities: { tools: {} }
              }
            });
            return;
          case "tools/list":
            reply({
              jsonrpc: "2.0", id: msg.id,
              result: {
                tools: [{
                  name: "add",
                  description: "Adds two numbers",
                  inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } }
                }]
              }
            });
            return;
          case "tools/call": {
            const a = Number(msg.params?.arguments?.a || 0);
            const b = Number(msg.params?.arguments?.b || 0);
            reply({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: String(a + b) }] } });
            return;
          }
          default:
            reply({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
        }
      });
    });
    return {
      server,
      calls,
      async listen() {
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        return `http://127.0.0.1:${server.address().port}/mcp`;
      },
      close: () => new Promise((resolve) => server.close(resolve))
    };
  }

  for (const sse of [false, true]) {
    const label = sse ? "SSE 应答" : "JSON 应答";
    test(`Streamable HTTP 端到端(${label}):discover → tools/list → tools/call`, async () => {
      const mock = modernMockServer({ sse });
      const url = await mock.listen();
      const client = new McpClient({
        serverId: "remote",
        url,
        type: "streamable-http",
        allowlist: ALLOW_LOOPBACK,
        timeoutMs: 10000
      });

      try {
        await client.connect();
        assert.equal(client.getStatus(), "CONNECTED");
        assert.equal(client.getProtocolMode(), "modern");
        assert.equal(client.protocolVersion, "2026-07-28");
        assert.equal(client.serverInfo?.name, "mock-http");

        const tools = await client.listTools();
        assert.equal(tools.length, 1);
        assert.equal(tools[0].name, "add");

        const result = await client.callTool("add", { a: 20, b: 22 });
        assert.equal(result.content[0].text, "42");

        // 协议头必须真的发出去了(不只是本地记账)
        const discover = mock.calls.find((c) => c.method === "server/discover");
        assert.ok(discover, "应发出 server/discover");
        assert.equal(discover.headers["mcp-method"], "server/discover");

        const call = mock.calls.find((c) => c.method === "tools/call");
        assert.equal(call.headers["mcp-name"], "add", "tools/call 必须带 Mcp-Name");
        assert.equal(call.headers["mcp-protocol-version"], "2026-07-28", "协商后必须回填协议版本");
      } finally {
        await client.disconnect().catch(() => {});
        await mock.close();
      }
    });
  }

  test("Streamable HTTP:unsupportedProtocolVersion(-32022)触发版本回退", async () => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        const msg = JSON.parse(body);
        const send = (payload) => {
          const text = JSON.stringify(payload);
          res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
          res.end(text);
        };
        if (msg.method === "server/discover") {
          send({ jsonrpc: "2.0", id: msg.id, error: { code: -32022, message: "Unsupported", data: { supported: ["2025-11-25"] } } });
          return;
        }
        if (msg.method === "initialize") {
          send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-11-25", serverInfo: { name: "legacy-http" }, capabilities: {} } });
          return;
        }
        if (msg.method === "tools/list") {
          send({ jsonrpc: "2.0", id: msg.id, result: { tools: [] } });
          return;
        }
        res.writeHead(202); res.end();
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${server.address().port}/mcp`;

    const client = new McpClient({ serverId: "legacy", url, allowlist: ALLOW_LOOPBACK, timeoutMs: 10000 });
    try {
      await client.connect();
      assert.equal(client.getStatus(), "CONNECTED");
      assert.equal(client.protocolVersion, "2025-11-25", "应回退到服务端支持的版本");
    } finally {
      await client.disconnect().catch(() => {});
      await new Promise((r) => server.close(r));
    }
  });

  test("Streamable HTTP:不可达/被拒目标连接失败但错误携带 SSRF 语义", async () => {
    const client = new McpClient({
      serverId: "blocked",
      url: "http://169.254.169.254/mcp",
      allowlist: ALLOW_LOOPBACK,
      timeoutMs: 5000
    });
    await assert.rejects(() => client.connect(), /blocked reserved network|blocked/i);
    assert.equal(client.getStatus(), "ERROR");
  });

  test("传输工厂:类型推断与校验", () => {
    assert.equal(resolveTransportType({ command: "node" }), TRANSPORT_TYPES.STDIO);
    assert.equal(resolveTransportType({ url: "http://x/mcp" }), TRANSPORT_TYPES.STREAMABLE_HTTP);
    assert.equal(resolveTransportType({ url: "http://x/mcp", type: "http" }), TRANSPORT_TYPES.STREAMABLE_HTTP);
    assert.equal(resolveTransportType({ url: "http://x/sse", type: "sse" }), TRANSPORT_TYPES.SSE);
    assert.equal(resolveTransportType({ command: "node", type: "stdio" }), TRANSPORT_TYPES.STDIO);

    assert.throws(() => createTransport({ type: "stdio" }), /requires 'command'/);
    assert.throws(() => createTransport({ type: "streamable-http" }), /requires 'url'/);
  });

  test("传输工厂:stdio 实例仍具备既有契约(迁移不破)", () => {
    const t = createTransport({ command: process.execPath, args: ["-e", "0"] });
    assert.equal(typeof t.start, "function");
    assert.equal(typeof t.send, "function");
    assert.equal(typeof t.close, "function");
    assert.equal(typeof t.getRecentStderr, "function");
    assert.equal(t.supportsRetry, undefined, "stdio 不声明 supportsRetry");
  });

  test("传输工厂:streamable-http 声明 supportsRetry 并接受 allowlist", () => {
    const t = createTransport({ url: "http://127.0.0.1:1/mcp", allowlist: ["127.0.0.1"], retryOnStreamBreak: 2 });
    assert.equal(t.supportsRetry, true);
    assert.deepEqual(t.allowlist, ["127.0.0.1"]);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/mcp-cancel.test.js
// ---------------------------------------------------------------------------
describe("unit/mcp-cancel", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { default: http } = await import("node:http");
  const { EventEmitter, getEventListeners, once } = await import("node:events");
  const { setTimeout: delay } = await import("node:timers/promises");
  const { JsonRpcClient, JSONRPC_ERRORS } = await import("../../../src/tools/mcp/jsonrpc-client.js");
  const { McpClient } = await import("../../../src/tools/mcp/mcp-client.js");
  const { HttpTransport } = await import("../../../src/tools/mcp/http-transport.js");
  const { SseTransport } = await import("../../../src/tools/mcp/sse-transport.js");
  const { StdioTransport } = await import("../../../src/tools/mcp/stdio-transport.js");
  const { oauthHttpRequest } = await import("../../../src/tools/mcp/oauth-http.js");

  function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  }
  class MemoryTransport extends EventEmitter {
    sent = [];
    cancelled = [];
    send(frame) { this.sent.push(frame); }
    cancelRequest(id, reason) { this.cancelled.push({ id, reason }); }
  }
  const reply = (transport, id, result = {}) => transport.emit("message", { jsonrpc: "2.0", id, result });

  async function serverFixture(t, handler) {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
    return `http://127.0.0.1:${server.address().port}/mcp`;
  }
  function readFrame(req, run) {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => run(JSON.parse(body)));
  }
  function jsonReply(res, id, result) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  test("RPC abort settles once, sends one cancellation, and removes listeners despite a late response", async (t) => {
    const transport = new MemoryTransport();
    const rpc = new JsonRpcClient({ transport });
    t.after(() => rpc.close());
    const controller = new AbortController();
    const completed = [], traces = [];
    rpc.on("request_completed", (event) => completed.push(event));
    rpc.on("trace", (event) => traces.push(event));
    const request = rpc.request("tools/call", { name: "slow" }, { signal: controller.signal, timeoutMs: 25 });
    assert.equal(getEventListeners(controller.signal, "abort").length, 1);
    const rejected = assert.rejects(request, { code: JSONRPC_ERRORS.CANCELLED, name: "AbortError" });
    controller.abort(new Error("user stopped"));
    await rejected;
    const id = transport.sent[0].id;
    reply(transport, id, { stale: true });
    await delay(45);
    assert.equal(rpc.getPendingCount(), 0);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    assert.equal(transport.cancelled.length, 1);
    assert.deepEqual(transport.sent[1], { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "cancelled" } });
    assert.equal(transport.sent.length, 2);
    assert.equal(completed.length, 1);
    assert.equal(completed[0].status, "cancelled");
    assert.ok(completed[0].durationMs >= 0);
    assert.deepEqual(traces.map((event) => event.direction), ["out", "out", "in"]);
  });

  test("RPC already-aborted signal sends nothing; success and server errors clean signal listeners", async (t) => {
    const transport = new MemoryTransport();
    const rpc = new JsonRpcClient({ transport });
    t.after(() => rpc.close());
    const completed = [];
    rpc.on("request_completed", (event) => completed.push(event));
    await assert.rejects(rpc.request("never", {}, { signal: AbortSignal.abort() }), { code: JSONRPC_ERRORS.CANCELLED });
    assert.equal(transport.sent.length, 0);
    for (const fails of [false, true]) {
      const controller = new AbortController();
      const result = rpc.request("normal", {}, { signal: controller.signal });
      const id = transport.sent.at(-1).id;
      if (fails) {
        transport.emit("message", { jsonrpc: "2.0", id, error: { code: -32602, message: "bad argument" } });
        await assert.rejects(result, { code: -32602 });
      } else {
        reply(transport, id, { ok: true });
        assert.deepEqual(await result, { ok: true });
      }
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
      controller.abort();
    }
    assert.deepEqual(completed.map((event) => event.status), ["cancelled", "success", "error"]);
  });

  test("RPC deadline cancels only its request; replacement and close settle pending requests exactly once", async (t) => {
    const transport = new MemoryTransport();
    const rpc = new JsonRpcClient({ transport });
    t.after(() => rpc.close());
    const completed = [];
    rpc.on("request_completed", (event) => completed.push(event));
    const keepAlive = delay(60);
    await assert.rejects(rpc.request("deadline", {}, { timeoutMs: 15 }), { code: JSONRPC_ERRORS.TIMEOUT });
    assert.equal(transport.sent.at(-1).params.reason, "timeout");
    assert.equal(transport.cancelled.length, 1);
    const controller = new AbortController();
    const pending = rpc.request("replace", {}, { signal: controller.signal });
    const rejected = assert.rejects(pending, { code: JSONRPC_ERRORS.SERVER_DISCONNECTED });
    const next = new MemoryTransport();
    rpc.setTransport(next);
    await rejected;
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    assert.equal(transport.listenerCount("message"), 0);
    reply(transport, transport.sent.at(-1).id, { late: true });
    const closing = rpc.request("close", {}, { signal: controller.signal });
    const closed = assert.rejects(closing, { code: JSONRPC_ERRORS.SERVER_DISCONNECTED });
    rpc.close();
    await closed;
    assert.equal(rpc.getPendingCount(), 0);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    assert.equal(next.cancelled.length, 1);
    assert.deepEqual(completed.map((event) => event.status), ["timeout", "error", "error"]);
    await keepAlive;
  });

  test("real stdio sends notifications/cancelled and preserves an unrelated request", async (t) => {
    const script = `const rl = require('node:readline').createInterface({input:process.stdin});
      const send = frame => process.stdout.write(JSON.stringify(frame)+'\\n');
      rl.on('line', line => { const m=JSON.parse(line);
        if(m.method==='notifications/cancelled') send({jsonrpc:'2.0',method:'cancel_seen',params:m.params});
        else if(m.method==='quick') send({jsonrpc:'2.0',id:m.id,result:{ok:true}});
      });`;
    const transport = new StdioTransport({ command: process.execPath, args: ["-e", script] });
    transport.start();
    const rpc = new JsonRpcClient({ transport });
    t.after(async () => { rpc.close(); await transport.close(); });
    const controller = new AbortController();
    const pending = rpc.request("slow", {}, { signal: controller.signal });
    const rejected = assert.rejects(pending, { code: JSONRPC_ERRORS.CANCELLED });
    const observed = once(rpc, "notification:cancel_seen");
    const quick = rpc.request("quick");
    controller.abort();
    await rejected;
    assert.equal((await observed)[0].requestId, 1);
    assert.deepEqual(await quick, { ok: true });
  });

  for (const deadline of [false, true]) {
    test(`real HTTP ${deadline ? "deadline" : "abort"} closes one SSE request socket without retry or damaging the client`, async (t) => {
      const slowSeen = deferred(), quickSeen = deferred(), slowClosed = deferred();
      let attempts = 0;
      const url = await serverFixture(t, (req, res) => readFrame(req, (frame) => {
        if (frame.method === "server/discover") return jsonReply(res, frame.id, { era: "modern", protocolVersion: "2026-07-28", capabilities: { tools: {} } });
        if (frame.id == null) { res.writeHead(202); res.end(); return; }
        if (frame.params.name === "slow") {
          attempts++;
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.write(": waiting\n\n");
          res.on("close", () => slowClosed.resolve());
          slowSeen.resolve();
        } else quickSeen.resolve({ res, id: frame.id });
      }));
      const client = new McpClient({ serverId: "remote", url, allowlist: ["127.0.0.1"], protocolMode: "modern" });
      t.after(() => client.disconnect());
      await client.connect();
      const completed = [], errors = [], retries = [];
      client.on("request_completed", (event) => completed.push(event));
      client.on("error", (error) => errors.push(error));
      client.transport.on("retry", (event) => retries.push(event));
      const controller = new AbortController();
      const slow = client.callTool("slow", {}, { signal: controller.signal, timeoutMs: deadline ? 1000 : 5000 });
      const rejected = assert.rejects(slow, { code: deadline ? JSONRPC_ERRORS.TIMEOUT : JSONRPC_ERRORS.CANCELLED });
      const quick = client.callTool("quick");
      await Promise.all([slowSeen.promise, quickSeen.promise]);
      if (!deadline) controller.abort();
      await rejected;
      await slowClosed.promise;
      const target = await quickSeen.promise;
      jsonReply(target.res, target.id, { content: [{ type: "text", text: "ok" }] });
      assert.equal((await quick).content[0].text, "ok");
      await delay(30);
      assert.equal(attempts, 1);
      assert.equal(retries.length, 0);
      assert.equal(errors.length, 0);
      assert.equal(client.getStatus(), "CONNECTED");
      assert.equal(client.rpc.getPendingCount(), 0);
      assert.equal(client.transport._requestControllers.size, 0);
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
      assert.deepEqual(completed.map((event) => event.status), [deadline ? "timeout" : "cancelled", "success"]);
    });
  }

  test("legacy SSE cancellation aborts only the POST, leaving the shared GET stream usable", async (t) => {
    const slowSeen = deferred(), slowClosed = deferred(), cancelSeen = deferred();
    let events, cancelledId;
    const url = await serverFixture(t, (req, res) => {
      if (req.method === "GET") {
        events = res;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("event: endpoint\ndata: /messages\n\n");
        return;
      }
      readFrame(req, (frame) => {
        if (frame.method === "slow") {
          res.on("close", () => slowClosed.resolve());
          slowSeen.resolve();
          return;
        }
        if (frame.method === "notifications/cancelled") { cancelledId = frame.params.requestId; cancelSeen.resolve(); }
        else events.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { ok: true } })}\n\n`);
        res.writeHead(202); res.end();
      });
    });
    const transport = new SseTransport({ url, allowlist: ["127.0.0.1"] });
    const errors = [];
    transport.on("error", (error) => errors.push(error));
    transport.start();
    await transport.waitForEndpoint();
    const rpc = new JsonRpcClient({ transport });
    t.after(async () => { rpc.close(); await transport.close(); });
    const controller = new AbortController();
    const slow = rpc.request("slow", {}, { signal: controller.signal });
    const rejected = assert.rejects(slow, { code: JSONRPC_ERRORS.CANCELLED });
    await slowSeen.promise;
    controller.abort();
    await rejected;
    await slowClosed.promise;
    assert.deepEqual(await rpc.request("quick"), { ok: true });
    await cancelSeen.promise;
    assert.equal(cancelledId, 1);
    assert.equal(transport.state, "running");
    assert.equal(errors.length, 0);
  });

  test("cancelled capability response cannot populate cache and the next read still issues RPC", async (t) => {
    const transport = new MemoryTransport();
    const client = new McpClient({ serverId: "local", transport });
    client.rpc.setTransport(transport);
    client.status = "CONNECTED";
    client.serverCapabilities = { resources: {} };
    t.after(() => client.disconnect());
    const controller = new AbortController();
    const read = client.readResource("file:///x", { signal: controller.signal });
    const rejected = assert.rejects(read, { code: JSONRPC_ERRORS.CANCELLED });
    const firstId = transport.sent[0].id;
    controller.abort();
    await rejected;
    reply(transport, firstId, { contents: [{ text: "stale" }], ttlMs: 60000 });
    const next = client.readResource("file:///x");
    const frame = transport.sent.at(-1);
    assert.equal(frame.method, "resources/read");
    assert.notEqual(frame.id, firstId);
    reply(transport, frame.id, { contents: [{ text: "fresh" }] });
    assert.equal((await next).contents[0].text, "fresh");
  });

  test("aborting while OAuth token refresh is shared prevents only that caller's MCP POST", async (t) => {
    const token = deferred(), requested = deferred();
    const seen = [];
    const url = await serverFixture(t, (req, res) => readFrame(req, (frame) => {
      seen.push(frame.method);
      if (frame.id == null) { res.writeHead(202); res.end(); }
      else jsonReply(res, frame.id, { ok: true });
    }));
    const transport = new HttpTransport({ url, allowlist: ["127.0.0.1"], oauth: {
      getAccessToken() { requested.resolve(); return token.promise; }
    } });
    transport.start();
    const rpc = new JsonRpcClient({ transport });
    t.after(async () => { rpc.close(); await transport.close(); });
    const controller = new AbortController();
    const cancelled = rpc.request("cancel_me", {}, { signal: controller.signal });
    const rejected = assert.rejects(cancelled, { code: JSONRPC_ERRORS.CANCELLED });
    const continuing = rpc.request("keep_me");
    await requested.promise;
    controller.abort();
    await rejected;
    token.resolve("shared-access-token");
    assert.deepEqual(await continuing, { ok: true });
    assert.equal(seen.includes("cancel_me"), false);
    assert.equal(seen.filter((method) => method === "keep_me").length, 1);
  });

  test("OAuth unauthorized metadata/refresh wait removes its abort listener and cannot retry after cancellation", async (t) => {
    const refresh = deferred(), challenged = deferred();
    let count = 0;
    const url = await serverFixture(t, (req, res) => {
      count++;
      req.resume();
      res.writeHead(401, { "WWW-Authenticate": "Bearer" }); res.end();
    });
    const controller = new AbortController();
    const operation = oauthHttpRequest(url, { allowlist: ["127.0.0.1"] }, { signal: controller.signal, method: "POST" }, {
      getAccessToken: async () => "expired",
      handleUnauthorized() { challenged.resolve(); return refresh.promise; }
    });
    const rejected = assert.rejects(operation, /stop during discovery/);
    await challenged.promise;
    controller.abort(new Error("stop during discovery"));
    await rejected;
    refresh.resolve("new-token");
    await delay(30);
    assert.equal(count, 1);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });
});
