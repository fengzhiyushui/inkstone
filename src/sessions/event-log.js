import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { makeId } from "../shared/id.js";
import { nowIso } from "../shared/time.js";
import { validateEvent } from "./event-schemas.js";

const SCHEMA_VERSION = 2;

// M1 A1a:strict 模式下 schema 违规记录上限(超出丢弃最旧),防长会话无界增长。
const MAX_SCHEMA_VIOLATIONS = 100;

const RESERVED_KEYS = new Set([
  "schema_version",
  "event_id",
  "prev_hash",
  "event_hash",
  "type",
  "timestamp",
  "seq",
  "session_id"
]);

export function projectIdFromRoot(root) {
  const normalized = path.resolve(String(root || process.cwd())).toLowerCase();
  return `proj_${createHash("sha256").update(normalized).digest("hex").slice(0, 12)}`;
}

export async function createSessionEventLog({ sessionRoot, projectId, sessionId, meta = {}, strictSchema = false, onSchemaViolation = null } = {}) {
  assertLogOptions({ sessionRoot, projectId, sessionId });
  await fs.mkdir(sessionDirectory(sessionRoot, projectId), { recursive: true });
  const log = new SessionEventLog(sessionFilePath(sessionRoot, projectId, sessionId), sessionId, { strictSchema, onSchemaViolation });
  const existing = await readJsonl(log.filePath);
  if (existing.length > 0) {
    log.seq = Number(existing.at(-1).seq) || 0;
    log.lastHash = existing.at(-1).event_hash || null;
    return log;
  }
  await log.append("session:start", meta);
  return log;
}

export async function openSessionEventLog({ sessionRoot, projectId, sessionId, strictSchema = false, onSchemaViolation = null } = {}) {
  assertLogOptions({ sessionRoot, projectId, sessionId });
  await fs.mkdir(sessionDirectory(sessionRoot, projectId), { recursive: true });
  const log = new SessionEventLog(sessionFilePath(sessionRoot, projectId, sessionId), sessionId, { strictSchema, onSchemaViolation });
  const existing = await readJsonl(log.filePath);
  const validEvents = existing.filter((event) => event && typeof event === "object");
  if (validEvents.length > 0) {
    log.seq = Number(validEvents.at(-1).seq) || 0;
    log.lastHash = validEvents.at(-1).event_hash || null;
  }
  return log;
}

class SessionEventLog {
  constructor(filePath, sessionId, { strictSchema = false, onSchemaViolation = null } = {}) {
    this.filePath = filePath;
    this.sessionId = sessionId;
    this.seq = 0;
    this.lastHash = null;
    // M1 A1a 契约守卫:默认关闭;开启时只记录 violations + 触发回调,
    // 绝不 throw、绝不阻塞 appendFile —— 落盘永远是第一公民。
    this.strictSchema = strictSchema === true;
    this.onSchemaViolation = typeof onSchemaViolation === "function" ? onSchemaViolation : null;
    this.violations = [];
    this.queue = Promise.resolve();
  }

