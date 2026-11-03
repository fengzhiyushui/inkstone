/** Kernel `mcp` facade (extracted from the createKernel composition root in src/index.js).
 * Thin pass-through over the MCP hub, with tool-test trials routed to the trials
 * service. Server-mutating calls cancel in-flight trials for the server first. */
export function createMcpFacade({ hub, trials }) {
  return {
    hub,
    listInputRequests: () => hub.listInputRequests(),
    respondInputRequest: (requestId, response) => hub.respondInputRequest(requestId, response),
    getLogs: (serverId, options) => hub.getLogs(serverId, options),
    exportLogs: (serverId, options) => hub.exportLogs(serverId, options),
    listTools: (serverId) => hub.listTools(serverId),
    startToolTest: (serverId, toolName, params, options) => trials.start(serverId, toolName, params, options),
    approveToolTest: (runId) => trials.approve(runId),
    cancelToolTest: (runId) => trials.cancel(runId),
    listServers: () => hub.listServers(),
    listInputs: () => hub.listInputs(),
    setInputValue: (name, value) => hub.setInputValue(name, value),
    getAuthStatus: (serverId) => hub.getAuthStatus(serverId),
    startAuth: (serverId) => hub.startAuth(serverId),
    cancelAuth: (serverId) => hub.cancelAuth(serverId),
    logoutAuth: (serverId) => { trials.cancelServer(serverId); return hub.logoutAuth(serverId); },
    restartServer: (serverId) => { trials.cancelServer(serverId); return hub.restartServer(serverId); },
    toggleServer: (serverId, enabled) => { trials.cancelServer(serverId); return hub.toggleServer(serverId, enabled); },
    addServer: (serverId, config, opts) => { trials.cancelServer(serverId); return hub.addServer(serverId, config, opts); },
    removeServer: (serverId) => { trials.cancelServer(serverId); return hub.removeServer(serverId); },
    listResources: (serverId, opts) => hub.listResources(serverId, opts),
    listResourceTemplates: (serverId, opts) => hub.listResourceTemplates(serverId, opts),
    readResource: (serverId, uri, opts) => hub.readResource(serverId, uri, opts),
    listPrompts: (serverId, opts) => hub.listPrompts(serverId, opts),
    getPrompt: (serverId, name, args, opts) => hub.getPrompt(serverId, name, args, opts),
    callTool: (namespacedName, params, options) => hub.callTool(namespacedName, params, options)
  };
}
