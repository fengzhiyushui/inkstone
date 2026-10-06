import { createHash, randomUUID } from "node:crypto";
import { createToolExecutor } from "../executor.js";
import { createApprovalCache } from "../permissions/approval-cache.js";
import { validateOutputSchema } from "./output-schema.js";
import { createMcpDisplayRedactor } from "../../security/mcp-content.js";
import { isToolEnabled } from "./tool-policy.js";

const MAX_PENDING = 32;
const APPROVAL_TTL = 5 * 60_000;
const MAX_OUTPUT = 64 * 1024;
const configFingerprint = (config) => createHash("sha256").update(JSON.stringify(config)).digest("hex");

function boundJson(value, maxBytes = MAX_OUTPUT) {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") <= maxBytes) return { value, truncated: false };
  // Cut at a UTF-8 boundary and include the JSON wrapper/marker in the budget.
  const buffer = Buffer.from(serialized, "utf8");
  let end = maxBytes - 256;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  const clipped = [{ type: "text", text: buffer.subarray(0, end).toString("utf8") + "\n[output truncated]" }];
  // JSON escaping the preview can expand its byte size (quotes/backslashes).
  while (Buffer.byteLength(JSON.stringify(clipped), "utf8") > maxBytes) {
    end = Math.max(0, Math.floor(end * 0.8));
    while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
    clipped[0].text = buffer.subarray(0, end).toString("utf8") + "\n[output truncated]";
  }
  return { value: clipped, truncated: true };
}

