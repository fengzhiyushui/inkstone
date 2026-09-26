// src/apps/session-index.js — 枚举项目内会话(只读,供 GUI/TUI 的「会话列表」)。
// 存储:<root>/.deepseek-code/v2/sessions/proj_<hash>/sess_<id>.jsonl(kernel 落盘,此处只读枚举)。
// 只扫前 64KB:足够拿事件数与首条用户消息摘要,大文件不整读。
import fsp from "node:fs/promises";
import path from "node:path";

const SCAN_LIMIT_BYTES = 64 * 1024;
const SUMMARY_MAX = 80;

export function summarizeUserMessage(event) {
  const text = event?.content || event?.text || "";
  const clean = String(text).replace(/\s+/g, " ").trim();
  return clean.length > SUMMARY_MAX ? `${clean.slice(0, SUMMARY_MAX)}…` : clean;
}

// 解析 jsonl 行:返回 {events, summary};损坏行跳过,超限截断。
export function parseSessionEvents(lines) {
  let bytes = 0;
  let events = 0;
  let summary = "";
  for (const line of lines) {
    if (!line) continue;
    bytes += line.length + 1;
    if (bytes > SCAN_LIMIT_BYTES) break;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // 损坏行:跳过不中断
    }
    events += 1;
    if (!summary && event?.type === "user:message") summary = summarizeUserMessage(event);
  }
  return { events, summary };
}

async function scanSessionFile(file) {
  let handle;
  try {
    handle = await fsp.open(file, "r");
    const buf = Buffer.alloc(SCAN_LIMIT_BYTES);
    const { bytesRead } = await handle.read(buf, 0, SCAN_LIMIT_BYTES, 0);
    return parseSessionEvents(buf.subarray(0, bytesRead).toString("utf8").split(/\r?\n/));
  } catch {
    return { events: 0, summary: "" };
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function listSessionsInDir(projDir, projectDir) {
  let files;
  try {
    files = await fsp.readdir(projDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const sessions = [];
  for (const entry of files) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl") || entry.name.endsWith(".branches.json")) continue;
    const file = path.join(projDir, entry.name);
    const stat = await fsp.stat(file).catch(() => null);
    const { events, summary } = await scanSessionFile(file);
    sessions.push({
      id: entry.name.replace(/\.jsonl$/, "").replace(/^sess_/, ""),
      file: entry.name,
      mtime: stat?.mtimeMs || 0,
      events,
      summary
    });
  }
  sessions.sort((a, b) => b.mtime - a.mtime);
  return sessions;
}

export function createSessionIndex({ sessionRoot }) {
  async function listByProject() {
    let projects;
    try {
      projects = await fsp.readdir(sessionRoot, { withFileTypes: true });
    } catch {
      return [];
    }
    const result = [];
    for (const entry of projects) {
      if (!entry.isDirectory() || !entry.name.startsWith("proj_")) continue;
      const sessions = await listSessionsInDir(path.join(sessionRoot, entry.name), entry.name);
      if (sessions.length) result.push({ projectDir: entry.name, sessions });
    }
    return result;
  }

  async function deleteSession(sessionId, projectDir) {
    if (!sessionId) throw new Error("sessionId is required");
    const rawId = String(sessionId).replace(/^sess_/, "");
    let targetDirs = [];
    if (projectDir) {
      targetDirs.push(path.join(sessionRoot, projectDir));
    } else {
      try {
        const entries = await fsp.readdir(sessionRoot, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && entry.name.startsWith("proj_")) {
            targetDirs.push(path.join(sessionRoot, entry.name));
          }
        }
      } catch {
        return { ok: false, deleted: false };
      }
    }

    let deleted = false;
    for (const dir of targetDirs) {
      const candidates = [
        `sess_${rawId}.jsonl`,
        `${rawId}.jsonl`,
        `sess_${rawId}.branches.json`,
        `${rawId}.branches.json`
      ];
      for (const name of candidates) {
        const file = path.join(dir, name);
        try {
          await fsp.unlink(file);
          deleted = true;
        } catch {
          // ignore non-existent
        }
      }
      try {
        const remaining = await fsp.readdir(dir);
        if (remaining.length === 0) {
          await fsp.rmdir(dir);
        }
      } catch { /* ignore */ }
    }
    return { ok: true, deleted };
  }

  return { listByProject, deleteSession };
}
