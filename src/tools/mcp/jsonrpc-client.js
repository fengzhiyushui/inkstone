import { EventEmitter } from "node:events";

export const JSONRPC_ERRORS = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  TIMEOUT: -32000,
  SERVER_DISCONNECTED: -32001,
  CANCELLED: -32800
});

export class JsonRpcClient extends EventEmitter {
  constructor({ transport = null, defaultTimeoutMs = 60000 } = {}) {
    super();
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.pendingRequests = new Map();
    this._idCounter = 0;
    this.transport = null;
    this._onTransportMessage = this.handleMessage.bind(this);
    this._onTransportClose = this._handleTransportClose.bind(this);
    this._onTransportError = this._handleTransportError.bind(this);

    if (transport) {
      this.setTransport(transport);
    }
  }

  setTransport(transport) {
    if (this.transport === transport) return;
    if (this.pendingRequests.size) {
      const error = Object.assign(new Error("JSON-RPC transport replaced"), { code: JSONRPC_ERRORS.SERVER_DISCONNECTED });
      this._rejectPending(error);
    }
    if (this.transport) {
      this.transport.removeListener("message", this._onTransportMessage);
      this.transport.removeListener("close", this._onTransportClose);
      this.transport.removeListener("error", this._onTransportError);
    }
    this.transport = transport;
    if (transport) {
      transport.on("message", this._onTransportMessage);
      transport.on("close", this._onTransportClose);
      transport.on("error", this._onTransportError);
    }
  }

  nextId() {
    this._idCounter += 1;
    return this._idCounter;
  }

  getPendingCount() {
    return this.pendingRequests.size;
  }

