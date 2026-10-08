// Request execution scope and aggregate budget for orchestration.
// Coordinates physical call attempts, atomic quota reservation, role attribution,
// token estimation, cancellation propagation, and durable recovery continuations.

function createBudgetExceededError(over) {
  const err = new Error(`cost budget exceeded: ${over.reason}`);
  err.code = "BUDGET_EXCEEDED";
  err.details = over;
  return err;
}

function abortError(reason = "This operation was aborted") {
  const err = new Error(reason);
  err.name = "AbortError";
  err.code = "ABORT";
  return err;
}

export function combineSignals(sig1, sig2) {
  const valid1 = sig1 && typeof sig1.addEventListener === "function";
  const valid2 = sig2 && typeof sig2.addEventListener === "function";
  if (!valid1 && !valid2) return null;
  if (!valid1) return sig2;
  if (!valid2) return sig1;
  if (sig1.aborted) return sig1;
  if (sig2.aborted) return sig2;
  const c = new AbortController();
  const onAbort1 = () => c.abort(sig1.reason);
  const onAbort2 = () => c.abort(sig2.reason);
  sig1.addEventListener("abort", onAbort1, { once: true });
  sig2.addEventListener("abort", onAbort2, { once: true });
  return c.signal;
}

export function normalizeUsageTokens(usage) {
  if (!usage || typeof usage !== "object") return null;
  const pt = usage.prompt_tokens;
  const ct = usage.completion_tokens;
  const tt = usage.total_tokens;

  // 严格检查负数与非有限数
  if (pt !== undefined && (!Number.isFinite(pt) || pt < 0)) return null;
  if (ct !== undefined && (!Number.isFinite(ct) || ct < 0)) return null;
  if (tt !== undefined && (!Number.isFinite(tt) || tt < 0)) return null;

  const validPt = Number.isFinite(pt) && pt >= 0;
  const validCt = Number.isFinite(ct) && ct >= 0;
  const validTt = Number.isFinite(tt) && tt >= 0;

  if (validPt && validCt) {
    const sum = pt + ct;
    if (validTt) {
      return Math.max(sum, tt);
    }
    return sum;
  }
  if (validTt) return tt;
  return null;
}

