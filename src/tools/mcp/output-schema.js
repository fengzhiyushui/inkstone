/** Bounded JSON Schema 2020-12 subset. Unsupported assertions fail explicitly. */
const MAX_DEPTH = 64;
const MAX_NODES = 20_000;
const MAX_BYTES = 1_048_576;
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
const own = (value, key) => Object.hasOwn(value, key);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

class SchemaFailure extends Error {
  constructor(code, message, path = "$") { super(message); this.code = code; this.path = path; }
}
function fail(code, message, path) { throw new SchemaFailure(`MCP_OUTPUT_SCHEMA_${code}`, message, path); }
function requireSchema(condition, message) { if (!condition) fail("INVALID", message); }

// Reject cyclic/non-JSON values, accessors, and oversized schemas/results before
// recursion or serialization. This also bounds equality/uniqueItems work.
function inspectJson(value) {
  let nodes = 0;
  let bytes = 0;
  const ancestors = new Set();
  function visit(item, depth) {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) fail("LIMIT", "JSON depth/node limit exceeded");
    if (item === null || typeof item === "boolean") { bytes += 5; return; }
    if (typeof item === "number") {
      requireSchema(Number.isFinite(item), "Non-finite number is not JSON"); bytes += 24; return;
    }
    if (typeof item === "string") { bytes += item.length * 3 + 2; }
    else if (typeof item === "object") {
      requireSchema(Array.isArray(item) || Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null, "Only JSON objects are supported");
      requireSchema(!ancestors.has(item), "Cyclic JSON value");
      ancestors.add(item);
      for (const key of Object.keys(item)) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        requireSchema(descriptor && own(descriptor, "value"), "JSON accessors are unsupported");
        bytes += key.length * 3 + 4;
        visit(descriptor.value, depth + 1);
        if (bytes > MAX_BYTES) fail("LIMIT", "JSON size limit exceeded");
      }
      ancestors.delete(item);
    } else fail("INVALID", "Value is not JSON");
    if (bytes > MAX_BYTES) fail("LIMIT", "JSON size limit exceeded");
  }
  visit(value, 0);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

// Native regex has no execution deadline. Support a deliberately restricted
// subset: no groups/alternation/backreferences, at most one variable quantifier,
// bounded fixed repetitions, bounded input and aggregate work.
function safePattern(pattern) {
  requireSchema(typeof pattern === "string", "pattern must be a string");
  if (pattern.length > 256) fail("UNSUPPORTED", "pattern exceeds supported length");
  let variable = 0;
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      const next = pattern[++i];
      if (!next || /[1-9kpPuU]/.test(next)) fail("UNSUPPORTED", "pattern escape is unsupported");
      continue;
    }
    if (ch === "[" && !inClass) { inClass = true; continue; }
    if (ch === "]" && inClass) { inClass = false; continue; }
    if (inClass) continue;
    if (ch === "(" || ch === ")" || ch === "|") fail("UNSUPPORTED", "pattern groups and alternation are unsupported");
    if (ch === "*" || ch === "+" || ch === "?") variable++;
    if (ch === "{") {
      const match = pattern.slice(i).match(/^\{(\d+)(?:,(\d*))?\}/);
      if (!match || Number(match[1]) > 1000 || (match[2] && Number(match[2]) > 1000)) fail("UNSUPPORTED", "pattern repetition is unsupported");
      if (match[2] !== undefined && match[2] !== match[1]) variable++;
      i += match[0].length - 1;
    }
    if (variable > 1) fail("UNSUPPORTED", "pattern has multiple variable repetitions");
  }
  try { return new RegExp(pattern, "u"); }
  catch { fail("INVALID", "Invalid pattern syntax"); }
}

