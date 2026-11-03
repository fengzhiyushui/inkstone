// Shared persistence mechanics for the durable recovery sidecar stores.
//
// Three stores persist one JSON file per approval id under
// `<root>/.deepseek-code/v2/sessions/<projectSegment>/<dirName>`:
//   paused-turn-persistence   -> "paused"               (snake_case fields)
//   orchestration-persistence -> "orchestration-paused" (camelCase fields)
//   task-paused-persistence   -> "task-paused"          (snake_case fields)
//
// They differ only in directory name, field naming and validation policy, so
// those are the only things a caller declares here. Directory creation, atomic
// writes, tombstone consume, quarantine, corrupt-entry isolation, scan
// ordering and reason sanitizing live in this module once.
//
// On-disk JSON and every thrown message stay caller-owned: the hooks below
// receive and return exactly the payloads the per-store implementations used,
// so the bytes on disk are unchanged.

import { mkdir, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { atomicReadJson, atomicWriteJson, safeRecoverySegment } from "./atomic-file.js";
import { createRecoveryFaults } from "./recovery-faults.js";

const SIDECAR_SUFFIX = ".json";
const REASON_MAX_LENGTH = 200;
const REASON_TRUNCATE_AT = 197;

export function createSidecarStore({
  root,
  projectId,
  dirName,
  idField = "approval_id",
  schemaVersion,
  schemaVersionField = "schema_version",
  faults = createRecoveryFaults(),
  invalidReason = "invalid sidecar",
  afterWriteLabel = null,
  beforeDeleteLabel = null,
  tombstoneFields = {},
  tombstoneWriteFailureReason = null,
  cleanupFailureReason = null,
  tombstoneDeleteFailure = "ignore",
  compareScan = null,
  updateState: updateStateHooks = null,
  prepareSave,
  prepareLoad,
  classifyScan
}) {
  if (!root) throw new Error("root is required");

  const projectSegment = safeRecoverySegment(projectId);
  const baseDir = path.join(root, ".deepseek-code", "v2", "sessions", projectSegment, dirName);
  const quarantineDir = path.join(baseDir, "quarantine");

  const sidecarPath = (approvalId) => path.join(baseDir, `${safeRecoverySegment(approvalId)}${SIDECAR_SUFFIX}`);
  // Scans are ordered by the id field unless a store declares otherwise.
  const orderScanned = compareScan
    || ((left, right) => String(left[idField]).localeCompare(String(right[idField])));

  function sanitizeReason(reason) {
    const text = String(reason || invalidReason);
    return text.length > REASON_MAX_LENGTH ? `${text.slice(0, REASON_TRUNCATE_AT)}...` : text;
  }

  function buildTombstone(id) {
    return {
      [schemaVersionField]: schemaVersion,
      [idField]: id,
      status: "consumed",
      ...tombstoneFields,
      consumed_at: new Date().toISOString(),
      reason: "consumed"
    };
  }

  // save() keeps each store's own argument shape (a bare record for paused
  // turns, an (approvalId, state) pair for the other two); prepareSave turns
  // whatever it received into the { id, payload } pair to persist.
  async function save(...args) {
    const { id, payload } = prepareSave(...args);
    await atomicWriteJson(sidecarPath(id), payload);
    if (afterWriteLabel) await faults.maybe(afterWriteLabel);
    return payload;
  }

  async function load(approvalId) {
    const id = safeRecoverySegment(approvalId);
    const filePath = sidecarPath(id);
    const record = await atomicReadJson(filePath);
    return prepareLoad(record, { id, path: filePath });
  }

  async function deleteSidecar(approvalId) {
    try {
      if (beforeDeleteLabel) await faults.maybe(beforeDeleteLabel);
      await unlink(sidecarPath(approvalId));
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }

  // A tombstone that could not be written must not leave the pre-tombstone
  // sidecar behind either; paused turns surface the original write error when
  // that cleanup itself fails, the other two stores report "missing".
  async function removeAfterTombstoneFailure(id, writeError) {
    try {
      return await deleteSidecar(id);
    } catch {
      throw writeError;
    }
  }

  async function consume(approvalId) {
    const id = safeRecoverySegment(approvalId);
    const filePath = sidecarPath(id);
    const tombstone = buildTombstone(id);
    try {
      await atomicWriteJson(filePath, tombstone);
    } catch (writeError) {
      const deleted = tombstoneDeleteFailure === "rethrow-write-error"
        ? await removeAfterTombstoneFailure(id, writeError)
        : await deleteSidecar(id).catch(() => false);
      return {
        status: deleted ? "deleted" : "missing",
        [idField]: id,
        path: filePath,
        reason: sanitizeReason(writeError?.message || tombstoneWriteFailureReason)
      };
    }
    try {
      const deleted = await deleteSidecar(id);
      return { status: deleted ? "deleted" : "missing", [idField]: id, path: filePath };
    } catch (error) {
      const reason = sanitizeReason(error?.message || cleanupFailureReason);
      await atomicWriteJson(filePath, { ...tombstone, reason }).catch(() => {});
      return { status: "consumed", [idField]: id, path: filePath, reason };
    }
  }

  async function quarantine(approvalId, reason = "quarantined") {
    const id = safeRecoverySegment(approvalId);
    const source = sidecarPath(id);
    const target = path.join(quarantineDir, `${id}${SIDECAR_SUFFIX}`);
    try {
      await mkdir(quarantineDir, { recursive: true });
      await rename(source, target);
      return { status: "quarantined", [idField]: id, path: target, reason: sanitizeReason(reason) };
    } catch (error) {
      if (error?.code === "ENOENT") {
        return { status: "missing", [idField]: id, path: source, reason: "sidecar not found" };
      }
      throw error;
    }
  }

  // classifyScan decides consumed / valid / corrupt per record. It reports
  // corruption as { kind: "corrupt", reason } so a caller can pass its own
  // contract error text through verbatim; anything it throws is sanitized.
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
      if (!entry.isFile() || !entry.name.endsWith(SIDECAR_SUFFIX)) {
        continue;
      }

      const approvalId = entry.name.slice(0, -SIDECAR_SUFFIX.length);
      const filePath = path.join(baseDir, entry.name);
      try {
        safeRecoverySegment(approvalId);
        const record = await atomicReadJson(filePath);
        const outcome = classifyScan(record, { approvalId, path: filePath });
        scanned.push(outcome.kind === "corrupt"
          ? { status: "corrupt", [idField]: approvalId, path: filePath, reason: outcome.reason }
          : outcome.entry);
      } catch (error) {
        scanned.push({
          status: "corrupt",
          [idField]: approvalId,
          path: filePath,
          reason: sanitizeReason(error?.message || invalidReason)
        });
      }
    }

    return scanned.sort(orderScanned);
  }

  async function writeRawForTest(approvalId, raw) {
    const filePath = sidecarPath(approvalId);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, raw);
  }

  // Opt-in read-modify-write update (task delegation's updateState). The store
  // owns the merge/validate/write/fault sequence; the caller only declares the
  // timestamp field, the re-validation, the error prefix and which patched
  // states inject a fault.
  async function updateState(approvalId, patch = {}) {
    const id = safeRecoverySegment(approvalId);
    const existing = await load(id);
    if (!existing || existing.status === "consumed") return existing;
    const next = {
      ...existing,
      ...patch,
      [updateStateHooks.timestampField]: new Date().toISOString()
    };
    const check = updateStateHooks.validateUpdate(next);
    if (!check.ok) throw new Error(`${updateStateHooks.invalidPrefix}: ${check.error}`);
    await atomicWriteJson(sidecarPath(id), next);
    for (const [patchedState, label] of Object.entries(updateStateHooks.faultLabels)) {
      if (patch.state === patchedState) await faults.maybe(label);
    }
    return next;
  }

  // The public shape is spelled out per store: no internal helper leaks into a
  // caller's store object, and updateState keeps its historical position.
  return updateStateHooks
    ? {
        baseDir,
        save,
        updateState,
        load,
        delete: deleteSidecar,
        consume,
        quarantine,
        scan,
        writeRawForTest
      }
    : {
        baseDir,
        save,
        load,
        delete: deleteSidecar,
        consume,
        quarantine,
        scan,
        writeRawForTest
      };
}
