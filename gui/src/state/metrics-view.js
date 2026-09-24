// gui/src/state/metrics-view.js — 对话框状态行的指标推导(纯函数,node:test 覆盖)。
// 设计稿 v4 把「比例型指标」做成 5 形态(文字/数值/进度条/点阵/关闭),此处只算数值与色阶,
// 具体 DOM 交给 MetricsLine。数据源是 kernel 的 usage 快照,没有的指标一律不出现(不编造)。
// v1.9:M2 遥测分列(cacheMiss / reasoningTokens / tps)+ CONTEXT_WINDOW 按模型推导(现行代际 1M)。

export const CONTEXT_WINDOW_LEGACY = 128000;
export const CONTEXT_WINDOW_CURRENT = 1000000;
// 兼容旧引用:默认按现行 DeepSeek 代际(1M)。精确值请用 contextWindowForModel。
export const CONTEXT_WINDOW = CONTEXT_WINDOW_CURRENT;

/** 按模型 id 推导上下文窗口。现行售卖代际(flash / v4-pro / v4.1)= 1M;旧 chat/reasoner= 64k;未知= 128k。 */
export function contextWindowForModel(model) {
  const id = String(model || "").toLowerCase();
  if (!id) return CONTEXT_WINDOW_CURRENT;
  if (id.includes("deepseek-chat") || id.includes("deepseek-reasoner")) return 64000;
  if (id.includes("flash") || id.includes("pro") || id.includes("v4") || id.includes("v4.1")) return CONTEXT_WINDOW_CURRENT;
  return CONTEXT_WINDOW_LEGACY;
}

export function formatPercent(ratio, decimals = 0) {
  const pct = Math.max(0, Math.min(1, Number(ratio) || 0)) * 100;
  return `${pct.toFixed(Math.max(0, Math.min(4, decimals)))}%`;
}

