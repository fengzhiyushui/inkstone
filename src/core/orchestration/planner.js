import { validatePlan, hasCycle, validateReplan } from "./subtask-schema.js";

export function createPlanner({ callModel, maxPlanRepairs = 2 }) {
  async function plan({ message, context, experiences, signal = null, scope = null }) {
    let feedback = null;
    for (let attempt = 0; attempt <= maxPlanRepairs; attempt += 1) {
      if (signal?.aborted) {
        const err = new Error("turn was interrupted");
        err.name = "AbortError";
        err.code = "ABORT";
        throw err;
      }
      if (scope?.budget?.exceeded()) {
        const over = scope.budget.exceeded();
        const err = new Error(`cost budget exceeded: ${over.reason}`);
        err.code = "BUDGET_EXCEEDED";
        err.details = over;
        throw err;
      }
      let raw;
      try {
        raw = await callModel(plannerPrompt(message, context, feedback, experiences), { signal, scope, role: "planner" });
      } catch (e) {
        if (isBudgetOrAbort(e)) throw e;
        feedback = `model error: ${e.message}`;
        continue;
      }
      const obj = extractJson(raw);
      if (!obj) { feedback = "output was not valid JSON; reply with ONLY the JSON plan"; continue; }
      const v = validatePlan(obj);
      if (!v.ok) { feedback = `plan invalid: ${v.error}`; continue; }
      if (hasCycle(v.plan.subtasks)) { feedback = "plan had a dependency cycle; remove it"; continue; }
      v.plan.used_experience_ids = Array.isArray(obj.used_experience_ids)
        ? obj.used_experience_ids.filter((x) => typeof x === "string")
        : [];
      return v.plan;
    }
    return degradeToSingle(message);
  }

  async function replan({ message, done_when, completed, failed, seenSubtaskIds, completedIds, failedIds, signal = null, scope = null }) {
    let feedback = null;
    for (let attempt = 0; attempt <= maxPlanRepairs; attempt += 1) {
      if (signal?.aborted) {
        const err = new Error("turn was interrupted");
        err.name = "AbortError";
        err.code = "ABORT";
        throw err;
      }
      if (scope?.budget?.exceeded()) {
        const over = scope.budget.exceeded();
        const err = new Error(`cost budget exceeded: ${over.reason}`);
        err.code = "BUDGET_EXCEEDED";
        err.details = over;
        throw err;
      }
      let raw;
      try {
        raw = await callModel(replanPrompt(message, done_when, completed, failed, feedback), { signal, scope, role: "replan" });
      } catch (e) {
        if (isBudgetOrAbort(e)) throw e;
        feedback = `model error: ${e.message}`;
        continue;
      }
      const obj = extractJson(raw);
      if (!obj || typeof obj.done !== "boolean" || !Array.isArray(obj.subtasks)) { feedback = 'reply ONLY {"done":bool,"subtasks":[...]}'; continue; }
      if (obj.done || obj.subtasks.length === 0) return { done: true, subtasks: [] };
      const v = validateReplan(obj.subtasks, { seenSubtaskIds, completedIds, failedIds });
      if (!v.ok) { feedback = `replan invalid: ${v.error}`; continue; }
      return { done: false, subtasks: obj.subtasks };
    }
    return { done: true, subtasks: [] };   // conservative: stop rather than loop badly
  }

  return { plan, replan };
}

function degradeToSingle(message) {
  return {
    task_summary: String(message || "").slice(0, 200),
    done_when: "the request is fulfilled",
    subtasks: [{ id: "st_1", goal: String(message || ""), acceptance: ["request fulfilled"], context_scope: {}, tool_profile: "edit", depends_on: [] }],
    used_experience_ids: []
  };
}

function plannerPrompt(message, context, feedback, experiences) {
  const expBlock = experiences?.length
    ? `Relevant past experience (heuristics, may be wrong — use judgement):\n${experiences.map((e) => `- [${e.id}] (tier ${e.tier}) ${e.lesson}`).join("\n")}`
    : "";
  return [
    "Break the user's request into a minimal set of sub-tasks for sub-agents to execute SEQUENTIALLY.",
    `User request: ${message}`,
    context ? `Context summary: ${context.summary || ""}` : "",
    expBlock,
    'Reply with ONLY JSON: {"task_summary","done_when","subtasks":[{"id","goal","acceptance":[...],"context_scope":{"files":[...]},"tool_profile":"edit"|"readonly","depends_on":[...]}]'
      + (experiences?.length ? ',"used_experience_ids":["<id of experience you actually relied on>"]' : "") + "}",
    "Use depends_on to express ordering. Keep it minimal — do not over-decompose.",
    feedback ? `Your previous attempt was rejected: ${feedback}` : ""
  ].filter(Boolean).join("\n\n");
}

function replanPrompt(message, done_when, completed, failed, feedback) {
  const sum = (list) => (list || []).map((c) => `- ${c.id} (${c.goal}): ${c.note || ""}`).join("\n");
  return [
    "You are revising a multi-agent plan after a dispatch round.",
    `Original request: ${message}`,
    `Done when: ${done_when}`,
    `Completed so far:\n${sum(completed) || "(none)"}`,
    `Failed so far:\n${sum(failed) || "(none)"}`,
    'If the goal is met, reply {"done":true,"subtasks":[]}. Otherwise reply {"done":false,"subtasks":[...]} with NEW sub-tasks (corrective for failures or continuation).',
    'New subtask ids must be globally unique (not reuse any prior id). To redo a failed task add "corrective_for":"<failedId>". context_scope.files + tool_profile required.',
    feedback ? `Previous attempt rejected: ${feedback}` : ""
  ].filter(Boolean).join("\n\n");
}

function extractJson(text) {
  const s = String(text || "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

function isBudgetOrAbort(e) {
  if (!e) return false;
  return e.code === "BUDGET_EXCEEDED" || e.code === "INTERRUPTED" || e.name === "AbortError" || e.name === "InterruptedError";
}

