import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { StdioTransport } from "./stdio-transport.js";
import { JsonRpcClient, JSONRPC_ERRORS } from "./jsonrpc-client.js";
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
    discoverTimeoutMs = 500
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
      this.emit("error", err);
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
        this.transport = new StdioTransport({
          command: this.command,
          args: this.args,
          env: this.env,
          cwd: this.cwd
        });
      }

      this.transport.on("close", this._onTransportClose);
      this.transport.on("error", this._onTransportError);

      this.rpc.setTransport(this.transport);
      this.rpc.on("notification", this._onNotification);

      if (typeof this.transport.start === "function") {
        this.transport.start();
      }

      const wantModern = this.requestedProtocolMode !== "legacy";
      const wantLegacy = this.requestedProtocolMode !== "modern";

      if (wantModern && (this.requestedProtocolMode === "modern" || this.requestedProtocolMode === "auto")) {
        const probed = await this._tryModernConnect();
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
        await this._legacyConnect();
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
      await this.disconnect().catch(() => {});
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
      this.protocolVersion = version;
      this.serverInfo = discover.serverInfo || discover.server || null;
      this.serverCapabilities = discover.capabilities || {};
      return true;
    }

    // discover answered but only legacy versions — still use modern meta? No: use legacy handshake with negotiated version
    this.protocolVersion = version;
    await this._legacyConnect(version);
    return true;
  }

  async _modernFromVersionError(err) {
    const supported = err?.data?.supported || [];
    const version = pickMutualVersion(supported, SUPPORTED_PROTOCOL_VERSIONS);
    if (!version || version !== MODERN_PROTOCOL_VERSION) {
      // Can't speak modern with this server
      if (version) {
        this.protocolVersion = version;
        await this._legacyConnect(version);
        this.protocolMode = PROTOCOL_MODE.LEGACY;
        return true;
      }
      return false;
    }
    this.protocolMode = PROTOCOL_MODE.MODERN;
    this.protocolVersion = version;
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
    this.protocolVersion = initResult?.protocolVersion || requested;
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

  async disconnect() {
    this.status = "DISCONNECTED";

    if (this.transport) {
      this.transport.removeListener("close", this._onTransportClose);
      this.transport.removeListener("error", this._onTransportError);
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
