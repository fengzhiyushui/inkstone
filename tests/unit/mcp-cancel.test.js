import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter, getEventListeners, once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { JsonRpcClient, JSONRPC_ERRORS } from "../../src/tools/mcp/jsonrpc-client.js";
import { McpClient } from "../../src/tools/mcp/mcp-client.js";
import { HttpTransport } from "../../src/tools/mcp/http-transport.js";
import { SseTransport } from "../../src/tools/mcp/sse-transport.js";
import { StdioTransport } from "../../src/tools/mcp/stdio-transport.js";
import { oauthHttpRequest } from "../../src/tools/mcp/oauth-http.js";

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
    const slow = client.callTool("slow", {}, { signal: controller.signal, timeoutMs: deadline ? 100 : 2000 });
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
  const slowSeen = deferred(), slowClosed = deferred();
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
      if (frame.method === "notifications/cancelled") cancelledId = frame.params.requestId;
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
