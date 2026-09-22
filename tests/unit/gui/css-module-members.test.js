import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// v1.8.3(W3):CSS Module 的成员是**编译期**解析的 —— `css.foo` 若在对应
// `*.module.css` 里不存在,CSS Modules 会返回 `undefined`,最终 className 里出现
// 字面量 "undefined"。这类缺陷类型检查抓不到、单测也容易漏(v1.8.2 的 ChatView 即如此)。
// 本守卫按「每个 css.<name> 必须有对应规则」逐文件核对。
const SRC = fileURLToPath(new URL("../../../gui/src/", import.meta.url));

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".jsx")) out.push(p);
  }
  return out;
}

const moduleClasses = (text) =>
  new Set([...text.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)].map((m) => m[1]));

test("每个 css.<name> 引用都必须在其 *.module.css 中真实定义", () => {
  const problems = [];
  for (const f of walk(SRC)) {
    const text = readFileSync(f, "utf8");
    for (const [, varName, rel] of text.matchAll(/import\s+(\w+)\s+from\s+["']([^"']+\.module\.css)["']/g)) {
      const modPath = resolve(f, "..", rel);
      let defined;
      try {
        defined = moduleClasses(readFileSync(modPath, "utf8"));
      } catch {
        problems.push(`${f.replace(SRC, "")}: 找不到模块 ${rel}`);
        continue;
      }
      for (const m of text.matchAll(new RegExp(`\\b${varName}\\.([A-Za-z_][\\w]*)`, "g"))) {
        if (!defined.has(m[1])) problems.push(`${f.replace(SRC, "").replace(/\\/g, "/")}: ${varName}.${m[1]} 未定义于 ${rel}`);
      }
    }
  }
  assert.deepEqual(problems, [], `css.<name> 缺失会渲染出 undefined:\n  ${problems.join("\n  ")}`);
});
