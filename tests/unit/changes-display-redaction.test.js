import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyUnifiedDiff } from "../../src/patch.js";
import { captureChangePlan, finalizeChange, formatChange, describeChange, rollbackChange } from "../../src/changes.js";
import { mkdtemp } from "../helpers/tmp.js";

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
