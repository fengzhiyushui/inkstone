const STATUSES = new Set(["disabled", "unauthenticated", "pending", "authenticated", "error"]);

export function subscribeMcpAuthChanges(api, onChanged) {
  if (typeof api?.onKernelEvent !== "function") return () => {};
  return api.onKernelEvent((event) => {
    // The authenticated event follows server reconnection. It refreshes tools
    // even if an earlier status poll observed the token before reconnect ended.
    if (event?.type === "mcp:auth_required" || (event?.type === "mcp:auth_status" && event.status === "authenticated")) onChanged();
  });
}

export function checkedAuthStatus(result) {
  if (!result || result.error || !STATUSES.has(result.status)) throw new Error("MCP OAuth operation failed");
  return result;
}

export function buildMcpOAuthConfig(enabled, clientId = "", scopes = "", headers = {}) {
  if (!enabled) return {};
  if (Object.keys(headers).some((key) => key.toLowerCase() === "authorization")) throw new Error("authorization-header");
  const id = clientId.trim();
  const scopeList = [...new Set(scopes.split(/[,，\s]+/).filter(Boolean))];
  return { oauth: { enabled: true, ...(id ? { clientId: id } : {}), ...(scopeList.length ? { scopes: scopeList } : {}) } };
}

// Poll only while a browser authorization is pending. Generation checks prevent
// an old status response from overwriting cancellation, logout or a new login.
export function createMcpAuthController({ kernel, serverId, initialStatus, onState, onChanged = () => {},
  schedule = setTimeout, unschedule = clearTimeout, interval = 1000 }) {
  let disposed = false;
  let generation = 0;
  let timer = null;
  let status = typeof initialStatus === "string" ? initialStatus : initialStatus?.status || "unauthenticated";
  const clear = () => { if (timer !== null) unschedule(timer); timer = null; };
  async function run(method = "getMcpAuthStatus") {
    if (disposed) return;
    clear();
    const current = ++generation;
    const previous = status;
    const action = method !== "getMcpAuthStatus";
    if (action) onState({ status, busy: true });
    try {
      const value = checkedAuthStatus(await kernel[method](serverId));
      if (disposed || current !== generation) return;
      status = value.status;
      onState({ ...value, busy: false });
      if (status === "pending") timer = schedule(() => { void run(); }, interval);
      if ((previous === "pending" && status !== "pending") || method === "logoutMcpAuth") onChanged();
    } catch {
      if (disposed || current !== generation) return;
      status = "error";
      onState({ status, busy: false });
    }
  }
  return { refresh: () => run(), run, dispose: () => { disposed = true; generation++; clear(); } };
}
