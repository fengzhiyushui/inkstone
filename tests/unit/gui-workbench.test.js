// tests/unit/gui-workbench.test.js — GUI 工作台状态机、响应式布局、主题、设置、卡片派生与 IPC 契约
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createInitialState } from "../../gui/src/state/workbench-state.js";
import { layoutForWidth } from "../../gui/src/state/layout.js";
import { GUI_THEMES, isLightTheme, themeLabel } from "../../gui/src/state/themes.js";
import { SETTINGS_GROUPS, getByPath, setByPath } from "../../gui/src/state/settings-schema.js";
import { deriveAgentCards } from "../../gui/src/state/agent-cards.js";

const require = createRequire(import.meta.url);
const { resolveProjectRoot, zeroUsage } = require("../../gui/kernel-host.js");

test("workbench-state 纯初始状态与动作派生", () => {
  const initial = createInitialState();

  assert.equal(initial.activeBranchId, "br_main");
  assert.equal(initial.selectedBranchId, "br_main");
  assert.equal(initial.theme, "sumi");
  assert.equal(initial.sidebarWidth, 280);
  assert.equal(initial.emptyStateVisible, true);
  assert.equal("railMode" in initial, false);
});

test("layout 响应式断点计算与面板折叠逻辑", () => {
  assert.deepEqual(layoutForWidth(1400), { rail: true, sidebar: true, chat: true });
  assert.deepEqual(layoutForWidth(1200), { rail: true, sidebar: false, chat: true });
  assert.deepEqual(layoutForWidth(900), { rail: true, sidebar: false, chat: false });
  assert.deepEqual(layoutForWidth(700), { rail: false, sidebar: false, chat: false });

  assert.equal(layoutForWidth(760).rail, true);
  assert.equal(layoutForWidth(759).rail, false);
  assert.equal(layoutForWidth(1060).chat, true);
  assert.equal(layoutForWidth(1059).chat, false);
  assert.equal(layoutForWidth(1340).sidebar, true);
  assert.equal(layoutForWidth(1339).sidebar, false);
});

test("themes 主题群组判定、亮暗色识别与显示标签", () => {
  const lightThemes = GUI_THEMES.filter((t) => t.group === "light");
  assert.ok(lightThemes.length >= 3);
  for (const t of lightThemes) {
    assert.equal(isLightTheme(t.id), true);
  }

  const darkThemes = GUI_THEMES.filter((t) => t.group === "dark");
  assert.ok(darkThemes.length >= 3);
  for (const t of darkThemes) {
    assert.equal(isLightTheme(t.id), false);
  }

  assert.equal(isLightTheme("non-existent"), false);
  assert.ok(themeLabel("sumi"));
});

test("settings-schema 分节分组与点路径不可变读写", () => {
  assert.ok(SETTINGS_GROUPS.length >= 8);
  const ids = SETTINGS_GROUPS.map((g) => g.id);
  assert.ok(ids.includes("general"));
  assert.ok(ids.includes("api"));
  assert.ok(ids.includes("limits"));

  const config = { limits: { toolTimeoutMs: 60000 }, orchestration: { budget: { maxTokens: 100 } } };
  assert.equal(getByPath(config, "limits.toolTimeoutMs"), 60000);
  assert.equal(getByPath(config, "orchestration.budget.maxTokens"), 100);
  assert.equal(getByPath(config, "non.existent.path"), undefined);

  const updated = setByPath(config, "orchestration.budget.maxTokens", 200);
  assert.equal(updated.orchestration.budget.maxTokens, 200);
  assert.equal(config.orchestration.budget.maxTokens, 100);
  assert.notEqual(updated.orchestration, config.orchestration);
  assert.equal(updated.limits, config.limits);
});

test("agent-cards 从内核事件流派生智能体卡片展示序列", () => {
  const cards = deriveAgentCards([
    { type: "orchestration:planned", subtasks: 3 },
    { type: "tool:call", id: "t1", tool: "read_file" },
    { type: "tool:result", id: "t1", status: "ok" },
    { type: "file:diff_applied", change_id: "chg_1", files: ["src/a.js"], summary: [{ path: "src/a.js", status: "modify" }] }
  ]);

  const planCards = cards.filter((c) => c.kind === "plan");
  assert.equal(planCards.length, 1);
  assert.equal(planCards[0].subtasks, 3);

  const toolCards = cards.filter((c) => c.kind === "tool");
  assert.equal(toolCards.length, 1);
  assert.equal(toolCards[0].status, "ok");

  const diffCards = cards.filter((c) => c.kind === "diff");
  assert.equal(diffCards.length, 1);
  assert.equal(diffCards[0].changeId, "chg_1");
});

test("kernel-host 进程参数解析与核心桥接选项生成", () => {
  assert.equal(resolveProjectRoot(["electron", ".", "--project=D:\\my-repo"], "fallback"), "D:\\my-repo");
  assert.equal(resolveProjectRoot(["electron", "."], "fallback"), "fallback");

  const zero = zeroUsage();
  assert.equal(zero.total_tokens, 0);
  assert.equal(zero.total_prompt_tokens, 0);
  assert.equal(zero.total_completion_tokens, 0);
  assert.equal(zero.requests, 0);
});

test("table-driven IPC 契约一致性校验（preload vs main vs kernel-host）", () => {
  const mainSrc = readFileSync(new URL("../../gui/main.js", import.meta.url), "utf8");
  const preloadSrc = readFileSync(new URL("../../gui/preload.js", import.meta.url), "utf8");

  // Extract IPC_CHANNELS whitelist from main.js
  const channelMatch = mainSrc.match(/const IPC_CHANNELS = \[([\s\S]*?)\];/);
  assert.ok(channelMatch, "IPC_CHANNELS whitelist found in gui/main.js");
  const channels = channelMatch[1]
    .split(",")
    .map((s) => s.trim().replace(/['"]/g, ""))
    .filter(Boolean);

  assert.equal(channels.length, 69, "Whitelist contains exactly 69 verified channels");

  // Extract IPC_API from preload.js
  const apiMatches = [...preloadSrc.matchAll(/\["[^"]+",\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(apiMatches.length >= 60, "Preload exposes full API table");

  // Verify all channels used in preload are present in main.js whitelist
  for (const ch of apiMatches) {
    assert.ok(channels.includes(ch), `Channel '${ch}' from preload.js must be in main.js IPC_CHANNELS whitelist`);
  }
});
