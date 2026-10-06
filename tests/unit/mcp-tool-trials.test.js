import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createMcpToolTrials } from "../../src/tools/mcp/tool-trials.js";
import { createToolRegistry } from "../../src/tools/registry.js";
import { createPermissionEngine } from "../../src/tools/permissions/permission-engine.js";

function fixture(t, { category = "read", connect = async () => {}, execute = async () => ({ content: [] }) } = {}) {
  const hub = new EventEmitter();
  const client = {};
  const config = { tools: { enabled: ["*"], disabled: [] }, env: { API_TOKEN: "private-trial-key" } };
  hub.serverConfigs = new Map([["server", config]]);
  hub.getServer = () => client;
  hub._connectedClient = connect;
  let calls = 0;
  const def = { name: "mcp__server__sample", originalName: "sample", description: "Sample tool", source: "mcp",
    serverId: "server", category, risk_level: "low", side_effect: "none", inputSchema: { type: "object" },
    execute: async (params, context) => { calls++; return execute(params, context); } };
  const registry = createToolRegistry({ tools: [def] });
  hub.serverTools = new Map([["server", [registry.resolve(def.name)]]]);
  const trials = createMcpToolTrials({ hub, registry, permissionEngine: createPermissionEngine() });
  t.after(() => trials.dispose());
  return { trials, hub, config, calls: () => calls };
}

test("trial argument clone does not execute non-enumerable toJSON accessors", async (t) => {
  let getterCalls = 0, captured;
  const { trials } = fixture(t, { execute: async (params) => { captured = params; return { content: [] }; } });
  const params = { text: "original" };
  Object.defineProperty(params, "toJSON", { get() { getterCalls++; return () => ({ text: "changed" }); } });
  assert.equal((await trials.start("server", "sample", params)).status, "success");
  assert.equal(getterCalls, 0);
  assert.deepEqual(captured, { text: "original" });
});

test("trial 64 KiB argument limit counts UTF-8 bytes before connecting or executing", async (t) => {
  let connections = 0;
  const { trials, calls } = fixture(t, { connect: async () => { connections++; } });
  const result = await trials.start("server", "sample", { text: "中".repeat(23_000) });
  assert.equal(result.status, "error");
  assert.match(result.content[0].text, /64 KiB/);
  assert.equal(connections, 0);
  assert.equal(calls(), 0);
});

test("trial output and metadata are bounded by UTF-8 bytes after redaction", async (t) => {
  const { trials } = fixture(t, { execute: async () => ({
    content: [{ type: "text", text: ('中😀"\\private-trial-key').repeat(10_000) }],
    metadata: { huge: "中".repeat(25_000) }
  }) });
  const result = await trials.start("server", "sample", {});
  assert.equal(result.status, "success");
  assert.equal(result.metadata.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result.content), "utf8") <= 64 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(result.metadata), "utf8") <= 64 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= 64 * 1024);
  assert.ok(!JSON.stringify(result).includes("private-trial-key"));
  assert.ok(!result.content[0].text.includes("\ufffd"));
});

test("pending approval rechecks tool disable and in-place server configuration changes", async (t) => {
  for (const change of [config => config.tools.disabled.push("sample"), config => { config.url = "https://new.example/mcp"; }]) {
    const { trials, config, calls } = fixture(t, { category: "mutate" });
    const pending = await trials.start("server", "sample", {});
    assert.equal(pending.status, "approval_required");
    change(config);
    const result = await trials.approve(pending.runId);
    assert.equal(result.status, "error");
    assert.equal(calls(), 0);
    assert.throws(() => trials.approve(pending.runId), /No pending/);
  }
});

test("early cancellation and server removal during connection prevent late execution and duplicate final events", async (t) => {
  for (const lifecycle of [false, true]) {
    let release;
    const connecting = new Promise((resolve) => { release = resolve; });
    const { trials, hub, calls } = fixture(t, { connect: () => connecting });
    const events = [];
    hub.on("tool_test", (event) => events.push(event));
    const result = trials.start("server", "sample", { text: "private-trial-key" }, { requestId: "early" });
    if (lifecycle) hub.emit("server_removed", { serverId: "server" });
    else assert.equal(trials.cancel("early").cancelled, true);
    release();
    const final = await result;
    assert.equal(final.status, "cancelled");
    assert.equal(calls(), 0);
    assert.equal(events.length, 1);
    assert.ok(!JSON.stringify(final).includes("private-trial-key"));
    assert.throws(() => trials.start("server", "sample", {}, { requestId: "early" }), /duplicate/);
  }
});

test("server configuration mutation during connection is rejected before tool dispatch", async (t) => {
  let release;
  const connected = new Promise((resolve) => { release = resolve; });
  const { trials, config, calls } = fixture(t, { connect: () => connected });
  const pending = trials.start("server", "sample", {});
  config.env.API_TOKEN = "replacement-token";
  release();
  assert.equal((await pending).status, "error");
  assert.equal(calls(), 0);
});
