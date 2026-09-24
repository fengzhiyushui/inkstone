import test from "node:test";
import assert from "node:assert/strict";
import { buildKernelOptions } from "../../../src/apps/kernel-options.js";

test("buildKernelOptions bridges legacy config into V2 DeepSeek options", async () => {
  const options = await buildKernelOptions("/repo", {}, async () => ({
    apiKey: "sk-test",
    baseUrl: "https://example.invalid"
  }));

  assert.deepEqual(options, {
    deepseek: { apiKey: "sk-test", baseUrl: "https://example.invalid" }
  });
});

test("buildKernelOptions preserves explicit modelGateway and does not read config", async () => {
  const gateway = { reply: async () => ({ content: "ok" }) };
  const options = await buildKernelOptions("/repo", { modelGateway: gateway }, async () => {
    throw new Error("should not load config");
  });

  assert.equal(options.modelGateway, gateway);
});

test("buildKernelOptions forwards config limits to the kernel", async () => {
  const options = await buildKernelOptions("/repo", {}, async () => ({
    apiKey: "sk-test",
    baseUrl: "https://example.invalid",
    limits: { toolTimeoutMs: 120000, modelTimeoutMs: 120000, maxTurnTokens: null, maxModelCalls: null, maxToolCallRepairs: null }
  }));
  assert.equal(options.limits.toolTimeoutMs, 120000);
  assert.equal(options.limits.modelTimeoutMs, 120000);
  assert.equal(options.deepseek.apiKey, "sk-test");
});

test("buildKernelOptions forwards config orchestration to the kernel", async () => {
  const options = await buildKernelOptions("/repo", {}, async () => ({
    apiKey: "sk-test",
    baseUrl: "https://example.invalid",
    orchestration: { maxSubtasks: 5, maxWorkerAttempts: 2, router: { minComplexFiles: 3, markers: [] }, budget: { maxTokens: null, maxModelCalls: 40 } }
  }));
  assert.equal(options.orchestration.maxSubtasks, 5);
  assert.equal(options.orchestration.router.minComplexFiles, 3);
});

test("buildKernelOptions forwards config models into deepseek options", async () => {
  const models = { act: "deepseek-flash", think: "deepseek-v4-pro", fim: "deepseek-flash" };
  const options = await buildKernelOptions("/repo", {}, async () => ({
    apiKey: "sk-test",
    baseUrl: "https://example.invalid",
    models
  }));
  assert.deepEqual(options.deepseek.models, { act: "deepseek-flash", think: "deepseek-v4-pro", fim: "deepseek-flash" });
});

test("buildKernelOptions forwards config events (strictSchema) to the kernel", async () => {
  const options = await buildKernelOptions("/repo", {}, async () => ({
    apiKey: "sk-test",
    baseUrl: "https://example.invalid",
    events: { strictSchema: true }
  }));
  assert.deepEqual(options.events, { strictSchema: true });
});

test("buildKernelOptions omits events when config has none (default off stays default)", async () => {
  const options = await buildKernelOptions("/repo", {}, async () => ({
    apiKey: "sk-test",
    baseUrl: "https://example.invalid"
  }));
  assert.equal("events" in options, false);
});
