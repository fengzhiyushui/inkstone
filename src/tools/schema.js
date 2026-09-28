const SUPPORTED_TYPES = new Set(["string", "number", "boolean", "array", "object"]);

export function validateToolParams(toolName, schema = {}, rawParams = {}) {
  const result = {};
  for (const key of Object.keys(rawParams)) {
    if (!schema[key]) throw new Error(`unknown param for ${toolName}: ${key}`);
  }
  for (const [key, spec] of Object.entries(schema)) {
    const hasValue = Object.prototype.hasOwnProperty.call(rawParams, key);
    if (!hasValue) {
      if (Object.prototype.hasOwnProperty.call(spec, "default")) result[key] = spec.default;
      else if (spec.required !== false) throw new Error(`missing required param: ${key}`);
      continue;
    }
    const value = rawParams[key];
    assertType(toolName, key, spec, value);
    if (spec.enum && !spec.enum.includes(value)) {
      throw new Error(`${toolName}.${key} must be one of: ${spec.enum.join(", ")}`);
    }
    result[key] = value;
  }
  return result;
}

export function toDeepSeekToolSchema(toolDef) {
  if (toolDef.rawFunctionSchema) {
    return toolDef.rawFunctionSchema;
  }
  const properties = {};
  const required = [];
  for (const [key, spec] of Object.entries(toolDef.params || {})) {
    if (spec.internal) continue;
    if (!SUPPORTED_TYPES.has(spec.type)) throw new Error(`unsupported schema type: ${spec.type}`);
    properties[key] = stripInternalFields(spec);
    if (spec.required !== false && !Object.prototype.hasOwnProperty.call(spec, "default")) {
      required.push(key);
    }
  }
  return {
    type: "function",
    function: {
      name: toolDef.name,
      description: toolDef.description,
      parameters: {
        type: "object",
        properties,
        required,
        additionalProperties: false
      }
    }
  };
}

function assertType(toolName, key, spec, value) {
  if (spec.type === "array") {
    if (!Array.isArray(value)) throw new Error(`${toolName}.${key} must be array`);
    return;
  }
  if (spec.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${toolName}.${key} must be object`);
    }
    return;
  }
  if (typeof value !== spec.type) {
    throw new Error(`${toolName}.${key} must be ${spec.type}`);
  }
}

function stripInternalFields(spec) {
  const { required, internal, ...publicSpec } = spec;
  return publicSpec;
}
