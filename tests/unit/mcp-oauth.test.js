import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, rm, stat, writeFile, copyFile } from "node:fs/promises";
import { mkdtemp } from "../helpers/tmp.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpOAuthClient } from "../../src/tools/mcp/auth/oauth-client.js";
import { OAuthCredentialStore } from "../../src/tools/mcp/auth/credential-store.js";
import { validateOAuthUrl } from "../../src/tools/mcp/auth/discovery.js";
import { createMcpDisplayRedactor } from "../../src/security/mcp-content.js";
import { createMockOAuthServer } from "../helpers/mcp-oauth-server.js";

async function fixture(t, options = {}, oauth = {}) {
  const srv = await createMockOAuthServer(options);
  const root = await mkdtemp(join(tmpdir(), "inkstone-oauth-"));
  const hooks = { secrets: [], required: [], authorized: [] };
  const args = { serverId: "demo", config: { url: srv.resource, oauth: { enabled: true, clientId: "public-client", scopes: ["mcp:read"], ...oauth } },
    allowlist: ["127.0.0.1"], credentialRoot: root,
    onSecrets: (value) => hooks.secrets.push(...value), onAuthRequired: (value) => hooks.required.push(value), onAuthorized: (value) => hooks.authorized.push(value) };
  const client = new McpOAuthClient(args);
  t.after(async () => { client.dispose(); await srv.close(); await rm(root, { recursive: true, force: true }); });
  return { srv, root, hooks, args, client };
}

async function login(client, srv) {
  const start = await client.startAuthorization();
  const response = await srv.authorize(start.authorizationUrl);
  assert.equal(response.status, 200, await response.text());
  return start;
}

