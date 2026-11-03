// tests/unit/deepseek/model-gateway-and-router.test.js — 模型网关与路由器领域测试
//
// v1.19.1 测试归并:本文件由下列历史任务单测试合并而成,每个来源包裹在独立
// describe 块中(异步回调 + 动态 import,来源间零共享绑定),测试语义与拆分前一致。
import { describe } from "node:test";

// ---------------------------------------------------------------------------
// 来源:tests/unit/deepseek/model-gateway.test.js
// ---------------------------------------------------------------------------
describe("unit/deepseek/model-gateway", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { assembleReplyMessages } = await import("../../../src/deepseek/prompt-assembler.js");
  const { createDeepSeekGateway } = await import("../../../src/deepseek/model-gateway.js");

  test("assembleReplyMessages uses stable system prefix and current user suffix", () => {
    const messages = assembleReplyMessages({ message: "What is this project?", classification: { task_type: "query" }, context: { summary: "Node project" } });
    assert.equal(messages[0].role, "system");
    assert.match(messages[0].content, /Inkstone/);
    assert.match(messages[0].content, /Node project/);
    assert.deepEqual(messages.at(-1), { role: "user", content: "What is this project?" });
  });

  test("assembleReplyMessages inserts sanitized history before current user message", () => {
    const messages = assembleReplyMessages({
      message: "What did I ask first?",
      classification: { task_type: "query" },
      history: [
        { role: "system", content: "ignored system" },
        { role: "user", content: "Remember alpha" },
        { role: "assistant", content: "Alpha noted" },
        { role: "tool", content: "ignored tool" },
        { role: "assistant", content: "" }
      ]
    });

    assert.deepEqual(messages.map((entry) => entry.role), ["system", "user", "assistant", "user"]);
    assert.equal(messages[1].content, "Remember alpha");
    assert.equal(messages[2].content, "Alpha noted");
    assert.equal(messages[3].content, "What did I ask first?");
  });

  test("buildChatRequest keeps plain reply out of JSON mode", () => {
    const gateway = createDeepSeekGateway({ apiKey: "key" });
    const request = gateway.buildChatRequest([{ role: "user", content: "hello" }], { purpose: "reply", stream: false });
    assert.equal(request.body.model, "deepseek-flash");
    assert.equal(request.body.response_format, undefined);
    assert.deepEqual(request.body.thinking, { type: "disabled" });
  });

  test("buildChatRequest enables JSON mode only when requested and prompted", () => {
    const gateway = createDeepSeekGateway({ apiKey: "key" });
    const request = gateway.buildChatRequest([{ role: "user", content: "Return json: {\"ok\":true}" }], { purpose: "plan", jsonMode: true });
    assert.equal(request.body.model, "deepseek-v4-pro");
    assert.deepEqual(request.body.response_format, { type: "json_object" });
    assert.deepEqual(request.body.thinking, { type: "enabled" });
  });

  test("invoke posts non-streaming chat request and records usage", async () => {
    const calls = [];
    const gateway = createDeepSeekGateway({ apiKey: "key", fetchImpl: async (url, init) => { calls.push({ url, init }); return jsonResponse(200, { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "hello back", reasoning_content: "hidden" } }], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_cache_hit_tokens: 4, prompt_cache_miss_tokens: 6 } }); } });
    const result = await gateway.invoke([{ role: "user", content: "hello" }], { purpose: "reply" });
    assert.equal(result.content, "hello back");
    assert.equal(result.reasoning_content, "hidden");
    assert.equal(calls[0].url, "https://api.deepseek.com/chat/completions");
    assert.equal(JSON.parse(calls[0].init.body).stream, false);
    assert.equal(gateway.getUsageStats().cache_hit_tokens, 4);
  });

  test("stream uses SSE parser and onDelta callback", async () => {
    const gateway = createDeepSeekGateway({ apiKey: "key", fetchImpl: async () => streamResponse(["data: {\"choices\":[{\"delta\":{\"content\":\"hi\"},\"finish_reason\":null,\"index\":0}],\"usage\":null}\n\n", "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1,\"prompt_cache_hit_tokens\":1,\"prompt_cache_miss_tokens\":0}}\n\n", "data: [DONE]\n\n"]) });
    const deltas = [];
    const result = await gateway.stream([{ role: "user", content: "hello" }], { purpose: "reply", onDelta: (text) => deltas.push(text) });
    assert.equal(result.content, "hi");
    assert.deepEqual(deltas, ["hi"]);
    assert.equal(gateway.getUsageStats().cache_hit_tokens, 1);
  });

  test("reply uses assembled messages and returns content", async () => {
    const gateway = createDeepSeekGateway({ apiKey: "key", fetchImpl: async () => jsonResponse(200, { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "project answer" } }], usage: { prompt_tokens: 4, completion_tokens: 2, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 4 } }) });
    const result = await gateway.reply({ message: "what is this?", classification: { task_type: "query" } });
    assert.equal(result.content, "project answer");
  });

  test("reply forwards options history into assembled request messages", async () => {
    const calls = [];
    const gateway = createDeepSeekGateway({
      apiKey: "key",
      fetchImpl: async (_url, init) => {
        calls.push(JSON.parse(init.body).messages);
        return jsonResponse(200, {
          choices: [{ finish_reason: "stop", message: { role: "assistant", content: "remembered" } }],
          usage: { prompt_tokens: 4, completion_tokens: 2, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 4 }
        });
      }
    });

    await gateway.reply({
      message: "second",
      classification: { task_type: "query" },
      options: {
        history: [
          { role: "user", content: "first" },
          { role: "assistant", content: "one" }
        ]
      }
    });

    assert.deepEqual(calls[0].map((entry) => entry.role), ["system", "user", "assistant", "user"]);
    assert.equal(calls[0][1].content, "first");
    assert.equal(calls[0][3].content, "second");
  });

  test("construction-time models drive chat requests; per-call models override", () => {
    const gateway = createDeepSeekGateway({ apiKey: "key", models: { act: "cfg-act", think: "cfg-think", fim: "cfg-fim" } });
    const request = gateway.buildChatRequest([{ role: "user", content: "hi" }], { purpose: "act", stream: false });
    assert.equal(request.body.model, "cfg-act");
    const overridden = gateway.buildChatRequest([{ role: "user", content: "hi" }], { purpose: "act", stream: false, models: { act: "call-act" } });
    assert.equal(overridden.body.model, "call-act");
  });

  test("fimComplete uses configured fim model and explicit options.model wins", async () => {
    const calls = [];
    const gateway = createDeepSeekGateway({
      apiKey: "key",
      models: { act: "cfg-act", think: "cfg-think", fim: "cfg-fim" },
      fetchImpl: async (url, init) => {
        calls.push({ url, body: JSON.parse(init.body) });
        return jsonResponse(200, { choices: [{ text: "done" }], usage: { prompt_tokens: 1, completion_tokens: 1, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1 } });
      }
    });
    await gateway.fimComplete("prefix");
    assert.equal(calls.at(-1).url, "https://api.deepseek.com/beta/completions");
    assert.equal(calls.at(-1).body.model, "cfg-fim");
    await gateway.fimComplete("prefix", "", { model: "explicit-fim" });
    assert.equal(calls.at(-1).body.model, "explicit-fim");
  });

  // v1.9.0 M4 #12:有限指数退避重试(.retryable 首次有执行端)。
  // sleepFn 注入即刻 resolve,测试不真的等 500ms/1000ms。
  test("invoke retries a retryable 429 once and records usage only once", async () => {
    let calls = 0;
    const gateway = createDeepSeekGateway({
      apiKey: "key",
      sleepFn: async () => {},
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return { ok: false, status: 429, text: async () => "{\"error\":{\"message\":\"rate limited\"}}" };
        return jsonResponse(200, { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "recovered" } }], usage: { prompt_tokens: 3, completion_tokens: 1, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 3 } });
      }
    });
    const result = await gateway.invoke([{ role: "user", content: "hello" }], { purpose: "reply" });
    assert.equal(calls, 2);
    assert.equal(result.content, "recovered");
    assert.equal(gateway.getUsageStats().requests, 1);
  });

  test("invoke gives up after 3 attempts on persistent 502 and throws the API error", async () => {
    let calls = 0;
    const gateway = createDeepSeekGateway({
      apiKey: "key",
      sleepFn: async () => {},
      fetchImpl: async () => {
        calls += 1;
        return { ok: false, status: 502, text: async () => "{\"error\":{\"message\":\"bad gateway\"}}" };
      }
    });
    await assert.rejects(
      () => gateway.invoke([{ role: "user", content: "hello" }], { purpose: "reply" }),
      (error) => error.status === 502 && error.code === "DEEPSEEK_API_ERROR"
    );
    assert.equal(calls, 3);
  });

  test("invoke does not retry 402 insufficient balance", async () => {
    let calls = 0;
    const gateway = createDeepSeekGateway({
      apiKey: "key",
      sleepFn: async () => {},
      fetchImpl: async () => {
        calls += 1;
        return { ok: false, status: 402, text: async () => "{\"error\":{\"message\":\"Insufficient Balance\"}}" };
      }
    });
    await assert.rejects(
      () => gateway.invoke([{ role: "user", content: "hello" }], { purpose: "reply" }),
      (error) => error.status === 402 && /余额不足/.test(error.message)
    );
    assert.equal(calls, 1);
  });

  test("invoke does not enter retry when the caller signal is already aborted", async () => {
    let calls = 0;
    const controller = new AbortController();
    controller.abort();
    const gateway = createDeepSeekGateway({
      apiKey: "key",
      sleepFn: async () => {},
      fetchImpl: async () => {
        calls += 1;
        return { ok: false, status: 429, text: async () => "rate limited" };
      }
    });
    await assert.rejects(
      () => gateway.invoke([{ role: "user", content: "hello" }], { purpose: "reply", signal: controller.signal }),
      (error) => error.code === "ABORT_ERR"
    );
    assert.equal(calls, 1);
  });

  // v1.9.0 M4 #7:JSON 模式空 content 原样重发一次。
  test("invoke retries empty JSON-mode content once and succeeds on the second response", async () => {
    let calls = 0;
    const gateway = createDeepSeekGateway({
      apiKey: "key",
      sleepFn: async () => {},
      fetchImpl: async () => {
        calls += 1;
        const content = calls === 1 ? "" : "{\"ok\":true}";
        return jsonResponse(200, { choices: [{ finish_reason: "stop", message: { role: "assistant", content } }], usage: { prompt_tokens: 2, completion_tokens: 2, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 2 } });
      }
    });
    const result = await gateway.invoke([{ role: "user", content: "Return a json object with key ok." }], { purpose: "plan", jsonMode: true });
    assert.equal(calls, 2);
    assert.equal(result.content, "{\"ok\":true}");
    assert.equal(result.emptyContent, undefined);
    assert.equal(gateway.getUsageStats().requests, 1);
  });

  test("invoke marks emptyContent when the JSON-mode retry still returns empty content", async () => {
    let calls = 0;
    const gateway = createDeepSeekGateway({
      apiKey: "key",
      sleepFn: async () => {},
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse(200, { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "" } }], usage: { prompt_tokens: 2, completion_tokens: 0, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 2 } });
      }
    });
    const result = await gateway.invoke([{ role: "user", content: "Return a json object with key ok." }], { purpose: "plan", jsonMode: true });
    assert.equal(calls, 2);
    assert.equal(result.content, "");
    assert.equal(result.emptyContent, true);
    assert.equal(gateway.getUsageStats().requests, 1);
  });

  test("non-JSON-mode empty content is returned as-is without a retry", async () => {
    let calls = 0;
    const gateway = createDeepSeekGateway({
      apiKey: "key",
      sleepFn: async () => {},
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse(200, { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "" } }], usage: { total_tokens: 2 } });
      }
    });
    const result = await gateway.invoke([{ role: "user", content: "hello" }], { purpose: "reply" });
    assert.equal(calls, 1);
    assert.equal(result.emptyContent, undefined);
  });

  // v1.9.0 M4 #9:finish_reason "length" → truncated(只挂返回值,不进事件载荷)。
  test("invoke flags truncated only when finish_reason is length", async () => {
    const truncatedGateway = createDeepSeekGateway({ apiKey: "key", fetchImpl: async () => jsonResponse(200, { choices: [{ finish_reason: "length", message: { role: "assistant", content: "partial" } }], usage: { total_tokens: 9 } }) });
    const truncated = await truncatedGateway.invoke([{ role: "user", content: "hello" }], { purpose: "reply" });
    assert.equal(truncated.truncated, true);
    const okGateway = createDeepSeekGateway({ apiKey: "key", fetchImpl: async () => jsonResponse(200, { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "full" } }], usage: { total_tokens: 9 } }) });
    const ok = await okGateway.invoke([{ role: "user", content: "hello" }], { purpose: "reply" });
    assert.equal("truncated" in ok, false);
  });

  test("stream retries only before the first byte and flags truncated", async () => {
    let calls = 0;
    const gateway = createDeepSeekGateway({
      apiKey: "key",
      sleepFn: async () => {},
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return { ok: false, status: 503, text: async () => "{\"error\":{\"message\":\"overloaded\"}}" };
        return streamResponse(["data: {\"choices\":[{\"delta\":{\"content\":\"hi\"},\"finish_reason\":\"length\",\"index\":0}],\"usage\":null}\n\n", "data: [DONE]\n\n"]);
      }
    });
    const result = await gateway.stream([{ role: "user", content: "hello" }], { purpose: "reply" });
    assert.equal(calls, 2);
    assert.equal(result.content, "hi");
    assert.equal(result.truncated, true);
  });

  test("stream does not retry failures after the body read has started", async () => {
    let calls = 0;
    const gateway = createDeepSeekGateway({
      apiKey: "key",
      sleepFn: async () => {},
      fetchImpl: async () => {
        calls += 1;
        return { ok: true, status: 200, text: async () => "", body: { getReader: () => ({ read: async () => { throw new Error("mid-stream reset"); }, cancel: async () => {} }) } };
      }
    });
    await assert.rejects(() => gateway.stream([{ role: "user", content: "hello" }], { purpose: "reply" }), /mid-stream reset/);
    assert.equal(calls, 1);
  });

  // M4 #4:gateway 接受 betaBase 并透传给 FIM 客户端(客户端实现由队友落盘,
  // 此处只钉「接线存在、可用」——不钉 URL,避免与其未着陆实现互相牵扯)。
  test("gateway accepts a betaBase option and fimComplete still completes", async () => {
    const calls = [];
    const gateway = createDeepSeekGateway({
      apiKey: "key",
      betaBase: "https://beta.example.com",
      fetchImpl: async (url) => {
        calls.push(url);
        return jsonResponse(200, { choices: [{ text: "x" }], usage: null });
      }
    });
    assert.equal(await gateway.fimComplete("function a() {"), "x");
    assert.equal(calls.length, 1);
  });

  function jsonResponse(status, payload) { return { ok: status >= 200 && status < 300, status, json: async () => payload, text: async () => JSON.stringify(payload) }; }
  function streamResponse(chunks) { return { ok: true, status: 200, text: async () => "", body: new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); } }) }; }
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/deepseek/model-gateway-timeout.test.js
// ---------------------------------------------------------------------------
describe("unit/deepseek/model-gateway-timeout", async () => {

  // 一个永不解决、但响应 abort 的假 fetch

  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createDeepSeekGateway } = await import("../../../src/deepseek/model-gateway.js");

  function hangingFetch() {
    return (url, init = {}) => new Promise((_resolve, reject) => {
      const signal = init.signal;
      if (signal) {
        if (signal.aborted) return reject(abortError());
        signal.addEventListener("abort", () => reject(abortError()), { once: true });
      }
    });
  }
  function abortError() {
    const e = new Error("aborted");
    e.name = "AbortError";
    e.code = "ABORT_ERR";
    return e;
  }

  // 响应头立即可得、但 body 永不产生数据、且响应 signal abort 的假流式响应
  function hangingStreamFetch() {
    return async (_url, init = {}) => {
      const signal = init.signal;
      const body = {
        getReader() {
          return {
            read() {
              return new Promise((_resolve, reject) => {
                if (!signal) return;
                if (signal.aborted) return reject(abortError());
                signal.addEventListener("abort", () => reject(abortError()), { once: true });
              });
            },
            cancel() { return Promise.resolve(); }
          };
        }
      };
      return { ok: true, status: 200, text: async () => "", body };
    };
  }

  // 响应头可立即得到、但 body 永不完成的假 JSON 响应
  function hangingBodyFetch() {
    return async (_url, init = {}) => {
      const signal = init.signal;
      return {
        ok: true,
        status: 200,
        text: async () => "",
        json() {
          return new Promise((_resolve, reject) => {
            if (!signal) return;
            if (signal.aborted) return reject(abortError());
            signal.addEventListener("abort", () => reject(abortError()), { once: true });
          });
        }
      };
    };
  }

  test("invoke rejects with MODEL_TIMEOUT after timeoutMs", async () => {
    const gateway = createDeepSeekGateway({ apiKey: "k", fetchImpl: hangingFetch() });
    await assert.rejects(
      () => gateway.invoke([{ role: "user", content: "hi" }], { timeoutMs: 20 }),
      (e) => e.code === "MODEL_TIMEOUT"
    );
  });

  test("invoke rejects with MODEL_TIMEOUT when the response body parse hangs past timeoutMs", async () => {
    const gateway = createDeepSeekGateway({ apiKey: "k", fetchImpl: hangingBodyFetch() });
    await assert.rejects(
      () => gateway.invoke([{ role: "user", content: "hi" }], { timeoutMs: 20 }),
      (e) => e.code === "MODEL_TIMEOUT"
    );
  });

  test("stream rejects with MODEL_TIMEOUT when the SSE body read hangs past timeoutMs", async () => {
    const gateway = createDeepSeekGateway({ apiKey: "k", fetchImpl: hangingStreamFetch() });
    await assert.rejects(
      () => gateway.stream([{ role: "user", content: "hi" }], { timeoutMs: 20 }),
      (e) => e.code === "MODEL_TIMEOUT"
    );
  });

  test("stream propagates caller abort (ABORT_ERR) during the SSE body read", async () => {
    const controller = new AbortController();
    const gateway = createDeepSeekGateway({ apiKey: "k", fetchImpl: hangingStreamFetch() });
    const pending = gateway.stream([{ role: "user", content: "hi" }], { signal: controller.signal, timeoutMs: 10000 });
    const assertion = assert.rejects(pending, (e) => e.code === "ABORT_ERR");
    setTimeout(() => controller.abort(), 5);
    await assertion;
  });

  test("stream resolves normally when the stream completes before timeoutMs", async () => {
    const streamFetch = async () => ({
      ok: true,
      status: 200,
      text: async () => "",
      body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":null,\"index\":0}],\"usage\":null}\n\n")); controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); controller.close(); } })
    });
    const gateway = createDeepSeekGateway({ apiKey: "k", fetchImpl: streamFetch });
    const result = await gateway.stream([{ role: "user", content: "hi" }], { timeoutMs: 500 });
    assert.equal(result.content, "ok");
  });

  test("invoke without timeoutMs is unaffected (resolves normally)", async () => {
    const okFetch = async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { total_tokens: 3 } })
    });
    const gateway = createDeepSeekGateway({ apiKey: "k", fetchImpl: okFetch });
    const r = await gateway.invoke([{ role: "user", content: "hi" }], {});
    assert.equal(r.content, "ok");
  });

  // FIM 与 invoke/stream 同语义:超时经 timeoutMs 开启,抛 MODEL_TIMEOUT;不传则不设超时。
  test("fimComplete rejects with MODEL_TIMEOUT after timeoutMs", async () => {
    const gateway = createDeepSeekGateway({ apiKey: "k", fetchImpl: hangingFetch() });
    await assert.rejects(
      () => gateway.fimComplete("const a =", "", { timeoutMs: 20 }),
      (e) => e.code === "MODEL_TIMEOUT"
    );
  });

  test("fimComplete rejects with MODEL_TIMEOUT when the response body parse hangs past timeoutMs", async () => {
    const gateway = createDeepSeekGateway({ apiKey: "k", fetchImpl: hangingBodyFetch() });
    await assert.rejects(
      () => gateway.fimComplete("const a =", "", { timeoutMs: 20 }),
      (e) => e.code === "MODEL_TIMEOUT"
    );
  });

  test("fimComplete propagates caller abort (ABORT_ERR)", async () => {
    const controller = new AbortController();
    const gateway = createDeepSeekGateway({ apiKey: "k", fetchImpl: hangingFetch() });
    const pending = gateway.fimComplete("const a =", "", { signal: controller.signal, timeoutMs: 10000 });
    const assertion = assert.rejects(pending, (e) => e.code === "ABORT_ERR");
    setTimeout(() => controller.abort(), 5);
    await assertion;
  });

  test("fimComplete without timeoutMs is unaffected (resolves normally)", async () => {
    const okFetch = async () => ({
      ok: true,
      json: async () => ({ choices: [{ text: "b = 1;" }], usage: { total_tokens: 4 } })
    });
    const gateway = createDeepSeekGateway({ apiKey: "k", fetchImpl: okFetch });
    assert.equal(await gateway.fimComplete("const a =", "", {}), "b = 1;");
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/deepseek/model-router.test.js
// ---------------------------------------------------------------------------
describe("unit/deepseek/model-router", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { routeModel, buildChannelParams } = await import("../../../src/deepseek/model-router.js");

  test("routes reply and act to flash with thinking disabled", () => {
    assert.deepEqual(routeModel({ purpose: "reply" }), {
      purpose: "reply",
      channel: "act",
      model: "deepseek-flash",
      thinking: { type: "disabled" },
      temperature: 0.2,
      max_tokens: 4096,
      stream: true
    });
    assert.equal(routeModel({ purpose: "act" }).model, "deepseek-flash");
    assert.deepEqual(routeModel({ purpose: "act" }).thinking, { type: "disabled" });
  });

  test("routes plan review and repair to pro with thinking enabled", () => {
    for (const purpose of ["plan", "review", "repair"]) {
      const route = routeModel({ purpose });
      assert.equal(route.channel, "think");
      assert.equal(route.model, "deepseek-v4-pro");
      assert.deepEqual(route.thinking, { type: "enabled" });
      assert.equal(route.reasoning_effort, "high");
      assert.equal(route.stream, false);
    }
  });

  test("routes complex reply to pro when complexity is high", () => {
    const route = routeModel({ purpose: "reply", complexity: "high" });
    assert.equal(route.model, "deepseek-v4-pro");
    assert.deepEqual(route.thinking, { type: "enabled" });
  });

  test("think channels omit temperature entirely (dead param under thinking)", () => {
    // 官方协议:thinking 开启时 temperature 静默无效。三个 think 通道必须不携带该键,
    // 否则既传了死参数、又会在协议变严时变成 400。
    for (const purpose of ["plan", "review", "repair"]) {
      const route = routeModel({ purpose });
      assert.equal("temperature" in route, false, `${purpose} routeModel must not carry temperature`);
      assert.equal(route.temperature, undefined);
      assert.equal(route.reasoning_effort, "high");
      assert.deepEqual(route.thinking, { type: "enabled" });

      const params = buildChannelParams({ purpose });
      assert.equal("temperature" in params, false, `${purpose} buildChannelParams must not carry temperature`);
      assert.equal(params.reasoning_effort, "high");
      assert.deepEqual(params.thinking, { type: "enabled" });
      // v1.9 M4 #9:think 通道 max_tokens 抬到 32768(官方 thinking 默认 64K 之下留余量)。
      assert.equal(params.max_tokens, 32768);
      assert.deepEqual(Object.keys(params).sort(), ["max_tokens", "model", "reasoning_effort", "thinking"].sort());
    }
    // 复杂 reply 走 plan 通道,同样不得漏出 temperature
    const complex = buildChannelParams({ purpose: "reply", complexity: "high" });
    assert.equal("temperature" in complex, false);
    assert.equal(complex.reasoning_effort, "high");
  });

  test("non-thinking channels keep temperature pinned", () => {
    // 钉住回归:reply/act 是 sampling 通道,temperature 必须原样保留。
    assert.equal(routeModel({ purpose: "reply" }).temperature, 0.2);
    assert.equal(routeModel({ purpose: "act" }).temperature, 0.1);
    assert.equal(buildChannelParams({ purpose: "reply" }).temperature, 0.2);
    assert.equal(buildChannelParams({ purpose: "act" }).temperature, 0.1);
    assert.equal(buildChannelParams({ purpose: "reply" }).reasoning_effort, undefined);
    assert.equal("reasoning_effort" in buildChannelParams({ purpose: "act" }), false);
  });

  test("routes fim to beta completion profile without thinking", () => {
    const route = routeModel({ purpose: "fim" });
    assert.equal(route.channel, "fim");
    assert.equal(route.model, "deepseek-flash");
    assert.equal(route.max_tokens, 4096);
    assert.equal(route.thinking, undefined);
  });

  test("explicit model overrides routed model but keeps channel settings", () => {
    const route = routeModel({ purpose: "reply", explicitModel: "deepseek-v4-pro" });
    assert.equal(route.model, "deepseek-v4-pro");
    assert.deepEqual(route.thinking, { type: "disabled" });
  });

  test("buildChannelParams removes undefined fields", () => {
    const params = buildChannelParams({ purpose: "fim" });
    assert.deepEqual(Object.keys(params).sort(), ["max_tokens", "model"].sort());
  });

  test("models option overrides channel default models", () => {
    const models = { act: "custom-act", think: "custom-think", fim: "custom-fim" };
    assert.equal(routeModel({ purpose: "act", models }).model, "custom-act");
    assert.equal(routeModel({ purpose: "plan", models }).model, "custom-think");
    assert.equal(routeModel({ purpose: "fim", models }).model, "custom-fim");
    assert.equal(routeModel({ purpose: "act" }).model, "deepseek-flash"); // 默认不变
  });

  test("partial models override keeps other channel defaults", () => {
    const route = routeModel({ purpose: "plan", models: { act: "only-act" } });
    assert.equal(route.model, "deepseek-v4-pro");
    assert.equal(routeModel({ purpose: "act", models: { act: "only-act" } }).model, "only-act");
  });

  test("explicitModel still wins over configured models", () => {
    assert.equal(routeModel({ purpose: "act", models: { act: "cfg" }, explicitModel: "explicit" }).model, "explicit");
  });
});
