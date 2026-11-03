import { safeRecoverySegment } from "./atomic-file.js";
import { createRecoveryFaults } from "./recovery-faults.js";
import { createSidecarStore } from "./sidecar-store.js";
import {
  TASK_DELEGATION_SCHEMA_VERSION,
  validateTaskPausedSidecar
} from "../orchestration/task-delegation-contract.js";

export function createTaskPausedPersistence({ root, projectId, faults = createRecoveryFaults() }) {
  return createSidecarStore({
    root,
    projectId,
    dirName: "task-paused",
    idField: "approval_id",
    schemaVersion: TASK_DELEGATION_SCHEMA_VERSION,
    faults,
    invalidReason: "invalid task paused sidecar",
    afterWriteLabel: "after-task-sidecar-write",
    beforeDeleteLabel: "before-task-sidecar-delete",
    // A task tombstone is consumed under either marker: `status` or `state`.
    tombstoneFields: { state: "consumed" },
    updateState: {
      timestampField: "updated_at",
      invalidPrefix: "invalid task paused sidecar update",
      validateUpdate: (next) => validateTaskPausedSidecar(next),
      faultLabels: {
        child_resuming: "after-task-child-resuming",
        child_completed_pending_parent: "after-task-child-completed-checkpoint"
      }
    },
    prepareSave: (approvalId, state) => {
      const id = safeRecoverySegment(approvalId);
      const check = validateTaskPausedSidecar(state);
      if (!check.ok) throw new Error(`invalid task paused sidecar: ${check.error}`);
      if (state.approval_id !== id) throw new Error("approval_id must match sidecar path");
      return { id, payload: state };
    },
    prepareLoad: (record, { id }) => {
      if (record?.status === "consumed" || record?.state === "consumed") {
        return { status: "consumed", approval_id: id };
      }
      const check = validateTaskPausedSidecar(record);
      if (!check.ok) throw new Error(`invalid task paused sidecar: ${check.error}`);
      if (record.approval_id !== id) throw new Error("approval_id must match sidecar path");
      return record;
    },
    classifyScan: (record, { approvalId, path: filePath }) => {
      if (record?.status === "consumed" || record?.state === "consumed") {
        return { kind: "entry", entry: { status: "consumed", approval_id: approvalId, path: filePath } };
      }
      const check = validateTaskPausedSidecar(record);
      if (!check.ok) return { kind: "corrupt", reason: check.error };
      if (record.approval_id !== approvalId) return { kind: "corrupt", reason: "approval_id mismatch" };
      return { kind: "entry", entry: record };
    }
  });
}