export function createRequestBudget({
  maxTokens = null,
  maxModelCalls = null,
  initialTokens = 0,
  initialModelCalls = 0,
  initialUnknownUsageAttempts = 0,
  initialUnknownUsageTokens = null,
  initialSettledAttempts = [],
  initialByRole = {},
  fallbackTokensPerUnknown = null,
  executionId = null
} = {}) {
  let tokens = Number.isFinite(initialTokens) && initialTokens >= 0 ? initialTokens : 0;
  let modelCalls = Number.isFinite(initialModelCalls) && initialModelCalls >= 0 ? initialModelCalls : 0;
  let reservedCalls = 0;
  let reservedTokens = 0;
  let unknownUsageAttempts = Number.isFinite(initialUnknownUsageAttempts) && initialUnknownUsageAttempts >= 0 ? initialUnknownUsageAttempts : 0;
  const settledAttempts = new Set(Array.isArray(initialSettledAttempts) ? initialSettledAttempts : []);
  const byRole = {};
  const execId = executionId || `exec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  // 未知费用保底估算（fallbackTokensPerUnknown）：若无显式设置且有 maxTokens，按 min(maxTokens, 500) 保守计算
  const fallbackTokens = Number.isFinite(fallbackTokensPerUnknown) && fallbackTokensPerUnknown > 0
    ? fallbackTokensPerUnknown
    : (maxTokens != null ? Math.min(maxTokens, 500) : 500);

  let unknownUsageTokens = (Number.isFinite(initialUnknownUsageTokens) && initialUnknownUsageTokens >= 0)
    ? Math.max(initialUnknownUsageTokens, (initialUnknownUsageAttempts || 0) * fallbackTokens)
    : ((Number.isFinite(initialUnknownUsageAttempts) && initialUnknownUsageAttempts > 0)
      ? initialUnknownUsageAttempts * fallbackTokens
      : 0);

  if (initialByRole && typeof initialByRole === "object") {
    for (const [r, stats] of Object.entries(initialByRole)) {
      if (stats && typeof stats === "object") {
        byRole[r] = {
          calls: Number.isFinite(stats.calls) && stats.calls >= 0 ? stats.calls : 0,
          tokens: Number.isFinite(stats.tokens) && stats.tokens >= 0 ? stats.tokens : 0
        };
      }
    }
  }

  function ensureRole(r) {
    const roleKey = r || "unknown";
    if (!byRole[roleKey]) byRole[roleKey] = { calls: 0, tokens: 0 };
    return byRole[roleKey];
  }

  function exceeded(estimatedTokens = 0) {
    const est = Number.isFinite(estimatedTokens) && estimatedTokens > 0 ? estimatedTokens : 0;
    const effectiveTokens = tokens + reservedTokens + unknownUsageTokens;
    if (maxTokens != null) {
      if (est > 0 && (effectiveTokens + est) > maxTokens) {
        return {
          reason: "max_tokens",
          tokens,
          effective_tokens: effectiveTokens + est,
          unknown_usage_attempts: unknownUsageAttempts,
          max_tokens: maxTokens,
          reserved_tokens: reservedTokens + est
        };
      }
      if (effectiveTokens >= maxTokens) {
        return {
          reason: "max_tokens",
          tokens,
          effective_tokens: effectiveTokens,
          unknown_usage_attempts: unknownUsageAttempts,
          max_tokens: maxTokens,
          reserved_tokens: reservedTokens
        };
      }
    }
    if (maxModelCalls != null && (modelCalls + reservedCalls) >= maxModelCalls) {
      return {
        reason: "max_model_calls",
        model_calls: modelCalls,
        max_model_calls: maxModelCalls,
        reserved_calls: reservedCalls
      };
    }
    return null;
  }

  function check(estimatedTokens = 0) {
    const over = exceeded(estimatedTokens);
    if (over) {
      throw createBudgetExceededError(over);
    }
  }

  function reserveCall({ role = "unknown", attemptId = null, estimatedTokens = 0, signal = null } = {}) {
    if (signal?.aborted) {
      throw abortError(signal.reason);
    }
    const effectiveAttemptId = attemptId || `att_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    if (settledAttempts.has(effectiveAttemptId)) {
      return {
        attemptId: effectiveAttemptId,
        role,
        ok: true,
        alreadySettled: true,
        markStarted: () => {},
        cancel: () => {},
        settle: () => {}
      };
    }
    check(estimatedTokens);
    reservedCalls += 1;
    reservedTokens += (estimatedTokens || 0);

    let started = false;
    let settled = false;

    function markStarted() {
      if (started || settled) return;
      started = true;
      reservedCalls = Math.max(0, reservedCalls - 1);
      modelCalls += 1;
      ensureRole(role).calls += 1;
    }

    function cancel() {
      if (settled) return;
      settled = true;
      if (!started) {
        reservedCalls = Math.max(0, reservedCalls - 1);
        reservedTokens = Math.max(0, reservedTokens - (estimatedTokens || 0));
      } else {
        reservedTokens = Math.max(0, reservedTokens - (estimatedTokens || 0));
        unknownUsageAttempts += 1;
        const unknownCharge = Math.max(fallbackTokens, estimatedTokens || 0);
        unknownUsageTokens += unknownCharge;
        ensureRole(role).tokens += unknownCharge;
      }
    }

    function settle({ usage = null, error = null } = {}) {
      if (settled) return;
      settled = true;
      if (settledAttempts.has(effectiveAttemptId)) return;
      settledAttempts.add(effectiveAttemptId);
      // 有界保护：限制最近 1000 个 settledAttempts，防止长生命周期内存持续膨胀
      if (settledAttempts.size > 1000) {
        const first = settledAttempts.values().next().value;
        settledAttempts.delete(first);
      }

      if (!started) {
        reservedCalls = Math.max(0, reservedCalls - 1);
        modelCalls += 1;
        ensureRole(role).calls += 1;
      }
      reservedTokens = Math.max(0, reservedTokens - (estimatedTokens || 0));

      const validTotal = normalizeUsageTokens(usage);
      if (validTotal != null && validTotal >= 0) {
        tokens += validTotal;
        ensureRole(role).tokens += validTotal;
      } else {
        unknownUsageAttempts += 1;
        const unknownCharge = Math.max(fallbackTokens, estimatedTokens || 0);
        unknownUsageTokens += unknownCharge;
        ensureRole(role).tokens += unknownCharge;
      }
    }

    return {
      attemptId: effectiveAttemptId,
      role,
      ok: true,
      markStarted,
      cancel,
      settle
    };
  }

  function recordModelResult(modelResult) {
    const validTotal = normalizeUsageTokens(modelResult?.usage);
    if (validTotal != null && validTotal >= 0) {
      tokens += validTotal;
    } else {
      unknownUsageAttempts += 1;
      unknownUsageTokens += fallbackTokens;
    }
    modelCalls += 1;
  }

  function snapshot() {
    return {
      tokens,
      model_calls: modelCalls,
      max_tokens: maxTokens,
      max_model_calls: maxModelCalls,
      reserved_calls: reservedCalls,
      reserved_tokens: reservedTokens,
      unknown_usage_attempts: unknownUsageAttempts,
      unknown_usage_tokens: unknownUsageTokens,
      effective_tokens: tokens + unknownUsageTokens,
      fallback_tokens_per_unknown: fallbackTokens,
      execution_id: execId,
      settled_attempts: [...settledAttempts],
      by_role: JSON.parse(JSON.stringify(byRole))
    };
  }

  return {
    executionId: execId,
    check,
    exceeded,
    reserveCall,
    recordModelResult,
    snapshot
  };
}

