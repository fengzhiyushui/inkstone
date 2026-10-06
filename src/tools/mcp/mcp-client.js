import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { JsonRpcClient, JSONRPC_ERRORS } from "./jsonrpc-client.js";
import { createTransport } from "./transport.js";
import { McpSubscriptions } from "./subscriptions.js";
import { createCapabilityCache, CAPABILITY_CACHE_LIMITS } from "./capability-cache.js";
import { boundCapabilityContent, capabilityLimit, CAPABILITY_CONTENT_DEFAULT_BYTES, CAPABILITY_CONTENT_MAX_BYTES } from "./capability-content.js";
import {
  MODERN_PROTOCOL_VERSION,
  LEGACY_PROTOCOL_VERSION,
  BASELINE_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  PROTOCOL_MODE,
  DEFAULT_CLIENT_CAPABILITIES,
  META_KEYS,
  MRTR_METHODS,
  MRTR_MAX_ROUNDS,
  MCP_SERVER_ERRORS,
  isUnsupportedProtocolVersionError,
  isModernProbeError,
  pickMutualVersion
} from "./protocol.js";

function loadPackageVersion() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, "..", "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Preferred handshake version for Legacy servers. */
export const MCP_PROTOCOL_VERSION = LEGACY_PROTOCOL_VERSION;
export const MCP_MODERN_PROTOCOL_VERSION = MODERN_PROTOCOL_VERSION;

export const MCP_CLIENT_INFO = Object.freeze({
  name: "inkstone",
  version: loadPackageVersion()
});

export class McpClient extends EventEmitter {
  constructor({
    serverId,
    command = "",
    args = [],
    env = {},
    cwd = process.cwd(),
    timeoutMs = 60000,
    transport = null,
    /** auto | modern | legacy */
    protocolMode = "auto",
    /** ms for server/discover probe before Legacy fallback */
    discoverTimeoutMs = 500,
    /** v1.12.0:远程传输(streamable-http / sse) */
    url = "",
    type = null,
    headers = {},
    allowlist = [],
    lookup,
    maxRedirects,
    retryOnStreamBreak,
    maxBodyBytes,
    oauthProvider = null,
    elicitation = {},
    subscriptions = {},
    inputHandler = null
  } = {}) {
    super();
    if (!serverId) {
      throw new Error("McpClient: 'serverId' is required");
    }
    this.serverId = serverId;
    this.command = command;
    this.args = Array.isArray(args) ? [...args] : [];
    this.env = { ...env };
    this.cwd = cwd;
    this.timeoutMs = timeoutMs;
    this.requestedProtocolMode = protocolMode;
    this.discoverTimeoutMs = discoverTimeoutMs;
    this.elicitationEnabled = elicitation?.enabled === true && typeof inputHandler === "function";
    this.inputHandler = this.elicitationEnabled ? inputHandler : null;
    this._lifecycle = new AbortController();
    this.subscriptions = new McpSubscriptions(this, subscriptions);

    // v1.12.0:传输选择。显式注入的 transport 优先;否则按 url/type 走统一工厂 ——
    // stdio 仍是默认,既有调用方与测试迁移不破。
    this.transportConfig = {
      command, args: this.args, env: this.env, cwd,
      url, type, headers, timeoutMs,
      allowlist, lookup, maxRedirects, retryOnStreamBreak, maxBodyBytes, oauthProvider
    };
    this.requestedTransportType = (url || type) ? (type || "streamable-http") : "stdio";
    this.deprecatedTransport = null;

    this.status = "DISCONNECTED";
    this.protocolMode = PROTOCOL_MODE.UNKNOWN;
    this.protocolVersion = null;
    this.serverInfo = null;
    this.serverCapabilities = {};
    this.clientCapabilities = { ...DEFAULT_CLIENT_CAPABILITIES };
    if (this.elicitationEnabled) this.clientCapabilities.elicitation = { form: {} };
    this.lastError = null;
    this._capabilityCache = createCapabilityCache();
    this._capabilityCursors = new Map();
    this._capabilityGeneration = 0;
    this._capabilityIdentity = null;

    this.transport = transport;
    this.rpc = new JsonRpcClient({ defaultTimeoutMs: this.timeoutMs });
    this.rpc.on("trace", (event) => this.emit("trace", event));
    this.rpc.on("request_completed", (event) => this.emit("request_completed", event));

    this._onTransportClose = (info) => {
      this.subscriptions.stop();
      this._lifecycle.abort(Object.assign(new Error("MCP connection closed"), { code: JSONRPC_ERRORS.SERVER_DISCONNECTED }));
      this._invalidateCapabilities();
      if (this.status === "CONNECTED") {
        this.status = "ERROR";
        this.lastError = new Error(
          `MCP server '${this.serverId}' process closed unexpectedly (code: ${info?.code}, signal: ${info?.signal})`
        );
        this.emit("error", this.lastError);
        this.emit("disconnected");
      }
    };

    this._onTransportError = (err) => {
      if (err?.requestId !== undefined && err.requestId === this.subscriptions.current?.id) return;
      if (err?.name === "AbortError" || err?.code === JSONRPC_ERRORS.CANCELLED || err?.code === JSONRPC_ERRORS.TIMEOUT) return;
      this._invalidateCapabilities();
      this.status = "ERROR";
      this.lastError = err;
      // 有监听者才 emit:EventEmitter 在没有 'error' 监听者时会直接抛出,
      // 把一个可上报的传输失败变成进程崩溃。同时延到微任务,让 connect() 的
      // catch 分支先跑完(否则 emit 会快过 caller 的 reject 处理)。
      if (this.listenerCount("error") > 0) {
        queueMicrotask(() => {
          if (this.listenerCount("error") > 0) this.emit("error", err);
        });
      }
    };

    this._onNotification = (message) => {
      if (!this.subscriptions.accepts(message)) return;
      const method = message?.method || "";
      if (method.endsWith("/list_changed") || method === "notifications/tools/list_changed") {
        this._invalidateCapabilities();
        this.emit("list_changed", { method, params: message?.params });
      }
      if (method === "notifications/resources/updated") this._invalidateCapabilities();
      if (method === "notifications/cancelled") {
        this.emit("cancelled", message?.params);
      }
    };
    this._onDeprecated = ({ reason }) => {
      this.deprecatedTransport = reason;
      this.emit("deprecated", { reason });
    };
  }

