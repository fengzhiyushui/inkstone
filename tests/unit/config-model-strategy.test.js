// tests/unit/config-model-strategy.test.js — v1.9.0 M4 模型适配:reasoning_effort 合法集 + FIM betaBase 配置键。
// 协议事实(调研核定):reasoning_effort 全集 = none|low|high|max(客户端历史档位 low/medium 亦原样透传);
// none 等价关思考,但「关不禁用」由通道层 thinking 开关决定,配置层只校验 + 透传。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { normalizeReasoningEffort, normalizeConfig, DEFAULT_CONFIG, loadConfig } from "../../src/config.js";

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
