import test from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import http from "node:http";
import { once } from "node:events";
import { McpHub } from "../../src/tools/mcp/mcp-hub.js";
import { createToolRegistry } from "../../src/tools/registry.js";

test("McpHub initializes enabled servers, mounts tools to registry, and skips disabled", async () => {
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
            result: { serverInfo: { name: 'hub-mock' }, capabilities: {} }
          }) + '\\n');
        } else if (msg.method === 'tools/list') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              tools: [
                {
                  name: 'get_weather',
                  description: 'Gets current weather',
                  inputSchema: { type: 'object', properties: { city: { type: 'string' } } }
                }
              ]
            }
          }) + '\\n');
        } else if (msg.method === 'tools/call') {
          const city = msg.params?.arguments?.city || 'unknown';
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              content: [{ type: 'text', text: 'Sunny in ' + city }],
              isError: false
            }
          }) + '\\n');
        }
      } catch (e) {}
    });
  `;

  const config = {
    mcpServers: {
      weather: {
        command: process.execPath,
        args: ["-e", mockServerScript],
        autoApprove: ["get_weather"],
        disabled: false
      },
      disabledServer: {
        command: "invalid-binary-that-should-not-run",
        disabled: true
      }
    }
  };

  const registry = createToolRegistry();
  const hub = new McpHub({ config, toolRegistry: registry });

  const initResults = await hub.initAll();
  assert.equal(initResults.length, 2);

  const weatherResult = initResults.find((r) => r.serverId === "weather");
  assert.equal(weatherResult.status, "CONNECTED");
  assert.equal(weatherResult.toolCount, 1);

  const disabledResult = initResults.find((r) => r.serverId === "disabledServer");
  assert.equal(disabledResult.status, "DISABLED");

  // Check registry has mounted the tool
  const mountedTool = registry.resolve("mcp__weather__get_weather");
  assert.ok(mountedTool, "Tool must be mounted in registry");
  assert.equal(mountedTool.category, "read");
  assert.equal(mountedTool.autoApprove, true);

  // Execute through registry
  const execOutput = await mountedTool.execute({ city: "Beijing" });
  assert.equal(execOutput, "Sunny in Beijing");

  // List servers
  const serverList = hub.listServers();
  assert.equal(serverList.length, 2);
  const srv = serverList.find((s) => s.serverId === "weather");
  assert.equal(srv.status, "CONNECTED");
  assert.equal(srv.toolCount, 1);

  // Stop all
  await hub.stopAll();
  assert.equal(registry.resolve("mcp__weather__get_weather"), null);
});

test("McpHub.addServer and removeServer support dynamic hot-plugging", async () => {
  const mockDynamicScript = `
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
            result: { serverInfo: { name: 'dynamic-mock' } }
          }) + '\\n');
        } else if (msg.method === 'tools/list') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              tools: [
                {
                  name: 'dynamic_tool',
                  description: 'A dynamically added tool',
                  inputSchema: { type: 'object', properties: { q: { type: 'string' } } }
                }
              ]
            }
          }) + '\\n');
        }
      } catch (e) {}
    });
  `;

  const registry = createToolRegistry();
  const hub = new McpHub({ config: {}, toolRegistry: registry });

  // Test validation
  await assert.rejects(async () => {
    await hub.addServer("bad id with spaces!", { command: "node" });
  }, /Invalid MCP server ID/);

  await assert.rejects(async () => {
    await hub.addServer("valid_id", { command: "" });
  }, /'command' or 'url' is required/);

  // Dynamically add server
  const addRes = await hub.addServer("dynamic_srv", {
    command: process.execPath,
    args: ["-e", mockDynamicScript],
    autoApprove: ["dynamic_tool"]
  });

  assert.equal(addRes.status, "CONNECTED");
  assert.equal(addRes.toolCount, 1);

  // Verify tool is mounted in ToolRegistry immediately
  const tool = registry.resolve("mcp__dynamic_srv__dynamic_tool");
  assert.ok(tool, "Dynamic tool should be mounted in registry");
  assert.equal(tool.autoApprove, true);

  // Verify listServers includes dynamic_srv
  const servers = hub.listServers();
  assert.equal(servers.length, 1);
  assert.equal(servers[0].serverId, "dynamic_srv");

  // Dynamically remove server
  const removeRes = await hub.removeServer("dynamic_srv");
  assert.equal(removeRes.ok, true);
  assert.equal(removeRes.serverId, "dynamic_srv");

  // Verify tool is unmounted immediately
  assert.equal(registry.resolve("mcp__dynamic_srv__dynamic_tool"), null);
  assert.equal(hub.listServers().length, 0);

  // Removing non-existent server returns notFound
  const notFoundRes = await hub.removeServer("non_existent");
  assert.equal(notFoundRes.ok, false);
  assert.equal(notFoundRes.notFound, true);
});

// ── v1.12.0:远程 Streamable HTTP 服务经 hub 装配工具 ────────────────────────
test("McpHub 连接远程 Streamable HTTP 服务并挂载工具", async () => {
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const msg = JSON.parse(body);
      const send = (p) => {
        const t = JSON.stringify(p);
        res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(t) });
        res.end(t);
      };
      if (msg.id === undefined) { res.writeHead(202); res.end(); return; }
      if (msg.method === "server/discover") {
        send({ jsonrpc: "2.0", id: msg.id, result: { era: "modern", protocolVersion: "2026-07-28", supportedVersions: ["2026-07-28"], serverInfo: { name: "hub-remote" }, capabilities: {} } });
      } else if (msg.method === "tools/list") {
        send({
          jsonrpc: "2.0", id: msg.id,
          result: {
            tools: [{
              name: "remote_echo",
              description: "Echo from remote hub mock",
              inputSchema: { type: "object", properties: { text: { type: "string" } } }
            }]
          }
        });
      } else if (msg.method === "tools/call") {
        send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `echo:${msg.params?.arguments?.text ?? ""}` }] } });
      } else {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "nf" } });
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/mcp`;

  const registry = createToolRegistry();
  const hub = new McpHub({
    config: { mcpServers: { remote: { url, type: "streamable-http", allowlist: ["127.0.0.1"] } } },
    toolRegistry: registry
  });

  try {
    const results = await hub.initAll();
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "CONNECTED", JSON.stringify(results[0]));
    assert.equal(results[0].toolCount, 1);

    // 工具以 mcp__<server>__<tool> 命名空间挂进注册表
    const tool = registry.resolve("mcp__remote__remote_echo");
    assert.ok(tool, "远程工具应挂载到注册表");
    assert.equal(tool.source, "mcp");

    // 直接经 hub 调用,验证请求真的发出去了
    const echoed = await hub.callTool("mcp__remote__remote_echo", { text: "hi" });
    assert.equal(echoed, "echo:hi");

    // listServers 暴露远程元信息
    const servers = hub.listServers();
    assert.equal(servers[0].url, url);
    assert.equal(servers[0].type, "streamable-http");
    assert.equal(servers[0].protocolMode, "modern");
  } finally {
    await hub.stopAll();
    await new Promise((r) => server.close(r));
  }
});
