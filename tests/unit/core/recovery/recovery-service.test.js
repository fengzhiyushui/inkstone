// tests/unit/core/recovery/recovery-service.test.js — 恢复服务(收件箱/符号链接/编排恢复)领域测试
//
// v1.19.1 测试归并:本文件由下列历史任务单测试合并而成,每个来源包裹在独立
// describe 块中(异步回调 + 动态 import,来源间零共享绑定),测试语义与拆分前一致。
import { describe } from "node:test";

// ---------------------------------------------------------------------------
// 来源:tests/unit/core/recovery/recovery-service.test.js
// ---------------------------------------------------------------------------
describe("unit/core/recovery/recovery-service", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createRecoveryService } = await import("../../../../src/core/recovery/recovery-service.js");

  test("recovery service rehydrates valid paused records", async () => {
    const restored = [];
    const events = [];
    const inboxItems = [];
    const service = createRecoveryService({
      projectId: "proj_1",
      lock: { assertOwner: async () => {}, epoch: 1 },
      paused: {
        baseDir: ".deepseek-code/v2/sessions/proj_1/paused",
        scan: async () => [
          {
            approval_id: "approval_1",
            turn_id: "turn_1",
            session_id: "sess_1",
            surface: "cli",
            permission_context: { autonomy: "supervised" },
            approval: { id: "approval_1", summary: "edit file" },
            turn: { id: "turn_1", autonomy: "supervised" },
            resume_state: {}
          }
        ]
      },
      pausedTurnStore: { restore: (record) => restored.push(record) },
      inbox: {
        upsert: async (item) => { inboxItems.push(item); },
        list: async () => inboxItems
      },
      appendMarker: async (type, data) => events.push([type, data])
    });

    const report = await service.recoverOnStartup();

    assert.equal(restored[0].approval_id, "approval_1");
    assert.equal(inboxItems[0].type, "paused_turn");
    assert.equal(inboxItems[0].status, "pending");
    assert.equal(report.found.length, 1);
    assert.equal(report.done.length, 1);
    assert.equal(report.next.length, 1);
    assert.ok(events.some(([type]) => type === "recovery:started"));
    assert.ok(events.some(([type]) => type === "turn:rehydrated"));
    assert.ok(events.some(([type]) => type === "recovery:report"));
  });

  test("recovery service blocks on corrupt paused sidecars", async () => {
    const events = [];
    const inboxItems = [];
    const service = createRecoveryService({
      projectId: "proj_1",
      lock: { assertOwner: async () => {}, epoch: 1 },
      paused: {
        baseDir: ".deepseek-code/v2/sessions/proj_1/paused",
        scan: async () => [
          { status: "corrupt", approval_id: "bad_1", path: "/path/bad_1.json", reason: "invalid json" }
        ]
      },
      pausedTurnStore: { restore: () => {} },
      inbox: {
        upsert: async (item) => { inboxItems.push(item); },
        list: async () => inboxItems
      },
      appendMarker: async (type, data) => events.push([type, data])
    });

    const report = await service.recoverOnStartup();

    assert.equal(inboxItems[0].type, "blocked_recovery");
    assert.equal(inboxItems[0].status, "blocked");
    assert.equal(report.blocked.length, 1);
    assert.ok(events.some(([type]) => type === "recovery:blocked"));
  });

  test("recovery service skips consumed paused sidecars", async () => {
    const restored = [];
    const inboxItems = [];
    const service = createRecoveryService({
      projectId: "proj_1",
      lock: { assertOwner: async () => {}, epoch: 1 },
      paused: {
        baseDir: ".deepseek-code/v2/sessions/proj_1/paused",
        scan: async () => [
          { status: "consumed", approval_id: "consumed_1" }
        ]
      },
      pausedTurnStore: { restore: (record) => restored.push(record) },
      inbox: {
        upsert: async (item) => { inboxItems.push(item); },
        list: async () => inboxItems
      },
      appendMarker: async () => {}
    });

    const report = await service.recoverOnStartup();

    assert.equal(restored.length, 0);
    assert.equal(inboxItems.length, 0);
    assert.equal(report.found.length, 0);
  });

  test("recovery service resume delegates to runtime", async () => {
    const calls = [];
    const service = createRecoveryService({
      projectId: "proj_1",
      lock: { assertOwner: async () => {}, epoch: 1 },
      paused: { scan: async () => [] },
      pausedTurnStore: {},
      inbox: {
        upsert: async () => {},
        list: async () => [],
        get: async (id) => ({ id, type: "paused_turn", status: "pending" }),
        mark: async () => {}
      },
      appendMarker: async () => {},
      resumePaused: async (approvalId, decision) => {
        calls.push(["resume", approvalId, decision]);
        return { status: "complete" };
      }
    });

    await service.recoverOnStartup();
    const result = await service.resume("rec_pause_approval_1", { decision: "approve" });

    assert.deepEqual(calls, [["resume", "approval_1", "approve"]]);
    assert.equal(result.status, "resumed");
  });

  test("recovery service cancel delegates to runtime", async () => {
    const calls = [];
    const service = createRecoveryService({
      projectId: "proj_1",
      lock: { assertOwner: async () => {}, epoch: 1 },
      paused: { scan: async () => [] },
      pausedTurnStore: {},
      inbox: {
        upsert: async () => {},
        list: async () => [],
        get: async (id) => ({ id, type: "paused_turn", status: "pending" }),
        mark: async () => {}
      },
      appendMarker: async () => {},
      cancelPaused: async (approvalId) => {
        calls.push(["cancel", approvalId]);
        return { status: "cancelled" };
      }
    });

    await service.recoverOnStartup();
    const result = await service.cancel("rec_pause_approval_1");

    assert.deepEqual(calls, [["cancel", "approval_1"]]);
    assert.equal(result.status, "cancelled");
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/core/recovery/recovery-service-orchestration.test.js
// ---------------------------------------------------------------------------
describe("unit/core/recovery/recovery-service-orchestration", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createRecoveryService } = await import("../../../../src/core/recovery/recovery-service.js");
  const { serializeOrchestrationState } = await import("../../../../src/core/orchestration/orchestration-recovery-contract.js");

  function noBudget() { return { snapshot: () => ({ tokens: 0, model_calls: 0, max_tokens: null, max_model_calls: null }) }; }
  function orchSidecar({ approvalId = "ap_orch", taskId = "task_1", sessionId = "s", subtaskId = "a" } = {}) {
    const state = { message: "m", done_when: "d", options: { autonomy: "gated", sessionId }, plan: { subtasks: [] }, round: 1, allCollected: [],
      seenSubtaskIds: new Set(), seenFp: new Set(), budget: noBudget(), adoptedExperienceIds: [], riskCues: new Set(), taskId, sessionId, env: { root: "/r", orchestrationConfig: {} } };
    return serializeOrchestrationState(state, { approvalId, pausedSubtask: { id: subtaskId, goal: "g", acceptance: [], context_scope: {}, tool_profile: "edit", depends_on: [] }, remaining: [] });
  }
  function workerRec({ approvalId = "ap_orch", taskId = "task_1", sessionId = "s", subtaskId = "a", marker = true } = {}) {
    return { approval_id: approvalId, turn_id: "t", session_id: sessionId, surface: "cli", approval: { id: approvalId, summary: "edit" }, turn: {}, permission_context: {}, resume_state: { options: marker ? { __orchestration: { taskId, sessionId, subtaskId } } : {} } };
  }
  function fakeInbox(items) {
    return {
      upsert: async (it) => { const i = items.findIndex((x) => x.id === it.id); if (i >= 0) items[i] = { ...items[i], ...it }; else items.push({ ...it }); },
      list: async () => items, get: async (id) => items.find((x) => x.id === id) || null,
      mark: async (id, patch) => { const it = items.find((x) => x.id === id); if (it) Object.assign(it, patch); }
    };
  }
  function svc({ pausedScan = [], orchScan = [], restored = [], items = [], resumeOrchestration = null }) {
    return createRecoveryService({
      projectId: "proj", lock: { assertOwner: async () => {}, epoch: 1 },
      paused: { baseDir: "/base", scan: async () => pausedScan, quarantine: async () => ({ status: "quarantined" }) },
      orchPersistence: { scan: async () => orchScan, consume: async () => {}, quarantine: async () => ({ status: "quarantined" }) },
      pausedTurnStore: { restore: (r) => restored.push(r), list: () => [] },
      inbox: fakeInbox(items), appendMarker: async () => {}, resumeOrchestration
    });
  }

  test("matched orchestration sidecar + worker -> orchestration_paused inbox, worker restored", async () => {
    const restored = [], items = [];
    await svc({ pausedScan: [workerRec()], orchScan: [orchSidecar()], restored, items }).recoverOnStartup();
    const item = items.find((x) => x.id === "rec_orch_ap_orch");
    assert.equal(item.type, "orchestration_paused");
    assert.equal(item.status, "pending");
    assert.deepEqual(item.allowed_actions, ["resume", "cancel"]);
    assert.equal(restored.some((r) => r.approval_id === "ap_orch"), true);
  });

  test("orphan orchestration worker (no orchestration sidecar) -> blocked, NEVER single-agent (CST-4)", async () => {
    const restored = [], items = [];
    await svc({ pausedScan: [workerRec({ approvalId: "ap_orphan", subtaskId: "a" })], orchScan: [], restored, items }).recoverOnStartup();
    const item = items.find((x) => x.id === "rec_pause_ap_orphan");
    assert.equal(item.type, "blocked_recovery");
    assert.equal(item.status, "blocked");
    assert.deepEqual(item.allowed_actions, ["cancel"]);
    assert.equal(restored.length, 0);
  });

  test("orchestration sidecar with fingerprint mismatch -> blocked (CST-6)", async () => {
    const items = [];
    const bad = orchSidecar(); bad.fingerprints = { workerFactory: 9, toolSubset: 1, subtaskSchema: 1 };
    await svc({ pausedScan: [workerRec()], orchScan: [bad], items }).recoverOnStartup();
    assert.equal(items.find((x) => x.id === "rec_orch_ap_orch").type, "blocked_recovery");
  });

  test("plain single-agent sidecar (no marker) still restores as paused_turn (no regression)", async () => {
    const restored = [], items = [];
    await svc({ pausedScan: [workerRec({ approvalId: "ap_single", marker: false })], orchScan: [], restored, items }).recoverOnStartup();
    assert.equal(items.find((x) => x.id === "rec_pause_ap_single").type, "paused_turn");
    assert.equal(restored.some((r) => r.approval_id === "ap_single"), true);
  });

  test("resume(rec_orch_...) routes to resumeOrchestration", async () => {
    const calls = [];
    const items = [{ id: "rec_orch_ap_orch", type: "orchestration_paused", status: "pending", source_id: "ap_orch" }];
    const s = svc({ items, resumeOrchestration: async (approvalId, decision) => { calls.push([approvalId, decision]); return { status: "complete" }; } });
    const res = await s.resume("rec_orch_ap_orch", { decision: "approve" });
    assert.deepEqual(calls, [["ap_orch", "approve"]]);
    assert.equal(res.status, "resumed");
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/core/recovery/recovery-inbox.test.js
// ---------------------------------------------------------------------------
describe("unit/core/recovery/recovery-inbox", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { createRecoveryInbox } = await import("../../../../src/core/recovery/recovery-inbox.js");
  const { mkdtemp } = await import("../../../helpers/tmp.js");

  test("recovery inbox upserts lists and clears safe items", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-inbox-"));
    const inbox = createRecoveryInbox({ root });

    await inbox.upsert({
      id: "rec_tx_tx_1",
      type: "recovered_tx",
      status: "done",
      source_id: "tx_1",
      summary: "rolled back edit",
      evidence: { recovered_path: ".deepseek-code/v2/recovered/tx_1" },
      allowed_actions: ["clear"]
    });

    assert.equal((await inbox.list()).length, 1);
    await inbox.clear("rec_tx_tx_1");
    assert.equal((await inbox.list()).length, 0);
    assert.equal((await inbox.list({ includeCleared: true }))[0].status, "cleared");
  });

  test("recovery inbox refuses to clear blocked items", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-inbox-blocked-"));
    const inbox = createRecoveryInbox({ root });
    await inbox.upsert({ id: "rec_block_journal", type: "blocked_recovery", status: "blocked", source_id: "journal", summary: "corrupt journal", allowed_actions: [] });

    await assert.rejects(() => inbox.clear("rec_block_journal"), /cannot clear blocked recovery item/);
  });

  test("recovery inbox persists marks and sorts by created_at", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-inbox-persist-"));
    const inboxDir = path.join(root, ".deepseek-code", "v2", "recovery");
    await mkdir(inboxDir, { recursive: true });
    await writeFile(
      path.join(inboxDir, "inbox.json"),
      JSON.stringify({
        schema_version: 1,
        items: [
          {
            id: "rec_b",
            type: "recovered_tx",
            status: "done",
            source_id: "tx_b",
            summary: "second",
            created_at: "2026-06-01T00:00:00.000Z",
            updated_at: "2026-06-01T00:00:00.000Z"
          },
          {
            id: "rec_a",
            type: "recovered_tx",
            status: "pending",
            source_id: "tx_a",
            summary: "first",
            created_at: "2026-06-01T00:00:01.000Z",
            updated_at: "2026-06-01T00:00:01.000Z"
          }
        ]
      })
    );
    const inbox = createRecoveryInbox({ root });
    await inbox.mark("rec_a", { status: "quarantined", evidence: { note: "kept safe" }, allowed_actions: ["clear"] });

    const reopened = createRecoveryInbox({ root });
    const items = await reopened.list({ includeCleared: true });
    assert.deepEqual(items.map((item) => item.id), ["rec_b", "rec_a"]);
    assert.equal(items[1].status, "quarantined");
    assert.deepEqual(items[1].evidence, { note: "kept safe" });
    assert.deepEqual(items[1].allowed_actions, ["clear"]);
  });

  test("recovery inbox serializes concurrent upserts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-inbox-concurrent-"));
    const inboxA = createRecoveryInbox({ root });
    const inboxB = createRecoveryInbox({ root });

    await Promise.all([
      inboxA.upsert({ id: "rec_concurrent_a", type: "recovered_tx", status: "done", source_id: "tx_a", summary: "first" }),
      inboxB.upsert({ id: "rec_concurrent_b", type: "recovered_tx", status: "done", source_id: "tx_b", summary: "second" })
    ]);

    const ids = (await createRecoveryInbox({ root }).list()).map((item) => item.id).sort();
    assert.deepEqual(ids, ["rec_concurrent_a", "rec_concurrent_b"]);
  });

  test("recovery inbox upsert preserves marked fields on existing items", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-inbox-preserve-mark-"));
    const inbox = createRecoveryInbox({ root });

    await inbox.upsert({ id: "rec_preserve", type: "recovered_tx", status: "pending", source_id: "tx_preserve", summary: "first" });
    await inbox.mark("rec_preserve", { status: "quarantined", evidence: { note: "operator reviewed" }, allowed_actions: ["clear"] });
    await inbox.upsert({ id: "rec_preserve", type: "recovered_tx", status: "done", source_id: "tx_preserve", summary: "scanner saw done" });

    const [item] = await inbox.list();
    assert.equal(item.status, "quarantined");
    assert.equal(item.summary, "scanner saw done");
    assert.deepEqual(item.evidence, { note: "operator reviewed" });
    assert.deepEqual(item.allowed_actions, ["clear"]);
  });

  test("recovery inbox treats cleared items as terminal", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-inbox-cleared-terminal-"));
    const inbox = createRecoveryInbox({ root });

    await inbox.upsert({ id: "rec_terminal", type: "recovered_tx", status: "done", source_id: "tx_terminal", summary: "done" });
    await inbox.clear("rec_terminal");

    await assert.rejects(
      () => inbox.upsert({ id: "rec_terminal", type: "recovered_tx", status: "pending", source_id: "tx_terminal", summary: "stale scanner" }),
      /cannot upsert cleared recovery item/
    );
    await assert.rejects(
      () => inbox.mark("rec_terminal", { status: "pending" }),
      /cannot mark cleared recovery item/
    );
    assert.equal((await inbox.list()).length, 0);
    assert.equal((await inbox.list({ includeCleared: true }))[0].status, "cleared");
  });

  test("recovery inbox validates required summary-only fields", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-inbox-validate-"));
    const inbox = createRecoveryInbox({ root });

    await assert.rejects(
      () => inbox.upsert({ id: "", type: "recovered_tx", status: "done", source_id: "tx_1", summary: "rolled back" }),
      /invalid recovery inbox item id/
    );
    await assert.rejects(
      () => inbox.upsert({ id: "rec_raw", type: "recovered_tx", status: "done", source_id: "tx_1", summary: "rolled back", resume_state: { raw: true } }),
      /disallowed recovery inbox payload field/
    );
  });

  test("recovery inbox rejects persisted items with unknown fields", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-inbox-persisted-unknown-"));
    const inboxDir = path.join(root, ".deepseek-code", "v2", "recovery");
    await mkdir(inboxDir, { recursive: true });
    await writeFile(
      path.join(inboxDir, "inbox.json"),
      JSON.stringify({
        schema_version: 1,
        items: [{
          id: "rec_unknown",
          type: "recovered_tx",
          status: "done",
          source_id: "tx_unknown",
          summary: "rolled back",
          resume_state: { step: "apply" }
        }]
      })
    );

    const inbox = createRecoveryInbox({ root });
    await assert.rejects(() => inbox.list(), /invalid recovery inbox item/);
  });

  test("recovery inbox rejects malformed persisted timestamps", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-inbox-bad-time-"));
    const inboxDir = path.join(root, ".deepseek-code", "v2", "recovery");
    await mkdir(inboxDir, { recursive: true });
    await writeFile(
      path.join(inboxDir, "inbox.json"),
      JSON.stringify({
        schema_version: 1,
        items: [{
          id: "rec_bad_time",
          type: "recovered_tx",
          status: "done",
          source_id: "tx_bad_time",
          summary: "bad timestamp",
          created_at: "banana",
          updated_at: "2026-06-01T00:00:00.000Z"
        }]
      })
    );

    const inbox = createRecoveryInbox({ root });
    await assert.rejects(() => inbox.list(), /invalid recovery inbox item created_at/);
  });

  test("recovery inbox rejects persisted items missing timestamps", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-inbox-missing-time-"));
    const inboxDir = path.join(root, ".deepseek-code", "v2", "recovery");
    await mkdir(inboxDir, { recursive: true });
    await writeFile(
      path.join(inboxDir, "inbox.json"),
      JSON.stringify({
        schema_version: 1,
        items: [{
          id: "rec_missing_time",
          type: "recovered_tx",
          status: "done",
          source_id: "tx_missing_time",
          summary: "missing timestamp"
        }]
      })
    );

    const inbox = createRecoveryInbox({ root });
    await assert.rejects(() => inbox.list(), /invalid recovery inbox item created_at/);
  });

  test("recovery inbox rejects non-canonical persisted timestamps", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-inbox-noncanonical-time-"));
    const inboxDir = path.join(root, ".deepseek-code", "v2", "recovery");
    await mkdir(inboxDir, { recursive: true });
    await writeFile(
      path.join(inboxDir, "inbox.json"),
      JSON.stringify({
        schema_version: 1,
        items: [{
          id: "rec_noncanonical_time",
          type: "recovered_tx",
          status: "done",
          source_id: "tx_noncanonical_time",
          summary: "bad timestamp",
          created_at: "2026-02-30T00:00:00.000Z",
          updated_at: "2026-06-01T00:00:00.000Z"
        }]
      })
    );

    const inbox = createRecoveryInbox({ root });
    await assert.rejects(() => inbox.list(), /invalid recovery inbox item created_at/);
  });


  test("recovery inbox mark cannot clear blocked items", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-inbox-mark-cleared-"));
    const inbox = createRecoveryInbox({ root });
    await inbox.upsert({ id: "rec_block_mark", type: "blocked_recovery", status: "blocked", source_id: "journal", summary: "corrupt journal", allowed_actions: [] });

    await assert.rejects(
      () => inbox.mark("rec_block_mark", { status: "cleared" }),
      /cannot mark recovery inbox item cleared; use clear\(\)/
    );

    const items = await inbox.list();
    assert.equal(items.length, 1);
    assert.equal(items[0].status, "blocked");
  });

  test("recovery inbox upsert rejects nested forbidden evidence payloads", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-inbox-upsert-evidence-"));
    const inbox = createRecoveryInbox({ root });

    await assert.rejects(
      () => inbox.upsert({
        id: "rec_nested_raw",
        type: "recovered_tx",
        status: "done",
        source_id: "tx_nested",
        summary: "rolled back nested raw payload",
        evidence: { summary: { resume_state: { current_step: "apply" } } }
      }),
      /disallowed recovery inbox summary payload field: evidence\.summary\.resume_state/
    );
  });

  test("recovery inbox accepts safe evidence strings containing forbidden substrings", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-inbox-safe-string-"));
    const inbox = createRecoveryInbox({ root });

    await inbox.upsert({
      id: "rec_safe_string",
      type: "recovered_tx",
      status: "done",
      source_id: "tx_safe_string",
      summary: "rolled back",
      evidence: { note: "operator promptly cancelled recovery" }
    });

    const items = await inbox.list();
    assert.equal(items[0].evidence.note, "operator promptly cancelled recovery");
  });

  test("recovery inbox mark rejects nested forbidden evidence payloads", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-inbox-mark-evidence-"));
    const inbox = createRecoveryInbox({ root });

    await inbox.upsert({ id: "rec_mark_raw", type: "recovered_tx", status: "pending", source_id: "tx_mark", summary: "needs mark" });

    await assert.rejects(
      () => inbox.mark("rec_mark_raw", { evidence: { summary: { diffs: "raw diff payload" } } }),
      /disallowed recovery inbox summary payload field: evidence\.summary\.diffs/
    );
  });

  test("recovery inbox rejects undefined evidence patches", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-inbox-undefined-evidence-"));
    const inbox = createRecoveryInbox({ root });

    await inbox.upsert({ id: "rec_undefined_evidence", type: "recovered_tx", status: "pending", source_id: "tx_undefined", summary: "needs mark" });

    await assert.rejects(
      () => inbox.mark("rec_undefined_evidence", { evidence: undefined }),
      /invalid recovery inbox item evidence/
    );
  });

  test("recovery inbox rejects oversized summary payload strings", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-inbox-large-evidence-"));
    const inbox = createRecoveryInbox({ root });

    await assert.rejects(
      () => inbox.upsert({
        id: "rec_large_evidence",
        type: "recovered_tx",
        status: "done",
        source_id: "tx_large",
        summary: "large evidence",
        evidence: { note: "x".repeat(1200) }
      }),
      /string too large/
    );
  });

  test("recovery inbox allows safe nested evidence summaries", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-inbox-safe-evidence-"));
    const inbox = createRecoveryInbox({ root });
    const evidence = {
      recovered_path: ".deepseek-code/v2/recovered/tx_safe",
      paths: ["src/app.js", "src/app.test.js"],
      counts: { recovered: 2, quarantined: 0 },
      statuses: { transaction: "done", workspace: "clean" }
    };

    await inbox.upsert({
      id: "rec_safe_evidence",
      type: "recovered_tx",
      status: "done",
      source_id: "tx_safe",
      summary: "safe nested evidence",
      evidence
    });
    await inbox.mark("rec_safe_evidence", { evidence: { ...evidence, statuses: { transaction: "quarantined", workspace: "clean" } } });

    const items = await inbox.list({ includeCleared: true });
    assert.deepEqual(items[0].evidence, { ...evidence, statuses: { transaction: "quarantined", workspace: "clean" } });
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/core/recovery/symlink-recovery.test.js
// ---------------------------------------------------------------------------
describe("unit/core/recovery/symlink-recovery", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { mkdir, rm, writeFile, symlink, lstat } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { createTransactionJournal } = await import("../../../../src/core/recovery/transaction-journal.js");
  const { mkdtemp } = await import("../../../helpers/tmp.js");

  test("transaction journal recognizes symlink/junction and restores it as symlink on abort", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-symlink-rec-"));
    const targetDir = path.join(root, "target_dir");
    const linkDir = path.join(root, "link_dir");

    await mkdir(targetDir);
    await writeFile(path.join(targetDir, "sample.txt"), "hello world");

    const symlinkType = process.platform === "win32" ? "junction" : "dir";
    try {
      await symlink(targetDir, linkDir, symlinkType);
    } catch (error) {
      // If platform doesn't allow symlink creation, return gracefully
      if (process.platform === "win32" && (error.code === "EPERM" || error.code === "ENOENT")) {
        return;
      }
      throw error;
    }

    const initialStat = await lstat(linkDir);
    assert.equal(initialStat.isSymbolicLink(), true, "link_dir should initially be a symbolic link");

    const journal = createTransactionJournal({ root, projectId: "proj_symlink" });
    const manifest = await journal.open({
      kind: "edit",
      tx_id: "tx_symlink_1",
      session_id: "sess_1",
      turn_id: "turn_1",
      owner_epoch: 1,
      paths: ["link_dir"]
    });

    assert.equal(manifest.paths.length, 1);
    assert.equal(manifest.paths[0].kind, "symlink");

    // Simulate an errant operation overwriting the symlink with a regular directory or file
    await rm(linkDir, { recursive: true, force: true });
    await writeFile(linkDir, "errant regular file content");

    const midStat = await lstat(linkDir);
    assert.equal(midStat.isSymbolicLink(), false, "link_dir was replaced with a regular file");

    // Abort the transaction
    const abortResult = await journal.abort("tx_symlink_1");
    assert.equal(abortResult.status, "rolled_back");

    // Verify that link_dir is restored back to a symbolic link
    const restoredStat = await lstat(linkDir);
    assert.equal(restoredStat.isSymbolicLink(), true, "link_dir must be restored as a symbolic link");
  });
});
