import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os"; import path from "node:path"; import { promises as fs } from "node:fs";
import { fsCopyWorkspace, hashTree, changedPaths } from "../../../src/core/orchestration/workspace-snapshot.js";
import { mkdtemp } from "../../helpers/tmp.js";

async function tmp() { return mkdtemp(path.join(os.tmpdir(), "ws-snap-")); }
const exists = (p) => fs.access(p).then(() => true, () => false);

test("copy excludes .git/node_modules/.deepseek-code; hashTree captures dirty content", async () => {
  const src = await tmp();
  await fs.mkdir(path.join(src, "src")); await fs.writeFile(path.join(src, "src/a.js"), "A\n");
  await fs.mkdir(path.join(src, ".git")); await fs.writeFile(path.join(src, ".git/x"), "g");
  await fs.mkdir(path.join(src, "node_modules")); await fs.writeFile(path.join(src, "node_modules/y"), "n");
  const dest = await tmp();
  const res = await fsCopyWorkspace(src, dest, { maxCopyFiles: 5000 });
  assert.ok(res.copied >= 1);
  assert.equal(await fs.readFile(path.join(dest, "src/a.js"), "utf8"), "A\n");
  assert.equal(await exists(path.join(dest, ".git")), false);
  assert.equal(await exists(path.join(dest, "node_modules")), false);
  const manifest = await hashTree(dest, { maxCopyFiles: 5000 });
  assert.ok(manifest.has("src/a.js"));
});

test("changedPaths reports added/deleted/modified vs base manifest", async () => {
  const root = await tmp();
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src/keep.js"), "k\n");
  await fs.writeFile(path.join(root, "src/mod.js"), "old\n");
  await fs.writeFile(path.join(root, "src/del.js"), "d\n");
  const base = await hashTree(root, { maxCopyFiles: 5000 });
  await fs.writeFile(path.join(root, "src/mod.js"), "new\n");      // modify
  await fs.rm(path.join(root, "src/del.js"));                       // delete
  await fs.writeFile(path.join(root, "src/add.js"), "a\n");         // add
  const ch = changedPaths(await hashTree(root, { maxCopyFiles: 5000 }), base);
  assert.deepEqual(ch.added, ["src/add.js"]);
  assert.deepEqual(ch.deleted, ["src/del.js"]);
  assert.deepEqual(ch.modified, ["src/mod.js"]);
});
