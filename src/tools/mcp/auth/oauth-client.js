import http from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { OAuthCredentialStore } from "./credential-store.js";
import { discoverOAuth, oauthJsonRequest, oauthError, safeOAuthError, resourceMetadataFromChallenge, validateOAuthUrl } from "./discovery.js";

const random = () => randomBytes(32).toString("base64url");
const SCOPES = (config) => [...new Set(config.oauth?.scopes || [])].sort();
function equalSecret(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Zero-dependency public OAuth client. Tokens only leave through getAccessToken/handleUnauthorized. */
export class McpOAuthClient {
  constructor({ serverId, config, allowlist = [], lookup, credentialRoot, onAuthRequired, onAuthorized, onSecrets } = {}) {
    this.serverId = serverId;
    this.config = config || {};
    this.options = { allowlist, lookup, timeoutMs: this.config.timeoutMs || 15000 };
    this.store = new OAuthCredentialStore(credentialRoot);
    this.onAuthRequired = onAuthRequired;
    this.onAuthorized = onAuthorized;
    this.onSecrets = onSecrets;
    this._status = this.config.oauth?.enabled === false ? "disabled" : "unauthenticated";
    this._context = null;
    this._clientId = null;
    this._tokens = null;
    this._binding = null;
    this._pending = null;
    this._epoch = 0;
    this._disposed = false;
  }

  _notify(callback, value) {
    try { Promise.resolve(callback?.(value)).catch(() => {}); } catch { /* Consumer hooks cannot break auth. */ }
  }

  _secrets(...values) { this._notify(this.onSecrets, values.filter((value) => typeof value === "string" && value.length)); }

  getStatus() {
    return {
      status: this._status,
      ...(this._context ? { issuer: this._context.issuer } : {}),
      ...(this._pending ? { expiresAt: new Date(this._pending.expiresAt).toISOString() } :
        this._tokens ? { expiresAt: new Date(this._tokens.expiresAt).toISOString() } : {})
    };
  }

  async _discover(force = false) {
    if (this._context && !force) return this._context;
    if (this._discovery && !force) return this._discovery;
    const epoch = this._epoch;
    const discovery = discoverOAuth(this.config, this.options, this._challengeMetadata).then((context) => {
      if (epoch !== this._epoch || this._disposed) throw oauthError("MCP_OAUTH_CANCELLED", "OAuth operation cancelled");
      // Concurrent 401s rediscover the same AS. Keep identity stable for the single-flight refresh.
      if (isDeepStrictEqual(context, this._context)) return this._context;
      if (this._context) {
        this._closePending(true);
        this._clientId = null;
        this._status = this._tokens?.expiresAt > Date.now() ? "authenticated" : "unauthenticated";
      }
      if (this._context && (context.issuer !== this._context.issuer || context.resource !== this._context.resource)) {
        // Never bring a previous authorization server's token or registration into the new context.
        this._tokens = null;
        this._binding = null;
        this._clientId = null;
        this._status = "unauthenticated";
      }
      this._context = context;
      return context;
    });
    this._discovery = discovery;
    try { return await discovery; }
    finally { if (this._discovery === discovery) this._discovery = null; }
  }

  _registrationBinding() {
    return ["registration", this.serverId, this._context.issuer, this._context.resource, SCOPES(this.config)];
  }

  async _ensureClient(redirectUri = null, signal) {
    if (this._clientId) return this._clientId;
    const configured = this.config.oauth?.clientId;
    if (configured) {
      if (/^https?:\/\//i.test(configured)) {
        const url = validateOAuthUrl(configured, this.options);
        if (url.protocol !== "https:" || this._context.metadata.client_id_metadata_document_supported !== true) {
          throw oauthError("MCP_OAUTH_CLIENT", "OAuth server does not support this client metadata document");
        }
      }
      this._clientId = configured;
      return this._clientId;
    }
    const saved = this.store.load(this._registrationBinding());
    if (typeof saved?.clientId === "string" && saved.clientId.length) {
      this._clientId = saved.clientId;
      return this._clientId;
    }
    if (!redirectUri) return null;
    if (!this._context.metadata.registration_endpoint) {
      throw oauthError("MCP_OAUTH_CLIENT", "Configure an OAuth client ID; dynamic registration is unavailable");
    }
    const context = this._context;
    const epoch = this._epoch;
    const result = await oauthJsonRequest(context.metadata.registration_endpoint, this.options, {
      method: "POST", signal, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "Inkstone", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", application_type: "native" })
    });
    if (context !== this._context || epoch !== this._epoch || this._disposed) throw oauthError("MCP_OAUTH_CANCELLED", "OAuth operation cancelled");
    this._secrets(result.client_secret, result.registration_access_token);
    if (typeof result.client_id !== "string" || !result.client_id.length || result.client_id.length > 8192 ||
        (result.token_endpoint_auth_method && result.token_endpoint_auth_method !== "none")) {
      throw oauthError("MCP_OAUTH_CLIENT", "OAuth server did not register a public client");
    }
    this._clientId = result.client_id;
    this.store.save(this._registrationBinding(), { clientId: this._clientId });
    return this._clientId;
  }

  _loadTokens() {
    const binding = ["tokens", this.serverId, this._context.issuer, this._context.resource, this._clientId, SCOPES(this.config)];
    if (JSON.stringify(binding) !== JSON.stringify(this._binding)) {
      this._binding = binding;
      const saved = this.store.load(binding);
      this._tokens = saved && typeof saved.accessToken === "string" && /^[\x21-\x7e]+$/.test(saved.accessToken) &&
        Number.isFinite(saved.expiresAt) ? saved : null;
      if (this._tokens) this._secrets(this._tokens.accessToken, this._tokens.refreshToken);
    }
  }

  _requireAuth(reason = "authorization_required") {
    if (this._disposed || this._status === "disabled") return;
    this._status = this._pending ? "pending" : "unauthenticated";
    this._notify(this.onAuthRequired, { ...this.getStatus(), reason });
  }

  _clearTokens() {
    this._tokens = null;
    if (this._binding) this.store.delete(this._binding);
  }

  async getAccessToken({ forceRefresh = false } = {}) {
    if (this._disposed || this._status === "disabled") return null;
    const epoch = this._epoch;
    try {
      await this._discover();
      if (epoch !== this._epoch || this._disposed) return null;
      if (!await this._ensureClient()) { this._requireAuth(); return null; }
      if (epoch !== this._epoch || this._disposed) return null;
      this._loadTokens();
      if (!forceRefresh && this._tokens?.expiresAt > Date.now() + 30000) {
        this._status = this._pending ? "pending" : "authenticated";
        return this._tokens.accessToken;
      }
      if (!this._tokens?.refreshToken) {
        this._clearTokens();
        this._requireAuth();
        return null;
      }
      return await this._refresh();
    } catch {
      this._requireAuth("authorization_unavailable");
      return null;
    }
  }

  async _tokenRequest(params, signal, context = this._context) {
    return oauthJsonRequest(context.metadata.token_endpoint, this.options, {
      method: "POST", signal, headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params).toString()
    });
  }

  _acceptTokens(result, previousRefresh = null, binding = this._binding) {
    this._secrets(result.access_token, result.refresh_token, result.id_token);
    const seconds = result.expires_in === undefined ? 3600 : Number(result.expires_in);
    if (typeof result.access_token !== "string" || !/^[\x21-\x7e]+$/.test(result.access_token) || result.access_token.length > 65536 ||
        String(result.token_type).toLowerCase() !== "bearer" || !Number.isFinite(seconds) || seconds <= 0 || seconds > 315360000 ||
        (result.refresh_token !== undefined && (typeof result.refresh_token !== "string" || !result.refresh_token.length || result.refresh_token.length > 65536))) {
      throw oauthError("MCP_OAUTH_TOKEN", "Invalid OAuth token response");
    }
    const tokens = { accessToken: result.access_token, refreshToken: result.refresh_token || previousRefresh, expiresAt: Date.now() + seconds * 1000 };
    this.store.save(binding, tokens);
    this._tokens = tokens;
    this._status = "authenticated";
    return tokens.accessToken;
  }

  async _refresh() {
    if (this._refreshPromise) return this._refreshPromise;
    const epoch = this._epoch;
    const context = this._context;
    const binding = this._binding;
    const previousTokens = this._tokens;
    const refreshToken = this._tokens.refreshToken;
    const work = (async () => {
      try {
        const result = await this._tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: this._clientId, resource: context.resource }, undefined, context);
        if (epoch !== this._epoch || context !== this._context || previousTokens !== this._tokens || this._disposed) return null;
        return this._acceptTokens(result, refreshToken);
      } catch {
        // An old refresh must not remove a later login, including the same issuer/client binding.
        if (epoch === this._epoch && context === this._context && binding === this._binding && previousTokens === this._tokens) {
          try { this.store.delete(binding); } catch { /* In-memory access still fails closed. */ }
          this._tokens = null;
          this._requireAuth("refresh_failed");
        }
        return null;
      }
    })();
    this._refreshPromise = work;
    try { return await work; }
    finally { if (this._refreshPromise === work) this._refreshPromise = null; }
  }

  /** Called once per 401 by the transport. A second 401 must end the retry. */
  async handleUnauthorized(challenge, { accessToken, allowRefresh = true } = {}) {
    if (this._disposed) return null;
    try {
      if (!allowRefresh) {
        this._clearTokens();
        this._requireAuth("token_rejected");
        return null;
      }
      const metadata = resourceMetadataFromChallenge(challenge);
      if (metadata) this._challengeMetadata = metadata;
      await this._discover(true);
      // Another concurrent request may already have rotated the rejected token.
      if (accessToken && this._tokens?.accessToken !== accessToken && this._tokens?.expiresAt > Date.now() + 30000) {
        return this._tokens.accessToken;
      }
      return await this.getAccessToken({ forceRefresh: true });
    } catch {
      this._tokens = null;
      this._requireAuth("discovery_failed");
      return null;
    }
  }

  async startAuthorization() {
    if (this._disposed || this._status === "disabled") throw oauthError("MCP_OAUTH_DISABLED", "OAuth is unavailable");
    if (this._pending?.authorizationUrl) return this._pendingView();
    if (this._startPromise) return this._startPromise;
    const work = this._startAuthorization();
    this._startPromise = work;
    try { return await work; }
    finally { if (this._startPromise === work) this._startPromise = null; }
  }

  async _startAuthorization() {
    const epoch = this._epoch;
    try {
      await this._discover(true);
      if (epoch !== this._epoch || this._disposed) throw oauthError("MCP_OAUTH_CANCELLED", "OAuth operation cancelled");
      const server = http.createServer((req, res) => { void this._callback(req, res); });
      server.headersTimeout = 10000;
      server.requestTimeout = 15000;
      server.maxHeadersCount = 32;
      server.maxRequestsPerSocket = 1;
      server.setTimeout(15000, (socket) => socket.destroy());
      const controller = new AbortController();
      const timeout = Math.max(1000, Math.min(this.config.oauth?.timeoutMs || 300000, 600000));
      const pending = { server, controller, epoch, context: this._context, state: random(), verifier: random(), expiresAt: Date.now() + timeout, processing: false };
      this._pending = pending;
      this._secrets(pending.state, pending.verifier);
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      if (this._pending !== pending || epoch !== this._epoch) throw oauthError("MCP_OAUTH_CANCELLED", "OAuth operation cancelled");
      pending.redirectUri = `http://127.0.0.1:${server.address().port}/oauth/callback`;
      await this._ensureClient(pending.redirectUri, controller.signal);
      if (this._pending !== pending || epoch !== this._epoch || pending.context !== this._context) throw oauthError("MCP_OAUTH_CANCELLED", "OAuth operation cancelled");
      this._loadTokens();
      pending.clientId = this._clientId;
      pending.binding = this._binding;
      const url = new URL(pending.context.metadata.authorization_endpoint);
      const params = { response_type: "code", client_id: pending.clientId, redirect_uri: pending.redirectUri, state: pending.state,
        code_challenge: createHash("sha256").update(pending.verifier).digest("base64url"), code_challenge_method: "S256", resource: pending.context.resource };
      if (SCOPES(this.config).length) params.scope = SCOPES(this.config).join(" ");
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      pending.authorizationUrl = url.href;
      pending.timer = setTimeout(() => {
        if (this._pending !== pending) return;
        this._closePending(true);
        this._requireAuth("authorization_expired");
      }, timeout);
      pending.timer.unref?.();
      this._status = "pending";
      return this._pendingView();
    } catch (error) {
      if (epoch === this._epoch) { this._closePending(); this._status = "error"; }
      throw safeOAuthError(error);
    }
  }

  _pendingView() {
    return { status: "pending", authorizationUrl: this._pending.authorizationUrl, expiresAt: new Date(this._pending.expiresAt).toISOString(), issuer: this._context.issuer };
  }

  async _callback(req, res) {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    const reply = (status, text) => { res.writeHead(status); res.end(text); };
    const pending = this._pending;
    if (!pending || !pending.redirectUri || pending.expiresAt <= Date.now()) { reply(410, "Authorization expired."); return; }
    let url;
    try { url = new URL(req.url, pending.redirectUri); } catch { reply(400, "Invalid callback."); return; }
    if (req.method !== "GET" || req.headers.host !== new URL(pending.redirectUri).host || url.pathname !== "/oauth/callback" || pending.processing) {
      reply(400, "Invalid callback."); return;
    }
    const params = url.searchParams;
    if (params.getAll("state").length !== 1 || !equalSecret(params.get("state"), pending.state)) {
      reply(400, "Invalid authorization state."); return;
    }
    pending.processing = true;
    try {
      if (params.getAll("iss").length !== 1 || params.get("iss") !== pending.context.issuer) {
        throw oauthError("MCP_OAUTH_ISSUER", "OAuth authorization response issuer mismatch");
      }
      if (params.has("error")) throw oauthError("MCP_OAUTH_DENIED", "OAuth authorization was denied");
      const code = params.get("code");
      if (params.getAll("code").length !== 1 || !code || code.length > 8192) throw oauthError("MCP_OAUTH_CODE", "Invalid OAuth authorization code");
      this._secrets(code);
      const result = await this._tokenRequest({ grant_type: "authorization_code", code, code_verifier: pending.verifier,
        redirect_uri: pending.redirectUri, client_id: pending.clientId, resource: pending.context.resource }, pending.controller.signal, pending.context);
      if (this._pending !== pending || pending.epoch !== this._epoch || pending.context !== this._context || pending.clientId !== this._clientId || this._disposed) {
        reply(410, "Authorization cancelled."); return;
      }
      this._acceptTokens(result, null, pending.binding);
      res.once("finish", () => pending.server.closeAllConnections?.());
      reply(200, "Authorization complete. You can close this window and return to Inkstone.");
      this._closePending();
      this._notify(this.onAuthorized, this.getStatus());
    } catch (error) {
      res.once("finish", () => pending.server.closeAllConnections?.());
      reply(400, safeOAuthError(error).message);
      if (this._pending === pending) {
        this._closePending();
        this._requireAuth(safeOAuthError(error).code);
      }
    }
  }

  _closePending(force = false) {
    const pending = this._pending;
    if (!pending) return;
    this._pending = null;
    clearTimeout(pending.timer);
    pending.controller.abort();
    pending.server.close();
    if (force) pending.server.closeAllConnections?.();
  }

  async cancelAuthorization() {
    this._epoch += 1;
    this._closePending(true);
    if (this._status !== "disabled") this._status = this._tokens?.expiresAt > Date.now() ? "authenticated" : "unauthenticated";
    return this.getStatus();
  }

  async logout() {
    await this.cancelAuthorization();
    // Logout must work offline, including in a fresh process with no metadata cache.
    this._tokens = null;
    this._clientId = null;
    this._binding = null;
    this.store.deleteServer(this.serverId, validateOAuthUrl(this.config.url, this.options).href);
    this._status = this._status === "disabled" ? "disabled" : "unauthenticated";
    return this.getStatus();
  }

  dispose() {
    this._disposed = true;
    this._epoch += 1;
    this._closePending(true);
    this._tokens = null;
  }
}
