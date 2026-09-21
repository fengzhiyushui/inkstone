import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../../../gui/src/styles/${p}`, import.meta.url), "utf8");

function definedVars() {
  const defs = new Set();
  for (const name of ["tokens.css", "theme.css"]) {
    const css = read(name);
    for (const [, v] of css.matchAll(/(--[\w-]+)\s*:/g)) defs.add(v);
  }
  return defs;
}

test("every var(--x) used in theme.css is defined in tokens.css or theme.css", () => {
  const defs = definedVars();
  const missing = [];
  const css = read("theme.css");
  const lines = css.split("\n");
  lines.forEach((line, i) => {
    for (const [, name] of line.matchAll(/var\((--[\w-]+)/g)) {
      if (!defs.has(name)) missing.push(`theme.css:${i + 1} ${name}`);
    }
  });
  assert.deepEqual(missing, [], `未定义的 CSS 变量:\n${missing.join("\n")}`);
});

test("shell.css is removed after B4 migration", () => {
  const path = new URL("../../../gui/src/styles/shell.css", import.meta.url);
  assert.equal(existsSync(path), false);
});
