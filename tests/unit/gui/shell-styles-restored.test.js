import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// B4 删 shell.css 后曾丢失、v1.8.2 必须存活的关键选择器(布局显隐 / 模态 / 省略号)
const REQUIRED = [
  ".sn-backdrop",
  ".sn-card",
  ".sn-refuse",
  ".sn-allow",
  ".s-body",
  ".s-in",
  ".sec-body.closed",
  ".proj-b",
  ".proj-h .nm",
  ".r-item .tt",
  ".th-detail",
  ".hello-txt",
  ".new-menu",
  ".nm-i",
  ".proj-h .tag",
  ".modal-backdrop"
];

test("theme.css keeps v1.8.2 restored shell selectors", () => {
  const css = readFileSync(new URL("../../../gui/src/styles/theme.css", import.meta.url), "utf8");
  for (const sel of REQUIRED) {
    assert.ok(css.includes(sel), `theme.css 缺少 ${sel}`);
  }
});

test("sensitive modal refuse appears before allow in DOM contract remains", () => {
  const src = readFileSync(new URL("../../../gui/src/components/v4/SensitiveNoticeModal.jsx", import.meta.url), "utf8");
  assert.ok(src.indexOf("sn-refuse") < src.indexOf("sn-allow"));
});
