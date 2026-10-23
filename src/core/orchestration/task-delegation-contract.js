// Pure contract layer for R18-02 task delegation and parent-child durable recovery.
// Operates strictly on plain serializable data (no live runtime, closures, eventBus, or AbortController).

export const TASK_DELEGATION_SCHEMA_VERSION = 1;

export const TASK_DELEGATION_FINGERPRINTS = Object.freeze({
  delegationService: 1,
  toolSubset: 1,
  parentChildBridge: 1
});

export const DEFAULT_TASK_TOOLS = Object.freeze(["read", "grep", "glob"]);
export const READ_ONLY_TASK_TOOLS = Object.freeze(new Set(["read", "grep", "glob", "ls"]));
export const FORBIDDEN_TASK_TOOLS = Object.freeze(new Set(["task", "ask_user"]));
export const MAX_TASK_TOOLS = 5;
export const MAX_TASK_DEPTH = 1;
export const MAX_TASK_SUBTASKS_PER_TURN = 5;
export const MAX_TASK_RESULT_CHARS = 8000;

export const TASK_PAUSED_STATES = Object.freeze({
  PARENT_APPROVED_CHILD_PENDING: "parent_approved_child_pending",
  CHILD_RUNNING: "child_running",
  CHILD_PAUSED_AWAITING_PARENT_PERSIST: "child_paused_awaiting_parent_persist",
  PAUSED_PERSISTED: "paused_persisted",
  CHILD_RESUMING: "child_resuming",
  CHILD_COMPLETED_PENDING_PARENT: "child_completed_pending_parent",
  PARENT_RESULT_WRITTEN_PENDING_CLEANUP: "parent_result_written_pending_cleanup",
  CONSUMED: "consumed"
});

const AUTONOMY_RANK = Object.freeze({
  "read-only": 0,
  supervised: 1,
  gated: 2,
  auto: 3,
  "full-auto": 4
});

export function clampChildAutonomy(parentAutonomy = "gated", requestedAutonomy = null) {
  const parentNorm = Object.prototype.hasOwnProperty.call(AUTONOMY_RANK, parentAutonomy)
    ? parentAutonomy
    : "gated";
  // Never automatically escalate child worker to full-auto; cap at parent's rank (and at most "auto" unless parent is already narrower)
  const effectiveParent = parentNorm === "full-auto" ? "auto" : parentNorm;
  if (!requestedAutonomy || !Object.prototype.hasOwnProperty.call(AUTONOMY_RANK, requestedAutonomy)) {
    return effectiveParent;
  }
  return AUTONOMY_RANK[requestedAutonomy] <= AUTONOMY_RANK[effectiveParent]
    ? requestedAutonomy
    : effectiveParent;
}

export function resolveTaskToolCategory(params = {}) {
  const rawTools = params?.tools;
  if (rawTools === undefined || rawTools === null) {
    return "read";
  }
  if (!Array.isArray(rawTools) || rawTools.length === 0) {
    return "execute";
  }
  const allReadOnly = rawTools.every(
    (name) => typeof name === "string" && READ_ONLY_TASK_TOOLS.has(name)
  );
  return allReadOnly ? "read" : "execute";
}

export function validateTaskParams(params = {}) {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return { ok: false, code: "TASK_INVALID_PARAMS", error: "task parameters must be an object" };
  }
  if (typeof params.prompt !== "string" || !params.prompt.trim()) {
    return { ok: false, code: "TASK_INVALID_PROMPT", error: "task prompt must be a non-empty string" };
  }

  if (params.tools === undefined || params.tools === null) {
    return {
      ok: true,
      prompt: params.prompt,
      tools: [...DEFAULT_TASK_TOOLS],
      explicitTools: false
    };
  }

  if (!Array.isArray(params.tools) || params.tools.length === 0) {
    return {
      ok: false,
      code: "TASK_INVALID_TOOLS",
      error: "task tools must be a non-empty array of tool names"
    };
  }

  if (params.tools.length > MAX_TASK_TOOLS) {
    return {
      ok: false,
      code: "TASK_TOOLS_LIMIT_EXCEEDED",
      error: `task tools exceeds maximum of ${MAX_TASK_TOOLS} items (received ${params.tools.length})`
    };
  }

  const deduped = [];
  const seen = new Set();
  for (let i = 0; i < params.tools.length; i += 1) {
    const item = params.tools[i];
    if (typeof item !== "string" || !item.trim() || item.trim() !== item) {
      return {
        ok: false,
        code: "TASK_INVALID_TOOL_NAME",
        error: `task tools[${i}] must be a non-empty tool name string`
      };
    }
    if (FORBIDDEN_TASK_TOOLS.has(item)) {
      return {
        ok: false,
        code: "TASK_FORBIDDEN_TOOL",
        error: `tool "${item}" is forbidden in task delegation`
      };
    }
    if (!seen.has(item)) {
      seen.add(item);
      deduped.push(item);
    }
  }

  return {
    ok: true,
    prompt: params.prompt,
    tools: deduped,
    explicitTools: true
  };
}

