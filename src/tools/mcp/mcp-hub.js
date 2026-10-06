import { EventEmitter } from "node:events";
import { McpClient } from "./mcp-client.js";
import { McpOAuthClient } from "./auth/oauth-client.js";
import { createMcpDisplayRedactor, sanitizeMcpSchema } from "../../security/mcp-content.js";
import {
  loadMcpConfig,
  bindInputs,
  resolveServerEnvAndHeaders,
  auditConfigSecrets,
  normalizeServerConfig
} from "./config-loader.js";
import {
  formatExternalToolName,
  parseExternalToolName,
  cleanJsonSchema,
  formatToolResult,
  summarizeToolResult,
  toToolExecutionResult,
  mcpToolToDeepSeekSchema
} from "./schema-converter.js";
import { resolveToolRisk, annotationsFromTool, riskBadge } from "./annotations.js";
import { isToolEnabled, resolveConfiguredScope, asPolicy } from "./tool-policy.js";
import { createMcpDiagnostics, MCP_HUB_EVENTS, summarizeFrame, diagnosticCategory } from "./diagnostics.js";
import { createMcpInputBroker } from "./input-broker.js";

const DEFAULT_MAX_PARALLEL_INIT = 4;
const DEFAULT_RECONNECT_BASE_MS = 500;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;

