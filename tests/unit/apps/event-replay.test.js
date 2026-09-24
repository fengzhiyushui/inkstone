// tests/unit/apps/event-replay.test.js — v1.9.0 M1 契约冻结波2「事件回放 fixtures」。
// 三端(CLI/TUI/GUI)共用同一内核事件契约,fixtures 是回放验证的单一数据源。
//
// fixtures 来源说明(JSON 不支持注释,集中写在这里):
//   tests/fixtures/events/samples.json 的每一个载荷均对照 src 真实 publish 站点逐键核写:
//     - schema 依据:src/sessions/event-schemas.js(required 键即样本必填键,逐类核对);
//     - 载荷形态:tools/executor.js(tool:call/tool:result/permission:decision/approval:requested)、
//       agent-runtime.js(user:message/agent:turn_started/agent:step/approval:resolved/turn:*)、
//       executor-loop.js 与 repair-executor.js(model:request/model:response,E2 全套字段)、
//       context/index.js 与 context-cache.js(context:*)、semantic-engine.js(context:semantic_degraded)、
//       edits/edit-service.js(file:*)、verifier.js(verification:result)、repair-loop.js(repair:*)、
//       orchestrator.js 与 dispatch-loop.js(orchestration:*)、recovery-service.js(recovery:*)、
//       rewind-service.js(session:rewind_*/session:branch_*)。
//   model:response 样本即 E2 定稿形态:usage(prompt/completion/cache hit+cache miss/
//   completion_tokens_details.reasoning_tokens)+ reasoning(>500 字符,覆盖截断断言)+ tps
//   + session_id + latency_ms,model 取 deepseek-flash。
//
// 判定链:samples.json ↔ SESSION_EVENT_TYPES(覆盖)↔ validateEvent(schema 锚)↔
// describeEvent(展示契约回放)↔ deriveAgentCards(GUI 同源消费,见 tests/unit/gui/agent-cards.test.js)。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SESSION_EVENT_TYPES } from "../../../src/sessions/event-types.js";
import { validateEvent } from "../../../src/sessions/event-schemas.js";
import { describeEvent } from "../../../src/apps/event-contract.js";

const samples = JSON.parse(readFileSync(new URL("../../fixtures/events/samples.json", import.meta.url), "utf8"));

const DIFF_HASH = "sha256:0f1e2d3c4b5a69788796a5b4c3d2e1f0091827364554637281910293a4b5c6d";
// 内核 file:* 事件的 files 为字符串路径数组,展示契约归一为 { status:"M", path, added:null, removed:null }
//(真实生产者不发 added/removed,见 src/edits/diff-parser.js summarizeDiff)。
const KERNEL_FILE_ENTRIES = [
  { status: "M", path: "src/apps/event-contract.js", added: null, removed: null },
  { status: "M", path: "src/sessions/event-schemas.js", added: null, removed: null }
];
const USER_TEXT = "把 src/apps/event-contract.js 的 describeEvent 补上 file:diff_preview 展示分支";
const FINAL_TEXT = "已完成 describeEvent 的 file:diff_preview 展示分支,契约回放断言全绿。";

// model:response 样本的 E2 定稿期望(既有 6 字段 + 新增 7 字段,共 13 个,与 event-contract.js 对齐)。
// tps 与 usage/latency 自洽:completion 512 / (683ms) ≈ 749.63 → 1 位小数 749.6。
const MODEL_RESPONSE_SAMPLE = samples["model:response"];
const MODEL_RESPONSE_EXPECTED_FIELDS = {
  purpose: "plan",
  model: "deepseek-flash",
  channel: "act",
  toolCallCount: 1,
  completionTokens: 512,
  reasoningTokens: 384,
  promptTokens: 2431,
  cacheHitTokens: 2048,
  cacheMissTokens: 383,
  latencyMs: 683,
  tps: 749.6,
  reasoning: `${MODEL_RESPONSE_SAMPLE.reasoning.slice(0, 500)}…`,
  sessionId: "sess_7f3a1c"
};

