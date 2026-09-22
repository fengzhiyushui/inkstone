// gui/src/state/workbench-state.js — Pure workbench state model (ESM; logic identical to
// the legacy UMD gui/renderer/workbench-state.js, now consumed by React useReducer).

import { normalizeStatusDisplay } from "./status-display.js";
import { SIDEBAR_MIN, SIDEBAR_MAX, SIDEBAR_DEFAULT, RIGHTBAR_MIN, RIGHTBAR_MAX } from "./columns.js";

var VIEWS = ["home", "chat", "projects", "mcp", "plugins"]; // 主区路由;changes/recovery 走右栏 dock;settings 走模态
var INSPECTOR_MODES = ["activity", "approval", "rewind", "details", "checkpoints", "branch"];
var THEMES = ["sumi", "slate", "vesper", "nord", "ash", "snow", "sand", "lotus", "latte", "paper"]; // v1.8.0 token 主题(10)
var LEGACY_THEME_MAP = { night: "sumi", day: "latte", dawn: "lotus", mocha: "sumi", moon: "slate", forest: "ash", clay: "vesper", rose: "sumi" }; // 旧 id → token 主题
var LIGHT_IDS = ["snow", "sand", "lotus", "latte", "paper"];
function isLightId(id) { return LIGHT_IDS.indexOf(id) >= 0; }
var LANGUAGES = ["zh", "en"];
var DOCK_TABS = ["files", "changes", "recovery"];

function normalizeSidebarWidth(value, fallback) {
  if (!Number.isFinite(Number(value))) return fallback;
  var n = Math.round(Number(value));
  return n >= SIDEBAR_MIN && n <= SIDEBAR_MAX ? n : fallback;
}
function normalizeRightbarWidth(value) {
  if (!Number.isFinite(Number(value))) return 0;
  var n = Math.round(Number(value));
  return n === 0 || (n >= RIGHTBAR_MIN && n <= RIGHTBAR_MAX) ? n : 0;
}

function normalizeTheme(value, fallback) {
  if (THEMES.indexOf(value) >= 0) return value;
  if (LEGACY_THEME_MAP[value]) return LEGACY_THEME_MAP[value];
  return fallback;
}

export function createInitialState() {
  return {
    messages: [],
    activity: [],
    changes: [],
    changesTick: 0,
    changeDiff: null,
    pendingReveal: null,
    branches: [],
    checkpoints: [],
    activeBranchId: "br_main",
    selectedBranchId: "br_main",
    selectedCheckpoint: null,
    selectedTarget: null,
    rewindPreview: null,
    rewindResult: null,
    forceRewind: false,
    railCollapsed: false,
    sidebarWidth: SIDEBAR_DEFAULT,
    rightbarWidth: 0,
    rightbarOpen: false,
    dockTab: "files",
    chatTab: "chat",
    dockFiles: { expanded: {} },
    settingsOpen: false,
    inspectorMode: "activity",
    theme: "sumi",
    lastDark: "sumi",
    lastLight: "latte",
    glass: true,
    language: "zh",
    statusDisplay: normalizeStatusDisplay(null),
    view: "home", // v1.4.0 七视图路由
    projects: [], // 全局项目 MRU(project-registry)
    sessions: [], // 当前项目会话(按项目分组,session-index)
    currentProject: null,
    emptyStateVisible: true,
    degraded: false,
    errors: [],
    approval: null,
    sensitiveNotice: null,
    fileTree: [],
    openFiles: [],
    activeFile: null,
    dirty: {},
    cursor: { line: 1, column: 1 },
    config: { model: null, hasApiKey: false },
    loading: {},
    usage: null,
    metrics: {
      tokens: "0",
      cacheRate: "0%",
      latency: "0ms",
      requests: "0"
    },
    runtime: { current: "idle", channel: null },
    statusChannel: "idle"
  };
}

