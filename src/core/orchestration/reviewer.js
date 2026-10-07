import { validateVerdict } from "./subtask-schema.js";

const FALLBACK = { pass: false, severity: "warn", reasons: ["verdict unparseable"], checked: [] };

export function createReviewer({ runtime }) {
  async function review(subtask, workerResult, options = {}) {
    const res = await runtime.send(reviewPrompt(subtask, workerResult), { autonomy: "auto", ...options });
    const obj = extractJson(res?.content || "");
    if (!obj) return { ...FALLBACK };
    const v = validateVerdict(obj);
    return v.ok ? v.verdict : { ...FALLBACK };
  }
  return { review };
}

function reviewPrompt(subtask, workerResult) {
  return [
    "You are an INDEPENDENT reviewer. Do not trust the worker's self-report.",
    `Sub-task goal: ${subtask.goal}`,
    `Acceptance criteria:\n${(subtask.acceptance || []).map((a) => `- ${a}`).join("\n")}`,
    `Worker output:\n${workerResult?.content || ""}`,
    "Independently verify (read files, run tests via your read-only tools).",
    'Reply with ONLY a JSON object: {"pass":bool,"severity":"block"|"warn","reasons":[...],"checked":[...]}'
  ].join("\n\n");
}

function extractJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}
