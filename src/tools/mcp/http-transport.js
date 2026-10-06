import { EventEmitter } from "node:events";
import { HttpRedirectError } from "./http-client.js";
import { SseParser, isEventStream } from "./sse.js";
import { oauthHttpRequest } from "./oauth-http.js";
import { META_KEYS, MODERN_PROTOCOL_VERSION } from "./protocol.js";

/**
 * v1.12.0:Streamable HTTP 传输(protocol 2026-07-28 / 2025-11-25)。
 *
 * 语义要点:
 *  - 每条 JSON-RPC 消息一个 POST;`Accept: application/json, text/event-stream`。
 *  - 响应可能是 `application/json`(单一响应)或 `text/event-stream`(请求级 SSE,
 *    一个 POST 可回收多条消息)。
 *  - 通知(无 id)通常回 202/204,不解析 body。
 *  - **断流语义**不依赖 Last-Event-ID:流中断时按 `retryOnStreamBreak` 重发
 *    in-flight 请求(全新 HTTP 请求 = 服务端不会命中"旧请求"状态)。
 *
 * 安全:所有出站请求经 http-client.js 的 DNS 固定 + 逐跳 SSRF 校验。
 */
export const TRANSPORT_STATE = Object.freeze({
  IDLE: "idle",
  RUNNING: "running",
  STOPPING: "stopping",
  STOPPED: "stopped",
  ERROR: "error"
});

function methodOf(message) {
  if (!message || typeof message !== "object") return null;
  if (typeof message.method === "string") return message.method;
  if (message.id !== undefined && message.id !== null) return "response";
  return null;
}

function toolNameOf(message) {
  const params = message?.params;
  if (!params || typeof params !== "object") return null;
  return typeof params.name === "string" ? params.name : null;
}

export class HttpTransport extends EventEmitter {
  constructor({
    url,
    headers = {},
    timeoutMs = 60000,
    protocolVersion = null,
    sessionId = null,
    allowlist = [],
    lookup,
    maxRedirects,
    maxBodyBytes,
    retryOnStreamBreak = 1,
    oauth = null
  } = {}) {
    super();
    if (!url || typeof url !== "string") {
      throw new Error("HttpTransport: 'url' is required");
    }
    new URL(url); // 早失败:非法 URL 在构造期就抛

    this.url = url;
    this.headers = { ...headers };
    this.timeoutMs = timeoutMs;
    this.protocolVersion = protocolVersion;
    this.sessionId = sessionId;
    this.allowlist = Array.isArray(allowlist) ? [...allowlist] : [];
    this.lookup = lookup;
    this.maxRedirects = maxRedirects;
    this.maxBodyBytes = maxBodyBytes;
    this.retryOnStreamBreak = retryOnStreamBreak;
    this.oauth = oauth;
    /** 传输是否支持"断流重发" —— JsonRpcClient 据此决定是否重试。 */
    this.supportsRetry = retryOnStreamBreak > 0;

    this.state = TRANSPORT_STATE.IDLE;
    this.lastError = null;
    this._controllers = new Set();
    this._requestControllers = new Map();
    this._cancelledControllers = new WeakSet();
  }

  /** 协商完成/握手后由 McpClient 回填,用于请求头。 */
  setProtocolVersion(version) {
    this.protocolVersion = version || null;
  }

  get cancellationNotifications() {
    return this.protocolVersion !== MODERN_PROTOCOL_VERSION;
  }

  setSessionId(sessionId) {
    this.sessionId = sessionId || null;
  }

  getRecentStderr() {
    return "";
  }

  start() {
    if (this.state === TRANSPORT_STATE.RUNNING) return;
    this.state = TRANSPORT_STATE.RUNNING;
    this.lastError = null;
    this.emit("connected", { url: this.url });
  }

