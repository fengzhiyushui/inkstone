import test from "node:test";
import assert from "node:assert/strict";
import {
  derivePriorityStrip,
  derivePlanSection,
  deriveToolPairs,
  deriveApprovalSection,
  deriveTimelineRows,
  deriveInspectorModel
} from "../../../gui/src/state/inspector-state.js";

const activity = [
  { type: "orchestration:planned", subtasks: 3, round: 1 },
  { type: "orchestration:subtask_started", subtask_id: "s1", attempt: 1 },
  { type: "orchestration:subtask_reviewed", subtask_id: "s1", pass: true },
  { type: "orchestration:subtask_started", subtask_id: "s2", attempt: 1 },
  { type: "tool:call", call: { id: "c1", name: "read", params: { path: "a.js" } } },
  { type: "tool:result", result: { call_id: "c1", status: "success", duration_ms: 12 } },
  { type: "tool:call", call: { id: "c2", name: "edit", params: { path: "b.js" } } },
  { type: "approval:requested", approval: { id: "ap1", summary: "edit b.js" } },
  { type: "approval:resolved", approval_id: "ap1", decision: "approved" },
  { type: "model:response", purpose: "plan", usage: { completion_tokens_details: { reasoning_tokens: 40 } } }
];

test("derivePriorityStrip:编排 lane + 卡片计数", () => {
  const strip = derivePriorityStrip(activity);
  assert.equal(strip.lane, "orchestrate");
  assert.equal(strip.total, 3);
  assert.equal(strip.done, 1);
  assert.equal(strip.running, 1);
  assert.equal(strip.counts.tool, 2);
  assert.equal(strip.counts.thought, 1);
});

test("derivePlanSection:步骤状态来自 activity", () => {
  const plan = derivePlanSection({ current: "acting", channel: "act" }, activity);
  assert.equal(plan.runtime, "acting");
  assert.equal(plan.channel, "act");
  assert.equal(plan.steps.length, 2);
  assert.equal(plan.steps[0].id, "s1");
  assert.equal(plan.steps[0].status, "done");
  assert.equal(plan.steps[1].id, "s2");
  assert.equal(plan.steps[1].status, "run");
});

test("deriveToolPairs:call.id ↔ result.call_id 严格配对", () => {
  const pairs = deriveToolPairs([
    { type: "tool:call", call: { id: "c1", name: "read", params: { path: "a.js" } } },
    { type: "tool:result", result: { call_id: "c1", status: "success", duration_ms: 12 } },
    { type: "tool:call", call: { id: "c2", name: "edit", params: { path: "b.js" } } }
  ]);
  assert.equal(pairs.length, 2);
  assert.equal(pairs[0].status, "ok");
  assert.equal(pairs[0].durationMs, 12);
  assert.equal(pairs[1].status, "running", "孤立 call 保持 running,不与其它 result 误配");
});

test("deriveToolPairs:错序/孤立 result 不误配", () => {
  const pairs = deriveToolPairs([
    { type: "tool:result", result: { call_id: "ghost", status: "success" } },
    { type: "tool:call", call: { id: "only", name: "ls" } }
  ]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].status, "running");
});

test("deriveApprovalSection:paused + open/resolved 归并", () => {
  const a = deriveApprovalSection(
    [{ approval: { id: "p9", summary: "shell rm" }, tool: { name: "shell" } }],
    activity
  );
  assert.equal(a.paused.length, 1);
  assert.equal(a.paused[0].id, "p9");
  assert.equal(a.open.length, 0);
  assert.equal(a.resolved.length, 1);
  assert.equal(a.resolved[0].decision, "approved");
});

test("deriveTimelineRows:limit 与基本字段", () => {
  const rows = deriveTimelineRows(
    Array.from({ length: 5 }, (_, i) => ({ seq: i + 1, type: `t${i}`, content: "x" })),
    { limit: 3 }
  );
  assert.equal(rows.length, 3);
  assert.equal(rows[0].seq, 1);
  assert.equal(rows[0].type, "t0");
});

test("deriveInspectorModel:五区齐全且容错空输入", () => {
  const m = deriveInspectorModel();
  assert.ok(m.priority && m.plan && Array.isArray(m.tools) && m.approvals && Array.isArray(m.timeline));
  assert.equal(m.tools.length, 0);
  const full = deriveInspectorModel({ activity, runtime: { current: "idle" }, timeline: [{ seq: 1, type: "user:message" }] });
  assert.equal(full.tools.length, 2);
  assert.equal(full.timeline.length, 1);
});
