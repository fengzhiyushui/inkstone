// tests/unit/gui/cards-and-inspector.test.js — 卡片与检查器(智能体卡/状态/指标/菜单)领域测试
//
// v1.19.1 测试归并:本文件由下列历史任务单测试合并而成,每个来源包裹在独立
// describe 块中(异步回调 + 动态 import,来源间零共享绑定),测试语义与拆分前一致。
import { describe } from "node:test";

// ---------------------------------------------------------------------------
// 来源:tests/unit/gui/agent-cards.test.js
// ---------------------------------------------------------------------------
describe("unit/gui/agent-cards", async () => {

  // v1.9.0 M1 契约冻结波2:GUI 派生与内核契约同源消费的直接证据 ——
  // 直接喂 tests/fixtures/events/samples.json 的真实内核事件载荷(而非手写 mock),
  // 证明 agent-cards.js 复用 src/apps/event-contract.js 的展示契约即可正确派生。

  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { readFileSync } = await import("node:fs");
  const { deriveAgentCards } = await import("../../../gui/src/state/agent-cards.js");

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

  test("v1.13.1:审批卡携带 category,供三端判定可否持久放行", () => {
    const cards = deriveAgentCards([
      { type: "approval:requested", approval: { id: "ap_x", summary: "wipe db", category: "destructive" } }
    ]);
    const ap = cards.find((c) => c.kind === "approval");
    assert.equal(ap.category, "destructive", "destructive 必须传到卡片,否则无法禁用持久放行按钮");

    const plain = deriveAgentCards([
      { type: "approval:requested", approval: { id: "ap_y", summary: "read file", category: "read" } }
    ]);
    assert.equal(plain[0].category, "read");

    // 没有 category 的旧载荷不得报错
    const legacy = deriveAgentCards([
      { type: "approval:requested", approval: { id: "ap_z", summary: "s" } }
    ]);
    assert.equal(legacy[0].category, null);
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
      category: null,
      decision: "approved"
    }]);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/gui/inspector-state.test.js
// ---------------------------------------------------------------------------
describe("unit/gui/inspector-state", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { derivePriorityStrip, derivePlanSection, deriveToolPairs, deriveApprovalSection, deriveTimelineRows, deriveInspectorModel } = await import("../../../gui/src/state/inspector-state.js");

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
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/gui/status-display.test.js
// ---------------------------------------------------------------------------
describe("unit/gui/status-display", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { STATUS_FORMS, STATUS_POSITIONS, STATUS_TOGGLES, STATUS_DISPLAY_DEFAULTS, normalizeStatusDisplay } = await import("../../../gui/src/state/status-display.js");

  test("默认值:4 组齐全,form=bar,14 个开关(本轮耗时/改动数默认关),格式默认", () => {
    assert.equal(STATUS_FORMS.length, 5);
    assert.equal(STATUS_POSITIONS.length, 3);
    assert.equal(STATUS_TOGGLES.length, 14);
    assert.equal(STATUS_DISPLAY_DEFAULTS.form, "bar");
    assert.equal(STATUS_DISPLAY_DEFAULTS.position, "composer");
    assert.equal(STATUS_DISPLAY_DEFAULTS.format.dotsCount, 10);
    assert.equal(STATUS_DISPLAY_DEFAULTS.format.tpsDecimals, 1);
    assert.equal(Object.keys(STATUS_DISPLAY_DEFAULTS.show).length, 14);
    assert.equal(STATUS_DISPLAY_DEFAULTS.show.turnTime, false);   // 设计稿默认关
    assert.equal(STATUS_DISPLAY_DEFAULTS.show.turnChanges, false);
    assert.equal(STATUS_DISPLAY_DEFAULTS.show.model, false);   // 输入行已有模型 pill,不重复
    assert.equal(STATUS_DISPLAY_DEFAULTS.show.branch, true);
    assert.equal(STATUS_DISPLAY_DEFAULTS.show.cacheMiss, true);
    assert.equal(STATUS_DISPLAY_DEFAULTS.show.reasoningTokens, true);
    assert.equal(STATUS_DISPLAY_DEFAULTS.show.tps, true);
  });

  test("normalize:null/非对象 → 完整默认深拷贝", () => {
    const a = normalizeStatusDisplay(null);
    const b = normalizeStatusDisplay(undefined);
    assert.equal(a.form, "bar");
    assert.notEqual(a, STATUS_DISPLAY_DEFAULTS, "应深拷贝,不与默认共享引用");
    a.show.branch = false;
    assert.equal(b.show.branch, true, "互不影响");
  });

  test("normalize:合法值通过,非法值回退", () => {
    const out = normalizeStatusDisplay({
      form: "dots", position: "both", fadeIdle: true, compact: true,
      show: { branch: false, context: true, unknown: true },
      format: { percentDecimals: 2, bigUnits: false, contextWarnRatio: 0.6, dotsCount: 16, junk: 1 }
    });
    assert.equal(out.form, "dots");
    assert.equal(out.position, "both");
    assert.equal(out.fadeIdle, true);
    assert.equal(out.compact, true);
    assert.equal(out.show.branch, false);
    assert.equal(out.show.context, true);
    assert.equal(out.show.checkpoint, true, "未提及的开关保留默认");
    assert.equal(out.format.percentDecimals, 2);
    assert.equal(out.format.bigUnits, false);
    assert.equal(out.format.contextWarnRatio, 0.6);
    assert.equal(out.format.dotsCount, 16);
  });

  test("normalize:越界与非法值被夹紧/回退", () => {
    const out = normalizeStatusDisplay({
      form: "sparkline", position: "sidebar",
      show: { branch: "yes" },
      format: { percentDecimals: 9, contextWarnRatio: 3, dotsCount: 2 }
    });
    assert.equal(out.form, "bar", "非法形态回退默认");
    assert.equal(out.position, "composer", "非法位置回退默认");
    assert.equal(out.show.branch, true, "非布尔开关保留默认");
    assert.equal(out.format.percentDecimals, 4, "小数位夹紧到 0–4");
    assert.equal(out.format.contextWarnRatio, 1, "阈值夹紧到 0–1");
    assert.equal(out.format.dotsCount, 4, "点阵格数夹紧到 4–24");
    assert.equal(out.format.tpsDecimals, 1, "未提及的 tpsDecimals 保留默认");
  });

  test("normalize:tpsDecimals 夹紧 0–2", () => {
    assert.equal(normalizeStatusDisplay({ format: { tpsDecimals: 0 } }).format.tpsDecimals, 0);
    assert.equal(normalizeStatusDisplay({ format: { tpsDecimals: 2 } }).format.tpsDecimals, 2);
    assert.equal(normalizeStatusDisplay({ format: { tpsDecimals: 9 } }).format.tpsDecimals, 2);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/gui/metrics-view.test.js
// ---------------------------------------------------------------------------
describe("unit/gui/metrics-view", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { CONTEXT_WINDOW, CONTEXT_WINDOW_CURRENT, CONTEXT_WINDOW_LEGACY, contextWindowForModel, metricSegments, formatCount, cacheRatio, totalTokens } = await import("../../../gui/src/state/metrics-view.js");

  test("contextWindowForModel:现行代际 1M,旧 id 64k,未知 128k", () => {
    assert.equal(contextWindowForModel("deepseek-flash"), CONTEXT_WINDOW_CURRENT);
    assert.equal(contextWindowForModel("deepseek-v4-pro"), CONTEXT_WINDOW_CURRENT);
    assert.equal(contextWindowForModel("deepseek-chat"), 64000);
    assert.equal(contextWindowForModel("deepseek-reasoner"), 64000);
    assert.equal(contextWindowForModel("deepseek-coder-v2:latest"), CONTEXT_WINDOW_LEGACY);
    assert.equal(contextWindowForModel(null), CONTEXT_WINDOW_CURRENT);
    assert.equal(CONTEXT_WINDOW, CONTEXT_WINDOW_CURRENT, "默认常量对齐现行代际");
  });

  test("metricSegments:context 窗口按模型推导(1M 时不再 12.8% 即满)", () => {
    const usage = { total_prompt_tokens: 200000, total_completion_tokens: 0, total_tokens: 200000 };
    const segs = metricSegments(usage, { show: { cacheHit: false, context: true }, format: {} }, "deepseek-flash");
    const ctx = segs.find((s) => s.key === "context");
    assert.ok(ctx);
    assert.equal(ctx.text.includes("/1.0M"), true);
    assert.ok(ctx.ratio < 0.25);
  });

  test("metricSegments:无数据即不渲染 cacheMiss/reasoning/tps", () => {
    const segs = metricSegments({ total_tokens: 10 }, { show: {} }, "deepseek-flash");
    const keys = segs.map((s) => s.key);
    assert.ok(!keys.includes("cacheMiss"));
    assert.ok(!keys.includes("reasoningTokens"));
    assert.ok(!keys.includes("tps"));
    assert.ok(keys.includes("context"));
    assert.ok(keys.includes("cacheHit"));
  });

  test("metricSegments:有数据时渲染三段遥测", () => {
    const usage = {
      requests: 1,
      total_prompt_tokens: 100,
      total_completion_tokens: 50,
      total_tokens: 150,
      cache_hit_tokens: 30,
      cache_miss_tokens: 70,
      total_reasoning_tokens: 20,
      avg_latency_ms: 500
    };
    const segs = metricSegments(usage, { show: { retrievalHit: false }, format: { tpsDecimals: 1 } }, "deepseek-flash");
    const keys = segs.map((s) => s.key);
    assert.ok(keys.includes("cacheMiss"));
    assert.ok(keys.includes("reasoningTokens"));
    assert.ok(keys.includes("tps"));
    const tps = segs.find((s) => s.key === "tps");
    // requests=1:completion 50 / 0.5s = 100 t/s(v1.9 M4 起 tps 口径 = completion ÷ (avg_latency×requests))
    assert.equal(tps.text, "100.0");
    const miss = segs.find((s) => s.key === "cacheMiss");
    assert.equal(miss.num.v, "70");
  });

  test("formatCount / cacheRatio / totalTokens 基础行为保持", () => {
    assert.equal(formatCount(1500), "1.5k");
    assert.equal(formatCount(2_500_000), "2.5M");
    assert.equal(cacheRatio({ cache_hit_tokens: 1, cache_miss_tokens: 1 }), 0.5);
    assert.equal(totalTokens({ total_prompt_tokens: 2, total_completion_tokens: 3 }), 5);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/gui/menu-model.test.js
// ---------------------------------------------------------------------------
describe("unit/gui/menu-model", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { menuModel } = await import("../../../gui/src/state/menu-model.js");

  test("menu groups expose action ids", () => {
    const m = menuModel((k) => k);
    assert.ok(m.find((g) => g.items.some((i) => i.id === "view.home")));
    assert.ok(m.find((g) => g.items.some((i) => i.id === "view.settings")));
    assert.ok(m.find((g) => g.items.some((i) => i.id === "view.theme")));
    assert.ok(m.find((g) => g.items.some((i) => i.id === "help.about")));
    assert.ok(m.every((g) => Array.isArray(g.items)));
  });
});
