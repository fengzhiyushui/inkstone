/**
 * MCP protocol constants for dual-era (Modern 2026-07-28 + Legacy initialize).
 */

/** Prefer Modern; fall back to newest widely-deployed Legacy. */
export const MODERN_PROTOCOL_VERSION = "2026-07-28";
export const LEGACY_PROTOCOL_VERSION = "2025-11-25";
/** v1.11.0 baseline — still accepted for older servers. */
export const BASELINE_PROTOCOL_VERSION = "2024-11-05";

export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([
  MODERN_PROTOCOL_VERSION,
  LEGACY_PROTOCOL_VERSION,
  "2025-06-18",
  "2025-03-26",
  BASELINE_PROTOCOL_VERSION
]);

export const PROTOCOL_MODE = Object.freeze({
  MODERN: "modern",
  LEGACY: "legacy",
  UNKNOWN: "unknown"
});

export const JSONRPC_SPEC_ERRORS = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603
});

/** MCP-reserved server error range (2026-07-28). */
export const MCP_SERVER_ERRORS = Object.freeze({
  HEADER_MISMATCH: -32020,
  MISSING_REQUIRED_CLIENT_CAPABILITY: -32021,
  UNSUPPORTED_PROTOCOL_VERSION: -32022
});

export const META_KEYS = Object.freeze({
  PROTOCOL_VERSION: "io.modelcontextprotocol/protocolVersion",
  CLIENT_INFO: "io.modelcontextprotocol/clientInfo",
  CLIENT_CAPABILITIES: "io.modelcontextprotocol/clientCapabilities",
  SERVER_INFO: "io.modelcontextprotocol/serverInfo",
  LOG_LEVEL: "io.modelcontextprotocol/logLevel",
  SUBSCRIPTION_ID: "io.modelcontextprotocol/subscriptionId"
});

// Tools, resources and prompts are server capabilities, not client capabilities.
// Elicitation is advertised per client only when its explicit consent handler exists.
export const DEFAULT_CLIENT_CAPABILITIES = Object.freeze({});

export const MRTR_METHODS = Object.freeze(["tools/call", "resources/read", "prompts/get"]);
export const MRTR_MAX_ROUNDS = 4;

export function isUnsupportedProtocolVersionError(err) {
  if (!err) return false;
  // -32000..-32019 are implementation-defined and cannot identify an era.
  return err.code === MCP_SERVER_ERRORS.UNSUPPORTED_PROTOCOL_VERSION;
}

export function isModernProbeError(err) {
  if (!err) return false;
  if (isUnsupportedProtocolVersionError(err)) return true;
  // Recognized modern error codes identify a modern server
  return (
    err.code === MCP_SERVER_ERRORS.HEADER_MISMATCH ||
    err.code === MCP_SERVER_ERRORS.MISSING_REQUIRED_CLIENT_CAPABILITY
  );
}

export function pickMutualVersion(supported, preferred = SUPPORTED_PROTOCOL_VERSIONS) {
  if (!Array.isArray(supported) || supported.length === 0) {
    return preferred[0];
  }
  for (const v of preferred) {
    if (supported.includes(v)) return v;
  }
  // Server listed something we know but not first in our preference
  for (const v of supported) {
    if (preferred.includes(v)) return v;
  }
  return null;
}
