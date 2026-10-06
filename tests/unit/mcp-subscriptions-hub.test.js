import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "../helpers/tmp.js";
import { McpHub } from "../../src/tools/mcp/mcp-hub.js";
import { createToolRegistry } from "../../src/tools/registry.js";
import { META_KEYS } from "../../src/tools/mcp/protocol.js";

async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("MCP subscription integration condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function fixture(t, enabled) {
  const calls = [], streams = [];
  let version = 1;
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const frame = JSON.parse(Buffer.concat(chunks));
    calls.push(frame);
    const reply = (result) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }));
    };
    switch (frame.method) {
      case "server/discover":
        reply({ supportedVersions: ["2026-07-28"], capabilities: { tools: { listChanged: true }, resources: { listChanged: true }, prompts: { listChanged: true } } });
        break;
      case "subscriptions/listen": {
        const stream = { response, id: frame.id, closed: false };
        streams.push(stream);
        response.on("close", () => { stream.closed = true; });
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/subscriptions/acknowledged", params: { notifications: frame.params.notifications, _meta: { [META_KEYS.SUBSCRIPTION_ID]: frame.id } } })}\n\n`);
        break;
      }
      case "tools/list": reply({ tools: [{ name: `read_${version}`, inputSchema: { type: "object", properties: {} } }] }); break;
      case "resources/list": reply({ resources: [{ uri: `file:///version-${version}`, name: `resource-${version}` }], ttlMs: 60000 }); break;
      case "prompts/list": reply({ prompts: [{ name: `prompt-${version}` }], ttlMs: 60000 }); break;
      default: reply({ content: [] });
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const registry = createToolRegistry();
  const hub = new McpHub({ cwd: await mkdtemp(join(tmpdir(), "mcp-subscription-hub-")), toolRegistry: registry, config: { mcpServers: { remote: {
    url: `http://127.0.0.1:${server.address().port}/mcp`, type: "streamable-http", allowlist: ["127.0.0.1"], subscriptions: { enabled }
  } } } });
  t.after(async () => {
    await hub.stopAll();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    hub, registry, calls, streams,
    changeVersion(next) { version = next; },
    notify(kind) {
      const stream = streams.at(-1);
      stream.response.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: `notifications/${kind}/list_changed`, params: { _meta: { [META_KEYS.SUBSCRIPTION_ID]: stream.id } } })}\n\n`);
    }
  };
}

test("Hub default subscription config does not open streams despite advertised listChanged capabilities", async (t) => {
  const { hub, streams, registry } = await fixture(t, false);
  const result = await hub.initAll();
  assert.equal(result[0].status, "CONNECTED");
  assert.ok(registry.resolve("mcp__remote__read_1"));
  assert.equal(streams.length, 0);
});

test("Hub opt-in subscriptions remount tools, invalidate resources/prompts and cleanly restart after disable", async (t) => {
  const { hub, registry, calls, streams, changeVersion, notify } = await fixture(t, true);
  const statuses = [];
  hub.on("subscription_status", (event) => statuses.push(event));
  await hub.initAll();
  await until(() => statuses.some((event) => event.status === "active"));
  assert.equal(streams.length, 1);
  assert.ok(statuses.every((event) => event.serverId === "remote"));
  assert.ok(registry.resolve("mcp__remote__read_1"));
  assert.equal((await hub.listResources("remote")).resources[0].name, "resource-1");
  assert.equal((await hub.listPrompts("remote")).prompts[0].name, "prompt-1");
  await hub.listResources("remote"); await hub.listPrompts("remote");
  assert.equal(calls.filter((frame) => frame.method === "resources/list").length, 1);
  assert.equal(calls.filter((frame) => frame.method === "prompts/list").length, 1);
  changeVersion(2);
  const toolsChanged = once(hub, "tools_changed"), resourcesChanged = once(hub, "resources_changed"), promptsChanged = once(hub, "prompts_changed");
  notify("tools"); notify("resources"); notify("prompts");
  await Promise.all([toolsChanged, resourcesChanged, promptsChanged]);
  assert.equal(registry.resolve("mcp__remote__read_1"), null);
  assert.ok(registry.resolve("mcp__remote__read_2"));
  assert.equal((await hub.listResources("remote")).resources[0].name, "resource-2");
  assert.equal((await hub.listPrompts("remote")).prompts[0].name, "prompt-2");
  await hub.toggleServer("remote", false);
  await until(() => streams[0].closed);
  assert.equal(registry.resolve("mcp__remote__read_2"), null);
  assert.equal(hub.getServer("remote").rpc.getPendingCount(), 0);
  assert.equal(calls.filter((frame) => frame.method === "subscriptions/listen").length, 1);
  await hub.toggleServer("remote", true);
  await until(() => statuses.filter((event) => event.status === "active").length === 2);
  assert.equal(streams.length, 2);
  assert.ok(registry.resolve("mcp__remote__read_2"));
  await hub.removeServer("remote");
  await until(() => streams[1].closed);
  assert.equal(hub.getServer("remote"), null);
  assert.equal(registry.resolve("mcp__remote__read_2"), null);
});
