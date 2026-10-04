import { EventEmitter } from "node:events";
import { McpClient } from "./mcp-client.js";
import {
  loadMcpConfig,
  bindInputs,
  resolveServerEnvAndHeaders,
  auditConfigSecrets
} from "./config-loader.js";
import {
  formatExternalToolName,
  parseExternalToolName,
  cleanJsonSchema,
  inferCategory,
  formatToolResult,
  summarizeToolResult,
  mcpToolToDeepSeekSchema
} from "./schema-converter.js";

const DEFAULT_MAX_PARALLEL_INIT = 4;
const DEFAULT_RECONNECT_BASE_MS = 500;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;

export class McpHub extends EventEmitter {
  constructor({
    config = {},
    toolRegistry = null,
    cwd = process.cwd(),
    maxParallelInit = DEFAULT_MAX_PARALLEL_INIT,
    reconnect = {},
    inputs = null,
    projectRoot = null,
    loadConfigScopes = false,
    /** v1.12.0:SSRF 私网允许清单(仅对列出的目标放行,默认空 = 全部 fail-closed) */
    httpAllowlist = []
  } = {}) {
    super();
    this.toolRegistry = toolRegistry;
    this.cwd = cwd;
    this.maxParallelInit = Math.max(1, Number(maxParallelInit) || DEFAULT_MAX_PARALLEL_INIT);
    this.reconnectBaseMs = reconnect.baseMs ?? DEFAULT_RECONNECT_BASE_MS;
    this.reconnectMaxMs = reconnect.maxMs ?? DEFAULT_RECONNECT_MAX_MS;
    this.maxReconnectAttempts = reconnect.maxAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
    this.httpAllowlist = Array.isArray(httpAllowlist) ? [...httpAllowlist] : [];

    this.clients = new Map();
    this.serverTools = new Map();
    this.serverConfigs = new Map();
    this._reconnectState = new Map();
    this._remounting = new Set();
    this._stopping = new Set();

    this.rawConfigs = config.mcpServers || {};
    this.inputs = inputs && typeof inputs === "object" ? { ...inputs } : {};
    this.projectRoot = projectRoot || cwd;

    if (loadConfigScopes) {
      const loaded = loadMcpConfig({
        projectRoot: this.projectRoot,
        sessionServers: config.mcpServers || {},
        sessionInputs: config.inputs || {},
        warn: (msg) => this.emit("config_warn", { message: msg })
      });
      this.rawConfigs = loaded.servers;
      this.inputs = bindInputs({ ...loaded.inputs, ...this.inputs });
      this.configSources = loaded.source;
      this.configPaths = loaded.paths;
      auditConfigSecrets(loaded.servers, {
        source: loaded.source,
        warn: (msg) => this.emit("config_warn", { message: msg })
      });
    } else {
      this.inputs = bindInputs(this.inputs);
      this.configSources = {};
      this.configPaths = null;
    }

    for (const [serverId, srvConfig] of Object.entries(this.rawConfigs)) {
      if (srvConfig && typeof srvConfig === "object") {
        this.serverConfigs.set(serverId, { ...srvConfig });
      }
    }
  }

  setInputValue(name, value) {
    this.inputs[name] = {
      ...(this.inputs[name] || { type: "promptString" }),
      value
    };
  }

  _resolveServerConfig(srvConfig) {
    return resolveServerEnvAndHeaders(srvConfig, this.inputs, { onMissing: "keep" });
  }

  setToolRegistry(registry) {
    this.toolRegistry = registry;
  }

