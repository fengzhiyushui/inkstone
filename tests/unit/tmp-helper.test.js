import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtemp, isInsideTempDir } from "../helpers/tmp.js";

test("tmp 助手:创建真实目录,且位于 os.tmpdir() 之内", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dsc-helpercheck-"));
  assert.ok(existsSync(dir), "创建后目录应存在");
  assert.ok(dir.startsWith(tmpdir()), "应落在系统临时目录内");
  assert.equal(isInsideTempDir(dir), true);
});

test("tmp 助手:越界路径判定为不安全(不参与回收)", () => {
  assert.equal(isInsideTempDir(path.join(tmpdir(), "dsc-x")), true);
  assert.equal(isInsideTempDir(path.resolve("/")), false);
  assert.equal(isInsideTempDir(path.resolve("C:/Windows")), false);
  assert.equal(isInsideTempDir(path.resolve("../outside-tmp")), false);
});
