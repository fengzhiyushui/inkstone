import test from "node:test";
import assert from "node:assert/strict";
import { normalizeModels, DEFAULT_CONFIG } from "../../src/config.js";
import { DEFAULT_MODELS } from "../../src/deepseek/model-router.js";

test("normalizeModels falls back per-key on missing or garbage input", () => {
  assert.deepEqual(normalizeModels(undefined), DEFAULT_CONFIG.models);
  assert.deepEqual(normalizeModels("nope"), DEFAULT_CONFIG.models);
  assert.deepEqual(normalizeModels({ act: 42, think: "", fim: "   " }), DEFAULT_CONFIG.models);
});

test("normalizeModels trims and keeps valid overrides per key", () => {
  assert.deepEqual(normalizeModels({ act: " my-act " }), { ...DEFAULT_CONFIG.models, act: "my-act" });
});

test("DEFAULT_CONFIG.models converges with model-router DEFAULT_MODELS", () => {
  // 锁双源头:DEFAULT_CONFIG.models 与 DEFAULT_MODELS 必须都源自 model-ids.js
  assert.deepEqual(DEFAULT_CONFIG.models, DEFAULT_MODELS);
});
