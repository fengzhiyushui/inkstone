# V2-1 DeepSeek Gateway Implementation Plan

> 完成状态以 [CHANGELOG](../../CHANGELOG.md) 为准。


**Goal:** Build a DeepSeek-native model gateway for V2 that supports Flash/Pro routing, explicit JSON mode, SSE streaming, tool-call payload preservation, FIM completion, cache-aware usage tracking, API error classification, and V2 runtime interruption.

**Architecture:** This phase adds `src/deepseek/*` as the only DeepSeek API adaptation layer and wires it into the V2 public kernel facade. The V2 runtime still runs a single-turn reply loop in this phase; tools, edits, approvals, and repair loops remain separate later phases. The gateway accepts injected `fetch` and optional config so every behavior can be tested without network access.

**Tech Stack:** Node.js >= 20, ESM, built-in `fetch`, `ReadableStream`, `AbortSignal`, `node:test`, `node:assert/strict`, no new runtime dependencies.

---

## Scope Boundary

Implement V2-1 from `docs/specs/architecture/2026-05-30-deepseek-code-v2-clean-runtime-design.md`:

- Model routing for `reply`, `plan`, `act`, `review`, `repair`, and `fim`.
- DeepSeek request body construction for chat, streaming chat, JSON mode, tool calls, and FIM.
- Explicit JSON mode guard: `response_format: { type: "json_object" }` is only added when the prompt already contains `json`.
- SSE parser that handles `data: ...`, `data: [DONE]`, chunk boundaries, reasoning deltas, usage chunks, and streamed tool-call deltas.
- Usage tracker with DeepSeek cache token fields.
- API error formatting and retryability classification.
- FIM request builder and client for `https://api.deepseek.com/beta/completions`.
- Public kernel integration so `createKernel(root, { deepseek })` can create a real gateway, while tests can still inject a mock `modelGateway`.
- Syntax check script update.

This plan does not implement tool execution, diff application, approval UI, persistent sessions, CLI migration, TUI migration, or GUI migration.

## Official DeepSeek Constraints

Use these docs while implementing:

- Chat Completion: https://api-docs.deepseek.com/api/create-chat-completion
- Tool Calls: https://api-docs.deepseek.com/guides/tool_calls
- JSON Output: https://api-docs.deepseek.com/guides/json_mode/
- FIM Completion: https://api-docs.deepseek.com/api/create-completion

Required behavior:

- Chat models are `deepseek-v4-flash` and `deepseek-v4-pro`.
- Thinking mode is controlled with `thinking: { type: "enabled" }` or `thinking: { type: "disabled" }`.
- `stream: true` returns Server-Sent Events lines beginning with `data:`, ending with `data: [DONE]`.
- Streamed usage requires `stream_options: { include_usage: true }`.
- JSON Output requires `response_format: { type: "json_object" }` and a prompt that explicitly contains `json`.
- Tool call arguments are JSON strings produced by the model and must be preserved, not executed in this phase.
- Usage includes `prompt_cache_hit_tokens`, `prompt_cache_miss_tokens`, and `completion_tokens_details.reasoning_tokens`.
- FIM uses the beta `/completions` endpoint with `prompt`, optional `suffix`, and no thinking mode.

## File Structure

Create:

```text
src/deepseek/model-router.js
src/deepseek/json-mode.js
src/deepseek/usage-tracker.js
src/deepseek/api-errors.js
src/deepseek/streaming.js
src/deepseek/fim-client.js
src/deepseek/tool-call-repair.js
src/deepseek/prompt-assembler.js
src/deepseek/model-gateway.js
tests/unit/deepseek/model-router.test.js
tests/unit/deepseek/json-mode.test.js
tests/unit/deepseek/usage-tracker.test.js
tests/unit/deepseek/api-errors.test.js
tests/unit/deepseek/streaming.test.js
tests/unit/deepseek/fim-client.test.js
tests/unit/deepseek/model-gateway.test.js
tests/integration/v2-deepseek-gateway-runtime.test.js
```

Modify:

```text
src/index.js
package.json
```

Responsibility map:

- `model-router.js`: pure channel profile selection and request parameter defaults.
- `json-mode.js`: prompt inspection and safe opt-in JSON Output body mutation.
- `usage-tracker.js`: in-memory usage aggregation with cache hit/miss accounting.
- `api-errors.js`: normalized DeepSeek error messages and retryability decisions.
- `streaming.js`: pure SSE parsing helpers and streamed chat response assembly.
- `fim-client.js`: FIM request body construction and beta endpoint invocation.
- `tool-call-repair.js`: safe parsing and normalization of model-produced tool calls.
- `prompt-assembler.js`: converts V2 runtime turn inputs into stable DeepSeek messages.
- `model-gateway.js`: high-level DeepSeek gateway with `reply`, `invoke`, `stream`, `fimComplete`, and `getUsageStats`.
- `src/index.js`: creates default V2 gateway when real DeepSeek config is present; preserves mock injection.

---

### Task 1: Model Router

**Files:**
- Create: `src/deepseek/model-router.js`
- Test: `tests/unit/deepseek/model-router.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/unit/deepseek/model-router.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { routeModel, buildChannelParams } from "../../../src/deepseek/model-router.js";

test("routes reply and act to flash with thinking disabled", () => {
  assert.deepEqual(routeModel({ purpose: "reply" }), {
    purpose: "reply",
    channel: "act",
    model: "deepseek-v4-flash",
    thinking: { type: "disabled" },
    temperature: 0.2,
    max_tokens: 4096,
    stream: true
  });

  assert.equal(routeModel({ purpose: "act" }).model, "deepseek-v4-flash");
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

test("routes fim to beta completion profile without thinking", () => {
  const route = routeModel({ purpose: "fim" });
  assert.equal(route.channel, "fim");
  assert.equal(route.model, "deepseek-v4-flash");
  assert.equal(route.max_tokens, 512);
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
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm.cmd test -- tests/unit/deepseek/model-router.test.js
```

Expected:

```text
ERR_MODULE_NOT_FOUND
```

- [ ] **Step 3: Write minimal implementation**

