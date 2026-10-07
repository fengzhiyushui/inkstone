// Request execution scope and aggregate budget for orchestration.
// Coordinates physical call attempts, atomic quota reservation, role attribution,
// cancellation propagation, and durable recovery continuations.

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

function combineSignals(sig1, sig2) {
  if (!sig1 && !sig2) return null;
  if (!sig1) return sig2;
  if (!sig2) return sig1;
  if (sig1.aborted) return sig1;
  if (sig2.aborted) return sig2;
  const c = new AbortController();
  const onAbort1 = () => c.abort(sig1.reason);
  const onAbort2 = () => c.abort(sig2.reason);
  sig1.addEventListener("abort", onAbort1, { once: true });
  sig2.addEventListener("abort", onAbort2, { once: true });
  return c.signal;
}

export function createRequestBudget({
  maxTokens = null,
  maxModelCalls = null,
  initialTokens = 0,
  initialModelCalls = 0,
  initialUnknownUsageAttempts = 0,
  initialSettledAttempts = [],
  executionId = null
} = {}) {
  let tokens = initialTokens;
  let modelCalls = initialModelCalls;
  let reservedCalls = 0;
  let reservedTokens = 0;
  let unknownUsageAttempts = initialUnknownUsageAttempts;
  const settledAttempts = new Set(initialSettledAttempts);
  const byRole = {};
  const execId = executionId || `exec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  function ensureRole(r) {
    const roleKey = r || "unknown";
    if (!byRole[roleKey]) byRole[roleKey] = { calls: 0, tokens: 0 };
    return byRole[roleKey];
  }

  function exceeded(estimatedTokens = 0) {
    if (maxTokens != null) {
      if (estimatedTokens > 0 && (tokens + reservedTokens + estimatedTokens) > maxTokens) {
        return { reason: "max_tokens", tokens, max_tokens: maxTokens, reserved_tokens: reservedTokens + estimatedTokens };
      }
      if ((tokens + reservedTokens) >= maxTokens) {
        return { reason: "max_tokens", tokens, max_tokens: maxTokens, reserved_tokens: reservedTokens };
      }
    }
    if (maxModelCalls != null && (modelCalls + reservedCalls) >= maxModelCalls) {
      return { reason: "max_model_calls", model_calls: modelCalls, max_model_calls: maxModelCalls, reserved_calls: reservedCalls };
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
      }
    }

    function settle({ usage = null, error = null } = {}) {
      if (settled) return;
      settled = true;
      if (settledAttempts.has(effectiveAttemptId)) return;
      settledAttempts.add(effectiveAttemptId);

      if (!started) {
        reservedCalls = Math.max(0, reservedCalls - 1);
        modelCalls += 1;
        ensureRole(role).calls += 1;
      }
      reservedTokens = Math.max(0, reservedTokens - (estimatedTokens || 0));

      if (usage && typeof usage === "object") {
        const total = usage.total_tokens || ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0));
        if (typeof total === "number" && total > 0) {
          tokens += total;
          ensureRole(role).tokens += total;
        } else {
          unknownUsageAttempts += 1;
        }
      } else {
        unknownUsageAttempts += 1;
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
    const usage = modelResult?.usage;
    if (usage && typeof usage === "object") {
      const total = usage.total_tokens || ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0));
      if (typeof total === "number" && total > 0) {
        tokens += total;
      } else {
        unknownUsageAttempts += 1;
      }
    } else {
      unknownUsageAttempts += 1;
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

    bound.invoke = async function (messages, options = {}) {
      const combinedSignal = combineSignals(options.signal, controller.signal);
      if (combinedSignal?.aborted) throw abortError();

      const roleToUse = options.role || role;
      const mergedOptions = { ...options, signal: combinedSignal, scope: requestScope, role: roleToUse };

      let fallbackTicket = null;
      if (!gateway._isDeepSeekGateway) {
        budget.check();
        fallbackTicket = budget.reserveCall({ role: roleToUse, attemptId: `mock_${Date.now()}_${Math.random().toString(36).slice(2, 6)}` });
        if (combinedSignal?.aborted) {
          fallbackTicket.cancel();
          throw abortError();
        }
        fallbackTicket.markStarted();
      }

      try {
        const res = await gateway.invoke(messages, mergedOptions);
        if (fallbackTicket) fallbackTicket.settle({ usage: res?.usage });
        return res;
      } catch (err) {
        if (fallbackTicket) fallbackTicket.settle({ error: err });
        throw err;
      }
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
      return gateway.reply(mergedArgs);
    };

    bound.stream = async function (messages, options = {}) {
      const combinedSignal = combineSignals(options.signal, controller.signal);
      if (combinedSignal?.aborted) throw abortError();
      const roleToUse = options.role || role;
      const mergedOptions = { ...options, signal: combinedSignal, scope: requestScope, role: roleToUse };
      return gateway.stream(messages, mergedOptions);
    };

    return bound;
  }

  const requestScope = {
    executionId: budget?.executionId || executionId,
    budget,
    signal: controller.signal,
    abort,
    bindGateway
  };

  return requestScope;
}