/** Returns {valid,supported,errors}; never claims support for ignored assertions. */
export function validateOutputSchema(schema, value) {
  if (schema === undefined) return { valid: true, supported: true, skipped: true, errors: [] };
  try {
    inspectJson(schema);
    const checked = new Set();
    const patterns = new Map();
    let visits = 0;
    let regexWork = 0;
    let comparisonBytes = 0;
    function fingerprint(item) {
      const serialized = canonical(item);
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
        requireSchema(target !== null && typeof target === "object" && own(target, key), "Unresolved local $ref");
        target = target[key];
      }
      return target;
    }
    function preflight(node, depth = 0) {
      if (depth > MAX_DEPTH) fail("LIMIT", "Schema reference depth limit exceeded");
      if (typeof node === "boolean") return;
      requireSchema(object(node), "Schema must be an object or boolean");
      if (checked.has(node)) return;
      checked.add(node);
      for (const [key, rule] of Object.entries(node)) {
        if (!KEYWORDS.has(key)) fail("UNSUPPORTED", `Unsupported outputSchema keyword: ${key}`);
        if (ANNOTATIONS.has(key)) continue;
        if (key === "$schema") requireSchema(rule === "https://json-schema.org/draft/2020-12/schema", "Only JSON Schema 2020-12 is supported");
        else if (key === "$ref") preflight(resolveRef(rule), depth + 1);
        else if (SCHEMA_MAPS.has(key)) {
          requireSchema(object(rule), `${key} must be an object`);
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
          requireSchema(object(rule), "dependentRequired must be an object");
          for (const names of Object.values(rule)) requireSchema(Array.isArray(names) && names.every((name) => typeof name === "string") && new Set(names).size === names.length, "dependentRequired must contain unique string arrays");
        } else if (key === "enum") requireSchema(Array.isArray(rule) && rule.length > 0, "enum must be a nonempty array");
        else if (key === "uniqueItems") requireSchema(typeof rule === "boolean", "uniqueItems must be boolean");
        else if (key === "pattern") patterns.set(rule, safePattern(rule));
      }
    }
    preflight(schema);
    if (value === undefined) fail("MISMATCH", "structuredContent is required when outputSchema is present");
    inspectJson(value);
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
      visits += 1 + (typeof item === "string" || Array.isArray(item) ? item.length : object(item) ? Object.keys(item).length : 0);
      if (visits > MAX_VISITS || depth > MAX_DEPTH) fail("LIMIT", "Schema evaluation budget exceeded", path);
      if (node === true) return;
      if (node === false) mismatch("Value rejected by false schema", path);
      const next = (child, childValue = item, childPath = path) => check(child, childValue, childPath, depth + 1);
      if (own(node, "$ref")) next(resolveRef(node.$ref));
      if (node.type) {
        const actual = item === null ? "null" : Array.isArray(item) ? "array" : typeof item;
        const wanted = Array.isArray(node.type) ? node.type : [node.type];
        if (!wanted.some((type) => type === actual || (type === "integer" && typeof item === "number" && Number.isInteger(item)))) mismatch("Type does not match outputSchema", path);
      }
      if (own(node, "const") && fingerprint(item) !== fingerprint(node.const)) mismatch("Value does not match const", path);
      if (node.enum) {
        const target = fingerprint(item);
        if (!node.enum.some((entry) => fingerprint(entry) === target)) mismatch("Value is not in enum", path);
      }
      for (const child of node.allOf || []) next(child);
      if (node.anyOf && !node.anyOf.some((child) => matches(child, item, path, depth + 1))) mismatch("No anyOf branch matched", path);
      if (node.oneOf && node.oneOf.filter((child) => matches(child, item, path, depth + 1)).length !== 1) mismatch("Exactly one oneOf branch must match", path);
      if (own(node, "not") && matches(node.not, item, path, depth + 1)) mismatch("Value matched forbidden schema", path);
      if (own(node, "if")) {
        const branch = matches(node.if, item, path, depth + 1) ? "then" : "else";
        if (own(node, branch)) next(node[branch]);
      }
      if (typeof item === "number") {
        if (own(node, "minimum") && item < node.minimum || own(node, "maximum") && item > node.maximum || own(node, "exclusiveMinimum") && item <= node.exclusiveMinimum || own(node, "exclusiveMaximum") && item >= node.exclusiveMaximum) mismatch("Number exceeds outputSchema bounds", path);
        if (own(node, "multipleOf")) {
          const quotient = item / node.multipleOf;
          if (!Number.isFinite(quotient) || Math.abs(quotient - Math.round(quotient)) > Number.EPSILON * Math.max(1, Math.abs(quotient)) * 4) mismatch("Number is not a multipleOf", path);
        }
      }
      if (typeof item === "string") {
        const length = [...item].length;
        if (own(node, "minLength") && length < node.minLength || own(node, "maxLength") && length > node.maxLength) mismatch("String length exceeds outputSchema bounds", path);
        if (own(node, "pattern") && !patternMatches(node.pattern, item)) mismatch("String does not match pattern", path);
      }
      if (Array.isArray(item)) {
        if (own(node, "minItems") && item.length < node.minItems || own(node, "maxItems") && item.length > node.maxItems) mismatch("Array length exceeds outputSchema bounds", path);
        if (node.uniqueItems && new Set(item.map(fingerprint)).size !== item.length) mismatch("Array items are not unique", path);
        const prefix = node.prefixItems || [];
        for (let i = 0; i < item.length; i++) {
          if (i < prefix.length) next(prefix[i], item[i], `${path}/${i}`);
          else if (own(node, "items")) next(node.items, item[i], `${path}/${i}`);
        }
        if (own(node, "contains")) {
          const count = item.filter((child, index) => matches(node.contains, child, `${path}/${index}`, depth + 1)).length;
          if (count < (node.minContains ?? 1) || count > (node.maxContains ?? Infinity)) mismatch("Array contains count is outside bounds", path);
        }
      }
      if (object(item)) {
        const keys = Object.keys(item);
        if (own(node, "minProperties") && keys.length < node.minProperties || own(node, "maxProperties") && keys.length > node.maxProperties) mismatch("Object property count is outside bounds", path);
        for (const key of node.required || []) if (!own(item, key)) mismatch(`Missing required property: ${key}`, path);
        for (const key of keys) {
          const childPath = `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
          if (own(node, "propertyNames")) next(node.propertyNames, key, childPath);
          let evaluated = false;
          if (node.properties && own(node.properties, key)) { evaluated = true; next(node.properties[key], item[key], childPath); }
          for (const [pattern, child] of Object.entries(node.patternProperties || {})) {
            if (patternMatches(pattern, key)) { evaluated = true; next(child, item[key], childPath); }
          }
          if (!evaluated && own(node, "additionalProperties")) next(node.additionalProperties, item[key], childPath);
          if (node.dependentSchemas && own(node.dependentSchemas, key)) next(node.dependentSchemas[key]);
          const dependents = node.dependentRequired && own(node.dependentRequired, key) ? node.dependentRequired[key] : [];
          for (const required of dependents) if (!own(item, required)) mismatch(`Missing dependent property: ${required}`, path);
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
