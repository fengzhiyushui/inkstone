// gui/preload.js — Secure context bridge
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("deepseek", {
  send: (message, opts) => ipcRenderer.invoke("agent:send", message, opts),
  approve: (id, decision) => ipcRenderer.invoke("agent:approve", id, decision),
  // #9.3:敏感文件提醒的回答(非审批 —— 不经权限引擎、不进审批缓存)
  respondSensitive: (requestId, allowed) => ipcRenderer.invoke("sensitive:respond", requestId, allowed === true),
  interrupt: () => ipcRenderer.invoke("agent:interrupt"),
  getTimeline: (count) => ipcRenderer.invoke("session:timeline", count),
  onKernelEvent: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("kernel:event", handler);
    return () => ipcRenderer.removeListener("kernel:event", handler);
  },
  getSnapshot: () => ipcRenderer.invoke("context:snapshot"),
  getUsage: () => ipcRenderer.invoke("model:usage"),
  getPreferences: () => ipcRenderer.invoke("gui:preferences-get"),
  setPreferences: (patch) => ipcRenderer.invoke("gui:preferences-set", patch || {}),
  getConfig: () => ipcRenderer.invoke("config:get"),
  getState: () => ipcRenderer.invoke("orchestrator:state"),
  listBranches: () => ipcRenderer.invoke("session:branches"),
  getActiveBranch: () => ipcRenderer.invoke("session:branch-active"),
  listCheckpoints: (options) => ipcRenderer.invoke("session:checkpoints", options || {}),
  rewindPreview: (options) => ipcRenderer.invoke("session:rewind-preview", options || {}),
  rewindApply: (options) => ipcRenderer.invoke("session:rewind-apply", options || {}),
  minimize: () => ipcRenderer.invoke("window:minimize"),
  maximizeToggle: () => ipcRenderer.invoke("window:maximize"),
  closeWindow: () => ipcRenderer.invoke("window:close"),
  listTree: () => ipcRenderer.invoke("fs:tree"),
  readFile: (rel) => ipcRenderer.invoke("fs:read", rel),
  writeFile: (rel, content) => ipcRenderer.invoke("fs:write", rel, content),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setConfig: (patch) => ipcRenderer.invoke("config:set", patch || {}),
  listApiProfiles: () => ipcRenderer.invoke("api:list"),
  saveApiProfile: (p) => ipcRenderer.invoke("api:save", p),
  deleteApiProfile: (id) => ipcRenderer.invoke("api:delete", id),
  activateApiProfile: (id) => ipcRenderer.invoke("api:activate", id),
  listModels: (profileId) => ipcRenderer.invoke("models:list", profileId),
  testConnection: (profileId) => ipcRenderer.invoke("conn:test", profileId),
  activateBranch: (id) => ipcRenderer.invoke("session:branch-activate", id),
  listChanges: (limit) => ipcRenderer.invoke("changes:list", limit),
  describeChange: (id, relPath) => ipcRenderer.invoke("changes:describe", id, relPath),
  listProjects: () => ipcRenderer.invoke("projects:list"),
  addProject: (root) => ipcRenderer.invoke("projects:add", root),
  removeProject: (root) => ipcRenderer.invoke("projects:remove", root),
  switchProject: (root) => ipcRenderer.invoke("projects:switch", root),
  listSessions: () => ipcRenderer.invoke("sessions:list"),
  pickProjectFolder: () => ipcRenderer.invoke("projects:pick"),
  revealProject: (root) => ipcRenderer.invoke("projects:reveal", root),
  // D-G7 Recovery Center
  listRecovery: (options) => ipcRenderer.invoke("recovery:list", options || {}),
  getRecoveryReport: () => ipcRenderer.invoke("recovery:report"),
  recoveryResume: (id, options) => ipcRenderer.invoke("recovery:resume", id, options || {}),
  recoveryCancel: (id) => ipcRenderer.invoke("recovery:cancel", id),
  recoveryClear: (id) => ipcRenderer.invoke("recovery:clear", id),
});
