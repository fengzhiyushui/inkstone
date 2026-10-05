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

  // per-tool 风险覆盖:{ "<toolName>": "read" | "mutate" | "destructive" }
  // 这是**用户手写**的决定(规格中优先级高于 annotations 与关键词),用于补回逃生阀:
  // 关键词把一个只读工具误判成写操作时,用户可以在配置里显式纠正。
  const risk = {};
  if (source.risk && typeof source.risk === "object" && !Array.isArray(source.risk)) {
    for (const [tool, level] of Object.entries(source.risk)) {
      const normalized = normalizeRiskOverride(level);
      if (normalized) risk[tool] = normalized;
    }
  }

  return { enabled, disabled, approval, risk };
}

export function normalizeApprovalScope(value) {
  if (typeof value !== "string") return null;
  const lowered = value.trim().toLowerCase();
  return APPROVAL_SCOPES.includes(lowered) ? lowered : null;
}

/** 宽容地拿到规范化策略:允许直接传 server 配置里的原始 `tools` 字段。 */
export function asPolicy(toolPolicy) {
  // 已规范化(有 enabled/disabled 两个键)时不再重复归一,保持幂等
  if (toolPolicy && typeof toolPolicy === "object" && Array.isArray(toolPolicy.enabled) && Array.isArray(toolPolicy.disabled)) {
    return toolPolicy;
  }
  return normalizeToolPolicy(toolPolicy);
}

/** 允许用户显式指定的风险等级(规格 §4.2:用户 policy 优先级最高)。 */
export const OVERRIDABLE_RISKS = Object.freeze(["read", "mutate", "destructive"]);

export function normalizeRiskOverride(value) {
  if (typeof value !== "string") return null;
  const lowered = value.trim().toLowerCase();
  return OVERRIDABLE_RISKS.includes(lowered) ? lowered : null;
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

/**
 * 把持久化授权翻译成**权限引擎已在读取的规则形状**,而不是另造一套规则源。
 *
 * 引擎的 `ruleMatches()` 已支持 `rule.tool` / `rule.category` / `rule.pattern`
 * (对 params.path 的 glob) / `rule.match.argv`,因此这里只需产出 tool 级规则,
 * 参数作用域可由用户手写规则获得(与内置工具的 projectRules 完全一致的体验)。
 *
 * 顺序即优先级:**用户级(always)先于项目级(project)** —— 引擎遇首条命中即返回,
 * 更"永久"的用户决定应覆盖更局部的项目决定。
 */
export function policyGrantsAsRules(grants = [], scope = "project") {
  const rules = [];
  for (const [key, grant] of Object.entries(grants || {})) {
    if (!key.startsWith("tool:")) continue; // 只消费工具级 key
    const tool = grant?.tool || key.slice(5);
    if (!tool) continue;
    rules.push({
      id: `mcp-policy:${scope}:${tool}`,
      tool: String(tool),
      decision: "allow",
      // 供界面区分这条规则来自哪里
      meta: { source: "mcp-policy", scope }
    });
  }
  return rules;
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

  /**
   * 翻译成权限引擎可直接消费的规则数组(见 policyGrantsAsRules)。
   * 顺序即优先级:用户级(always)先于项目级(project)。
   */
  function asRules() {
    const { always, project } = readAll();
    return [
      ...policyGrantsAsRules(always, "always"),
      ...policyGrantsAsRules(project, "project")
    ];
  }

  function list() {
    const { always, project } = readAll();
    return [
      ...Object.values(project).map((g) => ({ ...g, scope: "project" })),
      ...Object.values(always).map((g) => ({ ...g, scope: "always" }))
    ];
  }

  return { grant, revoke, asRules, list, files: { project: projectFile, user: userFile } };
}
