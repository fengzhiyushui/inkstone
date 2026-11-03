// tests/e2e/gui-smoke.test.js — GUI 构建与 Electron 冒烟测试
import test from "node:test";
import assert from "node:assert/strict";
import { access, rm } from "node:fs/promises";
import { existsSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { mkdtemp } from "../helpers/tmp.js";

const guiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "gui");
const viteInstalled = existsSync(path.join(guiDir, "node_modules", "vite"));

test("GUI 渲染层:构建配置存在且能从源码干净编译", { skip: !viteInstalled ? "gui deps not installed" : false, timeout: 240000 }, async () => {
  const builtIndex = path.join(guiDir, "renderer-dist", "index.html");
  assert.ok(existsSync(path.join(guiDir, "vite.renderer.config.mjs")), "vite config present");
  assert.ok(existsSync(builtIndex), "renderer-dist/index.html present");

  const require = createRequire(import.meta.url);
  const { build } = require(path.join(guiDir, "node_modules", "vite", "dist", "node", "index.js"));
  const outDir = await mkdtemp(path.join(os.tmpdir(), "dsc-gui-build-"));
  try {
    const result = await build({
      root: guiDir,
      logLevel: "error",
      build: { outDir, emptyOutDir: true },
      configFile: path.join(guiDir, "vite.renderer.config.mjs")
    });
    assert.ok(result, "vite build resolves");
    assert.ok(existsSync(path.join(outDir, "index.html")), "index.html emitted");
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test("GUI 桌面端冒烟:Electron 启动、全视图切换与事件链路验证", { timeout: 40000 }, async (t) => {
  const electronCli = path.resolve("gui", "node_modules", "electron", "cli.js");
  try {
    await access(electronCli);
  } catch {
    t.skip("Electron binary not installed under gui/node_modules");
    return;
  }

  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "dsc-gui-smoke-"));
  const userData = await mkdtemp(path.join(os.tmpdir(), "dsc-gui-userdata-"));
  t.after(() => {
    for (const p of [projectRoot, userData]) {
      try { rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  const env = {
    ...process.env,
    DEEPSEEK_CODE_GUI_SMOKE: "1",
    DEEPSEEK_CODE_GUI_USER_DATA: userData,
    DEEPSEEK_CODE_GUI_PROJECT_REGISTRY_DIR: path.join(userData, "registry"),
    DEEPSEEK_CODE_GUI_SMOKE_CLEANUP_DIRS: [projectRoot, userData].join(path.delimiter),
    ELECTRON_ENABLE_LOGGING: "1"
  };
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(process.execPath, [
    electronCli,
    "--disable-gpu",
    "--disable-gpu-compositing",
    "--disable-gpu-rasterization",
    "--disable-gpu-sandbox",
    "--no-sandbox",
    "--disable-features=UseSkiaRenderer,VizDisplayCompositor",
    ".",
    `--project=${projectRoot}`
  ], {
    cwd: path.resolve("gui"),
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => child.kill());

  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });

  const timer = setTimeout(() => child.kill(), 30000);
  await once(child, "exit");
  clearTimeout(timer);

  assert.match(output, /GUI_SMOKE_READY/);
  assert.match(output, /GUI_SMOKE_STEP:plan_verified/);
  assert.match(output, /GUI_SMOKE_STEP:inspector_verified/);
  assert.match(output, /GUI_SMOKE_STEP:diff_verified/);
  assert.match(output, /GUI_SMOKE_STEP:tool_cards_verified/);
  assert.match(output, /GUI_SMOKE_STEP:project_switch_verified/);
  assert.doesNotMatch(output, /TypeError|ReferenceError|SyntaxError/);
});
