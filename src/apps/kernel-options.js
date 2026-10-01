import { loadConfig } from "../config.js";

// v1.11.2:入口默认启用多作用域 MCP 配置加载(session > project > user,
// 兼容 .mcp.json / VS Code `servers`)。显式 false 关闭;缺配置文件按空处理。
function withMcpScopes(options) {
  return { ...options, loadMcpConfigScopes: options.loadMcpConfigScopes !== false };
}

export async function buildKernelOptions(root, overrides = {}, loadConfigImpl = loadConfig) {
  if (overrides.modelGateway || overrides.deepseek) return withMcpScopes(overrides);
  let config = {};
  try {
    config = await loadConfigImpl(root, { allowMissingKey: true });
  } catch {
    config = {};
  }
  if (!config.apiKey) return withMcpScopes(overrides);
  const result = {
    ...overrides,
    deepseek: {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl
    }
  };
  if (config.models) result.deepseek.models = config.models;
  // M4 #4:FIM betaBase 可配(空串=客户端缺省 ${baseUrl}/beta)。空值不传,
  // 未配置用户行为逐字节不变。
  if (config.betaBase) result.deepseek.betaBase = config.betaBase;
  if (config.limits) result.limits = config.limits;
  if (config.orchestration) result.orchestration = config.orchestration;
  if (config.edits) result.edits = config.edits;
  // M1 A1a:events.strictSchema 透传——不接就是死配置(重蹈 #8 languages 空转)。
  if (config.events) result.events = config.events;
  if (config.mcpServers) result.mcpServers = config.mcpServers;
  // v1.11.2:inputs 定义必须与 mcpServers 一同透传,否则 ${input:*} 无源可解析。
  if (config.inputs) result.inputs = config.inputs;
  result.loadMcpConfigScopes = overrides.loadMcpConfigScopes !== false;
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
