import test from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { EventEmitter } from "node:events";
import { McpClient, MCP_PROTOCOL_VERSION } from "../../src/tools/mcp/mcp-client.js";

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
}

test("McpClient performs initialization handshake", async () => {
  const transport = new MockTransport();
  const client = new McpClient({ serverId: "mock-srv", transport });

  const connectPromise = client.connect();

  // Step 1: expect initialize request
  assert.equal(transport.sent.length, 1);
  const initReq = transport.sent[0];
  assert.equal(initReq.method, "initialize");
  assert.equal(initReq.params.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.equal(initReq.params.clientInfo.name, "inkstone");

  // Step 2: reply with server info
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
  assert.deepEqual(client.serverInfo, { name: "test-server", version: "1.0.0" });
  assert.equal(client.serverCapabilities.tools.listChanged, true);

  // Step 3: expect notifications/initialized
  assert.equal(transport.sent.length, 2);
  const notif = transport.sent[1];
  assert.equal(notif.method, "notifications/initialized");
  assert.equal(notif.id, undefined);
});

test("McpClient listTools and callTool over mock RPC", async () => {
  const transport = new MockTransport();
  const client = new McpClient({ serverId: "mock-srv", transport });

  // Complete handshake
  const connectPromise = client.connect();
  const initReq = transport.sent[0];
  transport.emit("message", {
    jsonrpc: "2.0",
    id: initReq.id,
    result: { serverInfo: { name: "test-server" } }
  });
  await connectPromise;

  // 1. listTools
  const listPromise = client.listTools();
  const listReq = transport.sent[2]; // sent[0]=init, sent[1]=initialized notif, sent[2]=tools/list
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

  // 2. callTool
  const callPromise = client.callTool("calculate_sum", { a: 10, b: 20 });
  const callReq = transport.sent[3];
  assert.equal(callReq.method, "tools/call");
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
        if (msg.method === 'initialize') {
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
    args: ["-e", mockServerScript]
  });

  await client.connect();
  assert.equal(client.getStatus(), "CONNECTED");
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