  send(message, { retries = this.retryOnStreamBreak, timeoutMs, subscription = false } = {}) {
    if (this.state === TRANSPORT_STATE.STOPPED || this.state === TRANSPORT_STATE.STOPPING) {
      throw new Error(`HttpTransport: cannot send message while state is '${this.state}'`);
    }
    // 不阻塞调用方:JsonRpcClient.send 是同步契约,响应经 'message' 事件回流。
    const controller = new AbortController();
    const effectiveTimeout = timeoutMs ?? this.timeoutMs;
    this._controllers.add(controller);
    if (message?.id != null) this._requestControllers.set(message.id, controller);
    const timer = effectiveTimeout > 0 && effectiveTimeout !== Infinity
      ? setTimeout(() => controller.abort(Object.assign(new Error(`HTTP transport timeout after ${effectiveTimeout}ms`), { code: -32000 })), effectiveTimeout)
      : null;
    timer?.unref?.();
    const clearTimer = () => { if (timer) clearTimeout(timer); };
    controller.signal.addEventListener("abort", clearTimer, { once: true });
    this._dispatch(message, { retries: subscription ? 0 : retries, timeoutMs: effectiveTimeout, controller, subscription }).catch((err) => {
      // Explicit cancellation and close are local control flow. Never surface
      // them as a broken server or retry an aborted operation.
      if (this._cancelledControllers.has(controller) || (controller.signal.aborted && controller.signal.reason?.code !== -32000)) return;
      if (controller.signal.aborted) err = controller.signal.reason;
      if (message?.id !== undefined) err.requestId = message.id;
      this.lastError = err;
      this.emit("error", err);
    }).finally(() => {
      clearTimer();
      controller.signal.removeEventListener("abort", clearTimer);
      this._controllers.delete(controller);
      if (this._requestControllers.get(message?.id) === controller) this._requestControllers.delete(message.id);
    });
  }

  cancelRequest(id, reason = new Error("HTTP request cancelled")) {
    const controller = this._requestControllers.get(id);
    if (!controller) return false;
    this._requestControllers.delete(id);
    this._controllers.delete(controller);
    this._cancelledControllers.add(controller);
    controller.abort(reason);
    return true;
  }

  async _dispatch(message, { retries, timeoutMs, controller, subscription }) {
    const isNotification = message?.id === undefined || message?.id === null;
    let attempt = 0;
    for (;;) {
      try {
        controller.signal.throwIfAborted();
        await this._postOnce(message, { timeoutMs, controller, subscription });
        return;
      } catch (err) {
        if (controller.signal.aborted) throw controller.signal.reason;
        const retryable = !isNotification && attempt < retries && isStreamBreak(err);
        if (!retryable) {
          if (isNotification) return; // 通知失败不致命(服务端可能未实现)
          throw err;
        }
        attempt += 1;
        this.emit("retry", { attempt, method: methodOf(message), url: this.url });
        // 新 id 重发由调用方(JsonRpcClient)决定;这里只重发同一帧,
        // 但因为是全新 HTTP 请求,服务端不会命中旧的流状态。
      }
    }
  }

  async _postOnce(message, { timeoutMs, controller, subscription }) {
    const effectiveTimeout = timeoutMs ?? this.timeoutMs;

    const body = JSON.stringify(message);
    const method = methodOf(message);
    const toolName = toolNameOf(message);
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Content-Length": Buffer.byteLength(body),
      ...this.headers
    };
    if (this.protocolVersion) headers["MCP-Protocol-Version"] = this.protocolVersion;
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    if (method) headers["Mcp-Method"] = method;
    if (toolName) headers["Mcp-Name"] = toolName;

    const response = await oauthHttpRequest(
      this.url,
      { allowlist: this.allowlist, lookup: this.lookup, maxRedirects: this.maxRedirects },
      {
        method: "POST",
        headers,
        body,
        timeoutMs: effectiveTimeout,
        signal: controller.signal,
        stream: true,
        maxBodyBytes: this.maxBodyBytes
      },
      this.oauth
    );
    if (controller.signal.aborted) {
      response.stream?.destroy?.();
      controller.signal.throwIfAborted();
    }

    const sessionId = response.getHeader("mcp-session-id");
    if (sessionId && !this.sessionId) this.setSessionId(sessionId);

    if (response.status === 202 || response.status === 204) {
      response.stream.resume?.();
      if (subscription) throw Object.assign(new Error("MCP subscription requires an SSE response stream"), { code: "MCP_SUBSCRIPTION_STREAM" });
      return;
    }
    if (response.status >= 400) {
      if (this.oauth) {
        response.stream.destroy?.();
        throw httpError(response.status, "MCP request failed");
      }
      const detail = await readErrorBody(response);
      throw httpError(response.status, detail);
    }

