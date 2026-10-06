import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { checkedInputRequests, createMcpInputController, subscribeMcpInputChanges, subscribeMcpSubscriptionChanges } from "../../../gui/src/state/mcp-input-requests.js";
import { toolParameters } from "../../../gui/src/state/mcp-diagnostics.js";
import { translate } from "../../../gui/src/i18n/strings.js";

const require = createRequire(import.meta.url);
const { createKernelHost } = require("../../../gui/kernel-host.js");
const { inputResponse } = require("../../../gui/mcp-input-requests.js");
const read = (file) => readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8");
const requestId = "input-680340fd-49c1-45d0-985b-d7a9803c399e";
const descriptor = () => ({ requestId, serverId: "srv", method: "elicitation/create", message: "Enter a value",
  requestedSchema: { type: "object", properties: { id: { type: "string" } } }, createdAt: 100, expiresAt: 200 });
const deferred = () => { let resolve; const promise = new Promise((accept) => { resolve = accept; }); return { promise, resolve }; };
async function hostFor(mcp, config = {}) {
  const host = createKernelHost({ projectRoot: "/repo", configLoader: async () => config,
    kernelFactory: async () => ({ mcp, session: { subscribe: () => ({ unsubscribe() {} }) } }) });
  await host.init();
  return host;
}

test("input IPC exposes only safe descriptors and acknowledgements while preserving short-secret identifiers", async () => {
  const calls = [];
  const host = await hostFor({ hub: { oauthSecrets: new Set(["i", "private-token"]) },
    listInputRequests: () => [{ ...descriptor(), message: "private-token i", requestState: "opaque-state", inputResponses: { id: "hidden" },
      requestedSchema: { type: "object", required: ["id"], properties: { id: { type: "string", description: "private-token" } } } }],
    respondInputRequest: (...args) => { calls.push(args); return { requestId, serverId: "srv", status: "accepted", requestState: "opaque-state", content: { id: "private answer" } }; }
  });
  const requests = await host.listMcpInputRequests();
  assert.equal(requests[0].requestId, requestId);
  assert.equal(requests[0].method, "elicitation/create");
  assert.equal(requests[0].serverId, "srv");
  assert.equal(requests[0].requestedSchema.properties.id.type, "string");
  assert.deepEqual(requests[0].requestedSchema.required, ["id"]);
  assert.doesNotMatch(JSON.stringify(requests), /private-token|opaque-state|inputResponses|requestState/);
  const response = await host.respondMcpInputRequest(requestId, { action: "accept", content: { id: "private answer" }, requestState: "forged" });
  assert.deepEqual(calls, [[requestId, { action: "accept", content: { id: "private answer" } }]]);
  assert.deepEqual(response, { requestId, serverId: "srv", status: "accepted" });
});

test("input boundary rejects invalid data and does not echo submitted values through errors", async () => {
  const calls = [];
  const host = await hostFor({ listInputRequests: () => [{ ...descriptor(), requestedSchema: [] }],
    respondInputRequest: (...args) => { calls.push(args); throw new Error("could not use ordinary-private-answer"); } });
  await assert.rejects(host.listMcpInputRequests(), /operation failed/);
  await assert.rejects(host.respondMcpInputRequest(requestId, { action: "accept", content: { city: "ordinary-private-answer" } }),
    (error) => !error.message.includes("ordinary-private-answer"));
  assert.equal(calls.length, 1);
  for (const value of [null, [], "text", 12]) assert.throws(() => inputResponse(requestId, { action: "accept", content: value }), /object/);
  assert.throws(() => inputResponse("../invalid", { action: "cancel" }), /request ID/);
  assert.throws(() => inputResponse(requestId, { action: "auto" }), /action/);
  assert.throws(() => inputResponse(requestId, { action: "accept", content: { value: "x".repeat(65537) } }), /limit/);
  assert.deepEqual(inputResponse(requestId, { action: "decline", content: { id: "do not send" } }), { action: "decline" });
  assert.deepEqual(inputResponse(requestId, { action: "cancel", requestState: "do not send" }), { action: "cancel" });
});

