// Main-process OAuth boundary. Authorization URLs and credentials never cross IPC.
const AUTH_STATUSES = new Set(["disabled", "unauthenticated", "pending", "authenticated", "error"]);

function safeAuthorizationUrl(value) {
  if (typeof value !== "string" || value.length > 16384) throw new Error("Invalid OAuth authorization URL");
  let url;
  try { url = new URL(value); } catch { throw new Error("Invalid OAuth authorization URL"); }
  const localHttp = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((!localHttp && url.protocol !== "https:") || url.username || url.password || url.hash) {
    throw new Error("Unsafe OAuth authorization URL");
  }
  return url.href;
}

function publicAuthStatus(value) {
  if (!value || !AUTH_STATUSES.has(value.status)) return { status: "error" };
  const result = { status: value.status };
  // Do not copy arbitrary messages or extra properties from a provider response.
  if (typeof value.issuer === "string") {
    try {
      const issuer = new URL(safeAuthorizationUrl(value.issuer));
      if (!issuer.search) result.issuer = issuer.href;
    } catch { /* Invalid issuer strings are not renderer content. */ }
  }
  if (typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt)) result.expiresAt = value.expiresAt;
  else if (typeof value.expiresAt === "string" && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value.expiresAt) && Number.isFinite(Date.parse(value.expiresAt))) {
    result.expiresAt = value.expiresAt;
  }
  return result;
}

async function callMcpAuth(facade, method, serverId, openAuthorization) {
  if (typeof serverId !== "string" || !/^[a-zA-Z0-9_.-]{1,128}$/.test(serverId) || typeof facade?.[method] !== "function") {
    throw new Error("MCP OAuth is unavailable");
  }
  try {
    const result = await facade[method](serverId);
    if (method === "startAuth") {
      if (result?.status === "pending") {
        try {
          if (typeof openAuthorization !== "function") throw new Error("Browser unavailable");
          await openAuthorization(safeAuthorizationUrl(result.authorizationUrl));
        } catch {
          await facade.cancelAuth?.(serverId);
          throw new Error("Unable to open the OAuth sign-in page");
        }
      }
      return publicAuthStatus(result);
    }
    if (method === "cancelAuth" || method === "logoutAuth") return publicAuthStatus(await facade.getAuthStatus(serverId));
    return publicAuthStatus(result);
  } catch {
    // Error strings can include tokens, authorization codes or provider responses.
    throw new Error("MCP OAuth operation failed");
  }
}

module.exports = { safeAuthorizationUrl, publicAuthStatus, callMcpAuth };