```js
// src/deepseek/model-router.js
const CHANNELS = {
  reply: {
    purpose: "reply",
    channel: "act",
    model: "deepseek-v4-flash",
    thinking: { type: "disabled" },
    temperature: 0.2,
    max_tokens: 4096,
    stream: true
  },
  act: {
    purpose: "act",
    channel: "act",
    model: "deepseek-v4-flash",
    thinking: { type: "disabled" },
    temperature: 0.1,
    max_tokens: 4096,
    stream: true
  },
  plan: {
    purpose: "plan",
    channel: "think",
    model: "deepseek-v4-pro",
    thinking: { type: "enabled" },
    reasoning_effort: "high",
    temperature: 0.2,
    max_tokens: 8192,
    stream: false
  },
  review: {
    purpose: "review",
    channel: "think",
    model: "deepseek-v4-pro",
    thinking: { type: "enabled" },
    reasoning_effort: "high",
    temperature: 0.2,
    max_tokens: 8192,
    stream: false
  },
  repair: {
    purpose: "repair",
    channel: "think",
    model: "deepseek-v4-pro",
    thinking: { type: "enabled" },
    reasoning_effort: "high",
    temperature: 0.1,
    max_tokens: 8192,
    stream: false
  },
  fim: {
    purpose: "fim",
    channel: "fim",
    model: "deepseek-v4-flash",
    max_tokens: 512
  }
};

export function routeModel({ purpose = "reply", complexity = "normal", explicitModel = null } = {}) {
  const key = purpose === "reply" && complexity === "high" ? "plan" : purpose;
  const profile = CHANNELS[key];
  if (!profile) {
    throw new Error(`unknown DeepSeek purpose: ${purpose}`);
  }
  return removeUndefined({
    ...profile,
    purpose,
    model: explicitModel || profile.model
  });
}

export function buildChannelParams(input = {}) {
  const route = routeModel(input);
  return removeUndefined({
    model: route.model,
    thinking: route.thinking,
    reasoning_effort: route.reasoning_effort,
    temperature: route.temperature,
    max_tokens: route.max_tokens
  });
}

export function removeUndefined(record) {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined)
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
npm.cmd test -- tests/unit/deepseek/model-router.test.js
```

Expected:

```text
# pass 6
# fail 0
```

- [ ] **Step 5: Commit**

```powershell
git add src/deepseek/model-router.js tests/unit/deepseek/model-router.test.js
git commit -m "feat(v2): add DeepSeek model router"
```

---

### Task 2: JSON Mode Guard

**Files:**
- Create: `src/deepseek/json-mode.js`
- Test: `tests/unit/deepseek/json-mode.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/unit/deepseek/json-mode.test.js
import test from "node:test";
import assert from "node:assert/strict";
import {
  promptMentionsJson,
  applyJsonMode,
  parseJsonContent
} from "../../../src/deepseek/json-mode.js";

test("detects json in system or user messages case-insensitively", () => {
  assert.equal(promptMentionsJson([{ role: "system", content: "Return JSON only." }]), true);
  assert.equal(promptMentionsJson([{ role: "user", content: "plain chat" }]), false);
});

test("does not add response_format when JSON mode is disabled", () => {
  const body = applyJsonMode({
    body: { model: "deepseek-v4-flash" },
    messages: [{ role: "user", content: "hello" }],
    jsonMode: false
  });
  assert.equal(body.response_format, undefined);
});

test("adds response_format only when prompt includes json", () => {
  const body = applyJsonMode({
    body: { model: "deepseek-v4-pro" },
    messages: [{ role: "user", content: "Return a json object with key answer." }],
    jsonMode: true
  });
  assert.deepEqual(body.response_format, { type: "json_object" });
});

test("throws a clear error when JSON mode prompt lacks json", () => {
  assert.throws(
    () => applyJsonMode({
      body: { model: "deepseek-v4-pro" },
      messages: [{ role: "user", content: "Return an object." }],
      jsonMode: true
    }),
    /JSON mode requires/
  );
});

test("parseJsonContent parses object and annotates invalid JSON errors", () => {
  assert.deepEqual(parseJsonContent("{\"answer\":42}"), { answer: 42 });
  assert.throws(() => parseJsonContent("{bad"), /invalid DeepSeek JSON content/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm.cmd test -- tests/unit/deepseek/json-mode.test.js
```

Expected:

```text
ERR_MODULE_NOT_FOUND
```

- [ ] **Step 3: Write minimal implementation**

```js
// src/deepseek/json-mode.js
export function promptMentionsJson(messages = []) {
  return messages.some((message) => {
    const content = typeof message.content === "string" ? message.content : "";
    return /\bjson\b/i.test(content);
  });
}

export function applyJsonMode({ body, messages, jsonMode = false }) {
  const next = { ...body };
  if (!jsonMode) {
    delete next.response_format;
    return next;
  }
  if (!promptMentionsJson(messages)) {
    throw new Error("JSON mode requires a system or user prompt containing the word json");
  }
  next.response_format = { type: "json_object" };
  return next;
}

export function parseJsonContent(content) {
  try {
    return JSON.parse(content);
  } catch (error) {
    const err = new Error(`invalid DeepSeek JSON content: ${error.message}`);
    err.code = "DEEPSEEK_INVALID_JSON";
    err.cause = error;
    throw err;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
npm.cmd test -- tests/unit/deepseek/json-mode.test.js
```

Expected:

```text
# pass 5
# fail 0
```

- [ ] **Step 5: Commit**

```powershell
git add src/deepseek/json-mode.js tests/unit/deepseek/json-mode.test.js
git commit -m "feat(v2): add explicit DeepSeek JSON mode guard"
```

---

### Task 3: Usage Tracker and API Errors

**Files:**
- Create: `src/deepseek/usage-tracker.js`
- Create: `src/deepseek/api-errors.js`
- Test: `tests/unit/deepseek/usage-tracker.test.js`
- Test: `tests/unit/deepseek/api-errors.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// tests/unit/deepseek/usage-tracker.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { createUsageTracker } from "../../../src/deepseek/usage-tracker.js";

test("usage tracker records prompt completion reasoning and cache tokens", () => {
  const tracker = createUsageTracker();

  tracker.recordUsage({
    channel: "think",
    model: "deepseek-v4-pro",
    latency_ms: 120,
    usage: {
      prompt_tokens: 100,
      completion_tokens: 30,
      total_tokens: 130,
      prompt_cache_hit_tokens: 70,
      prompt_cache_miss_tokens: 30,
      completion_tokens_details: { reasoning_tokens: 12 }
    }
  });

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
  tracker.recordUsage({
    channel: "act",
    model: "deepseek-v4-flash",
    usage: {
      prompt_tokens: 50,
      completion_tokens: 10,
      prompt_tokens_details: { cached_tokens: 20 }
    }
  });

  const stats = tracker.getUsageStats();
  assert.equal(stats.cache_hit_tokens, 20);
  assert.equal(stats.cache_miss_tokens, 30);
});
```