// ── ① 覆盖:fixtures 键集合 ↔ SESSION_EVENT_TYPES 双向锁死 ──────────────────

test("fixtures 覆盖 SESSION_EVENT_TYPES 全部类型且无越界键", () => {
  const fixtureTypes = Object.keys(samples);
  assert.equal(fixtureTypes.length, SESSION_EVENT_TYPES.length);
  for (const type of SESSION_EVENT_TYPES) {
    assert.ok(Object.prototype.hasOwnProperty.call(samples, type), `fixtures 缺少 ${type}`);
  }
  const orphans = fixtureTypes.filter((type) => !SESSION_EVENT_TYPES.includes(type));
  assert.deepEqual(orphans, [], `fixtures 越出登记表的键: ${orphans.join(", ")}`);
  // 每个样本都是可回放的普通对象载荷(描述符以 { type, ...payload } 重建事件)。
  for (const [type, payload] of Object.entries(samples)) {
    assert.ok(payload && typeof payload === "object" && !Array.isArray(payload), `${type} 载荷必须是普通对象`);
  }
});

// ── ② 交叉校验:每个样本过 validateEvent(fixtures 与 schema 互为锚) ──────────

test("每个样本满足该类 schema 的 required 键(validateEvent ok)", () => {
  for (const [type, payload] of Object.entries(samples)) {
    const result = validateEvent(type, payload);
    assert.equal(result.ok, true, `${type} 应通过 validateEvent: ${result.errors.join("; ")}`);
  }
});

test("锚定有效性:删去任一必填键即 not ok(证明 ② 非空转)", () => {
  // 抽样证明 fixtures 确实被 schema required 约束,而非宽松放行。
  for (const [type, requiredKey] of [["tool:call", "call"], ["model:response", "turn_id"], ["file:diff_applied", "files"]]) {
    const payload = { ...samples[type] };
    delete payload[requiredKey];
    const result = validateEvent(type, payload);
    assert.equal(result.ok, false, `${type} 缺 ${requiredKey} 应 not ok`);
    assert.ok(result.errors.some((error) => error.includes(requiredKey)), `${type} 错误信息应点名 ${requiredKey}`);
  }
});

// ── ③ 回放:全量期望表(kind/severity/quiet 逐类,fields 逐字段) ──────────────
// 覆盖任务指定的核心类型(tool:call / tool:result / approval:* / permission:decision /
// file:diff_preview / file:diff_applied / file:rollback_applied / verification:result /
// repair:* 四类 / orchestration:* 七类 / recovery:* / session:rewind_* 八类 /
// session:branch_* / agent:final / agent:error / user:message / model:response /
// context:semantic_degraded),并对其余已登记类型同样锁死三项展示语义。

