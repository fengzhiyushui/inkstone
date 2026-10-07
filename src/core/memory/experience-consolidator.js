import { createHash } from "node:crypto";
import { upsert as defaultUpsert } from "./experience-upsert.js";
import { reinforce, weaken } from "./experience-scoring.js";
import { normalizeCues, effectiveCues } from "./experience-cluster.js";

const DEFAULT_THRESHOLDS = { T1: 0.7, T2: 0.4, T3: 0.2 };

// The consolidator = secondary agent at task boundary. Model only distills lessons;
// program logic does adopted reinforce/weaken + the upsert pipeline (deterministic).
export function createConsolidator({ callModel, store, now = () => Date.now(), upsert = defaultUpsert, cfg = {}, maxRepairs = 1, mode = "on", onPending = null }) {
  const {
    maxLessonsPerTask = 5, cap = 200, thresholds = DEFAULT_THRESHOLDS,
    decayPerDay = 0.02, dedupThreshold = 0.6
  } = cfg;
  const upsertCfg = { now, cap, thresholds, decayPerDay, dedupThreshold };

  async function consolidate({ message, done_when, allCollected = [], outcome, adoptedExperienceIds = [], taskId = "task", sessionId = "session", round = 1 } = {}, options = {}) {
    if (options?.signal?.aborted || options?.scope?.budget?.exceeded?.()) {
      return { written: 0, pending: 0, skipped: true };
    }
    await applyAdopted(adoptedExperienceIds, outcome);

    const lessons = await distill({ message, done_when, allCollected, outcome }, options);
    const subtaskIds = subtaskIdsOf(allCollected);
    let written = 0;
    let pending = 0;
    for (const [i, l] of lessons.slice(0, maxLessonsPerTask).entries()) {
      const cues = normalizeCues(l.cues);
      if (effectiveCues(cues).length < 1) continue;   // empty/low-info → not stored
      const iso = new Date(now()).toISOString();
      const entry = {
        id: "exp_" + createHash("sha256").update(`${taskId}|${i}|${l.lesson}`).digest("hex").slice(0, 12),
        kind: l.kind === "risk" ? "risk" : "procedural",
        lesson: String(l.lesson),
        cues,
        provenance: { taskId, sessionId, round, subtaskIds },
        confidence: clampConfidence(l.confidence),
        validations: 0, misleads: 0,
        created: iso, lastReinforced: iso, tier: 3
      };
      // gated: high-impact (risk-kind) writes wait in the pending area for human approval
      // before they can influence retrieval / permission escalation.
      if (mode === "gated" && entry.kind === "risk") {
        const pendingId = "pend_" + createHash("sha256").update(`${taskId}|${i}|${l.lesson}`).digest("hex").slice(0, 12);
        await store.putPending({ pendingId, entry, created: iso });
        if (onPending) onPending({ pendingId, kind: entry.kind });
        pending += 1;
        continue;
      }
      await upsert(store, entry, upsertCfg);
      written += 1;
    }
    return { written, pending };
  }

  // Program logic: task succeeded → reinforce adopted; otherwise → weaken. (Model not involved.)
  async function applyAdopted(ids, outcome) {
    if (!ids || !ids.length) return;
    const succeeded = outcome === "complete";
    for (const id of ids) {
      const e = store.get(id);
      if (!e) continue;
      await store.put(succeeded ? reinforce(e, now) : weaken(e));
    }
  }

  async function distill({ message, done_when, allCollected, outcome }, options = {}) {
    if (options?.signal?.aborted || options?.scope?.budget?.exceeded?.()) {
      return [];
    }
    let feedback = null;
    for (let attempt = 0; attempt <= maxRepairs; attempt += 1) {
      let raw;
      try {
        raw = await callModel(distillPrompt(message, done_when, allCollected, outcome, feedback), {
          ...options,
          role: "experience",
          purpose: "plan",
          signal: options.signal,
          scope: options.scope
        });
      }
      catch { return []; }   // model error → no consolidation
      const arr = extractJsonArray(raw);
      if (Array.isArray(arr) && arr.every(isLesson)) return arr;
      feedback = 'reply ONLY a JSON array: [{"kind":"procedural"|"risk","lesson":"...","cues":["..."],"confidence":0..1}]';
    }
    return [];   // conservative: distill nothing rather than store garbage
  }

  return { consolidate };
}

function clampConfidence(c) {
  const x = Number(c);
  if (!Number.isFinite(x)) return 0.2;
  return Math.min(0.6, Math.max(0.2, x));
}

function isLesson(l) {
  return l && typeof l === "object" && typeof l.lesson === "string" && l.lesson.length > 0 && Array.isArray(l.cues);
}

function subtaskIdsOf(allCollected) {
  return (allCollected || []).map((c) => c?.st?.id).filter((x) => typeof x === "string");
}

function distillPrompt(message, done_when, allCollected, outcome, feedback) {
  const sum = (allCollected || []).map((c) => `- ${c?.st?.id} [${c?.status}]: ${String(c?.st?.goal || "")}`).join("\n");
  return [
    "You just finished a multi-agent task. Distill durable lessons for FUTURE similar tasks (not a log).",
    `Request: ${message}`,
    done_when ? `Done when: ${done_when}` : "",
    `Outcome: ${outcome}`,
    `Subtasks:\n${sum || "(none)"}`,
    'Reply ONLY a JSON array: [{"kind":"procedural"|"risk","lesson":"<one actionable judgement>","cues":["<keyword>"...],"confidence":0..1}]. Keep it minimal; omit if nothing durable.',
    feedback ? `Previous attempt rejected: ${feedback}` : ""
  ].filter(Boolean).join("\n\n");
}

function extractJsonArray(text) {
  const s = String(text || "");
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}
