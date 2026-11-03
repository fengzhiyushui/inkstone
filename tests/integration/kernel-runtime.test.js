// tests/integration/kernel-runtime.test.js — 内核运行时集成(门面/循环/上下文/修复/恢复/时间线/用量)领域测试
//
// v1.19.1 测试归并:本文件由下列历史任务单测试合并而成,每个来源包裹在独立
// describe 块中(异步回调 + 动态 import,来源间零共享绑定),测试语义与拆分前一致。
import { describe } from "node:test";

// ---------------------------------------------------------------------------
// 来源:tests/integration/v2-kernel-facade.test.js
// ---------------------------------------------------------------------------
describe("integration/v2-kernel-facade", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { mkdtemp } = await import("../helpers/tmp.js");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { createKernel } = await import("../../src/index.js");

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
});

// ---------------------------------------------------------------------------
// 来源:tests/integration/v2-runtime-loop.test.js
// ---------------------------------------------------------------------------
describe("integration/v2-runtime-loop", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { readFile, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { createKernel } = await import("../../src/index.js");
  const { mkdtemp } = await import("../helpers/tmp.js");

  test("runtime loop executes read tool and feeds result back to model", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-loop-"));
    await writeFile(path.join(root, "README.md"), "hello runtime loop");
    let invokeCount = 0;
    const kernel = await createKernel(root, {
      sessionId: "sess_loop_read",
      modelGateway: {
        invoke: async (messages) => {
          invokeCount++;
          if (invokeCount === 1) {
            return { content: "", tool_calls: [{ id: "call_read", name: "read", arguments: { path: "README.md" } }] };
          }
          assert.ok(messages.some((message) => message.role === "tool" && message.content.includes("hello runtime loop")));
          return { content: "README says hello runtime loop", tool_calls: [] };
        },
        reply: async () => ({ content: "query fast path" })
      }
    });

    const result = await kernel.agent.send("inspect README", { autonomy: "gated" });

    assert.equal(result.status, "complete");
    assert.equal(result.content, "README says hello runtime loop");
    assert.equal(invokeCount, 2);
  });

  test("runtime loop executes edit tool and verifier after edit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-loop-edit-"));
    await writeFile(path.join(root, "a.txt"), "old\n");
    let invokeCount = 0;
    const diff = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new";
    const events = [];
    const kernel = await createKernel(root, {
      sessionId: "sess_loop_edit",
      modelGateway: {
        invoke: async () => {
          invokeCount++;
          if (invokeCount === 1) {
            return { content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff, prompt: "update a" } }] };
          }
          return { content: "updated a.txt", tool_calls: [] };
        },
        reply: async () => ({ content: "query fast path" })
      }
    });
    const sub = kernel.session.subscribe((event) => events.push(event));

    const result = await kernel.agent.send("modify a.txt", { autonomy: "gated" });
    sub.unsubscribe();

    assert.equal(result.status, "complete");
    assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "new\n");
    assert.ok(events.some((event) => event.type === "file:diff_applied"));
    assert.ok(events.some((event) => event.type === "verification:result"));
  });

  test("runtime loop stops for approval and does not write", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-loop-approval-"));
    await writeFile(path.join(root, "a.txt"), "old\n");
    const diff = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new";
    const kernel = await createKernel(root, {
      sessionId: "sess_loop_approval",
      modelGateway: {
        invoke: async () => ({ content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff } }] }),
        reply: async () => ({ content: "query fast path" })
      }
    });

    const result = await kernel.agent.send("modify a.txt", { autonomy: "supervised" });

    assert.equal(result.status, "awaiting_approval");
    assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "old\n");
  });

  test("runtime loop completes normally when verifier runs with auto autonomy", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-loop-verify-"));
    await writeFile(path.join(root, "a.txt"), "old\n");
    const diff = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new";
    let invokeCount = 0;
    const kernel = await createKernel(root, {
      sessionId: "sess_loop_verify",
      modelGateway: {
        invoke: async () => {
          invokeCount++;
          if (invokeCount === 1) {
            return { content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff, prompt: "update a" } }] };
          }
          return { content: "updated", tool_calls: [] };
        },
        reply: async () => ({ content: "query fast path" })
      }
    });

    // gated autonomy: verifier now runs with auto so detect-only test won't hang on approval
    const result = await kernel.agent.send("modify a.txt", { autonomy: "gated" });

    assert.equal(result.status, "complete");
    assert.ok(result.verification, "verification result must be present");
    assert.equal(result.verification.status, "passed");
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/integration/v2-runtime-context.test.js
// ---------------------------------------------------------------------------
describe("integration/v2-runtime-context", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { createKernel } = await import("../../src/index.js");
  const { mkdtemp } = await import("../helpers/tmp.js");

  test("runtime first tool-loop model call receives context summary", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-runtime-context-"));
    await writeFile(path.join(root, "package.json"), "{\"name\":\"demo\"}\n");
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "index.js"), "export const demo = true;\n");
    let firstMessages = null;
    const kernel = await createKernel(root, {
      sessionRoot: path.join(root, ".sessions"),
      modelGateway: {
        invoke: async (messages) => {
          firstMessages = firstMessages || messages;
          return { content: "done", tool_calls: [] };
        },
        reply: async () => ({ content: "query" })
      }
    });

    const result = await kernel.agent.send("modify src/index.js", { autonomy: "gated" });

    assert.equal(result.status, "complete");
    assert.ok(firstMessages[0].content.includes("Project context:"));
    assert.ok(firstMessages[0].content.includes("src/index.js"));
  });

  test("runtime query fast path receives context summary", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-runtime-query-context-"));
    await writeFile(path.join(root, "README.md"), "# query context\n");
    let receivedContext = null;
    const kernel = await createKernel(root, {
      sessionRoot: path.join(root, ".sessions"),
      modelGateway: {
        reply: async ({ context }) => {
          receivedContext = context;
          return { content: "answer" };
        },
        invoke: async () => ({ content: "slow", tool_calls: [] })
      }
    });

    const result = await kernel.agent.send("what is this project?");

    assert.equal(result.status, "complete");
    assert.ok(receivedContext.summary.includes("README.md"));
    assert.equal(receivedContext.channel, "reply");
  });

  test("repair prompt receives context summary from runtime", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-runtime-repair-context-"));
    await writeFile(path.join(root, "package.json"), "{\"scripts\":{\"test\":\"node --test\"}}\n");
    await writeFile(path.join(root, "a.txt"), "old\n");
    let repairPayload = null;
    let invokeCount = 0;
    const diff = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+broken";
    const kernel = await createKernel(root, {
      sessionRoot: path.join(root, ".sessions"),
      verifyMode: "run",
      maxRepairAttempts: 1,
      modelGateway: {
        invoke: async (messages, options = {}) => {
          if (options.purpose === "repair") {
            repairPayload = JSON.parse(messages[1].content);
            return { content: "no repair", tool_calls: [] };
          }
          invokeCount += 1;
          if (invokeCount === 1) {
            return { content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff, prompt: "break a" } }] };
          }
          return { content: "done", tool_calls: [] };
        },
        reply: async () => ({ content: "query" })
      },
      testArgv: ["node", "-e", "process.exit(1)"]
    });

    await assert.rejects(
      () => kernel.agent.send("modify a.txt", { autonomy: "gated", verifyMode: "run" }),
      /verification failed|repair/i
    );

    assert.ok(repairPayload.context_summary.includes("package.json"));
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/integration/v2-repair-loop.test.js
// ---------------------------------------------------------------------------
describe("integration/v2-repair-loop", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { readFile, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { createKernel } = await import("../../src/index.js");
  const { createEventBus } = await import("../../src/shared/event-bus.js");
  const { createEditService } = await import("../../src/edits/edit-service.js");
  const { createBuiltinTools } = await import("../../src/tools/builtin/index.js");
  const { createToolRegistry } = await import("../../src/tools/registry.js");
  const { mkdtemp } = await import("../helpers/tmp.js");

  const BROKEN_DIFF = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+broken";
  const REPAIR_DIFF = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-broken\n+fixed";

  function createKernelWithFakeTest(root, { modelGateway, testResults, sessionId }) {
    const eventBus = createEventBus();
    let testRuns = 0;
    const editService = createEditService({ projectRoot: root, eventBus });
    const fakeTestTool = {
      name: "test",
      description: "Fake integration test runner",
      category: "execute",
      side_effect: "process",
      risk_level: "low",
      source: "test",
      version: "2.0",
      params: {
        detect: { type: "boolean", required: false, default: true },
        argv: { type: "array", required: false }
      },
      execute: async () => {
        const next = testResults[Math.min(testRuns, testResults.length - 1)];
        testRuns += 1;
        return {
          status: "success",
          content: [{ type: "text", text: next.text }],
          metadata: { exit_code: next.exit_code, run: testRuns }
        };
      }
    };
    const tools = createBuiltinTools({ editService }).filter((tool) => tool.name !== "test");
    const toolRegistry = createToolRegistry({ tools: [...tools, fakeTestTool] });

    return createKernel(root, {
      eventBus,
      editService,
      toolRegistry,
      sessionRoot: path.join(root, ".sessions"),
      sessionId,
      verifyMode: "run",
      maxRepairAttempts: 1,
      modelGateway
    });
  }

  test("kernel repair loop applies repair edit after failed verification", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-repair-loop-"));
    await writeFile(path.join(root, "a.txt"), "old\n");
    let invokeCount = 0;
    const kernel = await createKernelWithFakeTest(root, {
      sessionId: "sess_repair_loop",
      testResults: [
        { exit_code: 1, text: "failed" },
        { exit_code: 0, text: "passed" }
      ],
      modelGateway: {
        invoke: async (_messages, options = {}) => {
          if (options.purpose === "repair") {
            return { content: "", tool_calls: [{ id: "call_repair", name: "edit", arguments: { diff: REPAIR_DIFF, prompt: "repair a" } }] };
          }
          invokeCount += 1;
          if (invokeCount === 1) {
            return { content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: BROKEN_DIFF, prompt: "break a" } }] };
          }
          return { content: "done", tool_calls: [] };
        },
        reply: async () => ({ content: "fast" })
      }
    });

    const result = await kernel.agent.send("modify a.txt", { autonomy: "gated", verifyMode: "run" });

    assert.equal(result.status, "complete");
    assert.equal(result.verification.status, "passed");
    assert.equal(result.repair.status, "complete");
    assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "fixed\n");
  });

  test("repair timeline persists repair events", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-repair-timeline-"));
    await writeFile(path.join(root, "a.txt"), "old\n");
    let invokeCount = 0;
    const kernel = await createKernelWithFakeTest(root, {
      sessionId: "sess_repair_timeline",
      testResults: [
        { exit_code: 1, text: "failed" },
        { exit_code: 1, text: "still failed" }
      ],
      modelGateway: {
        invoke: async (_messages, options = {}) => {
          if (options.purpose === "repair") {
            return { content: "no repair", tool_calls: [] };
          }
          invokeCount += 1;
          if (invokeCount === 1) {
            return { content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: BROKEN_DIFF, prompt: "break a" } }] };
          }
          return { content: "done", tool_calls: [] };
        },
        reply: async () => ({ content: "fast" })
      }
    });

    await assert.rejects(
      () => kernel.agent.send("modify a.txt", { autonomy: "gated", verifyMode: "run" }),
      /verification failed|repair/i
    );
    await kernel.session.flush();
    const types = (await kernel.session.getTimeline(50)).map((event) => event.type);

    assert.ok(types.includes("repair:started"));
    assert.ok(types.includes("repair:attempt"));
    assert.ok(types.includes("repair:result"));
    assert.ok(types.includes("repair:exhausted"));
  });

  test("query fast path does not enter repair loop", async () => {
    let invokeCalled = false;
    const kernel = await createKernel(process.cwd(), {
      sessionLog: null,
      context: { disabled: true },
      modelGateway: {
        reply: async () => ({ content: "query answer" }),
        invoke: async () => {
          invokeCalled = true;
          return { content: "tool path" };
        }
      }
    });

    const result = await kernel.agent.send("what is this project?");

    assert.equal(result.status, "complete");
    assert.equal(result.content, "query answer");
    assert.equal(invokeCalled, false);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/integration/v2-approval-resume.test.js
// ---------------------------------------------------------------------------
describe("integration/v2-approval-resume", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { readFile, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { createKernel } = await import("../../src/index.js");
  const { mkdtemp } = await import("../helpers/tmp.js");

  const DIFF = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new";

  test("kernel approval resumes supervised edit and applies file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-approval-resume-"));
    await writeFile(path.join(root, "a.txt"), "old\n");
    let invokeCount = 0;
    const events = [];
    const kernel = await createKernel(root, {
      sessionRoot: path.join(root, ".sessions"),
      sessionId: "sess_approval_resume",
      modelGateway: {
        invoke: async () => {
          invokeCount += 1;
          if (invokeCount === 1) {
            return { content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: DIFF, prompt: "update a" } }] };
          }
          return { content: "updated a.txt", tool_calls: [] };
        },
        reply: async () => ({ content: "fast" })
      }
    });
    const sub = kernel.session.subscribe((event) => events.push(event));

    const paused = await kernel.agent.send("modify a.txt", { autonomy: "supervised" });
    assert.equal(paused.status, "awaiting_approval");
    assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "old\n");

    const resumed = await kernel.agent.approve(paused.approval.id, "approve");
    sub.unsubscribe();

    assert.equal(resumed.status, "complete");
    assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "new\n");
    assert.ok(events.some((event) => event.type === "approval:requested"));
    assert.ok(events.some((event) => event.type === "approval:resolved"));
    assert.ok(events.some((event) => event.type === "tool:result" && event.result?.status === "success"));
    assert.ok(events.some((event) => event.type === "agent:final"));
  });

  test("kernel approval deny leaves file unchanged", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-approval-deny-"));
    await writeFile(path.join(root, "a.txt"), "old\n");
    const kernel = await createKernel(root, {
      sessionRoot: path.join(root, ".sessions"),
      sessionId: "sess_approval_deny",
      modelGateway: {
        invoke: async () => ({ content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: DIFF, prompt: "update a" } }] }),
        reply: async () => ({ content: "fast" })
      }
    });

    const paused = await kernel.agent.send("modify a.txt", { autonomy: "supervised" });
    const denied = await kernel.agent.approve(paused.approval.id, "deny");

    assert.equal(denied.status, "cancelled");
    assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "old\n");
  });

  test("kernel rejects duplicate approval", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-approval-duplicate-"));
    await writeFile(path.join(root, "a.txt"), "old\n");
    let invokeCount = 0;
    const kernel = await createKernel(root, {
      sessionRoot: path.join(root, ".sessions"),
      sessionId: "sess_approval_duplicate",
      modelGateway: {
        invoke: async () => {
          invokeCount += 1;
          if (invokeCount === 1) {
            return { content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: DIFF, prompt: "update a" } }] };
          }
          return { content: "done", tool_calls: [] };
        },
        reply: async () => ({ content: "fast" })
      }
    });

    const paused = await kernel.agent.send("modify a.txt", { autonomy: "supervised" });
    await kernel.agent.approve(paused.approval.id, "approve");

    await assert.rejects(
      () => kernel.agent.approve(paused.approval.id, "approve"),
      /approval not found/
    );
  });

  test("approval resume timeline persists requested resolved tool and final events", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-approval-timeline-"));
    await writeFile(path.join(root, "a.txt"), "old\n");
    let invokeCount = 0;
    const kernel = await createKernel(root, {
      sessionRoot: path.join(root, ".sessions"),
      sessionId: "sess_approval_timeline",
      modelGateway: {
        invoke: async () => {
          invokeCount += 1;
          if (invokeCount === 1) {
            return { content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: DIFF, prompt: "update a" } }] };
          }
          return { content: "updated", tool_calls: [] };
        },
        reply: async () => ({ content: "fast" })
      }
    });

    const paused = await kernel.agent.send("modify a.txt", { autonomy: "supervised" });
    await kernel.agent.approve(paused.approval.id, "approve");
    await kernel.session.flush();
    const timeline = await kernel.session.getTimeline(50);
    const types = timeline.map((event) => event.type);

    assert.ok(types.includes("approval:requested"));
    assert.ok(types.includes("approval:resolved"));
    assert.ok(types.includes("tool:result"));
    assert.ok(types.includes("agent:final"));
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/integration/v2-durable-paused-turn.test.js
// ---------------------------------------------------------------------------
describe("integration/v2-durable-paused-turn", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { readFile, stat, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { createKernel } = await import("../../src/index.js");
  const { createPausedTurnPersistence } = await import("../../src/core/recovery/paused-turn-persistence.js");
  const { createRecoveryFaults } = await import("../../src/core/recovery/recovery-faults.js");
  const { mkdtemp } = await import("../helpers/tmp.js");

  const DIFF = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new";

  test("paused sidecar stores original autonomy and project id for resume", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-durable-pause-"));
    await writeFile(path.join(root, "a.txt"), "old\n");
    const kernel = await createKernel(root, {
      sessionRoot: path.join(root, ".deepseek-code", "v2", "sessions"),
      sessionId: "sess_original",
      projectId: "proj_test",
      recovery: { enabled: true, surface: "cli", lock: false },
      modelGateway: {
        invoke: async () => ({ content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: DIFF, prompt: "update" } }] }),
        reply: async () => ({ content: "fast" })
      }
    });

    const paused = await kernel.agent.send("modify", { autonomy: "supervised" });
    const items = await kernel.recovery.list();
    const sidecar = await createPausedTurnPersistence({ root, projectId: "proj_test" }).load(paused.approval.id);

    assert.equal(paused.status, "awaiting_approval");
    assert.equal(items[0].type, "paused_turn");
    assert.equal(items[0].source_id, paused.approval.id);
    assert.equal(items[0].metadata.autonomy, "supervised");
    assert.equal(sidecar.permission_context.autonomy, "supervised");
    assert.equal(sidecar.permission_context.project_id, "proj_test");
  });

  test("recovery facade rehydrates paused sidecar and resumes under stored context", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-durable-rehydrate-"));
    await writeFile(path.join(root, "a.txt"), "old\n");
    const first = await createKernel(root, {
      sessionRoot: path.join(root, ".deepseek-code", "v2", "sessions"),
      sessionId: "sess_original",
      projectId: "proj_test",
      recovery: { enabled: true, surface: "cli", lock: false },
      modelGateway: {
        invoke: async () => ({ content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: DIFF, prompt: "update" } }] }),
        reply: async () => ({ content: "fast" })
      }
    });

    const paused = await first.agent.send("modify", { autonomy: "supervised" });
    const second = await createKernel(root, {
      sessionRoot: path.join(root, ".deepseek-code", "v2", "sessions"),
      sessionId: "sess_restart",
      projectId: "proj_test",
      recovery: { enabled: true, surface: "cli", lock: false },
      modelGateway: {
        invoke: async () => ({ content: "updated", tool_calls: [] }),
        reply: async () => ({ content: "fast" })
      }
    });

    const resumed = await second.recovery.resume(`rec_pause_${paused.approval.id}`);
    const items = await second.recovery.list();
    const timeline = await second.session.getTimeline({ count: 100, all_branches: true });

    assert.equal(resumed.status, "resumed");
    assert.equal(resumed.result.status, "complete");
    assert.deepEqual(items, []);
    assert.ok(timeline.some((event) => event.type === "turn:resumed" && event.approval_id === paused.approval.id));
    assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "new\n");
  });

  test("recovery facade quarantines corrupt paused sidecar on cancel", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-durable-corrupt-cancel-"));
    const store = createPausedTurnPersistence({ root, projectId: "proj_test" });
    await store.writeRawForTest("approval_bad", "{ bad json");
    const kernel = await createKernel(root, {
      sessionRoot: path.join(root, ".deepseek-code", "v2", "sessions"),
      sessionId: "sess_corrupt",
      projectId: "proj_test",
      recovery: { enabled: true, surface: "cli", lock: false },
      modelGateway: {
        invoke: async () => ({ content: "unused", tool_calls: [] }),
        reply: async () => ({ content: "fast" })
      }
    });

    const items = await kernel.recovery.list();
    const cancelled = await kernel.recovery.cancel("rec_pause_approval_bad", "operator cancelled corrupt sidecar");
    const sourceExists = await exists(path.join(store.baseDir, "approval_bad.json"));
    const quarantineExists = await exists(path.join(store.baseDir, "quarantine", "approval_bad.json"));

    assert.equal(items[0].status, "blocked");
    assert.deepEqual(items[0].allowed_actions, ["cancel"]);
    assert.equal(cancelled.status, "quarantined");
    assert.equal(sourceExists, false);
    assert.equal(quarantineExists, true);
  });

  test("recovery facade does not rehydrate consumed paused sidecar after delete failure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-durable-consumed-"));
    await writeFile(path.join(root, "a.txt"), "old\n");
    const faults = createRecoveryFaults({ labels: ["before-paused-sidecar-delete"] });
    const first = await createKernel(root, {
      sessionRoot: path.join(root, ".deepseek-code", "v2", "sessions"),
      sessionId: "sess_original",
      projectId: "proj_test",
      recovery: { enabled: true, surface: "cli", faults },
      modelGateway: {
        invoke: async () => ({ content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: DIFF, prompt: "update" } }] }),
        reply: async () => ({ content: "fast" })
      }
    });

    const paused = await first.agent.send("modify", { autonomy: "supervised", maxToolIterations: 1 });
    await assert.rejects(
      () => first.agent.approve(paused.approval.id, "approve"),
      /maximum tool iterations exceeded/
    );

    const store = createPausedTurnPersistence({ root, projectId: "proj_test" });
    const scanned = await store.scan();
    const second = await createKernel(root, {
      sessionRoot: path.join(root, ".deepseek-code", "v2", "sessions"),
      sessionId: "sess_restart",
      projectId: "proj_test",
      recovery: { enabled: true, surface: "cli", lock: false },
      modelGateway: {
        invoke: async () => ({ content: "unused", tool_calls: [] }),
        reply: async () => ({ content: "fast" })
      }
    });

    const items = await second.recovery.list();
    await assert.rejects(
      () => second.recovery.resume(`rec_pause_${paused.approval.id}`),
      /approval not found/
    );

    assert.equal(scanned[0].status, "consumed");
    assert.equal(scanned[0].approval_id, paused.approval.id);
    assert.deepEqual(items, []);
    assert.equal(faults.hitCount("before-paused-sidecar-delete"), 1);
  });

  test("recovery facade does not rehydrate denied paused sidecar after delete failure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-durable-denied-"));
    await writeFile(path.join(root, "a.txt"), "old\n");
    const faults = createRecoveryFaults({ labels: ["before-paused-sidecar-delete"] });
    const first = await createKernel(root, {
      sessionRoot: path.join(root, ".deepseek-code", "v2", "sessions"),
      sessionId: "sess_original",
      projectId: "proj_test",
      recovery: { enabled: true, surface: "cli", faults },
      modelGateway: {
        invoke: async () => ({ content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: DIFF, prompt: "update" } }] }),
        reply: async () => ({ content: "fast" })
      }
    });

    const paused = await first.agent.send("modify", { autonomy: "supervised" });
    const denied = await first.agent.approve(paused.approval.id, "deny");

    const store = createPausedTurnPersistence({ root, projectId: "proj_test" });
    const scanned = await store.scan();
    const second = await createKernel(root, {
      sessionRoot: path.join(root, ".deepseek-code", "v2", "sessions"),
      sessionId: "sess_restart",
      projectId: "proj_test",
      recovery: { enabled: true, surface: "cli", lock: false },
      modelGateway: {
        invoke: async () => ({ content: "unused", tool_calls: [] }),
        reply: async () => ({ content: "fast" })
      }
    });

    const items = await second.recovery.list();
    await assert.rejects(
      () => second.recovery.resume(`rec_pause_${paused.approval.id}`),
      /approval not found/
    );

    assert.equal(denied.status, "cancelled");
    assert.equal(scanned[0].status, "consumed");
    assert.equal(scanned[0].approval_id, paused.approval.id);
    assert.deepEqual(items, []);
    assert.equal(faults.hitCount("before-paused-sidecar-delete"), 1);
    assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "old\n");
  });

  async function exists(filePath) {
    try {
      await stat(filePath);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }
});

