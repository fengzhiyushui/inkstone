import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "../helpers/tmp.js";

import { tmpdir } from "node:os";
import path from "node:path";
import { createKernel } from "../../src/index.js";

test("kernel session timeline persists events from an agent turn", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-v2-session-"));
  const sessionRoot = path.join(root, ".sessions");
  const kernel = await createKernel(root, {
    sessionRoot,
    sessionId: "sess_timeline",
    modelGateway: {
      reply: async () => ({ content: "timeline response" })
    }
  });

  const result = await kernel.agent.send("what is this?", { autonomy: "auto" });
  await kernel.session.flush();
  const timeline = await kernel.session.getTimeline(20);

  assert.equal(result.status, "complete");
  assert.ok(timeline.some((event) => event.type === "session:start"));
  assert.ok(timeline.some((event) => event.type === "user:message" && event.content === "what is this?"));
  assert.ok(timeline.some((event) => event.type === "agent:turn_started"));
  assert.ok(timeline.some((event) => event.type === "agent:step"));
  assert.ok(timeline.some((event) => event.type === "agent:final" && event.content === "timeline response"));
});

test("kernel session timeline can reopen an existing session", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-v2-session-"));
  const sessionRoot = path.join(root, ".sessions");
  const first = await createKernel(root, {
    sessionRoot,
    sessionId: "sess_reopen",
    modelGateway: { reply: async () => ({ content: "first" }) }
  });
  await first.agent.send("first question", { autonomy: "auto" });
  await first.session.flush();

  const second = await createKernel(root, {
    sessionRoot,
    sessionId: "sess_reopen",
    modelGateway: { reply: async () => ({ content: "second" }) }
  });
  await second.agent.send("second question", { autonomy: "auto" });
  await second.session.flush();

  const timeline = await second.session.getTimeline(50);
  assert.equal(timeline.filter((event) => event.type === "session:start").length, 1);
  assert.ok(timeline.some((event) => event.type === "user:message" && event.content === "first question"));
  assert.ok(timeline.some((event) => event.type === "user:message" && event.content === "second question"));
  assert.ok(timeline.at(-1).seq > 1);
});
