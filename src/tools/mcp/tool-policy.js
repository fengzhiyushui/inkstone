/**
 * v1.13.0:MCP 工具治理 —— 工具级开关、三级批准与策略持久化。
 *
 * 设计规格(design §4.3):
 *   - 三级批准:**仅本次 / 本项目 / 永久**(session / project / always);
 *   - **destructive 不可永久自动放行**(§六 安全不变量)。
 *
 * 持久化位置:
 *   - `always`  → `~/.deepseek-code/mcp-policy.json`(用户级)
 *   - `project` → `<projectRoot>/.deepseek-code/mcp-policy.json`(项目级)
 * 两者都只记录**grant**,不写任何密钥;密钥继续走 inputs / credentials 体系。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export const APPROVAL_SCOPES = Object.freeze(["session", "project", "always"]);
export const DEFAULT_APPROVAL_SCOPE = "session";

/** 工具策略在 server 配置里的归一化形状(与 config-loader 对齐)。 */
export function normalizeToolPolicy(raw = {}) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};

  const toList = (value) => {
    if (!Array.isArray(value)) return [];
    return value.map((v) => String(v).trim()).filter(Boolean);
  };

  let enabled = toList(source.enabled);
  if (enabled.length === 0) enabled = ["*"];
  const disabled = toList(source.disabled);

  // per-tool 批准范围:{ "<toolName>": "session" | "project" | "always" }
  const approval = {};
  if (source.approval && typeof source.approval === "object" && !Array.isArray(source.approval)) {
    for (const [tool, scope] of Object.entries(source.approval)) {
      const normalized = normalizeApprovalScope(scope);
      if (normalized) approval[tool] = normalized;
    }
  }

  return { enabled, disabled, approval };
}

export function normalizeApprovalScope(value) {
  if (typeof value !== "string") return null;
  const lowered = value.trim().toLowerCase();
  return APPROVAL_SCOPES.includes(lowered) ? lowered : null;
}

/** 宽容地拿到规范化策略:允许直接传 server 配置里的原始 `tools` 字段。 */
function asPolicy(toolPolicy) {
  // 已规范化(有 enabled/disabled 两个键)时不再重复归一,保持幂等
  if (toolPolicy && typeof toolPolicy === "object" && Array.isArray(toolPolicy.enabled) && Array.isArray(toolPolicy.disabled)) {
    return toolPolicy;
  }
  return normalizeToolPolicy(toolPolicy);
}

/** 工具是否被 server 配置显式启用(默认全开)。 */
export function isToolEnabled(toolPolicy, toolName) {
  const policy = asPolicy(toolPolicy);
  const name = String(toolName);
  if (policy.disabled.includes(name)) return false;
  if (policy.enabled.includes("*")) return true;
  return policy.enabled.includes(name);
}

export function resolveConfiguredScope(toolPolicy, toolName) {
  const policy = asPolicy(toolPolicy);
  return policy.approval[String(toolName)] || null;
}

/**
 * D4 硬约束:批准请求能否以指定 scope 授予。
 *
 * `destructive` 只允许 `session`(仅本次)。任何 project / always 持久化都被拒绝,
 * 并给出 fallback —— 调用方应改用 fallback 而非静默忽略,否则用户点"永久"会
 * 发现没生效却不知道为什么。
 */
export function validateApprovalScope({ category, scope, toolName = "" } = {}) {
  const requested = normalizeApprovalScope(scope) || DEFAULT_APPROVAL_SCOPE;
  if (requested === "session") {
    return { ok: true, scope: "session", reason: null };
  }
  if (category === "destructive") {
    return {
      ok: false,
      scope: DEFAULT_APPROVAL_SCOPE,
      reason: `tool '${toolName}' is destructive: only per-session approval is allowed`,
      locked: true
    };
  }
  return { ok: true, scope: requested, reason: null };
}

/** 策略文件的规范 key(工具级,与调用参数无关)。 */
export function policyKey(toolName) {
  return `tool:${String(toolName)}`;
}

function readGrantFile(file) {
  try {
    if (!existsSync(file)) return {};
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const grants = parsed?.grants;
    return grants && typeof grants === "object" && !Array.isArray(grants) ? grants : {};
  } catch {
    // 损坏的策略文件不得让内核启动失败;按空表处理(等于回到默认保守)
    return {};
  }
}

function writeGrantFile(file, grants) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, grants }, null, 2), "utf8");
  // 策略文件含"永久放行"决定,收紧到 0600
  try { chmodSync(tmp, 0o600); } catch { /* POSIX-only; Windows 上无意义 */ }
  // rename 是同目录原子操作
  renameSync(tmp, file);
}

/**
 * 创建策略存储。两个作用域各自独立文件;读时**用户级优先**于项目级
 * (更"永久"的决定覆盖更局部的),任一命中即放行。
 */
export function createPolicyStore({ projectRoot = null, userRoot = null } = {}) {
  const projectFile = projectRoot ? join(projectRoot, ".deepseek-code", "mcp-policy.json") : null;
  // 用户根可用 DEEPSEEK_CODE_HOME 覆盖(测试隔离 / 便携部署);缺省仍是主目录
  const userHome = userRoot || process.env.DEEPSEEK_CODE_HOME || homedir();
  const userFile = join(userHome, ".deepseek-code", "mcp-policy.json");

  function readAll() {
    return {
      always: readGrantFile(userFile),
      project: projectFile ? readGrantFile(projectFile) : {}
    };
  }

  function grant(toolName, scope) {
    const normalized = normalizeApprovalScope(scope);
    if (!normalized || normalized === "session") return { ok: false, reason: "session scope is not persisted" };
    const file = normalized === "always" ? userFile : projectFile;
    if (!file) return { ok: false, reason: `no location for scope '${normalized}'` };
    const grants = readGrantFile(file);
    grants[policyKey(toolName)] = { tool: String(toolName), scope: normalized, granted_at: new Date().toISOString() };
    writeGrantFile(file, grants);
    return { ok: true, scope: normalized, key: policyKey(toolName) };
  }

  function revoke(toolName, scope = "always") {
    const normalized = normalizeApprovalScope(scope) || "always";
    const file = normalized === "always" ? userFile : projectFile;
    if (!file) return { ok: false };
    const grants = readGrantFile(file);
    delete grants[policyKey(toolName)];
    writeGrantFile(file, grants);
    return { ok: true };
  }

  /** 返回一个可直接被权限引擎消费的"已放行 key 集合"。 */
  function grantedKeys() {
    const { always, project } = readAll();
    return new Set([...Object.keys(project), ...Object.keys(always)]);
  }

  function list() {
    const { always, project } = readAll();
    return [
      ...Object.values(project).map((g) => ({ ...g, scope: "project" })),
      ...Object.values(always).map((g) => ({ ...g, scope: "always" }))
    ];
  }

  return { grant, revoke, grantedKeys, list, files: { project: projectFile, user: userFile } };
}
