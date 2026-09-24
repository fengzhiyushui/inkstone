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
