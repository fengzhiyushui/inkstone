import { createDeepSeekApiError } from "./api-errors.js";

// M1-P0:旧默认 deepseek-v4-pro 是浪费(FIM 官方仅 non-thinking,Flash 档足够);
// max_tokens 512 过小,与 model-router.js 的 fim 通道一并抬到 4096。
const FIM_MAX_TOKENS = 4096;

export function buildFimRequest({ prefix, suffix = "", model = "deepseek-flash", maxTokens = FIM_MAX_TOKENS } = {}) {
  if (typeof prefix !== "string" || prefix.length === 0) throw new Error("FIM prefix must be a non-empty string");
  const max_tokens = Number.isFinite(maxTokens) ? Math.min(Math.max(1, Math.trunc(maxTokens)), FIM_MAX_TOKENS) : FIM_MAX_TOKENS;
  return removeUndefined({ model, prompt: prefix, suffix, max_tokens });
}

// v1.9.0 M4:betaBase 可配(代理/自建网关可能只在裸 /completions 上暴露 beta 模型);
// 缺省时逐字节维持旧行为 `${baseUrl 去尾斜杠}/beta/completions`。
export function resolveBetaCompletionsUrl(baseUrl, betaBase) {
  const explicitBase = typeof betaBase === "string" ? betaBase.replace(/\/+$/, "") : "";
  const prefix = explicitBase || `${baseUrl.replace(/\/+$/, "")}/beta`;
  return `${prefix}/completions`;
}

export function createFimClient({ apiKey, baseUrl = "https://api.deepseek.com", betaBase, fetchImpl = globalThis.fetch } = {}) {
  const completionsUrl = resolveBetaCompletionsUrl(baseUrl, betaBase);
  async function complete({ prefix, suffix = "", model, maxTokens, signal } = {}) {
    const body = buildFimRequest({ prefix, suffix, model, maxTokens });
    const started = Date.now();
    const response = await fetchImpl(completionsUrl, { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
    const latencyMs = Date.now() - started;
    if (!response.ok) throw createDeepSeekApiError(response.status, await response.text().catch(() => ""));
    const payload = await response.json();
    return { content: payload.choices?.[0]?.text || "", usage: payload.usage || null, model: body.model, channel: "fim", latency_ms: latencyMs };
  }
  return { complete };
}

function removeUndefined(record) { return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)); }
