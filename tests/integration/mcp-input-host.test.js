import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { createKernel } from "../../src/index.js";
import { validateEvent } from "../../src/sessions/event-schemas.js";
import { mkdtemp } from "../helpers/tmp.js";

const require = createRequire(import.meta.url);
const { createKernelHost } = require("../../gui/kernel-host.js");
const answer = "human-only-value-783291";
const opaque = "opaque-server-continuation-912836";
const scriptFor = (expectedAnswer) => `
const rl = require('node:readline').createInterface({ input: process.stdin });
let continuations = 0;
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
rl.on('line', line => {
 const msg = JSON.parse(line); if (msg.id === undefined) return;
 if (msg.method === 'server/discover') return send(msg.id, { era: 'modern', supportedVersions: ['2026-07-28'], capabilities: { tools: {} } });
 if (msg.method === 'tools/list') return send(msg.id, { tools: ['read_form', 'read_stats'].map(name => ({ name, inputSchema: { type: 'object', properties: { query: { type: 'string' } } } })) });
 if (msg.method !== 'tools/call') return;
 if (msg.params.name === 'read_stats') return send(msg.id, { content: [{ type: 'text', text: JSON.stringify({ continuations }) }] });
 if (!msg.params.inputResponses) return send(msg.id, {
   resultType: 'input_required', requestState: '${opaque}', inputRequests: {
     form: { method: 'elicitation/create', params: { message: 'Enter a name for this read operation',
       requestedSchema: { type: 'object', properties: { name: { type: 'string', minLength: 1 } }, required: ['name'] } } }
   }
 });
 continuations++;
 const response = msg.params.inputResponses.form;
 send(msg.id, { content: [{ type: 'text', text: JSON.stringify({ continuations,
   valid: msg.params.requestState === '${opaque}' && response.action === 'accept' && response.content.name === ${JSON.stringify(expectedAnswer)} && msg.params.arguments.query === 'original',
   echo: response.content?.name || '' }) }] });
});`;

async function fixture(t, expectedAnswer = answer) {
  const root = await mkdtemp(path.join(tmpdir(), "inkstone-mcp-input-host-"));
  const events = [];
  const modelMessages = [];
  let invocation = 0;
  const host = createKernelHost({ projectRoot: root, projectRegistryDir: path.join(root, "registry"),
    configLoader: async () => ({}), kernelFactory: createKernel, pushEvent: (event) => events.push(event),
    kernelOptions: { sessionLog: null, mcpPolicyStore: null, loadMcpConfigScopes: false,
      orchestration: { router: { model: { enabled: false } } },
      mcpServers: { input: { command: process.execPath, args: ["-e", scriptFor(expectedAnswer)], elicitation: { enabled: true },
        tools: { risk: { read_form: "read", read_stats: "read" } } } },
      modelGateway: {
        invoke: async (messages) => {
          modelMessages.push(structuredClone(messages));
          if (++invocation === 1) return { content: "", tool_calls: [{ id: "request-input", name: "mcp__input__read_form", arguments: { query: "original" } }] };
          return { content: "Input operation completed", tool_calls: [] };
        }, reply: async () => ({ content: "offline" })
      }
    }
  });
  const kernel = await host.init();
  t.after(async () => { host.dispose(); await kernel.dispose(); });
  return { host, kernel, events, modelMessages };
}

async function pendingInput(host) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const requests = await host.listMcpInputRequests();
    if (requests.length) return requests[0];
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("MCP tool did not expose a pending input form through the GUI host");
}

function assertPrivate(events, kernel, privateAnswer = answer) {
  const serialized = JSON.stringify(events);
  for (const value of [privateAnswer, JSON.stringify(privateAnswer).slice(1, -1), opaque, '"requestState"', '"inputResponses"']) {
    assert.ok(!serialized.includes(value), `private MCP data leaked through session events: ${value}`);
    assert.ok(!kernel.mcp.exportLogs().includes(value), `private MCP data leaked through diagnostics: ${value}`);
  }
  for (const event of events.filter((item) => item.type.startsWith("mcp:"))) assert.deepEqual(validateEvent(event.type, event).errors, []);
}

