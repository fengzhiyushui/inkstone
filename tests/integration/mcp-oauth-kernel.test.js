import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { createKernel } from "../../src/index.js";
import { McpHub } from "../../src/tools/mcp/mcp-hub.js";
import { createToolRegistry } from "../../src/tools/registry.js";
import { createMcpDisplayRedactor } from "../../src/security/mcp-content.js";
import { normalizeServerConfig } from "../../src/tools/mcp/config-loader.js";
import { createMockOAuthServer } from "../helpers/mcp-oauth-server.js";
import { mkdtemp } from "../helpers/tmp.js";
import { runMcpAuth } from "../../src/apps/cli/mcp-auth.js";

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
