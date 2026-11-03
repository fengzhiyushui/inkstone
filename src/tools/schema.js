// src/tools/schema.js — 公共 Schema 内核：零依赖的 JSON Schema 子集校验与字段提取原语。
// 结构 = 公共内核 + 场景钩子：
//   内核 —— JSON 安全走查（拒绝环/访问器/非 JSON/超限）、精确类型判定、canonical 序列化、
//           安全 pattern 编译、对象 schema 字段提取；
//   钩子 —— limits 与计费口径、违规原因 → 错误码/消息的映射、检查顺序与复查时机，
//           由各场景配置，以保留各自特有的边界约束。
// 使用者：src/tools/mcp/output-schema.js（2020-12 严格断言拦截，MCP_OUTPUT_SCHEMA_*）、
//         src/tools/mcp/elicitation-schema.js（平面标量/枚举/格式与大小限制，MCP_INPUT_INVALID）、
//         src/tools/mcp/schema-converter.js（脱敏 JSON 走查语义）、
//         gui/src/state/mcp-diagnostics.js（宽松类型校验与 JSON.stringify 枚举比较）。
// 本文件被 Node 内核与 Vite GUI 包共同引用，因此禁止任何 node: 导入或包依赖，只使用语言内置能力。

/** 自身属性判定（含访问器属性自身的 value 描述符检查），供走查与 keyword 断言共用。 */
export const hasOwn = (value, key) => Object.hasOwn(value, key);

/** 精确的 JSON 对象判定：排除 null 与数组（原型形态由走查钩子另行判定）。 */
export function isJsonObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** JSON 值类型标签：null/array 优先于 typeof，其余回落 typeof。 */
function jsonTypeOf(value) {
  return value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}

/** 类型匹配：integer 只接受 Number.isInteger 的 number，未知类型一律不匹配。 */
export function matchesJsonType(value, type) {
  return type === jsonTypeOf(value) || (type === "integer" && typeof value === "number" && Number.isInteger(value));
}

/** JSON 安全走查的共享上限：深度 / 节点数 / 计费字节（output-schema、elicitation、schema-converter 同源）。 */
export const JSON_SAFE_LIMITS = { maxDepth: 64, maxNodes: 20_000, maxBytes: 1_048_576 };

/** 共享计费口径：标点固定成本 + 字符串/键按长度线性计价；场景可整体替换（如脱敏走查不计标点）。 */
export const JSON_SAFE_COST = {
  string: (length) => length * 3 + 2,
  key: (length) => length * 3 + 4,
  primitive: () => 5,
  number: () => 24
};

/**
 * 走查内核：递归拒绝环、访问器、非 JSON 值与超限值，并在 rebuild 模式下按钩子产出副本。
 * 配置（场景钩子）：
 * - limits/cost：上限与计费口径；字节超限按 fail("bytes")、深度/节点超限按 fail("limits") 失败。
 * - fail(kind)：违规原因 → 场景各自的错误码与消息；kind ∈ limits|bytes|prototype|cycle|accessor|nonFinite|nonJson。
 * - prototypeFirst：output-schema 先查原型再查环，schema-converter 先查环再查原型（逐字保留原有顺序）。
 * - checkBytesOnEntry/checkBytesAfterChild：字节预算的复查时机——output-schema 在每个子节点返回后复查，
 *   schema-converter 在进入每个节点与字符串计价后复查（逐字保留原有时点，含其失败开放的边界）。
 * - onString/onKey（仅 rebuild）：onString 替换字符串，onKey(key, recurse) 决定敏感键是否继续递归。
 */