const DESCRIPTOR_EXPECTATIONS = new Map([
  // ── 通用 other 回落 / NOISY 静默(与 event-schema-coverage.test.js 的 QUIET_TYPES 同源) ──
  ["session:start", { kind: "other", severity: "info", quiet: false, fields: {} }],
  ["session:resume", { kind: "other", severity: "info", quiet: false, fields: {} }],
  ["recovery:started", { kind: "other", severity: "info", quiet: false, fields: {} }],
  ["tx:opened", { kind: "other", severity: "info", quiet: false, fields: {} }],
  ["tx:committed", { kind: "other", severity: "info", quiet: false, fields: {} }],
  ["turn:paused", { kind: "other", severity: "info", quiet: false, fields: {} }],
  ["turn:resumed", { kind: "other", severity: "info", quiet: false, fields: {} }],
  ["file:transaction_started", { kind: "other", severity: "info", quiet: false, fields: {} }],
  ["file:transaction_committed", { kind: "other", severity: "info", quiet: false, fields: {} }],
  ["file:transaction_failed", { kind: "other", severity: "info", quiet: false, fields: {} }],
  ["file:transaction_rolled_back", { kind: "other", severity: "info", quiet: false, fields: {} }],
  ["file:rollback_conflict", { kind: "other", severity: "info", quiet: false, fields: {} }],
  ["model:request", { kind: "other", severity: "info", quiet: true, fields: {} }],
  ["agent:turn_started", { kind: "other", severity: "info", quiet: true, fields: {} }],
  ["agent:step", { kind: "other", severity: "info", quiet: true, fields: {} }],
  // ── context:* 静默支线 ──
  ["context:snapshot", { kind: "context", severity: "info", quiet: true, fields: {} }],
  ["context:pin", { kind: "context", severity: "info", quiet: true, fields: {} }],
  ["context:unpin", { kind: "context", severity: "info", quiet: true, fields: {} }],
  ["context:warm", { kind: "context", severity: "info", quiet: true, fields: {} }],
  ["context:cache_loaded", { kind: "context", severity: "info", quiet: true, fields: {} }],
  ["context:cache_saved", { kind: "context", severity: "info", quiet: true, fields: {} }],
  ["context:cache_reused", { kind: "context", severity: "info", quiet: true, fields: {} }],
  // ── 分支 / 接管 / 事务恢复 / 回合 ──
  ["session:branch_created", { kind: "branch", severity: "info", quiet: false, fields: { branchId: "br_9k2m" } }],
  ["session:branch_activated", { kind: "branch", severity: "info", quiet: false, fields: { branchId: "br_9k2m" } }],
  ["takeover:requested", { kind: "takeover", severity: "info", quiet: false, fields: { requestId: "req_6f2a" } }],
  ["takeover:completed", { kind: "takeover", severity: "info", quiet: false, fields: { requestId: "req_6f2a" } }],
  ["tx:recovered", { kind: "tx-recovered", severity: "info", quiet: false, fields: { kind: "edit", txId: "tx_edit_1a2b", preservedCount: 1 } }],
  ["turn:rehydrated", { kind: "turn", severity: "info", quiet: false, fields: { approvalId: "approval_3d8e" } }],
  ["turn:cancelled", { kind: "turn", severity: "info", quiet: false, fields: { approvalId: "approval_3d8e" } }],
  // ── 用户 / 终局 ──
  ["user:message", { kind: "user", severity: "info", quiet: true, fields: { text: USER_TEXT } }],
  ["agent:final", { kind: "final", severity: "success", quiet: true, fields: { content: FINAL_TEXT } }],
  ["agent:error", { kind: "error", severity: "danger", quiet: true, fields: { message: "model gateway timeout after 120000ms" } }],
  // ── 工具 / 权限 / 审批 ──
  ["tool:call", { kind: "tool-call", severity: "info", quiet: false, fields: { name: "read", argHint: "src/core/runtime/agent-runtime.js" } }],
  ["tool:result", { kind: "tool-result", severity: "success", quiet: false, fields: { status: "success", durationMs: 42 } }],
  ["permission:decision", { kind: "permission", severity: "info", quiet: false, fields: { decision: "allow" } }],
  ["approval:requested", { kind: "approval", severity: "warn", quiet: false, fields: { id: "approval_3d8e", summary: "shell requires approval: `npm test -- tests/unit/apps/event-contract.test.js`" } }],
  ["approval:resolved", { kind: "approval-resolved", severity: "info", quiet: false, fields: { decision: "approved" } }],
  // ── 恢复 ──
  ["recovery:blocked", { kind: "recovery-blocked", severity: "warn", quiet: false, fields: { reason: "corrupt paused sidecar: invalid json", itemId: "rec_pause_approval_3d8e" } }],
  ["recovery:report", { kind: "recovery-report", severity: "info", quiet: false, fields: { found: 2, done: 1, blocked: 1 } }],
  // ── 回放重放(rewind 八态语义:conflict/failed/recovery_failed → danger,applied/restored → success) ──
  ["session:rewind_preview", { kind: "rewind", severity: "info", quiet: false, fields: { phase: "preview", branchId: null, changeCount: 2, failedChangeId: null, reason: null } }],
  ["session:rewind_started", { kind: "rewind", severity: "info", quiet: false, fields: { phase: "started", branchId: null, changeCount: 2, failedChangeId: null, reason: null } }],
  ["session:rewind_applied", { kind: "rewind", severity: "success", quiet: false, fields: { phase: "applied", branchId: "br_9k2m", changeCount: 2, failedChangeId: null, reason: null } }],
  ["session:rewind_conflict", { kind: "rewind", severity: "danger", quiet: false, fields: { phase: "conflict", branchId: null, changeCount: 1, failedChangeId: "chg_77c41", reason: "rollback_failed" } }],
  ["session:rewind_failed", { kind: "rewind", severity: "danger", quiet: false, fields: { phase: "failed", branchId: null, changeCount: 1, failedChangeId: null, reason: "rollback: lock epoch changed" } }],
  ["session:rewind_restore_started", { kind: "rewind", severity: "info", quiet: false, fields: { phase: "restore_started", branchId: null, changeCount: 1, failedChangeId: null, reason: "rollback: lock epoch changed" } }],
  ["session:rewind_restored", { kind: "rewind", severity: "success", quiet: false, fields: { phase: "restored", branchId: null, changeCount: 1, failedChangeId: null, reason: "rollback_failed" } }],
  ["session:rewind_recovery_failed", { kind: "rewind", severity: "danger", quiet: false, fields: { phase: "recovery_failed", branchId: null, changeCount: 1, failedChangeId: null, reason: "rollback_failed" } }],
  // ── 上下文降级 / 校验 / 修复 ──
  ["context:semantic_degraded", { kind: "context-degraded", severity: "warn", quiet: false, fields: { reason: "wasm tree-sitter grammar unavailable: javascript" } }],
  ["verification:result", { kind: "verification", severity: "success", quiet: false, fields: { status: "passed", pass: true } }],
  ["repair:started", { kind: "repair", severity: "info", quiet: false, fields: { phase: "started" } }],
  ["repair:attempt", { kind: "repair", severity: "info", quiet: false, fields: { phase: "attempt" } }],
  ["repair:result", { kind: "repair", severity: "info", quiet: false, fields: { phase: "result" } }],
  ["repair:exhausted", { kind: "repair", severity: "info", quiet: false, fields: { phase: "exhausted" } }],
  // ── 文件编辑 ──
  ["file:diff_preview", { kind: "diff-preview", severity: "info", quiet: false, fields: { summaryText: null, diffHash: DIFF_HASH, changeId: null, files: KERNEL_FILE_ENTRIES } }],
  ["file:diff_applied", { kind: "diff", severity: "success", quiet: false, fields: { changeId: "chg_5f2a9b", files: KERNEL_FILE_ENTRIES } }],
  ["file:rollback_applied", { kind: "rollback", severity: "warn", quiet: false, fields: { changeId: "chg_5f2a9b" } }],
  // ── 编排七类 ──
  ["orchestration:planned", { kind: "orchestration-plan", severity: "info", quiet: false, fields: { subtasks: 3, doneWhen: "契约字段冻结且三端回放断言全绿" } }],
  ["orchestration:round_started", { kind: "orchestration-round-start", severity: "info", quiet: false, fields: { round: 2, subtasks: 3 } }],
  ["orchestration:replanned", { kind: "orchestration-replan", severity: "info", quiet: false, fields: { round: 2, newSubtasks: 2 } }],
  ["orchestration:subtask_started", { kind: "orchestration-subtask-start", severity: "info", quiet: false, fields: { subtaskId: "st_2", attempt: 1, toolProfile: "edit" } }],
  ["orchestration:subtask_reviewed", { kind: "orchestration-subtask-review", severity: "success", quiet: false, fields: { subtaskId: "st_2", pass: true, reviewSeverity: "warn" } }],
  ["orchestration:completed", { kind: "orchestration-complete", severity: "warn", quiet: false, fields: { rounds: 2, completed: 3, failed: 1, status: "partial" } }],
  ["orchestration:routed", { kind: "orchestration-route", severity: "info", quiet: false, fields: { lane: "orchestrate", score: 0.82 } }],
  // ── model:response(期望表与 ④ 专项共用同一常量) ──
  ["model:response", { kind: "thought", severity: "info", quiet: true, fields: MODEL_RESPONSE_EXPECTED_FIELDS }],
  // ── 经验记忆(C4)事件族:v1.9.0 M1 登记闭环补入(retrieved 有专属分支,其余三条通用回落) ──
  ["experience:retrieved", { kind: "experience-retrieved", severity: "info", quiet: false, fields: { count: 2, tiers: ["procedural", "risk"] } }],
  ["experience:consolidated", { kind: "other", severity: "info", quiet: false, fields: {} }],
  ["experience:pending_approval", { kind: "other", severity: "info", quiet: false, fields: {} }],
  ["experience:pending_resolved", { kind: "other", severity: "info", quiet: false, fields: {} }]
]);

