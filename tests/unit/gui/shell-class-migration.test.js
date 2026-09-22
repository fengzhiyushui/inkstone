import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// v1.8.3(W4):把「B4 删 shell.css 后是否还有样式丢失」变成**自动守卫**。
// v1.8.2 用的是人工 REQUIRED 清单,恰好漏掉了 .acc/.opt/.ai-ic/.f-in.short/.f-in.mid
// (见 v1.8.3 审查报告 W1/W2)。这里改为从**当前 JSX 实际用到的类名**反推:
// 每个类名必须能在某个 CSS(含 *.module.css)里找到定义,或在 ALLOW 里有明确理由。
const SRC = fileURLToPath(new URL("../../../gui/src/", import.meta.url));

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(jsx|css)$/.test(n)) out.push(p);
  }
  return out;
}

// 把模板字面量里的 ${…} 插值整体剔除(含嵌套花括号)
function stripInterpolations(s) {
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === "$" && s[i + 1] === "{") {
      let depth = 1;
      i += 2;
      while (i < s.length && depth > 0) {
        if (s[i] === "{") depth += 1;
        else if (s[i] === "}") depth -= 1;
        i += 1;
      }
      out += " ";
    } else {
      out += s[i];
      i += 1;
    }
  }
  return out;
}

// 只取小写/连字符形态的类名 token —— 天然排除 JS 标识符(css.mode / openPath / currentRoot)
const TOKEN = /^[a-z][a-z0-9-]*$/;

function jsxClassTokens(text) {
  const out = new Set();
  const push = (s) => { for (const tok of s.split(/\s+/)) if (TOKEN.test(tok)) out.add(tok); };
  for (const m of text.matchAll(/className="([^"]*)"/g)) push(m[1]);
  for (const m of text.matchAll(/className='([^']*)'/g)) push(m[1]);
  for (const m of text.matchAll(/className=\{`([^`]*)`\}/g)) push(stripInterpolations(m[1]));
  return out;
}

const cssClassTokens = (text) =>
  new Set([...text.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)].map((m) => m[1]));

// 明确「无全局规则也成立」的类名 —— 每条都必须给出理由,否则不许加。
const ALLOW = new Map([
  ["shell", "AppFrame 的 className 直通;布局由 AppFrame.module.css 的 .frame + 内联 gridTemplateColumns 提供"],
  ["rail-off", "同上;收起态由 gridTemplateColumns 数值驱动,非类名样式"],
  ["new-more", "同元素另挂 Rail.module.css 的 .newMore"],
  ["rail-toggle", "同元素另挂 Rail.module.css 的 .foot .iconbtn"],
  ["cz-input", "Composer 文本域钩子;样式由 theme.css 的 .cz-in textarea 承担(v1.8.0 起即无独立规则)"],
  ["settings-nav", "同元素另挂 SettingsModal.module.css 的 .nav"]
]);

test("GUI 中所有 JSX 类名都必须有样式定义,或在 ALLOW 中列明理由", () => {
  const files = walk(SRC);
  const defined = new Set();
  const jsx = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    if (f.endsWith(".css")) for (const c of cssClassTokens(text)) defined.add(c);
    else jsx.push([f, text]);
  }

  const orphans = new Map();
  for (const [f, text] of jsx) {
    for (const tok of jsxClassTokens(text)) {
      if (defined.has(tok) || ALLOW.has(tok)) continue;
      if (!orphans.has(tok)) orphans.set(tok, []);
      orphans.get(tok).push(f.replace(SRC, "").replace(/\\/g, "/"));
    }
  }

  const list = [...orphans.entries()].sort().map(([k, v]) => `.${k}  <- ${v.join(", ")}`);
  assert.deepEqual(orphans.size, 0,
    `以下类名在 JSX 中使用但任何 CSS 都未定义(疑似样式丢失;确有理由请加入 ALLOW):\n  ${list.join("\n  ")}`);
});

// v1.8.3 W1/W2 的回归钉:这些规则一旦再次消失,compact 偏好与表单宽度会静默失效。
test("v1.8.3 迁回的修饰符规则必须存活于 theme.css", () => {
  const css = readFileSync(new URL("../../../gui/src/styles/theme.css", import.meta.url), "utf8");
  const REQUIRED = [
    ".cz-meta.compact .m-bar .lb",
    ".cz-meta.compact .m-dots .lb",
    ".cz-meta.compact .sg.opt",
    ".api-item .ai-ic",
    ".f-in.short",
    ".f-in.mid"
  ];
  for (const sel of REQUIRED) assert.ok(css.includes(sel), `theme.css 缺少 ${sel}`);
});

test("ALLOW 不得成为垃圾桶:每个条目都必须有非空理由", () => {
  for (const [k, reason] of ALLOW) {
    assert.ok(reason && reason.length >= 12, `.${k} 的 ALLOW 理由过短`);
  }
});