export function authorizeTaskTools({
  requestedTools,
  explicitTools = false,
  parentToolNames = null,
  registry = null,
  parentAutonomy = "gated"
} = {}) {
  const parentSet = parentToolNames
    ? new Set(Array.isArray(parentToolNames) ? parentToolNames : [...parentToolNames])
    : null;

  const authorized = [];
  for (const name of requestedTools || []) {
    if (FORBIDDEN_TASK_TOOLS.has(name)) {
      return {
        ok: false,
        status: "denied",
        code: "TASK_FORBIDDEN_TOOL",
        error: `Tool "${name}" cannot be delegated to a task worker`
      };
    }

    const def = registry?.resolve ? registry.resolve(name) : null;
    if (registry && !def) {
      if (explicitTools) {
        return {
          ok: false,
          status: "error",
          code: "TASK_UNKNOWN_TOOL",
          error: `Unknown tool in task delegation: ${name}`
        };
      }
      continue;
    }

    if (parentSet && !parentSet.has(name)) {
      if (explicitTools) {
        return {
          ok: false,
          status: "denied",
          code: "TASK_TOOL_NOT_IN_PARENT_SCOPE",
          error: `Permission denied: tool "${name}" is not available in parent scope`
        };
      }
      continue;
    }

    if (parentAutonomy === "read-only") {
      const isReadCategory = def ? def.category === "read" && READ_ONLY_TASK_TOOLS.has(name) : READ_ONLY_TASK_TOOLS.has(name);
      if (!isReadCategory) {
        return {
          ok: false,
          status: "denied",
          code: "TASK_READONLY_VIOLATION",
          error: `Permission denied: read-only parent turn cannot delegate non-read tool "${name}"`
        };
      }
    }

    authorized.push(name);
  }

  if (authorized.length === 0) {
    return {
      ok: false,
      status: "denied",
      code: "TASK_NO_AUTHORIZED_TOOLS",
      error: "No authorized tools available for task delegation"
    };
  }

  return { ok: true, tools: authorized };
}

export function taskFingerprintsMatch(fp) {
  if (!fp || typeof fp !== "object") return false;
  const keys = Object.keys(TASK_DELEGATION_FINGERPRINTS);
  if (Object.keys(fp).length !== keys.length) return false;
  return keys.every((k) => fp[k] === TASK_DELEGATION_FINGERPRINTS[k]);
}

export function isTaskDelegationParentRecord(record) {
  return Boolean(record?.resume_state?.task_delegation && typeof record.resume_state.task_delegation === "object");
}

export function isTaskChildWorkerRecord(record) {
  return Boolean(record?.resume_state?.options?.__task_child && typeof record.resume_state.options.__task_child === "object");
}

export function validateTaskPausedSidecar(sidecar) {
  if (!sidecar || typeof sidecar !== "object" || Array.isArray(sidecar)) {
    return { ok: false, error: "task sidecar not an object" };
  }
  if (sidecar.schema_version !== TASK_DELEGATION_SCHEMA_VERSION) {
    return { ok: false, error: "unsupported task sidecar schema_version" };
  }
  if (typeof sidecar.approval_id !== "string" || !sidecar.approval_id) {
    return { ok: false, error: "missing approval_id" };
  }
  if (typeof sidecar.child_id !== "string" || !sidecar.child_id) {
    return { ok: false, error: "missing child_id" };
  }
  if (typeof sidecar.state !== "string" || !sidecar.state) {
    return { ok: false, error: "missing state" };
  }
  const parent = sidecar.parent;
  if (!parent || typeof parent !== "object") {
    return { ok: false, error: "missing parent metadata" };
  }
  if (typeof parent.turn_id !== "string" || !parent.turn_id) {
    return { ok: false, error: "missing parent.turn_id" };
  }
  if (typeof parent.tool_call_id !== "string" || !parent.tool_call_id) {
    return { ok: false, error: "missing parent.tool_call_id" };
  }
  if (typeof parent.session_id !== "string" || !parent.session_id) {
    return { ok: false, error: "missing parent.session_id" };
  }
  if (!Array.isArray(parent.delegated_tools) || parent.delegated_tools.length === 0) {
    return { ok: false, error: "invalid parent.delegated_tools" };
  }
  return { ok: true };
}

