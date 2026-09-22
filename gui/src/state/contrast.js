// gui/src/state/contrast.js — WCAG 相对亮度与对比度(纯函数)。
// 单一实现:GUI 设置›外观(Appearance.jsx,v1.8.1 起由 ThemeHub 并入)的运行时实测
// 与 scripts/check-theme-contrast.mjs 闸门共用这一处,避免把 Node 脚本拉进 Vite 构建。
export function relLum(hex) {
  const v = String(hex || "").replace("#", "");
  const c = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255)
    .map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
export function contrastRatio(a, b) {
  const [hi, lo] = [relLum(a), relLum(b)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
}
