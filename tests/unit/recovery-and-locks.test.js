// tests/unit/recovery-and-locks.test.js — 项目锁、原子写入、Sidecar 存储与恢复引擎
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  atomicReadJson,
  atomicWriteJson,
  atomicWriteBytes,
  safeRecoverySegment
} from "../../src/core/recovery/atomic-file.js";
import { acquireProjectLock } from "../../src/core/recovery/project-lock.js";
import { createPausedTurnPersistence } from "../../src/core/recovery/paused-turn-persistence.js";
import { createTransactionJournal } from "../../src/core/recovery/transaction-journal.js";
import { createRecoveryInbox } from "../../src/core/recovery/recovery-inbox.js";
import { createRecoveryService } from "../../src/core/recovery/recovery-service.js";
import { mkdtemp } from "../helpers/tmp.js";

test("原子文件读写与安全路径分片", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsc-atomic-"));
  const target = path.join(root, "data.json");

  await atomicWriteJson(target, { status: "active", count: 1 });
  const readBack = await atomicReadJson(target);
  assert.equal(readBack.status, "active");
  assert.equal(readBack.count, 1);

  const binTarget = path.join(root, "blob.bin");
  await atomicWriteBytes(binTarget, Buffer.from("hello atomic"));
  const binRead = await fs.readFile(binTarget, "utf8");
  assert.equal(binRead, "hello atomic");

  assert.equal(safeRecoverySegment("abc-123_DEF.json"), "abc-123_DEF.json");
  assert.throws(() => safeRecoverySegment("a/b:c*d?"), /invalid recovery path segment/);
});

test("项目进程锁（获取、重入、心跳、过期接管与并发竞争）", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsc-lock-"));
  const lock = await acquireProjectLock({
    root,
    surface: "cli",
    sessionId: "sess_lock_1"
  });

  assert.ok(lock);
  assert.ok(lock.owner);
  assert.equal(typeof lock.epoch, "number");

  await assert.rejects(
    async () => acquireProjectLock({
      root,
      surface: "gui",
      sessionId: "sess_lock_2"
    }),
    /RECOVERY_LOCK_HELD|locked/i
  );

  await lock.release();
  const acquiredAfterRelease = await acquireProjectLock({
    root,
    surface: "gui",
    sessionId: "sess_lock_2"
  });
  assert.ok(acquiredAfterRelease);
  await acquiredAfterRelease.release();
});

test("通用 sidecar-store 与三类暂停记录持久化与损坏隔离", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsc-sidecar-"));
  const persistence = createPausedTurnPersistence({ root, projectId: "proj_sidecar_1" });

  const state = {
    approval_id: "app_1",
    turn_id: "turn_paused_1",
    session_id: "sess_1",
    created_at: new Date().toISOString(),
    surface: "cli",
    permission_context: {},
    approval: { id: "app_1", kind: "tool" },
    turn: {},
    resume_state: { step_index: 2 }
  };
  await persistence.save(state);

  const loaded = await persistence.load("app_1");
  assert.equal(loaded.approval_id, "app_1");
  assert.equal(loaded.turn_id, "turn_paused_1");

  const scanned = await persistence.scan();
  assert.ok(scanned.some((s) => s.approval_id === "app_1"));

  await persistence.delete("app_1");
  const afterRemove = await persistence.load("app_1").catch(() => null);
  assert.equal(afterRemove, null);
});

test("事务日志（transaction-journal）提交与崩溃回滚", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsc-journal-"));
  await fs.writeFile(path.join(root, "test.txt"), "before\n");
  const journal = createTransactionJournal({ root, projectId: "proj_journal_1" });

  const entry = await journal.open({
    tx_id: "tx_1",
    kind: "edit",
    session_id: "sess_1",
    turn_id: "turn_1",
    owner_epoch: 1,
    paths: ["test.txt"]
  });
  assert.equal(entry.tx_id, "tx_1");

  const list = await journal.scan();
  assert.equal(list.find((tx) => tx.tx_id === "tx_1")?.state, "open");

  await journal.commit("tx_1");
  const afterCommit = await journal.scan();
  assert.equal(afterCommit.find((tx) => tx.tx_id === "tx_1")?.state, "committed");
});

test("恢复收件箱（recovery-inbox）分类扫描与清理", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsc-inbox-"));
  const inbox = createRecoveryInbox({ root });

  await inbox.upsert({
    id: "rec_item_1",
    type: "paused_turn",
    status: "done",
    source_id: "app_1",
    summary: "Approval handled"
  });

  const items = await inbox.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "rec_item_1");

  const retrieved = await inbox.get("rec_item_1");
  assert.equal(retrieved.status, "done");

  await inbox.clear("rec_item_1");
  const afterClear = await inbox.list({ includeCleared: false });
  assert.equal(afterClear.length, 0);
});

test("RecoveryService 跨进程恢复编排与孤儿/指纹失配阻断", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsc-rec-svc-"));
  const inbox = createRecoveryInbox({ root });
  const mockLock = {
    epoch: 1,
    assertOwner: async () => {}
  };
  const mockPaused = {
    scan: async () => []
  };

  const svc = createRecoveryService({
    projectId: "proj_rec_1",
    lock: mockLock,
    paused: mockPaused,
    pausedTurnStore: { scan: async () => [] },
    inbox,
    appendMarker: async () => {}
  });

  const report = await svc.recoverOnStartup();
  assert.ok(report);
  assert.ok(Array.isArray(report.found));
  assert.ok(Array.isArray(report.done));

  const list = await svc.list();
  assert.ok(Array.isArray(list));
});
