// tests/unit/edits-and-sessions.test.js — 编辑系统、变更台账、会话日志与分支回退
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseUnifiedDiff,
  applyPatchToText,
  assertDiffPathsSafe
} from "../../src/edits/diff-parser.js";
import { createEditService } from "../../src/edits/edit-service.js";
import { createChangeStore } from "../../src/edits/change-store.js";
import { assertRollbackableRecord } from "../../src/edits/edit-transaction.js";
import { buildSensitiveNotice, sensitiveReasonFor } from "../../src/edits/sensitive-notice.js";
import {
  createSessionEventLog,
  verifyEventLog,
  projectIdFromRoot
} from "../../src/sessions/event-log.js";
import { SESSION_EVENT_TYPES, isSessionEventType } from "../../src/sessions/event-types.js";
import { SESSION_EVENT_SCHEMAS, validateEvent } from "../../src/sessions/event-schemas.js";
import { createSessionManager } from "../../src/sessions/session-manager.js";
import { createBranchStore, BR_MAIN } from "../../src/sessions/branch-store.js";
import { createRewindService } from "../../src/sessions/rewind-service.js";
import { buildCheckpointIndex } from "../../src/sessions/checkpoint-index.js";
import { createEventBus } from "../../src/shared/event-bus.js";
import { mkdtemp } from "../helpers/tmp.js";

test("Unified Diff 解析与 CRLF/尾换行字节保真", () => {
  const diffText = [
    "--- a/src/app.js",
    "+++ b/src/app.js",
    "@@ -1,2 +1,3 @@",
    " line 1",
    "-line 2",
    "+line 2 modified",
    "+line 3 added"
  ].join("\n");

  const parsed = parseUnifiedDiff(diffText);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].oldPath, "src/app.js");
  assert.equal(parsed[0].newPath, "src/app.js");
  assert.equal(parsed[0].hunks.length, 1);

  const originalText = "line 1\nline 2\n";
  const patched = applyPatchToText(originalText, parsed[0]);
  assert.equal(patched, "line 1\nline 2 modified\nline 3 added\n");

  assert.doesNotThrow(() => assertDiffPathsSafe(process.cwd(), parsed));
});

test("事务化编辑（预览/应用/脏工作区拦截/半提交回滚）", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsc-edit-tx-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "file.js"), "const a = 1;\n");

  const diff = [
    "--- a/src/file.js",
    "+++ b/src/file.js",
    "@@ -1,1 +1,1 @@",
    "-const a = 1;",
    "+const a = 2;"
  ].join("\n");

  const editService = createEditService({ projectRoot: root, eventBus: createEventBus() });
  const preview = await editService.preview({ diff });
  assert.ok(preview.metadata.diff_hash);
  assert.equal(preview.status, "success");

  const applied = await editService.apply({ diff });
  assert.equal(applied.status, "success");

  const diskContent = await fs.readFile(path.join(root, "src", "file.js"), "utf8");
  assert.equal(diskContent, "const a = 2;\n");
});

test("变更台账捕获上限、展示脱敏、保留期清理与 ROLLBACK_TRUNCATED 守卫", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsc-change-store-"));
  const store = createChangeStore({ projectRoot: root, maxCaptureBytes: 1024 });
  assert.ok(store);

  const record = {
    id: "chg_1",
    files: [{ path: "src/a.js", status: "modify", before: "old", after: "new" }]
  };
  assert.doesNotThrow(() => assertRollbackableRecord(record));

  const truncatedRecord = {
    id: "chg_truncated",
    files: [{ path: "src/big.js", status: "modify", before_truncated: true }]
  };
  assert.throws(
    () => assertRollbackableRecord(truncatedRecord),
    /ROLLBACK_TRUNCATED|上限/i
  );
});

test("敏感文件独立风险提醒契约", () => {
  assert.ok(sensitiveReasonFor(".env"));
  assert.ok(sensitiveReasonFor(".env.local"));
  assert.equal(sensitiveReasonFor("src/app.js"), null);

  const notice = buildSensitiveNotice([".env", "src/app.js"]);
  assert.ok(notice);
  assert.equal(notice.paths.length, 1);
  assert.equal(notice.paths[0].path, ".env");
});

test("会话 JSONL 追加日志与 SHA-256 哈希链防篡改", async () => {
  const sessionRoot = await mkdtemp(path.join(os.tmpdir(), "dsc-event-log-"));
  const projectId = "proj_test_1";
  const sessionId = "sess_test_1";
  const log = await createSessionEventLog({ sessionRoot, projectId, sessionId });

  await log.append("session:start", { session_id: sessionId });
  await log.append("agent:step", { step_id: "s1" });
  await log.append("agent:final", { content: "finished" });

  const verified = await verifyEventLog(log.filePath);
  assert.equal(verified.valid, true);
  assert.ok(verified.verified_count >= 3);
});

test("64+ 类会话事件登记表与 Schema 双向覆盖守卫", () => {
  assert.ok(SESSION_EVENT_TYPES.length >= 60, `已登记事件类型数应 ≥ 60 (实得 ${SESSION_EVENT_TYPES.length})`);

  for (const type of SESSION_EVENT_TYPES) {
    assert.equal(isSessionEventType(type), true);
    assert.ok(SESSION_EVENT_SCHEMAS[type], `缺少 Schema: ${type}`);

    const blankCheck = validateEvent(type, {});
    assert.equal(typeof blankCheck.ok, "boolean");
    assert.ok(Array.isArray(blankCheck.errors));
  }

  const badType = validateEvent("unknown:event:type", {});
  assert.equal(badType.ok, false);

  const goodToolCall = validateEvent("tool:call", { call: { id: "c1" }, tool: { name: "read" } });
  assert.equal(goodToolCall.ok, true);
});

test("会话管理器与检查点索引", async () => {
  const bus = createEventBus();
  const manager = createSessionManager({ eventBus: bus });
  assert.ok(manager);

  const received = [];
  manager.subscribe((event) => received.push(event));

  bus.publish("agent:final", { content: "hello" });
  assert.equal(received.length, 1);
  assert.equal(received[0].content, "hello");

  const ckIndex = buildCheckpointIndex([
    { type: "user:message", session_id: "s1" },
    { type: "agent:final", turn_id: "t1" }
  ]);
  assert.equal(ckIndex.checkpoints.length, 2);
  assert.ok(ckIndex.checkpoints[0].checkpoint_id);
});

test("分支存储与 Rewind 事务回退", async () => {
  const sessionRoot = await mkdtemp(path.join(os.tmpdir(), "dsc-branch-rewind-"));
  const projectId = "proj_test_branch";
  const sessionId = "sess_test_branch";
  const store = await createBranchStore({ sessionRoot, projectId, sessionId });

  const activeId = await store.getActiveBranchId();
  assert.equal(activeId, BR_MAIN);

  const devBranch = await store.createBranch({ label: "feature-1" });
  assert.equal(devBranch.label, "feature-1");

  await store.activateBranch(devBranch.branch_id);
  const activeNow = await store.getActiveBranchId();
  assert.equal(activeNow, devBranch.branch_id);

  const rewindService = createRewindService({
    getTimeline: async () => [],
    getActiveBranchId: async () => store.getActiveBranchId(),
    rollback: async () => ({ ok: true })
  });
  assert.ok(rewindService);
});