  /**
   * v1.12.0:握手中的传输错误必须立即让 connect() 失败。
   *
   * 传输错误是**事件**(如 SSRF 目标被拒、连接被重置),原本只经 'error' 上报,
   * 而握手在等 JSON-RPC 响应 —— 结果要等满超时才失败,且错误语义被超时掩盖。
   * 这里把事件竞争进 Promise:先到者胜,监听器始终清理,不泄漏。
   */
  _raceTransportError(promise) {
    if (!this.transport || typeof this.transport.once !== "function") return promise;

    let onError;
    let onClose;
    const failure = new Promise((_, reject) => {
      onError = (err) => reject(err);
      onClose = (info) => reject(new Error(
        `MCP transport closed during handshake (code: ${info?.code}, signal: ${info?.signal})`
      ));
      this.transport.once("error", onError);
      this.transport.once("close", onClose);
    });

    return Promise.race([promise, failure]).finally(() => {
      this.transport?.removeListener?.("error", onError);
      this.transport?.removeListener?.("close", onClose);
    });
  }

  getStatus() {
    return this.status;
  }

  getProtocolMode() {
    return this.protocolMode;
  }

  getLastError() {
    return this.lastError;
  }

  getRecentStderr() {
    return this.transport?.getRecentStderr?.() || "";
  }

  /**
   * v1.12.0:协议协商结果必须同步给传输层 —— Streamable HTTP 的每个请求都要带
   * `MCP-Protocol-Version` 头,而协商发生在客户端。stdio 传输无此方法,安全降级。
   */
  setProtocolVersion(version) {
    this.protocolVersion = version;
    try {
      this.transport?.setProtocolVersion?.(version);
    } catch {
      /* 传输不支持则忽略 */
    }
  }

  _buildMeta() {
    return {
      [META_KEYS.PROTOCOL_VERSION]: this.protocolVersion || MODERN_PROTOCOL_VERSION,
      [META_KEYS.CLIENT_INFO]: { ...MCP_CLIENT_INFO },
      [META_KEYS.CLIENT_CAPABILITIES]: this.clientCapabilities
    };
  }

