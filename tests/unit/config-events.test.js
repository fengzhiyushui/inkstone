// tests/unit/config-events.test.js — 事件日志 schema 守卫开关(M1 A1a,可选严格模式)。
// 策略:默认关闭;strictSchema 只认显式布尔 true,字符串 "true" / 1 等一律 false。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { normalizeEvents, normalizeConfig, DEFAULT_CONFIG, loadConfig } from "../../src/config.js";

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