export function taskDelegationResumeGate({ parentRecord, childSidecar }) {
  if (!parentRecord) {
    return { ok: false, reason: "parent paused sidecar missing" };
  }
  if (!isTaskDelegationParentRecord(parentRecord)) {
    return { ok: false, reason: "parent sidecar missing task_delegation continuation" };
  }
  if (!childSidecar) {
    return { ok: false, reason: "task child sidecar missing" };
  }

  const shape = validateTaskPausedSidecar(childSidecar);
  if (!shape.ok) {
    return { ok: false, reason: shape.error };
  }

  const td = parentRecord.resume_state.task_delegation;
  if (td.schema_version !== TASK_DELEGATION_SCHEMA_VERSION) {
    return { ok: false, reason: "unsupported parent task_delegation schema_version" };
  }
  if (!taskFingerprintsMatch(td.fingerprints) || !taskFingerprintsMatch(childSidecar.fingerprints)) {
    return { ok: false, reason: "task delegation fingerprint mismatch" };
  }

  if (childSidecar.state === TASK_PAUSED_STATES.CHILD_PAUSED_AWAITING_PARENT_PERSIST) {
    return { ok: false, reason: "incomplete parent-child pause checkpoint (child_paused_awaiting_parent_persist)" };
  }
  if (childSidecar.state === TASK_PAUSED_STATES.CHILD_RESUMING) {
    return { ok: false, reason: "task child interrupted mid-resume; cannot prove side-effect idempotency" };
  }
  if (
    childSidecar.state !== TASK_PAUSED_STATES.PAUSED_PERSISTED &&
    childSidecar.state !== TASK_PAUSED_STATES.CHILD_COMPLETED_PENDING_PARENT
  ) {
    return { ok: false, reason: `unsupported task child recovery state: ${childSidecar.state}` };
  }

  // Ownership correlation checks (parent <-> task_delegation <-> childSidecar)
  if (parentRecord.approval_id !== childSidecar.approval_id || td.approval_id !== childSidecar.approval_id) {
    return { ok: false, reason: "task delegation approval_id mismatch" };
  }
  if (parentRecord.turn_id !== td.parent_turn_id || childSidecar.parent.turn_id !== td.parent_turn_id) {
    return { ok: false, reason: "task delegation parent_turn_id mismatch" };
  }
  if (parentRecord.session_id !== td.parent_session_id || childSidecar.parent.session_id !== td.parent_session_id) {
    return { ok: false, reason: "task delegation parent_session_id mismatch" };
  }
  if (
    parentRecord.resume_state.pending_tool_call?.id !== td.parent_tool_call_id ||
    childSidecar.parent.tool_call_id !== td.parent_tool_call_id ||
    parentRecord.resume_state.pending_tool_call?.name !== "task"
  ) {
    return { ok: false, reason: "task delegation parent_tool_call_id mismatch" };
  }
  if (td.child_id !== childSidecar.child_id) {
    return { ok: false, reason: "task delegation child_id mismatch" };
  }

  if (childSidecar.state === TASK_PAUSED_STATES.PAUSED_PERSISTED) {
    const childRecord = childSidecar.child_record;
    if (!childRecord || typeof childRecord !== "object") {
      return { ok: false, reason: "task child_record missing" };
    }
    if (childRecord.approval_id !== childSidecar.approval_id) {
      return { ok: false, reason: "task child_record approval_id mismatch" };
    }
    const marker = childRecord.resume_state?.options?.__task_child;
    if (
      !marker ||
      marker.child_id !== childSidecar.child_id ||
      marker.parent_turn_id !== td.parent_turn_id ||
      marker.parent_tool_call_id !== td.parent_tool_call_id ||
      marker.parent_session_id !== td.parent_session_id
    ) {
      return { ok: false, reason: "task child_record ownership marker mismatch" };
    }
  } else if (childSidecar.state === TASK_PAUSED_STATES.CHILD_COMPLETED_PENDING_PARENT) {
    if (!childSidecar.completed_result || typeof childSidecar.completed_result !== "object") {
      return { ok: false, reason: "task child_completed_pending_parent missing completed_result checkpoint" };
    }
  }

  return {
    ok: true,
    mode: childSidecar.state === TASK_PAUSED_STATES.CHILD_COMPLETED_PENDING_PARENT
      ? "deliver_checkpointed_result"
      : "resume_child"
  };
}
