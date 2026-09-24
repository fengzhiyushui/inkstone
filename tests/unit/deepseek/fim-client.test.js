import test from "node:test";
import assert from "node:assert/strict";
import { buildFimRequest, createFimClient, resolveBetaCompletionsUrl } from "../../../src/deepseek/fim-client.js";
import { normalizeToolCalls, parseToolArguments } from "../../../src/deepseek/tool-call-repair.js";

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
