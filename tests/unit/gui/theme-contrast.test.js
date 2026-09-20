import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkThemes, contrastRatio } from "../../../scripts/check-theme-contrast.mjs";

test("contrastRatio reproduces v1.4 recorded values", () => {
  assert.equal(contrastRatio("#d3c6aa", "#2d353b").toFixed(2), "7.38"); // forest(退役前)
  assert.equal(contrastRatio("#dcd7ba", "#1f1f28").toFixed(2), "11.26"); // sumi
  assert.equal(contrastRatio("#1c1b1a", "#fffcf0").toFixed(2), "16.73"); // paper
});

test("all 10 themes pass all 11 gate pairs (110/110)", () => {
  const css = readFileSync(new URL("../../../gui/src/styles/tokens.css", import.meta.url), "utf8");
  const r = checkThemes(css);
  const failed = r.rows.filter((x) => !x.pass);
  assert.equal(r.rows.length, 110, "应为 10 主题 × 11 对");
  assert.deepEqual(failed, [], failed.map((x) => `${x.theme} ${x.pair}=${x.value}`).join("\n"));
});

test("tokens.css has exactly 10 top-level theme blocks with 18 slots each, 12 palette slots as #rrggbb", () => {
  const css = readFileSync(new URL("../../../gui/src/styles/tokens.css", import.meta.url), "utf8");
  const blocks = [...css.matchAll(/\[theme="(\w+)"\]\s*\{([^}]*)\}/g)];
  assert.equal(blocks.length, 10);
  const SLOTS = ["bg-base","bg-panel","bg-element","bg-inset","text","text-mut","text-faint","border","border-strong","accent","accent-hover","accent-soft","accent-text","ok","warn","err","info","code-bg"];
  const HEX = ["bg-base","bg-panel","text","text-mut","text-faint","border","accent","accent-hover","ok","warn","err","info"];
  for (const [, id, body] of blocks) {
    for (const s of SLOTS) assert.match(body, new RegExp(`--${s}\\s*:`), `${id} 缺 --${s}`);
    for (const s of HEX) assert.match(body, new RegExp(`--${s}\\s*:\\s*#[0-9a-f]{6};`), `${id} --${s} 须为小写 #rrggbb(TUI 生成器契约)`);
  }
});
