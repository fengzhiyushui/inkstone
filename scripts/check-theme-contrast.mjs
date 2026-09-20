// scripts/check-theme-contrast.mjs — v1.8.0 主题对比度闸门(v1.4 spec §3.2 的 11 对 × 10 套 = 110 项)。
// 用法:node scripts/check-theme-contrast.mjs  → 打印表格,任一不过 exit 1。被测试 import 时只导出纯函数。
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
// 亮度/对比度实现单一来源:与 GUI ThemeHub 的运行时实测共用(避免把本脚本拉进 Vite 构建)。
import { relLum, contrastRatio } from "../gui/src/state/contrast.js";
export { relLum, contrastRatio };
// 11 对:[名, 前景槽, 背景槽, min, max]
export const GATE = [
  ["text/bg-base", "text", "bg-base", 7, 19.5],
  ["text/bg-panel", "text", "bg-panel", 7, 19.5],
  ["text-mut/bg-base", "text-mut", "bg-base", 4.5, Infinity],
  ["text-faint/bg-base", "text-faint", "bg-base", 3, Infinity],
  ["accent/bg-base", "accent", "bg-base", 3, Infinity],
  ["accent-text/accent", "accent-text", "accent", 4.5, Infinity],
  ["ok/bg-base", "ok", "bg-base", 3, Infinity],
  ["warn/bg-base", "warn", "bg-base", 3, Infinity],
  ["err/bg-base", "err", "bg-base", 3, Infinity],
  ["info/bg-base", "info", "bg-base", 3, Infinity],
  ["border-strong/bg-base", "border-strong", "bg-base", 1.5, Infinity]
];
export function parseThemes(css) {
  return [...css.matchAll(/\[theme="(\w+)"\]\s*\{([^}]*)\}/g)].map(([, id, body]) => {
    const vars = {};
    for (const [, k, v] of body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) vars[k] = v.trim();
    return { id, vars };
  });
}
export function checkThemes(css) {
  const rows = [];
  for (const { id, vars } of parseThemes(css)) {
    for (const [pair, fg, bg, min, max] of GATE) {
      const value = +contrastRatio(vars[fg], vars[bg]).toFixed(2);
      rows.push({ theme: id, pair, value, min, max, pass: value >= min && value <= max });
    }
  }
  return { ok: rows.every((r) => r.pass), rows };
}
const isDirect = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const r = checkThemes(readFileSync(join(root, "gui/src/styles/tokens.css"), "utf8"));
  for (const x of r.rows) console.log(`${x.pass ? "✓" : "✗"} ${x.theme.padEnd(7)} ${x.pair.padEnd(22)} ${x.value}`);
  console.log(r.ok ? "110/110 PASS" : `FAIL: ${r.rows.filter((x) => !x.pass).length} pairs`);
  process.exit(r.ok ? 0 : 1);
}
