import test from "node:test";
import assert from "node:assert/strict";
import { describeEvent } from "../../../src/apps/event-contract.js";

test("malformed input never throws, returns other/quiet", () => {
  for (const bad of [null, undefined, 42, "x", {}, { nope: 1 }]) {
    const d = describeEvent(bad);
    assert.equal(d.kind, "other");
    assert.equal(d.quiet, true);
    assert.equal(d.severity, "info");
    assert.deepEqual(d.fields, {});
  }
});

test("tool:call name alias resolves from three shapes", () => {
  assert.equal(describeEvent({ type: "tool:call", call: { name: "read" } }).fields.name, "read");
  assert.equal(describeEvent({ type: "tool:call", tool: { name: "grep" } }).fields.name, "grep");
  assert.equal(describeEvent({ type: "tool:call", tool: "shell" }).fields.name, "shell");
});

test("tool:call argHint picks first non-empty key in order", () => {
  const d = describeEvent({ type: "tool:call", call: { name: "edit", args: { path: "src/a.js" } } });
  assert.equal(d.fields.argHint, "src/a.js");
  assert.equal(describeEvent({ type: "tool:call", call: { name: "x", args: {} } }).fields.argHint, null);
});

test("tool:call argHint reads executor call.params and joins argv", () => {
  const d = describeEvent({ type: "tool:call", call: { name: "shell", params: { argv: ["git", "status"] } } });
  assert.equal(d.fields.argHint, "git status");
  const path = describeEvent({ type: "tool:call", call: { name: "read", params: { path: "src/a.js" } } });
  assert.equal(path.fields.argHint, "src/a.js");
  const long = describeEvent({ type: "tool:call", call: { name: "shell", params: { argv: ["node", "y".repeat(200)] } } });
  assert.ok(long.fields.argHint.length <= 121);
  assert.match(long.fields.argHint, /…$/);
  assert.equal(describeEvent({ type: "tool:call", call: { name: "x", params: { argv: [] } } }).fields.argHint, null);
});

test("tool:result severity maps ok->success else warn", () => {
  assert.equal(describeEvent({ type: "tool:result", result: { status: "ok" } }).severity, "success");
  assert.equal(describeEvent({ type: "tool:result", status: "error" }).severity, "warn");
});

test("file:diff_applied normalizes files, changeId dual source", () => {
  const d = describeEvent({
    type: "file:diff_applied", change_id: "chg_1",
    files: [{ path: "src/a.js", status: "M", added: 2, removed: 1 }]
  });
  assert.equal(d.kind, "diff");
  assert.equal(d.severity, "success");
  assert.equal(d.fields.changeId, "chg_1");
  assert.deepEqual(d.fields.files[0], { status: "M", path: "src/a.js", added: 2, removed: 1 });
  const alt = describeEvent({ type: "file:diff_applied", record: { id: "chg_2" }, summary: [{ path: "b.js" }] });
  assert.equal(alt.fields.changeId, "chg_2");
  assert.deepEqual(alt.fields.files[0], { status: "M", path: "b.js", added: null, removed: null });
});

test("normFiles accepts string path elements (legacy gui fixture)", () => {
  const d = describeEvent({ type: "file:diff_applied", change_id: "c", files: ["src/a.js"] });
  assert.deepEqual(d.fields.files[0], { status: "M", path: "src/a.js", added: null, removed: null });
});

