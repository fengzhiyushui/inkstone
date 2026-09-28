import test from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { McpHub } from "../../src/tools/mcp/mcp-hub.js";
import { createToolRegistry } from "../../src/tools/registry.js";

test("McpHub initializes enabled servers, mounts tools to registry, and skips disabled", async () => {
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
        if (msg.method === 'initialize') {
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
  }, /'command' string is required/);

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
