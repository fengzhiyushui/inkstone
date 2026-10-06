import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { McpClient, MCP_MODERN_PROTOCOL_VERSION, MCP_PROTOCOL_VERSION } from "../../src/tools/mcp/mcp-client.js";
import { createCapabilityCache, CAPABILITY_CACHE_LIMITS } from "../../src/tools/mcp/capability-cache.js";

// In-process transport: real McpClient + JsonRpcClient handshake/request paths,
// no subprocess, network server, credentials, or model API.
class LocalTransport extends EventEmitter {
  constructor(capabilities, respond) { super(); this.capabilities = capabilities; this.respond = respond; this.calls = []; }
  send(message) {
    if (message.id === undefined) return;
    this.calls.push(message);
    Promise.resolve().then(() => {
      if (message.method === "server/discover") return { era: "modern", supportedVersions: [MCP_MODERN_PROTOCOL_VERSION], capabilities: this.capabilities };
      if (message.method === "initialize") return { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: this.capabilities };
      return this.respond(message.method, message.params || {}, message);
    }).then((result) => this.emit("message", { jsonrpc: "2.0", id: message.id, result }),
      (error) => this.emit("message", { jsonrpc: "2.0", id: message.id, error: { code: -32603, message: error.message } }));
  }
  async close() {}
  notify(method, params = {}) { this.emit("message", { jsonrpc: "2.0", method, params }); }
}

async function fixture(t, { capabilities = { resources: {}, prompts: {} }, mode = "modern", respond = () => ({}), serverId = "local", headers = {} } = {}) {
  const transport = new LocalTransport(capabilities, respond);
  const client = new McpClient({ serverId, transport, protocolMode: mode, headers });
  await client.connect();
  transport.calls.length = 0;
  t.after(() => client.disconnect());
  return { client, transport };
}

test("undeclared or disabled resources/prompts never send RPC", async (t) => {
  for (const value of [undefined, false, null, "yes", [], 0]) {
    const capabilities = value === undefined ? {} : { resources: value, prompts: value };
    const { client, transport } = await fixture(t, { capabilities });
    assert.equal(client.supportsCapability("resources"), false);
    assert.deepEqual(await client.listResources(), { resources: [], supported: false });
    assert.deepEqual(await client.listResourceTemplates(), { resourceTemplates: [], supported: false });
    assert.deepEqual(await client.listPrompts(), { prompts: [], supported: false });
    await assert.rejects(client.readResource("file:///readme"), { code: "MCP_CAPABILITY_UNSUPPORTED" });
    await assert.rejects(client.getPrompt("review"), { code: "MCP_CAPABILITY_UNSUPPORTED" });
    assert.equal(transport.calls.length, 0);
  }
});

test("explicit true and object capability declarations are supported; tools compatibility stays unchanged", async (t) => {
  const { client } = await fixture(t, { capabilities: { resources: true, prompts: {} }, respond: () => ({ tools: [{ name: "old" }] }) });
  assert.equal(client.supportsCapability("resources"), true);
  assert.equal(client.supportsCapability("prompts"), true);
  assert.equal(client.supportsCapability("toString"), false);
  assert.deepEqual(await client.listTools(), [{ name: "old" }]);
});

for (const mode of ["modern", "legacy"]) {
  test(`${mode} lists resources/templates/prompts with the appropriate template method`, async (t) => {
    const { client, transport } = await fixture(t, { mode, respond: (method) => {
      if (method === "resources/list") return { resources: [{ uri: "file:///readme", name: "README" }] };
      if (method === "prompts/list") return { prompts: [{ name: "review", arguments: [{ name: "language", required: true }] }] };
      return { resourceTemplates: [{ uriTemplate: "file:///{path}", name: "files" }] };
    } });
    assert.equal((await client.listResources()).resources[0].name, "README");
    assert.equal((await client.listResourceTemplates()).resourceTemplates[0].uriTemplate, "file:///{path}");
    assert.equal((await client.listPrompts()).prompts[0].arguments[0].required, true);
    assert.deepEqual(transport.calls.map((c) => c.method), ["resources/list", mode === "modern" ? "templates/list" : "resources/templates/list", "prompts/list"]);
    assert.equal(Boolean(transport.calls[0].params._meta), mode === "modern");
  });
}

