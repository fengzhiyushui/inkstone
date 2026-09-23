// src/apps/event-contract.js — 共享事件展示契约(display contract)。
// 唯一语义源:内核事件 → 归一化展示描述符 { kind, sourceType, severity, quiet, fields }。
// 纯函数:无 I/O、无副作用、任意输入不抛错。表现层(CLI/TUI/GUI)只读描述符,不直接读 event.*。
// 明确边界:这不是 core 的事件生产契约(那由 src/sessions/event-types.js 负责),只做「已产出事件 → 展示语义」的单向映射。

const NOISY = new Set(["model:request", "model:response", "agent:step", "agent:turn_started"]);
const ARG_KEYS = ["path", "file", "pattern", "command", "query", "url", "argv"];
const ARG_HINT_LIMIT = 120;

function num(v) { return Number.isFinite(v) ? v : null; }
function str(v) { return typeof v === "string" && v.length ? v : null; }

function toolName(event) {
  return str(event.call?.name) || str(event.tool?.name) || str(event.tool) || null;
}
function argHint(event) {
  const args = event.call?.params ?? event.call?.args ?? event.call?.arguments ?? event.args;
  if (!args || typeof args !== "object") return null;
  for (const k of ARG_KEYS) {
    const v = args[k];
    if (Array.isArray(v)) {
      if (!v.length) continue;
      return clip(v.join(" "));
    }
    if (v) return clip(String(v));
  }
  return null;
}
function clip(s) {
  return s.length > ARG_HINT_LIMIT ? `${s.slice(0, ARG_HINT_LIMIT)}…` : s;
}
function changeId(event) {
  return str(event.change_id) || str(event.record?.id) || null;
}
function normFiles(event) {
  const raw = (Array.isArray(event.files) && event.files.length) ? event.files
    : (Array.isArray(event.summary) ? event.summary : []);
  return raw.map((e) => {
    if (typeof e === "string") return { status: "M", path: e, added: null, removed: null };
    return {
      status: str(e?.status) || "M",
      path: str(e?.path) || str(e?.file) || null,
      added: num(e?.added),
      removed: num(e?.removed)
    };
  });
}
function d(kind, sourceType, severity, quiet, fields) {
  return { kind, sourceType, severity, quiet, fields };
}

