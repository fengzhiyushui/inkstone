import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createSessionEventLog,
  openSessionEventLog,
  projectIdFromRoot,
  verifyEventLog
} from "../../../src/sessions/event-log.js";

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

