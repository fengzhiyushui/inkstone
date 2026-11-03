import { promises as fs } from "node:fs";
import path from "node:path";
import { describeChange } from "./change-store.js";
import {
  applyRollbackRecord,
  detectRollbackConflicts
} from "./edit-transaction.js";

// ── 回滚：CLI/TUI 直调的 rollbackChange + 内核侧 createRollbackService ──
// v1.19.0 由顶层 src/changes.js 的 rollbackChange 内聚至此。两条回滚路径
// （旧 rollbackChange 与 edit-transaction 的 applyRollbackRecord）曾经各自
// 复制了一份「截断守卫」，现已收敛为 edit-transaction.js 的单一实现。

export async function rollbackChange(root, id) {
  const record = await describeChange(root, id || "latest");
  // 截断守卫与逐字节复原都由 applyRollbackRecord 承担（单一实现）。
  const restoredFiles = await applyRollbackRecord(root, record);

  const rollbackPath = path.join(root, ".deepseek-code", "rollbacks.jsonl");
  await fs.mkdir(path.dirname(rollbackPath), { recursive: true });
  await fs.appendFile(rollbackPath, `${JSON.stringify({ time: new Date().toISOString(), id: record.id })}\n`, "utf8");
  return record;
}

export function createRollbackService({ projectRoot } = {}) {
  if (!projectRoot) throw new Error("projectRoot is required");

  return {
    async rollback({ change_id = "latest", force = false } = {}) {
      const record = await describeChange(projectRoot, change_id || "latest");
      const conflicts = await detectRollbackConflicts(projectRoot, record);
      if (conflicts.length && !force) {
        return {
          status: "conflict",
          record,
          conflicts,
          restored_files: [],
          forced: false
        };
      }
      const restoredFiles = await applyRollbackRecord(projectRoot, record);
      const rollbackPath = path.join(projectRoot, ".deepseek-code", "rollbacks.jsonl");
      await fs.mkdir(path.dirname(rollbackPath), { recursive: true });
      await fs.appendFile(rollbackPath, `${JSON.stringify({
        time: new Date().toISOString(),
        id: record.id,
        forced: Boolean(force),
        conflicts
      })}\n`, "utf8");
      return {
        status: "success",
        record,
        conflicts,
        restored_files: restoredFiles,
        forced: Boolean(force)
      };
    }
  };
}