for (const [label, privateAnswer] of [["plain", answer], ["JSON-escaped", 'quoted"answer\\with\nnewline']]) {
test(`actual GUI host answers an ordinary agent MCP call once without exposing its ${label} input`, { timeout: 15000 }, async (t) => {
  const { host, kernel, events, modelMessages } = await fixture(t, privateAnswer);
  let finished = false;
  const operation = kernel.agent.send("Read the remote record", { autonomy: "read-only" });
  operation.then(() => { finished = true; }, () => { finished = true; });
  const request = await pendingInput(host);
  assert.equal(finished, false);
  assert.equal(request.serverId, "input");
  assert.equal(request.method, "elicitation/create");
  assert.equal(request.requestedSchema.properties.name.type, "string");
  assert.ok(!JSON.stringify(request).includes(opaque));
  await assert.rejects(host.respondMcpInputRequest(request.requestId, { action: "accept", content: { name: 42 } }));
  assert.equal((await host.listMcpInputRequests()).length, 1, "invalid answers must not consume the pending form");
  const responses = await Promise.allSettled([
    host.respondMcpInputRequest(request.requestId, { action: "accept", content: { name: privateAnswer } }),
    host.respondMcpInputRequest(request.requestId, { action: "accept", content: { name: "duplicate" } })
  ]);
  assert.equal(responses.filter((item) => item.status === "fulfilled" && item.value.status === "accepted").length, 1);
  assert.equal((await operation).status, "complete");
  assert.deepEqual(await host.listMcpInputRequests(), []);
  const toolText = modelMessages.flat().filter((message) => message.role === "tool").map((message) => message.content).join("\n");
  const toolResults = modelMessages.flat().filter((message) => message.role === "tool").map((message) => JSON.parse(JSON.parse(message.content).text));
  assert.ok(toolResults.some((result) => result.continuations === 1 && result.valid === true));
  assert.ok(!toolText.includes(privateAnswer), "input responses must not be copied into the model's tool messages");
  assert.ok(toolResults.every((result) => result.echo !== privateAnswer), "JSON-escaped answers must be redacted before serialization");
  assert.ok(events.some((event) => event.type === "mcp:input_required"));
  assert.ok(events.some((event) => event.type === "mcp:input_resolved" && event.status === "accepted"));
  assertPrivate(events, kernel, privateAnswer);
});
}

test("GUI trial cancellation removes its pending input without continuing or disconnecting the MCP server", { timeout: 15000 }, async (t) => {
  const { host, kernel, events } = await fixture(t);
  const runId = "cancel-pending-input";
  const operation = host.startMcpToolTest("input", "read_form", { query: "original" }, { requestId: runId });
  operation.catch(() => {}); // Keep fixture cleanup from creating an unhandled rejection if polling fails.
  const request = await pendingInput(host);
  assert.equal((await host.cancelMcpToolTest(runId)).cancelled, true);
  assert.equal((await operation).status, "cancelled");
  assert.deepEqual(await host.listMcpInputRequests(), []);
  const late = await Promise.allSettled([host.respondMcpInputRequest(request.requestId, { action: "accept", content: { name: answer } })]);
  assert.ok(late[0].status === "rejected" || late[0].value.status !== "accepted");
  const stats = await host.startMcpToolTest("input", "read_stats", {}, { requestId: "stats-after-cancel" });
  assert.equal(stats.status, "success");
  assert.match(stats.content[0].text, /"continuations":0/);
  assert.equal(kernel.mcp.listServers()[0].status, "CONNECTED");
  assert.ok(events.some((event) => event.type === "mcp:input_resolved" && event.status === "cancelled"));
  assertPrivate(events, kernel);
});

test("kernel shutdown immediately invalidates an ordinary GUI input form before asynchronous cleanup", { timeout: 15000 }, async (t) => {
  const { host, kernel, events } = await fixture(t);
  const operation = kernel.tools.execute({ id: "shutdown-input", name: "mcp__input__read_form", params: { query: "original" } }, { autonomy: "read-only" });
  operation.catch(() => {});
  const request = await pendingInput(host);
  const closing = kernel.dispose();
  // Exercise the synchronous shutdown boundary before any flush promise yields.
  const late = kernel.mcp.respondInputRequest(request.requestId, { action: "accept", content: { name: answer } });
  assert.notEqual(late.status, "accepted");
  assert.deepEqual(kernel.mcp.listInputRequests(), []);
  assert.equal((await operation).status, "error");
  await closing;
  assert.ok(events.some((event) => event.type === "mcp:input_resolved" && event.status === "cancelled"));
  const outbound = kernel.mcp.getLogs("input", { method: "tools/call" }).entries.filter((entry) => entry.kind === "frame" && entry.direction === "out");
  assert.equal(outbound.length, 1, "shutdown must not authorize a continuation");
  assertPrivate(events, kernel);
});
