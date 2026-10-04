// tests/e2e/tui-smoke.test.js — 门控真终端 smoke:装了 gui 的 node-pty 才跑,否则优雅 skip。
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp } from "../helpers/tmp.js";

const require = createRequire(import.meta.url);
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

let pty = null;
try { pty = require(path.join(repoRoot, "gui", "node_modules", "node-pty")); } catch { pty = null; }

test("tui smoke: boots offline, /help renders, /quit restores terminal", { skip: !pty && "gui node-pty not installed" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsc-tui-smoke-"));
  const term = pty.spawn(process.execPath, [path.join(repoRoot, "bin", "inkstone.js"), "tui"], {
    name: "xterm-256color", cols: 100, rows: 30, cwd: root,
    env: { ...process.env, NO_COLOR: "1" }
  });
  let out = "";
  term.onData((d) => { out += d; });
  const waitFor = async (fn, ms = 15000) => {
    const start = Date.now();
    while (!fn()) {
      if (Date.now() - start > ms) throw new Error(`smoke timeout; tail:\n${out.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  await waitFor(() => out.includes("❯"));            // 底部输入行出现
  term.write("/help\r");
  await waitFor(() => out.includes("/quit"));         // 命令列表渲染
  assert.ok(out.includes("/mode"));
  term.write("/quit\r");
  await waitFor(() => out.includes("\x1b[?2004l")); // 括号粘贴关闭 = 终端态恢复
  await new Promise((resolve) => term.onExit(resolve));
  // Windows ConPTY 在子进程退出后仍占事件循环句柄,显式 kill 释放(可能有无害 stderr 噪音)。
  try { term.kill(); } catch { /* 收尾尽力而为 */ }
  // ConPTY 释放是异步的:句柄未放完时删目录会 EBUSY,故短重试后放弃
  // (失败也仍会由 tests/helpers/tmp.js 的退出回收兜底)。
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { await rm(root, { recursive: true, force: true }); break; }
    catch { await new Promise((r) => setTimeout(r, 200)); }
  }
});
