export function formatDeepSeekApiError(status, text = "") {
  const parsed = parseErrorBody(text);
  const message = parsed?.error?.message || parsed?.message || truncate(String(text || ""));
  // 402 = 账号余额不足:重试无意义,必须中文明示引导充值,否则用户只看到 DeepSeek API 402。
  const hint = status === 402 ? "（余额不足，请充值后重试）" : "";
  return `DeepSeek API ${status}: ${message || "request failed"}${hint}`;
}
export function createDeepSeekApiError(status, text = "") {
  const error = new Error(formatDeepSeekApiError(status, text));
  error.name = "DeepSeekApiError";
  error.code = "DEEPSEEK_API_ERROR";
  error.status = status;
  error.retryable = isRetryableDeepSeekError({ status });
  return error;
}
export function isRetryableDeepSeekError(errorLike = {}) {
  // 官方扩展 finish_reason:insufficient_system_resource(过载)与 aborted(服务端中止)均可重试。
  if (errorLike.finish_reason === "insufficient_system_resource" || errorLike.finish_reason === "aborted") return true;
  return [408, 409, 425, 429, 500, 502, 503, 504].includes(errorLike.status);
}
function parseErrorBody(text) { try { return JSON.parse(text); } catch { return null; } }
function truncate(text) { return text.length > 220 ? `${text.slice(0, 220)}...` : text; }
