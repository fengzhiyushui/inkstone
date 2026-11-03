// tests/unit/deepseek/protocol-and-streaming.test.js — 协议与流式(SSE/错误/FIM/JSON 模式/用量)领域测试
//
// v1.19.1 测试归并:本文件由下列历史任务单测试合并而成,每个来源包裹在独立
// describe 块中(异步回调 + 动态 import,来源间零共享绑定),测试语义与拆分前一致。
import { describe } from "node:test";

// ---------------------------------------------------------------------------
// 来源:tests/unit/deepseek/streaming.test.js
// ---------------------------------------------------------------------------
describe("unit/deepseek/streaming", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { parseSseBuffer, readDeepSeekStream } = await import("../../../src/deepseek/streaming.js");

  test("parseSseBuffer parses complete data lines and preserves remainder", () => {
    const parsed = parseSseBuffer("data: {\"a\":1}\n\ndata: {\"b\"");
    assert.deepEqual(parsed.events, [{ a: 1 }]);
    assert.equal(parsed.done, false);
    assert.equal(parsed.remainder, "data: {\"b\"");
  });

  test("parseSseBuffer detects DONE marker", () => {
    const parsed = parseSseBuffer("data: {\"a\":1}\n\ndata: [DONE]\n\n");
    assert.equal(parsed.done, true);
    assert.deepEqual(parsed.events, [{ a: 1 }]);
  });

  test("readDeepSeekStream accumulates content reasoning usage and tool call deltas", async () => {
    const chunks = [
      "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"hel\"},\"finish_reason\":null,\"index\":0}],\"usage\":null}\n\n",
      "data: {\"choices\":[{\"delta\":{\"content\":\"lo\",\"reasoning_content\":\"hidden\",\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"read\",\"arguments\":\"{\\\"path\\\":\"}}]},\"finish_reason\":null,\"index\":0}],\"usage\":null}\n\n",
      "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"README.md\\\"}\"}}]},\"finish_reason\":\"tool_calls\",\"index\":0}],\"usage\":null}\n\n",
      "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5,\"prompt_cache_hit_tokens\":7,\"prompt_cache_miss_tokens\":3}}\n\n",
      "data: [DONE]\n\n"
    ];
    const deltas = [];
    const stream = new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); } });
    const result = await readDeepSeekStream(stream, { onDelta: (text) => deltas.push(text) });
    assert.equal(result.content, "hello");
    assert.equal(result.reasoning_content, "hidden");
    assert.equal(result.finish_reason, "tool_calls");
    assert.deepEqual(deltas, ["hel", "lo"]);
    assert.equal(result.usage.prompt_cache_hit_tokens, 7);
    assert.equal(result.tool_calls[0].id, "call_1");
    assert.equal(result.tool_calls[0].function.name, "read");
    assert.equal(result.tool_calls[0].function.arguments, "{\"path\":\"README.md\"}");
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/deepseek/api-errors.test.js
// ---------------------------------------------------------------------------
describe("unit/deepseek/api-errors", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createDeepSeekApiError, formatDeepSeekApiError, isRetryableDeepSeekError } = await import("../../../src/deepseek/api-errors.js");

  test("formats JSON API errors without leaking large bodies", () => {
    assert.equal(formatDeepSeekApiError(401, "{\"error\":{\"message\":\"bad key\"}}"), "DeepSeek API 401: bad key");
  });

  test("formats plain-text API errors with truncation", () => {
    const text = "x".repeat(300);
    const message = formatDeepSeekApiError(500, text);
    assert.equal(message.length < 260, true);
    assert.match(message, /^DeepSeek API 500:/);
  });

  test("classifies retryable status codes and insufficient resources", () => {
    assert.equal(isRetryableDeepSeekError({ status: 429 }), true);
    assert.equal(isRetryableDeepSeekError({ status: 503 }), true);
    assert.equal(isRetryableDeepSeekError({ finish_reason: "insufficient_system_resource" }), true);
    assert.equal(isRetryableDeepSeekError({ status: 401 }), false);
  });

  test("treats the extended finish_reasons insufficient_system_resource and aborted as retryable", () => {
    assert.equal(isRetryableDeepSeekError({ finish_reason: "insufficient_system_resource" }), true);
    assert.equal(isRetryableDeepSeekError({ finish_reason: "aborted" }), true);
    assert.equal(isRetryableDeepSeekError({ finish_reason: "length" }), false);
    assert.equal(isRetryableDeepSeekError({ finish_reason: "stop" }), false);
  });

  test("402/400/401/403 are never retryable", () => {
    for (const status of [400, 401, 402, 403]) {
      assert.equal(isRetryableDeepSeekError({ status }), false, `status ${status}`);
    }
  });

  test("402 errors carry an insufficient-balance hint other statuses do not", () => {
    const message = formatDeepSeekApiError(402, "{\"error\":{\"message\":\"Insufficient Balance\"}}");
    assert.match(message, /Insufficient Balance/);
    assert.match(message, /余额不足/);
    assert.match(formatDeepSeekApiError(402, "Insufficient Balance"), /余额不足/);
    assert.equal(formatDeepSeekApiError(429, "{\"error\":{\"message\":\"rate limited\"}}").includes("余额不足"), false);
    assert.equal(formatDeepSeekApiError(401, "{\"error\":{\"message\":\"bad key\"}}").includes("余额不足"), false);
  });

  test("createDeepSeekApiError returns annotated Error", () => {
    const error = createDeepSeekApiError(403, "{\"message\":\"forbidden\"}");
    assert.equal(error.name, "DeepSeekApiError");
    assert.equal(error.status, 403);
    assert.equal(error.code, "DEEPSEEK_API_ERROR");
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/deepseek/fim-client.test.js
// ---------------------------------------------------------------------------
describe("unit/deepseek/fim-client", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { buildFimRequest, createFimClient, resolveBetaCompletionsUrl } = await import("../../../src/deepseek/fim-client.js");
  const { normalizeToolCalls, parseToolArguments } = await import("../../../src/deepseek/tool-call-repair.js");

  test("buildFimRequest creates beta completion body without chat-only fields", () => {
    const body = buildFimRequest({ prefix: "function add(a, b) {", suffix: "}", model: "deepseek-flash", maxTokens: 4096 });
    assert.deepEqual(body, { model: "deepseek-flash", prompt: "function add(a, b) {", suffix: "}", max_tokens: 4096 });
    assert.equal(body.thinking, undefined);
    assert.equal(body.response_format, undefined);
  });

  test("buildFimRequest defaults to deepseek-flash with 4096 max_tokens", () => {
    const body = buildFimRequest({ prefix: "function add(a, b) {" });
    assert.equal(body.model, "deepseek-flash");
    assert.equal(body.max_tokens, 4096);
  });

  test("buildFimRequest clamps max_tokens into 1..4096 and falls back on non-finite", () => {
    assert.equal(buildFimRequest({ prefix: "x", maxTokens: 9999 }).max_tokens, 4096);
    assert.equal(buildFimRequest({ prefix: "x", maxTokens: 0 }).max_tokens, 1);
    assert.equal(buildFimRequest({ prefix: "x", maxTokens: 1.9 }).max_tokens, 1);
    assert.equal(buildFimRequest({ prefix: "x", maxTokens: 100.9 }).max_tokens, 100);
    assert.equal(buildFimRequest({ prefix: "x", maxTokens: Infinity }).max_tokens, 4096);
    assert.equal(buildFimRequest({ prefix: "x", maxTokens: Number.NaN }).max_tokens, 4096);
    assert.equal(buildFimRequest({ prefix: "x", maxTokens: "abc" }).max_tokens, 4096);
    assert.throws(() => buildFimRequest({ prefix: "" }), /non-empty string/);
    assert.throws(() => buildFimRequest({}), /non-empty string/);
  });

  test("fim client posts to beta completions endpoint and returns text", async () => {
    const calls = [];
    const client = createFimClient({ apiKey: "key", baseUrl: "https://api.deepseek.com", fetchImpl: async (url, init) => { calls.push({ url, init }); return jsonResponse(200, { choices: [{ text: " return a + b; " }], usage: { prompt_tokens: 10, completion_tokens: 4 } }); } });
    const result = await client.complete({ prefix: "function add(a, b) {", suffix: "}" });
    assert.equal(result.content, " return a + b; ");
    assert.equal(calls[0].url, "https://api.deepseek.com/beta/completions");
    assert.equal(JSON.parse(calls[0].init.body).prompt, "function add(a, b) {");
    assert.ok(typeof result.latency_ms === "number");
    assert.ok(result.latency_ms >= 0);
  });

  test("fim client defaults to api.deepseek.com beta completions when baseUrl is omitted", async () => {
    const calls = [];
    const client = createFimClient({ apiKey: "key", fetchImpl: async (url, init) => { calls.push({ url, init }); return jsonResponse(200, { choices: [{ text: "ok" }] }); } });
    await client.complete({ prefix: "x" });
    assert.equal(calls[0].url, "https://api.deepseek.com/beta/completions");
  });

  test("resolveBetaCompletionsUrl falls back to baseUrl beta path", () => {
    assert.equal(resolveBetaCompletionsUrl("https://api.deepseek.com", undefined), "https://api.deepseek.com/beta/completions");
    assert.equal(resolveBetaCompletionsUrl("https://api.deepseek.com/", undefined), "https://api.deepseek.com/beta/completions");
    assert.equal(resolveBetaCompletionsUrl("https://api.deepseek.com///", ""), "https://api.deepseek.com/beta/completions");
    assert.equal(resolveBetaCompletionsUrl("https://api.deepseek.com", 42), "https://api.deepseek.com/beta/completions");
    assert.equal(resolveBetaCompletionsUrl("https://api.deepseek.com", null), "https://api.deepseek.com/beta/completions");
    assert.equal(resolveBetaCompletionsUrl("https://api.deepseek.com", { url: "https://evil.example" }), "https://api.deepseek.com/beta/completions");
  });

  test("resolveBetaCompletionsUrl appends /completions to a betaBase and trims trailing slashes", () => {
    assert.equal(resolveBetaCompletionsUrl("https://api.deepseek.com", "https://api.deepseek.com/beta"), "https://api.deepseek.com/beta/completions");
    assert.equal(resolveBetaCompletionsUrl("https://api.deepseek.com", "https://api.deepseek.com/beta/"), "https://api.deepseek.com/beta/completions");
    assert.equal(resolveBetaCompletionsUrl("https://api.deepseek.com", "https://api.deepseek.com/beta///"), "https://api.deepseek.com/beta/completions");
    assert.equal(resolveBetaCompletionsUrl("https://api.deepseek.com", "http://127.0.0.1:8787"), "http://127.0.0.1:8787/completions");
    assert.equal(resolveBetaCompletionsUrl("https://api.deepseek.com", "http://127.0.0.1:8787/"), "http://127.0.0.1:8787/completions");
  });

  test("fim client posts to betaBase /completions for proxy bases without /beta prefix", async () => {
    for (const betaBase of ["https://api.deepseek.com/beta", "https://api.deepseek.com/beta/", "http://127.0.0.1:8787"]) {
      const calls = [];
      const client = createFimClient({ apiKey: "key", baseUrl: "https://api.deepseek.com", betaBase, fetchImpl: async (url, init) => { calls.push({ url, init }); return jsonResponse(200, { choices: [{ text: "ok" }] }); } });
      await client.complete({ prefix: "x" });
      assert.equal(calls[0].url, `${betaBase.replace(/\/+$/, "")}/completions`);
    }
  });

  test("fim client falls back to default beta path when betaBase is blank or not a string", async () => {
    for (const betaBase of ["", undefined, null, 42, { url: "https://evil.example" }, ["https://evil.example"]]) {
      const calls = [];
      const client = createFimClient({ apiKey: "key", baseUrl: "https://api.deepseek.com", betaBase, fetchImpl: async (url, init) => { calls.push({ url, init }); return jsonResponse(200, { choices: [{ text: "ok" }] }); } });
      await client.complete({ prefix: "x" });
      assert.equal(calls[0].url, "https://api.deepseek.com/beta/completions", `betaBase ${JSON.stringify(betaBase)} should fall back`);
    }
  });

  test("normalizeToolCalls preserves raw argument strings and parsed arguments", () => {
    const calls = normalizeToolCalls([{ id: "call_1", type: "function", function: { name: "read", arguments: "{\"path\":\"README.md\"}" } }]);
    assert.equal(calls[0].name, "read");
    assert.deepEqual(calls[0].arguments, { path: "README.md" });
    assert.equal(calls[0].raw_arguments, "{\"path\":\"README.md\"}");
  });

  test("parseToolArguments marks invalid JSON without throwing", () => {
    const parsed = parseToolArguments("{bad");
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /position 1/);
  });

  function jsonResponse(status, payload) { return { ok: status >= 200 && status < 300, status, json: async () => payload, text: async () => JSON.stringify(payload) }; }
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/deepseek/json-mode.test.js
// ---------------------------------------------------------------------------
describe("unit/deepseek/json-mode", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { promptMentionsJson, applyJsonMode, parseJsonContent } = await import("../../../src/deepseek/json-mode.js");

  test("detects json in system or user messages case-insensitively", () => {
    assert.equal(promptMentionsJson([{ role: "system", content: "Return JSON only." }]), true);
    assert.equal(promptMentionsJson([{ role: "user", content: "plain chat" }]), false);
  });

  test("does not add response_format when JSON mode is disabled", () => {
    const body = applyJsonMode({ body: { model: "deepseek-flash" }, messages: [{ role: "user", content: "hello" }], jsonMode: false });
    assert.equal(body.response_format, undefined);
  });

  test("adds response_format only when prompt includes json", () => {
    const body = applyJsonMode({ body: { model: "deepseek-v4-pro" }, messages: [{ role: "user", content: "Return a json object with key answer." }], jsonMode: true });
    assert.deepEqual(body.response_format, { type: "json_object" });
  });

  test("throws a clear error when JSON mode prompt lacks json", () => {
    assert.throws(() => applyJsonMode({ body: { model: "deepseek-v4-pro" }, messages: [{ role: "user", content: "Return an object." }], jsonMode: true }), /JSON mode requires/);
  });

  test("does not add response_format when only assistant mentions json", () => {
    assert.throws(() => applyJsonMode({
      body: { model: "deepseek-v4-pro" },
      messages: [{ role: "assistant", content: "I will return a json object now." }],
      jsonMode: true
    }), /JSON mode requires/);
  });

  test("parseJsonContent parses object and annotates invalid JSON errors", () => {
    assert.deepEqual(parseJsonContent("{\"answer\":42}"), { answer: 42 });
    assert.throws(() => parseJsonContent("{bad"), /invalid DeepSeek JSON content/);
  });

  // 空串解析失败兜底在此;空 content 的重试策略在 gateway 侧(M4 #7),
  // parseJsonContent 自身行为不变。
  test("parseJsonContent rejects empty content with DEEPSEEK_INVALID_JSON", () => {
    assert.throws(() => parseJsonContent(""), (error) => error.code === "DEEPSEEK_INVALID_JSON" && /invalid DeepSeek JSON content/.test(error.message));
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/deepseek/usage-tracker.test.js
// ---------------------------------------------------------------------------
describe("unit/deepseek/usage-tracker", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createUsageTracker } = await import("../../../src/deepseek/usage-tracker.js");

  test("usage tracker records prompt completion reasoning and cache tokens", () => {
    const tracker = createUsageTracker();
    tracker.recordUsage({ channel: "think", model: "deepseek-v4-pro", latency_ms: 120, usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130, prompt_cache_hit_tokens: 70, prompt_cache_miss_tokens: 30, completion_tokens_details: { reasoning_tokens: 12 } } });
    const stats = tracker.getUsageStats();
    assert.equal(stats.requests, 1);
    assert.equal(stats.total_prompt_tokens, 100);
    assert.equal(stats.total_completion_tokens, 30);
    assert.equal(stats.total_reasoning_tokens, 12);
    assert.equal(stats.cache_hit_tokens, 70);
    assert.equal(stats.cache_miss_tokens, 30);
    assert.equal(stats.cache_hit_rate, 0.7);
    assert.equal(stats.avg_latency_ms, 120);
    assert.equal(stats.by_channel.think.requests, 1);
  });

  test("usage tracker falls back to prompt_tokens_details.cached_tokens", () => {
    const tracker = createUsageTracker();
    tracker.recordUsage({ channel: "act", model: "deepseek-flash", usage: { prompt_tokens: 50, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 20 } } });
    const stats = tracker.getUsageStats();
    assert.equal(stats.cache_hit_tokens, 20);
    assert.equal(stats.cache_miss_tokens, 30);
  });
});
