import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import path from "node:path";
import { rm } from "node:fs/promises";
import os from "node:os";
import { mkdtemp } from "../helpers/tmp.js";

// Gated: the Vite renderer build needs gui deps installed (network). Without them
// this skips, so the core suite stays green in a no-deps environment (spec §11).
// 校验口径 v1.4.7:存在依赖时必须真实编译一次(临时 outDir),只查产物存在拦不住
// 「组件引用了被删模块」这类编译回归(v1.4.6 误删 DiffView.jsx 即因此漏网)。
const guiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "gui");
const viteInstalled = existsSync(path.join(guiDir, "node_modules", "vite"));

test("gui renderer build config + entry are wired", { skip: !viteInstalled ? "gui deps not installed" : false }, async () => {
  // When deps are present, a prior `npm run build:renderer` should have produced the entry.
  const builtIndex = path.join(guiDir, "renderer-dist", "index.html");
  assert.ok(existsSync(path.join(guiDir, "vite.renderer.config.mjs")), "vite config present");
  assert.ok(existsSync(builtIndex), "run `npm run build:renderer` in gui/ to produce renderer-dist/index.html");
});

test("gui renderer compiles cleanly from source", { skip: !viteInstalled ? "gui deps not installed" : false, timeout: 240000 }, async () => {
  const require = createRequire(import.meta.url);
  const { build } = require(path.join(guiDir, "node_modules", "vite", "dist", "node", "index.js"));
  const outDir = await mkdtemp(path.join(os.tmpdir(), "dsc-gui-build-"));
  try {
    const result = await build({
      root: guiDir,
      logLevel: "error",
      build: {
        outDir,
        emptyOutDir: true
      },
      configFile: path.join(guiDir, "vite.renderer.config.mjs")
    });
    assert.ok(result, "vite build resolves");
    assert.ok(existsSync(path.join(outDir, "index.html")), "index.html emitted");
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
