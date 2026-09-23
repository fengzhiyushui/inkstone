import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveWorkspacePath } from "../workspace/path-safety.js";
import { applyUnifiedDiff } from "../patch.js";

export function hashContent(content) {
  const value = String(content ?? "");
  return {
    hash: `sha256:${createHash("sha256").update(value).digest("hex")}`,
    bytes: Buffer.byteLength(value, "utf8")
  };
}

export async function snapshotTouchedFiles(projectRoot, patches = []) {
  if (!projectRoot) throw new Error("projectRoot is required");
  const snapshots = [];
  for (const patch of patches) {
    const filePath = patch.newPath === "/dev/null" ? patch.oldPath : patch.newPath;
    const status = patch.oldPath === "/dev/null"
      ? "create"
      : patch.newPath === "/dev/null"
        ? "delete"
        : "modify";
    const existedBefore = patch.oldPath !== "/dev/null";
    let before = null;
    let beforeHash = null;
    let beforeBytes = 0;
    let beforeMtimeMs = null;

    let createdDirsBefore = [];
    if (existedBefore) {
      const resolved = await resolveWorkspacePath(projectRoot, patch.oldPath, { mustExist: true });
      const stat = await fs.stat(resolved.real);
      before = stripBom(await fs.readFile(resolved.real, "utf8"));
      const hashed = hashContent(before);
      beforeHash = hashed.hash;
      beforeBytes = hashed.bytes;
      beforeMtimeMs = stat.mtimeMs;
    } else {
      const resolved = await resolveWorkspacePath(projectRoot, filePath, { mustExist: false });
      if (await fileExists(resolved.absolute)) {
        throw new Error(`create patch target already exists: ${filePath}`);
      }
      let dir = path.dirname(resolved.absolute);
      const rootAbs = path.resolve(projectRoot);
      while (dir !== rootAbs && dir.startsWith(rootAbs)) {
        if (!(await fileExists(dir))) {
          createdDirsBefore.push(dir);
        } else {
          break;
        }
        dir = path.dirname(dir);
      }
    }

    snapshots.push({
      path: filePath,
      oldPath: patch.oldPath,
      newPath: patch.newPath,
      status,
      existed_before: existedBefore,
      created_dirs: createdDirsBefore,
      before,
      before_hash: beforeHash,
      before_bytes: beforeBytes,
      before_mtime_ms: beforeMtimeMs
    });
  }
  return snapshots;
}

export async function restoreSnapshots(projectRoot, snapshots = []) {
  const restored = [];
  const createdDirs = new Set();
  for (const snapshot of snapshots) {
    const targetPath = snapshot.newPath === "/dev/null" ? snapshot.oldPath : snapshot.newPath;
    const resolved = await resolveWorkspacePath(projectRoot, targetPath, { mustExist: false });
    if (!snapshot.existed_before) {
      await fs.rm(resolved.absolute, { force: true });
      for (const d of snapshot.created_dirs || []) {
        createdDirs.add(d);
      }
    } else {
      await fs.mkdir(path.dirname(resolved.absolute), { recursive: true });
      await fs.writeFile(resolved.absolute, snapshot.before ?? "", "utf8");
    }
    restored.push(snapshot.path);
  }
  // Clean up empty parent dirs from inside out
  const sortedDirs = [...createdDirs].sort((a, b) => b.length - a.length);
  for (const dir of sortedDirs) {
    try {
      await fs.rmdir(dir);
    } catch {
      // Directory not empty — skip
    }
  }
  return restored;
}

function stripBom(value) {
  return value.charCodeAt(0) === 0xFEFF ? value.slice(1) : value;
}

export async function applyDiffTransaction({
  projectRoot,
  parsed,
  transaction_id = makeTransactionId(),
  applyDiff = applyUnifiedDiff
} = {}) {
  if (!projectRoot) throw new Error("projectRoot is required");
  if (!parsed?.diff || !Array.isArray(parsed.patches)) throw new Error("parsed diff is required");
  const snapshots = await snapshotTouchedFiles(projectRoot, parsed.patches);
  try {
    const applied = await applyDiff(parsed.diff, projectRoot);
    return {
      transaction_id,
      snapshots,
      applied,
      restored_on_failure: false
    };
  } catch (error) {
    const restoredFiles = await restoreSnapshots(projectRoot, snapshots);
    error.transaction_id = transaction_id;
    error.restored = true;
    error.restored_files = restoredFiles;
    error.failed_files = parsed.files || snapshots.map((item) => item.path);
    throw error;
  }
}

