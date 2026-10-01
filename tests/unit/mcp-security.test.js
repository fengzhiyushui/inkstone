import test from "node:test";
import assert from "node:assert/strict";
import { createPermissionEngine } from "../../src/tools/permissions/permission-engine.js";

test("PermissionEngine evaluates MCP tools based on category and autonomy", () => {
  const engine = createPermissionEngine();

  // 1. Read category allows under gated
  const readCall = {
    id: "call-1",
    name: "mcp__db__query",
    category: "read",
    params: { sql: "SELECT * FROM users" }
  };
  const readDecision = engine.decide(readCall, { autonomy: "gated" });
  assert.equal(readDecision.decision, "allow");

  // 2. Mutate category asks under gated
  const mutateCall = {
    id: "call-2",
    name: "mcp__db__drop_table",
    category: "mutate",
    params: { sql: "DROP TABLE users" }
  };
  const mutateDecision = engine.decide(mutateCall, { autonomy: "gated" });
  assert.equal(mutateDecision.decision, "ask");

  // 3. Mutate category allows under full-auto
  const autoDecision = engine.decide(mutateCall, { autonomy: "full-auto" });
  assert.equal(autoDecision.decision, "allow");

  // 4. Mutate category denies under read-only
  const readOnlyDecision = engine.decide(mutateCall, { autonomy: "read-only" });
  assert.equal(readOnlyDecision.decision, "deny");

  // 5. Destructive always denies
  const destructiveCall = {
    id: "call-3",
    name: "mcp__fs__format_disk",
    category: "destructive"
  };
  const destructiveDecision = engine.decide(destructiveCall, { autonomy: "full-auto" });
  assert.equal(destructiveDecision.decision, "deny");
});

test("PermissionEngine honors autoApprove on tool call", () => {
  const engine = createPermissionEngine();

  const mutateCallWithApproval = {
    id: "call-4",
    name: "mcp__github__create_issue",
    category: "mutate",
    autoApprove: true,
    params: { title: "Bug" }
  };

  const decision = engine.decide(mutateCallWithApproval, { autonomy: "gated" });
  assert.equal(decision.decision, "allow");
  assert.equal(decision.matched_rule, "mcp:auto-approve");
});