  async initAll() {
    const entries = [...this.serverConfigs.entries()].filter(
      ([, cfg]) => !cfg.disabled
    );
    const disabled = [...this.serverConfigs.entries()]
      .filter(([, cfg]) => cfg.disabled)
      .map(([serverId]) => ({ serverId, status: "DISABLED" }));

    const results = [...disabled];
    const queue = entries.slice();

    const workers = Array.from(
      { length: Math.min(this.maxParallelInit, queue.length) },
      async () => {
        while (queue.length > 0) {
          const [serverId, srvConfig] = queue.shift();
          try {
            const client = this._createClient(serverId, srvConfig);
            await this._connectAndMount(serverId, client, srvConfig);
            results.push({
              serverId,
              status: "CONNECTED",
              protocolMode: client.getProtocolMode(),
              toolCount: this.serverTools.get(serverId)?.length || 0
            });
          } catch (err) {
            results.push({ serverId, status: "ERROR", error: err.message });
          }
        }
      }
    );

    await Promise.all(workers);
    return results;
  }

  _createClient(serverId, srvConfig) {
    if (this.clients.has(serverId)) {
      const existing = this.clients.get(serverId);
      existing.disconnect().catch(() => {});
    }

    const resolved = this._resolveServerConfig(srvConfig);

    const client = new McpClient({
      serverId,
      command: resolved.command,
      args: resolved.args,
      env: resolved.env,
      cwd: resolved.cwd || this.cwd,
      timeoutMs: resolved.timeoutMs || 60000,
      protocolMode: resolved.protocolMode || "auto",
      discoverTimeoutMs: resolved.discoverTimeoutMs || 500,
      // v1.12.0:远程传输。url/type 由配置决定;allowlist 与 headers 在此透传,
      // SSRF 校验在传输层的每一跳执行。
      url: resolved.url,
      type: resolved.type,
      headers: resolved.headers,
      allowlist: resolved.allowlist || this.httpAllowlist,
      maxRedirects: resolved.maxRedirects,
      retryOnStreamBreak: resolved.retryOnStreamBreak
    });

    // v1.12.0:legacy SSE 为已废弃通道 —— 透出事件,供 event-contract 与三端提示
    client.on("deprecated", ({ reason }) => {
      this.emit("server_deprecated", { serverId, reason });
    });

    client.on("error", (err) => {
      this.emit("server_error", { serverId, error: err });
    });

    client.on("disconnected", () => {
      if (this.toolRegistry) {
        this.toolRegistry.unmountExternalTools(serverId);
      }
      this.serverTools.delete(serverId);
      this.emit("server_disconnected", { serverId });
      const st = this._reconnectState.get(serverId);
      if (!this._stopping.has(serverId) && st?.everConnected) {
        this._scheduleReconnect(serverId);
      }
    });

    client.on("list_changed", async () => {
      await this._remountTools(serverId, client);
    });

    this.clients.set(serverId, client);
    return client;
  }

  async _connectAndMount(serverId, client, srvConfig) {
    await client.connect();

    const mcpTools = await client.listTools();
    this._mountTools(serverId, mcpTools, client, srvConfig);

    const st = this._reconnectState.get(serverId) || {
      attempts: 0,
      timer: null,
      everConnected: true
    };
    st.everConnected = true;
    st.attempts = 0;
    this._reconnectState.set(serverId, st);
    this._clearReconnectTimer(serverId);

    this.emit("server_status", {
      serverId,
      status: "CONNECTED",
      protocolMode: client.getProtocolMode(),
      protocolVersion: client.protocolVersion
    });
  }

