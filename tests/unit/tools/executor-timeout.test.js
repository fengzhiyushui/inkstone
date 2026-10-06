import test from "node:test";
import assert from "node:assert/strict";
import { createToolExecutor } from "../../../src/tools/executor.js";
import { EventEmitter, getEventListeners } from "node:events";
import { JsonRpcClient } from "../../../src/tools/mcp/jsonrpc-client.js";

function fakeRegistry(execFn) {
  const def = {
    name: "slow",
    category: "read",
    risk_level: "low",
    execute: execFn,
    normalizeParams: (p) => p,
    resolveCategory: () => "read"
  };
  return {
    resolve: (name) => (name === "slow" ? def : null),
    secureToolCall: (call) => ({ ...call, category: "read", params: call.params || {} })
  };
}
const allowEngine = { decide: () => ({ decision: "allow", matched_rule: "test" }) };
const call = { id: "tc_1", name: "slow", params: {} };

test("tool exec times out into an error result", async () => {
  const registry = fakeRegistry(() => new Promise(() => {})); // 永不解决
  const executor = createToolExecutor({ registry, permissionEngine: allowEngine, defaultToolTimeoutMs: 20 });
  const result = await executor.execute(call, { turnId: "t1" });
  assert.equal(result.status, "error");
  assert.equal(result.metadata.timeout, true);
  assert.match(result.content[0].text, /timed out/i);
});

test("fast tool under timeout succeeds", async () => {
  const registry = fakeRegistry(async () => ({ status: "success", content: [{ type: "text", text: "done" }] }));
  const executor = createToolExecutor({ registry, permissionEngine: allowEngine, defaultToolTimeoutMs: 1000 });
  const result = await executor.execute(call, { turnId: "t1" });
  assert.equal(result.status, "success");
});

test("no timeout configured keeps current behavior", async () => {
  const registry = fakeRegistry(async () => ({ status: "success", content: [] }));
  const executor = createToolExecutor({ registry, permissionEngine: allowEngine });
  const result = await executor.execute(call, { turnId: "t1" });
  assert.equal(result.status, "success");
});

test("executor timeout preserves caller cancellation through RPC and leaves another call running", async (t) => {
  class Transport extends EventEmitter {
    sent = [];
    send(frame) { this.sent.push(frame); }
  }
  const transport = new Transport();
  const rpc = new JsonRpcClient({ transport });
  t.after(() => rpc.close());
  const registry = fakeRegistry(async (params, { signal }) => {
    await rpc.request("tools/call", params, { signal });
    return { content: [{ type: "text", text: "finished" }] };
  });
  const executor = createToolExecutor({ registry, permissionEngine: allowEngine, defaultToolTimeoutMs: 2000 });
  const controller = new AbortController();
  const cancelled = executor.execute(call, { signal: controller.signal });
  const continuing = executor.execute({ ...call, id: "other" });
  await Promise.resolve();
  assert.equal(transport.sent.length, 2);
  const [first, second] = transport.sent;
  controller.abort(new Error("user stopped this call"));
  const result = await cancelled;
  assert.equal(result.status, "error");
  assert.match(result.content[0].text, /user stopped this call/);
  assert.equal(result.metadata.timeout, undefined);
  assert.equal(transport.sent.at(-1).method, "notifications/cancelled");
  assert.equal(transport.sent.at(-1).params.requestId, first.id);
  assert.equal(rpc.getPendingCount(), 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  transport.emit("message", { jsonrpc: "2.0", id: second.id, result: {} });
  assert.equal((await continuing).status, "success");
  assert.equal(rpc.getPendingCount(), 0);
});

test("executor deadline reaches RPC as timeout and clears the caller signal listener", async (t) => {
  const transport = new EventEmitter();
  transport.send = () => {};
  const rpc = new JsonRpcClient({ transport });
  t.after(() => rpc.close());
  const completed = [];
  rpc.on("request_completed", (event) => completed.push(event));
  const registry = fakeRegistry(async (_params, { signal }) => rpc.request("tools/call", {}, { signal }));
  const executor = createToolExecutor({ registry, permissionEngine: allowEngine, defaultToolTimeoutMs: 20 });
  const controller = new AbortController();
  const result = await executor.execute(call, { signal: controller.signal });
  assert.equal(result.metadata.timeout, true);
  assert.equal(rpc.getPendingCount(), 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.deepEqual(completed.map((event) => event.status), ["timeout"]);
});

test("already-cancelled tools never execute, with or without a deadline", async () => {
  for (const timeout of [undefined, 1000]) {
    let executed = false;
    const registry = fakeRegistry(() => { executed = true; return { content: [] }; });
    const executor = createToolExecutor({ registry, permissionEngine: allowEngine, defaultToolTimeoutMs: timeout });
    const result = await executor.execute(call, { signal: AbortSignal.abort(new Error("cancelled before execution")) });
    assert.equal(result.status, "error");
    assert.equal(executed, false);
  }
});

test("caller cancellation ends an uncooperative tool without a deadline and normal completion removes listeners", async () => {
  const controller = new AbortController();
  const stalled = createToolExecutor({ registry: fakeRegistry(() => new Promise(() => {})), permissionEngine: allowEngine });
  const pending = stalled.execute(call, { signal: controller.signal });
  await Promise.resolve();
  controller.abort(new Error("cancelled without deadline"));
  assert.equal((await pending).status, "error");
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  for (const fail of [false, true]) {
    const signal = new AbortController().signal;
    const executor = createToolExecutor({ registry: fakeRegistry(async () => {
      if (fail) throw new Error("tool failed");
      return { content: [] };
    }), permissionEngine: allowEngine, defaultToolTimeoutMs: 1000 });
    assert.equal((await executor.execute(call, { signal })).status, fail ? "error" : "success");
    assert.equal(getEventListeners(signal, "abort").length, 0);
  }
});