```js
// tests/unit/deepseek/api-errors.test.js
import test from "node:test";
import assert from "node:assert/strict";
import {
  createDeepSeekApiError,
  formatDeepSeekApiError,
  isRetryableDeepSeekError
} from "../../../src/deepseek/api-errors.js";

test("formats JSON API errors without leaking large bodies", () => {
  const message = formatDeepSeekApiError(401, "{\"error\":{\"message\":\"bad key\"}}");
  assert.equal(message, "DeepSeek API 401: bad key");
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

test("createDeepSeekApiError returns annotated Error", () => {
  const error = createDeepSeekApiError(403, "{\"message\":\"forbidden\"}");
  assert.equal(error.name, "DeepSeekApiError");
  assert.equal(error.status, 403);
  assert.equal(error.code, "DEEPSEEK_API_ERROR");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
npm.cmd test -- tests/unit/deepseek/usage-tracker.test.js tests/unit/deepseek/api-errors.test.js
```

Expected:

```text
ERR_MODULE_NOT_FOUND
```

- [ ] **Step 3: Write minimal implementation**

```js
// src/deepseek/usage-tracker.js
export function createUsageTracker() {
  const store = {
    requests: 0,
    total_prompt_tokens: 0,
    total_completion_tokens: 0,
    total_reasoning_tokens: 0,
    total_tokens: 0,
    cache_hit_tokens: 0,
    cache_miss_tokens: 0,
    total_latency_ms: 0,
    by_channel: {},
    by_model: {}
  };

  function recordUsage({ usage = null, channel = "unknown", model = "unknown", latency_ms = 0 } = {}) {
    if (!usage) return;

    const promptTokens = usage.prompt_tokens || 0;
    const completionTokens = usage.completion_tokens || 0;
    const totalTokens = usage.total_tokens || promptTokens + completionTokens;
    const cacheHit = usage.prompt_cache_hit_tokens
      ?? usage.prompt_tokens_details?.cached_tokens
      ?? 0;
    const cacheMiss = usage.prompt_cache_miss_tokens
      ?? Math.max(0, promptTokens - cacheHit);
    const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens || 0;

    store.requests += 1;
    store.total_prompt_tokens += promptTokens;
    store.total_completion_tokens += completionTokens;
    store.total_reasoning_tokens += reasoningTokens;
    store.total_tokens += totalTokens;
    store.cache_hit_tokens += cacheHit;
    store.cache_miss_tokens += cacheMiss;
    store.total_latency_ms += latency_ms || 0;

    bump(store.by_channel, channel, promptTokens, completionTokens, totalTokens);
    bump(store.by_model, model, promptTokens, completionTokens, totalTokens);
  }

  function getUsageStats() {
    const cacheTotal = store.cache_hit_tokens + store.cache_miss_tokens;
    return {
      requests: store.requests,
      total_prompt_tokens: store.total_prompt_tokens,
      total_completion_tokens: store.total_completion_tokens,
      total_reasoning_tokens: store.total_reasoning_tokens,
      total_tokens: store.total_tokens,
      cache_hit_tokens: store.cache_hit_tokens,
      cache_miss_tokens: store.cache_miss_tokens,
      cache_hit_rate: cacheTotal > 0 ? round(store.cache_hit_tokens / cacheTotal) : 0,
      avg_latency_ms: store.requests > 0 ? Math.round(store.total_latency_ms / store.requests) : 0,
      by_channel: clone(store.by_channel),
      by_model: clone(store.by_model)
    };
  }

  return { recordUsage, getUsageStats };
}

function bump(bucket, key, promptTokens, completionTokens, totalTokens) {
  if (!bucket[key]) {
    bucket[key] = {
      requests: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0
    };
  }
  bucket[key].requests += 1;
  bucket[key].prompt_tokens += promptTokens;
  bucket[key].completion_tokens += completionTokens;
  bucket[key].total_tokens += totalTokens;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function round(value) {
  return Math.round(value * 10000) / 10000;
}
```

```js
// src/deepseek/api-errors.js
export function formatDeepSeekApiError(status, text = "") {
  const parsed = parseErrorBody(text);
  const message = parsed?.error?.message || parsed?.message || truncate(String(text || ""));
  return `DeepSeek API ${status}: ${message || "request failed"}`;
}

export function createDeepSeekApiError(status, text = "") {
  const error = new Error(formatDeepSeekApiError(status, text));
  error.name = "DeepSeekApiError";
  error.code = "DEEPSEEK_API_ERROR";
  error.status = status;
  error.retryable = isRetryableDeepSeekError({ status });
  return error;
}

export function isRetryableDeepSeekError(errorLike = {}) {
  if (errorLike.finish_reason === "insufficient_system_resource") return true;
  return [408, 409, 425, 429, 500, 502, 503, 504].includes(errorLike.status);
}

function parseErrorBody(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function truncate(text) {
  return text.length > 220 ? `${text.slice(0, 220)}...` : text;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```powershell
npm.cmd test -- tests/unit/deepseek/usage-tracker.test.js tests/unit/deepseek/api-errors.test.js
```

Expected:

```text
# pass 6
# fail 0
```

- [ ] **Step 5: Commit**

```powershell
git add src/deepseek/usage-tracker.js src/deepseek/api-errors.js tests/unit/deepseek/usage-tracker.test.js tests/unit/deepseek/api-errors.test.js
git commit -m "feat(v2): track DeepSeek usage and API errors"
```

---

### Task 4: SSE Streaming Parser

**Files:**
- Create: `src/deepseek/streaming.js`
- Test: `tests/unit/deepseek/streaming.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/unit/deepseek/streaming.test.js
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSseBuffer,
  readDeepSeekStream
} from "../../../src/deepseek/streaming.js";

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
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    }
  });

  const result = await readDeepSeekStream(stream, {
    onDelta: (text) => deltas.push(text)
  });

  assert.equal(result.content, "hello");
  assert.equal(result.reasoning_content, "hidden");
  assert.equal(result.finish_reason, "tool_calls");
  assert.deepEqual(deltas, ["hel", "lo"]);
  assert.equal(result.usage.prompt_cache_hit_tokens, 7);
  assert.equal(result.tool_calls[0].id, "call_1");
  assert.equal(result.tool_calls[0].function.name, "read");
  assert.equal(result.tool_calls[0].function.arguments, "{\"path\":\"README.md\"}");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm.cmd test -- tests/unit/deepseek/streaming.test.js