export function applyWorkbenchAction(state, action) {
  var current = state || createInitialState();
  if (!action || !action.type) return current;
  if (action.type === "message_added") {
    // 防长会话 DOM/内存无界增长
    return copy(current, {
      messages: current.messages.concat([action.message]).slice(-200),
      emptyStateVisible: false
    });
  }
  if (action.type === "event_received") {
    var event = action.event || {};
    var patch = { activity: current.activity.concat([event]).slice(-50) };
    if (event.type === "approval:requested") {
      patch.inspectorMode = "approval";
      patch.approval = event.approval || null;
    }
    // #9.3 敏感文件提醒:独立字段,**不写 approval / inspectorMode** —— 它不是
    // 权限审批,以红色模态呈现,不进检查器的审批分区。
    if (event.type === "gui:sensitive_notice") {
      patch.sensitiveNotice = { requestId: event.request_id, descriptor: event.descriptor || null };
    }
    // 缺陷①(v1.7.2):agent 的最终回复此前从不进消息流,.a-msg 分支永远渲染不出来。
    // 空 content 不追加(避免空气泡);stopped 也入流,让用户看到为什么停了。
    if (event.type === "agent:final" && typeof event.content === "string" && event.content.length > 0) {
      patch.messages = current.messages.concat([{ role: "assistant", text: event.content }]).slice(-200);
    }
    if (event.type === "agent:error" || event.type === "session:rewind_conflict" || event.type === "session:rewind_failed" || event.type === "session:rewind_recovery_failed") {
      patch.inspectorMode = "details";
    }
    if (event.type === "file:diff_applied" || event.type === "file:rollback_applied") {
      patch.changesTick = (current.changesTick || 0) + 1;
    }
    return copy(current, patch);
  }
  if (action.type === "branches_loaded") {
    var active = action.activeBranchId || current.activeBranchId || "br_main";
    return copy(current, {
      branches: Array.isArray(action.branches) ? action.branches.slice() : [],
      activeBranchId: active,
      selectedBranchId: action.selectedBranchId || active
    });
  }
  if (action.type === "branch_selected") {
    return copy(current, {
      selectedBranchId: action.branch_id || "br_main",
      selectedCheckpoint: null,
      selectedTarget: null,
      rewindPreview: null,
      rewindResult: null,
      inspectorMode: "branch"
    });
  }
  if (action.type === "checkpoints_loaded") {
    return copy(current, { checkpoints: Array.isArray(action.checkpoints) ? action.checkpoints.slice() : [] });
  }
  if (action.type === "checkpoint_selected") {
    var checkpoint = action.checkpoint || null;
    return copy(current, {
      selectedCheckpoint: checkpoint,
      selectedTarget: targetFromCheckpoint(checkpoint),
      rewindPreview: null,
      rewindResult: null,
      inspectorMode: "rewind"
    });
  }
  if (action.type === "rewind_preview_loaded") {
    return copy(current, { rewindPreview: action.preview || null, rewindResult: null, inspectorMode: "rewind" });
  }
  if (action.type === "rewind_result_loaded") {
    return copy(current, { rewindResult: action.result || null, inspectorMode: "rewind" });
  }
  if (action.type === "rewind_dismissed") {
    return copy(current, { rewindPreview: null, rewindResult: null, selectedCheckpoint: null, selectedTarget: null });
  }
  if (action.type === "changes_loaded") {
    return copy(current, { changes: Array.isArray(action.changes) ? action.changes.slice() : [] });
  }
  if (action.type === "change_diff_loaded") {
    return copy(current, { changeDiff: action.diff || null });
  }
  if (action.type === "change_diff_dismissed") {
    return copy(current, { changeDiff: null });
  }
  if (action.type === "reveal_requested") {
    return copy(current, {
      pendingReveal: { path: action.path || "", line: Math.max(1, Math.floor(Number(action.line) || 1)) }
    });
  }
  if (action.type === "reveal_consumed") {
    return copy(current, { pendingReveal: null });
  }
  if (action.type === "force_rewind_changed") {
    return copy(current, { forceRewind: Boolean(action.force) });
  }
  if (action.type === "cursor_moved") {
    var pos = action.position || {};
    return copy(current, {
      cursor: { line: Math.max(1, Number(pos.line) || 1), column: Math.max(1, Number(pos.column) || 1) }
    });
  }
  if (action.type === "settings_loaded") {
    var cfg = action.config || {};
    return copy(current, {
      config: { model: cfg.model || null, hasApiKey: Boolean(cfg.hasApiKey) }
    });
  }
  if (action.type === "rail_collapsed_changed") {
    return copy(current, { railCollapsed: Boolean(action.collapsed) });
  }
  if (action.type === "sidebar_resized") {
    return copy(current, { sidebarWidth: normalizeSidebarWidth(action.width, current.sidebarWidth) });
  }
  if (action.type === "rightbar_resized") {
    return copy(current, { rightbarWidth: normalizeRightbarWidth(action.width) });
  }
  if (action.type === "rightbar_toggled") {
    var willOpen = !current.rightbarOpen;
    var rbWidth = current.rightbarWidth;
    if (willOpen && !(rbWidth >= RIGHTBAR_MIN)) {
      var vp = Number(action.viewport);
      rbWidth = Math.round((Number.isFinite(vp) && vp > 0 ? vp : 1280) * 0.45);
      if (rbWidth < RIGHTBAR_MIN) rbWidth = RIGHTBAR_MIN;
    }
    return copy(current, { rightbarOpen: willOpen, rightbarWidth: rbWidth });
  }
  if (action.type === "dock_tab_changed") {
    return copy(current, { dockTab: normalize(action.tab, DOCK_TABS, current.dockTab) });
  }
  if (action.type === "chat_tab_changed") {
    return copy(current, { chatTab: normalize(action.tab, ["chat", "trajectory"], current.chatTab) });
  }
  if (action.type === "tree_dir_toggled") {
    var dirPath = action.path;
    if (!dirPath || typeof dirPath !== "string") return current;
    var dockFiles = current.dockFiles || { expanded: {} };
    var expanded = Object.assign({}, dockFiles.expanded || {});
    if (expanded[dirPath]) delete expanded[dirPath];
    else expanded[dirPath] = true;
    return copy(current, { dockFiles: Object.assign({}, dockFiles, { expanded: expanded }) });
  }
  if (action.type === "settings_toggled") {
    return copy(current, { settingsOpen: action.open === undefined ? !current.settingsOpen : Boolean(action.open) });
  }
  if (action.type === "preferences_loaded") {
    var prefs = action.preferences || {};
    var lastDark = normalizeTheme(prefs.lastDark, current.lastDark);
    var lastLight = normalizeTheme(prefs.lastLight, current.lastLight);
    return copy(current, {
      theme: normalizeTheme(prefs.theme, current.theme),
      lastDark: isLightId(lastDark) ? current.lastDark : lastDark,
      lastLight: isLightId(lastLight) ? lastLight : current.lastLight,
      glass: typeof prefs.glass === "boolean" ? prefs.glass : current.glass,
      language: normalize(prefs.language, LANGUAGES, current.language),
      statusDisplay: normalizeStatusDisplay(prefs.statusDisplay, current.statusDisplay),
      railCollapsed: typeof prefs.railCollapsed === "boolean" ? prefs.railCollapsed : current.railCollapsed,
      sidebarWidth: normalizeSidebarWidth(prefs.sidebarWidth, current.sidebarWidth || SIDEBAR_DEFAULT),
      rightbarWidth: normalizeRightbarWidth(prefs.rightbarWidth === undefined ? current.rightbarWidth : prefs.rightbarWidth),
      rightbarOpen: typeof prefs.rightbarOpen === "boolean" ? prefs.rightbarOpen : current.rightbarOpen,
      dockTab: normalize(prefs.dockTab, DOCK_TABS, current.dockTab || "files")
    });
  }
  if (action.type === "inspector_closed") {
    return copy(current, { inspectorMode: "activity", approval: null });
  }
  if (action.type === "inspector_mode_changed" || action.type === "inspector_tab_changed") {
    return copy(current, { inspectorMode: normalize(action.mode || action.tab, INSPECTOR_MODES, "activity") });
  }
  if (action.type === "theme_changed") {
    var next = normalizeTheme(action.theme, "sumi");
    return copy(current, isLightId(next) ? { theme: next, lastLight: next } : { theme: next, lastDark: next });
  }
  if (action.type === "glass_changed") {
    return copy(current, { glass: Boolean(action.glass) });
  }
  if (action.type === "status_display_changed") {
    return copy(current, { statusDisplay: normalizeStatusDisplay(action.display, current.statusDisplay) });
  }
  if (action.type === "view_changed") {
    return copy(current, { view: normalize(action.view, VIEWS, "home") });
  }
  if (action.type === "projects_loaded") {
    return copy(current, { projects: Array.isArray(action.projects) ? action.projects : [] });
  }
  if (action.type === "sessions_loaded") {
    return copy(current, { sessions: Array.isArray(action.sessions) ? action.sessions : [] });
  }
  if (action.type === "project_switched") {
    return copy(current, { currentProject: action.root || null, view: "chat" });
  }
  if (action.type === "language_changed") {
    return copy(current, { language: normalize(action.language, LANGUAGES, "zh") });
  }
  if (action.type === "tree_loaded") {
    return copy(current, { fileTree: Array.isArray(action.files) ? action.files.slice() : [] });
  }
  if (action.type === "file_opened") {
    var file = action.file || {};
    if (!file.path) return current;
    var exists = (current.openFiles || []).some(function (f) { return f.path === file.path; });
    var openFiles = exists
      ? current.openFiles.map(function (f) {
          return f.path === file.path ? copy(file, { original: typeof f.original === "string" ? f.original : (file.content || "") }) : f;
        })
      : current.openFiles.concat([copy(file, { original: file.content || "" })]);
    return copy(current, { openFiles: openFiles, activeFile: file.path });
  }
  if (action.type === "file_activated") {
    return copy(current, { activeFile: action.path || current.activeFile });
  }
  if (action.type === "file_edited") {
    var edited = (current.openFiles || []).map(function (f) {
      return f.path === action.path ? copy(f, { content: action.content }) : f;
    });
    var editedFile = edited.find(function (f) { return f.path === action.path; });
    var isDirty = editedFile ? editedFile.content !== (editedFile.original || "") : true;
    return copy(current, {
      openFiles: edited,
      dirty: isDirty ? copy(current.dirty || {}, keyPatch(action.path, true)) : dropKey(current.dirty || {}, action.path)
    });
  }
  if (action.type === "file_saved") {
    var saved = (current.openFiles || []).map(function (f) {
      return f.path === action.path && typeof action.content === "string" ? copy(f, { content: action.content, original: action.content }) : f;
    });
    return copy(current, { openFiles: saved, dirty: dropKey(current.dirty || {}, action.path) });
  }
  if (action.type === "file_closed") {
    var remaining = (current.openFiles || []).filter(function (f) { return f.path !== action.path; });
    var nextActive = current.activeFile === action.path
      ? (remaining.length ? remaining[remaining.length - 1].path : null)
      : current.activeFile;
    return copy(current, { openFiles: remaining, activeFile: nextActive, dirty: dropKey(current.dirty || {}, action.path) });
  }
  if (action.type === "loading_changed") {
    return copy(current, {
      loading: copy(current.loading || {}, keyPatch(action.key || "default", Boolean(action.value)))
    });
  }
  if (action.type === "approval_loaded") {
    return copy(current, { approval: action.approval || null, inspectorMode: action.approval ? "approval" : current.inspectorMode });
  }
  if (action.type === "approval_cleared") {
    return copy(current, { approval: null, inspectorMode: current.inspectorMode === "approval" ? "activity" : current.inspectorMode });
  }
  if (action.type === "sensitive_notice_cleared") {
    return copy(current, { sensitiveNotice: null });
  }
  if (action.type === "error_reported") {
    var area = action.area || "runtime";
    var message = sanitizeMessage(action.message);
    return copy(current, {
      degraded: true,
      inspectorMode: "details",
      errors: (current.errors || []).concat([{ area: area, message: message }]).slice(-5),
      loading: copy(current.loading || {}, keyPatch(area, false))
    });
  }
  if (action.type === "usage_loaded") {
    return copy(current, {
      usage: action.usage || null,
      metrics: metricsFromUsage(action.usage || {})
    });
  }
  if (action.type === "runtime_loaded") {
    return copy(current, { runtime: action.runtime || { current: "idle", channel: null } });
  }
  if (action.type === "status_channel_changed") {
    return copy(current, { statusChannel: action.channel || current.statusChannel });
  }
  return current;
}

