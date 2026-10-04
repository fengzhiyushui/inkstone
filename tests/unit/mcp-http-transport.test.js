import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { HttpTransport, isStreamBreak } from "../../src/tools/mcp/http-transport.js";
import { SseParser, isEventStream } from "../../src/tools/mcp/sse.js";
/**
 * v1.12.0 Streamable HTTP:用真实本地 HTTP server 起 mock,只把 SSRF 的
 * loopback 判定经 allowlist 放行 —— 其余安全路径(DNS 固定、逐跳校验)全走真实现。
 */
const ALLOW_LOOPBACK = ["127.0.0.1"];

async function startServer(handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return {
    server,
    port,
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

function jsonReply(res, payload, status = 200, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), ...extraHeaders });
  res.end(body);
}

function sseHead(res, extraHeaders = {}) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...extraHeaders });
}

/** 收集 transport 上收到的消息,直到 predicate 满足或超时。 */
function collector(transport, { timeoutMs = 5000 } = {}) {
  const messages = [];
  const waiters = [];
  transport.on("message", (m) => {
    messages.push(m);
    for (const w of [...waiters]) w();
  });
  return {
    messages,
    until: (predicate) => new Promise((resolve, reject) => {
      if (predicate(messages)) { resolve(messages); return; }
      const timer = setTimeout(() => reject(new Error(`timeout waiting for message; got ${JSON.stringify(messages)}`)), timeoutMs);
      const check = () => {
        if (predicate(messages)) { clearTimeout(timer); resolve(messages); }
      };
      waiters.push(check);
    })
  };
}

test("POST JSON-RPC 携带标准头(Mcp-Method / Mcp-Name / MCP-Protocol-Version)", async () => {
  let seen = null;
  const srv = await startServer((req, res) => {
    seen = { method: req.method, headers: req.headers, body: "" };
    req.setEncoding("utf8");
    req.on("data", (c) => { seen.body += c; });
    req.on("end", () => jsonReply(res, { jsonrpc: "2.0", id: 1, result: { ok: true } }));
  });

  const transport = new HttpTransport({ url: srv.url, allowlist: ALLOW_LOOPBACK, protocolVersion: "2026-07-28" });
  transport.start();
  transport.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: {} } });
  await once(transport, "message");

  assert.equal(seen.method, "POST");
  assert.equal(seen.headers["content-type"], "application/json");
  assert.match(seen.headers.accept, /application\/json/);
  assert.match(seen.headers.accept, /text\/event-stream/);
  assert.equal(seen.headers["mcp-method"], "tools/call");
  assert.equal(seen.headers["mcp-name"], "echo");
  assert.equal(seen.headers["mcp-protocol-version"], "2026-07-28");
  assert.deepEqual(JSON.parse(seen.body), {
    jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: {} }
  });
  await transport.close();
  await srv.close();
});

test("application/json 响应经 message 事件回流", async () => {
  const srv = await startServer((req, res) => {
    req.resume();
    req.on("end", () => jsonReply(res, { jsonrpc: "2.0", id: 7, result: { tools: [] } }));
  });
  const transport = new HttpTransport({ url: srv.url, allowlist: ALLOW_LOOPBACK });
  const sink = collector(transport);
  transport.start();
  transport.send({ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} });

  const [msg] = await sink.until((m) => m.length >= 1);
  assert.deepEqual(msg, { jsonrpc: "2.0", id: 7, result: { tools: [] } });
  await transport.close();
  await srv.close();
});

