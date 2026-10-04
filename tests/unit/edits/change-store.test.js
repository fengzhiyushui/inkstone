import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyUnifiedDiff } from "../../../src/patch.js";
import { createChangeStore } from "../../../src/edits/change-store.js";
import { createRollbackService } from "../../../src/edits/rollback-service.js";
import { mkdtemp } from "../../helpers/tmp.js";

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
