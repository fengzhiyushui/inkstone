// tests/unit/orchestration-and-memory.test.js — 任务路由、规划调度、隔离环境、编排恢复与经验记忆
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "../helpers/tmp.js";
import { createTaskRouter } from "../../src/core/orchestration/task-router.js";
import { createPlanner } from "../../src/core/orchestration/planner.js";
import { runDispatchLoop } from "../../src/core/orchestration/dispatch-loop.js";
import { createIso, removeIso } from "../../src/core/orchestration/iso-workspace.js";
import { createOrchestrator } from "../../src/core/orchestration/orchestrator.js";
import { createOrchestrationPersistence } from "../../src/core/recovery/orchestration-persistence.js";
import { ORCH_RECOVERY_SCHEMA_VERSION } from "../../src/core/orchestration/orchestration-recovery-contract.js";
import { validateEntry, validatePending, clamp01 } from "../../src/core/memory/experience-schema.js";
import { score } from "../../src/core/memory/experience-scoring.js";
import { createExperienceStore } from "../../src/core/memory/experience-store.js";
import { query } from "../../src/core/memory/experience-retrieval.js";
import { riskRules } from "../../src/core/memory/risk-rules.js";

test("task-router 路由启发式（单任务与多任务编排分流）", () => {
  const router = createTaskRouter();

  const singleDecision = router.route("fix typo in a.js");
  assert.equal(singleDecision.lane, "single");

  const multiDecision = router.route("给这几个模块分别加输入校验并更新文档");
  assert.equal(multiDecision.lane, "orchestrate");
  assert.ok(multiDecision.score > 0);
  assert.ok(multiDecision.signals.length > 0);
  assert.ok(multiDecision.reason);
});

test("planner 结构化规划验证与模型输出解析与拓扑排序", async () => {
  const validPlanJson = JSON.stringify({
    task_summary: "refactor and test",
    done_when: "both subtasks succeed",
    subtasks: [
      { id: "st_1", goal: "implement helper", acceptance: ["helper works"], context_scope: {}, tool_profile: "edit", depends_on: [] },
      { id: "st_2", goal: "write unit tests", acceptance: ["tests pass"], context_scope: {}, tool_profile: "readonly", depends_on: ["st_1"] }
    ]
  });

  const planner = createPlanner({ callModel: async () => validPlanJson });
  const plan = await planner.plan({ message: "refactor helper and write tests", context: null });

  assert.equal(plan.subtasks.length, 2);
  assert.equal(plan.subtasks[0].id, "st_1");
  assert.equal(plan.subtasks[1].id, "st_2");
});

test("dispatch-loop 拓扑执行、多轮审查与结果合成", async () => {
  const executionOrder = [];
  const workerFactory = {
    worker: (subtask) => ({
      send: async () => {
        executionOrder.push(subtask.id);
        return { status: "complete", content: `result:${subtask.id}` };
      }
    })
  };

  const plan = {
    subtasks: [
      { id: "sub_b", goal: "b", acceptance: [], context_scope: {}, tool_profile: "edit", depends_on: ["sub_a"] },
      { id: "sub_a", goal: "a", acceptance: [], context_scope: {}, tool_profile: "edit", depends_on: [] }
    ]
  };

  const result = await runDispatchLoop({
    plan,
    workerFactory,
    makeReviewer: () => ({ review: async () => ({ pass: true, severity: "info", reasons: [], checked: [] }) }),
    synthesizer: { synthesize: async ({ collected }) => `synth:${collected.map((c) => c.st.id).join(",")}` },
    budget: { exceeded: () => null },
    maxWorkerAttempts: 2,
    autonomy: "auto"
  });

  assert.deepEqual(executionOrder, ["sub_a", "sub_b"]);
  assert.equal(result.status, "complete");
  assert.equal(result.content, "synth:sub_a,sub_b");
});

test("iso-workspace 隔离环境目录创建、写入与安全清理", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "dsc-iso-test-"));
  const isoDir = await createIso({ root: tempRoot, runId: "run_test_1", subtaskId: "st_work_1" });

  assert.ok(isoDir.includes("run_test_1"));
  assert.ok(isoDir.includes("st_work_1"));

  const cleaned = await removeIso(path.dirname(isoDir));
  assert.equal(cleaned, true);
});