  async _request(method, params, opts = {}) {
    const useMeta = this.protocolMode === PROTOCOL_MODE.MODERN;
    const lifecycle = this._lifecycle;
    const signal = opts.signal ? AbortSignal.any([opts.signal, lifecycle.signal]) : lifecycle.signal;
    const original = params && typeof params === "object" ? structuredClone(params) : params;
    // Continuations can only be constructed after the local consent handler.
    // Top-level state supplied by a caller cannot skip the initial round.
    if (original && typeof original === "object") {
      delete original.inputResponses;
      delete original.requestState;
    }
    let requestParams = original;
    for (let round = 0; ; round++) {
      signal.throwIfAborted();
      const result = await this.rpc.request(method, requestParams, {
        ...opts, signal, meta: useMeta ? this._buildMeta() : opts.meta
      });
      if (result?.resultType !== "input_required") return withoutContinuation(result);
      // Never publish opaque state, schemas, defaults or accompanying content
      // from an unhandled request into tool output, history or content caches.
      if (!this.elicitationEnabled || !useMeta) return { resultType: "input_required" };
      if (!MRTR_METHODS.includes(method)) throw Object.assign(new Error(`MCP input_required is not permitted for ${method}`), { code: "MCP_MRTR_METHOD" });
      if (round >= MRTR_MAX_ROUNDS) throw Object.assign(new Error("MCP multi-round input limit exceeded"), { code: "MCP_MRTR_LIMIT" });
      if ((result.requestState !== undefined && typeof result.requestState !== "string")
        || (result.inputRequests === undefined && result.requestState === undefined)) {
        throw Object.assign(new Error("MCP input_required has invalid request state"), { code: "MCP_MRTR_INVALID" });
      }
      signal.throwIfAborted();
      const requestState = result.requestState;
      const response = await waitForInput(this.inputHandler({ serverId: this.serverId, method, params: structuredClone(original), result, signal, round: round + 1 }), signal);
      signal.throwIfAborted();
      if (lifecycle !== this._lifecycle || this.status !== "CONNECTED") throw Object.assign(new Error("MCP connection changed during input confirmation"), { code: JSONRPC_ERRORS.SERVER_DISCONNECTED });
      if (!response || typeof response !== "object") throw Object.assign(new Error("MCP input handler returned no response"), { code: "MCP_MRTR_INVALID" });
      requestParams = { ...structuredClone(original) };
      delete requestParams.requestState;
      delete requestParams.inputResponses;
      if (response.inputResponses !== undefined) requestParams.inputResponses = structuredClone(response.inputResponses);
      // The opaque state belongs exclusively to the latest server response.
      if (requestState !== undefined) requestParams.requestState = requestState;
    }
  }

