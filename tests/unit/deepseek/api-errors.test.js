import test from "node:test";
import assert from "node:assert/strict";
import { createDeepSeekApiError, formatDeepSeekApiError, isRetryableDeepSeekError } from "../../../src/deepseek/api-errors.js";

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
