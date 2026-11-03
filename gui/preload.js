// gui/preload.js — Secure context bridge
const { contextBridge, ipcRenderer } = require("electron");

// 表驱动转发:渲染 API 方法名 → [IPC channel, 形参个数, 参数规整(可选)]。
// 形参个数与原逐条手写的箭头函数一一对应 —— 调用方多传的参数按原语义丢弃
// (例如 approveMcpToolTest(runId, extra) 只把 runId 送过桥,exportMcpLogs 的
// 第三个参数不会被当成输出路径);需要默认值 / 类型强制的条目用 shape 声明。
const IPC_API = [
  ["send", "agent:send", 2],
  ["approve", "agent:approve", 2],
  // #9.3:敏感文件提醒的回答(非审批 —— 不经权限引擎、不进审批缓存)
  ["respondSensitive", "sensitive:respond", 2, (requestId, allowed) => [requestId, allowed === true]],
  ["interrupt", "agent:interrupt", 0],
  ["getTimeline", "session:timeline", 1],
  ["listPaused", "agent:list-paused", 0],
  ["getSnapshot", "context:snapshot", 0],
  ["getUsage", "model:usage", 0],
  ["getPreferences", "gui:preferences-get", 0],
  ["setPreferences", "gui:preferences-set", 1, (patch) => [patch || {}]],
  ["getConfig", "config:get", 0],
  ["getState", "orchestrator:state", 0],
  ["listBranches", "session:branches", 0],
  ["getActiveBranch", "session:branch-active", 0],
  ["listCheckpoints", "session:checkpoints", 1, (options) => [options || {}]],
  ["rewindPreview", "session:rewind-preview", 1, (options) => [options || {}]],
  ["rewindApply", "session:rewind-apply", 1, (options) => [options || {}]],
  ["listTree", "fs:tree", 0],
  ["readFile", "fs:read", 1],
  ["writeFile", "fs:write", 2],
  ["getSettings", "settings:get", 0],
  ["setConfig", "config:set", 1, (patch) => [patch || {}]],
  ["listApiProfiles", "api:list", 0],
  ["saveApiProfile", "api:save", 1],
  ["deleteApiProfile", "api:delete", 1],
  ["activateApiProfile", "api:activate", 1],
  ["listModels", "models:list", 1],
  ["testConnection", "conn:test", 1],
  ["activateBranch", "session:branch-activate", 1],
  ["listChanges", "changes:list", 1],
  ["describeChange", "changes:describe", 2],
  ["listProjects", "projects:list", 0],
  ["addProject", "projects:add", 1],
  ["removeProject", "projects:remove", 1],
  ["switchProject", "projects:switch", 1],
  ["listSessions", "sessions:list", 0],
  ["pickProjectFolder", "projects:pick", 0],
  ["revealProject", "projects:reveal", 1],
  // D-G7 Recovery Center
  ["listRecovery", "recovery:list", 1, (options) => [options || {}]],
  ["getRecoveryReport", "recovery:report", 0],
  ["recoveryResume", "recovery:resume", 2, (id, options) => [id, options || {}]],
  ["recoveryCancel", "recovery:cancel", 1],
  ["recoveryClear", "recovery:clear", 1],
  // MCP 外部服务管理
  ["listMcpServers", "mcp:list", 0],
  ["getMcpAuthStatus", "mcp:auth-status", 1],
  ["startMcpAuth", "mcp:auth-start", 1],
  ["cancelMcpAuth", "mcp:auth-cancel", 1],
  ["logoutMcpAuth", "mcp:auth-logout", 1],
  ["restartMcpServer", "mcp:restart", 1],
  ["toggleMcpServer", "mcp:toggle", 2],
  ["addMcpServer", "mcp:add", 2],
  ["removeMcpServer", "mcp:remove", 1],
  ["listMcpResources", "mcp:resources-list", 2],
  ["listMcpResourceTemplates", "mcp:resource-templates-list", 2],
  ["readMcpResource", "mcp:resource-read", 3],
  ["listMcpPrompts", "mcp:prompts-list", 2],
  ["getMcpPrompt", "mcp:prompt-get", 4],
  ["getMcpLogs", "mcp:logs", 2],
  ["exportMcpLogs", "mcp:logs-export", 2],
  ["listMcpTools", "mcp:tools-list", 1],
  ["startMcpToolTest", "mcp:tool-test", 4],
  ["approveMcpToolTest", "mcp:tool-test-approve", 1],
  ["cancelMcpToolTest", "mcp:tool-test-cancel", 1],
  ["listMcpInputRequests", "mcp:input-requests", 0],
  ["respondMcpInputRequest", "mcp:input-respond", 2],
  // v1.11.2:${input:*} 密钥引用(值不落项目树)
  ["listMcpInputs", "mcp:inputs", 0],
  ["setMcpInput", "mcp:set-input", 2]
];

// 通用注册循环:一张表 + 一个循环,替代逐条手写 ipcRenderer.invoke 转发。
// 参数个数不足时按原语义补 undefined(与原箭头函数「形参默认 undefined」一致),
// 多传则丢弃 —— 两种情况都与原逐条实现逐字节相同。
const invokeArgs = (args, arity) => {
  const out = args.slice(0, arity);
  while (out.length < arity) out.push(undefined);
  return out;
};
const deepseek = {};
for (const [name, channel, arity, shape] of IPC_API) {
  deepseek[name] = shape
    ? (...args) => ipcRenderer.invoke(channel, ...shape(...args))
    : (...args) => ipcRenderer.invoke(channel, ...invokeArgs(args, arity));
}

contextBridge.exposeInMainWorld("deepseek", {
  ...deepseek,
  // 事件订阅(非 invoke):内核事件 → 回调,返回取消订阅函数。
  onKernelEvent: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("kernel:event", handler);
    return () => ipcRenderer.removeListener("kernel:event", handler);
  },
  // ⚠ 暴露形态冻结:tests/unit/gui/layout-and-panels.test.js(v1100)按源码文本
  //   断言 `setModalActive: (active) => ipcRenderer.invoke("gui:modal-active"` 与
  //   `deleteSession: (sessionId, options) => ipcRenderer.invoke("sessions:delete"`,
  //   故这两条保留显式写法(与表中路由的转发行为完全一致)。
  setModalActive: (active) => ipcRenderer.invoke("gui:modal-active", Boolean(active)),
  deleteSession: (sessionId, options) => ipcRenderer.invoke("sessions:delete", sessionId, options || {})
});
