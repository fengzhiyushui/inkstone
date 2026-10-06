/**
 * v1.12.0:极简 SSE(Server-Sent Events)解析器。
 *
 * 只实现 MCP 传输需要的部分:按行解析 `field: value`,`data:` 可多行拼接,
 * 空行结束一个事件;`:` 开头是注释(用于 keep-alive);`event:` / `id:` 记录在
 * 事件上透出。不做自动重连 —— MCP Streamable HTTP 的断流语义是"重发 in-flight
 * 请求(新 id)",而不是 Last-Event-ID 续传(见 v1.12.0 spec C3)。
 */
export class SseParser {
  constructor({ onEvent, maxEventBytes = Infinity } = {}) {
    this.onEvent = typeof onEvent === "function" ? onEvent : () => {};
    this.buffer = "";
    this.dataLines = [];
    this.eventName = null;
    this.lastEventId = null;
    this.maxEventBytes = maxEventBytes;
    this.eventBytes = 0;
  }

  /** 喂入一段文本(可跨 chunk 边界切断)。 */
  feed(chunk) {
    this.buffer += chunk;
    // 统一换行,再按 \n 切;保留最后一段不完整行等待后续 chunk
    this.buffer = this.buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) this.line(line);
    if (this.eventBytes + Buffer.byteLength(this.buffer) > this.maxEventBytes) this.tooLarge();
  }

  /** 流结束时调用:刷新缓冲区里的最后一行。 */
  end() {
    if (this.buffer.length > 0) {
      const rest = this.buffer;
      this.buffer = "";
      this.line(rest);
    }
    this.dispatch();
  }

  line(raw) {
    if (raw === "") {
      this.dispatch();
      return;
    }
    if (raw.startsWith(":")) return; // 注释 / keep-alive
    this.eventBytes += Buffer.byteLength(raw) + 1;
    if (this.eventBytes > this.maxEventBytes) this.tooLarge();

    const colon = raw.indexOf(":");
    const field = colon === -1 ? raw : raw.slice(0, colon);
    let value = colon === -1 ? "" : raw.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "data") this.dataLines.push(value);
    else if (field === "event") this.eventName = value;
    else if (field === "id") this.lastEventId = value;
    // retry / 其它字段:MCP 不需要,忽略
  }

  dispatch() {
    this.eventBytes = 0;
    if (this.dataLines.length === 0) {
      this.eventName = null;
      return;
    }
    const data = this.dataLines.join("\n");
    const event = this.eventName;
    const id = this.lastEventId;
    this.dataLines = [];
    this.eventName = null;
    this.onEvent({ data, event, id });
  }

  tooLarge() {
    throw Object.assign(new Error("MCP SSE event exceeds the configured byte limit"), { code: "MCP_SSE_EVENT_LIMIT" });
  }
}

/** 判断响应 Content-Type 是否为 SSE。 */
export function isEventStream(contentType) {
  return typeof contentType === "string" && contentType.toLowerCase().includes("text/event-stream");
}