test("OAuth real AS: discovery → S256 code exchange → resource token → refresh → encrypted restart", async (t) => {
  const { client, srv, root, hooks, args } = await fixture(t);
  assert.equal(await client.getAccessToken(), null);
  assert.equal(client.getStatus().status, "unauthenticated");
  const start = await login(client, srv);
  const auth = new URL(start.authorizationUrl);
  assert.equal(auth.searchParams.get("resource"), srv.resource);
  assert.equal(auth.searchParams.get("scope"), "mcp:read");
  assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
  assert.equal(new URL(auth.searchParams.get("redirect_uri")).hostname, "127.0.0.1");
  assert.notEqual(new URL(auth.searchParams.get("redirect_uri")).port, "");
  const token = await client.getAccessToken();
  assert.equal(token, "initial-access-secret");
  const call = await fetch(srv.resource, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(call.status, 200);
  assert.equal(client.getStatus().status, "authenticated");
  assert.equal(hooks.authorized.length, 1);
  assert.ok(hooks.secrets.includes(token));
  assert.equal(JSON.stringify(client.getStatus()).includes(token), false);
  const refreshed = await client.getAccessToken({ forceRefresh: true });
  assert.equal(refreshed, "rotated-access-secret");
  const files = await readdir(root);
  for (const file of files.filter((value) => value.endsWith(".json"))) {
    const content = await readFile(join(root, file), "utf8");
    assert.equal(content.includes("access-secret"), false);
    assert.equal(content.includes("refresh-secret"), false);
    if (process.platform !== "win32") assert.equal((await stat(join(root, file))).mode & 0o777, 0o600);
  }
  const restored = new McpOAuthClient(args);
  t.after(() => restored.dispose());
  assert.equal(await restored.getAccessToken(), "rotated-access-secret");
});

test("OAuth CIDM uses HTTPS client ID with no DCR; unsupported CIDM fails closed", async (t) => {
  const { client, srv } = await fixture(t, {}, { clientId: "https://client.example/inkstone.json" });
  const start = await login(client, srv);
  assert.equal(new URL(start.authorizationUrl).searchParams.get("client_id"), "https://client.example/inkstone.json");
  assert.equal(srv.calls.some((call) => call.path === "/register"), false);
  await client.logout();
  srv.options.cidm = false;
  await assert.rejects(() => client.startAuthorization(), { code: "MCP_OAUTH_CLIENT" });
});

test("OAuth DCR compatibility registers a native public client and persists scoped registration", async (t) => {
  const { client, srv, args } = await fixture(t, {}, { clientId: undefined });
  await login(client, srv);
  const registration = JSON.parse(srv.calls.find((call) => call.path === "/register").body);
  assert.equal(registration.token_endpoint_auth_method, "none");
  assert.equal(registration.application_type, "native");
  const restored = new McpOAuthClient(args);
  t.after(() => restored.dispose());
  assert.equal(await restored.getAccessToken(), "initial-access-secret");
  assert.equal(srv.calls.filter((call) => call.path === "/register").length, 1);
});

test("OAuth rejects AS issuer mismatch and missing S256 before opening authorization", async (t) => {
  const { client, srv } = await fixture(t, { metadataIssuer: "https://untrusted.example" });
  await assert.rejects(() => client.startAuthorization(), { code: "MCP_OAUTH_ISSUER" });
  delete srv.options.metadataIssuer;
  srv.options.pkce = ["plain"];
  await assert.rejects(() => client.startAuthorization(), { code: "MCP_OAUTH_PKCE" });
  assert.equal(srv.calls.some((call) => call.path === "/token"), false);
});

for (const options of [{ callbackIssuer: "https://wrong.example" }, { omitIssuer: true }, { denied: true }]) {
  test(`OAuth rejects callback ${JSON.stringify(options)} without exchanging code`, async (t) => {
    const { client, srv } = await fixture(t, options);
    const start = await client.startAuthorization();
    const response = await srv.authorize(start.authorizationUrl);
    assert.equal(response.status, 400);
    assert.equal(srv.calls.some((call) => call.path === "/token"), false);
    assert.equal(client.getStatus().status, "unauthenticated");
  });
}

test("OAuth wrong or duplicate state cannot consume the real pending authorization", async (t) => {
  const { client, srv } = await fixture(t, { callbackState: "wrong-state" });
  const start = await client.startAuthorization();
  assert.equal((await srv.authorize(start.authorizationUrl)).status, 400);
  assert.equal(client.getStatus().status, "pending");
  const auth = new URL(start.authorizationUrl);
  const callback = new URL(auth.searchParams.get("redirect_uri"));
  callback.searchParams.append("state", auth.searchParams.get("state"));
  callback.searchParams.append("state", auth.searchParams.get("state"));
  assert.equal((await fetch(callback)).status, 400);
  delete srv.options.callbackState;
  assert.equal((await srv.authorize(start.authorizationUrl)).status, 200);
});

test("OAuth refresh failure drops invalid stored tokens and emits only a safe auth_required reason", async (t) => {
  const { client, srv, args, hooks } = await fixture(t);
  await login(client, srv);
  srv.options.refreshFail = true;
  assert.equal(await client.getAccessToken({ forceRefresh: true }), null);
  assert.equal(client.getStatus().status, "unauthenticated");
  assert.equal(hooks.required.at(-1).reason, "refresh_failed");
  assert.equal(JSON.stringify(hooks.required).includes("DO_NOT_LEAK"), false);
  const restored = new McpOAuthClient(args);
  t.after(() => restored.dispose());
  assert.equal(await restored.getAccessToken(), null);
});

test("OAuth concurrent refresh calls perform one grant exchange", async (t) => {
  const { client, srv } = await fixture(t);
  await login(client, srv);
  srv.options.delayTokenMs = 30;
  const tokens = await Promise.all(Array.from({ length: 5 }, () => client.getAccessToken({ forceRefresh: true })));
  assert.deepEqual(tokens, Array(5).fill("rotated-access-secret"));
  assert.equal(srv.calls.filter((call) => call.path === "/token" && call.body.includes("refresh_token=")).length, 1);
});

test("OAuth concurrent 401 rediscovery preserves one refresh and returns the same rotated token", async (t) => {
  const { client, srv } = await fixture(t);
  await login(client, srv);
  srv.options.delayTokenMs = 50;
  const challenge = `Bearer resource_metadata="${srv.base}/.well-known/oauth-protected-resource/mcp"`;
  const tokens = await Promise.all(Array.from({ length: 5 }, () => client.handleUnauthorized(challenge, { accessToken: "initial-access-secret" })));
  assert.deepEqual(tokens, Array(5).fill("rotated-access-secret"));
  assert.equal(srv.calls.filter((call) => call.path === "/token" && call.body.includes("refresh_token=")).length, 1);
});

test("OAuth 401 challenge discovers non-default metadata, then stops after a rejected retry", async (t) => {
  const { client, srv } = await fixture(t, { defaultMetadataMissing: true });
  assert.equal(await client.getAccessToken(), null);
  const challenge = `Bearer resource_metadata="${srv.base}/.well-known/oauth-protected-resource/custom"`;
  assert.equal(await client.handleUnauthorized(challenge), null);
  await login(client, srv);
  assert.equal(await client.handleUnauthorized(challenge, { accessToken: "initial-access-secret" }), "rotated-access-secret");
  assert.equal(await client.handleUnauthorized(challenge, { accessToken: "rotated-access-secret", allowRefresh: false }), null);
  assert.equal(await client.getAccessToken(), null);
});

test("OAuth fresh login discovers custom metadata from one anonymous resource challenge", async (t) => {
  const { client, srv } = await fixture(t, { defaultMetadataMissing: true });
  client.config.headers = { Authorization: "Bearer must-not-send", "X-Api-Key": "must-not-send-either" };
  await login(client, srv);
  const probes = srv.calls.filter((call) => call.path === "/mcp");
  assert.equal(probes.length, 1);
  assert.equal(probes[0].method, "POST");
  assert.equal(JSON.parse(probes[0].body).method, "server/discover");
  assert.equal(probes[0].headers.authorization, undefined);
  assert.equal(probes[0].headers["x-api-key"], undefined);
  assert.equal(await client.getAccessToken(), "initial-access-secret");
});

test("OAuth metadata issuer switch never sends old refresh token to the new AS", async (t) => {
  const { client, srv } = await fixture(t);
  await login(client, srv);
  const other = await createMockOAuthServer();
  t.after(() => other.close());
  srv.options.issuer = other.base;
  const challenge = `Bearer resource_metadata="${srv.base}/.well-known/oauth-protected-resource/mcp"`;
  assert.equal(await client.handleUnauthorized(challenge, { accessToken: "initial-access-secret" }), null);
  assert.equal(client.getStatus().issuer, other.base);
  assert.equal(other.calls.some((call) => call.path === "/token"), false);
});

test("OAuth pending authorization stays bound to its AS when a 401 changes discovery", async (t) => {
  const { client, srv } = await fixture(t);
  const other = await createMockOAuthServer();
  t.after(() => other.close());
  const start = await client.startAuthorization();
  const authorize = await fetch(start.authorizationUrl, { redirect: "manual" });
  const forgedCallback = new URL(authorize.headers.get("location"));
  forgedCallback.searchParams.set("iss", other.base);
  srv.options.issuer = other.base;
  assert.equal(await client.handleUnauthorized(`Bearer resource_metadata="${srv.base}/.well-known/oauth-protected-resource/mcp"`), null);
  assert.equal(client.getStatus().status, "unauthenticated");
  await assert.rejects(() => fetch(forgedCallback));
  assert.equal(other.calls.some((call) => call.path === "/token"), false);
});

test("OAuth token POST never follows redirects or forwards the authorization code", async (t) => {
  const { client, srv } = await fixture(t);
  const other = await createMockOAuthServer();
  t.after(() => other.close());
  srv.options.tokenRedirect = `${other.base}/token`;
  const start = await client.startAuthorization();
  const response = await srv.authorize(start.authorizationUrl);
  assert.equal(response.status, 400);
  assert.equal(other.calls.length, 0);
  assert.equal(client.getStatus().status, "unauthenticated");
});

test("OAuth URL policy blocks plaintext remote endpoints, metadata SSRF and credential URLs", async (t) => {
  for (const url of ["http://public.example/token", "https://user:password@public.example/token", "http://127.0.0.1/token"]) {
    assert.throws(() => validateOAuthUrl(url), { code: "MCP_OAUTH_URL" });
  }
  const { client } = await fixture(t, { tokenEndpoint: "https://169.254.169.254/latest/meta-data" });
  await assert.rejects(() => client.startAuthorization(), { code: "MCP_OAUTH_SSRF" });
});

test("OAuth cancels loopback listener and logout works offline in a fresh process", async (t) => {
  const { client, srv, args, root } = await fixture(t);
  const start = await client.startAuthorization();
  const redirect = new URL(start.authorizationUrl).searchParams.get("redirect_uri");
  await client.cancelAuthorization();
  await assert.rejects(() => fetch(redirect));
  await login(client, srv);
  const offline = new McpOAuthClient(args);
  t.after(() => offline.dispose());
  const requestsBeforeLogout = srv.calls.length;
  await offline.logout();
  assert.equal(srv.calls.length, requestsBeforeLogout, "logout does not contact resource or authorization server");
  assert.deepEqual(await readdir(root), ["key.bin"]);
});

test("OAuth logout preserves same-named servers at other resources and removes old issuers for this resource", async (t) => {
  const { client, srv, args, root } = await fixture(t);
  const other = await createMockOAuthServer();
  const otherArgs = { ...args, config: { ...args.config, url: other.resource } };
  const otherClient = new McpOAuthClient(otherArgs);
  t.after(async () => { otherClient.dispose(); await other.close(); });
  await login(client, srv);
  await login(otherClient, other);
  const store = new OAuthCredentialStore(root);
  const oldTokens = ["tokens", "demo", "https://previous-issuer.example", srv.resource, "public-client", ["mcp:read"]];
  const oldRegistration = ["registration", "demo", "https://previous-issuer.example", srv.resource, ["mcp:read"]];
  store.save(oldTokens, { accessToken: "old-issuer-token" });
  store.save(oldRegistration, { clientId: "old-issuer-client" });
  await client.logout();
  assert.equal(store.load(oldTokens), null);
  assert.equal(store.load(oldRegistration), null);
  const restoredOther = new McpOAuthClient(otherArgs);
  const restoredFirst = new McpOAuthClient(args);
  t.after(() => { restoredOther.dispose(); restoredFirst.dispose(); });
  assert.equal(await restoredOther.getAccessToken(), "initial-access-secret");
  assert.equal(await restoredFirst.getAccessToken(), null);
});

test("OAuth rotated secrets are removed from RPC errors by a redactor created before refresh", async (t) => {
  const { client, srv } = await fixture(t);
  const hub = { oauthSecrets: new Set() };
  client.onSecrets = (values) => values.forEach((value) => hub.oauthSecrets.add(value));
  const redact = createMcpDisplayRedactor({ hub });
  await login(client, srv);
  assert.equal(await client.getAccessToken({ forceRefresh: true }), "rotated-access-secret");
  const error = redact({ error: { code: -32001, message: "RPC failed: rotated-access-secret; rotated-refresh-secret" } });
  assert.equal(error.error.message, "RPC failed: [REDACTED]; [REDACTED]");
});

test("OAuth credential encryption binds server, issuer, resource and client ID and rejects tampering", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "inkstone-oauth-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new OAuthCredentialStore(root);
  const binding = ["tokens", "server", "https://issuer.example", "https://resource.example/mcp", "client-a", ["read"]];
  store.save(binding, { accessToken: "top-secret" });
  assert.equal(store.load(binding).accessToken, "top-secret");
  for (const index of [1, 2, 3, 4, 5]) {
    const other = [...binding]; other[index] = "different";
    assert.equal(store.load(other), null);
    await copyFile(store._file(binding), store._file(other));
    assert.equal(store.load(other), null, "encrypted payload cannot be moved across identities");
  }
  const encrypted = JSON.parse(await readFile(store._file(binding), "utf8"));
  encrypted.data = Buffer.alloc(16).toString("base64");
  await writeFile(store._file(binding), JSON.stringify(encrypted));
  assert.equal(store.load(binding), null, "modified ciphertext fails authentication");
});

