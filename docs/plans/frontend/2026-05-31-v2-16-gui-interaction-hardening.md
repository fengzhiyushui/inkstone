# V2-16 GUI Interaction Hardening & Release Polish Implementation Plan

> 完成状态以 [CHANGELOG](../../CHANGELOG.md) 为准。


**Goal:** Harden the V2 GUI workbench interactions with persisted preferences, explicit drawer/inspector lifecycle, keyboard shortcuts, and Electron smoke coverage.

**Architecture:** Keep the V2-15 renderer architecture and add a small GUI preference bridge through Electron IPC. Renderer state remains pure in `workbench-state.js`; `app.js` coordinates DOM, shortcuts, focus, and persistence; `kernel-host.js` owns project-root-scoped preference file helpers.

**Tech Stack:** Electron 30, CommonJS GUI host/preload, plain browser JavaScript renderer, Node test runner, PowerShell on Windows.

---

## File Structure

- `gui/kernel-host.js`: add `loadGuiPreferences(projectRoot)`, `saveGuiPreferences(projectRoot, patch)`, `normalizeGuiPreferences(value)`, and expose `getPreferences` / `setPreferences` on host.
- `gui/main.js`: register `gui:preferences-get` and `gui:preferences-set` IPC channels.
- `gui/preload.js`: expose `getPreferences()` and `setPreferences(patch)` in `window.deepseek`.
- `gui/renderer/workbench-state.js`: add preference hydration/action helpers, explicit inspector close state, and keyboard-safe actions.
- `gui/renderer/index.html`: add inspector close button with stable ID.
- `gui/renderer/style.css`: style close button and drawer state without changing the V2-15 visual identity.
- `gui/renderer/app.js`: load preferences, persist preference-changing actions, bind keyboard shortcuts, manage inspector/context close and focus.
- `tests/unit/gui/kernel-host.test.js`: preference helper and host delegate tests.
- `tests/unit/gui/renderer-static.test.js`: static contract for preference bridge usage, close button, and shortcut tokens.
- `tests/unit/gui/workbench-state.test.js`: state tests for preference hydration and inspector close behavior.
- `tests/e2e/gui-smoke.test.js`: Electron shell smoke with temp project root, skipped only if Electron is unavailable.

## Task 1: GUI Preference Helpers

**Files:**
- Modify: `gui/kernel-host.js`
- Test: `tests/unit/gui/kernel-host.test.js`

- [ ] **Step 1: Write failing tests**

Append these tests to `tests/unit/gui/kernel-host.test.js`:

```js
test("gui preferences normalize invalid values to safe defaults", () => {
  const { normalizeGuiPreferences } = require("../../../gui/kernel-host.js");

  assert.deepEqual(normalizeGuiPreferences({
    schema: 99,
    theme: "neon",
    railMode: "unknown",
    contextCollapsed: "yes",
    transcript: "must not persist"
  }), {
    schema: 1,
    theme: "night",
    railMode: "chat",
    contextCollapsed: false
  });
});

test("gui preferences load missing corrupt and save sanitized values", async () => {
  const { loadGuiPreferences, saveGuiPreferences } = require("../../../gui/kernel-host.js");
  const { mkdtemp, readFile, writeFile } = require("node:fs/promises");
  const os = require("node:os");
  const path = require("node:path");

  const root = await mkdtemp(path.join(os.tmpdir(), "dsc-gui-pref-"));
  assert.equal((await loadGuiPreferences(root)).theme, "night");

  await saveGuiPreferences(root, { theme: "day", railMode: "branches", contextCollapsed: true, secret: "x" });
  assert.deepEqual(await loadGuiPreferences(root), {
    schema: 1,
    theme: "day",
    railMode: "branches",
    contextCollapsed: true
  });

  const raw = await readFile(path.join(root, ".deepseek-code", "gui-preferences.json"), "utf8");
  assert.equal(raw.includes("secret"), false);

  await writeFile(path.join(root, ".deepseek-code", "gui-preferences.json"), "{not json");
  assert.equal((await loadGuiPreferences(root)).theme, "night");
});

test("kernel host exposes gui preference delegates", async () => {
  const { createKernelHost } = require("../../../gui/kernel-host.js");
  const { mkdtemp } = require("node:fs/promises");
  const os = require("node:os");
  const path = require("node:path");

  const root = await mkdtemp(path.join(os.tmpdir(), "dsc-gui-host-pref-"));
  const host = createKernelHost({
    projectRoot: root,
    kernelFactory: async () => ({
      session: { subscribe: () => ({ unsubscribe() {} }) },
      context: { snapshot: () => ({ units: [] }) },
      config: { getPublicConfig: () => ({}) },
      runtime: { getState: () => ({ current: "idle" }) }
    })
  });
  await host.init();

  await host.setPreferences({ theme: "day", railMode: "timeline" });
  assert.equal((await host.getPreferences()).theme, "day");
  assert.equal((await host.getPreferences()).railMode, "timeline");
});
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```powershell
npm.cmd test -- tests/unit/gui/kernel-host.test.js
```

Expected: FAIL because `normalizeGuiPreferences`, `loadGuiPreferences`, `saveGuiPreferences`, `getPreferences`, or `setPreferences` is missing.

- [ ] **Step 3: Implement preference helpers**

In `gui/kernel-host.js`:

```js
const fs = require("fs/promises");

