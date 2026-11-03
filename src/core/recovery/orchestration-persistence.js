import { safeRecoverySegment } from "./atomic-file.js";
import { createRecoveryFaults } from "./recovery-faults.js";
import { createSidecarStore } from "./sidecar-store.js";
import { validateOrchestrationSidecar, ORCH_RECOVERY_SCHEMA_VERSION } from "../orchestration/orchestration-recovery-contract.js";

export function createOrchestrationPersistence({ root, projectId, faults = createRecoveryFaults() }) {
  return createSidecarStore({
    root,
    projectId,
    dirName: "orchestration-paused",
    idField: "approvalId",
    schemaVersion: ORCH_RECOVERY_SCHEMA_VERSION,
    schemaVersionField: "schemaVersion",
    faults,
    invalidReason: "invalid orchestration sidecar",
    afterWriteLabel: "after-orchestration-sidecar-write",
    prepareSave: (approvalId, state) => {
      const id = safeRecoverySegment(approvalId);
      const check = validateOrchestrationSidecar(state);
      if (!check.ok) throw new Error(`invalid orchestration sidecar: ${check.error}`);
      if (state.approvalId !== id) throw new Error("approvalId must match sidecar path");
      return { id, payload: state };
    },
    prepareLoad: (record, { id }) => {
      if (record?.status === "consumed") return { status: "consumed", approvalId: id };
      const check = validateOrchestrationSidecar(record);
      if (!check.ok) throw new Error(`invalid orchestration sidecar: ${check.error}`);
      if (record.approvalId !== id) throw new Error("approvalId must match sidecar path");
      return record;
    },
    classifyScan: (record, { approvalId, path: filePath }) => {
      if (record?.status === "consumed") {
        return { kind: "entry", entry: { status: "consumed", approvalId, path: filePath } };
      }
      const check = validateOrchestrationSidecar(record);
      if (!check.ok) return { kind: "corrupt", reason: check.error };
      if (record.approvalId !== approvalId) return { kind: "corrupt", reason: "approvalId mismatch" };
      return { kind: "entry", entry: record };
    }
  });
}
