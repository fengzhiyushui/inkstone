import { describeEvent } from "../event-contract.js";
import { color } from "../../theme.js";

const QUIET_EVENTS = new Set(["model:request", "model:response", "agent:step", "agent:turn_started"]);

function plural(n, unit) {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

function orchestrationSummary(d) {
  const f = d.fields;
  switch (d.kind) {
    case "orchestration-route": {
      if (f.lane === "single") return "routing: single-agent";
      if (f.lane === "orchestrate" || !f.lane) return "routing: multi-agent";
      return `routing: ${f.lane}`;
    }
    case "orchestration-plan": return `plan: ${plural(f.subtasks ?? 0, "subtask")}`;
    case "orchestration-round-start": return `round ${f.round ?? 0}: ${plural(f.subtasks ?? 0, "subtask")}`;
    case "orchestration-replan": return `replan round ${f.round ?? 0}: ${plural(f.newSubtasks ?? 0, "new subtask")}`;
    case "orchestration-complete": return `orchestration complete: ${f.completed ?? 0} succeeded, ${f.failed ?? 0} failed (status: ${f.status ?? "unknown"})`;
    case "orchestration-subtask-start": {
      const attempt = `attempt ${f.attempt ?? 1}`;
      const parts = f.toolProfile ? `${attempt}, profile ${f.toolProfile}` : attempt;
      return `subtask ${f.subtaskId ?? "?"}: starting (${parts})`;
    }
    case "orchestration-subtask-review": {
      const verdict = f.pass ? "passed" : "failed";
      const sev = (!f.pass && f.reviewSeverity) ? ` (severity: ${f.reviewSeverity})` : "";
      return `subtask ${f.subtaskId ?? "?"}: review ${verdict}${sev}`;
    }
    default: return null;
  }
}

export function summarizeKernelEvent(event = {}) {
  const d = describeEvent(event);
  const orch = orchestrationSummary(d);
  if (orch) return orch;
  if (d.kind === "experience-retrieved") return `experience: ${d.fields.count ?? 0} recalled`;

  if (event.type === "user:message") return `user ${clip(event.content || "")}`;
  if (event.type === "tool:call") return `tool ${d.fields.name || "unknown"}`;
  if (event.type === "tool:result") return `tool result ${d.fields.status || "unknown"}`;
  if (event.type === "permission:decision") return `permission ${event.permission?.decision || event.decision || "unknown"}`;
  if (event.type === "approval:requested") return `approval ${event.approval?.id || "unknown"} ${clip(event.approval?.summary || "")}`.trim();
  if (event.type === "file:diff_preview") return `diff preview ${event.summary || event.diff_hash || ""}`.trim();
  if (event.type === "file:diff_applied") return `diff applied ${d.fields.changeId || ""}`.trim();
  if (event.type === "file:rollback_applied") return `rollback ${d.fields.changeId || ""}`.trim();
  if (event.type === "verification:result") return `verification ${d.fields.status || "unknown"}`;
  if (event.type === "agent:final") return `final ${clip(event.content || "")}`.trim();
  if (event.type === "agent:error") return `error ${clip(event.message || event.error || "")}`.trim();
  if (event.type === "session:branch_created") return `branch created ${event.branch_id || "unknown"}`;
  if (event.type === "session:branch_activated") return `branch active ${event.branch_id || "unknown"}`;
  if (event.type === "session:rewind_preview") return `rewind preview ${event.rollback_count || event.rollback_change_ids?.length || 0} changes`;
  if (event.type === "session:rewind_applied") return `rewind applied ${event.branch_id || "unknown"} ${(event.rollback_change_ids || []).length} changes`;
  if (event.type === "session:rewind_conflict") return `rewind conflict ${event.failed_change_id || "unknown"}`;
  if (event.type === "session:rewind_failed") return `rewind failed ${event.failed_change_id || event.reason || "unknown"}`;
  if (event.type === "session:rewind_restore_started") return `rewind restoring ${(event.applied_rollbacks || []).length} changes`;
  if (event.type === "session:rewind_restored") return `rewind restored ${(event.restored_files || []).length} files`;
  if (event.type === "session:rewind_recovery_failed") return `rewind recovery failed ${event.reason || event.restore_error || "unknown"}`;
  if (event.type === "recovery:report") return `recovery report: found ${event.found_count || 0}, done ${event.done_count || 0}, blocked ${event.blocked_count || 0}`;
  if (event.type === "recovery:blocked") return `recovery blocked: ${event.reason || "unknown"} (${event.item_id || event.source_id || "unknown"})`;
  if (event.type === "tx:recovered") return `recovered ${event.kind || "transaction"} ${event.tx_id || "unknown"}, preserved ${event.preserved_count || 0}`;
  if (event.type === "turn:rehydrated") return `rehydrated approval ${event.approval_id || "unknown"}`;
  if (event.type === "turn:cancelled") return `cancelled approval ${event.approval_id || "unknown"}`;
  if (event.type === "takeover:requested") return `takeover requested ${event.request_id || "unknown"}`;
  if (event.type === "takeover:completed") return `takeover completed ${event.request_id || "unknown"}`;
  return event.type || "event";
}

// v1.9 M4 #11:终局 usage 摘要。默认不输出,由 INKSTONE_SHOW_USAGE 环境变量门控
// ("0"/"false"/空即关,循仓内 env 开关的朴素真值风格)。数据口径 =
// usage-tracker.getUsageStats()(requests/total_*_tokens/cache_*/avg_latency_ms),
// 由调用方把 kernel.metrics.getUsage() 快照挂到 result.usage 上;
// 缺 usage 快照时不追加(没有数据不编造一行)。返回纯文本行,着色交给调用方
// (循 cli.js formatFimUsageSummary「不含 dim,由调用方着色」的约定)。
export function formatUsageLine(usage = {}) {
  const u = usage || {};
  const num = (v) => Number(v) || 0;
  const parts = [
    `tokens ${num(u.total_prompt_tokens)} prompt / ${num(u.total_completion_tokens)} completion`,
    `cache ${num(u.cache_hit_tokens)} hit / ${num(u.cache_miss_tokens)} miss`,
    `reasoning ${num(u.total_reasoning_tokens)} tok`,
    `avg latency ${num(u.avg_latency_ms)} ms`
  ];
  return `usage: ${parts.join(" · ")}`;
}

function usageSummaryEnabled() {
  const raw = process.env.INKSTONE_SHOW_USAGE;
  if (raw == null) return false;
  const value = String(raw).trim().toLowerCase();
  return value !== "" && value !== "0" && value !== "false";
}

export function renderKernelResult(result = {}) {
  if (result.status === "awaiting_approval") {
    return [
      "",
      `Approval required: ${result.approval?.id || "unknown"}`,
      "Approve? y/N"
    ];
  }
  if (result.status === "error") {
    return ["", `Error: ${result.error || result.message || "unknown error"}`];
  }
  const lines = ["", result.content || ""];
  // 终局 usage 摘要:显式开关 + usage 快照齐备才追加一行,默认输出零变化。
  if (usageSummaryEnabled() && result.usage) lines.push(formatUsageLine(result.usage));
  return lines;
}

export function createEventRenderer({ write = console.log } = {}) {
  return function renderEvent(event) {
    if (!event?.type || QUIET_EVENTS.has(event.type)) return;
    const line = summarizeKernelEvent(event);
    // experience:retrieved 在 count===0 时不打印(契约 quiet);其余照原行为。
    const d = describeEvent(event);
    if (d.kind === "experience-retrieved" && d.quiet) return;
    write(`- ${line}`);
  };
}

function clip(value, max = 120) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

const SENSITIVE_REASON_LABELS = Object.freeze({
  "sensitive.reason.secret": "secret file",
  "sensitive.reason.credential": "credential file",
  "sensitive.reason.other": "sensitive file"
});

// #9.3 敏感文件提醒的 CLI 呈现。刻意与 `renderKernelResult` 的审批提示**不同形**:
// 全红 + 明确写「这不是权限审批」,避免用户按审批的肌肉记忆一路 y 下去。
// 纯函数、返回行数组,便于测试;颜色经 theme.color(NO_COLOR / 非 TTY 自动降级)。
export function formatSensitiveNotice(descriptor) {
  if (!descriptor?.paths?.length) return [];
  const lines = [
    "",
    color.red(color.bold("!! SENSITIVE FILE WRITE -- this is NOT a permission prompt"))
  ];
  for (const item of descriptor.paths) {
    const label = SENSITIVE_REASON_LABELS[item.reasonKey] || SENSITIVE_REASON_LABELS["sensitive.reason.other"];
    lines.push(color.red(`   ${item.path}  (${label})`));
  }
  lines.push(color.red(`   The full contents of ${descriptor.count === 1 ? "this file" : "these files"} will be copied into`));
  lines.push(color.red(`   ${descriptor.recordDir}/ so the edit stays rollbackable.`));
  lines.push(color.red("   That record is NOT redacted -- rollback needs the exact bytes."));
  lines.push(color.red("   Allow this write? y/N"));
  return lines;
}
