/** Bounded JSON Schema 2020-12 subset. Unsupported assertions fail explicitly. */
// 公共内核 + 场景钩子：JSON 安全走查、类型判定、canonical 序列化与安全 pattern 编译
// 统一来自 src/tools/schema.js；本模块只保留 2020-12 严格断言拦截特有的 keyword 白名单、
// $ref 解析与预算限制，错误码（MCP_OUTPUT_SCHEMA_*）与消息文本逐字不变。
import {
  canonicalJson,
  compileSafePattern,
  hasOwn,
  inspectJson,
  isJsonObject,
  JSON_SAFE_COST,
  JSON_SAFE_LIMITS,
  matchesJsonType
} from "../schema.js";

// 走查深度上限与内核共享；比较/评估/正则预算是本模块特有的断言拦截边界。
const MAX_DEPTH = JSON_SAFE_LIMITS.maxDepth;
const MAX_BYTES = JSON_SAFE_LIMITS.maxBytes;
const MAX_VISITS = 100_000;
const MAX_REGEX_WORK = 4_000_000;
const TYPES = new Set(["null", "boolean", "object", "array", "number", "integer", "string"]);
const ANNOTATIONS = new Set(["$comment", "title", "description", "default", "examples", "deprecated", "readOnly", "writeOnly"]);
const SCHEMA_MAPS = new Set(["$defs", "definitions", "properties", "patternProperties", "dependentSchemas"]);
const SCHEMA_ARRAYS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const SCHEMA_VALUES = new Set(["additionalProperties", "propertyNames", "items", "contains", "not", "if", "then", "else"]);
const COUNTS = new Set(["minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties", "minContains", "maxContains"]);
const NUMBERS = new Set(["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]);
const KEYWORDS = new Set([...ANNOTATIONS, ...SCHEMA_MAPS, ...SCHEMA_ARRAYS, ...SCHEMA_VALUES, ...COUNTS, ...NUMBERS,
  "$schema", "$ref", "type", "enum", "const", "required", "dependentRequired", "uniqueItems", "pattern"]);

class SchemaFailure extends Error {
  constructor(code, message, path = "$") { super(message); this.code = code; this.path = path; }
}
function fail(code, message, path) { throw new SchemaFailure(`MCP_OUTPUT_SCHEMA_${code}`, message, path); }
function requireSchema(condition, message) { if (!condition) fail("INVALID", message); }

// 走查违规原因 → 本模块的错误码与消息（与内核分离，文本逐字保留）。
function walkFailure(kind) {
  if (kind === "limits") fail("LIMIT", "JSON depth/node limit exceeded");
  if (kind === "bytes") fail("LIMIT", "JSON size limit exceeded");
  if (kind === "nonFinite") fail("INVALID", "Non-finite number is not JSON");
  if (kind === "prototype") fail("INVALID", "Only JSON objects are supported");
  if (kind === "cycle") fail("INVALID", "Cyclic JSON value");
  if (kind === "accessor") fail("INVALID", "JSON accessors are unsupported");
  fail("INVALID", "Value is not JSON");
}

// Reject cyclic/non-JSON values, accessors, and oversized schemas/results before
// recursion or serialization. This also bounds equality/uniqueItems work.
// 上限与计费口径与 elicitation 共享（JSON_SAFE_LIMITS/JSON_SAFE_COST）；
// 先查原型再查环、子节点返回后复查字节，沿用本模块原有的检查顺序与时点。
function inspectJsonValue(value) {
  inspectJson(value, { limits: JSON_SAFE_LIMITS, cost: JSON_SAFE_COST, fail: walkFailure, prototypeFirst: true, checkBytesOnEntry: false, checkBytesAfterChild: true });
}

// Native regex has no execution deadline. Support a deliberately restricted
// subset: no groups/alternation/backreferences, at most one variable quantifier,
// bounded fixed repetitions, bounded input and aggregate work.
function safePattern(pattern) {
  return compileSafePattern(pattern, { fail: (kind, message) => fail(kind === "invalid" ? "INVALID" : "UNSUPPORTED", message) });
}

/** Returns {valid,supported,errors}; never claims support for ignored assertions. */
export function validateOutputSchema(schema, value) {
  if (schema === undefined) return { valid: true, supported: true, skipped: true, errors: [] };
  try {
    inspectJsonValue(schema);
    const checked = new Set();
    const patterns = new Map();
    let visits = 0;
    let regexWork = 0;
    let comparisonBytes = 0;
    function fingerprint(item) {
      const serialized = canonicalJson(item);
      comparisonBytes += serialized.length;
      if (comparisonBytes > MAX_BYTES * 8) fail("LIMIT", "Schema comparison budget exceeded");
      return serialized;
    }
    function resolveRef(ref) {
      requireSchema(typeof ref === "string", "$ref must be a string");
      if (!ref.startsWith("#")) fail("UNSUPPORTED", "Only local JSON Pointer $ref is supported");
      let pointer;
      try { pointer = decodeURIComponent(ref.slice(1)); } catch { fail("INVALID", "Invalid $ref encoding"); }
      if (pointer === "") return schema;
      if (!pointer.startsWith("/")) fail("UNSUPPORTED", "Named anchors are unsupported; use local JSON Pointer $ref");
      let target = schema;
      for (const encoded of pointer.slice(1).split("/")) {
        if (/~(?![01])/.test(encoded)) fail("INVALID", "Invalid JSON Pointer escape");
        const key = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
        requireSchema(target !== null && typeof target === "object" && hasOwn(target, key), "Unresolved local $ref");
        target = target[key];
      }
      return target;
    }
    function preflight(node, depth = 0) {
      if (depth > MAX_DEPTH) fail("LIMIT", "Schema reference depth limit exceeded");
      if (typeof node === "boolean") return;
      requireSchema(isJsonObject(node), "Schema must be an object or boolean");
      if (checked.has(node)) return;
      checked.add(node);
      for (const [key, rule] of Object.entries(node)) {
        if (!KEYWORDS.has(key)) fail("UNSUPPORTED", `Unsupported outputSchema keyword: ${key}`);
        if (ANNOTATIONS.has(key)) continue;
        if (key === "$schema") requireSchema(rule === "https://json-schema.org/draft/2020-12/schema", "Only JSON Schema 2020-12 is supported");
        else if (key === "$ref") preflight(resolveRef(rule), depth + 1);
        else if (SCHEMA_MAPS.has(key)) {
          requireSchema(isJsonObject(rule), `${key} must be an object`);
          for (const [name, child] of Object.entries(rule)) {
            if (key === "patternProperties") patterns.set(name, safePattern(name));
            preflight(child, depth + 1);
          }
        } else if (SCHEMA_ARRAYS.has(key)) {
          requireSchema(Array.isArray(rule) && rule.length > 0, `${key} must be a nonempty array`);
          for (const child of rule) preflight(child, depth + 1);
        } else if (SCHEMA_VALUES.has(key)) preflight(rule, depth + 1);
        else if (COUNTS.has(key)) requireSchema(Number.isInteger(rule) && rule >= 0, `${key} must be a nonnegative integer`);
        else if (NUMBERS.has(key)) requireSchema(typeof rule === "number" && Number.isFinite(rule) && (key !== "multipleOf" || rule > 0), `${key} has an invalid numeric bound`);
        else if (key === "type") {
          const types = Array.isArray(rule) ? rule : [rule];
          requireSchema(types.length > 0 && types.every((type) => TYPES.has(type)) && new Set(types).size === types.length, "Invalid type constraint");
        } else if (key === "required") requireSchema(Array.isArray(rule) && rule.every((name) => typeof name === "string") && new Set(rule).size === rule.length, "required must contain unique strings");
        else if (key === "dependentRequired") {
          requireSchema(isJsonObject(rule), "dependentRequired must be an object");
          for (const names of Object.values(rule)) requireSchema(Array.isArray(names) && names.every((name) => typeof name === "string") && new Set(names).size === names.length, "dependentRequired must contain unique string arrays");
        } else if (key === "enum") requireSchema(Array.isArray(rule) && rule.length > 0, "enum must be a nonempty array");
        else if (key === "uniqueItems") requireSchema(typeof rule === "boolean", "uniqueItems must be boolean");
        else if (key === "pattern") patterns.set(rule, safePattern(rule));
      }
    }
    preflight(schema);
    if (value === undefined) fail("MISMATCH", "structuredContent is required when outputSchema is present");
    inspectJsonValue(value);
    function mismatch(message, path) { fail("MISMATCH", message, path); }
    function matches(node, item, path, depth) {
      try { check(node, item, path, depth); return true; }
      catch (error) { if (error.code === "MCP_OUTPUT_SCHEMA_MISMATCH") return false; throw error; }
    }
    function patternMatches(pattern, text) {
      regexWork += Math.max(1, text.length * text.length) * Math.max(1, pattern.length);
      if (text.length > 4096 || regexWork > MAX_REGEX_WORK) fail("LIMIT", "Pattern evaluation budget exceeded");
      return patterns.get(pattern).test(text);
    }
    function check(node, item, path, depth = 0) {
      visits += 1 + (typeof item === "string" || Array.isArray(item) ? item.length : isJsonObject(item) ? Object.keys(item).length : 0);
      if (visits > MAX_VISITS || depth > MAX_DEPTH) fail("LIMIT", "Schema evaluation budget exceeded", path);
      if (node === true) return;
      if (node === false) mismatch("Value rejected by false schema", path);
      const next = (child, childValue = item, childPath = path) => check(child, childValue, childPath, depth + 1);
      if (hasOwn(node, "$ref")) next(resolveRef(node.$ref));
      if (node.type) {
        const wanted = Array.isArray(node.type) ? node.type : [node.type];
        if (!wanted.some((type) => matchesJsonType(item, type))) mismatch("Type does not match outputSchema", path);
      }
      if (hasOwn(node, "const") && fingerprint(item) !== fingerprint(node.const)) mismatch("Value does not match const", path);
      if (node.enum) {
        const target = fingerprint(item);
        if (!node.enum.some((entry) => fingerprint(entry) === target)) mismatch("Value is not in enum", path);
      }
      for (const child of node.allOf || []) next(child);
      if (node.anyOf && !node.anyOf.some((child) => matches(child, item, path, depth + 1))) mismatch("No anyOf branch matched", path);
      if (node.oneOf && node.oneOf.filter((child) => matches(child, item, path, depth + 1)).length !== 1) mismatch("Exactly one oneOf branch must match", path);
      if (hasOwn(node, "not") && matches(node.not, item, path, depth + 1)) mismatch("Value matched forbidden schema", path);
      if (hasOwn(node, "if")) {
        const branch = matches(node.if, item, path, depth + 1) ? "then" : "else";
        if (hasOwn(node, branch)) next(node[branch]);
      }
      if (typeof item === "number") {
        if (hasOwn(node, "minimum") && item < node.minimum || hasOwn(node, "maximum") && item > node.maximum || hasOwn(node, "exclusiveMinimum") && item <= node.exclusiveMinimum || hasOwn(node, "exclusiveMaximum") && item >= node.exclusiveMaximum) mismatch("Number exceeds outputSchema bounds", path);
        if (hasOwn(node, "multipleOf")) {
          const quotient = item / node.multipleOf;
          if (!Number.isFinite(quotient) || Math.abs(quotient - Math.round(quotient)) > Number.EPSILON * Math.max(1, Math.abs(quotient)) * 4) mismatch("Number is not a multipleOf", path);
        }
      }
      if (typeof item === "string") {
        const length = [...item].length;
        if (hasOwn(node, "minLength") && length < node.minLength || hasOwn(node, "maxLength") && length > node.maxLength) mismatch("String length exceeds outputSchema bounds", path);
        if (hasOwn(node, "pattern") && !patternMatches(node.pattern, item)) mismatch("String does not match pattern", path);
      }
      if (Array.isArray(item)) {
        if (hasOwn(node, "minItems") && item.length < node.minItems || hasOwn(node, "maxItems") && item.length > node.maxItems) mismatch("Array length exceeds outputSchema bounds", path);
        if (node.uniqueItems && new Set(item.map(fingerprint)).size !== item.length) mismatch("Array items are not unique", path);
        const prefix = node.prefixItems || [];
        for (let i = 0; i < item.length; i++) {
          if (i < prefix.length) next(prefix[i], item[i], `${path}/${i}`);
          else if (hasOwn(node, "items")) next(node.items, item[i], `${path}/${i}`);
        }
        if (hasOwn(node, "contains")) {
          const count = item.filter((child, index) => matches(node.contains, child, `${path}/${index}`, depth + 1)).length;
          if (count < (node.minContains ?? 1) || count > (node.maxContains ?? Infinity)) mismatch("Array contains count is outside bounds", path);
        }
      }
      if (isJsonObject(item)) {
        const keys = Object.keys(item);
        if (hasOwn(node, "minProperties") && keys.length < node.minProperties || hasOwn(node, "maxProperties") && keys.length > node.maxProperties) mismatch("Object property count is outside bounds", path);
        for (const key of node.required || []) if (!hasOwn(item, key)) mismatch(`Missing required property: ${key}`, path);
        for (const key of keys) {
          const childPath = `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
          if (hasOwn(node, "propertyNames")) next(node.propertyNames, key, childPath);
          let evaluated = false;
          if (node.properties && hasOwn(node.properties, key)) { evaluated = true; next(node.properties[key], item[key], childPath); }
          for (const [pattern, child] of Object.entries(node.patternProperties || {})) {
            if (patternMatches(pattern, key)) { evaluated = true; next(child, item[key], childPath); }
          }
          if (!evaluated && hasOwn(node, "additionalProperties")) next(node.additionalProperties, item[key], childPath);
          if (node.dependentSchemas && hasOwn(node.dependentSchemas, key)) next(node.dependentSchemas[key]);
          const dependents = node.dependentRequired && hasOwn(node.dependentRequired, key) ? node.dependentRequired[key] : [];
          for (const required of dependents) if (!hasOwn(item, required)) mismatch(`Missing dependent property: ${required}`, path);
        }
      }
    }
    check(schema, value, "$");
    return { valid: true, supported: true, errors: [] };
  } catch (error) {
    if (!(error instanceof SchemaFailure)) throw error;
    return { valid: false, supported: error.code !== "MCP_OUTPUT_SCHEMA_UNSUPPORTED", errors: [{ code: error.code, path: error.path, message: error.message }] };
  }
}
