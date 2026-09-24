import test from "node:test";
import assert from "node:assert/strict";
import {
  CONTEXT_WINDOW, CONTEXT_WINDOW_CURRENT, CONTEXT_WINDOW_LEGACY,
  contextWindowForModel,
  metricSegments,
  formatCount,
  cacheRatio,
  totalTokens
} from "../../../gui/src/state/metrics-view.js";

test("contextWindowForModel:现行代际 1M,旧 id 64k,未知 128k", () => {
  assert.equal(contextWindowForModel("deepseek-flash"), CONTEXT_WINDOW_CURRENT);
  assert.equal(contextWindowForModel("deepseek-v4-pro"), CONTEXT_WINDOW_CURRENT);
  assert.equal(contextWindowForModel("deepseek-chat"), 64000);
  assert.equal(contextWindowForModel("deepseek-reasoner"), 64000);
  assert.equal(contextWindowForModel("deepseek-coder-v2:latest"), CONTEXT_WINDOW_LEGACY);
  assert.equal(contextWindowForModel(null), CONTEXT_WINDOW_CURRENT);
  assert.equal(CONTEXT_WINDOW, CONTEXT_WINDOW_CURRENT, "默认常量对齐现行代际");
});

test("metricSegments:context 窗口按模型推导(1M 时不再 12.8% 即满)", () => {
  const usage = { total_prompt_tokens: 200000, total_completion_tokens: 0, total_tokens: 200000 };
  const segs = metricSegments(usage, { show: { cacheHit: false, context: true }, format: {} }, "deepseek-flash");
  const ctx = segs.find((s) => s.key === "context");
  assert.ok(ctx);
  assert.equal(ctx.text.includes("/1.0M"), true);
  assert.ok(ctx.ratio < 0.25);
});

test("metricSegments:无数据即不渲染 cacheMiss/reasoning/tps", () => {
  const segs = metricSegments({ total_tokens: 10 }, { show: {} }, "deepseek-flash");
  const keys = segs.map((s) => s.key);
  assert.ok(!keys.includes("cacheMiss"));
  assert.ok(!keys.includes("reasoningTokens"));
  assert.ok(!keys.includes("tps"));
  assert.ok(keys.includes("context"));
  assert.ok(keys.includes("cacheHit"));
});

test("metricSegments:有数据时渲染三段遥测", () => {
  const usage = {
    total_prompt_tokens: 100,
    total_completion_tokens: 50,
    total_tokens: 150,
    cache_hit_tokens: 30,
    cache_miss_tokens: 70,
    total_reasoning_tokens: 20,
    avg_latency_ms: 500
  };
  const segs = metricSegments(usage, { show: { retrievalHit: false }, format: { tpsDecimals: 1 } }, "deepseek-flash");
  const keys = segs.map((s) => s.key);
  assert.ok(keys.includes("cacheMiss"));
  assert.ok(keys.includes("reasoningTokens"));
  assert.ok(keys.includes("tps"));
  const tps = segs.find((s) => s.key === "tps");
  // completion 50 / 0.5s = 100 t/s
  assert.equal(tps.text, "100.0");
  const miss = segs.find((s) => s.key === "cacheMiss");
  assert.equal(miss.num.v, "70");
});

test("formatCount / cacheRatio / totalTokens 基础行为保持", () => {
  assert.equal(formatCount(1500), "1.5k");
  assert.equal(formatCount(2_500_000), "2.5M");
  assert.equal(cacheRatio({ cache_hit_tokens: 1, cache_miss_tokens: 1 }), 0.5);
  assert.equal(totalTokens({ total_prompt_tokens: 2, total_completion_tokens: 3 }), 5);
});