```

Expected:

```text
ERR_MODULE_NOT_FOUND
```

- [ ] **Step 3: Write minimal implementation**

```js
// src/deepseek/streaming.js
export function parseSseBuffer(buffer) {
  const lines = buffer.split(/\r?\n/);
  const remainder = lines.pop() || "";
  const events = [];
  let done = false;

  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    if (data === "[DONE]") {
      done = true;
      continue;
    }
    events.push(JSON.parse(data));
  }

  return { events, done, remainder };
}

export async function readDeepSeekStream(body, { onDelta = null, signal = null } = {}) {
  if (!body || typeof body.getReader !== "function") {
    throw new Error("DeepSeek stream response body is not readable");
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoningContent = "";
  let usage = null;
  let finishReason = null;
  const toolCalls = [];

  while (true) {
    if (signal?.aborted) {
      await reader.cancel().catch(() => {});
      throw abortError();
    }

    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const parsed = parseSseBuffer(buffer);
    buffer = parsed.remainder;

    for (const event of parsed.events) {
      if (event.usage) usage = event.usage;
      const choice = event.choices?.[0];
      if (!choice) continue;

      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta || {};

      if (delta.content) {
        content += delta.content;
        if (onDelta) onDelta(delta.content);
      }
      if (delta.reasoning_content) {
        reasoningContent += delta.reasoning_content;
      }
      if (Array.isArray(delta.tool_calls)) {
        mergeToolCallDeltas(toolCalls, delta.tool_calls);
      }
    }

    if (parsed.done) break;
  }

  return {
    content,
    reasoning_content: reasoningContent || null,
    usage,
    finish_reason: finishReason,
    tool_calls: toolCalls
  };
}

function mergeToolCallDeltas(target, deltas) {
  for (const delta of deltas) {
    const index = delta.index ?? target.length;
    if (!target[index]) {
      target[index] = {
        id: delta.id || null,
        type: delta.type || "function",
        function: { name: "", arguments: "" }
      };
    }
    const call = target[index];
    if (delta.id) call.id = delta.id;
    if (delta.type) call.type = delta.type;
    if (delta.function?.name) call.function.name += delta.function.name;
    if (delta.function?.arguments) call.function.arguments += delta.function.arguments;
  }
}

function abortError() {
  const error = new Error("DeepSeek stream was aborted");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
npm.cmd test -- tests/unit/deepseek/streaming.test.js
```

Expected:

```text
# pass 3
# fail 0
```

- [ ] **Step 5: Commit**

```powershell
git add src/deepseek/streaming.js tests/unit/deepseek/streaming.test.js
git commit -m "feat(v2): parse DeepSeek streaming responses"
```

---

### Task 5: FIM Client and Tool Call Repair

**Files:**
- Create: `src/deepseek/fim-client.js`
- Create: `src/deepseek/tool-call-repair.js`
- Test: `tests/unit/deepseek/fim-client.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/unit/deepseek/fim-client.test.js
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFimRequest,
  createFimClient
} from "../../../src/deepseek/fim-client.js";
import {
  normalizeToolCalls,
  parseToolArguments
} from "../../../src/deepseek/tool-call-repair.js";

test("buildFimRequest creates beta completion body without chat-only fields", () => {
  const body = buildFimRequest({
    prefix: "function add(a, b) {",
    suffix: "}",
    model: "deepseek-v4-flash",
    maxTokens: 256
  });

  assert.deepEqual(body, {
    model: "deepseek-v4-flash",
    prompt: "function add(a, b) {",
    suffix: "}",
    max_tokens: 256
  });
  assert.equal(body.thinking, undefined);
  assert.equal(body.response_format, undefined);
});

test("fim client posts to beta completions endpoint and returns text", async () => {
  const calls = [];
  const client = createFimClient({
    apiKey: "key",
    baseUrl: "https://api.deepseek.com",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(200, {
        choices: [{ text: " return a + b; " }],
        usage: { prompt_tokens: 10, completion_tokens: 4 }
      });
    }
  });

  const result = await client.complete({
    prefix: "function add(a, b) {",
    suffix: "}"
  });

  assert.equal(result.content, " return a + b; ");
  assert.equal(calls[0].url, "https://api.deepseek.com/beta/completions");
  assert.equal(JSON.parse(calls[0].init.body).prompt, "function add(a, b) {");
});

test("normalizeToolCalls preserves raw argument strings and parsed arguments", () => {
  const calls = normalizeToolCalls([{
    id: "call_1",
    type: "function",
    function: { name: "read", arguments: "{\"path\":\"README.md\"}" }
  }]);

  assert.equal(calls[0].name, "read");
  assert.deepEqual(calls[0].arguments, { path: "README.md" });
  assert.equal(calls[0].raw_arguments, "{\"path\":\"README.md\"}");
});

test("parseToolArguments marks invalid JSON without throwing", () => {
  const parsed = parseToolArguments("{bad");
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /Unexpected/);
});

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload)
  };
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm.cmd test -- tests/unit/deepseek/fim-client.test.js
```

Expected:

```text
ERR_MODULE_NOT_FOUND
```

- [ ] **Step 3: Write minimal implementation**

```js
// src/deepseek/fim-client.js
import { createDeepSeekApiError } from "./api-errors.js";

export function buildFimRequest({
  prefix,
  suffix = "",
  model = "deepseek-v4-flash",
  maxTokens = 512
} = {}) {
  if (typeof prefix !== "string" || prefix.length === 0) {
    throw new Error("FIM prefix must be a non-empty string");
  }
  return removeUndefined({
    model,
    prompt: prefix,
    suffix,
    max_tokens: maxTokens
  });
}

export function createFimClient({
  apiKey,
  baseUrl = "https://api.deepseek.com",
  fetchImpl = globalThis.fetch
} = {}) {
  async function complete({ prefix, suffix = "", model, maxTokens, signal } = {}) {
    const body = buildFimRequest({ prefix, suffix, model, maxTokens });
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/beta/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal
    });

    if (!response.ok) {
      throw createDeepSeekApiError(response.status, await response.text().catch(() => ""));
    }

    const payload = await response.json();
    return {
      content: payload.choices?.[0]?.text || "",
      usage: payload.usage || null,
      model: body.model,
      channel: "fim"
    };
  }

  return { complete };
}

