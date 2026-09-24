import test from "node:test";
import assert from "node:assert/strict";
import { SESSION_EVENT_TYPES } from "../../../src/sessions/event-types.js";
import { SESSION_EVENT_SCHEMAS, validateEvent } from "../../../src/sessions/event-schemas.js";
import { describeEvent } from "../../../src/apps/event-contract.js";

const SCHEMA_TYPES = new Set(["string", "number", "boolean", "object", "array", "any"]);

// ── ① 覆盖守卫:登记表 ↔ schema 双向锁死 ──────────────────────────────────

test("SESSION_EVENT_TYPES 每一类都在 SESSION_EVENT_SCHEMAS 中有条目", () => {
  const missing = SESSION_EVENT_TYPES.filter((type) => !Object.prototype.hasOwnProperty.call(SESSION_EVENT_SCHEMAS, type));
  assert.deepEqual(missing, [], `缺少 schema 条目的已登记类型: ${missing.join(", ")}`);
});

test("SESSION_EVENT_SCHEMAS 无越出登记表的孤儿键", () => {
  const orphans = Object.keys(SESSION_EVENT_SCHEMAS).filter((type) => !SESSION_EVENT_TYPES.includes(type));
  assert.deepEqual(orphans, [], `孤儿 schema 键(越出登记表): ${orphans.join(", ")}`);
});

test("schema 条目形状合法(required/optional 均为 [key,type],类型名受控)且已冻结", () => {
  assert.ok(Object.isFrozen(SESSION_EVENT_SCHEMAS), "SESSION_EVENT_SCHEMAS 必须 Object.freeze");
  for (const [type, schema] of Object.entries(SESSION_EVENT_SCHEMAS)) {
    assert.ok(Object.isFrozen(schema), `${type} 条目未冻结`);
    for (const listName of ["required", "optional"]) {
      const list = schema[listName];
      assert.ok(Array.isArray(list), `${type}.${listName} 必须是数组`);
      for (const pair of list) {
        assert.ok(Array.isArray(pair) && pair.length === 2, `${type}.${listName} 条目必须是 [key, type]`);
        assert.equal(typeof pair[0], "string", `${type}.${listName} 键名必须是字符串`);
        assert.ok(SCHEMA_TYPES.has(pair[1]), `${type}.${listName} 非法类型名: ${pair[1]}`);
      }
    }
    const requiredKeys = schema.required.map(([key]) => key);
    for (const [key] of schema.optional) {
      assert.ok(!requiredKeys.includes(key), `${type} 键同时出现在 required 与 optional: ${key}`);
    }
  }
});

// ── ③ validateEvent 基本契约 ─────────────────────────────────────────────

test("validateEvent: 未知类型 not ok", () => {
  const result = validateEvent("not:a:real:type", { turn_id: "t" });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("not:a:real:type")));
});

test("validateEvent: 非对象载荷 not ok 且不抛错", () => {
  for (const payload of [null, undefined, "text", 42, true, [1, 2]]) {
    const result = validateEvent("agent:final", payload);
    assert.equal(result.ok, false, `payload=${JSON.stringify(payload) ?? String(payload)} 应判 not ok`);
    assert.ok(Array.isArray(result.errors) && result.errors.length > 0);
  }
});

test("validateEvent: 合法事件 ok", () => {
  assert.deepEqual(validateEvent("tool:call", { call: { id: "call_1" }, tool: { name: "read" } }), { ok: true, errors: [] });
});

test("validateEvent: 缺必填 not ok 并指出缺失键", () => {
  const result = validateEvent("tool:call", { tool: { name: "read" } });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("call")));
});

test("validateEvent: 必填键类型不符 not ok", () => {
  const result = validateEvent("model:request", { turn_id: 7, purpose: "act", iteration: 0 });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("turn_id") && error.includes("string")));
});

test("validateEvent: 额外未知键放行(前向兼容)", () => {
  const result = validateEvent("tool:call", { call: {}, tool: {}, brand_new_field: "v1.10" });
  assert.equal(result.ok, true);
});

test("validateEvent: model:response 必填恒定键齐备即 ok,usage 可空", () => {
  const base = { turn_id: "t1", purpose: "act", iteration: 0, content: "", tool_call_count: 0 };
  assert.equal(validateEvent("model:response", base).ok, true);
  assert.equal(validateEvent("model:response", { ...base, usage: null }).ok, true);
});

test("validateEvent: model:response 的 E2 新字段(reasoning/tps/session_id/latency_ms)均 optional 且类型受检", () => {
  const base = { turn_id: "t1", purpose: "act", iteration: 0, content: "", tool_call_count: 0 };
  const withE2 = { ...base, reasoning: "thinking…", tps: 42.5, session_id: "s1", latency_ms: 1200 };
  assert.equal(validateEvent("model:response", withE2).ok, true);
  const badTps = validateEvent("model:response", { ...withE2, tps: "fast" });
  assert.equal(badTps.ok, false);
  assert.ok(badTps.errors.some((error) => error.includes("tps") && error.includes("number")));
  const missing = validateEvent("model:response", { purpose: "act" });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((error) => error.includes("turn_id")));
});

test("validateEvent: 任意已登记类型配空载荷/ null 均不抛错", () => {
  for (const type of SESSION_EVENT_TYPES) {
    assert.doesNotThrow(() => validateEvent(type, {}), type);
    assert.doesNotThrow(() => validateEvent(type, null), type);
    const result = validateEvent(type, {});
    assert.equal(typeof result.ok, "boolean");
    assert.ok(Array.isArray(result.errors));
  }
});

