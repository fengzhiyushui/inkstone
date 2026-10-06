import { META_KEYS, PROTOCOL_MODE } from "./protocol.js";
import { JSONRPC_ERRORS } from "./jsonrpc-client.js";

const FILTER_METHODS = Object.freeze({
  "notifications/tools/list_changed": "toolsListChanged",
  "notifications/prompts/list_changed": "promptsListChanged",
  "notifications/resources/list_changed": "resourcesListChanged"
});

/** One opt-in subscription per connected client. No automatic HTTP retry loop. */
export class McpSubscriptions {
  constructor(client, { enabled = false, ackTimeoutMs = 10000 } = {}) {
    this.client = client;
    this.enabled = enabled === true;
    this.ackTimeoutMs = Math.max(10, Math.min(30000, Number(ackTimeoutMs) || 10000));
    this.current = null;
  }

  start() {
    if (!this.enabled || this.current || this.client.protocolMode !== PROTOCOL_MODE.MODERN) return;
    const notifications = {};
    for (const capability of ["tools", "prompts", "resources"]) {
      if (this.client.serverCapabilities[capability]?.listChanged === true) notifications[`${capability}ListChanged`] = true;
    }
    if (!Object.keys(notifications).length) return;
    const run = { id: null, notifications, acknowledged: null, controller: new AbortController(), timer: null, notificationCount: 0, status: "connecting" };
    this.current = run;
    this.emit(run, "connecting");
    run.timer = setTimeout(() => this.fail(run, "MCP subscription acknowledgment timed out"), this.ackTimeoutMs);
    run.timer.unref?.();
    run.promise = this.client._request("subscriptions/listen", { notifications }, {
      timeoutMs: Infinity, signal: run.controller.signal, subscription: true,
      onRequestId: (id) => { run.id = id; }
    }).then((result) => {
      if (this.current !== run) return;
      if (!run.acknowledged || result?._meta?.[META_KEYS.SUBSCRIPTION_ID] !== run.id) {
        this.fail(run, "MCP subscription closed with invalid correlation metadata");
        return;
      }
      this.finish(run, "closed");
    }, (error) => {
      if (this.current !== run) return;
      this.finish(run, error?.name === "AbortError" || error?.code === JSONRPC_ERRORS.CANCELLED ? "cancelled" : "error",
        error?.code === JSONRPC_ERRORS.CANCELLED ? undefined : "MCP subscription ended; restart the server to subscribe again");
    });
  }

  emit(run, status, message) {
    run.status = status;
    this.client.emit("subscription_status", { status, notificationCount: run.notificationCount, ...(message ? { message } : {}) });
  }

  finish(run, status, message) {
    clearTimeout(run.timer);
    if (this.current === run) this.current = null;
    this.emit(run, status, message);
  }

  fail(run, message) {
    if (this.current !== run) return;
    this.finish(run, "error", message);
    run.controller.abort(Object.assign(new Error(message), { code: JSONRPC_ERRORS.CANCELLED }));
  }

  stop() {
    const run = this.current;
    if (!run) return;
    this.finish(run, "cancelled");
    run.controller.abort(Object.assign(new Error("MCP subscription stopped"), { code: JSONRPC_ERRORS.CANCELLED }));
  }

  /** Untagged legacy notifications retain their existing behavior. Tagged
   * Modern notifications must match this live stream and its accepted filter. */
  accepts(message) {
    const run = this.current;
    const method = message?.method;
    if (method === "notifications/cancelled" && run && message.params?.requestId === run.id) {
      this.finish(run, "closed");
      this.client.rpc.cancelRequest(run.id);
      return false;
    }
    const id = message?.params?._meta?.[META_KEYS.SUBSCRIPTION_ID];
    if (id === undefined) {
      if (this.enabled && this.client.protocolMode === PROTOCOL_MODE.MODERN
        && (Object.hasOwn(FILTER_METHODS, method) || method === "notifications/resources/updated")) return false;
      return method !== "notifications/subscriptions/acknowledged";
    }
    if (!run || run.id !== id) return false;
    if (method === "notifications/subscriptions/acknowledged") {
      const filter = message.params?.notifications;
      if (run.acknowledged || !filter || typeof filter !== "object" || Array.isArray(filter)
        || Object.entries(filter).some(([key, value]) => !Object.hasOwn(run.notifications, key) || typeof value !== "boolean")) {
        this.fail(run, "MCP subscription acknowledgment contains an invalid filter");
        return false;
      }
      run.acknowledged = { ...filter };
      clearTimeout(run.timer);
      this.emit(run, "active");
      return false;
    }
    if (!run.acknowledged) {
      this.fail(run, "MCP subscription notification arrived before acknowledgment");
      return false;
    }
    if (!run.acknowledged[FILTER_METHODS[method]]) return false;
    run.notificationCount += 1;
    return true;
  }
}