const GUI_PREFERENCE_DEFAULTS = Object.freeze({
  schema: 1,
  theme: "night",
  railMode: "chat",
  contextCollapsed: false
});

function guiPreferencePath(projectRoot) {
  return path.join(projectRoot, ".deepseek-code", "gui-preferences.json");
}

function normalizeGuiPreferences(value = {}) {
  const input = value && typeof value === "object" ? value : {};
  return {
    schema: 1,
    theme: input.theme === "day" ? "day" : "night",
    railMode: ["chat", "context", "branches", "timeline", "settings"].includes(input.railMode) ? input.railMode : "chat",
    contextCollapsed: typeof input.contextCollapsed === "boolean" ? input.contextCollapsed : false
  };
}

async function loadGuiPreferences(projectRoot) {
  try {
    const raw = await fs.readFile(guiPreferencePath(projectRoot), "utf8");
    return normalizeGuiPreferences(JSON.parse(raw));
  } catch {
    return { ...GUI_PREFERENCE_DEFAULTS };
  }
}

async function saveGuiPreferences(projectRoot, patch = {}) {
  const current = await loadGuiPreferences(projectRoot);
  const next = normalizeGuiPreferences({ ...current, ...patch });
  const target = guiPreferencePath(projectRoot);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(next, null, 2), "utf8");
  return next;
}
```

Inside `createKernelHost`, add:

```js
async function getPreferences() {
  return loadGuiPreferences(projectRoot);
}

async function setPreferences(patch = {}) {
  return saveGuiPreferences(projectRoot, patch);
}
```

Return these methods from the host object. Export the helper functions:

```js
module.exports = {
  createKernelHost,
  resolveProjectRoot,
  zeroUsage,
  buildKernelOptions,
  normalizeGuiPreferences,
  loadGuiPreferences,
  saveGuiPreferences
};
```

- [ ] **Step 4: Run tests to verify GREEN**

Run:

```powershell
npm.cmd test -- tests/unit/gui/kernel-host.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add gui/kernel-host.js tests/unit/gui/kernel-host.test.js
git commit -m "feat(v2): persist gui workbench preferences"
```

## Task 2: IPC Preference Bridge

**Files:**
- Modify: `gui/main.js`
- Modify: `gui/preload.js`
- Test: `tests/unit/gui/renderer-static.test.js`

- [ ] **Step 1: Write failing static tests**

Append to `tests/unit/gui/renderer-static.test.js`:

```js
test("gui preload and main expose preference ipc bridge", async () => {
  const main = await readFile("gui/main.js", "utf8");
  const preload = await readFile("gui/preload.js", "utf8");

  assert.ok(main.includes("gui:preferences-get"));
  assert.ok(main.includes("gui:preferences-set"));
  assert.ok(preload.includes("getPreferences"));
  assert.ok(preload.includes("setPreferences"));
  assert.ok(preload.includes("gui:preferences-get"));
  assert.ok(preload.includes("gui:preferences-set"));
});
```

- [ ] **Step 2: Run test to verify RED**

Run:

```powershell
npm.cmd test -- tests/unit/gui/renderer-static.test.js
```

Expected: FAIL because preference IPC tokens are missing.

- [ ] **Step 3: Implement IPC bridge**

In `gui/main.js`, add both channels to `IPC_CHANNELS`:

```js
"gui:preferences-get", "gui:preferences-set",
```

Register handlers:

```js
ipcMain.handle("gui:preferences-get", async () => {
  try { return await host.getPreferences(); }
  catch (error) { return { error: error.message }; }
});
ipcMain.handle("gui:preferences-set", async (_event, patch) => {
  try { return await host.setPreferences(patch || {}); }
  catch (error) { return { error: error.message }; }
});
```

In `gui/preload.js`, expose:

```js
getPreferences: () => ipcRenderer.invoke("gui:preferences-get"),
setPreferences: (patch) => ipcRenderer.invoke("gui:preferences-set", patch || {}),
```

- [ ] **Step 4: Run test to verify GREEN**

Run:

```powershell
npm.cmd test -- tests/unit/gui/renderer-static.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add gui/main.js gui/preload.js tests/unit/gui/renderer-static.test.js
git commit -m "feat(v2): expose gui preference ipc"
```

## Task 3: State Hydration and Inspector Close

**Files:**
- Modify: `gui/renderer/workbench-state.js`
- Test: `tests/unit/gui/workbench-state.test.js`

- [ ] **Step 1: Write failing state tests**

Append to `tests/unit/gui/workbench-state.test.js`:

```js
test("preferences_loaded hydrates only safe presentation fields", () => {
  const current = state.applyWorkbenchAction(state.createInitialState(), {
    type: "preferences_loaded",
    preferences: {
      theme: "day",
      railMode: "timeline",
      contextCollapsed: true,
      messages: [{ role: "user", content: "ignored" }]
    }
  });

  assert.equal(current.theme, "day");
  assert.equal(current.railMode, "timeline");
  assert.equal(current.contextCollapsed, true);
  assert.deepEqual(current.messages, []);
});