function removeUndefined(record) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}
```

```js
// src/deepseek/tool-call-repair.js
export function parseToolArguments(raw) {
  if (raw === "" || raw === undefined || raw === null) {
    return { ok: true, value: {} };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (error) {
    return { ok: false, value: null, error: error.message };
  }
}

export function normalizeToolCalls(toolCalls = []) {
  return toolCalls.map((call, index) => {
    const rawArguments = call.function?.arguments || "";
    const parsed = parseToolArguments(rawArguments);
    return {
      id: call.id || `tool_call_${index}`,
      type: call.type || "function",
      name: call.function?.name || "",
      arguments: parsed.ok ? parsed.value : null,
      raw_arguments: rawArguments,
      arguments_parse_error: parsed.ok ? null : parsed.error
    };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
npm.cmd test -- tests/unit/deepseek/fim-client.test.js
```

Expected:

```text
# pass 4
# fail 0
```

- [ ] **Step 5: Commit**

```powershell
git add src/deepseek/fim-client.js src/deepseek/tool-call-repair.js tests/unit/deepseek/fim-client.test.js
git commit -m "feat(v2): add DeepSeek FIM and tool-call normalization"
```

---

### Task 6: Prompt Assembler and Model Gateway

**Files:**
- Create: `src/deepseek/prompt-assembler.js`
- Create: `src/deepseek/model-gateway.js`
- Test: `tests/unit/deepseek/model-gateway.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/unit/deepseek/model-gateway.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { assembleReplyMessages } from "../../../src/deepseek/prompt-assembler.js";
import { createDeepSeekGateway } from "../../../src/deepseek/model-gateway.js";

test("assembleReplyMessages uses stable system prefix and current user suffix", () => {
  const messages = assembleReplyMessages({
    message: "What is this project?",
    classification: { task_type: "query" },
    context: { summary: "Node project" }
  });

  assert.equal(messages[0].role, "system");
  assert.match(messages[0].content, /DeepSeek Code/);
  assert.match(messages[0].content, /Node project/);
  assert.deepEqual(messages.at(-1), { role: "user", content: "What is this project?" });
});

test("buildChatRequest keeps plain reply out of JSON mode", () => {
  const gateway = createDeepSeekGateway({ apiKey: "key" });
  const request = gateway.buildChatRequest(
    [{ role: "user", content: "hello" }],
    { purpose: "reply", stream: false }
  );

  assert.equal(request.body.model, "deepseek-v4-flash");
  assert.equal(request.body.response_format, undefined);
  assert.deepEqual(request.body.thinking, { type: "disabled" });
});

test("buildChatRequest enables JSON mode only when requested and prompted", () => {
  const gateway = createDeepSeekGateway({ apiKey: "key" });
  const request = gateway.buildChatRequest(
    [{ role: "user", content: "Return json: {\"ok\":true}" }],
    { purpose: "plan", jsonMode: true }
  );

  assert.equal(request.body.model, "deepseek-v4-pro");
  assert.deepEqual(request.body.response_format, { type: "json_object" });
  assert.deepEqual(request.body.thinking, { type: "enabled" });
});

test("invoke posts non-streaming chat request and records usage", async () => {
  const calls = [];
  const gateway = createDeepSeekGateway({
    apiKey: "key",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(200, {
        choices: [{
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: "hello back",
            reasoning_content: "hidden"
          }
        }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 2,
          prompt_cache_hit_tokens: 4,
          prompt_cache_miss_tokens: 6
        }
      });
    }
  });

  const result = await gateway.invoke([{ role: "user", content: "hello" }], {
    purpose: "reply"
  });

  assert.equal(result.content, "hello back");
  assert.equal(result.reasoning_content, "hidden");
  assert.equal(calls[0].url, "https://api.deepseek.com/chat/completions");
  assert.equal(JSON.parse(calls[0].init.body).stream, false);
  assert.equal(gateway.getUsageStats().cache_hit_tokens, 4);
});

test("stream uses SSE parser and onDelta callback", async () => {
  const gateway = createDeepSeekGateway({
    apiKey: "key",
    fetchImpl: async () => streamResponse([
      "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"},\"finish_reason\":null,\"index\":0}],\"usage\":null}\n\n",
      "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1,\"prompt_cache_hit_tokens\":1,\"prompt_cache_miss_tokens\":0}}\n\n",
      "data: [DONE]\n\n"
    ])
  });

  const deltas = [];
  const result = await gateway.stream([{ role: "user", content: "hello" }], {
    purpose: "reply",
    onDelta: (text) => deltas.push(text)
  });

  assert.equal(result.content, "hi");
  assert.deepEqual(deltas, ["hi"]);
  assert.equal(gateway.getUsageStats().cache_hit_tokens, 1);
});

test("reply uses assembled messages and returns content", async () => {
  const gateway = createDeepSeekGateway({
    apiKey: "key",
    fetchImpl: async () => jsonResponse(200, {
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "project answer" } }],
      usage: { prompt_tokens: 4, completion_tokens: 2, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 4 }
    })
  });

  const result = await gateway.reply({
    message: "what is this?",
    classification: { task_type: "query" }
  });

  assert.equal(result.content, "project answer");
});

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload)
  };
}

function streamResponse(chunks) {
  return {
    ok: true,
    status: 200,
    text: async () => "",
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      }
    })
  };
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm.cmd test -- tests/unit/deepseek/model-gateway.test.js
```

Expected:

```text
ERR_MODULE_NOT_FOUND
```

- [ ] **Step 3: Write minimal implementation**

```js
// src/deepseek/prompt-assembler.js
export function assembleReplyMessages({
  message,
  classification = null,
  context = null,
  systemAddendum = ""
} = {}) {
  const contextSummary = context?.summary ? `\nProject context:\n${context.summary}` : "";
  const taskType = classification?.task_type || "general";
  return [
    {
      role: "system",
      content: [
        "You are DeepSeek Code, a local coding agent optimized for DeepSeek models.",
        "Answer plainly for query tasks. Do not output JSON unless explicitly requested.",
        `Current task type: ${taskType}.`,
        contextSummary,
        systemAddendum
      ].filter(Boolean).join("\n")
    },
    { role: "user", content: String(message || "") }
  ];
}
```

```js
// src/deepseek/model-gateway.js
import { routeModel, buildChannelParams, removeUndefined } from "./model-router.js";
import { applyJsonMode } from "./json-mode.js";
import { createUsageTracker } from "./usage-tracker.js";
import { createDeepSeekApiError, isRetryableDeepSeekError } from "./api-errors.js";
import { readDeepSeekStream } from "./streaming.js";
import { createFimClient } from "./fim-client.js";
import { normalizeToolCalls } from "./tool-call-repair.js";
import { assembleReplyMessages } from "./prompt-assembler.js";