export function enhanceChangeRecord(record, { transaction_id = null } = {}) {
  const files = (record.files || []).map((file) => {
    const beforeMeta = file.before == null ? { hash: null, bytes: 0 } : hashContent(file.before);
    const afterMeta = file.after == null ? { hash: null, bytes: 0 } : hashContent(file.after);
    return {
      ...file,
      before_hash: file.before_hash ?? beforeMeta.hash,
      after_hash: file.after_hash ?? afterMeta.hash,
      before_bytes: file.before_bytes ?? beforeMeta.bytes,
      after_bytes: file.after_bytes ?? afterMeta.bytes,
      transaction_id: file.transaction_id || transaction_id
    };
  });
  return {
    ...record,
    transaction_id: record.transaction_id || transaction_id,
    files
  };
}

export async function detectRollbackConflicts(projectRoot, record) {
  const conflicts = [];
  for (const file of record.files || []) {
    const current = await readCurrentFile(projectRoot, file);
    const expectedAfterHash = file.after_hash ?? (file.after == null ? null : hashContent(file.after).hash);
    if (current.hash !== expectedAfterHash) {
      conflicts.push({
        path: file.path,
        status: file.status,
        expected_after_hash: expectedAfterHash,
        current_hash: current.hash,
        reason: "dirty"
      });
    }
  }
  return conflicts;
}

export async function applyRollbackRecord(projectRoot, record) {
  // 截断守卫(与 changes.js 的 rollbackChange 同语义):任何文件缺 before 全文
  // 就无法安全回滚,绝不写 `before ?? ""` 把用户文件清空。
  const truncated = (record.files || []).find((file) => {
    if (file.status === "create") return false;
    return file.before_truncated || (file.truncated && (file.before == null || (file.before_bytes && file.before_bytes > (file.before?.length || 0))));
  });
  if (truncated) {
    const error = new Error(
      `change ${record.id} 的 ${truncated.path} 超过记录大小上限,未保存回滚所需的完整内容,无法安全回滚。`
    );
    error.code = "ROLLBACK_TRUNCATED";
    throw error;
  }
  const restored = [];
  for (const file of record.files || []) {
    const filePath = file.newPath === "/dev/null" ? file.oldPath : file.newPath;
    const resolved = await resolveWorkspacePath(projectRoot, filePath, { mustExist: false });
    if (file.status === "create") {
      await fs.rm(resolved.absolute, { force: true });
    } else {
      await fs.mkdir(path.dirname(resolved.absolute), { recursive: true });
      await fs.writeFile(resolved.absolute, file.before ?? "", "utf8");
    }
    restored.push(file.path);
  }
  return restored;
}

async function readCurrentFile(projectRoot, file) {
  const filePath = file.newPath === "/dev/null" ? file.oldPath : file.newPath;
  try {
    const resolved = await resolveWorkspacePath(projectRoot, filePath, { mustExist: true });
    const stat = await fs.stat(resolved.real);
    if (!stat.isFile()) {
      return { hash: null, bytes: 0 };
    }
    const content = stripBom(await fs.readFile(resolved.real, "utf8"));
    return hashContent(content);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR" || error.code === "ENOTDIR") {
      return { hash: null, bytes: 0 };
    }
    throw error;
  }
}

export function safeTransactionError(error) {
  const message = String(error?.message || "");
  if (message.includes("patch") || message.includes("context") || message.includes("hunk") || message.includes("mismatch")) {
    return "patch_failed";
  }
  if (message.includes("ENOENT") || message.includes("write") || message.includes("finalize")) {
    return "transaction_finalize_failed";
  }
  if (error?.restored) return "transaction_failed_restored";
  return "transaction_failed";
}

export function makeTransactionId() {
  return `tx_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`;
}

export function pathsFromParsedDiff(parsed) {
  if (!parsed?.patches) return [];
  return parsed.patches.map((patch) => {
    const filePath = patch.newPath === "/dev/null" ? patch.oldPath : patch.newPath;
    return filePath;
  });
}

async function fileExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