export function targetFromCheckpoint(checkpoint) {
  if (!checkpoint) return null;
  if (checkpoint.turn_id) return { turn_id: checkpoint.turn_id };
  if (checkpoint.event_id) return { event_id: checkpoint.event_id };
  return { seq: checkpoint.seq };
}

export function shortId(value) {
  var text = String(value || "");
  if (text.indexOf("br_") === 0) return text.slice(0, 7);
  if (text.length <= 10) return text;
  return text.slice(0, 10);
}

export function formatRewindStatus(result) {
  if (!result) return "";
  if (result.status === "success") return "Rewind applied. New branch active.";
  if (result.status === "conflict") return "Rewind blocked by dirty files.";
  if (result.status === "conflict_restored") return "Rewind blocked; previous changes were restored.";
  if (result.status === "failed_restored") return "Rewind failed; workspace was restored.";
  if (result.status === "failed_unrestorable") return "Rewind recovery failed. Manual check required.";
  return "Rewind status: " + (result.status || "unknown");
}

export function metricsFromUsage(usage) {
  return {
    tokens: formatTokenCount(usage.total_tokens || ((usage.total_prompt_tokens || 0) + (usage.total_completion_tokens || 0))),
    cacheRate: formatCacheRate(usage),
    latency: formatLatency(usage),
    requests: String(usage.requests || 0)
  };
}

