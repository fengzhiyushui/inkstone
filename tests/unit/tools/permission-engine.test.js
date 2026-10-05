import test from "node:test";
import assert from "node:assert/strict";
import {
  createPermissionEngine,
  DEFAULT_POLICY_MATRIX,
  globMatch
} from "../../../src/tools/permissions/permission-engine.js";
import { createPolicyContext } from "../../../src/tools/permissions/policy-loader.js";

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
