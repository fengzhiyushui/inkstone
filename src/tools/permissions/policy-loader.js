export function createPolicyContext({
  autonomy = "gated",
  projectId = "",
  projectRoot = process.cwd(),
  trustStore = { rules: [] },
  projectRules = [],
  approvalCache = null,
  memoryRoot = null,
  // v1.13.0:持久化策略(mcp-policy 的 project / always 级授权)。
  // 由调用方用 mcp/tool-policy.js 的 createPolicyStore().grantedKeys() 提供。
  policyGrants = null
} = {}) {
  return {
    autonomy,
    projectId,
    projectRoot,
    trustStore,
    projectRules,
    approvalCache,
    memoryRoot,
    policyGrants
  };
}
