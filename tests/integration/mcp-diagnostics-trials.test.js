import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { readFile, readdir } from "node:fs/promises";
import { createKernel } from "../../src/index.js";
import { mkdtemp } from "../helpers/tmp.js";
import { validateEvent } from "../../src/sessions/event-schemas.js";
import { SESSION_EVENT_TYPES } from "../../src/sessions/event-types.js";

const secret = "trial-private-token-18462";
const script = `
const rl = require('readline').createInterface({input:process.stdin});
let writes = 0;
rl.on('line', line => {
 const msg=JSON.parse(line); if(msg.id===undefined)return;
 let result;
 if(msg.method==='server/discover')result={era:'modern',supportedVersions:['2026-07-28'],capabilities:{tools:{}}};
 else if(msg.method==='tools/list')result={tools:['read_count','write_note','delete_all','read_wait'].map(name=>({name,description:name,inputSchema:{type:'object',properties:{text:{type:'string'},password:{type:'string'},nested:{type:'object',properties:{n:{type:'integer',minimum:1}},required:['n']}},additionalProperties:false}}))};
 else if(msg.method==='tools/call'){
  if(msg.params.name==='read_wait')return;
  if(msg.params.name==='write_note')writes++;
  result={content:[{type:'text',text:JSON.stringify({writes,args:msg.params.arguments,secret:'${secret}'})}]};
 } else return;
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result})+'\\n');
});`;

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "inkstone-v116-"));
  const kernel = await createKernel(root, { sessionLog: null, mcpPolicyStore: null,
    mcpServers: { trial: { command: process.execPath, args: ["-e", script], env: { API_TOKEN: secret }, tools: { risk: { delete_all: "destructive" } } } },
    modelGateway: { invoke: async () => ({ content: "offline", tool_calls: [] }) }, ...options });
  t.after(() => kernel.dispose());
  return { kernel, root };
}

test("kernel trial validates nested schemas and binds approval to a cloned one-shot call", async (t) => {
  const { kernel } = await fixture(t);
  const events = [];
  const subscriptions = SESSION_EVENT_TYPES.map((type) => kernel.eventBus.subscribe(type, (event) => events.push({ type, ...event })));
  t.after(() => subscriptions.forEach((subscription) => subscription.unsubscribe()));
  const invalid = await kernel.mcp.startToolTest("trial", "write_note", { nested: { n: 0 } });
  assert.equal(invalid.status, "error");
  assert.match(invalid.content[0].text, /Invalid tool arguments/);
  const params = { text: "original", password: "trial-input-only-secret-92381" };
  const pending = kernel.mcp.startToolTest("trial", "write_note", params, { requestId: "test-once" });
  params.text = "changed";
  const ask = await pending;
  assert.equal(ask.status, "approval_required");
  assert.equal(ask.runId, "test-once");
  const approved = kernel.mcp.approveToolTest(ask.runId);
  assert.throws(() => kernel.mcp.approveToolTest(ask.runId), /No pending/);
  const result = await approved;
  assert.equal(result.status, "success");
  assert.match(result.content[0].text, /original/);
  assert.doesNotMatch(result.content[0].text, /changed/);
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.ok(!JSON.stringify(result).includes("trial-input-only-secret-92381"), "approved results must still redact secrets from the original trial arguments");
  assert.ok(result.metadata.durationMs >= 0);
  assert.throws(() => kernel.mcp.startToolTest("trial", "write_note", {}, { requestId: "test-once" }), /duplicate/);
  assert.equal((await kernel.mcp.startToolTest("trial", "write_note", {})).status, "approval_required", "approval must not persist");
  const denied = await kernel.mcp.startToolTest("trial", "delete_all", {});
  assert.equal(denied.status, "denied");
  assert.throws(() => kernel.mcp.approveToolTest(denied.runId), /No pending/);
  assert.ok(events.some((event) => event.type === "mcp:tool_test"));
  assert.ok(events.every((event) => !event.type.startsWith("approval:")), "standalone trials must not pause the agent conversation");
  for (const event of events.filter((event) => event.type.startsWith("mcp:"))) assert.deepEqual(validateEvent(event.type, event).errors, []);
});

