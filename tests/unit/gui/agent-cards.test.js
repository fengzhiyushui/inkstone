import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deriveAgentCards } from "../../../gui/src/state/agent-cards.js";

// v1.9.0 M1 契约冻结波2:GUI 派生与内核契约同源消费的直接证据 ——
// 直接喂 tests/fixtures/events/samples.json 的真实内核事件载荷(而非手写 mock),
// 证明 agent-cards.js 复用 src/apps/event-contract.js 的展示契约即可正确派生。
const samples = JSON.parse(readFileSync(new URL("../../fixtures/events/samples.json", import.meta.url), "utf8"));

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

// ── v1.9.0 M1:与 tests/fixtures/events/samples.json 同源消费 ─────────────────

test("M1 fixtures:tool:call + tool:result + model:response 内核样本直接派生出配对卡片", () => {
  const cards = deriveAgentCards([
    { type: "tool:call", ...samples["tool:call"] },
    { type: "tool:result", ...samples["tool:result"] },
    { type: "model:response", ...samples["model:response"] }
  ]);
  // tool:call 出工具卡、model:response 出推理摘要卡;tool:result 只回填、不新增卡。
  assert.equal(cards.length, 2);
  assert.deepEqual(cards[0], {
    kind: "tool",
    id: "call_9f3a",
    tool: "read",
    argHint: "src/core/runtime/agent-runtime.js",
    status: "ok",
    durationMs: 42
  });
  const thought = cards[1];
  assert.equal(thought.kind, "thought");
  assert.equal(thought.purpose, "plan");
  assert.equal(thought.model, "deepseek-flash");
  assert.equal(thought.reasoningTokens, 384);
  assert.equal(thought.completionTokens, 512);
  assert.equal(thought.cacheHitTokens, 2048);
  assert.equal(thought.cacheMissTokens, 383);
  assert.equal(thought.latencyMs, 683);
  assert.equal(thought.tps, 749.6);
  // describeEvent 对 reasoning 做 500 字截断(契约口径),样本原文更长
  assert.ok(String(thought.reasoning).endsWith("…"));
  assert.ok(String(thought.reasoning).length <= 501);
  assert.ok(samples["model:response"].reasoning.startsWith(String(thought.reasoning).slice(0, 40)));
});

test("M1 fixtures:配对按 result.call_id 锚定,错序/孤立 result 均不误配", () => {
  // 孤立 result(无先行 tool:call):不产卡、不回填。
  assert.deepEqual(deriveAgentCards([{ type: "tool:result", ...samples["tool:result"] }]), []);
  // 错序(result 先于 call):result 落空,后续 tool:call 保持 running。
  const reversed = deriveAgentCards([
    { type: "tool:result", ...samples["tool:result"] },
    { type: "tool:call", ...samples["tool:call"] }
  ]);
  assert.equal(reversed.length, 1);
  assert.equal(reversed[0].status, "running");
  assert.equal(reversed[0].durationMs, undefined);
});

test("M1 fixtures:result.status 派生卡片终态(error → error 卡,耗时回填)", () => {
  const cards = deriveAgentCards([
    { type: "tool:call", ...samples["tool:call"] },
    { type: "tool:result", result: { ...samples["tool:result"].result, status: "error" } }
  ]);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].status, "error");
  assert.equal(cards[0].durationMs, 42);
});

test("M1 fixtures:model:response 推理摘要卡门控(样本带 reasoningTokens 即出卡,usage 为空即无卡)", () => {
  const gated = deriveAgentCards([{ type: "model:response", ...samples["model:response"] }]);
  assert.equal(gated.length, 1);
  assert.equal(gated[0].kind, "thought");
  // 无 usage/reasoning 用量且无 purpose 时不产卡(与 v1.8.0 门控语义一致)
  assert.deepEqual(deriveAgentCards([{ type: "model:response", usage: null, reasoning: null, purpose: null }]), []);
});

test("M1 fixtures:审批卡也用内核样本闭环(requested 出卡 + resolved 回填决策)", () => {
  const cards = deriveAgentCards([
    { type: "approval:requested", ...samples["approval:requested"] },
    { type: "approval:resolved", ...samples["approval:resolved"] }
  ]);
  assert.deepEqual(cards, [{
    kind: "approval",
    id: "approval_3d8e",
    summary: "shell requires approval: `npm test -- tests/unit/apps/event-contract.test.js`",
    decision: "approved"
  }]);
});
