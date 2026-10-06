import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { checkedDiagnosticLogs, checkedDiagnosticTools, createToolTestController, includeMcpActivity, schemaFields, toolParameters } from "../../../gui/src/state/mcp-diagnostics.js";
import { deriveAgentCards } from "../../../gui/src/state/agent-cards.js";
import { translate } from "../../../gui/src/i18n/strings.js";

const require = createRequire(import.meta.url);
const { createKernelHost } = require("../../../gui/kernel-host.js");
const { diagnosticOptions, saveDiagnosticExport } = require("../../../gui/mcp-diagnostics.js");
const read = (file) => readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8");
const runId = "680340fd-49c1-45d0-985b-d7a9803c399e";
async function hostFor(mcp, configLoader = async () => ({ apiKey: "private-api-value" })) {
  const host = createKernelHost({ projectRoot: "/repo", configLoader,
    kernelFactory: async () => ({ mcp, session: { subscribe: () => ({ unsubscribe() {} }) } }) });
  await host.init();
  return host;
}

test("diagnostics host caps filters and redacts logs, exports and tool results at the IPC boundary", async () => {
  const calls = [];
  const raw = { entries: [{ message: "private-api-value private-input-value", preview: { access_token: "token-value" } }], total: 1, truncated: false };
  const mcp = { hub: { inputs: { key: { value: "private-input-value" } } },
    getLogs: (id, options) => { calls.push([id, options]); return raw; }, exportLogs: () => JSON.stringify(raw),
    listTools: () => [{ name: "mcp__srv__read", inputSchema: { type: "object" } }],
    startToolTest: (...args) => { calls.push(args); return { runId, status: "success", content: "private-api-value call-secret" }; } };
  const host = await hostFor(mcp);
  const logs = await host.getMcpLogs("srv", { limit: 99999, search: " abc ", filePath: "C:/bad" });
  assert.deepEqual(calls[0], ["srv", { limit: 500, search: "abc" }]);
  assert.doesNotMatch(JSON.stringify(logs), /private-api-value|private-input-value|token-value/);
  assert.doesNotMatch(await host.exportMcpLogs("srv"), /private-api-value|private-input-value|token-value/);
  assert.equal((await host.listMcpTools("srv"))[0].name, "mcp__srv__read");
  const result = await host.startMcpToolTest("srv", "mcp__srv__read", { password: "call-secret" }, { requestId: runId, approval: true });
  assert.doesNotMatch(result.content, /private-api-value|call-secret/);
  assert.deepEqual(calls.at(-1), ["srv", "mcp__srv__read", { password: "call-secret" }, { requestId: runId }]);
  assert.throws(() => host.startMcpToolTest("srv", "read", [], { requestId: runId }), /object/);
  assert.throws(() => host.startMcpToolTest("srv", "read", {}, { requestId: "../bad" }), /request ID/);
  mcp.exportLogs = () => "not JSON private-api-value";
  await assert.rejects(host.exportMcpLogs("srv"), (error) => !error.message.includes("private-api-value"));
});

test("main export uses only the native dialog path, and cancellation writes nothing", async () => {
  const writes = [];
  let dialogOptions;
  const deps = { host: { exportMcpLogs: async () => '{"redacted":true}' }, serverId: "srv", options: { filePath: "C:/injected" },
    showSaveDialog: async (settings) => { dialogOptions = settings; return { canceled: false, filePath: "C:/chosen.json" }; },
    writeFile: async (...args) => writes.push(args) };
  assert.deepEqual(await saveDiagnosticExport(deps), { canceled: false, saved: true });
  assert.equal(dialogOptions.defaultPath, "mcp-diagnostics.json");
  assert.equal(writes[0][0], "C:/chosen.json");
  assert.equal(writes[0][1], '{"redacted":true}');
  deps.showSaveDialog = async () => ({ canceled: true });
  assert.deepEqual(await saveDiagnosticExport(deps), { canceled: true });
  assert.equal(writes.length, 1);
  assert.deepEqual(diagnosticOptions(null), { limit: 100 });
});

test("host cancellation waits for pending startup configuration but not for the tool result", async () => {
  const order = [];
  let releaseConfig;
  let finish;
  let delayConfig = false;
  const host = await hostFor({ startToolTest: () => { order.push("start"); return new Promise((resolve) => { finish = resolve; }); },
    cancelToolTest: (id) => { order.push("cancel"); assert.equal(id, runId); finish({ status: "cancelled", runId }); return { cancelled: true }; } },
  async () => { if (delayConfig) { delayConfig = false; await new Promise((resolve) => { releaseConfig = resolve; }); } return {}; });
  delayConfig = true;
  const start = host.startMcpToolTest("srv", "mcp__srv__read", {}, { requestId: runId });
  const cancel = host.cancelMcpToolTest(runId);
  assert.deepEqual(order, []);
  releaseConfig();
  await Promise.all([start, cancel]);
  assert.deepEqual(order, ["start", "cancel"]);
});