test("orchestrator 端到端编排循环与事件发射", async () => {
  const events = [];
  const fakeBus = {
    publish(name, payload) {
      events.push({ name, payload });
    }
  };

  const plan = {
    task_summary: "orchestrate task",
    done_when: "complete",
    subtasks: [
      { id: "st_1", goal: "step 1", acceptance: [], context_scope: {}, tool_profile: "readonly", depends_on: [] }
    ]
  };

  const orchestrator = createOrchestrator({
    planner: { plan: async () => plan },
    makeWorkerFactory: () => ({
      worker: () => ({ send: async () => ({ status: "complete", content: "worker output" }) }),
      reviewerRuntime: () => ({})
    }),
    makeReviewerFor: () => ({ review: async () => ({ pass: true, severity: "info", reasons: [], checked: [] }) }),
    synthesizer: { synthesize: async ({ collected }) => `final:${collected[0]?.status}` },
    makeBudget: () => ({ exceeded: () => null, recordModelResult: () => {} }),
    maxSubtasks: 5,
    maxWorkerAttempts: 1,
    eventBus: fakeBus,
    makeContext: async () => null,
    maxRounds: 1
  });

  const turn = await orchestrator.run({ message: "do subtask" });
  assert.equal(turn.status, "complete");
  assert.ok(events.some((e) => e.name === "orchestration:planned"));
  assert.ok(events.some((e) => e.name === "orchestration:completed"));
});

test("orchestration-recovery 暂停持久化存储与 sidecar 校验", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "dsc-orch-rec-"));
  const persistence = createOrchestrationPersistence({ root: tempRoot, projectId: "proj_rec_1" });

  const validRecord = {
    schemaVersion: ORCH_RECOVERY_SCHEMA_VERSION,
    approvalId: "app_orch_1",
    taskId: "task_1",
    sessionId: "sess_1",
    message: "orchestration paused",
    done_when: "approval granted",
    round: 1,
    plan: { subtasks: [{ id: "st_1" }] },
    pausedSubtask: { id: "st_1" },
    remaining: [],
    budget: { spentTokens: 50, spentCalls: 1 },
    seenSubtaskIds: ["st_1"],
    seenFp: ["fp1"]
  };

  await persistence.save("app_orch_1", validRecord);
  const loaded = await persistence.load("app_orch_1");
  assert.equal(loaded.approvalId, "app_orch_1");
  assert.equal(loaded.taskId, "task_1");

  const consumeResult = await persistence.consume("app_orch_1");
  assert.equal(consumeResult.status, "deleted");

  await assert.rejects(
    async () => persistence.load("app_orch_1"),
    (err) => err.code === "ENOENT"
  );
});

test("experience-schema 与多层级经验记录校验、置信度与评分", () => {
  assert.equal(clamp01(1.5), 1);
  assert.equal(clamp01(-0.2), 0);
  assert.equal(clamp01(0.75), 0.75);

  const now = Date.now();
  const validEntry = {
    id: "exp_1",
    kind: "procedural",
    lesson: "always use path safety",
    cues: ["fs", "path", "security"],
    provenance: { taskId: "t1" },
    confidence: 0.8,
    validations: 2,
    misleads: 0,
    created: new Date(now).toISOString(),
    lastReinforced: new Date(now).toISOString(),
    tier: 1
  };
  assert.equal(validateEntry(validEntry), null);

  const invalidEntry = { ...validEntry, kind: "unknown_kind" };
  assert.match(validateEntry(invalidEntry), /kind/);

  const s = score(validEntry, () => now);
  assert.ok(s > 0);
});

test("experience-store 持久化与 experience-retrieval 线索检索与风险规则映射", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "dsc-exp-store-"));
  const store = createExperienceStore({ dir: tempDir });

  await store.put({
    id: "exp_db_1",
    kind: "procedural",
    lesson: "run database migrations before deployment",
    cues: ["database", "migration", "deploy"],
    provenance: { taskId: "t_db" },
    confidence: 0.9,
    validations: 1,
    misleads: 0,
    created: new Date().toISOString(),
    lastReinforced: new Date().toISOString(),
    tier: 1
  });

  await store.put({
    id: "exp_risk_1",
    kind: "risk",
    lesson: "destructive drop database",
    cues: ["drop", "database"],
    provenance: { taskId: "t_risk" },
    confidence: 0.95,
    validations: 1,
    misleads: 0,
    created: new Date().toISOString(),
    lastReinforced: new Date().toISOString(),
    tier: 1
  });

  const queryResult = query(store, { message: "run migration on database drop table" });
  assert.ok(queryResult.procedural.length >= 1);
  assert.equal(queryResult.procedural[0].id, "exp_db_1");

  const rules = riskRules(queryResult.riskCues);
  assert.ok(rules.length >= 1);
  assert.ok(rules.every((r) => r.escalate_only === true));
});
