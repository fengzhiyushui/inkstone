import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createMcpDiagnostics, diagnosticCategory, summarizeFrame, safeMcpEvent, MCP_HUB_EVENTS } from "../../src/tools/mcp/diagnostics.js";
import { McpHub } from "../../src/tools/mcp/mcp-hub.js";
import { createMcpDisplayRedactor } from "../../src/security/mcp-content.js";
import { toToolExecutionResult } from "../../src/tools/mcp/schema-converter.js";
import { mkdtempSync } from "../helpers/tmp.js";

function workspace(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "inkstone-mcp-diagnostics-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const directoryFor = (root) => path.join(root, ".deepseek-code", "mcp-logs");

test("boolean form echoes are scrubbed from external content while framework flags remain boolean", () => {
  const hub = { inputSecrets: new Set(["true", "false"]) };
  const result = toToolExecutionResult({
    resultType: "complete", isError: false,
    content: [{ type: "text", text: '{"answer":true,"other":false}' }],
    structuredContent: { answer: true, other: false }
  }, {
    outputSchema: { type: "object", properties: { answer: { type: "boolean" }, other: { type: "boolean" } } },
    redact: createMcpDisplayRedactor({ hub })
  });
  assert.deepEqual(result.metadata.structuredContent, { answer: "[REDACTED]", other: "[REDACTED]" });
  assert.equal(result.metadata.isError, false);
  assert.equal(result.metadata.outputValidation.valid, true);
  assert.doesNotMatch(result.content[0].text, /true|false/);
});

test("short form answers cannot corrupt the local input lifecycle identifier or subscription status", () => {
  const requestId = randomUUID();
  const hub = { inputSecrets: new Set(["a", "1"]) };
  const resolved = safeMcpEvent({ requestId, serverId: "server", method: "elicitation/create", status: "accepted" }, hub);
  assert.equal(resolved.requestId, requestId);
  assert.equal(resolved.status, "accepted");
  assert.equal(safeMcpEvent({ status: "active" }, hub).status, "active");
  assert.notEqual(safeMcpEvent({ requestId: "external-a-1", method: "tools/call" }, hub).requestId, "external-a-1");
});
function saveFixture(root, content, stamp = Date.now()) {
  const directory = directoryFor(root);
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, `${stamp}-${randomUUID()}.json`);
  fs.writeFileSync(target, typeof content === "string" ? content : JSON.stringify(content));
  return target;
}

test("diagnostic history reads do not create files or connect configured MCP servers", async (t) => {
  const root = workspace(t);
  const hub = new McpHub({ projectRoot: root, config: { mcpServers: { remote: { command: "never-spawn-this-command" } } } });
  t.after(() => hub.stopAll());
  let events = 0;
  hub.on("log", () => events++);
  hub.initAll = () => assert.fail("log reads must not initialize servers");
  hub._createClient = () => assert.fail("log reads must not create clients");
  assert.deepEqual(hub.getLogs(), { entries: [], total: 0, truncated: false });
  assert.deepEqual(JSON.parse(hub.exportLogs("remote")), { entries: [], total: 0, truncated: false });
  assert.equal(fs.existsSync(path.join(root, ".deepseek-code")), false);
  assert.equal(hub.clients.size, 0);
  assert.equal(events, 0);
});

test("diagnostic ring bounds records and bytes, filters recent entries and survives fresh instances", (t) => {
  const root = workspace(t);
  const store = createMcpDiagnostics({ root, maxEntries: 3 });
  for (let i = 0; i < 8; i++) store.record({ serverId: "srv", kind: "request", level: i === 6 ? "error" : "info",
    category: "tool", method: "tools/call", direction: "out", message: `operation-${i}` });
  assert.equal(store.getLogs().total, 3);
  assert.equal(store.getLogs("srv", { level: "error" }).entries[0].message, "operation-6");
  assert.equal(store.getLogs("srv", { category: "transport" }).total, 0);
  assert.equal(store.getLogs("different").total, 0);
  assert.equal(store.getLogs(null, { search: "OPERATION-6", method: "tools/call", direction: "out" }).total, 1);
  assert.equal(store.getLogs(null, { limit: 2 }).truncated, true);
  store.flush();
  const fresh = createMcpDiagnostics({ root });
  assert.equal(fresh.getLogs().total, 3);
  assert.deepEqual(fresh.getLogs().entries.map((entry) => entry.message).sort(), ["operation-5", "operation-6", "operation-7"]);
  assert.equal(store.getLogs().total, 3, "disk and current run are deduplicated");
  const secondRoot = workspace(t);
  const bounded = createMcpDiagnostics({ root: secondRoot, maxBytes: 4096 });
  for (let i = 0; i < 30; i++) bounded.record({ message: `${i}:` + "字".repeat(500), preview: "x".repeat(2000) });
  bounded.flush();
  assert.ok(bounded.getLogs().total > 0 && bounded.getLogs().total < 30);
  for (const file of fs.readdirSync(directoryFor(secondRoot))) assert.ok(fs.statSync(path.join(directoryFor(secondRoot), file)).size <= 4096);
});

