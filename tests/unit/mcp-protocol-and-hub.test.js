// tests/unit/mcp-protocol-and-hub.test.js — MCP 协议、传输层、客户端、Schema 转换与 Hub 门面
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { JsonRpcClient, JSONRPC_ERRORS } from "../../src/tools/mcp/jsonrpc-client.js";
import {
  MODERN_PROTOCOL_VERSION,
  LEGACY_PROTOCOL_VERSION,
  BASELINE_PROTOCOL_VERSION,
  pickMutualVersion
} from "../../src/tools/mcp/protocol.js";
import { StdioTransport } from "../../src/tools/mcp/stdio-transport.js";
import { SseParser } from "../../src/tools/mcp/sse.js";
import { McpClient, MCP_CLIENT_INFO } from "../../src/tools/mcp/mcp-client.js";
import {
  formatExternalToolName,
  parseExternalToolName,
  cleanJsonSchema,
  inferCategory
} from "../../src/tools/mcp/schema-converter.js";
import { validateOutputSchema } from "../../src/tools/mcp/output-schema.js";
import { createMcpFacade } from "../../src/tools/mcp/mcp-facade.js";

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

test("JsonRpcClient 请求响应、通知与错误码严格映射", async () => {
  const transport = new MockTransport();
  const client = new JsonRpcClient({ transport, defaultTimeoutMs: 1000 });

  const reqPromise = client.request("echo", { message: "ping" });
  assert.equal(transport.sent.length, 1);
  const sent = transport.sent[0];
  assert.equal(sent.jsonrpc, "2.0");
  assert.equal(sent.method, "echo");
  assert.deepEqual(sent.params, { message: "ping" });
  assert.ok(sent.id > 0);

  transport.emit("message", {
    jsonrpc: "2.0",
    id: sent.id,
    result: { message: "pong" }
  });

  const res = await reqPromise;
  assert.deepEqual(res, { message: "pong" });

  client.notify("alert", { level: "info" });
  assert.equal(transport.sent.length, 2);
  const notif = transport.sent[1];
  assert.equal(notif.method, "alert");
  assert.equal(notif.id, undefined);

  const errPromise = client.request("failMethod", {});
  const failSent = transport.sent[2];
  transport.emit("message", {
    jsonrpc: "2.0",
    id: failSent.id,
    error: { code: JSONRPC_ERRORS.METHOD_NOT_FOUND, message: "Method not found" }
  });

  await assert.rejects(
    () => errPromise,
    (err) => err.code === JSONRPC_ERRORS.METHOD_NOT_FOUND
  );
});

test("MCP 协议版本协商（modern vs legacy）与握手", () => {
  assert.ok(MODERN_PROTOCOL_VERSION);
  assert.ok(LEGACY_PROTOCOL_VERSION);
  assert.ok(BASELINE_PROTOCOL_VERSION);

  const mutual = pickMutualVersion([MODERN_PROTOCOL_VERSION, LEGACY_PROTOCOL_VERSION]);
  assert.equal(mutual, MODERN_PROTOCOL_VERSION);

  const legacyMutual = pickMutualVersion([LEGACY_PROTOCOL_VERSION]);
  assert.equal(legacyMutual, LEGACY_PROTOCOL_VERSION);

  const unsupported = pickMutualVersion(["1999-01-01"]);
  assert.equal(unsupported, null);
});

test("StdioTransport 安全环境变量过滤与跨平台参数处理", () => {
  const transport = new StdioTransport({
    command: "node",
    args: ["--version"],
    env: {
      SAFE_FOO: "safe",
      SECRET_API_KEY: "secret123"
    }
  });

  assert.ok(transport);
  assert.equal(transport.command, "node");
  assert.deepEqual(transport.args, ["--version"]);
});

test("SseParser 事件流分块与流式消息解析", () => {
  const events = [];
  const parser = new SseParser({
    onEvent: (evt) => events.push(evt)
  });

  parser.feed(": keepalive\n");
  parser.feed("event: message\n");
  parser.feed("data: line 1\n");
  parser.feed("data: line 2\n\n");

  assert.equal(events.length, 1);
  assert.equal(events[0].event, "message");
  assert.equal(events[0].data, "line 1\nline 2");

  parser.feed("data: chunked ");
  parser.feed("data across feed\n\n");
  assert.equal(events.length, 2);
  assert.equal(events[1].data, "chunked data across feed");
});

test("McpClient 请求生命周期、Ping 与 Capabilities 缓存", async () => {
  const transport = new MockTransport();
  const client = new McpClient({
    serverId: "test-server",
    transport,
    protocolMode: "legacy"
  });

  const connectPromise = client.connect();

  assert.ok(transport.sent.length >= 1);
  const initReq = transport.sent.find((m) => m.method === "initialize");
  assert.ok(initReq);

  transport.emit("message", {
    jsonrpc: "2.0",
    id: initReq.id,
    result: {
      protocolVersion: LEGACY_PROTOCOL_VERSION,
      serverInfo: { name: "mock-mcp-server", version: "1.0.0" },
      capabilities: { tools: {}, resources: {} }
    }
  });

  await connectPromise;
  assert.equal(client.status, "CONNECTED");
  assert.equal(client.serverInfo.name, "mock-mcp-server");

  const toolsPromise = client.listTools();
  const listReq = transport.sent.find((m) => m.method === "tools/list");
  assert.ok(listReq);
  transport.emit("message", {
    jsonrpc: "2.0",
    id: listReq.id,
    result: { tools: [{ name: "read_file" }] }
  });

  const tools = await toolsPromise;
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "read_file");

  await client.disconnect();
  assert.equal(client.status, "DISCONNECTED");
});

