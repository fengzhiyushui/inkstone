// src/apps/tui/tui-state.js — TUI 纯 reducer(不可变)+ 状态栏派生。IO 一概不进此文件。
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const HISTORY_CAP = 100; // 本地输入历史条数上限

export function initialTuiState({ lang = "zh", mode = "gated", theme = "sumi", shell = "pwsh" } = {}) {
  return {
    lang,
    mode,
    theme,
    shell,
    screen: "home", // v1.4.0:home 首页 / chat 会话
    busy: false,
    spin: 0,
    exit: false,
    input: { text: "", cursor: 0, history: [], hi: -1, saved: "" },
    stream: "",
    approval: null,
    // #9.3:敏感文件提醒**不复用** approval 态 —— 它不是权限审批,
    // 混用会让渲染层无从区分,也容易被后人接进审批缓存。
    sensitiveNotice: null,
    menu: null,
    overlay: null,
    pending: [],
    hint: "",
    // v1.9 M4 #11:reasoningTokens/tps 由 refreshStatus 从 usage 快照透传,0 = 无数据
    status: { state: "idle", model: "", tokens: 0, reasoningTokens: 0, tps: 0, cacheRate: 0 },
    ctrlcAt: 0
  };
}

function chars(text) { return Array.from(text); }

export function reduce(state, action = {}) {
  switch (action.type) {
    case "input_insert": {
      const cs = chars(state.input.text);
      const add = chars(String(action.text || ""));
      cs.splice(state.input.cursor, 0, ...add);
      return withInput(state, { text: cs.join(""), cursor: state.input.cursor + add.length });
    }
    case "input_backspace": {
      if (state.input.cursor === 0) return state;
      const cs = chars(state.input.text);
      cs.splice(state.input.cursor - 1, 1);
      return withInput(state, { text: cs.join(""), cursor: state.input.cursor - 1 });
    }
    case "input_left": return withInput(state, { cursor: Math.max(0, state.input.cursor - 1) });
    case "input_right": return withInput(state, { cursor: Math.min(chars(state.input.text).length, state.input.cursor + 1) });
    case "input_home": return withInput(state, { cursor: 0 });
    case "input_end": return withInput(state, { cursor: chars(state.input.text).length });
    case "input_set": return withInput(state, { text: action.text, cursor: chars(action.text).length });
    case "input_hist_prev": {
      const { history, hi, text, saved } = state.input;
      if (!history.length) return state;
      const next = hi === -1 ? history.length - 1 : Math.max(0, hi - 1);
      const keepSaved = hi === -1 ? text : saved;
      return withInput(state, { text: history[next], cursor: chars(history[next]).length, hi: next, saved: keepSaved });
    }
    case "input_hist_next": {
      const { history, hi, saved } = state.input;
      if (hi === -1) return state;
      if (hi >= history.length - 1) return withInput(state, { text: saved, cursor: chars(saved).length, hi: -1, saved: "" });
      const next = hi + 1;
      return withInput(state, { text: history[next], cursor: chars(history[next]).length, hi: next });
    }
    case "submit_local": {
      const entry = state.input.text;
      const history = entry ? [...state.input.history, entry].slice(-HISTORY_CAP) : state.input.history;
      return {
        ...state,
        pending: [...state.pending, action.line, ""],
        input: { text: "", cursor: 0, history, hi: -1, saved: "" }
      };
    }
    case "push": return { ...state, pending: [...state.pending, ...action.lines] };
    case "flush": return { ...state, pending: state.pending.slice(action.count) };
    case "stream_delta": return { ...state, stream: state.stream + String(action.text || "") };
    case "stream_clear": return { ...state, stream: "" };
    case "busy": return { ...state, busy: Boolean(action.busy), hint: action.busy ? state.hint : "" };
    case "spin": return { ...state, spin: (state.spin + 1) % SPINNER.length };
    case "approval": return { ...state, approval: action.approval || null };
    case "sensitive_notice": return { ...state, sensitiveNotice: action.notice || null };
    case "menu": return { ...state, menu: action.menu || null };
    case "menu_move": {
      if (!state.menu || !state.menu.items.length) return state;
      const n = state.menu.items.length;
      const index = ((state.menu.index + action.delta) % n + n) % n;
      return { ...state, menu: { ...state.menu, index } };
    }
    case "overlay": return { ...state, overlay: action.overlay || null };
    case "mode": return { ...state, mode: action.mode };
    case "lang": return { ...state, lang: action.lang };
    case "theme_set": return { ...state, theme: action.theme };
    case "shell_set": return { ...state, shell: action.shell };
    case "screen_set": return { ...state, screen: action.screen };
    case "hint": return { ...state, hint: String(action.text || "") };
    case "status": {
      const patch = action.patch || {};
      let same = true;
      for (const [key, value] of Object.entries(patch)) {
        if (state.status[key] !== value) { same = false; break; }
      }
      if (same) return state; // 空转刷新不触发重绘
      return { ...state, status: { ...state.status, ...patch } };
    }
    case "ctrlc_mark": return { ...state, ctrlcAt: action.now };
    case "exit": return { ...state, exit: true };
    default: return state;
  }
}

function withInput(state, patch) {
  return { ...state, input: { ...state.input, ...patch } };
}

export function formatTokens(n) {
  const v = Number(n) || 0;
  if (v < 1000) return String(v);
  if (v < 1_000_000) return `${(v / 1000).toFixed(1)}k`;
  return `${(v / 1_000_000).toFixed(1)}m`;
}

// v1.9 M4 #11:tps 口径 = 每请求均值吞吐(completion tokens / latency,循
// src/core/execution/executor-loop.js:148 约定,保留 1 位小数)。usage tracker 没有
// completion/latency 组合字段,用均值粗算:
//   tps = total_completion_tokens / (avg_latency_ms/1000 × requests)
//      = (total_completion_tokens / requests) / (avg_latency_ms / 1000)
// 即「平均每次请求的 completion tokens ÷ 平均每次延迟」。requests 或延迟为 0
// (尚无请求/网关未记 latency)时返回 0,状态行即不渲染该段(无数据不编造)。
export function deriveTps(usage = {}) {
  const u = usage || {};
  const requests = Number(u.requests) || 0;
  const avgLatencyMs = Number(u.avg_latency_ms) || 0;
  const completion = Number(u.total_completion_tokens) || 0;
  if (requests <= 0 || avgLatencyMs <= 0 || completion <= 0) return 0;
  return Math.round((completion / ((avgLatencyMs / 1000) * requests)) * 10) / 10;
}

export function statusLine(state, t) {
  const runState = state.busy ? SPINNER[state.spin] : (state.status.state || "idle");
  const reasoningTokens = Number(state.status.reasoningTokens) || 0;
  const tpsValue = Math.round((Number(state.status.tps) || 0) * 10) / 10;
  const parts = [
    state.mode,
    state.status.model || "-",
    runState,
    `tokens ${formatTokens(state.status.tokens)}`,
    reasoningTokens > 0 ? `r:${formatTokens(reasoningTokens)} tok` : "", // v1.9 M4 #11:无推理数据不渲染
    tpsValue > 0 ? `${tpsValue} tps` : "", // v1.9 M4 #11:吞吐(四舍五入不到 0.1 即视为无数据)
    `cache ${Math.round((state.status.cacheRate || 0) * 100)}%`,
    state.shell ? `sh:${state.shell}` : "",
    state.theme ? `theme:${state.theme}` : "", // v1.4.6:与设计稿的 TUI 状态行一致
    t("status.lang")
  ].filter(Boolean);
  const line = parts.join(" · ");
  return line;
}
