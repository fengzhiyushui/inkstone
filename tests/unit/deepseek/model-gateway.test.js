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

function jsonResponse(status, payload) { return { ok: status >= 200 && status < 300, status, json: async () => payload, text: async () => JSON.stringify(payload) }; }
function streamResponse(chunks) { return { ok: true, status: 200, text: async () => "", body: new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); } }) }; }
