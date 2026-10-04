import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyUnifiedDiff } from "../../src/patch.js";
import { captureChangePlan, finalizeChange, rollbackChange } from "../../src/changes.js";
import { createRollbackService } from "../../src/edits/rollback-service.js";
import { mkdtemp } from "../helpers/tmp.js";

// 200 行、每行 ~25 字符 → 约 5KB 的「大文件」,改动第 1 行
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
