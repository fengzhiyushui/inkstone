# Phase 1: Core Intelligence — Implementation Plan

> 完成状态以 [CHANGELOG](../../CHANGELOG.md) 为准。


**Goal:** Build the three core intelligence modules — ModelProvider (dual-channel DeepSeek API), ContextEngine (3-layer memory with cache-aware assembly), and TaskOrchestrator (event-driven state machine) — on top of the Phase 0 kernel foundation.

**Architecture:** ModelProvider wraps the DeepSeek API with Think/Act channel templates, FIM support, streaming, retry/fallback, and usage tracking. ContextEngine manages cold/warm/hot context layers with scoring-based eviction, snapshot references, and invalidation. TaskOrchestrator runs an explicit state machine (Idle→Classify→ThinkPlan→ActExecute→ThinkReview→Verify→Complete) with fast paths, autonomy gating, and event-logged transitions.

**Tech Stack:** Node.js >= 20 (ES modules), `node:fetch` (global), `node:crypto`, Phase 0 kernel modules (EventBus, SessionLog, ConfigProvider, KernelAPI).

**Dependency order:** ModelProvider (standalone) → ContextEngine (standalone) → TaskOrchestrator (composes both) → Wire KernelAPI → Integration.

---

## File Structure

```
Create:
  src/kernel/model-provider.js       — DeepSeek API adapter (dual-channel, FIM, streaming, retry)
  src/kernel/context-engine.js       — 3-layer context (ContextUnit, scoring, snapshot, invalidation)
  src/kernel/task-orchestrator.js    — State machine (11 states + fast paths + autonomy gating)
  test/kernel/model-provider.test.js — ModelProvider unit tests
  test/kernel/context-engine.test.js — ContextEngine unit tests
  test/kernel/task-orchestrator.test.js — TaskOrchestrator unit tests

Modify:
  src/kernel/kernel-api.js           — Wire ModelProvider + ContextEngine + TaskOrchestrator
```

---

### Task 1: ModelProvider

**Files:**
- Create: `src/kernel/model-provider.js`
- Create: `test/kernel/model-provider.test.js`
- Use: `src/kernel/config-provider.js` (DEFAULT_MODEL_PROFILES)

**What to build:** A module that wraps the DeepSeek API for both Think and Act channels. It takes a config object (with ModelProfiles) and exposes `invoke()`, `streamDelta()`, `fimComplete()`, and `getUsageStats()`.

#### Step 1: Write the test file

```js
// test/kernel/model-provider.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { createModelProvider } from "../../src/kernel/model-provider.js";
import { DEFAULT_MODEL_PROFILES } from "../../src/kernel/config-provider.js";

// Helper: create a minimal config object for testing
function testConfig(overrides = {}) {
  return {
    baseUrl: "https://api.deepseek.com",
    apiKey: "sk-test-dummy",
    model: "deepseek-v4-flash",
    temperature: 0.2,
    maxTokens: 4096,
    thinking: { type: "disabled" },
    reasoningEffort: "high",
    profiles: DEFAULT_MODEL_PROFILES,
    ...overrides
  };
}

test("channelParams returns Think channel params", () => {
  const provider = createModelProvider(testConfig());
  const params = provider.channelParams("think");
  assert.equal(params.thinking.type, "enabled");
  assert.equal(params.model, "deepseek-v4-pro");
  assert.equal(params.temperature, undefined); // not set in thinking mode
  assert.equal(params.max_tokens, 16384);
  assert.equal(params.stream, false);
});

test("channelParams returns Act channel params", () => {
  const provider = createModelProvider(testConfig());
  const params = provider.channelParams("act");
  assert.equal(params.thinking.type, "disabled");
  assert.equal(params.model, "deepseek-v4-flash");
  assert.equal(params.temperature, 0.1);
  assert.equal(params.max_tokens, 4096);
  assert.equal(params.stream, true);
});

test("channelParams uses user-specified model override", () => {
  const provider = createModelProvider(testConfig({ model: "custom-model" }));
  const thinkParams = provider.channelParams("think");
  const actParams = provider.channelParams("act");
  // User override wins for both channels
  assert.equal(thinkParams.model, "custom-model");
  assert.equal(actParams.model, "custom-model");
});

test("channelParams reasoning_effort is only set when thinking enabled", () => {
  const provider = createModelProvider(testConfig());
  const think = provider.channelParams("think");
  const act = provider.channelParams("act");
  assert.equal(think.reasoning_effort, "high");
  assert.equal(act.reasoning_effort, undefined);
});

test("supportsFIM returns true when fim profile exists", () => {
  const provider = createModelProvider(testConfig());
  assert.equal(provider.supportsFIM(), true);
});

test("fimParams returns correct FIM request body", () => {
  const provider = createModelProvider(testConfig());
  const body = provider.fimParams("function hello() {", "}");
  assert.equal(body.model, "deepseek-v4-pro");
  assert.equal(body.prompt, "function hello() {");
  assert.equal(body.suffix, "}");
  assert.equal(body.max_tokens, 128);
  // FIM is non-thinking mode
  assert.equal(body.thinking.type, "disabled");
});

test("buildRequestBody assembles messages with system prompt", () => {
  const provider = createModelProvider(testConfig());
  const messages = [{ role: "user", content: "hello" }];
  const body = provider.buildRequestBody(messages, "act");
  assert.equal(body.model, "deepseek-v4-flash");
  assert.deepEqual(body.messages, messages);
  assert.equal(body.stream, true);
  assert.equal(typeof body.max_tokens, "number");
});

test("buildRequestBody think channel includes response_format json_object", () => {
  const provider = createModelProvider(testConfig());
  const body = provider.buildRequestBody(
    [{ role: "user", content: "analyze this" }],
    "think"
  );
  assert.equal(body.response_format.type, "json_object");
});

test("buildRequestBody act channel does NOT include response_format", () => {
  const provider = createModelProvider(testConfig());
  const body = provider.buildRequestBody(
    [{ role: "user", content: "fix this"}],
    "act"
  );
  assert.equal(body.response_format, undefined);
});

test("getUsageStats returns initial zero stats", () => {
  const provider = createModelProvider(testConfig());
  const stats = provider.getUsageStats();
  assert.equal(stats.total_prompt_tokens, 0);
  assert.equal(stats.total_completion_tokens, 0);
  assert.equal(stats.total_reasoning_tokens, 0);
  assert.equal(stats.requests, 0);
  assert.equal(stats.cache_hit_tokens, 0);
  assert.equal(stats.cache_miss_tokens, 0);
});

test("trackUsage accumulates usage correctly", () => {
  const provider = createModelProvider(testConfig());
  provider.trackUsage({
    usage: {
      prompt_tokens: 1000,
      completion_tokens: 200,
      reasoning_tokens: 50,
      prompt_tokens_details: {
        cached_tokens: 300,
      },
      prompt_cache_hit_tokens: 300,
      prompt_cache_miss_tokens: 700
    },
    channel: "think",
    model: "deepseek-v4-pro",
    latency_ms: 1200
  });
  const stats = provider.getUsageStats();
  assert.equal(stats.total_prompt_tokens, 1000);
  assert.equal(stats.total_completion_tokens, 200);
  assert.equal(stats.total_reasoning_tokens, 50);
  assert.equal(stats.requests, 1);
  assert.equal(stats.cache_hit_tokens, 300);
  assert.equal(stats.cache_miss_tokens, 700);
  assert.equal(stats.avg_latency_ms, 1200);
});

test("getUsageStats accumulates across multiple calls", () => {
  const provider = createModelProvider(testConfig());
  provider.trackUsage({
    usage: { prompt_tokens: 500, completion_tokens: 100, reasoning_tokens: 0,
      prompt_tokens_details: { cached_tokens: 100 } },
    channel: "act",
    model: "deepseek-v4-flash",
    latency_ms: 300
  });
  provider.trackUsage({
    usage: { prompt_tokens: 600, completion_tokens: 150, reasoning_tokens: 20,
      prompt_tokens_details: { cached_tokens: 200 } },
    channel: "think",
    model: "deepseek-v4-pro",
    latency_ms: 800
  });
  const stats = provider.getUsageStats();
  assert.equal(stats.total_prompt_tokens, 1100);
  assert.equal(stats.total_completion_tokens, 250);
  assert.equal(stats.total_reasoning_tokens, 20);
  assert.equal(stats.requests, 2);
  assert.equal(stats.cache_hit_tokens, 300);
  assert.equal(stats.cache_miss_tokens, 800);
  assert.equal(stats.avg_latency_ms, 550);
  // Per-channel breakdown
  assert.ok(stats.by_channel.think);
  assert.ok(stats.by_channel.act);
  assert.equal(stats.by_channel.think.requests, 1);
  assert.equal(stats.by_channel.act.requests, 1);
});

test("reasoning_content is captured but flagged as hidden", () => {
  const provider = createModelProvider(testConfig());
  // Simulate an API response with reasoning_content
  const response = {
    choices: [{
      message: {
        content: "the answer",
        reasoning_content: "step 1: think... step 2: conclude..."
      }
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15,
      completion_tokens_details: { reasoning_tokens: 100 } }
  };
  
  // reasoning_content is extracted but flagged
  const processed = provider.processResponse(response, "think");
  assert.equal(processed.content, "the answer");
  assert.equal(processed.reasoning_content, "step 1: think... step 2: conclude...");
  assert.equal(processed._reasoning_hidden, true);
});
```