test("inspector_closed returns to activity without clearing selected checkpoint", () => {
  const cp = { turn_id: "turn_1", seq: 4 };
  const selected = state.applyWorkbenchAction(state.createInitialState(), { type: "checkpoint_selected", checkpoint: cp });
  const closed = state.applyWorkbenchAction(selected, { type: "inspector_closed" });

  assert.equal(selected.inspectorMode, "rewind");
  assert.equal(closed.inspectorMode, "activity");
  assert.deepEqual(closed.selectedCheckpoint, cp);
});
```

- [ ] **Step 2: Run test to verify RED**

Run:

```powershell
npm.cmd test -- tests/unit/gui/workbench-state.test.js
```

Expected: FAIL because `preferences_loaded` and `inspector_closed` are not implemented.

- [ ] **Step 3: Implement state actions**

In `applyWorkbenchAction` add:

```js
if (action.type === "preferences_loaded") {
  var prefs = action.preferences || {};
  return copy(current, {
    theme: normalize(prefs.theme, THEMES, current.theme),
    railMode: normalize(prefs.railMode, RAIL_MODES, current.railMode),
    contextCollapsed: typeof prefs.contextCollapsed === "boolean" ? prefs.contextCollapsed : current.contextCollapsed
  });
}
if (action.type === "inspector_closed") {
  return copy(current, { inspectorMode: "activity", approval: null });
}
```

- [ ] **Step 4: Run test to verify GREEN**

Run:

```powershell
npm.cmd test -- tests/unit/gui/workbench-state.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add gui/renderer/workbench-state.js tests/unit/gui/workbench-state.test.js
git commit -m "feat(v2): hydrate gui presentation state"
```

## Task 4: Renderer Preference Persistence and Keyboard Shortcuts

**Files:**
- Modify: `gui/renderer/app.js`
- Test: `tests/unit/gui/renderer-static.test.js`

- [ ] **Step 1: Write failing static tests**

Append to `tests/unit/gui/renderer-static.test.js`:

```js
test("renderer app loads persists preferences and binds keyboard shortcuts", async () => {
  const app = await readFile("gui/renderer/app.js", "utf8");

  for (const token of [
    "loadPreferences",
    "persistPreferences",
    "bindKeyboardShortcuts",
    "preferences_loaded",
    "inspector_closed",
    "Ctrl+K",
    "event.ctrlKey",
    "focusComposer",
    "getPreferences",
    "setPreferences"
  ]) {
    assert.ok(app.includes(token), `${token} missing`);
  }
});
```

- [ ] **Step 2: Run test to verify RED**

Run:

```powershell
npm.cmd test -- tests/unit/gui/renderer-static.test.js
```

Expected: FAIL because renderer preference and shortcut functions are missing.

- [ ] **Step 3: Implement renderer functions**

In `init()`, after `bindDom()`:

```js
bindKeyboardShortcuts();
loadPreferences();
```

Add:

```js
function loadPreferences() {
  if (typeof api.getPreferences !== "function") return;
  api.getPreferences().then(function (preferences) {
    if (preferences && preferences.error) throw new Error(preferences.error);
    dispatch({ type: "preferences_loaded", preferences: preferences || {} });
  }).catch(function (error) {
    reportError("preferences", error);
  });
}

