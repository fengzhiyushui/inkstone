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

test("v1.13.0:MCP 工具治理的 DOM 契约(风险徽章 / 信任开关 / 风险来源)", () => {
  const mcp = read("gui/src/components/v4/SecondaryViews.jsx");
  const themeCss = read("gui/src/styles/theme.css");

  // 风险徽章:destructive 必须用 danger 色(区别于 read / mutate)
  assert.match(mcp, /tDef\.badge\?\.level === "danger"/);
  assert.match(mcp, /tDef\.badge\?\.label \|\| tDef\.category/);

  // 信任开关:决定是否采纳 server 自报的 annotations
  assert.match(mcp, /mcp-trust-row/);
  assert.match(mcp, /trustServer \? \{ trust: true \} : \{\}/, "两处提交都要带 trust");
  assert.match(themeCss, /\.mcp-trust-row/);

  // 风险来源要可解释:不受信忽略 annotations / 受信采纳
  assert.match(mcp, /该 server 未受信,自报 annotations 已忽略/);
  assert.match(mcp, /风险判定来自受信 server 的 annotations/);

  // 持久放行徽章(project / always)
  assert.match(mcp, /永久放行/);
  assert.match(mcp, /本项目放行/);
});

function existsSync(url) {
  try { readFileSync(url); return true; } catch { return false; }
}