function walkJson(value, config, rebuild) {
  const limits = config.limits;
  const cost = config.cost;
  let nodes = 0;
  let bytes = 0;
  const ancestors = new Set();
  const overflow = () => {
    if (bytes > limits.maxBytes) config.fail("bytes");
  };
  function visit(item, depth) {
    if (++nodes > limits.maxNodes || depth > limits.maxDepth) config.fail("limits");
    if (config.checkBytesOnEntry && bytes > limits.maxBytes) config.fail("bytes");
    if (typeof item === "string") {
      bytes += cost.string(item.length);
      overflow();
      return rebuild ? config.onString(item) : undefined;
    }
    if (item === null || typeof item === "boolean") {
      bytes += cost.primitive();
      overflow();
      return rebuild ? item : undefined;
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) config.fail("nonFinite");
      bytes += cost.number();
      overflow();
      return rebuild ? item : undefined;
    }
    if (typeof item === "object") {
      const jsonShaped = Array.isArray(item) || Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null;
      const cyclic = ancestors.has(item);
      // 场景钩子：两个调用方原有的检查顺序不同，按配置逐字保留。
      if (config.prototypeFirst) {
        if (!jsonShaped) config.fail("prototype");
        if (cyclic) config.fail("cycle");
      } else {
        if (cyclic) config.fail("cycle");
        if (!jsonShaped) config.fail("prototype");
      }
      ancestors.add(item);
      const entries = rebuild ? [] : null;
      for (const key of Object.keys(item)) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor || !hasOwn(descriptor, "value")) config.fail("accessor");
        bytes += cost.key(key.length);
        if (rebuild && config.onKey) {
          entries.push([key, config.onKey(key, () => visit(descriptor.value, depth + 1))]);
          continue;
        }
        const child = visit(descriptor.value, depth + 1);
        if (config.checkBytesAfterChild) overflow();
        if (rebuild) entries.push([key, child]);
      }
      ancestors.delete(item);
      return rebuild ? (Array.isArray(item) ? entries.map(([, child]) => child) : Object.fromEntries(entries)) : undefined;
    }
    config.fail("nonJson");
  }
  return visit(value, 0);
}

/** 只读走查：拒绝环/访问器/非 JSON/超限，不产出副本（output-schema、elicitation 使用）。 */
export function inspectJson(value, config) {
  walkJson(value, config, false);
}

/** 重建式走查：同等安全判定下按 onString/onKey 钩子产出副本（schema-converter 脱敏使用）。 */
export function mapJson(value, config) {
  return walkJson(value, config, true);
}

/** canonical 序列化：键排序后的稳定指纹，用于 const/enum/uniqueItems 的相等比较。 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isJsonObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

/**
 * 安全 pattern 编译：Native regex 没有执行截止时间，只支持刻意收窄的子集——
 * 无分组/交替/反向引用、至多一个可变量词、固定重复有界、输入与累计工作量有界。
 * fail(kind, message) 由场景提供（kind ∈ invalid|unsupported）且必须抛错。
 */
export function compileSafePattern(pattern, { maxLength = 256, fail }) {
  if (typeof pattern !== "string") fail("invalid", "pattern must be a string");
  if (pattern.length > maxLength) fail("unsupported", "pattern exceeds supported length");
  let variable = 0;
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      const next = pattern[++i];
      if (!next || /[1-9kpPuU]/.test(next)) fail("unsupported", "pattern escape is unsupported");
      continue;
    }
    if (ch === "[" && !inClass) { inClass = true; continue; }
    if (ch === "]" && inClass) { inClass = false; continue; }
    if (inClass) continue;
    if (ch === "(" || ch === ")" || ch === "|") fail("unsupported", "pattern groups and alternation are unsupported");
    if (ch === "*" || ch === "+" || ch === "?") variable++;
    if (ch === "{") {
      const match = pattern.slice(i).match(/^\{(\d+)(?:,(\d*))?\}/);
      if (!match || Number(match[1]) > 1000 || (match[2] && Number(match[2]) > 1000)) fail("unsupported", "pattern repetition is unsupported");
      if (match[2] !== undefined && match[2] !== match[1]) variable++;
      i += match[0].length - 1;
    }
    if (variable > 1) fail("unsupported", "pattern has multiple variable repetitions");
  }
  try { return new RegExp(pattern, "u"); }
  catch { fail("invalid", "Invalid pattern syntax"); }
}

/**
 * 对象 schema 字段提取：扁平 object schema → [{ name, definition, required }]。
 * 组合/引用 schema（$ref/oneOf/anyOf/allOf）或非 object schema 返回 null（GUI 侧同语义）。
 */
export function objectSchemaFields(schema) {
  if (!isJsonObject(schema) || schema.type && schema.type !== "object" || schema.$ref || schema.oneOf || schema.anyOf || schema.allOf
    || !isJsonObject(schema.properties)) return null;
  return Object.entries(schema.properties).map(([name, definition]) => ({ name,
    definition: isJsonObject(definition) ? definition : {}, required: Array.isArray(schema.required) && schema.required.includes(name) }));
}

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

// 工具参数标量类型判定复用内核的 JSON 对象谓词，分支与错误消息文本保持原样。
function assertType(toolName, key, spec, value) {
  if (spec.type === "array") {
    if (!Array.isArray(value)) throw new Error(`${toolName}.${key} must be array`);
    return;
  }
  if (spec.type === "object") {
    if (!isJsonObject(value)) {
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
