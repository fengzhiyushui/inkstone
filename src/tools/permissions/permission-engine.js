import { createHash } from "node:crypto";

export const DEFAULT_POLICY_MATRIX = Object.freeze({
  "read-only": {
    read: "allow", read_secret: "ask",
    write_create: "deny", write_update: "deny", write_delete: "deny",
    execute: "deny", execute_dangerous: "deny", network: "deny", destructive: "deny"
  },
  supervised: {
    read: "allow", read_secret: "ask",
    write_create: "ask", write_update: "ask", write_delete: "ask",
    execute: "ask", execute_dangerous: "ask", network: "ask", destructive: "deny"
  },
  gated: {
    read: "allow", read_secret: "ask",
    write_create: "allow", write_update: "allow", write_delete: "ask",
    execute: "ask", execute_dangerous: "ask", network: "ask", destructive: "deny"
  },
  auto: {
    read: "allow", read_secret: "ask",
    write_create: "allow", write_update: "allow", write_delete: "allow",
    execute: "allow", execute_dangerous: "ask", network: "ask", destructive: "deny"
  },
  "full-auto": {
    read: "allow", read_secret: "ask",
    write_create: "allow", write_update: "allow", write_delete: "allow",
    execute: "allow", execute_dangerous: "ask", network: "allow", destructive: "deny"
  }
});

export function createPermissionEngine() {
  function decide(toolCall, context = {}) {
    const category = toolCall.category || "read";
    const autonomy = context.autonomy || "gated";

    if (category === "destructive") {
      return { decision: "deny", matched_rule: "hardcoded:destructive", source: "safety-invariant" };
    }

    const cached = context.approvalCache?.get?.(fingerprint(toolCall, context));
    if (cached?.decision === "allow") {
      return { decision: "allow", matched_rule: "approval-cache", source: "approval-cache" };
    }

    for (const rule of context.trustStore?.rules || []) {
      if (ruleMatches(rule, toolCall)) {
        return { decision: rule.decision, matched_rule: rule.id, source: "user-trust-store" };
      }
    }

    for (const rule of context.projectRules || []) {
      if (rule.escalate_only) continue; // risk-escalation rules are handled monotonically below, never returned here
      if (ruleMatches(rule, toolCall)) {
        return { decision: rule.decision, matched_rule: rule.id, source: "project-rules" };
      }
    }

    const matrix = DEFAULT_POLICY_MATRIX[autonomy] || DEFAULT_POLICY_MATRIX.gated;
    const decision = matrix[category] || "ask";
    // C4 risk→permission: monotonic escalation. ONLY upgrade a default-matrix "allow"
    // to "ask" when a risk cue matches; never downgrade deny/ask, never override the
    // explicit user decisions above (trust-store / approval-cache / project-rules).
    if (decision === "allow" && matchesRiskCue(context.projectRules, toolCall)) {
      return { decision: "ask", matched_rule: "risk-experience:escalate", source: "risk-experience", escalated: true };
    }
    return {
      decision,
      matched_rule: `default:${autonomy}:${category}`,
      source: "default-matrix"
    };
  }

  function explain(toolCall, context = {}) {
    const result = decide(toolCall, context);
    return {
      ...result,
      reason: `Category: ${toolCall.category} | Autonomy: ${context.autonomy || "gated"} | Source: ${result.source}`
    };
  }

  function fingerprint(toolCall, context = {}) {
    const params = toolCall.params || {};
    const sortedParams = Object.keys(params).sort().reduce((obj, key) => {
      obj[key] = params[key];
      return obj;
    }, {});
    const canonical = JSON.stringify({
      tool: toolCall.name,
      category: toolCall.category,
      params: sortedParams,
      project: context.projectId || ""
    });
    return `fp:${createHash("sha256").update(canonical).digest("hex").slice(0, 16)}`;
  }

  return { decide, explain, fingerprint };
}

// True if any escalate_only risk cue appears in the tool call's surface (tool/path/argv/command).
function matchesRiskCue(rules, toolCall) {
  const cues = (rules || []).filter((r) => r && r.escalate_only && typeof r.cue === "string" && r.cue);
  if (!cues.length) return false;
  const params = toolCall.params || {};
  const surface = [
    toolCall.name,
    params.path,
    Array.isArray(params.argv) ? params.argv.join(" ") : "",
    typeof params.command === "string" ? params.command : ""
  ].filter(Boolean).join(" ").toLowerCase();
  return cues.some((r) => surface.includes(r.cue));
}

function ruleMatches(rule, toolCall) {
  if (!rule || typeof rule !== "object") return false;
  const hasCondition = Boolean(rule.tool || rule.category || rule.pattern || rule.match?.argv);
  if (!hasCondition) return false;

  if (rule.tool && rule.tool !== toolCall.name) return false;
  if (rule.category && rule.category !== toolCall.category) return false;
  if (rule.pattern) {
    if (!toolCall.params?.path) return false;
    if (!globMatch(rule.pattern, toolCall.params.path)) return false;
  }
  if (rule.match?.argv) {
    const callArgv = toolCall.params?.argv || [];
    if (!arraysEqual(rule.match.argv, callArgv)) return false;
  }
  return true;
}

export function globMatch(pattern, value) {
  let source = pattern
    .replace(/\*\*/g, "\x00DSTAR\x00")
    .replace(/\*/g, "\x00STAR\x00")
    .replace(/\?/g, "\x00QMARK\x00");
  source = source.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  source = source
    .replace(/\x00DSTAR\x00/g, ".*")
    .replace(/\x00STAR\x00/g, "[^/]*")
    .replace(/\x00QMARK\x00/g, "[^/]");
  return new RegExp(`^${source}$`).test(value);
}

function arraysEqual(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