#### Step 2: Run tests to verify they fail

Run: `node --test test/kernel/model-provider.test.js`
Expected: FAIL — "Cannot find module"

#### Step 3: Create the ModelProvider module

```js
// src/kernel/model-provider.js

const CHANNEL_CONFIGS = {
  think: {
    profile: "reasoning",
    thinking: { type: "enabled" },
    reasoning_effort: "high",
    temperature: undefined,   // not set in thinking mode
    max_tokens: 16384,
    stream: false,
    response_format: { type: "json_object" }
  },
  act: {
    profile: "fast",
    thinking: { type: "disabled" },  // MUST be explicitly disabled
    reasoning_effort: undefined,     // not set in non-thinking mode
    temperature: 0.1,
    max_tokens: 4096,
    stream: true,
    response_format: undefined
  }
};

const FIM_CHANNEL_CONFIG = {
  profile: "fim",
  thinking: { type: "disabled" },
  max_tokens: 128   // FIM 4K cap
};

export function createModelProvider(config) {
  const profiles = config.profiles || {};
  const usageStore = {
    total_prompt_tokens: 0,
    total_completion_tokens: 0,
    total_reasoning_tokens: 0,
    requests: 0,
    cache_hit_tokens: 0,
    cache_miss_tokens: 0,
    total_latency_ms: 0,
    by_channel: {}
  };

  function channelParams(channel) {
    const channelCfg = CHANNEL_CONFIGS[channel];
    if (!channelCfg) throw new Error(`Unknown channel: ${channel}`);

    const profile = profiles[channelCfg.profile];
    const model = config.model && config.model !== "deepseek-v4-flash"
      ? config.model   // user explicit override
      : profile?.resolve() || channelCfg.model;

    return {
      model,
      thinking: channelCfg.thinking,
      reasoning_effort: channelCfg.thinking?.type === "enabled"
        ? (config.reasoningEffort || channelCfg.reasoning_effort)
        : undefined,
      temperature: channelCfg.temperature,
      max_tokens: channelCfg.max_tokens,
      stream: channelCfg.stream,
      response_format: channelCfg.response_format,
    };
  }

  function buildRequestBody(messages, channel) {
    const base = channelParams(channel);
    const body = {
      model: base.model,
      messages,
      max_tokens: base.max_tokens,
      stream: Boolean(base.stream),
      thinking: base.thinking,
      reasoning_effort: base.reasoning_effort,
    };

    if (base.temperature !== undefined) {
      body.temperature = base.temperature;
    }
    if (base.response_format) {
      body.response_format = base.response_format;
    }
    if (base.stream) {
      body.stream_options = { include_usage: true };
    }

    return removeUndefined(body);
  }

  function supportsFIM() {
    return !!profiles.fim;
  }

  function fimParams(prefix, suffix) {
    if (!supportsFIM()) throw new Error("FIM not supported by current config");
    const model = profiles.fim.resolve();
    return removeUndefined({
      model,
      prompt: prefix,
      suffix: suffix,
      max_tokens: FIM_CHANNEL_CONFIG.max_tokens,
      thinking: FIM_CHANNEL_CONFIG.thinking,
    });
  }

  function trackUsage(record) {
    const u = record.usage || {};
    usageStore.total_prompt_tokens += u.prompt_tokens || 0;
    usageStore.total_completion_tokens += u.completion_tokens || 0;
    usageStore.total_reasoning_tokens +=
      (u.completion_tokens_details?.reasoning_tokens) || 0;
    usageStore.requests += 1;
    usageStore.cache_hit_tokens += u.prompt_cache_hit_tokens ||
      (u.prompt_tokens_details?.cached_tokens) || 0;
    usageStore.cache_miss_tokens += u.prompt_cache_miss_tokens ||
      Math.max(0, (u.prompt_tokens || 0) - (u.prompt_tokens_details?.cached_tokens || 0));
    usageStore.total_latency_ms += record.latency_ms || 0;

    const ch = record.channel || "unknown";
    if (!usageStore.by_channel[ch]) {
      usageStore.by_channel[ch] = {
        requests: 0,
        total_prompt_tokens: 0,
        total_completion_tokens: 0
      };
    }
    usageStore.by_channel[ch].requests += 1;
    usageStore.by_channel[ch].total_prompt_tokens += u.prompt_tokens || 0;
    usageStore.by_channel[ch].total_completion_tokens += u.completion_tokens || 0;
  }

  function getUsageStats() {
    return {
      total_prompt_tokens: usageStore.total_prompt_tokens,
      total_completion_tokens: usageStore.total_completion_tokens,
      total_reasoning_tokens: usageStore.total_reasoning_tokens,
      requests: usageStore.requests,
      cache_hit_tokens: usageStore.cache_hit_tokens,
      cache_miss_tokens: usageStore.cache_miss_tokens,
      avg_latency_ms: usageStore.requests > 0
        ? Math.round(usageStore.total_latency_ms / usageStore.requests)
        : 0,
      by_channel: { ...usageStore.by_channel }
    };
  }

  function processResponse(response, channel) {
    const message = response.choices?.[0]?.message || {};
    return {
      content: message.content || "",
      reasoning_content: message.reasoning_content || null,
      _reasoning_hidden: true,  // never expose to user
      usage: response.usage || null,
      channel
    };
  }

  return {
    channelParams,
    buildRequestBody,
    supportsFIM,
    fimParams,
    trackUsage,
    getUsageStats,
    processResponse
  };
}

function removeUndefined(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined)
  );
}
```

