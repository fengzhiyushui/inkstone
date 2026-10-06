// Main-process boundary: renderer chooses filters, never an export path.
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const ENVELOPE_KEYS = new Set(["entries", "total", "truncated", "storageError", "id", "timestamp", "serverId", "kind", "direction", "method", "requestId", "durationMs", "status", "message", "preview", "level", "category",
  "runId", "toolName", "content", "metadata", "approval", "cancelled", "saved", "canceled", "error", "errorCode", "isError", "name", "originalName", "description", "inputSchema", "displayTruncated", "displayTruncationReasons"]);
const ENUMS = {
  status: new Set(["success", "error", "cancelled", "denied", "approval_required", "running", "not_found", "sent", "timeout", "CONNECTED", "DISCONNECTED", "CONNECTING", "AUTH_REQUIRED", "DISABLED", "ERROR", "authenticated", "unauthenticated", "pending", "disabled"]),
  direction: new Set(["in", "out"]), level: new Set(["debug", "info", "warn", "error"]),
  category: new Set(["read", "mutate", "execute", "destructive", "transport", "protocol", "auth", "permission", "timeout", "cancelled", "tool", "lifecycle"]),
  type: new Set(["object", "array", "string", "integer", "number", "boolean", "null"])
};

// Keep protocol field names and enums intact. Free-form payloads still use the
// full content redactor, including external keys and binary omission.
function projectDiagnostic(value, clean, cleanSchema, key = "", depth = 0, budget = { nodes: 0 }) {
  if (++budget.nodes > 20000 || depth > 32) return "[content omitted: display limit]";
  if (key === "inputSchema") return cleanSchema(value, clean);
  if (["content", "preview", "approval", "error"].includes(key)) return clean(value);
  if (typeof value === "string") {
    if (ENUMS[key]?.has(value)) return value;
    if (key === "runId" && /^[a-f0-9-]{36}$/i.test(value)) return value;
    if (["name", "originalName", "toolName"].includes(key) && /^[a-zA-Z0-9_.:-]{1,512}$/.test(value)) return value;
    return clean(value);
  }
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 20000).map((item) => projectDiagnostic(item, clean, cleanSchema, key, depth + 1, budget));
  const out = {};
  for (const [name, child] of Object.entries(value)) {
    if (budget.nodes > 20000) break;
    const safeKey = ENVELOPE_KEYS.has(name) ? name : clean(name);
    Object.defineProperty(out, safeKey, { value: projectDiagnostic(child, clean, cleanSchema, name, depth + 1, budget), enumerable: true, configurable: true });
  }
  return out;
}

function diagnosticOptions(options = {}) {
  const out = { limit: Number.isInteger(options?.limit) ? Math.max(1, Math.min(options.limit, 500)) : 100 };
  for (const key of ["level", "category", "method", "search"]) {
    if (typeof options?.[key] === "string" && options[key].trim()) out[key] = options[key].trim().slice(0, 200);
  }
  return out;
}

async function callDiagnostic({ facade, config = {}, method, args, sensitive = {}, onStarted }) {
  const { createMcpDisplayRedactor, sanitizeMcpSchema } = await import(pathToFileURL(path.join(__dirname, "..", "src", "security", "mcp-content.js")).href);
  const clean = createMcpDisplayRedactor({ config: { ...config, arguments: sensitive }, hub: facade?.hub });
  try {
    if (typeof facade?.[method] !== "function") throw new Error("MCP diagnostics API unavailable");
    const operation = facade[method](...args);
    onStarted?.();
    const result = await operation;
    if (method === "exportLogs") {
      if (typeof result !== "string" || Buffer.byteLength(result) > 4 * 1024 * 1024) throw new Error("Invalid MCP diagnostic export");
      return JSON.stringify(projectDiagnostic(JSON.parse(result), clean, sanitizeMcpSchema), null, 2);
    }
    return projectDiagnostic(result, clean, sanitizeMcpSchema);
  } catch (error) {
    throw new Error(clean(error?.message || "MCP diagnostics operation failed"));
  } finally {
    onStarted?.();
  }
}

async function saveDiagnosticExport({ host, serverId, options, showSaveDialog, writeFile }) {
  const content = await host.exportMcpLogs(serverId, diagnosticOptions(options));
  const choice = await showSaveDialog({ title: "Export MCP diagnostics", defaultPath: "mcp-diagnostics.json",
    filters: [{ name: "JSON", extensions: ["json"] }] });
  if (choice.canceled || !choice.filePath) return { canceled: true };
  await writeFile(choice.filePath, content, { encoding: "utf8", mode: 0o600 });
  return { canceled: false, saved: true };
}

module.exports = { diagnosticOptions, callDiagnostic, saveDiagnosticExport };