// ── ④ describeEvent 非静默回落守卫 ───────────────────────────────────────
// 静默路径判据(以 src/apps/event-contract.js 当前实现细节为准):
//   - kind === "other":NOISY 集合(line 70)、orchestration: 前缀兜底(line 113)、
//     末尾通用 other 回落(line 140)三条路径都不渲染具体字段;
//   - kind === "context":context:* 静默支线(line 72),quiet=true 折叠进上下文流。
// 所有专属展示分支的 kind 均不取这两个值,故可作为「漏登记展示分支」的精确信号:
// 新增已登记类型若忘记在 event-contract.js 加分支,必然落入其中之一而变红。
const SILENT_KINDS = new Set(["other", "context"]);

// QUIET_TYPES:已登记类型 → 一行理由。三类来源,与 event-contract.js 逐条对照:
//   A. NOISY 集合成员(line 6,命中 line 70 静默 other);
//   B. context:* 静默支线(line 72,kind="context" + quiet=true);
//   C. 末尾通用 other 回落(line 140)会吃掉的已登记类型——无专属展示分支,
//      由事件日志/时间线或其汇总事件消费,CLI 主线不渲染。
const QUIET_TYPES = new Map([
  // A. NOISY 高频帧:展示端统一折叠为静默 other,不产字段卡。
  ["model:request", "NOISY 高频帧(每轮模型请求都产生):展示端折叠为静默 other,无字段卡"],
  ["agent:step", "NOISY 高频帧(classify 步骤流水):展示端折叠为静默 other,无字段卡"],
  ["agent:turn_started", "NOISY 高频帧(回合开始标记):展示端折叠为静默 other,无字段卡"],
  // B. context:* 静默支线:上下文类事件默认不进事件主线。
  ["context:snapshot", "context:* 静默支线:快照仅服务上下文面板,不进事件主线"],
  ["context:pin", "context:* 静默支线:pin/unpin/warm 属上下文控制面,不进事件主线"],
  ["context:unpin", "context:* 静默支线:pin/unpin/warm 属上下文控制面,不进事件主线"],
  ["context:warm", "context:* 静默支线:pin/unpin/warm 属上下文控制面,不进事件主线"],
  ["context:cache_loaded", "context:* 静默支线:缓存加载计数仅观测用途,不进事件主线"],
  ["context:cache_saved", "context:* 静默支线:缓存保存计数仅观测用途,不进事件主线"],
  ["context:cache_reused", "context:* 静默支线:缓存复用计数仅观测用途,不进事件主线"],
  // C. 末尾通用 other 回落会吃掉的已登记类型:无专属展示分支。
  ["session:start", "通用 other 回落:会话起始标记仅事件日志消费,无展示分支"],
  ["session:resume", "通用 other 回落:恢复标记无展示分支,时间线可直接读取"],
  ["recovery:started", "通用 other 回落:恢复开始标记,详情由 recovery:report 汇总展示"],
  ["tx:opened", "通用 other 回落:v2.18 规格事件、当前无生产者,无展示分支"],
  ["tx:committed", "通用 other 回落:v2.18 规格事件、当前无生产者,无展示分支"],
  ["turn:paused", "通用 other 回落:暂停可见性由 approval:requested 卡片承载,本身无分支"],
  ["turn:resumed", "通用 other 回落:恢复可见性由 approval:resolved 卡片承载,本身无分支"],
  ["file:transaction_started", "通用 other 回落:事务开始标记,可见结果由 file:diff_applied 承载"],
  ["file:transaction_committed", "通用 other 回落:事务提交标记,可见结果由 file:diff_applied 承载"],
  ["file:transaction_failed", "通用 other 回落:事务失败标记,无展示分支"],
  ["file:transaction_rolled_back", "通用 other 回落:回滚事务标记,可见结果由 file:rollback_applied 承载"],
  ["file:rollback_conflict", "通用 other 回落:回滚冲突标记,无展示分支"],
  // D. C4 经验记忆事件族(v1.9.0 M1 登记闭环):无专属展示分支的成员逐条留痕
  //(experience:retrieved 有专属分支,不进本白名单)。
  ["experience:consolidated", "通用 other 回落:后台巩固回执仅观测用途,无展示分支"],
  ["experience:pending_approval", "通用 other 回落:待批经验经 experience.listPending 面板呈现,事件本身无分支"],
  ["experience:pending_resolved", "通用 other 回落:解决回执仅观测用途,无展示分支"]
]);

test("describeEvent: 白名单外的已登记类型不得落入静默/通用回落", () => {
  const silent = [];
  for (const type of SESSION_EVENT_TYPES) {
    const descriptor = describeEvent({ type });
    assert.equal(descriptor.sourceType, type, `${type} sourceType 应透传`);
    if (SILENT_KINDS.has(descriptor.kind) && !QUIET_TYPES.has(type)) {
      silent.push(`${type}(kind=${descriptor.kind})`);
    }
  }
  assert.deepEqual(silent, [], `以下已登记类型落入静默/通用回落但未登记 QUIET_TYPES: ${silent.join(", ")}`);
});

test("describeEvent: QUIET_TYPES 白名单精确——每条都必须真实命中静默路径", () => {
  const imprecise = [];
  for (const [type, reason] of QUIET_TYPES) {
    assert.ok(SESSION_EVENT_TYPES.includes(type), `QUIET_TYPES 越出登记表: ${type}`);
    assert.ok(typeof reason === "string" && reason.trim().length > 0, `QUIET_TYPES 条目缺少理由: ${type}`);
    const descriptor = describeEvent({ type });
    if (!SILENT_KINDS.has(descriptor.kind)) {
      imprecise.push(`${type}(kind=${descriptor.kind})`);
    }
  }
  assert.deepEqual(imprecise, [], `QUIET_TYPES 含非静默类型(白名单注水): ${imprecise.join(", ")}`);
});