test("每个样本过 describeEvent,全量期望表逐字段一致", () => {
  // 期望表必须覆盖全部 64 类,不允许「表比样本短」的假绿灯。
  assert.equal(DESCRIPTOR_EXPECTATIONS.size, SESSION_EVENT_TYPES.length);
  for (const [type, payload] of Object.entries(samples)) {
    const expected = DESCRIPTOR_EXPECTATIONS.get(type);
    assert.ok(expected, `期望表缺少 ${type}`);
    const descriptor = describeEvent({ type, ...payload });
    assert.equal(descriptor.kind, expected.kind, `${type}.kind`);
    assert.equal(descriptor.severity, expected.severity, `${type}.severity`);
    assert.equal(descriptor.quiet, expected.quiet, `${type}.quiet`);
    assert.deepEqual(descriptor.fields, expected.fields, `${type}.fields`);
  }
});

test("experience:retrieved 的 count===0 折叠语义(登记后仍保静默门控)", () => {
  // v1.9.0 M1 登记闭环:experience:retrieved 已进 SESSION_EVENT_TYPES 与 samples.json
  // (期望表覆盖 count>0 形态);此处补钉 count===0 时 quiet 的门控语义。
  assert.equal(describeEvent({ type: "experience:retrieved", count: 0 }).quiet, true);
  assert.equal(describeEvent({ type: "experience:retrieved", count: 0 }).fields.count, 0);
});