test("请求级 SSE:一次 POST 可回流多条消息,且跨 chunk 边界不丢", async () => {
  const srv = await startServer((req, res) => {
    req.resume();
    req.on("end", () => {
      sseHead(res);
      // 分片写入,故意在 data 中间切开
      res.write("event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"res");
      res.write("ult\":{\"step\":1}}\n\n");
      res.write(": keep-alive comment\n\n");
      res.write("data: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/tools/list_changed\"}\n\n");
      res.write("data: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"step\":2}}\n\n");
      res.end();
    });
  });

  const transport = new HttpTransport({ url: srv.url, allowlist: ALLOW_LOOPBACK });
  const sink = collector(transport);
  transport.start();
  transport.send({ jsonrpc: "2.0", id: 1, method: "server/discover", params: {} });

  const msgs = await sink.until((m) => m.length >= 3);
  assert.deepEqual(msgs[0], { jsonrpc: "2.0", id: 1, result: { step: 1 } });
  assert.deepEqual(msgs[1], { jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  assert.deepEqual(msgs[2], { jsonrpc: "2.0", id: 2, result: { step: 2 } });
  await transport.close();
  await srv.close();
});

test("通知回 202 不解析 body,且不产生 message", async () => {
  let posted = 0;
  const srv = await startServer((req, res) => {
    posted += 1;
    req.resume();
    req.on("end", () => { res.writeHead(202); res.end(); });
  });
  const transport = new HttpTransport({ url: srv.url, allowlist: ALLOW_LOOPBACK });
  let msgCount = 0;
  transport.on("message", () => { msgCount += 1; });
  transport.start();
  transport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await new Promise((r) => setTimeout(r, 300));

  assert.equal(posted, 1);
  assert.equal(msgCount, 0);
  await transport.close();
  await srv.close();
});

test("HTTP 4xx/5xx 归类为不可重发的错误(含状态码)", async () => {
  const srv = await startServer((req, res) => {
    req.resume();
    req.on("end", () => jsonReply(res, { error: "nope" }, 401));
  });
  const transport = new HttpTransport({ url: srv.url, allowlist: ALLOW_LOOPBACK });
  const failure = once(transport, "error");
  transport.start();
  transport.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

  const [err] = await failure;
  assert.equal(err.status, 401);
  assert.equal(err.code, "MCP_HTTP_UNAUTHORIZED");
  assert.equal(isStreamBreak(err), false, "鉴权失败不得触发重发");
  await transport.close();
  await srv.close();
});

test("断流重发:服务端首次直接切断连接,重发后成功收到响应", async () => {
  let attempts = 0;
  const srv = await startServer((req, res) => {
    req.resume();
    req.on("end", () => {
      attempts += 1;
      if (attempts === 1) {
        // 声明 SSE 后立刻切断 → 客户端应判定为流中断并重发
        sseHead(res);
        res.flushHeaders?.();
        res.socket?.destroy();
        return;
      }
      jsonReply(res, { jsonrpc: "2.0", id: 5, result: { recovered: true } });
    });
  });

  const transport = new HttpTransport({ url: srv.url, allowlist: ALLOW_LOOPBACK, retryOnStreamBreak: 1 });
  const retries = [];
  transport.on("retry", (info) => retries.push(info));
  const sink = collector(transport);
  transport.start();
  transport.send({ jsonrpc: "2.0", id: 5, method: "tools/list", params: {} });

  const msgs = await sink.until((m) => m.length >= 1);
  assert.deepEqual(msgs[0], { jsonrpc: "2.0", id: 5, result: { recovered: true } });
  assert.equal(attempts, 2, "应恰好重发一次");
  assert.equal(retries.length, 1);
  assert.equal(retries[0].method, "tools/list");
  await transport.close();
  await srv.close();
});

test("关闭后 send 立即抛错(不静默丢帧)", async () => {
  const srv = await startServer((req, res) => { req.resume(); res.writeHead(202); res.end(); });
  const transport = new HttpTransport({ url: srv.url, allowlist: ALLOW_LOOPBACK });
  transport.start();
  await transport.close();
  assert.throws(() => transport.send({ jsonrpc: "2.0", method: "notifications/initialized" }), /cannot send/);
  await srv.close();
});

test("SSRF:未列入 allowlist 的私网目标被拒(不发出请求)", async () => {
  const transport = new HttpTransport({ url: "http://10.0.0.5/mcp", allowlist: ALLOW_LOOPBACK });
  const failure = once(transport, "error");
  transport.start();
  transport.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  const [err] = await failure;
  assert.match(err.message, /blocked private network/);
  assert.equal(err.code, "SSRF_BLOCKED");
  await transport.close();
});

test("SSRF:重定向每一跳都重新校验(302 → 私网被拒)", async () => {
  const srv = await startServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
    });
  });
  const transport = new HttpTransport({ url: srv.url, allowlist: ALLOW_LOOPBACK });
  const failure = once(transport, "error");
  transport.start();
  transport.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

  const [err] = await failure;
  assert.match(err.message, /blocked/i, "重定向目标必须经 SSRF 校验");
  await transport.close();
  await srv.close();
});

test("SSRF:重定向到允许的地址时跨 origin 剥离凭据头", async () => {
  let finalAuth = "unset";
  const target = await startServer((req, res) => {
    finalAuth = req.headers.authorization ?? null;
    req.resume();
    req.on("end", () => jsonReply(res, { jsonrpc: "2.0", id: 1, result: { ok: true } }));
  });
  const front = await startServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(307, { Location: target.url });
      res.end();
    });
  });

  const transport = new HttpTransport({
    url: front.url,
    allowlist: ALLOW_LOOPBACK,
    headers: { Authorization: "Bearer secret-token" }
  });
  const sink = collector(transport);
  transport.start();
  transport.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  await sink.until((m) => m.length >= 1);

  assert.equal(finalAuth, null, "跨 origin 重定向不得携带 Authorization");
  await transport.close();
  await front.close();
  await target.close();
});

test("会话 id 从响应头捕获并回填后续请求", async () => {
  const seen = [];
  const srv = await startServer((req, res) => {
    seen.push(req.headers["mcp-session-id"] ?? null);
    req.resume();
    req.on("end", () => jsonReply(res, { jsonrpc: "2.0", id: 1, result: {} }, 200, { "Mcp-Session-Id": "sess-123" }));
  });
  const transport = new HttpTransport({ url: srv.url, allowlist: ALLOW_LOOPBACK });
  const sink = collector(transport);
  transport.start();
  transport.send({ jsonrpc: "2.0", id: 1, method: "server/discover", params: {} });
  await sink.until((m) => m.length >= 1);

  assert.equal(transport.sessionId, "sess-123");
  transport.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  await sink.until((m) => m.length >= 2);
  assert.deepEqual(seen, [null, "sess-123"], "第二次请求应带上会话 id");
  await transport.close();
  await srv.close();
});

// ── SSE 解析器单测 ──────────────────────────────────────────────────────────
test("SseParser:多行 data 拼接、注释忽略、跨 chunk 边界", () => {
  const events = [];
  const parser = new SseParser({ onEvent: (e) => events.push(e) });
  parser.feed("data: line1\ndata: line2\n\n");
  parser.feed(": keep-alive\n\n");
  parser.feed("event: custom\nid: 42\ndata: {\"a\":1}\n\n");
  parser.feed("data: tail");
  parser.end();

  assert.deepEqual(events[0], { data: "line1\nline2", event: null, id: null });
  assert.deepEqual(events[1], { data: "{\"a\":1}", event: "custom", id: "42" });
  assert.deepEqual(events[2], { data: "tail", event: null, id: "42" });
});

test("isEventStream 判定大小写与参数", () => {
  assert.equal(isEventStream("text/event-stream"), true);
  assert.equal(isEventStream("text/event-stream; charset=utf-8"), true);
  assert.equal(isEventStream("TEXT/EVENT-STREAM"), true);
  assert.equal(isEventStream("application/json"), false);
  assert.equal(isEventStream(undefined), false);
});