test("orchestration events map to prefixed kinds with fields", () => {
  assert.deepEqual(describeEvent({ type: "orchestration:routed", lane: "orchestrate" }),
    { kind: "orchestration-route", sourceType: "orchestration:routed", severity: "info", quiet: false, fields: { lane: "orchestrate", score: null } });
  assert.equal(describeEvent({ type: "orchestration:planned", subtasks: 3 }).kind, "orchestration-plan");
  assert.equal(describeEvent({ type: "orchestration:planned", subtasks: 3 }).fields.subtasks, 3);
  assert.equal(describeEvent({ type: "orchestration:round_started", round: 2, subtasks: 4 }).kind, "orchestration-round-start");
  const ss = describeEvent({ type: "orchestration:subtask_started", subtask_id: "s1", attempt: 1, tool_profile: "edit" });
  assert.equal(ss.kind, "orchestration-subtask-start");
  assert.deepEqual(ss.fields, { subtaskId: "s1", attempt: 1, toolProfile: "edit" });
  const sr = describeEvent({ type: "orchestration:subtask_reviewed", subtask_id: "s1", pass: false, severity: "high" });
  assert.equal(sr.kind, "orchestration-subtask-review");
  assert.equal(sr.severity, "warn");
  assert.deepEqual(sr.fields, { subtaskId: "s1", pass: false, reviewSeverity: "high" });
  const done = describeEvent({ type: "orchestration:completed", rounds: 2, completed: 3, failed: 1, status: "partial" });
  assert.equal(done.kind, "orchestration-complete");
  assert.equal(done.severity, "warn");
  assert.deepEqual(done.fields, { rounds: 2, completed: 3, failed: 1, status: "partial" });
});

test("experience:retrieved quiet when count zero", () => {
  assert.equal(describeEvent({ type: "experience:retrieved", count: 0 }).quiet, true);
  assert.equal(describeEvent({ type: "experience:retrieved", count: 2, tiers: ["T1"] }).quiet, false);
});

test("noisy + context events are quiet", () => {
  for (const type of ["model:request", "model:response", "agent:step", "agent:turn_started",
                      "context:snapshot", "context:cache_loaded", "context:warm"]) {
    assert.equal(describeEvent({ type }).quiet, true, type);
  }
});

test("unknown event falls back to other with sourceType preserved", () => {
  const d = describeEvent({ type: "some:new_thing" });
  assert.equal(d.kind, "other");
  assert.equal(d.sourceType, "some:new_thing");
});

test("file:diff_preview carries changeId(null) and normalized files for gui card", () => {
  const d = describeEvent({ type: "file:diff_preview", summary: [{ path: "src/x.js", status: "modify" }] });
  assert.equal(d.kind, "diff-preview");
  assert.equal(d.fields.changeId, null);
  assert.equal(d.fields.files[0].path, "src/x.js");
});

test("tool:result carries real durationMs (null when absent)", () => {
  assert.equal(describeEvent({ type: "tool:result", id: "c1", result: { status: "ok", durationMs: 38 } }).fields.durationMs, 38);
  assert.equal(describeEvent({ type: "tool:result", id: "c1", result: { status: "ok" } }).fields.durationMs, null);
});

test("model:response maps to a quiet thought descriptor with usage", () => {
  const d = describeEvent({
    type: "model:response", purpose: "plan", model: "deepseek-v4-pro",
    usage: { completion_tokens: 120, completion_tokens_details: { reasoning_tokens: 80 } }
  });
  assert.equal(d.kind, "thought");
  assert.equal(d.quiet, true);
  assert.equal(d.fields.reasoningTokens, 80);
  assert.equal(d.fields.purpose, "plan");
});

test("model:response descriptor carries the full v1.9.0 field set", () => {
  // 全字段事件:既有七字段 + 新增七字段逐一断言(300 tokens / 4000ms = 75 tps)。
  const d = describeEvent({
    type: "model:response",
    purpose: "plan",
    model: "deepseek-v4-pro",
    channel: "act",
    tool_call_count: 2,
    usage: {
      prompt_tokens: 1200,
      completion_tokens: 300,
      completion_tokens_details: { reasoning_tokens: 180 },
      prompt_cache_hit_tokens: 1024,
      prompt_cache_miss_tokens: 176
    },
    latency_ms: 4000,
    tps: 75,
    reasoning: "先读 README 再动手",
    session_id: "sess_1"
  });
  assert.equal(d.kind, "thought");
  assert.equal(d.sourceType, "model:response");
  assert.equal(d.severity, "info");
  assert.equal(d.quiet, true);
  // 既有七字段逐字节不动
  assert.equal(d.fields.purpose, "plan");
  assert.equal(d.fields.model, "deepseek-v4-pro");
  assert.equal(d.fields.channel, "act");
  assert.equal(d.fields.toolCallCount, 2);
  assert.equal(d.fields.completionTokens, 300);
  assert.equal(d.fields.reasoningTokens, 180);
  // v1.9.0 M1 新增七字段
  assert.equal(d.fields.promptTokens, 1200);
  assert.equal(d.fields.cacheHitTokens, 1024);
  assert.equal(d.fields.cacheMissTokens, 176);
  assert.equal(d.fields.latencyMs, 4000);
  assert.equal(d.fields.tps, 75);
  assert.equal(d.fields.reasoning, "先读 README 再动手");
  assert.equal(d.fields.sessionId, "sess_1");
});