// ── ④ model:response 专项:对照样本断言 E2 全套字段 ──────────────────────────

test("model:response 样本即 E2 定稿形态(reasoning >500、tps 与用量自洽)", () => {
  const sample = MODEL_RESPONSE_SAMPLE;
  assert.equal(sample.model, "deepseek-flash");
  assert.ok(sample.reasoning.length > 500, "fixture reasoning 必须 >500 字符以覆盖截断断言");
  for (const key of ["prompt_tokens", "completion_tokens", "prompt_cache_hit_tokens", "prompt_cache_miss_tokens"]) {
    assert.equal(typeof sample.usage[key], "number", `usage.${key} 必须显式给全`);
  }
  assert.equal(typeof sample.usage.completion_tokens_details.reasoning_tokens, "number");
  // tps 自洽:completion_tokens / (latency_ms/1000),保留 1 位小数(与 publisher 同口径)。
  assert.equal(Math.round((sample.usage.completion_tokens / (sample.latency_ms / 1000)) * 10) / 10, sample.tps);
});

test("model:response 回放描述符与样本逐字段一致(既有 6 + E2 新 7,共 13 字段)", () => {
  const descriptor = describeEvent({ type: "model:response", ...MODEL_RESPONSE_SAMPLE });
  assert.equal(descriptor.kind, "thought");
  assert.equal(descriptor.sourceType, "model:response");
  assert.equal(descriptor.severity, "info");
  assert.equal(descriptor.quiet, true);
  // 字段集恰好 13 个,不多不少
  assert.deepEqual(Object.keys(descriptor.fields).sort(), [
    "cacheHitTokens", "cacheMissTokens", "channel", "completionTokens", "latencyMs", "model",
    "promptTokens", "purpose", "reasoning", "reasoningTokens", "sessionId", "toolCallCount", "tps"
  ]);
  // 全 13 字段显式期望(含 reasoning 截断到 500 + 「…」、tps 舍入、cache hit/miss 显式值)
  assert.deepEqual(descriptor.fields, MODEL_RESPONSE_EXPECTED_FIELDS);
  const reasoning = descriptor.fields.reasoning;
  assert.equal(reasoning.length, 501);
  assert.ok(reasoning.endsWith("…"));
  assert.ok(MODEL_RESPONSE_SAMPLE.reasoning.startsWith(reasoning.slice(0, 500)));
});

