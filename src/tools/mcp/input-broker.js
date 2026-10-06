import { createHash, randomUUID } from "node:crypto";
import { createMcpDisplayRedactor, sanitizeMcpSchema } from "../../security/mcp-content.js";
import { validateOutputSchema } from "./output-schema.js";
import { validateElicitationSchema, validateElicitationResponse } from "./elicitation-schema.js";

const MAX_PENDING = 32;
const MAX_FORMS = 8;
const MAX_BYTES = 65536;
const fingerprint = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function failure(code, message) { return Object.assign(new Error(message), { code }); }
function cancelled() { return Object.assign(failure("MCP_INPUT_CANCELLED", "MCP input request cancelled"), { name: "AbortError" }); }

/** In-memory consent boundary. Opaque state and response values never become events. */
export function createMcpInputBroker({ hub }) {
  const pending = new Map();
  let disposed = false;
  let secretBytes = 0;
  hub.inputSecrets ||= new Set();

  function remember(value) {
    const values = new Set();
    const visit = (item) => {
      if (typeof item === "string" && item || typeof item === "number" || typeof item === "boolean") values.add(String(item));
      else if (item && typeof item === "object") Object.values(item).forEach(visit);
    };
    visit(value);
    const additions = [...values].filter((item) => !hub.inputSecrets.has(item));
    const bytes = additions.reduce((sum, item) => sum + Buffer.byteLength(item), 0);
    if (secretBytes + bytes > 524288 || hub.inputSecrets.size + additions.length > 4096) {
      throw failure("MCP_INPUT_LIMIT", "MCP input privacy budget exceeded; reconnect with a new kernel");
    }
    for (const item of additions) hub.inputSecrets.add(item);
    secretBytes += bytes;
  }
  function current(session) {
    if (disposed) throw cancelled();
    const config = hub.serverConfigs.get(session.serverId);
    if (session.signal?.aborted) throw cancelled();
    if (!config || config.disabled || config.elicitation?.enabled !== true
      || hub._stopping?.has(session.serverId) || hub._authRequired?.has(session.serverId)
      || hub.clients.get(session.serverId) !== session.client || config !== session.config
      || fingerprint(config) !== session.configHash) {
      throw failure("MCP_INPUT_STALE", "MCP server changed; start the operation again");
    }
    if (session.method === "tools/call" && (!session.tool
      || !(hub.serverTools.get(session.serverId) || []).includes(session.tool)
      || hub.toolRegistry !== session.registry
      || session.registry && session.registry.resolve(session.tool.name) !== session.registryTool)) {
      throw failure("MCP_INPUT_STALE", "MCP tool changed; start the operation again");
    }
  }
  function settle(record, response, error, status) {
    if (!pending.delete(record.requestId)) return;
    clearTimeout(record.timer);
    record.session.signal?.removeEventListener("abort", record.onAbort);
    hub.emit("input_resolved", { requestId: record.requestId, serverId: record.session.serverId,
      method: "elicitation/create", status });
    if (error) record.reject(error); else record.resolve(response);
    record.resolve = null; record.reject = null; record.schema = null;
  }
  function waitForForm(session, form) {
    current(session);
    if (pending.size >= MAX_PENDING) throw failure("MCP_INPUT_LIMIT", "Too many pending MCP input requests");
    return new Promise((resolve, reject) => {
      const createdAt = Date.now();
      const timeout = Math.min(300000, Math.max(1000, session.config.elicitation?.timeoutMs || 120000));
      const requestId = randomUUID();
      const record = { requestId, session, schema: form.schema, message: form.message, createdAt,
        expiresAt: createdAt + timeout, resolve, reject };
      record.onAbort = () => settle(record, null, cancelled(), "cancelled");
      record.timer = setTimeout(() => settle(record, null, failure("MCP_INPUT_EXPIRED", "MCP input request expired"), "expired"), timeout);
      record.timer.unref?.();
      pending.set(requestId, record);
      session.signal?.addEventListener("abort", record.onAbort, { once: true });
      if (session.signal?.aborted) { record.onAbort(); return; }
      hub.emit("input_required", { requestId, serverId: session.serverId, status: "pending", method: "elicitation/create" });
    });
  }
  async function request({ serverId, method, params, result, signal }, client) {
    const config = hub.serverConfigs.get(serverId);
    if (!config || config.elicitation?.enabled !== true) throw failure("MCP_INPUT_DISABLED", "MCP elicitation is disabled");
    const tool = method === "tools/call" ? (hub.serverTools.get(serverId) || []).find((entry) => entry.originalName === params?.name) : null;
    const registry = hub.toolRegistry;
    const registryTool = tool && registry ? registry.resolve(tool.name) : null;
    const session = { serverId, method, client, config, configHash: fingerprint(config), signal, tool, registry, registryTool };
    if (tool && registry && !registryTool) throw failure("MCP_INPUT_STALE", "MCP tool changed; start the operation again");
    current(session);
    if (!["tools/call", "resources/read", "prompts/get"].includes(method)) throw failure("MCP_INPUT_UNSUPPORTED", "MCP input is unsupported for this operation");
    if (!object(result) || !validateOutputSchema(true, result).valid || Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES) {
      throw failure("MCP_INPUT_INVALID", "Invalid or oversized MCP input request");
    }
    if (result.requestState !== undefined && typeof result.requestState !== "string") throw failure("MCP_INPUT_INVALID", "Invalid MCP continuation state");
    const requests = result.inputRequests;
    if (requests !== undefined && !object(requests)) throw failure("MCP_INPUT_INVALID", "Invalid MCP input request map");
    const entries = Object.entries(requests || {});
    if (entries.length > MAX_FORMS || !entries.length && result.requestState === undefined) throw failure("MCP_INPUT_INVALID", "Invalid MCP input request count");
    // Validate every form before any consent is collected. Unsupported methods
    // cannot borrow consent from an earlier form in the same server response.
    const forms = entries.map(([key, input]) => {
      if (!key || key.length > 256 || !object(input) || input.method !== "elicitation/create"
        || !object(input.params) || ![undefined, "form"].includes(input.params.mode)
        || typeof input.params.message !== "string" || Buffer.byteLength(input.params.message) > 8192) {
        throw failure("MCP_INPUT_UNSUPPORTED", "Only MCP form elicitation is supported");
      }
      return { key, message: input.params.message, schema: validateElicitationSchema(input.params.requestedSchema) };
    });
    // Retain state only as an opaque secret for scrubbing; never parse or display.
    if (result.requestState) remember(result.requestState);
    if (!forms.length) {
      const response = await waitForForm(session, { message: "The MCP server requests another round trip. Continue this operation?", schema: { type: "object", properties: {} } });
      current(session);
      if (response.action !== "accept") throw cancelled();
      return {};
    }
    const responses = Object.create(null);
    for (const form of forms) {
      const response = await waitForForm(session, form);
      current(session);
      responses[form.key] = response;
    }
    return { inputResponses: responses };
  }
  function list() {
    const clean = createMcpDisplayRedactor({ hub });
    const result = [];
    for (const record of [...pending.values()]) {
      try { current(record.session); }
      catch (error) { settle(record, null, error, "cancelled"); continue; }
      result.push({ requestId: record.requestId, serverId: record.session.serverId, method: "elicitation/create",
        message: clean(record.message), requestedSchema: sanitizeMcpSchema(record.schema, clean, { preserveConstraints: true }),
        createdAt: record.createdAt, expiresAt: record.expiresAt });
    }
    return result;
  }
  function respond(requestId, response) {
    const record = pending.get(requestId);
    if (!record) return { requestId, status: "not_found" };
    try { current(record.session); }
    catch (error) { settle(record, null, error, "cancelled"); return { requestId, status: "cancelled" }; }
    if (Date.now() >= record.expiresAt) {
      settle(record, null, failure("MCP_INPUT_EXPIRED", "MCP input request expired"), "expired");
      return { requestId, status: "expired" };
    }
    if (!object(response) || !["accept", "decline", "cancel"].includes(response.action)) throw failure("MCP_INPUT_INVALID", "Invalid MCP input response");
    const checked = { action: response.action };
    if (response.action === "accept") {
      checked.content = validateElicitationResponse(record.schema, response.content);
      remember(checked.content);
    }
    const status = { accept: "accepted", decline: "declined", cancel: "cancelled" }[response.action];
    settle(record, checked, null, status);
    return { requestId, serverId: record.session.serverId, status };
  }
  function cancelServer(serverId) {
    for (const record of [...pending.values()]) if (record.session.serverId === serverId) settle(record, null, cancelled(), "cancelled");
  }
  function cancelAll() {
    for (const record of [...pending.values()]) settle(record, null, cancelled(), "cancelled");
  }
  return { request, list, respond, cancelServer,
    cancelAll, dispose() { disposed = true; cancelAll(); } };
}