// ---------------------------------------------------------------------------
// 来源:tests/integration/v2-session-timeline.test.js
// ---------------------------------------------------------------------------
describe("integration/v2-session-timeline", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { mkdtemp } = await import("../helpers/tmp.js");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { createKernel } = await import("../../src/index.js");

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
});

// ---------------------------------------------------------------------------
// 来源:tests/integration/v2-branching-rewind.test.js
// ---------------------------------------------------------------------------
describe("integration/v2-branching-rewind", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { readFile, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { createKernel } = await import("../../src/index.js");
  const { createToolCall } = await import("../../src/core/protocol/index.js");
  const { mkdtemp } = await import("../helpers/tmp.js");

  const DIFF_A = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old a\n+new a";
  const DIFF_B = "diff --git a/b.txt b/b.txt\n--- a/b.txt\n+++ b/b.txt\n@@ -1 +1 @@\n-old b\n+new b";

  test("kernel rewind preview and apply create child branch and rollback later edits", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-v2-rewind-"));
    await writeFile(path.join(root, "a.txt"), "old a\n");
    await writeFile(path.join(root, "b.txt"), "old b\n");
    const kernel = await createKernel(root, {
      sessionRoot: path.join(root, ".sessions"),
      sessionId: "sess_rewind",
      context: { disabled: true }
    });

    kernel.eventBus.publish("user:message", { turn_id: "turn_1", content: "edit a" });
    await kernel.tools.execute(
      createToolCall({ name: "edit", params: { diff: DIFF_A, prompt: "edit a" }, requestedByStepId: "step_1" }),
      { autonomy: "gated", turnId: "turn_1" }
    );
    kernel.eventBus.publish("agent:final", { turn_id: "turn_1", content: "done a" });
    kernel.eventBus.publish("user:message", { turn_id: "turn_2", content: "edit b" });
    await kernel.tools.execute(
      createToolCall({ name: "edit", params: { diff: DIFF_B, prompt: "edit b" }, requestedByStepId: "step_2" }),
      { autonomy: "gated", turnId: "turn_2" }
    );
    kernel.eventBus.publish("agent:final", { turn_id: "turn_2", content: "done b" });
    await kernel.session.flush();

    const preview = await kernel.session.rewind.preview({ target: { turn_id: "turn_1" } });
    assert.equal(preview.rollback_count, 1);

    const result = await kernel.session.rewind.apply({ target: { turn_id: "turn_1" } });

    assert.equal(result.status, "success");
    assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "new a\n");
    assert.equal(await readFile(path.join(root, "b.txt"), "utf8"), "old b\n");
    assert.notEqual((await kernel.session.branches.getActive()).branch_id, "br_main");
  });

  test("kernel rewind conflict leaves active branch unchanged", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-v2-rewind-conflict-"));
    await writeFile(path.join(root, "a.txt"), "old a\n");
    await writeFile(path.join(root, "b.txt"), "old b\n");
    const kernel = await createKernel(root, {
      sessionRoot: path.join(root, ".sessions"),
      sessionId: "sess_rewind_conflict",
      context: { disabled: true }
    });

    kernel.eventBus.publish("user:message", { turn_id: "turn_1", content: "edit a" });
    await kernel.tools.execute(
      createToolCall({ name: "edit", params: { diff: DIFF_A, prompt: "edit a" }, requestedByStepId: "step_1" }),
      { autonomy: "gated", turnId: "turn_1" }
    );
    kernel.eventBus.publish("agent:final", { turn_id: "turn_1", content: "done a" });
    kernel.eventBus.publish("user:message", { turn_id: "turn_2", content: "edit b" });
    await kernel.tools.execute(
      createToolCall({ name: "edit", params: { diff: DIFF_B, prompt: "edit b" }, requestedByStepId: "step_2" }),
      { autonomy: "gated", turnId: "turn_2" }
    );
    // Manually dirty b.txt to trigger rollback conflict
    await writeFile(path.join(root, "b.txt"), "manual b\n");
    kernel.eventBus.publish("agent:final", { turn_id: "turn_2", content: "done b" });
    await kernel.session.flush();

    const result = await kernel.session.rewind.apply({ target: { turn_id: "turn_1" } });

    assert.equal(result.status, "conflict");
    assert.equal((await kernel.session.branches.getActive()).branch_id, "br_main");
    assert.equal(await readFile(path.join(root, "b.txt"), "utf8"), "manual b\n");
  });

  test("kernel rewind restores files when branch creation fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-v2-rewind-create-fail-"));
    await writeFile(path.join(root, "a.txt"), "old a\n");
    await writeFile(path.join(root, "b.txt"), "old b\n");
    const kernel = await createKernel(root, {
      sessionRoot: path.join(root, ".sessions"),
      sessionId: "sess_rewind_create_fail",
      context: { disabled: true }
    });

    kernel.eventBus.publish("user:message", { turn_id: "turn_1", content: "edit a" });
    await kernel.tools.execute(
      createToolCall({ name: "edit", params: { diff: DIFF_A, prompt: "edit a" }, requestedByStepId: "step_1" }),
      { autonomy: "gated", turnId: "turn_1" }
    );
    kernel.eventBus.publish("agent:final", { turn_id: "turn_1", content: "done a" });
    kernel.eventBus.publish("user:message", { turn_id: "turn_2", content: "edit b" });
    await kernel.tools.execute(
      createToolCall({ name: "edit", params: { diff: DIFF_B, prompt: "edit b" }, requestedByStepId: "step_2" }),
      { autonomy: "gated", turnId: "turn_2" }
    );
    kernel.eventBus.publish("agent:final", { turn_id: "turn_2", content: "done b" });
    await kernel.session.flush();

    const originalCreate = kernel.session.branches.create;
    kernel.session.branches.create = async () => { throw new Error("simulated branch create failure with secret content"); };

    const result = await kernel.session.rewind.apply({ target: { turn_id: "turn_1" } });

    assert.equal(result.status, "failed_restored");
    assert.equal(result.reason, "branch_create_failed");
    assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "new a\n");
    assert.equal(await readFile(path.join(root, "b.txt"), "utf8"), "new b\n");
    assert.equal((await kernel.session.branches.getActive()).branch_id, "br_main");
    assert.equal(JSON.stringify(result).includes("secret content"), false);

    kernel.session.branches.create = originalCreate;
  });

  test("kernel rewind restores files when branch activation fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-v2-rewind-activate-fail-"));
    await writeFile(path.join(root, "a.txt"), "old a\n");
    await writeFile(path.join(root, "b.txt"), "old b\n");
    const kernel = await createKernel(root, {
      sessionRoot: path.join(root, ".sessions"),
      sessionId: "sess_rewind_activate_fail",
      context: { disabled: true }
    });

    kernel.eventBus.publish("user:message", { turn_id: "turn_1", content: "edit a" });
    await kernel.tools.execute(
      createToolCall({ name: "edit", params: { diff: DIFF_A, prompt: "edit a" }, requestedByStepId: "step_1" }),
      { autonomy: "gated", turnId: "turn_1" }
    );
    kernel.eventBus.publish("agent:final", { turn_id: "turn_1", content: "done a" });
    kernel.eventBus.publish("user:message", { turn_id: "turn_2", content: "edit b" });
    await kernel.tools.execute(
      createToolCall({ name: "edit", params: { diff: DIFF_B, prompt: "edit b" }, requestedByStepId: "step_2" }),
      { autonomy: "gated", turnId: "turn_2" }
    );
    kernel.eventBus.publish("agent:final", { turn_id: "turn_2", content: "done b" });
    await kernel.session.flush();

    const originalActivate = kernel.session.branches.activate;
    kernel.session.branches.activate = async () => { throw new Error("simulated activation failure with raw details"); };

    const result = await kernel.session.rewind.apply({ target: { turn_id: "turn_1" } });

    assert.equal(result.status, "failed_restored");
    assert.equal(result.reason, "branch_activate_failed");
    assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "new a\n");
    assert.equal(await readFile(path.join(root, "b.txt"), "utf8"), "new b\n");
    assert.equal((await kernel.session.branches.getActive()).branch_id, "br_main");
    assert.equal(JSON.stringify(result).includes("raw details"), false);

    kernel.session.branches.activate = originalActivate;
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/integration/v2-usage-metrics.test.js
// ---------------------------------------------------------------------------
describe("integration/v2-usage-metrics", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { createKernel } = await import("../../src/index.js");
  const { mkdtemp } = await import("../helpers/tmp.js");

  test("kernel metrics exposes real DeepSeek usage stats", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-usage-metrics-"));
    await writeFile(path.join(root, "README.md"), "# demo\n");
    const usage = {
      requests: 1,
      total_prompt_tokens: 100,
      total_completion_tokens: 20,
      total_reasoning_tokens: 5,
      total_tokens: 120,
      cache_hit_tokens: 40,
      cache_miss_tokens: 60,
      cache_hit_rate: 0.4,
      avg_latency_ms: 33,
      by_channel: { act: { requests: 1, prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } },
      by_model: {}
    };
    const kernel = await createKernel(root, {
      sessionRoot: path.join(root, ".sessions"),
      sessionLog: null,
      context: { cacheRoot: path.join(root, ".context-cache") },
      modelGateway: {
        getUsageStats: () => usage,
        reply: async () => ({ content: "ok" })
      }
    });

    assert.deepEqual(kernel.metrics.getUsage(), usage);
    assert.equal(kernel.metrics.getContext().indexed_paths, 1);
    const redacted = await kernel.metrics.getSnapshot({ channel: "reply", classification: { task_type: "query" } });
    assert.equal(redacted.summary, undefined);
    assert.ok(redacted.units.some((u) => u.path === "README.md"));
    // Full snapshot (kernel.context) still has summary
    const full = await kernel.context.snapshot({ channel: "reply", classification: { task_type: "query" } });
    assert.ok(full.summary.includes("README.md"));
  });

  test("kernel metrics returns zero usage when gateway has no stats", async () => {
    const kernel = await createKernel(process.cwd(), {
      sessionLog: null,
      context: { disabled: true },
      modelGateway: { reply: async () => ({ content: "ok" }) }
    });

    assert.equal(kernel.metrics.getUsage().cache_hit_rate, 0);
    assert.equal(kernel.metrics.getUsage().requests, 0);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/integration/v2-cli-kernel-runner.test.js
// ---------------------------------------------------------------------------
describe("integration/v2-cli-kernel-runner", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { runKernelAgentCommand } = await import("../../src/apps/cli/kernel-runner.js");
  const { mkdtemp } = await import("../helpers/tmp.js");

  test("CLI kernel runner can drive a V2 read tool loop", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-cli-runner-"));
    await writeFile(path.join(root, "README.md"), "hello cli runner");
    let invokeCount = 0;
    const lines = [];

    const result = await runKernelAgentCommand({
      root,
      prompt: "inspect README",
      write: (line) => lines.push(line),
      createKernelOptions: {
        sessionId: "sess_cli_runner",
        modelGateway: {
          invoke: async (messages) => {
            invokeCount++;
            if (invokeCount === 1) {
              return { content: "", tool_calls: [{ id: "call_read", name: "read", arguments: { path: "README.md" } }] };
            }
            assert.ok(messages.some((message) => message.role === "tool" && message.content.includes("hello cli runner")));
            return { content: "README inspected", tool_calls: [] };
          },
          reply: async () => ({ content: "fast" })
        }
      }
    });

    assert.equal(result.status, "complete");
    assert.equal(result.content, "README inspected");
    assert.equal(invokeCount, 2);
    assert.ok(lines.some((line) => line.includes("README inspected")));
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/integration/v2-deepseek-gateway-runtime.test.js
// ---------------------------------------------------------------------------
describe("integration/v2-deepseek-gateway-runtime", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createKernel } = await import("../../src/index.js");

  test("createKernel creates DeepSeek gateway from options.deepseek", async () => {
    const calls = [];
    const kernel = await createKernel(process.cwd(), {
      sessionId: "sess_ds",
      sessionLog: null,
      context: { disabled: true },
      deepseek: {
        apiKey: "key",
        fetchImpl: async (url, init) => {
          calls.push({ url, init });
          return {
            ok: true,
            status: 200,
            json: async () => ({
              choices: [{
                finish_reason: "stop",
                message: { role: "assistant", content: "real gateway response" }
              }],
              usage: {
                prompt_tokens: 4,
                completion_tokens: 3,
                prompt_cache_hit_tokens: 1,
                prompt_cache_miss_tokens: 3
              }
            }),
            text: async () => ""
          };
        }
      }
    });

    const result = await kernel.agent.send("hello");
    assert.equal(result.content, "real gateway response");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.deepseek.com/chat/completions");
    assert.equal(kernel.config.getPublicConfig().has_api_key, true);
  });

  test("runtime passes AbortSignal to model gateway and aborts on interrupt", async () => {
    let seenSignal = null;
    let release;
    const blocked = new Promise((resolve) => { release = resolve; });

    const kernel = await createKernel(process.cwd(), {
      sessionId: "sess_ab",
      sessionLog: null,
      context: { disabled: true },
      modelGateway: {
        reply: async ({ signal }) => {
          seenSignal = signal;
          await blocked;
          if (signal.aborted) {
            const err = new Error("aborted by test");
            err.name = "AbortError";
            throw err;
          }
          return { content: "late" };
        }
      }
    });

    const pending = kernel.agent.send("long request");
    await new Promise((resolve) => setTimeout(resolve, 20));
    kernel.agent.interrupt();
    release();

    await assert.rejects(() => pending, /turn was interrupted|aborted by test/);
    assert.equal(seenSignal.aborted, true);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/integration/v2-interface-boundary.test.js
// ---------------------------------------------------------------------------
describe("integration/v2-interface-boundary", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { readdir, readFile } = await import("node:fs/promises");

  async function source(file) {
    return readFile(file, "utf8");
  }

  test("migrated CLI ask edit test entrypoints use V2 kernel runner", async () => {
    const cli = await source("src/cli.js");

    assert.match(cli, /runKernelAgentCommand/);
    assert.match(cli, /runKernelTestCommand/);
    assert.doesNotMatch(cli, /askCommand/);
    assert.doesNotMatch(cli, /editCommand/);
    assert.doesNotMatch(cli, /from "\.\/agent\.js"/);
  });

  test("TUI and GUI host do not import the old V1 kernel api", async () => {
    const tui = await source("src/apps/tui/tui-app.js");
    const guiMain = await source("gui/main.js");
    const guiHost = await source("gui/kernel-host.js");

    assert.match(tui, /from "\.\.\/\.\.\/index\.js"/);
    assert.doesNotMatch(tui, /from "\.\/agent\.js"/);
    assert.doesNotMatch(tui, /kernel-api/);
    assert.doesNotMatch(guiMain, /src[\\/]+kernel[\\/]+kernel-api|kernel-api/);
    assert.doesNotMatch(guiHost, /src[\\/]+kernel[\\/]+kernel-api|kernel-api/);
  });

  test("CLI chat routes through V2 kernel runner; TUI app talks to the unified kernel entry", async () => {
    const cli = await source("src/cli.js");
    const app = await source("src/apps/tui/tui-app.js");

    assert.match(cli, /runKernelChatCommand/);
    assert.match(app, /from "\.\.\/\.\.\/index\.js"/);
    assert.doesNotMatch(cli, /from "\.\/chat\.js"/);
    assert.doesNotMatch(app, /chat\.js/);
    assert.doesNotMatch(cli, /askDeepSeek/);
    assert.doesNotMatch(app, /askDeepSeek/);

    // V1 legacy entrypoints were deleted in V2-19.
    await assert.rejects(() => source("src/chat.js"));
    await assert.rejects(() => source("src/agent.js"));

    // v1.19.0 架构收敛：src/ 顶层只保留 index/cli/config/theme 四个入口，
    // 其余 V1 双轨遗留模块与 edits 域外泄实现一律删除。
    for (const removed of [
      "src/provider.js",
      "src/context.js",
      "src/search.js",
      "src/git.js",
      "src/tui.js",
      "src/patch.js",
      "src/changes.js"
    ]) {
      await assert.rejects(() => source(removed), `${removed} 应已在 v1.19.0 删除`);
    }
  });

  test("v1.19.0 top-level src entries are limited to the four entrypoints", async () => {
    const entries = await readdir("src", { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
    assert.deepEqual(files, ["cli.js", "config.js", "index.js", "theme.js"]);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/integration/v2-tool-plane-kernel.test.js
// ---------------------------------------------------------------------------
describe("integration/v2-tool-plane-kernel", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { createKernel } = await import("../../src/index.js");
  const { createToolCall } = await import("../../src/core/protocol/index.js");
  const { mkdtemp } = await import("../helpers/tmp.js");

  test("kernel exposes V2 tool list and executes read tool", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-kernel-tools-"));
    await writeFile(path.join(root, "README.md"), "hello tools", "utf8");
    const kernel = await createKernel(root, { sessionId: "sess_tools" });

    assert.ok(kernel.tools.list().some((tool) => tool.name === "read"));

    const result = await kernel.tools.execute(
      createToolCall({ name: "read", params: { path: "README.md" }, requestedByStepId: "step_1" }),
      { autonomy: "gated", turnId: "turn_1" }
    );

    assert.equal(result.status, "success");
    assert.equal(result.content[0].text, "hello tools");
  });

  test("kernel tool execution emits session events", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-kernel-tools-"));
    await writeFile(path.join(root, "README.md"), "hello events", "utf8");
    const kernel = await createKernel(root, { sessionId: "sess_tools_events" });
    const events = [];
    const sub = kernel.session.subscribe((event) => events.push(event));

    await kernel.tools.execute(
      createToolCall({ name: "read", params: { path: "README.md" }, requestedByStepId: "step_1" }),
      { autonomy: "gated", turnId: "turn_1" }
    );
    sub.unsubscribe();

    assert.ok(events.some((event) => event.type === "tool:call"));
    assert.ok(events.some((event) => event.type === "permission:decision"));
    assert.ok(events.some((event) => event.type === "tool:result"));
  });

  test("kernel tool execution returns approval_required for supervised shell", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-kernel-tools-"));
    const kernel = await createKernel(root, { sessionId: "sess_tools_shell" });

    const result = await kernel.tools.execute(
      createToolCall({ name: "shell", params: { argv: [process.execPath, "--version"] }, requestedByStepId: "step_1" }),
      { autonomy: "supervised", turnId: "turn_1" }
    );

    assert.equal(result.status, "approval_required");
  });
});
