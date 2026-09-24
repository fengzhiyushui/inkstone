// gui/src/state/status-display.js — 「状态显示」偏好 schema(设计 spec §4.2:4 组、22 项)。
// 纯函数,node:test 覆盖;组件按此渲染形态与开关。
export const STATUS_FORMS = ["text", "num", "bar", "dots", "off"]; // 指标展示形态(5 选 1)
export const STATUS_POSITIONS = ["composer", "statusbar", "both"]; // 显示位置
export const STATUS_TOGGLES = [ // 显示哪些信息(14 个独立开关;cacheMiss/reasoningTokens/tps 为 v1.9 遥测分列)
  "branch", "checkpoint", "connection", "context", "cacheHit", "cacheMiss", "retrievalHit",
  "reasoningTokens", "tps",
  "turnTime", "turnChanges", "model", "theme", "language"
];

export const STATUS_DISPLAY_DEFAULTS = {
  form: "bar",             // 默认进度条(设计稿默认)
  position: "composer",    // 默认嵌入对话框(.cz-meta)
  fadeIdle: false,         // 空闲淡出
  compact: false,          // 紧凑模式
  show: {                  // 与设计稿的开关默认一致:本轮耗时/本轮改动数默认关(状态行已足够长)
    branch: true, checkpoint: true, connection: true, context: true,
    cacheHit: true, cacheMiss: true, retrievalHit: true,
    reasoningTokens: true, tps: true,
    turnTime: false, turnChanges: false,
    model: false, theme: true, language: true
  },
  format: {                // 数值与格式
    percentDecimals: 0,    // 百分比小数位
    bigUnits: true,        // 大数字单位(k/M)
    contextWarnRatio: 0.8, // 上下文告警阈值
    dotsCount: 10,         // 点阵格数
    tpsDecimals: 1         // TPS 小数位(v1.9)
  }
};

export function normalizeStatusDisplay(input, fallback = STATUS_DISPLAY_DEFAULTS) {
  if (!input || typeof input !== "object") {
    return { ...fallback, show: { ...fallback.show }, format: { ...fallback.format } };
  }
  const show = { ...fallback.show };
  for (const key of STATUS_TOGGLES) {
    if (typeof input.show?.[key] === "boolean") show[key] = input.show[key];
  }
  const format = { ...fallback.format };
  const f = input.format || {};
  if (Number.isInteger(f.percentDecimals)) format.percentDecimals = Math.max(0, Math.min(4, f.percentDecimals));
  if (typeof f.bigUnits === "boolean") format.bigUnits = f.bigUnits;
  if (typeof f.contextWarnRatio === "number") format.contextWarnRatio = Math.max(0, Math.min(1, f.contextWarnRatio));
  if (Number.isInteger(f.dotsCount)) format.dotsCount = Math.max(4, Math.min(24, f.dotsCount));
  if (Number.isInteger(f.tpsDecimals)) format.tpsDecimals = Math.max(0, Math.min(2, f.tpsDecimals));
  return {
    form: STATUS_FORMS.includes(input.form) ? input.form : fallback.form,
    position: STATUS_POSITIONS.includes(input.position) ? input.position : fallback.position,
    fadeIdle: typeof input.fadeIdle === "boolean" ? input.fadeIdle : fallback.fadeIdle,
    compact: typeof input.compact === "boolean" ? input.compact : fallback.compact,
    show,
    format
  };
}

export function cloneStatusDisplay(display) {
  return normalizeStatusDisplay(display, display || STATUS_DISPLAY_DEFAULTS);
}
