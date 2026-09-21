// scripts/gen-tui-theme.js — 从 gui/src/styles/tokens.css 生成 TUI 的 xterm-256 调色板。
// 用法:node scripts/gen-tui-theme.js(输出写入 src/apps/tui/theme-palette.js,生成物入库,主包运行时零依赖)。
// v1.8.1:tokens 已是 C 变体结构槽 + 各主题 accent;契约不变(仍读 12 槽 #rrggbb)。
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tokensPath = join(root, "gui", "src", "styles", "tokens.css");
const outPath = join(root, "src", "apps", "tui", "theme-palette.js");

// 主题 id → 中文名(与 tokens.css 注释一致)
export const NAMES = {
  sumi: "墨", slate: "玄", vesper: "烬", nord: "峡", ash: "灰",
  snow: "霜", sand: "沙", lotus: "荷", latte: "瓷", paper: "宣",
};

// 需要暴露给 TUI 的槽位(tokens.css 变量名 → palette 键)
const SLOTS = [
  ["bg-base", "bg"], ["bg-panel", "panel"], ["text", "fg"], ["text-mut", "mut"],
  ["text-faint", "faint"], ["border", "border"], ["accent", "accent"],
  ["accent-hover", "accentHover"], ["ok", "ok"], ["warn", "warn"],
  ["err", "err"], ["info", "info"],
];

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

function xtermRgb(index) {
  if (index >= 232) {
    const v = 8 + 10 * (index - 232);
    return [v, v, v];
  }
  const n = index - 16;
  const ri = Math.floor(n / 36);
  const gi = Math.floor((n % 36) / 6);
  const bi = n % 6;
  return [CUBE_LEVELS[ri], CUBE_LEVELS[gi], CUBE_LEVELS[bi]];
}

// hex(#rrggbb) → xterm-256 索引(16–255,系统色 0–15 不用,保证低端终端一致)。
// 全 256 色最近邻搜索:纯黑→16、纯白→231,灰阶走 232–255,彩走 6×6×6 立方。
export function hexToXterm(hex) {
  const value = String(hex).trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(value)) throw new Error(`非法颜色:${hex}`);
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  let best = 16;
  let bestDist = Infinity;
  for (let i = 16; i <= 255; i += 1) {
    const [cr, cg, cb] = xtermRgb(i);
    const d = (cr - r) ** 2 + (cg - g) ** 2 + (cb - b) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

function parseThemes(css) {
  const themes = [];
  const blockRe = /\[theme="(\w+)"\]\s*\{([^}]*)\}/g;
  let m;
  while ((m = blockRe.exec(css)) !== null) {
    const id = m[1];
    const vars = {};
    const varRe = /--([\w-]+)\s*:\s*([^;]+);/g;
    let v;
    while ((v = varRe.exec(m[2])) !== null) vars[v[1]] = v[2].trim();
    themes.push({ id, vars });
  }
  return themes;
}

function main() {
  const css = readFileSync(tokensPath, "utf8");
  const themes = parseThemes(css);
  if (themes.length !== 10) throw new Error(`期望 10 主题,实得 ${themes.length}`);
  const palette = {};
  for (const { id, vars } of themes) {
    const entry = { id, name: NAMES[id] || id };
    for (const [cssVar, key] of SLOTS) {
      if (!(cssVar in vars)) throw new Error(`主题 ${id} 缺 ${cssVar}`);
      const idx = hexToXterm(vars[cssVar]);
      if (idx < 16 || idx > 255) throw new Error(`主题 ${id} ${cssVar} 色号越界:${idx}`);
      entry[key] = idx;
    }
    palette[id] = entry;
  }
  const body =
    "// 由 scripts/gen-tui-theme.js 从 gui/src/styles/tokens.css 生成 —— 请勿手改;重新生成:node scripts/gen-tui-theme.js\n" +
    "// 槽位均为 xterm-256 色号(16–255)。\n\n" +
    "export const TUI_THEMES = " + JSON.stringify(palette, null, 2) + ";\n\n" +
    "export const DEFAULT_TUI_THEME = \"sumi\";\n";
  writeFileSync(outPath, body);
  console.log(`已生成 ${outPath}(${themes.length} 主题)`);
}

// 仅直接执行时生成;被测试 import 时只导出纯函数(不触碰文件系统)。
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) main();
