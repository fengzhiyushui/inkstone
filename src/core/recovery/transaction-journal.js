import { readFile, stat, lstat, mkdir, rm, readdir, symlink as createSymlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { atomicWriteJson, atomicReadJson, atomicWriteBytes, safeRecoverySegment } from "./atomic-file.js";
import { recoveryError } from "./recovery-errors.js";
import { createRecoveryFaults } from "./recovery-faults.js";

export function createTransactionJournal({ root, projectId, faults = createRecoveryFaults() }) {
  const journalRoot = path.join(root, ".deepseek-code", "v2", "journal");
  const recoveredRoot = path.join(root, ".deepseek-code", "v2", "recovered");

  async function open({ kind, tx_id, session_id, turn_id, owner_epoch, paths, rewind_branch_state = null, target = {} }) {
    safeRecoverySegment(tx_id);
    const txDir = path.join(journalRoot, tx_id);
    const blobsDir = path.join(txDir, "blobs");

    await mkdir(blobsDir, { recursive: true });

    const capturedPaths = [];
    const seenKeys = new Set();

    for (const rawPath of paths) {
      const normalized = normalizePath(rawPath);
      const pathKey = process.platform === "win32" ? normalized.toLowerCase() : normalized;

      if (seenKeys.has(pathKey)) {
        throw recoveryError("RECOVERY_DUPLICATE_PATH", `duplicate path: ${rawPath}`);
      }
      seenKeys.add(pathKey);

      const absolutePath = path.join(root, normalized);
      await assertPathSafety(root, absolutePath, normalized);

      const entry = await capturePreimage(absolutePath, normalized, blobsDir);
      capturedPaths.push(entry);
    }

    const manifest = {
      schema_version: 1,
      tx_id,
      state: "open",
      kind,
      session_id,
      turn_id,
      owner_epoch,
      opened_at: new Date().toISOString(),
      phase: "started",
      target,
      paths: capturedPaths,
      rewind_branch_state,
      final_state: null,
      commit_id: null
    };

    await atomicWriteJson(path.join(txDir, "manifest.json"), manifest);
    await faults.maybe("after-journal-write");

    return manifest;
  }

  async function commit(txId, final_state = {}) {
    safeRecoverySegment(txId);
    const manifestPath = path.join(journalRoot, txId, "manifest.json");
    const manifest = await atomicReadJson(manifestPath);

    if (manifest.state !== "open") {
      throw recoveryError("RECOVERY_INVALID_STATE", `cannot commit journal in state: ${manifest.state}`);
    }

    manifest.state = "committed";
    manifest.commit_id = `commit_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    manifest.final_state = final_state;
    manifest.committed_at = new Date().toISOString();

    await atomicWriteJson(manifestPath, manifest);
    await faults.maybe("after-manifest-committed");
  }

  async function abort(txId) {
    safeRecoverySegment(txId);
    const manifestPath = path.join(journalRoot, txId, "manifest.json");
    let manifest;

    try {
      manifest = await atomicReadJson(manifestPath);
    } catch (error) {
      if (error.code === "ENOENT") {
        return { status: "not_found", tx_id: txId };
      }
      throw recoveryError("RECOVERY_BLOCKED", `corrupt journal manifest: ${txId}`, { tx_id: txId });
    }

    if (manifest.state === "committed") {
      throw recoveryError("RECOVERY_INVALID_STATE", `cannot abort committed journal: ${txId}`);
    }

    manifest.state = "aborting";
    await atomicWriteJson(manifestPath, manifest);

    let preservedCount = 0;

    for (const entry of manifest.paths) {
      const absolutePath = path.join(root, entry.path);

      if (entry.kind === "missing") {
        const currentState = await getCurrentState(absolutePath);
        if (shouldPreserveCurrent(entry, currentState)) {
          await preserveCurrent(txId, entry, currentState, "external_modified");
          preservedCount++;
        }
        try {
          await rm(absolutePath, { force: true, recursive: false });
        } catch {
          // File was already missing or could not be removed
        }
        continue;
      }

      const currentState = await getCurrentState(absolutePath);

      if (shouldPreserveCurrent(entry, currentState)) {
        await preserveCurrent(txId, entry, currentState, "external_modified");
        preservedCount++;
      }

      await restorePreimage(entry, absolutePath, path.join(journalRoot, txId));
    }

    if (manifest.rewind_branch_state) {
      await restoreBranchState(manifest.rewind_branch_state);
    }

    await rm(path.join(journalRoot, txId), { recursive: true, force: true });

    return { status: "rolled_back", tx_id: txId, preserved_count: preservedCount };
  }

  async function scan() {
    try {
      const entries = await readdir(journalRoot);
      const journals = [];

      for (const entry of entries) {
        if (entry.startsWith(".")) continue;

        try {
          const manifest = await atomicReadJson(path.join(journalRoot, entry, "manifest.json"));
          journals.push(manifest);
        } catch (error) {
          journals.push({
            tx_id: entry,
            state: "corrupt",
            error: error.message
          });
        }
      }

      return journals;
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  async function readManifest(txId) {
    safeRecoverySegment(txId);
    return atomicReadJson(path.join(journalRoot, txId, "manifest.json"));
  }

  async function preserveCurrent(txId, entry, currentState, reason) {
    const recoveredDir = path.join(recoveredRoot, txId);
    const recoveredBlobsDir = path.join(recoveredDir, "blobs");
    await mkdir(recoveredBlobsDir, { recursive: true });

    const recoveredEntry = {
      path: entry.path,
      path_key: entry.path_key,
      reason,
      kind: currentState.kind,
      blob: null,
      hash: currentState.hash,
      symlink_target: currentState.symlink_target
    };

    if (currentState.bytes) {
      const blobName = `blob_${currentState.hash.replace("sha256:", "")}`;
      await atomicWriteBytes(path.join(recoveredBlobsDir, blobName), currentState.bytes);
      recoveredEntry.blob = `blobs/${blobName}`;
    }

    const recoveredManifestPath = path.join(recoveredDir, "manifest.json");
    let recoveredManifest;

    try {
      recoveredManifest = await atomicReadJson(recoveredManifestPath);
    } catch {
      recoveredManifest = {
        schema_version: 1,
        tx_id: txId,
        created_at: new Date().toISOString(),
        entries: []
      };
    }

    recoveredManifest.entries.push(recoveredEntry);
    await atomicWriteJson(recoveredManifestPath, recoveredManifest);
  }

  return { open, commit, abort, scan, readManifest, preserveCurrent };
}

function normalizePath(rawPath) {
  const normalized = path.normalize(rawPath).replace(/^[a-zA-Z]:/, "").replace(/\\/g, "/");
  if (path.isAbsolute(normalized)) {
    throw recoveryError("RECOVERY_ABSOLUTE_PATH", `absolute path not allowed: ${rawPath}`);
  }
  const segments = normalized.split("/");
  if (segments.includes("..")) {
    throw recoveryError("RECOVERY_TRAVERSAL", `path traversal not allowed: ${rawPath}`);
  }
  return normalized;
}

async function assertPathSafety(root, absolutePath, normalized) {
  const realRoot = await realpathSafe(root);

  // Check parent directories for symlink escape
  let checkPath = absolutePath;
  while (checkPath !== root && checkPath !== path.dirname(checkPath)) {
    let realPath;
    try {
      realPath = await realpathSafe(checkPath);
    } catch (error) {
      if (error.code === "ENOENT") {
        checkPath = path.dirname(checkPath);
        continue;
      }
      throw error;
    }

    if (!realPath.startsWith(realRoot + path.sep) && realPath !== realRoot) {
      throw recoveryError("RECOVERY_ESCAPE", `path escapes workspace via symlink: ${normalized}`);
    }

    checkPath = path.dirname(checkPath);
  }
}

async function realpathSafe(p) {
  try {
    const { realpath } = await import("node:fs/promises");
    return await realpath(p);
  } catch (error) {
    if (error.code === "ENOENT") return p;
    throw error;
  }
}

async function capturePreimage(absolutePath, normalized, blobsDir) {
  let stats;

  try {
    stats = await lstat(absolutePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        path: normalized,
        path_key: process.platform === "win32" ? normalized.toLowerCase() : normalized,
        kind: "missing",
        pre_hash: null,
        pre_size: 0,
        pre_mtime_ms: null,
        mode: null,
        symlink_target: null,
        blob: null
      };
    }
    throw error;
  }

  if (stats.isSymbolicLink()) {
    const { readlink } = await import("node:fs/promises");
    const target = await readlink(absolutePath);
    let symlinkType = null;
    try {
      const resolvedTarget = path.resolve(path.dirname(absolutePath), target);
      const targetStats = await stat(resolvedTarget);
      if (targetStats.isDirectory()) {
        symlinkType = process.platform === "win32" ? "junction" : "dir";
      } else {
        symlinkType = "file";
      }
    } catch {
      // target may not exist or not be readable
    }
    return {
      path: normalized,
      path_key: process.platform === "win32" ? normalized.toLowerCase() : normalized,
      kind: "symlink",
      symlink_type: symlinkType,
      pre_hash: null,
      pre_size: 0,
      pre_mtime_ms: stats.mtimeMs,
      mode: stats.mode,
      symlink_target: target,
      blob: null
    };
  }

  if (stats.isDirectory()) {
    return {
      path: normalized,
      path_key: process.platform === "win32" ? normalized.toLowerCase() : normalized,
      kind: "directory",
      pre_hash: null,
      pre_size: 0,
      pre_mtime_ms: stats.mtimeMs,
      mode: stats.mode,
      symlink_target: null,
      blob: null
    };
  }

  const bytes = await readFile(absolutePath);
  const hash = "sha256:" + createHash("sha256").update(bytes).digest("hex");
  const blobName = `blob_${hash.replace("sha256:", "")}`;

  await atomicWriteBytes(path.join(blobsDir, blobName), bytes);

  return {
    path: normalized,
    path_key: process.platform === "win32" ? normalized.toLowerCase() : normalized,
    kind: "file",
    pre_hash: hash,
    pre_size: bytes.length,
    pre_mtime_ms: stats.mtimeMs,
    mode: stats.mode,
    symlink_target: null,
    blob: `blobs/${blobName}`
  };
}

async function getCurrentState(absolutePath) {
  try {
    const stats = await lstat(absolutePath);

    if (stats.isSymbolicLink()) {
      const { readlink } = await import("node:fs/promises");
      const target = await readlink(absolutePath);
      return { kind: "symlink", symlink_target: target, hash: null, bytes: null };
    }

    if (stats.isDirectory()) {
      return { kind: "directory", hash: null, bytes: null, symlink_target: null };
    }

    const bytes = await readFile(absolutePath);
    const hash = "sha256:" + createHash("sha256").update(bytes).digest("hex");
    return { kind: "file", hash, bytes, symlink_target: null };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { kind: "missing", hash: null, bytes: null, symlink_target: null };
    }
    throw error;
  }
}

function shouldPreserveCurrent(entry, currentState) {
  if (entry.kind === "missing" && currentState.kind === "missing") return false;
  if (entry.kind === "missing" && currentState.kind !== "missing") return true;

  if (entry.kind === "file" && currentState.kind === "file") {
    return entry.pre_hash !== currentState.hash;
  }

  if (entry.kind !== currentState.kind) return true;

  return false;
}

async function restorePreimage(entry, absolutePath, txDir) {
  if (entry.kind === "missing") {
    try {
      await rm(absolutePath, { force: true, recursive: false });
    } catch {
      // Best effort
    }
    return;
  }

  if (entry.kind === "directory") {
    // Only remove if empty and created by transaction
    try {
      const entries = await readdir(absolutePath);
      if (entries.length === 0) {
        await rm(absolutePath, { force: true, recursive: false });
      }
    } catch {
      // Keep directory if it has content or cannot be read
    }
    return;
  }

  if (entry.kind === "symlink") {
    try {
      await rm(absolutePath, { force: true, recursive: false });
      const linkType = entry.symlink_type || (process.platform === "win32" ? "junction" : "file");
      try {
        await createSymlink(entry.symlink_target, absolutePath, linkType);
      } catch (linkError) {
        if (process.platform === "win32" && linkType !== "junction") {
          await createSymlink(entry.symlink_target, absolutePath, "junction");
        } else {
          throw linkError;
        }
      }
    } catch (error) {
      throw recoveryError("RECOVERY_BLOCKED", `cannot restore symlink: ${entry.path}`, { error: error.message });
    }
    return;
  }

  if (entry.kind === "file") {
    const blobPath = path.join(txDir, entry.blob);
    const bytes = await readFile(blobPath);
    await atomicWriteBytes(absolutePath, bytes);
  }
}

async function restoreBranchState(branchState) {
  if (!branchState || !branchState.branch_store_path || !branchState.state_before) return;

  await atomicWriteJson(branchState.branch_store_path, branchState.state_before);
}
