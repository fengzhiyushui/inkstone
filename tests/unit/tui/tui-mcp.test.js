import test from "node:test";
import assert from "node:assert/strict";
import { createTuiApp } from "../../../src/apps/tui/tui-app.js";
import { parseMcpArgs } from "../../../src/apps/tui/mcp-actions.js";
import { eventToLines } from "../../../src/apps/tui/event-cards.js";
import { makeT } from "../../../src/apps/tui/tui-i18n.js";
import { makeIO, makeFakeKernel, until, tmpRoot } from "./helpers.js";

async function boot(mcp = {}, overrides = {}) {
  const io = makeIO();
  let sends = 0, interrupts = 0;
  const kernel = makeFakeKernel({ onSend: async () => { sends++; return { status: "complete", content: "model reply" }; }, onInterrupt: () => interrupts++ });
  kernel.config = { apiKey: "test-configured-secret" };
  kernel.mcp = { hub: { oauthSecrets: new Set(["rotated-oauth-secret"]) }, ...mcp };
  const app = createTuiApp({ root: await tmpRoot(), kernel, input: io.input, output: io.output, ...overrides });
  const done = app.run();
  await until(() => io.text().includes("❯"));
  const stop = async () => { io.input.write("\x03"); io.input.write("\x03"); await done; };
  return { io, kernel, done, stop, sends: () => sends, interrupts: () => interrupts };
}

test("MCP slash parsing validates verbs, arity, ids and log bounds", () => {
  assert.deepEqual(parseMcpArgs(""), { action: "list" });
  assert.deepEqual(parseMcpArgs("logs"), { action: "logs", serverId: null, limit: 50 });
  assert.deepEqual(parseMcpArgs("logs removed-server 500"), { action: "logs", serverId: "removed-server", limit: 500 });
  for (const arg of ["list extra", "restart", "restart srv extra", "disable", "enable srv extra", "delete srv", "logs srv 501", "logs srv 0", "logs srv 1.5", "logs srv 1e2", "logs srv 3 extra", "restart x/y"]) assert.equal(parseMcpArgs(arg).action, "invalid", arg);
});

test("/mcp lists all server states without invoking a model or connecting", async () => {
  let lists = 0;
  const f = await boot({ listServers: async () => { lists++; return [
    { serverId: "local", status: "CONNECTED", type: "stdio", protocolMode: "modern", toolCount: 3 },
    { serverId: "remote", status: "AUTH_REQUIRED", type: "streamable-http", toolCount: 0 },
    { serverId: "disabled", status: "DISABLED", toolCount: 0 },
    { serverId: "degraded", status: "DEGRADED", toolCount: 0 }
  ]; } });
  try {
    f.io.input.write("/mcp\r");
    await until(() => f.io.text().includes("AUTH_REQUIRED"));
    assert.match(f.io.text(), /CONNECTED.*stdio.*modern.*3/);
    assert.match(f.io.text(), /DISABLED/);
    assert.match(f.io.text(), /DEGRADED/);
    assert.equal(lists, 1);
    assert.equal(f.sends(), 0);
  } finally { await f.stop(); }
});

test("/mcp restarts and toggles through facade; histories accept removed servers", async () => {
  const calls = [];
  const f = await boot({
    restartServer: async (id) => { calls.push(["restart", id]); return { status: "CONNECTED" }; },
    toggleServer: async (id, enabled) => { calls.push(["toggle", id, enabled]); return { status: enabled ? "CONNECTED" : "DISABLED" }; },
    getLogs: async (id, options) => { calls.push(["logs", id, options]); return { entries: [{ serverId: id, message: "historical test-configured-secret rotated-oauth-secret" }], total: 8, truncated: true }; }
  });
  try {
    for (const [command, count] of [["restart srv", 1], ["disable srv", 2], ["enable srv", 3], ["logs removed 10", 4]]) {
      f.io.input.write(`/mcp ${command}\r`);
      await until(() => calls.length === count);
      await new Promise((resolve) => setImmediate(resolve));
    }
    await until(() => f.io.text().includes("historical"));
    assert.deepEqual(calls, [["restart", "srv"], ["toggle", "srv", false], ["toggle", "srv", true], ["logs", "removed", { limit: 10 }]]);
    assert.match(f.io.text(), /1 \/ 8.*已截断/);
    assert.doesNotMatch(f.io.text(), /test-configured-secret|rotated-oauth-secret/);
    assert.equal(f.sends(), 0);
  } finally { await f.stop(); }
});

test("/mcp errors, empty results and unavailable interfaces remain local and recover", async () => {
  const f = await boot({ listServers: async () => [], getLogs: async () => ({ entries: [] }), restartServer: async () => { throw new Error("test-configured-secret rotated-oauth-secret"); } });
  try {
    for (const [command, message] of [["list", "未配置 MCP 服务"], ["logs", "没有匹配的 MCP 历史日志"], ["restart srv", "REDACTED"], ["enable srv", "MCP 接口不可用"], ["restart", "用法:/mcp"]]) {
      f.io.input.write(`/mcp ${command}\r`);
      await until(() => f.io.text().includes(message));
    }
    assert.doesNotMatch(f.io.text(), /test-configured-secret|rotated-oauth-secret/);
    assert.equal(f.sends(), 0);
  } finally { await f.stop(); }
});

test("MCP busy state prevents concurrent model sends and Esc does not claim cancellation", async () => {
  let finish;
  const f = await boot({ restartServer: async () => {
    await new Promise((resolve) => { finish = resolve; });
    return { status: "CONNECTED" };
  } });
  try {
    f.io.input.write("/mcp restart srv\r");
    await until(() => finish);
    f.io.input.write("not sent\r");
    assert.equal(f.sends(), 0);
    f.io.input.write("\x1b");
    await until(() => f.io.text().includes("MCP 管理操作正在完成"));
    assert.equal(f.interrupts(), 0);
    finish();
    await until(() => f.io.text().includes("srv: CONNECTED"));
    f.io.input.write("\r");
    await until(() => f.sends() === 1);
  } finally { await f.stop(); }
});

test("MCP session events display safe states and errors without terminal controls", async () => {
  const f = await boot();
  try {
    f.kernel.emit({ type: "mcp:server_error", serverId: "remote", error: { message: "failed test-configured-secret rotated-oauth-secret\x1b]0;owned\x07" } });
    await until(() => f.io.text().includes("failed"));
    assert.match(f.io.text(), /remote.*REDACTED/);
    assert.doesNotMatch(f.io.text(), /test-configured-secret|rotated-oauth-secret|\x1b\]0;owned|\x07/);
    const lines = eventToLines({ type: "mcp:auth_required", serverId: "remote", status: "AUTH_REQUIRED" }, makeT("en"));
    assert.match(lines.join("\n"), /remote.*AUTH_REQUIRED/);
    assert.deepEqual(eventToLines({ type: "mcp:server_status", serverId: "remote", status: "CONNECTED" }, makeT("en")), []);
  } finally { await f.stop(); }
});
