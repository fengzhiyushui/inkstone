import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../../../gui/src/styles/${p}`, import.meta.url), "utf8");

// 定义源:tokens.css 主题块 + :root,theme.css 的 :root 与 [theme] 别名块
function definedVars() {
  const defs = new Set();
  for (const css of [read("tokens.css"), read("theme.css")]) {
    for (const [, name] of css.matchAll(/(--[\w-]+)\s*:/g)) defs.add(name);
  }
  return defs;
}

test("every var(--x) used in shell.css / theme.css is defined in tokens.css or theme.css", () => {
  const defs = definedVars();
  const missing = [];
  for (const file of ["shell.css", "theme.css"]) {
    const css = read(file);
    const lines = css.split("\n");
    lines.forEach((line, i) => {
      for (const [, name] of line.matchAll(/var\((--[\w-]+)/g)) {
        if (!defs.has(name)) missing.push(`${file}:${i + 1} ${name}`);
      }
    });
  }
  assert.deepEqual(missing, [], `未定义的 CSS 变量:\n${missing.join("\n")}`);
});
