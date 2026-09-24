import { CURRENT_MODELS } from "./model-ids.js";

// 保留命名导出:路由默认模型统一取自单一常量源 model-ids.js(v1.9.0 M1-P0),
// 消除「config 显示 A、实际发 B」的双源头漂移;deepseek-v4-flash 已退役。
export const DEFAULT_MODELS = CURRENT_MODELS;

// 通道参数画像(source of truth)。think 通道(plan/review/repair)只声明 thinking + reasoning_effort,
// **不声明 temperature**:官方协议下 thinking 开启时 temperature/presence_penalty/frequency_penalty
// 静默无效,传了就是死参数(还会掩盖「忘记关 thinking」的配置错误)。非 thinking 通道(reply/act)
// 的 temperature 由本表显式钉住;fim 通道无 sampling 参数。
// max_tokens:v1.9 M4 #9 把 think 通道从 8192 抬到 32768——官方 thinking 默认输出 64K
// (effort=max 128K、上限 384K),8192 对长推理是硬截断;32768 对默认档留足余量又不触顶。
const CHANNELS = {
  reply: { purpose: "reply", channel: "act", thinking: { type: "disabled" }, temperature: 0.2, max_tokens: 4096, stream: true },
  act: { purpose: "act", channel: "act", thinking: { type: "disabled" }, temperature: 0.1, max_tokens: 4096, stream: true },
  plan: { purpose: "plan", channel: "think", thinking: { type: "enabled" }, reasoning_effort: "high", max_tokens: 32768, stream: false },
  review: { purpose: "review", channel: "think", thinking: { type: "enabled" }, reasoning_effort: "high", max_tokens: 32768, stream: false },
  repair: { purpose: "repair", channel: "think", thinking: { type: "enabled" }, reasoning_effort: "high", max_tokens: 32768, stream: false },
  fim: { purpose: "fim", channel: "fim", max_tokens: 4096 }
};

export function routeModel({ purpose = "reply", complexity = "normal", explicitModel = null, models } = {}) {
  const key = purpose === "reply" && complexity === "high" ? "plan" : purpose;
  const profile = CHANNELS[key];
  if (!profile) throw new Error(`unknown DeepSeek purpose: ${purpose}`);
  const m = { ...DEFAULT_MODELS, ...models };
  return removeUndefined({ ...profile, purpose, model: explicitModel || m[profile.channel] });
}

export function buildChannelParams(input = {}) {
  const route = routeModel(input);
  return removeUndefined({ model: route.model, thinking: route.thinking, reasoning_effort: route.reasoning_effort, temperature: route.temperature, max_tokens: route.max_tokens });
}

export function removeUndefined(record) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}
