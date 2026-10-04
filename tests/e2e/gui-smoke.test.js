import test from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { rmSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { mkdtemp } from "../helpers/tmp.js";

test("gui electron shell starts against a temp project", { timeout: 40000 }, async (t) => {
  const electronCli = path.resolve("gui", "node_modules", "electron", "cli.js");
  try {
    await access(electronCli);
  } catch {
    t.skip("Electron binary not installed under gui/node_modules");
    return;
  }

  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "dsc-gui-smoke-"));
  const userData = await mkdtemp(path.join(os.tmpdir(), "dsc-gui-userdata-"));
  // 冒烟是"分离进程 + 子进程自回收"的结构:临时脚手架由主进程在退出前删除,
  // 测试侧只做兜底(正常路径下这里已是空操作)。
  t.after(() => {
    for (const p of [projectRoot, userData]) {
      try { rmSync(p, { recursive: true, force: true }); } catch { /* 已被主进程回收 */ }
    }
  });
  const env = {
    ...process.env,
    DEEPSEEK_CODE_GUI_SMOKE: "1",
    DEEPSEEK_CODE_GUI_USER_DATA: userData,
    // 隔离全局项目 MRU 登记表(否则测试会把临时项目写进开发者真实项目列表),
    // 并授权主进程回收本次脚手架目录。
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
