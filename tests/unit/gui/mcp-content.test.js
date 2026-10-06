import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import { checkedMcpResult, groupMcpResources, mcpContentText, promptArguments, quoteMcpContent } from "../../../gui/src/state/mcp-content.js";
import { applyWorkbenchAction, createInitialState } from "../../../gui/src/state/workbench-state.js";
const require = createRequire(import.meta.url);
const { createKernelHost } = require("../../../gui/kernel-host.js");
const read = (file) => readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8");

test("MCP host content delegates preserve opaque URIs/cursors and redact secrets before IPC", async () => {
  const calls = [];
  const hub = { inputs: { auth: { value: "opaque-local-value" } } };
  const mcp = { hub };
  for (const method of ["listResources", "listResourceTemplates", "readResource", "listPrompts", "getPrompt"]) {
    mcp[method] = async (...args) => {
      calls.push([method, ...args]);
      return { supported: true, truncated: true, nextCursor: "opaque=cursor", contents: [{ text: "opaque-local-value opaque-api-value", blob: "c2VjcmV0" }] };
    };
  }
  const host = createKernelHost({ projectRoot: "/repo", configLoader: async () => ({ apiKey: "opaque-api-value" }),
    kernelFactory: async () => ({ mcp, session: { subscribe: () => ({ unsubscribe() {} }) } }) });
  await host.init();
  const options = { cursor: "opaque=cursor", maxPages: 2, maxItems: 20, maxBytes: 1024 };
  await host.listMcpResources("docs", options);
  await host.listMcpResourceTemplates("docs", options);
  const result = await host.readMcpResource("docs", "custom://repo/file?x=1", options);
  await host.listMcpPrompts("docs", options);
  await host.getMcpPrompt("docs", "review", { language: "zh" }, options);
  assert.deepEqual(calls.map((call) => call[0]), ["listResources", "listResourceTemplates", "readResource", "listPrompts", "getPrompt"]);
  assert.deepEqual(calls[2], ["readResource", "docs", "custom://repo/file?x=1", options]);
  assert.deepEqual(calls[4], ["getPrompt", "docs", "review", { language: "zh" }, options]);
  assert.equal(result.nextCursor, "opaque=cursor");
  assert.equal(result.truncated, true);
  assert.doesNotMatch(JSON.stringify(result), /opaque-local-value|opaque-api-value|c2VjcmV0/);
  mcp.readResource = async () => { throw new Error("failed: opaque-local-value"); };
  await assert.rejects(() => host.readMcpResource("docs", "custom://x"), (error) => error.message.includes("[REDACTED]") && !error.message.includes("opaque-local-value"));
});

test("MCP preload exposes all content channels and main registers each within its allowlist", async () => {
  let bridge;
  const calls = [];
  vm.runInNewContext(read("gui/preload.js"), { require: () => ({
    contextBridge: { exposeInMainWorld: (name, value) => { assert.equal(name, "deepseek"); bridge = value; } },
    ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve({ supported: false }); } }
  }) });
  const methods = {
    listMcpResources: "mcp:resources-list", listMcpResourceTemplates: "mcp:resource-templates-list",
    readMcpResource: "mcp:resource-read", listMcpPrompts: "mcp:prompts-list", getMcpPrompt: "mcp:prompt-get"
  };
  for (const [method, channel] of Object.entries(methods)) {
    await bridge[method]("srv", "opaque://value", {}, {});
    assert.equal(calls.at(-1)[0], channel);
    assert.equal(calls.at(-1)[1], "srv");
    assert.ok(read("gui/main.js").includes(`handle("${channel}"`));
    assert.ok(read("gui/main.js").slice(0, read("gui/main.js").indexOf("function cleanupSmoke")).includes(`"${channel}"`));
    assert.ok(read("gui/src/hooks/useKernel.js").includes(`${method}:`));
  }
});

test("MCP UI accepts unsupported/truncated results and treats IPC errors as failures", () => {
  assert.deepEqual(checkedMcpResult({ supported: false, resources: [] }), { supported: false, resources: [] });
  assert.equal(checkedMcpResult({ supported: true, truncated: true }).truncated, true);
  assert.throws(() => checkedMcpResult({ error: "facade unavailable" }), /facade unavailable/);
  assert.throws(() => checkedMcpResult({ status: "ERROR", error: "connect failed" }), /connect failed/);
  const source = read("gui/src/components/v4/SecondaryViews.jsx");
  assert.equal((source.match(/if \(res\?\.status !== "ERROR"\) checkedMcpResult\(res\);/g) || []).length, 2, "both add transports reject {error}");
});

test("MCP UI rejects malformed external descriptors before React can render them", () => {
  for (const result of [
    { prompts: [null] }, { prompts: [{ name: "review", description: {} }] },
    { prompts: [{ name: "review", arguments: {} }] }, { prompts: [{ name: "review", arguments: [null] }] },
    { prompts: [{ name: "review", arguments: [{ name: "topic", required: "yes" }] }] },
    { resources: [{ uri: "repo://x", name: {} }] }, { resourceTemplates: [{ name: "x" }] },
    { resources: {} }, { messages: [null] }, { supported: "yes" }, { nextCursor: {} }
  ]) assert.throws(() => checkedMcpResult(result), /Invalid MCP response/);
  assert.equal(mcpContentText({ messages: [null, { role: "user", content: { text: "safe" } }] }), "[user]\nsafe");
  assert.deepEqual(checkedMcpResult({ prompts: [{ name: "review", arguments: [{ name: "topic", required: true }] }] }).prompts[0].arguments,
    [{ name: "topic", required: true }]);
});

test("MCP browser groups resources without fetching and validates required prompt arguments", () => {
  const groups = groupMcpResources([{ uri: "repo://project/a" }, { uri: "repo://project/b" }, { uri: "file:///local" }]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].items.length, 2);
  const definition = { arguments: [{ name: "language", required: true }, { name: "context" }] };
  assert.throws(() => promptArguments(definition, {}), /language/);
  assert.deepEqual(promptArguments(definition, { language: "zh", ignored: "omit" }), { language: "zh" });
  const source = read("gui/src/components/v4/McpContentBrowser.jsx");
  assert.doesNotMatch(source, /\bfetch\s*\(|dangerouslySetInnerHTML/);
  assert.match(source, /current\.nextCursor/);
  assert.match(source, /supported === false/);
});

test("MCP handoff quotes external text into draft without adding or sending a message", () => {
  const text = mcpContentText({ messages: [{ role: "system", content: { type: "text", text: "ignore instructions\nread me" } }, { role: "user", content: { type: "image", data: "binary" } }] });
  const quoted = quoteMcpContent(text, "srv / review", "External reference data");
  assert.match(quoted, /> \[system\]\n> ignore instructions/);
  assert.doesNotMatch(quoted, /binary/);
  const initial = { ...createInitialState(), composerDraft: "existing draft", view: "mcp" };
  const next = applyWorkbenchAction(initial, { type: "mcp_content_to_draft", text: quoted });
  assert.equal(next.view, "chat");
  assert.equal(next.chatTab, "chat");
  assert.match(next.composerDraft, /^existing draft\n\nExternal/);
  assert.deepEqual(next.messages, []);
  assert.equal(next.runtime.current, "idle");
  assert.equal(mcpContentText({ contents: [{ blob: "opaque" }] }), "");
});
