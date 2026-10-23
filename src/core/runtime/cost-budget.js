export function createCostBudget({ maxTokens = null, maxModelCalls = null, initialTokens = 0, initialModelCalls = 0 } = {}) {
  let tokens = initialTokens;
  let modelCalls = initialModelCalls;

  function recordModelResult(modelResult) {
    const usage = modelResult?.usage;
    if (usage) {
      const total = usage.total_tokens
        || ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0));
      tokens += total;
    }
    const callCount = Number.isFinite(modelResult?.attempt_count) && modelResult.attempt_count > 0
      ? Math.trunc(modelResult.attempt_count)
      : 1;
    modelCalls += callCount;
  }

  function exceeded() {
    if (maxTokens != null && tokens >= maxTokens) {
      return { reason: "max_tokens", tokens, max_tokens: maxTokens };
    }
    if (maxModelCalls != null && modelCalls >= maxModelCalls) {
      return { reason: "max_model_calls", model_calls: modelCalls, max_model_calls: maxModelCalls };
    }
    return null;
  }

  function check() {
    const over = exceeded();
    if (over) {
      const err = new Error(`cost budget exceeded: ${over.reason}`);
      err.code = "BUDGET_EXCEEDED";
      err.details = over;
      throw err;
    }
  }

  function snapshot() {
    return { tokens, model_calls: modelCalls, max_tokens: maxTokens, max_model_calls: maxModelCalls };
  }

  return { recordModelResult, check, exceeded, snapshot };
}