function persistPreferences() {
  if (typeof api.setPreferences !== "function") return;
  api.setPreferences({
    theme: state.theme,
    railMode: state.railMode,
    contextCollapsed: state.contextCollapsed
  }).catch(function (error) {
    reportError("preferences", error);
  });
}

function bindKeyboardShortcuts() {
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      closeTopDrawer();
      return;
    }
    if (isTextEditing(event.target)) return;
    if (event.ctrlKey && event.key.toLowerCase() === "k") {
      event.preventDefault();
      focusComposer();
      return;
    }
    if (event.ctrlKey && /^[1-5]$/.test(event.key)) {
      event.preventDefault();
      var modes = ["chat", "context", "branches", "timeline", "settings"];
      dispatch({ type: "rail_mode_changed", mode: modes[Number(event.key) - 1] });
      persistPreferences();
    }
  });
}
```

Add helper functions:

```js
function closeTopDrawer() {
  if (state.inspectorMode !== "activity") {
    dispatch({ type: "inspector_closed" });
    focusComposer();
    return true;
  }
  if (state.contextCollapsed === false && window.matchMedia && window.matchMedia("(max-width: 900px)").matches) {
    dispatch({ type: "context_collapsed_changed", collapsed: true });
    persistPreferences();
    focusComposer();
    return true;
  }
  return false;
}

function focusComposer() {
  var input = document.getElementById("msg-input");
  if (input) input.focus();
}

function isTextEditing(target) {
  if (!target) return false;
  var tag = String(target.tagName || "").toLowerCase();
  return tag === "input" || tag === "textarea" || target.isContentEditable;
}
```

Call `persistPreferences()` after theme toggle, context collapse, and rail click state changes.

- [ ] **Step 4: Run test to verify GREEN**

Run:

```powershell
npm.cmd test -- tests/unit/gui/renderer-static.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add gui/renderer/app.js tests/unit/gui/renderer-static.test.js
git commit -m "feat(v2): persist gui renderer preferences"
```

## Task 5: Inspector Close Control and Focus Target

**Files:**
- Modify: `gui/renderer/index.html`
- Modify: `gui/renderer/style.css`
- Modify: `gui/renderer/app.js`
- Test: `tests/unit/gui/renderer-static.test.js`

- [ ] **Step 1: Write failing static tests**

Append to `tests/unit/gui/renderer-static.test.js`:

```js
test("renderer exposes explicit inspector close control", async () => {
  const html = await readFile("gui/renderer/index.html", "utf8");
  const css = await readFile("gui/renderer/style.css", "utf8");
  const app = await readFile("gui/renderer/app.js", "utf8");

  assert.ok(html.includes('id="inspector-close"'));
  assert.ok(html.includes('aria-label="Close inspector"'));
  assert.ok(css.includes(".inspector-close"));
  assert.ok(app.includes("inspector-close"));
  assert.ok(app.includes("focusInspector"));
});
```

- [ ] **Step 2: Run test to verify RED**

Run:

```powershell
npm.cmd test -- tests/unit/gui/renderer-static.test.js
```

Expected: FAIL because close control is missing.

- [ ] **Step 3: Add close control**

In `gui/renderer/index.html`, inside contextual inspector `.pane-header`, add:

```html
<button id="inspector-close" class="icon-button inspector-close" type="button" aria-label="Close inspector">X</button>
```

In `gui/renderer/style.css`, add:

```css
.inspector-close {
  justify-self: end;
}
@media (min-width: 1201px) {
  .inspector-close {
    display: none;
  }
}
```

In `gui/renderer/app.js`, bind:

```js
document.getElementById("inspector-close").onclick = function () {
  dispatch({ type: "inspector_closed" });
  focusComposer();
};
```

Add:

```js
function focusInspector() {
  var close = document.getElementById("inspector-close");
  if (close && state.inspectorMode !== "activity") close.focus();
}
```

Call `focusInspector()` after approval is loaded and after rewind preview is loaded.

- [ ] **Step 4: Run test to verify GREEN**

Run:

```powershell
npm.cmd test -- tests/unit/gui/renderer-static.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add gui/renderer/index.html gui/renderer/style.css gui/renderer/app.js tests/unit/gui/renderer-static.test.js
git commit -m "feat(v2): add gui inspector close flow"
```

## Task 6: Electron Smoke Test

**Files:**
- Create: `tests/e2e/gui-smoke.test.js`

- [ ] **Step 1: Write smoke test**

Create `tests/e2e/gui-smoke.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

