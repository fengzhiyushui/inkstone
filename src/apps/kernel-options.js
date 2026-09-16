import { loadConfig } from "../config.js";

export async function buildKernelOptions(root, overrides = {}, loadConfigImpl = loadConfig) {
  if (overrides.modelGateway || overrides.deepseek) return overrides;
  let config = {};
  try {
    config = await loadConfigImpl(root, { allowMissingKey: true });
  } catch {
    config = {};
  }
  if (!config.apiKey) return overrides;
  const result = {
    ...overrides,
    deepseek: {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl
    }
  };
  if (config.models) result.deepseek.models = config.models;
  if (config.limits) result.limits = config.limits;
  if (config.orchestration) result.orchestration = config.orchestration;
  if (config.edits) result.edits = config.edits;
  if (overrides.context?.semantic) {
    result.context = {
      ...config.context,
      semantic: { ...(config.context?.semantic || {}), ...overrides.context.semantic }
    };
  } else if (config.context) {
    result.context = config.context;
  }
  return result;
}