test("schema-converter 工具与模式双向转换、脱敏与命名空间编码", () => {
  const namespaced = formatExternalToolName("my-srv", "read_file");
  assert.equal(namespaced, "mcp__my-srv__read_file");

  const parsed = parseExternalToolName(namespaced);
  assert.deepEqual(parsed, { serverId: "my-srv", originalName: "read_file" });

  assert.equal(parseExternalToolName("builtin_tool"), null);

  const cleaned = cleanJsonSchema({
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: {
      path: { type: "string", $schema: "sub" }
    },
    required: ["path"],
    description: "Read a file"
  });

  assert.equal(cleaned.$schema, undefined);
  assert.equal(cleaned.properties.path.$schema, undefined);
  assert.equal(cleaned.properties.path.type, "string");
  assert.deepEqual(cleaned.required, ["path"]);

  assert.equal(inferCategory("create_user", "Create a user account"), "mutate");
  assert.equal(inferCategory("get_weather", "Fetch weather data"), "read");
});

test("output-schema 严格 JSON Schema 2020-12 校验与边界控制", () => {
  const schema = {
    type: "object",
    properties: {
      count: { type: "integer", minimum: 0 },
      name: { type: "string", minLength: 2 }
    },
    required: ["count", "name"]
  };

  const validResult = validateOutputSchema(schema, { count: 42, name: "Antigravity" });
  assert.equal(validResult.valid, true);
  assert.equal(validResult.errors.length, 0);

  const invalidResult = validateOutputSchema(schema, { count: -1, name: "A" });
  assert.equal(invalidResult.valid, false);
  assert.ok(invalidResult.errors.length >= 1);

  const unsupportedResult = validateOutputSchema({ unsupportedKeyword123: true }, { a: 1 });
  assert.equal(unsupportedResult.valid, false);
  assert.equal(unsupportedResult.supported, false);
});

test("mcpFacade 门面方法全量映射与 Hub 调度代理", async () => {
  const calls = [];
  const mockHub = {
    listInputRequests: () => (calls.push("listInputRequests"), ["req1"]),
    respondInputRequest: (id, res) => (calls.push(`respondInputRequest:${id}`), true),
    getLogs: (id) => (calls.push(`getLogs:${id}`), []),
    exportLogs: (id) => (calls.push(`exportLogs:${id}`), ""),
    listTools: (id) => (calls.push(`listTools:${id}`), []),
    listServers: () => (calls.push("listServers"), []),
    listInputs: () => (calls.push("listInputs"), []),
    setInputValue: (n, v) => (calls.push(`setInputValue:${n}`), true),
    getAuthStatus: (id) => (calls.push(`getAuthStatus:${id}`), { status: "ok" }),
    startAuth: (id) => (calls.push(`startAuth:${id}`), {}),
    cancelAuth: (id) => (calls.push(`cancelAuth:${id}`), true),
    logoutAuth: (id) => (calls.push(`logoutAuth:${id}`), true),
    restartServer: (id) => (calls.push(`restartServer:${id}`), true),
    toggleServer: (id, en) => (calls.push(`toggleServer:${id}:${en}`), true),
    addServer: (id) => (calls.push(`addServer:${id}`), true),
    removeServer: (id) => (calls.push(`removeServer:${id}`), true),
    listResources: (id) => (calls.push(`listResources:${id}`), []),
    listResourceTemplates: (id) => (calls.push(`listResourceTemplates:${id}`), []),
    readResource: (id, u) => (calls.push(`readResource:${id}:${u}`), {}),
    listPrompts: (id) => (calls.push(`listPrompts:${id}`), []),
    getPrompt: (id, n) => (calls.push(`getPrompt:${id}:${n}`), {}),
    callTool: (name, p) => (calls.push(`callTool:${name}`), { result: "ok" })
  };

  const mockTrials = {
    start: (s, t, p) => (calls.push(`trial:start:${s}:${t}`), "run1"),
    approve: (r) => (calls.push(`trial:approve:${r}`), true),
    cancel: (r) => (calls.push(`trial:cancel:${r}`), true),
    cancelServer: (s) => (calls.push(`trial:cancelServer:${s}`), true)
  };

  const facade = createMcpFacade({ hub: mockHub, trials: mockTrials });
  assert.equal(facade.hub, mockHub);

  facade.listInputRequests();
  facade.respondInputRequest("r1", {});
  facade.getLogs("srv1");
  facade.exportLogs("srv1");
  facade.listTools("srv1");
  facade.startToolTest("srv1", "t1", {});
  facade.approveToolTest("run1");
  facade.cancelToolTest("run1");
  facade.listServers();
  facade.listInputs();
  facade.setInputValue("k", "v");
  facade.getAuthStatus("srv1");
  facade.startAuth("srv1");
  facade.cancelAuth("srv1");
  facade.logoutAuth("srv1");
  facade.restartServer("srv1");
  facade.toggleServer("srv1", true);
  facade.addServer("srv2", {});
  facade.removeServer("srv2");
  facade.listResources("srv1");
  facade.listResourceTemplates("srv1");
  facade.readResource("srv1", "uri1");
  facade.listPrompts("srv1");
  facade.getPrompt("srv1", "p1");
  facade.callTool("mcp__s__t", {});

  assert.ok(calls.includes("trial:cancelServer:srv1"));
  assert.ok(calls.includes("trial:start:srv1:t1"));
  assert.ok(calls.includes("callTool:mcp__s__t"));
});
