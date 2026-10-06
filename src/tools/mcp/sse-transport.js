import { EventEmitter } from "node:events";
import { SseParser, isEventStream } from "./sse.js";
import { oauthHttpRequest } from "./oauth-http.js";

/**
 * v1.12.0:legacy HTTP+SSE 传输(protocol 2024-11-05 时代的 `type: "sse"`)。
 *
 * 与 Streamable HTTP 的差别:
 *  - 长连 `GET <url>` 接收事件(Content-Type: text/event-stream);
 *  - 服务端先推一个 `event: endpoint` 事件,给出 POST 用的地址;
 *  - 客户端把 JSON-RPC 帧 POST 到该 endpoint,响应回到同一条 GET 流。
 *
 * **已废弃**:为兼容存量 Server 保留。默认仍可用,但会在诊断里标注 deprecated;
 * 新配置应使用 `type: "streamable-http"`。
 */
export const LEGACY_SSE_DEPRECATION =
  "legacy HTTP+SSE transport is deprecated; prefer type 'streamable-http'";

export class SseTransport extends EventEmitter {
  constructor({
    url,
    headers = {},
    timeoutMs = 60000,
    protocolVersion = null,
    allowlist = [],
    lookup,
    maxRedirects,
    oauth = null
  } = {}) {
    super();
    if (!url || typeof url !== "string") throw new Error("SseTransport: 'url' is required");
    new URL(url);

    this.url = url;
    this.headers = { ...headers };
    this.timeoutMs = timeoutMs;
    this.protocolVersion = protocolVersion;
    this.allowlist = Array.isArray(allowlist) ? [...allowlist] : [];
    this.lookup = lookup;
    this.maxRedirects = maxRedirects;
    this.oauth = oauth;

    this.endpoint = null;
    this.state = "idle";
    this.lastError = null;
    this.deprecated = true;
    this.supportsRetry = false; // legacy 通道靠长连复用,不适用"断流重发"语义
    this._controller = null;
  }

  setProtocolVersion(version) {
    this.protocolVersion = version || null;
  }

  getRecentStderr() {
    return "";
  }

  /** 等待 endpoint 事件就绪(长连建立后服务端会推)。 */
  async waitForEndpoint(timeoutMs = 15000) {
    if (this.endpoint) return this.endpoint;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`SseTransport: endpoint event not received within ${timeoutMs}ms`));
      }, timeoutMs);
      if (timer.unref) timer.unref();
      const onEndpoint = (value) => { cleanup(); resolve(value); };
      const onClose = () => {
        cleanup();
        reject(new Error("SseTransport: stream closed before endpoint event"));
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.removeListener("endpoint", onEndpoint);
        this.removeListener("close", onClose);
      };
      this.once("endpoint", onEndpoint);
      this.once("close", onClose);
    });
  }

  start() {
    if (this.state === "running" || this.state === "starting") return;
    this.state = "starting";
    this.emit("deprecated", { reason: LEGACY_SSE_DEPRECATION });
    // 长连 GET:不阻塞 start();失败经 error 事件上报。
    this._openStream()
      .then(() => { this.state = "running"; this.emit("connected", { url: this.url, legacy: true }); })
      .catch((err) => {
        this.state = "error";
        this.lastError = err;
        this.emit("error", err);
      });
  }

  async _openStream() {
    const controller = new AbortController();
    this._controller = controller;
    const headers = {
      Accept: "text/event-stream",
      ...this.headers
    };
    if (this.protocolVersion) headers["MCP-Protocol-Version"] = this.protocolVersion;

    const response = await oauthHttpRequest(
      this.url,
      { allowlist: this.allowlist, lookup: this.lookup, maxRedirects: this.maxRedirects },
      { method: "GET", headers, timeoutMs: 0, signal: controller.signal, stream: true },
      this.oauth
    );

    if (response.status >= 400) {
      throw Object.assign(new Error(`HTTP ${response.status} opening SSE stream`), {
        code: "MCP_HTTP_STATUS",
        status: response.status
      });
    }
    if (!isEventStream(response.getHeader("content-type"))) {
      throw Object.assign(
        new Error(`expected text/event-stream, got ${response.getHeader("content-type")}`),
        { code: "MCP_HTTP_NOT_SSE" }
      );
    }

    const parser = new SseParser({
      onEvent: ({ data, event }) => {
        if (event === "endpoint") {
          this.endpoint = resolveEndpoint(data, this.url);
          this.emit("endpoint", this.endpoint);
          return;
        }
        if (!data) return;
        try {
          const parsed = JSON.parse(data);
          if (Array.isArray(parsed)) for (const item of parsed) this.emit("message", item);
          else this.emit("message", parsed);
        } catch (err) {
          this.emit("protocol_error", { line: data, error: err });
        }
      }
    });

    response.stream.setEncoding?.("utf8");
    await new Promise((resolve, reject) => {
      response.stream.on("data", (chunk) => parser.feed(String(chunk)));
      response.stream.on("end", () => { parser.end(); resolve(); });
      response.stream.on("error", reject);
      response.stream.on("aborted", () => resolve()); // 长连被中断:交由上层重连策略
    });
    // GET 流结束 = 传输侧断开
    if (this.state !== "stopped" && this.state !== "stopping") {
      this.state = "stopped";
      this.emit("close", { code: 0, signal: null });
    }
  }

  send(message) {
    if (this.state === "stopped" || this.state === "stopping") {
      throw new Error(`SseTransport: cannot send message while state is '${this.state}'`);
    }
    if (!this.endpoint) {
      throw new Error("SseTransport: endpoint not established yet");
    }
    // POST 到 endpoint;响应经长连回流,这里只关心是否被接受。
    this._post(message).catch((err) => {
      this.lastError = err;
      this.emit("error", err);
    });
  }

  async _post(message) {
    const body = JSON.stringify(message);
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      ...this.headers
    };
    if (this.protocolVersion) headers["MCP-Protocol-Version"] = this.protocolVersion;
    if (typeof message?.method === "string") headers["Mcp-Method"] = message.method;
    if (typeof message?.params?.name === "string") headers["Mcp-Name"] = message.params.name;

    const response = await oauthHttpRequest(
      this.endpoint,
      { allowlist: this.allowlist, lookup: this.lookup, maxRedirects: this.maxRedirects },
      { method: "POST", headers, body, timeoutMs: this.timeoutMs },
      this.oauth,
      this.url
    );
    if (response.status >= 400) {
      throw Object.assign(new Error(`HTTP ${response.status} posting to SSE endpoint`), {
        code: "MCP_HTTP_STATUS",
        status: response.status
      });
    }
  }

  async close() {
    if (this.state === "stopped" || this.state === "idle") {
      this.state = "stopped";
      return;
    }
    this.state = "stopping";
    try { this._controller?.abort(new Error("SseTransport closed")); } catch { /* best-effort */ }
    this._controller = null;
    this.state = "stopped";
    this.emit("close", { code: 0, signal: null });
  }
}

/** endpoint 事件给的是相对或绝对地址;相对地址按长连 URL 解析。 */
export function resolveEndpoint(endpoint, baseUrl) {
  const raw = String(endpoint || "").trim();
  if (!raw) throw new Error("SseTransport: empty endpoint event");
  return new URL(raw, baseUrl).href;
}