export function formatTokenCount(value) {
  var count = Number(value || 0);
  return count >= 1000 ? (count / 1000).toFixed(1) + "K" : String(count);
}

export function formatCacheRate(usage) {
  if (typeof usage.cache_hit_rate === "number") return Math.round(usage.cache_hit_rate * 100) + "%";
  var hits = usage.cache_hit_tokens || 0;
  var misses = usage.cache_miss_tokens || 0;
  var denom = hits + misses;
  return denom > 0 ? Math.round(hits / denom * 100) + "%" : "0%";
}

export function formatLatency(usage) {
  var ms = Number(usage.avg_latency_ms || 0);
  if (ms >= 1000) return (ms / 1000).toFixed(1) + "s";
  return Math.round(ms) + "ms";
}

export function statusSummary(state) {
  var current = state || createInitialState();
  return {
    runtime: current.runtime?.current || "idle",
    channel: current.statusChannel || current.runtime?.channel || "idle",
    branch: current.activeBranchId || "br_main",
    autonomy: current.runtime?.autonomy || "gated",
    degraded: Boolean(current.degraded),
    approval: Boolean(current.approval)
  };
}

export function trafficTone(state) {
  var current = state || createInitialState();
  var runtime = current.runtime?.current || "idle";
  if (current.degraded || runtime === "error" || runtime === "conflict" || runtime === "denied") return "error";
  if (runtime === "offline" || runtime === "unknown" || runtime === "preview") return "offline";
  if (runtime === "acting" || runtime === "thinking" || runtime === "verifying" || runtime === "repairing" || runtime === "awaiting_approval" || current.approval) {
    return "working";
  }
  return "ready";
}

