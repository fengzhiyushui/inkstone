import { routeModel, buildChannelParams, removeUndefined } from "./model-router.js";
import { applyJsonMode } from "./json-mode.js";
import { createUsageTracker } from "./usage-tracker.js";
import { createDeepSeekApiError, isRetryableDeepSeekError } from "./api-errors.js";
import { readDeepSeekStream } from "./streaming.js";
import { createFimClient } from "./fim-client.js";
import { normalizeToolCalls } from "./tool-call-repair.js";
import { assembleReplyMessages } from "./prompt-assembler.js";

export function createDeepSeekGateway({ apiKey = process.env.DEEPSEEK_API_KEY || "", baseUrl = "https://api.deepseek.com", betaBase, fetchImpl = globalThis.fetch, userId = null, models, sleepFn = defaultSleep } = {}) {
  const usageTracker = createUsageTracker();
  // M4 #4:betaBase 透传给 FIM 客户端(undefined=客户端缺省 ${baseUrl}/beta/completions)。
  const fimClient = createFimClient({ apiKey, baseUrl, betaBase, fetchImpl });

  function buildChatRequest(messages, options = {}) {
    const routed = { ...options, models: options.models ?? models };
    const route = routeModel(routed);
    const body = applyJsonMode({ messages, jsonMode: Boolean(options.jsonMode), body: removeUndefined({ ...buildChannelParams(routed), messages, stream: Boolean(options.stream ?? route.stream), tools: options.tools, tool_choice: options.toolChoice, user_id: userId }) });
    if (body.stream) body.stream_options = { include_usage: true };
    return { url: `${baseUrl.replace(/\/+$/, "")}/chat/completions`, body, route };
  }

  // M4 #12:首字节前(HTTP 头阶段)的有限指数退避重试——.retryable 标志自 v1.x 起
  // 首次有执行端。最多 RETRY_MAX_ATTEMPTS 次尝试(首次+2 重试),退避序列
  // 500ms→1000ms(指数,上限 8s);402/400/401/403 等不可重试错误直接抛。
  // 重试期间尊重 options.signal:已 abort 则不进入重试并以 ABORT 收场,
  // 退避等待中 abort 同样立即抛 ABORT。每次重试都新建 timeout(didTimeout
  // 语义=单次尝试内超时;MODEL_TIMEOUT 不可重试,原样抛出)。
  // 返回 { response, timeout }:成功 attempt 的 timeout 不在此清理,由调用方在
  // body 解析/流读取结束后 cleanup(body 阶段的 abort 必须仍能取消读取)。
  async function fetchChatWithRetry(request, options) {
    let attempts = 0;
    while (true) {
      attempts += 1;
      const timeout = withTimeout(options.signal, options.timeoutMs);
      let response;
      try {
        try {
          response = await fetchImpl(request.url, { method: "POST", headers: authHeaders(apiKey), body: JSON.stringify(request.body), signal: timeout.signal });
        } catch (error) {
          if (timeout.didTimeout()) throw modelTimeoutError(options.timeoutMs);
          throw error;
        }
        if (!response.ok) throw createDeepSeekApiError(response.status, await response.text().catch(() => ""));
      } catch (error) {
        timeout.cleanup();
        const retryable = isRetryableDeepSeekError(error) || error?.retryable === true;
        if (attempts < RETRY_MAX_ATTEMPTS && retryable) {
          if (options.signal?.aborted) throw abortError();
          await sleepFn(backoffDelayMs(attempts), options.signal);
          continue;
        }
        throw error;
      }
      return { response, timeout };
    }
  }

  async function invoke(messages, options = {}) {
    const request = buildChatRequest(messages, { ...options, stream: false });
    const started = Date.now();
    let attempts = 0;
    let jsonAttempts = 0;
    while (true) {
      attempts += 1;
      // fetch 阶段走有限退避重试;MODEL_TIMEOUT/调用方 abort 等不可重试错误直接穿传。
      const { response, timeout } = await fetchChatWithRetry(request, options);
      try {
        const latencyMs = Date.now() - started;
        let payload;
        try {
          payload = await response.json();
        } catch (error) {
          if (timeout.didTimeout()) throw modelTimeoutError(options.timeoutMs);
          throw error;
        }
        const processed = markTruncated(processChatPayload(payload, request.route, latencyMs));
        if (isRetryableDeepSeekError({ finish_reason: processed.finish_reason })) processed.retryable = true;
        // JSON 模式空 content:同一 request 原样重发(共最多 JSON_EMPTY_MAX_ATTEMPTS 次);
        // 退避固定 300ms 并遵守 signal;仍空则挂 emptyContent 返回,不抛错。
        if (options.jsonMode && processed.content === "" && !processed.retryable) {
          jsonAttempts += 1;
          if (jsonAttempts < JSON_EMPTY_MAX_ATTEMPTS && attempts < RETRY_MAX_ATTEMPTS) {
            await sleepFn(JSON_EMPTY_RETRY_DELAY_MS, options.signal);
            continue;
          }
          processed.emptyContent = true;
        }
        // 重试逻辑不重复计费用:仅最终返回的 attempt 记录一次 usage。
        usageTracker.recordUsage({ usage: processed.usage, channel: request.route.channel, model: request.body.model, latency_ms: latencyMs });
        return processed;
      } finally {
        timeout.cleanup();
      }
    }
  }

  async function stream(messages, options = {}) {
    const request = buildChatRequest(messages, { ...options, stream: true });
    const started = Date.now();
    // 只对首字节前(fetch 抛错/非 2xx)应用退避重试;body 开始读取后失败不重试——
    // 已通过 onDelta 吐出的增量无法收回,重发等于重复输出。
    const { response, timeout } = await fetchChatWithRetry(request, options);
    try {
      const latencyMs = Date.now() - started;
      // Keep the timeout armed across the SSE body read: the fetch resolves on headers,
      // so the body is consumed after — an abort here (timeout or caller) must cancel
      // the reader and surface as MODEL_TIMEOUT / the original AbortError.
      let streamed;
      try {
        streamed = await readDeepSeekStream(response.body, { onDelta: options.onDelta, signal: timeout.signal });
      } catch (error) {
        if (timeout.didTimeout()) throw modelTimeoutError(options.timeoutMs);
        throw error;
      }
      const result = markTruncated({ ...streamed, model: request.body.model, channel: request.route.channel, latency_ms: latencyMs, tool_calls: normalizeToolCalls(streamed.tool_calls) });
      usageTracker.recordUsage({ usage: result.usage, channel: request.route.channel, model: request.body.model, latency_ms: latencyMs });
      return result;
    } finally {
      timeout.cleanup();
    }
  }

  async function fimComplete(prefix, suffix = "", options = {}) {
    const resolvedModels = options.models ?? models;
    const timeout = withTimeout(options.signal, options.timeoutMs);
    try {
      // fim-client 的 fetch 拿到 timeout.signal,故超时同时约束请求与 body 解析,
      // 与 invoke / stream 语义一致(不传 timeoutMs 则不设超时)。
      let result;
      try {
        result = await fimClient.complete({ prefix, suffix, model: options.model ?? resolvedModels?.fim, maxTokens: options.maxTokens, signal: timeout.signal });
      } catch (error) {
        if (timeout.didTimeout()) throw modelTimeoutError(options.timeoutMs);
        throw error;
      }
      usageTracker.recordUsage({ usage: result.usage, channel: "fim", model: result.model, latency_ms: result.latency_ms || 0 });
      return result.content;
    } finally {
      timeout.cleanup();
    }
  }

  async function reply({ message, classification, context, turn, options = {}, signal, onDelta } = {}) {
    const messages = assembleReplyMessages({ message, classification, context, turn, history: options.history });
    const taskType = classification?.task_type || "general";
    const purpose = taskType === "query" ? "reply" : "plan";
    const result = await invoke(messages, { purpose, signal, timeoutMs: options.timeoutMs });
    if (onDelta && result.content) onDelta(result.content);
    return result;
  }

  return { buildChatRequest, invoke, stream, fimComplete, reply, getUsageStats: usageTracker.getUsageStats };
}

