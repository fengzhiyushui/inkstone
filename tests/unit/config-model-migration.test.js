// tests/unit/config-model-migration.test.js — 退役模型 id 迁移(v1.9.0 M1-P0)。
// 策略:仅精确键匹配(deepseek-v4-flash → deepseek-flash),未知/第三方端点 id 原样透传。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { normalizeModels, normalizeConfig, DEFAULT_CONFIG, loadConfig } from "../../src/config.js";
import { migrateModelId } from "../../src/deepseek/model-ids.js";

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
