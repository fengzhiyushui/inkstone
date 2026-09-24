// src/apps/tui/session-actions.js — /branch /rewind /fim 的纯解析与格式化(零 I/O)。
// 本模块是 v1.9.0 M3 A6/A3 的纯逻辑部分;执行器(kernel 调用、pushLines、配色)
// 留在 tui-app.js 的 SLASH_HANDLERS 闭包里,循 recovery 既有模式。
//
// 纯度契约(全部导出函数共用):
//   - 零 I/O、零副作用:不 import 内核 / tui-app / color / tui-i18n,不读环境、不触时钟、
//     不发事件;入参即所得,输出全新对象/数组,绝不改写入参(format* 先拷贝再排序)。
//   - 文案经注入的 t(key) 取得(循 TUI 既有 injectable 模式:tui-app 闭包内 t = makeT(lang));
//     dim/高亮等样式由调用方包装,本模块只产纯文本行。
//   - t 缺省时退化为原样返回 key(桩注入友好,调用方恒传入 makeT 实例)。
//
// 依赖文案键(tui-i18n.js 双字典,与执行器接线轨共用;单测以桩 t 注入):
//   msg.branchEmpty    分支列表为空时的一行提示(调用方按 dim 渲染)
//   msg.checkpointEmpty 检查点列表为空时的一行提示(调用方按 dim 渲染)
// 当前分支标记用字面量 "●"(循 cfg.active "●已激活" 的既有字形,无需新增文案键);
// /fim 缺 prefix 的用法提示(parseFimArgs 不产出行)用已有键 msg.fimUsage,由调用方使用。
//
// 形状约定(与内核门面对齐):
//   branch:     { branch_id, label, parent_branch_id, created_at, ... }   src/sessions/branch-store.js
//   checkpoint: { checkpoint_id, branch_id, seq, turn_id, type, label,     src/sessions/checkpoint-index.js
//                 timestamp? | created_at? | ts? }  // 时间戳可选,缺省时该段省略

const text = (value) => (value == null ? "" : String(value));

// 字典序比较(按 code unit,不依赖 locale,保证跨平台确定)。
function compare(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// /branch 参数解析。arg 形态(动词大小写敏感;首词前后空白已容忍):
//   "" | 纯空白                       → { action: "list",   id: null, label: null }
//   "switch <branchId>"               → { action: "switch", id: <branchId>, label: null }
//   "new <label...>"                  → { action: "new",    id: null, label: <多词 label> }
//   "switch"(缺 id) / "new"(缺 label)  → { action: "invalid", ..., error: "missing_id" | "missing_label" }
//   其他首词                          → { action: "invalid", ..., error: "unknown_action" }
// label 多词时以单空格连接(内部连续空白折叠)并 trim;switch 后续多余词元忽略(取首个为 id)。
// invalid 时附带 error 原因码供调用方决定提示文案;正常分支无 error 键。
export function parseBranchArgs(arg) {
  const raw = text(arg).trim();
  if (!raw) return { action: "list", id: null, label: null };
  const [verb, ...rest] = raw.split(/\s+/);
  if (verb === "switch") {
    const id = rest[0] || "";
    return id
      ? { action: "switch", id, label: null }
      : { action: "invalid", id: null, label: null, error: "missing_id" };
  }
  if (verb === "new") {
    const label = rest.join(" ").trim();
    return label
      ? { action: "new", id: null, label }
      : { action: "invalid", id: null, label: null, error: "missing_label" };
  }
  return { action: "invalid", id: null, label: null, error: "unknown_action" };
}

// 分支列表格式化。每行恒为三段:两空格缩进 + branchId + 两空格 + label(可空)
// + 两空格 + 当前标记(当前分支为字面量 "●",否则为空,即空段不省略)。
// 排序按 branch_id 字典序升序;Array#sort 在 V8 稳定,同 id 时保留输入顺序
// (确定性不依赖调用顺序)。
// 空列表(或入参非数组)返回单行 t("msg.branchEmpty")。
const BRANCH_ACTIVE_MARK = "●";
export function formatBranchLines(branches, activeId, t) {
  const say = typeof t === "function" ? t : (key) => key;
  const list = (Array.isArray(branches) ? branches : [])
    .slice()
    .sort((a, b) => compare(text(a?.branch_id), text(b?.branch_id)));
  if (list.length === 0) return [`  ${say("msg.branchEmpty")}`];
  const active = text(activeId);
  return list.map((branch) => {
    const marker = active && text(branch?.branch_id) === active ? BRANCH_ACTIVE_MARK : "";
    return `  ${text(branch?.branch_id)}  ${text(branch?.label)}  ${marker}`;
  });
}

// /rewind 参数解析。arg 形态(动词大小写敏感):
//   "" | 纯空白          → { action: "list", checkpointId: null }
//   "preview <id>"       → { action: "preview", checkpointId: <id> }
//   "apply <id>"         → { action: "apply",   checkpointId: <id> }
//   "preview" / "apply" 缺 id → { action: "invalid", checkpointId: null, error: "missing_id" }
//   其他首词              → { action: "invalid", checkpointId: null, error: "unknown_action" }
// 后续多余词元忽略(取首个为 checkpointId)。
export function parseRewindArgs(arg) {
  const raw = text(arg).trim();
  if (!raw) return { action: "list", checkpointId: null };
  const [verb, ...rest] = raw.split(/\s+/);
  if (verb === "preview" || verb === "apply") {
    const checkpointId = rest[0] || "";
    return checkpointId
      ? { action: verb, checkpointId }
      : { action: "invalid", checkpointId: null, error: "missing_id" };
  }
  return { action: "invalid", checkpointId: null, error: "unknown_action" };
}

// 检查点列表格式化。每行三段:两空格缩进 + checkpointId + 两空格 + turn/seq 摘要
// (有 turn_id → "turn <turn_id>",否则 "seq <seq>")+ 两空格 + 时间
// (依次取 timestamp / created_at / ts,均缺省时段落省略)。排序按 seq 升序,
// 同 seq 按 checkpoint_id 字典序(全序确定,不依赖引擎 sort 稳定性)。
// 空列表(或入参非数组)返回单行 t("msg.checkpointEmpty")。
export function formatCheckpointLines(checkpoints, t) {
  const say = typeof t === "function" ? t : (key) => key;
  const list = (Array.isArray(checkpoints) ? checkpoints : [])
    .slice()
    .sort((a, b) => {
      const bySeq = Number(a?.seq || 0) - Number(b?.seq || 0);
      return bySeq !== 0 ? bySeq : compare(text(a?.checkpoint_id), text(b?.checkpoint_id));
    });
  if (list.length === 0) return [`  ${say("msg.checkpointEmpty")}`];
  return list.map((cp) => {
    const summary = text(cp?.turn_id) ? `turn ${text(cp.turn_id)}` : `seq ${Number(cp?.seq || 0)}`;
    const time = text(cp?.timestamp ?? cp?.created_at ?? cp?.ts);
    const parts = [text(cp?.checkpoint_id), summary, time].filter((part) => part !== "");
    return `  ${parts.join("  ")}`;
  });
}

// /fim 参数解析。D3 拍板:TUI 只做前缀补全,无光标内联 → 整个 arg(trim 后)即 prefix,
// suffix 恒 ""。空 arg → prefix ""(调用方提示用法,文案键 msg.fimUsage 已在字典)。
export function parseFimArgs(arg) {
  return { prefix: text(arg).trim(), suffix: "" };
}
