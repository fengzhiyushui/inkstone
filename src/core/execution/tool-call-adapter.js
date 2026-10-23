import { createToolCall } from "../protocol/index.js";

export const TOOL_CALL_SYNTAX_ERROR_CODE = "TOOL_CALL_SYNTAX_ERROR";

export function createToolCallSyntaxError(message) {
  const error = new Error(message);
  error.code = TOOL_CALL_SYNTAX_ERROR_CODE;
  return error;
}

export function isToolCallSyntaxError(error) {
  return Boolean(error && error.code === TOOL_CALL_SYNTAX_ERROR_CODE);
}

export function adaptDeepSeekToolCall(rawCall, { requestedByStepId } = {}) {
  if (!requestedByStepId) throw new Error("requestedByStepId is required");
  if (!rawCall || typeof rawCall !== "object" || typeof rawCall.name !== "string" || !rawCall.name.trim()) {
    throw createToolCallSyntaxError("tool call name is required");
  }
  if (rawCall.arguments_parse_error) {
    throw createToolCallSyntaxError(`invalid tool arguments for ${rawCall.name}: ${rawCall.arguments_parse_error}`);
  }
  if (rawCall.arguments === null || Array.isArray(rawCall.arguments) || typeof rawCall.arguments !== "object") {
    throw createToolCallSyntaxError(`invalid tool arguments for ${rawCall.name}`);
  }
  return createToolCall({
    id: rawCall.id,
    name: rawCall.name,
    params: rawCall.arguments || {},
    source: "model",
    requestedByStepId
  });
}

export function adaptDeepSeekToolCalls(rawCalls = [], options = {}) {
  if (!Array.isArray(rawCalls)) {
    throw createToolCallSyntaxError("tool_calls must be an array");
  }
  const seenExplicitIds = new Set();
  return rawCalls.map((call) => {
    const adapted = adaptDeepSeekToolCall(call, options);
    if (typeof call?.id === "string" && call.id.length > 0) {
      if (seenExplicitIds.has(call.id)) {
        throw createToolCallSyntaxError(`duplicate tool call id in batch: ${call.id}`);
      }
      seenExplicitIds.add(call.id);
    }
    return adapted;
  });
}
