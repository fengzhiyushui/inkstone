import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { readFile } from "node:fs/promises";
import { runCli, runMcp } from "../../src/cli.js";
import { mkdtemp } from "../helpers/tmp.js";

function fixture() {
  const output = [], calls = [];
  let disposed = 0, removed = 0, clock = 100000, interrupt;
  const statuses = [{ status: "pending" }, { status: "authenticated", issuer: "https://auth.example", expiresAt: 200000,
    accessToken: "must-not-display", refreshToken: "must-not-display-refresh" }];
  const mcp = {
    hub: { inputs: { password: { value: "configured-secret" } }, oauthSecrets: new Set(["nonce"]) },
    startAuth: async (id) => {
      calls.push(["start", id]);
      return { status: "pending", authorizationUrl: "https://auth.example/authorize?state=nonce&code_challenge=challenge", expiresAt: 150000 };
    },
    getAuthStatus: async (id) => { calls.push(["status", id]); return statuses.shift() || { status: "pending" }; },
    cancelAuth: async (id) => { calls.push(["cancel", id]); },
    logoutAuth: async (id) => { calls.push(["logout", id]); }
  };
  const deps = {
    write: (value) => output.push(value), writeError: (value) => output.push(value),
    loadConfigImpl: async () => ({ apiKey: "test-api-secret", mcpServers: { remote: { url: "https://mcp.example", oauth: { enabled: true } } } }),
    buildKernelOptionsImpl: async () => ({ sentinel: true }),
    createKernelImpl: async (_root, options) => {
      assert.equal(options.autoInitMcp, false);
      assert.equal(options.sentinel, true);
      calls.push(["kernel", options]);
      return { mcp, dispose: async () => { disposed++; } };
    },
    now: () => clock,
    sleep: async (ms, signal) => { assert.equal(signal.aborted, false); clock += ms; },
    onSigint: (handler) => { interrupt = handler; return () => { removed++; }; }
  };
  return { deps, mcp, output, calls, statuses, disposed: () => disposed, removed: () => removed, interrupt: () => interrupt() };
}

test("CLI OAuth login waits for authentication and displays only safe status fields", async () => {
  const f = fixture();
  const result = await runMcp("/repo", ["auth", "remote"], new Map(), f.deps);
  assert.equal(result.status, "authenticated");
  assert.equal(result.issuer, "https://auth.example");
  assert.match(f.output.join("\n"), /https:\/\/auth.example\/authorize\?state=nonce&code_challenge=challenge/);
  assert.match(f.output.join("\n"), /已登录/);
  assert.doesNotMatch(JSON.stringify([result, f.output]), /must-not-display|configured-secret|test-api-secret/);
  assert.deepEqual(f.calls.filter(([action]) => action !== "kernel").map(([action]) => action), ["start", "status", "status"]);
  assert.equal(f.disposed(), 1);
  assert.equal(f.removed(), 1);
});

test("CLI OAuth status/logout/cancel never initiate authorization", async () => {
  for (const action of ["status", "logout", "cancel"]) {
    const f = fixture();
    f.statuses.splice(0, f.statuses.length, { status: "unauthenticated", refreshToken: "must-not-display" });
    await runCli(["mcp", "auth", "remote", action], { root: "/repo", mcp: f.deps });
    assert.deepEqual(f.calls.filter(([kind]) => kind !== "kernel"), [[action, "remote"]]);
    assert.doesNotMatch(f.output.join("\n"), /must-not-display/);
    assert.equal(f.disposed(), 1);
  }
});

test("CLI OAuth failure is redacted and cleans up pending callback resources", async () => {
  const f = fixture();
  f.statuses.splice(0, f.statuses.length, { status: "error", message: "denied configured-secret test-api-secret" });
  await assert.rejects(() => runMcp("/repo", ["auth", "remote"], new Map(), f.deps),
    (error) => error.message.includes("REDACTED") && !/configured-secret|test-api-secret/.test(error.message));
  assert.deepEqual(f.calls.at(-1), ["cancel", "remote"]);
  assert.equal(f.disposed(), 1);
  assert.equal(f.removed(), 1);
});

test("CLI OAuth timeout cancels the pending flow and disposes", async () => {
  const f = fixture();
  f.statuses.length = 0;
  await assert.rejects(() => runMcp("/repo", ["auth", "remote"], new Map([["timeout", "1000"]]), f.deps), /登录超时/);
  assert.deepEqual(f.calls.at(-1), ["cancel", "remote"]);
  assert.equal(f.disposed(), 1);
});

test("CLI OAuth Ctrl+C is cancellation rather than successful login", async () => {
  const f = fixture();
  f.deps.sleep = async () => { f.interrupt(); throw new Error("aborted"); };
  await assert.rejects(() => runMcp("/repo", ["auth", "remote"], new Map(), f.deps), /已取消登录/);
  assert.deepEqual(f.calls.at(-1), ["cancel", "remote"]);
  assert.doesNotMatch(f.output.join("\n"), /已登录/);
  assert.equal(f.disposed(), 1);
  assert.equal(f.removed(), 1);
});

