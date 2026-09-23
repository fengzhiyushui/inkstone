import { createToolResult, createApprovalRequest } from "../core/protocol/index.js";
import { redactToolContent } from "../security/redactor.js";

const ARGV_PREVIEW_LIMIT = 120;

function approvalSummary(name, params) {
  const argv = params?.argv;
  if (!Array.isArray(argv) || !argv.length) return `${name} requires approval`;
  const joined = argv.join(" ");
  const preview = joined.length > ARGV_PREVIEW_LIMIT ? `${joined.slice(0, ARGV_PREVIEW_LIMIT)}…` : joined;
  return `${name} requires approval: \`${preview}\``;
}

export function createToolExecutor({ registry, permissionEngine, eventBus = null, defaultToolTimeoutMs = null } = {}) {
  if (!registry) throw new Error("registry is required");
  if (!permissionEngine) throw new Error("permissionEngine is required");

  async function execute(toolCall, context = {}) {
    const started = Date.now();
    const def = registry.resolve(toolCall.name);
    if (!def) {
      return publishResult(createToolResult({
        callId: toolCall.id,
        status: "error",
        content: [{ type: "error", text: `Unknown tool: ${toolCall.name}` }],
        durationMs: 0
      }));
    }

    let securedCall;
    try {
      securedCall = registry.secureToolCall(toolCall);
    } catch (error) {
      return publishResult(createToolResult({
        callId: toolCall.id,
        status: "error",
        content: [{ type: "error", text: error.message }],
        durationMs: Date.now() - started
      }));
    }

    publish("tool:call", { call: securedCall, tool: publicTool(def) });

    const permission = permissionEngine.decide(securedCall, context);
    publish("permission:decision", { call_id: toolCall.id, tool: def.name, category: securedCall.category, permission });

    if (permission.decision === "deny") {
      return publishResult(createToolResult({
        callId: toolCall.id,
        status: "denied",
        content: [{ type: "error", text: `Permission denied: ${permission.matched_rule}` }],
        metadata: { permission },
        durationMs: Date.now() - started
      }));
    }

    if (permission.decision === "ask") {
      const approval = createApprovalRequest({
        turnId: context.turnId || "turn_unknown",
        kind: "tool",
        risk: def.risk_level,
        summary: approvalSummary(def.name, securedCall.params),
        detailsRef: toolCall.id
      });
      publish("approval:requested", { approval, call: securedCall });
      return publishResult(createToolResult({
        callId: toolCall.id,
        status: "approval_required",
        content: [{ type: "text", text: approval.summary }],
        metadata: { permission, approval },
        durationMs: Date.now() - started
      }));
    }

    try {
      const timeoutMs = context.toolTimeoutMs ?? defaultToolTimeoutMs;
      const raw = await runWithTimeout(
        ({ signal } = {}) => def.execute(securedCall.params, { ...context, ...(signal ? { signal } : {}) }),
        timeoutMs
      );
      return publishResult(createToolResult({
        callId: toolCall.id,
        status: raw.status || "success",
        content: redactToolContent(raw.content || []),
        metadata: raw.metadata || {},
        durationMs: Date.now() - started
      }));
    } catch (error) {
      return publishResult(createToolResult({
        callId: toolCall.id,
        status: "error",
        content: [{ type: "error", text: error.message }],
        metadata: error.code === "TOOL_TIMEOUT" ? { timeout: true } : {},
        durationMs: Date.now() - started
      }));
    }
  }

  function publish(type, data) {
    eventBus?.publish?.(type, data);
  }

  function publishResult(result) {
    publish("tool:result", { result });
    return result;
  }

  return { execute };
}

function publicTool(def) {
  const { execute, normalizeParams, resolveCategory, ...publicDef } = def;
  return publicDef;
}

function runWithTimeout(promiseFactory, timeoutMs) {
  if (!timeoutMs) return promiseFactory({});
  const ac = new AbortController();
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ac.abort(); } catch {}
      const err = new Error(`tool timed out after ${timeoutMs}ms`);
      err.code = "TOOL_TIMEOUT";
      reject(err);
    }, timeoutMs);
    Promise.resolve()
      .then(() => promiseFactory({ signal: ac.signal }))
      .then((value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } })
      .catch((error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
  });
}