test("gui electron shell starts against a temp project", { timeout: 20000 }, async (t) => {
  const electronBin = path.resolve("gui", "node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron");
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "dsc-gui-smoke-"));
  const child = spawn(electronBin, [".", `--project=${projectRoot}`], {
    cwd: path.resolve("gui"),
    env: {
      ...process.env,
      DEEPSEEK_CODE_GUI_SMOKE: "1",
      ELECTRON_ENABLE_LOGGING: "1"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => child.kill());

  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });

  const timer = setTimeout(() => child.kill(), 12000);
  await once(child, "exit");
  clearTimeout(timer);

  assert.match(output, /GUI_SMOKE_READY/);
  assert.doesNotMatch(output, /TypeError|ReferenceError|SyntaxError/);
});
```

- [ ] **Step 2: Add smoke hook in main process**

In `gui/main.js`, after `win.loadFile(...)`, add:

```js
if (process.env.DEEPSEEK_CODE_GUI_SMOKE === "1") {
  win.webContents.once("did-finish-load", async () => {
    const ready = await win.webContents.executeJavaScript(`
      Boolean(document.querySelector("#command-bar") &&
        document.querySelector("#activity-rail") &&
        document.querySelector("#agent-session") &&
        document.querySelector("#statusline") &&
        document.querySelector("#theme-toggle"))
    `);
    console.log(ready ? "GUI_SMOKE_READY" : "GUI_SMOKE_FAILED");
    app.quit();
  });
}
```

- [ ] **Step 3: Run smoke test**

Run:

```powershell
npm.cmd test -- tests/e2e/gui-smoke.test.js
```

Expected: PASS if Electron is installed in `gui/node_modules`. If Electron is missing, install GUI dependencies or convert the test to skip only when `electronBin` does not exist.

- [ ] **Step 4: Commit**

```powershell
git add gui/main.js tests/e2e/gui-smoke.test.js
git commit -m "test(v2): add gui electron smoke"
```

## Task 7: Visual QA and Regression

**Files:**
- No production file changes unless QA finds issues.

- [ ] **Step 1: Run focused GUI tests**

Run:

```powershell
npm.cmd test -- tests/unit/gui/kernel-host.test.js tests/unit/gui/renderer-static.test.js tests/unit/gui/workbench-state.test.js tests/unit/gui/renderer-event-adapter.test.js tests/e2e/gui-smoke.test.js
```

Expected: PASS.

- [ ] **Step 2: Run full regression**

Run:

```powershell
npm.cmd test
npm.cmd run check
git diff --check
```

Expected: PASS. `git diff --check` may print CRLF warnings but must exit 0.

- [ ] **Step 3: Run pollution checks**

Run:

```powershell
Test-Path -LiteralPath ".tmp-gui-qa"
```

Expected: `False`.

Do not delete `.deepseek-code/v2` automatically if the user started the real GUI; report it as user/runtime local state.

- [ ] **Step 4: Optional screenshots**

If Chrome is available, regenerate mock screenshots for:

- 1440x900 night,
- 1440x900 day,
- 720x760 compact.

Inspect:

- close button visible in drawer mode,
- composer visible,
- traffic label visible,
- no overlapping drawers in compact layout.

Delete `.tmp-gui-qa` after inspection.

- [ ] **Step 5: Commit package/check updates if needed**

If new files need syntax coverage in `package.json`, add them to `check` and commit:

```powershell
git add package.json tests/e2e/gui-smoke.test.js
git commit -m "chore(v2): include gui hardening checks"
```

## Final Review Checklist

- [ ] Preferences persist theme, rail mode, and context collapsed state.
- [ ] Preference file stores no user/model content or secrets.
- [ ] `Escape` closes inspector/context drawers.
- [ ] `Ctrl+K` focuses composer.
- [ ] `Ctrl+1..5` switches rail modes outside text input.
- [ ] Approval, rewind, and error flows open the inspector intentionally.
- [ ] Electron smoke test passes or skips only when Electron is absent.
- [ ] Full tests/check/diff pass.
- [ ] No test-created `.deepseek-code/v2` pollution in repo root.
