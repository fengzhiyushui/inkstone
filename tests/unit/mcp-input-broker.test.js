import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, getEventListeners } from "node:events";
import { createMcpInputBroker } from "../../src/tools/mcp/input-broker.js";
import { createMcpDisplayRedactor, sanitizeMcpSchema } from "../../src/security/mcp-content.js";
import { inputFields, parseInputField } from "../../src/apps/mcp-input-form.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const form = (message = "Enter a value") => ({ method: "elicitation/create", params: { mode: "form", message,
  requestedSchema: { type: "object", properties: { value: { type: "string", minLength: 1 } }, required: ["value"] } } });
const required = (requests = { value: form() }, requestState = "opaque-private-state") => ({ resultType: "input_required", inputRequests: requests, requestState });
const accepted = (value = "private-response") => ({ action: "accept", content: { value } });

function fixture(t) {
  const hub = new EventEmitter();
  const client = { getStatus: () => "CONNECTED" };
  const config = { command: "mock", elicitation: { enabled: true, timeoutMs: 1000 }, disabled: false };
  const tool = { name: "mcp__server__read", originalName: "read", serverId: "server", category: "read" };
  hub.clients = new Map([["server", client]]);
  hub.serverConfigs = new Map([["server", config]]);
  hub.serverTools = new Map([["server", [tool]]]);
  hub.toolRegistry = { resolve: (name) => (hub.serverTools.get("server") || []).find((item) => item.name === name) || null };
  hub._stopping = new Set(); hub._authRequired = new Set();
  const broker = createMcpInputBroker({ hub });
  const events = [];
  for (const name of ["input_required", "input_resolved"]) hub.on(name, (event) => events.push({ name, ...event }));
  t.after(() => broker.cancelAll());
  function start(result = required(), options = {}) {
    const controller = new AbortController();
    const promise = broker.request({ serverId: "server", method: "tools/call", params: { name: "read", arguments: {} }, result, signal: controller.signal, ...options }, options.client || client);
    const outcome = promise.then((value) => ({ value }), (error) => ({ error }));
    return { promise, outcome, controller };
  }
  return { hub, client, config, tool, broker, events, start };
}

test("broker requires explicit acceptance, isolates values from events and rejects duplicate submission", async (t) => {
  const { hub, broker, events, start } = fixture(t);
  const run = start(required({ value: form("Continue opaque-private-state") }));
  const [pending] = broker.list();
  assert.ok(pending.requestId);
  assert.equal(pending.message, "Continue [REDACTED]");
  assert.equal(getEventListeners(run.controller.signal, "abort").length, 1);
  assert.equal(broker.respond(pending.requestId, accepted()).status, "accepted");
  assert.equal(broker.respond(pending.requestId, accepted()).status, "not_found");
  const result = (await run.outcome).value;
  assert.equal(result.inputResponses.value.content.value, "private-response");
  assert.deepEqual(broker.list(), []);
  assert.equal(getEventListeners(run.controller.signal, "abort").length, 0);
  const text = JSON.stringify(events);
  assert.equal(text.includes("opaque-private-state"), false);
  assert.equal(text.includes("private-response"), false);
  assert.equal(text.includes("requestedSchema"), false);
  assert.equal(createMcpDisplayRedactor({ hub })("opaque-private-state private-response"), "[REDACTED] [REDACTED]");
});

test("broker preserves every server key including prototype-like keys and each action", async (t) => {
  const { broker, start } = fixture(t);
  const requests = Object.fromEntries([["__proto__", form()], ["constructor", form()], ["normal", form()]]);
  const run = start(required(requests));
  const responses = [accepted("first-value"), { action: "decline", content: { ignored: "not-retained" } }, { action: "cancel" }];
  for (const response of responses) {
    assert.equal(broker.list().length, 1);
    broker.respond(broker.list()[0].requestId, response);
    await tick();
  }
  const result = (await run.outcome).value.inputResponses;
  assert.equal(Object.getPrototypeOf(result), null);
  assert.deepEqual(Object.keys(result), ["__proto__", "constructor", "normal"]);
  assert.deepEqual(result.__proto__, responses[0]);
  assert.deepEqual(result.constructor, { action: "decline" });
  assert.deepEqual(result.normal, { action: "cancel" });
  assert.equal({}.value, undefined);
});

