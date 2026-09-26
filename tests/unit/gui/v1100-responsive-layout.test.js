import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

test("v1.10.0: four version spots are synchronized to 1.10.0", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
  const theme = readFileSync(join(ROOT, "src/theme.js"), "utf8");
  const app = readFileSync(join(ROOT, "gui/src/App.jsx"), "utf8");

  assert.equal(pkg.version, "1.10.0", "package.json version should be 1.10.0");
  assert.equal(lock.version, "1.10.0", "package-lock.json root version should be 1.10.0");
  assert.match(theme, /export const VERSION = "1\.10\.0";/, "src/theme.js VERSION should be 1.10.0");
  assert.match(app, /const VERSION = "1\.10\.0";/, "gui/src/App.jsx VERSION should be 1.10.0");
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