  async connect() {
    if (this.status === "CONNECTED") {
      return;
    }
    this.status = "CONNECTING";
    this.subscriptions.stop();
    this._lifecycle.abort(Object.assign(new Error("MCP connection replaced"), { code: JSONRPC_ERRORS.SERVER_DISCONNECTED }));
    this._lifecycle = new AbortController();
    this._invalidateCapabilities();
    this.serverCapabilities = {};
    this.lastError = null;
    this.protocolMode = PROTOCOL_MODE.UNKNOWN;
    this.protocolVersion = null;

    try {
      if (!this.transport) {
        // v1.12.0:统一经工厂选择传输(stdio / streamable-http / legacy sse)
        this.transport = createTransport(this.transportConfig);
      }

      this.transport.removeListener("close", this._onTransportClose);
      this.transport.removeListener("error", this._onTransportError);
      this.transport.on("close", this._onTransportClose);
      this.transport.on("error", this._onTransportError);
      if (typeof this.transport.on === "function") {
        // legacy SSE 是已废弃通道:透出标记,供事件契约与诊断提示
        this.transport.removeListener("deprecated", this._onDeprecated);
        this.transport.on("deprecated", this._onDeprecated);
        if (this.transport.deprecated) this.deprecatedTransport = "legacy transport";
      }

      this.rpc.setTransport(this.transport);
      this.rpc.on("notification", this._onNotification);
      // Transport errors are already handled above. JsonRpcClient conditionally
      // emits its own error event; subscribing twice would report each twice.

      // v1.12.0:传输是在这里才创建的,协商结果要重新回填一次
      // (connect() 开头已把 protocolVersion 置空,但那时 transport 还不存在)。
      this.setProtocolVersion(this.protocolVersion);

      if (typeof this.transport.start === "function") {
        this.transport.start();
      }

      // legacy SSE:长连建立后要先拿到 endpoint 才能发帧
      if (typeof this.transport.waitForEndpoint === "function") {
        await this.transport.waitForEndpoint(this.timeoutMs);
      }

      // legacy SSE 通道不存在 Modern 时代语义,直接走 Legacy initialize
      const legacyOnlyTransport = this.transport.deprecated === true;
      const wantModern = !legacyOnlyTransport && this.requestedProtocolMode !== "legacy";
      const wantLegacy = this.requestedProtocolMode !== "modern";

      if (wantModern && (this.requestedProtocolMode === "modern" || this.requestedProtocolMode === "auto")) {
        const probed = await this._raceTransportError(this._tryModernConnect());
        if (probed) {
          this.status = "CONNECTED";
          this.subscriptions.start();
          this.emit("connected", {
            protocolMode: this.protocolMode,
            protocolVersion: this.protocolVersion,
            serverInfo: this.serverInfo,
            capabilities: this.serverCapabilities
          });
          return;
        }
        if (this.requestedProtocolMode === "modern") {
          throw this.lastError || new Error("MCP modern handshake failed");
        }
      }

      if (wantLegacy) {
        await this._raceTransportError(this._legacyConnect());
        this.status = "CONNECTED";
        this.subscriptions.start();
        this.emit("connected", {
          protocolMode: this.protocolMode,
          protocolVersion: this.protocolVersion,
          serverInfo: this.serverInfo,
          capabilities: this.serverCapabilities
        });
        return;
      }

      throw new Error("MCP connect failed: no compatible protocol era");
    } catch (err) {
      this.status = "ERROR";
      this.lastError = err;
      // 保留 ERROR 状态:失败后的清理不应把"最近一次连接失败"抹成 DISCONNECTED,
      // 否则调用方与界面无法区分"从未连过"和"连过但失败"。
      await this.disconnect({ keepStatus: true }).catch(() => {});
      throw err;
    }
  }

  /**
   * Modern era: server/discover (or inline version error retry).
   * @returns {Promise<boolean>} true if connected as modern
   */
  async _tryModernConnect() {
    let discover = null;
    try {
      discover = await this.rpc.request("server/discover", {}, {
        timeoutMs: this.discoverTimeoutMs,
        meta: {
          [META_KEYS.PROTOCOL_VERSION]: MODERN_PROTOCOL_VERSION,
          [META_KEYS.CLIENT_INFO]: { ...MCP_CLIENT_INFO },
          [META_KEYS.CLIENT_CAPABILITIES]: this.clientCapabilities
        },
        cancelOnTimeout: true
      });
    } catch (err) {
      if (isModernProbeError(err)) {
        // Modern server speaking version negotiation
        return await this._modernFromVersionError(err);
      }
      // Method not found / timeout / generic → treat as Legacy
      this.lastError = err;
      return false;
    }

    if (!discover || typeof discover !== "object") {
      return false;
    }

    const supported =
      discover.supportedVersions ||
      discover.protocolVersions ||
      (discover.protocolVersion ? [discover.protocolVersion] : null);

    const version = pickMutualVersion(supported, [
      MODERN_PROTOCOL_VERSION,
      LEGACY_PROTOCOL_VERSION,
      ...SUPPORTED_PROTOCOL_VERSIONS
    ]);

    if (!version) {
      this.lastError = new Error(
        `MCP server '${this.serverId}' has no mutually supported protocol version: ${JSON.stringify(supported)}`
      );
      return false;
    }

    // Modern only (2026-07-28+); if negotiated a legacy version fall through
    if (version === MODERN_PROTOCOL_VERSION || discover.era === "modern") {
      this.protocolMode = PROTOCOL_MODE.MODERN;
      this.setProtocolVersion(version);
      this.serverInfo = discover.serverInfo || discover.server || null;
      this.serverCapabilities = discover.capabilities || {};
      return true;
    }

    // discover answered but only legacy versions — still use modern meta? No: use legacy handshake with negotiated version
    this.setProtocolVersion(version);
    await this._legacyConnect(version);
    return true;
  }

