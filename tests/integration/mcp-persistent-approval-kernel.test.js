import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdir } from "node:fs/promises";
import { createKernel } from "../../src/index.js";
import { createPolicyStore } from "../../src/tools/mcp/tool-policy.js";
import { mkdtemp } from "../helpers/tmp.js";

const TOOL = "mcp__demo__update_record";

async function makeKernel(root, userRoot, executions, extra = {}) {
  await mkdir(root, { recursive: true });
  let count = 0;
  const kernel = await createKernel(root, {
    sessionLog: null,
    mcpPolicyStore: createPolicyStore({ projectRoot: root, userRoot }),
    orchestration: { router: { model: { enabled: false } } },
    modelGateway: {
      invoke: async (messages) => ++count === 1
        ? { content: "", tool_calls: [{ id: "external_update", name: TOOL, arguments: { value: count } }] }
        : { content: "record updated", tool_calls: [] },
      reply: async () => ({ content: "offline" })
    },
    ...extra
  });
  kernel.tools.registry.register({
    name: TOOL, description: "Update a simulated external record", source: "mcp", category: "mutate",
    execute: async () => { executions.push("executed"); return { content: [{ type: "text", text: "updated" }] }; }
  });
  return kernel;
}

for (const scope of ["project", "always"]) {
  test(`MCP ${scope} approval survives a new kernel with a fresh approval cache`, async (t) => {
    const base = await mkdtemp(path.join(tmpdir(), "inkstone-mcp-approval-"));
    const root = path.join(base, "project"), userRoot = path.join(base, "user");
    const executions = [];
    const first = await makeKernel(root, userRoot, executions);
    t.after(() => first.dispose());
    const paused = await first.agent.send("inspect external record", { autonomy: "gated" });
    assert.equal(paused.status, "awaiting_approval");
    assert.equal(executions.length, 0);
    const completed = await first.agent.approve(paused.approval.id, "approve", { scope });
    assert.equal(completed.status, "complete");
    assert.equal(executions.length, 1);
    await first.dispose();

    const second = await makeKernel(root, userRoot, executions);
    t.after(() => second.dispose());
    const result = await second.agent.send("inspect external record", { autonomy: "gated", projectRules: [] });
    assert.equal(result.status, "complete");
    assert.equal(executions.length, 2, "normal runtime execution must consume persisted rules");
    const direct = await second.tools.execute({ id: "direct", name: TOOL, params: { value: 42 } }, { autonomy: "gated" });
    assert.equal(direct.status, "success", "the public tool executor must consume the same policy");
  });
}

test("session approval does not become persistent and destructive remains denied", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "inkstone-mcp-session-"));
  const executions = [];
  const root = path.join(base, "project"), userRoot = path.join(base, "user");
  const first = await makeKernel(root, userRoot, executions);
  t.after(() => first.dispose());
  const paused = await first.agent.send("inspect external record", { autonomy: "gated" });
  await first.agent.approve(paused.approval.id, "approve", { scope: "session" });
  await first.dispose();
  const second = await makeKernel(root, userRoot, executions);
  t.after(() => second.dispose());
  const next = await second.agent.send("inspect external record", { autonomy: "gated" });
  assert.equal(next.status, "awaiting_approval");
  assert.equal(executions.length, 1);
  const destructive = "mcp__demo__destroy_all";
  second.tools.registry.register({ name: destructive, description: "Forbidden operation", category: "destructive", source: "mcp", execute: () => { throw new Error("must not run"); } });
  createPolicyStore({ projectRoot: root, userRoot }).grant(destructive, "project");
  const result = await second.tools.execute({ id: "denied", name: destructive, params: {} }, { autonomy: "full-auto" });
  assert.equal(result.status, "denied");
});

test("kernel exposes dynamic MCP add/remove on its public facade", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "inkstone-mcp-facade-"));
  const kernel = await createKernel(root, { sessionLog: null, mcpPolicyStore: null });
  t.after(() => kernel.dispose());
  await kernel.mcp.addServer("local", { command: "unused", disabled: true }, { autoStart: false });
  assert.equal(kernel.mcp.listServers().length, 1);
  await kernel.mcp.removeServer("local");
  assert.equal(kernel.mcp.listServers().length, 0);
});
