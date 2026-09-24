// Fold the workbench activity event stream into agent-panel card view-models.
// Pure — node:test-covered. 字段归一走共享事件展示契约(src/apps/event-contract.js),避免第 4 份并行读法。
// v1.4.6:卡片补齐设计稿 v4 的展示需要 —— 工具卡带参数摘要、diff 卡带逐文件增删、
// 计划卡带子任务清单与状态、审批卡带命令与 id、编排卡带轮次与完成度。
import { describeEvent } from "../../../src/apps/event-contract.js";

export function deriveAgentCards(activity) {
  const cards = [];
  const toolIndex = new Map();
  const subtaskIndex = new Map();
  let planCard = null;
  let orchCard = null;

  const ensurePlan = () => {
    if (!planCard) { planCard = { kind: "plan", subtasks: 0, round: 0, steps: [] }; cards.push(planCard); }
    return planCard;
  };

  for (const e of activity || []) {
    const type = e && e.type;
    const f = describeEvent(e).fields;

    if (type === "orchestration:planned" || type === "orchestration:round_started" || type === "orchestration:replanned") {
      const plan = ensurePlan();
      if (typeof f.subtasks === "number") plan.subtasks = f.subtasks;
      if (typeof f.newSubtasks === "number") plan.subtasks = f.newSubtasks;
      if (typeof f.round === "number") plan.round = f.round;
      if (f.doneWhen) plan.doneWhen = f.doneWhen;
    } else if (type === "orchestration:subtask_started") {
      const plan = ensurePlan();
      const id = f.subtaskId || `sub_${plan.steps.length + 1}`;
      let step = subtaskIndex.get(id);
      if (!step) { step = { id, status: "run", attempt: f.attempt || 1 }; subtaskIndex.set(id, step); plan.steps.push(step); }
      else { step.status = "run"; step.attempt = f.attempt || step.attempt; }
    } else if (type === "orchestration:subtask_reviewed") {
      const plan = ensurePlan();
      const id = f.subtaskId || "";
      let step = subtaskIndex.get(id);
      if (!step) { step = { id, status: "todo", attempt: 1 }; subtaskIndex.set(id, step); plan.steps.push(step); }
      step.status = f.pass ? "done" : "failed";
      step.severity = f.reviewSeverity || null;
    } else if (type === "orchestration:completed") {
      orchCard = {
        kind: "orchestration",
        rounds: f.rounds || 0,
        completed: f.completed || 0,
        failed: f.failed || 0,
        status: f.status || null,
        steps: planCard ? planCard.steps : []
      };
      cards.push(orchCard);
    } else if (type === "tool:call") {
      const callId = e.call?.id || e.id;
      const card = { kind: "tool", id: callId, tool: f.name || "tool", argHint: f.argHint || "", status: "running" };
      if (callId) toolIndex.set(callId, card);
      cards.push(card);
    } else if (type === "tool:result") {
      const callId = e.result?.call_id || e.result?.callId || e.id;
      const card = callId ? toolIndex.get(callId) : null;
      if (card) {
        card.status = f.status === "error" ? "error" : "ok";
        card.durationMs = f.durationMs; // v1.8.0 真实耗时(内核 executor 已带)
      }
    } else if (type === "model:response") {
      // v1.8.0 推理摘要卡 —— 门控:只有带 purpose 或真实 reasoning 用量才出卡。
      // v1.9 M2:meta 追加 model,展开体可展示 cache/tps/reasoning。
      if (f.reasoningTokens > 0 || f.purpose) {
        cards.push({
          kind: "thought",
          purpose: f.purpose,
          model: f.model,
          reasoningTokens: f.reasoningTokens,
          completionTokens: f.completionTokens,
          cacheHitTokens: f.cacheHitTokens,
          cacheMissTokens: f.cacheMissTokens,
          latencyMs: f.latencyMs,
          tps: f.tps,
          reasoning: f.reasoning
        });
      }
    } else if (type === "file:diff_applied" || type === "file:diff_preview") {
      const files = (f.files || []).filter((x) => x && x.path);
      const paths = files.map((x) => x.path);
      cards.push({
        kind: "diff",
        changeId: f.changeId,
        path: paths[0] || "",
        fileCount: paths.length,
        files,
        added: files.reduce((n, x) => n + (x.added || 0), 0),
        removed: files.reduce((n, x) => n + (x.removed || 0), 0),
        applied: type === "file:diff_applied"
      });
    } else if (type === "approval:requested") {
      cards.push({ kind: "approval", id: f.id || null, summary: f.summary || "" });
    } else if (type === "approval:resolved") {
      for (let i = cards.length - 1; i >= 0; i -= 1) {
        if (cards[i].kind === "approval" && !cards[i].decision) { cards[i].decision = f.decision || "resolved"; break; }
      }
    } else if (type === "verification:result") {
      cards.push({ kind: "test", pass: Boolean(f.pass), status: f.status || null });
    }
  }
  return cards;
}
