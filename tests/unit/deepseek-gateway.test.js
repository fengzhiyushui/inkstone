// tests/unit/deepseek-gateway.test.js — DeepSeek 模型网关、路由、流式解析与容错
import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createDeepSeekGateway, testDeepSeekConnection } from "../../src/deepseek/model-gateway.js";
import { routeModel, buildChannelParams } from "../../src/deepseek/model-router.js";
import { parseSseBuffer, readDeepSeekStream } from "../../src/deepseek/streaming.js";
import {
  createDeepSeekApiError,
  formatDeepSeekApiError,
  isRetryableDeepSeekError
} from "../../src/deepseek/api-errors.js";
import { normalizeToolCalls, parseToolArguments } from "../../src/deepseek/tool-call-repair.js";
import { promptMentionsJson, applyJsonMode, parseJsonContent } from "../../src/deepseek/json-mode.js";
import { buildFimRequest, createFimClient } from "../../src/deepseek/fim-client.js";
import { createUsageTracker } from "../../src/deepseek/usage-tracker.js";

test("模型路由器（act/think/fim 与复杂度升档策略）", () => {
  const defaultAct = routeModel({ purpose: "reply", complexity: "normal" });
  assert.equal(typeof defaultAct.model, "string");
  assert.equal(defaultAct.channel, "act");

  const complexThink = routeModel({ purpose: "reply", complexity: "high" });
  assert.equal(complexThink.channel, "think");

  const planThink = routeModel({ purpose: "plan" });
  assert.equal(planThink.channel, "think");

  const explicit = routeModel({ explicitModel: "custom-v4" });
  assert.equal(explicit.model, "custom-v4");

  const fim = routeModel({ purpose: "fim" });
  assert.equal(fim.channel, "fim");

  const params = buildChannelParams({ purpose: "reply" });
  assert.equal(typeof params.temperature, "number");
});

test("invoke 请求组装、thinking 参数与 reasoning_content 回传", async () => {
  let capturedBody = null;
  const mockFetch = async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({
        choices: [{
          message: {
            role: "assistant",
            content: "hello world",
            reasoning_content: "thinking step 1"
          }
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      })
    };
  };

  const gateway = createDeepSeekGateway({ apiKey: "sk-test", fetchImpl: mockFetch });
  const result = await gateway.invoke([{ role: "user", content: "hi" }], {
    purpose: "plan",
    thinking: { type: "enabled" }
  });

  assert.equal(result.content, "hello world");
  assert.equal(result.reasoning_content, "thinking step 1");
  assert.ok(capturedBody.messages.length > 0);
  assert.equal(capturedBody.thinking?.type, "enabled");
});

test("SSE 流式解析与用量遥测（TPS、缓存命中率、思考用量）", async () => {
  const sseRaw = [
    "data: {\"choices\":[{\"delta\":{\"content\":\"Hello \"}}]}",
    "",
    "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"thought \"}}]}",
    "",
    "data: {\"choices\":[{\"delta\":{\"content\":\"world\"}}],\"usage\":{\"prompt_tokens\":20,\"completion_tokens\":10,\"total_tokens\":30,\"prompt_cache_hit_tokens\":15,\"prompt_cache_miss_tokens\":5,\"completion_tokens_details\":{\"reasoning_tokens\":4}}}",
    "",
    "data: [DONE]",
    ""
  ].join("\n");

  const parsedEvents = parseSseBuffer(sseRaw);
  assert.ok(parsedEvents.events.length >= 3);
  assert.equal(parsedEvents.done, true);

  const chunks = [];
  const bodyStream = Readable.toWeb(Readable.from([Buffer.from(sseRaw)]));
  const final = await readDeepSeekStream(bodyStream, {
    onDelta: (d) => chunks.push(d)
  });

  assert.equal(final.content, "Hello world");
  assert.equal(final.reasoning_content, "thought ");
  assert.equal(final.usage.prompt_cache_hit_tokens, 15);

  const tracker = createUsageTracker();
  tracker.recordUsage({
    usage: { prompt_tokens: 100, completion_tokens: 50, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20 },
    channel: "act",
    model: "deepseek-flash",
    latency_ms: 500
  });
  const metrics = tracker.getUsageStats();
  assert.equal(metrics.total_tokens, 150);
  assert.equal(metrics.cache_hit_rate, 0.8);
  assert.equal(metrics.requests, 1);
});

