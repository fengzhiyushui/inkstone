const object = (value) => value && typeof value === "object" && !Array.isArray(value);

export function checkedInputRequests(value) {
  if (!Array.isArray(value) || value.some((item) => !object(item) || typeof item.requestId !== "string"
    || typeof item.serverId !== "string" || typeof item.message !== "string" || !object(item.requestedSchema))) {
    throw new Error("Invalid MCP input requests response");
  }
  return value;
}

export function subscribeMcpInputChanges(api, onChanged) {
  if (typeof api?.onKernelEvent !== "function") return () => {};
  return api.onKernelEvent((event) => {
    if (["mcp:input_required", "mcp:input_resolved"].includes(event?.type)) onChanged();
  });
}

export function subscribeMcpSubscriptionChanges(api, onChanged) {
  if (typeof api?.onKernelEvent !== "function") return () => {};
  return api.onKernelEvent((event) => {
    if (event?.type === "mcp:subscription_status") onChanged();
  });
}

// Form values live only in the component. The controller stores safe pending
// descriptors and status, never response content or errors supplied by a server.
export function createMcpInputController({ kernel, onState }) {
  let disposed = false;
  let generation = 0;
  let state = { requests: [], busyId: null, error: false };
  const emit = (patch) => { state = { ...state, ...patch }; if (!disposed) onState(state); };
  async function refresh() {
    if (disposed) return;
    const current = ++generation;
    try {
      const requests = checkedInputRequests(await kernel.listMcpInputRequests());
      if (!disposed && current === generation) emit({ requests, error: false });
    } catch {
      if (!disposed && current === generation) emit({ error: true });
    }
  }
  const unsubscribe = kernel.subscribeMcpInputChanges?.(() => { void refresh(); });
  return {
    refresh,
    async respond(requestId, action, content) {
      if (disposed || state.busyId || !state.requests.some((item) => item.requestId === requestId)
        || !["accept", "decline", "cancel"].includes(action)) return false;
      emit({ busyId: requestId, error: false });
      generation++;
      try {
        const result = await kernel.respondMcpInputRequest(requestId, { action, ...(action === "accept" ? { content } : {}) });
        if (!result || result.error || result.status === "error") throw new Error("failed");
        if (disposed) return false;
        generation++;
        emit({ requests: state.requests.filter((item) => item.requestId !== requestId), busyId: null });
        await refresh();
        return true;
      } catch {
        if (!disposed) { emit({ busyId: null, error: true }); }
        return false;
      }
    },
    dispose() { disposed = true; generation++; if (typeof unsubscribe === "function") unsubscribe(); }
  };
}