test("resource read and parameterized prompt get preserve bounded content", async (t) => {
  const { client, transport } = await fixture(t, { respond: (method) => method === "resources/read"
    ? { contents: [{ uri: "file:///readme", mimeType: "text/plain", text: "hello" }] }
    : { messages: [{ role: "user", content: { type: "text", text: "review JS" } }] } });
  assert.equal((await client.readResource("file:///readme")).contents[0].text, "hello");
  assert.equal((await client.getPrompt("review", { language: "JS" })).messages[0].content.text, "review JS");
  assert.equal(transport.calls[0].params.uri, "file:///readme");
  assert.deepEqual(transport.calls[1].params.arguments, { language: "JS" });
});

test("page budget returns server cursor and can continue without repeating the first page", async (t) => {
  const { client, transport } = await fixture(t, { respond: (_method, params) => params.cursor === "page2"
    ? { resources: [{ name: "second" }] }
    : { resources: [{ name: "first" }], nextCursor: "page2" } });
  const first = await client.listResources({ maxPages: 1 });
  assert.deepEqual(first, { resources: [{ name: "first" }], supported: true, truncated: true, truncationReason: "max_pages", nextCursor: "page2" });
  const rest = await client.listResources({ cursor: first.nextCursor });
  assert.deepEqual(rest.resources, [{ name: "second" }]);
  assert.equal(rest.truncated, undefined);
  assert.equal(transport.calls.length, 2);
});

test("item budget cutting a server page preserves its remaining entries via an opaque cursor", async (t) => {
  const { client, transport } = await fixture(t, { respond: (_method, params) => params.cursor === "page2"
    ? { resources: [{ name: "d" }] }
    : { resources: ["a", "b", "c"].map((name) => ({ name })), nextCursor: "page2" } });
  const first = await client.listResources({ maxItems: 2 });
  assert.deepEqual(first.resources.map((x) => x.name), ["a", "b"]);
  assert.equal(first.truncationReason, "max_items");
  assert.match(first.nextCursor, /^inkstone-page:/);
  const rest = await client.listResources({ cursor: first.nextCursor });
  assert.deepEqual(rest.resources.map((x) => x.name), ["c", "d"]);
  assert.equal(transport.calls[1].params.cursor, undefined);
  assert.equal(transport.calls[2].params.cursor, "page2");
});

test("repeated pagination cursor terminates instead of making unbounded requests", async (t) => {
  const { client, transport } = await fixture(t, { respond: () => ({ prompts: [], nextCursor: "loop" }) });
  const result = await client.listPrompts();
  assert.equal(result.truncated, true);
  assert.equal(result.truncationReason, "repeated_cursor");
  assert.equal(result.nextCursor, undefined);
  assert.equal(transport.calls.length, 2);
});

test("cancellation during a page stops subsequent pagination requests", async (t) => {
  const controller = new AbortController();
  const { client, transport } = await fixture(t, { respond: () => {
    controller.abort(new Error("pagination cancelled"));
    return { resources: [{ name: "first" }], nextCursor: "next-page" };
  } });
  await assert.rejects(client.listResources({ signal: controller.signal }), /pagination cancelled/);
  assert.equal(transport.calls.length, 1, "an aborted request must not fetch later pages");
});

test("list byte limits retain a resumable item offset and reject an individually oversized descriptor", async (t) => {
  const { client } = await fixture(t, { respond: () => ({ resources: [{ name: "small" }, { name: "second" }] }) });
  const first = await client.listResources({ maxBytes: 24 });
  assert.deepEqual(first.resources, [{ name: "small" }]);
  assert.equal(first.truncationReason, "max_bytes");
  const second = await client.listResources({ maxBytes: 24, cursor: first.nextCursor });
  assert.deepEqual(second.resources, [{ name: "second" }]);
  const tiny = await client.listResources({ maxBytes: 2 });
  assert.deepEqual(tiny.resources, []);
  assert.equal(tiny.truncationReason, "item_too_large");
  assert.equal(tiny.nextCursor, undefined);
});