test("CLI OAuth interrupts startup without leaking a callback listener", async () => {
  const f = fixture();
  const start = f.mcp.startAuth;
  f.mcp.startAuth = async (id) => { const pending = await start(id); f.interrupt(); return pending; };
  await assert.rejects(() => runMcp("/repo", ["auth", "remote"], new Map(), f.deps), /已取消登录/);
  assert.deepEqual(f.calls.at(-1), ["cancel", "remote"]);
  assert.equal(f.disposed(), 1);
});

test("CLI OAuth validates arguments before creating kernel state", async () => {
  const f = fixture();
  for (const [args, flags] of [
    [["auth"], []], [["auth", "bad id"], []], [["auth", "remote", "unknown"], []],
    [["auth", "remote", "status", "extra"], []], [["auth", "remote"], [["timeout", "0"]]],
    [["auth", "remote"], [["timeout", true]]]
  ]) await assert.rejects(() => runMcp("/repo", args, new Map(flags), f.deps));
  assert.equal(f.calls.length, 0);
});

test("CLI OAuth preserves loopback authorization URL and rejects unsafe browser addresses", async () => {
  for (const authorizationUrl of ["http://127.0.0.1:12345/authorize?state=nonce", "http://localhost:12345/authorize?state=nonce"]) {
    const f = fixture();
    f.mcp.startAuth = async () => ({ status: "pending", authorizationUrl });
    await runMcp("/repo", ["auth", "remote"], new Map(), f.deps);
    assert.ok(f.output.includes(authorizationUrl));
  }
  for (const authorizationUrl of ["javascript:alert(1)", "http://public.example/authorize", "https://user:password@example.com/authorize", "https://example.com/authorize#secret"]) {
    const f = fixture();
    f.mcp.startAuth = async () => ({ status: "pending", authorizationUrl });
    await assert.rejects(() => runMcp("/repo", ["auth", "remote"], new Map(), f.deps), /授权地址/);
    assert.ok(!f.output.includes(authorizationUrl));
    assert.deepEqual(f.calls.at(-1), ["cancel", "remote"]);
    assert.equal(f.disposed(), 1);
  }
});

test("CLI mcp check uses Hub authorization with temporary private allowlist and redacts output", async () => {
  const f = fixture();
  f.mcp.restartServer = async (id) => { f.calls.push(["restart", id]); };
  f.mcp.hub.getServer = () => ({ serverInfo: { name: "configured-secret", version: "1" }, getProtocolMode: () => "modern" });
  f.mcp.hub.serverTools = new Map([["remote", [{ name: "mcp__remote__ping", description: "test-api-secret" }]]]);
  await runMcp("/repo", ["check", "remote"], new Map([["allow-private", "127.0.0.1"]]), f.deps);
  const options = f.calls.find(([kind]) => kind === "kernel")[1];
  assert.deepEqual(options.mcpServers.remote.oauth, { enabled: true });
  assert.deepEqual(options.mcpServers.remote.allowlist, ["127.0.0.1"]);
  assert.deepEqual(f.calls.at(-1), ["restart", "remote"]);
  assert.match(f.output.join("\n"), /连接成功|ping/);
  assert.doesNotMatch(f.output.join("\n"), /configured-secret|test-api-secret/);
  assert.equal(f.disposed(), 1);
});

async function withIsolatedHome(run) {
  const previous = process.env.DEEPSEEK_CODE_HOME;
  process.env.DEEPSEEK_CODE_HOME = await mkdtemp(path.join(tmpdir(), "mcp-cli-auth-home-"));
  try { return await run(); }
  finally {
    if (previous === undefined) delete process.env.DEEPSEEK_CODE_HOME;
    else process.env.DEEPSEEK_CODE_HOME = previous;
  }
}

test("CLI mcp add writes only public OAuth configuration", async () => {
  await withIsolatedHome(async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mcp-cli-auth-project-"));
    const original = console.log;
    console.log = () => {};
    try {
      await runCli(["mcp", "add", "remote", "--url", "https://mcp.example", "--oauth", "--client-id", "public-client", "--scopes", "mcp:read,mcp:write mcp:read"], { root });
    } finally { console.log = original; }
    const saved = JSON.parse(await readFile(path.join(root, ".deepseek-code", "config.json"), "utf8"));
    assert.deepEqual(saved.mcpServers.remote.oauth, { enabled: true, clientId: "public-client", scopes: ["mcp:read", "mcp:write"] });
  });
});

test("CLI mcp add rejects OAuth secrets, stdio OAuth and invalid public options", async () => {
  const f = fixture();
  for (const flags of [
    [["command", "npx"], ["oauth", true]],
    [["url", "https://mcp.example"], ["client-id", "public-client"]],
    [["url", "https://mcp.example"], ["oauth", true], ["client-secret", "never-save"]],
    [["url", "https://mcp.example"], ["oauth", true], ["client-id", true]],
    [["url", "https://mcp.example"], ["oauth", true], ["scopes", true]],
    [["url", "https://mcp.example"], ["oauth", true], ["scopes", 'bad"scope']]
  ]) await assert.rejects(() => runMcp("/repo", ["add", "remote"], new Map(flags), f.deps));
});
