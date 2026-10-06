import { describeEvent } from "../../../src/apps/event-contract.js";
const object = (value) => value && typeof value === "object" && !Array.isArray(value);

export function includeMcpActivity(event) {
  return event?.type !== "mcp:log" || !describeEvent(event).quiet;
}

export function checkedDiagnosticResult(result) {
  if (result?.error && !["error", "cancelled"].includes(result.status)) throw new Error(typeof result.error === "string" ? result.error : "MCP diagnostics failed");
  if (!result || typeof result !== "object") throw new Error("Invalid MCP diagnostics response");
  return result;
}

export function checkedDiagnosticTools(result) {
  checkedDiagnosticResult(result);
  if (!Array.isArray(result) || result.some((tool) => !object(tool) || typeof tool.name !== "string"
    || tool.description != null && typeof tool.description !== "string" || tool.originalName != null && typeof tool.originalName !== "string"
    || tool.inputSchema != null && typeof tool.inputSchema !== "boolean" && !object(tool.inputSchema))) throw new Error("Invalid MCP tools response");
  return result;
}

export function checkedDiagnosticLogs(result) {
  checkedDiagnosticResult(result);
  if (!Array.isArray(result.entries) || result.entries.some((entry) => !object(entry))) throw new Error("Invalid MCP logs response");
  // These are external data: stringify unexpected scalar types instead of letting React render objects.
  return { ...result, entries: result.entries.map((entry) => Object.fromEntries(Object.entries(entry).map(([key, value]) =>
    [key, value != null && typeof value === "object" ? JSON.stringify(value) : value]))) };
}

export function schemaFields(schema) {
  if (!object(schema) || schema.type && schema.type !== "object" || schema.$ref || schema.oneOf || schema.anyOf || schema.allOf
    || !object(schema.properties)) return null;
  return Object.entries(schema.properties).map(([name, definition]) => ({ name,
    definition: object(definition) ? definition : {}, required: Array.isArray(schema.required) && schema.required.includes(name) }));
}

export function toolParameters(schema, values, json) {
  let params;
  const fields = schemaFields(schema);
  if (typeof json === "string" || !fields) {
    try { params = JSON.parse(json || "{}"); } catch { throw new Error("json"); }
  } else {
    params = {};
    for (const { name, definition, required } of fields) {
      const raw = values[name];
      if (raw === undefined || raw === "") { if (required) throw new Error(`required: ${name}`); continue; }
      let value = raw;
      if (Array.isArray(definition.enum) || definition.type !== "string") {
        try { value = JSON.parse(raw); } catch { throw new Error(`json: ${name}`); }
      }
      Object.defineProperty(params, name, { value, enumerable: true, configurable: true });
    }
  }
  if (!object(params)) throw new Error("object");
  for (const name of Array.isArray(schema?.required) ? schema.required : []) if (!Object.hasOwn(params, name)) throw new Error(`required: ${name}`);
  for (const [name, value] of Object.entries(params)) {
    const definition = schema?.properties?.[name];
    if (!definition || typeof definition !== "object") continue;
    const types = Array.isArray(definition.type) ? definition.type : [definition.type];
    const validType = (type) => !type || (type === "object" ? object(value) : type === "array" ? Array.isArray(value)
      : type === "integer" ? Number.isInteger(value) : type === "null" ? value === null : typeof value === type && (type !== "number" || Number.isFinite(value)));
    if (!types.some(validType)) throw new Error(`type: ${name}`);
    if (Array.isArray(definition.enum) && !definition.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) throw new Error(`enum: ${name}`);
  }
  return params;
}

export function createToolTestController({ kernel, serverId, onState, makeId = () => crypto.randomUUID() }) {
  let state = { status: "idle", busy: false };
  let disposed = false;
  let generation = 0;
  const emit = (next) => { state = next; if (!disposed) onState(next); };
  async function execute(method, args, runId) {
    const current = ++generation;
    emit({ status: "running", busy: true, runId });
    try {
      const result = checkedDiagnosticResult(await kernel[method](...args));
      if (!disposed && current === generation) emit({ ...result, busy: false, runId: result.runId || runId });
    } catch (error) {
      if (!disposed && current === generation) emit({ status: "error", busy: false, runId, error: error.message });
    }
  }
  return {
    start(name, params) {
      if (disposed || state.busy || state.status === "approval_required") return Promise.resolve();
      const runId = makeId();
      return execute("startMcpToolTest", [serverId, name, params, { requestId: runId }], runId);
    },
    approve() {
      if (disposed || state.busy || state.status !== "approval_required") return Promise.resolve();
      return execute("approveMcpToolTest", [state.runId], state.runId);
    },
    async cancel() {
      if (disposed || !state.runId || !["running", "approval_required"].includes(state.status)) return;
      const current = generation;
      try {
        const result = checkedDiagnosticResult(await kernel.cancelMcpToolTest(state.runId));
        if (!disposed && current === generation && result.cancelled) {
          generation++;
          emit({ status: "cancelled", busy: false, runId: state.runId });
        }
      } catch (error) {
        if (!disposed && current === generation) emit({ ...state, cancelError: error.message });
      }
    },
    dispose() {
      disposed = true;
      generation++;
      if (state.runId && ["running", "approval_required"].includes(state.status)) void kernel.cancelMcpToolTest(state.runId).catch(() => {});
    }
  };
}