test("Modern templates accepts the era-specific templates result alias", async (t) => {
  const { client } = await fixture(t, { respond: () => ({ templates: [{ uriTemplate: "file:///{path}" }] }) });
  assert.deepEqual((await client.listResourceTemplates()).resourceTemplates, [{ uriTemplate: "file:///{path}" }]);
});

test("invalid resource/prompt inputs fail before sending a request", async (t) => {
  const { client, transport } = await fixture(t);
  await assert.rejects(client.readResource(""), TypeError);
  await assert.rejects(client.getPrompt("review", []), TypeError);
  await assert.rejects(client.readResource("file:///x", { maxBytes: 1 }), TypeError);
  assert.equal(transport.calls.length, 0);
});

test("pagination enforces hard page/item ceilings and rejects invalid limits before requesting", async (t) => {
  const { client, transport } = await fixture(t, { respond: (_method, _params, message) => ({ resources: [], nextCursor: String(message.id) }) });
  assert.equal((await client.listResources({ maxPages: 999 })).truncationReason, "max_pages");
  assert.equal(transport.calls.length, 20);
  transport.respond = () => ({ resources: Array.from({ length: 1002 }, (_, i) => ({ name: String(i) })) });
  assert.equal((await client.listResources({ maxItems: 9999 })).resources.length, 1000);
  const before = transport.calls.length;
  for (const opts of [{ maxPages: 0 }, { maxItems: Infinity }, { maxItems: -2 }, { cursor: {} }]) await assert.rejects(client.listResources(opts), TypeError);
  assert.equal(transport.calls.length, before);
});

test("resources and embedded prompt text are clipped to a UTF-8 JSON byte budget without mutation", async (t) => {
  const text = "中文🙂\n\"".repeat(2000);
  const raw = { contents: [{ uri: "file:///x", text }] };
  const { client, transport } = await fixture(t, { respond: () => raw });
  const read = await client.readResource("file:///x", { maxBytes: 160 });
  assert.equal(read.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(read.contents)) <= 160);
  assert.equal(read.bytes, Buffer.byteLength(JSON.stringify(read.contents)));
  assert.ok(!read.contents[0].text.includes("�"));
  assert.equal(raw.contents[0].text, text);
  transport.respond = () => ({ messages: [{ role: "user", content: { type: "resource", resource: { uri: "file:///x", text } } }] });
  const prompt = await client.getPrompt("embedded", {}, { maxBytes: 160 });
  assert.equal(prompt.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(prompt.messages)) <= 160);
  assert.ok(prompt.messages[0].content.resource.text.length < text.length);
});

test("oversized binary blocks are omitted rather than corrupted and later entries respect the total budget", async (t) => {
  const { client, transport } = await fixture(t, { respond: () => ({ contents: [{ uri: "file:///image", blob: "A".repeat(1000) }] }) });
  assert.deepEqual(await client.readResource("file:///image", { maxBytes: 80 }), { contents: [], supported: true, truncated: true, bytes: 2 });
  transport.respond = () => ({ messages: [{ role: "user", content: { type: "text", text: "hello" } }, { role: "user", content: { type: "image", data: "A".repeat(1000), mimeType: "image/png" } }] });
  const result = await client.getPrompt("image", {}, { maxBytes: 100 });
  assert.equal(result.messages.length, 1);
  assert.equal(result.truncated, true);
});

test("read output has a hard 1 MiB limit even when callers request more", async (t) => {
  const { client } = await fixture(t, { respond: () => ({ contents: [{ uri: "file:///large", text: "x".repeat(2 * 1024 * 1024) }] }) });
  const result = await client.readResource("file:///large", { maxBytes: 10 * 1024 * 1024 });
  assert.equal(result.truncated, true);
  assert.ok(result.bytes <= 1024 * 1024);
});

test("TTL cache is detached from caller mutations and forceRefresh bypasses it", async (t) => {
  let n = 0;
  const { client, transport } = await fixture(t, { respond: () => ({ resources: [{ name: String(++n) }], ttlMs: 10000, cacheScope: "session" }) });
  (await client.listResources()).resources[0].name = "mutated";
  assert.equal((await client.listResources()).resources[0].name, "1");
  assert.equal(transport.calls.length, 1);
  assert.equal((await client.listResources({ forceRefresh: true })).resources[0].name, "2");
  assert.equal(transport.calls.length, 2);
});