test("history retention limits run files and ignores malformed or oversized runs without hiding valid data", (t) => {
  const root = workspace(t);
  for (let i = 0; i < 11; i++) {
    const run = createMcpDiagnostics({ root });
    run.record({ message: `run-${i}` });
    run.flush();
  }
  assert.equal(fs.readdirSync(directoryFor(root)).length, 8);
  const damagedRoot = workspace(t);
  saveFixture(damagedRoot, "{broken");
  saveFixture(damagedRoot, { version: 999, entries: [] });
  saveFixture(damagedRoot, "x".repeat(1_048_577));
  const good = createMcpDiagnostics({ root: damagedRoot });
  good.record({ message: "still readable" }); good.flush();
  const fresh = createMcpDiagnostics({ root: damagedRoot });
  assert.equal(fresh.getLogs().total, 1);
  assert.equal(fresh.getLogs().entries[0].message, "still readable");
});

test("diagnostics redact configured inputs and OAuth tokens at record, flush, read and export boundaries", (t) => {
  const root = workspace(t);
  const hub = { rawConfigs: { srv: { headers: { Authorization: "Bearer configured-auth" } } },
    inputs: { credential: { value: "input-secret" } }, oauthSecrets: new Set(["oauth-old"]) };
  const store = createMcpDiagnostics({ root, hub });
  const record = store.record({ serverId: "srv", message: "configured-auth input-secret oauth-old", preview: "access_token=extra-secret" });
  assert.doesNotMatch(JSON.stringify(record), /configured-auth|input-secret|oauth-old|extra-secret/);
  store.record({ message: "new-opaque-oauth-value" });
  hub.oauthSecrets.add("new-opaque-oauth-value");
  store.flush();
  for (const filename of fs.readdirSync(directoryFor(root))) {
    assert.doesNotMatch(fs.readFileSync(path.join(directoryFor(root), filename), "utf8"), /configured-auth|input-secret|oauth-old|new-opaque-oauth-value|extra-secret/);
  }
  saveFixture(root, { version: 1, entries: [{ id: "old-run:1", timestamp: "2026-10-06T00:00:00.000Z", message: "new-opaque-oauth-value" }] });
  const fresh = createMcpDiagnostics({ root, hub });
  assert.doesNotMatch(fresh.exportLogs(), /configured-auth|input-secret|oauth-old|new-opaque-oauth-value|extra-secret/);
});

test("persisted metadata is treated as untrusted and known secrets do not escape through IDs or timestamps", (t) => {
  const root = workspace(t);
  const secret = "persisted-opaque-secret";
  saveFixture(root, { version: 1, entries: [{ id: secret, timestamp: secret, message: "visible" }] });
  const store = createMcpDiagnostics({ root, hub: { oauthSecrets: new Set([secret]) } });
  assert.doesNotMatch(store.exportLogs(), new RegExp(secret));
});

test("structural frame summaries omit arguments, result bodies, errors, headers and notification text", () => {
  const secret = "very-private-payload";
  const frames = [
    { id: 1, method: "tools/call", params: { arguments: { value: secret }, headers: { Authorization: secret } } },
    { id: 1, result: { content: [{ text: secret }] } },
    { id: 1, error: { code: -32602, message: secret, data: { token: secret } } },
    { method: "notifications/message", params: { data: secret } }
  ];
  for (const frame of frames) {
    assert.doesNotMatch(JSON.stringify(summarizeFrame(frame)), new RegExp(secret));
    assert.equal(summarizeFrame(frame).requestId, frame.id);
  }
  assert.equal(summarizeFrame(frames[2]).status, "error");
  assert.match(summarizeFrame(frames[2]).preview, /-32602/);
});

test("diagnostic directories reject junctions and symlinks without touching their targets", (t) => {
  const root = workspace(t);
  const outside = workspace(t);
  fs.writeFileSync(path.join(outside, "keep.txt"), "unchanged");
  fs.symlinkSync(outside, path.join(root, ".deepseek-code"), process.platform === "win32" ? "junction" : "dir");
  const store = createMcpDiagnostics({ root });
  assert.equal(store.getLogs().total, 0);
  store.record({ message: "memory only" }); store.flush();
  assert.match(store.getLogs().storageError, /could not/);
  assert.equal(store.getLogs().entries[0].message, "memory only");
  assert.deepEqual(fs.readdirSync(outside), ["keep.txt"]);
});

test("diagnostic reader does not open symlinked history files", (t) => {
  const root = workspace(t);
  const history = saveFixture(root, { version: 1, entries: [{ id: "linked:1", message: "must not read" }] });
  const originalStat = fs.lstatSync;
  const originalRead = fs.readFileSync;
  // Exercise the lstat rejection even on Windows without file-symlink privilege.
  t.mock.method(fs, "lstatSync", (target, ...args) => target === history
    ? { isFile: () => true, isSymbolicLink: () => true, size: 100 }
    : originalStat(target, ...args));
  t.mock.method(fs, "readFileSync", (target, ...args) => {
    assert.notEqual(target, history, "never read the target of a symbolic link");
    return originalRead(target, ...args);
  });
  assert.equal(createMcpDiagnostics({ root }).getLogs().total, 0);
});

