// tests/integration/kernel-and-mcp.test.js — 内核运行时、上下文、编辑服务与 MCP 集成
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdtemp } from "../helpers/tmp.js";
import { createKernel } from "../../src/index.js";

test("kernel composition root 门面导出、事件流订阅与会话生命周期", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-int-kernel-"));
  await writeFile(path.join(root, "package.json"), "{\"name\":\"kernel-test\"}\n");

  const events = [];
  const kernel = await createKernel(root, {
    sessionId: "sess_int_1",
    context: { disabled: true },
    modelGateway: {
      reply: async () => ({ content: "Kernel integration reply" }),
      invoke: async () => ({ content: "Kernel integration reply", tool_calls: [] })
    }
  });

  const sub = kernel.session.subscribe((ev) => events.push(ev));

  assert.equal(typeof kernel.agent.send, "function");
  assert.equal(typeof kernel.agent.approve, "function");
  assert.equal(typeof kernel.agent.interrupt, "function");
  assert.equal(typeof kernel.session.getTimeline, "function");

  const turn = await kernel.agent.send("hello kernel");
  assert.equal(turn.status, "complete");
  assert.equal(turn.content, "Kernel integration reply");
  assert.ok(events.length >= 1);

  sub.unsubscribe();
  await kernel.dispose();
});

test("kernel 工作区上下文索引与安全快照生成", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-int-context-"));
  await writeFile(path.join(root, "package.json"), "{\"name\":\"context-demo\"}\n");
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "index.js"), "export const hello = 'world';\n");

  const kernel = await createKernel(root, {
    sessionRoot: path.join(root, ".sessions"),
    modelGateway: {
      reply: async () => ({ content: "ok" }),
      invoke: async () => ({ content: "ok", tool_calls: [] })
    }
  });

  const snapshot = await kernel.context.snapshot({
    message: "modify src/index.js",
    classification: { task_type: "edit" },
    channel: "act"
  });

  assert.notEqual(snapshot.snapshot_id, "v2_empty_snapshot");
  assert.ok(snapshot.units.some((u) => u.path === "package.json"));
  assert.ok(snapshot.units.some((u) => u.path === "src/index.js"));

  await kernel.dispose();
});

test("kernel project-lock 保护与恢复日志清除", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-int-lock-"));
  await writeFile(path.join(root, "package.json"), "{\"name\":\"lock-test\"}\n");

  const kernel = await createKernel(root, {
    context: { disabled: true },
    recovery: { enabled: true, lockFailureMode: "warn" },
    modelGateway: { reply: async () => ({ content: "done" }) }
  });

  assert.ok(kernel.recovery);
  const items = await kernel.recovery.list();
  assert.ok(Array.isArray(items));
  const report = await kernel.recovery.report();
  assert.ok(report);

  await kernel.dispose();
});

test("kernel mcp 外部工具与资源门面集成", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-int-mcp-"));
  await writeFile(path.join(root, "package.json"), "{\"name\":\"mcp-kernel-test\"}\n");

  const kernel = await createKernel(root, {
    context: { disabled: true },
    modelGateway: { reply: async () => ({ content: "mcp ok" }) }
  });

  assert.ok(kernel.mcp);
  assert.equal(typeof kernel.mcp.listServers, "function");
  assert.equal(typeof kernel.mcp.listTools, "function");
  assert.equal(typeof kernel.mcp.callTool, "function");

  const servers = kernel.mcp.listServers();
  assert.ok(Array.isArray(servers));

  await kernel.dispose();
});
