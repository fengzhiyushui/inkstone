// tests/unit/edits/edits-and-changes.test.js — 编辑服务与变更记录(事务/敏感通知/保留/捕获上限)领域测试
//
// v1.19.1 测试归并:本文件由下列历史任务单测试合并而成,每个来源包裹在独立
// describe 块中(异步回调 + 动态 import,来源间零共享绑定),测试语义与拆分前一致。
import { describe } from "node:test";

// ---------------------------------------------------------------------------
// 来源:tests/unit/edits/edit-service.test.js
// ---------------------------------------------------------------------------
describe("unit/edits/edit-service", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { readFile, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { createEventBus } = await import("../../../src/shared/event-bus.js");
  const { createEditService } = await import("../../../src/edits/edit-service.js");
  const { mkdtemp } = await import("../../helpers/tmp.js");

  const MODIFY_DIFF = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new";

  test("preview parses validates and does not write files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-edit-service-"));
    await writeFile(path.join(root, "a.txt"), "old\n");
    const service = createEditService({ projectRoot: root });

    const result = await service.preview({ diff: MODIFY_DIFF });

    assert.equal(result.status, "success");
    assert.match(result.content[0].text, /modify a\.txt/);
    assert.equal(result.metadata.summary[0].path, "a.txt");
    assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "old\n");
  });

  test("apply writes files finalizes change and publishes event without raw diff", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-edit-service-"));
    await writeFile(path.join(root, "a.txt"), "old\n");
    const eventBus = createEventBus();
    const events = [];
    eventBus.subscribe("file:diff_applied", (data) => events.push(data));
    const service = createEditService({ projectRoot: root, eventBus });

    const result = await service.apply({ diff: MODIFY_DIFF, prompt: "update a", approval_id: "appr_1" });

    assert.equal(result.status, "success");
    assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "new\n");
    assert.match(result.metadata.change_id, /^\d{14}-[a-f0-9]{6}$/);
    assert.equal(result.metadata.approval_id, "appr_1");
    assert.equal(events.length, 1);
    assert.equal(events[0].change_id, result.metadata.change_id);
    assert.equal(events[0].diff, undefined);
  });

  test("rollback restores change and publishes rollback event", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-edit-service-"));
    await writeFile(path.join(root, "a.txt"), "old\n");
    const eventBus = createEventBus();
    const rollbacks = [];
    eventBus.subscribe("file:rollback_applied", (data) => rollbacks.push(data));
    const service = createEditService({ projectRoot: root, eventBus });

    const applied = await service.apply({ diff: MODIFY_DIFF, prompt: "update a" });
    const rolledBack = await service.rollback({ change_id: applied.metadata.change_id });

    assert.equal(rolledBack.status, "success");
    assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "old\n");
    assert.equal(rollbacks.length, 1);
    assert.equal(rollbacks[0].change_id, applied.metadata.change_id);
  });

  test("apply restores earlier writes when a later patch fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-edit-service-tx-fail-"));
    await writeFile(path.join(root, "a.txt"), "old a\n");
    await writeFile(path.join(root, "b.txt"), "old b\n");
    const service = createEditService({ projectRoot: root });
    const diff = [
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-old a",
      "+new a",
      "diff --git a/b.txt b/b.txt",
      "--- a/b.txt",
      "+++ b/b.txt",
      "@@ -1 +1 @@",
      "-not the current content",
      "+new b"
    ].join("\n");

    await assert.rejects(() => service.apply({ diff, prompt: "partial failure" }), /上下文不匹配|context|mismatch/i);

    assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "old a\n");
    assert.equal(await readFile(path.join(root, "b.txt"), "utf8"), "old b\n");
  });

  test("apply records before and after hashes in change metadata", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-edit-service-hashes-"));
    await writeFile(path.join(root, "a.txt"), "old\n");
    const service = createEditService({ projectRoot: root });

    const applied = await service.apply({ diff: MODIFY_DIFF, prompt: "hashes" });
    const record = JSON.parse(await readFile(path.join(root, ".deepseek-code", "changes", `${applied.metadata.change_id}.json`), "utf8"));
    assert.equal(record.files[0].before_hash?.startsWith("sha256:"), true);
    assert.equal(record.files[0].after_hash?.startsWith("sha256:"), true);
    assert.notEqual(record.files[0].before_hash, record.files[0].after_hash);
    assert.equal(record.transaction_id?.startsWith("tx_"), true);
  });

  test("rollback blocks dirty files and writes nothing by default", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-edit-service-dirty-"));
    await writeFile(path.join(root, "a.txt"), "old\n");
    const eventBus = createEventBus();
    const conflicts = [];
    eventBus.subscribe("file:rollback_conflict", (data) => conflicts.push(data));
    const service = createEditService({ projectRoot: root, eventBus });

    const applied = await service.apply({ diff: MODIFY_DIFF, prompt: "update a" });
    await writeFile(path.join(root, "a.txt"), "manual change\n");
    const result = await service.rollback({ change_id: applied.metadata.change_id });

    assert.equal(result.status, "conflict");
    assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "manual change\n");
    assert.equal(result.metadata.conflicts.length, 1);
    assert.equal(result.metadata.conflicts[0].path, "a.txt");
    assert.equal(result.metadata.force_available, true);
    assert.equal(conflicts.length, 1);
  });

  test("force rollback overwrites dirty files and reports conflicts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-edit-service-force-"));
    await writeFile(path.join(root, "a.txt"), "old\n");
    const service = createEditService({ projectRoot: root });

    const applied = await service.apply({ diff: MODIFY_DIFF, prompt: "update a" });
    await writeFile(path.join(root, "a.txt"), "manual change\n");
    const result = await service.rollback({ change_id: applied.metadata.change_id, force: true });

    assert.equal(result.status, "success");
    assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "old\n");
    assert.equal(result.metadata.forced, true);
    assert.equal(result.metadata.conflicts.length, 1);
  });

  test("transaction events do not include raw diff or file content", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-edit-service-event-privacy-"));
    await writeFile(path.join(root, "a.txt"), "old secret text\n");
    const eventBus = createEventBus();
    const events = [];
    for (const type of [
      "file:transaction_started",
      "file:transaction_committed",
      "file:transaction_failed",
      "file:transaction_rolled_back",
      "file:rollback_conflict",
      "file:diff_applied",
      "file:rollback_applied"
    ]) {
      eventBus.subscribe(type, (data) => events.push({ type, data }));
    }
    const service = createEditService({ projectRoot: root, eventBus });

    const applied = await service.apply({
      diff: "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old secret text\n+new secret text",
      prompt: "privacy"
    });
    await writeFile(path.join(root, "a.txt"), "manual secret text\n");
    await service.rollback({ change_id: applied.metadata.change_id });

    const raw = JSON.stringify(events);
    assert.equal(raw.includes("old secret text"), false);
    assert.equal(raw.includes("new secret text"), false);
    assert.equal(raw.includes("manual secret text"), false);
    assert.equal(raw.includes("@@ -1 +1 @@"), false);
  });

  test("apply rejects unsafe diff before writing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-edit-service-"));
    const service = createEditService({ projectRoot: root });
    const diff = "--- a/../outside.txt\n+++ b/../outside.txt\n@@ -1 +1 @@\n-old\n+new";

    await assert.rejects(() => service.apply({ diff, prompt: "escape" }), /escapes project root/);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/edits/edit-transaction.test.js