export function createMcpToolTrials({ hub, registry, permissionEngine, getContext = () => ({}) }) {
  const runs = new Map();
  const used = new Set();
  let disposed = false;
  const executor = createToolExecutor({ registry, permissionEngine, defaultToolTimeoutMs: 60_000 });

  function available(run) {
    const config = hub.serverConfigs.get(run.serverId);
    if (disposed || run.controller.signal.aborted) throw new Error("MCP tool test cancelled");
    if (!config || config.disabled || hub._stopping?.has(run.serverId) || hub._authRequired?.has(run.serverId)) throw new Error("MCP server is unavailable");
    if (run.config && (run.config !== config || run.client !== hub.getServer(run.serverId)
      || run.def !== registry.resolve(run.call.name))) throw new Error("MCP tool changed; start a new test");
    if (run.def && !isToolEnabled(config.tools, run.def.originalName || run.toolName)) throw new Error("MCP tool is no longer enabled");
    if (run.configSnapshot && run.configSnapshot !== configFingerprint(config)) throw new Error("MCP server configuration changed; start a new test");
  }
  function finish(run, result) {
    if (run.final) return run.final;
    const clean = run.redact || createMcpDisplayRedactor({ hub });
    const status = run.controller.signal.aborted ? "cancelled" : result.status || "error";
    const content = boundJson(clean(result.content || []));
    const out = {
      runId: run.id, serverId: run.serverId, toolName: run.toolName, status,
      content: content.value,
      metadata: { ...clean(result.metadata || {}), durationMs: Math.max(0, Date.now() - run.started), ...(content.truncated ? { truncated: true } : {}) }
    };
    run.status = status;
    if (Buffer.byteLength(JSON.stringify(out.metadata), "utf8") > MAX_OUTPUT) out.metadata = { durationMs: out.metadata.durationMs, truncated: true };
    if (Buffer.byteLength(JSON.stringify(out), "utf8") > MAX_OUTPUT) {
      out.metadata = { durationMs: out.metadata.durationMs, truncated: true };
      const overhead = Buffer.byteLength(JSON.stringify({ ...out, content: [] }), "utf8");
      out.content = boundJson(out.content, MAX_OUTPUT - overhead - 128).value;
    }
    if (status !== "approval_required") {
      run.final = out; runs.delete(run.id); clearTimeout(run.timer);
      // Completed/cancelled runs retain only the bounded, redacted result. In
      // particular, a late connection/transport promise must not retain args.
      run.call = null; run.def = null; run.client = null; run.config = null; run.configSnapshot = null; run.redact = null;
    }
    hub.emit("tool_test", { serverId: run.serverId, runId: run.id, toolName: run.toolName, status, durationMs: out.metadata.durationMs });
    return out;
  }
  const errorResult = (run, error) => finish(run, { status: "error", content: [{ type: "error", text: error.message || String(error) }] });
  function context() {
    return { ...getContext(), autonomy: "supervised", approvalCache: null };
  }
  async function execute(run, approved = false) {
    try {
      available(run);
      const policyContext = context();
      const secured = registry.secureToolCall(run.call);
      const decision = permissionEngine.decide(secured, policyContext);
      if (approved && decision.decision === "ask") {
        const cache = createApprovalCache();
        cache.grant(permissionEngine.fingerprint(secured, policyContext), { decision: "allow", ttlMs: 1000 });
        policyContext.approvalCache = cache;
      }
      run.status = "running";
      const result = await executor.execute(run.call, { ...policyContext, signal: run.controller.signal, turnId: `mcp-test:${run.id}` });
      if (result.status === "approval_required" && !run.controller.signal.aborted) {
        run.expires = Date.now() + APPROVAL_TTL;
        run.timer = setTimeout(() => cancel(run.id), APPROVAL_TTL);
        run.timer.unref?.();
      }
      return finish(run, result);
    } catch (error) { return errorResult(run, error); }
  }
  async function prepare(run, params) {
    try {
      available(run);
      // Inspection precedes cloning so cyclic/accessor/non-JSON input cannot
      // execute getters or be silently changed by JSON.stringify.
      const json = validateOutputSchema(true, params);
      if (!json.valid || !params || typeof params !== "object" || Array.isArray(params)) throw new Error("Tool arguments must be a bounded JSON object");
      const cloned = structuredClone(params);
      if (Buffer.byteLength(JSON.stringify(cloned), "utf8") > 64 * 1024) throw new Error("Tool arguments exceed 64 KiB");
      run.redact = createMcpDisplayRedactor({ hub, config: { arguments: cloned } });
      const initialConfig = hub.serverConfigs.get(run.serverId);
      const initialFingerprint = configFingerprint(initialConfig);
      await hub._connectedClient(run.serverId);
      available(run);
      if (hub.serverConfigs.get(run.serverId) !== initialConfig || configFingerprint(initialConfig) !== initialFingerprint) throw new Error("MCP server changed; start a new test");
      const tool = (hub.serverTools.get(run.serverId) || []).find((candidate) => candidate.name === run.toolName || candidate.originalName === run.toolName);
      if (!tool) throw new Error("Tool is not enabled on the selected MCP server");
      const def = registry.resolve(tool.name);
      if (!def || def.source !== "mcp" || def.serverId !== run.serverId) throw new Error("MCP tool is unavailable");
      const validation = validateOutputSchema(def.rawInputSchema ?? def.inputSchema ?? true, cloned);
      if (!validation.valid) throw new Error(`Invalid tool arguments: ${validation.errors.map((e) => e.message.replaceAll("outputSchema", "inputSchema")).join("; ")}`);
      run.call = { id: run.id, name: def.name, params: cloned };
      run.def = def; run.client = hub.getServer(run.serverId); run.config = hub.serverConfigs.get(run.serverId);
      run.configSnapshot = configFingerprint(run.config);
      return await execute(run);
    } catch (error) { return errorResult(run, error); }
  }
  function start(serverId, toolName, params = {}, { requestId = randomUUID() } = {}) {
    if (disposed) throw new Error("MCP tool tests are disposed");
    if (typeof requestId !== "string" || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(requestId) || used.has(requestId) || runs.has(requestId)) throw new Error("Invalid or duplicate MCP test requestId");
    if (typeof serverId !== "string" || !serverId || serverId.length > 256
      || typeof toolName !== "string" || !toolName || toolName.length > 512) throw new Error("Valid MCP server and tool names are required");
    if (runs.size >= MAX_PENDING) throw new Error("Too many pending MCP tool tests");
    const run = { id: requestId, serverId, toolName, started: Date.now(), status: "starting", controller: new AbortController() };
    // Register before the first await: GUI cancellation can immediately find it.
    runs.set(requestId, run); used.add(requestId);
    while (used.size > 2048) used.delete(used.values().next().value);
    return prepare(run, params);
  }
  function approve(runId) {
    const run = runs.get(runId);
    if (!run || run.status !== "approval_required") throw new Error("No pending MCP test approval");
    clearTimeout(run.timer);
    if (run.expires <= Date.now()) { cancel(runId); throw new Error("MCP tool test approval expired"); }
    // Mark synchronously: a double click cannot execute the same approval twice.
    run.status = "running";
    return execute(run, true);
  }
  function cancel(runId) {
    const run = runs.get(runId);
    if (!run) return { runId, status: "not_found", cancelled: false };
    run.controller.abort(Object.assign(new Error("MCP tool test cancelled"), { name: "AbortError", code: "ABORT_ERR" }));
    return { ...finish(run, { status: "cancelled", content: [] }), cancelled: true };
  }
  function cancelServer(serverId) {
    for (const run of [...runs.values()]) if (run.serverId === serverId) cancel(run.id);
  }
  const invalidated = (event) => cancelServer(event.serverId);
  for (const name of ["server_disconnected", "server_removed", "auth_required"]) hub.on?.(name, invalidated);
  return {
    start, approve, cancel, cancelServer,
    dispose() {
      disposed = true;
      for (const run of [...runs.values()]) cancel(run.id);
      for (const name of ["server_disconnected", "server_removed", "auth_required"]) hub.removeListener?.(name, invalidated);
    }
  };
}