  async _modernFromVersionError(err) {
    const supported = err?.data?.supported || [];
    const version = pickMutualVersion(supported, SUPPORTED_PROTOCOL_VERSIONS);
    if (!version || version !== MODERN_PROTOCOL_VERSION) {
      // Can't speak modern with this server
      if (version) {
        this.setProtocolVersion(version);
        await this._legacyConnect(version);
        this.protocolMode = PROTOCOL_MODE.LEGACY;
        return true;
      }
      return false;
    }
    this.protocolMode = PROTOCOL_MODE.MODERN;
    this.setProtocolVersion(version);
    return true;
  }

  /** Legacy era: initialize + notifications/initialized */
  async _legacyConnect(preferredVersion = null) {
    const requested =
      preferredVersion ||
      this.protocolVersion ||
      LEGACY_PROTOCOL_VERSION;

    const initResult = await this.rpc.request(
      "initialize",
      {
        protocolVersion: requested,
        // The opt-in form flow uses Modern MRTR, not legacy server requests.
        capabilities: { ...DEFAULT_CLIENT_CAPABILITIES },
        clientInfo: { ...MCP_CLIENT_INFO }
      },
      { timeoutMs: Math.max(this.timeoutMs, 15000) }
    );

    this.serverInfo = initResult?.serverInfo || null;
    this.serverCapabilities = initResult?.capabilities || {};
    this.setProtocolVersion(initResult?.protocolVersion || requested);
    this.protocolMode = PROTOCOL_MODE.LEGACY;

    this.rpc.notify("notifications/initialized");
  }

  async listTools(opts = {}) {
    if (this.status !== "CONNECTED") {
      throw new Error(
        `MCP client '${this.serverId}' is not connected (current status: ${this.status})`
      );
    }

    const result = await this._request("tools/list", {}, { timeoutMs: this.timeoutMs, ...opts });
    return result?.tools || [];
  }

  async callTool(name, toolArguments = {}, opts = {}) {
    if (this.status !== "CONNECTED") {
      throw new Error(
        `MCP client '${this.serverId}' is not connected (current status: ${this.status})`
      );
    }

    const result = await this._request(
      "tools/call",
      {
        name,
        arguments: toolArguments
      },
      { timeoutMs: this.timeoutMs, ...opts }
    );

    return result || { content: [], isError: false, resultType: "complete" };
  }

  supportsCapability(name) {
    if (!Object.prototype.hasOwnProperty.call(this.serverCapabilities || {}, name)) return false;
    const value = this.serverCapabilities[name];
    return value === true || (value !== null && typeof value === "object" && !Array.isArray(value));
  }

  _assertCapability(capability) {
    if (!this.supportsCapability(capability)) {
      const error = new Error(`MCP server '${this.serverId}' does not advertise ${capability}`);
      error.code = "MCP_CAPABILITY_UNSUPPORTED";
      throw error;
    }
    if (this.status !== "CONNECTED") throw new Error(`MCP client '${this.serverId}' is not connected (current status: ${this.status})`);
  }

  _invalidateCapabilities() {
    this._capabilityCache.clear();
    this._capabilityCursors.clear();
    this._capabilityGeneration += 1;
  }

  _syncCapabilityIdentity() {
    const identity = createHash("sha256").update(JSON.stringify({
      serverId: this.serverId, transport: this.transportConfig,
      protocolMode: this.protocolMode, protocolVersion: this.protocolVersion
    })).digest("hex");
    if (identity !== this._capabilityIdentity) {
      this._invalidateCapabilities();
      this._capabilityIdentity = identity;
    }
  }

  async _cachedCapability(key, opts, run) {
    opts.signal?.throwIfAborted?.();
    this._syncCapabilityIdentity();
    const cacheKey = createHash("sha256").update(JSON.stringify(key)).digest("hex");
    if (!opts.forceRefresh) {
      const hit = this._capabilityCache.get(cacheKey);
      if (hit) return hit;
    }
    const generation = this._capabilityGeneration;
    const { value, hints } = await run();
    opts.signal?.throwIfAborted?.();
    if (generation === this._capabilityGeneration && this.status === "CONNECTED") this._capabilityCache.set(cacheKey, value, hints);
    return value;
  }