test("model:response cache token fields follow the usage-tracker fallback chain", () => {
  // 显式字段优先(参照 usage-tracker.js:9-10 的 ?? 链)
  const explicit = describeEvent({
    type: "model:response",
    usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 40, prompt_cache_miss_tokens: 60 }
  });
  assert.equal(explicit.fields.cacheHitTokens, 40);
  assert.equal(explicit.fields.cacheMissTokens, 60);

  // prompt_cache_hit_tokens 缺省回退 prompt_tokens_details.cached_tokens,
  // miss 缺省且 hit/prompt 均可知时按 prompt-hit 推导(usage-tracker.js:10 同链)
  const fallback = describeEvent({
    type: "model:response",
    usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 40 } }
  });
  assert.equal(fallback.fields.cacheHitTokens, 40);
  assert.equal(fallback.fields.cacheMissTokens, 60);

  // 完全无 cache 信息:不推导,一律 null
  const noCache = describeEvent({ type: "model:response", usage: { prompt_tokens: 100 } });
  assert.equal(noCache.fields.cacheHitTokens, null);
  assert.equal(noCache.fields.cacheMissTokens, null);
});

test("model:response descriptor tolerates legacy usage-only event (new keys null)", () => {
  // 契约冻结前的旧形态事件只有 usage 子对象:不得抛错,新键一律 null。
  const d = describeEvent({
    type: "model:response",
    purpose: "plan",
    model: "deepseek-chat",
    channel: "act",
    tool_call_count: 1,
    usage: { completion_tokens: 120, completion_tokens_details: { reasoning_tokens: 80 } }
  });
  assert.equal(d.kind, "thought");
  assert.equal(d.fields.promptTokens, null);
  assert.equal(d.fields.cacheHitTokens, null);
  assert.equal(d.fields.cacheMissTokens, null);
  assert.equal(d.fields.latencyMs, null);
  assert.equal(d.fields.tps, null);
  assert.equal(d.fields.reasoning, null);
  assert.equal(d.fields.sessionId, null);
  // 既有字段不受影响
  assert.equal(d.fields.completionTokens, 120);
  assert.equal(d.fields.reasoningTokens, 80);
  // 连 usage 都没有的裸事件同样不炸
  const bare = describeEvent({ type: "model:response" });
  assert.equal(bare.kind, "thought");
  assert.equal(bare.fields.promptTokens, null);
  assert.equal(bare.fields.reasoning, null);
  assert.equal(bare.fields.sessionId, null);
});

test("model:response descriptor truncates reasoning at 500 chars with ellipsis", () => {
  const d = describeEvent({ type: "model:response", reasoning: "x".repeat(600) });
  assert.equal(d.fields.reasoning.length, 501);
  assert.equal(d.fields.reasoning, `${"x".repeat(500)}…`);
  // 恰好 500 字不补「…」;空串归 null
  assert.equal(describeEvent({ type: "model:response", reasoning: "y".repeat(500) }).fields.reasoning, "y".repeat(500));
  assert.equal(describeEvent({ type: "model:response", reasoning: "" }).fields.reasoning, null);
});

test("model:response descriptor rounds tps to one decimal", () => {
  // 74.96 → 75;748.129 → 748.1(与 publisher 的 1 位小数量纲一致,幂等)
  assert.equal(describeEvent({ type: "model:response", tps: 74.96 }).fields.tps, 75);
  assert.equal(describeEvent({ type: "model:response", tps: 748.129 }).fields.tps, 748.1);
  assert.equal(describeEvent({ type: "model:response", tps: 75 }).fields.tps, 75);
  assert.equal(describeEvent({ type: "model:response" }).fields.tps, null);
});