test("private input descriptors preserve executable constraints after short answers while scrubbing descriptions", async () => {
  const schema = { type: "object", properties: {
    count: { type: "integer", minimum: 1, maximum: 10, title: "c1", description: "c1" },
    choice: { type: "string", enum: ["cat", "dog"] },
    exact: { type: "string", oneOf: [{ const: "cat", title: "c1" }] },
    address: { type: "string", format: "email", minLength: 1, maxLength: 100 }
  }, required: ["count", "choice"] };
  const host = await hostFor({ hub: { inputSecrets: new Set(["c", "1"]) },
    listInputRequests: () => [{ ...descriptor(), requestedSchema: schema }] });
  const result = (await host.listMcpInputRequests())[0].requestedSchema;
  assert.equal(result.properties.count.minimum, 1);
  assert.equal(result.properties.count.maximum, 10);
  assert.deepEqual(result.properties.choice.enum, ["cat", "dog"]);
  assert.equal(result.properties.exact.oneOf[0].const, "cat");
  assert.equal(result.properties.address.format, "email");
  assert.equal(result.properties.address.minLength, 1);
  assert.equal(result.properties.address.maxLength, 100);
  assert.deepEqual(result.required, ["count", "choice"]);
  assert.match(result.properties.count.description, /REDACTED/);
  assert.match(result.properties.exact.oneOf[0].title, /REDACTED/);
});

test("global pending input controller never auto-submits, deduplicates explicit responses and clears resolved forms", async () => {
  const pending = deferred();
  const calls = [];
  let requests = [descriptor()];
  let state;
  const controller = createMcpInputController({ onState: (value) => { state = value; }, kernel: {
    listMcpInputRequests: async () => requests,
    respondMcpInputRequest: (...args) => { calls.push(args); return pending.promise; }
  } });
  await controller.refresh();
  assert.equal(state.requests.length, 1);
  assert.equal(calls.length, 0);
  const response = controller.respond(requestId, "accept", { id: "answer" });
  assert.equal(await controller.respond(requestId, "accept", { id: "duplicate" }), false);
  assert.deepEqual(calls, [[requestId, { action: "accept", content: { id: "answer" } }]]);
  assert.doesNotMatch(JSON.stringify(state), /answer|duplicate/);
  requests = [];
  pending.resolve({ status: "accepted", requestId });
  assert.equal(await response, true);
  assert.equal(state.requests.length, 0);
  assert.equal(state.busyId, null);
  controller.dispose();
});

test("resolved input cannot be resurrected by a stale list or an unmounted completion", async () => {
  const stale = deferred();
  let calls = 0;
  let state;
  const states = [];
  const controller = createMcpInputController({ onState: (value) => { state = value; states.push(value); }, kernel: {
    listMcpInputRequests: () => ++calls === 1 ? [descriptor()] : calls === 2 ? stale.promise : [],
    respondMcpInputRequest: async (_id, response) => { assert.deepEqual(response, { action: "cancel" }); return { status: "cancelled" }; }
  } });
  await controller.refresh();
  const oldList = controller.refresh();
  await controller.respond(requestId, "cancel", { ignored: true });
  stale.resolve([descriptor()]);
  await oldList;
  assert.deepEqual(state.requests, []);
  controller.dispose();
  const count = states.length;
  await controller.refresh();
  assert.equal(states.length, count);
});

test("input failures retain the pending form without storing answers or backend error text", async () => {
  let state;
  const controller = createMcpInputController({ onState: (value) => { state = value; }, kernel: {
    listMcpInputRequests: () => [descriptor()],
    respondMcpInputRequest: async () => { throw new Error("private-answer"); }
  } });
  await controller.refresh();
  assert.equal(await controller.respond(requestId, "accept", { id: "private-answer" }), false);
  assert.equal(state.requests.length, 1);
  assert.equal(state.error, true);
  assert.equal(state.busyId, null);
  assert.doesNotMatch(JSON.stringify(state), /private-answer/);
  controller.dispose();
});

