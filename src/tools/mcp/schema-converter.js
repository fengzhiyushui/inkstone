import { redactSecrets } from "../../security/redactor.js";
import { validateOutputSchema } from "./output-schema.js";

export function sanitizeIdentifier(str) {
  if (!str || typeof str !== "string") return "unknown";
  return str.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function shortHash(str) {
  // FNV-1a 32-bit → base36, stable and dependency-free
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(7, "0").slice(-8);
}

export const MAX_TOOL_NAME_LENGTH = 128;

/**
 * `mcp__<serverId>__<toolName>` with collision-safe overflow handling.
 * Spec tool names: 1–128 chars of [A-Za-z0-9_.-].
 */
export function formatExternalToolName(serverId, originalName) {
  const cleanServer = sanitizeIdentifier(serverId);
  const cleanName = sanitizeIdentifier(originalName);
  const result = `mcp__${cleanServer}__${cleanName}`;
  if (result.length <= MAX_TOOL_NAME_LENGTH) {
    return result;
  }
  // Stable unique fallback: readable prefix + hash of full name
  const hash = shortHash(result);
  const prefix = result.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1);
  return `${prefix}_${hash}`;
}

export function parseExternalToolName(namespacedName) {
  if (typeof namespacedName !== "string" || !namespacedName.startsWith("mcp__")) {
    return null;
  }
  const parts = namespacedName.split("__");
  if (parts.length < 3) {
    return null;
  }
  const serverId = parts[1];
  const originalName = parts.slice(2).join("__");
  return { serverId, originalName };
}

export function cleanJsonSchema(inputSchema) {
  if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema)) {
    return {
      type: "object",
      properties: {}
    };
  }

  const { $schema, additionalProperties, ...rest } = inputSchema;
  const properties = {};

  if (rest.properties && typeof rest.properties === "object" && !Array.isArray(rest.properties)) {
    for (const [key, prop] of Object.entries(rest.properties)) {
      if (prop && typeof prop === "object") {
        const { $schema: _, ...cleanProp } = prop;
        properties[key] = cleanProp;
      } else {
        properties[key] = prop;
      }
    }
  }

  return {
    type: "object",
    properties,
    ...(Array.isArray(rest.required) ? { required: rest.required } : {}),
    ...(rest.description ? { description: rest.description } : {})
  };
}

export function inferCategory(name = "", description = "") {
  const text = `${name} ${description}`.toLowerCase();
  const writeKeywords = [
    "create",
    "write",
    "delete",
    "remove",
    "update",
    "insert",
    "drop",
    "mutate",
    "modify",
    "execute",
    "exec",
    "send",
    "post",
    "put",
    "patch"
  ];

  for (const kw of writeKeywords) {
    if (text.includes(kw)) {
      return "mutate";
    }
  }
  return "read";
}

export function formatToolResult(callResult) {
  if (callResult?.resultType === "input_required") return "[MCP Input Required] Additional user input is required; elicitation must be explicitly enabled.";
  if (!callResult) {
    return "";
  }

  if (typeof callResult === "string") {
    return callResult;
  }

  const isError = Boolean(callResult.isError);
  // Modern results carry resultType; absent means complete (legacy servers)
  const resultType = callResult.resultType || "complete";
  let outputText = "";

  if (Array.isArray(callResult.content)) {
    const textPieces = [];
    for (const item of callResult.content) {
      if (item && item.type === "text" && typeof item.text === "string") {
        textPieces.push(item.text);
      } else if (item && item.type === "resource_link" && item.uri) {
        textPieces.push(`[resource_link] ${item.uri}`);
      } else if (item && item.type === "resource" && item.resource) {
        textPieces.push(JSON.stringify(item.resource));
      } else if (item) {
        textPieces.push(JSON.stringify(item));
      }
    }
    outputText = textPieces.join("\n");
  } else if (callResult.text) {
    outputText = String(callResult.text);
  } else {
    outputText = JSON.stringify(callResult);
  }

  // Prefer structuredContent serialization when text is empty
  if (!outputText && callResult.structuredContent !== undefined) {
    try {
      outputText = JSON.stringify(callResult.structuredContent);
    } catch {
      outputText = String(callResult.structuredContent);
    }
  }

  if (resultType === "input_required") {
    return `[MCP Input Required] ${outputText}`;
  }

  if (isError) {
    return `[MCP Error] ${outputText}`;
  }
  return outputText;
}

