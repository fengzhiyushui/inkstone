// tests/integration/orchestration-and-closure.test.js — 编排聚合预算、子任务委派、修复重试与跨域验收
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { writeFile } from "node:fs/promises";
import { mkdtemp } from "../helpers/tmp.js";
import { createOrchestrator } from "../../src/core/orchestration/orchestrator.js";
import { createCostBudget } from "../../src/core/runtime/cost-budget.js";
import { createIso, removeIso } from "../../src/core/orchestration/iso-workspace.js";
import { runRepairLoop } from "../../src/core/verification/repair-loop.js";
import { createTaskRouter } from "../../src/core/orchestration/task-router.js";
import { createPlanner } from "../../src/core/orchestration/planner.js";
import { runDispatchLoop } from "../../src/core/orchestration/dispatch-loop.js";

test("multi-round 编排循环与任务预算上限检查", async () => {
  const budget = createCostBudget({ maxTokens: 50 });
  budget.recordModelResult({ usage: { total_tokens: 60 } });

  const orchestrator = createOrchestrator({
    planner: {
      plan: async () => ({
        task_summary: "budget-test",
        done_when: "complete",
        subtasks: [{ id: "st_1", goal: "do work", acceptance: [], context_scope: {}, tool_profile: "readonly", depends_on: [] }]
      })
    },
    makeWorkerFactory: () => ({
      worker: () => ({ send: async () => ({ status: "complete", content: "ok" }) }),
      reviewerRuntime: () => ({})
    }),
    makeReviewerFor: () => ({ review: async () => ({ pass: true, severity: "info", reasons: [], checked: [] }) }),
    synthesizer: { synthesize: async () => "synthesized" },
    makeBudget: () => budget,
    maxSubtasks: 5,
    maxWorkerAttempts: 1,
    maxRounds: 2
  });

  const res = await orchestrator.run({ message: "run with budget cap" });
  assert.equal(res.status, "complete");
  assert.ok(res.collected);
});

test("task delegation 子任务委派与分支工作区隔离", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-delegation-iso-"));
  await writeFile(path.join(root, "package.json"), "{\"name\":\"delegation-test\"}\n");

  const isoDir = await createIso({ root, runId: "delegation_run_1", subtaskId: "sub_task_1" });
  assert.ok(isoDir.includes("sub_task_1"));

  const cleaned = await removeIso(path.dirname(isoDir));
  assert.equal(cleaned, true);
});

test("repair-loop 验证失败自动修复与工具语法重试", async () => {
  let repairAttempts = 0;
  const mockGateway = {
    invoke: async () => {
      repairAttempts += 1;
      return { content: "repaired syntax", tool_calls: [], usage: { total_tokens: 5 } };
    }
  };

  const repairResult = await runRepairLoop({
    turnId: "turn_int_rep_1",
    userMessage: "fix test",
    modelGateway: mockGateway,
    initialVerification: { status: "failed", ok: false, failures: ["assertion failed"] },
    maxRepairAttempts: 2,
    runVerifierImpl: async () => ({ status: "passed", ok: true, failures: [] }),
    executeTool: async () => ({ status: "success" }),
    createPolicyContext: () => ({ autonomyLevel: "full-auto" })
  });

  assert.equal(repairResult.status, "complete");
  assert.ok(repairAttempts >= 1);
});

test("cross-domain acceptance 端到端闭环（路由-规划-调度-合成）", async () => {
  const router = createTaskRouter();
  const decision = router.route("请分别重构模块 A 和模块 B 并添加测试");
  assert.equal(decision.lane, "orchestrate");

  const planner = createPlanner({
    callModel: async () => JSON.stringify({
      task_summary: "refactor A and B",
      done_when: "both tested",
      subtasks: [
        { id: "sub_a", goal: "refactor A", acceptance: [], context_scope: {}, tool_profile: "edit", depends_on: [] },
        { id: "sub_b", goal: "refactor B", acceptance: [], context_scope: {}, tool_profile: "edit", depends_on: ["sub_a"] }
      ]
    })
  });

  const plan = await planner.plan({ message: "refactor A and B" });
  assert.equal(plan.subtasks.length, 2);

  const history = [];
  const loopResult = await runDispatchLoop({
    plan,
    workerFactory: {
      worker: (subtask) => ({
        send: async () => {
          history.push(subtask.id);
          return { status: "complete", content: `done:${subtask.id}` };
        }
      })
    },
    makeReviewer: () => ({ review: async () => ({ pass: true, severity: "info", reasons: [], checked: [] }) }),
    synthesizer: { synthesize: async ({ collected }) => `all_done:${collected.map((c) => c.st.id).join(",")}` },
    budget: { exceeded: () => null },
    maxWorkerAttempts: 1,
    autonomy: "auto"
  });

  assert.deepEqual(history, ["sub_a", "sub_b"]);
  assert.equal(loopResult.status, "complete");
  assert.equal(loopResult.content, "all_done:sub_a,sub_b");
});
