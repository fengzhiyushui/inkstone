import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyUnifiedDiff } from "../../src/patch.js";
import { captureChangePlan, finalizeChange, listChanges } from "../../src/changes.js";
import { mkdtemp } from "../helpers/tmp.js";

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
