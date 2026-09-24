import test from "node:test";
import assert from "node:assert/strict";
import {
  summarizeKernelEvent,
  renderKernelResult,
  formatUsageLine,
  createEventRenderer
} from "../../../../src/apps/cli/render-events.js";

const USAGE_SNAPSHOT = {
  requests: 4,
  total_prompt_tokens: 120,
  total_completion_tokens: 340,
  total_reasoning_tokens: 120,
  cache_hit_tokens: 80,
  cache_miss_tokens: 40,
  avg_latency_ms: 850
};

// INKSTONE_SHOW_USAGE 进程级开关:用例现场改、finally 复原,不污染其它测试。
function withUsageEnv(value, fn) {
  const prev = process.env.INKSTONE_SHOW_USAGE;
  if (value === undefined) delete process.env.INKSTONE_SHOW_USAGE;
  else process.env.INKSTONE_SHOW_USAGE = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.INKSTONE_SHOW_USAGE;
    else process.env.INKSTONE_SHOW_USAGE = prev;
  }
}

test("summarizeKernelEvent formats key V2 events without raw payload dumps", () => {
  assert.equal(
    summarizeKernelEvent({ type: "tool:call", call: { name: "read" } }),
    "tool read"
  );
  assert.equal(
    summarizeKernelEvent({ type: "file:diff_applied", change_id: "chg_1" }),
    "diff applied chg_1"
  );
  assert.equal(
    summarizeKernelEvent({ type: "approval:requested", approval: { id: "apr_1", summary: "edit requires approval" } }),
    "approval apr_1 edit requires approval"
  );
  assert.equal(
    summarizeKernelEvent({ type: "agent:final", content: "hello" }),
    "final hello"
  );
});

test("renderKernelResult returns final content and approval message", () => {
  assert.deepEqual(
    renderKernelResult({ status: "complete", content: "done" }),
    ["", "done"]
  );
  assert.deepEqual(
    renderKernelResult({ status: "awaiting_approval", approval: { id: "apr_1" } }),
    ["", "Approval required: apr_1", "Approve? y/N"]
  );
});

test("v1.9 M4 #11:renderKernelResult appends one-line usage summary when INKSTONE_SHOW_USAGE is set", () => {
  withUsageEnv("1", () => {
    const lines = renderKernelResult({ status: "complete", content: "done", usage: USAGE_SNAPSHOT });
    assert.equal(lines.length, 3);
    assert.equal(lines[0], "");
    assert.equal(lines[1], "done");
    assert.equal(lines[2], formatUsageLine(USAGE_SNAPSHOT));
    assert.ok(lines[2].includes("usage: tokens 120 prompt / 340 completion"));
    assert.ok(lines[2].includes("cache 80 hit / 40 miss"));
    assert.ok(lines[2].includes("reasoning 120 tok"));
    assert.ok(lines[2].includes("avg latency 850 ms"));
    // 缺 usage 快照时不追加(无数据不编造)
    assert.deepEqual(renderKernelResult({ status: "complete", content: "done" }), ["", "done"]);
    // 审批/错误终局不加 usage 行
    assert.deepEqual(renderKernelResult({ status: "error", error: "boom", usage: USAGE_SNAPSHOT }), ["", "Error: boom"]);
  });
});

test("v1.9 M4 #11:usage summary off by default and for falsy env values", () => {
  withUsageEnv(undefined, () => {
    assert.deepEqual(renderKernelResult({ status: "complete", content: "done", usage: USAGE_SNAPSHOT }), ["", "done"]);
  });
  for (const raw of ["", "0", "false"]) {
    withUsageEnv(raw, () => {
      assert.deepEqual(renderKernelResult({ status: "complete", content: "done", usage: USAGE_SNAPSHOT }), ["", "done"]);
    });
  }
});

test("v1.9 M4 #11:formatUsageLine renders all four segments, zero-safe", () => {
  const line = formatUsageLine(USAGE_SNAPSHOT);
  assert.equal(line, "usage: tokens 120 prompt / 340 completion · cache 80 hit / 40 miss · reasoning 120 tok · avg latency 850 ms");
  assert.equal(formatUsageLine({}), "usage: tokens 0 prompt / 0 completion · cache 0 hit / 0 miss · reasoning 0 tok · avg latency 0 ms");
  assert.equal(formatUsageLine(), "usage: tokens 0 prompt / 0 completion · cache 0 hit / 0 miss · reasoning 0 tok · avg latency 0 ms");
});

test("createEventRenderer writes only useful progress events", () => {
  const lines = [];
  const renderer = createEventRenderer({ write: (line) => lines.push(line) });

  renderer({ type: "user:message", content: "hi" });
  renderer({ type: "tool:result", result: { status: "success" } });
  renderer({ type: "model:request", purpose: "act" });

  assert.deepEqual(lines, ["- user hi", "- tool result success"]);
});

