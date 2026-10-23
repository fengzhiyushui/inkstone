import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { createKernel } from "../../src/index.js";
import { createOrchestrationPersistence } from "../../src/core/recovery/orchestration-persistence.js";
import { createPausedTurnPersistence } from "../../src/core/recovery/paused-turn-persistence.js";
import { mkdtemp } from "../helpers/tmp.js";

function modelResponse(message) {
  return {
    ok: true,
    status: 200,
    headers: new Map(),
    json: async () => ({
      choices: [{ finish_reason: message.tool_calls ? "tool_calls" : "stop", message }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
    }),
    text: async () => ""
  };
}

test("kernel blocks ambiguous legacy token debt during scan and resume without consuming sidecars or approving edits", { timeout: 15000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orch-legacy-budget-"));
  const projectId = "legacy-budget-project";
  const filePath = path.join(root, "a.js");
  const original = "const value = 1;\n";
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "legacy-budget-fixture" }) + "\n");
  await writeFile(filePath, original);

  const options = {
    sessionLog: null,
    branchStore: null,
    verifyMode: "off",
    projectId,
    recovery: { enabled: true, lock: false, surface: "cli" },
    orchestration: {
      router: { minComplexFiles: 1, model: { enabled: false } },
      budget: { maxTokens: 5000, maxModelCalls: 10 }
    }
  };
  let kernelA;
  let kernelB;
  t.after(async () => {
    if (kernelB) await kernelB.dispose();
    if (kernelA) await kernelA.dispose();
  });

  kernelA = await createKernel(root, {
    ...options,
    sessionId: "legacy-budget-original",
    deepseek: {
      apiKey: "mock-key-no-network",
      fetchImpl: async (_url, init) => {
        if (init.body.includes("Break the user's request")) {
          return modelResponse({ role: "assistant", content: JSON.stringify({
            task_summary: "Update a.js",
            done_when: "a.js contains the new value",
            subtasks: [{
              id: "st_1", goal: "Update a.js", acceptance: ["value is 2"],
              context_scope: { files: ["a.js"] }, tool_profile: "edit", depends_on: []
            }]
          }) });
        }
        return modelResponse({
          role: "assistant",
          content: "",
          tool_calls: [{
            id: "edit_a",
            type: "function",
            function: {
              name: "diff_apply",
              arguments: JSON.stringify({ diff: "--- a/a.js\n+++ b/a.js\n@@ -1,1 +1,1 @@\n-const value = 1;\n+const value = 2;\n" })
            }
          }]
        });
      }
    }
  });

  const paused = await kernelA.agent.send("Update a.js", { autonomy: "supervised" });
  assert.equal(paused.status, "awaiting_approval");
  assert.equal(await readFile(filePath, "utf8"), original, "the proposed edit is still awaiting approval");
  await kernelA.dispose();
  kernelA = null;

  const approvalId = paused.approval.id;
  const orchestration = createOrchestrationPersistence({ root, projectId });
  const workers = createPausedTurnPersistence({ root, projectId });
  const sidecar = await orchestration.load(approvalId);
  await workers.load(approvalId); // Validate the real matching worker sidecar before changing the history fixture.
  assert.equal(sidecar.budget.spentCalls, 2, "planner and worker produced a real durable approval");

  // Historical fixture: an earlier unknown charge of 500 was restored without
  // role attribution, then a later request added 4020 to both debt and byRole.
  // Old sidecars stored two unknown attempts but omitted the actual 4520 debt
  // and fallback policy. The role total (4020) cannot safely recover that debt.
  // Keep real ownership, paused-tool state and attempt IDs; no git history is needed.
  sidecar.budget = {
    ...sidecar.budget,
    spentTokens: 0,
    unknownUsageAttempts: 2,
    byRole: { planner: { calls: 1, tokens: 0 }, worker: { calls: 1, tokens: 4020 } }
  };
  delete sidecar.budget.unknownUsageTokens;
  delete sidecar.budget.fallbackTokensPerUnknown;
  await orchestration.save(approvalId, sidecar);

  const orchestrationPath = path.join(orchestration.baseDir, `${approvalId}.json`);
  const workerPath = path.join(workers.baseDir, `${approvalId}.json`);
  const orchestrationBytes = await readFile(orchestrationPath, "utf8");
  const workerBytes = await readFile(workerPath, "utf8");
  let resumedFetches = 0;
  kernelB = await createKernel(root, {
    ...options,
    sessionId: "legacy-budget-restarted",
    deepseek: {
      apiKey: "mock-key-no-network",
      fetchImpl: async () => {
        resumedFetches += 1;
        throw new Error("ambiguous legacy recovery must be blocked before model execution");
      }
    }
  });

  const recoveryId = `rec_orch_${approvalId}`;
  const item = (await kernelB.recovery.list()).find((candidate) => candidate.id === recoveryId);
  assert.ok(item, "startup scan presents the matching orchestration record");
  assert.equal(item.status, "blocked");
  assert.equal(item.type, "blocked_recovery");
  assert.match(item.evidence.reason, /unknown.*(usage|liability|token)|legacy.*budget/i);
  assert.equal(item.allowed_actions.includes("resume"), false);

  await assert.rejects(kernelB.recovery.resume(recoveryId, { decision: "approve" }), {
    code: "ORCH_RECOVERY_BLOCKED"
  });
  assert.equal(resumedFetches, 0, "scan and resume never make a model request");
  assert.equal(await readFile(filePath, "utf8"), original, "blocked resume never executes the approved edit");
  assert.equal(await readFile(orchestrationPath, "utf8"), orchestrationBytes, "orchestration history is retained unchanged");
  assert.equal(await readFile(workerPath, "utf8"), workerBytes, "pending tool approval is retained unchanged");
  const after = (await kernelB.recovery.list()).find((candidate) => candidate.id === recoveryId);
  assert.equal(after.status, "blocked", "a rejected resume cannot mark the record resumed");
});
