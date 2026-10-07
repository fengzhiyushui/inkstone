import { extractFeatures, computeScore, classifyBand, featuresForEvent } from "./router-scoring.js";
import { COMPLEXITY_MARKERS } from "../planning/keywords.js";

const DEFAULT_MARKERS = COMPLEXITY_MARKERS;
// Today's file-count signal regex — kept verbatim so the disabled-path lane is byte-identical.
const LEGACY_FILE_TOKEN = /\b[\w.-]+\.(?:js|mjs|cjs|jsx|ts|tsx|py|json|md)\b/gi;

export function createTaskRouter({ minComplexFiles = 2, markers = DEFAULT_MARKERS, model = {}, now = () => Date.now() } = {}) {
  const { enabled = true, callModel = null, timeoutMs = 8000, maxRepairs = 1, complexThreshold = 3 } = model;
  const modelActive = enabled !== false && typeof callModel === "function";

  function legacySignals(text) {
    const signals = [];
    for (const m of markers) if (text.toLowerCase().includes(m.toLowerCase())) signals.push(`marker:${m}`);
    const files = new Set((text.match(LEGACY_FILE_TOKEN) || []).map((f) => f.toLowerCase()));
    if (files.size >= minComplexFiles) signals.push(`files:${files.size}`);
    return signals;
  }

  function decide(lane, tier, ctx) {
    return {
      lane, tier, reason: ctx.reason, signals: ctx.signals, score: ctx.score, band: ctx.band,
      features: featuresForEvent(ctx.feat), classification: ctx.feat.classification
    };
  }

  function route(message, options = {}) {
    const text = String(message || "");
    const feat = extractFeatures(text, options, { markers });
    const score = computeScore(feat);
    const band = classifyBand(score, complexThreshold);
    const signals = legacySignals(text);
    const heuristicLane = signals.length > 0 ? "orchestrate" : "single";
    const ctx = { feat, score, band, signals };

    if (!modelActive) {
      return decide(heuristicLane, "heuristic", { ...ctx, reason: heuristicLane === "orchestrate" ? "complexity signals present" : "no complexity signals" });
    }
    if (band === "simple") return decide("single", "heuristic", { ...ctx, reason: "band:simple" });
    if (band === "complex") return decide("orchestrate", "heuristic", { ...ctx, reason: "band:complex" });

    // ambiguous → model tier (async; the only branch that returns a Promise)
    return modelTier(text, feat, options).then((v) => (v.ok
      ? decide(v.lane, "model", { ...ctx, reason: v.reason || "model" })
      : decide(heuristicLane, "fallback", { ...ctx, reason: v.reason })));
  }

  async function modelTier(message, feat, options = {}) {
    const start = now();
    let feedback = null;
    for (let attempt = 0; attempt <= maxRepairs; attempt += 1) {
      if (options.signal?.aborted) {
        const err = new Error("turn was interrupted");
        err.name = "AbortError";
        err.code = "ABORT";
        throw err;
      }
      if (options.scope?.budget?.exceeded()) {
        const over = options.scope.budget.exceeded();
        const err = new Error(`cost budget exceeded: ${over.reason}`);
        err.code = "BUDGET_EXCEEDED";
        err.details = over;
        throw err;
      }
      const remaining = timeoutMs - (now() - start);
      if (remaining <= 0) return { ok: false, reason: "router_model_timeout" };
      let raw;
      try {
        raw = await callModel(routerPrompt(message, feat, feedback), {
          timeoutMs: remaining,
          signal: options.signal,
          scope: options.scope,
          role: "router"
        });
      } catch (e) {
        if (isBudgetOrAbort(e)) throw e;
        return { ok: false, reason: isTimeout(e) ? "router_model_timeout" : "router_model_error" };
      }
      if (!raw) return { ok: false, reason: "router_model_empty" };
      const v = validateRouteVerdict(extractJson(raw));
      if (v.ok) return v;
      feedback = 'reply ONLY {"lane":"single"|"orchestrate","reason":"..."}';
    }
    return { ok: false, reason: "router_model_invalid" };
  }

  return { route };
}

export function validateRouteVerdict(obj) {
  if (!obj || typeof obj !== "object") return { ok: false, reason: "router_model_invalid" };
  if (obj.lane !== "single" && obj.lane !== "orchestrate") return { ok: false, reason: "router_model_invalid" };
  return { ok: true, lane: obj.lane, reason: typeof obj.reason === "string" ? obj.reason.slice(0, 200) : "model" };
}

function routerPrompt(message, feat, feedback) {
  return [
    "Classify this coding request for routing.",
    "Answer single = one focused change or question; orchestrate = spans multiple files / sub-goals / a large refactor.",
    `Request: ${message}`,
    feat.files.length ? `Files mentioned: ${feat.files.join(", ")}` : "",
    'Reply with ONLY JSON: {"lane":"single"|"orchestrate","reason":"<short>"}',
    feedback ? `Previous attempt rejected: ${feedback}` : ""
  ].filter(Boolean).join("\n\n");
}

function isTimeout(e) { return Boolean(e) && (e.code === "MODEL_TIMEOUT" || /timeout/i.test(e.message || "")); }

function isBudgetOrAbort(e) {
  if (!e) return false;
  return e.code === "BUDGET_EXCEEDED" || e.code === "INTERRUPTED" || e.name === "AbortError" || e.name === "InterruptedError";
}

function extractJson(text) {
  const s = String(text || "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}