test("OAuth loopback authorization expiry releases listener and reports safe status", async (t) => {
  const { client, hooks } = await fixture(t, {}, { timeoutMs: 1000 });
  const start = await client.startAuthorization();
  const redirect = new URL(start.authorizationUrl).searchParams.get("redirect_uri");
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(client.getStatus().status, "unauthenticated");
  assert.equal(hooks.required.at(-1).reason, "authorization_expired");
  await assert.rejects(() => fetch(redirect));
});

test("OAuth logout during in-flight refresh cannot resurrect persisted authorization", async (t) => {
  const { client, srv, root } = await fixture(t);
  await login(client, srv);
  srv.options.delayTokenMs = 100;
  const refresh = client.getAccessToken({ forceRefresh: true });
  await new Promise((resolve) => setTimeout(resolve, 30));
  await client.logout();
  assert.equal(await refresh, null);
  assert.equal(client.getStatus().status, "unauthenticated");
  assert.deepEqual(await readdir(root), ["key.bin"]);
});

for (const logoutFirst of [false, true]) {
  test(`OAuth stale refresh failure cannot delete a subsequent login (logout=${logoutFirst})`, async (t) => {
    const { client, srv, args } = await fixture(t);
    await login(client, srv);
    let signalStarted, releaseRefresh;
    const started = new Promise((resolve) => { signalStarted = resolve; });
    const blocked = new Promise((resolve) => { releaseRefresh = resolve; });
    srv.options.beforeTokenResponse = async (params) => {
      if (params.get("grant_type") !== "refresh_token") return;
      signalStarted();
      await blocked;
    };
    srv.options.refreshFail = true;
    const refresh = client.getAccessToken({ forceRefresh: true });
    await started;
    if (logoutFirst) await client.logout();
    await login(client, srv);
    releaseRefresh();
    assert.equal(await refresh, null);
    assert.equal(client.getStatus().status, "authenticated");
    const restored = new McpOAuthClient(args);
    t.after(() => restored.dispose());
    assert.equal(await restored.getAccessToken(), "initial-access-secret");
  });
}

test("OAuth dispose racing with saved-token restore cannot return credentials", async (t) => {
  const { client, srv } = await fixture(t);
  await login(client, srv);
  const pendingToken = client.getAccessToken();
  client.dispose();
  assert.equal(await pendingToken, null);
});