export function trafficLabel(tone, state) {
  var current = state || createInitialState();
  if (tone === "error") return "Error";
  if (tone === "working") return current.runtime?.current === "awaiting_approval" || current.approval ? "Approval" : "Working";
  if (tone === "offline") return "Offline";
  return "Ready";
}

const THEME_LABELS = { sumi: "墨", slate: "玄", vesper: "烬", nord: "峡", ash: "灰", snow: "霜", sand: "沙", lotus: "荷", latte: "瓷", paper: "宣" };

export function themeLabel(theme) {
  return THEME_LABELS[theme] || "墨";
}

function normalize(value, allowed, fallback) {
  return allowed.indexOf(value) >= 0 ? value : fallback;
}

function copy(base, patch) {
  var next = {};
  Object.keys(base).forEach(function (key) { next[key] = base[key]; });
  Object.keys(patch).forEach(function (key) { next[key] = patch[key]; });
  return next;
}

function keyPatch(key, value) {
  var patch = {};
  patch[key] = value;
  return patch;
}

function dropKey(base, key) {
  var next = {};
  Object.keys(base).forEach(function (k) { if (k !== key) next[k] = base[k]; });
  return next;
}

function sanitizeMessage(message) {
  var text = String(message || "").replace(/\s+/g, " ").trim();
  return text || "Unknown error";
}
