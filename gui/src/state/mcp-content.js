// MCP data remains quoted user content, never messages injected into model roles.
export const MCP_CONTENT_TABS = [
  { id: "resources", key: "resources", call: "listMcpResources" },
  { id: "templates", key: "resourceTemplates", call: "listMcpResourceTemplates" },
  { id: "prompts", key: "prompts", call: "listMcpPrompts" }
];
export const MCP_CONTENT_LIMITS = Object.freeze({ maxPages: 1, maxItems: 50, maxBytes: 65536 });

export function checkedMcpResult(result) {
  if (result?.error || result?.status === "ERROR") {
    throw new Error(typeof result.error === "string" ? result.error : result.error?.message || "MCP request failed");
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("MCP returned no result");
  const invalid = (field) => { throw new Error(`Invalid MCP response: ${field}`); };
  const object = (value) => value && typeof value === "object" && !Array.isArray(value);
  const optionalStrings = (value, fields, location) => {
    for (const field of fields) if (value[field] !== undefined && typeof value[field] !== "string") invalid(`${location}.${field}`);
  };
  for (const flag of ["supported", "truncated"]) if (result[flag] !== undefined && typeof result[flag] !== "boolean") invalid(flag);
  if (result.nextCursor != null && typeof result.nextCursor !== "string") invalid("nextCursor");
  for (const [key, required] of [["resources", "uri"], ["resourceTemplates", "uriTemplate"], ["prompts", "name"]]) {
    if (result[key] === undefined) continue;
    if (!Array.isArray(result[key])) invalid(key);
    for (const item of result[key]) {
      if (!object(item) || typeof item[required] !== "string" || !item[required]) invalid(`${key}.${required}`);
      optionalStrings(item, ["name", "title", "description", "mimeType"], key);
      if (key === "prompts" && item.arguments !== undefined) {
        if (!Array.isArray(item.arguments)) invalid("prompts.arguments");
        for (const arg of item.arguments) {
          if (!object(arg) || typeof arg.name !== "string" || !arg.name) invalid("prompts.arguments.name");
          optionalStrings(arg, ["description", "title"], "prompts.arguments");
          if (arg.required !== undefined && typeof arg.required !== "boolean") invalid("prompts.arguments.required");
        }
      }
    }
  }
  for (const key of ["contents", "messages"]) {
    if (result[key] !== undefined && (!Array.isArray(result[key]) || result[key].some((item) => !object(item)))) invalid(key);
  }
  for (const message of result.messages || []) optionalStrings(message, ["role"], "messages");
  return result;
}

export function groupMcpResources(resources = []) {
  const groups = new Map();
  for (const resource of resources) {
    if (!resource || typeof resource.uri !== "string") continue;
    const match = resource.uri.match(/^([a-z][a-z0-9+.-]*:\/\/[^/]*|[a-z][a-z0-9+.-]*:)/i);
    const group = match?.[1] || "/";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(resource);
  }
  return [...groups].map(([name, items]) => ({ name, items }));
}

function partText(part) {
  if (Array.isArray(part)) return part.map(partText).filter(Boolean).join("\n\n");
  if (!part || typeof part !== "object") return "";
  if (typeof part.text === "string") return part.text;
  if (part.resource) return partText(part.resource);
  return "";
}

export function mcpContentText(result) {
  if (Array.isArray(result?.contents)) return result.contents.map(partText).filter(Boolean).join("\n\n");
  if (Array.isArray(result?.messages)) return result.messages.map((message) => {
    const text = partText(message?.content);
    return text ? `[${message?.role || "message"}]\n${text}` : "";
  }).filter(Boolean).join("\n\n");
  return "";
}

export function quoteMcpContent(text, source, label) {
  if (!String(text || "").trim()) return "";
  return `${label} (${String(source).replace(/[\r\n]/g, " ")})\n` + String(text).split(/\r?\n/).map((line) => `> ${line}`).join("\n");
}

export function promptArguments(definition, values = {}) {
  const result = {};
  for (const arg of Array.isArray(definition?.arguments) ? definition.arguments : []) {
    if (typeof arg?.name !== "string") continue;
    const value = String(values[arg.name] ?? "");
    if (arg.required && !value.trim()) throw new Error(`${arg.name}: required`);
    if (value || arg.required) Object.defineProperty(result, arg.name, { value, enumerable: true, configurable: true });
  }
  return result;
}
