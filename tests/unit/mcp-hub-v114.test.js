import test from "node:test";
import assert from "node:assert/strict";
import { McpHub } from "../../src/tools/mcp/mcp-hub.js";
import { normalizeServerConfig } from "../../src/tools/mcp/config-loader.js";
import { asPolicy } from "../../src/tools/mcp/tool-policy.js";
import { createToolRegistry } from "../../src/tools/registry.js";
import { createToolExecutor } from "../../src/tools/executor.js";
import { createPermissionEngine } from "../../src/tools/permissions/permission-engine.js";

test("normalized tools policy reaches mounting with risk, approval and filtering intact", () => {
  const config = normalizeServerConfig("probe", { command: "unused", tools: { enabled: ["create_backup"], disabled: ["write_file"], risk: { create_backup: "read" }, approval: { create_backup: "project" } } });
  assert.deepEqual(asPolicy({ enabled: ["*"], disabled: [] }), { enabled: ["*"], disabled: [], approval: {}, risk: {} });
  const registry = createToolRegistry();
  const hub = new McpHub({ toolRegistry: registry });
  hub._mountTools("probe", [{ name: "create_backup" }, { name: "write_file" }], {}, config);
  const tool = registry.resolve("mcp__probe__create_backup");
  assert.equal(tool.category, "read");
  assert.equal(tool.riskOverridden, true);
  assert.equal(tool.approvalScope, "project");
  assert.equal(registry.resolve("mcp__probe__write_file"), null);
});

test("dynamic server add uses full shared normalization without starting a connection", async () => {
  const raw = { url: "https://example.invalid/mcp", type: "http", headers: { Authorization: "Bearer placeholder" }, allowlist: ["127.0.0.1"], trust: true, protocolMode: "legacy", tools: { disabled: ["remove"], risk: { create_backup: "READ" }, approval: { create_backup: "PROJECT" } } };
  const hub = new McpHub();
  await hub.addServer("probe", raw, { autoStart: false });
  assert.deepEqual(hub.serverConfigs.get("probe"), normalizeServerConfig("probe", raw));
  assert.equal(hub.clients.size, 0);
});

test("mounted tools preserve executor content, structured metadata and error statuses", async () => {
  const registry = createToolRegistry();
  const hub = new McpHub({ toolRegistry: registry });
  let response = { content: [{ type: "text", text: "answer" }], structuredContent: { count: 1, password: "secret-value", data: { records: [1, 2], label: "ordinary payload" } } };
  const client = { callTool: async () => response, getStatus: () => "CONNECTED" };
  hub.clients.set("s", client);
  hub._mountTools("s", [{ name: "lookup", outputSchema: { type: "object", required: ["count"], properties: { count: { type: "integer" } } } }], client, {});
  const executor = createToolExecutor({ registry, permissionEngine: createPermissionEngine() });
  const call = { id: "c", name: "mcp__s__lookup", params: {} };
  const result = await executor.execute(call);
  assert.equal(result.status, "success");
  assert.deepEqual(result.content, [{ type: "text", text: "answer" }]);
  assert.equal(result.metadata.structuredContent.password, "[REDACTED]");
  assert.equal(result.metadata.structuredContent.count, 1);
  assert.deepEqual(result.metadata.structuredContent.data, { records: [1, 2], label: "ordinary payload" }, "ordinary data objects must not be mistaken for binary content");
  assert.equal(await hub.callTool(call.name), "answer", "public direct API retains textual contract");
  response = { structuredContent: { count: "invalid" } };
  assert.equal((await executor.execute(call)).metadata.errorCode, "MCP_OUTPUT_SCHEMA_MISMATCH");
  response = { isError: true, content: [{ type: "text", text: "server failed" }] };
  const failed = await executor.execute(call);
  assert.equal(failed.status, "error");
  assert.match(failed.content[0].text, /server failed/);
});

test("tool names that match Object prototype keys do not become risk overrides", () => {
  const registry = createToolRegistry();
  const hub = new McpHub({ toolRegistry: registry });
  hub._mountTools("s", [{ name: "constructor" }, { name: "toString" }], {}, {});
  for (const tool of registry.listTools()) {
    assert.equal(tool.category, "read");
    assert.equal(tool.riskOverride, null);
    assert.equal(tool.approvalScope, null);
  }
});

test("resources-only servers connect without tools/list and expose capabilities", async () => {
  const hub = new McpHub({ config: { mcpServers: { r: { command: "unused" } } } });
  const client = { serverCapabilities: { resources: {}, prompts: {} }, connect: async () => {}, listTools: async () => { throw new Error("tools/list must not run"); }, getProtocolMode: () => "legacy", getStatus: () => "CONNECTED", getLastError: () => null, getRecentStderr: () => "" };
  hub.clients.set("r", client);
  await hub._connectAndMount("r", client, {});
  assert.equal(hub.listServers()[0].toolCount, 0);
  assert.deepEqual(hub.listServers()[0].capabilities, { resources: {}, prompts: {} });
});

