import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createMcpDisplayRedactor } from "../../security/mcp-content.js";

export const MCP_HUB_EVENTS = Object.freeze([
  "server_status", "server_error", "server_disconnected", "server_added", "server_removed",
  "tools_mounted", "tools_changed", "resources_changed", "prompts_changed", "server_deprecated",
  "auth_required", "auth_status", "config_warn", "protocol_mode", "input_required", "input_resolved", "subscription_status", "log", "tool_test"
]);
export const LOG_LEVELS = Object.freeze(["debug", "info", "warn", "error"]);
export const LOG_CATEGORIES = Object.freeze(["transport", "protocol", "auth", "permission", "timeout", "cancelled", "tool", "lifecycle"]);
const FILE_LIMIT = 1_048_576;
const KEEP_FILES = 8;
const TEXT_FIELDS = ["kind", "direction", "method", "requestId", "status", "message", "preview"];
const STATUS_VALUES = new Set(["CONNECTED", "CONNECTING", "DISCONNECTED", "DISABLED", "AUTH_REQUIRED", "ERROR", "DEGRADED", "RECONNECTING", "CONFIGURED", "REMOVED",
  "success", "error", "cancelled", "timeout", "sent", "running", "approval_required", "awaiting_approval", "denied", "failed", "pending", "authenticated", "unauthenticated", "disabled", "accepted", "declined", "expired", "active", "listening", "connecting", "closed"]);
const enumValue = (key, value) => key === "status" && STATUS_VALUES.has(value) || key === "direction" && ["in", "out"].includes(value);

