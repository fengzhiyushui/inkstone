import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { McpClient } from "../../src/tools/mcp/mcp-client.js";
import { createTransport, resolveTransportType, TRANSPORT_TYPES } from "../../src/tools/mcp/transport.js";

/**
 * v1.12.0 验收:连真实 mock Streamable HTTP Server 走通 discover → tools/list → tools/call。
 * 只用 SSRF allowlist 放行 loopback;传输、握手、工具调用全部走真实实现。
 */
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
