import { isIP } from "node:net";
import { validateOutputSchema } from "./output-schema.js";

const MAX_BYTES = 65_536;
const MAX_STRING_BYTES = 16_384;
const MAX_FIELDS = 64;
const FORM_KEYS = new Set(["$schema", "type", "properties", "required"]);
const ANNOTATIONS = ["type", "title", "description", "default"];
const FORMATS = new Set(["email", "uri", "date", "date-time"]);
const own = (value, key) => Object.hasOwn(value, key);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function invalid() {
  const error = new Error("MCP input does not match the supported form schema");
  error.code = "MCP_INPUT_INVALID";
  throw error;
}

// Inspect before cloning: reject accessors, cycles, exotic prototypes, non-JSON
// values and excessive depth/nodes without invoking JSON serialization hooks.
function detachedJson(value) {
  try {
    if (!validateOutputSchema(true, value).valid) invalid();
    const clone = structuredClone(value);
    if (Buffer.byteLength(JSON.stringify(clone), "utf8") > MAX_BYTES) invalid();
    return clone;
  } catch { invalid(); }
}

function onlyKeys(value, keys) {
  if (!object(value) || Object.keys(value).some((key) => !keys.has(key))) invalid();
}

function strings(value, { unique = false, nonempty = false } = {}) {
  if (!Array.isArray(value) || (nonempty && !value.length)) invalid();
  for (let index = 0; index < value.length; index++) if (typeof value[index] !== "string") invalid();
  if (unique && new Set(value).size !== value.length) invalid();
}

function bounds(schema, minimum, maximum, integer = false) {
  for (const name of [minimum, maximum]) {
    if (own(schema, name) && (typeof schema[name] !== "number" || !Number.isFinite(schema[name]) || (integer && (!Number.isSafeInteger(schema[name]) || schema[name] < 0)))) invalid();
  }
  if (own(schema, minimum) && own(schema, maximum) && schema[minimum] > schema[maximum]) invalid();
}

function options(value) {
  if (!Array.isArray(value) || !value.length) invalid();
  const values = [];
  for (const option of value) {
    onlyKeys(option, new Set(["const", "title"]));
    if (typeof option.const !== "string" || typeof option.title !== "string") invalid();
    values.push(option.const);
  }
  if (new Set(values).size !== values.length) invalid();
}

function fieldSchema(field) {
  if (!object(field)) invalid();
  for (const key of ["title", "description"]) if (own(field, key) && typeof field[key] !== "string") invalid();
  if (field.type === "string") {
    if (own(field, "enum")) {
      onlyKeys(field, new Set([...ANNOTATIONS, "enum", "enumNames"]));
      strings(field.enum, { unique: true, nonempty: true });
      if (own(field, "enumNames")) {
        strings(field.enumNames);
        if (field.enumNames.length !== field.enum.length) invalid();
      }
    } else if (own(field, "oneOf")) {
      onlyKeys(field, new Set([...ANNOTATIONS, "oneOf"]));
      options(field.oneOf);
    } else {
      onlyKeys(field, new Set([...ANNOTATIONS, "minLength", "maxLength", "format"]));
      bounds(field, "minLength", "maxLength", true);
      if (own(field, "format") && !FORMATS.has(field.format)) invalid();
    }
  } else if (field.type === "number" || field.type === "integer") {
    onlyKeys(field, new Set([...ANNOTATIONS, "minimum", "maximum"]));
    bounds(field, "minimum", "maximum");
  } else if (field.type === "boolean") {
    onlyKeys(field, new Set(ANNOTATIONS));
  } else if (field.type === "array") {
    onlyKeys(field, new Set([...ANNOTATIONS, "minItems", "maxItems", "items"]));
    bounds(field, "minItems", "maxItems", true);
    if (!object(field.items)) invalid();
    if (own(field.items, "enum")) {
      onlyKeys(field.items, new Set(["type", "enum"]));
      if (field.items.type !== "string") invalid();
      strings(field.items.enum, { unique: true, nonempty: true });
    } else {
      onlyKeys(field.items, new Set(["anyOf"]));
      options(field.items.anyOf);
    }
  } else invalid();
  if (own(field, "default")) validateField(field, field.default);
}

