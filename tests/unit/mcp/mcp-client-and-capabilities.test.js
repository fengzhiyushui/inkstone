// tests/unit/mcp/mcp-client-and-capabilities.test.js — MCP 客户端与能力(output-schema/elicitation/schema 转换)领域测试
//
// v1.19.1 测试归并:本文件由下列历史任务单测试合并而成,每个来源包裹在独立
// describe 块中(异步回调 + 动态 import,来源间零共享绑定),测试语义与拆分前一致。
import { describe } from "node:test";

// ---------------------------------------------------------------------------
// 来源:tests/unit/mcp-client.test.js
// ---------------------------------------------------------------------------
describe("unit/mcp-client", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { default: process } = await import("node:process");
  const { EventEmitter } = await import("node:events");
  const { McpClient, MCP_PROTOCOL_VERSION, MCP_MODERN_PROTOCOL_VERSION, MCP_CLIENT_INFO } = await import("../../../src/tools/mcp/mcp-client.js");

  class MockTransport extends EventEmitter {
    constructor() {
      super();
      this.sent = [];
      this.closed = false;
    }

    send(msg) {
      this.sent.push(msg);
    }

    async close() {
      this.closed = true;
    }

    findMethod(method) {
      return this.sent.filter((m) => m.method === method);
    }

    lastMethod(method) {
      const hits = this.findMethod(method);
      return hits[hits.length - 1] || null;
    }
  }

  /** Reply to server/discover as a Modern server. */
  function replyModernDiscover(transport, { version = MCP_MODERN_PROTOCOL_VERSION, capabilities = { tools: { listChanged: true } } } = {}) {
    const req = transport.lastMethod("server/discover");
    assert.ok(req, "expected server/discover probe");
    transport.emit("message", {
      jsonrpc: "2.0",
      id: req.id,
      result: {
        supportedVersions: [version, "2025-11-25", "2024-11-05"],
        era: version === MCP_MODERN_PROTOCOL_VERSION ? "modern" : "legacy",
        serverInfo: { name: "test-server", version: "1.0.0" },
        capabilities
      }
    });
  }

  /** Reply to server/discover as unknown method → Legacy fallback. */
  function replyDiscoverNotFound(transport) {
    const req = transport.lastMethod("server/discover");
    if (!req) return;
    transport.emit("message", {
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32601, message: "Method not found" }
    });
  }

  test("McpClient falls back to Legacy initialize handshake", async () => {
    const transport = new MockTransport();
    const client = new McpClient({ serverId: "mock-srv", transport, discoverTimeoutMs: 500 });

    const connectPromise = client.connect();

    // Probe first
    assert.equal(transport.sent[0].method, "server/discover");
    replyDiscoverNotFound(transport);

    // Legacy initialize
    await new Promise((r) => setImmediate(r));
    const initReq = transport.lastMethod("initialize");
    assert.ok(initReq, "expected initialize after discover miss");
    assert.equal(initReq.params.protocolVersion, MCP_PROTOCOL_VERSION);
    assert.equal(initReq.params.clientInfo.name, "inkstone");

    transport.emit("message", {
      jsonrpc: "2.0",
      id: initReq.id,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        serverInfo: { name: "test-server", version: "1.0.0" },
        capabilities: { tools: { listChanged: true } }
      }
    });

    await connectPromise;

    assert.equal(client.getStatus(), "CONNECTED");
    assert.equal(client.getProtocolMode(), "legacy");
    assert.deepEqual(client.serverInfo, { name: "test-server", version: "1.0.0" });
    assert.equal(client.serverCapabilities.tools.listChanged, true);

    const notif = transport.lastMethod("notifications/initialized");
    assert.ok(notif);
    assert.equal(notif.id, undefined);
  });

  test("McpClient connects in Modern era via server/discover", async () => {
    const transport = new MockTransport();
    const client = new McpClient({ serverId: "modern-srv", transport, discoverTimeoutMs: 500 });

    const connectPromise = client.connect();
    assert.equal(transport.sent[0].method, "server/discover");
    replyModernDiscover(transport);

    await connectPromise;

    assert.equal(client.getStatus(), "CONNECTED");
    assert.equal(client.getProtocolMode(), "modern");
    assert.equal(client.protocolVersion, MCP_MODERN_PROTOCOL_VERSION);
    // Modern era: no initialize handshake
    assert.equal(transport.findMethod("initialize").length, 0);
    assert.equal(transport.findMethod("notifications/initialized").length, 0);

    // tools/list carries modern _meta
    const listPromise = client.listTools();
    const listReq = transport.lastMethod("tools/list");
    assert.ok(listReq.params._meta);
    assert.equal(
      listReq.params._meta["io.modelcontextprotocol/protocolVersion"],
      MCP_MODERN_PROTOCOL_VERSION
    );
    assert.equal(listReq.params._meta["io.modelcontextprotocol/clientInfo"].name, "inkstone");

    transport.emit("message", {
      jsonrpc: "2.0",
      id: listReq.id,
      result: {
        resultType: "complete",
        tools: [{ name: "ping", description: "ping", inputSchema: { type: "object", properties: {} } }]
      }
    });
    const tools = await listPromise;
    assert.equal(tools.length, 1);
  });

  test("McpClient listTools and callTool over Legacy mock RPC", async () => {
    const transport = new MockTransport();
    const client = new McpClient({ serverId: "mock-srv", transport, protocolMode: "legacy" });

    const connectPromise = client.connect();
    const initReq = transport.sent[0];
    assert.equal(initReq.method, "initialize");
    transport.emit("message", {
      jsonrpc: "2.0",
      id: initReq.id,
      result: { serverInfo: { name: "test-server" } }
    });
    await connectPromise;

    const listPromise = client.listTools();
    const listReq = transport.lastMethod("tools/list");
    assert.equal(listReq.method, "tools/list");

    transport.emit("message", {
      jsonrpc: "2.0",
      id: listReq.id,
      result: {
        tools: [
          {
            name: "calculate_sum",
            description: "Adds two numbers",
            inputSchema: {
              type: "object",
              properties: { a: { type: "number" }, b: { type: "number" } }
            }
          }
        ]
      }
    });

    const tools = await listPromise;
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "calculate_sum");

    const callPromise = client.callTool("calculate_sum", { a: 10, b: 20 });
    const callReq = transport.lastMethod("tools/call");
    assert.deepEqual(callReq.params, {
      name: "calculate_sum",
      arguments: { a: 10, b: 20 }
    });

    transport.emit("message", {
      jsonrpc: "2.0",
      id: callReq.id,
      result: {
        content: [{ type: "text", text: "30" }],
        isError: false
      }
    });

    const callResult = await callPromise;
    assert.equal(callResult.isError, false);
    assert.equal(callResult.content[0].text, "30");

    await client.disconnect();
    assert.equal(client.getStatus(), "DISCONNECTED");
    assert.equal(transport.closed, true);
  });

  test("McpClient surfaces structuredContent and resultType", async () => {
    const transport = new MockTransport();
    const client = new McpClient({ serverId: "modern-srv", transport, protocolMode: "modern", discoverTimeoutMs: 500 });

    const connectPromise = client.connect();
    replyModernDiscover(transport);
    await connectPromise;

    const callPromise = client.callTool("get_data", {});
    const callReq = transport.lastMethod("tools/call");
    transport.emit("message", {
      jsonrpc: "2.0",
      id: callReq.id,
      result: {
        resultType: "complete",
        content: [{ type: "text", text: '{"n":1}' }],
        structuredContent: { n: 1 },
        isError: false
      }
    });

    const result = await callPromise;
    assert.equal(result.resultType, "complete");
    assert.deepEqual(result.structuredContent, { n: 1 });
  });

  test("McpClient emits list_changed on tools list_changed notification", async () => {
    const transport = new MockTransport();
    const client = new McpClient({ serverId: "mock-srv", transport, protocolMode: "legacy" });

    const connectPromise = client.connect();
    const initReq = transport.sent[0];
    transport.emit("message", {
      jsonrpc: "2.0",
      id: initReq.id,
      result: { capabilities: { tools: { listChanged: true } } }
    });
    await connectPromise;

    let changed = null;
    client.on("list_changed", (payload) => {
      changed = payload;
    });

    transport.emit("message", {
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed"
    });

    assert.ok(changed);
    assert.match(changed.method, /list_changed/);
  });

  test("McpClient refuses tool calls when not connected", async () => {
    const client = new McpClient({ serverId: "unconnected" });
    await assert.rejects(
      async () => await client.listTools(),
      /is not connected/
    );
    await assert.rejects(
      async () => await client.callTool("foo", {}),
      /is not connected/
    );
  });

  test("McpClient runs end-to-end with real child process mock server over stdio", async () => {
    const mockServerScript = `
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin, terminal: false });

      rl.on('line', (line) => {
        try {
          const msg = JSON.parse(line);
          if (msg.method === 'server/discover') {
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              error: { code: -32601, message: 'Method not found' }
            }) + '\\n');
          } else if (msg.method === 'initialize') {
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: {
                protocolVersion: '2024-11-05',
                serverInfo: { name: 'live-mock', version: '0.1.0' },
                capabilities: {}
              }
            }) + '\\n');
          } else if (msg.method === 'tools/list') {
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: {
                tools: [
                  {
                    name: 'echo_reverse',
                    description: 'Reverses input text',
                    inputSchema: {
                      type: 'object',
                      properties: { text: { type: 'string' } },
                      required: ['text']
                    }
                  }
                ]
              }
            }) + '\\n');
          } else if (msg.method === 'tools/call') {
            const text = msg.params?.arguments?.text || '';
            const reversed = text.split('').reverse().join('');
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: {
                content: [{ type: 'text', text: reversed }],
                isError: false
              }
            }) + '\\n');
          }
        } catch (err) {}
      });
    `;

    const client = new McpClient({
      serverId: "e2e-live-test",
      command: process.execPath,
      args: ["-e", mockServerScript],
      discoverTimeoutMs: 500
    });

    await client.connect();
    assert.equal(client.getStatus(), "CONNECTED");
    assert.equal(client.getProtocolMode(), "legacy");
    assert.equal(client.serverInfo.name, "live-mock");

    const tools = await client.listTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "echo_reverse");

    const result = await client.callTool("echo_reverse", { text: "hello inkstone" });
    assert.equal(result.isError, false);
    assert.equal(result.content[0].text, "enotskni olleh");

    await client.disconnect();
    assert.equal(client.getStatus(), "DISCONNECTED");
  });

  test("McpClient e2e modern server via server/discover", async () => {
    const mockServerScript = `
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin, terminal: false });
      rl.on('line', (line) => {
        try {
          const msg = JSON.parse(line);
          if (msg.method === 'server/discover') {
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: {
                supportedVersions: ['2026-07-28', '2024-11-05'],
                era: 'modern',
                serverInfo: { name: 'modern-mock', version: '0.1.0' },
                capabilities: { tools: {} }
              }
            }) + '\\n');
          } else if (msg.method === 'tools/list') {
            const hasMeta = !!(msg.params && msg.params._meta);
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: {
                resultType: 'complete',
                tools: [
                  {
                    name: 'echo',
                    description: 'echo',
                    inputSchema: { type: 'object', properties: { text: { type: 'string' } } }
                  }
                ],
                metaSeen: hasMeta
              }
            }) + '\\n');
          } else if (msg.method === 'tools/call') {
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: {
                resultType: 'complete',
                content: [{ type: 'text', text: msg.params.arguments.text || '' }],
                structuredContent: { echo: msg.params.arguments.text || '' },
                isError: false
              }
            }) + '\\n');
          }
        } catch (err) {}
      });
    `;

    const client = new McpClient({
      serverId: "e2e-modern",
      command: process.execPath,
      args: ["-e", mockServerScript],
      discoverTimeoutMs: 2000
    });

    await client.connect();
    assert.equal(client.getProtocolMode(), "modern");
    assert.equal(client.serverInfo.name, "modern-mock");

    const tools = await client.listTools();
    assert.equal(tools.length, 1);

    const result = await client.callTool("echo", { text: "dual-era" });
    assert.equal(result.structuredContent.echo, "dual-era");

    await client.disconnect();
  });

  test("McpClient package version is used for clientInfo", () => {
    assert.equal(MCP_CLIENT_INFO.name, "inkstone");
    assert.match(MCP_CLIENT_INFO.version, /^\d+\.\d+\.\d+/);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/mcp-capabilities.test.js
// ---------------------------------------------------------------------------
describe("unit/mcp-capabilities", async () => {

  // In-process transport: real McpClient + JsonRpcClient handshake/request paths,
  // no subprocess, network server, credentials, or model API.

  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { EventEmitter } = await import("node:events");
  const { McpClient, MCP_MODERN_PROTOCOL_VERSION, MCP_PROTOCOL_VERSION } = await import("../../../src/tools/mcp/mcp-client.js");
  const { createCapabilityCache, CAPABILITY_CACHE_LIMITS } = await import("../../../src/tools/mcp/capability-cache.js");

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
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/mcp-output-schema.test.js
// ---------------------------------------------------------------------------
describe("unit/mcp-output-schema", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { validateOutputSchema } = await import("../../../src/tools/mcp/output-schema.js");
  const { toToolExecutionResult, redactStructuredContent } = await import("../../../src/tools/mcp/schema-converter.js");

  test("outputSchema validates nested objects, local refs, required and additional properties", () => {
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $defs: { count: { type: "integer", minimum: 0 } },
      type: "object", required: ["count"], additionalProperties: false,
      properties: { count: { $ref: "#/$defs/count", maximum: 10 } }
    };
    assert.equal(validateOutputSchema(schema, { count: 3 }).valid, true);
    for (const value of [{}, { count: -1 }, { count: 11 }, { count: 1.5 }, { count: 1, extra: true }]) assert.equal(validateOutputSchema(schema, value).valid, false);
    assert.equal(validateOutputSchema({ $defs: { "a/b": { const: "ok" } }, $ref: "#/$defs/a~1b" }, "ok").valid, true);
  });

  test("outputSchema enforces tuples, items, uniqueItems and contains bounds", () => {
    const schema = { type: "array", prefixItems: [{ const: "tag" }], items: { type: "integer" }, uniqueItems: true, contains: { type: "integer", minimum: 2 }, minContains: 1, maxContains: 2, minItems: 2, maxItems: 4 };
    assert.equal(validateOutputSchema(schema, ["tag", 1, 2]).valid, true);
    for (const value of [["bad", 2], ["tag", 1], ["tag", 2, 2], ["tag", 2, 3, 4], ["tag", "bad", 2]]) assert.equal(validateOutputSchema(schema, value).valid, false);
    assert.equal(validateOutputSchema({ type: "array", uniqueItems: true }, [{ a: 1, b: 2 }, { b: 2, a: 1 }]).valid, false);
  });

  test("outputSchema supports composition, conditionals and property dependencies", () => {
    const schema = {
      type: "object", properties: { mode: { enum: ["a", "b"] }, count: { type: "number", multipleOf: 0.1 } },
      required: ["mode"], dependentRequired: { count: ["label"] },
      dependentSchemas: { label: { properties: { label: { type: "string", minLength: 1 } } } },
      if: { properties: { mode: { const: "a" } } }, then: { required: ["count"] }, else: { not: { required: ["count"] } }
    };
    assert.equal(validateOutputSchema(schema, { mode: "a", count: 0.3, label: "ok" }).valid, true);
    assert.equal(validateOutputSchema(schema, { mode: "b" }).valid, true);
    for (const value of [{ mode: "a" }, { mode: "a", count: 0.3 }, { mode: "a", count: 0.35, label: "x" }, { mode: "b", count: 1 }]) assert.equal(validateOutputSchema(schema, value).valid, false);
    assert.equal(validateOutputSchema({ allOf: [{ anyOf: [{ type: "null" }, { type: "string" }] }], oneOf: [{ const: null }, { const: "ok" }] }, "ok").valid, true);
    assert.equal(validateOutputSchema({ oneOf: [{ type: "number" }, { type: "integer" }] }, 2).valid, false);
  });

  test("outputSchema supports safe patterns, Unicode lengths, and patternProperties", () => {
    assert.equal(validateOutputSchema({ type: "string", minLength: 1, maxLength: 1 }, "😀").valid, true);
    assert.equal(validateOutputSchema({ pattern: "^[a-z]+$" }, "abc").valid, true);
    assert.equal(validateOutputSchema({ pattern: "^[a-z]+$" }, "a1").valid, false);
    const schema = { type: "object", propertyNames: { pattern: "^x_[a-z]+$" }, patternProperties: { "^x_": { type: "integer" } }, additionalProperties: false };
    assert.equal(validateOutputSchema(schema, { x_a: 1 }).valid, true);
    assert.equal(validateOutputSchema(schema, { x_a: "bad" }).valid, false);
    assert.equal(validateOutputSchema(schema, { y_a: 1 }).valid, false);
  });

  test("unsupported assertions fail explicitly even in unselected branches", () => {
    for (const schema of [
      { unevaluatedProperties: false }, { format: "email" }, { $ref: "https://example.invalid/schema" },
      { $defs: { future: { contentEncoding: "base64" } } },
      { anyOf: [true, { $dynamicRef: "#node" }] }, { pattern: "(a+)+$" }, { pattern: "a+a+$" }
    ]) {
      const result = validateOutputSchema(schema, {});
      assert.equal(result.valid, false);
      assert.equal(result.supported, false);
      assert.equal(result.errors[0].code, "MCP_OUTPUT_SCHEMA_UNSUPPORTED");
    }
  });

  test("invalid schemas and missing structuredContent never count as valid", () => {
    for (const schema of [{ required: "name" }, { type: "unknown" }, { minItems: -1 }, { $ref: "#/missing" }, { items: [] }, { pattern: "[" }]) assert.equal(validateOutputSchema(schema, {}).valid, false);
    assert.equal(validateOutputSchema({}, undefined).valid, false);
    assert.equal(validateOutputSchema(false, {}).valid, false);
    assert.equal(validateOutputSchema(undefined, undefined).skipped, true);
  });

  test("local recursive schemas terminate and validation budgets fail closed", () => {
    const recursive = { type: "object", properties: { next: { anyOf: [{ type: "null" }, { $ref: "#" }] } }, required: ["next"] };
    assert.equal(validateOutputSchema(recursive, { next: { next: null } }).valid, true);
    assert.equal(validateOutputSchema({ $ref: "#" }, {}).errors[0].code, "MCP_OUTPUT_SCHEMA_LIMIT");
    assert.equal(validateOutputSchema({}, "x".repeat(400_000)).errors[0].code, "MCP_OUTPUT_SCHEMA_LIMIT");
    assert.equal(validateOutputSchema({ pattern: "a+b" }, "a".repeat(4000)).errors[0].code, "MCP_OUTPUT_SCHEMA_LIMIT");
    const cyclic = {}; cyclic.self = cyclic;
    assert.equal(validateOutputSchema({}, cyclic).valid, false);
  });

  test("JSON property names cannot traverse prototypes and getters are not evaluated", () => {
    const value = JSON.parse('{"__proto__":{"safe":true},"toString":1}');
    assert.equal(validateOutputSchema({ type: "object", dependentRequired: {} }, value).valid, true);
    assert.equal(validateOutputSchema({ $ref: "#/__proto__" }, {}).valid, false);
    let accessed = false;
    const withGetter = { get token() { accessed = true; return "secret"; } };
    assert.equal(validateOutputSchema({}, withGetter).valid, false);
    assert.equal(accessed, false);
    assert.throws(() => redactStructuredContent(withGetter), /accessors/);
    assert.equal(accessed, false);
  });

  test("result adapter validates original data then redacts metadata without mutating input", () => {
    const original = { count: 2, password: "sensitive", nested: { token: "private" }, text: "sk-test_secret_123456" };
    const result = toToolExecutionResult({ content: [{ type: "text", text: "ok" }], structuredContent: original }, { outputSchema: { type: "object", required: ["count"], properties: { count: { type: "integer" } } } });
    assert.equal(result.status, "success");
    assert.equal(result.metadata.outputValidation.valid, true);
    assert.equal(result.metadata.structuredContent.password, "[REDACTED]");
    assert.equal(result.metadata.structuredContent.nested.token, "[REDACTED]");
    assert.equal(result.metadata.structuredContent.text, "[REDACTED]");
    assert.equal(original.password, "sensitive");
  });

  test("tool errors and input_required remain errors, schema mismatches are diagnostic", () => {
    const remoteError = toToolExecutionResult({ isError: true, content: [{ type: "text", text: "failed" }] }, { outputSchema: { type: "object" } });
    assert.equal(remoteError.status, "error");
    assert.match(remoteError.content[0].text, /MCP Error/);
    assert.equal(remoteError.metadata.outputValidation, undefined);
    assert.equal(toToolExecutionResult({ resultType: "input_required", content: [] }).metadata.errorCode, "MCP_INPUT_REQUIRED");
    const mismatch = toToolExecutionResult({ structuredContent: { count: "bad" } }, { outputSchema: { properties: { count: { type: "integer" } } } });
    assert.equal(mismatch.status, "error");
    assert.equal(mismatch.metadata.errorCode, "MCP_OUTPUT_SCHEMA_MISMATCH");
    assert.match(mismatch.content[0].text, /validation failed/);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/mcp-elicitation-schema.test.js
// ---------------------------------------------------------------------------
describe("unit/mcp-elicitation-schema", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { validateElicitationSchema, validateElicitationResponse } = await import("../../../src/tools/mcp/elicitation-schema.js");

  const form = (properties = {}, required = []) => ({ type: "object", properties, required });
  const assertInvalid = (operation) => assert.throws(operation, (error) => error.code === "MCP_INPUT_INVALID"
    && error.message === "MCP input does not match the supported form schema");

  test("elicitation supports scalars, all enum shapes and detached responses without defaults", () => {
    const schema = form({
      text: { type: "string", title: "Label", description: "Description", minLength: 0, maxLength: 20, default: "unused" },
      integer: { type: "integer", minimum: -2, maximum: 4, default: 1 },
      decimal: { type: "number", minimum: 0, maximum: 1 },
      flag: { type: "boolean", default: true },
      plain: { type: "string", enum: ["a", "b"] },
      legacy: { type: "string", enum: ["a", "b"], enumNames: ["Alpha", "Beta"] },
      titled: { type: "string", oneOf: [{ const: "a", title: "Alpha" }, { const: "b", title: "Beta" }] },
      many: { type: "array", minItems: 1, maxItems: 2, items: { type: "string", enum: ["a", "b"] } },
      titledMany: { type: "array", items: { anyOf: [{ const: "a", title: "Alpha" }, { const: "b", title: "Beta" }] }, default: ["b"] }
    }, ["integer", "decimal", "flag", "plain", "legacy", "titled", "many", "titledMany"]);
    const normalized = validateElicitationSchema(schema);
    normalized.properties.text.title = "Changed";
    assert.equal(schema.properties.text.title, "Label");
    const value = { integer: 2, decimal: 0.5, flag: false, plain: "a", legacy: "b", titled: "a", many: ["a", "b"], titledMany: ["b"] };
    const result = validateElicitationResponse(schema, value);
    assert.deepEqual(result, value);
    assert.equal(Object.hasOwn(result, "text"), false);
    result.many.push("a");
    assert.deepEqual(value.many, ["a", "b"]);
    assert.deepEqual(validateElicitationResponse(form(), {}), {});
  });

  test("elicitation rejects nested, ambiguous and unknown schema assertions", () => {
    const badFields = [
      { type: "object", properties: {} }, { type: "array", items: { type: "string" } }, { type: "null" }, { type: ["string", "null"] },
      { type: "string", pattern: ".*" }, { type: "string", $ref: "#" }, { type: "string", minLength: -1 },
      { type: "string", minLength: 2, maxLength: 1 }, { type: "string", format: "password" },
      { type: "integer", minimum: 3, maximum: 1 }, { type: "number", minimum: "1" }, { type: "boolean", default: "true" },
      { type: "string", enum: [] }, { type: "string", enum: ["a", "a"] }, { type: "string", enum: [1] },
      { type: "string", enum: ["a"], oneOf: [{ const: "a", title: "A" }] },
      { type: "string", enum: ["a"], minLength: 1 }, { type: "string", enum: ["a"], enumNames: [] },
      { type: "string", enumNames: ["A"] }, { type: "string", oneOf: [{ const: "a" }] },
      { type: "string", oneOf: [{ const: "a", title: "A", type: "string" }] },
      { type: "string", oneOf: [{ const: "a", title: "A" }, { const: "a", title: "B" }] },
      { type: "array", items: { enum: ["a"] } }, { type: "array", items: { anyOf: [] } },
      { type: "array", items: { type: "string", enum: ["a"], anyOf: [{ const: "a", title: "A" }] } },
      { type: "array", items: { anyOf: [{ const: "a", title: "A" }] }, maxItems: 0.5 },
      { type: "string", default: false }, { type: "integer", default: 1.5 }, { type: "string", enum: ["a"], default: "b" }
    ];
    for (const field of badFields) assertInvalid(() => validateElicitationSchema(form({ privateField: field })));
    for (const schema of [null, [], { type: "object" }, { ...form(), additionalProperties: false }, { ...form(), properties: [] },
      { ...form(), title: "ignored" }, { ...form(), $schema: "https://example.invalid/schema" }, form({}, ["missing"]), form({ a: { type: "string" } }, ["a", "a"])]) {
      assertInvalid(() => validateElicitationSchema(schema));
    }
  });

  test("elicitation checks required, types, bounds and extra properties without echoing values", () => {
    const schema = form({ privateField: { type: "integer", minimum: 1, maximum: 3 }, value: { type: "string", minLength: 2, maxLength: 3 } }, ["privateField"]);
    for (const content of [{}, { privateField: 0 }, { privateField: 4 }, { privateField: 1.2 }, { privateField: "sensitive-value" },
      { privateField: 1, value: "a" }, { privateField: 1, value: "long" }, { privateField: 1, injectedSecret: "sensitive-value" }, null, [], "sensitive-value"]) {
      assertInvalid(() => validateElicitationResponse(schema, content));
    }
    assert.equal(validateElicitationResponse(schema, { privateField: 1, value: "界字" }).value, "界字");
    const arraySchema = form({ values: { type: "array", minItems: 1, maxItems: 2, items: { type: "string", enum: ["a", "b"] } } });
    for (const values of [[], ["a", "b", "a"], ["c"], [1], [{}], "a"]) assertInvalid(() => validateElicitationResponse(arraySchema, { values }));
  });

  test("elicitation enforces email, URI, calendar dates and RFC3339 date-time formats", () => {
    const cases = {
      email: { valid: ["a@example.com", "first.last+tag@example.co.uk", '"quoted local"@example.com', "a@[192.0.2.1]", "a@[IPv6:2001:db8::1]"], invalid: ["plain", "a@@example.com", ".a@example.com", "a..b@example.com", "a@-host.com", "a@host..com", "a@example.com\n", "a@例子.com"] },
      uri: { valid: ["https://example.com/path?q=1#anchor", "urn:example:animal:ferret:nose", "mailto:a@example.com", "https://example.com/a%20b"], invalid: ["/relative", "example.com", "https://", "https://example.com/space here", "https://example.com/%no", "https://example.com/\u0000", "https://example.com/界"] },
      date: { valid: ["2024-02-29", "2000-02-29", "0000-01-01"], invalid: ["2023-02-29", "1900-02-29", "2024-04-31", "2024-00-10", "2024-1-01", "2024-01-01Z"] },
      "date-time": { valid: ["2024-02-29T12:34:56Z", "2024-02-29t12:34:56.123z", "2024-02-29T12:34:56+05:30", "2016-12-31T23:59:60Z", "2017-01-01T00:59:60+01:00"], invalid: ["2024-02-29 12:34:56Z", "2023-02-29T12:34:56Z", "2024-01-01T24:00:00Z", "2024-01-01T12:34:56", "2024-01-01T12:34:56+24:00", "2024-01-01T12:34:56+02:60", "2024-01-01T12:34:60Z", "2024-01-01T12:34:61Z"] }
    };
    for (const [format, values] of Object.entries(cases)) {
      const schema = form({ value: { type: "string", format } }, ["value"]);
      assert.equal(validateElicitationSchema(schema).properties.value.format, format);
      for (const value of values.valid) assert.equal(validateElicitationResponse(schema, { value }).value, value, `${format}: ${value}`);
      for (const value of values.invalid) assertInvalid(() => validateElicitationResponse(schema, { value }));
    }
  });

  test("elicitation bounds schema/content UTF8 bytes, field sizes, fields, depth and nodes", () => {
    const fields = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`f${index}`, { type: "string" }]));
    assert.equal(Object.keys(validateElicitationSchema(form(fields)).properties).length, 64);
    assertInvalid(() => validateElicitationSchema(form({ ...fields, overflow: { type: "string" } })));
    assertInvalid(() => validateElicitationSchema(form({ value: { type: "string", title: "界".repeat(22_000) } })));
    const schema = form({ value: { type: "string" } });
    assert.equal(validateElicitationResponse(schema, { value: "a".repeat(16_384) }).value.length, 16_384);
    assertInvalid(() => validateElicitationResponse(schema, { value: "a".repeat(16_385) }));
    assertInvalid(() => validateElicitationResponse(schema, { value: "界".repeat(5500) }));
    assertInvalid(() => validateElicitationResponse(form(fields), Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`f${index}`, "x".repeat(16_000)]))));
    let deep = {};
    for (let index = 0; index < 70; index++) deep = { next: deep };
    assertInvalid(() => validateElicitationSchema(deep));
    assertInvalid(() => validateElicitationResponse(schema, deep));
    assertInvalid(() => validateElicitationResponse(schema, { value: Array(20_001).fill(null) }));
  });

  test("elicitation rejects unsafe JSON without evaluating accessors or serialization hooks", () => {
    let reads = 0;
    const accessor = { get privateField() { reads++; return "secret"; } };
    const cyclic = {}; cyclic.self = cyclic;
    const schema = form({ privateField: { type: "string" } });
    for (const content of [accessor, cyclic, { privateField: NaN }, { privateField: Infinity }, { privateField: undefined },
      { privateField: () => "secret" }, new Date(), new Map(), { toJSON() { reads++; return "secret"; } }]) assertInvalid(() => validateElicitationResponse(schema, content));
    assert.equal(reads, 0);
    assertInvalid(() => validateElicitationSchema(form({ privateField: accessor })));
    assert.equal(reads, 0);
    const trickySchema = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"},"constructor":{"type":"boolean"}},"required":["__proto__"]}');
    const trickyContent = JSON.parse('{"__proto__":"private","constructor":false}');
    const result = validateElicitationResponse(trickySchema, trickyContent);
    assert.deepEqual(result, trickyContent);
    assert.equal(Object.getPrototypeOf(result), Object.prototype);
    assert.equal(Object.prototype.private, undefined);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/mcp-schema-converter.test.js
// ---------------------------------------------------------------------------
describe("unit/mcp-schema-converter", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { sanitizeIdentifier, formatExternalToolName, parseExternalToolName, cleanJsonSchema, inferCategory, formatToolResult, mcpToolToDeepSeekSchema } = await import("../../../src/tools/mcp/schema-converter.js");

  test("formatExternalToolName and parseExternalToolName two-level namespacing", () => {
    const name1 = formatExternalToolName("postgres", "query_table");
    assert.equal(name1, "mcp__postgres__query_table");
    assert.deepEqual(parseExternalToolName(name1), {
      serverId: "postgres",
      originalName: "query_table"
    });

    const name2 = formatExternalToolName("@company/mcp-server.v1", "read/file.txt");
    // server: non [A-Za-z0-9_.-] → _ ; tool keeps dot (spec-legal)
    assert.equal(name2, "mcp___company_mcp-server.v1__read_file.txt");
    assert.deepEqual(parseExternalToolName(name2), {
      serverId: "_company_mcp-server.v1",
      originalName: "read_file.txt"
    });
  });

  test("sanitizeIdentifier allows spec-legal dots", () => {
    assert.equal(sanitizeIdentifier("admin.tools.list"), "admin.tools.list");
    assert.equal(sanitizeIdentifier("read/file"), "read_file");
  });

  test("cleanJsonSchema removes $schema and non-standard fields", () => {
    const cleaned = cleanJsonSchema({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        a: { type: "string", $schema: "x" },
        b: { type: "number" }
      },
      required: ["a"],
      additionalProperties: false,
      description: "d"
    });
    assert.equal(cleaned.$schema, undefined);
    assert.equal(cleaned.properties.a.$schema, undefined);
    assert.deepEqual(cleaned.required, ["a"]);
    assert.equal(cleaned.description, "d");
  });

  test("inferCategory detects read vs mutate from tool semantics", () => {
    assert.equal(inferCategory("get_user", "fetch a user"), "read");
    assert.equal(inferCategory("delete_row", "remove a row"), "mutate");
    assert.equal(inferCategory("do_thing", "execute command"), "mutate");
  });

  test("formatToolResult extracts text and error flags", () => {
    assert.equal(
      formatToolResult({ content: [{ type: "text", text: "ok" }], isError: false }),
      "ok"
    );
    assert.match(
      formatToolResult({ content: [{ type: "text", text: "boom" }], isError: true }),
      /\[MCP Error\] boom/
    );
  });

  test("mcpToolToDeepSeekSchema formats OpenAI/DeepSeek function schema", () => {
    const schema = mcpToolToDeepSeekSchema("fs", {
      name: "read_file",
      description: "Read a file",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
    });
    assert.equal(schema.type, "function");
    assert.equal(schema.function.name, "mcp__fs__read_file");
    assert.match(schema.function.description, /\[MCP: fs\]/);
    assert.equal(schema.function.parameters.required[0], "path");
  });
});
