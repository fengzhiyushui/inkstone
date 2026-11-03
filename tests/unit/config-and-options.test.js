// tests/unit/config-and-options.test.js — 配置加载、归一化与内核门面选项构建
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_CONFIG,
  loadConfig,
  normalizeOrchestration,
  normalizeContext,
  normalizeLimits,
  normalizeModels
} from "../../src/config.js";
import { buildKernelOptions } from "../../src/apps/kernel-options.js";
import { mkdtemp } from "../helpers/tmp.js";

test("默认配置与环境变量覆盖表驱动校验", async () => {
  assert.equal(typeof DEFAULT_CONFIG.model, "string");
  assert.ok(DEFAULT_CONFIG.model.length > 0);
  assert.equal(typeof DEFAULT_CONFIG.models.act, "string");
  assert.equal(typeof DEFAULT_CONFIG.models.think, "string");
  assert.equal(typeof DEFAULT_CONFIG.models.fim, "string");
  assert.equal(DEFAULT_CONFIG.orchestration.maxSubtasks, 8);
  assert.equal(DEFAULT_CONFIG.limits.toolTimeoutMs, 120000);

  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "dsc-cfg-test-"));
  const projectCfgDir = path.join(tmpRoot, ".deepseek-code");
  await fs.mkdir(projectCfgDir, { recursive: true });
  await fs.writeFile(
    path.join(projectCfgDir, "config.json"),
    JSON.stringify({ apiKey: "sk-file-key", limits: { toolTimeoutMs: 60000 } })
  );

  const prevEnv = { ...process.env };
  try {
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_BASE_URL;

    const loaded = await loadConfig(tmpRoot);
    assert.equal(loaded.apiKey, "sk-file-key");
    assert.equal(loaded.limits.toolTimeoutMs, 60000);

    // 空根目录时走环境变量
    const emptyRoot = await mkdtemp(path.join(os.tmpdir(), "dsc-cfg-empty-"));
    process.env.DEEPSEEK_API_KEY = "sk-env-key";
    process.env.DEEPSEEK_BASE_URL = "https://custom.api/v1";
    const loadedEnv = await loadConfig(emptyRoot);
    assert.equal(loadedEnv.apiKey, "sk-env-key");
    assert.equal(loadedEnv.baseUrl, "https://custom.api/v1");
  } finally {
    process.env = prevEnv;
  }
});

test("模型退役迁移与多通道策略", () => {
  const norm1 = normalizeModels({ act: "deepseek-chat", think: "deepseek-reasoner" });
  assert.equal(norm1.act, "deepseek-chat");
  assert.equal(norm1.think, "deepseek-reasoner");

  const custom = normalizeModels({ act: "my-act-model", think: "my-think-model", fim: "my-fim-model" });
  assert.equal(custom.act, "my-act-model");
  assert.equal(custom.think, "my-think-model");
  assert.equal(custom.fim, "my-fim-model");
});

test("编排、上下文与 MCP 配置归一化", () => {
  const orch = normalizeOrchestration({
    maxSubtasks: 4,
    maxRounds: 3,
    parallel: { maxParallelWorkers: 2, maxCopyFiles: 1000 },
    router: { minComplexFiles: 4, model: { enabled: true, timeoutMs: 5000 } }
  });
  assert.equal(orch.maxSubtasks, 4);
  assert.equal(orch.maxRounds, 3);
  assert.equal(orch.parallel.maxParallelWorkers, 2);
  assert.equal(orch.parallel.maxCopyFiles, 1000);
  assert.equal(orch.router.minComplexFiles, 4);
  assert.equal(orch.router.model.timeoutMs, 5000);

  const fallbackOrch = normalizeOrchestration({ maxSubtasks: -1, maxRounds: 0 });
  assert.equal(fallbackOrch.maxSubtasks, 8);
  assert.equal(fallbackOrch.maxRounds, 2);

  const ctx = normalizeContext({ semantic: { enabled: true, hops: 3, maxSymbols: 250 } });
  assert.equal(ctx.semantic.enabled, true);
  assert.equal(ctx.semantic.hops, 3);
  assert.equal(ctx.semantic.maxSymbols, 250);

  const lim = normalizeLimits({ toolTimeoutMs: 45000 });
  assert.equal(lim.toolTimeoutMs, 45000);
  assert.equal(lim.modelTimeoutMs, 120000);
});

test("buildKernelOptions 映射与参数桥接", async () => {
  const options = await buildKernelOptions("/repo", {}, async () => ({
    apiKey: "sk-test",
    baseUrl: "https://example.invalid",
    models: { act: "custom-act", think: "custom-think", fim: "custom-fim" },
    limits: { toolTimeoutMs: 90000, modelTimeoutMs: 80000 },
    orchestration: { maxSubtasks: 5 },
    events: { strictSchema: true },
    mcpServers: { myServer: { command: "node" } },
    inputs: { apiToken: { type: "promptString", password: true } }
  }));

  assert.equal(options.deepseek.apiKey, "sk-test");
  assert.equal(options.deepseek.baseUrl, "https://example.invalid");
  assert.equal(options.deepseek.models.act, "custom-act");
  assert.equal(options.limits.toolTimeoutMs, 90000);
  assert.equal(options.orchestration.maxSubtasks, 5);
  assert.deepEqual(options.events, { strictSchema: true });
  assert.deepEqual(options.mcpServers, { myServer: { command: "node" } });
  assert.deepEqual(options.inputs, { apiToken: { type: "promptString", password: true } });
  assert.equal(options.loadMcpConfigScopes, true);

  const explicitGateway = { reply: async () => ({ content: "mock" }) };
  const bypassed = await buildKernelOptions("/repo", { modelGateway: explicitGateway }, async () => {
    throw new Error("should not load config when modelGateway provided");
  });
  assert.equal(bypassed.modelGateway, explicitGateway);
});
