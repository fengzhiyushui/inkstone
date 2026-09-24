// gui/src/state/inspector-state.js — Agent Inspector 五区纯派生（node:test 覆盖）。
// 数据源全部来自既有 workbench.activity / kernel 快照，本模块不发 IPC、不持状态。
import { deriveAgentCards } from "./agent-cards.js";

/** 优先条：编排进度 + 卡片计数（工具/审批/改动/推理）。 */
export function derivePriorityStrip(activity) {
  const cards = deriveAgentCards(activity);
  const plan = cards.find((c) => c.kind === "plan");
  const orch = cards.find((c) => c.kind === "orchestration");
  const counts = { tool: 0, approval: 0, diff: 0, thought: 0, test: 0, other: 0 };
  for (const c of cards) {
    if (Object.prototype.hasOwnProperty.call(counts, c.kind)) counts[c.kind] += 1;
    else counts.other += 1;
  }
  const steps = plan?.steps || [];
  const done = steps.filter((s) => s.status === "done").length;
  const hasOrch = (activity || []).some((e) => typeof e?.type === "string" && e.type.startsWith("orchestration:"));
  return {
    lane: orch || hasOrch ? "orchestrate" : plan ? "plan" : "single",
    round: plan?.round || orch?.rounds || 0,
    total: plan?.subtasks || steps.length || 0,
    done,
    failed: steps.filter((s) => s.status === "failed").length,
    running: steps.filter((s) => s.status === "run").length,
    counts,
    status: orch?.status || null
  };
}

/** 计划区：runtime 状态 + 最新 plan 卡步骤。 */
export function derivePlanSection(runtimeState, activity) {
  const cards = deriveAgentCards(activity);
  const plan = cards.find((c) => c.kind === "plan");
  const steps = (plan?.steps || []).map((s, idx) => ({
    index: idx + 1,
    id: s.id,
    status: s.status || "todo",
    attempt: s.attempt || 1
  }));
  return {
    runtime: runtimeState?.current || "idle",
    channel: runtimeState?.channel || null,
    autonomy: runtimeState?.autonomy || null,
    steps,
    doneWhen: plan?.doneWhen || null,
    round: plan?.round || 0
  };
}

/** 工具区：call.id ↔ result.call_id 严格字典配对（与 agent-cards 同口径）。 */
export function deriveToolPairs(activity) {
  const pairs = [];
  const index = new Map();
  for (const e of activity || []) {
    if (!e || typeof e !== "object") continue;
    if (e.type === "tool:call") {
      const callId = e.call?.id || e.id || null;
      const row = {
        callId,
        name: e.call?.name || e.name || "tool",
        status: "running",
        durationMs: null,
        argHint: null
      };
      if (callId) index.set(callId, row);
      pairs.push(row);
    } else if (e.type === "tool:result") {
      const callId = e.result?.call_id || e.result?.callId || e.id || null;
      const row = callId ? index.get(callId) : null;
      if (row) {
        row.status = e.result?.status === "error" || e.result?.status === "failed" ? "error" : "ok";
        const ms = e.result?.metadata?.duration_ms ?? e.result?.duration_ms;
        if (ms != null) row.durationMs = Number(ms) || null;
      }
    }
  }
  return pairs;
}

/** 审批区：kernel listPaused 结果 + activity 上最近的 approval:requested。 */
export function deriveApprovalSection(pausedList, activity) {
  const paused = (Array.isArray(pausedList) ? pausedList : []).map((p) => ({
    id: p?.approval?.id || p?.id || p?.approval_id || null,
    summary: p?.approval?.summary || p?.summary || "",
    tool: p?.tool?.name || p?.name || null,
    category: p?.approval?.category || p?.category || null
  })).filter((p) => p.id);

  const open = [];
  const resolved = [];
  for (const e of activity || []) {
    if (e?.type === "approval:requested") {
      open.push({ id: e.approval?.id || e.id || null, summary: e.approval?.summary || e.summary || "" });
    } else if (e?.type === "approval:resolved") {
      const id = e.approval_id || e.id || null;
      const decision = e.decision || "resolved";
      const hit = open.findIndex((x) => x.id && x.id === id);
      if (hit >= 0) {
        const [row] = open.splice(hit, 1);
        resolved.push({ ...row, decision });
      } else {
        resolved.push({ id, summary: "", decision });
      }
    }
  }
  return { paused, open, resolved };
}

/** 时间线行：session 事件 → 展示行（seq/type/title/quiet）。 */
export function deriveTimelineRows(timeline, { limit = 200 } = {}) {
  const rows = [];
  for (const e of Array.isArray(timeline) ? timeline : []) {
    if (!e || typeof e !== "object") continue;
    rows.push({
      key: `${e.seq ?? rows.length}:${e.type || "unknown"}`,
      seq: e.seq ?? null,
      type: e.type || "unknown",
      ts: e.ts || e.timestamp || null,
      title: e.type || "unknown",
      content: typeof e.content === "string" ? e.content : null
    });
    if (rows.length >= limit) break;
  }
  return rows;
}

/**
 * 汇总 Inspector 模型。
 * @param {{activity?:[], runtime?:object, paused?:[], timeline?:[], orchState?:object}} input
 */
export function deriveInspectorModel(input = {}) {
  const activity = input.activity || [];
  const runtime = input.runtime || {};
  const paused = input.paused || [];
  const timeline = input.timeline || [];
  const orchState = input.orchState || null;
  return {
    priority: derivePriorityStrip(activity),
    plan: derivePlanSection({ ...runtime, ...(orchState || {}) }, activity),
    tools: deriveToolPairs(activity),
    approvals: deriveApprovalSection(paused, activity),
    timeline: deriveTimelineRows(timeline)
  };
}
