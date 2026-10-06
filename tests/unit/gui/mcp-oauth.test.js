import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { buildMcpOAuthConfig, createMcpAuthController, subscribeMcpAuthChanges } from "../../../gui/src/state/mcp-oauth.js";
import { translate } from "../../../gui/src/i18n/strings.js";

const require = createRequire(import.meta.url);
const { createKernelHost } = require("../../../gui/kernel-host.js");
const { safeAuthorizationUrl, publicAuthStatus } = require("../../../gui/mcp-oauth.js");
const read = (file) => readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8");

async function oauthHost(mcp, openMcpAuthorization) {
  const host = createKernelHost({ projectRoot: "/repo", configLoader: async () => ({}), openMcpAuthorization,
    kernelFactory: async () => ({ mcp, session: { subscribe: () => ({ unsubscribe() {} }) } }) });
  await host.init();
  return host;
}

test("OAuth host opens browser in main and exposes only public status over IPC", async () => {
  const opened = [];
  const calls = [];
  let status = "unauthenticated";
  const details = () => ({ status, issuer: "https://auth.example", expiresAt: 1893456000000,
    access_token: "access-secret", refresh_token: "refresh-secret", code_verifier: "pkce-secret",
    message: "provider response access-secret", authorizationUrl: "https://auth.example/authorize?state=state-secret&code_challenge=pkce-secret" });
  const host = await oauthHost({
    getAuthStatus: async (id) => { calls.push(["get", id]); return details(); },
    startAuth: async (id) => { calls.push(["start", id]); status = "pending"; return details(); },
    cancelAuth: async (id) => { calls.push(["cancel", id]); status = "unauthenticated"; },
    logoutAuth: async (id) => { calls.push(["logout", id]); status = "unauthenticated"; }
  }, async (url) => opened.push(url));
  const pending = await host.startMcpAuth("remote");
  assert.deepEqual(pending, { status: "pending", issuer: "https://auth.example/", expiresAt: 1893456000000 });
  assert.equal(opened.length, 1);
  assert.match(opened[0], /state=state-secret/);
  assert.doesNotMatch(JSON.stringify(pending), /secret|authorizationUrl|token|message/);
  status = "authenticated";
  assert.equal((await host.getMcpAuthStatus("remote")).status, "authenticated");
  assert.equal((await host.cancelMcpAuth("remote")).status, "unauthenticated");
  assert.equal((await host.logoutMcpAuth("remote")).status, "unauthenticated");
  assert.ok(calls.some(([method, id]) => method === "logout" && id === "remote"));
  await host.getMcpAuthStatus("remote.with.dots");
  assert.deepEqual(calls.at(-1), ["get", "remote.with.dots"]);
});

test("OAuth browser rejects non-web schemes and credential-bearing URLs", () => {
  for (const url of ["file:///C:/Windows/system32/cmd.exe", "javascript:alert(1)", "ms-settings:privacy", "http://auth.example/authorize",
    "https://user:password@auth.example/authorize", "https://auth.example/#access_token=secret", "not a url"]) {
    assert.throws(() => safeAuthorizationUrl(url), /OAuth authorization URL/);
  }
  for (const url of ["https://auth.example/authorize", "http://127.0.0.1:1234/authorize", "http://localhost:1234/authorize", "http://[::1]:1234/authorize"]) {
    assert.equal(safeAuthorizationUrl(url), url);
  }
  assert.deepEqual(publicAuthStatus({ status: "authenticated", issuer: "https://auth.example/?access_token=secret", expiresAt: "secret" }), { status: "authenticated" });
});

test("OAuth failed browser opening cancels pending flow and masks provider errors", async () => {
  let cancelled = 0;
  let opened = 0;
  const mcp = { startAuth: async () => ({ status: "pending", authorizationUrl: "file:///secret" }), cancelAuth: async () => cancelled++ };
  const host = await oauthHost(mcp, async () => { opened++; });
  await assert.rejects(host.startMcpAuth("srv"), { message: "MCP OAuth operation failed" });
  assert.equal(cancelled, 1);
  assert.equal(opened, 0);
  mcp.startAuth = async () => { throw new Error("provider failed with refresh_token=secret"); };
  await assert.rejects(host.startMcpAuth("srv"), (error) => !/secret|refresh_token/.test(error.message));
  mcp.startAuth = async () => ({ status: "pending", authorizationUrl: "https://auth.example/authorize" });
  const blocked = await oauthHost(mcp, async () => { throw new Error("OS error code=secret"); });
  await assert.rejects(blocked.startMcpAuth("srv"), { message: "MCP OAuth operation failed" });
  assert.equal(cancelled, 2);
});

