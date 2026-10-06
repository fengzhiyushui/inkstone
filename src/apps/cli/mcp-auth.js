import { setTimeout as delay } from "node:timers/promises";
import { createMcpDisplayRedactor } from "../../security/mcp-content.js";

const STATUS_LABELS = {
  disabled: "未启用 OAuth",
  unauthenticated: "尚未登录",
  pending: "等待浏览器授权",
  authenticated: "已登录",
  error: "登录失败"
};

function defaultOnSigint(handler) {
  process.on("SIGINT", handler);
  return () => process.off("SIGINT", handler);
}

function expiryTime(value) {
  return typeof value === "number" ? value : Date.parse(value);
}

function authorizationAddress(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("OAuth 授权地址无效。"); }
  const loopback = url.hostname === "localhost" || /^127\.\d+\.\d+\.\d+$/.test(url.hostname) || url.hostname === "[::1]";
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.hash) {
    throw new Error("OAuth 授权地址必须使用 HTTPS 或本机回环 HTTP。");
  }
  return url.href;
}

// Auth commands deliberately display a small status projection, never token records.
export async function runMcpAuth(root, args, flags, {
  createKernelImpl,
  buildKernelOptionsImpl,
  loadConfigImpl,
  write = console.log,
  onSigint = defaultOnSigint,
  sleep = (ms, signal) => delay(ms, undefined, { signal }),
  now = Date.now
}) {
  const [, serverId, action = "login"] = args;
  const usage = "inkstone mcp auth <server> [login|status|cancel|logout] [--timeout <毫秒>]";
  if (!serverId || !/^[a-zA-Z0-9_.-]+$/.test(serverId)
    || !["login", "status", "cancel", "logout"].includes(action) || args.length > 3) {
    throw new Error(`用法：${usage}`);
  }
  const timeoutMs = flags.has("timeout") && typeof flags.get("timeout") === "string"
    ? Number(flags.get("timeout")) : flags.has("timeout") ? NaN : 180000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) {
    throw new Error("--timeout 必须是 1000–600000 之间的毫秒数。");
  }
  const config = await loadConfigImpl(root, { allowMissingKey: true });
  const kernel = await createKernelImpl(root, { ...(await buildKernelOptionsImpl(root)), autoInitMcp: false });
  const clean = createMcpDisplayRedactor({ config, hub: kernel.mcp?.hub });
  const controller = new AbortController();
  let removeSigint = () => {};
  let started = false;
  let completed = false;
  const statusView = (status) => ({
    status: Object.hasOwn(STATUS_LABELS, status?.status) ? status.status : "error",
    ...(typeof status?.issuer === "string" ? { issuer: clean(status.issuer) } : {}),
    ...(Number.isFinite(expiryTime(status?.expiresAt))
      ? { expiresAt: new Date(expiryTime(status.expiresAt)).toISOString() } : {})
  });
  const displayStatus = (status) => {
    const safe = statusView(status);
    write(`${serverId}: ${STATUS_LABELS[safe.status]}`);
    if (safe.issuer) write(`授权服务器: ${safe.issuer}`);
    if (safe.expiresAt) write(`到期时间: ${safe.expiresAt}`);
    return safe;
  };
  try {
    const mcp = kernel.mcp;
    const method = { login: "startAuth", status: "getAuthStatus", cancel: "cancelAuth", logout: "logoutAuth" }[action];
    if (typeof mcp?.[method] !== "function") throw new Error("MCP OAuth 接口不可用。");
    if (action === "status") return displayStatus(await mcp.getAuthStatus(serverId));
    if (action === "cancel" || action === "logout") {
      await mcp[method](serverId);
      write(action === "logout" ? `${serverId}: 已退出登录并清除本地凭据。` : `${serverId}: 已取消当前登录。`);
      return { status: "unauthenticated" };
    }
    removeSigint = onSigint(() => controller.abort()) || removeSigint;
    started = true;
    const pending = await mcp.startAuth(serverId);
    if (controller.signal.aborted) throw new Error("已取消登录。");
    if (pending?.status === "authenticated") {
      completed = true;
      return displayStatus(pending);
    }
    if (pending?.status !== "pending" || typeof pending.authorizationUrl !== "string") {
      throw new Error("无法启动 OAuth 登录，请检查服务的 OAuth 配置。");
    }
    const authorizationUrl = authorizationAddress(pending.authorizationUrl);
    write(`请在浏览器中打开以下地址，完成 ${serverId} 的授权：`);
    // This explicit login handoff must preserve state and PKCE parameters. The
    // general display redactor deliberately removes state from ordinary output.
    write(authorizationUrl);
    write("正在等待授权回调；按 Ctrl+C 取消。请保持此命令运行。");
    const pendingExpiry = expiryTime(pending.expiresAt);
    const deadline = Math.min(now() + timeoutMs, Number.isFinite(pendingExpiry) ? pendingExpiry : Infinity);
    while (!controller.signal.aborted) {
      if (now() >= deadline) throw new Error("OAuth 登录超时，请重新运行登录命令。");
      const status = await mcp.getAuthStatus(serverId);
      if (controller.signal.aborted) break;
      if (status?.status === "authenticated") {
        completed = true;
        return displayStatus(status);
      }
      if (status?.status !== "pending") {
        throw new Error(status?.status === "error"
          ? clean(status.message || "OAuth 登录失败，请重新登录。")
          : "OAuth 登录已结束，尚未获得授权，请重新登录。");
      }
      await sleep(Math.min(500, Math.max(1, deadline - now())), controller.signal);
    }
    throw new Error("已取消登录。");
  } catch (error) {
    throw new Error(controller.signal.aborted ? "已取消登录。" : clean(error?.message || String(error)));
  } finally {
    removeSigint();
    if (started && !completed) await kernel.mcp?.cancelAuth?.(serverId).catch(() => {});
    await kernel.dispose?.();
  }
}
