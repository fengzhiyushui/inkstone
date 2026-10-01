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
