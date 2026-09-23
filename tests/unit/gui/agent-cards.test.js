import test from "node:test";
import assert from "node:assert/strict";
import { deriveAgentCards } from "../../../gui/src/state/agent-cards.js";

test("plan/tool(pair)/diff/test cards derived from event stream", () => {
  const cards = deriveAgentCards([
    { type: "orchestration:planned", subtasks: 4 },
    { type: "tool:call", id: "t1", tool: "read" },
    { type: "tool:result", id: "t1", status: "ok" },
    { type: "tool:call", id: "t2", tool: "edit" },
    { type: "file:diff_applied", change_id: "chg_1", files: ["src/a.js", "src/b.js"],
      summary: [{ path: "src/a.js", status: "modify" }, { path: "src/b.js", status: "create" }] },
    { type: "verification:result", pass: true }
  ]);
  const byKind = (k) => cards.filter((c) => c.kind === k);
  assert.equal(byKind("plan")[0].subtasks, 4);
  assert.equal(byKind("tool").find((c) => c.id === "t1").status, "ok");
  assert.equal(byKind("tool").find((c) => c.id === "t2").status, "running");
  assert.equal(byKind("diff")[0].path, "src/a.js");
  assert.equal(byKind("diff")[0].fileCount, 2);
  assert.equal(byKind("diff")[0].changeId, "chg_1");
  assert.equal(byKind("diff")[0].applied, true);
  assert.equal(byKind("test")[0].pass, true);
});

test("diff_preview without change_id → changeId null, summary fallback for paths", () => {
  const [card] = deriveAgentCards([
    { type: "file:diff_preview", summary: [{ path: "src/x.js", status: "modify" }] }
  ]);
  assert.equal(card.kind, "diff");
  assert.equal(card.changeId, null);
  assert.equal(card.path, "src/x.js");
  assert.equal(card.fileCount, 1);
  assert.equal(card.applied, false);
});

test("tool:result error marks the tool card as error", () => {
  const cards = deriveAgentCards([
    { type: "tool:call", id: "x", tool: "shell" },
    { type: "tool:result", id: "x", status: "error" }
  ]);
  assert.equal(cards[0].status, "error");
});

test("empty activity → no cards", () => {
  assert.deepEqual(deriveAgentCards([]), []);
  assert.deepEqual(deriveAgentCards(null), []);
});

test("v1.4.6:工具卡带参数摘要,diff 卡带逐文件增删合计", () => {
  const cards = deriveAgentCards([
    { type: "tool:call", id: "t1", tool: "grep", args: { pattern: "form-inline" } },
    { type: "file:diff_applied", change_id: "chg_7f2a",
      summary: [{ path: "Login.jsx", status: "modify", added: 12, removed: 4 },
                { path: "login.css", status: "modify", added: 28, removed: 2 }] }
  ]);
  assert.equal(cards[0].argHint, "form-inline");
  const diff = cards.find((c) => c.kind === "diff");
  assert.equal(diff.added, 40);
  assert.equal(diff.removed, 6);
  assert.equal(diff.files.length, 2);
});

test("v1.4.6:计划卡累积子任务清单,复核结果落到对应步骤", () => {
  const [plan] = deriveAgentCards([
    { type: "orchestration:planned", subtasks: 3, done_when: "tests green" },
    { type: "orchestration:subtask_started", subtask_id: "s1", attempt: 1 },
    { type: "orchestration:subtask_reviewed", subtask_id: "s1", pass: true },
    { type: "orchestration:subtask_started", subtask_id: "s2", attempt: 1 }
  ]);
  assert.equal(plan.kind, "plan");
  assert.equal(plan.subtasks, 3);
  assert.equal(plan.doneWhen, "tests green");
  assert.deepEqual(plan.steps.map((s) => [s.id, s.status]), [["s1", "done"], ["s2", "run"]]);
});

test("v1.4.6:审批卡带 id 与摘要,resolved 回填决策", () => {
  const cards = deriveAgentCards([
    { type: "approval:requested", approval: { id: "ap_1", summary: "npm test -- tests/login" } },
    { type: "approval:resolved", decision: "approved" }
  ]);
  const ap = cards.find((c) => c.kind === "approval");
  assert.equal(ap.id, "ap_1");
  assert.equal(ap.summary, "npm test -- tests/login");
  assert.equal(ap.decision, "approved");
});

test("v1.4.6:编排完成产出编排卡(轮次/完成/失败)", () => {
  const cards = deriveAgentCards([
    { type: "orchestration:planned", subtasks: 2 },
    { type: "orchestration:completed", rounds: 2, completed: 2, failed: 0, status: "ok" }
  ]);
  const orch = cards.find((c) => c.kind === "orchestration");
  assert.equal(orch.rounds, 2);
  assert.equal(orch.completed, 2);
  assert.equal(orch.failed, 0);
});

test("v1.8.0:工具卡回填真实耗时", () => {
  const cards = deriveAgentCards([
    { type: "tool:call", id: "t1", tool: "grep" },
    { type: "tool:result", id: "t1", status: "ok", result: { status: "ok", durationMs: 38 } }
  ]);
  assert.equal(cards[0].durationMs, 38);
});

test("v1.8.0:推理摘要卡受门控(有 purpose/reasoningTokens 才出)", () => {
  const withThought = deriveAgentCards([
    { type: "model:response", purpose: "plan", model: "deepseek-v4-pro",
      usage: { completion_tokens: 120, completion_tokens_details: { reasoning_tokens: 80 } } }
  ]);
  assert.equal(withThought.length, 1);
  assert.equal(withThought[0].kind, "thought");
  assert.equal(withThought[0].reasoningTokens, 80);
  assert.equal(deriveAgentCards([{ type: "model:response" }]).length, 0);
});

test("real kernel events: multiple concurrent tool calls paired correctly by call_id", () => {
  const cards = deriveAgentCards([
    { type: "tool:call", call: { id: "call_1", name: "read", params: { path: "a.js" } } },
    { type: "tool:call", call: { id: "call_2", name: "grep", params: { pattern: "foo" } } },
    { type: "tool:result", result: { call_id: "call_1", status: "success", duration_ms: 25 } },
    { type: "tool:result", result: { call_id: "call_2", status: "error", duration_ms: 10 } }
  ]);
  assert.equal(cards.length, 2);
  const card1 = cards.find((c) => c.id === "call_1");
  const card2 = cards.find((c) => c.id === "call_2");
  assert.ok(card1);
  assert.ok(card2);
  assert.equal(card1.status, "ok");
  assert.equal(card2.status, "error");
});
