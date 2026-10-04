import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "../helpers/tmp.js";

import { tmpdir } from "node:os";
import path from "node:path";
import { createKernel } from "../../src/index.js";

test("v2 createKernel exposes agent, session, context, and config facades", async () => {
  const kernel = await createKernel(process.cwd(), {
    sessionId: "sess_integration",
    sessionLog: null,
    branchStore: null,
    context: { disabled: true },
    modelGateway: {
      reply: async () => ({ content: "facade response" })
    }
  });

  assert.equal(typeof kernel.agent.send, "function");
  assert.equal(typeof kernel.agent.approve, "function");
  assert.equal(typeof kernel.agent.interrupt, "function");
  assert.equal(typeof kernel.session.subscribe, "function");
  assert.equal(typeof kernel.session.getTimeline, "function");
  assert.equal(typeof kernel.context.snapshot, "function");
  assert.equal(typeof kernel.config.getPublicConfig, "function");
});

test("v2 kernel facade sends a turn and streams events to subscribers", async () => {
  const kernel = await createKernel(process.cwd(), {
    sessionId: "sess_integration",
    sessionLog: null,
    branchStore: null,
    context: { disabled: true },
    modelGateway: {
      reply: async ({ classification }) => ({
        content: `facade ${classification.task_type}`
      })
    }
  });

  const events = [];
  const sub = kernel.session.subscribe((event) => events.push(event));

  const result = await kernel.agent.send("what is this?", { autonomy: "auto" });
  sub.unsubscribe();

  assert.equal(result.content, "facade query");
  assert.ok(events.some((event) => event.type === "user:message"));
  assert.ok(events.some((event) => event.type === "agent:turn_started"));
  assert.ok(events.some((event) => event.type === "agent:step"));
  assert.ok(events.some((event) => event.type === "agent:final"));
});

test("v2 kernel context and config return safe public data", async () => {
  const kernel = await createKernel("C:/example/project", {
    sessionId: "sess_safe",
    sessionLog: null,
    branchStore: null,
    context: { disabled: true }
  });

  const snapshot = await kernel.context.snapshot();
  const publicConfig = kernel.config.getPublicConfig();

  assert.equal(snapshot.snapshot_id, "v2_context_disabled");
  assert.deepEqual(snapshot.units, []);
  assert.equal(publicConfig.runtime, "v2");
  assert.equal(publicConfig.has_api_key, false);
});

test("session subscriber event type is never overwritten by payload fields", async () => {
  const kernel = await createKernel(process.cwd(), {
    sessionId: "sess_type_test",
    sessionLog: null,
    branchStore: null,
    context: { disabled: true },
    modelGateway: { reply: async () => ({ content: "ok", type: "payload_overwrite" }) }
  });

  const events = [];
  const sub = kernel.session.subscribe((event) => events.push(event));

  kernel.eventBus.publish("agent:final", { turn_id: "t1", content: "done", type: "should_not_win" });
  sub.unsubscribe();

  const finalEvent = events.find(e => e.type === "agent:final");
  assert.ok(finalEvent, "agent:final should be received");
  assert.equal(finalEvent.type, "agent:final");
  assert.equal(finalEvent.content, "done");
  assert.equal(finalEvent.turn_id, "t1");
});

test("v2 kernel exposes branch facade and stamps active branch events", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-v2-branch-facade-"));
  const kernel = await createKernel(root, {
    sessionId: "sess_branch_facade",
    sessionRoot: path.join(root, ".sessions"),
    context: { disabled: true },
    modelGateway: { reply: async () => ({ content: "ok" }) }
  });

  assert.equal(typeof kernel.session.branches.list, "function");
  assert.equal(typeof kernel.session.branches.getActive, "function");
  const active = await kernel.session.branches.getActive();
  assert.equal(active.branch_id, "br_main");

  const child = await kernel.session.branches.create({
    parent_branch_id: "br_main",
    forked_from_seq: 1,
    label: "test branch"
  });
  await kernel.session.branches.activate(child.branch_id);

  const events = [];
  const sub = kernel.session.subscribe((event) => events.push(event));
  await kernel.agent.send("hello?", { autonomy: "auto" });
  sub.unsubscribe();

  assert.ok(events.some((event) => event.type === "user:message" && event.branch_id === child.branch_id));
});
