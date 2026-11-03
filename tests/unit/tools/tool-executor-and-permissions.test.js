// tests/unit/tools/tool-executor-and-permissions.test.js — 工具执行器与权限(超时/策略引擎/审批缓存/风险升级)领域测试
//
// v1.19.1 测试归并:本文件由下列历史任务单测试合并而成,每个来源包裹在独立
// describe 块中(异步回调 + 动态 import,来源间零共享绑定),测试语义与拆分前一致。
import { describe } from "node:test";

// ---------------------------------------------------------------------------
// 来源:tests/unit/tools/executor.test.js
// ---------------------------------------------------------------------------
describe("unit/tools/executor", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createEventBus } = await import("../../../src/shared/event-bus.js");
  const { createToolCall } = await import("../../../src/core/protocol/index.js");
  const { createToolRegistry } = await import("../../../src/tools/registry.js");
  const { createToolExecutor } = await import("../../../src/tools/executor.js");
  const { createPermissionEngine } = await import("../../../src/tools/permissions/permission-engine.js");
  const { createPolicyContext } = await import("../../../src/tools/permissions/policy-loader.js");

  test("executor validates schema and executes allowed tools", async () => {
    const registry = createToolRegistry({
      tools: [{
        name: "echo",
        description: "Echo text",
        category: "read",
        side_effect: "none",
        risk_level: "low",
        source: "test",
        version: "1.0",
        params: { text: { type: "string" } },
        execute: async (params) => ({ content: [{ type: "text", text: params.text }] })
      }]
    });
    const executor = createToolExecutor({ registry, permissionEngine: createPermissionEngine() });

    const result = await executor.execute(
      createToolCall({ name: "echo", params: { text: "hi" }, requestedByStepId: "step_1" }),
      createPolicyContext({ autonomy: "gated" })
    );

    assert.equal(result.status, "success");
    assert.equal(result.content[0].text, "hi");
  });

  test("executor ignores model-provided category and uses definition category", async () => {
    const bus = createEventBus();
    const toolCalls = [];
    bus.subscribe("tool:call", (data) => toolCalls.push(data));
    const registry = createToolRegistry({
      tools: [{
        name: "write_like",
        description: "Write-like tool",
        category: "write_delete",
        side_effect: "filesystem",
        risk_level: "high",
        source: "test",
        version: "1.0",
        params: {},
        execute: async () => ({ content: [{ type: "text", text: "wrote" }] })
      }]
    });
    const executor = createToolExecutor({ registry, permissionEngine: createPermissionEngine(), eventBus: bus });

    const result = await executor.execute(
      { id: "call_1", name: "write_like", category: "read", params: {}, requested_by_step_id: "step_1" },
      createPolicyContext({ autonomy: "supervised" })
    );

    assert.equal(result.status, "approval_required");
    // tool:call event must use registry-derived category, not model-provided "read"
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].call.category, "write_delete");
    assert.equal(toolCalls[0].call.risk_level, "high");
  });

  test("executor publishes tool call permission approval and result events", async () => {
    const bus = createEventBus();
    const events = [];
    for (const type of ["tool:call", "permission:decision", "approval:requested", "tool:result"]) {
      bus.subscribe(type, (data) => events.push([type, data]));
    }
    const registry = createToolRegistry({
      tools: [{
        name: "needs_approval",
        description: "Approval tool",
        category: "execute",
        side_effect: "process",
        risk_level: "medium",
        source: "test",
        version: "1.0",
        params: {},
        execute: async () => ({ content: [{ type: "text", text: "ran" }] })
      }]
    });
    const executor = createToolExecutor({ registry, permissionEngine: createPermissionEngine(), eventBus: bus });

    const result = await executor.execute(
      createToolCall({ name: "needs_approval", params: {}, requestedByStepId: "step_1" }),
      createPolicyContext({ autonomy: "supervised", projectRoot: process.cwd() })
    );

    assert.equal(result.status, "approval_required");
    assert.ok(events.some(([type]) => type === "tool:call"));
    assert.ok(events.some(([type]) => type === "permission:decision"));
    assert.ok(events.some(([type]) => type === "approval:requested"));
    assert.ok(events.some(([type]) => type === "tool:result"));
  });

  test("executor approval summary includes clipped argv preview", async () => {
    const registry = createToolRegistry({
      tools: [{
        name: "shell_like",
        description: "Argv tool",
        category: "execute",
        side_effect: "process",
        risk_level: "medium",
        source: "test",
        version: "1.0",
        params: { argv: { type: "array" } },
        execute: async () => ({ content: [{ type: "text", text: "ran" }] })
      }]
    });
    const executor = createToolExecutor({ registry, permissionEngine: createPermissionEngine() });

    const short = await executor.execute(
      createToolCall({ name: "shell_like", params: { argv: ["git", "push", "--force", "origin", "main"] }, requestedByStepId: "step_1" }),
      createPolicyContext({ autonomy: "supervised" })
    );
    assert.equal(short.status, "approval_required");
    assert.equal(short.metadata.approval.summary, "shell_like requires approval: `git push --force origin main`");

    const long = await executor.execute(
      createToolCall({ name: "shell_like", params: { argv: ["node", "x".repeat(200)] }, requestedByStepId: "step_1" }),
      createPolicyContext({ autonomy: "supervised" })
    );
    assert.equal(long.status, "approval_required");
    assert.ok(long.metadata.approval.summary.length <= "shell_like requires approval: ``…".length + 120);
    assert.match(long.metadata.approval.summary, /…`$/);
  });

  test("executor approval summary unchanged for tools without argv", async () => {
    const registry = createToolRegistry({
      tools: [{
        name: "needs_approval",
        description: "Approval tool",
        category: "execute",
        side_effect: "process",
        risk_level: "medium",
        source: "test",
        version: "1.0",
        params: {},
        execute: async () => ({ content: [{ type: "text", text: "ran" }] })
      }]
    });
    const executor = createToolExecutor({ registry, permissionEngine: createPermissionEngine() });

    const result = await executor.execute(
      createToolCall({ name: "needs_approval", params: {}, requestedByStepId: "step_1" }),
      createPolicyContext({ autonomy: "supervised" })
    );
    assert.equal(result.status, "approval_required");
    assert.equal(result.metadata.approval.summary, "needs_approval requires approval");
  });

  test("executor redacts secrets from tool output", async () => {
    const registry = createToolRegistry({
      tools: [{
        name: "leak",
        description: "Leak text",
        category: "read",
        side_effect: "none",
        risk_level: "low",
        source: "test",
        version: "1.0",
        params: {},
        execute: async () => ({ content: [{ type: "text", text: "Authorization: Bearer secret-token" }] })
      }]
    });
    const executor = createToolExecutor({ registry, permissionEngine: createPermissionEngine() });

    const result = await executor.execute(
      createToolCall({ name: "leak", params: {}, requestedByStepId: "step_1" }),
      createPolicyContext({ autonomy: "gated" })
    );

    assert.equal(result.content[0].text, "Authorization: Bearer [REDACTED]");
  });

  test("executor uses registry secureToolCall helper for permission and events", async () => {
    const calls = [];
    const registry = {
      resolve: () => ({
        name: "custom",
        description: "custom",
        category: "read",
        risk_level: "low",
        side_effect: "none",
        execute: async () => ({ status: "success", content: [{ type: "text", text: "ok" }] })
      }),
      secureToolCall(toolCall) {
        calls.push(toolCall);
        return {
          id: toolCall.id,
          name: "custom",
          params: { path: "safe.txt" },
          category: "write_update",
          risk_level: "low",
          side_effect: "none",
          requested_by_step_id: toolCall.requested_by_step_id
        };
      }
    };
    const decisions = [];
    const executor = createToolExecutor({
      registry,
      permissionEngine: {
        decide: (call) => {
          decisions.push(call);
          return { decision: "allow", matched_rule: "test", source: "test" };
        }
      }
    });

    const result = await executor.execute(
      createToolCall({ id: "call_1", name: "custom", params: {}, requestedByStepId: "step_1" }),
      { autonomy: "gated" }
    );

    assert.equal(result.status, "success");
    assert.equal(calls.length, 1);
    assert.equal(decisions[0].category, "write_update");
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/tools/executor-timeout.test.js
// ---------------------------------------------------------------------------
describe("unit/tools/executor-timeout", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createToolExecutor } = await import("../../../src/tools/executor.js");
  const { EventEmitter, getEventListeners } = await import("node:events");
  const { JsonRpcClient } = await import("../../../src/tools/mcp/jsonrpc-client.js");

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
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/tools/permission-engine.test.js
// ---------------------------------------------------------------------------
describe("unit/tools/permission-engine", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createPermissionEngine, DEFAULT_POLICY_MATRIX, globMatch } = await import("../../../src/tools/permissions/permission-engine.js");
  const { createPolicyContext } = await import("../../../src/tools/permissions/policy-loader.js");

  test("default matrix covers 10 categories across 5 autonomy levels", () => {
    const categories = ["read", "read_secret", "write_create", "write_update", "write_delete", "execute", "execute_dangerous", "network", "destructive", "mutate"];
    for (const autonomy of ["read-only", "supervised", "gated", "auto", "full-auto"]) {
      assert.deepEqual(Object.keys(DEFAULT_POLICY_MATRIX[autonomy]).sort(), categories.sort());
    }
  });

  test("read-only allows reads, asks for secrets, and denies mutations and side effects", () => {
    const engine = createPermissionEngine();
    const expected = {
      read: "allow",
      read_secret: "ask",
      write_create: "deny",
      write_update: "deny",
      write_delete: "deny",
      execute: "deny",
      execute_dangerous: "deny",
      network: "deny",
      destructive: "deny",
      mutate: "deny"
    };

    for (const [category, decision] of Object.entries(expected)) {
      const result = engine.decide(
        { name: `tool_${category}`, category, params: {} },
        createPolicyContext({ autonomy: "read-only" })
      );
      assert.equal(result.decision, decision, category);
      if (category !== "destructive") {
        assert.equal(result.matched_rule, `default:read-only:${category}`);
      }
    }
  });

  test("execute_dangerous asks in every mode that may execute at all", () => {
    const engine = createPermissionEngine();
    for (const autonomy of ["supervised", "gated", "auto", "full-auto"]) {
      const result = engine.decide(
        { name: "shell", category: "execute_dangerous", params: { argv: ["rm", "-rf", "x"] } },
        createPolicyContext({ autonomy })
      );
      assert.equal(result.decision, "ask", autonomy);
      assert.equal(result.matched_rule, `default:${autonomy}:execute_dangerous`, autonomy);
    }
  });

  test("destructive is denied before trust rules", () => {
    const engine = createPermissionEngine();
    const decision = engine.decide(
      { name: "delete_repo", category: "destructive", params: {} },
      createPolicyContext({
        autonomy: "full-auto",
        trustStore: { rules: [{ id: "allow-all", category: "destructive", decision: "allow" }] }
      })
    );

    assert.equal(decision.decision, "deny");
    assert.equal(decision.source, "safety-invariant");
  });

  test("user rules override project rules and default matrix", () => {
    const engine = createPermissionEngine();
    const call = { name: "write", category: "write_update", params: { path: "src/app.js" } };
    const ctx = createPolicyContext({
      autonomy: "supervised",
      trustStore: { rules: [{ id: "user-allow-src", category: "write_update", pattern: "src/**", decision: "allow" }] },
      projectRules: [{ id: "project-deny-src", category: "write_update", pattern: "src/**", decision: "deny" }]
    });

    const decision = engine.decide(call, ctx);

    assert.equal(decision.decision, "allow");
    assert.equal(decision.source, "user-trust-store");
  });

  test("rule pattern requires call path", () => {
    const engine = createPermissionEngine();
    const decision = engine.decide(
      { name: "shell", category: "execute", params: { argv: ["npm", "test"] } },
      createPolicyContext({
        autonomy: "supervised",
        trustStore: { rules: [{ id: "path-rule", category: "execute", pattern: "src/**", decision: "allow" }] }
      })
    );

    assert.equal(decision.decision, "ask");
    assert.equal(decision.source, "default-matrix");
  });

  test("argv rule matches exact argv only", () => {
    const engine = createPermissionEngine();
    const ctx = createPolicyContext({
      autonomy: "supervised",
      trustStore: { rules: [{ id: "allow-npm-test", category: "execute", match: { argv: ["npm", "test"] }, decision: "allow" }] }
    });

    assert.equal(engine.decide({ name: "shell", category: "execute", params: { argv: ["npm", "test"] } }, ctx).decision, "allow");
    assert.equal(engine.decide({ name: "shell", category: "execute", params: { argv: ["npm", "run", "test"] } }, ctx).decision, "ask");
  });

  test("globMatch supports recursive and single-segment globs", () => {
    assert.equal(globMatch("src/**", "src/a/b.js"), true);
    assert.equal(globMatch("src/*.js", "src/app.js"), true);
    assert.equal(globMatch("src/*.js", "src/nested/app.js"), false);
  });

  test("fingerprint is deterministic for tool path argv and project", () => {
    const engine = createPermissionEngine();
    const ctx = createPolicyContext({ projectId: "proj_1" });
    const a = engine.fingerprint({ name: "shell", category: "execute", params: { argv: ["npm", "test"], cwd: "." } }, ctx);
    const b = engine.fingerprint({ name: "shell", category: "execute", params: { argv: ["npm", "test"], cwd: "." } }, ctx);
    assert.equal(a, b);
    assert.match(a, /^fp:/);
  });

  test("fingerprint changes when diff content differs (edit)", () => {
    const engine = createPermissionEngine();
    const ctx = createPolicyContext({ projectId: "proj_1" });
    const fp1 = engine.fingerprint(
      { name: "edit", category: "write_update", params: { diff: "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new", path: "a.txt" } },
      ctx
    );
    const fp2 = engine.fingerprint(
      { name: "edit", category: "write_update", params: { diff: "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-safe\n+evil", path: "a.txt" } },
      ctx
    );
    assert.notEqual(fp1, fp2);
  });

  test("fingerprint changes when memory action differs", () => {
    const engine = createPermissionEngine();
    const ctx = createPolicyContext({ projectId: "proj_1" });
    const fpWrite = engine.fingerprint(
      { name: "memory", category: "write_create", params: { action: "write", key: "notes", value: "hello" } },
      ctx
    );
    const fpDelete = engine.fingerprint(
      { name: "memory", category: "write_delete", params: { action: "delete", key: "notes" } },
      ctx
    );
    assert.notEqual(fpWrite, fpDelete);
  });

  test("fingerprint changes when memory key or value differs", () => {
    const engine = createPermissionEngine();
    const ctx = createPolicyContext({ projectId: "proj_1" });
    const fp1 = engine.fingerprint(
      { name: "memory", category: "write_create", params: { action: "write", key: "notes", value: "safe" } },
      ctx
    );
    const fp2 = engine.fingerprint(
      { name: "memory", category: "write_create", params: { action: "write", key: "notes", value: "DROP TABLE users" } },
      ctx
    );
    const fp3 = engine.fingerprint(
      { name: "memory", category: "write_create", params: { action: "write", key: "secrets", value: "safe" } },
      ctx
    );
    assert.notEqual(fp1, fp2);
    assert.notEqual(fp1, fp3);
  });

  // ── v1.13.1:MCP 持久化授权以「规则」形式进入引擎(不再有平行规则源) ──────────
  test("mcp-policy 规则命中即放行(经 projectRules 通道)", () => {
    const engine = createPermissionEngine();
    // 这正是 mcp/tool-policy.js 的 createPolicyStore().asRules() 产出的形状
    const policyRules = [{
      id: "mcp-policy:project:mcp__srv__read_doc",
      tool: "mcp__srv__read_doc",
      decision: "allow",
      meta: { source: "mcp-policy", scope: "project" }
    }];
    const call = { name: "mcp__srv__read_doc", category: "read", params: {}, autoApprove: false };
    const r = engine.decide(call, createPolicyContext({ autonomy: "read-only", projectRules: policyRules }));
    assert.deepEqual(
      r,
      { decision: "allow", matched_rule: "mcp-policy:project:mcp__srv__read_doc", source: "project-rules" }
    );
  });

  test("mcp-policy 规则可带参数作用域(pattern),与内置 projectRules 一致", () => {
    const engine = createPermissionEngine();
    const rules = [{
      id: "mcp-policy:project:mcp__fs__write_file",
      tool: "mcp__fs__write_file",
      pattern: "src/**",
      decision: "allow",
      meta: { source: "mcp-policy", scope: "project" }
    }];
    const base = { name: "mcp__fs__write_file", category: "mutate", autoApprove: false };
    const allowed = engine.decide({ ...base, params: { path: "src/a.js" } }, createPolicyContext({ autonomy: "read-only", projectRules: rules }));
    const rejected = engine.decide({ ...base, params: { path: "etc/passwd" } }, createPolicyContext({ autonomy: "read-only", projectRules: rules }));
    assert.equal(allowed.decision, "allow", "命中 pattern 应放行");
    assert.equal(rejected.decision, "deny", "pattern 外不得被顺带放行");
  });

  test("没有持久化策略时,决策与既有默认矩阵一致", () => {
    const engine = createPermissionEngine();
    const call = { name: "mcp__srv__write", category: "mutate", params: {} };
    assert.equal(
      engine.decide(call, createPolicyContext({ autonomy: "read-only" })).decision,
      "deny"
    );
    assert.equal(
      engine.decide(call, createPolicyContext({ autonomy: "auto" })).decision,
      "allow"
    );
  });

  test("D4 安全网:destructive 即使有规则放行也一律 deny", () => {
    const engine = createPermissionEngine();
    const rules = [{ id: "p1", tool: "wipe_db", decision: "allow" }];
    const r = engine.decide(
      { name: "wipe_db", category: "destructive", params: {} },
      createPolicyContext({ projectRules: rules })
    );
    assert.equal(r.decision, "deny");
    assert.equal(r.source, "safety-invariant");
    assert.equal(r.matched_rule, "hardcoded:destructive");
  });

  test("D4 安全网:autoApprove + approval-cache + trust + project 规则全允许时,destructive 仍 deny", () => {
    const engine = createPermissionEngine();
    const ctx = createPolicyContext({
      autonomy: "full-auto",
      projectRules: [{ id: "p1", tool: "wipe_db", decision: "allow" }]
    });
    ctx.trustStore = { rules: [{ id: "t1", tool: "wipe_db", decision: "allow" }] };
    ctx.approvalCache = {
      get: () => ({ decision: "allow" })
    };
    // 深度合并:approvalCache 不被 policy-loader 覆盖
    const merged = { ...ctx, approvalCache: ctx.approvalCache, trustStore: ctx.trustStore };
    const r = engine.decide(
      { name: "wipe_db", category: "destructive", params: {}, autoApprove: true },
      merged
    );
    assert.equal(r.decision, "deny", "四类放行来源叠加也不能破坏 destructive 不变量");
    assert.equal(r.matched_rule, "hardcoded:destructive");
  });

  test("D4 安全网:非 destructive 工具不受影响", () => {
    const engine = createPermissionEngine();
    const r = engine.decide(
      { name: "write_file", category: "mutate", params: {}, autoApprove: true },
      createPolicyContext({ autonomy: "gated" })
    );
    assert.equal(r.decision, "allow", "mutate 的 autoApprove 仍照旧生效");
    assert.equal(r.source, "mcp-server-config");
  });

  test("D4 安全网:approval-cache 对 destructive 不产生放行", () => {
    const engine = createPermissionEngine();
    const ctx = createPolicyContext({ autonomy: "gated" });
    ctx.approvalCache = { get: () => ({ decision: "allow" }) };
    const r = engine.decide(
      { name: "drop_table", category: "destructive", params: {} },
      { ...ctx, approvalCache: ctx.approvalCache }
    );
    assert.equal(r.decision, "deny");
  });

  test("mcp-policy 规则作用于工具名粒度,不伤其它工具", () => {
    const engine = createPermissionEngine();
    const rules = [{ id: "mcp-policy:project:write_notes", tool: "write_notes", decision: "allow", meta: { source: "mcp-policy" } }];
    // 用 mutate + read-only:默认矩阵本身就是 deny,放行只可能来自规则
    const ctx = createPolicyContext({ autonomy: "read-only", projectRules: rules });
    const granted = engine.decide({ name: "write_notes", category: "mutate", params: {} }, ctx);
    assert.equal(granted.decision, "allow");
    assert.equal(granted.source, "project-rules", "放行必须来自规则通道(与内置 projectRules 同一条路径)");

    const other = engine.decide({ name: "write_notes_backup", category: "mutate", params: {} }, ctx);
    assert.equal(other.decision, "deny", "未被授权的另一个工具不得被顺带放行");
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/tools/approval-cache.test.js
// ---------------------------------------------------------------------------
describe("unit/tools/approval-cache", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createApprovalCache } = await import("../../../src/tools/permissions/approval-cache.js");

  test("approval cache grants and expires decisions by fingerprint", () => {
    let now = 1000;
    const cache = createApprovalCache({ now: () => now });

    cache.grant("fp:abc", { decision: "allow", ttlMs: 500 });
    assert.equal(cache.get("fp:abc").decision, "allow");

    now = 1600;
    assert.equal(cache.get("fp:abc"), null);
  });

  test("approval cache rejects non-allow grants", () => {
    const cache = createApprovalCache();
    assert.throws(() => cache.grant("fp:abc", { decision: "deny", ttlMs: 1000 }), /only stores allow/);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/tools/command-policy-wiring.test.js
// ---------------------------------------------------------------------------
describe("unit/tools/command-policy-wiring", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { mkdtemp } = await import("../../helpers/tmp.js");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { createToolCall } = await import("../../../src/core/protocol/index.js");
  const { createToolRegistry } = await import("../../../src/tools/registry.js");
  const { createToolExecutor } = await import("../../../src/tools/executor.js");
  const { createPermissionEngine } = await import("../../../src/tools/permissions/permission-engine.js");
  const { createApprovalCache } = await import("../../../src/tools/permissions/approval-cache.js");
  const { createPolicyContext } = await import("../../../src/tools/permissions/policy-loader.js");
  const { createShellTool } = await import("../../../src/tools/builtin/shell.js");
  const { createGitTool } = await import("../../../src/tools/builtin/git.js");

  const MODES = ["supervised", "gated", "auto", "full-auto"];
  const ALL_MODES = ["read-only", ...MODES];

  function setup() {
    const registry = createToolRegistry({ tools: [createShellTool(), createGitTool()] });
    const engine = createPermissionEngine();
    const executor = createToolExecutor({ registry, permissionEngine: engine });
    return { registry, engine, executor };
  }

  async function projectRoot() {
    return mkdtemp(path.join(tmpdir(), "dsc-cmd-policy-"));
  }

  test("shell forbidden argv is denied in every autonomy mode", async () => {
    const { executor } = setup();
    const root = await projectRoot();
    for (const autonomy of ALL_MODES) {
      const result = await executor.execute(
        createToolCall({ name: "shell", params: { argv: ["format", "/?"] }, requestedByStepId: "step_1" }),
        createPolicyContext({ autonomy, projectRoot: root })
      );
      assert.equal(result.status, "denied", autonomy);
      assert.equal(result.metadata.permission.matched_rule, "hardcoded:destructive", autonomy);
    }
  });

  test("shell forbidden argv cannot be released by the approval cache", async () => {
    const { registry, engine, executor } = setup();
    const root = await projectRoot();
    const approvalCache = createApprovalCache();
    const context = createPolicyContext({ autonomy: "full-auto", projectRoot: root, approvalCache });
    const securedCall = registry.secureToolCall(
      createToolCall({ name: "shell", params: { argv: ["format", "/?"] }, requestedByStepId: "step_1" })
    );
    approvalCache.grant(engine.fingerprint(securedCall, context), { decision: "allow" });

    const result = await executor.execute(
      createToolCall({ name: "shell", params: { argv: ["format", "/?"] }, requestedByStepId: "step_1" }),
      context
    );

    assert.equal(result.status, "denied");
    assert.equal(result.metadata.permission.matched_rule, "hardcoded:destructive");
  });

  test("shell dangerous argv requires approval in all four autonomy modes", async () => {
    const { executor } = setup();
    const root = await projectRoot();
    for (const autonomy of MODES) {
      for (const argv of [["cmd", "/c", "npm", "test"], ["rm", "-rf", "x"]]) {
        const result = await executor.execute(
          createToolCall({ name: "shell", params: { argv }, requestedByStepId: "step_1" }),
          createPolicyContext({ autonomy, projectRoot: root })
        );
        assert.equal(result.status, "approval_required", `${autonomy} ${argv[0]}`);
      }
    }
  });

  test("shell dangerous argv stays denied in read-only, never softened to ask", async () => {
    const { executor } = setup();
    const root = await projectRoot();
    for (const argv of [["cmd", "/c", "npm", "test"], ["rm", "-rf", "x"], ["curl", "http://example.com"]]) {
      const result = await executor.execute(
        createToolCall({ name: "shell", params: { argv }, requestedByStepId: "step_1" }),
        createPolicyContext({ autonomy: "read-only", projectRoot: root })
      );
      assert.equal(result.status, "denied", argv[0]);
      assert.equal(result.metadata.permission.matched_rule, "default:read-only:execute_dangerous", argv[0]);
    }
  });

  test("shell safe argv keeps the existing execute matrix behavior", async () => {
    const { executor } = setup();
    const root = await projectRoot();
    const expected = { "read-only": "denied", supervised: "approval_required", gated: "approval_required", auto: "success", "full-auto": "success" };
    for (const autonomy of ALL_MODES) {
      const result = await executor.execute(
        createToolCall({ name: "shell", params: { argv: ["node", "--version"] }, requestedByStepId: "step_1" }),
        createPolicyContext({ autonomy, projectRoot: root })
      );
      assert.equal(result.status, expected[autonomy], autonomy);
    }
  });

  test("evasion spellings do not reach auto-allow through the execute category", async () => {
    const { executor } = setup();
    const root = await projectRoot();
    const context = () => createPolicyContext({ autonomy: "auto", projectRoot: root });

    for (const argv of [["cmd.", "/c", "whoami"], ["powershell.", "-c", "ls"], ["node", "--eval=console.log(1)"], ["git", "push", "-f", "origin", "main"]]) {
      const result = await executor.execute(
        createToolCall({ name: "shell", params: { argv }, requestedByStepId: "step_1" }),
        context()
      );
      assert.equal(result.status, "approval_required", argv.join(" "));
    }

    const forbidden = await executor.execute(
      createToolCall({ name: "shell", params: { argv: ["format.", "c:"] }, requestedByStepId: "step_1" }),
      context()
    );
    assert.equal(forbidden.status, "denied");
    assert.equal(forbidden.metadata.permission.matched_rule, "hardcoded:destructive");
  });

  test("git read ops keep read category and stay allowed", async () => {
    const { executor } = setup();
    const root = await projectRoot();
    const git = createGitTool();
    assert.equal(git.resolveCategory({ op: "status", argv: ["git", "status", "--short"] }), "read");

    const result = await executor.execute(
      createToolCall({ name: "git", params: { op: "status" }, requestedByStepId: "step_1" }),
      createPolicyContext({ autonomy: "supervised", projectRoot: root })
    );
    assert.equal(result.status, "success");
  });

  test("git resolveCategory classifies non-read argv defensively", async () => {
    const git = createGitTool();
    assert.equal(git.resolveCategory({ op: "push", argv: ["git", "push", "--force"] }), "execute_dangerous");
    assert.equal(git.resolveCategory({ op: "push", argv: ["git", "push", "origin", "main"] }), "read");
    assert.equal(git.resolveCategory({ op: "wipe", argv: ["format", "/?"] }), "destructive");
  });

  test("git push --force via shell requires approval in every mode", async () => {
    const { executor } = setup();
    const root = await projectRoot();
    for (const autonomy of MODES) {
      const result = await executor.execute(
        createToolCall({ name: "shell", params: { argv: ["git", "push", "--force", "origin", "main"] }, requestedByStepId: "step_1" }),
        createPolicyContext({ autonomy, projectRoot: root })
      );
      assert.equal(result.status, "approval_required", autonomy);
    }
  });

  test("approving a dangerous command replays through the approval cache", async () => {
    const { registry, engine, executor } = setup();
    const root = await projectRoot();
    const approvalCache = createApprovalCache();
    const context = createPolicyContext({ autonomy: "auto", projectRoot: root, approvalCache });
    const params = { argv: [process.execPath, "-e", "console.log('approved')"] };

    const first = await executor.execute(
      createToolCall({ name: "shell", params, requestedByStepId: "step_1" }),
      context
    );
    assert.equal(first.status, "approval_required");

    const securedCall = registry.secureToolCall(
      createToolCall({ name: "shell", params, requestedByStepId: "step_1" })
    );
    assert.equal(securedCall.category, "execute_dangerous");
    approvalCache.grant(engine.fingerprint(securedCall, context), { decision: "allow" });

    const replay = await executor.execute(
      createToolCall({ name: "shell", params, requestedByStepId: "step_1" }),
      context
    );
    assert.equal(replay.status, "success");
    assert.match(replay.content[0].text, /approved/);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/tools/grep-timeout.test.js
// ---------------------------------------------------------------------------
describe("unit/tools/grep-timeout", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { createGrepTool } = await import("../../../src/tools/builtin/grep.js");
  const { mkdtemp } = await import("../../helpers/tmp.js");

  test("grep tool skips a file when per-file budget is exhausted and keeps searching", async () => {
    const root = await timeoutFixtureWorkspace();
    // 调用序列（参照 execute 内 now() 的取样点）:
    // 1 totalStart / 2 文件一总预算预检 / 3 文件一 fileStart
    // 4 文件一 index 0 总预算 / 5 文件一 index 0 每文件预算(500-0 >= 100 → 跳过)
    // 6 文件二总预算预检 / 7 文件二 fileStart / 8+ 恒为 500 → 文件二不超时
    const now = sequenceClock([0, 0, 0, 0, 500], 500);
    const tool = createGrepTool({ now, totalTimeoutMs: 10_000, perFileTimeoutMs: 100 });

    const result = await tool.execute(
      { pattern: "unique_token_xyz", path: ".", max_matches: 200 },
      { projectRoot: root }
    );

    assert.equal(result.metadata.timed_out, true);
    assert.equal(result.metadata.timed_out_scope, "file");
    assert.equal(result.metadata.files_skipped_timeout >= 1, true);
    assert.equal(result.metadata.files_searched, 2);
    assert.equal(result.metadata.matches, 1);
    assert.match(result.content[0].text, /unique_token_xyz/);
  });

  test("grep tool stops entirely when total budget is exhausted", async () => {
    const root = await timeoutFixtureWorkspace();
    // 1 totalStart=0 / 2 文件一总预算预检=0 / 3 文件一 fileStart=0
    // 4 文件一 index 0 总预算=5000 >= 1000 → "total"，终止全部搜索
    const now = sequenceClock([0, 0, 0], 5000);
    const tool = createGrepTool({ now, totalTimeoutMs: 1000, perFileTimeoutMs: 1_000_000 });

    const result = await tool.execute(
      { pattern: "unique_token_xyz", path: ".", max_matches: 200 },
      { projectRoot: root }
    );

    assert.equal(result.metadata.timed_out, true);
    assert.equal(result.metadata.timed_out_scope, "total");
    assert.equal(result.metadata.files_searched, 1);
    assert.equal(result.metadata.files_skipped_timeout, 0);
    assert.equal(result.metadata.matches, 0);
    assert.equal(result.content[0].text.includes("unique_token_xyz"), false);
  });

  test("grep tool reports no timeout on the normal path with real clock", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-grep-normal-"));
    await writeFile(path.join(root, "app.txt"), "say hello\n", "utf8");
    const tool = createGrepTool();

    const result = await tool.execute(
      { pattern: "hello", path: ".", max_matches: 200 },
      { projectRoot: root }
    );

    assert.equal(result.metadata.matches, 1);
    assert.equal(result.metadata.timed_out, false);
    assert.equal(result.metadata.timed_out_scope, null);
    assert.equal(result.metadata.files_skipped_timeout, 0);
  });

  function sequenceClock(values, fallback) {
    let calls = 0;
    return () => {
      const value = calls < values.length ? values[calls] : fallback;
      calls += 1;
      return value;
    };
  }

  async function timeoutFixtureWorkspace() {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-grep-timeout-"));
    await mkdir(path.join(root, "a"));
    await mkdir(path.join(root, "b"));
    const manyLines = Array.from({ length: 200 }, (_, i) => `aaa line ${i}`).join("\n");
    await writeFile(path.join(root, "a", "one.txt"), manyLines, "utf8");
    await writeFile(path.join(root, "b", "two.txt"), "unique_token_xyz\n", "utf8");
    return root;
  }
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/tools/schema.test.js
// ---------------------------------------------------------------------------
describe("unit/tools/schema", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { validateToolParams, toDeepSeekToolSchema } = await import("../../../src/tools/schema.js");

  const schema = {
    path: { type: "string" },
    mode: { type: "string", enum: ["read", "write"], default: "read" },
    limit: { type: "number", required: false },
    tags: { type: "array", required: false },
    internal_flag: { type: "boolean", required: false, internal: true }
  };

  test("validateToolParams accepts required params and applies defaults", () => {
    const params = validateToolParams("memory", schema, { path: "README.md" });
    assert.deepEqual(params, { path: "README.md", mode: "read" });
  });

  test("validateToolParams rejects missing required params", () => {
    assert.throws(
      () => validateToolParams("read", schema, {}),
      /missing required param: path/
    );
  });

  test("validateToolParams rejects unknown params", () => {
    assert.throws(
      () => validateToolParams("read", schema, { path: "README.md", extra: true }),
      /unknown param/
    );
  });

  test("validateToolParams checks type and enum", () => {
    assert.throws(() => validateToolParams("read", schema, { path: 3 }), /must be string/);
    assert.throws(() => validateToolParams("read", schema, { path: "a", mode: "delete" }), /must be one of/);
  });

  test("toDeepSeekToolSchema emits function tool schema", () => {
    const tool = toDeepSeekToolSchema({
      name: "read",
      description: "Read file",
      params: schema
    });

    assert.equal(tool.type, "function");
    assert.equal(tool.function.name, "read");
    assert.deepEqual(tool.function.parameters.required, ["path"]);
    assert.equal(tool.function.parameters.properties.mode.default, "read");
    assert.equal(tool.function.parameters.properties.internal_flag, undefined);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/tools/registry.test.js
// ---------------------------------------------------------------------------
describe("unit/tools/registry", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createBuiltinTools } = await import("../../../src/tools/builtin/index.js");
  const { createToolRegistry } = await import("../../../src/tools/registry.js");

  test("builtin registry exposes expected tools", () => {
    const registry = createToolRegistry({ tools: createBuiltinTools() });
    const names = registry.listTools().map((tool) => tool.name).sort();

    assert.deepEqual(names, [
      "ask_user", "diff_apply", "diff_preview", "diff_rollback", "edit",
      "git", "glob", "grep", "ls", "memory", "read", "shell", "task", "test", "web_fetch"
    ].sort());
  });

  test("registry rejects duplicate tool names", () => {
    const registry = createToolRegistry();
    registry.register({ name: "x", description: "x", category: "read", params: {}, execute: async () => ({ content: [] }) });
    assert.throws(
      () => registry.register({ name: "x", description: "x", category: "read", params: {}, execute: async () => ({ content: [] }) }),
      /already registered/
    );
  });

  test("registry filters tools and exports DeepSeek schemas", () => {
    const registry = createToolRegistry({ tools: createBuiltinTools() });

    assert.ok(registry.listTools({ category: "read" }).some((tool) => tool.name === "read"));
    const schemas = registry.toDeepSeekTools();
    assert.ok(schemas.some((schema) => schema.function.name === "read"));
  });

  test("registry normalization uses tool normalizeParams hook", () => {
    const registry = createToolRegistry({ tools: createBuiltinTools() });

    assert.throws(
      () => registry.normalizeParams("shell", { cmd: "npm test" }),
      /structured argv/
    );
  });

  test("registry secureToolCall normalizes params and uses definition category", () => {
    const registry = createToolRegistry({
      tools: [{
        name: "memory",
        description: "memory",
        category: "read",
        risk_level: "medium",
        side_effect: "none",
        params: {
          action: { type: "string" },
          key: { type: "string", required: false }
        },
        resolveCategory: (params) => params.action === "write" ? "write_update" : "read",
        execute: async () => ({ status: "success", content: [] })
      }]
    });

    const secured = registry.secureToolCall({
      id: "call_1",
      name: "memory",
      params: { action: "write", key: "style" },
      category: "read_secret",
      requested_by_step_id: "step_1"
    });

    assert.equal(secured.name, "memory");
    assert.equal(secured.category, "write_update");
    assert.equal(secured.risk_level, "medium");
    assert.equal(secured.requested_by_step_id, "step_1");
    assert.deepEqual(secured.params, { action: "write", key: "style" });
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/tools/permission-risk-escalation.test.js
// ---------------------------------------------------------------------------
describe("tools/permission-risk-escalation", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createPermissionEngine } = await import("../../../src/tools/permissions/permission-engine.js");
  const { riskRules } = await import("../../../src/core/memory/risk-rules.js");

  const pe = createPermissionEngine();
  const esc = riskRules(new Set(["migrate"]));            // [{ escalate_only, cue:"migrate", id }]
  const writeMigrate = { name: "edit", category: "write_update", params: { path: "db/migrate/001.js" } };
  const writePlain = { name: "edit", category: "write_update", params: { path: "src/util.js" } };

  test("default-matrix allow + risk cue match => ask (escalated)", () => {
    const d = pe.decide(writeMigrate, { autonomy: "gated", projectRules: esc });
    assert.equal(d.decision, "ask");
    assert.equal(d.source, "risk-experience");
    assert.equal(d.escalated, true);
  });

  test("no cue match => allow unchanged", () => {
    const d = pe.decide(writePlain, { autonomy: "gated", projectRules: esc });
    assert.equal(d.decision, "allow");
    assert.equal(d.source, "default-matrix");
  });

  test("never downgrades a deny (read-only write stays deny)", () => {
    const d = pe.decide(writeMigrate, { autonomy: "read-only", projectRules: esc });
    assert.equal(d.decision, "deny");
  });

  test("never downgrades an ask (supervised write stays ask)", () => {
    const d = pe.decide(writeMigrate, { autonomy: "supervised", projectRules: esc });
    assert.equal(d.decision, "ask");
    assert.notEqual(d.source, "risk-experience"); // not an escalation, it was already ask
  });

  test("does NOT override explicit user trust allow", () => {
    const trustStore = { rules: [{ id: "t", tool: "edit", decision: "allow" }] };
    const d = pe.decide(writeMigrate, { autonomy: "gated", projectRules: esc, trustStore });
    assert.equal(d.decision, "allow");
    assert.equal(d.source, "user-trust-store");
  });

  test("escalate_only rule is never returned by the normal projectRules loop", () => {
    // even if it carries a (bogus) decision and would 'match', it must be ignored as a normal rule
    const sneaky = [{ escalate_only: true, cue: "anything", id: "r", decision: "deny", tool: "read" }];
    const d = pe.decide({ name: "read", category: "read", params: {} }, { autonomy: "gated", projectRules: sneaky });
    assert.equal(d.decision, "allow"); // read stays allow; the deny on the escalate_only rule is ignored
  });

  test("cue match against argv/command surface", () => {
    const d = pe.decide({ name: "shell", category: "execute", params: { argv: ["psql", "-f", "migrate.sql"] } }, { autonomy: "auto", projectRules: esc });
    assert.equal(d.decision, "ask"); // execute is allow under auto -> escalated to ask
  });

  test("destructive always deny regardless of risk rules", () => {
    const d = pe.decide({ name: "x", category: "destructive", params: { path: "migrate" } }, { autonomy: "gated", projectRules: esc });
    assert.equal(d.decision, "deny");
    assert.equal(d.source, "safety-invariant");
  });

  test("no risk rules => decide byte-identical to today", () => {
    const d = pe.decide(writeMigrate, { autonomy: "gated" });
    assert.equal(d.decision, "allow");
    assert.equal(d.source, "default-matrix");
  });

  test("riskRules maps cues; empty in => empty out", () => {
    assert.equal(riskRules(new Set(["a", "b"])).length, 2);
    assert.ok(riskRules(new Set(["A"]))[0].cue === "a"); // lowercased
    assert.deepEqual(riskRules(new Set()), []);
    assert.deepEqual(riskRules(), []);
  });
});
