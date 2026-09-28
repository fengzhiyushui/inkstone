import { EventEmitter } from "node:events";
import { StdioTransport } from "./stdio-transport.js";
import { JsonRpcClient } from "./jsonrpc-client.js";

export const MCP_PROTOCOL_VERSION = "2024-11-05";
export const MCP_CLIENT_INFO = Object.freeze({
  name: "inkstone",
  version: "1.11.0"
});

export class McpClient extends EventEmitter {
  constructor({
    serverId,
    command = "",
    args = [],
    env = {},
    cwd = process.cwd(),
    timeoutMs = 60000,
    transport = null
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

    this.status = "DISCONNECTED";
    this.serverInfo = null;
    this.serverCapabilities = {};
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
  }

  getStatus() {
    return this.status;
  }

  getLastError() {
    return this.lastError;
  }

  getRecentStderr() {
    return this.transport?.getRecentStderr?.() || "";
  }

  async connect() {
    if (this.status === "CONNECTED") {
      return;
    }
    this.status = "CONNECTING";
    this.lastError = null;

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

      if (typeof this.transport.start === "function") {
        this.transport.start();
      }

      // 1. Handshake: initialize request
      const initResult = await this.rpc.request(
        "initialize",
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          clientInfo: MCP_CLIENT_INFO
        },
        { timeoutMs: 15000 }
      );

      this.serverInfo = initResult?.serverInfo || null;
      this.serverCapabilities = initResult?.capabilities || {};

      // 2. Handshake: initialized notification
      this.rpc.notify("notifications/initialized");

      this.status = "CONNECTED";
      this.emit("connected", {
        serverInfo: this.serverInfo,
        capabilities: this.serverCapabilities
      });
    } catch (err) {
      this.status = "ERROR";
      this.lastError = err;
      await this.disconnect().catch(() => {});
      throw err;
    }
  }

  async listTools() {
    if (this.status !== "CONNECTED") {
      throw new Error(
        `MCP client '${this.serverId}' is not connected (current status: ${this.status})`
      );
    }

    const result = await this.rpc.request("tools/list", {}, { timeoutMs: this.timeoutMs });
    return result?.tools || [];
  }

  async callTool(name, toolArguments = {}) {
    if (this.status !== "CONNECTED") {
      throw new Error(
        `MCP client '${this.serverId}' is not connected (current status: ${this.status})`
      );
    }

    const result = await this.rpc.request(
      "tools/call",
      {
        name,
        arguments: toolArguments
      },
      { timeoutMs: this.timeoutMs }
    );

    return result || { content: [], isError: false };
  }

  async disconnect() {
    this.status = "DISCONNECTED";

    if (this.transport) {
      this.transport.removeListener("close", this._onTransportClose);
      this.transport.removeListener("error", this._onTransportError);
    }

    this.rpc.close();

    if (this.transport && typeof this.transport.close === "function") {
      await this.transport.close();
    }

    this.emit("disconnected");
  }
}