  // Local opaque cursors retain an offset into a server page. When maxItems
  // cuts through one page, the next call re-reads it and skips exactly that
  // prefix, rather than silently dropping all remaining entries in the page.
  _continuation(method, cursor, offset, generation) {
    while (this._capabilityCursors.size >= CAPABILITY_CACHE_LIMITS.maxEntries) this._capabilityCursors.delete(this._capabilityCursors.keys().next().value);
    const token = `inkstone-page:${randomUUID()}`;
    this._capabilityCursors.set(token, { method, cursor, offset, generation, expiresAt: Date.now() + CAPABILITY_CACHE_LIMITS.maxTtlMs });
    return token;
  }

  _resolveCapabilityCursor(method, cursor) {
    if (cursor === undefined || cursor === null) return { cursor: undefined, offset: 0 };
    if (typeof cursor !== "string" || cursor.length > 8192) throw new TypeError("MCP cursor must be a string of at most 8192 characters");
    if (!cursor.startsWith("inkstone-page:")) return { cursor, offset: 0 };
    const saved = this._capabilityCursors.get(cursor);
    if (!saved || saved.method !== method || saved.generation !== this._capabilityGeneration || saved.expiresAt <= Date.now()) {
      this._capabilityCursors.delete(cursor);
      const error = new Error("MCP pagination cursor expired or belongs to another capability/client; restart the listing");
      error.code = "MCP_CURSOR_EXPIRED";
      throw error;
    }
    return saved;
  }

  async _listCapability(capability, method, field, opts = {}) {
    if (!this.supportsCapability(capability)) return { [field]: [], supported: false };
    this._assertCapability(capability);
    const maxPages = capabilityLimit(opts.maxPages, 5, 20);
    const maxItems = capabilityLimit(opts.maxItems, 200, 1000);
    const maxBytes = capabilityLimit(opts.maxBytes, CAPABILITY_CONTENT_MAX_BYTES, CAPABILITY_CONTENT_MAX_BYTES, 2);
    this._syncCapabilityIdentity();
    const start = this._resolveCapabilityCursor(method, opts.cursor);
    return this._cachedCapability([method, opts.cursor ?? null, maxPages, maxItems, maxBytes], opts, async () => {
      const collected = [];
      let bytes = 2;
      const generation = this._capabilityGeneration;
      const seen = new Set();
      let cursor = start.cursor, offset = start.offset;
      const hints = {};
      let expiresAt = Infinity;
      let nextCursor;
      let truncationReason;
      for (let page = 0; page < maxPages; page += 1) {
        opts.signal?.throwIfAborted?.();
        seen.add(cursor ?? null);
        const result = await this._request(method, cursor == null ? {} : { cursor }, { timeoutMs: this.timeoutMs, ...(opts.signal ? { signal: opts.signal } : {}) });
        const rawItems = result?.[field] ?? (method === "templates/list" ? result?.templates : undefined);
        const items = Array.isArray(rawItems) ? rawItems : [];
        const ttl = Number.isFinite(result?.ttlMs) && result.ttlMs > 0 ? result.ttlMs : 0;
        expiresAt = Math.min(expiresAt, Date.now() + Math.min(ttl, CAPABILITY_CACHE_LIMITS.maxTtlMs));
        if (result?.cacheScope === "none" || result?.cacheScope === "request") hints.cacheScope = "none";
        while (offset < items.length && collected.length < maxItems) {
          const json = JSON.stringify(items[offset]);
          const itemBytes = typeof json === "string" ? Buffer.byteLength(json, "utf8") : Infinity;
          const needed = itemBytes + (collected.length ? 1 : 0);
          if (bytes + needed > maxBytes) {
            truncationReason = collected.length ? "max_bytes" : "item_too_large";
            break;
          }
          collected.push(JSON.parse(json));
          bytes += needed;
          offset += 1;
        }
        if (offset < items.length) {
          // A single descriptor larger than the entire byte cap cannot make
          // progress with the same options; report it without a looping cursor.
          if (truncationReason !== "item_too_large") nextCursor = this._continuation(method, cursor, offset, generation);
          truncationReason ||= "max_items";
          break;
        }
        offset = 0;
        const next = result?.nextCursor;
        if (next == null || next === "") break;
        if (typeof next !== "string" || next.length > 8192) { truncationReason = "invalid_cursor"; break; }
        if (seen.has(next)) { truncationReason = "repeated_cursor"; break; }
        nextCursor = next;
        if (collected.length >= maxItems) { truncationReason = "max_items"; break; }
        if (page + 1 >= maxPages) { truncationReason = "max_pages"; break; }
        cursor = next;
        nextCursor = undefined;
      }
      const value = { [field]: collected, supported: true, ...(truncationReason ? { truncated: true, truncationReason } : {}), ...(nextCursor ? { nextCursor } : {}) };
      // A continuation depends on mutable server pagination state; do not cache
      // a truncated aggregate whose client-side cursor could expire or evict.
      hints.ttlMs = truncationReason ? 0 : Math.max(0, expiresAt - Date.now());
      return { value, hints };
    });
  }

