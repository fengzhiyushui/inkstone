import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

test("gui electron shell starts against a temp project", { timeout: 20000 }, async (t) => {
  const electronCli = path.resolve("gui", "node_modules", "electron", "cli.js");
  try {
    await access(electronCli);
  } catch {
    t.skip("Electron binary not installed under gui/node_modules");
    return;
  }

  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "dsc-gui-smoke-"));
  const userData = await mkdtemp(path.join(os.tmpdir(), "dsc-gui-userdata-"));
  const env = {
    ...process.env,
    DEEPSEEK_CODE_GUI_SMOKE: "1",
    DEEPSEEK_CODE_GUI_USER_DATA: userData,
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

  const timer = setTimeout(() => child.kill(), 15000);
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