  _mountTools(serverId, mcpTools, client, srvConfig) {
    const toolDefs = [];
    const toolPolicy = srvConfig.tools || { enabled: ["*"], disabled: [] };
    const enabled = new Set(toolPolicy.enabled || ["*"]);
    const disabled = new Set(toolPolicy.disabled || []);

    for (const tool of mcpTools) {
      if (disabled.has(tool.name)) continue;
      if (!enabled.has("*") && !enabled.has(tool.name)) continue;

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
        autoApprove:
          Array.isArray(srvConfig.autoApprove) && srvConfig.autoApprove.includes(tool.name),
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

  async _remountTools(serverId, client) {
    if (this._remounting.has(serverId)) return;
    this._remounting.add(serverId);
    try {
      const srvConfig = this.serverConfigs.get(serverId) || {};
      const mcpTools = await client.listTools();
      this._mountTools(serverId, mcpTools, client, srvConfig);
      this.emit("tools_changed", {
        serverId,
        count: mcpTools.length
      });
    } catch (err) {
      this.emit("server_error", { serverId, error: err });
    } finally {
      this._remounting.delete(serverId);
    }
  }

  _clearReconnectTimer(serverId) {
    const st = this._reconnectState.get(serverId);
    if (st?.timer) {
      clearTimeout(st.timer);
      st.timer = null;
    }
  }

  _clearReconnect(serverId) {
    this._clearReconnectTimer(serverId);
    this._reconnectState.delete(serverId);
  }

  _scheduleReconnect(serverId) {
    const srvConfig = this.serverConfigs.get(serverId);
    if (!srvConfig || srvConfig.disabled || this._stopping.has(serverId)) return;

    const st = this._reconnectState.get(serverId) || {
      attempts: 0,
      timer: null,
      everConnected: true
    };
    if (st.timer) return;

    if (st.attempts >= this.maxReconnectAttempts) {
      this.emit("server_status", {
        serverId,
        status: "DEGRADED",
        attempts: st.attempts
      });
      return;
    }

    const delay = Math.min(
      this.reconnectMaxMs,
      this.reconnectBaseMs * 2 ** st.attempts
    );
    const jitter = Math.floor(Math.random() * (delay * 0.2));
    const waitMs = delay + jitter;

    st.attempts += 1;
    st.timer = setTimeout(() => {
      st.timer = null;
      if (this._stopping.has(serverId)) return;
      this.restartServer(serverId).catch((err) => {
        this.emit("server_error", { serverId, error: err });
        this._scheduleReconnect(serverId);
      });
    }, waitMs);
    if (typeof st.timer.unref === "function") st.timer.unref();

    this._reconnectState.set(serverId, st);
    this.emit("server_status", {
      serverId,
      status: "RECONNECTING",
      attempts: st.attempts,
      waitMs
    });
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
    return {
      serverId,
      status: "CONNECTED",
      protocolMode: client.getProtocolMode(),
      toolCount: this.serverTools.get(serverId)?.length || 0
    };
  }

  async toggleServer(serverId, enabled) {
    const srvConfig = this.serverConfigs.get(serverId);
    if (!srvConfig) {
      throw new Error(`MCP server '${serverId}' not found in configuration`);
    }

    srvConfig.disabled = !enabled;

    if (!enabled) {
      this._stopping.add(serverId);
      try {
        this._clearReconnect(serverId);
        if (this.toolRegistry) {
          this.toolRegistry.unmountExternalTools(serverId);
        }
        this.serverTools.delete(serverId);
        const client = this.clients.get(serverId);
        if (client) {
          await client.disconnect();
        }
        return { serverId, status: "DISABLED" };
      } finally {
        this._stopping.delete(serverId);
      }
    } else {
      return await this.restartServer(serverId);
    }
  }

  async addServer(serverId, srvConfig, { autoStart = true } = {}) {
    if (!serverId || typeof serverId !== "string" || !/^[a-zA-Z0-9_.-]+$/.test(serverId)) {
      throw new Error(
        `Invalid MCP server ID: "${serverId}". Only alphanumeric, dot, dash, underscore allowed.`
      );
    }
    if (
      !srvConfig ||
      typeof srvConfig !== "object" ||
      (!srvConfig.command && !srvConfig.url)
    ) {
      throw new Error("Invalid MCP server config: 'command' or 'url' is required");
    }

    const normalized = {
      command: typeof srvConfig.command === "string" ? srvConfig.command.trim() : "",
      args: Array.isArray(srvConfig.args) ? srvConfig.args.map(String) : [],
      env:
        srvConfig.env && typeof srvConfig.env === "object" && !Array.isArray(srvConfig.env)
          ? { ...srvConfig.env }
          : {},
      disabled: Boolean(srvConfig.disabled),
      autoApprove: Array.isArray(srvConfig.autoApprove) ? srvConfig.autoApprove.map(String) : [],
      timeoutMs:
        typeof srvConfig.timeoutMs === "number" && srvConfig.timeoutMs > 0
          ? srvConfig.timeoutMs
          : 60000
    };
    if (typeof srvConfig.url === "string" && srvConfig.url.trim()) {
      normalized.url = srvConfig.url.trim();
      normalized.type = srvConfig.type || "streamable-http";
    }
    if (typeof srvConfig.cwd === "string" && srvConfig.cwd.trim()) {
      normalized.cwd = srvConfig.cwd.trim();
    }

    if (this.serverConfigs.has(serverId)) {
      await this.removeServer(serverId);
    }

    this.serverConfigs.set(serverId, normalized);

    if (normalized.disabled || !autoStart) {
      this.emit("server_added", {
        serverId,
        status: normalized.disabled ? "DISABLED" : "CONFIGURED"
      });
      return {
        serverId,
        status: normalized.disabled ? "DISABLED" : "CONFIGURED",
        toolCount: 0
      };
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

    this._stopping.add(serverId);
    try {
      this._clearReconnect(serverId);
      if (this.toolRegistry) {
        this.toolRegistry.unmountExternalTools(serverId);
      }
      this.serverTools.delete(serverId);

      const client = this.clients.get(serverId);
      if (client) {
        try {
          await client.disconnect();
        } catch {
          /* ignore */
        }
        this.clients.delete(serverId);
      }

      this.serverConfigs.delete(serverId);
      this._reconnectState.delete(serverId);
      this.emit("server_removed", { serverId });
      return { ok: true, serverId };
    } finally {
      this._stopping.delete(serverId);
    }
  }

  async stopAll() {
    for (const serverId of this.serverConfigs.keys()) {
      this._stopping.add(serverId);
      this._clearReconnect(serverId);
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
    this._stopping.clear();
  }

  getServer(serverId) {
    return this.clients.get(serverId) || null;
  }

  listServers() {
    const list = [];
    for (const [serverId, srvConfig] of this.serverConfigs.entries()) {
      const client = this.clients.get(serverId);
      const tools = this.serverTools.get(serverId) || [];
      const reconnect = this._reconnectState.get(serverId);

      let status = "DISCONNECTED";
      if (srvConfig.disabled) {
        status = "DISABLED";
      } else if (reconnect?.attempts >= this.maxReconnectAttempts) {
        status = "DEGRADED";
      } else if (client) {
        status = client.getStatus();
      }

      list.push({
        serverId,
        command: srvConfig.command || null,
        url: srvConfig.url || null,
        type: srvConfig.type || (srvConfig.url ? "streamable-http" : "stdio"),
        args: srvConfig.args || [],
        disabled: Boolean(srvConfig.disabled),
        autoApprove: srvConfig.autoApprove || [],
        status,
        protocolMode: client?.getProtocolMode?.() || "unknown",
        protocolVersion: client?.protocolVersion || null,
        // v1.12.0:legacy SSE 通道的弃用提示透出给界面
        deprecatedTransport: client?.deprecatedTransport || null,
        configSource: this.configSources?.[serverId] || null,
        reconnectAttempts: reconnect?.attempts || 0,
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

  listInputs() {
    return Object.entries(this.inputs || {}).map(([name, def]) => ({
      name,
      type: def?.type || "promptString",
      description: def?.description || "",
      password: Boolean(def?.password),
      hasValue: def?.value !== undefined && def?.value !== null && def?.value !== "",
      source: def?.value !== undefined ? "bound" : "missing"
    }));
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

  async callToolDetailed(namespacedName, params = {}) {
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
    return summarizeToolResult(res);
  }
}
