import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { mkdtemp } from "../../helpers/tmp.js";
const require = createRequire(import.meta.url);
const { createKernelHost } = require("../../../gui/kernel-host.js");

const DIFF_A = [
  "--- a/src/a.js",
  "+++ b/src/a.js",
  "@@ -1,2 +1,3 @@",
  " line1",
  "-old",
  "+new",
  "+added",
  ""
].join("\n");

async function tmpProject() {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsc-chg-"));
  await fs.mkdir(path.join(root, ".deepseek-code", "changes"), { recursive: true });
  return root;
}

async function seedChange(root, record) {
  const target = path.join(root, ".deepseek-code", "changes", `${record.id}.json`);
  await fs.writeFile(target, JSON.stringify(record, null, 2), "utf8");
}

function makeRecord(overrides = {}) {
  return {
    id: "20260702090000-aaaaaa",
    time: "2026-07-02T09:00:00.000Z",
    prompt: "agent edits a",
    diff: DIFF_A,
    summary: [{ path: "src/a.js", status: "modify" }],
    files: [{
      path: "src/a.js", oldPath: "src/a.js", newPath: "src/a.js", status: "modify",
      before: "SECRET_BEFORE_TEXT", after: "SECRET_AFTER_TEXT"
    }],
    ...overrides
  };
}

test("listChanges slims records, enriches counts/hunkStarts, marks rollbacks", async () => {
  const root = await tmpProject();
  await seedChange(root, makeRecord());
  await seedChange(root, makeRecord({
    id: "20260702100000-bbbbbb", time: "2026-07-02T10:00:00.000Z", prompt: "GUI edit src/a.js"
  }));
  await fs.writeFile(path.join(root, ".deepseek-code", "rollbacks.jsonl"),
    `${JSON.stringify({ time: "2026-07-02T11:00:00.000Z", id: "20260702090000-aaaaaa", forced: false })}\n`, "utf8");

  const host = createKernelHost({ projectRoot: root });
  const list = await host.listChanges();
  assert.equal(list.length, 2);
  assert.equal(list[0].id, "20260702100000-bbbbbb"); // time desc
  const f = list[1].files[0];
  assert.equal(f.added, 2);
  assert.equal(f.removed, 1);
  assert.deepEqual(f.hunkStarts, [1]);
  assert.equal(list[1].rolledBack, true);
  assert.equal(list[0].rolledBack, false);
  const text = JSON.stringify(list);
  assert.ok(!text.includes("SECRET_BEFORE_TEXT"), "list must not carry before text");
  assert.ok(!text.includes("SECRET_AFTER_TEXT"), "list must not carry after text");
  assert.ok(!text.includes("@@ -1,2 +1,3 @@"), "list must not carry raw diff");
});

test("describeChange returns single-file slice with before/after + language", async () => {
  const root = await tmpProject();
  await seedChange(root, makeRecord());
  const host = createKernelHost({ projectRoot: root });
  const d = await host.describeChange("20260702090000-aaaaaa", "src/a.js");
  assert.equal(d.id, "20260702090000-aaaaaa");
  assert.equal(d.file.path, "src/a.js");
  assert.equal(d.file.before, "SECRET_BEFORE_TEXT");
  assert.equal(d.file.after, "SECRET_AFTER_TEXT");
  assert.equal(d.file.language, "javascript");
  assert.deepEqual(d.file.hunkStarts, [1]);
  // relPath 缺省 → 首文件;changeId 缺省 → latest
  assert.equal((await host.describeChange("20260702090000-aaaaaa")).file.path, "src/a.js");
  assert.equal((await host.describeChange(null)).id, "20260702090000-aaaaaa");
  await assert.rejects(() => host.describeChange("20260702090000-aaaaaa", "src/missing.js"));
  await assert.rejects(() => host.describeChange("no-such-id"));
});

test("graceful: no changes dir → [], unparseable diff → null counts", async () => {
  const empty = await mkdtemp(path.join(os.tmpdir(), "dsc-chg-"));
  const host0 = createKernelHost({ projectRoot: empty });
  assert.deepEqual(await host0.listChanges(), []);

  const root = await tmpProject();
  await seedChange(root, makeRecord({ diff: "not a diff at all" }));
  const host = createKernelHost({ projectRoot: root });
  const list = await host.listChanges();
  assert.equal(list.length, 1);
  assert.equal(list[0].files[0].added, null);
  assert.equal(list[0].files[0].hunkStarts, null);
});
