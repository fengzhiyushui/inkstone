import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "../../helpers/tmp.js";

import { tmpdir } from "node:os";
import path from "node:path";
import { createToolCall } from "../../../src/core/protocol/index.js";
import { createToolRegistry } from "../../../src/tools/registry.js";
import { createToolExecutor } from "../../../src/tools/executor.js";
import { createPermissionEngine } from "../../../src/tools/permissions/permission-engine.js";
import { createApprovalCache } from "../../../src/tools/permissions/approval-cache.js";
import { createPolicyContext } from "../../../src/tools/permissions/policy-loader.js";
import { createShellTool } from "../../../src/tools/builtin/shell.js";
import { createGitTool } from "../../../src/tools/builtin/git.js";

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
