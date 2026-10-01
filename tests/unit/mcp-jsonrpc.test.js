import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { JsonRpcClient, JSONRPC_ERRORS } from "../../src/tools/mcp/jsonrpc-client.js";

class MockTransport extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
  }

  send(msg) {
    this.sent.push(msg);
  }
}

test("JsonRpcClient handles request and response successfully", async () => {
  const transport = new MockTransport();
  const client = new JsonRpcClient({ transport });

  const promise = client.request("testMethod", { foo: "bar" });
  assert.equal(transport.sent.length, 1);
  const sent = transport.sent[0];
  assert.equal(sent.jsonrpc, "2.0");
  assert.equal(sent.method, "testMethod");
  assert.deepEqual(sent.params, { foo: "bar" });
  assert.ok(sent.id > 0);

  // Simulate server response
  transport.emit("message", {
    jsonrpc: "2.0",
    id: sent.id,
    result: { answer: 42 }
  });

  const result = await promise;
  assert.deepEqual(result, { answer: 42 });
  assert.equal(client.getPendingCount(), 0);
});

test("JsonRpcClient rejects when server returns an error response", async () => {
  const transport = new MockTransport();
  const client = new JsonRpcClient({ transport });

  const promise = client.request("failMethod", {});
  const sent = transport.sent[0];

  transport.emit("message", {
    jsonrpc: "2.0",
    id: sent.id,
    error: {
      code: JSONRPC_ERRORS.METHOD_NOT_FOUND,
      message: "Method not found",
      data: { hint: "check method name" }
    }
  });

  await assert.rejects(
    async () => await promise,
    (err) => {
      assert.equal(err.code, JSONRPC_ERRORS.METHOD_NOT_FOUND);
      assert.equal(err.message, "Method not found");
      assert.deepEqual(err.data, { hint: "check method name" });
      return true;
    }
  );
  assert.equal(client.getPendingCount(), 0);
});

test("JsonRpcClient times out when no response is received", async () => {
  const transport = new MockTransport();
  const client = new JsonRpcClient({ transport, defaultTimeoutMs: 50 });

  await assert.rejects(
    async () => await client.request("hangingMethod", {}, { timeoutMs: 30 }),
    (err) => {
      assert.equal(err.code, JSONRPC_ERRORS.TIMEOUT);
      assert.match(err.message, /timed out after 30ms/);
      return true;
    }
  );
  assert.equal(client.getPendingCount(), 0);
});

test("JsonRpcClient sends and receives notifications", async () => {
  const transport = new MockTransport();
  const client = new JsonRpcClient({ transport });

  // Outgoing notification
  client.notify("status/update", { ready: true });
  assert.equal(transport.sent.length, 1);
  const sent = transport.sent[0];
  assert.equal(sent.jsonrpc, "2.0");
  assert.equal(sent.method, "status/update");
  assert.equal(sent.id, undefined);
  assert.deepEqual(sent.params, { ready: true });

  // Incoming notification
  let receivedNotification = null;
  client.on("notification:ping", (params) => {
    receivedNotification = params;
  });

  transport.emit("message", {
    jsonrpc: "2.0",
    method: "ping",
    params: { time: 12345 }
  });

  assert.deepEqual(receivedNotification, { time: 12345 });
});

test("JsonRpcClient aborts pending requests on transport close", async () => {
  const transport = new MockTransport();
  const client = new JsonRpcClient({ transport });

  const promise1 = client.request("req1", {});
  const promise2 = client.request("req2", {});
  assert.equal(client.getPendingCount(), 2);

  transport.emit("close", { code: 1, signal: null });

  await assert.rejects(
    async () => await promise1,
    (err) => {
      assert.equal(err.code, JSONRPC_ERRORS.SERVER_DISCONNECTED);
      return true;
    }
  );
  await assert.rejects(
    async () => await promise2,
    (err) => {
      assert.equal(err.code, JSONRPC_ERRORS.SERVER_DISCONNECTED);
      return true;
    }
  );
  assert.equal(client.getPendingCount(), 0);
});
