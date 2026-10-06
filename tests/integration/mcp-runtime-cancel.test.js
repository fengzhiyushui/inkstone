import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { createKernel } from "../../src/index.js";
import { mkdtemp } from "../helpers/tmp.js";

const script = `
const rl=require('node:readline').createInterface({input:process.stdin});
const held=new Set();
const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
rl.on('line',line=>{const m=JSON.parse(line);if(m.id==null)return;
 if(m.method==='server/discover')return send(m.id,{era:'modern',supportedVersions:['2026-07-28'],capabilities:{tools:{}}});
 if(m.method==='tools/list')return send(m.id,{tools:['read_wait','write_wait','read_hold','read_release'].map(name=>({name,inputSchema:{type:'object'}}))});
 if(m.method==='tools/call'){
  if(m.params.name==='read_wait'||m.params.name==='write_wait')return;
  if(m.params.name==='read_hold'){held.add(m.id);return;}
  for(const id of held)send(id,{content:[{type:'text',text:'unrelated request finished'}]});
  held.clear();send(m.id,{content:[]});
 }
});`;

async function fixture(t, toolName = "read_wait") {
  const root = await mkdtemp(path.join(tmpdir(), "inkstone-runtime-cancel-"));
  let modelCalls = 0;
  const kernel = await createKernel(root, { sessionLog: null, mcpPolicyStore: null,
    mcpServers: { blocking: { command: process.execPath, args: ["-e", script], tools: {
      risk: { read_wait: "read", write_wait: "mutate", read_hold: "read", read_release: "read" }
    } } },
    modelGateway: {
      invoke: async () => {
        modelCalls++;
        return { content: "", tool_calls: [{ id: "agent-wait", name: `mcp__blocking__${toolName}`, arguments: {} }] };
      },
      reply: async () => ({ content: "new turn is usable" })
    }
  });
  t.after(() => kernel.dispose());
  return { kernel, client: kernel.mcp.hub.getServer("blocking"), modelCalls: () => modelCalls };
}

function whenSent(client, name) {
  return new Promise((resolve) => {
    const listener = ({ direction, frame }) => {
      if (direction !== "out" || frame.method !== "tools/call" || frame.params.name !== name) return;
      client.removeListener("trace", listener);
      resolve(frame);
    };
    client.on("trace", listener);
  });
}

for (const resumed of [false, true]) {
  test(`agent interrupt cancels real stdio MCP ${resumed ? "after approval resume" : "during execution"}, preserving another request`, { timeout: 10_000 }, async (t) => {
    const name = resumed ? "write_wait" : "read_wait";
    const { kernel, client, modelCalls } = await fixture(t, name);
    const heldSent = whenSent(client, "read_hold");
    const unrelated = kernel.mcp.callTool("mcp__blocking__read_hold", {});
    await heldSent;
    const waitingSent = whenSent(client, name);
    let operation;
    if (resumed) {
      const paused = await kernel.agent.send("inspect remote data", { autonomy: "supervised" });
      assert.equal(paused.status, "awaiting_approval");
      operation = kernel.agent.approve(paused.approval.id, "approve");
    } else operation = kernel.agent.send("inspect remote data", { autonomy: "supervised" });
    const rejected = assert.rejects(operation, { code: "INTERRUPTED" });
    const frame = await waitingSent;
    assert.equal(client.rpc.getPendingCount(), 2);
    kernel.agent.interrupt();
    // Start a new turn before the cancelled promise finishes unwinding.
    const next = kernel.agent.send("what is a request?");
    await rejected;
    assert.equal((await next).status, "complete");
    assert.equal(client.rpc.getPendingCount(), 1);
    assert.equal(client.getStatus(), "CONNECTED");
    assert.equal(modelCalls(), 1, "interruption must stop before another model call");
    const completion = kernel.mcp.getLogs("blocking", { method: "tools/call", category: "cancelled" }).entries;
    assert.ok(completion.some((entry) => entry.requestId === String(frame.id)));
    await kernel.mcp.callTool("mcp__blocking__read_release", {});
    assert.match(await unrelated, /unrelated request finished/);
    assert.equal(client.rpc.getPendingCount(), 0);
  });
}

test("public kernel.tools.execute forwards caller cancellation into actual MCP RPC", { timeout: 10_000 }, async (t) => {
  const { kernel, client } = await fixture(t);
  const controller = new AbortController();
  const sent = whenSent(client, "read_wait");
  const operation = kernel.tools.execute({ id: "public-tool", name: "mcp__blocking__read_wait", params: {} }, {
    signal: controller.signal, toolTimeoutMs: 5000
  });
  await sent;
  controller.abort(new Error("public caller stopped"));
  const result = await operation;
  assert.equal(result.status, "error");
  assert.match(result.content[0].text, /public caller stopped/);
  assert.equal(client.rpc.getPendingCount(), 0);
  assert.equal(client.getStatus(), "CONNECTED");
});