export function createRequestScope({
  budget,
  signal = null,
  executionId = null
} = {}) {
  const controller = new AbortController();
  if (signal) {
    if (signal.aborted) {
      controller.abort(signal.reason);
    } else {
      signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
    }
  }

  function abort(reason = "turn was interrupted") {
    if (!controller.signal.aborted) {
      controller.abort(reason);
    }
  }

  function bindGateway(gateway, { role = "worker", subtaskId = null } = {}) {
    if (!gateway) return null;
    const bound = Object.create(gateway);

    // 辅助函数：统一为非 DeepSeek 自定义网关执行 fallback ticket 的包装
    async function withFallbackTicket(roleToUse, fn) {
      if (gateway._isDeepSeekGateway || !budget) {
        return fn();
      }
      let fallbackEstimatedTokens = 500;
      switch (roleToUse) {
        case "router": fallbackEstimatedTokens = 200; break;
        case "planner": fallbackEstimatedTokens = 1000; break;
        case "worker": fallbackEstimatedTokens = 1500; break;
        case "reviewer": fallbackEstimatedTokens = 500; break;
        case "synthesizer": fallbackEstimatedTokens = 800; break;
        default: fallbackEstimatedTokens = 500;
      }
      budget.check(fallbackEstimatedTokens);
      const ticket = budget.reserveCall({
        role: roleToUse,
        attemptId: `mock_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        estimatedTokens: fallbackEstimatedTokens,
        signal: controller.signal
      });
      if (controller.signal.aborted) {
        ticket.cancel();
        throw abortError();
      }
      ticket.markStarted();
      try {
        const res = await fn();
        ticket.settle({ usage: res?.usage });
        return res;
      } catch (err) {
        ticket.settle({ error: err });
        throw err;
      }
    }

    bound.invoke = async function (messages, options = {}) {
      const combinedSignal = combineSignals(options.signal, controller.signal);
      if (combinedSignal?.aborted) throw abortError();

      const roleToUse = options.role || role;
      const mergedOptions = { ...options, signal: combinedSignal, scope: requestScope, role: roleToUse };

      if (options._fallbackScoped || gateway._isDeepSeekGateway) {
        return gateway.invoke(messages, mergedOptions);
      }
      mergedOptions._fallbackScoped = true;
      return withFallbackTicket(roleToUse, () => gateway.invoke(messages, mergedOptions));
    };

    bound.reply = async function (args = {}) {
      const combinedSignal = combineSignals(args.signal, controller.signal);
      if (combinedSignal?.aborted) throw abortError();
      const roleToUse = args.options?.role || role;
      const mergedArgs = {
        ...args,
        signal: combinedSignal,
        options: { ...args.options, scope: requestScope, role: roleToUse }
      };

      if (args._fallbackScoped || args.options?._fallbackScoped || gateway._isDeepSeekGateway) {
        return gateway.reply(mergedArgs);
      }
      mergedArgs._fallbackScoped = true;
      return withFallbackTicket(roleToUse, () => gateway.reply(mergedArgs));
    };

    bound.stream = async function (messages, options = {}) {
      const combinedSignal = combineSignals(options.signal, controller.signal);
      if (combinedSignal?.aborted) throw abortError();
      const roleToUse = options.role || role;
      const mergedOptions = { ...options, signal: combinedSignal, scope: requestScope, role: roleToUse };

      if (options._fallbackScoped || gateway._isDeepSeekGateway) {
        return gateway.stream(messages, mergedOptions);
      }
      mergedOptions._fallbackScoped = true;
      return withFallbackTicket(roleToUse, () => gateway.stream(messages, mergedOptions));
    };

    return bound;
  }

  const requestScope = {
    executionId: budget?.executionId || executionId || `exec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    budget,
    signal: controller.signal,
    abort,
    bindGateway
  };

  return requestScope;
}
