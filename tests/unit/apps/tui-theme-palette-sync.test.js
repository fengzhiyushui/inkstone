import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildPaletteBody } from "../../../scripts/gen-tui-theme.js";

const tokens = readFileSync(new URL("../../../gui/src/styles/tokens.css", import.meta.url), "utf8");
const paletteUrl = new URL("../../../src/apps/tui/theme-palette.js", import.meta.url);

// v1.8.3 C1:生成物入库契约必须可自证 —— 曾出现 tokens 改了(paper warn #ad8301)
// 却没重跑生成器,导致 TUI 主题色与 GUI 不一致,且既有测试抓不到。
test("theme-palette.js 必须与 tokens.css 的生成结果逐字节一致(不得手改/不得滞后)", () => {
  const expected = buildPaletteBody(tokens);
  const actual = readFileSync(paletteUrl, "utf8");
  if (actual !== expected) {
    const firstDiff = [...expected].findIndex((ch, i) => ch !== actual[i]);
    const ctx = (s) => s.slice(Math.max(0, firstDiff - 60), firstDiff + 60).replace(/\n/g, "\\n");
    assert.fail(`theme-palette.js 已过期(首个差异 @${firstDiff})\n  期望: …${ctx(expected)}…\n  实得: …${ctx(actual)}…\n  修复:node scripts/gen-tui-theme.js`);
  }
});

test("buildPaletteBody 契约:主题数不为 10 或缺槽位时抛错", () => {
  assert.throws(() => buildPaletteBody('[theme="sumi"] { --bg-base: #000000; }'), /10 主题/);
  const nine = Array.from({ length: 9 }, (_, i) => `[theme="t${i}"] { --bg-base:#000000; }`).join("\n");
  assert.throws(() => buildPaletteBody(nine), /10 主题/);
  const tenBad = Array.from({ length: 10 }, (_, i) => `[theme="t${i}"] { --bg-base:#000000; }`).join("\n");
  assert.throws(() => buildPaletteBody(tenBad), /缺/);
});