export function createDeepSeekGateway({
  apiKey = process.env.DEEPSEEK_API_KEY || "",
  baseUrl = "https://api.deepseek.com",
  fetchImpl = globalThis.fetch,
  userId = null
} = {}) {
  const usageTracker = createUsageTracker();
  const fimClient = createFimClient({ apiKey, baseUrl, fetchImpl });

  function buildChatRequest(messages, options = {}) {
    const route = routeModel(options);
    const body = applyJsonMode({
      messages,
      jsonMode: Boolean(options.jsonMode),
      body: removeUndefined({
        ...buildChannelParams(options),
        messages,
        stream: Boolean(options.stream ?? route.stream),
        tools: options.tools,
        tool_choice: options.toolChoice,
        user_id: userId
      })
    });

    if (body.stream) {
      body.stream_options = { include_usage: true };
    }

    return {
      url: `${baseUrl.replace(/\/+$/, "")}/chat/completions`,
      body,
      route
    };
  }

  async function invoke(messages, options = {}) {
    const request = buildChatRequest(messages, { ...options, stream: false });
    const started = Date.now();
    const response = await fetchImpl(request.url, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify(request.body),
      signal: options.signal
    });

    const latencyMs = Date.now() - started;
    if (!response.ok) {
      throw createDeepSeekApiError(response.status, await response.text().catch(() => ""));
    }

    const payload = await response.json();
    const processed = processChatPayload(payload, request.route, latencyMs);
    usageTracker.recordUsage({
      usage: processed.usage,
      channel: request.route.channel,
      model: request.body.model,
      latency_ms: latencyMs
    });
    if (isRetryableDeepSeekError({ finish_reason: processed.finish_reason })) {
      processed.retryable = true;
    }
    return processed;
  }

  async function stream(messages, options = {}) {
    const request = buildChatRequest(messages, { ...options, stream: true });
    const started = Date.now();
    const response = await fetchImpl(request.url, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify(request.body),
      signal: options.signal
    });

    const latencyMs = Date.now() - started;
    if (!response.ok) {
      throw createDeepSeekApiError(response.status, await response.text().catch(() => ""));
    }

    const streamed = await readDeepSeekStream(response.body, {
      onDelta: options.onDelta,
      signal: options.signal
    });

    const result = {
      ...streamed,
      model: request.body.model,
      channel: request.route.channel,
      latency_ms: latencyMs,
      tool_calls: normalizeToolCalls(streamed.tool_calls)
    };
    usageTracker.recordUsage({
      usage: result.usage,
      channel: request.route.channel,
      model: request.body.model,
      latency_ms: latencyMs
    });
    return result;
  }

  async function fimComplete(prefix, suffix = "", options = {}) {
    const result = await fimClient.complete({
      prefix,
      suffix,
      model: options.model,
      maxTokens: options.maxTokens,
      signal: options.signal
    });
    usageTracker.recordUsage({
      usage: result.usage,
      channel: "fim",
      model: result.model,
      latency_ms: result.latency_ms || 0
    });
    return result.content;
  }

  async function reply({ message, classification, context, turn, signal, onDelta } = {}) {
    const messages = assembleReplyMessages({ message, classification, context, turn });
    const taskType = classification?.task_type || "general";
    const purpose = taskType === "query" ? "reply" : "plan";
    const result = purpose === "reply"
      ? await invoke(messages, { purpose, signal })
      : await invoke(messages, { purpose, signal });
    if (onDelta && result.content) onDelta(result.content);
    return result;
  }

  return {
    buildChatRequest,
    invoke,
    stream,
    fimComplete,
    reply,
    getUsageStats: usageTracker.getUsageStats
  };
}

function processChatPayload(payload, route, latencyMs) {
  const choice = payload.choices?.[0] || {};
  const message = choice.message || {};
  return {
    content: message.content || "",
    reasoning_content: message.reasoning_content || null,
    reasoning_hidden: true,
    tool_calls: normalizeToolCalls(message.tool_calls || []),
    finish_reason: choice.finish_reason || null,
    usage: payload.usage || null,
    model: payload.model || route.model,
    channel: route.channel,
    latency_ms: latencyMs
  };
}

function authHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json"
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
npm.cmd test -- tests/unit/deepseek/model-gateway.test.js
```

Expected:

```text
# pass 6
# fail 0
```

- [ ] **Step 5: Commit**

```powershell
git add src/deepseek/prompt-assembler.js src/deepseek/model-gateway.js tests/unit/deepseek/model-gateway.test.js
git commit -m "feat(v2): add DeepSeek model gateway"
```

---

### Task 7: Kernel Integration and Runtime Abort Signal

**Files:**
- Modify: `src/core/runtime/agent-runtime.js`
- Modify: `src/index.js`
- Test: `tests/integration/v2-deepseek-gateway-runtime.test.js`

- [ ] **Step 1: Write the failing integration test**

```js
// tests/integration/v2-deepseek-gateway-runtime.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { createKernel } from "../../src/index.js";

test("createKernel creates DeepSeek gateway from options.deepseek", async () => {
  const calls = [];
  const kernel = await createKernel(process.cwd(), {
    sessionId: "sess_deepseek",
    deepseek: {
      apiKey: "key",
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ finish_reason: "stop", message: { role: "assistant", content: "real gateway response" } }],
            usage: { prompt_tokens: 4, completion_tokens: 3, prompt_cache_hit_tokens: 1, prompt_cache_miss_tokens: 3 }
          }),
          text: async () => ""
        };
      }
    }
  });

  const result = await kernel.agent.send("hello");

  assert.equal(result.content, "real gateway response");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.deepseek.com/chat/completions");
  assert.equal(kernel.config.getPublicConfig().has_api_key, true);
});

