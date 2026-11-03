// tests/unit/mcp/mcp-hub-and-registry.test.js — MCP Hub 与工具注册表领域测试
//
// v1.19.1 测试归并:本文件由下列历史任务单测试合并而成,每个来源包裹在独立
// describe 块中(异步回调 + 动态 import,来源间零共享绑定),测试语义与拆分前一致。
import { describe } from "node:test";

// ---------------------------------------------------------------------------
// 来源:tests/unit/mcp-hub.test.js
// ---------------------------------------------------------------------------
describe("unit/mcp-hub", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { default: process } = await import("node:process");
  const { default: http } = await import("node:http");
  const { once } = await import("node:events");
  const { McpHub } = await import("../../../src/tools/mcp/mcp-hub.js");
  const { createToolRegistry } = await import("../../../src/tools/registry.js");
  const { createPermissionEngine } = await import("../../../src/tools/permissions/permission-engine.js");
  const { createPolicyContext } = await import("../../../src/tools/permissions/policy-loader.js");

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
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/mcp-hub-v114.test.js
// ---------------------------------------------------------------------------
describe("unit/mcp-hub-v114", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { McpHub } = await import("../../../src/tools/mcp/mcp-hub.js");
  const { normalizeServerConfig } = await import("../../../src/tools/mcp/config-loader.js");
  const { asPolicy } = await import("../../../src/tools/mcp/tool-policy.js");
  const { createToolRegistry } = await import("../../../src/tools/registry.js");
  const { createToolExecutor } = await import("../../../src/tools/executor.js");
  const { createPermissionEngine } = await import("../../../src/tools/permissions/permission-engine.js");

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
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/mcp-subscriptions-hub.test.js
// ---------------------------------------------------------------------------
describe("unit/mcp-subscriptions-hub", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { default: http } = await import("node:http");
  const { once } = await import("node:events");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { mkdtemp } = await import("../../helpers/tmp.js");
  const { McpHub } = await import("../../../src/tools/mcp/mcp-hub.js");
  const { createToolRegistry } = await import("../../../src/tools/registry.js");
  const { META_KEYS } = await import("../../../src/tools/mcp/protocol.js");

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
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/mcp-tool-registry.test.js
// ---------------------------------------------------------------------------
describe("unit/mcp-tool-registry", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createToolRegistry } = await import("../../../src/tools/registry.js");
  const { formatExternalToolName, mcpToolToDeepSeekSchema } = await import("../../../src/tools/mcp/schema-converter.js");

  test("ToolRegistry dynamic mounting and unmounting of external tools", () => {
    const registry = createToolRegistry();

    const externalTool = {
      name: "mcp__pg__query",
      description: "[MCP: pg] Run SQL",
      category: "read",
      source: "mcp",
      serverId: "pg",
      originalName: "query",
      rawFunctionSchema: {
        type: "function",
        function: {
          name: "mcp__pg__query",
          description: "[MCP: pg] Run SQL",
          parameters: { type: "object", properties: { sql: { type: "string" } } }
        }
      },
      execute: async (params) => `Executed: ${params.sql}`
    };

    assert.equal(registry.isExternalTool("mcp__pg__query"), true);
    assert.equal(registry.isExternalTool("read"), false);

    // Mount
    registry.mountExternalTools("pg", [externalTool]);

    const resolved = registry.resolve("mcp__pg__query");
    assert.ok(resolved);
    assert.equal(resolved.name, "mcp__pg__query");

    // DeepSeek tools schema export
    const dsTools = registry.toDeepSeekTools();
    assert.equal(dsTools.length, 1);
    assert.equal(dsTools[0].type, "function");
    assert.equal(dsTools[0].function.name, "mcp__pg__query");
    assert.deepEqual(dsTools[0].function.parameters.properties.sql, { type: "string" });

    // Unmount
    registry.unmountExternalTools("pg");
    assert.equal(registry.resolve("mcp__pg__query"), null);
    assert.equal(registry.toDeepSeekTools().length, 0);
  });

  test("ToolRegistry normalizeParams handles MCP tools without throwing for arbitrary params", () => {
    const registry = createToolRegistry();

    const externalTool = {
      name: "mcp__custom__action",
      description: "Custom",
      category: "mutate",
      source: "mcp",
      rawFunctionSchema: {
        type: "function",
        function: { name: "mcp__custom__action", parameters: {} }
      },
      execute: async () => "ok"
    };

    registry.mountExternalTools("custom", [externalTool]);

    const normalized = registry.normalizeParams("mcp__custom__action", {
      arbitraryField1: 123,
      nested: { a: "b" }
    });

    assert.deepEqual(normalized, { arbitraryField1: 123, nested: { a: "b" } });
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/mcp-kernel-integration.test.js
// ---------------------------------------------------------------------------
describe("unit/mcp-kernel-integration", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { default: process } = await import("node:process");
  const { rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { createKernel } = await import("../../../src/index.js");
  const { mkdtemp } = await import("../../helpers/tmp.js");

  test("createKernel integrates McpHub, exposes kernel.mcp facet, and cleans up on dispose", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "inkstone-mcp-kernel-"));

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
              result: { serverInfo: { name: 'kernel-mock' }, capabilities: {} }
            }) + '\\n');
          } else if (msg.method === 'tools/list') {
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: {
                tools: [
                  {
                    name: 'calc_multiply',
                    description: 'Multiplies two numbers',
                    inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } }
                  }
                ]
              }
            }) + '\\n');
          } else if (msg.method === 'tools/call') {
            const a = Number(msg.params?.arguments?.a || 0);
            const b = Number(msg.params?.arguments?.b || 0);
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: {
                content: [{ type: 'text', text: String(a * b) }],
                isError: false
              }
            }) + '\\n');
          }
        } catch (e) {}
      });
    `;

    const kernel = await createKernel(root, {
      deepseek: { apiKey: "test-dummy-key" },
      mcpServers: {
        math: {
          command: process.execPath,
          args: ["-e", mockServerScript],
          autoApprove: ["calc_multiply"]
        }
      }
    });

    try {
      assert.ok(kernel.mcp, "Kernel must expose mcp facet");

      const servers = kernel.mcp.listServers();
      assert.equal(servers.length, 1);
      assert.equal(servers[0].serverId, "math");
      assert.equal(servers[0].status, "CONNECTED");
      assert.equal(servers[0].toolCount, 1);

      // Call tool directly via kernel.mcp.callTool
      const directResult = await kernel.mcp.callTool("mcp__math__calc_multiply", { a: 6, b: 7 });
      assert.equal(directResult, "42");

      // Check that tool is registered in kernel tools
      const resolvedTool = kernel.tools.registry.resolve("mcp__math__calc_multiply");
      assert.ok(resolvedTool);
      assert.equal(resolvedTool.autoApprove, true);

      const execResult = await resolvedTool.execute({ a: 8, b: 9 });
      assert.equal(execResult.status, "success");
      assert.deepEqual(execResult.content, [{ type: "text", text: "72" }]);
    } finally {
      await kernel.dispose();
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });
});