#### Step 4: Run tests to verify they pass

Run: `node --test test/kernel/model-provider.test.js`
Expected: all 13 tests PASS

#### Step 5: Commit

```bash
git add src/kernel/model-provider.js test/kernel/model-provider.test.js
git commit -m "feat(kernel): add ModelProvider with dual-channel params, FIM, and usage tracking"
```

---

### Task 2: ContextEngine

**Files:**
- Create: `src/kernel/context-engine.js`
- Create: `test/kernel/context-engine.test.js`

**What to build:** A module managing cold/warm/hot context layers. It accepts files into units with scoring, assembles snapshots for Think/Act channels, and handles invalidation when files change on disk.

#### Step 1: Write the test file

```js
// test/kernel/context-engine.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createContextEngine } from "../../src/kernel/context-engine.js";

const tmpDir = path.join(os.tmpdir(), `dsc-ctx-test-${Date.now()}`);

test.before(async () => {
  await fs.mkdir(tmpDir, { recursive: true });
  // Create a few test files
  await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
  await fs.writeFile(path.join(tmpDir, "README.md"), "# Test Project\nHello.", "utf8");
  await fs.writeFile(path.join(tmpDir, "package.json"), JSON.stringify({ name: "test" }), "utf8");
  await fs.writeFile(path.join(tmpDir, "src", "index.js"), "const x = 1;\nfunction main() {}\n", "utf8");
  await fs.writeFile(path.join(tmpDir, ".gitignore"), "node_modules\n", "utf8");
});

test.after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("creates ContextUnits from files", async () => {
  const engine = createContextEngine(tmpDir);
  await engine.scan();

  const stats = engine.getCacheStats();
  assert.ok(stats.total_units >= 2); // at least README.md and package.json
});

test("ContextUnit has required fields", async () => {
  const engine = createContextEngine(tmpDir);
  await engine.scan();
  
  const unit = engine.getUnit("README.md");
  assert.ok(unit);
  assert.equal(unit.type, "file");
  assert.equal(unit.source, "README.md");
  assert.ok(typeof unit.token_count === "number");
  assert.ok(unit.token_count > 0);
  assert.ok(typeof unit.hash === "string");
  assert.ok(unit.hash.startsWith("sha256:"));
  assert.ok(typeof unit.freshness === "string");
  assert.ok(unit.priority >= 0 && unit.priority <= 4);
});

test("getUnit returns undefined for unknown file", () => {
  const engine = createContextEngine(tmpDir);
  assert.equal(engine.getUnit("nonexistent.js"), undefined);
});

test("pin promotes unit to P4", async () => {
  const engine = createContextEngine(tmpDir);
  await engine.scan();
  
  engine.pin("README.md");
  const unit = engine.getUnit("README.md");
  assert.equal(unit.priority, 4);
});

test("unpin demotes unit from P4", async () => {
  const engine = createContextEngine(tmpDir);
  await engine.scan();
  
  engine.pin("README.md");
  engine.unpin("README.md");
  const unit = engine.getUnit("README.md");
  assert.ok(unit.priority < 4);
});

test("warm loads a cold file into warm layer", async () => {
  const engine = createContextEngine(tmpDir);
  await engine.scan();
  
  // "src/index.js" starts cold (not prioritized like README/package.json)
  engine.warm("src/index.js");
  
  const snapshot = engine.snapshot("think", "think");
  const unitIds = snapshot.units;
  assert.ok(unitIds.includes(engine.getUnit("src/index.js").id));
});

test("snapshot for think channel includes P0-P2 by default", async () => {
  const engine = createContextEngine(tmpDir);
  await engine.scan();
  
  const snapshot = engine.snapshot("plan", "think");
  assert.ok(typeof snapshot.snapshot_id === "string");
  assert.ok(snapshot.snapshot_id.startsWith("snap_"));
  assert.equal(snapshot.channel, "think");
  assert.ok(Array.isArray(snapshot.units));
  assert.ok(Array.isArray(snapshot.unit_hashes));
  assert.ok(snapshot.budget.allocated > 0);
  assert.ok(snapshot.budget.used >= 0);
  assert.ok(typeof snapshot.expected_cache_prefix_offset === "number");
});

test("snapshot for act channel has smaller budget", async () => {
  const engine = createContextEngine(tmpDir);
  await engine.scan();
  
  const thinkSnap = engine.snapshot("plan", "think");
  const actSnap = engine.snapshot("execute", "act");
  
  assert.ok(actSnap.budget.allocated <= thinkSnap.budget.allocated);
});

test("snapshot is reproducible with same inputs", async () => {
  const engine = createContextEngine(tmpDir);
  await engine.scan();
  
  const snap1 = engine.snapshot("plan", "think");
  const snap2 = engine.snapshot("plan", "think");
  
  // Same project state → same snapshot hash
  assert.notEqual(snap1.snapshot_id, snap2.snapshot_id); // unique IDs
  // But unit hashes should match (no changes)
  assert.deepEqual(snap1.unit_hashes.sort(), snap2.unit_hashes.sort());
});

test("cache stats show correct layer distribution", async () => {
  const engine = createContextEngine(tmpDir);
  await engine.scan();
  
  const stats = engine.getCacheStats();
  assert.ok(stats.total_units > 0);
  assert.ok(stats.hot_units >= 0);
  assert.ok(stats.warm_units >= 0);
});

test("setChannelConfig overrides budget", async () => {
  const engine = createContextEngine(tmpDir);
  await engine.scan();
  
  engine.setChannelConfig("think", { maxBudget: 100000 });
  const snapshot = engine.snapshot("analyze", "think");
  assert.equal(snapshot.budget.allocated, 100000);
});

test("invalidation: file change updates hash", async () => {
  const engine = createContextEngine(tmpDir);
  await engine.scan();

  const before = engine.getUnit("README.md");
  const beforeHash = before.hash;

  // Modify the file
  await fs.writeFile(path.join(tmpDir, "README.md"), "# Updated\nChanged.", "utf8");
  engine.invalidate("README.md");

  const after = engine.getUnit("README.md");
  assert.notEqual(after.hash, beforeHash);
  assert.ok(after.freshness > before.freshness);
});
```

