// gui/src/state/columns.js — 三列壳层宽度求解(纯函数;数值契约见 v1.8.1 spec §4.0)

export const CENTER_MIN = 400;
export const SIDEBAR_MIN = 264;
export const SIDEBAR_MAX = 420;
export const SIDEBAR_DEFAULT = 280;
export const SIDEBAR_COLLAPSED = 56;
export const SIDEBAR_AUTO_COLLAPSE = 1024;
export const RIGHTBAR_MIN = 300;
export const RIGHTBAR_MAX = 1600;
export const RIGHTBAR_MAX_RATIO = 0.7;
export const RIGHTBAR_DEFAULT_RATIO = 0.45;

export function clampWidth(px, min, max) {
  const n = Math.round(Number(px));
  const safe = Number.isFinite(n) ? n : min;
  // max < min 时保下限,避免拖拽/窄窗把列宽打到契约外
  const hi = Math.max(min, max);
  return Math.min(hi, Math.max(min, safe));
}

/**
 * @param {number} viewport  视口宽(px)
 * @param {number} sidebar   侧栏偏好宽;0 → 折叠轨(或 collapsedWidth)
 * @param {number} rightbar  右栏偏好宽;0 / 挤不下 → 0
 * @param {number} collapsedWidth  折叠轨宽,默认 56;传 0 则侧栏列完全隐藏
 */
export function computeColumns(viewport, sidebar, rightbar, collapsedWidth = SIDEBAR_COLLAPSED) {
  const s = !sidebar ? collapsedWidth : clampWidth(sidebar, SIDEBAR_MIN, SIDEBAR_MAX);
  const available = viewport - s - CENTER_MIN;
  let r = 0;
  if (rightbar > 0 && available >= RIGHTBAR_MIN) {
    const ratioMax = viewport * RIGHTBAR_MAX_RATIO;
    const maxRight = Math.max(RIGHTBAR_MIN, Math.min(available, ratioMax, RIGHTBAR_MAX));
    r = clampWidth(rightbar, RIGHTBAR_MIN, maxRight);
  }
  const center = Math.max(0, viewport - s - r);
  return { sidebar: s, center, rightbar: r };
}

/** 右栏拖拽宽:夹到 [RIGHTBAR_MIN, min(viewport*0.7, RIGHTBAR_MAX)] */
export function clampRightbarWidth(px, viewport) {
  const vp = Number(viewport);
  const maxRight = Math.max(
    RIGHTBAR_MIN,
    Math.min(Number.isFinite(vp) && vp > 0 ? vp * RIGHTBAR_MAX_RATIO : RIGHTBAR_MAX, RIGHTBAR_MAX)
  );
  return clampWidth(px, RIGHTBAR_MIN, maxRight);
}
