// tests/unit/sessions/session-and-event-log.test.js — 会话与事件日志(管理器/日志/类型/模式覆盖/检查点索引)领域测试
//
// v1.19.1 测试归并:本文件由下列历史任务单测试合并而成,每个来源包裹在独立
// describe 块中(异步回调 + 动态 import,来源间零共享绑定),测试语义与拆分前一致。
import { describe } from "node:test";

// ---------------------------------------------------------------------------
// 来源:tests/unit/sessions/session-manager.test.js
// ---------------------------------------------------------------------------
describe("unit/sessions/session-manager", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createEventBus } = await import("../../../src/shared/event-bus.js");
  const { createSessionManager } = await import("../../../src/sessions/session-manager.js");

  test("session manager subscribes to events without allowing payload type overwrite", () => {
    const eventBus = createEventBus();
    const session = createSessionManager({ eventBus, eventLog: null });
    const events = [];
    const sub = session.subscribe((event) => events.push(event));

    eventBus.publish("agent:final", { content: "done", type: "fake" });
    sub.unsubscribe();

    assert.equal(events.length, 1);
    assert.equal(events[0].type, "agent:final");
    assert.equal(events[0].content, "done");
  });

  test("session manager persists bridged events and flush waits for writes", async () => {
    const eventBus = createEventBus();
    const writes = [];
    const eventLog = {
      append: async (type, data, meta) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        writes.push({ type, data, meta });
      },
      flush: async () => {},
      tail: async (count) => writes.slice(-count).map((entry) => ({ type: entry.type, ...entry.data }))
    };
    const session = createSessionManager({ eventBus, eventLog });

    eventBus.publish("user:message", { content: "hi" });
    eventBus.publish("agent:final", { content: "done" });
    await session.flush();

    assert.deepEqual(writes.map((write) => write.type), ["user:message", "agent:final"]);
    const timeline = await session.getTimeline(2);
    assert.deepEqual(timeline.map((event) => event.type), ["user:message", "agent:final"]);
  });

  test("session manager isolates persistence failures from live subscribers", async () => {
    const eventBus = createEventBus();
    const errors = [];
    const events = [];
    const session = createSessionManager({
      eventBus,
      eventLog: {
        append: async () => { throw new Error("disk full"); },
        flush: async () => {},
        tail: async () => []
      },
      onError: (error, type) => errors.push(`${type}:${error.message}`)
    });
    const sub = session.subscribe((event) => events.push(event));

    eventBus.publish("user:message", { content: "hi" });
    await session.flush();
    sub.unsubscribe();

    assert.deepEqual(errors, ["user:message:disk full"]);
    assert.equal(events[0].type, "user:message");
  });

  test("session manager stamps active branch id on live and persisted events", async () => {
    const eventBus = createEventBus();
    const writes = [];
    const session = createSessionManager({
      eventBus,
      eventLog: {
        append: async (type, data) => writes.push({ type, data }),
        flush: async () => {},
        tail: async () => writes.map((entry, index) => ({ seq: index + 1, type: entry.type, ...entry.data }))
      },
      getActiveBranchId: () => "br_feature"
    });
    const events = [];
    const sub = session.subscribe((event) => events.push(event));

    eventBus.publish("user:message", { content: "hi" });
    await session.flush();
    sub.unsubscribe();

    assert.equal(events[0].branch_id, "br_feature");
    assert.equal(writes[0].data.branch_id, "br_feature");
  });

  test("session getTimeline filters active branch while keeping br_main ancestors", async () => {
    const eventBus = createEventBus();
    const timeline = [
      { seq: 1, type: "session:start", branch_id: "br_main" },
      { seq: 2, type: "agent:final", branch_id: "br_main" },
      { seq: 3, type: "session:branch_created", branch_id: "br_child", parent_branch_id: "br_main" },
      { seq: 4, type: "agent:final", branch_id: "br_child" },
      { seq: 5, type: "agent:final", branch_id: "br_other" }
    ];
    const session = createSessionManager({
      eventBus,
      eventLog: {
        append: async () => {},
        flush: async () => {},
        tail: async () => timeline
      },
      getActiveBranchId: () => "br_child",
      getBranchAncestry: async () => [
        { branch_id: "br_main", forked_from_seq: 0 },
        { branch_id: "br_child", forked_from_seq: 2 }
      ]
    });

    const active = await session.getTimeline({ count: 20 });
    assert.deepEqual(active.map((event) => event.seq), [1, 2, 3, 4]);

    const all = await session.getTimeline({ count: 20, all_branches: true });
    assert.deepEqual(all.map((event) => event.seq), [1, 2, 3, 4, 5]);
  });

  test("session manager preserves payload branch_id on branch control events", async () => {
    const eventBus = createEventBus();
    const writes = [];
    const session = createSessionManager({
      eventBus,
      eventLog: {
        append: async (type, data) => writes.push({ type, data }),
        flush: async () => {},
        tail: async () => []
      },
      getActiveBranchId: () => "br_main"
    });
    const events = [];
    const sub = session.subscribe((event) => events.push(event));

    // Publish branch_created from a child branch BEFORE activation
    eventBus.publish("session:branch_created", {
      branch_id: "br_child",
      parent_branch_id: "br_main",
      forked_from_event_id: "evt_1",
      forked_from_seq: 5
    });
    await session.flush();
    sub.unsubscribe();

    // Payload branch_id "br_child" must survive, not be overwritten to "br_main"
    assert.equal(events[0].branch_id, "br_child");
    assert.equal(writes[0].data.branch_id, "br_child");
    assert.equal(writes[0].data.parent_branch_id, "br_main");
  });

  test("session manager preserves payload branch_id on rollback file events", async () => {
    const eventBus = createEventBus();
    const writes = [];
    const session = createSessionManager({
      eventBus,
      eventLog: {
        append: async (type, data) => writes.push({ type, data }),
        flush: async () => {},
        tail: async () => []
      },
      getActiveBranchId: () => "br_main"
    });
    const events = [];
    const sub = session.subscribe((event) => events.push(event));

    // Rollback events during rewind carry the planned child branch_id
    eventBus.publish("file:transaction_rolled_back", {
      branch_id: "br_child",
      change_id: "change_1",
      files: ["a.txt"]
    });
    eventBus.publish("file:rollback_applied", {
      branch_id: "br_child",
      change_id: "change_1",
      files: ["a.txt"]
    });
    await session.flush();
    sub.unsubscribe();

    assert.equal(events[0].branch_id, "br_child");
    assert.equal(events[1].branch_id, "br_child");
    assert.equal(writes[0].data.branch_id, "br_child");
    assert.equal(writes[1].data.branch_id, "br_child");
  });

  test("session manager dispose stops bridge writes", async () => {
    const eventBus = createEventBus();
    const writes = [];
    const session = createSessionManager({
      eventBus,
      eventLog: {
        append: async (type) => writes.push(type),
        flush: async () => {},
        tail: async () => []
      }
    });

    eventBus.publish("user:message", { content: "before" });
    await session.flush();
    session.dispose();
    eventBus.publish("agent:final", { content: "after" });
    await session.flush();

    assert.deepEqual(writes, ["user:message"]);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/sessions/event-log.test.js
// ---------------------------------------------------------------------------
describe("unit/sessions/event-log", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { appendFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { createSessionEventLog, openSessionEventLog, projectIdFromRoot, verifyEventLog } = await import("../../../src/sessions/event-log.js");
  const { mkdtemp } = await import("../../helpers/tmp.js");

  test("event log creates session start and strips reserved data fields", async () => {
    const sessionRoot = await mkdtemp(path.join(tmpdir(), "dsc-session-log-"));
    const log = await createSessionEventLog({
      sessionRoot,
      projectId: "proj:unsafe",
      sessionId: "sess/unsafe",
      meta: { root: "/repo", type: "payload_type", seq: 99 }
    });

    await log.append(
      "user:message",
      { content: "hello", type: "fake_type", seq: 777, event_hash: "bad" },
      { event_id: "evt_meta", timestamp: "2026-05-30T00:00:00.000Z" }
    );
    await log.flush();

    const events = await log.tail(10);
    assert.equal(events.length, 2);
    assert.equal(events[0].type, "session:start");
    assert.equal(events[0].session_id, "sess/unsafe");
    assert.equal(events[0].root, "/repo");
    assert.equal(events[0].seq, 1);
    assert.equal(events[1].type, "user:message");
    assert.equal(events[1].event_id, "evt_meta");
    assert.equal(events[1].timestamp, "2026-05-30T00:00:00.000Z");
    assert.equal(events[1].content, "hello");
    assert.equal(events[1].seq, 2);
    assert.equal(events[1].prev_hash, events[0].event_hash);
    assert.match(events[1].event_hash, /^sha256:/);
  });

  test("event log serializes concurrent appends in seq order", async () => {
    const sessionRoot = await mkdtemp(path.join(tmpdir(), "dsc-session-log-"));
    const log = await createSessionEventLog({ sessionRoot, projectId: "proj", sessionId: "sess" });

    await Promise.all([
      log.append("agent:step", { step: { id: "a" } }),
      log.append("agent:step", { step: { id: "b" } }),
      log.append("agent:step", { step: { id: "c" } })
    ]);
    await log.flush();

    const events = await log.tail(10);
    assert.deepEqual(events.map((event) => event.seq), [1, 2, 3, 4]);
    for (let index = 1; index < events.length; index += 1) {
      assert.equal(events[index].prev_hash, events[index - 1].event_hash);
    }
  });

  test("event log reopens existing file without duplicating session start", async () => {
    const sessionRoot = await mkdtemp(path.join(tmpdir(), "dsc-session-log-"));
    const first = await createSessionEventLog({ sessionRoot, projectId: "proj", sessionId: "sess" });
    await first.append("user:message", { content: "first" });
    await first.flush();

    const reopened = await openSessionEventLog({ sessionRoot, projectId: "proj", sessionId: "sess" });
    await reopened.append("agent:final", { content: "done" });
    await reopened.flush();

    const events = await reopened.tail(10);
    assert.deepEqual(events.map((event) => event.type), ["session:start", "user:message", "agent:final"]);
    assert.deepEqual(events.map((event) => event.seq), [1, 2, 3]);
  });

  test("event log tail skips corrupt jsonl lines", async () => {
    const sessionRoot = await mkdtemp(path.join(tmpdir(), "dsc-session-log-"));
    const log = await createSessionEventLog({ sessionRoot, projectId: "proj", sessionId: "sess" });
    await log.append("user:message", { content: "before" });
    await log.flush();
    await appendFile(log.filePath, "{not json}\n", "utf8");

    const reopened = await openSessionEventLog({ sessionRoot, projectId: "proj", sessionId: "sess" });
    await reopened.append("agent:final", { content: "after" });

    const events = await reopened.tail(10);
    assert.deepEqual(events.map((event) => event.type), ["session:start", "user:message", "agent:final"]);
  });

  test("event log strict schema records violation, callback fires, and append still lands", async () => {
    const sessionRoot = await mkdtemp(path.join(tmpdir(), "dsc-session-log-"));
    const seen = [];
    const log = await createSessionEventLog({
      sessionRoot,
      projectId: "proj",
      sessionId: "sess",
      strictSchema: true,
      onSchemaViolation: (violation) => seen.push(violation)
    });

    // "agent:final" 必填 turn_id / content / status,这里故意缺 turn_id 与 status。
    const event = await log.append("agent:final", { content: "partial" });
    await log.flush();

    // append 成功落盘(不抛错、不阻塞)、seq 正常推进。
    assert.equal(event.seq, 2);
    const events = await log.tail(10);
    assert.equal(events.length, 2);
    assert.equal(events[1].type, "agent:final");

    // violations 记录 1 条,带 type/errors/seq。
    const violations = log.getViolations();
    assert.equal(violations.length, 1);
    assert.equal(violations[0].type, "agent:final");
    assert.equal(violations[0].seq, 2);
    assert.ok(Array.isArray(violations[0].errors) && violations[0].errors.length > 0);
    assert.ok(violations[0].errors.some((e) => e.includes("turn_id")));

    // onSchemaViolation 回调收到 { type, errors }(seq 一并提供)。
    assert.equal(seen.length, 1);
    assert.equal(seen[0].type, "agent:final");
    assert.ok(Array.isArray(seen[0].errors) && seen[0].errors.length > 0);

    // getViolations 返回副本:改动副本不得污染内部记录。
    violations[0].errors.push("tampered");
    assert.equal(log.getViolations()[0].errors.length, 2);
  });

  test("event log ignores schema violations when strictSchema is off (default)", async () => {
    const sessionRoot = await mkdtemp(path.join(tmpdir(), "dsc-session-log-"));
    const seen = [];
    // 不传 strictSchema / onSchemaViolation:默认关闭。
    const log = await createSessionEventLog({ sessionRoot, projectId: "proj", sessionId: "sess" });

    await log.append("agent:final", { content: "partial" });
    await log.flush();

    assert.deepEqual(log.getViolations(), []);

    // 显式 false + 回调同样不触发。
    const offLog = await openSessionEventLog({
      sessionRoot,
      projectId: "proj",
      sessionId: "sess",
      strictSchema: false,
      onSchemaViolation: (violation) => seen.push(violation)
    });
    await offLog.append("agent:final", { content: "still partial" });
    await offLog.flush();

    assert.deepEqual(offLog.getViolations(), []);
    assert.equal(seen.length, 0);
  });

  test("event log strict schema passes valid payloads without violations", async () => {
    const sessionRoot = await mkdtemp(path.join(tmpdir(), "dsc-session-log-"));
    const log = await createSessionEventLog({
      sessionRoot,
      projectId: "proj",
      sessionId: "sess",
      strictSchema: true
    });

    await log.append("agent:final", { turn_id: "turn_1", content: "done", status: "complete" });
    // 额外未知键放行(前向兼容),optional 键缺失不报错。
    await log.append("model:response", {
      turn_id: "turn_1",
      purpose: "act",
      iteration: 1,
      content: "hi",
      tool_call_count: 0,
      future_field: { anything: true }
    });
    await log.flush();

    assert.deepEqual(log.getViolations(), []);
  });

  test("projectIdFromRoot is stable and filesystem safe", () => {
    const first = projectIdFromRoot("D:\\person studio\\deepseek code");
    const second = projectIdFromRoot("D:\\person studio\\deepseek code");

    assert.equal(first, second);
    assert.match(first, /^proj_[a-f0-9]{12}$/);
  });

  test("verifyEventLog validates intact hash chain and detects corruption or tampering", async () => {
    const sessionRoot = await mkdtemp(path.join(tmpdir(), "dsc-session-verify-"));
    const log = await createSessionEventLog({ sessionRoot, projectId: "proj", sessionId: "sess" });
    await log.append("user:message", { content: "hello" });
    await log.append("agent:step", { step: { id: "step_1" } });
    await log.flush();

    // Full 64-hex sha256 hash check
    const events = await log.tail(10);
    assert.equal(events[0].event_hash.length, 71); // 'sha256:' (7) + 64 hex = 71 chars

    // 1. Valid intact log verification
    const checkPass = await log.verify();
    assert.equal(checkPass.valid, true);
    assert.equal(checkPass.verified_count, 3);
    assert.equal(checkPass.errors.length, 0);

    // 2. Corrupt JSON line detection
    await appendFile(log.filePath, "corrupt bad json\n", "utf8");
    const checkCorrupt = await verifyEventLog(log.filePath);
    assert.equal(checkCorrupt.valid, false);
    assert.ok(checkCorrupt.errors.some((e) => e.error === "corrupt_line"));

    // 3. Tampered prev_hash / chain break detection
    const tamperedEvent = JSON.stringify({
      schema_version: 2,
      event_id: "evt_tampered",
      prev_hash: "sha256:fake000000000000000000000000000000000000000000000000000000000000",
      event_hash: "sha256:badhash",
      type: "user:message",
      timestamp: "2026-05-30T00:00:00.000Z",
      seq: 5,
      session_id: "sess"
    });
    await appendFile(log.filePath, `${tamperedEvent}\n`, "utf8");
    const checkTampered = await verifyEventLog(log.filePath);
    assert.equal(checkTampered.valid, false);
    assert.ok(checkTampered.errors.some((e) => e.error === "chain_broken" || e.error === "hash_mismatch"));
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/sessions/event-types.test.js
// ---------------------------------------------------------------------------
describe("unit/sessions/event-types", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { SESSION_EVENT_TYPES, isSessionEventType, assertSessionEventType } = await import("../../../src/sessions/event-types.js");

  test("session event registry contains the v2 canonical events", () => {
    for (const type of [
      "session:start",
      "session:resume",
      "session:branch_created",
      "session:branch_activated",
      "session:rewind_preview",
      "session:rewind_started",
      "session:rewind_applied",
      "session:rewind_conflict",
      "session:rewind_failed",
      "session:rewind_restore_started",
      "session:rewind_restored",
      "session:rewind_recovery_failed",
      "user:message",
      "agent:turn_started",
      "agent:step",
      "model:request",
      "model:response",
      "tool:call",
      "tool:result",
      "permission:decision",
      "approval:requested",
      "approval:resolved",
      "context:snapshot",
      "context:pin",
      "context:unpin",
      "context:warm",
      "context:cache_loaded",
      "context:cache_saved",
      "context:cache_reused",
      "file:diff_preview",
      "file:diff_applied",
      "file:rollback_applied",
      "file:transaction_started",
      "file:transaction_committed",
      "file:transaction_failed",
      "file:transaction_rolled_back",
      "file:rollback_conflict",
      "verification:result",
      "repair:started",
      "repair:attempt",
      "repair:result",
      "repair:exhausted",
      "agent:final",
      "agent:error"
    ]) {
      assert.ok(SESSION_EVENT_TYPES.includes(type), `${type} missing`);
      assert.equal(isSessionEventType(type), true);
    }
  });

  test("session event registry contains repair events", () => {
    for (const type of ["repair:started", "repair:attempt", "repair:result", "repair:exhausted"]) {
      assert.ok(SESSION_EVENT_TYPES.includes(type), `${type} should be registered`);
    }
  });

  test("assertSessionEventType rejects unknown events", () => {
    assert.doesNotThrow(() => assertSessionEventType("agent:step"));
    assert.throws(
      () => assertSessionEventType("unknown:event"),
      /unknown session event type/
    );
  });

  test("V2-18 recovery lifecycle events are registered", () => {
    for (const type of [
      "recovery:started",
      "recovery:blocked",
      "recovery:report",
      "tx:opened",
      "tx:committed",
      "tx:recovered",
      "turn:paused",
      "turn:rehydrated",
      "turn:resumed",
      "turn:cancelled",
      "takeover:requested",
      "takeover:completed"
    ]) {
      assert.equal(isSessionEventType(type), true, `${type} should be registered`);
    }
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/sessions/event-schema-coverage.test.js
// ---------------------------------------------------------------------------
describe("unit/sessions/event-schema-coverage", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { SESSION_EVENT_TYPES } = await import("../../../src/sessions/event-types.js");
  const { SESSION_EVENT_SCHEMAS, validateEvent } = await import("../../../src/sessions/event-schemas.js");
  const { describeEvent } = await import("../../../src/apps/event-contract.js");

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
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/sessions/checkpoint-index.test.js
// ---------------------------------------------------------------------------
describe("unit/sessions/checkpoint-index", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { buildCheckpointIndex, computeRollbackPlan, resolveRewindTarget } = await import("../../../src/sessions/checkpoint-index.js");

  const EVENTS = [
    { seq: 1, event_id: "evt_start", type: "session:start", branch_id: "br_main" },
    { seq: 2, event_id: "evt_user_1", type: "user:message", turn_id: "turn_1", branch_id: "br_main" },
    { seq: 3, event_id: "evt_final_1", type: "agent:final", turn_id: "turn_1", branch_id: "br_main" },
    { seq: 4, event_id: "evt_apply_1", type: "file:diff_applied", change_id: "change_1", files: ["a.txt"], branch_id: "br_main" },
    { seq: 5, event_id: "evt_user_2", type: "user:message", turn_id: "turn_2", branch_id: "br_main" },
    { seq: 6, event_id: "evt_apply_2", type: "file:transaction_committed", change_id: "change_2", files: ["b.txt"], branch_id: "br_main" },
    { seq: 7, event_id: "evt_final_2", type: "agent:final", turn_id: "turn_2", branch_id: "br_main" }
  ];

  test("buildCheckpointIndex derives turn checkpoints with cumulative changes", () => {
    const index = buildCheckpointIndex(EVENTS, { branch_id: "br_main" });

    assert.equal(index.checkpoints.length >= 2, true);
    const turn2 = [...index.checkpoints].reverse().find((checkpoint) => checkpoint.turn_id === "turn_2");
    assert.equal(turn2.seq, 7);
    assert.deepEqual(turn2.cumulative_change_ids, ["change_1", "change_2"]);
  });

  test("resolveRewindTarget finds target by turn id event id or seq", () => {
    const index = buildCheckpointIndex(EVENTS, { branch_id: "br_main" });

    assert.equal(resolveRewindTarget(index, { turn_id: "turn_1" }).turn_id, "turn_1");
    assert.equal(resolveRewindTarget(index, { event_id: "evt_apply_1" }).event_id, "evt_apply_1");
    assert.equal(resolveRewindTarget(index, { seq: 3 }).seq, 3);
  });

  test("computeRollbackPlan returns changes after target in reverse order", () => {
    const index = buildCheckpointIndex(EVENTS, { branch_id: "br_main" });
    const target = resolveRewindTarget(index, { turn_id: "turn_1" });

    const plan = computeRollbackPlan(index, target);

    assert.deepEqual(plan.change_ids, ["change_2", "change_1"]);
    assert.deepEqual(plan.files.sort(), ["a.txt", "b.txt"]);
  });

  test("checkpoint index treats branchless events as br_main", () => {
    const index = buildCheckpointIndex(EVENTS.map(({ branch_id, ...event }) => event), { branch_id: "br_main" });

    assert.equal(index.events.every((event) => event.branch_id === "br_main"), true);
  });
});