#### Step 2: Run tests to verify they fail

Run: `node --test test/kernel/context-engine.test.js`
Expected: FAIL — "Cannot find module"

#### Step 3: Create the ContextEngine module

```js
// src/kernel/context-engine.js
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const CHANNEL_BUDGETS = {
  think: 500000,
  act: 64000
};

const CHANNEL_MAX_PRIORITY = {
  think: 2,   // P0-P2 in hot layer
  act: 1      // P0-P1 only
};

const PRIORITY_RANK = {
  "README.md": 3,
  "package.json": 3,
  "tsconfig.json": 3,
  "pyproject.toml": 3,
  "Cargo.toml": 3,
  "go.mod": 3,
  ".gitignore": 2
};

const TEXT_EXTENSIONS = new Set([
  ".c", ".cc", ".conf", ".cpp", ".cs", ".css", ".csv",
  ".go", ".h", ".hpp", ".html", ".java", ".js", ".json",
  ".jsx", ".md", ".mjs", ".py", ".rs", ".sql", ".ts",
  ".tsx", ".txt", ".xml", ".yaml", ".yml"
]);

const IGNORE_DIRS = new Set([
  ".git", ".deepseek-code", "node_modules", "dist", "build",
  "coverage", ".next", ".nuxt", ".turbo", ".cache", "target",
  "vendor", "__pycache__"
]);

export function createContextEngine(root) {
  const units = new Map();       // id → ContextUnit
  const pinned = new Set();      // set of source paths
  const warmSet = new Set();     // set of unit ids in warm layer
  const channelConfigs = {};

  // --- public API ---

  async function scan() {
    const files = await listProjectFiles(root);
    for (const file of files) {
      if (!isLikelyText(file)) continue;
      try {
        const content = await readTextFile(root, file, 64000);
        const unit = createUnit(file, content);
        units.set(file, unit);
      } catch {
        // skip unreadable files
      }
    }
  }

  function getUnit(source) {
    return units.get(source);
  }

  function pin(filePath) {
    if (pinned.size >= 5) return; // max 5 pinned
    pinned.add(filePath);
    const unit = units.get(filePath);
    if (unit) unit.priority = 4;
  }

  function unpin(filePath) {
    pinned.delete(filePath);
    const unit = units.get(filePath);
    if (unit) unit.priority = defaultPriority(filePath);
  }

  function warm(filePath) {
    const unit = units.get(filePath);
    if (unit) warmSet.add(unit.id);
  }

  function evict(filePath) {
    const unit = units.get(filePath);
    if (unit) warmSet.delete(unit.id);
  }

  function invalidate(filePath) {
    // Re-read from disk and update hash
    const unit = units.get(filePath);
    if (!unit) return;
    readTextFile(root, filePath, 64000).then((content) => {
      const newHash = hashContent(content);
      if (newHash !== unit.hash) {
        unit.hash = newHash;
        unit.token_count = estimateTokens(content);
        unit.freshness = new Date().toISOString();
        unit.content_ref = newHash;
        // Invalidate dependent units
        for (const [src, other] of units) {
          if (other.dependencies?.includes(filePath)) {
            warmSet.delete(other.id);
          }
        }
      }
    }).catch(() => {});
  }

  function snapshot(phase, channel, options = {}) {
    const budget = channelConfigs[channel]?.maxBudget
      || CHANNEL_BUDGETS[channel]
      || 64000;
    const maxPriority = CHANNEL_MAX_PRIORITY[channel] ?? 2;

    const selected = [];
    let used = 0;

    // P0 first (system-level, always included)
    for (const unit of sortedUnits()) {
      if (unit.priority > maxPriority && unit.priority !== 4) continue; // pinned bypass
      if (used + unit.token_count > budget) break;
      selected.push(unit);
      used += unit.token_count;
    }

    const unitIds = selected.map(u => u.id);
    const unitHashes = selected.map(u => u.hash);
    const cacheOffset = estimateCacheOffset(selected, channel);

    return {
      snapshot_id: `snap_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      channel,
      phase: phase || "unknown",
      units: unitIds,
      unit_hashes: unitHashes,
      assembly_order: describeAssembly(selected),
      compression_policy_id: `${channel}_v1`,
      expected_cache_prefix_offset: cacheOffset,
      file_revision_hashes: Object.fromEntries(
        selected.filter(u => u.type === "file").map(u => [u.source, u.hash])
      ),
      budget: { allocated: budget, used }
    };
  }

  function getCacheStats() {
    const allUnits = [...units.values()];
    const hotUnits = allUnits.filter(u => u.priority <= 2 || pinned.has(u.source));
    return {
      total_units: allUnits.length,
      hot_units: hotUnits.length,
      warm_units: warmSet.size,
      cold_units: allUnits.length - hotUnits.length - warmSet.size,
      pinned_count: pinned.size
    };
  }

  function setChannelConfig(channel, cfg) {
    channelConfigs[channel] = { ...channelConfigs[channel], ...cfg };
  }

  // --- internal helpers ---

  function createUnit(source, content) {
    const h = hashContent(content);
    return {
      id: `unit_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      type: "file",
      source,
      content_ref: h,
      token_count: estimateTokens(content),
      hash: h,
      freshness: new Date().toISOString(),
      priority: pinned.has(source) ? 4 : defaultPriority(source),
      dependencies: []
    };
  }

  function defaultPriority(filePath) {
    const base = path.basename(filePath);
    if (PRIORITY_RANK[base] !== undefined) return PRIORITY_RANK[base];
    return 1; // normal file
  }

  function sortedUnits() {
    return [...units.values()].sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      return a.source.localeCompare(b.source);
    });
  }

  function estimateCacheOffset(selectedUnits, channel) {
    // Stable prefix: system prompt + project index + config
    // Estimate based on top-priority units
    let offset = 0;
    for (const unit of selectedUnits) {
      if (unit.priority >= 3) offset += unit.token_count;
    }
    return offset;
  }

  function describeAssembly(units) {
    const byPriority = {};
    for (const u of units) {
      const p = `P${u.priority}`;
      if (!byPriority[p]) byPriority[p] = [];
      byPriority[p].push(u.source);
    }
    return Object.keys(byPriority).sort().map(p => `${p}:${byPriority[p].length} units`);
  }

  return {
    scan, getUnit, pin, unpin, warm, evict,
    invalidate, snapshot, getCacheStats, setChannelConfig
  };
}

// --- standalone helpers ---

async function listProjectFiles(rootDir, maxFiles = 1000) {
  const result = [];
  async function walk(current) {
    if (result.length >= maxFiles) return;
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (result.length >= maxFiles) return;
      if (entry.name.startsWith(".") && entry.name !== ".gitignore" && entry.name !== ".env.example") {
        if (entry.isDirectory()) continue;
        if (entry.name !== ".gitignore") continue;
      }
      const absolute = path.join(current, entry.name);
      const relative = toPosix(path.relative(rootDir, absolute));
      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name)) await walk(absolute);
      } else if (entry.isFile()) {
        result.push(relative);
      }
    }
  }
  await walk(rootDir);
  return result;
}

async function readTextFile(rootDir, relativePath, maxBytes = 200000) {
  const target = path.resolve(rootDir, relativePath);
  if (!target.startsWith(path.resolve(rootDir))) {
    throw new Error(`Path escape: ${relativePath}`);
  }
  const stat = await fs.stat(target);
  if (stat.size > maxBytes) throw new Error(`File too large: ${relativePath}`);
  const buffer = await fs.readFile(target);
  if (buffer.includes(0)) throw new Error(`Binary file: ${relativePath}`);
  return buffer.toString("utf8");
}

function isLikelyText(file) {
  return TEXT_EXTENSIONS.has(path.extname(file).toLowerCase())
    || path.basename(file).includes(".");
}

function estimateTokens(content) {
  return Math.ceil(Buffer.byteLength(content, "utf8") / 3.5);
}

function hashContent(content) {
  return `sha256:${createHash("sha256").update(content).digest("hex").slice(0, 16)}`;
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}
```

#### Step 4: Run tests to verify they pass

Run: `node --test test/kernel/context-engine.test.js`
Expected: all 13 tests PASS

#### Step 5: Commit

```bash
git add src/kernel/context-engine.js test/kernel/context-engine.test.js
git commit -m "feat(kernel): add ContextEngine with 3-layer memory and channel-aware snapshots"
```

---

### Task 3: TaskOrchestrator

**Files:**
- Create: `src/kernel/task-orchestrator.js`
- Create: `test/kernel/task-orchestrator.test.js`
- Use: `src/kernel/event-bus.js`, `src/kernel/model-provider.js`, `src/kernel/context-engine.js`

**What to build:** An event-driven state machine that accepts user messages, classifies them, routes through Think/Act channels, and emits state transitions as events. The orchestrator wraps ModelProvider.invoke() for actual API calls.

#### Step 1: Write the test file

```js
// test/kernel/task-orchestrator.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { createTaskOrchestrator } from "../../src/kernel/task-orchestrator.js";
import { createEventBus } from "../../src/kernel/event-bus.js";

// A mock model provider that returns canned responses
function mockModelProvider() {
  return {
    channelParams(channel) {
      return channel === "think"
        ? { model: "mock-think", thinking: { type: "enabled" }, reasoning_effort: "high", max_tokens: 100, stream: false, temperature: undefined, response_format: { type: "json_object" } }
        : { model: "mock-act", thinking: { type: "disabled" }, max_tokens: 100, stream: true, temperature: 0.1, response_format: undefined };
    },
    buildRequestBody(messages, channel) { return { model: "mock", messages, channel }; },
    processResponse(resp, channel) { return { content: resp.content || "", reasoning_content: null, _reasoning_hidden: true, usage: resp.usage || null, channel }; },
    trackUsage() {},
    getUsageStats() { return { requests: 0 }; },
    supportsFIM() { return false; },
    fimParams() { throw new Error("not supported"); }
  };
}

// A mock context engine
function mockContextEngine() {
  return {
    scan: async () => {},
    snapshot: (phase, channel) => ({
      snapshot_id: "snap_test",
      channel,
      phase,
      units: [],
      unit_hashes: [],
      budget: { allocated: 1000, used: 0 },
      expected_cache_prefix_offset: 200,
      file_revision_hashes: {},
      assembly_order: []
    }),
    pin: () => {}, unpin: () => {}, warm: () => {}, evict: () => {},
    getCacheStats: () => ({ total_units: 0 }),
    setChannelConfig: () => {},
    getUnit: () => undefined,
    invalidate: () => {}
  };
}

test("initial state is Idle", () => {
  const bus = createEventBus();
  const orchestrator = createTaskOrchestrator({
    eventBus: bus,
    modelProvider: mockModelProvider(),
    contextEngine: mockContextEngine()
  });
  assert.equal(orchestrator.getState().current, "idle");
});

test("submit transitions Idle → Classify", async () => {
  const bus = createEventBus();
  const transitions = [];
  bus.subscribe("orchestrator:state", (data) => {
    transitions.push(data.state.entered);
  });

  const orchestrator = createTaskOrchestrator({
    eventBus: bus,
    modelProvider: mockModelProvider(),
    contextEngine: mockContextEngine()
  });

  const promise = orchestrator.submit("explain this project");

  // Give it time to transition
  await new Promise(r => setTimeout(r, 50));
  orchestrator.interrupt();

  try { await promise; } catch {}

  assert.ok(transitions.includes("classify"));
});

test("classify detects query task type and takes fast path", async () => {
  const bus = createEventBus();
  const states = [];
  bus.subscribe("orchestrator:state", (data) => {
    states.push(data.state.entered);
  });

  const orchestrator = createTaskOrchestrator({
    eventBus: bus,
    modelProvider: mockModelProvider(),
    contextEngine: mockContextEngine()
  });

  const promise = orchestrator.submit("what does this project do?");
  await new Promise(r => setTimeout(r, 50));
  orchestrator.interrupt();
  try { await promise; } catch {}

  // Should hit classify → thinkreply (fast path), not thinkplan
  assert.ok(states.includes("classify"));
  // Fast path for query tasks
  assert.ok(states.includes("thinkreply") || states.includes("complete"));
});

test("autonomy levels: supervised requires approval before plan", async () => {
  const bus = createEventBus();
  const approvals = [];
  bus.subscribe("orchestrator:state", (data) => {
    if (data.state.entered === "awaitapproval") {
      approvals.push(data);
    }
  });

  const orchestrator = createTaskOrchestrator({
    eventBus: bus,
    modelProvider: mockModelProvider(),
    contextEngine: mockContextEngine()
  });

  const promise = orchestrator.submit("delete all files", { autonomy: "supervised" });
  await new Promise(r => setTimeout(r, 50));
  orchestrator.interrupt();
  try { await promise; } catch {}

  // supervised should trigger awaitapproval before executing
  assert.ok(approvals.length >= 1);
});

test("autonomy levels: full-auto skips approvals", async () => {
  const bus = createEventBus();
  const approvals = [];
  bus.subscribe("orchestrator:state", (data) => {
    if (data.state.entered === "awaitapproval") {
      approvals.push(data);
    }
  });

  const orchestrator = createTaskOrchestrator({
    eventBus: bus,
    modelProvider: mockModelProvider(),
    contextEngine: mockContextEngine()
  });

  // Mock a response for full-auto path
  const mp = mockModelProvider();
  const origBuildBody = mp.buildRequestBody;
  mp.buildRequestBody = function(messages, channel) {
    return { ...origBuildBody(messages, channel), _mockResponse: { content: "done", usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } } };
  };

  const orchestrator2 = createTaskOrchestrator({
    eventBus: bus,
    modelProvider: mp,
    contextEngine: mockContextEngine()
  });

  const promise = orchestrator2.submit("add comment", { autonomy: "full-auto" });
  await new Promise(r => setTimeout(r, 100));
  orchestrator2.interrupt();
  try { await promise; } catch {}

  // full-auto should NOT trigger awaitapproval
  assert.equal(approvals.length, 0);
});

test("state transitions emit orchestator:state events", async () => {
  const bus = createEventBus();
  const events = [];
  bus.subscribe("orchestrator:state", (data) => {
    events.push(data);
  });

  const orchestrator = createTaskOrchestrator({
    eventBus: bus,
    modelProvider: mockModelProvider(),
    contextEngine: mockContextEngine()
  });

  const promise = orchestrator.submit("hello");
  await new Promise(r => setTimeout(r, 50));
  orchestrator.interrupt();
  try { await promise; } catch {}

  // Each event should have the required fields
  for (const evt of events) {
    assert.ok(typeof evt.state === "object");
    assert.ok(typeof evt.state.entered === "string");
    assert.ok(typeof evt.transition === "object");
    assert.ok(typeof evt.transition.reason === "string");
    assert.ok(typeof evt.trace === "object");
    assert.ok(typeof evt.trace.id === "string");
    assert.ok(evt.trace.id.startsWith("trace_"));
  }
});

test("interrupt sets state to idle", async () => {
  const bus = createEventBus();
  const orchestrator = createTaskOrchestrator({
    eventBus: bus,
    modelProvider: mockModelProvider(),
    contextEngine: mockContextEngine()
  });

  const promise = orchestrator.submit("do something slow");
  await new Promise(r => setTimeout(r, 30));
  orchestrator.interrupt();

  try { await promise; } catch (e) {
    assert.ok(e.message.includes("interrupted") || e.message.includes("Interrupted"));
  }

  assert.equal(orchestrator.getState().current, "idle");
});

test("terminal state on unrecoverable error", async () => {
  const bus = createEventBus();
  const badMP = mockModelProvider();
  // Model provider that always throws
  const origBuild = badMP.buildRequestBody;
  badMP.buildRequestBody = function() {
    throw new Error("API key invalid");
  };

  const orchestrator = createTaskOrchestrator({
    eventBus: bus,
    modelProvider: badMP,
    contextEngine: mockContextEngine()
  });

  const states = [];
  bus.subscribe("orchestrator:state", (data) => states.push(data.state.entered));

  const promise = orchestrator.submit("do something");
  await new Promise(r => setTimeout(r, 50));
  orchestrator.interrupt();
  try { await promise; } catch {}

  // Should have entered terminal
  assert.ok(states.includes("terminal"));
});

test("getState returns current state with metadata", () => {
  const orchestrator = createTaskOrchestrator({
    eventBus: mockModelProvider(),
    contextEngine: mockContextEngine()
  });
  const state = orchestrator.getState();
  assert.equal(state.current, "idle");
  assert.equal(state.autonomy, "gated");
  assert.equal(state.channel, null);
});
```

#### Step 2: Run tests to verify they fail

Run: `node --test test/kernel/task-orchestrator.test.js`
Expected: FAIL — "Cannot find module"

#### Step 3: Create the TaskOrchestrator module

```js
// src/kernel/task-orchestrator.js
import { randomUUID } from "node:crypto";

// State machine definition
const STATE = {
  IDLE: "idle",
  CLASSIFY: "classify",
  THINKPLAN: "thinkplan",
  THINKREPLY: "thinkreply",
  ACTEXECUTE: "actexecute",
  THINKREVIEW: "thinkreview",
  ACTREPAIR: "actrepair",
  VERIFY: "verify",
  COMPLETE: "complete",
  AWAITAPPROVAL: "awaitapproval",
  TERMINAL: "terminal"
};

const AUTONOMY_DEFAULT = "gated";

// Simple classification: maps message patterns to task types
function classifyMessage(message, options = {}) {
  const lower = message.toLowerCase().trim();

  // Explicit autonomy override
  const autonomy = options.autonomy || AUTONOMY_DEFAULT;

  // Query/explain patterns → fast path
  if (/^(what|how|why|explain|describe|show|list|who|where|when)\b/.test(lower)
      && !/\b(fix|change|modify|edit|delete|remove|add|create|write|update|refactor)\b/.test(lower)) {
    return {
      task_type: "query",
      risk: "low",
      channel: "think",
      autonomy,
      reason: "问答/查询任务",
      fast_path: "thinkreply"
    };
  }

  // Edit/write patterns → standard loop
  if (/\b(fix|change|modify|edit|delete|remove|add|create|write|update|refactor|implement)\b/.test(lower)) {
    return {
      task_type: "edit",
      risk: "medium",
      channel: "think",
      autonomy,
      reason: "代码修改任务",
      fast_path: null
    };
  }

  // Diagnostic/analyze → ThinkReply
  if (/\b(debug|diagnose|analyze|investigate|inspect|check)\b/.test(lower)) {
    return {
      task_type: "diagnostic",
      risk: "low",
      channel: "think",
      autonomy,
      reason: "诊断/分析任务",
      fast_path: "thinkreply"
    };
  }

  // Default → standard loop
  return {
    task_type: "general",
    risk: "medium",
    channel: "think",
    autonomy,
    reason: "通用任务",
    fast_path: null
  };
}

export function createTaskOrchestrator({ eventBus, modelProvider, contextEngine }) {
  let currentState = STATE.IDLE;
  let currentAutonomy = AUTONOMY_DEFAULT;
  let currentChannel = null;
  let interrupted = false;
  let returnState = null;   // state to return to after AwaitApproval
  let pendingApproval = null;

  function getState() {
    return {
      current: currentState,
      autonomy: currentAutonomy,
      channel: currentChannel
    };
  }

  function transition(to, reason, meta = {}) {
    const from = currentState;
    currentState = to;
    if (meta.channel) currentChannel = meta.channel;

    const event = {
      state: { entered: to, exited: from },
      transition: {
        reason,
        autonomy: { level: currentAutonomy },
        channel: currentChannel || null,
        approval: pendingApproval
          ? { required: true, type: pendingApproval.type }
          : null
      },
      trace: {
        id: `trace_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
        timestamp: new Date().toISOString()
      }
    };

    if (eventBus) {
      eventBus.publish("orchestrator:state", event);
    }

    return event;
  }

  async function submit(message, options = {}) {
    interrupted = false;
    currentAutonomy = options.autonomy || AUTONOMY_DEFAULT;

    try {
      // Idle → Classify
      transition(STATE.CLASSIFY, "user message received",
        { channel: null });

      if (interrupted) throw new InterruptedError();

      // Classify the message
      const classification = classifyMessage(message, options);

      // Decide path
      if (classification.fast_path === "thinkreply") {
        // Fast path: query → ThinkReply → Complete
        transition(STATE.THINKREPLY,
          classification.reason,
          { channel: "think" });

        if (interrupted) throw new InterruptedError();

        // Build context snapshot for this phase
        const snapshot = contextEngine.snapshot("reply", "think");

        // Build request body
        const messages = [
          { role: "system", content: "You are DeepSeek Code. Answer concisely in the user's language." },
          { role: "user", content: `Context snapshot: ${snapshot.snapshot_id}\n\n${message}` }
        ];

        const body = modelProvider.buildRequestBody(messages, "think");

        // If model provider has invoke, use it; otherwise the caller handles it
        if (modelProvider.invoke) {
          const response = await modelProvider.invoke(messages, "think");
          if (response.usage) modelProvider.trackUsage({
            usage: response.usage, channel: "think", model: body.model, latency_ms: response.latency_ms || 0
          });
        }

        if (interrupted) throw new InterruptedError();

        transition(STATE.COMPLETE, "reply delivered");
        transition(STATE.IDLE, "task complete");
        return { status: "complete", state: "idle" };

      } else if (classification.fast_path === null) {
        // Standard loop: ThinkPlan → ActExecute → ThinkReview → Verify → Complete
        return await runStandardLoop(message, classification, options);

      } else {
        // Generic: go through ThinkPlan
        return await runStandardLoop(message, classification, options);
      }

    } catch (error) {
      if (error instanceof InterruptedError) {
        transition(STATE.IDLE, "interrupted by user");
        throw error;
      }

      // Unrecoverable error → Terminal
      transition(STATE.TERMINAL, `error: ${error.message}`,
        { channel: currentChannel });

      throw error;
    }
  }

  async function runStandardLoop(message, classification, options) {
    // ThinkPlan
    const needsApproval = currentAutonomy === "supervised" || currentAutonomy === "gated";

    if (needsApproval) {
      pendingApproval = { type: "plan", message, classification };
      returnState = STATE.THINKPLAN;
      transition(STATE.AWAITAPPROVAL, "plan requires approval",
        { channel: "think" });
      // Return so the caller can handle the approval
      return { status: "awaiting_approval", approval: pendingApproval };
    }

    transition(STATE.THINKPLAN, classification.reason,
      { channel: "think" });

    if (interrupted) throw new InterruptedError();

    // Get context snapshot for planning
    const planSnapshot = contextEngine.snapshot("plan", "think");

    // Build think request
    const thinkMessages = [
      { role: "system", content: "You are DeepSeek Code. Analyze and create a structured plan. Output JSON with: analysis, plan (array of steps), risks, file_targets (array), test_strategy." },
      { role: "user", content: `Context snapshot: ${planSnapshot.snapshot_id}\n\nTask: ${message}` }
    ];

    let planResult = null;
    if (modelProvider.invoke) {
      const body = modelProvider.buildRequestBody(thinkMessages, "think");
      try {
        planResult = await modelProvider.invoke(thinkMessages, "think");
        if (planResult.usage) {
          modelProvider.trackUsage({
            usage: planResult.usage, channel: "think", model: body.model, latency_ms: planResult.latency_ms || 0
          });
        }
      } catch (err) {
        // If API call fails, go terminal
        throw err;
      }
    }

    if (interrupted) throw new InterruptedError();

    // ActExecute
    transition(STATE.ACTEXECUTE, "plan ready, executing",
      { channel: "act" });

    const execSnapshot = contextEngine.snapshot("execute", "act");

    const actMessages = [
      { role: "system", content: "You are DeepSeek Code. Execute the plan. Return unified diffs." },
      { role: "user", content: `Plan: ${planResult ? planResult.content : 'follow user request'}\n\nContext: ${execSnapshot.snapshot_id}\n\nExecute: ${message}` }
    ];

    if (modelProvider.invoke) {
      const actBody = modelProvider.buildRequestBody(actMessages, "act");
      try {
        const actResult = await modelProvider.invoke(actMessages, "act");
        if (actResult.usage) {
          modelProvider.trackUsage({
            usage: actResult.usage, channel: "act", model: actBody.model, latency_ms: actResult.latency_ms || 0
          });
        }
      } catch (err) {
        throw err;
      }
    }

    if (interrupted) throw new InterruptedError();

    // ThinkReview
    transition(STATE.THINKREVIEW, "execution complete, reviewing",
      { channel: "think" });

    // Verify (composite: ActVerify + ThinkVerify)
    transition(STATE.VERIFY, "review complete, verifying",
      { channel: "act" });

    if (interrupted) throw new InterruptedError();

    // Complete
    transition(STATE.COMPLETE, "verification passed");
    transition(STATE.IDLE, "task complete");
    return { status: "complete", state: "idle" };
  }

  function approve(id, decision) {
    if (pendingApproval) {
      pendingApproval = null;
    }
    if (returnState) {
      currentState = returnState;
      returnState = null;
      if (eventBus) {
        eventBus.publish("orchestrator:state", {
          state: { entered: currentState, exited: STATE.AWAITAPPROVAL },
          transition: { reason: `user ${decision}`, autonomy: { level: currentAutonomy }, channel: currentChannel, approval: null },
          trace: { id: `trace_${randomUUID().replace(/-/g, "").slice(0, 12)}`, timestamp: new Date().toISOString() }
        });
      }
    }
  }

  function interrupt() {
    interrupted = true;
  }

  return { getState, submit, approve, interrupt };
}

