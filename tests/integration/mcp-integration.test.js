// tests/integration/mcp-integration.test.js — MCP 内核集成(内容/审批/OAuth/诊断试用/输入主机/取消)领域测试
//
// v1.19.1 测试归并:本文件由下列历史任务单测试合并而成,每个来源包裹在独立
// describe 块中(异步回调 + 动态 import,来源间零共享绑定),测试语义与拆分前一致。
import { describe } from "node:test";

// ---------------------------------------------------------------------------
// 来源:tests/integration/mcp-content-kernel.test.js
// ---------------------------------------------------------------------------
describe("integration/mcp-content-kernel", async () => {

  // Real stdio transport and kernel/runtime, with a local deterministic model.
  // No model API, remote MCP endpoint or user credentials are used.

  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { default: path } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { createKernel } = await import("../../src/index.js");
  const { mkdtemp } = await import("../helpers/tmp.js");

  const secret = "fixture-private-value-76342";
  const serverScript = `
    const rl = require('readline').createInterface({ input: process.stdin });
    rl.on('line', line => {
      const msg = JSON.parse(line);
      if (msg.id === undefined) return;
      if (msg.method === 'resources/read' && msg.params.uri === 'memory://error') {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Resource failed: ${secret}' } }) + '\\n');
        return;
      }
      let result;
      switch (msg.method) {
        case 'server/discover': result = { era: 'modern', supportedVersions: ['2026-07-28'], capabilities: { resources: {}, prompts: {} } }; break;
        case 'resources/list': result = { resources: [{ uri: 'memory://sprint', name: 'Sprint plan' }] }; break;
        case 'resources/read': result = { contents: [{ uri: msg.params.uri, text: 'RESOURCE_PROOF: finish E1-E6; ${secret}' }] }; break;
        case 'templates/list': result = { resourceTemplates: [{ uriTemplate: 'memory://{name}', name: 'Plans' }] }; break;
        case 'prompts/list': result = { prompts: [{ name: 'review', arguments: [{ name: 'topic', required: true }] }] }; break;
        case 'prompts/get': result = { messages: [{ role: 'system', content: { type: 'text', text: 'PROMPT_PROOF: review ' + msg.params.arguments.topic } }] }; break;
        default: process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Unexpected request: ' + msg.method } }) + '\\n'); return;
      }
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
    });
  `;

  test("MCP resource and prompt content reaches the model through tool messages with capability lifecycle and redaction", async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "inkstone-mcp-content-"));
    let invocation = 0;
    const kernel = await createKernel(root, {
      sessionLog: null, mcpPolicyStore: null,
      orchestration: { router: { model: { enabled: false } } },
      mcpServers: { content: { command: process.execPath, args: ["-e", serverScript], env: { API_TOKEN: secret } } },
      modelGateway: {
        invoke: async (messages, options) => {
          invocation++;
          assert.ok(options.tools.some((tool) => tool.function.name === "mcp_resources"));
          assert.ok(options.tools.some((tool) => tool.function.name === "mcp_prompts"));
          const call = (id, name, args) => ({ content: "", tool_calls: [{ id, name, arguments: args }] });
          if (invocation === 1) return call("list", "mcp_resources", { server: "content" });
          const resultText = messages.filter((msg) => msg.role === "tool").map((msg) => msg.content).join("\n");
          if (invocation === 2) {
            assert.match(resultText, /memory:\/\/sprint/);
            return call("read", "mcp_resources", { server: "content", action: "read", uri: "memory://sprint" });
          }
          assert.match(resultText, /RESOURCE_PROOF/);
          assert.ok(!resultText.includes(secret));
          assert.match(resultText, /REDACTED/);
          if (invocation === 3) return call("prompt", "mcp_prompts", { server: "content", action: "get", name: "review", arguments: { topic: "E1-E6" } });
          assert.match(resultText, /PROMPT_PROOF: review E1-E6/);
          assert.ok(messages.filter((msg) => msg.role === "system").every((msg) => !String(msg.content).includes("PROMPT_PROOF")), "external prompt roles must remain quoted tool data");
          return { content: "Verified resource and prompt context", tool_calls: [] };
        },
        reply: async () => ({ content: "offline" })
      }
    });
    t.after(() => kernel.dispose());
    assert.equal(kernel.mcp.listServers()[0].status, "CONNECTED", "resources-only server must not probe tools/list");
    const result = await kernel.agent.send("Read the sprint resource and its review prompt", { autonomy: "read-only" });
    assert.equal(result.status, "complete");
    assert.equal(invocation, 4);
    assert.equal((await kernel.mcp.listResourceTemplates("content")).resourceTemplates.length, 1);
    assert.equal((await kernel.mcp.listPrompts("content")).prompts[0].name, "review");

    const failure = await kernel.tools.execute({ id: "rpc-error", name: "mcp_resources", params: { server: "content", action: "read", uri: "memory://error" } }, { autonomy: "read-only" });
    assert.equal(failure.status, "error");
    assert.match(failure.content[0].text, /Resource failed/);
    assert.ok(!JSON.stringify(failure).includes(secret), "RPC errors must be scrubbed before ToolExecutor publishes them");

    const invalid = await kernel.tools.execute({ id: "invalid", name: "mcp_resources", params: { server: "unknown", action: "list" } }, { autonomy: "read-only" });
    assert.equal(invalid.status, "error");
    await kernel.mcp.toggleServer("content", false);
    assert.equal(kernel.tools.registry.resolve("mcp_resources"), null);
    assert.equal(kernel.tools.registry.resolve("mcp_prompts"), null);
    await assert.rejects(kernel.mcp.readResource("content", "memory://sprint"), /disabled/i);
    await kernel.mcp.toggleServer("content", true);
    assert.ok(kernel.tools.registry.resolve("mcp_resources"));
    await kernel.mcp.removeServer("content");
    assert.equal(kernel.tools.registry.resolve("mcp_resources"), null);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/integration/mcp-persistent-approval-kernel.test.js
// ---------------------------------------------------------------------------
describe("integration/mcp-persistent-approval-kernel", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { default: path } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { mkdir } = await import("node:fs/promises");
  const { createKernel } = await import("../../src/index.js");
  const { createPolicyStore } = await import("../../src/tools/mcp/tool-policy.js");
  const { mkdtemp } = await import("../helpers/tmp.js");

  const TOOL = "mcp__demo__update_record";

  async function makeKernel(root, userRoot, executions, extra = {}) {
    await mkdir(root, { recursive: true });
    let count = 0;
    const kernel = await createKernel(root, {
      sessionLog: null,
      mcpPolicyStore: createPolicyStore({ projectRoot: root, userRoot }),
      orchestration: { router: { model: { enabled: false } } },
      modelGateway: {
        invoke: async (messages) => ++count === 1
          ? { content: "", tool_calls: [{ id: "external_update", name: TOOL, arguments: { value: count } }] }
          : { content: "record updated", tool_calls: [] },
        reply: async () => ({ content: "offline" })
      },
      ...extra
    });
    kernel.tools.registry.register({
      name: TOOL, description: "Update a simulated external record", source: "mcp", category: "mutate",
      execute: async () => { executions.push("executed"); return { content: [{ type: "text", text: "updated" }] }; }
    });
    return kernel;
  }

  for (const scope of ["project", "always"]) {
    test(`MCP ${scope} approval survives a new kernel with a fresh approval cache`, async (t) => {
      const base = await mkdtemp(path.join(tmpdir(), "inkstone-mcp-approval-"));
      const root = path.join(base, "project"), userRoot = path.join(base, "user");
      const executions = [];
      const first = await makeKernel(root, userRoot, executions);
      t.after(() => first.dispose());
      const paused = await first.agent.send("inspect external record", { autonomy: "gated" });
      assert.equal(paused.status, "awaiting_approval");
      assert.equal(executions.length, 0);
      const completed = await first.agent.approve(paused.approval.id, "approve", { scope });
      assert.equal(completed.status, "complete");
      assert.equal(executions.length, 1);
      await first.dispose();

      const second = await makeKernel(root, userRoot, executions);
      t.after(() => second.dispose());
      const result = await second.agent.send("inspect external record", { autonomy: "gated", projectRules: [] });
      assert.equal(result.status, "complete");
      assert.equal(executions.length, 2, "normal runtime execution must consume persisted rules");
      const direct = await second.tools.execute({ id: "direct", name: TOOL, params: { value: 42 } }, { autonomy: "gated" });
      assert.equal(direct.status, "success", "the public tool executor must consume the same policy");
    });
  }

  test("session approval does not become persistent and destructive remains denied", async (t) => {
    const base = await mkdtemp(path.join(tmpdir(), "inkstone-mcp-session-"));
    const executions = [];
    const root = path.join(base, "project"), userRoot = path.join(base, "user");
    const first = await makeKernel(root, userRoot, executions);
    t.after(() => first.dispose());
    const paused = await first.agent.send("inspect external record", { autonomy: "gated" });
    await first.agent.approve(paused.approval.id, "approve", { scope: "session" });
    await first.dispose();
    const destructive = "mcp__demo__destroy_all";
    createPolicyStore({ projectRoot: root, userRoot }).grant(destructive, "project");
    const second = await makeKernel(root, userRoot, executions);
    t.after(() => second.dispose());
    const next = await second.agent.send("inspect external record", { autonomy: "gated" });
    assert.equal(next.status, "awaiting_approval");
    assert.equal(executions.length, 1);
    second.tools.registry.register({ name: destructive, description: "Forbidden operation", category: "destructive", source: "mcp", execute: () => { throw new Error("must not run"); } });
    const result = await second.tools.execute({ id: "denied", name: destructive, params: {} }, { autonomy: "full-auto" });
    assert.equal(result.status, "denied");
  });

  test("kernel exposes dynamic MCP add/remove on its public facade", async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "inkstone-mcp-facade-"));
    const kernel = await createKernel(root, { sessionLog: null, mcpPolicyStore: null });
    t.after(() => kernel.dispose());
    await kernel.mcp.addServer("local", { command: "unused", disabled: true }, { autoStart: false });
    assert.equal(kernel.mcp.listServers().length, 1);
    await kernel.mcp.removeServer("local");
    assert.equal(kernel.mcp.listServers().length, 0);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/integration/mcp-oauth-kernel.test.js
// ---------------------------------------------------------------------------
describe("integration/mcp-oauth-kernel", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { once } = await import("node:events");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { mkdir, readdir, readFile } = await import("node:fs/promises");
  const { createKernel } = await import("../../src/index.js");
  const { McpHub } = await import("../../src/tools/mcp/mcp-hub.js");
  const { createToolRegistry } = await import("../../src/tools/registry.js");
  const { createMcpDisplayRedactor } = await import("../../src/security/mcp-content.js");
  const { normalizeServerConfig } = await import("../../src/tools/mcp/config-loader.js");
  const { createMockOAuthServer } = await import("../helpers/mcp-oauth-server.js");
  const { mkdtemp } = await import("../helpers/tmp.js");
  const { runMcpAuth } = await import("../../src/apps/cli/mcp-auth.js");

  function mcpHandler(_req, res, body) {
    const message = JSON.parse(body);
    if (message.id === undefined) { res.writeHead(202); res.end(); return; }
    const result = message.method === "server/discover"
      ? { era: "modern", supportedVersions: ["2026-07-28"], capabilities: { tools: {}, resources: {} } }
      : message.method === "tools/list"
        ? { tools: [{ name: "read_secret", description: "Echo fixture", inputSchema: { type: "object", properties: {} } }] }
        : message.method === "tools/call"
          ? { content: [{ type: "text", text: "proof initial-access-secret rotated-access-secret" }] }
          : { resources: [{ uri: "fixture://example", name: "Example" }] };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  }

  test("OAuth kernel: login, remount, refresh, redaction, persisted restart and logout", { timeout: 20000 }, async (t) => {
    const mock = await createMockOAuthServer({ mcpHandler });
    t.after(() => mock.close());
    const base = await mkdtemp(join(tmpdir(), "inkstone-oauth-kernel-"));
    const root = join(base, "project");
    await mkdir(root);
    const credentials = join(base, "credentials");
    const options = {
      autoInitMcp: false, sessionLog: null, mcpPolicyStore: null,
      mcpOAuthCredentialRoot: credentials,
      mcpServers: { remote: { url: mock.resource, type: "streamable-http", allowlist: ["127.0.0.1"], oauth: { enabled: true, clientId: "public-client" }, timeoutMs: 5000 } }
    };
    const kernel = await createKernel(root, options);
    t.after(() => kernel.dispose());
    const events = [];
    kernel.eventBus.subscribe("mcp:auth_required", (event) => events.push(event));
    kernel.eventBus.subscribe("mcp:auth_status", (event) => events.push(event));
    await assert.rejects(kernel.mcp.restartServer("remote"), { code: "MCP_AUTH_REQUIRED" });
    assert.equal(kernel.mcp.listServers()[0].status, "AUTH_REQUIRED");
    assert.equal((await kernel.mcp.getAuthStatus("remote")).status, "unauthenticated");
    const pending = await kernel.mcp.startAuth("remote");
    const authorized = once(kernel.mcp.hub, "auth_status");
    assert.equal((await mock.authorize(pending.authorizationUrl)).status, 200);
    assert.equal((await authorized)[0].status, "authenticated");
    assert.equal(kernel.mcp.listServers()[0].status, "CONNECTED");
    assert.ok(kernel.tools.registry.resolve("mcp__remote__read_secret"));
    assert.ok(kernel.tools.registry.resolve("mcp_resources"));
    const cleanBeforeRefresh = createMcpDisplayRedactor({ hub: kernel.mcp.hub });
    mock.options.rejectInitialToken = true;
    const result = await kernel.mcp.callTool("mcp__remote__read_secret", {});
    assert.match(result, /proof/);
    assert.ok(!result.includes("initial-access-secret") && !result.includes("rotated-access-secret"));
    assert.equal(cleanBeforeRefresh("rotated-access-secret"), "[REDACTED]");
    assert.equal(mock.calls.filter((call) => call.path === "/token" && call.body.includes("grant_type=refresh_token")).length, 1);
    assert.ok(!JSON.stringify(events).includes("secret"));
    assert.ok(!JSON.stringify(kernel.mcp.listServers()).includes("access-secret"), "descriptions and errors are sanitized");
    for (const file of await readdir(credentials)) {
      const contents = await readFile(join(credentials, file));
      assert.ok(!contents.includes(Buffer.from("rotated-access-secret")));
    }
    await kernel.dispose();
    const restored = await createKernel(root, options);
    t.after(() => restored.dispose());
    assert.equal((await restored.mcp.getAuthStatus("remote")).status, "authenticated");
    await restored.mcp.restartServer("remote");
    assert.equal(restored.mcp.listServers()[0].status, "CONNECTED");
    await restored.mcp.logoutAuth("remote");
    assert.equal((await restored.mcp.getAuthStatus("remote")).status, "unauthenticated");
    assert.equal(restored.tools.registry.resolve("mcp__remote__read_secret"), null);
    assert.equal(restored.tools.registry.resolve("mcp_resources"), null);
  });

  test("OAuth HTTP challenge fallback and bounded retry do not publish raw unauthorized content", { timeout: 15000 }, async (t) => {
    const mock = await createMockOAuthServer({ mcpHandler, defaultMetadataMissing: true });
    t.after(() => mock.close());
    const root = await mkdtemp(join(tmpdir(), "inkstone-oauth-challenge-"));
    const hub = new McpHub({ cwd: root, oauthCredentialRoot: join(root, "credentials"), config: { mcpServers: {
      remote: { url: mock.resource, allowlist: ["127.0.0.1"], oauth: { enabled: true, clientId: "public-client" }, timeoutMs: 5000 }
    } } });
    t.after(() => hub.stopAll());
    await assert.rejects(hub.restartServer("remote"), { code: "MCP_AUTH_REQUIRED" });
    const pending = await hub.startAuth("remote");
    const ready = once(hub, "auth_status");
    await mock.authorize(pending.authorizationUrl);
    await ready;
    mock.options.rejectTokens = true;
    const before = mock.calls.filter((call) => call.path === "/mcp").length;
    const failed = hub.callTool("mcp__remote__read_secret");
    await assert.rejects(failed, { code: "MCP_AUTH_REQUIRED" });
    assert.equal(mock.calls.filter((call) => call.path === "/mcp").length - before, 2, "one authenticated retry only");
    assert.equal((await hub.getAuthStatus("remote")).status, "unauthenticated");
  });

  test("Fresh CLI login follows a 401 metadata challenge and preserves the browser state", { timeout: 10000 }, async (t) => {
    const mock = await createMockOAuthServer({ mcpHandler, defaultMetadataMissing: true });
    t.after(() => mock.close());
    const base = await mkdtemp(join(tmpdir(), "inkstone-oauth-cli-live-"));
    const root = join(base, "project");
    await mkdir(root);
    const output = [];
    const browser = [];
    const result = await runMcpAuth(root, ["auth", "remote"], new Map(), {
      createKernelImpl: createKernel,
      loadConfigImpl: async () => ({}),
      buildKernelOptionsImpl: async () => ({
        sessionLog: null, mcpPolicyStore: null, mcpOAuthCredentialRoot: join(base, "credentials"),
        mcpServers: { remote: { url: mock.resource, allowlist: ["127.0.0.1"], oauth: { enabled: true, clientId: "public-client" } } }
      }),
      write: (line) => {
        output.push(line);
        if (line.startsWith(mock.base + "/authorize")) browser.push(mock.authorize(line));
      },
      onSigint: () => () => {}
    });
    assert.equal(result.status, "authenticated");
    assert.equal((await browser[0]).status, 200);
    assert.ok(output.some((line) => line.includes("state=") && !line.includes("REDACTED")));
    assert.ok(!output.join("\n").includes("initial-access-secret"));
  });

  for (const action of ["stopAll", "removeServer", "logoutAuth", "disable"]) {
    test(`OAuth pending connection cannot resurrect tools after ${action}`, async () => {
      const registry = createToolRegistry();
      const hub = new McpHub({ toolRegistry: registry, config: { mcpServers: { s: { command: "unused" } } } });
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      let connected = 0;
      const client = { connect: async () => { connected++; }, disconnect: async () => {}, listTools: async () => [{ name: "read" }], getProtocolMode: () => "modern" };
      hub.clients.set("s", client);
      hub.oauthClients.set("s", { getAccessToken: () => gate, dispose() {}, cancelAuthorization() {} });
      const pending = hub._connectAndMount("s", client, hub.serverConfigs.get("s"));
      const rejected = assert.rejects(pending, { code: "MCP_CONNECTION_SUPERSEDED" });
      if (action === "disable") await hub.toggleServer("s", false);
      else await hub[action]("s");
      release(null);
      await rejected;
      assert.equal(connected, 0);
      assert.equal(registry.resolve("mcp__s__read"), null);
    });
  }

  test("OAuth tool list response after logout cannot remount stale tools", async () => {
    const registry = createToolRegistry();
    const hub = new McpHub({ toolRegistry: registry, config: { mcpServers: { s: { command: "unused" } } } });
    let release;
    const client = { disconnect: async () => {}, listTools: () => new Promise((resolve) => { release = resolve; }) };
    hub.clients.set("s", client);
    const pending = hub._remountTools("s", client);
    await hub.logoutAuth("s");
    release([{ name: "read" }]);
    await pending;
    assert.equal(registry.resolve("mcp__s__read"), null);
  });

  test("OAuth normalization preserves public settings while rejecting embedded credentials and invalid scopes", () => {
    const config = normalizeServerConfig("s", { url: "https://mcp.example/mcp", oauth: { enabled: true, clientId: "public", scopes: ["read", "read"], ignored: true } });
    assert.deepEqual(config.oauth, { enabled: true, clientId: "public", scopes: ["read"] });
    assert.throws(() => normalizeServerConfig("s", { command: "node", oauth: { enabled: true } }), /remote HTTP/);
    assert.throws(() => normalizeServerConfig("s", { url: "https://mcp.example/mcp", oauth: { enabled: true, clientSecret: "secret" } }), /cannot contain credentials/);
    assert.throws(() => normalizeServerConfig("s", { url: "https://mcp.example/mcp", oauth: { scopes: ["two scopes"] } }), /scope/);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/integration/mcp-diagnostics-trials.test.js
// ---------------------------------------------------------------------------
describe("integration/mcp-diagnostics-trials", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { default: path } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { readFile, readdir } = await import("node:fs/promises");
  const { createKernel } = await import("../../src/index.js");
  const { mkdtemp } = await import("../helpers/tmp.js");
  const { validateEvent } = await import("../../src/sessions/event-schemas.js");
  const { SESSION_EVENT_TYPES } = await import("../../src/sessions/event-types.js");

  const secret = "trial-private-token-18462";
  const script = `
  const rl = require('readline').createInterface({input:process.stdin});
  let writes = 0;
  rl.on('line', line => {
   const msg=JSON.parse(line); if(msg.id===undefined)return;
   let result;
   if(msg.method==='server/discover')result={era:'modern',supportedVersions:['2026-07-28'],capabilities:{tools:{}}};
   else if(msg.method==='tools/list')result={tools:['read_count','write_note','delete_all','read_wait'].map(name=>({name,description:name,inputSchema:{type:'object',properties:{text:{type:'string'},password:{type:'string'},nested:{type:'object',properties:{n:{type:'integer',minimum:1}},required:['n']}},additionalProperties:false}}))};
   else if(msg.method==='tools/call'){
    if(msg.params.name==='read_wait')return;
    if(msg.params.name==='write_note')writes++;
    result={content:[{type:'text',text:JSON.stringify({writes,args:msg.params.arguments,secret:'${secret}'})}]};
   } else return;
   process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result})+'\\n');
  });`;

  async function fixture(t, options = {}) {
    const root = await mkdtemp(path.join(tmpdir(), "inkstone-v116-"));
    const kernel = await createKernel(root, { sessionLog: null, mcpPolicyStore: null,
      mcpServers: { trial: { command: process.execPath, args: ["-e", script], env: { API_TOKEN: secret }, tools: { risk: { delete_all: "destructive" } } } },
      modelGateway: { invoke: async () => ({ content: "offline", tool_calls: [] }) }, ...options });
    t.after(() => kernel.dispose());
    return { kernel, root };
  }

  test("kernel trial validates nested schemas and binds approval to a cloned one-shot call", async (t) => {
    const { kernel } = await fixture(t);
    const events = [];
    const subscriptions = SESSION_EVENT_TYPES.map((type) => kernel.eventBus.subscribe(type, (event) => events.push({ type, ...event })));
    t.after(() => subscriptions.forEach((subscription) => subscription.unsubscribe()));
    const invalid = await kernel.mcp.startToolTest("trial", "write_note", { nested: { n: 0 } });
    assert.equal(invalid.status, "error");
    assert.match(invalid.content[0].text, /Invalid tool arguments/);
    const params = { text: "original", password: "trial-input-only-secret-92381" };
    const pending = kernel.mcp.startToolTest("trial", "write_note", params, { requestId: "test-once" });
    params.text = "changed";
    const ask = await pending;
    assert.equal(ask.status, "approval_required");
    assert.equal(ask.runId, "test-once");
    const approved = kernel.mcp.approveToolTest(ask.runId);
    assert.throws(() => kernel.mcp.approveToolTest(ask.runId), /No pending/);
    const result = await approved;
    assert.equal(result.status, "success");
    assert.match(result.content[0].text, /original/);
    assert.doesNotMatch(result.content[0].text, /changed/);
    assert.ok(!JSON.stringify(result).includes(secret));
    assert.ok(!JSON.stringify(result).includes("trial-input-only-secret-92381"), "approved results must still redact secrets from the original trial arguments");
    assert.ok(result.metadata.durationMs >= 0);
    assert.throws(() => kernel.mcp.startToolTest("trial", "write_note", {}, { requestId: "test-once" }), /duplicate/);
    assert.equal((await kernel.mcp.startToolTest("trial", "write_note", {})).status, "approval_required", "approval must not persist");
    const denied = await kernel.mcp.startToolTest("trial", "delete_all", {});
    assert.equal(denied.status, "denied");
    assert.throws(() => kernel.mcp.approveToolTest(denied.runId), /No pending/);
    assert.ok(events.some((event) => event.type === "mcp:tool_test"));
    assert.ok(events.every((event) => !event.type.startsWith("approval:")), "standalone trials must not pause the agent conversation");
    for (const event of events.filter((event) => event.type.startsWith("mcp:"))) assert.deepEqual(validateEvent(event.type, event).errors, []);
  });

  test("kernel trial cancellation aborts in-flight RPC and history is readable by a fresh offline kernel", async (t) => {
    const { kernel, root } = await fixture(t);
    const pending = kernel.mcp.startToolTest("trial", "read_wait", {}, { requestId: "cancel-me" });
    // Wait for actual send, so this tests transport cancellation rather than just preflight.
    const deadline = Date.now() + 2000;
    while (!kernel.mcp.getLogs("trial", { method: "tools/call" }).entries.some((entry) => entry.direction === "out")) {
      assert.ok(Date.now() < deadline); await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const cancelled = kernel.mcp.cancelToolTest("cancel-me");
    assert.equal(cancelled.cancelled, true);
    assert.equal((await pending).status, "cancelled");
    assert.equal(kernel.mcp.listServers()[0].status, "CONNECTED");
    assert.equal((await kernel.mcp.startToolTest("trial", "read_count", {})).status, "success");
    assert.ok(kernel.mcp.getLogs("trial", { category: "cancelled" }).entries.length > 0);
    await kernel.dispose();
    const offline = await createKernel(root, { sessionLog: null, mcpPolicyStore: null, autoInitMcp: false,
      mcpServers: { trial: { command: "THIS-MUST-NOT-START" } },
      modelGateway: { invoke: async () => ({ content: "offline", tool_calls: [] }) } });
    t.after(() => offline.dispose());
    assert.equal(offline.mcp.hub.clients.size, 0);
    const logs = offline.mcp.getLogs("trial", { limit: 500 });
    assert.ok(logs.entries.some((entry) => entry.kind === "request" && entry.durationMs >= 0));
    assert.ok(!offline.mcp.exportLogs().includes(secret));
    const directory = path.join(root, ".deepseek-code", "mcp-logs");
    for (const file of await readdir(directory)) assert.ok(!(await readFile(path.join(directory, file), "utf8")).includes(secret));
  });

  test("pending trial approvals expire on server lifecycle changes", async (t) => {
    const { kernel } = await fixture(t);
    let pending = await kernel.mcp.startToolTest("trial", "write_note", {});
    const name = (await kernel.mcp.listTools("trial")).find((tool) => tool.originalName === "write_note").name;
    // A replaced registry definition must invalidate the secured call.
    const old = kernel.tools.registry.resolve(name);
    kernel.tools.registry.mountExternalTools("trial", [{ ...old }]);
    assert.equal((await kernel.mcp.approveToolTest(pending.runId)).status, "error");
    await kernel.mcp.restartServer("trial");
    pending = await kernel.mcp.startToolTest("trial", "write_note", {});
    await kernel.mcp.toggleServer("trial", false);
    assert.throws(() => kernel.mcp.approveToolTest(pending.runId), /No pending/);
    assert.deepEqual(await kernel.mcp.listTools("trial"), []);
    const stopped = await kernel.mcp.startToolTest("trial", "write_note", {}, { approved: true });
    assert.equal(stopped.status, "error");
  });

  test("trial approval rechecks current configured denies and cannot authorize unrelated tools", async (t) => {
    const rules = [];
    const { kernel } = await fixture(t, { projectRules: rules });
    const pending = await kernel.mcp.startToolTest("trial", "write_note", {});
    assert.equal(pending.status, "approval_required");
    const tools = await kernel.mcp.listTools("trial");
    const name = tools.find((tool) => tool.originalName === "write_note").name;
    rules.push({ id: "deny-trial-write", tool: name, decision: "deny" });
    const denied = await kernel.mcp.approveToolTest(pending.runId);
    assert.equal(denied.status, "denied");
    assert.equal((await kernel.mcp.startToolTest("trial", "write_note", {}, { approved: true })).status, "denied");
    assert.equal((await kernel.mcp.startToolTest("trial", "read_file", {})).status, "error");
    const count = await kernel.mcp.startToolTest("trial", "read_count", {});
    assert.match(count.content[0].text, /"writes":0/);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/integration/mcp-input-host.test.js
// ---------------------------------------------------------------------------
describe("integration/mcp-input-host", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { default: path } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { createRequire } = await import("node:module");
  const { createKernel } = await import("../../src/index.js");
  const { validateEvent } = await import("../../src/sessions/event-schemas.js");
  const { mkdtemp } = await import("../helpers/tmp.js");

  const require = createRequire(import.meta.url);
  const { createKernelHost } = require("../../gui/kernel-host.js");
  const answer = "human-only-value-783291";
  const opaque = "opaque-server-continuation-912836";
  const scriptFor = (expectedAnswer) => `
  const rl = require('node:readline').createInterface({ input: process.stdin });
  let continuations = 0;
  const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
  rl.on('line', line => {
   const msg = JSON.parse(line); if (msg.id === undefined) return;
   if (msg.method === 'server/discover') return send(msg.id, { era: 'modern', supportedVersions: ['2026-07-28'], capabilities: { tools: {} } });
   if (msg.method === 'tools/list') return send(msg.id, { tools: ['read_form', 'read_stats'].map(name => ({ name, inputSchema: { type: 'object', properties: { query: { type: 'string' } } } })) });
   if (msg.method !== 'tools/call') return;
   if (msg.params.name === 'read_stats') return send(msg.id, { content: [{ type: 'text', text: JSON.stringify({ continuations }) }] });
   if (!msg.params.inputResponses) return send(msg.id, {
     resultType: 'input_required', requestState: '${opaque}', inputRequests: {
       form: { method: 'elicitation/create', params: { message: 'Enter a name for this read operation',
         requestedSchema: { type: 'object', properties: { name: { type: 'string', minLength: 1 } }, required: ['name'] } } }
     }
   });
   continuations++;
   const response = msg.params.inputResponses.form;
   send(msg.id, { content: [{ type: 'text', text: JSON.stringify({ continuations,
     valid: msg.params.requestState === '${opaque}' && response.action === 'accept' && response.content.name === ${JSON.stringify(expectedAnswer)} && msg.params.arguments.query === 'original',
     echo: response.content?.name || '' }) }] });
  });`;

  async function fixture(t, expectedAnswer = answer) {
    const root = await mkdtemp(path.join(tmpdir(), "inkstone-mcp-input-host-"));
    const events = [];
    const modelMessages = [];
    let invocation = 0;
    const host = createKernelHost({ projectRoot: root, projectRegistryDir: path.join(root, "registry"),
      configLoader: async () => ({}), kernelFactory: createKernel, pushEvent: (event) => events.push(event),
      kernelOptions: { sessionLog: null, mcpPolicyStore: null, loadMcpConfigScopes: false,
        orchestration: { router: { model: { enabled: false } } },
        mcpServers: { input: { command: process.execPath, args: ["-e", scriptFor(expectedAnswer)], elicitation: { enabled: true },
          tools: { risk: { read_form: "read", read_stats: "read" } } } },
        modelGateway: {
          invoke: async (messages) => {
            modelMessages.push(structuredClone(messages));
            if (++invocation === 1) return { content: "", tool_calls: [{ id: "request-input", name: "mcp__input__read_form", arguments: { query: "original" } }] };
            return { content: "Input operation completed", tool_calls: [] };
          }, reply: async () => ({ content: "offline" })
        }
      }
    });
    const kernel = await host.init();
    t.after(async () => { host.dispose(); await kernel.dispose(); });
    return { host, kernel, events, modelMessages };
  }

  async function pendingInput(host) {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const requests = await host.listMcpInputRequests();
      if (requests.length) return requests[0];
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail("MCP tool did not expose a pending input form through the GUI host");
  }

  function assertPrivate(events, kernel, privateAnswer = answer) {
    const serialized = JSON.stringify(events);
    for (const value of [privateAnswer, JSON.stringify(privateAnswer).slice(1, -1), opaque, '"requestState"', '"inputResponses"']) {
      assert.ok(!serialized.includes(value), `private MCP data leaked through session events: ${value}`);
      assert.ok(!kernel.mcp.exportLogs().includes(value), `private MCP data leaked through diagnostics: ${value}`);
    }
    for (const event of events.filter((item) => item.type.startsWith("mcp:"))) assert.deepEqual(validateEvent(event.type, event).errors, []);
  }

  for (const [label, privateAnswer] of [["plain", answer], ["JSON-escaped", 'quoted"answer\\with\nnewline']]) {
  test(`actual GUI host answers an ordinary agent MCP call once without exposing its ${label} input`, { timeout: 15000 }, async (t) => {
    const { host, kernel, events, modelMessages } = await fixture(t, privateAnswer);
    let finished = false;
    const operation = kernel.agent.send("Read the remote record", { autonomy: "read-only" });
    operation.then(() => { finished = true; }, () => { finished = true; });
    const request = await pendingInput(host);
    assert.equal(finished, false);
    assert.equal(request.serverId, "input");
    assert.equal(request.method, "elicitation/create");
    assert.equal(request.requestedSchema.properties.name.type, "string");
    assert.ok(!JSON.stringify(request).includes(opaque));
    await assert.rejects(host.respondMcpInputRequest(request.requestId, { action: "accept", content: { name: 42 } }));
    assert.equal((await host.listMcpInputRequests()).length, 1, "invalid answers must not consume the pending form");
    const responses = await Promise.allSettled([
      host.respondMcpInputRequest(request.requestId, { action: "accept", content: { name: privateAnswer } }),
      host.respondMcpInputRequest(request.requestId, { action: "accept", content: { name: "duplicate" } })
    ]);
    assert.equal(responses.filter((item) => item.status === "fulfilled" && item.value.status === "accepted").length, 1);
    assert.equal((await operation).status, "complete");
    assert.deepEqual(await host.listMcpInputRequests(), []);
    const toolText = modelMessages.flat().filter((message) => message.role === "tool").map((message) => message.content).join("\n");
    const toolResults = modelMessages.flat().filter((message) => message.role === "tool").map((message) => JSON.parse(JSON.parse(message.content).text));
    assert.ok(toolResults.some((result) => result.continuations === 1 && result.valid === true));
    assert.ok(!toolText.includes(privateAnswer), "input responses must not be copied into the model's tool messages");
    assert.ok(toolResults.every((result) => result.echo !== privateAnswer), "JSON-escaped answers must be redacted before serialization");
    assert.ok(events.some((event) => event.type === "mcp:input_required"));
    assert.ok(events.some((event) => event.type === "mcp:input_resolved" && event.status === "accepted"));
    assertPrivate(events, kernel, privateAnswer);
  });
  }

  test("GUI trial cancellation removes its pending input without continuing or disconnecting the MCP server", { timeout: 15000 }, async (t) => {
    const { host, kernel, events } = await fixture(t);
    const runId = "cancel-pending-input";
    const operation = host.startMcpToolTest("input", "read_form", { query: "original" }, { requestId: runId });
    operation.catch(() => {}); // Keep fixture cleanup from creating an unhandled rejection if polling fails.
    const request = await pendingInput(host);
    assert.equal((await host.cancelMcpToolTest(runId)).cancelled, true);
    assert.equal((await operation).status, "cancelled");
    assert.deepEqual(await host.listMcpInputRequests(), []);
    const late = await Promise.allSettled([host.respondMcpInputRequest(request.requestId, { action: "accept", content: { name: answer } })]);
    assert.ok(late[0].status === "rejected" || late[0].value.status !== "accepted");
    const stats = await host.startMcpToolTest("input", "read_stats", {}, { requestId: "stats-after-cancel" });
    assert.equal(stats.status, "success");
    assert.match(stats.content[0].text, /"continuations":0/);
    assert.equal(kernel.mcp.listServers()[0].status, "CONNECTED");
    assert.ok(events.some((event) => event.type === "mcp:input_resolved" && event.status === "cancelled"));
    assertPrivate(events, kernel);
  });

  test("kernel shutdown immediately invalidates an ordinary GUI input form before asynchronous cleanup", { timeout: 15000 }, async (t) => {
    const { host, kernel, events } = await fixture(t);
    const operation = kernel.tools.execute({ id: "shutdown-input", name: "mcp__input__read_form", params: { query: "original" } }, { autonomy: "read-only" });
    operation.catch(() => {});
    const request = await pendingInput(host);
    const closing = kernel.dispose();
    // Exercise the synchronous shutdown boundary before any flush promise yields.
    const late = kernel.mcp.respondInputRequest(request.requestId, { action: "accept", content: { name: answer } });
    assert.notEqual(late.status, "accepted");
    assert.deepEqual(kernel.mcp.listInputRequests(), []);
    assert.equal((await operation).status, "error");
    await closing;
    assert.ok(events.some((event) => event.type === "mcp:input_resolved" && event.status === "cancelled"));
    const outbound = kernel.mcp.getLogs("input", { method: "tools/call" }).entries.filter((entry) => entry.kind === "frame" && entry.direction === "out");
    assert.equal(outbound.length, 1, "shutdown must not authorize a continuation");
    assertPrivate(events, kernel);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/integration/mcp-runtime-cancel.test.js
// ---------------------------------------------------------------------------
describe("integration/mcp-runtime-cancel", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { default: path } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { createKernel } = await import("../../src/index.js");
  const { mkdtemp } = await import("../helpers/tmp.js");

  const script = `
  const rl=require('node:readline').createInterface({input:process.stdin});
  const held=new Set();
  const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
  rl.on('line',line=>{const m=JSON.parse(line);if(m.id==null)return;
   if(m.method==='server/discover')return send(m.id,{era:'modern',supportedVersions:['2026-07-28'],capabilities:{tools:{}}});
   // Under parallel test load the short era probe can fall back before this
   // child starts. Keep the cancellation fixture usable in both supported eras.
   if(m.method==='initialize')return send(m.id,{protocolVersion:'2025-11-25',serverInfo:{name:'cancel-fixture',version:'1'},capabilities:{tools:{}}});
   if(m.method==='tools/list')return send(m.id,{tools:['read_wait','write_wait','read_hold','read_release'].map(name=>({name,inputSchema:{type:'object'}}))});
   if(m.method==='tools/call'){
    if(m.params.name==='read_wait'||m.params.name==='write_wait')return;
    if(m.params.name==='read_hold'){held.add(m.id);return;}
    for(const id of held)send(id,{content:[{type:'text',text:'unrelated request finished'}]});
    held.clear();send(m.id,{content:[]});
   }
  });`;

  async function fixture(t, toolName = "read_wait") {
    const root = await mkdtemp(path.join(tmpdir(), "inkstone-runtime-cancel-"));
    let modelCalls = 0;
    const kernel = await createKernel(root, { sessionLog: null, mcpPolicyStore: null,
      mcpServers: { blocking: { command: process.execPath, args: ["-e", script], tools: {
        risk: { read_wait: "read", write_wait: "mutate", read_hold: "read", read_release: "read" }
      } } },
      modelGateway: {
        invoke: async () => {
          modelCalls++;
          return { content: "", tool_calls: [{ id: "agent-wait", name: `mcp__blocking__${toolName}`, arguments: {} }] };
        },
        reply: async () => ({ content: "new turn is usable" })
      }
    });
    t.after(() => kernel.dispose());
    return { kernel, client: kernel.mcp.hub.getServer("blocking"), modelCalls: () => modelCalls };
  }

  function whenSent(client, name) {
    return new Promise((resolve) => {
      const listener = ({ direction, frame }) => {
        if (direction !== "out" || frame.method !== "tools/call" || frame.params.name !== name) return;
        client.removeListener("trace", listener);
        resolve(frame);
      };
      client.on("trace", listener);
    });
  }

  for (const resumed of [false, true]) {
    test(`agent interrupt cancels real stdio MCP ${resumed ? "after approval resume" : "during execution"}, preserving another request`, { timeout: 10_000 }, async (t) => {
      const name = resumed ? "write_wait" : "read_wait";
      const { kernel, client, modelCalls } = await fixture(t, name);
      const heldSent = whenSent(client, "read_hold");
      const unrelated = kernel.mcp.callTool("mcp__blocking__read_hold", {});
      await heldSent;
      const waitingSent = whenSent(client, name);
      let operation;
      if (resumed) {
        const paused = await kernel.agent.send("inspect remote data", { autonomy: "supervised" });
        assert.equal(paused.status, "awaiting_approval");
        operation = kernel.agent.approve(paused.approval.id, "approve");
      } else operation = kernel.agent.send("inspect remote data", { autonomy: "supervised" });
      const rejected = assert.rejects(operation, { code: "INTERRUPTED" });
      const frame = await waitingSent;
      assert.equal(client.rpc.getPendingCount(), 2);
      kernel.agent.interrupt();
      // Start a new turn before the cancelled promise finishes unwinding.
      const next = kernel.agent.send("what is a request?");
      await rejected;
      assert.equal((await next).status, "complete");
      assert.equal(client.rpc.getPendingCount(), 1);
      assert.equal(client.getStatus(), "CONNECTED");
      assert.equal(modelCalls(), 1, "interruption must stop before another model call");
      const completion = kernel.mcp.getLogs("blocking", { method: "tools/call", category: "cancelled" }).entries;
      assert.ok(completion.some((entry) => entry.requestId === String(frame.id)));
      await kernel.mcp.callTool("mcp__blocking__read_release", {});
      assert.match(await unrelated, /unrelated request finished/);
      assert.equal(client.rpc.getPendingCount(), 0);
    });
  }

  test("public kernel.tools.execute forwards caller cancellation into actual MCP RPC", { timeout: 10_000 }, async (t) => {
    const { kernel, client } = await fixture(t);
    const controller = new AbortController();
    const sent = whenSent(client, "read_wait");
    const operation = kernel.tools.execute({ id: "public-tool", name: "mcp__blocking__read_wait", params: {} }, {
      signal: controller.signal, toolTimeoutMs: 5000
    });
    await sent;
    controller.abort(new Error("public caller stopped"));
    const result = await operation;
    assert.equal(result.status, "error");
    assert.match(result.content[0].text, /public caller stopped/);
    assert.equal(client.rpc.getPendingCount(), 0);
    assert.equal(client.getStatus(), "CONNECTED");
  });
});