test("Hub emits one sanitized log per lifecycle, frame and completed request and classifies failures", async (t) => {
  const root = workspace(t);
  const secret = "hub-private-value";
  const hub = new McpHub({ projectRoot: root, inputs: { credential: { value: secret } },
    config: { mcpServers: { srv: { command: "unstarted-command" } } } });
  t.after(() => hub.stopAll());
  const events = [];
  hub.on("log", (event) => events.push(event));
  hub.emit("server_status", { serverId: "srv", status: "CONNECTED" });
  hub.emit("auth_required", { serverId: "srv", message: secret });
  const client = hub._createClient("srv", hub.serverConfigs.get("srv"));
  client.emit("trace", { direction: "out", frame: { id: 7, method: "tools/call", params: { password: secret } } });
  client.emit("request_completed", { method: "tools/call", requestId: 7, durationMs: 14,
    status: "error", error: { code: "MCP_TIMEOUT", message: `${secret} unknown-argument-credential-echo` } });
  assert.equal(events.length, 4);
  assert.doesNotMatch(JSON.stringify(events), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(events), /unknown-argument-credential-echo/);
  assert.equal(hub.getLogs("srv", { category: "auth" }).total, 1);
  assert.equal(hub.getLogs("srv", { category: "timeout" }).entries[0].durationMs, 14);
  assert.equal(hub.getLogs("srv", { method: "tools/call" }).total, 2);
  hub.getLogs(); hub.exportLogs();
  assert.equal(events.length, 4, "reading never recursively emits logs");
  assert.ok(MCP_HUB_EVENTS.includes("log"));
  assert.ok(MCP_HUB_EVENTS.includes("tool_test"));
});

test("event projection preserves framework keys and omits OAuth credentials and unexpected payloads", () => {
  const projected = safeMcpEvent({ serverId: "srv", status: "authenticated", durationMs: 12, authorizationUrl: "https://private/",
    access_token: "private-token", arbitrary: "private-token", error: { message: "private-token", stack: "private-token" } },
  { oauthSecrets: new Set(["private-token"]) });
  assert.equal(projected.status, "authenticated");
  assert.equal(projected.durationMs, 12);
  assert.doesNotMatch(JSON.stringify(projected), /private-token|authorizationUrl|access_token|arbitrary|stack/);
  assert.equal(diagnosticCategory({ code: "ABORT_ERR" }), "cancelled");
  assert.equal(diagnosticCategory({ code: "MCP_TIMEOUT" }), "timeout");
  assert.equal(diagnosticCategory({ code: "MCP_AUTH_REQUIRED" }), "auth");
  assert.equal(diagnosticCategory({ code: "PERMISSION_DENIED" }), "permission");
  assert.equal(diagnosticCategory({ code: -32603 }), "protocol");
  assert.equal(diagnosticCategory({}, "tools/call"), "tool");
});

test("same-millisecond request records keep numeric sequence ordering", (t) => {
  t.mock.method(Date.prototype, "toISOString", () => "2026-10-06T01:00:00.000Z");
  const store = createMcpDiagnostics({ persist: false });
  for (let i = 0; i < 24; i++) store.record({ message: `request-${i}` });
  assert.deepEqual(store.getLogs(null, { limit: 3 }).entries.map((entry) => entry.message), ["request-21", "request-22", "request-23"]);
});

test("flush recounts bytes after dynamic redaction expands old records", (t) => {
  const root = workspace(t);
  const hub = { oauthSecrets: new Set() };
  const store = createMcpDiagnostics({ root, hub, maxBytes: 4096 });
  for (let i = 0; i < 12; i++) store.record({ message: "z".repeat(50), preview: "z".repeat(50) });
  hub.oauthSecrets.add("z");
  store.flush();
  for (const filename of fs.readdirSync(directoryFor(root))) {
    const file = path.join(directoryFor(root), filename);
    assert.ok(fs.statSync(file).size <= 4096);
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), /zz/);
  }
  assert.ok(store.getLogs().total < 12);
});

test("short configured secrets do not corrupt framework status and direction enums", () => {
  const hub = { oauthSecrets: new Set(["s", "i"]) };
  const store = createMcpDiagnostics({ hub, persist: false });
  store.record({ serverId: "srv", status: "success", direction: "in", message: "s i" });
  assert.equal(store.getLogs("srv").entries.length, 1, "server filtering uses the same redaction as displayed identifiers");
  assert.equal(store.getLogs(null, { direction: "in" }).entries[0].status, "success");
  assert.equal(safeMcpEvent({ status: "authenticated" }, hub).status, "authenticated");
  assert.match(store.getLogs().entries[0].message, /REDACTED/);
});
