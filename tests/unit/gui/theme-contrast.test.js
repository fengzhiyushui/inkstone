import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkThemes, checkPairs, contrastRatio, GATE, EXTRA_GATE } from "../../../scripts/check-theme-contrast.mjs";

test("contrastRatio reproduces v1.4 recorded values", () => {
  assert.equal(contrastRatio("#d3c6aa", "#2d353b").toFixed(2), "7.38"); // forest(退役前)
  assert.equal(contrastRatio("#dcd7ba", "#1f1f28").toFixed(2), "11.26"); // sumi(v1.8.0)
  assert.equal(contrastRatio("#1c1b1a", "#fffcf0").toFixed(2), "16.73"); // paper(v1.8.0)
});

test("11 pairs × 10 themes = 110 rows all pass (附录 A 口径)", () => {
  const css = readFileSync(new URL("../../../gui/src/styles/tokens.css", import.meta.url), "utf8");
  const r = checkThemes(css);
  const failed = r.rows.filter((x) => !x.pass);
  assert.equal(r.rows.length, 110, "11 对 × 10 套 = 110");
  assert.deepEqual(failed, [], failed.map((x) => `${x.theme} ${x.pair}=${x.value}`).join("\n"));
});

// v1.8.3:110 项口径不得被悄悄改动(曾出现闸门被降到 54 项后又被恢复)。
test("GATE 恒为 11 对,且 checkThemes 恒为 GATE 的判定", () => {
  assert.equal(GATE.length, 11, "闸门色对数锁定为 11");
  const css = readFileSync(new URL("../../../gui/src/styles/tokens.css", import.meta.url), "utf8");
  assert.deepEqual(checkThemes(css), checkPairs(css, GATE));
});

// v1.8.3:EXTRA_GATE 此前导出后从未被引用(死代码);现由本用例守护其真实通过。
test("附加色对(text/bg-element · text/code-bg)亦全部达标", () => {
  const css = readFileSync(new URL("../../../gui/src/styles/tokens.css", import.meta.url), "utf8");
  const r = checkPairs(css, EXTRA_GATE);
  assert.equal(r.rows.length, EXTRA_GATE.length * 10);
  const failed = r.rows.filter((x) => !x.pass);
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
