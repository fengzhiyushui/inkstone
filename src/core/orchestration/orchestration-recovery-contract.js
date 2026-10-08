// Pure contract layer for durable orchestration recovery. No I/O, no live objects.
// Every function operates on plain serializable data so it is unit-testable in isolation.

export const ORCH_RECOVERY_SCHEMA_VERSION = 1;

// Version fingerprints of the code a rebuilt worker's byte-equivalence depends on.
// Bump the relevant field when that logic changes incompatibly:
//   workerFactory -> worker-factory.js rebuild wiring;  toolSubset -> tool-profiles.js filtering;
//   subtaskSchema -> subtask-schema.js SubTask shape.
export const ORCH_FINGERPRINTS = Object.freeze({ workerFactory: 1, toolSubset: 1, subtaskSchema: 1 });

export function fingerprintsMatch(sidecarFingerprints) {
  if (!sidecarFingerprints || typeof sidecarFingerprints !== "object") return false;
  const keys = Object.keys(ORCH_FINGERPRINTS);
  if (Object.keys(sidecarFingerprints).length !== keys.length) return false;
  return keys.every((k) => sidecarFingerprints[k] === ORCH_FINGERPRINTS[k]);
}

export function isOrchestrationWorkerSidecar(workerRecord) {
  return !!workerRecord?.resume_state?.options?.__orchestration;
}

export function ownershipOk({ sidecar, workerRecord }) {
  if (!sidecar || !workerRecord) return false;
  const marker = workerRecord.resume_state?.options?.__orchestration;
  if (!marker) return false;                                     // turn owner type must be orchestration-owned
  if (sidecar.approvalId !== workerRecord.approval_id) return false;   // same-key correlation
  if (sidecar.taskId !== marker.taskId) return false;
  if (sidecar.sessionId !== marker.sessionId) return false;
  if (!sidecar.pausedSubtask || sidecar.pausedSubtask.id !== marker.subtaskId) return false;
  return true;
}

const REQUIRED_TOP_FIELDS = ["approvalId", "taskId", "sessionId", "message", "done_when", "plan", "round", "pausedSubtask", "remaining", "budget", "seenSubtaskIds", "seenFp"];

// Structural validation only — NOT the version gate. A fingerprint-outdated but
// well-formed sidecar passes here (so the caller can present it as blocked with a
// clear "fingerprint mismatch" reason via orchestrationResumeGate).
export function validateOrchestrationSidecar(json) {
  if (!json || typeof json !== "object" || Array.isArray(json)) return { ok: false, error: "sidecar not an object" };
  if (json.schemaVersion !== ORCH_RECOVERY_SCHEMA_VERSION) return { ok: false, error: "unsupported schemaVersion" };
  for (const f of REQUIRED_TOP_FIELDS) {
    if (json[f] === undefined || json[f] === null) return { ok: false, error: `missing field: ${f}` };
  }
  if (!Array.isArray(json.plan?.subtasks)) return { ok: false, error: "plan.subtasks not array" };
  if (typeof json.pausedSubtask.id !== "string") return { ok: false, error: "pausedSubtask.id missing" };
  if (!Array.isArray(json.remaining)) return { ok: false, error: "remaining not array" };
  if (!Array.isArray(json.seenSubtaskIds) || !Array.isArray(json.seenFp)) return { ok: false, error: "seen sets not arrays" };
  const b = json.budget;
  if (!b || typeof b !== "object" || !("spentTokens" in b) || !("spentCalls" in b)) return { ok: false, error: "budget counts missing" };
  return { ok: true };
}

