import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const LIGHT = new Set(["paper", "latte", "lotus", "snow", "sand"]);
const DARK = new Set(["sumi", "slate", "vesper", "nord", "ash"]);
const STRUCT = ["bg-base", "bg-panel", "bg-element", "bg-inset", "text", "text-mut", "text-faint", "border", "border-strong", "code-bg"];

function parseThemes(css) {
  return [...css.matchAll(/\[theme="(\w+)"\]\s*\{([^}]*)\}/g)].map(([, id, body]) => {
    const vars = {};
    for (const [, k, v] of body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) vars[k] = v.trim();
    return { id, vars };
  });
}

test("C 变体:同 group 结构槽逐字节相等;明 #ffffff / 暗 #151517", () => {
  const css = readFileSync(new URL("../../../gui/src/styles/tokens.css", import.meta.url), "utf8");
  const themes = parseThemes(css);
  assert.equal(themes.length, 10);

  const light = themes.filter((t) => LIGHT.has(t.id));
  const dark = themes.filter((t) => DARK.has(t.id));
  assert.equal(light.length, 5);
  assert.equal(dark.length, 5);

  for (const slot of STRUCT) {
    const lightVals = new Set(light.map((t) => t.vars[slot]));
    const darkVals = new Set(dark.map((t) => t.vars[slot]));
    assert.equal(lightVals.size, 1, `明组 --${slot} 不一致: ${[...lightVals].join(",")}`);
    assert.equal(darkVals.size, 1, `暗组 --${slot} 不一致: ${[...darkVals].join(",")}`);
  }

  assert.equal(light[0].vars["bg-base"], "#ffffff");
  assert.equal(dark[0].vars["bg-base"], "#151517");
});
