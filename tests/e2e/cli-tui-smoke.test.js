// tests/e2e/cli-tui-smoke.test.js — CLI 与 TUI 冒烟测试
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp } from "../helpers/tmp.js";
import { runKernelAgentCommand } from "../../src/apps/cli/kernel-runner.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const binPath = path.join(repoRoot, "bin", "inkstone.js");
const require = createRequire(import.meta.url);

let pty = null;
try { pty = require(path.join(repoRoot, "gui", "node_modules", "node-pty")); } catch { pty = null; }

test("CLI 冒烟:子进程退出码透传与离线问答执行", async () => {
  const testRoot = await mkdtemp(path.join(os.tmpdir(), "dsc-cli-smoke-test-"));
  const child = spawnSync(
    process.execPath,
    [binPath, "test", process.execPath, "-e", "process.exit(7)"],
    { cwd: testRoot, encoding: "utf8" }
  );
  assert.equal(child.status, 7, `stdout:\n${child.stdout}\nstderr:\n${child.stderr}`);

  const askRoot = await mkdtemp(path.join(os.tmpdir(), "dsc-cli-ask-"));
  const lines = [];
  const result = await runKernelAgentCommand({
    root: askRoot,
    prompt: "你好",
    write: (line) => lines.push(line),
    createKernelImpl: async () => ({
      session: {
        subscribe(handler) {
          handler({ type: "agent:final", content: "你好，我是 Inkstone。" });
          return { unsubscribe() {} };
        }
      },
      agent: {
        send: async () => ({ status: "complete", content: "你好，我是 Inkstone。" })
      }
    })
  });

  assert.equal(result.status, "complete");
  assert.equal(lines.some((line) => /response_format|json_object|Prompt must contain/i.test(line)), false);
  assert.ok(lines.some((line) => line.includes("你好，我是 Inkstone。")));
});

test("TUI 冒烟:伪终端启动、/help渲染与/quit恢复终端", { skip: !pty && "gui node-pty not installed" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsc-tui-smoke-"));
  const term = pty.spawn(process.execPath, [binPath, "tui"], {
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
  await waitFor(() => out.includes("❯"));
  term.write("/help\r");
  await waitFor(() => out.includes("/quit"));
  assert.ok(out.includes("/mode"));
  term.write("/quit\r");
  await waitFor(() => out.includes("\x1b[?2004l"));
  await new Promise((resolve) => term.onExit(resolve));
  try { term.kill(); } catch { /* ignore */ }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { await rm(root, { recursive: true, force: true }); break; }
    catch { await new Promise((r) => setTimeout(r, 200)); }
  }
});
