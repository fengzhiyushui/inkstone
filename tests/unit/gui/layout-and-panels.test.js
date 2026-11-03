// tests/unit/gui/layout-and-panels.test.js — 布局与面板(文件树/过滤/保存 diff/变更派生/响应式)领域测试
//
// v1.19.1 测试归并:本文件由下列历史任务单测试合并而成,每个来源包裹在独立
// describe 块中(异步回调 + 动态 import,来源间零共享绑定),测试语义与拆分前一致。
import { describe } from "node:test";

// ---------------------------------------------------------------------------
// 来源:tests/unit/gui/layout.test.js
// ---------------------------------------------------------------------------
describe("unit/gui/layout", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { layoutForWidth } = await import("../../../gui/src/state/layout.js");

  test("breakpoints toggle panels (760 rail / 1060 chat / 1340 sidebar)", () => {
    assert.deepEqual(layoutForWidth(1400), { rail: true, sidebar: true, chat: true });
    assert.deepEqual(layoutForWidth(1200), { rail: true, sidebar: false, chat: true });
    assert.deepEqual(layoutForWidth(900), { rail: true, sidebar: false, chat: false });
    assert.deepEqual(layoutForWidth(700), { rail: false, sidebar: false, chat: false });
  });

  test("exact breakpoint boundaries are inclusive", () => {
    assert.equal(layoutForWidth(760).rail, true);
    assert.equal(layoutForWidth(759).rail, false);
    assert.equal(layoutForWidth(1060).chat, true);
    assert.equal(layoutForWidth(1059).chat, false);
    assert.equal(layoutForWidth(1340).sidebar, true);
    assert.equal(layoutForWidth(1339).sidebar, false);
  });

  test("non-numeric width is treated as 0 (all collapsed)", () => {
    assert.deepEqual(layoutForWidth(undefined), { rail: false, sidebar: false, chat: false });
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/gui/panels.test.js
// ---------------------------------------------------------------------------
describe("unit/gui/panels", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { isLivePanel } = await import("../../../gui/src/state/panels.js");

  test("chat/timeline/status are live", () => {
    assert.equal(isLivePanel("chat", {}), true);
    assert.equal(isLivePanel("timeline", {}), true);
    assert.equal(isLivePanel("status", {}), true);
  });

  test("filetree/editor/terminal are always placeholders in D-1", () => {
    assert.equal(isLivePanel("filetree", { activity: [{ type: "x" }] }), false);
    assert.equal(isLivePanel("editor", {}), false);
    assert.equal(isLivePanel("terminal", {}), false);
  });

  test("toolcards are live only when activity exists", () => {
    assert.equal(isLivePanel("toolcards", { activity: [{ type: "tool:call" }] }), true);
    assert.equal(isLivePanel("toolcards", { activity: [] }), false);
    assert.equal(isLivePanel("toolcards", {}), false);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/gui/file-filter.test.js
// ---------------------------------------------------------------------------
describe("unit/gui/file-filter", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { filterTree } = await import("../../../gui/src/state/file-filter.js");

  const tree = [
    { name: "src", type: "dir", path: "src", children: [
      { name: "index.js", type: "file", path: "src/index.js" },
      { name: "config.js", type: "file", path: "src/config.js" }
    ] },
    { name: "README.md", type: "file", path: "README.md" }
  ];

  test("empty query returns all", () => { assert.equal(filterTree(tree, ""), tree); });

  test("substring keeps matches + parent dirs", () => {
    const f = filterTree(tree, "index");
    assert.equal(f.length, 1);
    assert.equal(f[0].name, "src");
    assert.equal(f[0].children.length, 1);
    assert.equal(f[0].children[0].name, "index.js");
  });

  test("no match returns empty", () => { assert.deepEqual(filterTree(tree, "zzz"), []); });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/gui/file-tree.test.js
// ---------------------------------------------------------------------------
describe("unit/gui/file-tree", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { buildTree, treeFromPaths } = await import("../../../gui/src/state/file-tree.js");

  test("buildTree nests paths; dirs first then alphabetical", () => {
    const t = buildTree(["src/index.js", "README.md", "src/core/x.js"]);
    assert.equal(t[0].name, "src");
    assert.equal(t[0].type, "dir");
    assert.equal(t[1].name, "README.md");
    assert.equal(t[1].type, "file");
    const src = t[0].children;
    assert.equal(src[0].name, "core");
    assert.equal(src[0].type, "dir");
    assert.equal(src[1].name, "index.js");
    assert.equal(src[1].type, "file");
    assert.equal(src[0].children[0].path, "src/core/x.js");
  });

  test("buildTree empty → []", () => {
    assert.deepEqual(buildTree([]), []);
    assert.deepEqual(buildTree(null), []);
  });

  test("treeFromPaths builds nested dirs, dirs first, sorted", () => {
    const t = treeFromPaths(["src/b.js", "src/a.js", "README.md", "src/lib/x.js"]);
    assert.deepEqual(t.map((n) => n.name), ["src", "README.md"]);
    assert.deepEqual(t[0].children.map((n) => n.name), ["lib", "a.js", "b.js"]);
    assert.equal(t[0].children[0].children[0].path, "src/lib/x.js");
    assert.equal(t[0].type, "directory");
    assert.equal(t[1].type, "file");
  });

  test("treeFromPaths tolerates empty and duplicate input", () => {
    assert.deepEqual(treeFromPaths([]), []);
    assert.equal(treeFromPaths(["a.js", "a.js"]).length, 1);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/gui/save-diff.test.js
// ---------------------------------------------------------------------------
describe("unit/gui/save-diff", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { wholeFileDiff } = await import("../../../gui/src/state/save-diff.js");

  test("before equals after produces empty diff (nothing to save)", () => {
    assert.equal(wholeFileDiff("a.js", "x\n", "x\n"), "");
  });

  test("diff has file headers, hunk, and -old/+new lines", () => {
    const d = wholeFileDiff("a.js", "one\ntwo", "one\nTWO");
    assert.match(d, /--- a\/a\.js/);
    assert.match(d, /\+\+\+ b\/a\.js/);
    assert.match(d, /@@ -1,2 \+1,2 @@/);
    assert.match(d, /-two/);
    assert.match(d, /\+TWO/);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/gui/changes-derive.test.js
// ---------------------------------------------------------------------------
describe("unit/gui/changes-derive", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { deriveChangeEntries, statusLetter, clampLine, shortTime } = await import("../../../gui/src/state/changes-derive.js");

  test("deriveChangeEntries: source tag, normalization, rollback flag", () => {
    const entries = deriveChangeEntries([
      { id: "c2", time: "2026-07-02T10:00:00.000Z", prompt: "GUI edit src/a.js", rolledBack: false,
        files: [{ path: "src/a.js", status: "modify", added: 2, removed: 1, hunkStarts: [1] }] },
      { id: "c1", time: "2026-07-02T09:00:00.000Z", prompt: "fix login bug", rolledBack: true,
        files: [{ path: "src/auth.js", status: "create", added: null, removed: null, hunkStarts: null }] },
      null,
      { time: "no-id-dropped" }
    ]);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].source, "manual");
    assert.equal(entries[1].source, "agent");
    assert.equal(entries[1].rolledBack, true);
    assert.match(entries[0].timeShort, /^\d{2}-\d{2} \d{2}:\d{2}$/);
    assert.equal(entries[0].files[0].added, 2);
    assert.equal(entries[1].files[0].added, null);
  });

  test("long prompt truncated with ellipsis; bad time → empty", () => {
    const [e] = deriveChangeEntries([{ id: "c", time: "bogus", prompt: "x".repeat(80), files: [] }]);
    assert.equal(e.timeShort, "");
    assert.ok(e.promptShort.length <= 42);
    assert.ok(e.promptShort.endsWith("…"));
    assert.equal(shortTime("not-a-date"), "");
  });

  test("statusLetter + clampLine", () => {
    assert.equal(statusLetter("create"), "A");
    assert.equal(statusLetter("delete"), "D");
    assert.equal(statusLetter("modify"), "M");
    assert.equal(clampLine(7, 100), 7);
    assert.equal(clampLine(999, 10), 10);
    assert.equal(clampLine(0, 10), 1);
    assert.equal(clampLine(NaN, 10), 1);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/gui/v1100-responsive-layout.test.js
// ---------------------------------------------------------------------------
describe("unit/gui/v1100-responsive-layout", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

  test("four version spots are synchronized to the product version", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
    const theme = readFileSync(join(ROOT, "src/theme.js"), "utf8");
    const app = readFileSync(join(ROOT, "gui/src/App.jsx"), "utf8");

    assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
    assert.equal(lock.version, pkg.version);
    assert.equal(lock.packages[""].version, pkg.version);
    assert.equal(theme.match(/export const VERSION = "([^"]+)";/)?.[1], pkg.version);
    assert.equal(app.match(/const VERSION = "([^"]+)";/)?.[1], pkg.version);
  });

  test("v1.10.0: IPC_CHANNELS whitelist includes gui:modal-active and preload exposes setModalActive", () => {
    const mainJs = readFileSync(join(ROOT, "gui/main.js"), "utf8");
    const preloadJs = readFileSync(join(ROOT, "gui/preload.js"), "utf8");
    const useKernelJs = readFileSync(join(ROOT, "gui/src/hooks/useKernel.js"), "utf8");

    assert.match(mainJs, /"gui:modal-active"/, "main.js IPC_CHANNELS must include gui:modal-active");
    assert.match(mainJs, /handle\("gui:modal-active"/, "main.js must handle gui:modal-active");
    assert.match(preloadJs, /setModalActive:\s*\(active\)\s*=>\s*ipcRenderer\.invoke\("gui:modal-active"/, "preload.js must expose setModalActive");
    assert.match(useKernelJs, /setModalActive:\s*\(active\)/, "useKernel.js must export setModalActive");
  });

  test("v1.10.0: .btn and .api-item prevent vertical text wrapping and squishing", () => {
    const themeCss = readFileSync(join(ROOT, "gui/src/styles/theme.css"), "utf8");
    const secondaryViews = readFileSync(join(ROOT, "gui/src/components/v4/SecondaryViews.jsx"), "utf8");

    assert.match(themeCss, /\.btn\s*\{[^}]*white-space:\s*nowrap/i, ".btn must have white-space: nowrap");
    assert.match(themeCss, /\.btn\s*\{[^}]*flex-shrink:\s*0/i, ".btn must have flex-shrink: 0");
    assert.match(themeCss, /\.api-item\s*\{[^}]*flex-wrap:\s*wrap/i, ".api-item must support flex-wrap: wrap");
    assert.match(themeCss, /\.api-item\s+\.ai-actions/i, "theme.css must define .ai-actions container");
    assert.match(secondaryViews, /className="ai-actions"/, "SecondaryViews must wrap action buttons in ai-actions");
    assert.match(secondaryViews, /className="ai-info"/, "SecondaryViews must wrap card info in ai-info");
  });

  test("v1.10.0: Dock tabs prevent vertical two-line text wrapping and allow horizontal overflow", () => {
    const dockCss = readFileSync(join(ROOT, "gui/src/components/v4/Dock.module.css"), "utf8");

    assert.match(dockCss, /\.tab\s*\{[^}]*white-space:\s*nowrap/i, ".tab must have white-space: nowrap");
    assert.match(dockCss, /\.tab\s*\{[^}]*flex-shrink:\s*0/i, ".tab must have flex-shrink: 0");
    assert.match(dockCss, /\.tabbar\s*\{[^}]*overflow-x:\s*auto/i, ".tabbar must support horizontal scroll");
  });

  test("v1.10.0: Composer action pills prevent vertical wrapping and constrain rightGroup within card", () => {
    const composerCss = readFileSync(join(ROOT, "gui/src/components/v4/Composer.module.css"), "utf8");

    assert.match(composerCss, /\.permissionChip\s*\{[^}]*white-space:\s*nowrap/i, ".permissionChip must have white-space: nowrap");
    assert.match(composerCss, /\.permissionChip\s*\{[^}]*flex-shrink:\s*0/i, ".permissionChip must have flex-shrink: 0");
    assert.match(composerCss, /\.apiNoticePill\s*\{[^}]*white-space:\s*nowrap/i, ".apiNoticePill must have white-space: nowrap");
    assert.match(composerCss, /\.apiNoticePill\s*\{[^}]*flex-shrink:\s*0/i, ".apiNoticePill must have flex-shrink: 0");
    assert.match(composerCss, /\.modelPill\s*\{[^}]*white-space:\s*nowrap/i, ".modelPill must have white-space: nowrap");
    assert.match(composerCss, /\.modelPill\s*\{[^}]*flex-shrink:\s*1/i, ".modelPill must have flex-shrink: 1 to adapt to card width");
    assert.match(composerCss, /\.row\s*\{[^}]*flex-wrap:\s*wrap/i, ".row must support responsive flex-wrap: wrap");
    assert.match(composerCss, /\.row\s*\{[^}]*max-width:\s*100%/i, ".row must constrain max-width: 100%");
    assert.match(composerCss, /\.rightGroup\s*\{[^}]*max-width:\s*100%/i, ".rightGroup must constrain max-width: 100% to keep sendBtn inside card");
    assert.match(composerCss, /\.rightGroup\s*\{[^}]*flex-shrink:\s*1/i, ".rightGroup must allow flex-shrink: 1");
    assert.match(composerCss, /\.sendBtn\s*\{[^}]*flex-shrink:\s*0/i, ".sendBtn must maintain its circle button dimension");
  });

  test("v1.10.0: Dock fills grid column with inset: 0 to prevent left clipping, and Rail dock active state respects chat view", () => {
    const dockCss = readFileSync(join(ROOT, "gui/src/components/v4/Dock.module.css"), "utf8");
    const dockJsx = readFileSync(join(ROOT, "gui/src/components/v4/Dock.jsx"), "utf8");
    const railJsx = readFileSync(join(ROOT, "gui/src/components/v4/Rail.jsx"), "utf8");
    const appJsx = readFileSync(join(ROOT, "gui/src/App.jsx"), "utf8");

    assert.match(dockCss, /\.dock\s*\{[^}]*inset:\s*0/i, ".dock must use inset: 0 to fit column exactly");
    assert.doesNotMatch(dockJsx, /className=\{css\.dock\}\s+style=\{\{\s*width:\s*rightbarWidth\s*\}\}/, "Dock.jsx must not force inline width overriding grid column");
    assert.match(railJsx, /dock && state\.dockTab === dock && state\.rightbarOpen && view === "chat"/, "Rail must only highlight dock item in chat view");
    assert.match(appJsx, /rightbarOpen=\{\s*Boolean\(state\.rightbarOpen && isWorkspaceView\)\s*\}/, "App.jsx must only open rightbar in workspace/chat view");
  });

  test("v1.10.0: titleBarOverlay uses transparent background (#00000000) for seamless theme and modal integration", () => {
    const mainJs = readFileSync(join(ROOT, "gui/main.js"), "utf8");

    assert.match(mainJs, /color:\s*["']#00000000["']/, "main.js initial titleBarOverlay must use #00000000 transparent color");
    assert.match(mainJs, /handle\("gui:modal-active",\s*async\s*\(_event,\s*active\)\s*=>\s*\{[\s\S]*color:\s*["']#00000000["']/, "main.js modal-active must use #00000000 transparent color");
    assert.match(mainJs, /handle\("gui:preferences-set",\s*async\s*\(_event,\s*patch\)\s*=>\s*\{[\s\S]*color:\s*["']#00000000["']/, "main.js preferences-set must preserve #00000000 transparent color");
  });

  test("v1.10.0: Settings navigation displays distinct active indicator and Rail .who button is interactive", () => {
    const settingsJsx = readFileSync(join(ROOT, "gui/src/components/Settings/Settings.jsx"), "utf8");
    const settingsModalCss = readFileSync(join(ROOT, "gui/src/components/Settings/SettingsModal.module.css"), "utf8");
    const railJsx = readFileSync(join(ROOT, "gui/src/components/v4/Rail.jsx"), "utf8");

    assert.match(settingsJsx, /className=\{`item \$\{css\.item\} \$\{active === g\.id \? `\$\{css\.on\} on` : ""\}`\}/, "Settings.jsx must pass css.on to active nav button");
    assert.match(settingsModalCss, /\.item\.on,\s*\.item:global\(\.on\),\s*\.item\[aria-current="true"\]/s, "SettingsModal.module.css must handle module class, global class, and aria-current");
    assert.match(settingsModalCss, /box-shadow:\s*inset\s*3px\s*0\s*0\s*var\(--accent\)/, "SettingsModal.module.css must show accent indicator bar");
    assert.match(railJsx, /<button[^>]*className=\{`who \$\{css\.who\}`\}[^>]*onClick=\{\(\)\s*=>\s*setView\("projects"\)\}/s, "Rail.jsx must render .who as clickable button to projects");
  });

  test("v1.10.0: Rail sidebar supports project removal and session deletion with confirm protection and backend IPC", () => {
    const mainJs = readFileSync(join(ROOT, "gui/main.js"), "utf8");
    const preloadJs = readFileSync(join(ROOT, "gui/preload.js"), "utf8");
    const useKernelJs = readFileSync(join(ROOT, "gui/src/hooks/useKernel.js"), "utf8");
    const railJsx = readFileSync(join(ROOT, "gui/src/components/v4/Rail.jsx"), "utf8");
    const railCss = readFileSync(join(ROOT, "gui/src/components/v4/Rail.module.css"), "utf8");
    const themeCss = readFileSync(join(ROOT, "gui/src/styles/theme.css"), "utf8");
    const stringsJs = readFileSync(join(ROOT, "gui/src/i18n/strings.js"), "utf8");

    assert.match(mainJs, /"sessions:delete"/, "main.js IPC_CHANNELS whitelist must include sessions:delete");
    assert.match(mainJs, /handle\("sessions:delete"/, "main.js must register sessions:delete handler");
    assert.match(preloadJs, /deleteSession:\s*\(sessionId,\s*options\)\s*=>\s*ipcRenderer\.invoke\("sessions:delete"/, "preload.js must expose deleteSession");
    assert.match(useKernelJs, /deleteSession:\s*async\s*\(sessionId,\s*options\)/, "useKernel.js must implement deleteSession");

    assert.match(railJsx, /handleRemoveProject/, "Rail.jsx must define handleRemoveProject");
    assert.match(railJsx, /handleDeleteSession/, "Rail.jsx must define handleDeleteSession");
    assert.match(railJsx, /className=\{`pdel\s+\$\{css\.iconbtn\}\s+\$\{css\.pdel\}`\}/, "Rail.jsx must render pdel button");
    assert.match(railJsx, /className=\{`sdel\s+\$\{css\.sessionDelBtn\}`\}/, "Rail.jsx must render sdel button");

    assert.match(railCss, /\.pdel\s*\{/, "Rail.module.css must style .pdel");
    assert.match(railCss, /\.sessionDelBtn\s*\{/, "Rail.module.css must style .sessionDelBtn");
    assert.match(themeCss, /\.pdel\s*\{/, "theme.css must declare .pdel");
    assert.match(themeCss, /\.sdel\s*\{/, "theme.css must declare .sdel");

    assert.match(stringsJs, /"rail\.removeProject"/, "strings.js must have rail.removeProject");
    assert.match(stringsJs, /"rail\.deleteSession"/, "strings.js must have rail.deleteSession");
  });

  test("v1.10.0: High-end ConfirmModal replaces window.confirm and typography is unified with tabular-nums", () => {
    const appJsx = readFileSync(join(ROOT, "gui/src/App.jsx"), "utf8");
    const railJsx = readFileSync(join(ROOT, "gui/src/components/v4/Rail.jsx"), "utf8");
    const confirmJsx = readFileSync(join(ROOT, "gui/src/components/v4/ConfirmModal.jsx"), "utf8");
    const themeCss = readFileSync(join(ROOT, "gui/src/styles/theme.css"), "utf8");
    const tokensCss = readFileSync(join(ROOT, "gui/src/styles/tokens.css"), "utf8");

    assert.match(appJsx, /<ConfirmModal/, "App.jsx must render ConfirmModal");
    assert.match(appJsx, /onRequestConfirm=\{requestConfirm\}/, "App.jsx must wire requestConfirm to Rail and ProjectsView");
    assert.match(railJsx, /onRequestConfirm\(\{/, "Rail.jsx must call onRequestConfirm instead of native alert/confirm");
    assert.match(confirmJsx, /role="dialog"/, "ConfirmModal must have accessible dialog role");
    assert.match(confirmJsx, /cm-card/, "ConfirmModal must render cm-card");

    assert.match(tokensCss, /Microsoft YaHei UI/, "tokens.css must prioritize Microsoft YaHei UI for clean baseline alignment");
    assert.match(tokensCss, /Segoe UI Variable Text/, "tokens.css must include modern Segoe UI Variable font");
    assert.match(tokensCss, /JetBrains Mono/, "tokens.css must include JetBrains Mono in mono font stack");

    assert.match(themeCss, /text-rendering:\s*optimizeLegibility/, "theme.css must enable optimizeLegibility");
    assert.match(themeCss, /font-variant-numeric:\s*tabular-nums/, "theme.css must use tabular-nums on badges and counts");
    assert.match(themeCss, /\.cm-backdrop\s*\{/, "theme.css must define .cm-backdrop");
    assert.match(themeCss, /\.cm-card\s*\{/, "theme.css must define .cm-card");
  });
});
