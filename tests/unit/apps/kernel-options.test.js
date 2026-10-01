import test from "node:test";
import assert from "node:assert/strict";
import { buildKernelOptions } from "../../../src/apps/kernel-options.js";

test("buildKernelOptions bridges legacy config into V2 DeepSeek options", async () => {
  const options = await buildKernelOptions("/repo", {}, async () => ({
    apiKey: "sk-test",
    baseUrl: "https://example.invalid"
  }));

  assert.deepEqual(options, {
    deepseek: { apiKey: "sk-test", baseUrl: "https://example.invalid" },
    // v1.11.2:入口默认开启多作用域 MCP 配置加载(.mcp.json / VS Code servers)
    loadMcpConfigScopes: true
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

// ── v1.11.2:配置文件里的 inputs 必须与 mcpServers 一同到达内核 ──────────────
test("buildKernelOptions forwards config inputs alongside mcpServers", async () => {
  const options = await buildKernelOptions("/repo", {}, async () => ({
    apiKey: "sk-test",
    baseUrl: "https://example.invalid",
    mcpServers: { fs: { command: "node" } },
    inputs: { tok: { type: "promptString", password: true } }
  }));
  assert.deepEqual(options.mcpServers, { fs: { command: "node" } });
  assert.deepEqual(options.inputs, { tok: { type: "promptString", password: true } });
});

test("buildKernelOptions omits inputs when config defines none", async () => {
  const options = await buildKernelOptions("/repo", {}, async () => ({
    apiKey: "sk-test",
    baseUrl: "https://example.invalid"
  }));
  assert.equal("inputs" in options, false);
});

test("buildKernelOptions enables MCP config scopes even without an apiKey", async () => {
  const options = await buildKernelOptions("/repo", {}, async () => ({}));
  assert.equal(options.loadMcpConfigScopes, true);
});

test("buildKernelOptions respects an explicit loadMcpConfigScopes override", async () => {
  const off = await buildKernelOptions("/repo", { loadMcpConfigScopes: false }, async () => ({
    apiKey: "sk-test",
    baseUrl: "https://example.invalid"
  }));
  assert.equal(off.loadMcpConfigScopes, false);

  const viaGateway = await buildKernelOptions(
    "/repo",
    { modelGateway: {}, loadMcpConfigScopes: false },
    async () => { throw new Error("should not load config"); }
  );
  assert.equal(viaGateway.loadMcpConfigScopes, false);
});

test("buildKernelOptions enables scopes on the explicit-gateway early-return path", async () => {
  const options = await buildKernelOptions("/repo", { modelGateway: {} }, async () => {
    throw new Error("should not load config");
  });
  assert.equal(options.loadMcpConfigScopes, true);
});