// Authoritative resume gate (CST-6 version + CST-7 ownership). Used by both the
// scan-time presentation (M6) and the resume-time gate (M4). Fails closed.
export function orchestrationResumeGate({ sidecar, workerRecord }) {
  const shape = validateOrchestrationSidecar(sidecar);
  if (!shape.ok) return { ok: false, reason: shape.error };
  if (!fingerprintsMatch(sidecar.fingerprints)) return { ok: false, reason: "fingerprint mismatch" };
  if (!workerRecord) return { ok: false, reason: "worker sidecar missing" };
  if (!isOrchestrationWorkerSidecar(workerRecord)) return { ok: false, reason: "worker sidecar not orchestration-owned" };
  if (!ownershipOk({ sidecar, workerRecord })) return { ok: false, reason: "ownership mismatch" };

  const b = sidecar.budget || {};
  const hasFiniteQuota = (b.quotaTokens != null && Number.isFinite(b.quotaTokens)) ||
                         (b.quotaCalls != null && Number.isFinite(b.quotaCalls));
  const isLegacyUnmetered = b.settledAttempts === undefined && b.unknownUsageAttempts === undefined;
  if (hasFiniteQuota && isLegacyUnmetered) {
    return { ok: false, reason: "legacy unmetered budget: cannot safely verify remaining quota" };
  }

  return { ok: true };
}

export function serializeOrchestrationState(state, { approvalId, pausedSubtask, remaining }) {
  const bs = state.budget.snapshot();
  return {
    schemaVersion: ORCH_RECOVERY_SCHEMA_VERSION,
    fingerprints: { ...ORCH_FINGERPRINTS },
    approvalId,
    taskId: state.taskId,
    sessionId: state.sessionId,
    executionId: state.executionId || bs.execution_id || state.taskId,
    message: state.message,
    done_when: state.done_when,
    autonomy: state.options?.autonomy || "gated",
    plan: { subtasks: (state.plan?.subtasks || []).map((s) => ({ ...s })) },
    round: state.round,
    env: { root: state.env?.root ?? null, orchestrationConfig: state.env?.orchestrationConfig ?? null },
    allCollected: (state.allCollected || []).map(serializeCollected),
    seenSubtaskIds: [...state.seenSubtaskIds],
    seenFp: [...state.seenFp],
    executionId: state.executionId || state.scope?.executionId || state.taskId,
    budget: {
      quotaTokens: bs.max_tokens ?? null,
      quotaCalls: bs.max_model_calls ?? null,
      spentTokens: bs.tokens || 0,
      spentCalls: bs.model_calls || 0,
      ...(bs.unknown_usage_attempts != null || bs.unknownUsageAttempts != null ? {
        unknownUsageAttempts: bs.unknown_usage_attempts || bs.unknownUsageAttempts || 0
      } : {}),
      ...(bs.unknown_usage_tokens != null || bs.unknownUsageTokens != null ? {
        unknownUsageTokens: bs.unknown_usage_tokens ?? bs.unknownUsageTokens ?? 0
      } : {}),
      ...(bs.fallback_tokens_per_unknown != null || bs.fallbackTokensPerUnknown != null ? {
        fallbackTokensPerUnknown: bs.fallback_tokens_per_unknown ?? bs.fallbackTokensPerUnknown
      } : {}),
      ...(bs.settled_attempts != null || bs.settledAttempts != null ? {
        settledAttempts: bs.settled_attempts || bs.settledAttempts || []
      } : {}),
      ...(bs.by_role ? { byRole: bs.by_role } : {})
    },
    adoptedExperienceIds: [...(state.adoptedExperienceIds || [])],
    riskCues: [...(state.riskCues || [])],
    pausedSubtask: { ...pausedSubtask },
    remaining: (remaining || []).map((s) => ({ ...s }))
  };
}

function serializeCollected(c) {
  return {
    st: c.st,
    status: c.status,
    wres: c.wres ? { status: c.wres.status, content: String(c.wres.content ?? "") } : undefined,
    verdict: c.verdict ? { pass: !!c.verdict.pass, severity: c.verdict.severity, reasons: c.verdict.reasons || [], checked: c.verdict.checked || [] } : undefined,
    lastFeedback: c.lastFeedback,
    change_id: c.change_id ?? null
  };
}