test("summarizeKernelEvent renders branch and rewind events", () => {
  assert.equal(
    summarizeKernelEvent({ type: "session:branch_created", branch_id: "br_child" }),
    "branch created br_child"
  );
  assert.equal(
    summarizeKernelEvent({ type: "session:branch_activated", branch_id: "br_child" }),
    "branch active br_child"
  );
  assert.equal(
    summarizeKernelEvent({ type: "session:rewind_preview", rollback_count: 3 }),
    "rewind preview 3 changes"
  );
  assert.equal(
    summarizeKernelEvent({ type: "session:rewind_applied", branch_id: "br_child", rollback_change_ids: ["a", "b"] }),
    "rewind applied br_child 2 changes"
  );
  assert.equal(
    summarizeKernelEvent({ type: "session:rewind_conflict", failed_change_id: "change_1" }),
    "rewind conflict change_1"
  );
  assert.equal(
    summarizeKernelEvent({ type: "session:rewind_failed", failed_change_id: "change_2" }),
    "rewind failed change_2"
  );
});

test("summarizeKernelEvent renders rewind recovery events", () => {
  assert.equal(
    summarizeKernelEvent({ type: "session:rewind_restore_started", applied_rollbacks: ["a", "b"] }),
    "rewind restoring 2 changes"
  );
  assert.equal(
    summarizeKernelEvent({ type: "session:rewind_restored", restored_files: ["a.txt"] }),
    "rewind restored 1 files"
  );
  assert.equal(
    summarizeKernelEvent({ type: "session:rewind_recovery_failed", reason: "restore_failed" }),
    "rewind recovery failed restore_failed"
  );
});

test("renderer summarizes recovery events without payload leaks", () => {
  const lines = [
    summarizeKernelEvent({ type: "recovery:report", found_count: 2, done_count: 1, blocked_count: 0 }),
    summarizeKernelEvent({ type: "tx:recovered", tx_id: "tx_123", kind: "edit", preserved_count: 1 }),
    summarizeKernelEvent({ type: "turn:rehydrated", approval_id: "approval_456", marker_status: "ok" })
  ];

  assert.ok(lines.some((line) => line.includes("recovery report: found 2, done 1, blocked 0")));
  assert.ok(lines.some((line) => line.includes("recovered edit tx_123")));
  assert.ok(lines.some((line) => line.includes("rehydrated approval approval_456")));
  assert.equal(lines.join("\n").includes("resume_state"), false);
});

test("summarizeKernelEvent renders multi-agent orchestration summaries", () => {
  assert.equal(summarizeKernelEvent({ type: "orchestration:routed", lane: "orchestrate" }), "routing: multi-agent");
  assert.equal(summarizeKernelEvent({ type: "orchestration:planned", subtasks: 1 }), "plan: 1 subtask");
  assert.equal(summarizeKernelEvent({ type: "orchestration:planned", subtasks: 3 }), "plan: 3 subtasks");
  assert.equal(summarizeKernelEvent({ type: "orchestration:round_started", round: 2, subtasks: 1 }), "round 2: 1 subtask");
  assert.equal(summarizeKernelEvent({ type: "orchestration:round_started", round: 2, subtasks: 4 }), "round 2: 4 subtasks");
  assert.equal(summarizeKernelEvent({ type: "orchestration:replanned", round: 3, new_subtasks: 1 }), "replan round 3: 1 new subtask");
  assert.equal(summarizeKernelEvent({ type: "orchestration:replanned", round: 3, new_subtasks: 2 }), "replan round 3: 2 new subtasks");
  assert.equal(summarizeKernelEvent({ type: "orchestration:completed", completed: 3, failed: 1, status: "partial" }), "orchestration complete: 3 succeeded, 1 failed (status: partial)");
});

test("subtask start/review: no dangling parens/commas, passed|failed literal", () => {
  assert.equal(summarizeKernelEvent({ type: "orchestration:subtask_started", subtask_id: "s1", attempt: 1, tool_profile: "edit" }), "subtask s1: starting (attempt 1, profile edit)");
  assert.equal(summarizeKernelEvent({ type: "orchestration:subtask_started", subtask_id: "s2", attempt: 2 }), "subtask s2: starting (attempt 2)");
  assert.equal(summarizeKernelEvent({ type: "orchestration:subtask_reviewed", subtask_id: "s1", pass: true }), "subtask s1: review passed");
  assert.equal(summarizeKernelEvent({ type: "orchestration:subtask_reviewed", subtask_id: "s1", pass: false, severity: "high" }), "subtask s1: review failed (severity: high)");
  assert.equal(summarizeKernelEvent({ type: "orchestration:subtask_reviewed", subtask_id: "s1", pass: false }), "subtask s1: review failed");
});

test("experience:retrieved printed only when count>0", () => {
  const lines = [];
  const renderer = createEventRenderer({ write: (l) => lines.push(l) });
  renderer({ type: "experience:retrieved", count: 0 });
  renderer({ type: "experience:retrieved", count: 2, tiers: ["T1", "T2"] });
  assert.deepEqual(lines, ["- experience: 2 recalled"]);
});

test("orchestration route respects lane: single vs orchestrate", () => {
  assert.equal(summarizeKernelEvent({ type: "orchestration:route_resolved", lane: "single" }), "routing: single-agent");
  assert.equal(summarizeKernelEvent({ type: "orchestration:routed", lane: "orchestrate" }), "routing: multi-agent");
  assert.equal(summarizeKernelEvent({ type: "orchestration:routed" }), "routing: multi-agent");
});
