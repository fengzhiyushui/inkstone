// gui/src/state/columns.js — 三列壳层宽度求解(纯函数;数值契约见 v1.8.1 spec §4.0)

export const CENTER_MIN = 400;
export const SIDEBAR_MIN = 264;
export const SIDEBAR_MAX = 420;
export const SIDEBAR_DEFAULT = 280;
export const SIDEBAR_COLLAPSED = 56;
export const SIDEBAR_AUTO_COLLAPSE = 1024;
export const RIGHTBAR_MIN = 300;
export const RIGHTBAR_MAX_RATIO = 0.7;
export const RIGHTBAR_DEFAULT_RATIO = 0.45;

export function clampWidth(px, min, max) {
  return Math.min(max, Math.max(min, Math.round(px)));
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
    const maxRight = Math.min(available, viewport * RIGHTBAR_MAX_RATIO);
    r = clampWidth(rightbar, RIGHTBAR_MIN, maxRight);
  }
  const center = Math.max(0, viewport - s - r);
  return { sidebar: s, center, rightbar: r };
}
