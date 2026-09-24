import test from "node:test";
import assert from "node:assert/strict";
import {
  STATUS_FORMS, STATUS_POSITIONS, STATUS_TOGGLES, STATUS_DISPLAY_DEFAULTS,
  normalizeStatusDisplay
} from "../../../gui/src/state/status-display.js";

test("默认值:4 组齐全,form=bar,14 个开关(本轮耗时/改动数默认关),格式默认", () => {
  assert.equal(STATUS_FORMS.length, 5);
  assert.equal(STATUS_POSITIONS.length, 3);
  assert.equal(STATUS_TOGGLES.length, 14);
  assert.equal(STATUS_DISPLAY_DEFAULTS.form, "bar");
  assert.equal(STATUS_DISPLAY_DEFAULTS.position, "composer");
  assert.equal(STATUS_DISPLAY_DEFAULTS.format.dotsCount, 10);
  assert.equal(STATUS_DISPLAY_DEFAULTS.format.tpsDecimals, 1);
  assert.equal(Object.keys(STATUS_DISPLAY_DEFAULTS.show).length, 14);
  assert.equal(STATUS_DISPLAY_DEFAULTS.show.turnTime, false);   // 设计稿默认关
  assert.equal(STATUS_DISPLAY_DEFAULTS.show.turnChanges, false);
  assert.equal(STATUS_DISPLAY_DEFAULTS.show.model, false);   // 输入行已有模型 pill,不重复
  assert.equal(STATUS_DISPLAY_DEFAULTS.show.branch, true);
  assert.equal(STATUS_DISPLAY_DEFAULTS.show.cacheMiss, true);
  assert.equal(STATUS_DISPLAY_DEFAULTS.show.reasoningTokens, true);
  assert.equal(STATUS_DISPLAY_DEFAULTS.show.tps, true);
});

test("normalize:null/非对象 → 完整默认深拷贝", () => {
  const a = normalizeStatusDisplay(null);
  const b = normalizeStatusDisplay(undefined);
  assert.equal(a.form, "bar");
  assert.notEqual(a, STATUS_DISPLAY_DEFAULTS, "应深拷贝,不与默认共享引用");
  a.show.branch = false;
  assert.equal(b.show.branch, true, "互不影响");
});

test("normalize:合法值通过,非法值回退", () => {
  const out = normalizeStatusDisplay({
    form: "dots", position: "both", fadeIdle: true, compact: true,
    show: { branch: false, context: true, unknown: true },
    format: { percentDecimals: 2, bigUnits: false, contextWarnRatio: 0.6, dotsCount: 16, junk: 1 }
  });
  assert.equal(out.form, "dots");
  assert.equal(out.position, "both");
  assert.equal(out.fadeIdle, true);
  assert.equal(out.compact, true);
  assert.equal(out.show.branch, false);
  assert.equal(out.show.context, true);
  assert.equal(out.show.checkpoint, true, "未提及的开关保留默认");
  assert.equal(out.format.percentDecimals, 2);
  assert.equal(out.format.bigUnits, false);
  assert.equal(out.format.contextWarnRatio, 0.6);
  assert.equal(out.format.dotsCount, 16);
});

test("normalize:越界与非法值被夹紧/回退", () => {
  const out = normalizeStatusDisplay({
    form: "sparkline", position: "sidebar",
    show: { branch: "yes" },
    format: { percentDecimals: 9, contextWarnRatio: 3, dotsCount: 2 }
  });
  assert.equal(out.form, "bar", "非法形态回退默认");
  assert.equal(out.position, "composer", "非法位置回退默认");
  assert.equal(out.show.branch, true, "非布尔开关保留默认");
  assert.equal(out.format.percentDecimals, 4, "小数位夹紧到 0–4");
  assert.equal(out.format.contextWarnRatio, 1, "阈值夹紧到 0–1");
  assert.equal(out.format.dotsCount, 4, "点阵格数夹紧到 4–24");
  assert.equal(out.format.tpsDecimals, 1, "未提及的 tpsDecimals 保留默认");
});

test("normalize:tpsDecimals 夹紧 0–2", () => {
  assert.equal(normalizeStatusDisplay({ format: { tpsDecimals: 0 } }).format.tpsDecimals, 0);
  assert.equal(normalizeStatusDisplay({ format: { tpsDecimals: 2 } }).format.tpsDecimals, 2);
  assert.equal(normalizeStatusDisplay({ format: { tpsDecimals: 9 } }).format.tpsDecimals, 2);
});
