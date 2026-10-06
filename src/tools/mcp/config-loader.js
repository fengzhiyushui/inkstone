import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { normalizeToolPolicy } from "./tool-policy.js";

/**
 * MCP configuration loader — multi-scope merge + secret inputs.
 *
 * Scope priority (high → low): session > project > user
 * Compatible aliases: `.mcp.json` (Claude), `servers` key (VS Code).
 */

const SERVER_ID_RE = /^[a-zA-Z0-9_.-]{1,128}$/;

export function normalizeOAuthConfig(raw, type) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("MCP OAuth configuration must be an object");
  if (Object.keys(raw).some((key) => /secret|token|password|credential|verifier/i.test(key))) {
    throw new Error("MCP OAuth configuration cannot contain credentials; use the sign-in flow");
  }
  const enabled = raw.enabled === true;
  if (enabled && type === "stdio") throw new Error("MCP OAuth requires a remote HTTP server");
  const result = { enabled };
  for (const key of ["clientId", "issuer", "resourceMetadataUrl"]) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== "string" || !raw[key].trim() || raw[key].length > 8192 || /[\r\n]/.test(raw[key])) {
      throw new Error(`Invalid MCP OAuth ${key}`);
    }
    result[key] = raw[key].trim();
  }
  if (raw.scopes !== undefined) {
    if (!Array.isArray(raw.scopes) || raw.scopes.length > 100 || raw.scopes.some((scope) => typeof scope !== "string" || !/^[\x21\x23-\x5b\x5d-\x7e]{1,256}$/.test(scope))) {
      throw new Error("MCP OAuth scopes must be an array of valid scope strings");
    }
    result.scopes = [...new Set(raw.scopes)];
  }
  if (raw.timeoutMs !== undefined) {
    if (!Number.isFinite(raw.timeoutMs) || raw.timeoutMs < 1000 || raw.timeoutMs > 600000) throw new Error("Invalid MCP OAuth timeoutMs");
    result.timeoutMs = raw.timeoutMs;
  }
  return result;
}