test("diagnostics IPC methods are allowlisted and export does not accept an output path", async () => {
  let bridge;
  const calls = [];
  vm.runInNewContext(read("gui/preload.js"), { require: () => ({ contextBridge: { exposeInMainWorld: (_name, api) => { bridge = api; } },
    ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve({}); } } }) });
  const main = read("gui/main.js");
  for (const [method, channel] of Object.entries({ getMcpLogs: "mcp:logs", exportMcpLogs: "mcp:logs-export", listMcpTools: "mcp:tools-list",
    startMcpToolTest: "mcp:tool-test", approveMcpToolTest: "mcp:tool-test-approve", cancelMcpToolTest: "mcp:tool-test-cancel" })) {
    await bridge[method]("srv", {}, "C:/injected");
    assert.equal(calls.at(-1)[0], channel);
    assert.ok(main.includes(`handle("${channel}"`));
    assert.ok(main.slice(0, main.indexOf("function cleanupSmoke")).includes(`"${channel}"`));
    assert.ok(read("gui/src/hooks/useKernel.js").includes(`${method}:`));
  }
  await bridge.exportMcpLogs("srv", {}, "C:/injected");
  assert.equal(calls.at(-1).length, 3);
  await bridge.approveMcpToolTest(runId, { changed: true });
  assert.deepEqual(calls.at(-1), ["mcp:tool-test-approve", runId]);
});

test("schema tool form converts booleans, enums, numbers and nested JSON while rejecting invalid object input", () => {
  const schema = { type: "object", required: ["name", "enabled"], properties: {
    name: { type: "string" }, enabled: { type: "boolean" }, count: { type: "integer" },
    mode: { type: "string", enum: ["fast", "safe"] }, options: { type: "object" } } };
  assert.equal(schemaFields(schema).length, 5);
  assert.deepEqual(toolParameters(schema, { name: "demo", enabled: "false", count: "3", mode: '"safe"', options: '{"depth":2}' }),
    { name: "demo", enabled: false, count: 3, mode: "safe", options: { depth: 2 } });
  for (const raw of ["[]", "null", "7"]) assert.throws(() => toolParameters(schema, {}, raw), /object/);
  assert.throws(() => toolParameters(schema, {}, "{"), /json/);
  assert.throws(() => toolParameters(schema, { name: "demo" }), /required: enabled/);
  assert.throws(() => toolParameters(schema, {}, '{"name":"demo","enabled":"false"}'), /type: enabled/);
  assert.throws(() => toolParameters(schema, { name: "demo", enabled: "true", count: "1.5" }), /type: count/);
  assert.equal(schemaFields({ $ref: "#/$defs/test" }), null);
  const unsafe = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"object"}}}');
  const result = toolParameters(unsafe, JSON.parse('{"__proto__":"{\\"polluted\\":true}"}'));
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.deepEqual(result.__proto__, { polluted: true });
});

test("tool runner executes once, requires explicit approval and never retries a failed call", async () => {
  const calls = [];
  let state;
  const controller = createToolTestController({ serverId: "srv", makeId: () => runId, onState: (value) => { state = value; }, kernel: {
    startMcpToolTest: async (...args) => { calls.push(["start", ...args]); return { status: "approval_required", runId }; },
    approveMcpToolTest: async (...args) => { calls.push(["approve", ...args]); return { status: "error", runId, content: "denied" }; }
  } });
  await Promise.all([controller.start("write", { value: 1 }), controller.start("write", { value: 2 })]);
  assert.equal(state.status, "approval_required");
  assert.equal(calls.length, 1);
  await controller.start("write", { value: 3 });
  assert.equal(calls.length, 1);
  await Promise.all([controller.approve(), controller.approve()]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], ["approve", runId]);
  assert.equal(state.status, "error");
  controller.dispose();
});