/** Attach structured payload metadata for agent/GUI without bloating text. */
export function summarizeToolResult(callResult) {
  const text = formatToolResult(callResult);
  const meta = {
    isError: Boolean(callResult?.isError),
    resultType: callResult?.resultType || "complete"
  };
  if (callResult?.structuredContent !== undefined) {
    meta.structuredContent = callResult.structuredContent;
  }
  return { text, meta };
}

/** Copy JSON metadata while redacting secret fields and token-like strings. */
export function redactStructuredContent(value) {
  let nodes = 0;
  let bytes = 0;
  const ancestors = new Set();
  const secretKey = /^(?:authorization|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret|token)$/i;
  function visit(item, depth = 0) {
    if (++nodes > 20_000 || depth > 64 || bytes > 1_048_576) throw new Error("MCP structuredContent exceeds safety limits");
    if (typeof item === "string") {
      bytes += item.length * 3;
      if (bytes > 1_048_576) throw new Error("MCP structuredContent exceeds safety limits");
      return redactSecrets(item);
    }
    if (item === null || typeof item === "boolean" || typeof item === "number" && Number.isFinite(item)) return item;
    if (!item || typeof item !== "object" || ancestors.has(item)) throw new Error("MCP structuredContent must be acyclic JSON");
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error("MCP structuredContent must be JSON");
    ancestors.add(item);
    const entries = [];
    for (const key of Object.keys(item)) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new Error("MCP structuredContent accessors are unsupported");
      bytes += key.length * 3;
      entries.push([key, secretKey.test(key) ? "[REDACTED]" : visit(descriptor.value, depth + 1)]);
    }
    ancestors.delete(item);
    return Array.isArray(item) ? entries.map(([, child]) => child) : Object.fromEntries(entries);
  }
  return visit(value);
}

/** Adapter for ToolExecutor's object contract; public callTool stays textual. */
export function toToolExecutionResult(callResult, { outputSchema, redact = (value) => value } = {}) {
  const isError = Boolean(callResult?.isError);
  const resultType = callResult?.resultType || "complete";
  const metadata = { isError, resultType: redact(redactSecrets(resultType)) };
  let validation;
  if (!isError && resultType === "complete" && outputSchema !== undefined) {
    validation = validateOutputSchema(outputSchema, callResult?.structuredContent);
    metadata.outputValidation = redact(redactStructuredContent(validation));
  }
  try {
    if (callResult?.structuredContent !== undefined) metadata.structuredContent = redact(redactStructuredContent(callResult.structuredContent), { inputContent: true });
  } catch {
    return { status: "error", content: [{ type: "error", text: "MCP structuredContent could not be safely retained" }], metadata: { ...metadata, errorCode: "MCP_OUTPUT_CONTENT_INVALID" } };
  }
  if (validation && !validation.valid) {
    metadata.errorCode = validation.errors[0].code;
    return { status: "error", content: [{ type: "error", text: redact(redactSecrets(`MCP outputSchema validation failed: ${validation.errors[0].message} (${validation.errors[0].path})`)) }], metadata };
  }
  if (resultType !== "complete") {
    metadata.errorCode = resultType === "input_required" ? "MCP_INPUT_REQUIRED" : "MCP_RESULT_TYPE_UNSUPPORTED";
    return { status: "error", content: [{ type: "error", text: redact(redactSecrets(formatToolResult(callResult))) }], metadata };
  }
  const text = redact(redactSecrets(formatToolResult(callResult)));
  return { status: isError ? "error" : "success", content: [{ type: isError ? "error" : "text", text }], metadata };
}

export function mcpToolToDeepSeekSchema(serverId, mcpTool) {
  const namespacedName = formatExternalToolName(serverId, mcpTool.name);
  const parameters = cleanJsonSchema(mcpTool.inputSchema);
  const desc = `[MCP: ${serverId}] ${mcpTool.description || mcpTool.name}`.trim();

  return {
    type: "function",
    function: {
      name: namespacedName,
      description: desc,
      parameters
    }
  };
}