test("model:response:reasoning 截断/tps 舍入/cache 回退的边界行为", () => {
  // 第二形态(deepseek-v4-pro):reasoning <500 不补「…」、tps 原始高精度值按 1 位小数舍入。
  const pro = describeEvent({
    type: "model:response",
    purpose: "act",
    model: "deepseek-v4-pro",
    channel: "act",
    tool_call_count: 0,
    content: "",
    iteration: 1,
    usage: { prompt_tokens: 1024, completion_tokens: 256, completion_tokens_details: { reasoning_tokens: 128 }, prompt_tokens_details: { cached_tokens: 512 } },
    latency_ms: 3412,
    tps: 74.96,
    reasoning: "先核对 schema 再动手",
    session_id: "sess_7f3a1c"
  });
  assert.equal(pro.fields.model, "deepseek-v4-pro");
  assert.equal(pro.fields.reasoning, "先核对 schema 再动手");
  assert.equal(pro.fields.tps, 75);
  // cache 回退链(usage-tracker.js:9-11 同口径):hit 回退 prompt_tokens_details.cached_tokens,
  // miss 缺省且 hit/prompt 均可知时按 prompt-hit 推导。
  assert.equal(pro.fields.promptTokens, 1024);
  assert.equal(pro.fields.cacheHitTokens, 512);
  assert.equal(pro.fields.cacheMissTokens, 512);

  // 完全无 cache 信息:不推导,一律 null
  const noCache = describeEvent({ type: "model:response", usage: { prompt_tokens: 1024 } });
  assert.equal(noCache.fields.cacheHitTokens, null);
  assert.equal(noCache.fields.cacheMissTokens, null);
  // 舍入演示:748.129 → 748.1(与 event-contract.test.js 同期望)
  assert.equal(describeEvent({ type: "model:response", tps: 748.129 }).fields.tps, 748.1);
});

// ── ⑤ 全量不变量:任何样本的 fields 不得含 undefined(null 可以) ─────────────

test("全量不变量:kind 非空字符串 / quiet 布尔 / fields 无 undefined / severity 受控", () => {
  const SEVERITIES = new Set(["info", "success", "warn", "danger"]);
  const collectUndefined = (value, path, out) => {
    if (value === undefined) { out.push(path); return; }
    if (Array.isArray(value)) value.forEach((item, index) => collectUndefined(item, `${path}[${index}]`, out));
    else if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) collectUndefined(item, `${path}.${key}`, out);
    }
  };
  for (const [type, payload] of Object.entries(samples)) {
    const descriptor = describeEvent({ type, ...payload });
    assert.equal(descriptor.sourceType, type, `${type} sourceType 应透传`);
    assert.equal(typeof descriptor.kind, "string", `${type}.kind 应为字符串`);
    assert.ok(descriptor.kind.length > 0, `${type}.kind 不应为空`);
    assert.equal(typeof descriptor.quiet, "boolean", `${type}.quiet 应为布尔`);
    assert.ok(SEVERITIES.has(descriptor.severity), `${type}.severity 越界: ${descriptor.severity}`);
    const undefinedPaths = [];
    collectUndefined(descriptor.fields, "fields", undefinedPaths);
    assert.deepEqual(undefinedPaths, [], `${type} 描述符 fields 含 undefined: ${undefinedPaths.join(", ")}`);
  }
});
