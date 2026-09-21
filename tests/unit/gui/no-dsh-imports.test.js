import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) { if (n !== "node_modules") walk(p, out); }
    else if (/\.(jsx?|css|mjs)$/.test(n)) out.push(p);
  }
  return out;
}
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

test("gui never depends on or references the reference project's packages", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "gui/package.json"), "utf8"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies };
  assert.deepEqual(Object.keys(deps).filter((k) => k.startsWith("@deepseek-ai/")), [], "gui/package.json 不得依赖 @deepseek-ai/*");
  for (const f of walk(join(ROOT, "gui/src"))) {
    const s = readFileSync(f, "utf8");
    assert.ok(!/from\s+['"]@deepseek-ai\//.test(s), `${f} 不得 import @deepseek-ai/*`);
    assert.ok(!/--dsw-|--dsh-/.test(s), `${f} 不得使用 --dsw-/--dsh- 变量名`);
  }
});
