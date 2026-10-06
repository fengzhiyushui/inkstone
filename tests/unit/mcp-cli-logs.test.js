import test from "node:test";
import assert from "node:assert/strict";
import { runCli, runMcp } from "../../src/cli.js";
import { cleanMcpLogResult } from "../../src/apps/cli/mcp-logs.js";
import { createMcpDisplayRedactor } from "../../src/security/mcp-content.js";
import { createMcpDiagnostics } from "../../src/tools/mcp/diagnostics.js";
import { mkdtemp } from "../helpers/tmp.js";
import { mkdir, writeFile, access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

function fixture() {
  const calls = [], output = [];
  const config = { apiKey: "test-configured-secret", mcpServers: { remote: { url: "https://mcp.example" } } };
  const mcp = {
    hub: { oauthSecrets: new Set(["rotated-oauth-secret"]) },
    getLogs: async (id, options) => {
      calls.push(["logs", id, options]);
      return { entries: [{ timestamp: "2026-10-06T00:00:00Z", serverId: "remote", level: "info", category: "protocol", method: "tools/call", requestId: "q1", durationMs: 12, status: "ok", message: "test-configured-secret rotated-oauth-secret" }], total: 4, truncated: true };
    },
    restartServer: () => { throw new Error("Must not connect"); },
    listServers: () => { throw new Error("History does not depend on current config"); }
  };
  const deps = {
    write: (value) => output.push(value),
    loadConfigImpl: async (_root, options) => { calls.push(["load", options]); return config; },
    buildKernelOptionsImpl: async () => ({ sentinel: true, autoInitMcp: true }),
    createKernelImpl: async (_root, options) => {
      calls.push(["kernel", options]);
      assert.equal(options.autoInitMcp, false);
      assert.equal(options.sentinel, true);
      return { mcp, dispose: async () => calls.push(["dispose"]) };
    }
  };
  return { calls, output, deps, mcp };
}

test("CLI logs reads history without connecting and redacts both configured and rotated secrets", async () => {
  const f = fixture();
  await runCli(["mcp", "logs", "remote", "--limit", "25", "--level", "info", "--category", "protocol", "--method", "tools/call", "--search", "ok"], { root: "/repo", mcp: f.deps });
  assert.deepEqual(f.calls.find(([kind]) => kind === "logs"), ["logs", "remote", { limit: 25, level: "info", category: "protocol", method: "tools/call", search: "ok" }]);
  assert.deepEqual(f.calls.at(-1), ["dispose"]);
  assert.match(f.output.join("\n"), /1 \/ 4.*已截断/);
  assert.match(f.output.join("\n"), /tools\/call.*#q1.*12ms.*REDACTED/);
  assert.doesNotMatch(f.output.join("\n"), /test-configured-secret|rotated-oauth-secret/);
});

test("CLI logs supports JSON before server positional arg and removed servers", async () => {
  const f = fixture();
  await runCli(["mcp", "logs", "--json", "removed-server"], { root: "/repo", mcp: f.deps });
  assert.deepEqual(f.calls.find(([kind]) => kind === "logs"), ["logs", "removed-server", { limit: 50 }]);
  const result = JSON.parse(f.output.join("\n"));
  assert.equal(result.entries.length, 1);
  assert.equal(result.truncated, true);
});

test("CLI logs gives clear empty history and no-server defaults", async () => {
  const f = fixture();
  f.mcp.getLogs = async (id, options) => { assert.equal(id, null); assert.deepEqual(options, { limit: 50 }); return { entries: [], total: 0, truncated: false }; };
  await runMcp("/repo", ["logs"], new Map(), f.deps);
  assert.match(f.output.join("\n"), /没有匹配的 MCP 历史日志/);
});

test("CLI logs rejects malformed arguments before reading config or creating kernel", async () => {
  const f = fixture();
  for (const args of [
    ["logs", "bad id"], ["logs", "remote", "extra"], ["logs", "--limit"],
    ["logs", "--limit", "0"], ["logs", "--limit", "501"], ["logs", "--limit", "1.2"], ["logs", "--limit", "1e2"],
    ["logs", "--limit", "2", "--limit", "3"], ["logs", "--level", "banana"], ["logs", "--category"],
    ["logs", "--category", "banana"], ["logs", "--method", ""], ["logs", "--search", "\x1b[31m"], ["logs", "--json=bogus"], ["logs", "--typo"]
  ]) await assert.rejects(() => runCli(["mcp", ...args], { root: "/repo", mcp: f.deps }), `accepted ${JSON.stringify(args)}`);
  assert.equal(f.calls.length, 0);
});

test("CLI logs disposes after safe read failure and sanitizes terminal controls", async () => {
  const f = fixture();
  f.mcp.getLogs = async () => { throw new Error("test-configured-secret rotated-oauth-secret"); };
  await assert.rejects(() => runMcp("/repo", ["logs"], new Map(), f.deps), (error) => /REDACTED/.test(error.message) && !/test-configured-secret|rotated-oauth-secret/.test(error.message));
  assert.deepEqual(f.calls.at(-1), ["dispose"]);
  f.mcp.getLogs = async () => ({ entries: [{ serverId: "remote", message: "\x1b]0;owned\x07\r\nhello" }], total: 1, truncated: false });
  await runMcp("/repo", ["logs"], new Map(), f.deps);
  assert.doesNotMatch(f.output.join(""), /[\x1b\x07\r]/);
});

test("CLI log envelopes survive short configured secrets and surface storage failures", async () => {
  const safe = cleanMcpLogResult({ entries: [{ message: "e", serverId: "remote" }], total: 1, truncated: false, storageError: "e" }, createMcpDisplayRedactor({ config: { apiKey: "e" } }));
  assert.deepEqual(Object.keys(safe), ["entries", "total", "truncated", "storageError"]);
  assert.equal(safe.entries[0].message, "[REDACTED]");
  const f = fixture();
  f.mcp.getLogs = async () => ({ entries: [], total: 0, storageError: "could not read history" });
  await runMcp("/repo", ["logs"], new Map(), f.deps);
  assert.match(f.output.join("\n"), /日志存储错误.*could not read history/);
});

test("fresh CLI process reads persisted history without starting a configured stdio server", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-cli-log-history-"));
  const userDir = await mkdtemp(path.join(os.tmpdir(), "mcp-cli-log-home-"));
  const marker = path.join(root, "server-started");
  await mkdir(path.join(root, ".deepseek-code"), { recursive: true });
  await writeFile(path.join(root, ".deepseek-code", "config.json"), JSON.stringify({
    mcpServers: { trap: { command: process.execPath, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`] } }
  }));
  const diagnostics = createMcpDiagnostics({ root });
  diagnostics.record({ serverId: "removed-server", level: "warn", category: "timeout", message: "past timeout", method: "tools/call" });
  diagnostics.flush();
  const cliUrl = new URL("../../src/cli.js", import.meta.url).href;
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `import { runCli } from ${JSON.stringify(cliUrl)}; await runCli(['mcp','logs','removed-server','--json'], {root:process.argv[1]});`, root], {
    env: { ...process.env, DEEPSEEK_CODE_HOME: userDir }, timeout: 15000
  });
  assert.equal(stderr, "");
  const result = JSON.parse(stdout);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].message, "past timeout");
  await assert.rejects(() => access(marker));
});