test("OAuth preload channels are dedicated operations without renderer-controlled URLs", async () => {
  let bridge;
  const calls = [];
  vm.runInNewContext(read("gui/preload.js"), { require: () => ({ contextBridge: { exposeInMainWorld: (_name, api) => { bridge = api; } },
    ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve({ status: "pending" }); } } }) });
  const main = read("gui/main.js");
  for (const [method, channel] of Object.entries({ getMcpAuthStatus: "mcp:auth-status", startMcpAuth: "mcp:auth-start",
    cancelMcpAuth: "mcp:auth-cancel", logoutMcpAuth: "mcp:auth-logout" })) {
    await bridge[method]("srv", "file:///untrusted");
    assert.deepEqual(calls.at(-1), [channel, "srv"]);
    assert.ok(main.includes(`handle("${channel}"`));
    assert.ok(main.slice(0, main.indexOf("function cleanupSmoke")).includes(`"${channel}"`));
    assert.ok(read("gui/src/hooks/useKernel.js").includes(`${method}:`));
  }
  assert.equal(bridge.openExternal, undefined);
});

test("OAuth form preserves static headers by default and detects OAuth Authorization conflicts", () => {
  assert.deepEqual(buildMcpOAuthConfig(false, "", "", { Authorization: "Bearer old" }), {});
  assert.deepEqual(buildMcpOAuthConfig(true, " https://app.example/client.json ", "tools:read tools:write,tools:read"),
    { oauth: { enabled: true, clientId: "https://app.example/client.json", scopes: ["tools:read", "tools:write"] } });
  assert.deepEqual(buildMcpOAuthConfig(true), { oauth: { enabled: true } });
  assert.throws(() => buildMcpOAuthConfig(true, "", "", { aUthorization: "Bearer old" }), /authorization-header/);
});

test("OAuth UI polls pending login until success and stops its timer after logout", async () => {
  const timers = new Map();
  let sequence = 0;
  let current = { status: "pending" };
  let changed = 0;
  const states = [];
  const controller = createMcpAuthController({ serverId: "srv", onState: (value) => states.push(value), onChanged: () => changed++,
    schedule: (fn) => { const id = ++sequence; timers.set(id, fn); return id; }, unschedule: (id) => timers.delete(id),
    kernel: { startMcpAuth: async () => ({ status: "pending" }), getMcpAuthStatus: async () => current,
      logoutMcpAuth: async () => ({ status: "unauthenticated" }) } });
  await controller.run("startMcpAuth");
  assert.equal(states.at(-1).status, "pending");
  assert.equal(timers.size, 1);
  current = { status: "authenticated" };
  const poll = [...timers.values()][0];
  poll();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(states.at(-1).status, "authenticated");
  assert.equal(timers.size, 0);
  assert.equal(changed, 1);
  await controller.run("logoutMcpAuth");
  assert.equal(states.at(-1).status, "unauthenticated");
  assert.equal(changed, 2);
  controller.dispose();
});

test("OAuth UI cancellation and unmount discard stale status requests", async () => {
  let resolveStatus;
  const states = [];
  const kernel = { getMcpAuthStatus: () => new Promise((resolve) => { resolveStatus = resolve; }),
    cancelMcpAuth: async () => ({ status: "unauthenticated" }) };
  const controller = createMcpAuthController({ kernel, serverId: "srv", initialStatus: "pending", onState: (value) => states.push(value) });
  const stale = controller.refresh();
  await controller.run("cancelMcpAuth");
  resolveStatus({ status: "authenticated" });
  await stale;
  assert.equal(states.at(-1).status, "unauthenticated");
  const late = controller.refresh();
  const before = states.length;
  controller.dispose();
  resolveStatus({ status: "authenticated" });
  await late;
  assert.equal(states.length, before);
});

test("OAuth UI IPC errors stop polling and show translated recovery guidance", async () => {
  let state;
  const controller = createMcpAuthController({ kernel: { startMcpAuth: async () => ({ error: "unsafe provider details" }) },
    serverId: "srv", onState: (value) => { state = value; }, schedule: () => assert.fail("must not poll an IPC failure") });
  await controller.run("startMcpAuth");
  assert.deepEqual(state, { status: "error", busy: false });
  for (const lang of ["zh", "en"]) for (const key of ["login", "logout", "cancel", "errorHint", "clientHint", "browserHint", "pending", "authenticated"]) {
    assert.notEqual(translate(lang, `mcp.oauth.${key}`), `mcp.oauth.${key}`);
  }
  controller.dispose();
});

test("OAuth UI refreshes tools after the completed reconnect event and unsubscribes on unmount", () => {
  let listener;
  let changes = 0;
  let removed = false;
  const unsubscribe = subscribeMcpAuthChanges({ onKernelEvent: (handler) => {
    listener = handler;
    return () => { removed = true; };
  } }, () => changes++);
  listener({ type: "mcp:auth_status", status: "pending" });
  listener({ type: "agent:final" });
  assert.equal(changes, 0);
  listener({ type: "mcp:auth_status", status: "authenticated" });
  listener({ type: "mcp:auth_required" });
  assert.equal(changes, 2);
  unsubscribe();
  assert.equal(removed, true);
  assert.doesNotThrow(() => subscribeMcpAuthChanges(null, () => {})());
});
