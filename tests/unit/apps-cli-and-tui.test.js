// tests/unit/apps-cli-and-tui.test.js — CLI 与 TUI 应用层、Slash 命令、视图渲染与项目索引
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { writeFile } from "node:fs/promises";
import { mkdtemp } from "../helpers/tmp.js";
import { makeIO, makeFakeKernel } from "../helpers/apps-helpers.js";
import { parseSlash, filterCommands } from "../../src/apps/tui/slash.js";
import { initialTuiState, reduce } from "../../src/apps/tui/tui-state.js";
import { computeBottom } from "../../src/apps/tui/paint.js";
import { buildProjectContext } from "../../src/context/project-index.js";
import { summarizeKernelEvent } from "../../src/apps/cli/render-events.js";
import { createTuiApp } from "../../src/apps/tui/tui-app.js";

test("slash 命令解析与过滤（parseSlash 与 filterCommands）", () => {
  assert.deepEqual(parseSlash("/help"), { name: "help", arg: "" });
  assert.deepEqual(parseSlash("/theme sumi"), { name: "theme", arg: "sumi" });
  assert.deepEqual(parseSlash("/mode gated extra args"), { name: "mode", arg: "gated extra args" });

  assert.equal(parseSlash("not_a_slash"), null);
  assert.equal(parseSlash("/"), null);

  const matched = filterCommands("th");
  assert.ok(matched.some((c) => c.name === "theme"));

  const allSlash = filterCommands("");
  assert.ok(allSlash.length >= 10);
});

test("tui-state 纯 reducer 与状态机动作转换", () => {
  const initial = initialTuiState({ lang: "zh", mode: "gated", theme: "sumi" });
  assert.equal(initial.screen, "home");
  assert.equal(initial.input.text, "");

  const s1 = reduce(initial, { type: "input_insert", text: "hello" });
  assert.equal(s1.input.text, "hello");
  assert.equal(s1.input.cursor, 5);

  const s2 = reduce(s1, { type: "input_left" });
  assert.equal(s2.input.cursor, 4);

  const s3 = reduce(s2, { type: "input_backspace" });
  assert.equal(s3.input.text, "helo");
  assert.equal(s3.input.cursor, 3);

  const s4 = reduce(s3, { type: "screen_set", screen: "chat" });
  assert.equal(s4.screen, "chat");
});

test("tui paint 底部固定区视口与状态行计算", () => {
  const state = initialTuiState();
  const bottom = computeBottom(state, (k) => k, 80);

  assert.ok(Array.isArray(bottom.lines));
  assert.ok(bottom.lines.length >= 2);
  assert.ok(Number.isFinite(bottom.cursorRow));
  assert.ok(Number.isFinite(bottom.cursorCol));
});

test("buildProjectContext 项目文件索引与摘要收集", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "dsc-proj-idx-"));
  await writeFile(path.join(tempDir, "README.md"), "# Test Project\nSample description.");
  await writeFile(path.join(tempDir, "package.json"), JSON.stringify({ name: "test-proj", version: "1.0.0" }));
  await writeFile(path.join(tempDir, "index.js"), "console.log('hello');");

  const context = await buildProjectContext(tempDir);
  assert.ok(Array.isArray(context.files));
  assert.ok(context.files.includes("README.md"));
  assert.ok(context.files.includes("package.json"));
  assert.ok(context.files.includes("index.js"));

  assert.ok(context.indexText.includes("README.md"));
  assert.ok(context.stats.indexed_files >= 3);
});

test("apps-helpers makeIO 与 makeFakeKernel 契约测试", async () => {
  const io = makeIO();
  io.output.write("test output chunk");
  assert.equal(io.text(), "test output chunk");

  let sentMessage = null;
  const fakeKernel = makeFakeKernel({
    onSend: ({ text }) => {
      sentMessage = text;
      return { status: "complete", content: "kernel reply" };
    },
    onApprove: () => ({ status: "complete" })
  });

  const response = await fakeKernel.agent.send("hello from tui");
  assert.equal(sentMessage, "hello from tui");
  assert.equal(response.content, "kernel reply");
  assert.equal(fakeKernel.runtime.getState().current, "idle");

  await fakeKernel.dispose();
  assert.equal(fakeKernel.disposed, true);
});

test("render-events CLI 事件流格式化与状态标记", () => {
  const finalSummary = summarizeKernelEvent({
    type: "agent:final",
    content: "All tests pass",
    status: "complete"
  });
  assert.ok(finalSummary);

  const routeSummary = summarizeKernelEvent({
    type: "orchestration:routed",
    lane: "orchestrate"
  });
  assert.ok(routeSummary);
  assert.ok(routeSummary.includes("multi-agent") || routeSummary.includes("orchestrate"));
});

test("tui-app 键盘交互与事件流集成", async () => {
  const io = makeIO();
  let interrupts = 0;
  const fakeKernel = makeFakeKernel({
    onSend: () => ({ status: "complete" }),
    onInterrupt: () => { interrupts += 1; }
  });

  const app = createTuiApp({
    kernel: fakeKernel,
    input: io.input,
    output: io.output,
    root: process.cwd()
  });

  assert.ok(app);
  if (typeof app.stop === "function") {
    await app.stop();
  }
});
