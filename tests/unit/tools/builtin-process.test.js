import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createShellTool } from "../../../src/tools/builtin/shell.js";
import { createTestTool } from "../../../src/tools/builtin/test.js";
import { createGitTool } from "../../../src/tools/builtin/git.js";
import { runProcess } from "../../../src/security/shell-policy.js";
import { mkdtemp } from "../../helpers/tmp.js";

test("shell tool executes structured argv with shell false", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-shell-"));
  const result = await createShellTool().execute(
    { argv: [process.execPath, "-e", "console.log('ok')"], cwd: "." },
    { projectRoot: root }
  );

  assert.equal(result.metadata.exit_code, 0);
  assert.equal(result.stdout.trim(), "ok");
});

test("shell tool rejects raw cmd strings", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-shell-"));

  await assert.rejects(
    () => createShellTool().execute({ cmd: "echo nope" }, { projectRoot: root }),
    /structured argv/
  );
});

test("test tool detects npm test from package json", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-test-"));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node --version" } }));

  const result = await createTestTool().execute({ detect: true }, { projectRoot: root });

  const expectedArgv = process.platform === "win32"
    ? ["cmd.exe", "/d", "/s", "/c", "npm", "test"]
    : ["npm", "test"];
  assert.deepEqual(result.metadata.argv, expectedArgv);
});

test("test tool runs detected npm test without throwing or hanging", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-test-"));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node --version" } }));

  // detect:false forces actual execution via shell tool
  const result = await createTestTool().execute({ detect: false }, { projectRoot: root });

  // The spawned command should complete, returning exit_code (success or spawn_error)
  assert.ok(typeof result.metadata.exit_code === "number" || result.metadata.spawn_error != null);
});

test("shell tool returns error on non-existent command instead of hanging", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-shell-"));
  const result = await createShellTool().execute(
    { argv: ["definitely-not-a-command-xyz"], cwd: "." },
    { projectRoot: root }
  );

  assert.equal(result.metadata.spawn_error != null, true);
  assert.match(result.content[0].text, /spawn error/);
});

test("git tool only allows read operations", async () => {
  const tool = createGitTool();
  assert.throws(() => tool.normalizeParams({ op: "commit" }), /unsupported git read op/);
  assert.deepEqual(tool.normalizeParams({ op: "status" }).argv, ["git", "status", "--short"]);
});

test("security shell policy exports shared runProcess primitive", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-run-process-"));
  const result = await runProcess(
    [process.execPath, "-e", "console.log('shared')"],
    { cwd: root, timeoutMs: 30000 }
  );

  assert.equal(result.metadata.exit_code, 0);
  assert.equal(result.stdout.trim(), "shared");
});

test("git tool uses honest process side-effect metadata and direct read execution", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-git-direct-"));
  const tool = createGitTool();

  assert.equal(tool.category, "read");
  assert.equal(tool.side_effect, "process");

  const result = await tool.execute({ op: "status" }, { projectRoot: root });

  assert.ok(typeof result.metadata.exit_code === "number" || result.metadata.spawn_error != null);
  assert.deepEqual(tool.normalizeParams({ op: "log" }).argv, ["git", "log", "--oneline", "-20"]);
});