export function describeEvent(event) {
  if (!event || typeof event !== "object" || typeof event.type !== "string") {
    return d("other", "", "info", true, {});
  }
  const type = event.type;
  const src = type;

  // v1.8.0 推理摘要卡:model:response 仍为 quiet(两端静默语义不变),但给出可展示的用量描述符。
  if (type === "model:response") {
    return d("thought", src, "info", true, {
      purpose: str(event.purpose),
      model: str(event.model),
      channel: str(event.channel),
      toolCallCount: num(event.tool_call_count),
      completionTokens: num(event.usage?.completion_tokens),
      reasoningTokens: num(event.usage?.completion_tokens_details?.reasoning_tokens)
    });
  }
  if (NOISY.has(type)) return d("other", src, "info", true, {});
  if (type === "context:semantic_degraded") return d("context-degraded", src, "warn", false, { reason: str(event.reason) });
  if (type.startsWith("context:")) return d("context", src, "info", true, {});

  if (type === "user:message") return d("user", src, "info", true, { text: str(event.content) });
  if (type === "agent:final") return d("final", src, "success", true, { content: str(event.content) });
  if (type === "agent:error") return d("error", src, "danger", true, { message: str(event.message) || str(event.error) });

  if (type === "tool:call") return d("tool-call", src, "info", false, { name: toolName(event), argHint: argHint(event) });
  if (type === "tool:result") {
    const status = str(event.result?.status) || str(event.status);
    const isSuccess = status === "ok" || status === "success";
    const duration = num(event.result?.duration_ms) ?? num(event.result?.durationMs) ?? num(event.duration_ms) ?? num(event.durationMs);
    return d("tool-result", src, isSuccess ? "success" : "warn", false, { status, durationMs: duration });
  }
  if (type === "permission:decision") return d("permission", src, "info", false, { decision: str(event.permission?.decision) || str(event.decision) });
  if (type === "approval:requested") return d("approval", src, "warn", false, { id: str(event.approval?.id), summary: str(event.approval?.summary) });
  if (type === "approval:resolved") return d("approval-resolved", src, "info", false, { decision: str(event.decision) || str(event.approval?.decision) });

  if (type === "file:diff_preview") return d("diff-preview", src, "info", false, { summaryText: str(event.summary_text), diffHash: str(event.diff_hash), changeId: changeId(event), files: normFiles(event) });
  if (type === "file:diff_applied") return d("diff", src, "success", false, { changeId: changeId(event), files: normFiles(event) });
  if (type === "file:rollback_applied") return d("rollback", src, "warn", false, { changeId: changeId(event) });
  if (type === "verification:result") {
    const status = str(event.result?.status) || str(event.status);
    const pass = typeof event.pass === "boolean" ? event.pass
      : (status === "passed" || status === "pass") ? true
      : (status === "failed" || status === "fail" || status === "error") ? false
      : null;
    return d("verification", src, (status === "passed" || pass === true) ? "success" : "warn", false, { status, pass });
  }
  if (type.startsWith("repair:")) return d("repair", src, "info", false, { phase: type.slice("repair:".length) });

  if (type === "orchestration:routed") return d("orchestration-route", src, "info", false, { lane: str(event.lane), score: num(event.score) });
  if (type === "orchestration:route_resolved") return d("orchestration-route", src, "info", false, { lane: str(event.lane) || str(event.route), score: num(event.score) });
  if (type === "orchestration:planned") return d("orchestration-plan", src, "info", false, { subtasks: num(event.subtasks), doneWhen: str(event.done_when) });
  if (type === "orchestration:round_started") return d("orchestration-round-start", src, "info", false, { round: num(event.round), subtasks: num(event.subtasks) });
  if (type === "orchestration:subtask_started") return d("orchestration-subtask-start", src, "info", false, { subtaskId: str(event.subtask_id), attempt: num(event.attempt), toolProfile: str(event.tool_profile) });
  if (type === "orchestration:subtask_reviewed") return d("orchestration-subtask-review", src, event.pass ? "success" : "warn", false, { subtaskId: str(event.subtask_id), pass: Boolean(event.pass), reviewSeverity: str(event.severity) });
  if (type === "orchestration:replanned") return d("orchestration-replan", src, "info", false, { round: num(event.round), newSubtasks: num(event.new_subtasks) });
  if (type === "orchestration:completed") {
    const failed = num(event.failed) || 0;
    return d("orchestration-complete", src, failed > 0 ? "warn" : "success", false, { rounds: num(event.rounds), completed: num(event.completed), failed: num(event.failed), status: str(event.status) });
  }
  if (type.startsWith("orchestration:")) return d("other", src, "info", false, {});

  if (type === "experience:retrieved") {
    const count = num(event.count) || 0;
    return d("experience-retrieved", src, "info", count === 0, { count: num(event.count), tiers: Array.isArray(event.tiers) ? event.tiers : null });
  }

  if (type === "recovery:report") return d("recovery-report", src, "info", false, { found: num(event.found_count), done: num(event.done_count), blocked: num(event.blocked_count) });
  if (type === "recovery:blocked") return d("recovery-blocked", src, "warn", false, { reason: str(event.reason), itemId: str(event.item_id) || str(event.source_id) });

  if (type.startsWith("session:rewind_")) {
    const phase = type.slice("session:rewind_".length);
    const danger = phase === "conflict" || phase === "failed" || phase === "recovery_failed";
    const success = phase === "applied" || phase === "restored";
    return d("rewind", src, danger ? "danger" : (success ? "success" : "info"), false, {
      phase,
      branchId: str(event.branch_id),
      changeCount: num(event.rollback_count) ?? (Array.isArray(event.rollback_change_ids) ? event.rollback_change_ids.length : (Array.isArray(event.applied_rollbacks) ? event.applied_rollbacks.length : (Array.isArray(event.restored_files) ? event.restored_files.length : null))),
      failedChangeId: str(event.failed_change_id),
      reason: str(event.reason) || str(event.restore_error)
    });
  }
  if (type === "session:branch_created" || type === "session:branch_activated") return d("branch", src, "info", false, { branchId: str(event.branch_id) });
  if (type === "tx:recovered") return d("tx-recovered", src, "info", false, { kind: str(event.kind), txId: str(event.tx_id), preservedCount: num(event.preserved_count) });
  if (type === "turn:rehydrated" || type === "turn:cancelled") return d("turn", src, "info", false, { approvalId: str(event.approval_id) });
  if (type === "takeover:requested" || type === "takeover:completed") return d("takeover", src, "info", false, { requestId: str(event.request_id) });

  return d("other", src, "info", false, {});
}
