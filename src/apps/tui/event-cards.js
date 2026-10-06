// src/apps/tui/event-cards.js — kernel 事件 → 已着色卡片行。纯函数;负载全部防御式读取。
// user:message / agent:final / agent:error 静默:用户行与终态行由 app 从 send() 结果路径打印,避免重复。
import { tc as color } from "./theme.js";
import { describeEvent } from "../event-contract.js";
import { mcpText } from "./mcp-actions.js";

export const QUIET = new Set([
  "model:request", "model:response", "agent:step", "agent:turn_started",
  "user:message", "agent:final", "agent:error",
  "context:cache_loaded", "context:cache_reused", "context:cache_saved",
  "context:snapshot", "context:warm", "context:pin", "context:unpin"
]);

function clip(value, max = 48) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function fileRows(files) {
  const entries = Array.isArray(files) ? files : [];
  return entries.map((e) => {
    const status = e.status || "M";
    const path = e.path || "?";
    const counts = [
      Number.isFinite(e.added) ? color.green(`+${e.added}`) : "",
      Number.isFinite(e.removed) ? color.red(`−${e.removed}`) : ""
    ].filter(Boolean).join(" ");
    return ` ${color.dim("│")} ${status} ${path}${counts ? ` ${counts}` : ""}`;
  });
}

export function eventToLines(event = {}, t, clean = (value) => value) {
  const type = event.type || "";
  const f = describeEvent(event).fields;
  if (type.startsWith("mcp:")) {
    const descriptor = describeEvent(event);
    if (descriptor.quiet) return [];
    const parts = ["mcp", f.serverId, f.status || type.slice(4), f.toolName, f.method,
      f.requestId != null ? `#${f.requestId}` : "",
      f.durationMs != null ? `${f.durationMs}ms` : "", f.protocolMode,
      f.toolCount != null ? `${f.toolCount} ${t("msg.mcpTools")}` : "",
      f.notificationCount != null ? `${f.notificationCount} notifications` : "",
      f.progress != null ? `${f.progress}${f.total != null ? `/${f.total}` : ""}` : "",
      f.message].filter((value) => value !== null && value !== undefined && value !== "").map((value) => mcpText(clean(value)));
    const paint = descriptor.severity === "danger" ? color.red : descriptor.severity === "warn" ? color.yellow : color.dim;
    return [` ${paint(`· ${parts.join(" · ")}`)}`];
  }
  if (type === "tool:call") {
    const name = f.name || "?";
    const hint = f.argHint ? clip(f.argHint) : "";
    return [` ${color.dim("┌")} tool ▸ ${color.bold(name)}${hint ? ` ${color.dim(hint)}` : ""}`];
  }
  if (type === "tool:result") {
    const status = f.status || "?";
    const mark = status === "ok" ? color.green(t("ev.toolOk")) : color.red(String(status));
    return [` ${color.dim("└")} ${mark}`];
  }
  if (type === "approval:requested") {
    const summary = clip(event.approval?.summary || event.approval?.id || "", 100);
    return [
      ` ${color.yellow("┌─ " + t("ev.approvalTitle") + " ─")}`,
      ` ${color.yellow("│")} ${summary}`
    ];
  }
  if (type === "approval:resolved") {
    return [` ${color.dim(`· approval ${event.decision || event.approval?.decision || ""}`)}`];
  }
  if (type === "file:diff_preview") {
    return [` ${color.dim(`· diff preview ${clip(event.summary_text || event.diff_hash || "")}`)}`];
  }
  if (type === "file:diff_applied") {
    return [
      ` ${color.dim("┌─")} diff · ${color.cyan(f.changeId || "?")}`,
      ...fileRows(f.files),
      ` ${color.dim("└─")}`
    ];
  }
  if (type === "file:rollback_applied") {
    return [` ${color.yellow(`↺ ${t("ev.rollback")} ${f.changeId || ""}`)}`];
  }
  if (type === "verification:result") {
    return [` ${color.dim(`· ${t("ev.verify")} ${f.status || "?"}`)}`];
  }
  if (type.startsWith("repair:")) {
    return [` ${color.dim(`· ${t("ev.repair")} ${type.slice("repair:".length)}`)}`];
  }
  if (type === "orchestration:route_resolved") {
    return [` ${color.dim(`· ${t("ev.route")} ▸ ${f.lane || ""}`)}`];
  }
  if (type === "orchestration:subtask_started") {
    const f = describeEvent(event).fields;
    const prof = f.toolProfile ? color.dim(` (${f.toolProfile})`) : "";
    return [` ${color.dim(`· ${t("ev.subtaskStart")} ${f.subtaskId || "?"}`)}${prof}`];
  }
  if (type === "orchestration:subtask_reviewed") {
    const f = describeEvent(event).fields;
    const verdict = f.pass ? color.green(t("ev.reviewPass")) : color.red(t("ev.reviewFail"));
    return [` ${color.dim(`· ${t("ev.subtaskReview")} ${f.subtaskId || "?"} `)}${verdict}`];
  }
  if (type.startsWith("orchestration:")) {
    return [` ${color.dim(`· orch ▸ ${type.slice("orchestration:".length)}`)}`];
  }
  if (type === "recovery:report") {
    const found = event.found_count ?? 0;
    const done = event.done_count ?? 0;
    const blocked = event.blocked_count ?? 0;
    return [` ${color.dim(`· ${t("ev.recovery")} found ${found} done ${done} blocked ${blocked}`)}`];
  }
  if (type === "recovery:blocked") {
    return [` ${color.yellow(`· ${t("ev.recovery")} blocked ${event.reason || ""} ${event.item_id || event.source_id || ""}`.trimEnd())}`];
  }
  return [` ${color.dim(`· ${type || "event"}`)}`];
}
