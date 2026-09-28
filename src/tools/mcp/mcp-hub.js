import { EventEmitter } from "node:events";
import { McpClient } from "./mcp-client.js";
import {
  formatExternalToolName,
  parseExternalToolName,
  cleanJsonSchema,
  inferCategory,
  formatToolResult,
  mcpToolToDeepSeekSchema
} from "./schema-converter.js";

export class McpHub extends EventEmitter {
  constructor({
    config = {},
    toolRegistry = null,
    cwd = process.cwd()
  } = {}) {
    super();
    this.rawConfigs = config.mcpServers || {};
    this.toolRegistry = toolRegistry;
    this.cwd = cwd;

    this.clients = new Map();
    this.serverTools = new Map(); // serverId -> toolDefs
    this.serverConfigs = new Map(); // serverId -> config

    for (const [serverId, srvConfig] of Object.entries(this.rawConfigs)) {
      if (srvConfig && typeof srvConfig === "object") {
        this.serverConfigs.set(serverId, { ...srvConfig });
      }
    }
  }

  setToolRegistry(registry) {
    this.toolRegistry = registry;
  }

  async initAll() {
    const results = [];
    for (const [serverId, srvConfig] of this.serverConfigs.entries()) {
      if (srvConfig.disabled) {
        results.push({ serverId, status: "DISABLED" });
        continue;
      }

      try {
        const client = this._createClient(serverId, srvConfig);
        await this._connectAndMount(serverId, client, srvConfig);
        results.push({ serverId, status: "CONNECTED", toolCount: this.serverTools.get(serverId)?.length || 0 });
      } catch (err) {
        results.push({ serverId, status: "ERROR", error: err.message });
      }
    }
    return results;
  }

  _createClient(serverId, srvConfig) {
    if (this.clients.has(serverId)) {
      const existing = this.clients.get(serverId);
      existing.disconnect().catch(() => {});
    }

    const client = new McpClient({
      serverId,
      command: srvConfig.command,
      args: srvConfig.args,
      env: srvConfig.env,
      cwd: srvConfig.cwd || this.cwd,
      timeoutMs: srvConfig.timeoutMs || 60000
    });

    client.on("error", (err) => {
      this.emit("server_error", { serverId, error: err });
    });

    client.on("disconnected", () => {
      if (this.toolRegistry) {
        this.toolRegistry.unmountExternalTools(serverId);
      }
      this.emit("server_disconnected", { serverId });
    });

    this.clients.set(serverId, client);
    return client;
  }

  async _connectAndMount(serverId, client, srvConfig) {
    await client.connect();

    const mcpTools = await client.listTools();
    const toolDefs = [];

    for (const tool of mcpTools) {
      const namespacedName = formatExternalToolName(serverId, tool.name);
      const rawFunctionSchema = mcpToolToDeepSeekSchema(serverId, tool);
      const category = inferCategory(tool.name, tool.description);

      const toolDef = {
        name: namespacedName,
        description: `[MCP: ${serverId}] ${tool.description || tool.name}`.trim(),
        category,
        source: "mcp",
        serverId,
        originalName: tool.name,
        rawFunctionSchema,
        inputSchema: cleanJsonSchema(tool.inputSchema),
        autoApprove: Array.isArray(srvConfig.autoApprove) && srvConfig.autoApprove.includes(tool.name),
        execute: async (params) => {
          const res = await client.callTool(tool.name, params);
          return formatToolResult(res);
        }
      };

      toolDefs.push(toolDef);
    }

    this.serverTools.set(serverId, toolDefs);

    if (this.toolRegistry) {
      this.toolRegistry.mountExternalTools(serverId, toolDefs);
    }

    this.emit("tools_mounted", { serverId, count: toolDefs.length });
  }

  async restartServer(serverId) {
    const srvConfig = this.serverConfigs.get(serverId);
    if (!srvConfig) {
      throw new Error(`MCP server '${serverId}' not found in configuration`);
    }

    if (this.toolRegistry) {
      this.toolRegistry.unmountExternalTools(serverId);
    }
    this.serverTools.delete(serverId);

    const client = this._createClient(serverId, srvConfig);
    await this._connectAndMount(serverId, client, srvConfig);
    return { serverId, status: "CONNECTED", toolCount: this.serverTools.get(serverId)?.length || 0 };
  }

  async toggleServer(serverId, enabled) {
    const srvConfig = this.serverConfigs.get(serverId);
    if (!srvConfig) {
      throw new Error(`MCP server '${serverId}' not found in configuration`);
    }

    srvConfig.disabled = !enabled;

    if (!enabled) {
      if (this.toolRegistry) {
        this.toolRegistry.unmountExternalTools(serverId);
      }
      this.serverTools.delete(serverId);
      const client = this.clients.get(serverId);
      if (client) {
        await client.disconnect();
      }
      return { serverId, status: "DISABLED" };
    } else {
      return await this.restartServer(serverId);
    }
  }