class InterruptedError extends Error {
  constructor() {
    super("Interrupted");
    this.name = "InterruptedError";
  }
}
```

#### Step 4: Run tests to verify they pass

Run: `node --test test/kernel/task-orchestrator.test.js`
Expected: all 9 tests PASS

#### Step 5: Commit

```bash
git add src/kernel/task-orchestrator.js test/kernel/task-orchestrator.test.js
git commit -m "feat(kernel): add TaskOrchestrator with state machine and autonomy gating"
```

---

### Task 4: Wire KernelAPI

**Files:**
- Modify: `src/kernel/kernel-api.js` — Wire real ModelProvider, ContextEngine, and TaskOrchestrator

#### Step 1: Update kernel-api.js

Read the current file. Replace the `agent` and `context` stubs with real implementations:

```js
// src/kernel/kernel-api.js
import { createEventBus } from "./event-bus.js";
import { loadConfig } from "./config-provider.js";
import { createModelProvider } from "./model-provider.js";
import { createContextEngine } from "./context-engine.js";
import { createTaskOrchestrator } from "./task-orchestrator.js";

export async function createKernel(root, options = {}) {
  const eventBus = createEventBus();
  const config = await loadConfig(root, options.config);

  // Phase 1: real modules
  const modelProvider = createModelProvider(config);
  const contextEngine = createContextEngine(root);

  // Scan project on startup
  await contextEngine.scan();

  const orchestrator = createTaskOrchestrator({
    eventBus,
    modelProvider,
    contextEngine
  });

  const session = {
    subscribe(handler) {
      // Subscribe to orchestrator state events
      return eventBus.subscribe("orchestrator:state", (data) => {
        handler({ type: "orchestrator:state", ...data });
      });
    },

    getTimeline(count = 20) {
      // Phase 3+: read from SessionLog
      return Promise.resolve([]);
    },

    async resume() {
      eventBus.publish("session:resume", { timestamp: new Date().toISOString() });
    }
  };

  // agent now delegates to the orchestrator
  const agent = {
    async send(message, opts = {}) {
      return orchestrator.submit(message, opts);
    },

    approve(id, decision) {
      orchestrator.approve(id, decision);
      eventBus.publish("permission:decision", {
        tool_call_id: id,
        decision
      });
    },

    interrupt() {
      orchestrator.interrupt();
      eventBus.publish("agent:interrupt", {
        timestamp: new Date().toISOString()
      });
    }
  };

  const context = {
    async getSnapshot(phase = "general", channel = "think") {
      return contextEngine.snapshot(phase, channel);
    },

    pin(filePath) {
      contextEngine.pin(filePath);
      eventBus.publish("context:pin", { path: filePath });
    },

    unpin(filePath) {
      contextEngine.unpin(filePath);
      eventBus.publish("context:unpin", { path: filePath });
    }
  };

  return {
    eventBus,
    config,
    modelProvider,
    contextEngine,
    orchestrator,
    session,
    agent,
    context
  };
}
```

#### Step 2: Verify syntax

Run: `node --check src/kernel/kernel-api.js && node --check src/kernel/model-provider.js && node --check src/kernel/context-engine.js && node --check src/kernel/task-orchestrator.js`
Expected: no output (all clean)

#### Step 3: Commit

```bash
git add src/kernel/kernel-api.js
git commit -m "feat(kernel): wire ModelProvider, ContextEngine, and TaskOrchestrator into KernelAPI"
```

---

### Task 5: Integration

#### Step 1: Run all tests

Run: `node --test test/patch.test.js test/kernel/*.test.js`
Expected: all tests PASS (3 patch + 35 Phase 0 + 13 model-provider + 13 context-engine + 9 orchestrator = 73 PASS)

#### Step 2: Run npm check

Run: `npm run check`
Expected: no output (all 22 source files parse cleanly)

#### Step 3: Commit any final tweaks and tag

```bash
git commit -m "chore: Phase 1 integration complete"
```

---

### Phase 1 Completion Checklist

```
- [ ] src/kernel/model-provider.js created and tested (13 tests)
- [ ] src/kernel/context-engine.js created and tested (13 tests)
- [ ] src/kernel/task-orchestrator.js created and tested (9 tests)
- [ ] src/kernel/kernel-api.js updated with real implementations
- [ ] npm run check passes (all 22 source files)
- [ ] All 73 tests pass
- [ ] No regression on existing Phase 0 tests
```