test("sequential short answers cannot corrupt the next private form's selectable values or bounds", async (t) => {
  const { hub, broker, start } = fixture(t);
  const numeric = form();
  numeric.params.requestedSchema = { type: "object", properties: { value: { type: "integer" } }, required: ["value"] };
  const later = form("Choose c, then enter 1");
  later.params.requestedSchema = { type: "object", properties: {
    choice: { type: "string", enum: ["c", "d"], description: "c", default: "c" },
    titled: { type: "string", oneOf: [{ const: "c", title: "c" }, { const: "d", title: "d" }] },
    count: { type: "integer", minimum: 1, maximum: 3 },
    length: { type: "string", minLength: 1, maxLength: 3 },
    date: { type: "string", format: "date" }
  }, required: ["choice", "titled", "count", "length", "date"] };
  const run = start(required({ first: form(), numeric, later }));
  broker.respond(broker.list()[0].requestId, accepted("c"));
  await tick();
  broker.respond(broker.list()[0].requestId, accepted(1));
  await tick();
  const [pending] = broker.list();
  const fields = inputFields(pending);
  const raw = ["c", "c", "1", "c", "2026-10-06"];
  const content = Object.fromEntries(fields.map((field, index) => [field.name, parseInputField(field, raw[index]).value]));
  assert.deepEqual(pending.requestedSchema.properties.choice.enum, ["c", "d"]);
  assert.equal(pending.requestedSchema.properties.titled.oneOf[0].const, "c");
  assert.equal(pending.requestedSchema.properties.count.minimum, 1);
  assert.equal(pending.requestedSchema.properties.length.minLength, 1);
  assert.equal(pending.requestedSchema.properties.choice.description, "[REDACTED]");
  assert.equal(pending.requestedSchema.properties.choice.default, "[REDACTED]");
  assert.equal(broker.respond(pending.requestId, { action: "accept", content }).status, "accepted");
  assert.equal((await run.outcome).value.inputResponses.later.content.choice, "c");
  const publicSchema = sanitizeMcpSchema(later.params.requestedSchema, createMcpDisplayRedactor({ hub }));
  assert.equal(publicSchema.properties.choice.enum[0], "[REDACTED]", "general tool-schema presentation keeps its prior privacy boundary");
});

test("state-only continuation has its own explicit empty form and never exposes state", async (t) => {
  const { broker, start } = fixture(t);
  const run = start({ resultType: "input_required", requestState: "state-only-private" });
  const [pending] = broker.list();
  assert.deepEqual(JSON.parse(JSON.stringify(pending.requestedSchema)), { type: "object", properties: {} });
  assert.equal(JSON.stringify(pending).includes("state-only-private"), false);
  broker.respond(pending.requestId, { action: "accept", content: {} });
  assert.deepEqual((await run.outcome).value, {});
});

for (const action of ["decline", "cancel"]) test(`state-only ${action} cannot silently retry`, async (t) => {
  const { broker, start } = fixture(t);
  const run = start({ resultType: "input_required", requestState: "opaque" });
  broker.respond(broker.list()[0].requestId, { action });
  assert.equal((await run.outcome).error.code, "MCP_INPUT_CANCELLED");
});

for (const unsupported of ["sampling/createMessage", "roots/list", "url"]) test(`broker rejects ${unsupported} before presenting any preceding valid form`, async (t) => {
  const { broker, events, start } = fixture(t);
  const blocked = unsupported === "url" ? { method: "elicitation/create", params: { mode: "url", message: "Visit", url: "https://example.com/private" } } : { method: unsupported, params: {} };
  const run = start(required({ first: form(), blocked }));
  assert.equal((await run.outcome).error.code, "MCP_INPUT_UNSUPPORTED");
  assert.deepEqual(broker.list(), []);
  assert.deepEqual(events, []);
});

test("invalid submitted values stay pending and errors do not echo input", async (t) => {
  const { broker, start } = fixture(t);
  const run = start();
  const id = broker.list()[0].requestId;
  for (const response of [{ action: "unknown" }, { action: "accept", content: { wrong: "secret-value" } }, { action: "accept", content: { value: "" } }]) {
    assert.throws(() => broker.respond(id, response), (error) => error.code === "MCP_INPUT_INVALID" && !error.message.includes("secret-value"));
    assert.equal(broker.list().length, 1);
  }
  broker.respond(id, accepted());
  assert.ok((await run.outcome).value);
});

for (const change of ["disable", "remove", "replace_config", "mutate_config", "replace_client", "stopping", "auth_required"]) test(`broker rejects stale approval after ${change}`, async (t) => {
  const { hub, config, broker, start } = fixture(t);
  const run = start();
  const id = broker.list()[0].requestId;
  if (change === "disable") config.disabled = true;
  else if (change === "remove") hub.serverConfigs.delete("server");
  else if (change === "replace_config") hub.serverConfigs.set("server", { ...config });
  else if (change === "mutate_config") config.command = "replacement";
  else if (change === "replace_client") hub.clients.set("server", {});
  else if (change === "stopping") hub._stopping.add("server");
  else hub._authRequired.add("server");
  assert.equal(broker.respond(id, accepted()).status, "cancelled");
  assert.equal((await run.outcome).error.code, "MCP_INPUT_STALE");
  assert.deepEqual(broker.list(), []);
});

test("broker listing settles stale requests so an obsolete form cannot remain actionable", async (t) => {
  const { hub, broker, start } = fixture(t);
  const run = start();
  hub.clients.delete("server");
  assert.deepEqual(broker.list(), []);
  assert.equal((await run.outcome).error.code, "MCP_INPUT_STALE");
});

