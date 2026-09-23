import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { resolveInsideRoot } from "./context.js";
import { parseUnifiedDiff, summarizeDiff } from "./patch.js";
import { redactSecrets } from "./security/redactor.js";

// #9.3 大小上限默认 1 MiB:超过只存 sha256 + 摘要,不存全文(回滚需全文 → 截断记录
// 在 rollbackChange 抛 ROLLBACK_TRUNCATED,绝不静默写空)。传 maxCaptureBytes=null 关闭。
const DEFAULT_MAX_CAPTURE_BYTES = 1024 * 1024;

export async function captureChangePlan(root, diff, prompt, { maxCaptureBytes = DEFAULT_MAX_CAPTURE_BYTES } = {}) {
  const patches = parseUnifiedDiff(diff);
  const files = [];

  for (const patch of patches) {
    const filePath = patch.newPath === "/dev/null" ? patch.oldPath : patch.newPath;
    const beforePath = patch.oldPath === "/dev/null" ? null : patch.oldPath;
    let before = null;
    if (beforePath) {
      before = stripBom(await fs.readFile(resolveInsideRoot(root, beforePath), "utf8"));
    }
    const captured = captureText(before, maxCaptureBytes);
    files.push({
      path: filePath,
      oldPath: patch.oldPath,
      newPath: patch.newPath,
      status: patch.oldPath === "/dev/null" ? "create" : patch.newPath === "/dev/null" ? "delete" : "modify",
      before: captured.value,
      ...(captured.sha256 ? { before_sha256: captured.sha256 } : {}),
      ...(captured.size != null ? { before_size: captured.size } : {}),
      ...(captured.truncated ? { truncated: true } : {})
    });
  }

  return {
    id: makeChangeId(),
    time: new Date().toISOString(),
    prompt,
    diff,
    summary: summarizeDiff(diff),
    files
  };
}

