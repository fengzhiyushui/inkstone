/**
 * v1.13.0:MCP tool annotations 解析与风险推导。
 *
 * 规范见 design §4.2(风险推导优先级):
 *   1. 用户 policy(enabled/disabled、autoApprove、三级批准)   ← 最高,由引擎处理
 *   2. tool annotations(readOnlyHint / destructiveHint / openWorldHint)
 *      ※ **annotations 不可信,除非 server 受信** → 默认偏保守
 *   3. 启发式关键词(兜底)
 *   4. 默认:mutate → 需审批
 *
 * 设计约束(design §六 安全不变量):
 *   - 不受信 server 的 annotations **不得放宽**任何权限;
 *   - `destructiveHint: true` 一律升级为 destructive,永不自动放行。
 */

export const ANNOTATION_KEYS = Object.freeze([
  "readOnlyHint",
  "destructiveHint",
  "openWorldHint",
  "idempotentHint"
]);

/** 风险阶梯:越靠后越危险。 */
export const RISK_LADDER = Object.freeze(["read", "mutate", "destructive"]);

function riskRank(category) {
  const i = RISK_LADDER.indexOf(category);
  return i === -1 ? 1 : i;
}

function escalate(category, steps = 1) {
  const next = riskRank(category) + steps;
  return RISK_LADDER[Math.min(next, RISK_LADDER.length - 1)];
}

/**
 * 严格解析 annotations:只有显式 `=== true` 才算命中。
 * 缺省/非布尔/认证失败的字段一律视为 false —— annotations 缺失时走保守兜底。
 * @param {unknown} raw tools/list 返回的 tool.annotations
 */
export function parseAnnotations(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const out = {
    readOnly: false,
    destructive: false,
    openWorld: false,
    idempotent: false,
    present: false,
    // 无法识别的字段照抄一份,仅用于展示/诊断,不参与判定
    title: typeof source.title === "string" ? source.title : null
  };

  for (const key of ANNOTATION_KEYS) {
    if (source[key] === true) {
      out.present = true;
      if (key === "readOnlyHint") out.readOnly = true;
      if (key === "destructiveHint") out.destructive = true;
      if (key === "openWorldHint") out.openWorld = true;
      if (key === "idempotentHint") out.idempotent = true;
    }
  }
  return out;
}

/** 从 tools/list 的工具定义里取 annotations。 */
export function annotationsFromTool(mcpTool) {
  if (!mcpTool || typeof mcpTool !== "object") return parseAnnotations(null);
  // 规范里没有外层 annotations 时,也可能直接摊在 tool 上(部分 server 实现不一致)
  return parseAnnotations(mcpTool.annotations ?? mcpTool);
}

/**
 * 由 annotations + 信任度 + 关键词推导最终 category。
 *
 * @param {object} args
 * @param {string} [args.name]
 * @param {string} [args.description]
 * @param {unknown} [args.annotations] 原始 annotations(或已 parse 过的对象)
 * @param {boolean} [args.trusted] server 是否受用户显式信任
 * @param {(name: string, description: string) => string} [args.infer] 关键词兜底
 * @returns {{ category: string, source: string, annotations: object, trusted: boolean, escalatedBy: string[] }}
 */
export function resolveToolRisk({
  name = "",
  description = "",
  annotations = null,
  trusted = false,
  infer = defaultInfer
} = {}) {
  const parsed = annotations && typeof annotations === "object" && "present" in annotations
    ? annotations
    : parseAnnotations(annotations);

  const keywordCategory = infer(name, description);
  const escalatedBy = [];

  // 不受信:annotations 一律不参与判定,只用关键词兜底(默认偏保守)。
  // 走到这里也可能是因为"受信但没提供 annotations"——此时 trusted 仍反映输入信任度,
  // 只是没有 annotations 可供采纳,不影响下游对信任关系的判断。
  if (!trusted || !parsed.present) {
    return {
      category: keywordCategory,
      source: parsed.present && !trusted ? "keyword-untrusted" : "keyword",
      annotations: parsed,
      trusted: Boolean(trusted),
      escalatedBy
    };
  }

  // 受信:annotations 参与判定,但只向"更危险"方向升级,不允许把危险工具讲成只读。
  let category = keywordCategory;

  // destructiveHint 是最强信号:直接置顶,且不允许被 readOnlyHint 抵消。
  if (parsed.destructive) {
    if (riskRank(category) < riskRank("destructive")) {
      category = "destructive";
      escalatedBy.push("destructiveHint");
    }
  } else if (parsed.readOnly) {
    // readOnlyHint 只在"关键词没有判定出写操作"时才生效;
    // 若关键词已推断为 mutate/destructive,说明工具名/描述里有写意图,
    // 此时不因受信 server 的单一字段就降级(防误放行)。
    if (keywordCategory === "read") {
      category = "read";
      escalatedBy.push("readOnlyHint");
    }
  }

  // openWorldHint:风险 +1(与外部世界交互,倾向 ask)。
  if (parsed.openWorld && riskRank(category) < riskRank("destructive")) {
    category = escalate(category, 1);
    escalatedBy.push("openWorldHint");
  }

  return {
    category,
    source: escalatedBy.length ? "annotations" : "keyword",
    annotations: parsed,
    trusted: true,
    escalatedBy
  };
}

/** 与 schema-converter.inferCategory 一致的默认关键词兜底(避免循环依赖)。 */
function defaultInfer(name = "", description = "") {
  const text = `${name} ${description}`.toLowerCase();
  const WRITE_KEYWORDS = [
    "create", "write", "delete", "remove", "update",
    "insert", "drop", "mutate", "modify", "execute", "exec",
    "send", "post", "put", "patch"
  ];
  const DESTRUCTIVE_KEYWORDS = ["destroy", "purge", "wipe", "rm -rf", "format", "truncate", "drop database"];
  if (DESTRUCTIVE_KEYWORDS.some((kw) => text.includes(kw))) return "destructive";
  return WRITE_KEYWORDS.some((kw) => text.includes(kw)) ? "mutate" : "read";
}

/** 供 GUI/CLI 展示的风险等级文字。 */
export function riskBadge(category) {
  if (category === "destructive") return { level: "danger", label: "破坏性" };
  if (category === "mutate") return { level: "warn", label: "写操作" };
  return { level: "ok", label: "只读" };
}
