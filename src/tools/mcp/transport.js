import { StdioTransport } from "./stdio-transport.js";
import { HttpTransport } from "./http-transport.js";
import { SseTransport } from "./sse-transport.js";

/**
 * v1.12.0:传输层统一出口。
 *
 * 所有传输共享同一契约(与 stdio 原本的形状一致),因此 McpClient / JsonRpcClient
 * 无需区分类型:
 *   - EventEmitter,事件:`message`(JSON-RPC 帧)/ `error` / `close` / `protocol_error`
 *   - `start()` 建立连接;`send(message)` 发送一帧;`close()` 断开
 *   - `getRecentStderr()` 诊断文本(HTTP 系返回空串)
 *   - 可选 `supportsRetry` —— 为 true 时传输支持"断流重发"
 *   - 可选 `setProtocolVersion(v)` / `setSessionId(id)` / `deprecated` 标记
 */
export const TRANSPORT_TYPES = Object.freeze({
  STDIO: "stdio",
  STREAMABLE_HTTP: "streamable-http",
  SSE: "sse"
});

/** 由 server 配置推断类型(与 config-loader.normalizeServerConfig 的判定保持一致)。 */
export function resolveTransportType(config = {}) {
  const explicit = typeof config.type === "string" ? config.type.trim().toLowerCase() : null;
  if (explicit === "http") return TRANSPORT_TYPES.STREAMABLE_HTTP;
  if (explicit === "streamable-http" || explicit === "sse" || explicit === "stdio") return explicit;
  const hasUrl = typeof config.url === "string" && config.url.trim();
  return hasUrl ? TRANSPORT_TYPES.STREAMABLE_HTTP : TRANSPORT_TYPES.STDIO;
}

/**
 * 按配置创建传输实例。
 * @param {object} config 已归一化的 server 配置(command/url/type/headers/args/env/...)
 */
export function createTransport(config = {}) {
  const type = resolveTransportType(config);
  const timeoutMs = typeof config.timeoutMs === "number" && config.timeoutMs > 0 ? config.timeoutMs : 60000;

  if (type === TRANSPORT_TYPES.STDIO) {
    if (!config.command) {
      throw new Error("createTransport: stdio transport requires 'command'");
    }
    return new StdioTransport({
      command: config.command,
      args: config.args,
      env: config.env,
      cwd: config.cwd,
      shell: config.shell,
      maxStderrLines: config.maxStderrLines
    });
  }

  if (!config.url) {
    throw new Error(`createTransport: ${type} transport requires 'url'`);
  }

  const common = {
    url: config.url,
    headers: config.headers,
    timeoutMs,
    protocolVersion: config.protocolVersion || null,
    allowlist: config.allowlist || [],
    lookup: config.lookup,
    maxRedirects: config.maxRedirects
  };

  if (type === TRANSPORT_TYPES.SSE) {
    return new SseTransport(common);
  }
  return new HttpTransport({
    ...common,
    retryOnStreamBreak: config.retryOnStreamBreak,
    maxBodyBytes: config.maxBodyBytes
  });
}