export async function finalizeChange(root, plan, { maxCaptureBytes = DEFAULT_MAX_CAPTURE_BYTES, changeRetention = null } = {}) {
  const files = [];
  for (const item of plan.files) {
    const currentPath = item.newPath === "/dev/null" ? item.oldPath : item.newPath;
    let after = null;
    if (item.newPath !== "/dev/null") {
      after = stripBom(await fs.readFile(resolveInsideRoot(root, currentPath), "utf8"));
    }
    const captured = captureText(after, maxCaptureBytes);
    files.push({
      ...item,
      after: captured.value,
      ...(captured.sha256 ? { after_sha256: captured.sha256 } : {}),
      ...(captured.size != null ? { after_size: captured.size } : {}),
      // 只要任一侧被截断,记录即视为 truncated(回滚守卫依赖它)
      ...(item.truncated || captured.truncated ? { truncated: true } : {})
    });
  }

  const record = { ...plan, files };
  const target = changePath(root, record.id);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.writeFile(target, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  if (changeRetention) await pruneChangeRecords(root, changeRetention);
  return record;
}

export async function listChanges(root, limit = 20) {
  const dir = changesDir(root);
  try {
    const entries = await fs.readdir(dir);
    const records = [];
    for (const entry of entries.filter((name) => name.endsWith(".json"))) {
      const target = path.join(dir, entry);
      const record = JSON.parse(await fs.readFile(target, "utf8"));
      records.push(record);
    }
    return records
      .sort((a, b) => b.time.localeCompare(a.time))
      .slice(0, limit);
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function describeChange(root, id) {
  return readChange(root, id || "latest");
}

export async function rollbackChange(root, id) {
  const record = await readChange(root, id || "latest");
  // 截断守卫:任何文件缺 before 全文就无法安全回滚,先全部校验再动手,
  // 绝不写 `before ?? ""` 把用户文件清空。
  const truncated = record.files?.find((file) => {
    if (file.status === "create") return false;
    return file.before_truncated || (file.truncated && (file.before == null || (file.before_size && file.before_size > (file.before?.length || 0))));
  });
  if (truncated) {
    const error = new Error(
      `change ${record.id} 的 ${truncated.path} 超过记录大小上限,未保存回滚所需的完整内容,无法安全回滚。`
    );
    error.code = "ROLLBACK_TRUNCATED";
    throw error;
  }
  for (const file of record.files) {
    const filePath = file.newPath === "/dev/null" ? file.oldPath : file.newPath;
    const target = resolveInsideRoot(root, filePath);
    if (file.status === "create") {
      await fs.rm(target, { force: true });
    } else {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, file.before ?? "", "utf8");
    }
  }

  const rollbackPath = path.join(root, ".deepseek-code", "rollbacks.jsonl");
  await fs.mkdir(path.dirname(rollbackPath), { recursive: true });
  await fs.appendFile(rollbackPath, `${JSON.stringify({ time: new Date().toISOString(), id: record.id })}\n`, "utf8");
  return record;
}

// #9.3 展示层脱敏:这是**显示**函数(CLI `changes` / TUI 卡片都用它),不是存储。
// 落盘记录必须保持原文 —— 回滚靠逐字节复原;但打到屏幕上的内容会被截图、
// 贴进 issue,是密钥唯一能离开本机的路径,故在此处过 redactor。
export function formatChange(record) {
  const lines = [
    `变更 ID：${record.id}`,
    `时间：${record.time}`,
    `需求：${redactSecrets(record.prompt ?? "")}`,
    "",
    "文件："
  ];
  for (const item of record.summary) {
    lines.push(`  ${translateStatus(item.status).padEnd(4)} ${item.path}`);
  }
  lines.push("");
  lines.push("补丁：");
  lines.push(redactSecrets(record.diff ?? ""));
  return lines.join("\n");
}

async function readChange(root, id) {
  if (id === "latest") {
    const [latest] = await listChanges(root, 1);
    if (!latest) {
      throw new Error("还没有可回退的变更记录。");
    }
    return latest;
  }
  const target = changePath(root, id);
  try {
    return JSON.parse(await fs.readFile(target, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`找不到变更记录：${id}`);
    }
    throw error;
  }
}

function changesDir(root) {
  return path.join(root, ".deepseek-code", "changes");
}

function changePath(root, id) {
  return path.join(changesDir(root), `${id}.json`);
}

function makeChangeId() {
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const rand = Math.random().toString(16).slice(2, 8);
  return `${ts}-${rand}`;
}

function translateStatus(status) {
  if (status === "create") {
    return "新建";
  }
  if (status === "delete") {
    return "删除";
  }
  return "修改";
}

function stripBom(value) {
  return value.charCodeAt(0) === 0xFEFF ? value.slice(1) : value;
}

// #9.3:文本若超过 maxCaptureBytes(默认 1 MiB)只存 sha256 与原始大小,不存全文。
// maxCaptureBytes=null → 永不截断(逐字节维持旧行为)。
function captureText(value, maxCaptureBytes) {
  if (value == null) return { value: null };
  if (maxCaptureBytes == null) return { value };
  const size = Buffer.byteLength(value, "utf8");
  if (size <= maxCaptureBytes) return { value };
  return {
    value: null,
    sha256: createHash("sha256").update(value).digest("hex"),
    size,
    truncated: true
  };
}

// #9.3 保留期:finalize 写新记录后,按 maxRecords(数量上限)与 maxAgeDays(保留期)
// 做确定性清理。只删 .deepseek-code/changes/*.json,绝不碰工作区文件。
async function pruneChangeRecords(root, retention) {
  if (!retention || (!retention.maxRecords && !retention.maxAgeDays)) return;
  const dir = changesDir(root);
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  const names = entries.filter((name) => name.endsWith(".json"));
  if (names.length <= 1) return;

  const records = [];
  for (const name of names) {
    const target = path.join(dir, name);
    let time = "";
    try {
      time = JSON.parse(await fs.readFile(target, "utf8")).time || "";
    } catch {
      // 损坏记录:视为最旧,优先被清理
    }
    records.push({ name, time, ageDays: ageInDays(time) });
  }
  // 新的在前(与 listChanges 的排序一致)
  records.sort((a, b) => b.time.localeCompare(a.time));

  const keep = new Set(records.map((record) => record.name));
  if (retention.maxRecords) {
    const newest = new Set(records.slice(0, retention.maxRecords).map((record) => record.name));
    for (const record of records) {
      if (!newest.has(record.name)) keep.delete(record.name);
    }
  }
  if (retention.maxAgeDays) {
    for (const record of records) {
      if (record.ageDays > retention.maxAgeDays) keep.delete(record.name);
    }
  }

  for (const record of records) {
    if (!keep.has(record.name)) {
      await fs.rm(path.join(dir, record.name), { force: true });
    }
  }
}

function ageInDays(isoTime) {
  if (!isoTime) return Infinity;
  const timestamp = Date.parse(isoTime);
  if (Number.isNaN(timestamp)) return Infinity;
  return (Date.now() - timestamp) / 86400000;
}