// ---------------------------------------------------------------------------
describe("unit/edits/edit-transaction", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { readFile, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { enhanceChangeRecord, hashContent, restoreSnapshots, safeTransactionError, snapshotTouchedFiles } = await import("../../../src/edits/edit-transaction.js");
  const { parseDiff } = await import("../../../src/edits/diff-parser.js");
  const { mkdtemp } = await import("../../helpers/tmp.js");

  test("hashContent returns stable sha256 metadata", () => {
    const result = hashContent("hello\n");

    assert.equal(result.hash.startsWith("sha256:"), true);
    assert.equal(result.bytes, Buffer.byteLength("hello\n"));
    assert.equal(hashContent("hello\n").hash, result.hash);
    assert.notEqual(hashContent("other\n").hash, result.hash);
  });

  test("snapshotTouchedFiles records existing and created file states", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-edit-tx-snapshot-"));
    await writeFile(path.join(root, "a.txt"), "old\n");
    const diff = [
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/new.txt b/new.txt",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1 @@",
      "+created"
    ].join("\n");
    const parsed = parseDiff(diff);

    const snapshots = await snapshotTouchedFiles(root, parsed.patches);

    const byPath = Object.fromEntries(snapshots.map((item) => [item.path, item]));
    assert.equal(byPath["a.txt"].status, "modify");
    assert.equal(byPath["a.txt"].existed_before, true);
    assert.equal(byPath["a.txt"].before, "old\n");
    assert.equal(byPath["a.txt"].before_hash, hashContent("old\n").hash);
    assert.equal(byPath["new.txt"].status, "create");
    assert.equal(byPath["new.txt"].existed_before, false);
    assert.equal(byPath["new.txt"].before, null);
    assert.equal(byPath["new.txt"].before_hash, null);
  });

  test("restoreSnapshots restores modified files and removes created files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-edit-tx-restore-"));
    await writeFile(path.join(root, "a.txt"), "old\n");
    const parsed = parseDiff([
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/new.txt b/new.txt",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1 @@",
      "+created"
    ].join("\n"));
    const snapshots = await snapshotTouchedFiles(root, parsed.patches);
    await writeFile(path.join(root, "a.txt"), "new\n");
    await writeFile(path.join(root, "new.txt"), "created\n");

    const restored = await restoreSnapshots(root, snapshots);

    assert.deepEqual(restored.sort(), ["a.txt", "new.txt"]);
    assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "old\n");
    await assert.rejects(() => readFile(path.join(root, "new.txt"), "utf8"), /ENOENT/);
  });

  test("snapshotTouchedFiles refuses create patches when target already exists", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-edit-tx-create-exists-"));
    await writeFile(path.join(root, "new.txt"), "user content\n");
    const parsed = parseDiff([
      "diff --git a/new.txt b/new.txt",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1 @@",
      "+created"
    ].join("\n"));

    await assert.rejects(
      () => snapshotTouchedFiles(root, parsed.patches),
      /already exists/
    );
  });

  test("safeTransactionError returns category-only message, no raw content", () => {
    const contentLeak = safeTransactionError(new Error("patch context mismatch: expected 'secret a', got 'old a'"));
    assert.equal(contentLeak.includes("secret a"), false);
    assert.equal(contentLeak.includes("old a"), false);
    assert.match(contentLeak, /patch_failed/);

    const finalizeErr = safeTransactionError(new Error("ENOENT: write failed"));
    assert.match(finalizeErr, /transaction_finalize_failed/);

    const restoreErr = safeTransactionError(new Error("something else"));
    assert.match(restoreErr, /transaction_failed/);
  });

  test("detectRollbackConflicts treats non-file paths as dirty", async () => {
    const { detectRollbackConflicts } = await import("../../../src/edits/edit-transaction.js");
    const root = await mkdtemp(path.join(tmpdir(), "dsc-edit-tx-eisdir-"));
    // Create a directory at the file path to trigger EISDIR
    await (await import("node:fs/promises")).mkdir(path.join(root, "a.txt"));

    const record = {
      id: "change_1",
      files: [{ path: "a.txt", newPath: "a.txt", oldPath: "a.txt", status: "modify", before: "old\n", after: "new\n", after_hash: hashContent("new\n").hash }]
    };
    const conflicts = await detectRollbackConflicts(root, record);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].path, "a.txt");
    assert.equal(conflicts[0].reason, "dirty");
  });

  test("restoreSnapshots removes empty parent dirs created during apply", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-edit-tx-cleandir-"));
    // Diff creates nested/new.txt
    const parsed = parseDiff([
      "diff --git a/deep/nested/new.txt b/deep/nested/new.txt",
      "--- /dev/null",
      "+++ b/deep/nested/new.txt",
      "@@ -0,0 +1 @@",
      "+created"
    ].join("\n"));
    const snapshots = await snapshotTouchedFiles(root, parsed.patches);
    // Apply: create the nested file
    const { resolveWorkspacePath } = await import("../../../src/workspace/path-safety.js");
    const resolved = await resolveWorkspacePath(root, "deep/nested/new.txt", { mustExist: false });
    await (await import("node:fs/promises")).mkdir(path.dirname(resolved.absolute), { recursive: true });
    await writeFile(resolved.absolute, "created\n");

    const restored = await restoreSnapshots(root, snapshots);
    assert.deepEqual(restored, ["deep/nested/new.txt"]);
    // All parent dirs should be cleaned up
    const { stat } = await import("node:fs/promises");
    await assert.rejects(() => stat(path.join(root, "deep", "nested")), /ENOENT/);
    await assert.rejects(() => stat(path.join(root, "deep")), /ENOENT/);
  });

  test("enhanceChangeRecord adds before and after hashes to each file", () => {
    const record = {
      id: "change_1",
      files: [
        {
          path: "a.txt",
          oldPath: "a.txt",
          newPath: "a.txt",
          status: "modify",
          before: "old\n",
          after: "new\n"
        }
      ]
    };
    const enhanced = enhanceChangeRecord(record, { transaction_id: "tx_1" });

    assert.equal(enhanced.transaction_id, "tx_1");
    assert.equal(enhanced.files[0].before_hash, hashContent("old\n").hash);
    assert.equal(enhanced.files[0].after_hash, hashContent("new\n").hash);
    assert.equal(enhanced.files[0].before_bytes, Buffer.byteLength("old\n"));
    assert.equal(enhanced.files[0].after_bytes, Buffer.byteLength("new\n"));
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/edits/sensitive-notice.test.js
// ---------------------------------------------------------------------------
describe("unit/edits/sensitive-notice", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { readFile, readdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { buildSensitiveNotice, sensitiveReasonFor } = await import("../../../src/edits/sensitive-notice.js");
  const { createEditService } = await import("../../../src/edits/edit-service.js");
  const { mkdtemp } = await import("../../helpers/tmp.js");

  const ENV_DIFF = "--- a/.env\n+++ b/.env\n@@ -1 +1 @@\n-OLD=1\n+NEW=2";
  const SAFE_DIFF = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new";

  // ── 纯判定层 ──

  test("sensitiveReasonFor flags secret and credential files", () => {
    assert.equal(sensitiveReasonFor(".env"), "secret-file");
    assert.equal(sensitiveReasonFor(".env.production"), "secret-file");
    assert.equal(sensitiveReasonFor("certs/server.pem"), "secret-file");
    assert.equal(sensitiveReasonFor("id_rsa.key"), "secret-file");
    assert.equal(sensitiveReasonFor(".npmrc"), "credential-file");
    assert.equal(sensitiveReasonFor("config/credentials.json"), "credential-file");
  });

  // 这条是本模块存在的理由:contextSkipReason 对 node_modules/dist/.vscode 也返回
  // 非 null(ignored-directory / hidden-tool-dir),但那些不是密钥文件。整个复用
  // 会让红色提醒在改 dist/ 时也弹,沦为噪音 —— 提醒一旦成噪音就等于没有。
  test("sensitiveReasonFor does NOT flag merely-ignored paths (would make the warning noise)", () => {
    assert.equal(sensitiveReasonFor("node_modules/lib/index.js"), null);
    assert.equal(sensitiveReasonFor("dist/bundle.js"), null);
    assert.equal(sensitiveReasonFor("build/out.js"), null);
    assert.equal(sensitiveReasonFor(".vscode/settings.json"), null);
    assert.equal(sensitiveReasonFor(".claude/config.json"), null);
    assert.equal(sensitiveReasonFor("src/app.js"), null);
  });

  test("buildSensitiveNotice returns only the sensitive subset, null when none", () => {
    const notice = buildSensitiveNotice([".env", "src/a.js", "certs/k.pem"]);
    assert.deepEqual(notice.paths, [
      { path: ".env", reason: "secret-file" },
      { path: "certs/k.pem", reason: "secret-file" }
    ]);
    assert.equal(buildSensitiveNotice(["src/a.js", "README.md"]), null);
    assert.equal(buildSensitiveNotice([]), null);
  });

  // ── editService 接入 ──

  async function fixture() {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-sensitive-"));
    await writeFile(path.join(root, ".env"), "OLD=1\n");
    await writeFile(path.join(root, "a.txt"), "old\n");
    return root;
  }

  async function changeRecordCount(root) {
    try {
      const entries = await readdir(path.join(root, ".deepseek-code", "changes"));
      return entries.filter((n) => n.endsWith(".json")).length;
    } catch (error) {
      if (error.code === "ENOENT") return 0;
      throw error;
    }
  }

  test("editService refuses the edit when the notice callback declines", async () => {
    const root = await fixture();
    const seen = [];
    const svc = createEditService({
      projectRoot: root,
      onSensitiveNotice: async (notice) => { seen.push(notice); return false; }
    });

    await assert.rejects(
      () => svc.apply({ diff: ENV_DIFF, prompt: "touch env" }),
      (e) => e.code === "SENSITIVE_EDIT_DECLINED"
    );
    // 回调确实收到了载荷
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].paths, [{ path: ".env", reason: "secret-file" }]);
    // 文件未被改动,且没有任何变更记录落盘
    assert.equal(await readFile(path.join(root, ".env"), "utf8"), "OLD=1\n");
    assert.equal(await changeRecordCount(root), 0);
  });

  test("editService applies normally when the notice callback allows", async () => {
    const root = await fixture();
    const svc = createEditService({
      projectRoot: root,
      onSensitiveNotice: async () => true
    });

    const result = await svc.apply({ diff: ENV_DIFF, prompt: "touch env" });
    assert.equal(result.status, "success");
    assert.equal(await readFile(path.join(root, ".env"), "utf8"), "NEW=2\n");
    assert.equal(await changeRecordCount(root), 1);
  });

  test("editService never prompts for non-sensitive paths", async () => {
    const root = await fixture();
    let called = 0;
    const svc = createEditService({
      projectRoot: root,
      onSensitiveNotice: async () => { called += 1; return true; }
    });

    const result = await svc.apply({ diff: SAFE_DIFF, prompt: "touch a" });
    assert.equal(result.status, "success");
    assert.equal(called, 0, "普通文件不得触发提醒");
  });

  test("editService without a notice callback behaves exactly as before", async () => {
    const root = await fixture();
    const svc = createEditService({ projectRoot: root });

    const result = await svc.apply({ diff: ENV_DIFF, prompt: "touch env" });
    assert.equal(result.status, "success");
    assert.equal(await readFile(path.join(root, ".env"), "utf8"), "NEW=2\n");
    assert.equal(await changeRecordCount(root), 1);
  });

  // 安全默认:回调返回任何非 true 的值(undefined/null/抛错以外)都按拒绝处理,
  // 避免实现方漏写返回值就等于放行。
  test("editService treats a non-true callback result as decline", async () => {
    const root = await fixture();
    const svc = createEditService({
      projectRoot: root,
      onSensitiveNotice: async () => undefined
    });

    await assert.rejects(
      () => svc.apply({ diff: ENV_DIFF, prompt: "touch env" }),
      (e) => e.code === "SENSITIVE_EDIT_DECLINED"
    );
    assert.equal(await readFile(path.join(root, ".env"), "utf8"), "OLD=1\n");
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/edits/change-store.test.js
// ---------------------------------------------------------------------------
describe("unit/edits/change-store", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { readFile, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { applyUnifiedDiff } = await import("../../../src/edits/diff-parser.js");
  const { createChangeStore } = await import("../../../src/edits/change-store.js");
  const { createRollbackService } = await import("../../../src/edits/rollback-service.js");
  const { mkdtemp } = await import("../../helpers/tmp.js");

  const MODIFY_DIFF = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new";

  test("change store captures finalizes lists and describes legacy change records", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-change-store-"));
    await writeFile(path.join(root, "a.txt"), "old\n");
    const store = createChangeStore({ projectRoot: root });

    const plan = await store.capture({ diff: MODIFY_DIFF, prompt: "update a" });
    await applyUnifiedDiff(MODIFY_DIFF, root);
    const record = await store.finalize(plan);
    const list = await store.list({ limit: 5 });
    const described = await store.describe({ change_id: record.id });

    assert.equal(record.prompt, "update a");
    assert.equal(record.summary[0].path, "a.txt");
    assert.equal(record.files[0].before, "old\n");
    assert.equal(record.files[0].after, "new\n");
    assert.equal(list[0].id, record.id);
    assert.equal(described.id, record.id);
  });

  test("rollback service restores a finalized change record", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-change-store-"));
    await writeFile(path.join(root, "a.txt"), "old\n");
    const store = createChangeStore({ projectRoot: root });
    const rollback = createRollbackService({ projectRoot: root });

    const plan = await store.capture({ diff: MODIFY_DIFF, prompt: "update a" });
    await applyUnifiedDiff(MODIFY_DIFF, root);
    const record = await store.finalize(plan);
    const rolledBack = await rollback.rollback({ change_id: record.id });

    assert.equal(rolledBack.record.id, record.id);
    assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "old\n");
  });

  test("change store finalize with transaction enhances legacy record", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-change-store-tx-"));
    await writeFile(path.join(root, "a.txt"), "old\n");
    const store = createChangeStore({ projectRoot: root });

    const plan = await store.capture({ diff: MODIFY_DIFF, prompt: "update a" });
    await applyUnifiedDiff(MODIFY_DIFF, root);
    const record = await store.finalize(plan, { transaction: { transaction_id: "tx_test" } });

    assert.equal(record.transaction_id, "tx_test");
    assert.ok(record.files[0].before_hash?.startsWith("sha256:"));
    assert.ok(record.files[0].after_hash?.startsWith("sha256:"));
    // Cleanup on failure: verify that if enhance write fails, the error propagates
    // (the try/catch in finalize ensures no stale record is left)
  });

  test("change store requires projectRoot", () => {
    assert.throws(() => createChangeStore(), /projectRoot is required/);
    assert.throws(() => createRollbackService(), /projectRoot is required/);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/edits/change-retention-wiring.test.js
// ---------------------------------------------------------------------------
describe("unit/edits/change-retention-wiring", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { readdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { createKernel } = await import("../../../src/index.js");
  const { createEditService } = await import("../../../src/edits/edit-service.js");
  const { createChangeStore } = await import("../../../src/edits/change-store.js");
  const { normalizeEdits, DEFAULT_CONFIG } = await import("../../../src/config.js");
  const { buildKernelOptions } = await import("../../../src/apps/kernel-options.js");
  const { createToolCall } = await import("../../../src/core/protocol/index.js");
  const { mkdtemp } = await import("../../helpers/tmp.js");

  const DIFF = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new";

  test("normalizeEdits defaults match DEFAULT_CONFIG", () => {
    const out = normalizeEdits(undefined);
    assert.deepEqual(out, DEFAULT_CONFIG.edits);
    assert.equal(out.maxCaptureBytes, 1024 * 1024);
    assert.deepEqual(out.changeRetention, { maxRecords: 200, maxAgeDays: 90 });
  });

  test("normalizeEdits keeps partial changeRetention fields and fills defaults", () => {
    const out = normalizeEdits({ changeRetention: { maxRecords: 5 } });
    assert.deepEqual(out.changeRetention, { maxRecords: 5, maxAgeDays: 90 });
  });

  test("normalizeEdits null disables capture cap and retention", () => {
    const out = normalizeEdits({ maxCaptureBytes: null, changeRetention: null });
    assert.equal(out.maxCaptureBytes, null);
    assert.equal(out.changeRetention, null);
  });

  test("normalizeEdits ignores invalid maxCaptureBytes", () => {
    assert.equal(normalizeEdits({ maxCaptureBytes: -1 }).maxCaptureBytes, 1024 * 1024);
    assert.equal(normalizeEdits({ maxCaptureBytes: "x" }).maxCaptureBytes, 1024 * 1024);
  });

  test("createEditService with edits prunes via change-store", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-edits-wire-"));
    await writeFile(path.join(root, "a.txt"), "old\n");
    const svc = createEditService({
      projectRoot: root,
      edits: { changeRetention: { maxRecords: 1 } }
    });
    for (let i = 0; i < 3; i += 1) {
      await writeFile(path.join(root, "a.txt"), "old\n");
      await svc.apply({ diff: DIFF, prompt: `c${i}` });
    }
    const entries = (await readdir(path.join(root, ".deepseek-code", "changes")))
      .filter((n) => n.endsWith(".json"));
    assert.equal(entries.length, 1, "changeRetention 应清理到 maxRecords=1");
  });

  test("createChangeStore default (no edits) does not prune", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-edits-noprune-"));
    await writeFile(path.join(root, "a.txt"), "old\n");
    const store = createChangeStore({ projectRoot: root });
    const { applyUnifiedDiff } = await import("../../../src/edits/diff-parser.js");
    const { captureChangePlan, finalizeChange } = await import("../../../src/edits/change-store.js");
    for (let i = 0; i < 3; i += 1) {
      const plan = await captureChangePlan(root, DIFF, `c${i}`);
      await applyUnifiedDiff(DIFF, root);
      await writeFile(path.join(root, "a.txt"), "old\n");
      await finalizeChange(root, plan);
    }
    const entries = (await readdir(path.join(root, ".deepseek-code", "changes")))
      .filter((n) => n.endsWith(".json"));
    assert.equal(entries.length, 3, "未注入 edits 时保持旧行为、不清理");
  });

  test("buildKernelOptions forwards config.edits", async () => {
    const opts = await buildKernelOptions("/tmp/unused-root", {}, async () => ({
      apiKey: "sk-test",
      baseUrl: "https://api.deepseek.com",
      limits: {},
      orchestration: {},
      context: {},
      edits: { maxCaptureBytes: 4096, changeRetention: { maxRecords: 10, maxAgeDays: 7 } }
    }));
    assert.deepEqual(opts.edits, {
      maxCaptureBytes: 4096,
      changeRetention: { maxRecords: 10, maxAgeDays: 7 }
    });
  });

  test("kernel options.edits wires into editService retention", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-kernel-edits-"));
    await writeFile(path.join(root, "a.txt"), "old\n");
    const kernel = await createKernel(root, {
      sessionId: "sess_edits_wire",
      edits: { changeRetention: { maxRecords: 1 } }
    });
    try {
      for (let i = 0; i < 3; i += 1) {
        await writeFile(path.join(root, "a.txt"), "old\n");
        const result = await kernel.tools.execute(
          createToolCall({
            name: "diff_apply",
            params: { diff: DIFF, prompt: `k${i}`, approval_id: "appr_1" },
            requestedByStepId: "step_1"
          }),
          { autonomy: "gated", turnId: "turn_1" }
        );
        assert.equal(result.status, "success");
      }
      const entries = (await readdir(path.join(root, ".deepseek-code", "changes")))
        .filter((n) => n.endsWith(".json"));
      assert.equal(entries.length, 1, "createKernel 注入的 edits 应生效");
    } finally {
      await kernel.dispose?.();
    }
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/changes-retention.test.js
// ---------------------------------------------------------------------------
describe("unit/changes-retention", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { readFile, readdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { applyUnifiedDiff } = await import("../../../src/edits/diff-parser.js");
  const { captureChangePlan, finalizeChange, listChanges } = await import("../../../src/edits/change-store.js");
  const { mkdtemp } = await import("../../helpers/tmp.js");

  const DIFF = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new";

  test("finalize prunes records beyond maxRecords, newest retained", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-retention-count-"));
    await writeFile(path.join(root, "a.txt"), "old\n");
    const retention = { maxRecords: 2 };
    for (let i = 0; i < 4; i += 1) {
      const plan = await captureChangePlan(root, DIFF, `change ${i}`);
      await applyUnifiedDiff(DIFF, root);
      await writeFile(path.join(root, "a.txt"), "old\n"); // 复位,供下一次 capture 读 before
      await finalizeChange(root, plan, { changeRetention: retention });
    }
    const list = await listChanges(root, 10);
    assert.equal(list.length, 2, "超出 maxRecords 的旧记录应被清理");
    const dirEntries = await readdir(path.join(root, ".deepseek-code", "changes"));
    assert.equal(dirEntries.filter((n) => n.endsWith(".json")).length, 2);
  });

  test("finalize prunes records older than maxAgeDays, keeps newer", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-retention-age-"));
    await writeFile(path.join(root, "a.txt"), "old\n");
    const retention = { maxAgeDays: 90 };

    // 制造一条 200 天前的旧记录
    const oldPlan = await captureChangePlan(root, DIFF, "old");
    await applyUnifiedDiff(DIFF, root);
    const oldRecord = await finalizeChange(root, oldPlan, { changeRetention: retention });
    const oldPath = path.join(root, ".deepseek-code", "changes", `${oldRecord.id}.json`);
    const oldRecordJson = JSON.parse(await readFile(oldPath, "utf8"));
    oldRecordJson.time = new Date(Date.now() - 200 * 86400000).toISOString();
    await writeFile(oldPath, JSON.stringify(oldRecordJson, null, 2) + "\n");

    // 新记录触发清理
    await writeFile(path.join(root, "a.txt"), "old\n");
    const plan = await captureChangePlan(root, DIFF, "new");
    await applyUnifiedDiff(DIFF, root);
    await finalizeChange(root, plan, { changeRetention: retention });

    const list = await listChanges(root, 10);
    assert.equal(list.length, 1, "超过 maxAgeDays 的旧记录应被清理");
    assert.equal(list[0].prompt, "new");
  });

  test("retention cleanup leaves the workspace files untouched", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-retention-ws-"));
    await writeFile(path.join(root, "a.txt"), "old\n");
    await writeFile(path.join(root, "b.txt"), "keep-me\n");
    const retention = { maxRecords: 1 };
    for (let i = 0; i < 3; i += 1) {
      const plan = await captureChangePlan(root, DIFF, `change ${i}`);
      await applyUnifiedDiff(DIFF, root);
      await writeFile(path.join(root, "a.txt"), "old\n");
      await finalizeChange(root, plan, { changeRetention: retention });
    }
    assert.equal(await readFile(path.join(root, "b.txt"), "utf8"), "keep-me\n");
    assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "old\n");
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/changes-display-redaction.test.js
// ---------------------------------------------------------------------------
describe("unit/changes-display-redaction", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { readFile, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { applyUnifiedDiff } = await import("../../../src/edits/diff-parser.js");
  const { captureChangePlan, finalizeChange, formatChange, describeChange } = await import("../../../src/edits/change-store.js");
  const { rollbackChange } = await import("../../../src/edits/rollback-service.js");
  const { mkdtemp } = await import("../../helpers/tmp.js");

  const SECRET = "sk-live-AbCdEf0123456789AbCdEf0123456789";
  const DIFF = `--- a/.env\n+++ b/.env\n@@ -1 +1 @@\n-OLD=1\n+DEEPSEEK_API_KEY=${SECRET}`;

  async function makeRecord() {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-redact-"));
    await writeFile(path.join(root, ".env"), "OLD=1\n");
    const plan = await captureChangePlan(root, DIFF, `rotate key ${SECRET}`);
    await applyUnifiedDiff(DIFF, root);
    const record = await finalizeChange(root, plan);
    return { root, record };
  }

  test("formatChange redacts secrets in the displayed diff and prompt", async () => {
    const { record } = await makeRecord();
    const shown = formatChange(record);
    assert.ok(!shown.includes(SECRET), "显示内容不得含明文密钥");
    assert.match(shown, /\.env/, "文件名仍应可见");
  });

  // 这条是本片的硬约束:脱敏只作用于显示,**存储必须原样**,否则回滚会写回被掩码的
  // 垃圾。两侧同时断言,防止有人图省事把 redactor 套到写盘路径上。
  test("storage keeps the original bytes while display is redacted", async () => {
    const { root, record } = await makeRecord();

    // 显示侧:已脱敏
    assert.ok(!formatChange(record).includes(SECRET));

    // 存储侧:磁盘记录仍是原文
    const onDisk = await readFile(
      path.join(root, ".deepseek-code", "changes", `${record.id}.json`),
      "utf8"
    );
    assert.ok(onDisk.includes(SECRET), "落盘记录必须保留原文供回滚");

    // describeChange 读回的记录也是原文(它是数据读取,不是展示函数)
    const readBack = await describeChange(root, record.id);
    assert.ok(JSON.stringify(readBack).includes(SECRET));
  });

  // 证明脱敏没污染回滚:回滚后文件应精确复原为改动前内容。
  test("rollback still restores exact original content after display redaction exists", async () => {
    const { root, record } = await makeRecord();
    assert.equal(await readFile(path.join(root, ".env"), "utf8"), `DEEPSEEK_API_KEY=${SECRET}\n`);

    await rollbackChange(root, record.id);
    assert.equal(await readFile(path.join(root, ".env"), "utf8"), "OLD=1\n", "回滚必须逐字节复原");
  });

  test("formatChange tolerates records with missing prompt or diff", () => {
    const shown = formatChange({ id: "x", time: "t", summary: [] });
    assert.match(shown, /变更 ID：x/);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/changes-capture-limit.test.js
// ---------------------------------------------------------------------------
describe("unit/changes-capture-limit", async () => {

  // 200 行、每行 ~25 字符 → 约 5KB 的「大文件」,改动第 1 行

  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { readFile, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { applyUnifiedDiff } = await import("../../../src/edits/diff-parser.js");
  const { captureChangePlan, finalizeChange } = await import("../../../src/edits/change-store.js");
  const { rollbackChange } = await import("../../../src/edits/rollback-service.js");
  const { createRollbackService } = await import("../../../src/edits/rollback-service.js");
  const { mkdtemp } = await import("../../helpers/tmp.js");

  const BIG_LINES = Array.from({ length: 200 }, (_, i) => `line-${i}-${"x".repeat(20)}`);
  const BIG_DIFF = `--- a/big.txt\n+++ b/big.txt\n@@ -1 +1 @@\n-${BIG_LINES[0]}\n+CHANGED`;
  const CAP = 256;

  test("capture stores sha256 instead of full before text past maxCaptureBytes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-capture-cap-"));
    await writeFile(path.join(root, "big.txt"), BIG_LINES.join("\n") + "\n");
    const plan = await captureChangePlan(root, BIG_DIFF, "p", { maxCaptureBytes: CAP });
    assert.equal(plan.files[0].before, null);
    assert.equal(plan.files[0].truncated, true);
    assert.match(plan.files[0].before_sha256, /^[0-9a-f]{64}$/);
    assert.ok(plan.files[0].before_size > CAP, "记录被截断文件的原始大小");
  });

  test("finalize stores sha256 instead of full after text past maxCaptureBytes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-finalize-cap-"));
    await writeFile(path.join(root, "big.txt"), BIG_LINES.join("\n") + "\n");
    const plan = await captureChangePlan(root, BIG_DIFF, "p", { maxCaptureBytes: CAP });
    await applyUnifiedDiff(BIG_DIFF, root);
    const record = await finalizeChange(root, plan, { maxCaptureBytes: CAP });
    assert.equal(record.files[0].before, null);
    assert.equal(record.files[0].after, null);
    assert.match(record.files[0].before_sha256, /^[0-9a-f]{64}$/);
    assert.match(record.files[0].after_sha256, /^[0-9a-f]{64}$/);
    assert.equal(record.files[0].truncated, true);
  });

  test("rollback refuses a truncated record instead of writing empty content", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-rollback-cap-"));
    await writeFile(path.join(root, "big.txt"), BIG_LINES.join("\n") + "\n");
    const plan = await captureChangePlan(root, BIG_DIFF, "p", { maxCaptureBytes: CAP });
    await applyUnifiedDiff(BIG_DIFF, root);
    const record = await finalizeChange(root, plan, { maxCaptureBytes: CAP });
    await assert.rejects(
      () => rollbackChange(root, record.id),
      (e) => e.code === "ROLLBACK_TRUNCATED"
    );
    // 文件必须未被清空:仍是改后内容,而非空串
    const afterText = await readFile(path.join(root, "big.txt"), "utf8");
    assert.ok(afterText.length > 0, "回滚拒绝后文件不得被清空");
  });

  test("rollback service also refuses a truncated record (GUI/edit-service path)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-rollback-svc-cap-"));
    await writeFile(path.join(root, "big.txt"), BIG_LINES.join("\n") + "\n");
    const plan = await captureChangePlan(root, BIG_DIFF, "p", { maxCaptureBytes: CAP });
    await applyUnifiedDiff(BIG_DIFF, root);
    const record = await finalizeChange(root, plan, { maxCaptureBytes: CAP });
    const service = createRollbackService({ projectRoot: root });
    await assert.rejects(
      () => service.rollback({ change_id: record.id, force: true }),
      (e) => e.code === "ROLLBACK_TRUNCATED"
    );
  });
});
