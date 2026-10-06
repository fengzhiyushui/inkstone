import test from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import http from "node:http";
import { once } from "node:events";
import { McpHub } from "../../src/tools/mcp/mcp-hub.js";
import { createToolRegistry } from "../../src/tools/registry.js";
import { createPermissionEngine } from "../../src/tools/permissions/permission-engine.js";
import { createPolicyContext } from "../../src/tools/permissions/policy-loader.js";

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
  assert.equal(execOutput.status, "success");
  assert.deepEqual(execOutput.content, [{ type: "text", text: "Sunny in Beijing" }]);

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

// ── v1.13.0:annotations 与信任模型的真实挂载行为 ───────────────────────────
/** 返回一个带 annotations 的 stdio mock 配置(含只读/写/破坏性/无标注四种工具)。 */
function annotatedMockConfig() {
  const mockServerScript = `
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.method === 'server/discover') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } }) + '\\n');
        } else if (msg.method === 'initialize') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'anno-mock' }, capabilities: {} } }) + '\\n');
        } else if (msg.method === 'tools/list') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
            tools: [
              { name: 'delete_file', description: 'Deletes a file from disk',
                inputSchema: { type: 'object', properties: {} },
                annotations: { readOnlyHint: true } },
              { name: 'lookup_doc', description: 'Reads a document',
                inputSchema: { type: 'object', properties: {} },
                annotations: { readOnlyHint: true } },
              { name: 'wipe_all', description: 'Wipes everything',
                inputSchema: { type: 'object', properties: {} },
                annotations: { destructiveHint: true, openWorldHint: true } },
              { name: 'run_cleanup', description: 'Runs a routine cleanup task',
                inputSchema: { type: 'object', properties: {} },
                annotations: { destructiveHint: true } },
              { name: 'quiet_tool', description: 'No annotations here',
                inputSchema: { type: 'object', properties: {} } }
            ]
          } }) + '\\n');
        } else if (msg.method === 'tools/call') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'ok' }] } }) + '\\n');
        }
      } catch (e) {}
    });
  `;
  return { command: process.execPath, args: ["-e", mockServerScript] };
}

test("D2 信任模型:不受信 server 的 annotations 不得把 delete_file 讲成只读", async () => {
  const registry = createToolRegistry();
  const hub = new McpHub({
    config: { mcpServers: { s1: { ...annotatedMockConfig() } } },
    toolRegistry: registry
  });

  try {
    await hub.initAll();
    const tools = hub.listServers()[0].tools;

    const deleteTool = tools.find((t) => t.originalName === "delete_file");
    assert.equal(deleteTool.category, "mutate", "不受信:readOnlyHint 被忽略,按关键词判为写操作");
    assert.equal(deleteTool.riskSource, "keyword-untrusted");
    assert.equal(deleteTool.serverTrusted, false);

    const lookup = tools.find((t) => t.originalName === "lookup_doc");
    assert.equal(lookup.category, "read", "名称本身是只读语义");
  } finally {
    await hub.stopAll();
  }
});

test("D2 信任模型:受信 server 的 annotations 生效,只读可自动放行", async () => {
  const registry = createToolRegistry();
  const hub = new McpHub({
    config: {
      mcpServers: {
        s1: { ...annotatedMockConfig(), trust: true, autoApprove: ["delete_file", "lookup_doc"] }
      }
    },
    toolRegistry: registry
  });

  try {
    await hub.initAll();
    const tools = hub.listServers()[0].tools;

    const lookup = tools.find((t) => t.originalName === "lookup_doc");
    assert.equal(lookup.category, "read");
    assert.equal(lookup.riskSource, "annotations");
    assert.deepEqual(lookup.riskEscalatedBy, ["readOnlyHint"]);
    assert.equal(lookup.autoApprove, true, "只读 + 配置允许 → 自动放行");

    const deleteTool = tools.find((t) => t.originalName === "delete_file");
    assert.equal(deleteTool.category, "mutate", "关键词已判定写操作,readOnlyHint 不得降级");
    assert.deepEqual(deleteTool.riskEscalatedBy, [], "不得记录降级");

    const wipe = tools.find((t) => t.originalName === "wipe_all");
    assert.equal(wipe.category, "destructive");
    assert.equal(wipe.autoApprove, false, "破坏性工具永不自动放行");
    assert.deepEqual(wipe.badge, { level: "danger", label: "破坏性" });
    // 名称/描述已含 wipe/purge 等破坏性关键词 —— TOCTOU:关键词兜底已判 destructive,
    // 此时 destructiveHint 是"确认"而非"升级",故 escalatedBy 为空。
    assert.deepEqual(wipe.riskEscalatedBy, []);

    // 换个无害命名的工具,destructiveHint 本身成为决定性信号
    const cleanup = tools.find((t) => t.originalName === "run_cleanup");
    assert.equal(cleanup.category, "destructive");
    assert.deepEqual(cleanup.riskEscalatedBy, ["destructiveHint"]);
    assert.equal(cleanup.autoApprove, false);
  } finally {
    await hub.stopAll();
  }
});