test("错误分类（网络/认证/超限）、指数退避重试与超时中断", async () => {
  const err401 = createDeepSeekApiError(401, "Invalid API key");
  assert.equal(isRetryableDeepSeekError(err401), false);

  const err402 = createDeepSeekApiError(402, "out of credits");
  assert.match(err402.message, /余额不足/);

  const err429 = createDeepSeekApiError(429, "Rate limit exceeded");
  assert.equal(isRetryableDeepSeekError(err429), true);

  const err503 = createDeepSeekApiError(503, "Service unavailable");
  assert.equal(isRetryableDeepSeekError(err503), true);

  let attempts = 0;
  const failingFetch = async () => {
    attempts += 1;
    if (attempts < 2) {
      return { ok: false, status: 429, text: async () => "rate limit" };
    }
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ choices: [{ message: { content: "recovered" } }], usage: { total_tokens: 5 } })
    };
  };

  const gateway = createDeepSeekGateway({
    apiKey: "sk-test",
    fetchImpl: failingFetch,
    sleepFn: async () => {}
  });

  const res = await gateway.invoke([{ role: "user", content: "test retry" }]);
  assert.equal(res.content, "recovered");
  assert.equal(attempts, 2);

  const timeoutGateway = createDeepSeekGateway({
    apiKey: "sk-test",
    fetchImpl: async (_url, init) => new Promise((_, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })
  });
  await assert.rejects(
    () => timeoutGateway.invoke([{ role: "user", content: "slow" }], { timeoutMs: 20 }),
    (e) => e.code === "MODEL_TIMEOUT"
  );
});

test("JSON Mode 守卫与 tool-call 格式容错", () => {
  assert.equal(promptMentionsJson([{ role: "user", content: "Output valid JSON please" }]), true);
  assert.equal(promptMentionsJson([{ role: "user", content: "Explain this code" }]), false);

  const reqBody = { model: "deepseek-flash" };
  const modified = applyJsonMode({
    body: reqBody,
    messages: [{ role: "user", content: "Return JSON: {\"ok\": true}" }],
    jsonMode: true
  });
  assert.equal(modified.response_format?.type, "json_object");

  const parsed = parseJsonContent("{\"status\": \"ok\", \"count\": 42}");
  assert.equal(parsed.status, "ok");
  assert.equal(parsed.count, 42);

  const args = parseToolArguments("{\"path\": \"src/app.js\"}");
  assert.equal(args.ok, true);
  assert.equal(args.value.path, "src/app.js");

  const normalized = normalizeToolCalls([
    { id: "call_1", type: "function", function: { name: "read", arguments: "{\"path\":\"a.js\"}" } }
  ]);
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].name, "read");
  assert.equal(normalized[0].arguments.path, "a.js");
});

test("FIM 补全与 testDeepSeekConnection 连通性测试", async () => {
  const fimReq = buildFimRequest({ prefix: "function add(", suffix: ") { return a + b; }" });
  assert.equal(fimReq.prompt, "function add(");
  assert.equal(fimReq.suffix, ") { return a + b; }");

  let fimCalled = false;
  const fimClient = createFimClient({
    apiKey: "sk-test",
    fetchImpl: async (_url, init) => {
      fimCalled = true;
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ choices: [{ text: "a, b" }] })
      };
    }
  });
  const fimRes = await fimClient.complete({ prefix: "def add(", suffix: "): pass" });
  assert.equal(fimRes.content, "a, b");
  assert.equal(fimCalled, true);

  const connRes = await testDeepSeekConnection({
    apiKey: "sk-test",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ choices: [{ message: { content: "OK" } }] })
    })
  });
  assert.equal(connRes.content, "OK");
});
