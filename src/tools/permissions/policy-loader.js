export function createPolicyContext({
  autonomy = "gated",
  projectId = "",
  projectRoot = process.cwd(),
  trustStore = { rules: [] },
  projectRules = [],
  approvalCache = null,
  memoryRoot = null
} = {}) {
  return {
    autonomy,
    projectId,
    projectRoot,
    trustStore,
    projectRules,
    approvalCache,
    memoryRoot
  };
}