  async addServer(serverId, srvConfig, { autoStart = true } = {}) {
    if (!serverId || typeof serverId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(serverId)) {
      throw new Error(`Invalid MCP server ID: "${serverId}". Only alphanumeric characters, dashes, and underscores are allowed.`);
    }
    if (!srvConfig || typeof srvConfig !== "object" || !srvConfig.command || typeof srvConfig.command !== "string") {
      throw new Error("Invalid MCP server config: 'command' string is required");
    }

    const normalized = {
      command: srvConfig.command.trim(),
      args: Array.isArray(srvConfig.args) ? srvConfig.args.map(String) : [],
      env: srvConfig.env && typeof srvConfig.env === "object" && !Array.isArray(srvConfig.env) ? { ...srvConfig.env } : {},
      disabled: Boolean(srvConfig.disabled),
      autoApprove: Array.isArray(srvConfig.autoApprove) ? srvConfig.autoApprove.map(String) : [],
      ...(typeof srvConfig.cwd === "string" && srvConfig.cwd.trim() ? { cwd: srvConfig.cwd.trim() } : {}),
      timeoutMs: typeof srvConfig.timeoutMs === "number" && srvConfig.timeoutMs > 0 ? srvConfig.timeoutMs : 60000
    };

    if (this.serverConfigs.has(serverId)) {
      await this.removeServer(serverId);
    }

    this.serverConfigs.set(serverId, normalized);

    if (normalized.disabled || !autoStart) {
      this.emit("server_added", { serverId, status: normalized.disabled ? "DISABLED" : "CONFIGURED" });
      return { serverId, status: normalized.disabled ? "DISABLED" : "CONFIGURED", toolCount: 0 };
    }

    try {
      const client = this._createClient(serverId, normalized);
      await this._connectAndMount(serverId, client, normalized);
      const toolCount = this.serverTools.get(serverId)?.length || 0;
      this.emit("server_added", { serverId, status: "CONNECTED", toolCount });
      return { serverId, status: "CONNECTED", toolCount };
    } catch (err) {
      this.emit("server_added", { serverId, status: "ERROR", error: err.message });
      return { serverId, status: "ERROR", error: err.message, toolCount: 0 };
    }
  }

  async removeServer(serverId) {
    if (!this.serverConfigs.has(serverId)) {
      return { ok: false, notFound: true };
    }

    if (this.toolRegistry) {
      this.toolRegistry.unmountExternalTools(serverId);
    }
    this.serverTools.delete(serverId);

    const client = this.clients.get(serverId);
    if (client) {
      try {
        await client.disconnect();
      } catch { /* ignore */ }
      this.clients.delete(serverId);
    }

    this.serverConfigs.delete(serverId);
    this.emit("server_removed", { serverId });
    return { ok: true, serverId };
  }

  async stopAll() {
    for (const serverId of this.serverConfigs.keys()) {
      if (this.toolRegistry) {
        this.toolRegistry.unmountExternalTools(serverId);
      }
      this.serverTools.delete(serverId);
    }

    const promises = [];
    for (const client of this.clients.values()) {
      promises.push(client.disconnect().catch(() => {}));
    }
    await Promise.allSettled(promises);
    this.clients.clear();
  }

  getServer(serverId) {
    return this.clients.get(serverId) || null;
  }

  listServers() {
    const list = [];
    for (const [serverId, srvConfig] of this.serverConfigs.entries()) {
      const client = this.clients.get(serverId);
      const tools = this.serverTools.get(serverId) || [];

      let status = "DISCONNECTED";
      if (srvConfig.disabled) {
        status = "DISABLED";
      } else if (client) {
        status = client.getStatus();
      }

      list.push({
        serverId,
        command: srvConfig.command,
        args: srvConfig.args || [],
        disabled: Boolean(srvConfig.disabled),
        autoApprove: srvConfig.autoApprove || [],
        status,
        serverInfo: client?.serverInfo || null,
        toolCount: tools.length,
        tools: tools.map((t) => ({
          name: t.name,
          originalName: t.originalName,
          description: t.description,
          category: t.category,
          autoApprove: t.autoApprove
        })),
        error: client?.getLastError()?.message || null,
        stderr: client?.getRecentStderr() || ""
      });
    }
    return list;
  }

  async callTool(namespacedName, params = {}) {
    const parsed = parseExternalToolName(namespacedName);
    if (!parsed) {
      throw new Error(`Invalid MCP tool name: ${namespacedName}`);
    }
    const { serverId, originalName } = parsed;
    const client = this.clients.get(serverId);
    if (!client || client.getStatus() !== "CONNECTED") {
      throw new Error(`MCP server '${serverId}' is not connected`);
    }

    const res = await client.callTool(originalName, params);
    return formatToolResult(res);
  }
}
