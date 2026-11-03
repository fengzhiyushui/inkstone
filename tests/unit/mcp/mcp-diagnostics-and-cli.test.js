// tests/unit/mcp/mcp-diagnostics-and-cli.test.js — MCP 诊断与 CLI(日志/工具试用/认证/内容)领域测试
//
// v1.19.1 测试归并:本文件由下列历史任务单测试合并而成,每个来源包裹在独立
// describe 块中(异步回调 + 动态 import,来源间零共享绑定),测试语义与拆分前一致。
import { describe } from "node:test";

// ---------------------------------------------------------------------------
// 来源:tests/unit/mcp-diagnostics.test.js
// ---------------------------------------------------------------------------
describe("unit/mcp-diagnostics", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { default: fs } = await import("node:fs");
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { randomUUID } = await import("node:crypto");
  const { createMcpDiagnostics, diagnosticCategory, summarizeFrame, safeMcpEvent, MCP_HUB_EVENTS } = await import("../../../src/tools/mcp/diagnostics.js");
  const { McpHub } = await import("../../../src/tools/mcp/mcp-hub.js");
  const { createMcpDisplayRedactor } = await import("../../../src/security/mcp-content.js");
  const { toToolExecutionResult } = await import("../../../src/tools/mcp/schema-converter.js");
  const { mkdtempSync } = await import("../../helpers/tmp.js");

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
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/mcp-tool-trials.test.js
// ---------------------------------------------------------------------------
describe("unit/mcp-tool-trials", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { EventEmitter } = await import("node:events");
  const { createMcpToolTrials } = await import("../../../src/tools/mcp/tool-trials.js");
  const { createToolRegistry } = await import("../../../src/tools/registry.js");
  const { createPermissionEngine } = await import("../../../src/tools/permissions/permission-engine.js");

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
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/mcp-cli.test.js
// ---------------------------------------------------------------------------
describe("unit/mcp-cli", async () => {

  /**
   * runCli 以 process.cwd() 作为项目根,没有 cwd 参数。测试里临时切目录,
   * 并保证无论断言如何失败都还原(否则会污染同进程的其它测试)。
   */

  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { default: http } = await import("node:http");
  const { once } = await import("node:events");
  const { mkdir, writeFile, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { runCli } = await import("../../../src/cli.js");
  const { mkdtemp } = await import("../../helpers/tmp.js");

  async function withProjectDir(root, fn) {
    const previous = process.cwd();
    process.chdir(root);
    try {
      return await fn();
    } finally {
      process.chdir(previous);
    }
  }

  async function writeProjectConfig(root, mcpServers) {
    await mkdir(path.join(root, ".deepseek-code"), { recursive: true });
    await writeFile(
      path.join(root, ".deepseek-code", "config.json"),
      JSON.stringify({ mcpServers }),
      "utf8"
    );
  }

  /** 起一个最小 Streamable HTTP mock,返回 { url, close }。 */
  async function startMockHttpServer() {
    const server = http.createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        const msg = JSON.parse(body);
        const send = (p) => {
          const t = JSON.stringify(p);
          res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(t) });
          res.end(t);
        };
        if (msg.id === undefined) { res.writeHead(202); res.end(); return; }
        if (msg.method === "server/discover") {
          send({
            jsonrpc: "2.0", id: msg.id,
            result: {
              era: "modern",
              protocolVersion: "2026-07-28",
              supportedVersions: ["2026-07-28"],
              serverInfo: { name: "cli-mock", version: "9.9" },
              capabilities: {}
            }
          });
        } else if (msg.method === "tools/list") {
          send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "ping", description: "Ping the server" }] } });
        } else {
          send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "nf" } });
        }
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return {
      url: `http://127.0.0.1:${server.address().port}/mcp`,
      close: () => new Promise((r) => server.close(r))
    };
  }

  test("CLI mcp list handles empty config and prints guidance", async () => {
    const origLog = console.log;
    const logs = [];
    console.log = (...args) => logs.push(args.join(" "));

    try {
      await runCli(["mcp", "list"]);
      const text = logs.join("\n");
      assert.match(text, /当前项目未配置任何 MCP 服务|已配置的 MCP 服务/);
    } finally {
      console.log = origLog;
    }
  });

  test("CLI mcp check validates arguments", async () => {
    await assert.rejects(
      async () => await runCli(["mcp", "check"]),
      /请指定要测试的 MCP 服务标识/
    );

    await assert.rejects(
      async () => await runCli(["mcp", "check", "non-existent-server-id"]),
      /未找到名为 "non-existent-server-id" 的 MCP 服务配置/
    );
  });

  test("CLI help output includes inkstone mcp command", async () => {
    const origLog = console.log;
    const logs = [];
    console.log = (...args) => logs.push(args.join(" "));

    try {
      await runCli(["help"]);
      const text = logs.join("\n");
      assert.match(text, /inkstone mcp/);
      assert.match(text, /MCP 外部扩展服务与工具/);
    } finally {
      console.log = origLog;
    }
  });

  test("CLI mcp add and remove validate arguments", async () => {
    await assert.rejects(
      async () => await runCli(["mcp", "add"]),
      /请指定有效的 MCP 服务标识/
    );

    await assert.rejects(
      async () => await runCli(["mcp", "add", "bad id with space!"]),
      /请指定有效的 MCP 服务标识/
    );

    await assert.rejects(
      async () => await runCli(["mcp", "add", "my_srv"]),
      /必须指定 --command/
    );

    await assert.rejects(
      async () => await runCli(["mcp", "remove"]),
      /请指定要移除的 MCP 服务标识/
    );

    await assert.rejects(
      async () => await runCli(["mcp", "remove", "no_such_server"]),
      /未找到名为 "no_such_server" 的 MCP 服务配置/
    );
  });

  // ── v1.12.0:远程(Streamable HTTP)服务的 CLI 支持 ───────────────────────────
  test("CLI mcp add 支持 --url 并以 streamable-http 记录", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-cli-mcp-"));
    const origLog = console.log;
    const logs = [];
    console.log = (...args) => logs.push(args.join(" "));
    try {
      await withProjectDir(root, () => runCli(["mcp", "add", "remote1", "--url", "https://mcp.example/mcp"]));
      const text = logs.join("\n");
      assert.match(text, /已成功添加并保存/);
      assert.match(text, /mcp\.example/);

      const saved = JSON.parse(await readFile(path.join(root, ".deepseek-code", "config.json"), "utf8"));
      assert.equal(saved.mcpServers.remote1.url, "https://mcp.example/mcp");
      assert.equal(saved.mcpServers.remote1.type, "streamable-http");
      assert.ok(!saved.mcpServers.remote1.command, "远程服务不应写入 command");
    } finally {
      console.log = origLog;
    }
  });

  test("CLI mcp add 拒绝非法 --headers JSON", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-cli-mcp-"));
    await assert.rejects(
      () => withProjectDir(root, () => runCli(["mcp", "add", "bad_hdr", "--url", "https://x.example/mcp", "--headers", "not-json"])),
      /--headers 必须是 JSON 对象/
    );
  });

  test("CLI mcp check 连通真实 Streamable HTTP 服务并列出工具", async () => {
    const mock = await startMockHttpServer();
    const root = await mkdtemp(path.join(tmpdir(), "dsc-cli-mcp-"));
    await writeProjectConfig(root, { local: { url: mock.url, type: "streamable-http", allowlist: ["127.0.0.1"] } });

    const origLog = console.log;
    const logs = [];
    console.log = (...args) => logs.push(args.join(" "));
    try {
      await withProjectDir(root, () => runCli(["mcp", "check", "local"]));
      const text = logs.join("\n");
      assert.match(text, /连接成功/);
      assert.match(text, /cli-mock/);
      assert.match(text, /ping/);
      assert.match(text, /modern/, "应显示协商到的协议模式");
    } finally {
      console.log = origLog;
      await mock.close();
    }
  });

  test("CLI mcp check 对私网目标默认拒绝(需显式放行)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-cli-mcp-"));
    await writeProjectConfig(root, { blocked: { url: "http://10.0.0.5/mcp", type: "streamable-http" } });
    const origLog = console.log;
    const origErr = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
      await assert.rejects(
        () => withProjectDir(root, () => runCli(["mcp", "check", "blocked"])),
        /blocked private network|blocked/i
      );
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
  });

  test("CLI mcp list 标注远程类型与 legacy SSE 弃用提示", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-cli-mcp-"));
    await writeProjectConfig(root, {
      modern: { url: "https://a.example/mcp", type: "streamable-http" },
      legacy: { url: "https://b.example/sse", type: "sse" }
    });
    const origLog = console.log;
    const logs = [];
    console.log = (...args) => logs.push(args.join(" "));
    try {
      await withProjectDir(root, () => runCli(["mcp", "list"]));
      const text = logs.join("\n");
      assert.match(text, /streamable-http/);
      assert.match(text, /\[sse\]/);
      assert.match(text, /legacy SSE 传输已废弃/);
    } finally {
      console.log = origLog;
    }
  });

  // ── v1.13.0:trust 与持久放行策略 ───────────────────────────────────────────
  test("CLI mcp add --trust 写入 trust 并提示风险", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-cli-mcp-"));
    const origLog = console.log;
    const logs = [];
    console.log = (...args) => logs.push(args.join(" "));
    try {
      await withProjectDir(root, () => runCli(["mcp", "add", "trusted_srv", "--command", "npx", "--trust"]));
      assert.match(logs.join("\n"), /已信任/);

      const saved = JSON.parse(await readFile(path.join(root, ".deepseek-code", "config.json"), "utf8"));
      assert.equal(saved.mcpServers.trusted_srv.trust, true);
    } finally {
      console.log = origLog;
    }
  });

  test("CLI mcp add 未加 --trust 时不写 trust 字段", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-cli-mcp-"));
    const origLog = console.log;
    console.log = () => {};
    try {
      await withProjectDir(root, () => runCli(["mcp", "add", "plain_srv", "--command", "npx"]));
      const saved = JSON.parse(await readFile(path.join(root, ".deepseek-code", "config.json"), "utf8"));
      assert.ok(!("trust" in saved.mcpServers.plain_srv), "默认不得写 trust,保持最小惊讶");
    } finally {
      console.log = origLog;
    }
  });

  /** 把 DEEPSEEK_CODE_HOME 指到临时目录,避免测试写进真实主目录。 */
  async function withIsolatedHome(fn) {
    const orig = process.env.DEEPSEEK_CODE_HOME;
    process.env.DEEPSEEK_CODE_HOME = await mkdtemp(path.join(tmpdir(), "dsc-cli-policy-home-"));
    try {
      return await fn(process.env.DEEPSEEK_CODE_HOME);
    } finally {
      if (orig === undefined) delete process.env.DEEPSEEK_CODE_HOME;
      else process.env.DEEPSEEK_CODE_HOME = orig;
    }
  }

  test("CLI mcp policy list 空/有记录两种情形", async () => {
    await withIsolatedHome(async () => {
      const root = await mkdtemp(path.join(tmpdir(), "dsc-cli-policy-"));
      await writeProjectConfig(root, { s: { command: "npx" } });
      const origLog = console.log;
      const logs = [];
      console.log = (...args) => logs.push(args.join(" "));
      try {
        await withProjectDir(root, () => runCli(["mcp", "policy", "list"]));
        assert.match(logs.join("\n"), /当前没有持久放行记录/);

        const { createPolicyStore } = await import("../../../src/tools/mcp/tool-policy.js");
        createPolicyStore({ projectRoot: root }).grant("mcp__s__read_doc", "project");

        logs.length = 0;
        await withProjectDir(root, () => runCli(["mcp", "policy", "list"]));
        const text = logs.join("\n");
        assert.match(text, /持久放行记录/);
        assert.match(text, /mcp__s__read_doc/);
        assert.match(text, /本项目/);
        assert.match(text, /破坏性/, "应提示 destructive 不可持久放行");
      } finally {
        console.log = origLog;
      }
    });
  });

  test("CLI mcp policy revoke 撤销两个作用域的授权", async () => {
    await withIsolatedHome(async () => {
      const root = await mkdtemp(path.join(tmpdir(), "dsc-cli-policy-"));
      await writeProjectConfig(root, { s: { command: "npx" } });
      const origLog = console.log;
      const logs = [];
      console.log = (...args) => logs.push(args.join(" "));
      try {
        const { createPolicyStore } = await import("../../../src/tools/mcp/tool-policy.js");
        const store = createPolicyStore({ projectRoot: root });
        store.grant("mcp__s__t", "project");
        store.grant("mcp__s__t", "always");
        assert.equal(store.asRules().length, 2);

        await withProjectDir(root, () => runCli(["mcp", "policy", "revoke", "mcp__s__t"]));
        assert.match(logs.join("\n"), /已撤销/);

        assert.equal(createPolicyStore({ projectRoot: root }).asRules().length, 0, "两个作用域都应被撤销");
      } finally {
        console.log = origLog;
      }
    });
  });

  test("CLI mcp policy revoke 缺少工具名时报错", async () => {
    await withIsolatedHome(async () => {
      const root = await mkdtemp(path.join(tmpdir(), "dsc-cli-policy-"));
      await writeProjectConfig(root, { s: { command: "npx" } });
      await assert.rejects(
        () => withProjectDir(root, () => runCli(["mcp", "policy", "revoke"])),
        /请指定要撤销的工具名/
      );
    });
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/mcp-cli-auth.test.js
// ---------------------------------------------------------------------------
describe("unit/mcp-cli-auth", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { default: path } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { readFile } = await import("node:fs/promises");
  const { runCli, runMcp } = await import("../../../src/cli.js");
  const { mkdtemp } = await import("../../helpers/tmp.js");

  function fixture() {
    const output = [], calls = [];
    let disposed = 0, removed = 0, clock = 100000, interrupt;
    const statuses = [{ status: "pending" }, { status: "authenticated", issuer: "https://auth.example", expiresAt: 200000,
      accessToken: "must-not-display", refreshToken: "must-not-display-refresh" }];
    const mcp = {
      hub: { inputs: { password: { value: "configured-secret" } }, oauthSecrets: new Set(["nonce"]) },
      startAuth: async (id) => {
        calls.push(["start", id]);
        return { status: "pending", authorizationUrl: "https://auth.example/authorize?state=nonce&code_challenge=challenge", expiresAt: 150000 };
      },
      getAuthStatus: async (id) => { calls.push(["status", id]); return statuses.shift() || { status: "pending" }; },
      cancelAuth: async (id) => { calls.push(["cancel", id]); },
      logoutAuth: async (id) => { calls.push(["logout", id]); }
    };
    const deps = {
      write: (value) => output.push(value), writeError: (value) => output.push(value),
      loadConfigImpl: async () => ({ apiKey: "test-api-secret", mcpServers: { remote: { url: "https://mcp.example", oauth: { enabled: true } } } }),
      buildKernelOptionsImpl: async () => ({ sentinel: true }),
      createKernelImpl: async (_root, options) => {
        assert.equal(options.autoInitMcp, false);
        assert.equal(options.sentinel, true);
        calls.push(["kernel", options]);
        return { mcp, dispose: async () => { disposed++; } };
      },
      now: () => clock,
      sleep: async (ms, signal) => { assert.equal(signal.aborted, false); clock += ms; },
      onSigint: (handler) => { interrupt = handler; return () => { removed++; }; }
    };
    return { deps, mcp, output, calls, statuses, disposed: () => disposed, removed: () => removed, interrupt: () => interrupt() };
  }

  test("CLI OAuth login waits for authentication and displays only safe status fields", async () => {
    const f = fixture();
    const result = await runMcp("/repo", ["auth", "remote"], new Map(), f.deps);
    assert.equal(result.status, "authenticated");
    assert.equal(result.issuer, "https://auth.example");
    assert.match(f.output.join("\n"), /https:\/\/auth.example\/authorize\?state=nonce&code_challenge=challenge/);
    assert.match(f.output.join("\n"), /已登录/);
    assert.doesNotMatch(JSON.stringify([result, f.output]), /must-not-display|configured-secret|test-api-secret/);
    assert.deepEqual(f.calls.filter(([action]) => action !== "kernel").map(([action]) => action), ["start", "status", "status"]);
    assert.equal(f.disposed(), 1);
    assert.equal(f.removed(), 1);
  });

  test("CLI OAuth status/logout/cancel never initiate authorization", async () => {
    for (const action of ["status", "logout", "cancel"]) {
      const f = fixture();
      f.statuses.splice(0, f.statuses.length, { status: "unauthenticated", refreshToken: "must-not-display" });
      await runCli(["mcp", "auth", "remote", action], { root: "/repo", mcp: f.deps });
      assert.deepEqual(f.calls.filter(([kind]) => kind !== "kernel"), [[action, "remote"]]);
      assert.doesNotMatch(f.output.join("\n"), /must-not-display/);
      assert.equal(f.disposed(), 1);
    }
  });

  test("CLI OAuth failure is redacted and cleans up pending callback resources", async () => {
    const f = fixture();
    f.statuses.splice(0, f.statuses.length, { status: "error", message: "denied configured-secret test-api-secret" });
    await assert.rejects(() => runMcp("/repo", ["auth", "remote"], new Map(), f.deps),
      (error) => error.message.includes("REDACTED") && !/configured-secret|test-api-secret/.test(error.message));
    assert.deepEqual(f.calls.at(-1), ["cancel", "remote"]);
    assert.equal(f.disposed(), 1);
    assert.equal(f.removed(), 1);
  });

  test("CLI OAuth timeout cancels the pending flow and disposes", async () => {
    const f = fixture();
    f.statuses.length = 0;
    await assert.rejects(() => runMcp("/repo", ["auth", "remote"], new Map([["timeout", "1000"]]), f.deps), /登录超时/);
    assert.deepEqual(f.calls.at(-1), ["cancel", "remote"]);
    assert.equal(f.disposed(), 1);
  });

  test("CLI OAuth Ctrl+C is cancellation rather than successful login", async () => {
    const f = fixture();
    f.deps.sleep = async () => { f.interrupt(); throw new Error("aborted"); };
    await assert.rejects(() => runMcp("/repo", ["auth", "remote"], new Map(), f.deps), /已取消登录/);
    assert.deepEqual(f.calls.at(-1), ["cancel", "remote"]);
    assert.doesNotMatch(f.output.join("\n"), /已登录/);
    assert.equal(f.disposed(), 1);
    assert.equal(f.removed(), 1);
  });

  test("CLI OAuth interrupts startup without leaking a callback listener", async () => {
    const f = fixture();
    const start = f.mcp.startAuth;
    f.mcp.startAuth = async (id) => { const pending = await start(id); f.interrupt(); return pending; };
    await assert.rejects(() => runMcp("/repo", ["auth", "remote"], new Map(), f.deps), /已取消登录/);
    assert.deepEqual(f.calls.at(-1), ["cancel", "remote"]);
    assert.equal(f.disposed(), 1);
  });

  test("CLI OAuth validates arguments before creating kernel state", async () => {
    const f = fixture();
    for (const [args, flags] of [
      [["auth"], []], [["auth", "bad id"], []], [["auth", "remote", "unknown"], []],
      [["auth", "remote", "status", "extra"], []], [["auth", "remote"], [["timeout", "0"]]],
      [["auth", "remote"], [["timeout", true]]]
    ]) await assert.rejects(() => runMcp("/repo", args, new Map(flags), f.deps));
    assert.equal(f.calls.length, 0);
  });

  test("CLI OAuth preserves loopback authorization URL and rejects unsafe browser addresses", async () => {
    for (const authorizationUrl of ["http://127.0.0.1:12345/authorize?state=nonce", "http://localhost:12345/authorize?state=nonce"]) {
      const f = fixture();
      f.mcp.startAuth = async () => ({ status: "pending", authorizationUrl });
      await runMcp("/repo", ["auth", "remote"], new Map(), f.deps);
      assert.ok(f.output.includes(authorizationUrl));
    }
    for (const authorizationUrl of ["javascript:alert(1)", "http://public.example/authorize", "https://user:password@example.com/authorize", "https://example.com/authorize#secret"]) {
      const f = fixture();
      f.mcp.startAuth = async () => ({ status: "pending", authorizationUrl });
      await assert.rejects(() => runMcp("/repo", ["auth", "remote"], new Map(), f.deps), /授权地址/);
      assert.ok(!f.output.includes(authorizationUrl));
      assert.deepEqual(f.calls.at(-1), ["cancel", "remote"]);
      assert.equal(f.disposed(), 1);
    }
  });

  test("CLI mcp check uses Hub authorization with temporary private allowlist and redacts output", async () => {
    const f = fixture();
    f.mcp.restartServer = async (id) => { f.calls.push(["restart", id]); };
    f.mcp.hub.getServer = () => ({ serverInfo: { name: "configured-secret", version: "1" }, getProtocolMode: () => "modern" });
    f.mcp.hub.serverTools = new Map([["remote", [{ name: "mcp__remote__ping", description: "test-api-secret" }]]]);
    await runMcp("/repo", ["check", "remote"], new Map([["allow-private", "127.0.0.1"]]), f.deps);
    const options = f.calls.find(([kind]) => kind === "kernel")[1];
    assert.deepEqual(options.mcpServers.remote.oauth, { enabled: true });
    assert.deepEqual(options.mcpServers.remote.allowlist, ["127.0.0.1"]);
    assert.deepEqual(f.calls.at(-1), ["restart", "remote"]);
    assert.match(f.output.join("\n"), /连接成功|ping/);
    assert.doesNotMatch(f.output.join("\n"), /configured-secret|test-api-secret/);
    assert.equal(f.disposed(), 1);
  });

  async function withIsolatedHome(run) {
    const previous = process.env.DEEPSEEK_CODE_HOME;
    process.env.DEEPSEEK_CODE_HOME = await mkdtemp(path.join(tmpdir(), "mcp-cli-auth-home-"));
    try { return await run(); }
    finally {
      if (previous === undefined) delete process.env.DEEPSEEK_CODE_HOME;
      else process.env.DEEPSEEK_CODE_HOME = previous;
    }
  }

  test("CLI mcp add writes only public OAuth configuration", async () => {
    await withIsolatedHome(async () => {
      const root = await mkdtemp(path.join(tmpdir(), "mcp-cli-auth-project-"));
      const original = console.log;
      console.log = () => {};
      try {
        await runCli(["mcp", "add", "remote", "--url", "https://mcp.example", "--oauth", "--client-id", "public-client", "--scopes", "mcp:read,mcp:write mcp:read"], { root });
      } finally { console.log = original; }
      const saved = JSON.parse(await readFile(path.join(root, ".deepseek-code", "config.json"), "utf8"));
      assert.deepEqual(saved.mcpServers.remote.oauth, { enabled: true, clientId: "public-client", scopes: ["mcp:read", "mcp:write"] });
    });
  });

  test("CLI mcp add rejects OAuth secrets, stdio OAuth and invalid public options", async () => {
    const f = fixture();
    for (const flags of [
      [["command", "npx"], ["oauth", true]],
      [["url", "https://mcp.example"], ["client-id", "public-client"]],
      [["url", "https://mcp.example"], ["oauth", true], ["client-secret", "never-save"]],
      [["url", "https://mcp.example"], ["oauth", true], ["client-id", true]],
      [["url", "https://mcp.example"], ["oauth", true], ["scopes", true]],
      [["url", "https://mcp.example"], ["oauth", true], ["scopes", 'bad"scope']]
    ]) await assert.rejects(() => runMcp("/repo", ["add", "remote"], new Map(flags), f.deps));
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/mcp-cli-content.test.js
// ---------------------------------------------------------------------------
describe("unit/mcp-cli-content", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { runCli, runMcp } = await import("../../../src/cli.js");

  function fixture() {
    const calls = [], output = [];
    let disposed = 0;
    const mcp = { hub: { inputs: { auth: { value: "local-credential" } } } };
    for (const name of ["listResources", "listResourceTemplates", "readResource", "listPrompts", "getPrompt"]) {
      mcp[name] = async (...args) => {
        calls.push([name, ...args]);
        return { supported: true, truncated: true, nextCursor: "server-cursor", contents: [{ text: "local-credential api-local-key", blob: "raw-binary" }] };
      };
    }
    const deps = {
      write: (line) => output.push(line), loadConfigImpl: async () => ({ apiKey: "api-local-key" }),
      buildKernelOptionsImpl: async () => ({ sentinel: true }),
      createKernelImpl: async (_root, options) => {
        assert.equal(options.autoInitMcp, false);
        assert.equal(options.sentinel, true);
        return { mcp, dispose: async () => { disposed++; } };
      }
    };
    return { calls, output, mcp, deps, disposed: () => disposed };
  }

  test("CLI resources routes lists/templates/read with limits and opaque URI through MCP", async () => {
    const f = fixture();
    const flags = new Map([["max-pages", "2"], ["max-items", "10"], ["max-bytes", "1024"], ["cursor", "opaque=server"]]);
    for (const sub of ["list", "templates", "read"]) {
      await runMcp("/repo", ["resources", "srv", sub, ...(sub === "read" ? ["custom://thing?x=1"] : [])], flags, f.deps);
    }
    assert.deepEqual(f.calls.map((call) => call[0]), ["listResources", "listResourceTemplates", "readResource"]);
    assert.deepEqual(f.calls[2], ["readResource", "srv", "custom://thing?x=1", { maxPages: 2, maxItems: 10, maxBytes: 1024, cursor: "opaque=server" }]);
    assert.equal(f.disposed(), 3);
    assert.doesNotMatch(f.output.join("\n"), /local-credential|api-local-key|raw-binary/);
    assert.match(f.output.join("\n"), /截断/);
  });

  test("CLI prompts accepts JSON arguments including equals and does not send to an agent", async () => {
    const f = fixture();
    await runCli(["mcp", "prompts", "srv", "get", "review", '--arguments={"context":"a=b","password":"test-secret"}'], { root: "/repo", mcp: f.deps });
    assert.equal(f.calls[0][0], "getPrompt");
    assert.deepEqual(f.calls[0][3], { context: "a=b", password: "test-secret" });
    assert.equal(f.disposed(), 1);
    await runMcp("/repo", ["prompts", "srv"], new Map(), f.deps);
    assert.equal(f.calls.at(-1)[0], "listPrompts");
  });

  test("CLI content validates before opening a connection and identifies stale local cursors", async () => {
    const f = fixture();
    for (const [args, flags] of [
      [["resources"], []], [["resources", "srv", "read"], []],
      [["prompts", "srv", "get", "review"], [["arguments", '"secret"']]],
      [["resources", "srv"], [["max-items", "0"]]],
      [["resources", "srv"], [["cursor", "inkstone-page:stale"]]]
    ]) await assert.rejects(() => runMcp("/repo", args, new Map(flags), f.deps));
    assert.equal(f.calls.length, 0);
  });

  test("CLI content shows unsupported state and disposes after redacted failure", async () => {
    const f = fixture();
    f.mcp.listResources = async () => ({ supported: false, resources: [] });
    await runMcp("/repo", ["resources", "srv"], new Map(), f.deps);
    assert.match(f.output.join("\n"), /不支持/);
    f.mcp.readResource = async () => { throw new Error("denied: local-credential"); };
    await assert.rejects(() => runMcp("/repo", ["resources", "srv", "read", "file:///x"], new Map(), f.deps),
      (error) => /REDACTED/.test(error.message) && !error.message.includes("local-credential"));
    assert.equal(f.disposed(), 2);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/mcp-cli-logs.test.js
// ---------------------------------------------------------------------------
describe("unit/mcp-cli-logs", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { runCli, runMcp } = await import("../../../src/cli.js");
  const { cleanMcpLogResult } = await import("../../../src/apps/cli/mcp-logs.js");
  const { createMcpDisplayRedactor } = await import("../../../src/security/mcp-content.js");
  const { createMcpDiagnostics } = await import("../../../src/tools/mcp/diagnostics.js");
  const { mkdtemp } = await import("../../helpers/tmp.js");
  const { mkdir, writeFile, access } = await import("node:fs/promises");
  const { default: path } = await import("node:path");
  const { default: os } = await import("node:os");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");

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
    const cliUrl = new URL("../../../src/cli.js", import.meta.url).href;
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `import { runCli } from ${JSON.stringify(cliUrl)}; await runCli(['mcp','logs','removed-server','--json'], {root:process.argv[1]});`, root], {
      env: { ...process.env, DEEPSEEK_CODE_HOME: userDir }, timeout: 15000
    });
    assert.equal(stderr, "");
    const result = JSON.parse(stdout);
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].message, "past timeout");
    await assert.rejects(() => access(marker));
  });
});
