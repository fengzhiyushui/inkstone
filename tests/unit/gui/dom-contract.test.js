import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = (p) => readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8");

test("frozen DOM/CSS contracts survive (v1.8.1 B0 冻结清单)", () => {
  const app = read("gui/src/App.jsx"), rail = read("gui/src/components/v4/Rail.jsx");
  const metrics = read("gui/src/components/v4/MetricsLine.jsx"), sn = read("gui/src/components/v4/SensitiveNoticeModal.jsx");
  const themeCss = read("gui/src/styles/theme.css"), main = read("gui/main.js");
  const appFrame = read("gui/src/components/v4/AppFrame.jsx");
  assert.match(app, /setAttribute\("theme", state\.theme\)/);
  assert.match(app, /className=\{`shell\$\{state\.railCollapsed \? " rail-off" : ""\}\$\{(?:view === "settings"|isFullWindowSettings) \? " shell-settings" : ""\}`\}/);
  for (const cls of ["rail-fn", "rail-scroll", "rail-foot", "rail-new"]) assert.match(rail, new RegExp(`className="${cls}`), cls);
  assert.match(metrics, /"cz-meta"/);
  assert.match(metrics, /data-mv=/);
  assert.match(sn, /className="sn-backdrop" role="dialog" aria-modal="true"/);
  assert.ok(sn.indexOf("sn-refuse") < sn.indexOf("sn-allow"), "拒绝键须在允许键之前");
  assert.match(sn, /sn-refuse" autoFocus/);
  assert.match(themeCss, /--titlebar:40px/);
  assert.match(appFrame, /data-windows-titlebar/);
  for (const sel of [".ide", 'header[role="banner"]', ".shell", ".rail", ".pane", ".rail-fn", ".cz-input", ".titlebar .actions .lang"])
    assert.ok(main.includes(`querySelector(${JSON.stringify(sel)})`) || main.includes(`querySelector('${sel}')`), `smoke 门选择器 ${sel}`);
  assert.ok(!/telemetry|statusbar/.test(app), "不得出现遥测条/独立状态栏");
});
