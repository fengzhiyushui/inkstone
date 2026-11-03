import { safeRecoverySegment } from "./atomic-file.js";
import { createRecoveryFaults } from "./recovery-faults.js";
import { createSidecarStore } from "./sidecar-store.js";

const SCHEMA_VERSION = 1;
const VALID_SURFACES = new Set(["cli", "tui", "gui"]);

export function createPausedTurnPersistence({ root, projectId, faults = createRecoveryFaults() }) {
  return createSidecarStore({
    root,
    projectId,
    dirName: "paused",
    idField: "approval_id",
    schemaVersion: SCHEMA_VERSION,
    faults,
    invalidReason: "invalid paused sidecar",
    afterWriteLabel: "after-paused-sidecar-write",
    beforeDeleteLabel: "before-paused-sidecar-delete",
    tombstoneWriteFailureReason: "consumed paused sidecar tombstone write failed",
    cleanupFailureReason: "consumed paused sidecar cleanup failed",
    tombstoneDeleteFailure: "rethrow-write-error",
    compareScan: compareScanned,
    prepareSave: (record) => {
      const normalized = validateRecord(record);
      return { id: normalized.approval_id, payload: normalized };
    },
    prepareLoad: (record, { id }) => validateRecord(record, { expectedApprovalId: id }),
    classifyScan: (record, { approvalId, path: filePath }) => ({
      kind: "entry",
      entry: record?.status === "consumed"
        ? validateConsumedRecord(record, { expectedApprovalId: approvalId, path: filePath })
        : validateRecord(record, { expectedApprovalId: approvalId })
    })
  });
}

function validateRecord(record, { expectedApprovalId = null } = {}) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("paused record is required");
  }

  const approval_id = requireSegment(record.approval_id, "approval_id");
  if (expectedApprovalId && approval_id !== expectedApprovalId) {
    throw new Error("approval_id must match sidecar path");
  }

  const schema_version = record.schema_version ?? SCHEMA_VERSION;
  if (schema_version !== SCHEMA_VERSION) throw new Error("unsupported paused sidecar schema_version");
  const turn_id = requireString(record.turn_id, "turn_id");
  const session_id = requireString(record.session_id, "session_id");
  const created_at = requireIsoTimestamp(record.created_at, "created_at");
  const surface = requireString(record.surface, "surface");
  if (!VALID_SURFACES.has(surface)) throw new Error("invalid paused sidecar surface");
  const permission_context = requireObject(record.permission_context, "permission_context");
  const approval = requireObject(record.approval, "approval");
  if (approval.id !== approval_id) throw new Error("approval.id must match approval_id");
  const turn = requireObject(record.turn, "turn");
  const resume_state = requireObject(record.resume_state, "resume_state");

  return {
    schema_version,
    approval_id,
    turn_id,
    session_id,
    created_at,
    surface,
    permission_context,
    approval,
    turn,
    resume_state
  };
}

function validateConsumedRecord(record, { expectedApprovalId = null, path = null } = {}) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("paused consumed record is required");
  }

  const approval_id = requireSegment(record.approval_id, "approval_id");
  if (expectedApprovalId && approval_id !== expectedApprovalId) {
    throw new Error("approval_id must match sidecar path");
  }

  const schema_version = record.schema_version ?? SCHEMA_VERSION;
  if (schema_version !== SCHEMA_VERSION) throw new Error("unsupported paused sidecar schema_version");
  if (record.status !== "consumed") throw new Error("invalid paused consumed status");
  const consumed_at = requireIsoTimestamp(record.consumed_at, "consumed_at");

  return {
    schema_version,
    approval_id,
    status: "consumed",
    consumed_at,
    path,
    reason: sanitizeReason(record.reason || "consumed")
  };
}

function requireSegment(value, field) {
  if (!value) throw new Error(`${field} is required`);
  return safeRecoverySegment(value);
}

function requireString(value, field) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} is required`);
  return value;
}

function requireObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} is required`);
  return value;
}

function requireIsoTimestamp(value, field) {
  requireString(value, field);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`${field} must be an ISO timestamp`);
  }
  return value;
}

function compareScanned(left, right) {
  const leftTime = left.created_at || "";
  const rightTime = right.created_at || "";
  if (leftTime !== rightTime) return leftTime.localeCompare(rightTime);
  return String(left.approval_id || "").localeCompare(String(right.approval_id || ""));
}

function sanitizeReason(reason) {
  const text = String(reason || "invalid paused sidecar");
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}
