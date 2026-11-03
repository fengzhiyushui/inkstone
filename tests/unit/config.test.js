// tests/unit/config.test.js — 配置与门面选项领域测试
//
// v1.19.1 测试归并:本文件由下列历史任务单测试合并而成,每个来源包裹在独立
// describe 块中(异步回调 + 动态 import,来源间零共享绑定),测试语义与拆分前一致。
import { describe } from "node:test";

// ---------------------------------------------------------------------------
// 来源:tests/config-orchestration.test.js
// ---------------------------------------------------------------------------
describe("config-orchestration", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { normalizeOrchestration, DEFAULT_CONFIG } = await import("../../src/config.js");

  test("defaults: no enabled flag; safe gates", () => {
    const o = DEFAULT_CONFIG.orchestration;
    assert.equal("enabled" in o, false);
    assert.equal(o.maxSubtasks, 8);
    assert.equal(o.maxWorkerAttempts, 2);
    assert.equal(o.router.minComplexFiles, 2);
    assert.equal(o.budget.maxModelCalls, 40);
  });

  test("normalizeOrchestration deep-merges per field, clamps to safe", () => {
    const o = normalizeOrchestration({ maxSubtasks: 3, router: { minComplexFiles: 5 }, budget: { maxModelCalls: 100 } });
    assert.equal(o.maxSubtasks, 3);
    assert.equal(o.router.minComplexFiles, 5);
    assert.equal(o.budget.maxModelCalls, 100);
    assert.equal(o.maxWorkerAttempts, 2);            // untouched default
    assert.ok(Array.isArray(o.router.markers));      // default markers preserved
  });

  test("invalid values fall back to defaults", () => {
    const o = normalizeOrchestration({ maxSubtasks: -1, maxWorkerAttempts: 0 });
    assert.equal(o.maxSubtasks, 8);
    assert.equal(o.maxWorkerAttempts, 2);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/config-orchestration-parallel.test.js
// ---------------------------------------------------------------------------
describe("config-orchestration-parallel", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { normalizeOrchestration, DEFAULT_CONFIG } = await import("../../src/config.js");

  test("parallel defaults", () => {
    const p = DEFAULT_CONFIG.orchestration.parallel;
    assert.equal(p.maxParallelWorkers, 4);
    assert.equal(p.maxCopyFiles, 5000);
    assert.equal(p.sweepTtlMs, 3600000);
  });

  test("normalize clamps + falls back per field", () => {
    const o = normalizeOrchestration({ parallel: { maxParallelWorkers: 2, maxCopyFiles: 0 } });
    assert.equal(o.parallel.maxParallelWorkers, 2);
    assert.equal(o.parallel.maxCopyFiles, 5000);    // 0 invalid -> default
    assert.equal(o.parallel.sweepTtlMs, 3600000);   // untouched default
  });

  test("parallel survives alongside other orchestration fields", () => {
    const o = normalizeOrchestration({ maxSubtasks: 3 });
    assert.equal(o.maxSubtasks, 3);
    assert.equal(o.parallel.maxParallelWorkers, 4);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/config-orchestration-maxrounds.test.js
// ---------------------------------------------------------------------------
describe("config-orchestration-maxrounds", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { normalizeOrchestration, DEFAULT_CONFIG } = await import("../../src/config.js");

  test("maxRounds default 2", () => {
    assert.equal(DEFAULT_CONFIG.orchestration.maxRounds, 2);
  });

  test("normalize maxRounds posInt with fallback", () => {
    assert.equal(normalizeOrchestration({ maxRounds: 5 }).maxRounds, 5);
    assert.equal(normalizeOrchestration({ maxRounds: 0 }).maxRounds, 2);   // invalid -> default
    assert.equal(normalizeOrchestration({ maxRounds: 1 }).maxRounds, 1);
  });

  test("maxRounds coexists with other orchestration fields", () => {
    const o = normalizeOrchestration({ maxSubtasks: 3 });
    assert.equal(o.maxRounds, 2);
    assert.equal(o.maxSubtasks, 3);
    assert.equal(o.parallel.maxParallelWorkers, 4);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/config-orchestration-router-model.test.js
// ---------------------------------------------------------------------------
describe("config-orchestration-router-model", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { normalizeOrchestration } = await import("../../src/config.js");

  test("router.model defaults: enabled on, act channel, 8000/1/3", () => {
    const m = normalizeOrchestration({}).router.model;
    assert.deepEqual(m, { enabled: true, channel: "act", timeoutMs: 8000, maxRepairs: 1, complexThreshold: 3 });
  });

  test("router.model.enabled coerced to boolean", () => {
    assert.equal(normalizeOrchestration({ router: { model: { enabled: false } } }).router.model.enabled, false);
    assert.equal(normalizeOrchestration({ router: { model: { enabled: 0 } } }).router.model.enabled, false);
    assert.equal(normalizeOrchestration({ router: { model: { enabled: "yes" } } }).router.model.enabled, true);
  });

  test("router.model.maxRepairs is nonNegativeInt: 0 kept, negative/invalid → 1", () => {
    assert.equal(normalizeOrchestration({ router: { model: { maxRepairs: 0 } } }).router.model.maxRepairs, 0);
    assert.equal(normalizeOrchestration({ router: { model: { maxRepairs: -2 } } }).router.model.maxRepairs, 1);
    assert.equal(normalizeOrchestration({ router: { model: { maxRepairs: "x" } } }).router.model.maxRepairs, 1);
  });

  test("router.model.channel: any non-empty string passes through; blank → default", () => {
    assert.equal(normalizeOrchestration({ router: { model: { channel: "think" } } }).router.model.channel, "think");
    assert.equal(normalizeOrchestration({ router: { model: { channel: "" } } }).router.model.channel, "act");
    assert.equal(normalizeOrchestration({ router: { model: { channel: 7 } } }).router.model.channel, "act");
  });

  test("timeoutMs/complexThreshold posInt fallback; existing router fields kept", () => {
    const r = normalizeOrchestration({ router: { minComplexFiles: 4, model: { timeoutMs: 0, complexThreshold: -1 } } }).router;
    assert.equal(r.minComplexFiles, 4);
    assert.equal(r.model.timeoutMs, 8000);
    assert.equal(r.model.complexThreshold, 3);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/config-orchestration-experience.test.js
// ---------------------------------------------------------------------------
describe("config-orchestration-experience", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { normalizeOrchestration } = await import("../../src/config.js");

  test("crossTaskLearning defaults to off; enum normalized", () => {
    assert.equal(normalizeOrchestration({}).crossTaskLearning, "off");
    assert.equal(normalizeOrchestration({ crossTaskLearning: "on" }).crossTaskLearning, "on");
    assert.equal(normalizeOrchestration({ crossTaskLearning: "gated" }).crossTaskLearning, "gated");
    assert.equal(normalizeOrchestration({ crossTaskLearning: "bogus" }).crossTaskLearning, "off");
    assert.equal(normalizeOrchestration({ crossTaskLearning: 1 }).crossTaskLearning, "off");
  });

  test("experience defaults", () => {
    const e = normalizeOrchestration({}).experience;
    assert.equal(e.cap, 200);
    assert.equal(e.decayPerDay, 0.02);
    assert.deepEqual(e.thresholds, { T1: 0.7, T2: 0.4, T3: 0.2 });
    assert.equal(e.dedupThreshold, 0.6);
    assert.equal(e.maxLessonsPerTask, 5);
    assert.equal(e.retrieveK, 5);
    assert.equal(e.pendingTtlMs, 86400000);
  });

  test("experience invalid values fall back", () => {
    assert.equal(normalizeOrchestration({ experience: { cap: 0 } }).experience.cap, 200);
    assert.equal(normalizeOrchestration({ experience: { retrieveK: -1 } }).experience.retrieveK, 5);
    assert.equal(normalizeOrchestration({ experience: { decayPerDay: -1 } }).experience.decayPerDay, 0.02);
    assert.equal(normalizeOrchestration({ experience: { dedupThreshold: 9 } }).experience.dedupThreshold, 0.6);
    const th = normalizeOrchestration({ experience: { thresholds: { T1: 9, T2: 0.4, T3: 0.2 } } }).experience.thresholds;
    assert.equal(th.T1, 0.7); // out of [0,1] -> default
  });

  test("experience valid overrides pass through", () => {
    const e = normalizeOrchestration({ experience: { cap: 50, retrieveK: 3, decayPerDay: 0.05, thresholds: { T1: 0.8, T2: 0.5, T3: 0.3 } } }).experience;
    assert.equal(e.cap, 50);
    assert.equal(e.retrieveK, 3);
    assert.equal(e.decayPerDay, 0.05);
    assert.deepEqual(e.thresholds, { T1: 0.8, T2: 0.5, T3: 0.3 });
  });

  test("existing orchestration fields unchanged", () => {
    const o = normalizeOrchestration({});
    assert.equal(o.maxRounds, 2);
    assert.equal(o.maxSubtasks, 8);
    assert.ok(o.router);
    assert.ok(o.parallel);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/config-context-languages.test.js
// ---------------------------------------------------------------------------
describe("config-context-languages", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { normalizeContext, DEFAULT_CONFIG } = await import("../../src/config.js");

  test("defaults no longer have languages key", () => {
    assert.equal("languages" in DEFAULT_CONFIG.context.semantic, false);
    assert.deepEqual(DEFAULT_CONFIG.context.semantic.importRoots, []);
  });

  test("normalizeContext drops languages key from old config — key silently disappears", () => {
    const c = normalizeContext({ semantic: { languages: ["js", "ruby", "py", "js"], importRoots: ["src", "lib"] } });
    assert.equal("languages" in c.semantic, false);
    assert.deepEqual(c.semantic.importRoots, ["src", "lib"]);
  });

  test("normalizeContext ignores languages even when present", () => {
    const c = normalizeContext({ semantic: { languages: "nope" } });
    // Other keys are unaffected.
    assert.equal(c.semantic.enabled, false);
    assert.equal(c.semantic.hops, 2);
    assert.deepEqual(c.semantic.importRoots, []);
  });

  test("normalizeContext still works with old-style config containing languages", () => {
    const c = normalizeContext({ semantic: { enabled: true, languages: ["py"], importRoots: [] } });
    assert.equal(c.semantic.enabled, true);
    assert.equal("languages" in c.semantic, false);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/config-context-semantic.test.js
// ---------------------------------------------------------------------------
describe("config-context-semantic", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { normalizeContext, DEFAULT_CONFIG } = await import("../../src/config.js");

  test("defaults: semantic disabled", () => {
    assert.equal(DEFAULT_CONFIG.context.semantic.enabled, false);
    assert.equal(DEFAULT_CONFIG.context.semantic.hops, 2);
  });

  test("normalizeContext coerces and fills defaults", () => {
    const c = normalizeContext({ semantic: { enabled: true, hops: 0, maxSymbols: "x" } });
    assert.equal(c.semantic.enabled, true);
    assert.equal(c.semantic.hops, 2);        // 0/invalid -> default
    assert.equal(c.semantic.maxSymbols, 200);
    assert.equal(c.semantic.includeMethodHints, false);
  });

  test("normalizeContext on empty -> defaults", () => {
    assert.deepEqual(normalizeContext(), { semantic: { enabled: false, hops: 2, maxSymbols: 200, includeMethodHints: false, importRoots: [] } });
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/config-limits.test.js
// ---------------------------------------------------------------------------
describe("unit/config-limits", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { normalizeConfig, normalizeLimits, DEFAULT_CONFIG } = await import("../../src/config.js");

  test("DEFAULT_CONFIG enables 120s timeouts, leaves budgets off", () => {
    assert.equal(DEFAULT_CONFIG.limits.toolTimeoutMs, 120000);
    assert.equal(DEFAULT_CONFIG.limits.modelTimeoutMs, 120000);
    assert.equal(DEFAULT_CONFIG.limits.maxTurnTokens, null);
    assert.equal(DEFAULT_CONFIG.limits.maxModelCalls, null);
    assert.equal(DEFAULT_CONFIG.limits.maxToolCallRepairs, null);
  });

  test("normalizeConfig fills default limits when omitted", () => {
    const c = normalizeConfig({});
    assert.equal(c.limits.toolTimeoutMs, 120000);
    assert.equal(c.limits.modelTimeoutMs, 120000);
  });

  test("normalizeConfig deep-merges user limits per field", () => {
    const c = normalizeConfig({ limits: { toolTimeoutMs: 5000, maxModelCalls: 10 } });
    assert.equal(c.limits.toolTimeoutMs, 5000);     // user override
    assert.equal(c.limits.modelTimeoutMs, 120000);  // default preserved
    assert.equal(c.limits.maxModelCalls, 10);       // user opt-in
  });

  test("normalizeLimits treats null / <=0 as disabled", () => {
    assert.equal(normalizeLimits({ toolTimeoutMs: null }).toolTimeoutMs, null);
    assert.equal(normalizeLimits({ modelTimeoutMs: 0 }).modelTimeoutMs, null);
    assert.equal(normalizeLimits({ toolTimeoutMs: -5 }).toolTimeoutMs, null);
  });

  test("normalizeLimits coerces numeric strings and truncates", () => {
    assert.equal(normalizeLimits({ toolTimeoutMs: "3000" }).toolTimeoutMs, 3000);
    assert.equal(normalizeLimits({ maxModelCalls: 4.9 }).maxModelCalls, 4);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/config-models.test.js
// ---------------------------------------------------------------------------
describe("unit/config-models", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { normalizeModels, DEFAULT_CONFIG } = await import("../../src/config.js");
  const { DEFAULT_MODELS } = await import("../../src/deepseek/model-router.js");

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
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/config-events.test.js
// ---------------------------------------------------------------------------
describe("unit/config-events", async () => {
  // tests/unit/config-events.test.js — 事件日志 schema 守卫开关(M1 A1a,可选严格模式)。
  // 策略:默认关闭;strictSchema 只认显式布尔 true,字符串 "true" / 1 等一律 false。


  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { normalizeEvents, normalizeConfig, DEFAULT_CONFIG, loadConfig } = await import("../../src/config.js");
  const { mkdtemp } = await import("../helpers/tmp.js");

  test("DEFAULT_CONFIG.events.strictSchema defaults to false", () => {
    assert.deepEqual(DEFAULT_CONFIG.events, { strictSchema: false });
  });

  test("normalizeEvents defaults when omitted or non-object", () => {
    assert.deepEqual(normalizeEvents(undefined), { strictSchema: false });
    assert.deepEqual(normalizeEvents(), { strictSchema: false });
    assert.deepEqual(normalizeEvents(null), { strictSchema: false });
    assert.deepEqual(normalizeEvents("nope"), { strictSchema: false });
    assert.deepEqual(normalizeEvents(42), { strictSchema: false });
  });

  test("normalizeEvents only accepts explicit boolean true", () => {
    assert.equal(normalizeEvents({ strictSchema: true }).strictSchema, true);
    assert.equal(normalizeEvents({ strictSchema: false }).strictSchema, false);
    assert.equal(normalizeEvents({}).strictSchema, false);
    assert.equal(normalizeEvents({ strictSchema: "true" }).strictSchema, false);
    assert.equal(normalizeEvents({ strictSchema: 1 }).strictSchema, false);
  });

  test("normalizeConfig passes events through normalization", () => {
    assert.equal(normalizeConfig({}).events.strictSchema, false);
    assert.equal(normalizeConfig({ events: { strictSchema: true } }).events.strictSchema, true);
    assert.equal(normalizeConfig({ events: { strictSchema: "true" } }).events.strictSchema, false);
  });

  test("loadConfig reads events.strictSchema from config.json", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-cfg-events-"));
    try {
      await mkdir(path.join(root, ".deepseek-code"), { recursive: true });
      await writeFile(
        path.join(root, ".deepseek-code", "config.json"),
        JSON.stringify({ events: { strictSchema: true } }),
        "utf8"
      );
      const config = await loadConfig(root, { allowMissingKey: true });
      assert.equal(config.events.strictSchema, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("loadConfig leaves events.strictSchema off when config.json omits it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-cfg-events-"));
    try {
      await mkdir(path.join(root, ".deepseek-code"), { recursive: true });
      await writeFile(
        path.join(root, ".deepseek-code", "config.json"),
        JSON.stringify({ model: "deepseek-chat" }),
        "utf8"
      );
      const config = await loadConfig(root, { allowMissingKey: true });
      assert.equal(config.events.strictSchema, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/config-model-migration.test.js
// ---------------------------------------------------------------------------
describe("unit/config-model-migration", async () => {
  // tests/unit/config-model-migration.test.js — 退役模型 id 迁移(v1.9.0 M1-P0)。
  // 策略:仅精确键匹配(deepseek-v4-flash → deepseek-flash),未知/第三方端点 id 原样透传。


  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { normalizeModels, normalizeConfig, DEFAULT_CONFIG, loadConfig } = await import("../../src/config.js");
  const { migrateModelId } = await import("../../src/deepseek/model-ids.js");
  const { mkdtemp } = await import("../helpers/tmp.js");

  test("normalizeModels migrates retired act id to current default", () => {
    const models = normalizeModels({ act: "deepseek-v4-flash" });
    assert.equal(models.act, "deepseek-flash");
    assert.equal(models.think, DEFAULT_CONFIG.models.think);
    assert.equal(models.fim, DEFAULT_CONFIG.models.fim);
  });

  test("normalizeModels keeps defaults for keys omitted by a partial override", () => {
    // 防混态:只写 act 时,think/fim 必须仍取默认(而不是残留/丢失)
    const models = normalizeModels({ act: "deepseek-v4-flash" });
    assert.deepEqual(models, {
      act: "deepseek-flash",
      think: DEFAULT_CONFIG.models.think,
      fim: DEFAULT_CONFIG.models.fim
    });
  });

  test("normalizeConfig migrates retired top-level model id", () => {
    assert.equal(normalizeConfig({ model: "deepseek-v4-flash" }).model, "deepseek-flash");
    assert.equal(DEFAULT_CONFIG.model, "deepseek-flash");
  });

  test("third-party / compatibility endpoint ids pass through untouched", () => {
    // 最重要一条:模型 id 是开放字符串(Ollama/vLLM/OneAPI 等兼容端点),
    // 未知 id 绝不可改写成官方 ID,否则直接打断第三方端点。
    const models = normalizeModels({
      act: "deepseek-coder-v2:latest",
      think: "deepseek-ai/DeepSeek-V3"
    });
    assert.deepEqual(models, {
      act: "deepseek-coder-v2:latest",
      think: "deepseek-ai/DeepSeek-V3",
      fim: DEFAULT_CONFIG.models.fim
    });
    assert.equal(normalizeConfig({ model: "deepseek-chat" }).model, "deepseek-chat");
  });

  test("migration is idempotent", () => {
    assert.equal(migrateModelId(migrateModelId("deepseek-v4-flash")), "deepseek-flash");
    const migrated = normalizeConfig({ model: "deepseek-v4-flash" });
    const twice = normalizeConfig(migrated);
    assert.equal(twice.model, "deepseek-flash");
    assert.deepEqual(twice.models, migrated.models);
  });

  test("loadConfig migrates model id from file config", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-cfg-migrate-"));
    try {
      await mkdir(path.join(root, ".deepseek-code"), { recursive: true });
      await writeFile(
        path.join(root, ".deepseek-code", "config.json"),
        JSON.stringify({ model: "deepseek-v4-flash", models: { act: "deepseek-v4-flash" } }),
        "utf8"
      );
      const config = await loadConfig(root, { allowMissingKey: true });
      assert.equal(config.model, "deepseek-flash");
      assert.equal(config.models.act, "deepseek-flash");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("loadConfig keeps DEEPSEEK_MODEL env value un-migrated (D5)", async () => {
    // env 是显式指定(可能指向仍接受旧 id 的自建网关),原样生效,不过迁移。
    const root = await mkdtemp(path.join(tmpdir(), "dsc-cfg-env-"));
    const previous = process.env.DEEPSEEK_MODEL;
    process.env.DEEPSEEK_MODEL = "deepseek-v4-flash";
    try {
      const config = await loadConfig(root, { allowMissingKey: true });
      assert.equal(config.model, "deepseek-v4-flash");
    } finally {
      if (previous === undefined) {
        delete process.env.DEEPSEEK_MODEL;
      } else {
        process.env.DEEPSEEK_MODEL = previous;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/config-model-strategy.test.js
// ---------------------------------------------------------------------------
describe("unit/config-model-strategy", async () => {
  // tests/unit/config-model-strategy.test.js — v1.9.0 M4 模型适配:reasoning_effort 合法集 + FIM betaBase 配置键。
  // 协议事实(调研核定):reasoning_effort 全集 = none|low|high|max(客户端历史档位 low/medium 亦原样透传);
  // none 等价关思考,但「关不禁用」由通道层 thinking 开关决定,配置层只校验 + 透传。


  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { normalizeReasoningEffort, normalizeConfig, DEFAULT_CONFIG, loadConfig } = await import("../../src/config.js");
  const { mkdtemp } = await import("../helpers/tmp.js");

  test("normalizeReasoningEffort passes the whole legal set through untouched", () => {
    // 降档必须真的降档:fold-to-high 会把 low/medium 变成死配置。
    for (const effort of ["none", "low", "medium", "high", "max"]) {
      assert.equal(normalizeReasoningEffort(effort), effort, `${effort} must pass through`);
    }
  });

  test("normalizeReasoningEffort normalizes case and surrounding whitespace", () => {
    assert.equal(normalizeReasoningEffort("  LOW  "), "low");
    assert.equal(normalizeReasoningEffort("Medium"), "medium");
    assert.equal(normalizeReasoningEffort("\tNONE\n"), "none");
    assert.equal(normalizeReasoningEffort(" Max "), "max");
    assert.equal(normalizeReasoningEffort("High"), "high");
  });

  test("normalizeReasoningEffort falls back to the default on undefined, empty and illegal values", () => {
    assert.equal(normalizeReasoningEffort(undefined), DEFAULT_CONFIG.reasoningEffort);
    assert.equal(normalizeReasoningEffort(undefined), "high");
    assert.equal(normalizeReasoningEffort(""), "high");
    assert.equal(normalizeReasoningEffort("   "), "high");
    assert.equal(normalizeReasoningEffort("xhigh"), "high");
    assert.equal(normalizeReasoningEffort("minimal"), "high");
    assert.equal(normalizeReasoningEffort("turbo"), "high");
    assert.equal(normalizeReasoningEffort(42), "high");
    assert.equal(normalizeReasoningEffort(null), "high");
    assert.equal(normalizeReasoningEffort({ effort: "low" }), "high");
  });

  test("normalizeConfig threads reasoningEffort through instead of folding low/medium up", () => {
    assert.equal(normalizeConfig({ reasoningEffort: "low" }).reasoningEffort, "low");
    assert.equal(normalizeConfig({ reasoningEffort: "medium" }).reasoningEffort, "medium");
    assert.equal(normalizeConfig({ reasoningEffort: "none" }).reasoningEffort, "none");
    assert.equal(normalizeConfig({ reasoningEffort: " MAX " }).reasoningEffort, "max");
    // 缺省 / 非法回落仍走默认,键本身不得消失
    assert.equal(normalizeConfig({}).reasoningEffort, "high");
    assert.equal(normalizeConfig({ reasoningEffort: "bogus" }).reasoningEffort, "high");
    assert.equal("reasoningEffort" in normalizeConfig({}), true);
  });

  test("DEFAULT_CONFIG.betaBase defaults to the empty string (client缺省 ${baseUrl}/beta)", () => {
    assert.equal(DEFAULT_CONFIG.betaBase, "");
    // 缺省时 normalizeConfig 不得把 betaBase 变成别的值
    assert.equal(normalizeConfig({}).betaBase, "");
  });

  test("normalizeConfig strips trailing slashes from betaBase and keeps empty string empty", () => {
    assert.equal(normalizeConfig({ betaBase: "https://beta.example.com/v1/" }).betaBase, "https://beta.example.com/v1");
    assert.equal(normalizeConfig({ betaBase: "https://beta.example.com///" }).betaBase, "https://beta.example.com");
    assert.equal(normalizeConfig({ betaBase: "  https://beta.example.com/b  " }).betaBase, "https://beta.example.com/b");
    // 空串 = 用客户端缺省,归一必须保持空串(现有行为逐字节不变)
    assert.equal(normalizeConfig({ betaBase: "" }).betaBase, "");
    assert.equal(normalizeConfig({ betaBase: "   " }).betaBase, "");
    assert.equal(normalizeConfig({ betaBase: null }).betaBase, "");
    assert.equal(normalizeConfig({ betaBase: undefined }).betaBase, "");
    // 非字符串强转
    assert.equal(normalizeConfig({ betaBase: 42 }).betaBase, "42");
  });

  test("betaBase normalization is idempotent", () => {
    const once = normalizeConfig({ betaBase: "https://beta.example.com/v1///" });
    const twice = normalizeConfig(once);
    assert.equal(twice.betaBase, "https://beta.example.com/v1");
    assert.deepEqual(twice.betaBase, once.betaBase);
  });

  test("loadConfig reads betaBase from config.json and normalizes it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-cfg-beta-"));
    try {
      await mkdir(path.join(root, ".deepseek-code"), { recursive: true });
      await writeFile(
        path.join(root, ".deepseek-code", "config.json"),
        JSON.stringify({ betaBase: "https://beta.example.com/v1/", reasoningEffort: "low" }),
        "utf8"
      );
      const config = await loadConfig(root, { allowMissingKey: true });
      assert.equal(config.betaBase, "https://beta.example.com/v1");
      // fileConfig 的 reasoningEffort 走同一合法集(低频档不被折叠)
      assert.equal(config.reasoningEffort, "low");
      assert.equal("betaBase" in config, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("loadConfig defaults betaBase to empty string when config.json omits it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-cfg-beta-default-"));
    try {
      const config = await loadConfig(root, { allowMissingKey: true });
      assert.equal(config.betaBase, "");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/mcp-config.test.js
// ---------------------------------------------------------------------------
describe("unit/mcp-config", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { normalizeConfig, normalizeMcpServers } = await import("../../src/config.js");

  test("normalizeMcpServers validates and normalizes server configurations", () => {
    const raw = {
      sqlite: {
        command: "uvx",
        args: ["mcp-server-sqlite", "--db-path", "test.db"],
        env: { DB_MODE: "ro" },
        disabled: false,
        autoApprove: ["read_query"]
      },
      emptyCommand: {
        command: "   ",
        args: []
      },
      disabledServer: {
        command: "npx",
        args: ["-y", "dummy"],
        disabled: true
      },
      invalidEntry: "not an object"
    };

    const normalized = normalizeMcpServers(raw);

    assert.ok(normalized.sqlite);
    assert.equal(normalized.sqlite.command, "uvx");
    assert.deepEqual(normalized.sqlite.args, ["mcp-server-sqlite", "--db-path", "test.db"]);
    assert.deepEqual(normalized.sqlite.env, { DB_MODE: "ro" });
    assert.equal(normalized.sqlite.disabled, false);
    assert.deepEqual(normalized.sqlite.autoApprove, ["read_query"]);
    assert.equal(normalized.sqlite.timeoutMs, 60000);

    assert.equal(normalized.emptyCommand, undefined);
    assert.equal(normalized.invalidEntry, undefined);

    assert.ok(normalized.disabledServer);
    assert.equal(normalized.disabledServer.disabled, true);
  });

  test("normalizeConfig incorporates mcpServers safely", () => {
    const config = normalizeConfig({
      apiKey: "test-key",
      mcpServers: {
        fetch: {
          command: "node",
          args: ["./fetch-mcp.js"]
        }
      }
    });

    assert.ok(config.mcpServers.fetch);
    assert.equal(config.mcpServers.fetch.command, "node");
    assert.deepEqual(config.mcpServers.fetch.args, ["./fetch-mcp.js"]);
  });
});