  append(type, data = {}, meta = {}) {
    if (!type || typeof type !== "string") {
      throw new Error("session event type must be a non-empty string");
    }
    const write = this.queue.then(async () => {
      const event = {
        schema_version: SCHEMA_VERSION,
        event_id: typeof meta.event_id === "string" ? meta.event_id : makeId("evt"),
        prev_hash: this.lastHash,
        event_hash: null,
        type,
        timestamp: typeof meta.timestamp === "string" ? meta.timestamp : nowIso(),
        seq: this.seq + 1,
        session_id: this.sessionId,
        ...stripReservedKeys(data)
      };
      event.event_hash = hashEvent(event);
      if (this.strictSchema) this.recordSchemaCheck(type, data, event.seq);
      await fs.appendFile(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
      this.seq = event.seq;
      this.lastHash = event.event_hash;
      return event;
    });
    this.queue = write.catch(() => {});
    return write;
  }

  // M1 A1a:strict 模式载荷校验。reserved 键本就不该由 schema 管 → 校验 strip 后载荷。
  // 只告警:记 violations(上限 100,超出丢弃最旧)+ 回调;任何失败都不得打断写入。
  recordSchemaCheck(type, data, seq) {
    let result;
    try {
      result = validateEvent(type, stripReservedKeys(data));
    } catch {
      return; // validateEvent 契约保证永不抛错;兜底同样不阻断 appendFile。
    }
    if (result.ok) return;
    const violation = { type, errors: [...result.errors], seq };
    this.violations.push(violation);
    if (this.violations.length > MAX_SCHEMA_VIOLATIONS) this.violations.shift();
    if (this.onSchemaViolation) {
      try {
        this.onSchemaViolation({ type, errors: [...violation.errors], seq });
      } catch {
        // 告警回调自身失败同样不得打断事件流。
      }
    }
  }

  getViolations() {
    return this.violations.map((violation) => ({ ...violation, errors: [...violation.errors] }));
  }

  async flush() {
    await this.queue;
  }

  async tail(count = 20) {
    const safeCount = Number.isFinite(Number(count)) && Number(count) > 0 ? Number(count) : 20;
    const events = await readJsonl(this.filePath);
    return events.slice(-safeCount);
  }

  async verify() {
    await this.flush();
    return verifyEventLog(this.filePath);
  }
}

function assertLogOptions({ sessionRoot, projectId, sessionId }) {
  if (!sessionRoot || typeof sessionRoot !== "string") throw new Error("sessionRoot is required");
  if (!projectId || typeof projectId !== "string") throw new Error("projectId is required");
  if (!sessionId || typeof sessionId !== "string") throw new Error("sessionId is required");
}

function sessionDirectory(sessionRoot, projectId) {
  return path.join(sessionRoot, sanitize(projectId));
}

function sessionFilePath(sessionRoot, projectId, sessionId) {
  return path.join(sessionDirectory(sessionRoot, projectId), `${sanitize(sessionId)}.jsonl`);
}

async function readJsonl(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const events = [];
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        // Ignore corrupt lines so one bad append does not hide the usable timeline.
      }
    }
    return events;
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function stripReservedKeys(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const cleaned = {};
  for (const [key, value] of Object.entries(data)) {
    if (!RESERVED_KEYS.has(key) && value !== undefined) cleaned[key] = value;
  }
  return cleaned;
}

export function hashEvent(event) {
  const { event_hash, ...hashable } = jsonSafe(event);
  return `sha256:${createHash("sha256").update(stableStringify(hashable)).digest("hex")}`;
}

export async function verifyEventLog(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const lines = content.split(/\r?\n/);
    const errors = [];
    let prevHash = null;
    let expectedSeq = 1;
    let verifiedCount = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;

      let event;
      try {
        event = JSON.parse(line);
      } catch (err) {
        errors.push({ line_number: i + 1, error: "corrupt_line", message: "Malformed JSON line", raw: line });
        continue;
      }

      if (!event || typeof event !== "object" || !event.type || !event.event_id) {
        errors.push({ line_number: i + 1, error: "invalid_schema", message: "Event missing required schema fields", event });
        continue;
      }

      if (typeof event.seq === "number" && event.seq !== expectedSeq) {
        errors.push({ line_number: i + 1, seq: event.seq, error: "seq_discontinuity", expected: expectedSeq, actual: event.seq });
      }
      if (typeof event.seq === "number") {
        expectedSeq = event.seq + 1;
      }

      if (event.prev_hash !== prevHash) {
        errors.push({ line_number: i + 1, seq: event.seq, error: "chain_broken", expected_prev_hash: prevHash, actual_prev_hash: event.prev_hash });
      }

      const expectedHash = hashEvent(event);
      const isMatch = event.event_hash === expectedHash ||
        (event.event_hash && event.event_hash.startsWith("sha256:") && expectedHash.startsWith(event.event_hash));
      if (!isMatch) {
        errors.push({ line_number: i + 1, seq: event.seq, error: "hash_mismatch", expected_hash: expectedHash, actual_hash: event.event_hash });
      }

      prevHash = event.event_hash || expectedHash;
      verifiedCount++;
    }

    return {
      valid: errors.length === 0,
      verified_count: verifiedCount,
      errors
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { valid: true, verified_count: 0, errors: [] };
    }
    throw error;
  }
}

function jsonSafe(value) {
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(jsonSafe);
  const safe = {};
  for (const key of Object.keys(value)) {
    if (value[key] !== undefined) safe[key] = jsonSafe(value[key]);
  }
  return safe;
}

function stableStringify(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function sanitize(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
}