for (const change of ["replace", "remove", "registry_replace"]) test(`broker cannot authorize a tool whose mounted identity changed: ${change}`, async (t) => {
  const { hub, tool, broker, start } = fixture(t);
  const run = start();
  const id = broker.list()[0].requestId;
  if (change === "replace") hub.serverTools.set("server", [{ ...tool, category: "destructive" }]);
  else if (change === "remove") hub.serverTools.set("server", []);
  else hub.toolRegistry.resolve = () => ({ ...tool, category: "destructive" });
  assert.equal(broker.respond(id, accepted()).status, "cancelled");
  assert.equal((await run.outcome).error.code, "MCP_INPUT_STALE");
  assert.deepEqual(broker.list(), []);
});

test("broker checks mounted tool identity again after acceptance before continuing", async (t) => {
  const { hub, tool, broker, start } = fixture(t);
  const run = start();
  const id = broker.list()[0].requestId;
  broker.respond(id, accepted());
  hub.serverTools.set("server", [{ ...tool }]);
  assert.equal((await run.outcome).error.code, "MCP_INPUT_STALE");
});

for (const mode of ["signal", "server", "all"]) test(`broker ${mode} cancellation settles once and removes signal listeners`, async (t) => {
  const { broker, events, start } = fixture(t);
  const run = start();
  const id = broker.list()[0].requestId;
  if (mode === "signal") run.controller.abort();
  else if (mode === "server") broker.cancelServer("server");
  else broker.cancelAll();
  assert.equal((await run.outcome).error.code, "MCP_INPUT_CANCELLED");
  assert.equal(getEventListeners(run.controller.signal, "abort").length, 0);
  assert.equal(broker.respond(id, accepted()).status, "not_found");
  assert.equal(events.filter((event) => event.name === "input_resolved").length, 1);
});

test("broker accepts no disabled, already-aborted, oversized or structurally invalid requests", async (t) => {
  const { config, broker, start } = fixture(t);
  config.elicitation.enabled = false;
  assert.equal((await start().outcome).error.code, "MCP_INPUT_DISABLED");
  config.elicitation.enabled = true;
  const controller = new AbortController(); controller.abort();
  assert.equal((await start(required(), { signal: controller.signal }).outcome).error.code, "MCP_INPUT_CANCELLED");
  const invalid = [{ resultType: "input_required" }, required({}, 123), required([], "state"), required(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [String(i), form()]))), required({ value: form("x".repeat(65537)) })];
  for (const result of invalid) assert.equal((await start(result).outcome).error.code, "MCP_INPUT_INVALID");
  assert.deepEqual(broker.list(), []);
});

test("broker rejects accessors and cycles without invoking serialization hooks", async (t) => {
  const { start } = fixture(t);
  let calls = 0;
  const accessor = required(); Object.defineProperty(accessor, "trap", { enumerable: true, get() { calls++; return "sensitive"; } });
  const cycle = required(); cycle.cycle = cycle;
  assert.equal((await start(accessor).outcome).error.code, "MCP_INPUT_INVALID");
  assert.equal((await start(cycle).outcome).error.code, "MCP_INPUT_INVALID");
  assert.equal(calls, 0);
});

test("broker pending limit is bounded and cancellation clears every queued request", async (t) => {
  const { broker, start } = fixture(t);
  const runs = Array.from({ length: 32 }, () => start());
  assert.equal(broker.list().length, 32);
  assert.equal((await start().outcome).error.code, "MCP_INPUT_LIMIT");
  broker.cancelAll();
  const results = await Promise.all(runs.map((run) => run.outcome));
  assert.ok(results.every((result) => result.error.code === "MCP_INPUT_CANCELLED"));
  assert.deepEqual(broker.list(), []);
});

test("broker expiry settles waiting request and prevents a late acceptance", async (t) => {
  const { broker, events, start } = fixture(t);
  const run = start();
  const id = broker.list()[0].requestId;
  // Broker timers intentionally do not keep the application alive.
  const keepAlive = setTimeout(() => {}, 1500);
  try {
    assert.equal((await run.outcome).error.code, "MCP_INPUT_EXPIRED");
    assert.equal(broker.respond(id, accepted()).status, "not_found");
    assert.equal(events.at(-1).status, "expired");
    assert.equal(getEventListeners(run.controller.signal, "abort").length, 0);
  } finally { clearTimeout(keepAlive); }
});

test("broker refuses new secret values after its bounded privacy budget is consumed", async (t) => {
  const { broker, start } = fixture(t);
  let rejected = false;
  for (let index = 0; index < 34; index++) {
    const run = start();
    const id = broker.list()[0].requestId;
    try {
      broker.respond(id, accepted(`${index}-` + "x".repeat(16370)));
      assert.ok((await run.outcome).value);
    } catch (error) {
      assert.equal(error.code, "MCP_INPUT_LIMIT");
      assert.equal(error.message.includes("xxxx"), false);
      broker.cancelAll();
      await run.outcome;
      rejected = true;
      break;
    }
  }
  assert.equal(rejected, true);
});
