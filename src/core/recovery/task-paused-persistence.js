import { mkdir, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { atomicReadJson, atomicWriteJson, safeRecoverySegment } from "./atomic-file.js";
import { createRecoveryFaults } from "./recovery-faults.js";
import {
  TASK_DELEGATION_SCHEMA_VERSION,
  validateTaskPausedSidecar
} from "../orchestration/task-delegation-contract.js";

export function createTaskPausedPersistence({ root, projectId, faults = createRecoveryFaults() }) {
  if (!root) throw new Error("root is required");
  const projectSegment = safeRecoverySegment(projectId);
  const baseDir = path.join(root, ".deepseek-code", "v2", "sessions", projectSegment, "task-paused");
  const quarantineDir = path.join(baseDir, "quarantine");

  const sidecarPath = (approvalId) => path.join(baseDir, `${safeRecoverySegment(approvalId)}.json`);

  async function save(approvalId, state) {
    const id = safeRecoverySegment(approvalId);
    const check = validateTaskPausedSidecar(state);
    if (!check.ok) throw new Error(`invalid task paused sidecar: ${check.error}`);
    if (state.approval_id !== id) throw new Error("approval_id must match sidecar path");
    await atomicWriteJson(sidecarPath(id), state);
    await faults.maybe("after-task-sidecar-write");
    return state;
  }

  async function updateState(approvalId, patch = {}) {
    const id = safeRecoverySegment(approvalId);
    const existing = await load(id);
    if (!existing || existing.status === "consumed") return existing;
    const next = {
      ...existing,
      ...patch,
      updated_at: new Date().toISOString()
    };
    const check = validateTaskPausedSidecar(next);
    if (!check.ok) throw new Error(`invalid task paused sidecar update: ${check.error}`);
    await atomicWriteJson(sidecarPath(id), next);
    if (patch.state === "child_resuming") {
      await faults.maybe("after-task-child-resuming");
    }
    if (patch.state === "child_completed_pending_parent") {
      await faults.maybe("after-task-child-completed-checkpoint");
    }
    return next;
  }

  async function load(approvalId) {
    const id = safeRecoverySegment(approvalId);
    const record = await atomicReadJson(sidecarPath(id));
    if (record?.status === "consumed" || record?.state === "consumed") {
      return { status: "consumed", approval_id: id };
    }
    const check = validateTaskPausedSidecar(record);
    if (!check.ok) throw new Error(`invalid task paused sidecar: ${check.error}`);
    if (record.approval_id !== id) throw new Error("approval_id must match sidecar path");
    return record;
  }

  async function deleteSidecar(approvalId) {
    try {
      await faults.maybe("before-task-sidecar-delete");
      await unlink(sidecarPath(approvalId));
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }

  async function consume(approvalId) {
    const id = safeRecoverySegment(approvalId);
    const filePath = sidecarPath(id);
    const consumed = {
      schema_version: TASK_DELEGATION_SCHEMA_VERSION,
      approval_id: id,
      status: "consumed",
      state: "consumed",
      consumed_at: new Date().toISOString(),
      reason: "consumed"
    };
    try {
      await atomicWriteJson(filePath, consumed);
    } catch (writeError) {
      const deleted = await deleteSidecar(id).catch(() => false);
      return {
        status: deleted ? "deleted" : "missing",
        approval_id: id,
        path: filePath,
        reason: sanitizeReason(writeError?.message)
      };
    }
    try {
      const deleted = await deleteSidecar(id);
      return { status: deleted ? "deleted" : "missing", approval_id: id, path: filePath };
    } catch (error) {
      const reason = sanitizeReason(error?.message);
      await atomicWriteJson(filePath, { ...consumed, reason }).catch(() => {});
      return { status: "consumed", approval_id: id, path: filePath, reason };
    }
  }

  async function quarantine(approvalId, reason = "quarantined") {
    const id = safeRecoverySegment(approvalId);
    const source = sidecarPath(id);
    const target = path.join(quarantineDir, `${id}.json`);
    try {
      await mkdir(quarantineDir, { recursive: true });
      await rename(source, target);
      return { status: "quarantined", approval_id: id, path: target, reason: sanitizeReason(reason) };
    } catch (error) {
      if (error?.code === "ENOENT") {
        return { status: "missing", approval_id: id, path: source, reason: "sidecar not found" };
      }
      throw error;
    }
  }

  async function scan() {
    let entries;
    try {
      entries = await readdir(baseDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const scanned = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const approvalId = entry.name.slice(0, -".json".length);
      const filePath = path.join(baseDir, entry.name);
      try {
        safeRecoverySegment(approvalId);
        const record = await atomicReadJson(filePath);
        if (record?.status === "consumed" || record?.state === "consumed") {
          scanned.push({ status: "consumed", approval_id: approvalId, path: filePath });
          continue;
        }
        const check = validateTaskPausedSidecar(record);
        if (!check.ok) {
          scanned.push({ status: "corrupt", approval_id: approvalId, path: filePath, reason: check.error });
          continue;
        }
        if (record.approval_id !== approvalId) {
          scanned.push({ status: "corrupt", approval_id: approvalId, path: filePath, reason: "approval_id mismatch" });
          continue;
        }
        scanned.push(record);
      } catch (error) {
        scanned.push({
          status: "corrupt",
          approval_id: approvalId,
          path: filePath,
          reason: sanitizeReason(error?.message || "invalid task paused sidecar")
        });
      }
    }
    return scanned.sort((a, b) => String(a.approval_id).localeCompare(String(b.approval_id)));
  }

  async function writeRawForTest(approvalId, raw) {
    const filePath = sidecarPath(approvalId);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, raw);
  }

  return {
    baseDir,
    save,
    updateState,
    load,
    delete: deleteSidecar,
    consume,
    quarantine,
    scan,
    writeRawForTest
  };
}

function sanitizeReason(reason) {
  const text = String(reason || "invalid task paused sidecar");
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}