export function normalizeServerConfig(serverId, raw = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Invalid MCP server config for '${serverId}'`);
  }
  const hasCommand = typeof raw.command === "string" && raw.command.trim();
  const hasUrl = typeof raw.url === "string" && raw.url.trim();
  if (!hasCommand && !hasUrl) {
    throw new Error(`MCP server '${serverId}' requires 'command' or 'url'`);
  }

  let type = typeof raw.type === "string" ? raw.type.trim().toLowerCase() : null;
  if (!type) {
    type = hasUrl ? "streamable-http" : "stdio";
  }
  const allowed = new Set(["stdio", "streamable-http", "sse", "http"]);
  if (!allowed.has(type)) {
    throw new Error(`MCP server '${serverId}' has unknown type '${type}'`);
  }
  if (type === "http") type = "streamable-http";

  const normalized = {
    type,
    command: hasCommand ? raw.command.trim() : "",
    args: Array.isArray(raw.args) ? raw.args.map(String) : [],
    env: raw.env && typeof raw.env === "object" && !Array.isArray(raw.env) ? { ...raw.env } : {},
    disabled: Boolean(raw.disabled),
    autoApprove: Array.isArray(raw.autoApprove) ? raw.autoApprove.map(String) : [],
    timeoutMs: typeof raw.timeoutMs === "number" && raw.timeoutMs > 0 ? raw.timeoutMs : 60000
  };

  if (hasUrl) normalized.url = raw.url.trim();
  if (typeof raw.cwd === "string" && raw.cwd.trim()) normalized.cwd = raw.cwd.trim();
  if (raw.headers && typeof raw.headers === "object" && !Array.isArray(raw.headers)) {
    normalized.headers = { ...raw.headers };
  }
  // v1.12.0:SSRF 私网放行清单必须原样保留 —— 否则远程配置在归一化这一步就被削掉,
  // 内网自建 Server 永远连不上(且现象是"被安全策略拒绝",很难定位)。
  if (Array.isArray(raw.allowlist) && raw.allowlist.length) {
    normalized.allowlist = raw.allowlist.map(String).filter((s) => s.trim());
  }
  if (typeof raw.retryOnStreamBreak === "number" && raw.retryOnStreamBreak >= 0) {
    normalized.retryOnStreamBreak = raw.retryOnStreamBreak;
  }
  if (typeof raw.maxRedirects === "number" && raw.maxRedirects >= 0) {
    normalized.maxRedirects = raw.maxRedirects;
  }
  if (raw.oauth !== undefined) {
    normalized.oauth = normalizeOAuthConfig(raw.oauth, type);
  }
  for (const name of ["elicitation", "subscriptions"]) {
    if (raw[name] !== undefined) {
      const settings = raw[name];
      if (!settings || typeof settings !== "object" || Array.isArray(settings)
        || settings.enabled !== undefined && typeof settings.enabled !== "boolean") throw new Error(`Invalid MCP ${name} configuration`);
      normalized[name] = { enabled: settings.enabled === true };
      if (name === "elicitation" && settings.timeoutMs !== undefined) {
        if (!Number.isInteger(settings.timeoutMs) || settings.timeoutMs < 1000 || settings.timeoutMs > 300000) throw new Error("Invalid MCP elicitation timeoutMs");
        normalized[name].timeoutMs = settings.timeoutMs;
      }
    }
  }
  // v1.13.0:trust 决定该 server 自报的 annotations 是否参与风险判定
  // (design §4.2:annotations 不可信,除非 server 受信)。默认 false。
  if (raw.trust === true) normalized.trust = true;
  if (raw.tools && typeof raw.tools === "object") {
    normalized.tools = normalizeToolPolicy(raw.tools);
  }
  if (raw.protocolMode === "auto" || raw.protocolMode === "modern" || raw.protocolMode === "legacy") {
    normalized.protocolMode = raw.protocolMode;
  }
  return normalized;
}

export function normalizeServersMap(raw = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const [id, cfg] of Object.entries(raw)) {
    if (!SERVER_ID_RE.test(id)) {
      throw new Error(`Invalid MCP server ID: "${id}"`);
    }
    out[id] = normalizeServerConfig(id, cfg);
  }
  return out;
}

/** Claude-style project file or VS Code-style { servers: {...} }. */
export function extractServersFromDocument(doc) {
  if (!doc || typeof doc !== "object") return { servers: {}, inputs: {} };
  const servers = doc.mcpServers || doc.servers || {};
  const inputs = doc.inputs && typeof doc.inputs === "object" ? { ...doc.inputs } : {};
  return { servers, inputs };
}

export function readJsonIfExists(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    const text = readFileSync(filePath, "utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Load merged MCP config.
 * @param {object} opts
 * @param {string} opts.projectRoot
 * @param {object} [opts.sessionServers] session-level overrides (highest)
 * @param {object} [opts.userConfigPath]
 * @param {object} [opts.projectConfigPath]
 * @param {string} [opts.dotMcpPath] defaults to `<projectRoot>/.mcp.json`
 */
export function loadMcpConfig({
  projectRoot,
  sessionServers = {},
  sessionInputs = {},
  userConfigPath = null,
  projectConfigPath = null,
  dotMcpPath = null,
  warn = () => {}
} = {}) {
  const root = resolve(projectRoot || process.cwd());
  const userPath = userConfigPath || join(homedir(), ".deepseek-code", "config.json");
  const projectPath = projectConfigPath || join(root, ".deepseek-code", "config.json");
  const mcpJsonPath = dotMcpPath || join(root, ".mcp.json");

  const userDoc = readJsonIfExists(userPath);
  const projectDoc = readJsonIfExists(projectPath);
  const mcpJsonDoc = readJsonIfExists(mcpJsonPath);

  const userPart = extractServersFromDocument(userDoc);
  const projectPart = extractServersFromDocument(projectDoc);
  const mcpJsonPart = extractServersFromDocument(mcpJsonDoc);

  // .mcp.json is lower priority than project config's own mcpServers
  let base = {};
  if (mcpJsonDoc) {
    try {
      base = normalizeServersMap(mcpJsonPart.servers);
    } catch (err) {
      warn(`.mcp.json ignored: ${err.message}`);
    }
    // conflict detection
    try {
      const projectIds = new Set(Object.keys(normalizeServersMap(projectPart.servers)));
      for (const id of Object.keys(normalizeServersMap(mcpJsonPart.servers))) {
        if (projectIds.has(id)) {
          warn(`MCP server '${id}' defined in both .mcp.json and project config; project config wins`);
        }
      }
    } catch {
      /* project may be invalid; merge layer handles it */
    }
  }

  const scopes = [
    { name: "user", servers: userPart.servers, inputs: userPart.inputs },
    { name: "project", servers: projectPart.servers, inputs: projectPart.inputs },
    { name: "session", servers: sessionServers, inputs: sessionInputs }
  ];

  const merged = { ...base };
  const inputs = { ...mcpJsonPart.inputs };
  const source = {};
  for (const id of Object.keys(base)) source[id] = "mcp.json";

  for (const scope of scopes) {
    let map = {};
    try {
      map = normalizeServersMap(scope.servers);
    } catch (err) {
      warn(`MCP ${scope.name} config ignored: ${err.message}`);
      continue;
    }
    Object.assign(inputs, scope.inputs);
    for (const [id, cfg] of Object.entries(map)) {
      merged[id] = cfg;
      source[id] = scope.name;
    }
  }

  return {
    projectRoot: root,
    servers: merged,
    inputs,
    source,
    paths: { user: userPath, project: projectPath, mcpJson: mcpJsonPath }
  };
}

/** ${input:name} → resolved value; missing inputs throw unless optional. */
export function resolveInputTemplates(value, inputs = {}, { onMissing = "throw" } = {}) {
  if (typeof value === "string") {
    return value.replace(/\$\{input:([a-zA-Z0-9_.-]+)\}/g, (match, name) => {
      const def = inputs[name];
      if (def && def.value !== undefined && def.value !== null) {
        return String(def.value);
      }
      if (def && def.default !== undefined) {
        return String(def.default);
      }
      if (onMissing === "keep") return match;
      if (onMissing === "empty") return "";
      throw new Error(`Missing MCP input: ${name}`);
    });
  }
  if (Array.isArray(value)) {
    return value.map((v) => resolveInputTemplates(v, inputs, { onMissing }));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = resolveInputTemplates(v, inputs, { onMissing });
    }
    return out;
  }
  return value;
}

export function resolveServerEnvAndHeaders(serverCfg, inputs = {}, opts = {}) {
  return {
    ...serverCfg,
    env: resolveInputTemplates(serverCfg.env || {}, inputs, opts),
    headers: resolveInputTemplates(serverCfg.headers || {}, inputs, opts),
    args: resolveInputTemplates(serverCfg.args || [], inputs, opts),
    url: serverCfg.url ? resolveInputTemplates(serverCfg.url, inputs, opts) : serverCfg.url,
    command: serverCfg.command
      ? resolveInputTemplates(serverCfg.command, inputs, opts)
      : serverCfg.command
  };
}

const HIGH_ENTROPY_RE = /^(sk-|ghp_|gho_|github_pat_|xox[baprs]-|AKIA|ASIA)[A-Za-z0-9_\-]{8,}$|^[A-Za-z0-9+/_-]{32,}$/;

export function looksLikeSecret(value) {
  return typeof value === "string" && HIGH_ENTROPY_RE.test(value);
}

/** Warn when project-committable config embeds literal secrets. */
export function auditConfigSecrets(servers, { source = {}, warn = () => {} } = {}) {
  for (const [id, cfg] of Object.entries(servers || {})) {
    const scope = source[id] || "unknown";
    if (scope === "session") continue;
    const scan = (obj, path) => {
      if (!obj || typeof obj !== "object") return;
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === "string" && looksLikeSecret(v) && !v.includes("${input:")) {
          warn(`MCP '${id}' ${path}.${k} looks like a literal secret (${scope}); prefer \${input:*}`);
        } else if (v && typeof v === "object") {
          scan(v, `${path}.${k}`);
        }
      }
    };
    scan(cfg.env, "env");
    scan(cfg.headers, "headers");
  }
}

/** User credential store — never in the project tree. */
export function credentialsDir() {
  return join(homedir(), ".deepseek-code", "credentials");
}

export function saveCredential(key, value) {
  const dir = credentialsDir();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${key.replace(/[^a-zA-Z0-9_.-]/g, "_")}.json`);
  const payload = { key, value, savedAt: new Date().toISOString() };
  writeFileSync(file, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* Windows: chmod is best-effort */
  }
  return file;
}

export function loadCredential(key) {
  const file = join(credentialsDir(), `${key.replace(/[^a-zA-Z0-9_.-]/g, "_")}.json`);
  const doc = readJsonIfExists(file);
  return doc && typeof doc.value === "string" ? doc.value : null;
}

export function deleteCredential(key) {
  const file = join(credentialsDir(), `${key.replace(/[^a-zA-Z0-9_.-]/g, "_")}.json`);
  try {
    if (existsSync(file)) {
      rmSync(file, { force: true });
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/** Bind inputs: prefer explicit value, then credentials store, then default. */
export function bindInputs(inputs = {}) {
  const bound = {};
  for (const [name, def] of Object.entries(inputs)) {
    const fromCred = loadCredential(name);
    bound[name] = {
      ...(def && typeof def === "object" ? def : { type: "promptString" }),
      value:
        def && def.value !== undefined
          ? def.value
          : fromCred !== null
            ? fromCred
            : def && def.default !== undefined
              ? def.default
              : undefined
    };
  }
  return bound;
}
