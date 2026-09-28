export function sanitizeIdentifier(str) {
  if (!str || typeof str !== "string") return "unknown";
  return str.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function formatExternalToolName(serverId, originalName) {
  const cleanServer = sanitizeIdentifier(serverId);
  const cleanName = sanitizeIdentifier(originalName);
  const result = `mcp__${cleanServer}__${cleanName}`;
  if (result.length > 64) {
    return result.slice(0, 64);
  }
  return result;
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
  if (!callResult) {
    return "";
  }

  if (typeof callResult === "string") {
    return callResult;
  }

  const isError = Boolean(callResult.isError);
  let outputText = "";

  if (Array.isArray(callResult.content)) {
    const textPieces = [];
    for (const item of callResult.content) {
      if (item && item.type === "text" && typeof item.text === "string") {
        textPieces.push(item.text);
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

  if (isError) {
    return `[MCP Error] ${outputText}`;
  }
  return outputText;
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
