import test from "node:test";
import assert from "node:assert/strict";
import { routeModel, buildChannelParams } from "../../../src/deepseek/model-router.js";

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