function sanitizedMcpError(error, redact) {
  const sanitized = new Error(redact(error?.message || String(error)));
  // RPC data/cause/stack may contain the same secret; expose only the safe message and code.
  if (typeof error?.code === "number" || typeof error?.code === "string") sanitized.code = redact(error.code);
  return sanitized;
}

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
    httpAllowlist = [],
    oauthCredentialRoot = undefined,
    diagnostics = {}
  } = {}) {
    super();
    this.toolRegistry = toolRegistry;
    this.cwd = cwd;
    this.maxParallelInit = Math.max(1, Number(maxParallelInit) || DEFAULT_MAX_PARALLEL_INIT);
    this.reconnectBaseMs = reconnect.baseMs ?? DEFAULT_RECONNECT_BASE_MS;
    this.reconnectMaxMs = reconnect.maxMs ?? DEFAULT_RECONNECT_MAX_MS;
    this.maxReconnectAttempts = reconnect.maxAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
    this.httpAllowlist = Array.isArray(httpAllowlist) ? [...httpAllowlist] : [];
    this.oauthCredentialRoot = oauthCredentialRoot;
    this.oauthClients = new Map();
    this.oauthSecrets = new Set();
    this.inputSecrets = new Set();
    this.subscriptionStates = new Map();
    this._authRequired = new Set();

    this.clients = new Map();
    this.serverTools = new Map();
    this.serverConfigs = new Map();
    this._reconnectState = new Map();
    this._remounting = new Set();
    this._stopping = new Set();
    this._capabilityConnections = new Map();

    this.rawConfigs = config.mcpServers || {};
    this.inputs = inputs && typeof inputs === "object" ? { ...inputs } : {};
    this.projectRoot = projectRoot || cwd;
    this.diagnostics = createMcpDiagnostics({ root: this.projectRoot, hub: this, ...diagnostics });
    for (const name of MCP_HUB_EVENTS.filter((name) => name !== "log")) {
      this.on(name, (event = {}) => this._recordDiagnostic({
        ...event, kind: name,
        level: event.error ? "error" : name === "config_warn" || name === "auth_required" ? "warn" : "info",
        category: name.startsWith("auth_") ? "auth" : name === "tool_test" ? "tool" : event.error ? diagnosticCategory(event.error) : "lifecycle",
        message: event.error?.message || event.message || event.reason
      }));
    }

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
    this.inputBroker = createMcpInputBroker({ hub: this });
  }

  setInputValue(name, value) {
    this.inputs[name] = {
      ...(this.inputs[name] || { type: "promptString" }),
      value
    };
  }

  _recordDiagnostic(entry) {
    const recorded = this.diagnostics.record(entry);
    this.emit("log", { ...(recorded.serverId ? { serverId: recorded.serverId } : {}), entry: recorded });
  }

  getLogs(serverId, options) { return this.diagnostics.getLogs(serverId, options); }
  exportLogs(serverId, options) { return this.diagnostics.exportLogs(serverId, options); }
  listInputRequests() { return this.inputBroker.list(); }
  respondInputRequest(requestId, response) { return this.inputBroker.respond(requestId, response); }

  async listTools(serverId) {
    if (this.serverConfigs.get(serverId)?.disabled || this.getServer(serverId)?.getStatus() !== "CONNECTED") return [];
    const clean = createMcpDisplayRedactor({ hub: this });
    return (this.serverTools.get(serverId) || []).map((tool) => ({
      name: tool.name, originalName: tool.originalName, category: tool.category,
      description: clean(tool.description), inputSchema: sanitizeMcpSchema(tool.rawInputSchema ?? tool.inputSchema, clean)
    }));
  }

  _oauthClient(serverId) {
    const config = this.serverConfigs.get(serverId);
    if (!config) throw new Error(`MCP server '${serverId}' not found in configuration`);
    if (config.oauth?.enabled !== true) return null;
    if (this.oauthClients.has(serverId)) return this.oauthClients.get(serverId);
    if (!config.url || config.type === "stdio") {
      throw new Error("MCP OAuth requires a remote HTTP server");
    }
    const client = new McpOAuthClient({
      serverId, config: this._resolveServerConfig(config),
      allowlist: config.allowlist || this.httpAllowlist,
      credentialRoot: this.oauthCredentialRoot,
      onSecrets: (values) => { for (const value of values) if (value) this.oauthSecrets.add(value); },
      onAuthRequired: () => {
        if (this.oauthClients.get(serverId) !== client) return;
        this.inputBroker.cancelServer(serverId);
        const first = !this._authRequired.has(serverId);
        this._authRequired.add(serverId);
        this._clearReconnect(serverId);
        this.clients.get(serverId)?._invalidateCapabilities();
        this.toolRegistry?.unmountExternalTools(serverId);
        this.serverTools.delete(serverId);
        if (first) this.emit("auth_required", { serverId, status: "AUTH_REQUIRED", message: "Sign in to this MCP server" });
        this.emit("server_status", { serverId, status: "AUTH_REQUIRED" });
      },
      onAuthorized: async () => {
        if (this.oauthClients.get(serverId) !== client) return;
        this._authRequired.delete(serverId);
        if (this.serverConfigs.get(serverId)?.disabled || this._stopping.has(serverId)) return;
        try { await this.restartServer(serverId); }
        catch (error) {
          this.emit("server_error", { serverId, error: sanitizedMcpError(error, createMcpDisplayRedactor({ hub: this })) });
        }
        if (this.oauthClients.get(serverId) === client) this.emit("auth_status", { serverId, status: "authenticated" });
      }
    });
    this.oauthClients.set(serverId, client);
    return client;
  }

  async getAuthStatus(serverId) {
    const oauth = this._oauthClient(serverId);
    if (!oauth) return { serverId, status: "disabled" };
    if (!this.serverConfigs.get(serverId)?.disabled && oauth.getStatus().status !== "pending") await oauth.getAccessToken();
    return { serverId, ...oauth.getStatus() };
  }

  async startAuth(serverId) {
    if (this.serverConfigs.get(serverId)?.disabled) throw new Error("Enable the MCP server before signing in");
    const oauth = this._oauthClient(serverId);
    if (!oauth) throw new Error("OAuth is not enabled for this MCP server");
    const result = await oauth.startAuthorization();
    this.emit("auth_status", { serverId, status: "pending" });
    return { serverId, ...result };
  }

  async cancelAuth(serverId) {
    const oauth = this._oauthClient(serverId);
    await oauth?.cancelAuthorization();
    const result = { serverId, ...(oauth?.getStatus() || { status: "disabled" }) };
    this.emit("auth_status", { serverId, status: result.status });
    return result;
  }

  async logoutAuth(serverId) {
    this.inputBroker.cancelServer(serverId);
    const oauth = this._oauthClient(serverId);
    this._stopping.add(serverId);
    try {
      this._clearReconnect(serverId);
      await this.clients.get(serverId)?.disconnect();
      this.clients.delete(serverId);
      this.toolRegistry?.unmountExternalTools(serverId);
      this.serverTools.delete(serverId);
      await oauth?.logout();
      if (oauth) this._authRequired.add(serverId);
      this.emit("server_status", { serverId, status: oauth ? "AUTH_REQUIRED" : "DISCONNECTED" });
      this.emit("auth_status", { serverId, status: oauth ? "unauthenticated" : "disabled" });
      return { serverId, status: oauth ? "unauthenticated" : "disabled" };
    } finally { this._stopping.delete(serverId); }
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
    this.inputBroker.cancelServer(serverId);
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
      retryOnStreamBreak: resolved.retryOnStreamBreak,
      oauthProvider: resolved.oauth?.enabled === true ? this._oauthClient(serverId) : null,
      elicitation: resolved.elicitation,
      subscriptions: resolved.subscriptions,
      inputHandler: (request) => this.inputBroker.request(request, client)
    });
    client.on("subscription_status", (event) => {
      if (this.clients.get(serverId) !== client) return;
      this.subscriptionStates.set(serverId, event.status);
      this.emit("subscription_status", { serverId, ...event });
    });

    client.on("trace", ({ direction, frame }) => this._recordDiagnostic({
      serverId, kind: "frame", direction, level: "debug", category: "protocol", ...summarizeFrame(frame)
    }));
    client.on("request_completed", (event) => this._recordDiagnostic({
      serverId, kind: "request", ...event,
      level: event.status === "success" ? "info" : event.status === "cancelled" ? "warn" : "error",
      category: event.status === "cancelled" ? "cancelled" : event.status === "timeout" ? "timeout" : event.error ? diagnosticCategory(event.error, event.method) : "protocol",
      // Remote error text may echo arbitrary arguments, including credentials
      // entered only for this call. Persist the status/code, never that body.
      message: event.error ? `MCP request ${event.status} (${typeof event.error.code === "number" ? event.error.code : diagnosticCategory(event.error)})` : undefined
    }));

    // v1.12.0:legacy SSE 为已废弃通道 —— 透出事件,供 event-contract 与三端提示
    client.on("deprecated", ({ reason }) => {
      this.emit("server_deprecated", { serverId, reason });
    });

    client.on("error", (err) => {
      this.emit("server_error", { serverId, error: sanitizedMcpError(err, createMcpDisplayRedactor({ hub: this })) });
    });

    client.on("disconnected", () => {
      if (this.clients.get(serverId) !== client) return;
      this.inputBroker.cancelServer(serverId);
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

    client.on("list_changed", async ({ method = "" } = {}) => {
      if (this.clients.get(serverId) !== client) return;
      if (method.includes("resources/") || method.includes("templates/")) {
        this.emit("resources_changed", { serverId, method });
      } else if (method.includes("prompts/")) {
        this.emit("prompts_changed", { serverId, method });
      } else if (method.includes("tools/") || !method) {
        this.inputBroker.cancelServer(serverId);
        await this._remountTools(serverId, client);
      }
    });

    this.clients.set(serverId, client);
    return client;
  }

  async _connectAndMount(serverId, client, srvConfig) {
    const configIdentity = this.serverConfigs.get(serverId);
    const assertCurrent = () => {
      if (this.clients.get(serverId) !== client || this.serverConfigs.get(serverId) !== configIdentity
          || configIdentity?.disabled || this._stopping.has(serverId)) {
        throw Object.assign(new Error("MCP connection was stopped or replaced"), { code: "MCP_CONNECTION_SUPERSEDED" });
      }
    };
    // Metadata and token refresh must not consume the short protocol-era probe budget.
    await this.oauthClients.get(serverId)?.getAccessToken();
    assertCurrent();
    await client.connect();
    assertCurrent();
    this._authRequired.delete(serverId);

    // Older servers omitted capabilities even when they exposed tools. Preserve
    // that compatibility, but never probe tools on an explicit resources/prompts-only server.
    const caps = client.serverCapabilities || {};
    const supportsTools = caps.tools !== false && (caps.tools !== undefined || (!caps.resources && !caps.prompts));
    const mcpTools = supportsTools ? await client.listTools() : [];
    assertCurrent();
    if (this._authRequired.has(serverId)) throw Object.assign(new Error("MCP authorization required"), { code: "MCP_AUTH_REQUIRED" });
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

    for (const tool of mcpTools) {
      if (!isToolEnabled(srvConfig.tools, tool.name)) continue;

      const namespacedName = formatExternalToolName(serverId, tool.name);
      const rawFunctionSchema = mcpToolToDeepSeekSchema(serverId, tool);

      // v1.13.0:风险推导。**server 未受信时 annotations 一律不参与判定**(design §4.2),
      // 因此一个恶意 server 无法通过 annotation 把自己的写工具伪装成只读。
      const trusted = Boolean(srvConfig.trust);
      const risk = resolveToolRisk({
        name: tool.name,
        description: tool.description,
        annotations: annotationsFromTool(tool),
        trusted
      });

      // v1.13.1:用户显式风险覆盖(design §4.2 中"用户 policy"是最高优先级)。
      // 关键词/annotations 都是启发式,会把 create_backup 这类只读工具误判成写操作;
      // 这里给用户一个手写的逃生阀。它是人手写进配置的**有意决定**,因此允许降级,
      // 但会被记录下来并在三端提示,避免悄悄放宽。
      const policy = asPolicy(srvConfig.tools);
      const riskOverride = Object.hasOwn(policy.risk, tool.name) ? policy.risk[tool.name] : null;
      const overridden = Boolean(riskOverride) && riskOverride !== risk.category;
      let category = risk.category;
      if (riskOverride) category = riskOverride;

      const configuredScope = resolveConfiguredScope(srvConfig.tools, tool.name);

      const toolDef = {
        name: namespacedName,
        description: `[MCP: ${serverId}] ${tool.description || tool.name}`.trim(),
        category,
        source: "mcp",
        serverId,
        originalName: tool.name,
        rawFunctionSchema,
        rawInputSchema: tool.inputSchema,
        inputSchema: cleanJsonSchema(tool.inputSchema),
        // v1.13.1:恢复 v1.11.0 的语义 —— autoApprove 不看类别,列入即放行。
        // (v1.13.0 曾错误地收紧为"仅 read",那是无声的行为回退。)
        // 破坏性工具仍由引擎硬拒绝,不受此项影响。
        autoApprove:
          Array.isArray(srvConfig.autoApprove) &&
          srvConfig.autoApprove.includes(tool.name),
        annotations: risk.annotations,
        riskSource: risk.source,
        riskEscalatedBy: risk.escalatedBy,
        serverTrusted: trusted,
        approvalScope: configuredScope,
        riskOverridden: overridden,
        riskOverride: riskOverride,
        execute: async (params, context = {}) => {
          const redact = createMcpDisplayRedactor({ hub: this });
          try {
            const res = await client.callTool(tool.name, params, { signal: context.signal, timeoutMs: context.toolTimeoutMs });
            return toToolExecutionResult(res, { outputSchema: tool.outputSchema, redact });
          } catch (error) {
            const sanitized = sanitizedMcpError(error, redact);
            return { status: "error", content: [{ type: "error", text: sanitized.message }], metadata: { isError: true, errorCode: sanitized.code ?? "MCP_TOOL_CALL_FAILED" } };
          }
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
      if (this.clients.get(serverId) !== client || this.serverConfigs.get(serverId) !== srvConfig
          || srvConfig.disabled || this._stopping.has(serverId) || this._authRequired.has(serverId)) return;
      this._mountTools(serverId, mcpTools, client, srvConfig);
      this.emit("tools_changed", {
        serverId,
        count: mcpTools.length
      });
    } catch (err) {
      this.emit("server_error", { serverId, error: sanitizedMcpError(err, createMcpDisplayRedactor({ hub: this })) });
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
    this.inputBroker.cancelServer(serverId);
    const srvConfig = this.serverConfigs.get(serverId);
    if (!srvConfig) {
      throw new Error(`MCP server '${serverId}' not found in configuration`);
    }
    if (srvConfig.disabled) throw new Error(`MCP server '${serverId}' is disabled`);

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
    this.inputBroker.cancelServer(serverId);
    const srvConfig = this.serverConfigs.get(serverId);
    if (!srvConfig) {
      throw new Error(`MCP server '${serverId}' not found in configuration`);
    }

    srvConfig.disabled = !enabled;

    if (!enabled) {
      await this.oauthClients.get(serverId)?.cancelAuthorization();
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

    const normalized = normalizeServerConfig(serverId, srvConfig);

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
    this.inputBroker.cancelServer(serverId);
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
      this.subscriptionStates.delete(serverId);
      this.oauthClients.get(serverId)?.dispose();
      this.oauthClients.delete(serverId);
      this._authRequired.delete(serverId);
      this._reconnectState.delete(serverId);
      this.emit("server_removed", { serverId });
      return { ok: true, serverId };
    } finally {
      this._stopping.delete(serverId);
    }
  }

  async stopAll() {
    this.inputBroker.cancelAll();
    for (const oauth of this.oauthClients.values()) oauth.dispose();
    this.oauthClients.clear();
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
    this.diagnostics.flush();
  }

  getServer(serverId) {
    return this.clients.get(serverId) || null;
  }

  listServers() {
    const list = [];
    const clean = createMcpDisplayRedactor({ hub: this });
    for (const [serverId, srvConfig] of this.serverConfigs.entries()) {
      const client = this.clients.get(serverId);
      const tools = this.serverTools.get(serverId) || [];
      const reconnect = this._reconnectState.get(serverId);

      let status = "DISCONNECTED";
      if (srvConfig.disabled) {
        status = "DISABLED";
      } else if (this._authRequired.has(serverId)) {
        status = "AUTH_REQUIRED";
      } else if (reconnect?.attempts >= this.maxReconnectAttempts) {
        status = "DEGRADED";
      } else if (client) {
        status = client.getStatus();
      }

      list.push({
        serverId,
        command: clean(srvConfig.command || null),
        url: clean(srvConfig.url || null),
        type: srvConfig.type || (srvConfig.url ? "streamable-http" : "stdio"),
        args: clean(srvConfig.args || []),
        disabled: Boolean(srvConfig.disabled),
        autoApprove: srvConfig.autoApprove || [],
        oauth: { enabled: srvConfig.oauth?.enabled === true },
        elicitation: { enabled: srvConfig.elicitation?.enabled === true },
        subscriptions: { enabled: srvConfig.subscriptions?.enabled === true },
        subscriptionStatus: this.subscriptionStates.get(serverId) || "disabled",
        authStatus: this.oauthClients.get(serverId)?.getStatus() || { status: srvConfig.oauth?.enabled ? "unauthenticated" : "disabled" },
        status,
        protocolMode: client?.getProtocolMode?.() || "unknown",
        protocolVersion: client?.protocolVersion || null,
        // v1.12.0:legacy SSE 通道的弃用提示透出给界面
        deprecatedTransport: client?.deprecatedTransport || null,
        configSource: this.configSources?.[serverId] || null,
        reconnectAttempts: reconnect?.attempts || 0,
        serverInfo: clean(client?.serverInfo || null),
        capabilities: Object.fromEntries(Object.entries(client?.serverCapabilities || {}).map(([key, value]) => [key, clean(value)])),
        toolCount: tools.length,
        tools: tools.map((t) => {
          const badge = riskBadge(t.category);
          return {
            name: clean(t.name),
            originalName: clean(t.originalName),
            description: clean(t.description),
            category: t.category,
            autoApprove: t.autoApprove,
            // v1.13.0:风险徽章与推导依据,供 GUI 展示"这条放行是凭据来的"
            badge,
            riskSource: t.riskSource || null,
            riskEscalatedBy: t.riskEscalatedBy || [],
            serverTrusted: Boolean(t.serverTrusted),
            approvalScope: t.approvalScope || null,
            riskOverridden: Boolean(t.riskOverridden),
            riskOverride: t.riskOverride || null
          };
        }),
        error: clean(client?.getLastError()?.message || null),
        stderr: clean(client?.getRecentStderr() || "")
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

  async _connectedClient(serverId) {
    const config = this.serverConfigs.get(serverId);
    if (config?.disabled) {
      const error = new Error(`MCP server '${serverId}' is disabled`);
      error.code = "MCP_SERVER_DISABLED";
      throw error;
    }
    const client = this.clients.get(serverId);
    if (client?.getStatus() === "CONNECTED") return client;
    if (!config) throw new Error(`MCP server '${serverId}' is not connected or configured`);
    // CLI capability commands can keep autoInitMcp:false: connect only the
    // requested server, sharing concurrent browser requests to the same target.
    if (this._capabilityConnections.has(serverId)) return this._capabilityConnections.get(serverId);
    const pending = this.restartServer(serverId).then(() => {
      const connected = this.clients.get(serverId);
      if (!this.serverConfigs.has(serverId) || this.serverConfigs.get(serverId).disabled || connected?.getStatus() !== "CONNECTED") {
        throw new Error(`MCP server '${serverId}' is no longer available`);
      }
      return connected;
    });
    this._capabilityConnections.set(serverId, pending);
    try { return await pending; }
    finally { if (this._capabilityConnections.get(serverId) === pending) this._capabilityConnections.delete(serverId); }
  }

  async listResources(serverId, opts = {}) {
    return (await this._connectedClient(serverId)).listResources(opts);
  }

  async listResourceTemplates(serverId, opts = {}) {
    return (await this._connectedClient(serverId)).listResourceTemplates(opts);
  }

  async readResource(serverId, uri, opts = {}) {
    return (await this._connectedClient(serverId)).readResource(uri, opts);
  }

  async listPrompts(serverId, opts = {}) {
    return (await this._connectedClient(serverId)).listPrompts(opts);
  }

  async getPrompt(serverId, name, args = {}, opts = {}) {
    return (await this._connectedClient(serverId)).getPrompt(name, args, opts);
  }

  async callTool(namespacedName, params = {}, options = {}) {
    const parsed = parseExternalToolName(namespacedName);
    if (!parsed) {
      throw new Error(`Invalid MCP tool name: ${namespacedName}`);
    }
    const { serverId, originalName } = parsed;
    const client = this.clients.get(serverId);
    if (!client || client.getStatus() !== "CONNECTED") {
      throw new Error(`MCP server '${serverId}' is not connected`);
    }

    const redact = createMcpDisplayRedactor({ hub: this });
    try {
      const res = await client.callTool(originalName, params, options);
      return redact(formatToolResult(res));
    } catch (error) {
      throw sanitizedMcpError(error, redact);
    }
  }

  async callToolDetailed(namespacedName, params = {}, options = {}) {
    const parsed = parseExternalToolName(namespacedName);
    if (!parsed) {
      throw new Error(`Invalid MCP tool name: ${namespacedName}`);
    }
    const { serverId, originalName } = parsed;
    const client = this.clients.get(serverId);
    if (!client || client.getStatus() !== "CONNECTED") {
      throw new Error(`MCP server '${serverId}' is not connected`);
    }

    const redact = createMcpDisplayRedactor({ hub: this });
    try {
      const res = await client.callTool(originalName, params, options);
      return redact(summarizeToolResult(res));
    } catch (error) {
      throw sanitizedMcpError(error, redact);
    }
  }
}
