import { createMcpDisplayRedactor } from "../../security/mcp-content.js";

const FILTERS = ["level", "category", "method", "search"];
const LEVELS = new Set(["debug", "info", "warn", "error"]);
const CATEGORIES = new Set(["transport", "protocol", "auth", "permission", "timeout", "cancelled", "tool", "lifecycle"]);

export function parseMcpLogsArgs(args, flags = new Map()) {
  const [, serverId = null] = args;
  if (args.length > 2 || (serverId !== null && !/^[a-zA-Z0-9_.-]+$/.test(serverId))) {
    throw new Error("用法：inkstone mcp logs [server] [--limit 1–500] [--level <level>] [--category <category>] [--method <method>] [--search <text>] [--json]");
  }
  for (const key of flags.keys()) {
    if (!["limit", "json", ...FILTERS].includes(key)) throw new Error(`mcp logs 不支持 --${key}。`);
  }
  const rawLimit = flags.get("limit");
  const limit = rawLimit === undefined ? 50 : typeof rawLimit === "string" && /^\d+$/.test(rawLimit) ? Number(rawLimit) : NaN;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("--limit 必须是 1–500 之间的整数。");
  const options = { limit };
  for (const key of FILTERS) {
    if (!flags.has(key)) continue;
    const value = flags.get(key);
    if (typeof value !== "string" || !value.trim() || value.length > 500 || /[\x00-\x1f\x7f]/.test(value)) {
      throw new Error(`--${key} 需要一个非空文本值（最多 500 字符）。`);
    }
    options[key] = value.trim();
  }
  if (options.level && !LEVELS.has(options.level)) throw new Error(`--level 必须是 ${[...LEVELS].join("、")}。`);
  if (options.category && !CATEGORIES.has(options.category)) throw new Error(`--category 必须是 ${[...CATEGORIES].join("、")}。`);
  const jsonFlag = flags.get("json");
  if (jsonFlag !== undefined && jsonFlag !== true && jsonFlag !== "true" && jsonFlag !== "false") {
    throw new Error("--json 是布尔选项，请使用 --json 或 --json=false。");
  }
  return { serverId, options, json: jsonFlag === true || jsonFlag === "true" };
}

function field(value) {
  return String(value ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
}

export function formatMcpLogEntry(entry = {}) {
  const duration = Number.isFinite(entry.durationMs) ? `${entry.durationMs}ms` : "";
  const message = entry.message || (typeof entry.preview === "string" ? entry.preview : entry.preview ? JSON.stringify(entry.preview) : "");
  return [entry.timestamp, entry.serverId, entry.level, entry.category || entry.kind,
    entry.method, entry.requestId != null ? `#${entry.requestId}` : "", entry.status, duration, message].map(field).filter(Boolean).join(" · ");
}

export function cleanMcpLogResult(result, clean) {
  return {
    entries: Array.isArray(result?.entries) ? result.entries.map((entry) => Object.fromEntries(
      Object.entries(entry || {}).map(([key, value]) => [key, clean(value)])
    )) : [],
    total: Number.isFinite(result?.total) ? result.total : 0,
    truncated: result?.truncated === true,
    ...(result?.storageError ? { storageError: clean(String(result.storageError)) } : {})
  };
}

// Read the persisted diagnostic store without connecting any configured server.
export async function runMcpLogs(root, args, flags, {
  createKernelImpl, buildKernelOptionsImpl, loadConfigImpl, write = console.log
}) {
  const { serverId, options, json } = parseMcpLogsArgs(args, flags);
  const config = await loadConfigImpl(root, { allowMissingKey: true });
  let clean = createMcpDisplayRedactor({ config });
  let kernel;
  try {
    kernel = await createKernelImpl(root, { ...(await buildKernelOptionsImpl(root)), autoInitMcp: false });
    clean = createMcpDisplayRedactor({ config, hub: kernel.mcp?.hub });
    if (typeof kernel.mcp?.getLogs !== "function") throw new Error("MCP 日志接口不可用。");
    const result = cleanMcpLogResult(await kernel.mcp.getLogs(serverId, options), clean);
    if (!json && result.storageError) write(`MCP 日志存储错误：${field(result.storageError)}`);
    if (json) write(JSON.stringify(result, null, 2));
    else if (!result?.entries?.length) write("没有匹配的 MCP 历史日志。日志由实际的服务连接或调用产生。");
    else {
      write(`MCP 历史日志${serverId ? ` (${serverId})` : ""}：显示 ${result.entries.length} / ${result.total ?? result.entries.length} 条${result.truncated ? "（已截断）" : ""}`);
      for (const entry of result.entries) write(formatMcpLogEntry(entry));
    }
    return result;
  } catch (error) {
    throw new Error(clean(error?.message || String(error)));
  } finally {
    await kernel?.dispose?.();
  }
}