export function deserializeOrchestrationState(json) {
  return {
    message: json.message,
    done_when: json.done_when,
    options: { autonomy: json.autonomy || "gated", sessionId: json.sessionId },
    plan: { subtasks: (json.plan?.subtasks || []).map((s) => ({ ...s })) },
    round: json.round,
    allCollected: (json.allCollected || []).map((c) => ({ ...c })),
    seenSubtaskIds: new Set(json.seenSubtaskIds || []),
    seenFp: new Set(json.seenFp || []),
    riskCues: new Set(json.riskCues || []),
    adoptedExperienceIds: [...(json.adoptedExperienceIds || [])],
    taskId: json.taskId,
    sessionId: json.sessionId,
    executionId: json.executionId || json.taskId,
    env: json.env || { root: null, orchestrationConfig: null },
    budgetSnapshot: budgetContinuation(json.budget, json),
    pausedSubtask: { ...json.pausedSubtask },
    remaining: (json.remaining || []).map((s) => ({ ...s }))
  };
}

export function budgetContinuation(budgetJson, rootJson = {}) {
  const b = budgetJson || {};
  const isLegacy = Boolean(
    rootJson && (rootJson.taskId || rootJson.approvalId) &&
    b.settledAttempts === undefined &&
    b.unknownUsageAttempts === undefined &&
    b.quotaTokens == null && b.quotaCalls == null
  );

  let initialCalls = b.spentCalls || 0;
  let initialUnknown = b.unknownUsageAttempts ?? 0;
  if (isLegacy) {
    const completedCount = Array.isArray(rootJson.allCollected)
      ? rootJson.allCollected.filter((c) => c.status === "complete").length
      : 0;
    initialCalls = Math.max(initialCalls, completedCount > 0 ? completedCount * 2 : 1);
    initialUnknown = Math.max(initialUnknown, 1);
  }

  const continuation = {
    maxTokens: b.quotaTokens ?? null,
    maxModelCalls: b.quotaCalls ?? null,
    initialTokens: b.spentTokens || 0,
    initialModelCalls: initialCalls
  };
  if (b.unknownUsageAttempts != null && b.unknownUsageAttempts > 0) {
    continuation.initialUnknownUsageAttempts = b.unknownUsageAttempts;
  } else if (isLegacy) {
    continuation.initialUnknownUsageAttempts = initialUnknown;
  }

  // Preserve unknown usage liability across recovery
  let recoveredUnknownTokens = 0;
  if (b.unknownUsageTokens != null && b.unknownUsageTokens > 0) {
    recoveredUnknownTokens = b.unknownUsageTokens;
  } else if (continuation.initialUnknownUsageAttempts > 0) {
    const byRoleTokens = Object.values(b.byRole || {}).reduce((acc, r) => acc + (r?.tokens || 0), 0);
    const fb = b.fallbackTokensPerUnknown || 500;
    if (byRoleTokens > (b.spentTokens || 0)) {
      recoveredUnknownTokens = Math.max(byRoleTokens - (b.spentTokens || 0), continuation.initialUnknownUsageAttempts * fb);
    } else {
      recoveredUnknownTokens = continuation.initialUnknownUsageAttempts * fb;
    }
  }
  if (recoveredUnknownTokens > 0) {
    continuation.initialUnknownUsageTokens = recoveredUnknownTokens;
  }
  if (b.fallbackTokensPerUnknown != null && b.fallbackTokensPerUnknown > 0) {
    continuation.fallbackTokensPerUnknown = b.fallbackTokensPerUnknown;
  }

  if (b.settledAttempts != null && b.settledAttempts.length > 0) {
    continuation.initialSettledAttempts = Array.isArray(b.settledAttempts) ? b.settledAttempts : [];
  }
  if (b.byRole) {
    continuation.initialByRole = b.byRole;
  }
  if (isLegacy) {
    continuation.legacyUnmetered = true;
  }
  return continuation;
}

