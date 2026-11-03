// tests/unit/tui/helpers.js — TUI 全链路测试共用的注入桩。
import { PassThrough } from "node:stream";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "../../helpers/tmp.js";

export function makeIO() {
  const input = new PassThrough();
  input.setRawMode = () => {};
  input.isTTY = true;
  const output = new PassThrough();
  output.columns = 80;
  const chunks = [];
  output.on("data", (c) => chunks.push(String(c)));
  return { input, output, text: () => chunks.join("") };
}

export function makeFakeKernel({ onSend, onApprove, onInterrupt } = {}) {
  const subs = new Set();
  const kernel = {
    disposed: false,
    session: { subscribe(fn) { subs.add(fn); return { unsubscribe: () => subs.delete(fn) }; } },
    runtime: { getState: () => ({ current: "idle", channel: null }) },
    metrics: { getUsage: () => ({ total_tokens: 42, cache_hit_rate: 0.5 }) },
    agent: {
      send: (text, options) => onSend({ text, options, emit }),
      // v1.13.1:第三个参数是放行范围 scope(session/project/always)
      approve: (id, decision, opts) => onApprove({ id, decision, scope: opts?.scope }),
      interrupt: () => onInterrupt?.()
    },
    async dispose() { kernel.disposed = true; }
  };
  function emit(ev) { for (const fn of subs) fn(ev); }
  kernel.emit = emit;
  return kernel;
}

export async function until(fn, ms = 3000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

export async function tmpRoot() {
  // 经 tests/helpers/tmp.js:进程退出时统一回收,避免每轮测试堆一批 dsc-tui-*
  return mkdtemp(path.join(os.tmpdir(), "dsc-tui-"));
}