test("tool runner cancels in flight and discards late completion and unmounted updates", async () => {
  let finish;
  const states = [];
  const cancellations = [];
  const controller = createToolTestController({ serverId: "srv", makeId: () => runId, onState: (value) => states.push(value), kernel: {
    startMcpToolTest: () => new Promise((resolve) => { finish = resolve; }),
    cancelMcpToolTest: async (id) => { cancellations.push(id); return { cancelled: true }; }
  } });
  const pending = controller.start("read", {});
  await controller.cancel();
  assert.equal(states.at(-1).status, "cancelled");
  finish({ status: "success", content: "late" });
  await pending;
  assert.equal(states.at(-1).status, "cancelled");
  const another = controller.start("read", {});
  const count = states.length;
  controller.dispose();
  finish({ status: "success" });
  await another;
  assert.equal(states.length, count);
  assert.equal(cancellations.length, 2);
});

test("diagnostics rejects malformed tools, renders log payloads as data and translates controls", () => {
  for (const value of [null, {}, [null], [{ name: "read", description: {} }], [{ name: "read", inputSchema: [] }]]) {
    assert.throws(() => checkedDiagnosticTools(value), /response/);
  }
  assert.deepEqual(checkedDiagnosticTools([]), []);
  assert.throws(() => checkedDiagnosticLogs({ entries: [null] }), /response/);
  assert.equal(checkedDiagnosticLogs({ entries: [{ preview: { text: "safe" } }] }).entries[0].preview, '{"text":"safe"}');
  const source = read("gui/src/components/v4/McpDiagnostics.jsx");
  assert.doesNotMatch(source, /dangerouslySetInnerHTML|\bfetch\s*\(|setInterval/);
  for (const lang of ["zh", "en"]) for (const key of ["title", "logs", "test", "invalidArguments", "confirmHint", "run", "export", "status.cancelled"]) {
    assert.notEqual(translate(lang, `mcp.diagnostics.${key}`), `mcp.diagnostics.${key}`);
  }
});

test("short secrets preserve IPC envelope, tool identifiers and schema contract while redacting freeform values", async () => {
  const schema = { type: "object", required: ["id"], properties: { id: { type: "string", description: "sensitive i s" } } };
  const host = await hostFor({ hub: { oauthSecrets: new Set(["s", "i"]) },
    getLogs: () => ({ entries: [{ status: "success", direction: "in", message: "s i" }], total: 1, truncated: false }),
    listTools: () => [{ name: "mcp__srv__inspect", originalName: "inspect", inputSchema: schema }, { name: "mcp__srv__any", inputSchema: true }],
    startToolTest: () => ({ runId, status: "success", content: [{ type: "text", text: "s i" }], metadata: { durationMs: 12 } }) });
  const logs = await host.getMcpLogs("srv");
  assert.equal(logs.entries[0].status, "success");
  assert.equal(logs.entries[0].direction, "in");
  assert.match(logs.entries[0].message, /REDACTED/);
  const tools = checkedDiagnosticTools(await host.listMcpTools("srv"));
  assert.equal(tools[0].name, "mcp__srv__inspect");
  assert.equal(tools[0].inputSchema.type, "object");
  assert.deepEqual(tools[0].inputSchema.required, ["id"]);
  assert.equal(tools[0].inputSchema.properties.id.type, "string");
  assert.match(tools[0].inputSchema.properties.id.description, /REDACTED/);
  assert.equal(tools[1].inputSchema, true);
  const result = await host.startMcpToolTest("srv", tools[0].name, { id: "42" }, { requestId: runId });
  assert.equal(result.status, "success");
  assert.equal(result.runId, runId);
  assert.equal(result.metadata.durationMs, 12);
  const deniedHost = await hostFor({ hub: { oauthSecrets: new Set(["i"]) },
    startToolTest: () => ({ runId, status: "denied", content: "Permission denied" }) });
  assert.equal((await deniedHost.startMcpToolTest("srv", "write", {}, { requestId: runId })).status, "denied");
});

test("GUI displays common MCP event fields and keeps quiet traffic out of the activity window", () => {
  const quiet = { type: "mcp:log", entry: { level: "debug", direction: "out", method: "tools/call" } };
  const visible = { type: "mcp:log", serverId: "srv", entry: { level: "error", category: "timeout", status: "error", method: "tools/call", requestId: 7, durationMs: 18, direction: "in", message: "timeout" } };
  assert.equal(includeMcpActivity(quiet), false);
  assert.equal(includeMcpActivity(visible), true);
  assert.equal(includeMcpActivity({ type: "model:response" }), true);
  const cards = deriveAgentCards([quiet, visible]);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].kind, "mcp");
  assert.equal(cards[0].severity, "danger");
  assert.equal(cards[0].serverId, "srv");
  assert.equal(cards[0].method, "tools/call");
  assert.equal(cards[0].requestId, 7);
  assert.equal(cards[0].durationMs, 18);
  assert.equal(cards[0].direction, "in");
});
