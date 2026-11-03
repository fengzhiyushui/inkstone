// tests/unit/core/cost-and-approval-store.test.js — 成本预算与暂停轮次存储领域测试
//
// v1.19.1 测试归并:本文件由下列历史任务单测试合并而成,每个来源包裹在独立
// describe 块中(异步回调 + 动态 import,来源间零共享绑定),测试语义与拆分前一致。
import { describe } from "node:test";

// ---------------------------------------------------------------------------
// 来源:tests/unit/core/runtime/cost-budget.test.js
// ---------------------------------------------------------------------------
describe("unit/core/runtime/cost-budget", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createCostBudget } = await import("../../../src/core/runtime/cost-budget.js");

  test("null limits never exceed", () => {
    const b = createCostBudget({});
    b.recordModelResult({ usage: { total_tokens: 999999 } });
    assert.equal(b.exceeded(), null);
    b.check(); // 不抛
    assert.deepEqual(b.snapshot(), { tokens: 999999, model_calls: 1, max_tokens: null, max_model_calls: null });
  });

  test("max_tokens trips after accumulation", () => {
    const b = createCostBudget({ maxTokens: 100 });
    b.recordModelResult({ usage: { total_tokens: 60 } });
    assert.equal(b.exceeded(), null);
    b.recordModelResult({ usage: { total_tokens: 60 } }); // 累计 120 >= 100
    assert.equal(b.exceeded().reason, "max_tokens");
    assert.throws(() => b.check(), (e) => e.code === "BUDGET_EXCEEDED" && e.details.reason === "max_tokens");
  });

  test("total_tokens falls back to prompt+completion", () => {
    const b = createCostBudget({ maxTokens: 50 });
    b.recordModelResult({ usage: { prompt_tokens: 30, completion_tokens: 25 } }); // 55
    assert.equal(b.exceeded().reason, "max_tokens");
  });

  test("max_model_calls trips after N calls", () => {
    const b = createCostBudget({ maxModelCalls: 2 });
    b.recordModelResult({ usage: { total_tokens: 1 } });
    b.check();
    b.recordModelResult({ usage: { total_tokens: 1 } });
    assert.throws(() => b.check(), (e) => e.code === "BUDGET_EXCEEDED" && e.details.reason === "max_model_calls");
  });

  test("missing usage still counts a model call", () => {
    const b = createCostBudget({ maxModelCalls: 1 });
    b.recordModelResult({});
    assert.equal(b.snapshot().model_calls, 1);
    assert.throws(() => b.check(), (e) => e.code === "BUDGET_EXCEEDED");
  });

  test("initial seeds continue deducting from prior spend (durable resume — CST-8)", () => {
    const b = createCostBudget({ maxTokens: 100, initialTokens: 90 });
    assert.equal(b.snapshot().tokens, 90);
    assert.equal(b.exceeded(), null);
    b.recordModelResult({ usage: { total_tokens: 15 } }); // 90 + 15 = 105 >= 100
    assert.equal(b.exceeded().reason, "max_tokens");
  });

  test("initial model-call seed can already be at cap on resume", () => {
    const b = createCostBudget({ maxModelCalls: 3, initialModelCalls: 3 });
    assert.equal(b.snapshot().model_calls, 3);
    assert.equal(b.exceeded().reason, "max_model_calls");
  });

  test("default seeds are zero (no regression)", () => {
    const b = createCostBudget({ maxTokens: 100 });
    assert.deepEqual(b.snapshot(), { tokens: 0, model_calls: 0, max_tokens: 100, max_model_calls: null });
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/core/approval/paused-turn-store.test.js
// ---------------------------------------------------------------------------
describe("unit/core/approval/paused-turn-store", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createPausedTurnStore } = await import("../../../src/core/approval/paused-turn-store.js");

  test("paused turn store saves gets and takes records once", () => {
    const store = createPausedTurnStore({ now: () => "2026-05-30T00:00:00.000Z" });
    const record = {
      approval_id: "approval_1",
      turn_id: "turn_1",
      approval: { id: "approval_1" },
      turn: { id: "turn_1" },
      resume_state: { pending_tool_call: { id: "call_1" } }
    };

    store.save(record);

    assert.equal(store.size(), 1);
    assert.equal(store.get("approval_1").created_at, "2026-05-30T00:00:00.000Z");
    assert.equal(store.take("approval_1").turn_id, "turn_1");
    assert.equal(store.get("approval_1"), null);
    assert.equal(store.take("approval_1"), null);
  });

  test("paused turn store rejects duplicate approval ids", () => {
    const store = createPausedTurnStore();
    const record = {
      approval_id: "approval_1",
      turn_id: "turn_1",
      approval: { id: "approval_1" },
      turn: { id: "turn_1" },
      resume_state: {}
    };

    store.save(record);

    assert.throws(() => store.save(record), /paused approval already exists/);
  });

  test("paused turn store deletes records for a turn and clears all", () => {
    const store = createPausedTurnStore();
    store.save({ approval_id: "a1", turn_id: "t1", approval: { id: "a1" }, turn: { id: "t1" }, resume_state: {} });
    store.save({ approval_id: "a2", turn_id: "t2", approval: { id: "a2" }, turn: { id: "t2" }, resume_state: {} });

    assert.equal(store.deleteForTurn("t1"), 1);
    assert.equal(store.get("a1"), null);
    assert.equal(store.get("a2").turn_id, "t2");

    store.clear();
    assert.equal(store.size(), 0);
  });

  test("paused turn store validates required fields", () => {
    const store = createPausedTurnStore();

    assert.throws(() => store.save({}), /approval_id is required/);
    assert.throws(
      () => store.save({ approval_id: "a", turn_id: "t", approval: { id: "different" }, turn: {}, resume_state: {} }),
      /approval.id must match approval_id/
    );
  });

  test("paused turn store can restore list and cancel durable records", () => {
    const store = createPausedTurnStore({ now: () => "2026-06-01T00:00:00.000Z" });
    store.restore({
      approval_id: "approval_1",
      turn_id: "turn_1",
      approval: { id: "approval_1" },
      turn: { id: "turn_1" },
      resume_state: { pending_tool_call: { id: "call_1" } }
    });

    assert.deepEqual(store.list().map((item) => item.approval_id), ["approval_1"]);
    assert.equal(store.list()[0].created_at, "2026-06-01T00:00:00.000Z");
    assert.equal(store.delete("approval_1"), true);
    assert.deepEqual(store.list(), []);
  });
});