test("input subscriptions refresh on required and resolved events and detach on disposal", async () => {
  let listener;
  let count = 0;
  let detached = false;
  const dispose = subscribeMcpInputChanges({ onKernelEvent: (fn) => { listener = fn; return () => { detached = true; }; } }, () => { count++; });
  listener({ type: "mcp:log" });
  listener({ type: "mcp:input_required", requestState: "must not forward" });
  listener({ type: "mcp:input_resolved" });
  assert.equal(count, 2);
  dispose();
  assert.equal(detached, true);
  assert.deepEqual(checkedInputRequests([]), []);
  for (const value of [null, {}, [null], [{ ...descriptor(), requestedSchema: null }]]) assert.throws(() => checkedInputRequests(value), /response/);
});

test("catalog subscription status refreshes independently of input forms and both features start disabled", () => {
  let listener;
  let count = 0;
  const dispose = subscribeMcpSubscriptionChanges({ onKernelEvent: (fn) => { listener = fn; return () => {}; } }, () => { count++; });
  listener({ type: "mcp:input_required" });
  listener({ type: "mcp:subscription_status" });
  assert.equal(count, 1);
  dispose();
  const source = read("gui/src/components/v4/SecondaryViews.jsx");
  assert.match(source, /\[elicitationEnabled, setElicitationEnabled\] = React.useState\(false\)/);
  assert.match(source, /\[subscriptionsEnabled, setSubscriptionsEnabled\] = React.useState\(false\)/);
  assert.equal(source.split("subscriptionsEnabled ? { subscriptions: { enabled: true } }").length - 1, 2);
  assert.equal(source.split("elicitationEnabled ? { elicitation: { enabled: true } }").length - 1, 2);
  for (const lang of ["zh", "en"]) for (const key of ["enable", "enableHint", "status.active", "status.error"]) {
    assert.notEqual(translate(lang, `mcp.subscriptions.${key}`), `mcp.subscriptions.${key}`);
  }
});

test("elicitation uses blank forms and requires explicit outbound confirmation in all views", () => {
  const schema = { type: "object", required: ["id"], properties: { id: { type: "string", default: "never-auto-send" } } };
  assert.throws(() => toolParameters(schema, {}), /required/);
  assert.deepEqual(toolParameters({ type: "object", properties: schema.properties }, {}), {});
  assert.deepEqual(toolParameters({}, {}, "{}"), {});
  const source = read("gui/src/components/v4/McpInputRequests.jsx");
  assert.match(source, /disabled=\{busy \|\| !confirmed\}/);
  assert.match(source, /if \(!confirmed \|\| busy\) return/);
  assert.match(source, /setConfirmed\(false\)/);
  assert.match(source, /role="dialog"/);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML|\bfetch\s*\(|localStorage|sessionStorage|requestState|inputResponses/);
  const app = read("gui/src/App.jsx");
  assert.match(app, /<McpInputRequests key=\{state.currentProject/);
  assert.match(app, /hasModal = Boolean\(settingsOpen \|\| state.sensitiveNotice \|\| mcpInputOpen\)/);
  for (const lang of ["zh", "en"]) for (const key of ["title", "confirmHint", "confirm", "submit", "decline", "cancel", "invalid", "enableHint"]) {
    assert.notEqual(translate(lang, `mcp.input.${key}`), `mcp.input.${key}`);
  }
});

test("input request IPC and hook methods are allowlisted without exposing continuation state", async () => {
  let bridge;
  const calls = [];
  vm.runInNewContext(read("gui/preload.js"), { require: () => ({ contextBridge: { exposeInMainWorld: (_name, api) => { bridge = api; } },
    ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve({}); } } }) });
  for (const [method, channel] of Object.entries({ listMcpInputRequests: "mcp:input-requests", respondMcpInputRequest: "mcp:input-respond" })) {
    await bridge[method](requestId, { action: "decline" }, "ignored");
    assert.equal(calls.at(-1)[0], channel);
    assert.ok(read("gui/main.js").includes(`handle("${channel}"`));
    assert.ok(read("gui/main.js").split("function cleanupSmoke")[0].includes(`"${channel}"`));
    assert.ok(read("gui/src/hooks/useKernel.js").includes(`${method}:`));
  }
  assert.deepEqual(calls[0], ["mcp:input-requests"]);
  assert.deepEqual(calls[1], ["mcp:input-respond", requestId, { action: "decline" }]);
});
