import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter, once } from "node:events";
import { McpClient } from "../../src/tools/mcp/mcp-client.js";
import { META_KEYS, MCP_SERVER_ERRORS, isUnsupportedProtocolVersionError } from "../../src/tools/mcp/protocol.js";
import { SseParser } from "../../src/tools/mcp/sse.js";

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