// bigUnits=true → 34.2k / 1.2M;false → 原始数字。
export function formatCount(value, bigUnits = true) {
  const n = Math.max(0, Number(value) || 0);
  if (!bigUnits) return String(n);
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function cacheRatio(usage) {
  const u = usage || {};
  if (typeof u.cache_hit_rate === "number") return Math.max(0, Math.min(1, u.cache_hit_rate));
  const hits = Number(u.cache_hit_tokens) || 0;
  const misses = Number(u.cache_miss_tokens) || 0;
  return hits + misses > 0 ? hits / (hits + misses) : 0;
}

export function totalTokens(usage) {
  const u = usage || {};
  if (typeof u.total_tokens === "number") return u.total_tokens;
  return (Number(u.total_prompt_tokens) || 0) + (Number(u.total_completion_tokens) || 0);
}

function reasonTokens(usage) {
  const u = usage || {};
  return Number(u.total_reasoning_tokens ?? u.reasoning_tokens) || 0;
}

function cacheMissTokens(usage) {
  const u = usage || {};
  return Number(u.cache_miss_tokens) || 0;
}

function tpsOf(usage) {
  const u = usage || {};
  const direct = Number(u.tps ?? u.tokens_per_second);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const completion = Number(u.total_completion_tokens) || 0;
  const latency = Number(u.avg_latency_ms) || 0;
  const requests = Number(u.requests) || 0;
  // 与 TUI deriveTps 同口径(v1.9 M4 #11):avg_latency 是「每请求均值」,
  // 总生成时长 ≈ avg_latency × requests;不除 requests 会把均值当总时长,多请求时虚高。
  if (completion > 0 && latency > 0 && requests > 0) return completion / ((latency / 1000) * requests);
  return 0;
}

// 比例型指标段。每段:{ key, ratio, text, num:{v,u}, tone }。
// tone:accent(默认)/ok(越高越好)/warn(超过阈值的上下文用量)。
// model 可选:用于 contextWindowForModel;不传则用 display.model 或 1M。
export function metricSegments(usage, display, model) {
  const show = (display && display.show) || {};
  const fmt = (display && display.format) || {};
  const decimals = Number.isInteger(fmt.percentDecimals) ? fmt.percentDecimals : 0;
  const tpsDecimals = Number.isInteger(fmt.tpsDecimals) ? Math.max(0, Math.min(2, fmt.tpsDecimals)) : 1;
  const bigUnits = fmt.bigUnits !== false;
  const warnAt = typeof fmt.contextWarnRatio === "number" ? fmt.contextWarnRatio : 0.8;
  const windowSize = contextWindowForModel(model || display?.model);
  const segments = [];

  if (show.context !== false) {
    const tokens = totalTokens(usage);
    const ratio = Math.min(1, tokens / windowSize);
    segments.push({
      key: "context",
      ratio,
      text: `${formatCount(tokens, bigUnits)}/${formatCount(windowSize, bigUnits)}`,
      num: { v: formatCount(tokens, bigUnits), u: `/${formatCount(windowSize, bigUnits)}` },
      percent: formatPercent(ratio, decimals),
      tone: ratio >= warnAt ? "warn" : "accent"
    });
  }

  if (show.cacheHit !== false) {
    const ratio = cacheRatio(usage);
    segments.push({
      key: "cacheHit",
      ratio,
      text: formatPercent(ratio, decimals),
      num: { v: formatPercent(ratio, decimals).replace("%", ""), u: "%" },
      percent: formatPercent(ratio, decimals),
      tone: "ok"
    });
  }

  // v1.9:缓存未命中 token——无数据即不渲染。
  const miss = cacheMissTokens(usage);
  const hits = Number(usage?.cache_hit_tokens) || 0;
  if (show.cacheMiss !== false && (miss > 0 || hits > 0)) {
    const denom = hits + miss;
    const ratio = denom > 0 ? Math.min(1, miss / denom) : 0;
    segments.push({
      key: "cacheMiss",
      ratio,
      text: formatCount(miss, bigUnits),
      num: { v: formatCount(miss, bigUnits), u: "" },
      percent: formatCount(miss, bigUnits),
      tone: "warn"
    });
  }

  // 检索命中率:kernel 暂未上报,没有数据就不显示这一段(而不是显示 0)。
  const retrieval = usage && usage.retrieval;
  if (show.retrievalHit !== false && retrieval && Number(retrieval.total) > 0) {
    const ratio = Math.min(1, Number(retrieval.hit) / Number(retrieval.total));
    segments.push({
      key: "retrievalHit",
      ratio,
      text: `${retrieval.hit}/${retrieval.total}`,
      num: { v: String(retrieval.hit), u: `/${retrieval.total}` },
      percent: formatPercent(ratio, decimals),
      tone: "accent"
    });
  }

  // v1.9:推理 tokens——无数据即不渲染。
  const reasoning = reasonTokens(usage);
  if (show.reasoningTokens !== false && reasoning > 0) {
    const completion = Number(usage?.total_completion_tokens) || 0;
    const ratio = completion > 0 ? Math.min(1, reasoning / completion) : 1;
    segments.push({
      key: "reasoningTokens",
      ratio,
      text: formatCount(reasoning, bigUnits),
      num: { v: formatCount(reasoning, bigUnits), u: "" },
      percent: formatCount(reasoning, bigUnits),
      tone: "accent"
    });
  }

  // v1.9:TPS——无数据即不渲染。bar/dots 形态用 50 t/s 作满刻度参考。
  const tps = tpsOf(usage);
  if (show.tps !== false && tps > 0) {
    const text = tps.toFixed(tpsDecimals);
    segments.push({
      key: "tps",
      ratio: Math.min(1, tps / 50),
      text,
      num: { v: text, u: " t/s" },
      percent: text,
      tone: "accent"
    });
  }

  return segments;
}

// 点阵形态:按格数把比例离散化。
export function dotCells(ratio, count) {
  const total = Math.max(4, Math.min(24, Number(count) || 10));
  const filled = Math.max(0, Math.min(total, Math.round((Number(ratio) || 0) * total)));
  return { total, filled };
}
