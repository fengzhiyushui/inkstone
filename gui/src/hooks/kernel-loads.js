// gui/src/hooks/kernel-loads.js — pure mapping between window.deepseek calls/events
// and workbench-state actions. Kept pure so the wiring is node:test-able; the hook
// (useKernel) only invokes these and dispatches the results.

// Single-call first-paint loads: each api result maps cleanly to one reducer action.
export function buildInitialLoads() {
  return [
    { call: "getPreferences", toAction: (preferences) => ({ type: "preferences_loaded", preferences: preferences || {} }) },
    { call: "listCheckpoints", toAction: (checkpoints) => ({ type: "checkpoints_loaded", checkpoints: Array.isArray(checkpoints) ? checkpoints : [] }) },
    { call: "getUsage", toAction: (usage) => ({ type: "usage_loaded", usage: usage || {} }) },
    { call: "getState", toAction: (runtime) => ({ type: "runtime_loaded", runtime: runtime || { current: "idle", channel: null } }) },
    { call: "listTree", toAction: (files) => ({ type: "tree_loaded", files: Array.isArray(files) ? files : [] }) },
    { call: "getSettings", toAction: (s) => ({ type: "settings_loaded", config: (s && s.config) || {} }) },
    { call: "listProjects", toAction: (projects) => ({ type: "projects_loaded", projects: Array.isArray(projects) ? projects : [] }) }
  ];
}

// 回合边界后需要重拉的数据(缺陷②,v1.7.2):usage 与检查点在回合结束前不会变,
// 所以只在终态事件上刷新,不在 model:*/tool:* 上刷新(那会每回合打十几次 IPC)。
const TURN_END = new Set(["agent:final", "agent:error", "turn:cancelled", "file:rollback_applied"]);
export function refreshLoadsFor(eventType) {
  if (!TURN_END.has(eventType)) return [];
  return buildInitialLoads().filter((l) => l.call === "getUsage" || l.call === "listCheckpoints");
}

// Branches need two calls (list + active) combined into one action.
export function branchesAction(branches, active) {
  return {
    type: "branches_loaded",
    branches: Array.isArray(branches) ? branches : [],
    activeBranchId: active || "br_main"
  };
}

export function eventToAction(event) {
  return { type: "event_received", event: event || {} };
}

export function errorToAction(area, err) {
  const message = err && err.message ? err.message : String(err || "error");
  return { type: "error_reported", area: area || "runtime", message };
}
