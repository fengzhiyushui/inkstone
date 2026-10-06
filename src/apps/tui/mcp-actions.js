import { formatMcpLogEntry } from "../cli/mcp-logs.js";

export function parseMcpArgs(arg = "") {
  const parts = String(arg).trim().split(/\s+/).filter(Boolean);
  const [action = "list", serverId, rawLimit] = parts;
  const validId = (value) => typeof value === "string" && /^[a-zA-Z0-9_.-]+$/.test(value);
  if (action === "list" && parts.length <= 1) return { action };
  if (["restart", "disable", "enable"].includes(action) && parts.length === 2 && validId(serverId)) return { action, serverId };
  if (action === "logs" && parts.length <= 3 && (serverId === undefined || validId(serverId))) {
    const limit = rawLimit === undefined ? 50 : /^\d+$/.test(rawLimit) ? Number(rawLimit) : NaN;
    if (Number.isInteger(limit) && limit >= 1 && limit <= 500) return { action, serverId: serverId || null, limit };
  }
  return { action: "invalid" };
}

export function mcpText(value) {
  return String(value ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
}

export function formatMcpServerLines(servers, t, clean = (value) => value) {
  if (!Array.isArray(servers) || !servers.length) return [` ${t("msg.mcpEmpty")}`];
  return servers.map((server) => ` ${[
    server.serverId, server.status || "UNKNOWN", server.type, server.protocolMode,
    `${server.toolCount ?? 0} ${t("msg.mcpTools")}`,
    server.authStatus?.status === "pending" ? t("msg.mcpAuthPending") : ""
  ].filter(Boolean).map((value) => mcpText(clean(value))).join(" · ")}`);
}

export function formatMcpLogLines(result, t) {
  const errors = result?.storageError ? [` ${t("msg.mcpLogStorageError")}: ${mcpText(result.storageError)}`] : [];
  if (!result?.entries?.length) return [...errors, ` ${t("msg.mcpLogsEmpty")}`];
  return [
    ...errors,
    ` ${t("msg.mcpLogCount", { count: result.entries.length, total: result.total ?? result.entries.length })}${result.truncated ? ` · ${t("msg.mcpTruncated")}` : ""}`,
    ...result.entries.map((entry) => ` ${formatMcpLogEntry(entry)}`)
  ];
}
