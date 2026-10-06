import { redactSecrets } from "./redactor.js";

const SECRET_KEY = /api[_-]?key|token|secret|password|passwd|authorization|credential/i;

// Shared presentation boundary for CLI and Electron. Never render binary payloads,
// and scrub both recognizable secret syntax and actual locally configured values.
export function createMcpDisplayRedactor({ config = {}, hub = null, knownSecrets = [] } = {}) {
  const secrets = new Set(knownSecrets.filter((v) => typeof v === "string" && v));
  const collecting = new WeakSet();
  let collected = 0;
  const collect = (value, sensitive = false, depth = 0) => {
    if (depth > 32 || ++collected > 20000) return;
    if (typeof value === "string" && sensitive && value) {
      secrets.add(value);
      if (/^Bearer\s+/i.test(value)) secrets.add(value.replace(/^Bearer\s+/i, ""));
    } else if (value && typeof value === "object") {
      if (collecting.has(value)) return;
      collecting.add(value);
      if (Array.isArray(value)) value.forEach((child) => collect(child, sensitive, depth + 1));
      else for (const [key, child] of Object.entries(value)) collect(child, sensitive || SECRET_KEY.test(key), depth + 1);
      collecting.delete(value);
    }
  };
  collect(config);
  collect(hub?.rawConfigs);
  for (const server of hub?.serverConfigs?.values?.() || []) collect(server);
  for (const input of Object.values(hub?.inputs || {})) collect(input?.value, true);
  const values = [...secrets].sort((a, b) => b.length - a.length);
  const text = (value) => {
    let out = String(value);
    // Refresh can rotate tokens during the operation being displayed. Read this
    // set at render time, including when the redactor predates the request.
    for (const secret of hub?.oauthSecrets || []) if (secret) out = out.split(secret).join("[REDACTED]");
    // Tools may echo input inside serialized JSON text instead of as a scalar.
    // Match the escaped spelling too, before replacing its raw representation.
    for (const secret of hub?.inputSecrets || []) if (secret) {
      const escaped = JSON.stringify(secret).slice(1, -1);
      if (escaped !== secret) out = out.split(escaped).join("[REDACTED]");
      out = out.split(secret).join("[REDACTED]");
    }
    for (const secret of values) out = out.split(secret).join("[REDACTED]");
    return redactSecrets(out);
  };
  const clean = (input, { inputContent = false } = {}) => {
    const ancestors = new WeakSet();
    const reasons = new Set();
    let nodes = 0;
    const omit = (reason) => { reasons.add(reason); return `[content omitted: ${reason}]`; };
    const visit = (value, depth = 0) => {
      if (depth > 32) return omit("depth limit");
      if (++nodes > 20000) return omit("item limit");
      if (typeof value === "string") return text(value);
      if (typeof value === "number" && hub?.inputSecrets?.has(String(value))) return "[REDACTED]";
      // Typed booleans in external content can be form answers too. Framework
      // flags (isError, outputValidation.valid, etc.) retain their boolean type.
      if (inputContent && typeof value === "boolean" && hub?.inputSecrets?.has(String(value))) return "[REDACTED]";
      if (!value || typeof value !== "object") return value;
      if (ancestors.has(value)) return omit("circular reference");
      ancestors.add(value);
      const out = Array.isArray(value) ? [] : {};
      const entries = Array.isArray(value) ? value.entries() : Object.entries(value);
      for (const [key, child] of entries) {
        if (nodes >= 20000) {
          if (Array.isArray(out)) out.push(omit("item limit"));
          else out._displayOmitted = omit("item limit");
          break;
        }
        const binary = typeof child === "string" && (key === "blob"
          || key === "data" && ["image", "audio"].includes(value.type));
        const cleaned = binary ? "[binary omitted]"
          : SECRET_KEY.test(String(key)) && typeof child === "string" && child ? "[REDACTED]" : visit(child, depth + 1);
        // JSON keys are external data too. Keep colliding redacted keys with stable
        // suffixes rather than silently overwriting another field.
        const baseKey = Array.isArray(out) ? key : text(key);
        let safeKey = baseKey;
        let collision = 1;
        while (Object.prototype.hasOwnProperty.call(out, safeKey)) safeKey = `${baseKey}#${++collision}`;
        Object.defineProperty(out, safeKey, { value: cleaned, enumerable: true, writable: true, configurable: true });
      }
      ancestors.delete(value);
      return out;
    };
    const out = visit(input);
    if (reasons.size && out && typeof out === "object" && !Array.isArray(out)) {
      out.truncated = true;
      out.displayTruncated = true;
      out.displayTruncationReasons = [...reasons];
    }
    return out;
  };
  return clean;
}

export function sanitizeMcpDisplay(value, options = {}) {
  return createMcpDisplayRedactor(options)(value);
}

// Schema keywords, types and parameter identifiers are an executable contract.
// Scrub descriptive/default/example data without renaming that contract when a
// short configured secret happens to match a keyword or parameter name.
export function sanitizeMcpSchema(schema, clean = createMcpDisplayRedactor(), { preserveConstraints = false } = {}) {
  const maps = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
  const children = new Set(["items", "additionalProperties", "propertyNames", "contains", "not", "if", "then", "else"]);
  const lists = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
  // Private elicitation delivery needs the actual selectable values and bounds.
  // Redacting a prior short answer must not change the form's valid responses.
  // General tool-schema presentation retains its existing redaction behavior.
  const constraints = new Set(["enum", "const", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
    "minLength", "maxLength", "pattern", "format", "minItems", "maxItems", "uniqueItems", "minContains", "maxContains",
    "minProperties", "maxProperties"]);
  let nodes = 0;
  const visit = (value, depth = 0) => {
    if (++nodes > 20000 || depth > 32) return false;
    if (typeof value === "boolean") return value;
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const output = Object.create(null);
    for (const [key, item] of Object.entries(value)) {
      if (++nodes > 20000) return false;
      if (maps.has(key) && item && typeof item === "object" && !Array.isArray(item)) {
        output[key] = Object.fromEntries(Object.entries(item).map(([name, child]) => [name, visit(child, depth + 1)]));
      } else if (children.has(key)) output[key] = visit(item, depth + 1);
      else if (lists.has(key) && Array.isArray(item)) output[key] = item.map((child) => visit(child, depth + 1));
      else if (["type", "required", "dependentRequired", "$ref", "$schema"].includes(key)
        || preserveConstraints && constraints.has(key)) output[key] = structuredClone(item);
      else output[key] = clean(item);
    }
    return output;
  };
  return visit(schema);
}
