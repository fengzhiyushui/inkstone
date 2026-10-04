import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { JsonRpcClient, JSONRPC_ERRORS } from "./jsonrpc-client.js";
import { createTransport } from "./transport.js";
import {
  MODERN_PROTOCOL_VERSION,
  LEGACY_PROTOCOL_VERSION,
  BASELINE_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  PROTOCOL_MODE,
  DEFAULT_CLIENT_CAPABILITIES,
  META_KEYS,
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
    maxBodyBytes
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

    // v1.12.0:传输选择。显式注入的 transport 优先;否则按 url/type 走统一工厂 ——
    // stdio 仍是默认,既有调用方与测试迁移不破。
    this.transportConfig = {
      command, args: this.args, env: this.env, cwd,
      url, type, headers, timeoutMs,
      allowlist, lookup, maxRedirects, retryOnStreamBreak, maxBodyBytes
    };
    this.requestedTransportType = (url || type) ? (type || "streamable-http") : "stdio";
    this.deprecatedTransport = null;

    this.status = "DISCONNECTED";
    this.protocolMode = PROTOCOL_MODE.UNKNOWN;
    this.protocolVersion = null;
    this.serverInfo = null;
    this.serverCapabilities = {};
    this.clientCapabilities = { ...DEFAULT_CLIENT_CAPABILITIES };
    this.lastError = null;

    this.transport = transport;
    this.rpc = new JsonRpcClient({ defaultTimeoutMs: this.timeoutMs });

    this._onTransportClose = (info) => {
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
      const method = message?.method || "";
      if (method.endsWith("/list_changed") || method === "notifications/tools/list_changed") {
        this.emit("list_changed", { method, params: message?.params });
      }
      if (method === "notifications/cancelled") {
        this.emit("cancelled", message?.params);
      }
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
    return this.rpc.request(method, params, {
      ...opts,
      meta: useMeta ? this._buildMeta() : opts.meta
    });
  }

  async connect() {
    if (this.status === "CONNECTED") {
      return;
    }
    this.status = "CONNECTING";
    this.lastError = null;
    this.protocolMode = PROTOCOL_MODE.UNKNOWN;
    this.protocolVersion = null;

    try {
      if (!this.transport) {
        // v1.12.0:统一经工厂选择传输(stdio / streamable-http / legacy sse)
        this.transport = createTransport(this.transportConfig);
      }

      this.transport.on("close", this._onTransportClose);
      this.transport.on("error", this._onTransportError);
      if (typeof this.transport.on === "function") {
        // legacy SSE 是已废弃通道:透出标记,供事件契约与诊断提示
        this.transport.on("deprecated", ({ reason }) => {
          this.deprecatedTransport = reason;
          this.emit("deprecated", { reason });
        });
        if (this.transport.deprecated) this.deprecatedTransport = "legacy transport";
      }

      this.rpc.setTransport(this.transport);
      this.rpc.on("notification", this._onNotification);
      // JsonRpcClient 会把传输错误再 emit 一次;没有监听者时 EventEmitter 会把它
      // 当未处理异常抛出 → 进程级崩溃。这里必须接住,转成本客户端的 error 事件。
      this.rpc.on("error", this._onTransportError);

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
        capabilities: this.clientCapabilities,
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

  async listTools() {
    if (this.status !== "CONNECTED") {
      throw new Error(
        `MCP client '${this.serverId}' is not connected (current status: ${this.status})`
      );
    }

    const result = await this._request("tools/list", {}, { timeoutMs: this.timeoutMs });
    return result?.tools || [];
  }

  async callTool(name, toolArguments = {}) {
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
      { timeoutMs: this.timeoutMs }
    );

    return result || { content: [], isError: false, resultType: "complete" };
  }

  async disconnect({ keepStatus = false } = {}) {
    if (!keepStatus) this.status = "DISCONNECTED";

    if (this.transport) {
      this.transport.removeListener("close", this._onTransportClose);
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