test("D4 端到端:destructive 工具经引擎必然 deny(autoApprove 也不放行)", async () => {
  const registry = createToolRegistry();
  const hub = new McpHub({
    config: {
      mcpServers: {
        s1: { ...annotatedMockConfig(), trust: true, autoApprove: ["wipe_all", "lookup_doc"] }
      }
    },
    toolRegistry: registry
  });
  const engine = createPermissionEngine();

  try {
    await hub.initAll();
    const secured = registry.secureToolCall({ id: "c1", name: "mcp__s1__wipe_all", params: {} });
    assert.equal(secured.category, "destructive");

    const result = engine.decide(secured, createPolicyContext({ autonomy: "full-auto" }));
    assert.equal(result.decision, "deny");
    assert.equal(result.source, "safety-invariant");
  } finally {
    await hub.stopAll();
  }
});

test("D5 工具开关:disabled / enabled 白名单都不得挂载未列出的工具", async () => {  const registry = createToolRegistry();
  const base = annotatedMockConfig();

  const denyHub = new McpHub({
    config: { mcpServers: { s1: { ...base, trust: true, tools: { disabled: ["quiet_tool"] } } } },
    toolRegistry: registry
  });
  try {
    await denyHub.initAll();
    const names = denyHub.listServers()[0].tools.map((t) => t.originalName);
    assert.equal(names.includes("quiet_tool"), false, "被禁用的工具不得挂载");
    assert.equal(names.includes("lookup_doc"), true);
    assert.equal(registry.resolve("mcp__s1__quiet_tool"), null);
  } finally {
    await denyHub.stopAll();
  }

  const allowHub = new McpHub({
    config: { mcpServers: { s2: { ...base, trust: true, tools: { enabled: ["lookup_doc"] } } } },
    toolRegistry: registry
  });
  try {
    await allowHub.initAll();
    const allowNames = allowHub.listServers()[0].tools.map((t) => t.originalName);
    assert.deepEqual(allowNames, ["lookup_doc"], "白名单模式只挂列出的工具");
  } finally {
    await allowHub.stopAll();
  }
});

// ── v1.13.1:回归修复与用户逃生阀 ───────────────────────────────────────────
test("回归:autoApprove 恢复 v1.11.0 语义 —— 不看类别,列入即放行", async () => {
  // v1.13.0 曾错误收紧为"仅 read",导致存量 `autoApprove: ["write_file"]`
  // 升级后每次都要重新审批(无声行为回退)。
  const registry = createToolRegistry();
  const hub = new McpHub({
    config: {
      mcpServers: {
        s1: { ...annotatedMockConfig(), autoApprove: ["lookup_doc", "delete_file", "wipe_all"] }
      }
    },
    toolRegistry: registry
  });

  try {
    await hub.initAll();
    const tools = hub.listServers()[0].tools;
    const byName = (n) => tools.find((t) => t.originalName === n);

    assert.equal(byName("lookup_doc").autoApprove, true, "只读工具照旧放行");
    assert.equal(byName("delete_file").autoApprove, true, "mutate 工具也必须放行(v1.11.0 行为)");
    // destructive 的 autoApprove 仍为 true(配置层面),但引擎会硬拒绝 —— 双保险
    assert.equal(byName("wipe_all").autoApprove, true);
  } finally {
    await hub.stopAll();
  }
});

test("回归:autoApprove 不含的工具不受影响;列表不自动带 autoApprove", async () => {
  const registry = createToolRegistry();
  const hub = new McpHub({
    config: { mcpServers: { s1: { ...annotatedMockConfig(), autoApprove: ["lookup_doc"] } } },
    toolRegistry: registry
  });
  try {
    await hub.initAll();
    const tools = hub.listServers()[0].tools;
    assert.equal(tools.find((t) => t.originalName === "lookup_doc").autoApprove, true);
    assert.equal(tools.find((t) => t.originalName === "quiet_tool").autoApprove, false);
  } finally {
    await hub.stopAll();
  }
});

test("逃生阀:tools.risk 可让用户显式覆盖风险等级", async () => {
  const registry = createToolRegistry();
  const hub = new McpHub({
    config: {
      mcpServers: {
        s1: { ...annotatedMockConfig(), tools: { risk: { delete_file: "read", wipe_all: "mutate" } } }
      }
    },
    toolRegistry: registry
  });

  try {
    await hub.initAll();
    const tools = hub.listServers()[0].tools;
    const byName = (n) => tools.find((t) => t.originalName === n);

    // 关键词/annotations 判定为 mutate,用户手写降级为 read
    assert.equal(byName("delete_file").category, "read", "用户覆盖应生效");
    assert.equal(byName("delete_file").riskOverridden, true);
    assert.equal(byName("delete_file").riskOverride, "read");

    // destructive 也可由用户显式改写(有意决定),但会被记录
    assert.equal(byName("wipe_all").category, "mutate");
    assert.equal(byName("wipe_all").riskOverridden, true);

    // 未覆盖的工具保持原判定
    assert.equal(byName("lookup_doc").category, "read");
    assert.equal(byName("lookup_doc").riskOverridden, false);
  } finally {
    await hub.stopAll();
  }
});

test("逃生阀:tools.risk 的非法值被忽略,不破坏挂载", async () => {
  const registry = createToolRegistry();
  const hub = new McpHub({
    config: { mcpServers: { s1: { ...annotatedMockConfig(), tools: { risk: { delete_file: "bogus", lookup_doc: 42 } } } } },
    toolRegistry: registry
  });
  try {
    await hub.initAll();
    const tools = hub.listServers()[0].tools;
    assert.equal(tools.find((t) => t.originalName === "delete_file").category, "mutate", "非法值回落到原判定");
    assert.equal(tools.find((t) => t.originalName === "lookup_doc").category, "read");
  } finally {
    await hub.stopAll();
  }
});
