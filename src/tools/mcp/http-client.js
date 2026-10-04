import http from "node:http";
import https from "node:https";
import { resolveFetchTarget } from "../../security/ssrf.js";

/**
 * v1.12.0:HTTP 传输的底层客户端。
 *
 * 两个不变量:
 *  1. **DNS 固定**:每跳都先经 ssrf.js 解析出已验证 IP,再用自定义 lookup 把 socket
 *     钉在该 IP 上(保留原 hostname 做 Host 与 TLS SNI/证书校验),杜绝校验后二次解析
 *     造成的 rebinding / TOCTOU。
 *  2. **逐跳校验**:重定向由本模块手动跟随,每一跳都重新走 SSRF 校验;跨 origin 时
 *     剥掉自定义头,避免把 Authorization 之类凭据泄漏给第三方主机。
 */
export const DEFAULT_MAX_REDIRECTS = 5;
export const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;

export class HttpRedirectError extends Error {
  constructor(message) {
    super(message);
    this.name = "HttpRedirectError";
    this.code = "MCP_HTTP_REDIRECT";
  }
}

function headerValue(headers, name) {
  const value = headers[String(name).toLowerCase()];
  return Array.isArray(value) ? value.join(", ") : (value ?? null);
}

/** 把请求体收集为 Buffer(带上限,超限截断但继续 drain)。 */
export function collectBody(stream, maxBytes = DEFAULT_MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let stored = 0;
    let total = 0;
    stream.on("data", (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (stored >= maxBytes) return;
      const room = maxBytes - stored;
      chunks.push(buf.length <= room ? buf : buf.subarray(0, room));
      stored += Math.min(buf.length, room);
    });
    stream.on("end", () => resolve({
      buffer: Buffer.concat(chunks),
      text: Buffer.concat(chunks).toString("utf8"),
      truncated: total > stored,
      originalLength: total
    }));
    stream.on("error", reject);
  });
}

/**
 * 发一次 HTTP 请求(不经系统 DNS 决策),返回响应流或已收集的 body。
 * @param {URL} url 已校验的 URL
 * @param {string} address 与 url 对应的已验证 IP
 */
function requestOnce(url, address, {
  method = "POST",
  headers = {},
  body = null,
  timeoutMs = 30000,
  signal = null,
  stream = false,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES
} = {}) {
  const transport = url.protocol === "https:" ? https : http;
  const family = address && address.includes(":") ? 6 : 4;

  return new Promise((resolve, reject) => {
    const request = transport.request(url, {
      method,
      headers,
      signal: signal || undefined,
      // 保留 hostname 用于 Host 与 SNI;仅把解析结果钉死为已验证地址
      lookup(_hostname, options, callback) {
        if (options?.all) callback(null, [{ address, family }]);
        else callback(null, address, family);
      }
    }, (response) => {
      const view = {
        status: response.statusCode || 0,
        headers: response.headers,
        getHeader: (name) => headerValue(response.headers, name),
        stream: response
      };
      if (stream) {
        resolve(view);
        return;
      }
      collectBody(response, maxBodyBytes)
        .then((collected) => resolve({ ...view, ...collected }))
        .catch(reject);
    });

    const timer = timeoutMs > 0 && timeoutMs !== Infinity
      ? setTimeout(() => {
        const err = new Error(`HTTP request timed out after ${timeoutMs}ms: ${method} ${url.href}`);
        err.code = "ETIMEDOUT";
        request.destroy(err);
      }, timeoutMs)
      : null;
    if (timer?.unref) timer.unref();

    const done = (fn) => (value) => {
      if (timer) clearTimeout(timer);
      fn(value);
    };
    request.on("error", done(reject));
    request.on("close", () => { if (timer) clearTimeout(timer); });

    if (body !== null && body !== undefined) request.write(body);
    request.end();
  });
}

/**
 * 发送请求并跟随重定向(逐跳校验 + 跨 origin 剥头)。
 * @param {string} rawUrl
 * @param {{ allowlist?: string[], lookup?: Function, maxRedirects?: number }} [resolveOpts]
 * @param {object} [requestOpts] 透传给 requestOnce
 */
export async function pinnedHttpRequest(rawUrl, resolveOpts = {}, requestOpts = {}) {
  const { allowlist = [], lookup, maxRedirects = DEFAULT_MAX_REDIRECTS } = resolveOpts;
  const original = new URL(rawUrl);
  let current = original;
  let redirects = 0;
  let headers = { ...(requestOpts.headers || {}) };

  for (;;) {
    const target = await resolveFetchTarget(current.href, {
      ...(lookup ? { lookup } : {}),
      allowlist
    });
    const response = await requestOnce(target.url, target.address, { ...requestOpts, headers });

    const isRedirect = response.status >= 300 && response.status < 400;
    if (!isRedirect) return response;

    const location = response.getHeader("location");
    if (!location) throw new HttpRedirectError(`HTTP ${response.status} without Location: ${current.href}`);
    if (redirects >= maxRedirects) throw new HttpRedirectError(`too many redirects (>${maxRedirects}): ${original.href}`);
    if (response.stream && !requestOpts.stream) response.stream.resume?.();

    const next = new URL(location, current.href);
    // 跨 origin 时剥离凭据类自定义头,只保留协议必需头
    if (next.origin !== current.origin) {
      const keep = new Set(["content-type", "accept", "mcp-protocol-version", "mcp-session-id", "user-agent"]);
      headers = Object.fromEntries(
        Object.entries(headers).filter(([k]) => keep.has(k.toLowerCase()))
      );
    }
    current = next;
    redirects += 1;
  }
}
