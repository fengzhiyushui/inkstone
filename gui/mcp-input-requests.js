// MCP elicitation is a separate IPC boundary: only pending forms and response
// acknowledgements cross it. Continuation tokens and submitted values stay out.
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const identifier = (value) => typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,160}$/.test(value);
const ACTIONS = new Set(["accept", "decline", "cancel"]);
const STATUSES = new Set(["pending", "accepted", "declined", "cancelled", "resolved", "expired", "not_found", "error"]);

function inputResponse(requestId, response) {
  if (!identifier(requestId)) throw new Error("Invalid MCP input request ID");
  if (!object(response) || !ACTIONS.has(response.action)) throw new Error("Invalid MCP input action");
  if (response.action !== "accept") return { action: response.action };
  if (!object(response.content)) throw new Error("MCP input content must be an object");
  let json;
  try { json = JSON.stringify(response.content); } catch { throw new Error("Invalid MCP input content"); }
  if (Buffer.byteLength(json) > 65536) throw new Error("MCP input content exceeds limit");
  return { action: "accept", content: JSON.parse(json) };
}

async function callInputRequest({ facade, config = {}, method, args = [] }) {
  const { createMcpDisplayRedactor, sanitizeMcpSchema } = await import(pathToFileURL(path.join(__dirname, "..", "src", "security", "mcp-content.js")).href);
  const clean = createMcpDisplayRedactor({ config, hub: facade?.hub });
  try {
    if (typeof facade?.[method] !== "function") throw new Error("unavailable");
    const result = await facade[method](...args);
    if (method === "listInputRequests") {
      if (!Array.isArray(result) || result.length > 64) throw new Error("invalid response");
      return result.map((item) => {
        if (!object(item) || !identifier(item.requestId) || !identifier(item.serverId)
          || typeof item.method !== "string" || !object(item.requestedSchema)) throw new Error("invalid descriptor");
        return {
          requestId: item.requestId, serverId: item.serverId,
          method: ["elicitation/create", "elicitation"].includes(item.method) ? item.method : "elicitation/create",
          status: "pending", message: clean(typeof item.message === "string" ? item.message.slice(0, 8192) : ""),
          requestedSchema: sanitizeMcpSchema(item.requestedSchema, clean, { preserveConstraints: true }),
          ...(Number.isFinite(item.createdAt) ? { createdAt: item.createdAt } : {}),
          ...(Number.isFinite(item.expiresAt) ? { expiresAt: item.expiresAt } : {})
        };
      });
    }
    if (!object(result) || result.error || !STATUSES.has(result.status)) throw new Error("invalid acknowledgement");
    return { requestId: args[0], status: result.status,
      ...(identifier(result.serverId) ? { serverId: result.serverId } : {}) };
  } catch {
    // Backend errors can include submitted values. Never echo them into the
    // renderer's activity/error state, even when they are not named "secret".
    throw new Error("MCP input request operation failed");
  }
}

module.exports = { inputResponse, callInputRequest };