  /**
   * @param {string} method
   * @param {object} [params]
   * @param {{ timeoutMs?: number, meta?: object, cancelOnTimeout?: boolean, signal?: AbortSignal }} [opts]
   */
  async request(method, params, { timeoutMs, meta, cancelOnTimeout = true, signal, onRequestId, subscription = false } = {}) {
    if (!this.transport) {
      throw new Error("No transport configured for JSON-RPC client");
    }

    const id = this.nextId();
    const effectiveTimeoutMs = timeoutMs ?? this.defaultTimeoutMs;

    let finalParams = params;
    if (meta && typeof meta === "object") {
      finalParams = {
        ...(params && typeof params === "object" ? params : {}),
        _meta: {
          ...(params && typeof params === "object" && params._meta ? params._meta : {}),
          ...meta
        }
      };
    }

    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      ...(finalParams !== undefined ? { params: finalParams } : {})
    };

    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, timer: null, method, signal, onAbort: null, startedAt: performance.now(), transport: this.transport, sent: false };
      this.pendingRequests.set(id, pending);
      const cancel = (error, status, notify) => {
        if (!this._settle(id, status, undefined, error)) return;
        try { pending.transport.cancelRequest?.(id, error); } catch { /* best-effort */ }
        if (notify && pending.sent && pending.transport.cancellationNotifications !== false) {
          try {
            this._send(pending.transport, {
              jsonrpc: "2.0", method: "notifications/cancelled",
              params: { requestId: id, reason: status === "timeout" ? "timeout" : "cancelled" }
            });
          } catch { /* best-effort */ }
        }
      };
      pending.cancel = cancel;
      pending.onAbort = () => {
        const timedOut = signal.reason?.code === "TOOL_TIMEOUT" || signal.reason?.code === JSONRPC_ERRORS.TIMEOUT;
        const status = timedOut ? "timeout" : "cancelled";
        cancel(Object.assign(new Error(`JSON-RPC request ${timedOut ? "timed out" : "cancelled"}: ${method}${signal.reason?.message ? ` (${signal.reason.message})` : ""}`, { cause: signal.reason }), {
          name: timedOut ? "TimeoutError" : "AbortError", code: timedOut ? JSONRPC_ERRORS.TIMEOUT : JSONRPC_ERRORS.CANCELLED, requestId: id
        }), status, !timedOut || cancelOnTimeout);
      };
      if (signal?.aborted) { pending.onAbort(); return; }
      signal?.addEventListener("abort", pending.onAbort, { once: true });
      if (effectiveTimeoutMs > 0 && effectiveTimeoutMs !== Infinity) {
        pending.timer = setTimeout(() => {
          const err = new Error(`JSON-RPC request timed out after ${effectiveTimeoutMs}ms: ${method}`);
          err.code = JSONRPC_ERRORS.TIMEOUT;
          err.requestId = id;
          cancel(err, "timeout", cancelOnTimeout);
        }, effectiveTimeoutMs);
        if (typeof pending.timer.unref === "function") {
          pending.timer.unref();
        }
      }
      try {
        onRequestId?.(id);
        if (!this.pendingRequests.has(id)) return;
        pending.sent = true;
        this._send(pending.transport, payload, { timeoutMs: effectiveTimeoutMs, ...(subscription ? { subscription: true, retries: 0 } : {}) });
      } catch (err) {
        this._settle(id, "error", undefined, err);
      }
    });
  }

  cancelRequest(id, error = Object.assign(new Error("JSON-RPC request cancelled"), { code: JSONRPC_ERRORS.CANCELLED }), { notify = false } = {}) {
    const pending = this.pendingRequests.get(id);
    if (!pending) return false;
    pending.cancel(error, completionStatus(error), notify);
    return true;
  }

  _send(transport, frame, opts) {
    this.emit("trace", { direction: "out", frame });
    transport.send(frame, opts);
  }

  _settle(id, status, result, error) {
    const pending = this.pendingRequests.get(id);
    if (!pending) return false;
    this.pendingRequests.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    pending.signal?.removeEventListener("abort", pending.onAbort);
    this.emit("request_completed", {
      requestId: id, method: pending.method,
      durationMs: Math.max(0, performance.now() - pending.startedAt), status,
      ...(error ? { error } : {})
    });
    if (error) pending.reject(error);
    else pending.resolve(result);
    return true;
  }

  notify(method, params) {
    if (!this.transport) {
      throw new Error("No transport configured for JSON-RPC client");
    }

    const payload = {
      jsonrpc: "2.0",
      method,
      ...(params !== undefined ? { params } : {})
    };

    this._send(this.transport, payload);
  }

  handleMessage(message) {
    if (!message || typeof message !== "object") {
      return;
    }
    this.emit("trace", { direction: "in", frame: message });

    // Response to a request
    if (message.id !== undefined && message.id !== null) {
      const pending = this.pendingRequests.get(message.id);
      if (pending && !message.method) {
        if (message.error) {
          const err = new Error(message.error.message || "JSON-RPC error");
          err.code = message.error.code;
          err.data = message.error.data;
          this._settle(message.id, completionStatus(err), undefined, err);
        } else {
          this._settle(message.id, "success", message.result);
        }
        return;
      }

      // If id is present and method is present, it's a server-initiated request to client
      if (message.method) {
        this.emit("request", message);
        return;
      }

      // Unknown response id - ignore or log
      return;
    }

    // Notification (no id)
    if (message.method) {
      this.emit("notification", message);
      this.emit(`notification:${message.method}`, message.params);
    }
  }

  _handleTransportClose(info) {
    this.close(new Error(`JSON-RPC transport closed (code: ${info?.code}, signal: ${info?.signal})`));
  }

  _handleTransportError(err) {
    // HTTP errors have no JSON-RPC response. Settle the failed request now so
    // an OAuth challenge reaches callers instead of being masked by a timeout.
    for (const id of this.pendingRequests.keys()) {
      if (err?.requestId !== undefined && err.requestId !== id) continue;
      this._settle(id, completionStatus(err), undefined, err);
    }
    if (this.listenerCount("error")) this.emit("error", err);
  }

  close(error = null) {
    const err = error || new Error("JSON-RPC client closed");
    if (!err.code) {
      err.code = JSONRPC_ERRORS.SERVER_DISCONNECTED;
    }

    this._rejectPending(err);

    if (this.transport) {
      this.transport.removeListener("message", this._onTransportMessage);
      this.transport.removeListener("close", this._onTransportClose);
      this.transport.removeListener("error", this._onTransportError);
      this.transport = null;
    }

    this.emit("close");
  }

  _rejectPending(error) {
    for (const [id, pending] of this.pendingRequests) {
      this._settle(id, completionStatus(error), undefined, error);
      try { pending.transport.cancelRequest?.(id, error); } catch { /* best-effort */ }
    }
  }
}

function completionStatus(error) {
  if (error?.code === JSONRPC_ERRORS.CANCELLED || error?.name === "AbortError") return "cancelled";
  if (error?.code === JSONRPC_ERRORS.TIMEOUT || error?.code === "ETIMEDOUT") return "timeout";
  return "error";
}
