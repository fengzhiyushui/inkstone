// tests/unit/tools/builtin-tools.test.js — 内置工具(文件/进程/网络记忆)领域测试
//
// v1.19.1 测试归并:本文件由下列历史任务单测试合并而成,每个来源包裹在独立
// describe 块中(异步回调 + 动态 import,来源间零共享绑定),测试语义与拆分前一致。
import { describe } from "node:test";

// ---------------------------------------------------------------------------
// 来源:tests/unit/tools/builtin-files.test.js
// ---------------------------------------------------------------------------
describe("unit/tools/builtin-files", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { createReadTool } = await import("../../../src/tools/builtin/read.js");
  const { createLsTool } = await import("../../../src/tools/builtin/ls.js");
  const { createGrepTool } = await import("../../../src/tools/builtin/grep.js");
  const { createGlobTool } = await import("../../../src/tools/builtin/glob.js");
  const { mkdtemp } = await import("../../helpers/tmp.js");

  test("read tool reads text files inside workspace", async () => {
    const root = await fixtureWorkspace();
    const result = await createReadTool().execute({ path: "README.md" }, { projectRoot: root });

    assert.equal(result.content[0].text, "# Demo");
    assert.equal(result.metadata.path, "README.md");
  });

  test("ls tool lists directory entries", async () => {
    const root = await fixtureWorkspace();
    const result = await createLsTool().execute({ path: "." }, { projectRoot: root });

    assert.match(result.content[0].text, /README.md/);
    assert.equal(result.metadata.count >= 2, true);
  });

  test("grep tool finds regex matches with file and line", async () => {
    const root = await fixtureWorkspace();
    const result = await createGrepTool().execute({ pattern: "hello", path: "." }, { projectRoot: root });

    assert.match(result.content[0].text, /src\/app.js:1:console.log\("hello"\)/);
    assert.equal(result.metadata.matches, 1);
  });

  test("glob tool supports recursive patterns", async () => {
    const root = await fixtureWorkspace();
    const result = await createGlobTool().execute({ pattern: "src/**/*.js" }, { projectRoot: root });

    assert.deepEqual(JSON.parse(result.content[0].text), ["src/app.js"]);
  });

  async function fixtureWorkspace() {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-tools-"));
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "README.md"), "# Demo", "utf8");
    await writeFile(path.join(root, "src", "app.js"), "console.log(\"hello\")\n", "utf8");
    return root;
  }
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/tools/builtin-process.test.js
// ---------------------------------------------------------------------------
describe("unit/tools/builtin-process", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { createShellTool } = await import("../../../src/tools/builtin/shell.js");
  const { createTestTool } = await import("../../../src/tools/builtin/test.js");
  const { createGitTool } = await import("../../../src/tools/builtin/git.js");
  const { runProcess } = await import("../../../src/security/shell-policy.js");
  const { mkdtemp } = await import("../../helpers/tmp.js");

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
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/tools/builtin-network-memory.test.js
// ---------------------------------------------------------------------------
describe("unit/tools/builtin-network-memory", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { mkdtemp } = await import("../../helpers/tmp.js");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { Readable } = await import("node:stream");
  const { createWebFetchTool, collectCappedBody, WEB_FETCH_MAX_BODY_BYTES } = await import("../../../src/tools/builtin/web-fetch.js");
  const { createMemoryTool } = await import("../../../src/tools/builtin/memory.js");
  const { createTaskTool } = await import("../../../src/tools/builtin/task.js");
  const { createAskUserTool } = await import("../../../src/tools/builtin/ask-user.js");
  const { createDeferredEditTools } = await import("../../../src/tools/builtin/edit-deferred.js");

  test("web_fetch validates URL and truncates response", async () => {
    const tool = createWebFetchTool({
      lookup: async () => ({ address: "93.184.216.34" }),
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: new Map([["content-type", "text/plain"]]),
        text: async () => "x".repeat(40000)
      })
    });

    const result = await tool.execute({ url: "https://example.com" }, {});

    assert.equal(result.content[0].text.length, 32000);
    assert.equal(result.metadata.original_length, 40000);
  });

  test("web_fetch gives network layer the prevalidated IP (no second DNS resolution)", async () => {
    let seen = null;
    const tool = createWebFetchTool({
      lookup: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "93.184.216.35", family: 4 }
      ],
      fetchImpl: async (url, options) => {
        seen = { url, options };
        return {
          ok: true,
          status: 200,
          headers: new Map(),
          text: async () => "ok"
        };
      }
    });

    await tool.execute({ url: "https://example.com/path" }, {});
    assert.equal(seen.url, "https://example.com/path");
    assert.equal(seen.options.validatedAddress, "93.184.216.34");
    assert.equal(seen.options.redirect, "manual");
  });

  test("web_fetch blocks localhost", async () => {
    const tool = createWebFetchTool();
    await assert.rejects(() => tool.execute({ url: "http://localhost:3000" }, {}), /blocked/i);
  });

  test("collectCappedBody stores at most WEB_FETCH_MAX_BODY_BYTES but reports full length", async () => {
    const payload = Buffer.alloc(WEB_FETCH_MAX_BODY_BYTES + 5000, 0x61); // 'a'
    const stream = Readable.from([payload.subarray(0, 10000), payload.subarray(10000)]);
    const { text, originalLength } = await collectCappedBody(stream, WEB_FETCH_MAX_BODY_BYTES);
    assert.equal(originalLength, WEB_FETCH_MAX_BODY_BYTES + 5000);
    assert.equal(text.length, WEB_FETCH_MAX_BODY_BYTES);
    assert.equal(text, "a".repeat(WEB_FETCH_MAX_BODY_BYTES));
  });

  test("web_fetch metadata preserves originalLength from network layer", async () => {
    const tool = createWebFetchTool({
      lookup: async () => ({ address: "93.184.216.34" }),
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: new Map([["content-type", "text/plain"]]),
        originalLength: 90000,
        text: async () => "y".repeat(WEB_FETCH_MAX_BODY_BYTES)
      })
    });
    const result = await tool.execute({ url: "https://example.com/big" }, {});
    assert.equal(result.content[0].text.length, WEB_FETCH_MAX_BODY_BYTES);
    assert.equal(result.metadata.original_length, 90000);
  });

  test("memory tool maps categories by action and persists project memory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-proj-"));
    const memoryRoot = await mkdtemp(path.join(tmpdir(), "dsc-memory-"));
    const tool = createMemoryTool();

    assert.equal(tool.resolveCategory({ action: "write" }), "write_update");
    assert.equal(tool.resolveCategory({ action: "delete" }), "write_delete");

    await tool.execute({ action: "write", key: "style", value: "Use ESM" }, { projectRoot: root, memoryRoot });
    const read = await tool.execute({ action: "read", key: "style" }, { projectRoot: root, memoryRoot });

    assert.equal(read.content[0].text, "Use ESM");
  });

  test("task tool validates tools strictly and rejects unconfigured delegation instead of faking queued success", async () => {
    const tool = createTaskTool();

    const overLimit = await tool.execute({
      prompt: "inspect files",
      tools: ["read", "grep", "glob", "ls", "git", "shell"]
    }, {});
    assert.equal(overLimit.status, "error");
    assert.equal(overLimit.metadata.code, "TASK_TOOLS_LIMIT_EXCEEDED");

    const forbidden = await tool.execute({
      prompt: "recurse",
      tools: ["read", "task"]
    }, {});
    assert.equal(forbidden.status, "error");
    assert.equal(forbidden.metadata.code, "TASK_FORBIDDEN_TOOL");

    const unconfigured = await tool.execute({
      prompt: "inspect files",
      tools: ["read", "grep", "read"]
    }, {});
    assert.equal(unconfigured.status, "error");
    assert.equal(unconfigured.metadata.code, "TASK_DELEGATION_UNAVAILABLE");
  });

  test("ask_user creates an approval-style pending result", async () => {
    const result = await createAskUserTool().execute({ question: "Which file?" }, {});
    assert.equal(result.status, "awaiting_user");
    assert.equal(result.content[0].text, "Which file?");
  });

  test("deferred edit tools dispatch to configured editService", async () => {
    const calls = [];
    const editService = {
      preview: async (params) => {
        calls.push(["preview", params]);
        return { content: [{ type: "text", text: "previewed" }], metadata: { ok: true } };
      },
      apply: async (params) => {
        calls.push(["apply", params]);
        return { content: [{ type: "text", text: "applied" }], metadata: { ok: true } };
      },
      rollback: async (params) => {
        calls.push(["rollback", params]);
        return { content: [{ type: "text", text: "rolled back" }], metadata: { ok: true } };
      }
    };

    const [preview, apply, rollback, edit] = createDeferredEditTools({ editService });
    assert.equal((await preview.execute({ diff: "d" }, {})).content[0].text, "previewed");
    assert.equal((await apply.execute({ diff: "d", prompt: "p", approval_id: "a" }, {})).content[0].text, "applied");
    assert.equal((await rollback.execute({ change_id: "c" }, {})).content[0].text, "rolled back");
    assert.equal((await edit.execute({ diff: "d", prompt: "p" }, {})).content[0].text, "applied");

    assert.deepEqual(calls.map(([name]) => name), ["preview", "apply", "rollback", "apply"]);
  });

  test("deferred edit tools fail clearly without editService", async () => {
    const [preview] = createDeferredEditTools();
    await assert.rejects(
      () => preview.execute({ diff: "--- a\n" }, {}),
      /Edit service is not configured/
    );
  });
});