function processChatPayload(payload, route, latencyMs) {
  const choice = payload.choices?.[0] || {};
  const message = choice.message || {};
  return { content: message.content || "", reasoning_content: message.reasoning_content || null, reasoning_hidden: true, tool_calls: normalizeToolCalls(message.tool_calls || []), finish_reason: choice.finish_reason || null, usage: payload.usage || null, model: payload.model || route.model, channel: route.channel, latency_ms: latencyMs };
}

function authHeaders(apiKey) { return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }; }

function withTimeout(callerSignal, timeoutMs) {
  if (!timeoutMs) return { signal: callerSignal, cleanup: () => {}, didTimeout: () => false };
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      if (callerSignal) callerSignal.removeEventListener("abort", onAbort);
    },
    didTimeout: () => timedOut
  };
}

function modelTimeoutError(timeoutMs) {
  const err = new Error(`model request timed out after ${timeoutMs}ms`);
  err.code = "MODEL_TIMEOUT";
  return err;
}

function abortError() { const error = new Error("DeepSeek request was aborted"); error.name = "AbortError"; error.code = "ABORT_ERR"; return error; }

// v1.9.0 M4 #12 重试参数:最多 3 次尝试(首次+2 重试),指数退避基 500ms、上限 8s。
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 8000;
// M4 #7:JSON 模式空 content 最多重发 1 次(共 2 次尝试),固定间隔 300ms。
const JSON_EMPTY_MAX_ATTEMPTS = 2;
const JSON_EMPTY_RETRY_DELAY_MS = 300;

// retryIndex 从 1 起(第 1 次重试):500ms、1000ms……指数翻倍并钳制在上限 8s。
function backoffDelayMs(retryIndex) { return Math.min(RETRY_BASE_DELAY_MS * 2 ** (retryIndex - 1), RETRY_MAX_DELAY_MS); }

// 可注入的退避 sleep(测试传即刻 resolve 的实现);默认实现在等待期间监听 signal,
// abort 即拒(ABORT),不让调用方在退避窗口里无限等待一个已取消的回合。
function defaultSleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { if (signal) signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

// finish_reason === "length" = 输出被 max_tokens 截断;仅此值挂 truncated,
// 其余 finish_reason 不加键(调用方 `in`/hasOwn 检查保持干净)。只挂返回值,
// 不进 model:response 事件载荷(M1 冻结契约)。
function markTruncated(result) {
  if (result.finish_reason === "length") result.truncated = true;
  return result;
}
