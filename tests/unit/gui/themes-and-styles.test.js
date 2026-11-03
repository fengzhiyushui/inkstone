// tests/unit/gui/themes-and-styles.test.js — 主题与样式契约(对比度/结构/CSS 变量/模块成员)领域测试
//
// v1.19.1 测试归并:本文件由下列历史任务单测试合并而成,每个来源包裹在独立
// describe 块中(异步回调 + 动态 import,来源间零共享绑定),测试语义与拆分前一致。
import { describe } from "node:test";

// ---------------------------------------------------------------------------
// 来源:tests/unit/gui/themes.test.js
// ---------------------------------------------------------------------------
describe("unit/gui/themes", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { GUI_THEMES, isLightTheme, themeLabel } = await import("../../../gui/src/state/themes.js");

  test("themes: light group themes are flagged light", () => {
    for (const theme of GUI_THEMES.filter((x) => x.group === "light")) {
      assert.equal(isLightTheme(theme.id), true, theme.id);
    }
  });

  test("themes: dark and unknown themes are not light", () => {
    for (const theme of GUI_THEMES.filter((x) => x.group === "dark")) {
      assert.equal(isLightTheme(theme.id), false, theme.id);
    }
    assert.equal(isLightTheme("not-a-theme"), false);
  });

  test("themes: themeLabel returns display name with sumi fallback", () => {
    assert.equal(themeLabel("paper"), "宣");
    assert.equal(themeLabel("vesper"), "烬");
    assert.equal(themeLabel("missing"), "墨");
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/gui/theme-hub.test.js
// ---------------------------------------------------------------------------
describe("unit/gui/theme-hub", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { nextInGroup, otherModeTheme, groupOf } = await import("../../../gui/src/state/theme-hub.js");

  test("nextInGroup cycles inside the same group and wraps at the end", () => {
    assert.equal(nextInGroup("sumi"), "slate");
    assert.equal(nextInGroup("ash"), "sumi");   // 暗组末尾回绕
    assert.equal(nextInGroup("paper"), "snow"); // 明组末尾回绕
  });

  test("otherModeTheme returns the most recent theme of the opposite mode", () => {
    assert.equal(otherModeTheme({ theme: "sumi", lastDark: "sumi", lastLight: "sand" }), "sand");
    assert.equal(otherModeTheme({ theme: "snow", lastDark: "ash", lastLight: "snow" }), "ash");
  });

  test("groupOf maps dim to dark and tint to light", () => {
    assert.equal(groupOf("nord"), "dark");
    assert.equal(groupOf("snow"), "light");
  });

  test("retired ids are normalized instead of throwing", () => {
    assert.equal(nextInGroup("rose"), "slate"); // rose → sumi → dark 组下一个
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/gui/theme-pins.test.js
// ---------------------------------------------------------------------------
describe("unit/gui/theme-pins", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { GUI_THEMES, TIERS, themesByTier, isLightTheme } = await import("../../../gui/src/state/themes.js");
  const { TUI_THEMES, DEFAULT_TUI_THEME } = await import("../../../src/apps/tui/theme-palette.js");
  const { NAMES } = await import("../../../scripts/gen-tui-theme.js");
  const { createInitialState, applyWorkbenchAction } = await import("../../../gui/src/state/workbench-state.js");

  const ids = GUI_THEMES.map((x) => x.id);
  const RETIRED = { dawn: "lotus", mocha: "sumi", moon: "slate", forest: "ash", clay: "vesper", rose: "sumi" };

  test("GUI / TUI palette / generator NAMES share one id set, in order", () => {
    assert.deepEqual(Object.keys(TUI_THEMES), ids);
    assert.deepEqual(Object.keys(NAMES), ids);
    assert.equal(ids.length, 10);
    assert.equal(DEFAULT_TUI_THEME, "sumi");
  });
  test("tiers are dark3/dim2/tint2/light3 and group is derived from tier", () => {
    const by = themesByTier();
    assert.deepEqual(TIERS.map((t) => by[t].length), [3, 2, 2, 3]);
    for (const th of GUI_THEMES) assert.equal(isLightTheme(th.id), th.tier === "tint" || th.tier === "light", th.id);
  });
  test("retired ids migrate and never survive normalize", () => {
    for (const [old, next] of Object.entries(RETIRED)) {
      assert.ok(!ids.includes(old), `${old} 仍在集合`);
      const s = applyWorkbenchAction(createInitialState(), { type: "theme_changed", theme: old });
      assert.equal(s.theme, next, `${old}→${next}`);
    }
  });
  test("theme_changed keeps lastDark / lastLight in sync by group", () => {
    let s = createInitialState();
    s = applyWorkbenchAction(s, { type: "theme_changed", theme: "snow" });
    assert.equal(s.lastLight, "snow"); assert.equal(s.lastDark, "sumi");
    s = applyWorkbenchAction(s, { type: "theme_changed", theme: "ash" });
    assert.equal(s.lastDark, "ash"); assert.equal(s.lastLight, "snow");
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/gui/theme-contrast.test.js
// ---------------------------------------------------------------------------
describe("unit/gui/theme-contrast", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { readFileSync } = await import("node:fs");
  const { checkThemes, checkPairs, contrastRatio, GATE, EXTRA_GATE } = await import("../../../scripts/check-theme-contrast.mjs");

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
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/gui/theme-structure.test.js
// ---------------------------------------------------------------------------
describe("unit/gui/theme-structure", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { readFileSync } = await import("node:fs");

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
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/gui/css-vars.test.js
// ---------------------------------------------------------------------------
describe("unit/gui/css-vars", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { readFileSync, existsSync } = await import("node:fs");

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
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/gui/css-module-members.test.js
// ---------------------------------------------------------------------------
describe("unit/gui/css-module-members", async () => {

  // v1.8.3(W3):CSS Module 的成员是**编译期**解析的 —— `css.foo` 若在对应
  // `*.module.css` 里不存在,CSS Modules 会返回 `undefined`,最终 className 里出现
  // 字面量 "undefined"。这类缺陷类型检查抓不到、单测也容易漏(v1.8.2 的 ChatView 即如此)。
  // 本守卫按「每个 css.<name> 必须有对应规则」逐文件核对。

  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { readFileSync, readdirSync, statSync } = await import("node:fs");
  const { join, resolve } = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const SRC = fileURLToPath(new URL("../../../gui/src", import.meta.url));

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
});