test("none/request scope and missing/invalid TTL prohibit caching", async (t) => {
  for (const hints of [{ ttlMs: 1000, cacheScope: "none" }, { ttlMs: 1000, cacheScope: "request" }, {}, { ttlMs: 0 }, { ttlMs: -1 }]) {
    const { client, transport } = await fixture(t, { respond: () => ({ resources: [], ...hints }) });
    await client.listResources();
    await client.listResources();
    assert.equal(transport.calls.length, 2);
  }
});

test("cache is isolated by client and is invalidated when credential configuration changes", async (t) => {
  const first = await fixture(t, { serverId: "same", headers: { Authorization: "Bearer a" }, respond: () => ({ prompts: [{ name: "a" }], ttlMs: 10000, cacheScope: "public" }) });
  const second = await fixture(t, { serverId: "same", headers: { Authorization: "Bearer b" }, respond: () => ({ prompts: [{ name: "b" }], ttlMs: 10000, cacheScope: "public" }) });
  assert.equal((await first.client.listPrompts()).prompts[0].name, "a");
  assert.equal((await second.client.listPrompts()).prompts[0].name, "b");
  first.client.transportConfig.headers.Authorization = "Bearer changed";
  await first.client.listPrompts();
  assert.equal(first.transport.calls.length, 2);
});

test("list_changed invalidates list/read caches and outstanding client cursors", async (t) => {
  const { client, transport } = await fixture(t, { respond: (method) => method === "resources/read"
    ? { contents: [{ uri: "file:///x", text: "hello" }], ttlMs: 10000 }
    : { resources: [{ name: "a" }, { name: "b" }], ttlMs: 10000 } });
  await client.listResources();
  await client.readResource("file:///x");
  const partial = await client.listResources({ maxItems: 1 });
  transport.notify("notifications/resources/list_changed");
  await assert.rejects(client.listResources({ cursor: partial.nextCursor }), { code: "MCP_CURSOR_EXPIRED" });
  await client.listResources();
  await client.readResource("file:///x");
  assert.equal(transport.calls.length, 5);
});

test("disconnect/reconnect invalidates capabilities cached by the prior connection", async (t) => {
  const { client, transport } = await fixture(t, { respond: () => ({ prompts: [{ name: "cached" }], ttlMs: 10000 }) });
  await client.listPrompts();
  await client.disconnect();
  await client.connect();
  await client.listPrompts();
  assert.equal(transport.calls.filter((c) => c.method === "prompts/list").length, 2);
  await client.disconnect();
  transport.capabilities = {};
  await client.connect();
  assert.deepEqual(await client.listPrompts(), { prompts: [], supported: false });
});

test("notification during an in-flight read prevents repopulating the invalidated cache", async (t) => {
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  let n = 0;
  const { client, transport } = await fixture(t, { respond: () => ++n === 1 ? pending : { contents: [], ttlMs: 10000 } });
  const reading = client.readResource("file:///x");
  await Promise.resolve();
  transport.notify("notifications/resources/list_changed");
  finish({ contents: [], ttlMs: 10000 });
  await reading;
  await client.readResource("file:///x");
  assert.equal(n, 2);
});

test("capability cache bounds TTL, entry count and memory, with TTL expiry and LRU eviction", () => {
  let now = 0;
  const cache = createCapabilityCache({ now: () => now, maxEntries: 2, maxBytes: 100 });
  cache.set("a", { name: "a" }, { ttlMs: 1e12 });
  cache.set("b", { name: "b" }, { ttlMs: 100 });
  assert.deepEqual(cache.get("a"), { name: "a" });
  cache.set("c", { name: "c" }, { ttlMs: 100 });
  assert.equal(cache.get("b"), null);
  cache.set("large", { data: "x".repeat(101) }, { ttlMs: 100 });
  assert.equal(cache.get("large"), null);
  assert.equal(cache.size(), 2);
  now = 101;
  assert.equal(cache.get("c"), null);
  assert.deepEqual(cache.get("a"), { name: "a" });
  now = CAPABILITY_CACHE_LIMITS.maxTtlMs + 1;
  assert.equal(cache.get("a"), null);
});
