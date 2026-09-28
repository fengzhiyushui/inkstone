import { validateToolParams, toDeepSeekToolSchema } from "./schema.js";

export function createToolRegistry({ tools = [] } = {}) {
  const map = new Map();
  const externalToolMap = new Map();
  for (const tool of tools) register(tool);

  function register(toolDef) {
    validateToolDefinition(toolDef);
    if (map.has(toolDef.name)) throw new Error(`tool already registered: ${toolDef.name}`);
    map.set(toolDef.name, { ...toolDef });
  }

  function mountExternalTools(serverId, toolDefs = []) {
    if (!serverId) throw new Error("mountExternalTools: serverId is required");
    unmountExternalTools(serverId);
    const mountedNames = new Set();
    for (const def of toolDefs) {
      register(def);
      mountedNames.add(def.name);
    }
    externalToolMap.set(serverId, mountedNames);
  }

  function unmountExternalTools(serverId) {
    if (!serverId) return;
    const names = externalToolMap.get(serverId);
    if (names) {
      for (const name of names) {
        map.delete(name);
      }
      externalToolMap.delete(serverId);
    }
  }

  function isExternalTool(name) {
    if (typeof name !== "string") return false;
    if (name.startsWith("mcp__")) return true;
    const tool = map.get(name);
    return tool?.source === "mcp";
  }

  function resolve(name) {
    return map.get(name) || null;
  }

  function listTools(filter = {}) {
    let result = [...map.values()];
    if (filter.category) result = result.filter((tool) => tool.category === filter.category);
    if (filter.source) result = result.filter((tool) => tool.source === filter.source);
    return result.map(publicToolDef);
  }

  function normalizeParams(name, rawParams = {}) {
    const tool = resolve(name);
    if (!tool) throw new Error(`unknown tool: ${name}`);
    if (tool.source === "mcp" || tool.rawFunctionSchema) {
      return tool.normalizeParams ? tool.normalizeParams(rawParams) : rawParams;
    }
    const normalized = tool.normalizeParams ? tool.normalizeParams(rawParams) : rawParams;
    return validateToolParams(name, tool.params || {}, normalized);
  }

  function toDeepSeekTools(filter = {}) {
    return listTools(filter).map(toDeepSeekToolSchema);
  }

  function secureToolCall(toolCall) {
    const def = resolve(toolCall.name);
    if (!def) throw new Error(`Unknown tool: ${toolCall.name}`);
    const params = normalizeParams(def.name, toolCall.params || {});
    const category = typeof def.resolveCategory === "function" ? def.resolveCategory(params) : def.category;
    return {
      id: toolCall.id,
      name: def.name,
      params,
      category,
      risk_level: def.risk_level,
      side_effect: def.side_effect,
      autoApprove: Boolean(def.autoApprove),
      requested_by_step_id: toolCall.requested_by_step_id
    };
  }

  return {
    register,
    resolve,
    listTools,
    normalizeParams,
    toDeepSeekTools,
    secureToolCall,
    mountExternalTools,
    unmountExternalTools,
    isExternalTool
  };
}

function validateToolDefinition(toolDef) {
  if (!toolDef?.name) throw new Error("tool name is required");
  if (!toolDef.description) throw new Error(`tool description is required: ${toolDef.name}`);
  if (!toolDef.category) throw new Error(`tool category is required: ${toolDef.name}`);
  if (typeof toolDef.execute !== "function") throw new Error(`tool execute function is required: ${toolDef.name}`);
}

function publicToolDef(tool) {
  const { execute, normalizeParams, resolveCategory, ...publicFields } = tool;
  return publicFields;
}