function genericField(field) {
  const plain = structuredClone(field);
  // These are MCP presentation/format annotations. Formats are checked below.
  delete plain.format;
  delete plain.enumNames;
  return plain;
}

function validDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}

function validDateTime(value) {
  const match = /^(\d{4}-\d{2}-\d{2})[tT](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?([zZ]|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match || !validDate(match[1])) return false;
  const hour = Number(match[2]), minute = Number(match[3]), second = Number(match[4]);
  if (hour > 23 || minute > 59 || second > 60 || Number(match[7] || 0) > 23 || Number(match[8] || 0) > 59) return false;
  if (second < 60) return true;
  // RFC 3339 leap seconds are at 23:59 UTC on a June/December boundary;
  // account for the stated offset before checking the calendar boundary.
  const instant = new Date(`${match[1]}T${match[2]}:${match[3]}:59${match[5].toUpperCase()}`);
  return instant.getUTCHours() === 23 && instant.getUTCMinutes() === 59
    && ((instant.getUTCMonth() === 5 && instant.getUTCDate() === 30) || (instant.getUTCMonth() === 11 && instant.getUTCDate() === 31));
}

function validEmail(value) {
  if (value.length > 254 || /[^\x20-\x7e]/.test(value)) return false;
  const at = value.lastIndexOf("@");
  if (at < 1) return false;
  const local = value.slice(0, at), domain = value.slice(at + 1);
  if (local.length > 64 || !domain || domain.length > 253) return false;
  const dotAtom = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
  const quoted = /^"(?:[\x20-\x21\x23-\x5b\x5d-\x7e]|\\[\x20-\x7e])*"$/;
  if (!dotAtom.test(local) && !quoted.test(local)) return false;
  if (domain.startsWith("[") && domain.endsWith("]")) {
    const address = domain.slice(1, -1);
    return address.startsWith("IPv6:") ? isIP(address.slice(5)) === 6 : isIP(address) === 4;
  }
  return domain.split(".").every((label) => label.length > 0 && label.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label));
}

function validUri(value) {
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) || /[^\x21-\x7e]|[<>"{}|\\^`]/.test(value) || /%(?![0-9A-Fa-f]{2})/.test(value)) return false;
  try { new URL(value); return true; } catch { return false; }
}

function validateField(field, value) {
  if (!validateOutputSchema(genericField(field), value).valid) invalid();
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > MAX_STRING_BYTES) invalid();
    if (field.format && !({ email: validEmail, uri: validUri, date: validDate, "date-time": validDateTime })[field.format]?.(value)) invalid();
  }
  if (Array.isArray(value) && value.some((item) => typeof item !== "string" || Buffer.byteLength(item, "utf8") > MAX_STRING_BYTES)) invalid();
}

/** Validate the exact supported MCP form subset and return an isolated copy. */
export function validateElicitationSchema(schema) {
  try {
    const normalized = detachedJson(schema);
    onlyKeys(normalized, FORM_KEYS);
    if (normalized.type !== "object" || !object(normalized.properties)) invalid();
    if (own(normalized, "$schema") && normalized.$schema !== "https://json-schema.org/draft/2020-12/schema") invalid();
    if (Object.keys(normalized.properties).length > MAX_FIELDS) invalid();
    if (own(normalized, "required")) {
      strings(normalized.required, { unique: true });
      if (normalized.required.some((name) => !own(normalized.properties, name))) invalid();
    }
    for (const field of Object.values(normalized.properties)) fieldSchema(field);
    return normalized;
  } catch { invalid(); }
}

/** Validate submitted values without applying defaults or exposing field data. */
export function validateElicitationResponse(schema, content) {
  try {
    const normalized = validateElicitationSchema(schema);
    const result = detachedJson(content);
    if (!object(result)) invalid();
    const generic = {
      ...normalized,
      properties: Object.fromEntries(Object.entries(normalized.properties).map(([name, field]) => [name, genericField(field)])),
      additionalProperties: false
    };
    if (!validateOutputSchema(generic, result).valid) invalid();
    for (const [name, value] of Object.entries(result)) validateField(normalized.properties[name], value);
    return result;
  } catch { invalid(); }
}