test("kernel trial cancellation aborts in-flight RPC and history is readable by a fresh offline kernel", async (t) => {
  const { kernel, root } = await fixture(t);
  const pending = kernel.mcp.startToolTest("trial", "read_wait", {}, { requestId: "cancel-me" });
  // Wait for actual send, so this tests transport cancellation rather than just preflight.
  const deadline = Date.now() + 2000;
  while (!kernel.mcp.getLogs("trial", { method: "tools/call" }).entries.some((entry) => entry.direction === "out")) {
    assert.ok(Date.now() < deadline); await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const cancelled = kernel.mcp.cancelToolTest("cancel-me");
  assert.equal(cancelled.cancelled, true);
  assert.equal((await pending).status, "cancelled");
  assert.equal(kernel.mcp.listServers()[0].status, "CONNECTED");
  assert.equal((await kernel.mcp.startToolTest("trial", "read_count", {})).status, "success");
  assert.ok(kernel.mcp.getLogs("trial", { category: "cancelled" }).entries.length > 0);
  await kernel.dispose();
  const offline = await createKernel(root, { sessionLog: null, mcpPolicyStore: null, autoInitMcp: false,
    mcpServers: { trial: { command: "THIS-MUST-NOT-START" } },
    modelGateway: { invoke: async () => ({ content: "offline", tool_calls: [] }) } });
  t.after(() => offline.dispose());
  assert.equal(offline.mcp.hub.clients.size, 0);
  const logs = offline.mcp.getLogs("trial", { limit: 500 });
  assert.ok(logs.entries.some((entry) => entry.kind === "request" && entry.durationMs >= 0));
  assert.ok(!offline.mcp.exportLogs().includes(secret));
  const directory = path.join(root, ".deepseek-code", "mcp-logs");
  for (const file of await readdir(directory)) assert.ok(!(await readFile(path.join(directory, file), "utf8")).includes(secret));
});

test("pending trial approvals expire on server lifecycle changes", async (t) => {
  const { kernel } = await fixture(t);
  let pending = await kernel.mcp.startToolTest("trial", "write_note", {});
  const name = (await kernel.mcp.listTools("trial")).find((tool) => tool.originalName === "write_note").name;
  // A replaced registry definition must invalidate the secured call.
  const old = kernel.tools.registry.resolve(name);
  kernel.tools.registry.mountExternalTools("trial", [{ ...old }]);
  assert.equal((await kernel.mcp.approveToolTest(pending.runId)).status, "error");
  await kernel.mcp.restartServer("trial");
  pending = await kernel.mcp.startToolTest("trial", "write_note", {});
  await kernel.mcp.toggleServer("trial", false);
  assert.throws(() => kernel.mcp.approveToolTest(pending.runId), /No pending/);
  assert.deepEqual(await kernel.mcp.listTools("trial"), []);
  const stopped = await kernel.mcp.startToolTest("trial", "write_note", {}, { approved: true });
  assert.equal(stopped.status, "error");
});

test("trial approval rechecks current configured denies and cannot authorize unrelated tools", async (t) => {
  const rules = [];
  const { kernel } = await fixture(t, { projectRules: rules });
  const pending = await kernel.mcp.startToolTest("trial", "write_note", {});
  assert.equal(pending.status, "approval_required");
  const tools = await kernel.mcp.listTools("trial");
  const name = tools.find((tool) => tool.originalName === "write_note").name;
  rules.push({ id: "deny-trial-write", tool: name, decision: "deny" });
  const denied = await kernel.mcp.approveToolTest(pending.runId);
  assert.equal(denied.status, "denied");
  assert.equal((await kernel.mcp.startToolTest("trial", "write_note", {}, { approved: true })).status, "denied");
  assert.equal((await kernel.mcp.startToolTest("trial", "read_file", {})).status, "error");
  const count = await kernel.mcp.startToolTest("trial", "read_count", {});
  assert.match(count.content[0].text, /"writes":0/);
});