export function diagnosticCategory(error, method = "") {
  const code = String(error?.code || error?.name || "");
  if (code === "-32800") return "cancelled";
  if (code === "-32000") return "timeout";
  if (/ABORT|CANCEL|Abort/i.test(code)) return "cancelled";
  if (/TIMEOUT|Timeout/i.test(code)) return "timeout";
  if (/AUTH|401|403/i.test(code)) return "auth";
  if (/PERMISSION|DENIED/i.test(code)) return "permission";
  if (/^tools\//.test(method)) return "tool";
  return /^-32/.test(code) ? "protocol" : "transport";
}

// Only a structural summary is retained: arguments, results, notification text,
// HTTP headers, OAuth exchanges and stderr bodies never enter the frame log.
export function summarizeFrame(frame = {}) {
  return {
    method: typeof frame.method === "string" ? frame.method : undefined,
    requestId: typeof frame.id === "string" || typeof frame.id === "number" ? frame.id : undefined,
    status: frame.error ? "error" : Object.hasOwn(frame, "result") ? "success" : "sent",
    preview: frame.error ? `JSON-RPC error (${Number.isFinite(frame.error.code) ? frame.error.code : "unknown"})`
      : Object.hasOwn(frame, "result") ? "JSON-RPC result (body omitted)"
      : "JSON-RPC request/notification (body omitted)"
  };
}

// Preserve framework keys; only externally supplied values pass through the
// content redactor (a configured one-character secret must not rename keys).
export function safeMcpEvent(event = {}, hub) {
  const clean = createMcpDisplayRedactor({ hub });
  const out = {};
  for (const key of ["serverId", "runId", "requestId", "status", "protocolMode", "protocolVersion", "toolName", "method", "reason", "message"]) {
    // Input request UUIDs are generated locally and correlate modal lifecycle
    // events. Short answers must not corrupt them and leave a stale form open.
    const inputId = key === "requestId" && event.method === "elicitation/create"
      && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(event[key]);
    if (typeof event[key] === "string") out[key] = inputId || enumValue(key, event[key]) ? event[key] : clean(event[key]).slice(0, 2048);
  }
  for (const key of ["count", "toolCount", "attempts", "waitMs", "durationMs", "notificationCount"]) {
    if (Number.isFinite(event[key])) out[key] = event[key];
  }
  if (event.error) out.error = { message: clean(event.error.message || String(event.error)).slice(0, 2048) };
  if (event.entry) out.entry = event.entry;
  return out;
}

export function createMcpDiagnostics({ root, hub, maxEntries = 500, maxBytes = FILE_LIMIT, persist = true } = {}) {
  const directory = path.join(root || process.cwd(), ".deepseek-code", "mcp-logs");
  const runId = randomUUID();
  const filename = `${Date.now()}-${runId}.json`;
  const entries = [];
  let bytes = 0;
  let sequence = 0;
  let timer;
  let dirty = false;
  let storageError = null;
  maxEntries = Math.min(500, Math.max(1, maxEntries));
  maxBytes = Math.min(FILE_LIMIT, Math.max(4096, maxBytes));

  function safeDirectory(create = false) {
    for (const target of [path.dirname(directory), directory]) {
      try {
        const stat = fs.lstatSync(target);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Unsafe MCP diagnostic directory");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        if (!create) return false;
        fs.mkdirSync(target, { mode: 0o700 });
      }
    }
    return true;
  }
  function files() {
    if (!safeDirectory()) return [];
    return fs.readdirSync(directory).filter((name) => /^\d+-[a-f0-9-]{36}\.json$/.test(name)).sort().reverse();
  }
  function sanitize(input) {
    const clean = createMcpDisplayRedactor({ hub });
    const entry = {
      id: clean(String(input.id || "")).slice(0, 100),
      timestamp: typeof input.timestamp === "string" ? clean(input.timestamp).slice(0, 100) : new Date().toISOString(),
      level: LOG_LEVELS.includes(input.level) ? input.level : "info",
      category: LOG_CATEGORIES.includes(input.category) ? input.category : "lifecycle"
    };
    if (typeof input.serverId === "string") entry.serverId = clean(input.serverId).slice(0, 200);
    for (const key of TEXT_FIELDS) {
      if (["string", "number"].includes(typeof input[key])) entry[key] = enumValue(key, input[key]) ? input[key]
        : clean(String(input[key])).slice(0, key === "preview" || key === "message" ? 1024 : 200);
    }
    if (Number.isFinite(input.durationMs)) entry.durationMs = Math.max(0, input.durationMs);
    return entry;
  }
  function record(input) {
    const entry = sanitize({ ...input, id: `${runId}:${++sequence}`, timestamp: new Date().toISOString() });
    const size = Buffer.byteLength(JSON.stringify(entry)) + 2;
    entries.push({ entry, size }); bytes += size;
    while (entries.length > maxEntries || bytes > maxBytes - 256) bytes -= entries.shift().size;
    dirty = true;
    if (persist && !timer) { timer = setTimeout(flush, 100); timer.unref?.(); }
    return entry;
  }
  function flush() {
    clearTimeout(timer); timer = undefined;
    if (!persist || !dirty) return;
    let temporary;
    try {
      safeDirectory(true);
      const target = path.join(directory, filename);
      if (fs.existsSync(target)) {
        const stat = fs.lstatSync(target);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe MCP diagnostic file");
      }
      temporary = path.join(directory, `${filename}.${randomUUID()}.tmp`);
      // Rotated secrets can expand redaction markers. Recalculate the actual
      // serialized size before persisting, including entries already in memory.
      bytes = 0;
      for (const item of entries) {
        item.entry = sanitize(item.entry);
        item.size = Buffer.byteLength(JSON.stringify(item.entry)) + 2;
        bytes += item.size;
      }
      while (entries.length && bytes > maxBytes - 256) bytes -= entries.shift().size;
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, entries: entries.map(({ entry }) => entry) }), { flag: "wx", mode: 0o600 });
      fs.renameSync(temporary, target);
      for (const name of files().slice(KEEP_FILES)) {
        const old = path.join(directory, name);
        const stat = fs.lstatSync(old);
        if (stat.isFile() && !stat.isSymbolicLink()) fs.unlinkSync(old);
      }
      dirty = false; storageError = null;
    } catch { storageError = "MCP diagnostic history could not be saved"; }
    finally { if (temporary) { try { fs.unlinkSync(temporary); } catch {} } }
  }
  function getLogs(serverId, options = {}) {
    const filterServerId = typeof serverId === "string" ? sanitize({ serverId }).serverId : serverId;
    const all = new Map();
    try {
      if (persist) for (const name of files().slice(0, KEEP_FILES)) {
        const file = path.join(directory, name);
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > FILE_LIMIT) continue;
        try {
          const saved = JSON.parse(fs.readFileSync(file, "utf8"));
          if (saved.version !== 1 || !Array.isArray(saved.entries)) continue;
          for (const entry of saved.entries.slice(-500)) if (entry && typeof entry.id === "string") all.set(entry.id, sanitize(entry));
        } catch { /* A damaged run cannot hide other runs. */ }
      }
    } catch { storageError = "MCP diagnostic history could not be read"; }
    for (const { entry } of entries) all.set(entry.id, sanitize(entry));
    const filtered = [...all.values()].filter((entry) => (!filterServerId || entry.serverId === filterServerId)
      && (!options.level || entry.level === options.level) && (!options.category || entry.category === options.category)
      && (!options.direction || entry.direction === options.direction)
      && (!options.method || entry.method === options.method)
      && (!options.search || JSON.stringify(entry).toLowerCase().includes(String(options.search).slice(0, 200).toLowerCase())))
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id, undefined, { numeric: true }));
    const limit = Math.min(4000, Math.max(1, Math.floor(Number(options.limit) || 100)));
    return { entries: filtered.slice(-limit), total: filtered.length, truncated: filtered.length > limit, ...(storageError ? { storageError } : {}) };
  }
  return { record, flush, getLogs, exportLogs: (serverId, options) => JSON.stringify(getLogs(serverId, options), null, 2) };
}
