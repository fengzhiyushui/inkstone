import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createGrepTool } from "../../../src/tools/builtin/grep.js";
import { mkdtemp } from "../../helpers/tmp.js";

test("grep tool skips a file when per-file budget is exhausted and keeps searching", async () => {
  const root = await timeoutFixtureWorkspace();
  // 调用序列（参照 execute 内 now() 的取样点）:
  // 1 totalStart / 2 文件一总预算预检 / 3 文件一 fileStart
  // 4 文件一 index 0 总预算 / 5 文件一 index 0 每文件预算(500-0 >= 100 → 跳过)
  // 6 文件二总预算预检 / 7 文件二 fileStart / 8+ 恒为 500 → 文件二不超时
  const now = sequenceClock([0, 0, 0, 0, 500], 500);
  const tool = createGrepTool({ now, totalTimeoutMs: 10_000, perFileTimeoutMs: 100 });

  const result = await tool.execute(
    { pattern: "unique_token_xyz", path: ".", max_matches: 200 },
    { projectRoot: root }
  );

  assert.equal(result.metadata.timed_out, true);
  assert.equal(result.metadata.timed_out_scope, "file");
  assert.equal(result.metadata.files_skipped_timeout >= 1, true);
  assert.equal(result.metadata.files_searched, 2);
  assert.equal(result.metadata.matches, 1);
  assert.match(result.content[0].text, /unique_token_xyz/);
});

test("grep tool stops entirely when total budget is exhausted", async () => {
  const root = await timeoutFixtureWorkspace();
  // 1 totalStart=0 / 2 文件一总预算预检=0 / 3 文件一 fileStart=0
  // 4 文件一 index 0 总预算=5000 >= 1000 → "total"，终止全部搜索
  const now = sequenceClock([0, 0, 0], 5000);
  const tool = createGrepTool({ now, totalTimeoutMs: 1000, perFileTimeoutMs: 1_000_000 });

  const result = await tool.execute(
    { pattern: "unique_token_xyz", path: ".", max_matches: 200 },
    { projectRoot: root }
  );

  assert.equal(result.metadata.timed_out, true);
  assert.equal(result.metadata.timed_out_scope, "total");
  assert.equal(result.metadata.files_searched, 1);
  assert.equal(result.metadata.files_skipped_timeout, 0);
  assert.equal(result.metadata.matches, 0);
  assert.equal(result.content[0].text.includes("unique_token_xyz"), false);
});

test("grep tool reports no timeout on the normal path with real clock", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-grep-normal-"));
  await writeFile(path.join(root, "app.txt"), "say hello\n", "utf8");
  const tool = createGrepTool();

  const result = await tool.execute(
    { pattern: "hello", path: ".", max_matches: 200 },
    { projectRoot: root }
  );

  assert.equal(result.metadata.matches, 1);
  assert.equal(result.metadata.timed_out, false);
  assert.equal(result.metadata.timed_out_scope, null);
  assert.equal(result.metadata.files_skipped_timeout, 0);
});

function sequenceClock(values, fallback) {
  let calls = 0;
  return () => {
    const value = calls < values.length ? values[calls] : fallback;
    calls += 1;
    return value;
  };
}

async function timeoutFixtureWorkspace() {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-grep-timeout-"));
  await mkdir(path.join(root, "a"));
  await mkdir(path.join(root, "b"));
  const manyLines = Array.from({ length: 200 }, (_, i) => `aaa line ${i}`).join("\n");
  await writeFile(path.join(root, "a", "one.txt"), manyLines, "utf8");
  await writeFile(path.join(root, "b", "two.txt"), "unique_token_xyz\n", "utf8");
  return root;
}
