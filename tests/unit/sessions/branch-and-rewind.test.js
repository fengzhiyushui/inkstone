// tests/unit/sessions/branch-and-rewind.test.js — 分支与回滚(服务/事务/存储)领域测试
//
// v1.19.1 测试归并:本文件由下列历史任务单测试合并而成,每个来源包裹在独立
// describe 块中(异步回调 + 动态 import,来源间零共享绑定),测试语义与拆分前一致。
import { describe } from "node:test";

// ---------------------------------------------------------------------------
// 来源:tests/unit/sessions/rewind-service.test.js
// ---------------------------------------------------------------------------
describe("unit/sessions/rewind-service", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createEventBus } = await import("../../../src/shared/event-bus.js");
  const { createRewindService } = await import("../../../src/sessions/rewind-service.js");

  test("rewind preview computes reverse rollback plan without writing", async () => {
    const eventBus = createEventBus();
    const events = [];
    eventBus.subscribe("session:rewind_preview", (data) => events.push(data));
    const rollbacks = [];
    const service = createRewindService({
      eventBus,
      getTimeline: async () => [
        { seq: 1, event_id: "evt_user_1", type: "user:message", turn_id: "turn_1", branch_id: "br_main" },
        { seq: 2, event_id: "evt_apply_1", type: "file:diff_applied", change_id: "change_1", files: ["a.txt"], branch_id: "br_main" },
        { seq: 3, event_id: "evt_user_2", type: "user:message", turn_id: "turn_2", branch_id: "br_main" },
        { seq: 4, event_id: "evt_apply_2", type: "file:diff_applied", change_id: "change_2", files: ["b.txt"], branch_id: "br_main" }
      ],
      getActiveBranchId: async () => "br_main",
      rollback: async (input) => rollbacks.push(input)
    });

    const result = await service.preview({ target: { turn_id: "turn_1" } });

    assert.equal(result.status, "success");
    assert.deepEqual(result.rollback_change_ids, ["change_2", "change_1"]);
    assert.deepEqual(rollbacks, []);
    assert.equal(events.length, 1);
    assert.equal(JSON.stringify(events).includes("diff --git"), false);
  });

  test("rewind preview throws when missing required dependencies", async () => {
    assert.throws(() => createRewindService(), /getTimeline is required/);
    assert.throws(() => createRewindService({ getTimeline: async () => [] }), /getActiveBranchId is required/);
    assert.throws(
      () => createRewindService({ getTimeline: async () => [], getActiveBranchId: async () => "br_main" }),
      /rollback is required/
    );
  });

  test("rewind apply rolls back changes creates and activates child branch", async () => {
    const eventBus = createEventBus();
    const published = [];
    for (const type of ["session:rewind_started", "session:branch_created", "session:branch_activated", "session:rewind_applied"]) {
      eventBus.subscribe(type, (data) => published.push({ type, data }));
    }
    const rollbackCalls = [];
    let activeBranch = "br_main";
    const service = createRewindService({
      eventBus,
      getTimeline: async () => [
        { seq: 1, event_id: "evt_user_1", type: "user:message", turn_id: "turn_1", branch_id: "br_main" },
        { seq: 2, event_id: "evt_apply_1", type: "file:diff_applied", change_id: "change_1", files: ["a.txt"], branch_id: "br_main" },
        { seq: 3, event_id: "evt_apply_2", type: "file:diff_applied", change_id: "change_2", files: ["b.txt"], branch_id: "br_main" }
      ],
      getActiveBranchId: async () => activeBranch,
      createBranch: async (input) => ({ branch_id: input.branch_id || "br_child", ...input }),
      activateBranch: async (branchId) => { activeBranch = branchId; return { branch_id: branchId }; },
      rollback: async (input) => {
        rollbackCalls.push(input);
        return { status: "success", metadata: { change_id: input.change_id, files: [] } };
      }
    });

    const result = await service.apply({ target: { turn_id: "turn_1" } });

    assert.equal(result.status, "success");
    assert.deepEqual(rollbackCalls.map((call) => call.change_id), ["change_2", "change_1"]);
    // Rollback events must carry the actual created branch id, not a phantom one
    const actualBranchId = result.branch_id;
    assert.ok(actualBranchId.startsWith("br_"), "branch id must be valid");
    assert.equal(rollbackCalls[0].branch_id, actualBranchId);
    assert.equal(rollbackCalls[1].branch_id, actualBranchId);
    assert.equal(activeBranch, actualBranchId);
    assert.equal(published.some((event) => event.type === "session:rewind_applied"), true);
  });

  test("rewind apply stops on conflict and does not activate child branch", async () => {
    const eventBus = createEventBus();
    const conflicts = [];
    eventBus.subscribe("session:rewind_conflict", (data) => conflicts.push(data));
    let activeBranch = "br_main";
    const service = createRewindService({
      eventBus,
      getTimeline: async () => [
        { seq: 1, event_id: "evt_user_1", type: "user:message", turn_id: "turn_1", branch_id: "br_main" },
        { seq: 2, event_id: "evt_apply_1", type: "file:diff_applied", change_id: "change_1", files: ["a.txt"], branch_id: "br_main" },
        { seq: 3, event_id: "evt_apply_2", type: "file:diff_applied", change_id: "change_2", files: ["b.txt"], branch_id: "br_main" }
      ],
      getActiveBranchId: async () => activeBranch,
      createBranch: async () => { throw new Error("should not create branch on conflict"); },
      activateBranch: async () => { throw new Error("should not activate branch on conflict"); },
      rollback: async ({ change_id }) => change_id === "change_2"
        ? { status: "conflict", metadata: { change_id, conflicts: [{ path: "b.txt", reason: "dirty" }] } }
        : { status: "success", metadata: { change_id } }
    });

    const result = await service.apply({ target: { turn_id: "turn_1" } });

    assert.equal(result.status, "conflict");
    assert.equal(activeBranch, "br_main");
    assert.equal(result.failed_change_id, "change_2");
    assert.equal(conflicts.length, 1);
  });

  test("rewind apply handles force flag and failed rollback", async () => {
    const eventBus = createEventBus();
    const failed = [];
    eventBus.subscribe("session:rewind_failed", (data) => failed.push(data));
    const rollbackCalls = [];
    const service = createRewindService({
      eventBus,
      getTimeline: async () => [
        { seq: 1, event_id: "evt_user_1", type: "user:message", turn_id: "turn_1", branch_id: "br_main" },
        { seq: 2, event_id: "evt_apply_1", type: "file:diff_applied", change_id: "change_1", files: ["a.txt"], branch_id: "br_main" }
      ],
      getActiveBranchId: async () => "br_main",
      createBranch: async () => ({ branch_id: "br_unused" }),
      activateBranch: async () => {},
      rollback: async (input) => {
        rollbackCalls.push(input);
        return { status: "failed", content: [{ text: "rollback error" }] };
      }
    });

    const result = await service.apply({ target: { turn_id: "turn_1" }, force: true });

    assert.equal(result.status, "failed_restored");
    assert.equal(rollbackCalls[0].force, true);
    assert.ok(failed.length >= 1);
  });

  test("rewind apply restores files when createBranch fails after rollback", async () => {
    const eventBus = createEventBus();
    const restored = [];
    eventBus.subscribe("session:rewind_restored", (data) => restored.push(data));
    let fileState = "after edit";
    const service = createRewindService({
      eventBus,
      projectRoot: "/virtual",
      getTimeline: async () => [
        { seq: 1, event_id: "evt_user_1", type: "user:message", turn_id: "turn_1", branch_id: "br_main" },
        { seq: 2, event_id: "evt_apply_1", type: "file:diff_applied", change_id: "change_1", files: ["a.txt"], branch_id: "br_main" }
      ],
      getActiveBranchId: async () => "br_main",
      captureSnapshots: async () => [{ path: "a.txt", existed_before: true, before: "after edit" }],
      restoreSnapshots: async () => { fileState = "after edit"; return ["a.txt"]; },
      createBranch: async () => { throw new Error("secret branch store failure"); },
      activateBranch: async () => { throw new Error("should not activate"); },
      rollback: async () => { fileState = "before edit"; return { status: "success", metadata: { change_id: "change_1" } }; }
    });

    const result = await service.apply({ target: { turn_id: "turn_1" } });

    assert.equal(result.status, "failed_restored");
    assert.equal(result.phase, "create_branch");
    assert.equal(result.reason, "branch_create_failed");
    assert.equal(fileState, "after edit");
    assert.deepEqual(result.restored_files, ["a.txt"]);
    assert.equal(restored.length, 1);
    assert.equal(JSON.stringify(restored).includes("secret branch store failure"), false);
  });

  test("rewind apply restores files when activateBranch fails after branch creation", async () => {
    const eventBus = createEventBus();
    let activeBranch = "br_main";
    let fileState = "after edit";
    const service = createRewindService({
      eventBus,
      projectRoot: "/virtual",
      getTimeline: async () => [
        { seq: 1, event_id: "evt_user_1", type: "user:message", turn_id: "turn_1", branch_id: "br_main" },
        { seq: 2, event_id: "evt_apply_1", type: "file:diff_applied", change_id: "change_1", files: ["a.txt"], branch_id: "br_main" }
      ],
      getActiveBranchId: async () => activeBranch,
      captureSnapshots: async () => [{ path: "a.txt", existed_before: true, before: "after edit" }],
      restoreSnapshots: async () => { fileState = "after edit"; return ["a.txt"]; },
      createBranch: async (input) => ({ branch_id: input.branch_id, parent_branch_id: "br_main" }),
      activateBranch: async () => { throw new Error("cannot activate secret branch"); },
      rollback: async () => { fileState = "before edit"; return { status: "success", metadata: { change_id: "change_1" } }; }
    });

    const result = await service.apply({ target: { turn_id: "turn_1" } });

    assert.equal(result.status, "failed_restored");
    assert.equal(result.phase, "activate_branch");
    assert.equal(result.reason, "branch_activate_failed");
    assert.equal(fileState, "after edit");
    assert.equal(activeBranch, "br_main");
  });

  test("rewind apply restores earlier rollbacks when later rollback fails", async () => {
    let fileA = "after a";
    let fileB = "after b";
    const service = createRewindService({
      projectRoot: "/virtual",
      getTimeline: async () => [
        { seq: 1, event_id: "evt_user_1", type: "user:message", turn_id: "turn_1", branch_id: "br_main" },
        { seq: 2, event_id: "evt_apply_1", type: "file:diff_applied", change_id: "change_1", files: ["a.txt"], branch_id: "br_main" },
        { seq: 3, event_id: "evt_apply_2", type: "file:diff_applied", change_id: "change_2", files: ["b.txt"], branch_id: "br_main" }
      ],
      getActiveBranchId: async () => "br_main",
      captureSnapshots: async () => [
        { path: "a.txt", existed_before: true, before: "after a" },
        { path: "b.txt", existed_before: true, before: "after b" }
      ],
      restoreSnapshots: async () => { fileA = "after a"; fileB = "after b"; return ["a.txt", "b.txt"]; },
      createBranch: async () => ({ branch_id: "br_unused" }),
      activateBranch: async () => {},
      rollback: async ({ change_id }) => {
        if (change_id === "change_2") {
          fileB = "before b";
          return { status: "success", metadata: { change_id } };
        }
        return { status: "failed", content: [{ text: "raw secret rollback error" }] };
      }
    });

    const result = await service.apply({ target: { turn_id: "turn_1" } });

    assert.equal(result.status, "failed_restored");
    assert.equal(result.phase, "rollback");
    assert.equal(result.reason, "rollback_failed");
    assert.deepEqual(result.applied_rollbacks, ["change_2"]);
    assert.equal(fileA, "after a");
    assert.equal(fileB, "after b");
    assert.equal(JSON.stringify(result).includes("raw secret"), false);
  });

  test("rewind apply restores earlier rollbacks when later rollback conflicts", async () => {
    let fileB = "after b";
    const eventBus = createEventBus();
    const restored = [];
    eventBus.subscribe("session:rewind_restored", (data) => restored.push(data));
    const service = createRewindService({
      eventBus,
      projectRoot: "/virtual",
      getTimeline: async () => [
        { seq: 1, event_id: "evt_user_1", type: "user:message", turn_id: "turn_1", branch_id: "br_main" },
        { seq: 2, event_id: "evt_apply_1", type: "file:diff_applied", change_id: "change_1", files: ["a.txt"], branch_id: "br_main" },
        { seq: 3, event_id: "evt_apply_2", type: "file:diff_applied", change_id: "change_2", files: ["b.txt"], branch_id: "br_main" }
      ],
      getActiveBranchId: async () => "br_main",
      captureSnapshots: async () => [{ path: "b.txt", existed_before: true, before: "after b" }],
      restoreSnapshots: async () => { fileB = "after b"; return ["b.txt"]; },
      createBranch: async () => ({ branch_id: "br_unused" }),
      activateBranch: async () => {},
      rollback: async ({ change_id }) => {
        if (change_id === "change_2") {
          fileB = "before b";
          return { status: "success", metadata: { change_id } };
        }
        return { status: "conflict", metadata: { change_id, conflicts: [{ path: "a.txt", reason: "dirty" }] } };
      }
    });

    const result = await service.apply({ target: { turn_id: "turn_1" } });

    assert.equal(result.status, "conflict_restored");
    assert.deepEqual(result.applied_rollbacks, ["change_2"]);
    assert.equal(fileB, "after b");
    assert.equal(restored.length, 1);
  });

  test("rewind recovery events do not include raw file content diff or exception text", async () => {
    const eventBus = createEventBus();
    const events = [];
    for (const type of [
      "session:rewind_restore_started",
      "session:rewind_restored",
      "session:rewind_failed",
      "session:rewind_recovery_failed"
    ]) {
      eventBus.subscribe(type, (data) => events.push({ type, data }));
    }
    const service = createRewindService({
      eventBus,
      projectRoot: "/virtual",
      getTimeline: async () => [
        { seq: 1, event_id: "evt_user_1", type: "user:message", turn_id: "turn_1", branch_id: "br_main" },
        { seq: 2, event_id: "evt_apply_1", type: "file:diff_applied", change_id: "change_1", files: ["secret.txt"], branch_id: "br_main" }
      ],
      getActiveBranchId: async () => "br_main",
      captureSnapshots: async () => [{ path: "secret.txt", existed_before: true, before: "TOP_SECRET_CONTENT\n" }],
      restoreSnapshots: async () => ["secret.txt"],
      createBranch: async () => { throw new Error("diff --git a/secret.txt b/secret.txt @@ TOP_SECRET_CONTENT"); },
      activateBranch: async () => {},
      rollback: async () => ({ status: "success", metadata: { change_id: "change_1" } })
    });

    await service.apply({ target: { turn_id: "turn_1" } });

    const serialized = JSON.stringify(events);
    assert.equal(serialized.includes("TOP_SECRET_CONTENT"), false);
    assert.equal(serialized.includes("diff --git"), false);
    assert.equal(serialized.includes("@@"), false);
    assert.equal(serialized.includes("before"), false);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/sessions/rewind-transaction.test.js
// ---------------------------------------------------------------------------
describe("unit/sessions/rewind-transaction", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { readFile, writeFile, mkdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { captureRewindSnapshots, restoreRewindSnapshots, safeRewindError } = await import("../../../src/sessions/rewind-transaction.js");
  const { mkdtemp } = await import("../../helpers/tmp.js");

  test("captureRewindSnapshots captures existing and missing files without leaking content in metadata", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-rewind-tx-"));
    await writeFile(path.join(root, "a.txt"), "before a\n", "utf8");

    const snapshots = await captureRewindSnapshots(root, ["a.txt", "new/created.txt"]);

    assert.equal(snapshots.length, 2);
    assert.equal(snapshots[0].path, "a.txt");
    assert.equal(snapshots[0].existed_before, true);
    assert.equal(snapshots[0].before, "before a\n");
    assert.match(snapshots[0].before_hash, /^sha256:/);
    assert.equal(snapshots[1].path, "new/created.txt");
    assert.equal(snapshots[1].existed_before, false);
    assert.equal(snapshots[1].before, null);
    assert.equal(JSON.stringify(snapshots.map(({ before, ...safe }) => safe)).includes("before a"), false);
  });

  test("restoreRewindSnapshots restores modified files and removes files created during rewind", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-rewind-restore-"));
    await writeFile(path.join(root, "a.txt"), "before a\n", "utf8");
    const snapshots = await captureRewindSnapshots(root, ["a.txt", "nested/new.txt"]);

    await writeFile(path.join(root, "a.txt"), "after rewind\n", "utf8");
    await mkdir(path.join(root, "nested"), { recursive: true });
    await writeFile(path.join(root, "nested", "new.txt"), "created\n", "utf8");

    const restored = await restoreRewindSnapshots(root, snapshots);

    assert.deepEqual(restored.sort(), ["a.txt", "nested/new.txt"].sort());
    assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "before a\n");
    await assert.rejects(() => readFile(path.join(root, "nested", "new.txt"), "utf8"), /ENOENT/);
  });

  test("captureRewindSnapshots rejects path traversal", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-rewind-unsafe-"));
    await assert.rejects(
      () => captureRewindSnapshots(root, ["../outside.txt"]),
      /outside workspace|path traversal|outside project|escapes project/i
    );
  });

  test("safeRewindError returns category only and never raw message", () => {
    const error = new Error("disk failed while writing secret-token-123");
    assert.equal(safeRewindError(error, "create_branch"), "branch_create_failed");
    assert.equal(safeRewindError(error, "activate_branch"), "branch_activate_failed");
    assert.equal(safeRewindError(error, "rollback"), "rollback_failed");
    assert.equal(safeRewindError(error, "restore"), "restore_failed");
    assert.equal(safeRewindError(error, "other"), "rewind_failed");
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/sessions/branch-store.test.js
// ---------------------------------------------------------------------------
describe("unit/sessions/branch-store", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { BR_MAIN, createBranchStore } = await import("../../../src/sessions/branch-store.js");
  const { mkdtemp } = await import("../../helpers/tmp.js");

  test("branch store creates br_main lazily", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-branch-store-"));
    const store = await createBranchStore({
      sessionRoot: path.join(root, ".sessions"),
      projectId: "proj_test",
      sessionId: "sess_test"
    });

    assert.equal(await store.getActiveBranchId(), BR_MAIN);
    const branches = await store.listBranches();
    assert.equal(branches.length, 1);
    assert.equal(branches[0].branch_id, BR_MAIN);
    assert.equal(branches[0].parent_branch_id, null);
  });

  test("branch store persists child branch and active branch", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-branch-store-persist-"));
    const options = {
      sessionRoot: path.join(root, ".sessions"),
      projectId: "proj_test",
      sessionId: "sess_test"
    };
    const first = await createBranchStore(options);
    const child = await first.createBranch({
      parent_branch_id: BR_MAIN,
      forked_from_event_id: "evt_1",
      forked_from_seq: 10,
      forked_from_turn_id: "turn_1",
      label: "rewind to turn_1"
    });
    await first.activateBranch(child.branch_id);

    const second = await createBranchStore(options);
    assert.equal(await second.getActiveBranchId(), child.branch_id);
    const branches = await second.listBranches();
    assert.equal(branches.length, 2);
    assert.equal(branches[1].parent_branch_id, BR_MAIN);

    const raw = JSON.parse(await readFile(path.join(options.sessionRoot, "proj_test", "sess_test.branches.json"), "utf8"));
    assert.equal(raw.active_branch_id, child.branch_id);
  });

  test("branch store rejects unknown branch activation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-branch-store-unknown-"));
    const store = await createBranchStore({
      sessionRoot: path.join(root, ".sessions"),
      projectId: "proj_test",
      sessionId: "sess_test"
    });

    await assert.rejects(() => store.activateBranch("br_missing"), /unknown branch/);
  });

  test("branch ancestry includes parent chain from root to child", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-branch-store-ancestry-"));
    const store = await createBranchStore({
      sessionRoot: path.join(root, ".sessions"),
      projectId: "proj_test",
      sessionId: "sess_test"
    });
    const first = await store.createBranch({ parent_branch_id: BR_MAIN, forked_from_seq: 5 });
    const second = await store.createBranch({ parent_branch_id: first.branch_id, forked_from_seq: 8 });

    assert.deepEqual(
      (await store.getAncestry(second.branch_id)).map((branch) => branch.branch_id),
      [BR_MAIN, first.branch_id, second.branch_id]
    );
  });
});
