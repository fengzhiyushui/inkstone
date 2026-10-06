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
        detailsRef: toolCall.id,
        // v1.13.1:把风险等级带到审批请求上,三端据此决定是否提供
        // "本项目/永久" 这类持久放行(destructive 一律只允许逐次审批)。
        category: securedCall.category
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
        timeoutMs,
        context.signal
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

function runWithTimeout(promiseFactory, timeoutMs, signal) {
  const hasTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0;
  if (!hasTimeout && !signal) return promiseFactory({});
  const ac = new AbortController();
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (error, value, abort = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (abort) ac.abort(error);
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => {
      const error = signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason || "Tool execution cancelled"));
      finish(error, undefined, true);
    };
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener("abort", onAbort, { once: true });
    if (hasTimeout) {
      timer = setTimeout(() => {
        const error = Object.assign(new Error(`tool timed out after ${timeoutMs}ms`), { code: "TOOL_TIMEOUT" });
        finish(error, undefined, true);
      }, timeoutMs);
    }
    Promise.resolve()
      .then(() => { if (!settled) return promiseFactory({ signal: ac.signal }); })
      .then((value) => finish(null, value), (error) => finish(error));
  });
}
