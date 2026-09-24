import test from "node:test";
import assert from "node:assert/strict";
import { createUsageTracker } from "../../../src/deepseek/usage-tracker.js";

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
