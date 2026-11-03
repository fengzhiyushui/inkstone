// tests/unit/mcp/mcp-auth-and-inputs.test.js — MCP 认证与输入代理领域测试
//
// v1.19.1 测试归并:本文件由下列历史任务单测试合并而成,每个来源包裹在独立
// describe 块中(异步回调 + 动态 import,来源间零共享绑定),测试语义与拆分前一致。
import { describe } from "node:test";

// ---------------------------------------------------------------------------
// 来源:tests/unit/mcp-oauth.test.js
// ---------------------------------------------------------------------------
describe("unit/mcp-oauth", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { readdir, readFile, rm, stat, writeFile, copyFile } = await import("node:fs/promises");
  const { mkdtemp } = await import("../../helpers/tmp.js");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { McpOAuthClient } = await import("../../../src/tools/mcp/auth/oauth-client.js");
  const { OAuthCredentialStore } = await import("../../../src/tools/mcp/auth/credential-store.js");
  const { validateOAuthUrl } = await import("../../../src/tools/mcp/auth/discovery.js");
  const { createMcpDisplayRedactor } = await import("../../../src/security/mcp-content.js");
  const { createMockOAuthServer } = await import("../../helpers/mcp-oauth-server.js");

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
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/mcp-input-broker.test.js
// ---------------------------------------------------------------------------
describe("unit/mcp-input-broker", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { EventEmitter, getEventListeners } = await import("node:events");
  const { createMcpInputBroker } = await import("../../../src/tools/mcp/input-broker.js");
  const { createMcpDisplayRedactor, sanitizeMcpSchema } = await import("../../../src/security/mcp-content.js");
  const { inputFields, parseInputField } = await import("../../../src/apps/mcp-input-form.js");

  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const form = (message = "Enter a value") => ({ method: "elicitation/create", params: { mode: "form", message,
    requestedSchema: { type: "object", properties: { value: { type: "string", minLength: 1 } }, required: ["value"] } } });
  const required = (requests = { value: form() }, requestState = "opaque-private-state") => ({ resultType: "input_required", inputRequests: requests, requestState });
  const accepted = (value = "private-response") => ({ action: "accept", content: { value } });

  function fixture(t) {
    const hub = new EventEmitter();
    const client = { getStatus: () => "CONNECTED" };
    const config = { command: "mock", elicitation: { enabled: true, timeoutMs: 1000 }, disabled: false };
    const tool = { name: "mcp__server__read", originalName: "read", serverId: "server", category: "read" };
    hub.clients = new Map([["server", client]]);
    hub.serverConfigs = new Map([["server", config]]);
    hub.serverTools = new Map([["server", [tool]]]);
    hub.toolRegistry = { resolve: (name) => (hub.serverTools.get("server") || []).find((item) => item.name === name) || null };
    hub._stopping = new Set(); hub._authRequired = new Set();
    const broker = createMcpInputBroker({ hub });
    const events = [];
    for (const name of ["input_required", "input_resolved"]) hub.on(name, (event) => events.push({ name, ...event }));
    t.after(() => broker.cancelAll());
    function start(result = required(), options = {}) {
      const controller = new AbortController();
      const promise = broker.request({ serverId: "server", method: "tools/call", params: { name: "read", arguments: {} }, result, signal: controller.signal, ...options }, options.client || client);
      const outcome = promise.then((value) => ({ value }), (error) => ({ error }));
      return { promise, outcome, controller };
    }
    return { hub, client, config, tool, broker, events, start };
  }

  test("broker requires explicit acceptance, isolates values from events and rejects duplicate submission", async (t) => {
    const { hub, broker, events, start } = fixture(t);
    const run = start(required({ value: form("Continue opaque-private-state") }));
    const [pending] = broker.list();
    assert.ok(pending.requestId);
    assert.equal(pending.message, "Continue [REDACTED]");
    assert.equal(getEventListeners(run.controller.signal, "abort").length, 1);
    assert.equal(broker.respond(pending.requestId, accepted()).status, "accepted");
    assert.equal(broker.respond(pending.requestId, accepted()).status, "not_found");
    const result = (await run.outcome).value;
    assert.equal(result.inputResponses.value.content.value, "private-response");
    assert.deepEqual(broker.list(), []);
    assert.equal(getEventListeners(run.controller.signal, "abort").length, 0);
    const text = JSON.stringify(events);
    assert.equal(text.includes("opaque-private-state"), false);
    assert.equal(text.includes("private-response"), false);
    assert.equal(text.includes("requestedSchema"), false);
    assert.equal(createMcpDisplayRedactor({ hub })("opaque-private-state private-response"), "[REDACTED] [REDACTED]");
  });

  test("broker preserves every server key including prototype-like keys and each action", async (t) => {
    const { broker, start } = fixture(t);
    const requests = Object.fromEntries([["__proto__", form()], ["constructor", form()], ["normal", form()]]);
    const run = start(required(requests));
    const responses = [accepted("first-value"), { action: "decline", content: { ignored: "not-retained" } }, { action: "cancel" }];
    for (const response of responses) {
      assert.equal(broker.list().length, 1);
      broker.respond(broker.list()[0].requestId, response);
      await tick();
    }
    const result = (await run.outcome).value.inputResponses;
    assert.equal(Object.getPrototypeOf(result), null);
    assert.deepEqual(Object.keys(result), ["__proto__", "constructor", "normal"]);
    assert.deepEqual(result.__proto__, responses[0]);
    assert.deepEqual(result.constructor, { action: "decline" });
    assert.deepEqual(result.normal, { action: "cancel" });
    assert.equal({}.value, undefined);
  });

  test("sequential short answers cannot corrupt the next private form's selectable values or bounds", async (t) => {
    const { hub, broker, start } = fixture(t);
    const numeric = form();
    numeric.params.requestedSchema = { type: "object", properties: { value: { type: "integer" } }, required: ["value"] };
    const later = form("Choose c, then enter 1");
    later.params.requestedSchema = { type: "object", properties: {
      choice: { type: "string", enum: ["c", "d"], description: "c", default: "c" },
      titled: { type: "string", oneOf: [{ const: "c", title: "c" }, { const: "d", title: "d" }] },
      count: { type: "integer", minimum: 1, maximum: 3 },
      length: { type: "string", minLength: 1, maxLength: 3 },
      date: { type: "string", format: "date" }
    }, required: ["choice", "titled", "count", "length", "date"] };
    const run = start(required({ first: form(), numeric, later }));
    broker.respond(broker.list()[0].requestId, accepted("c"));
    await tick();
    broker.respond(broker.list()[0].requestId, accepted(1));
    await tick();
    const [pending] = broker.list();
    const fields = inputFields(pending);
    const raw = ["c", "c", "1", "c", "2026-10-06"];
    const content = Object.fromEntries(fields.map((field, index) => [field.name, parseInputField(field, raw[index]).value]));
    assert.deepEqual(pending.requestedSchema.properties.choice.enum, ["c", "d"]);
    assert.equal(pending.requestedSchema.properties.titled.oneOf[0].const, "c");
    assert.equal(pending.requestedSchema.properties.count.minimum, 1);
    assert.equal(pending.requestedSchema.properties.length.minLength, 1);
    assert.equal(pending.requestedSchema.properties.choice.description, "[REDACTED]");
    assert.equal(pending.requestedSchema.properties.choice.default, "[REDACTED]");
    assert.equal(broker.respond(pending.requestId, { action: "accept", content }).status, "accepted");
    assert.equal((await run.outcome).value.inputResponses.later.content.choice, "c");
    const publicSchema = sanitizeMcpSchema(later.params.requestedSchema, createMcpDisplayRedactor({ hub }));
    assert.equal(publicSchema.properties.choice.enum[0], "[REDACTED]", "general tool-schema presentation keeps its prior privacy boundary");
  });

  test("state-only continuation has its own explicit empty form and never exposes state", async (t) => {
    const { broker, start } = fixture(t);
    const run = start({ resultType: "input_required", requestState: "state-only-private" });
    const [pending] = broker.list();
    assert.deepEqual(JSON.parse(JSON.stringify(pending.requestedSchema)), { type: "object", properties: {} });
    assert.equal(JSON.stringify(pending).includes("state-only-private"), false);
    broker.respond(pending.requestId, { action: "accept", content: {} });
    assert.deepEqual((await run.outcome).value, {});
  });

  for (const action of ["decline", "cancel"]) test(`state-only ${action} cannot silently retry`, async (t) => {
    const { broker, start } = fixture(t);
    const run = start({ resultType: "input_required", requestState: "opaque" });
    broker.respond(broker.list()[0].requestId, { action });
    assert.equal((await run.outcome).error.code, "MCP_INPUT_CANCELLED");
  });

  for (const unsupported of ["sampling/createMessage", "roots/list", "url"]) test(`broker rejects ${unsupported} before presenting any preceding valid form`, async (t) => {
    const { broker, events, start } = fixture(t);
    const blocked = unsupported === "url" ? { method: "elicitation/create", params: { mode: "url", message: "Visit", url: "https://example.com/private" } } : { method: unsupported, params: {} };
    const run = start(required({ first: form(), blocked }));
    assert.equal((await run.outcome).error.code, "MCP_INPUT_UNSUPPORTED");
    assert.deepEqual(broker.list(), []);
    assert.deepEqual(events, []);
  });

  test("invalid submitted values stay pending and errors do not echo input", async (t) => {
    const { broker, start } = fixture(t);
    const run = start();
    const id = broker.list()[0].requestId;
    for (const response of [{ action: "unknown" }, { action: "accept", content: { wrong: "secret-value" } }, { action: "accept", content: { value: "" } }]) {
      assert.throws(() => broker.respond(id, response), (error) => error.code === "MCP_INPUT_INVALID" && !error.message.includes("secret-value"));
      assert.equal(broker.list().length, 1);
    }
    broker.respond(id, accepted());
    assert.ok((await run.outcome).value);
  });

  for (const change of ["disable", "remove", "replace_config", "mutate_config", "replace_client", "stopping", "auth_required"]) test(`broker rejects stale approval after ${change}`, async (t) => {
    const { hub, config, broker, start } = fixture(t);
    const run = start();
    const id = broker.list()[0].requestId;
    if (change === "disable") config.disabled = true;
    else if (change === "remove") hub.serverConfigs.delete("server");
    else if (change === "replace_config") hub.serverConfigs.set("server", { ...config });
    else if (change === "mutate_config") config.command = "replacement";
    else if (change === "replace_client") hub.clients.set("server", {});
    else if (change === "stopping") hub._stopping.add("server");
    else hub._authRequired.add("server");
    assert.equal(broker.respond(id, accepted()).status, "cancelled");
    assert.equal((await run.outcome).error.code, "MCP_INPUT_STALE");
    assert.deepEqual(broker.list(), []);
  });

  test("broker listing settles stale requests so an obsolete form cannot remain actionable", async (t) => {
    const { hub, broker, start } = fixture(t);
    const run = start();
    hub.clients.delete("server");
    assert.deepEqual(broker.list(), []);
    assert.equal((await run.outcome).error.code, "MCP_INPUT_STALE");
  });

  for (const change of ["replace", "remove", "registry_replace"]) test(`broker cannot authorize a tool whose mounted identity changed: ${change}`, async (t) => {
    const { hub, tool, broker, start } = fixture(t);
    const run = start();
    const id = broker.list()[0].requestId;
    if (change === "replace") hub.serverTools.set("server", [{ ...tool, category: "destructive" }]);
    else if (change === "remove") hub.serverTools.set("server", []);
    else hub.toolRegistry.resolve = () => ({ ...tool, category: "destructive" });
    assert.equal(broker.respond(id, accepted()).status, "cancelled");
    assert.equal((await run.outcome).error.code, "MCP_INPUT_STALE");
    assert.deepEqual(broker.list(), []);
  });

  test("broker checks mounted tool identity again after acceptance before continuing", async (t) => {
    const { hub, tool, broker, start } = fixture(t);
    const run = start();
    const id = broker.list()[0].requestId;
    broker.respond(id, accepted());
    hub.serverTools.set("server", [{ ...tool }]);
    assert.equal((await run.outcome).error.code, "MCP_INPUT_STALE");
  });

  for (const mode of ["signal", "server", "all"]) test(`broker ${mode} cancellation settles once and removes signal listeners`, async (t) => {
    const { broker, events, start } = fixture(t);
    const run = start();
    const id = broker.list()[0].requestId;
    if (mode === "signal") run.controller.abort();
    else if (mode === "server") broker.cancelServer("server");
    else broker.cancelAll();
    assert.equal((await run.outcome).error.code, "MCP_INPUT_CANCELLED");
    assert.equal(getEventListeners(run.controller.signal, "abort").length, 0);
    assert.equal(broker.respond(id, accepted()).status, "not_found");
    assert.equal(events.filter((event) => event.name === "input_resolved").length, 1);
  });

  test("broker accepts no disabled, already-aborted, oversized or structurally invalid requests", async (t) => {
    const { config, broker, start } = fixture(t);
    config.elicitation.enabled = false;
    assert.equal((await start().outcome).error.code, "MCP_INPUT_DISABLED");
    config.elicitation.enabled = true;
    const controller = new AbortController(); controller.abort();
    assert.equal((await start(required(), { signal: controller.signal }).outcome).error.code, "MCP_INPUT_CANCELLED");
    const invalid = [{ resultType: "input_required" }, required({}, 123), required([], "state"), required(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [String(i), form()]))), required({ value: form("x".repeat(65537)) })];
    for (const result of invalid) assert.equal((await start(result).outcome).error.code, "MCP_INPUT_INVALID");
    assert.deepEqual(broker.list(), []);
  });

  test("broker rejects accessors and cycles without invoking serialization hooks", async (t) => {
    const { start } = fixture(t);
    let calls = 0;
    const accessor = required(); Object.defineProperty(accessor, "trap", { enumerable: true, get() { calls++; return "sensitive"; } });
    const cycle = required(); cycle.cycle = cycle;
    assert.equal((await start(accessor).outcome).error.code, "MCP_INPUT_INVALID");
    assert.equal((await start(cycle).outcome).error.code, "MCP_INPUT_INVALID");
    assert.equal(calls, 0);
  });

  test("broker pending limit is bounded and cancellation clears every queued request", async (t) => {
    const { broker, start } = fixture(t);
    const runs = Array.from({ length: 32 }, () => start());
    assert.equal(broker.list().length, 32);
    assert.equal((await start().outcome).error.code, "MCP_INPUT_LIMIT");
    broker.cancelAll();
    const results = await Promise.all(runs.map((run) => run.outcome));
    assert.ok(results.every((result) => result.error.code === "MCP_INPUT_CANCELLED"));
    assert.deepEqual(broker.list(), []);
  });

  test("broker expiry settles waiting request and prevents a late acceptance", async (t) => {
    const { broker, events, start } = fixture(t);
    const run = start();
    const id = broker.list()[0].requestId;
    // Broker timers intentionally do not keep the application alive.
    const keepAlive = setTimeout(() => {}, 1500);
    try {
      assert.equal((await run.outcome).error.code, "MCP_INPUT_EXPIRED");
      assert.equal(broker.respond(id, accepted()).status, "not_found");
      assert.equal(events.at(-1).status, "expired");
      assert.equal(getEventListeners(run.controller.signal, "abort").length, 0);
    } finally { clearTimeout(keepAlive); }
  });

  test("broker refuses new secret values after its bounded privacy budget is consumed", async (t) => {
    const { broker, start } = fixture(t);
    let rejected = false;
    for (let index = 0; index < 34; index++) {
      const run = start();
      const id = broker.list()[0].requestId;
      try {
        broker.respond(id, accepted(`${index}-` + "x".repeat(16370)));
        assert.ok((await run.outcome).value);
      } catch (error) {
        assert.equal(error.code, "MCP_INPUT_LIMIT");
        assert.equal(error.message.includes("xxxx"), false);
        broker.cancelAll();
        await run.outcome;
        rejected = true;
        break;
      }
    }
    assert.equal(rejected, true);
  });
});