test("runtime passes AbortSignal to model gateway and aborts on interrupt", async () => {
  let seenSignal = null;
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const kernel = await createKernel(process.cwd(), {
    sessionId: "sess_abort",
    modelGateway: {
      reply: async ({ signal }) => {
        seenSignal = signal;
        await blocked;
        if (signal.aborted) {
          const error = new Error("aborted by test");
          error.name = "AbortError";
          throw error;
        }
        return { content: "late" };
      }
    }
  });

  const pending = kernel.agent.send("long request");
  await new Promise((resolve) => setTimeout(resolve, 20));
  kernel.agent.interrupt();
  release();

  await assert.rejects(() => pending, /turn was interrupted|aborted by test/);
  assert.equal(seenSignal.aborted, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm.cmd test -- tests/integration/v2-deepseek-gateway-runtime.test.js
```

Expected:

```text
not ok
```

At least one assertion fails because `createKernel()` does not build a real DeepSeek gateway, and `agent-runtime` does not pass an `AbortSignal` into `modelGateway.reply()`.

- [ ] **Step 3: Modify runtime to create and pass AbortSignal**

Replace `src/core/runtime/agent-runtime.js` with this version, preserving the existing generation and `currentTurnId` guards:

```js
// src/core/runtime/agent-runtime.js
import { createAgentTurn, addTurnStep, setTurnStatus } from "../protocol/agent-turn.js";
import { createAgentStep, completeAgentStep } from "../protocol/agent-step.js";
import { classifyMessage } from "../planning/classifier.js";
import { createLifecycleState, transitionLifecycle } from "./lifecycle.js";

function publish(eventBus, eventType, data) {
  if (eventBus && typeof eventBus.publish === "function") {
    eventBus.publish(eventType, data);
  }
}

class InterruptedError extends Error {
  constructor(reason = "turn was interrupted") {
    super(reason);
    this.name = "InterruptedError";
    this.code = "INTERRUPTED";
  }
}

export function createAgentRuntime({ eventBus = null, sessionId = `sess_${Date.now()}`, modelGateway = null } = {}) {
  let lifecycle = createLifecycleState();
  let currentTurnId = null;
  let currentAbortController = null;
  let turnGeneration = 0;

  function getState() {
    return { ...lifecycle };
  }

  function assertNotInterrupted(generation) {
    if (turnGeneration !== generation) throw new InterruptedError();
  }

  async function send(message, options = {}) {
    if (currentTurnId) {
      const err = new Error("another turn is in progress");
      err.code = "BUSY";
      throw err;
    }

    const generation = ++turnGeneration;
    currentAbortController = new AbortController();
    let turn = createAgentTurn({
      sessionId,
      userMessage: message,
      autonomy: options.autonomy || "gated"
    });
    currentTurnId = turn.id;

    publish(eventBus, "user:message", {
      turn_id: turn.id,
      content: message,
      options
    });
    publish(eventBus, "agent:turn_started", { turn });

    try {
      lifecycle = transitionLifecycle(lifecycle, {
        to: "classify",
        reason: "user message received",
        channel: "think"
      });
      assertNotInterrupted(generation);

      const classifyStep = createAgentStep({
        turnId: turn.id,
        type: "classify",
        channel: "think"
      });
      const classification = classifyMessage(message, options);
      const completedClassifyStep = completeAgentStep(classifyStep, {
        outputRef: `classification:${classification.task_type}`
      });
      turn = addTurnStep(turn, completedClassifyStep);
      publish(eventBus, "agent:step", {
        turn_id: turn.id,
        step: completedClassifyStep,
        classification
      });
      assertNotInterrupted(generation);

      lifecycle = transitionLifecycle(lifecycle, {
        to: "complete",
        reason: "V2-1 gateway reply",
        channel: "system"
      });
      assertNotInterrupted(generation);

      const finalStep = completeAgentStep(createAgentStep({
        turnId: turn.id,
        type: "final",
        channel: "system"
      }));
      turn = addTurnStep(turn, finalStep);

      const response = modelGateway && typeof modelGateway.reply === "function"
        ? await modelGateway.reply({
            message,
            classification,
            turn,
            options,
            signal: currentAbortController.signal
          })
        : { content: `V2-0 mock ${classification.task_type} response` };

      assertNotInterrupted(generation);

      turn = setTurnStatus(turn, "completed");
      publish(eventBus, "agent:final", {
        turn_id: turn.id,
        content: response.content,
        status: "complete"
      });

      lifecycle = transitionLifecycle(lifecycle, {
        to: "idle",
        reason: "turn complete",
        channel: null
      });
      currentTurnId = null;
      currentAbortController = null;

      return {
        status: "complete",
        state: "idle",
        content: response.content,
        turn
      };
    } catch (error) {
      if (currentTurnId !== turn.id) {
        throw error;
      }

      if (error instanceof InterruptedError || error.name === "AbortError") {
        currentTurnId = null;
        currentAbortController = null;
        lifecycle = transitionLifecycle(lifecycle, {
          to: "idle",
          reason: error.message,
          channel: null
        });
        throw error instanceof InterruptedError ? error : new InterruptedError(error.message);
      }

      lifecycle = transitionLifecycle(lifecycle, {
        to: "failed",
        reason: error.message,
        channel: lifecycle.channel
      });
      publish(eventBus, "agent:error", {
        turn_id: turn.id,
        message: error.message
      });
      currentTurnId = null;
      currentAbortController = null;
      throw error;
    }
  }

  function approve(approvalId, decision) {
    publish(eventBus, "approval:resolved", {
      approval_id: approvalId,
      decision
    });
  }

  function interrupt(turnId = null) {
    turnGeneration += 1;
    if (currentAbortController) {
      currentAbortController.abort();
    }
    currentTurnId = null;
    currentAbortController = null;
    lifecycle = transitionLifecycle(lifecycle, {
      to: "idle",
      reason: turnId ? `turn interrupted: ${turnId}` : "interrupt requested",
      channel: null
    });
  }

  return { send, approve, interrupt, getState };
}
```

- [ ] **Step 4: Modify public kernel facade**

Replace `src/index.js` with:

```js
// src/index.js
import { createEventBus } from "./shared/event-bus.js";
import { createAgentRuntime } from "./core/runtime/agent-runtime.js";
import { SESSION_EVENT_TYPES } from "./sessions/event-types.js";
import { createDeepSeekGateway } from "./deepseek/model-gateway.js";

export async function createKernel(root, options = {}) {
  const eventBus = options.eventBus || createEventBus();
  const sessionId = options.sessionId || `sess_${Date.now()}`;
  const modelGateway = resolveModelGateway(options);
  const runtime = createAgentRuntime({
    eventBus,
    sessionId,
    modelGateway
  });

  const session = {
    subscribe(handler) {
      if (typeof handler !== "function") {
        throw new Error("session subscriber must be a function");
      }

      const subscriptions = SESSION_EVENT_TYPES.map((type) =>
        eventBus.subscribe(type, (data, meta) => {
          handler({ ...data, type, meta });
        })
      );

      return {
        unsubscribe() {
          for (const sub of subscriptions) {
            sub.unsubscribe();
          }
        }
      };
    },

    async getTimeline() {
      return [];
    },

    async resume(resumeSessionId = sessionId) {
      eventBus.publish("session:resume", {
        session_id: resumeSessionId,
        root
      });
    }
  };

  const context = {
    async snapshot() {
      return {
        snapshot_id: "v2_empty_snapshot",
        root,
        units: [],
        budget: { allocated: 0, used: 0 }
      };
    },
    pin(path) {
      eventBus.publish("context:pin", { path });
    },
    unpin(path) {
      eventBus.publish("context:unpin", { path });
    }
  };

  const config = {
    getPublicConfig() {
      return {
        runtime: "v2",
        root,
        has_api_key: Boolean(options.deepseek?.apiKey || process.env.DEEPSEEK_API_KEY)
      };
    },
    updateProjectConfig() {
      throw new Error("project config updates are not available in V2-1");
    }
  };

  return {
    root,
    eventBus,
    runtime,
    agent: {
      send: runtime.send,
      approve: runtime.approve,
      interrupt: runtime.interrupt
    },
    session,
    context,
    config
  };
}

function resolveModelGateway(options) {
  if (options.modelGateway) return options.modelGateway;
  if (options.deepseek || process.env.DEEPSEEK_API_KEY) {
    return createDeepSeekGateway(options.deepseek || {});
  }
  return null;
}
```

- [ ] **Step 5: Run integration tests**

Run:

```powershell
npm.cmd test -- tests/integration/v2-deepseek-gateway-runtime.test.js tests/integration/v2-kernel-facade.test.js tests/unit/core/agent-runtime.test.js
```

Expected:

```text
# fail 0
```

- [ ] **Step 6: Commit**

```powershell
git add src/core/runtime/agent-runtime.js src/index.js tests/integration/v2-deepseek-gateway-runtime.test.js
git commit -m "feat(v2): wire DeepSeek gateway into kernel facade"
```

---

### Task 8: Script Integration and Full Regression

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Update `package.json` check script**

In `package.json`, append the new DeepSeek files to the existing `check` script:

```json
"scripts": {
  "test": "node --test test/**/*.test.js tests/**/*.test.js",
  "check": "node --check bin/deepseek-code.js && node --check src/cli.js src/agent.js src/chat.js src/config.js src/context.js src/git.js src/patch.js src/changes.js src/provider.js src/search.js src/ui.js src/theme.js src/tui.js && node --check src/kernel/event-bus.js src/kernel/session-log.js src/kernel/config-provider.js src/kernel/kernel-api.js src/kernel/model-provider.js src/kernel/context-engine.js src/kernel/task-orchestrator.js src/kernel/permission-engine.js src/kernel/tool-registry.js src/kernel/session-manager.js && node --check src/index.js src/shared/id.js src/shared/time.js src/shared/event-bus.js src/core/protocol/agent-turn.js src/core/protocol/agent-step.js src/core/protocol/tool-call.js src/core/protocol/tool-result.js src/core/protocol/approval-request.js src/core/protocol/artifact.js src/core/protocol/index.js src/core/planning/classifier.js src/core/runtime/lifecycle.js src/core/runtime/agent-runtime.js src/sessions/event-types.js src/deepseek/model-router.js src/deepseek/json-mode.js src/deepseek/usage-tracker.js src/deepseek/api-errors.js src/deepseek/streaming.js src/deepseek/fim-client.js src/deepseek/tool-call-repair.js src/deepseek/prompt-assembler.js src/deepseek/model-gateway.js && node --check gui/main.js gui/preload.js gui/renderer/app.js"
}
```

- [ ] **Step 2: Run all V2-1 targeted tests**

Run:

```powershell
npm.cmd test -- tests/unit/deepseek/model-router.test.js tests/unit/deepseek/json-mode.test.js tests/unit/deepseek/usage-tracker.test.js tests/unit/deepseek/api-errors.test.js tests/unit/deepseek/streaming.test.js tests/unit/deepseek/fim-client.test.js tests/unit/deepseek/model-gateway.test.js tests/integration/v2-deepseek-gateway-runtime.test.js
```

Expected:

```text
# fail 0
```

- [ ] **Step 3: Run full regression**

Run:

```powershell
npm.cmd test
```

Expected:

```text
# fail 0
```

The exact test count must be greater than 154 because V2-1 adds new tests.

- [ ] **Step 4: Run syntax check**

Run:

```powershell
npm.cmd run check
```

Expected:

```text
PASS
```

The command prints no `SyntaxError`.

- [ ] **Step 5: Commit**

```powershell
git add package.json
git commit -m "chore(v2): include DeepSeek gateway checks"
```

---

## Acceptance Criteria

V2-1 is complete only when all items are true:

- Plain chat through `createKernel(..., { deepseek })` returns model text without `response_format`.
- JSON mode is opt-in and throws locally if no system/user message contains `json`.
- Streaming chat is parsed from SSE, never with `response.json()`.
- Streamed usage chunks update cache hit/miss stats.
- `reasoning_content` is returned as internal data and marked hidden by convention.
- Tool calls are preserved and normalized, but not executed.
- FIM calls use `/beta/completions` and do not include chat-only fields.
- `kernel.agent.interrupt()` aborts the in-flight DeepSeek request through `AbortSignal`.
- Existing V2-0 mock injection tests still pass.
- `npm.cmd test` passes.
- `npm.cmd run check` passes.

## Review Checklist

Before reporting completion:

- Run `git diff --check`.
- Run `npm.cmd test`.
- Run `npm.cmd run check`.
- Inspect `src/deepseek/model-gateway.js` and confirm plain `reply` does not add `response_format`.
- Inspect `src/deepseek/streaming.js` and confirm it handles `data: [DONE]`.
- Inspect `src/core/runtime/agent-runtime.js` and confirm stale interrupted turns still cannot publish `agent:final` or unlock a newer turn.
- Inspect `src/index.js` and confirm `options.modelGateway` still overrides the real DeepSeek gateway for tests.

## Commit Order

Use this order:

1. `feat(v2): add DeepSeek model router`
2. `feat(v2): add explicit DeepSeek JSON mode guard`
3. `feat(v2): track DeepSeek usage and API errors`
4. `feat(v2): parse DeepSeek streaming responses`
5. `feat(v2): add DeepSeek FIM and tool-call normalization`
6. `feat(v2): add DeepSeek model gateway`
7. `feat(v2): wire DeepSeek gateway into kernel facade`
8. `chore(v2): include DeepSeek gateway checks`

## Handoff Notes

- Keep all tests offline by injecting `fetchImpl`.
- Use `npm.cmd` on Windows PowerShell.
- Do not modify legacy `src/provider.js` or V1 `src/kernel/model-provider.js` in this phase.
- Do not add dependencies.
- Do not expose API keys in `config.getPublicConfig()`.
- Do not show `reasoning_content` in user-facing strings.