  listResources(opts = {}) {
    return this._listCapability("resources", "resources/list", "resources", opts);
  }

  listResourceTemplates(opts = {}) {
    const method = this.protocolMode === PROTOCOL_MODE.MODERN ? "templates/list" : "resources/templates/list";
    return this._listCapability("resources", method, "resourceTemplates", opts);
  }

  listPrompts(opts = {}) {
    return this._listCapability("prompts", "prompts/list", "prompts", opts);
  }

  async _readCapability(capability, method, params, field, opts) {
    this._assertCapability(capability);
    const identifier = params.uri ?? params.name;
    if (typeof identifier !== "string" || !identifier.trim() || identifier.length > 8192) throw new TypeError("MCP resource URI/prompt name must be a non-empty string of at most 8192 characters");
    if ("arguments" in params && (!params.arguments || typeof params.arguments !== "object" || Array.isArray(params.arguments))) throw new TypeError("MCP prompt arguments must be an object");
    const maxBytes = capabilityLimit(opts.maxBytes, CAPABILITY_CONTENT_DEFAULT_BYTES, CAPABILITY_CONTENT_MAX_BYTES, 2);
    return this._cachedCapability([method, params, maxBytes], opts, async () => {
      const result = await this._request(method, params, { timeoutMs: this.timeoutMs, ...(opts.signal ? { signal: opts.signal } : {}) });
      if (result?.resultType && result.resultType !== "complete") {
        throw Object.assign(new Error(result.resultType === "input_required" ? "MCP server requires input; enable elicitation and confirm the request to continue" : "MCP content response type is unsupported"), {
          code: result.resultType === "input_required" ? "MCP_INPUT_REQUIRED" : "MCP_RESULT_TYPE_UNSUPPORTED"
        });
      }
      return { value: boundCapabilityContent(result?.[field], field, maxBytes), hints: { ttlMs: result?.ttlMs, cacheScope: result?.cacheScope } };
    });
  }

  readResource(uri, opts = {}) {
    return this._readCapability("resources", "resources/read", { uri }, "contents", opts);
  }

  getPrompt(name, args = {}, opts = {}) {
    return this._readCapability("prompts", "prompts/get", { name, arguments: args }, "messages", opts);
  }

  async disconnect({ keepStatus = false } = {}) {
    this.subscriptions.stop();
    this._lifecycle.abort(Object.assign(new Error("MCP client disconnected"), { code: JSONRPC_ERRORS.SERVER_DISCONNECTED }));
    this._invalidateCapabilities();
    if (!keepStatus) this.status = "DISCONNECTED";

    if (this.transport) {
      this.transport.removeListener("close", this._onTransportClose);
      this.transport.removeListener("deprecated", this._onDeprecated);
      // 故意**保留** error 监听:close() 之后仍可能有迟到的网络错误(如 abort、
      // 连接重置)。移除监听会让 EventEmitter 把 'error' 当未处理异常直接抛出,
      // 把一次可控的传输失败变成进程级崩溃。
    }

    this.rpc.removeListener("notification", this._onNotification);
    this.rpc.close();

    if (this.transport && typeof this.transport.close === "function") {
      await this.transport.close();
    }

    this.emit("disconnected");
  }
}

export { PROTOCOL_MODE, MCP_SERVER_ERRORS, JSONRPC_ERRORS, BASELINE_PROTOCOL_VERSION };

function waitForInput(promise, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => { cleanup(); reject(signal.reason); };
    Promise.resolve(promise).then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function withoutContinuation(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const { inputRequests: _requests, inputResponses: _responses, requestState: _state, ...content } = result;
  return content;
}
