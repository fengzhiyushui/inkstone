import test from "node:test";
import assert from "node:assert/strict";
import { assembleReplyMessages } from "../../../src/deepseek/prompt-assembler.js";
import { createDeepSeekGateway } from "../../../src/deepseek/model-gateway.js";

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