test("resource and prompt facade methods forward arguments without reshaping results", async () => {
  const hub = new McpHub();
  const calls = [];
  const client = { getStatus: () => "CONNECTED" };
  const expected = { supported: true, resources: [], nextCursor: "next", truncated: true };
  for (const method of ["listResources", "listResourceTemplates", "readResource", "listPrompts", "getPrompt"]) client[method] = async (...args) => { calls.push([method, ...args]); return expected; };
  hub.clients.set("r", client);
  const opts = { cursor: "cursor", maxItems: 3 };
  assert.equal(await hub.listResources("r", opts), expected);
  await hub.listResourceTemplates("r", opts);
  await hub.readResource("r", "test://item", opts);
  await hub.listPrompts("r", opts);
  await hub.getPrompt("r", "review", { lang: "zh" }, opts);
  assert.deepEqual(calls, [["listResources", opts], ["listResourceTemplates", opts], ["readResource", "test://item", opts], ["listPrompts", opts], ["getPrompt", "review", { lang: "zh" }, opts]]);
  await assert.rejects(hub.listResources("missing"), /not connected/);
});

test("capability requests lazily connect only the target and share in-flight connection", async () => {
  const hub = new McpHub({ config: { mcpServers: { target: { command: "unused" }, other: { command: "unused" }, disabled: { command: "unused", disabled: true } } } });
  const connections = [];
  hub.restartServer = async (serverId) => {
    connections.push(serverId);
    await Promise.resolve();
    hub.clients.set(serverId, { getStatus: () => "CONNECTED", listResources: async () => ({ resources: [], supported: true }), listPrompts: async () => ({ prompts: [], supported: true }) });
  };
  const [resources, prompts] = await Promise.all([hub.listResources("target"), hub.listPrompts("target")]);
  assert.equal(resources.supported, true);
  assert.equal(prompts.supported, true);
  assert.deepEqual(connections, ["target"]);
  await assert.rejects(hub.listResources("disabled"), { code: "MCP_SERVER_DISABLED" });
  assert.equal(hub.clients.has("other"), false);
});

test("mounted executor results redact actual bound input values in text and metadata", async () => {
  const registry = createToolRegistry();
  const hub = new McpHub({ toolRegistry: registry });
  hub.setInputValue("credential", "a-private-value-without-token-prefix");
  const client = { callTool: async () => ({ content: [{ type: "text", text: "value=a-private-value-without-token-prefix" }], structuredContent: { echoed: "a-private-value-without-token-prefix", "a-private-value-without-token-prefix": 1 } }) };
  hub._mountTools("s", [{ name: "lookup" }], client, {});
  const result = await createToolExecutor({ registry, permissionEngine: createPermissionEngine() }).execute({ id: "c", name: "mcp__s__lookup", params: {} });
  assert.equal(result.metadata.structuredContent.echoed, "[REDACTED]");
  assert.equal(result.content[0].text, "value=[REDACTED]");
  assert.equal(JSON.stringify(result).includes("a-private-value-without-token-prefix"), false, "secret-valued property names must also be scrubbed");
});

test("RPC failures are redacted before executor events and public direct API rejection", async () => {
  const registry = createToolRegistry();
  const hub = new McpHub({ toolRegistry: registry });
  const secret = "private-credential-without-recognizable-prefix";
  hub.setInputValue("key", secret);
  const client = { getStatus: () => "CONNECTED", callTool: async () => {
    const error = new Error(`Unauthorized credential ${secret}`);
    error.code = -32001;
    error.data = { leaked: secret };
    throw error;
  } };
  hub.clients.set("s", client);
  hub._mountTools("s", [{ name: "lookup" }], client, {});
  const events = [];
  const executor = createToolExecutor({ registry, permissionEngine: createPermissionEngine(), eventBus: { publish: (type, data) => events.push({ type, data }) } });
  const result = await executor.execute({ id: "c", name: "mcp__s__lookup", params: {} });
  assert.equal(result.status, "error");
  assert.equal(result.metadata.errorCode, -32001);
  assert.equal(JSON.stringify(events).includes(secret), false);
  for (const method of ["callTool", "callToolDetailed"]) {
    await assert.rejects(hub[method]("mcp__s__lookup"), (error) => {
      assert.equal(error.code, -32001);
      assert.equal(error.message.includes(secret), false);
      assert.equal(error.data, undefined);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

test("list_changed dispatches by capability without remounting tools for resources/prompts", async () => {
  const hub = new McpHub();
  const client = hub._createClient("r", { command: "unused" });
  const changed = [];
  hub.on("resources_changed", (event) => changed.push(["resources", event.serverId]));
  hub.on("prompts_changed", (event) => changed.push(["prompts", event.serverId]));
  hub._remountTools = async (serverId) => changed.push(["tools", serverId]);
  client.emit("list_changed", { method: "notifications/resources/list_changed" });
  client.emit("list_changed", { method: "notifications/prompts/list_changed" });
  client.emit("list_changed", { method: "notifications/tools/list_changed" });
  assert.deepEqual(changed, [["resources", "r"], ["prompts", "r"], ["tools", "r"]]);
  await hub.stopAll();
});