    if (isEventStream(response.getHeader("content-type"))) {
      await this._consumeSse(response.stream, controller.signal, subscription ? message.id : undefined);
      return;
    }
    if (subscription) {
      response.stream.destroy?.();
      throw Object.assign(new Error("MCP subscription requires an SSE response stream"), { code: "MCP_SUBSCRIPTION_STREAM" });
    }
    await this._consumeJson(response.stream, response.getHeader("content-length"), controller.signal);
  }

  async _consumeJson(stream, contentLength, signal) {
    const chunks = [];
    await new Promise((resolve, reject) => {
      stream.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      stream.on("end", resolve);
      stream.on("error", reject);
    });
    signal?.throwIfAborted();
    const text = Buffer.concat(chunks).toString("utf8").trim();
    if (!text) {
      // 空 body:通知被接受,或服务端没有内容可回
      if (!contentLength || contentLength === "0") return;
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      const wrapped = new Error(`HttpTransport: invalid JSON response: ${err.message}`);
      wrapped.code = "MCP_HTTP_BAD_JSON";
      throw wrapped;
    }
    if (Array.isArray(parsed)) for (const item of parsed) this.emit("message", item);
    else this.emit("message", parsed);
  }

  async _consumeSse(stream, signal, subscriptionId) {
    let completed = false;
    let finishSubscription = null;
    const isSubscription = subscriptionId !== undefined;
    const parser = new SseParser({
      ...(isSubscription ? { maxEventBytes: 64 * 1024 } : {}),
      onEvent: ({ data }) => {
        if (!data || signal?.aborted) return;
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          if (isSubscription) throw Object.assign(new Error("MCP subscription received invalid JSON"), { code: "MCP_SUBSCRIPTION_FRAME" });
          // 单条事件解析失败不应中断整条流
          this.emit("protocol_error", { line: data, error: new Error("invalid SSE JSON") });
          return;
        }
        if (isSubscription) {
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw Object.assign(new Error("MCP subscription frame must be a JSON-RPC object"), { code: "MCP_SUBSCRIPTION_FRAME" });
          if (parsed.id !== undefined) {
            if (parsed.id !== subscriptionId || parsed.method) throw Object.assign(new Error("MCP subscription response ID mismatch"), { code: "MCP_SUBSCRIPTION_FRAME" });
            completed = true;
          } else if (parsed.params?._meta?.[META_KEYS.SUBSCRIPTION_ID] !== subscriptionId) {
            throw Object.assign(new Error("MCP subscription notification ID mismatch"), { code: "MCP_SUBSCRIPTION_FRAME" });
          }
          this.emit("message", parsed);
          if (completed) finishSubscription?.();
        } else if (Array.isArray(parsed)) for (const item of parsed) this.emit("message", item);
        else this.emit("message", parsed);
      }
    });
    stream.setEncoding?.("utf8");
    await new Promise((resolve, reject) => {
      finishSubscription = () => { resolve(); stream.destroy(); };
      stream.on("data", (chunk) => {
        try { parser.feed(String(chunk)); }
        catch (error) { reject(error); stream.destroy(); }
      });
      stream.on("end", () => {
        try {
          parser.end();
          if (isSubscription && !completed) throw Object.assign(new Error("MCP subscription stream ended without a completion result"), { code: "MCP_SUBSCRIPTION_CLOSED" });
          resolve();
        } catch (error) { reject(error); }
      });
      stream.on("error", (err) => {
        const wrapped = isStreamBreak(err)
          ? Object.assign(new Error(`HTTP SSE stream broke: ${err.message}`), { code: "MCP_STREAM_BREAK" })
          : err;
        reject(wrapped);
      });
      stream.on("aborted", () => {
        reject(Object.assign(new Error("HTTP SSE stream aborted"), { code: "MCP_STREAM_BREAK" }));
      });
    });
  }

  async close() {
    if (this.state === TRANSPORT_STATE.STOPPED) {
      this.state = TRANSPORT_STATE.STOPPED;
      return;
    }
    this.state = TRANSPORT_STATE.STOPPING;
    for (const controller of this._controllers) {
      try { controller.abort(new Error("HttpTransport closed")); } catch { /* best-effort */ }
    }
    this._controllers.clear();
    this._requestControllers.clear();
    this.state = TRANSPORT_STATE.STOPPED;
    this.emit("close", { code: 0, signal: null });
  }
}

function httpError(status, detail) {
  const err = new Error(`HTTP ${status}${detail ? `: ${detail}` : ""}`);
  err.code = status === 401 || status === 403 ? "MCP_HTTP_UNAUTHORIZED" : "MCP_HTTP_STATUS";
  err.status = status;
  return err;
}

async function readErrorBody(response) {
  try {
    const chunks = [];
    for await (const chunk of response.stream) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString("utf8").trim();
    return text.slice(0, 500);
  } catch {
    return "";
  }
}

/** 网络类中断(可重发)vs 协议/鉴权错误(不可重发)。 */
export function isStreamBreak(err) {
  if (!err) return false;
  if (err instanceof HttpRedirectError) return false;
  if (err.code === "MCP_STREAM_BREAK") return true;
  return ["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_SOCKET"]
    .includes(err.code);
}
