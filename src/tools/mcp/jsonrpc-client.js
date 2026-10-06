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
   * @param {{ timeoutMs?: number, meta?: object, cancelOnTimeout?: boolean }} [opts]
   */
  async request(method, params, { timeoutMs, meta, cancelOnTimeout = true } = {}) {
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
      let timer = null;
      if (effectiveTimeoutMs > 0 && effectiveTimeoutMs !== Infinity) {
        timer = setTimeout(() => {
          this.pendingRequests.delete(id);
          if (cancelOnTimeout) {
            try {
              this.transport?.send({
                jsonrpc: "2.0",
                method: "notifications/cancelled",
                params: { requestId: id, reason: "timeout" }
              });
            } catch {
              /* best-effort */
            }
          }
          const err = new Error(`JSON-RPC request timed out after ${effectiveTimeoutMs}ms: ${method}`);
          err.code = JSONRPC_ERRORS.TIMEOUT;
          err.requestId = id;
          reject(err);
        }, effectiveTimeoutMs);
        if (typeof timer.unref === "function") {
          timer.unref();
        }
      }

      this.pendingRequests.set(id, { resolve, reject, timer, method });

      try {
        this.transport.send(payload);
      } catch (err) {
        if (timer) clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(err);
      }
    });
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

    this.transport.send(payload);
  }

  handleMessage(message) {
    if (!message || typeof message !== "object") {
      return;
    }

    // Response to a request
    if (message.id !== undefined && message.id !== null) {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        this.pendingRequests.delete(message.id);
        if (pending.timer) {
          clearTimeout(pending.timer);
        }

        if (message.error) {
          const err = new Error(message.error.message || "JSON-RPC error");
          err.code = message.error.code;
          err.data = message.error.data;
          pending.reject(err);
        } else {
          pending.resolve(message.result);
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
    for (const [id, pending] of this.pendingRequests) {
      if (err?.requestId !== undefined && err.requestId !== id) continue;
      if (pending.timer) clearTimeout(pending.timer);
      this.pendingRequests.delete(id);
      pending.reject(err);
    }
    if (this.listenerCount("error")) this.emit("error", err);
  }

  close(error = null) {
    const err = error || new Error("JSON-RPC client closed");
    if (!err.code) {
      err.code = JSONRPC_ERRORS.SERVER_DISCONNECTED;
    }

    for (const [id, pending] of this.pendingRequests.entries()) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pending.reject(err);
    }
    this.pendingRequests.clear();

    if (this.transport) {
      this.transport.removeListener("message", this._onTransportMessage);
      this.transport.removeListener("close", this._onTransportClose);
      this.transport.removeListener("error", this._onTransportError);
      this.transport = null;
    }

    this.emit("close");
  }
}
