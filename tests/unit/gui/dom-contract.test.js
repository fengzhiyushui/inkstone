import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = (p) => readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8");

test("frozen DOM/CSS contracts survive (v1.8.1 B4 冻结清单)", () => {
  const app = read("gui/src/App.jsx"), rail = read("gui/src/components/v4/Rail.jsx");
  const metrics = read("gui/src/components/v4/MetricsLine.jsx"), sn = read("gui/src/components/v4/SensitiveNoticeModal.jsx");
  const themeCss = read("gui/src/styles/theme.css"), main = read("gui/main.js");
  const appFrame = read("gui/src/components/v4/AppFrame.jsx");
  assert.match(app, /setAttribute\("theme", state\.theme\)/);
  // v1.8.3(I2):`shell` / `rail-off` 是**无样式的结构钩子** —— 布局由 AppFrame.module.css 的
  // .frame + 内联 gridTemplateColumns 承担,这两个类名目前在 gui/src 的任何 CSS 里都没有规则。
  // 此处保留断言以冻结 DOM,但请勿据此认为它们有视觉作用;若将来要删除,需同步改本行。
  assert.match(app, /className=\{`shell\$\{state\.railCollapsed \? " rail-off" : ""\}`\}/);
  for (const cls of ["rail-fn", "rail-scroll", "rail-foot", "rail-new"]) assert.match(rail, new RegExp(`className=\\{?[\`"']${cls}`), cls);
  assert.match(metrics, /"cz-meta"/);
  assert.match(metrics, /data-mv=/);
  assert.match(sn, /className="sn-backdrop" role="dialog" aria-modal="true"/);
  assert.ok(sn.indexOf("sn-refuse") < sn.indexOf("sn-allow"), "拒绝键须在允许键之前");
  assert.match(sn, /sn-refuse" autoFocus/);
  assert.match(themeCss, /--titlebar:40px/);
  assert.match(appFrame, /data-windows-titlebar/);
  assert.match(appFrame, /data-rightbar-col/);
  for (const sel of [
    ".ide", "[data-windows-titlebar]", ".rail", ".pane",
    ".rail-fn", ".cz-input", "[data-rightbar-col]", ".rail-foot"
  ]) {
    assert.ok(main.includes(`querySelector(${JSON.stringify(sel)})`) || main.includes(`querySelector('${sel}')`),
      `smoke 门选择器 ${sel}`);
  }
  assert.ok(!/TitleBar|shell-settings|view === "settings"|view === "changes"|view === "recovery"|ChangesView|RecoveryView/.test(app),
    "B4 后 App 不得出现 TitleBar / shell-settings / 旧路由");
  assert.ok(!existsSync(new URL("../../../gui/src/components/TitleBar.jsx", import.meta.url)));
  assert.ok(!existsSync(new URL("../../../gui/src/styles/shell.css", import.meta.url)));
  assert.ok(!existsSync(new URL("../../../gui/src/components/Settings/ThemeHub.jsx", import.meta.url)));
});

function existsSync(url) {
  try { readFileSync(url); return true; } catch { return false; }
}
