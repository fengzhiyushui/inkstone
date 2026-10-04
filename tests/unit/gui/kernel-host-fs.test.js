import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { mkdtemp } from "../../helpers/tmp.js";

const require = createRequire(import.meta.url);
const { createKernelHost } = require("../../../gui/kernel-host.js");

async function tmpProject() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dsc-fs-"));
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.writeFile(path.join(dir, "src", "index.js"), "export const x = 1;\n");
  await fs.writeFile(path.join(dir, "README.md"), "# hi\n");
  await fs.mkdir(path.join(dir, "node_modules", "z"), { recursive: true });
  await fs.writeFile(path.join(dir, "node_modules", "z", "a.js"), "junk");
  return dir;
}

test("listTree returns project files, excludes node_modules/.git", async () => {
  const host = createKernelHost({ projectRoot: await tmpProject() });
  const files = await host.listTree();
  assert.ok(files.includes("src/index.js"));
  assert.ok(files.includes("README.md"));
  assert.ok(!files.some((f) => f.startsWith("node_modules/")));
});

test("readFile returns content + language, rejects escape", async () => {
  const host = createKernelHost({ projectRoot: await tmpProject() });
  const f = await host.readFile("src/index.js");
  assert.match(f.content, /export const x/);
  assert.equal(f.language, "javascript");
  await assert.rejects(() => host.readFile("../../../etc/passwd"));
});

test("readFile maps extensions to languages", async () => {
  const host = createKernelHost({ projectRoot: await tmpProject() });
  assert.equal((await host.readFile("README.md")).language, "markdown");
});
