// scripts/check-theme-contrast.mjs — v1.8.1 闸门:结构 2 group×7 + 强调 10×4 = 54 项。
// 用法:node scripts/check-theme-contrast.mjs  → 打印表格,任一不过 exit 1。被测试 import 时只导出纯函数。
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { relLum, contrastRatio } from "../gui/src/state/contrast.js";
export { relLum, contrastRatio };

// 结构闸门(7 对,按 group 去重——同组 10 槽字节相同)
export const STRUCT_GATE = [
  ["text/bg-base", "text", "bg-base", 7, 19.5],
  ["text/bg-panel", "text", "bg-panel", 7, 19.5],
  ["text-mut/bg-base", "text-mut", "bg-base", 4.5, Infinity],
  ["text-faint/bg-base", "text-faint", "bg-base", 3, Infinity],
  ["border-strong/bg-base", "border-strong", "bg-base", 1.5, Infinity],
  ["text/bg-element", "text", "bg-element", 7, 19.5],
  ["text/code-bg", "text", "code-bg", 7, 19.5]
];

// 强调闸门(4 对,每主题;warn/info 为附加对,不计入 54)
export const ACCENT_GATE = [
  ["accent/bg-base", "accent", "bg-base", 3, Infinity],
  ["accent-text/accent", "accent-text", "accent", 4.5, Infinity],
  ["ok/bg-base", "ok", "bg-base", 3, Infinity],
  ["err/bg-base", "err", "bg-base", 3, Infinity]
];

// 兼容旧名:STRUCT + 附加 warn/info + accent(不在 54 口径内)
export const GATE = [
  ...STRUCT_GATE,
  ...ACCENT_GATE,
  ["warn/bg-base", "warn", "bg-base", 3, Infinity],
  ["info/bg-base", "info", "bg-base", 3, Infinity]
];

const LIGHT = new Set(["paper", "latte", "lotus", "snow", "sand"]);

export function parseThemes(css) {
  return [...css.matchAll(/\[theme="(\w+)"\]\s*\{([^}]*)\}/g)].map(([, id, body]) => {
    const vars = {};
    for (const [, k, v] of body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) vars[k] = v.trim();
    return { id, vars };
  });
}

export function checkThemes(css) {
  const themes = parseThemes(css);
  const rows = [];
  // 结构:每 group 取一个代表主题计算(同组槽位应字节相同)
  for (const [group, id] of [["light", "paper"], ["dark", "sumi"]]) {
    const vars = themes.find((t) => t.id === id)?.vars;
    if (!vars) continue;
    for (const [pair, fg, bg, min, max] of STRUCT_GATE) {
      const value = +contrastRatio(vars[fg], vars[bg]).toFixed(2);
      rows.push({ theme: `${group}:${id}`, group, pair, value, min, max, pass: value >= min && value <= max });
    }
  }
  // 强调:每主题 4 对
  for (const { id, vars } of themes) {
    const group = LIGHT.has(id) ? "light" : "dark";
    for (const [pair, fg, bg, min, max] of ACCENT_GATE) {
      const value = +contrastRatio(vars[fg], vars[bg]).toFixed(2);
      rows.push({ theme: id, group, pair, value, min, max, pass: value >= min && value <= max });
    }
  }
  return { ok: rows.every((r) => r.pass), rows };
}

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const r = checkThemes(readFileSync(join(root, "gui/src/styles/tokens.css"), "utf8"));
  for (const x of r.rows) console.log(`${x.pass ? "✓" : "✗"} ${String(x.theme).padEnd(12)} ${x.pair.padEnd(22)} ${x.value}`);
  const total = r.rows.length;
  console.log(r.ok ? `${total}/${total} PASS` : `FAIL: ${r.rows.filter((x) => !x.pass).length}/${total}`);
  process.exit(r.ok ? 0 : 1);
}
