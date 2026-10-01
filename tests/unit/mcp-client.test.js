import test from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { EventEmitter } from "node:events";
import {
  McpClient,
  MCP_PROTOCOL_VERSION,
  MCP_MODERN_PROTOCOL_VERSION,
  MCP_CLIENT_INFO
} from "../../src/tools/mcp/mcp-client.js";

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
