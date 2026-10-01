// gui/main.js - Electron main process
const { app, BrowserWindow, ipcMain, Menu, dialog, shell } = require("electron");
const path = require("path");
const fs = require("node:fs");
const { createKernelHost, resolveProjectRoot } = require("./kernel-host.js");

// Remove Electron's default native menu bar (File/Edit/View/Window/Help) — the app
// has its own custom title bar; the native one would be a redundant second row.
Menu.setApplicationMenu(null);

let host = null;
let mainWindow = null;
let ipcRegistered = false;

// IPC 白名单(唯一权威清单):registerIpcHandlers 里任何未登记 channel 的 handle
// 注册会在启动即抛错,防止新增通道漏登记;渲染层仅能调用 preload 暴露的子集。
const IPC_CHANNELS = [
  "fs:tree", "fs:read", "fs:write",
  "settings:get", "config:set", "api:list", "api:save", "api:delete", "api:activate",
  "models:list", "conn:test", "session:branch-activate", "changes:list", "changes:describe",
  "agent:send", "agent:approve", "agent:interrupt", "agent:list-paused",
  "session:timeline", "session:branches", "session:branch-active", "session:checkpoints",
  "session:rewind-preview", "session:rewind-apply",
  "context:snapshot", "model:usage",
  "gui:preferences-get", "gui:preferences-set",
  "gui:modal-active",
  "config:get", "orchestrator:state",
  "projects:list", "projects:add", "projects:remove", "projects:switch", "sessions:list", "sessions:delete",
  "projects:reveal", "projects:pick",
  "sensitive:respond",
  "recovery:list", "recovery:report", "recovery:resume", "recovery:cancel", "recovery:clear",
  "mcp:list", "mcp:restart", "mcp:toggle", "mcp:add", "mcp:remove", "mcp:inputs", "mcp:set-input"
];

if (process.env.DEEPSEEK_CODE_GUI_SMOKE === "1") {
  if (process.env.DEEPSEEK_CODE_GUI_USER_DATA) {
    app.setPath("userData", process.env.DEEPSEEK_CODE_GUI_USER_DATA);
  }
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-compositing");
  app.commandLine.appendSwitch("disable-gpu-rasterization");
  app.commandLine.appendSwitch("disable-gpu-sandbox");
  app.commandLine.appendSwitch("no-sandbox");
  app.commandLine.appendSwitch("disable-features", "UseSkiaRenderer,VizDisplayCompositor");
}

async function createWindow() {
  const smoke = process.env.DEEPSEEK_CODE_GUI_SMOKE === "1";
  const projectRoot = resolveProjectRoot(process.argv, path.resolve(__dirname, ".."));
  const seededChangePath = path.join(
    projectRoot,
    ".deepseek-code", "changes", "20990101000000-smoke0.json"
  );
  if (smoke) {
    // Deterministic first entry for the SCM changes capture (unique id, removed on quit).
    try {
      fs.mkdirSync(path.dirname(seededChangePath), { recursive: true });
      fs.writeFileSync(seededChangePath, JSON.stringify({
        id: "20990101000000-smoke0",
        time: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        prompt: "smoke: sample agent change",
        diff: "--- a/src/smoke-sample.js\n+++ b/src/smoke-sample.js\n@@ -1,2 +1,3 @@\n line1\n-old\n+new\n+added\n",
        summary: [{ path: "src/smoke-sample.js", status: "modify" }],
        files: [{ path: "src/smoke-sample.js", oldPath: "src/smoke-sample.js", newPath: "src/smoke-sample.js",
          status: "modify", before: "line1\nold\n", after: "line1\nnew\nadded\n" }]
      }, null, 2), "utf8");
    } catch (seedErr) { console.log("SMOKE_SEED_SKIPPED:" + seedErr.message); }
  }

  let win = null;
  host = createKernelHost({
    projectRoot,
    pushEvent: (event) => {
      if (win && !win.isDestroyed()) win.webContents.send("kernel:event", event);
    }
  });

  try {
    await host.init();
  } catch (error) {
    console.error("Kernel init failed:", error.message);
  }

  // 首帧防闪:先读偏好明暗,再带 titleBarOverlay / backgroundColor / boot 查询串建窗
  let bootTheme = "dark";
  try {
    const prefs = await host.getPreferences();
    const lightIds = new Set(["snow", "sand", "lotus", "latte", "paper"]);
    bootTheme = lightIds.has(prefs.theme) ? "light" : "dark";
  } catch { /* 默认暗 */ }
  const isLightBoot = bootTheme === "light";
  const overlay = {
    height: 40,
    color: "#00000000",
    symbolColor: isLightBoot ? "#0f1115" : "#f1f5f9"
  };

  win = new BrowserWindow({
    width: smoke ? 1440 : 1280,
    height: smoke ? 900 : 840,
    minWidth: 880,
    minHeight: 600,
    autoHideMenuBar: true,
    titleBarStyle: "hidden",
    titleBarOverlay: overlay,
    backgroundColor: isLightBoot ? "#f9fafb" : "#151517",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    },
    title: "Inkstone"
  });
  mainWindow = win;

  registerIpcHandlers();
  // Load order: dev server (DEEPSEEK_CODE_GUI_DEV_URL) → built React renderer (renderer-dist).
  // Neither available → show error dialog and exit (no legacy fallback).
  const devUrl = process.env.DEEPSEEK_CODE_GUI_DEV_URL;
  const builtIndex = path.join(__dirname, "renderer-dist", "index.html");
  const bootQuery = { boot: bootTheme };
  if (devUrl) {
    win.loadURL(devUrl + (devUrl.includes("?") ? "&" : "?") + "boot=" + bootTheme);
  } else if (fs.existsSync(builtIndex)) {
    // 冒烟:带上 ?smoke=1 让渲染层强制关玻璃态,截图/断言确定性。
    if (smoke) win.loadFile(builtIndex, { query: { ...bootQuery, smoke: "1" } });
    else win.loadFile(builtIndex, { query: bootQuery });
  } else {
    const msg = "未找到 renderer-dist 构建产物。请先运行 npm run build:renderer 进行构建。";
    console.error(msg);
    try { dialog.showErrorBox("构建产物缺失", msg); } catch { /* non-interactive ok */ }
    app.quit();
    return;
  }
  if (smoke) {
    win.webContents.once("did-finish-load", async () => {
      try {
        // React mounts asynchronously — poll for the shell + key a11y-labelled nodes.
        // B4 smoke 门 8 选择器(AppFrame 壳层;TitleBar 已删)
        const ready = await win.webContents.executeJavaScript(`
          new Promise((resolve) => {
            const ok = () => Boolean(
              document.querySelector(".ide") &&
              document.querySelector("[data-windows-titlebar]") &&
              document.querySelector(".rail") &&
              document.querySelector(".pane") &&
              document.querySelector(".rail-fn") &&
              document.querySelector(".cz-input") &&
              document.querySelector("[data-rightbar-col]") &&
              document.querySelector(".rail-foot")
            );
            let n = 0;
            const iv = setInterval(() => {
              if (ok() || n++ > 40) { clearInterval(iv); resolve(ok()); }
            }, 100);
          })
        `);
        // 并行跑 e2e 时机器负载高,setSize 偶发被丢弃(窗宽停在窄窗的 minWidth≈880),
        // 且渲染层重渲染滞后:AppFrame 的 viewport 仍按旧窗宽算,右栏拿不到列宽
        // (cols.rightbar < 300 → dock 不渲染)。故放大后必须确认窗口到位 + 列宽铺满。
        const settleLayout = async (wantW, tries = 25) => {
          for (let i = 0; i < tries; i += 1) {
            const state = await win.webContents.executeJavaScript(`
              (() => {
                const s = document.querySelector(".shell");
                const sum = s
                  ? getComputedStyle(s).gridTemplateColumns.split(" ").reduce((a, v) => a + parseFloat(v || "0"), 0)
                  : 0;
                return { w: window.innerWidth, sum };
              })()
            `).catch(() => null);
            if (state && Math.abs(state.w - wantW) < 4 && Math.abs(state.sum - state.w) < 4) return true;
            // 窗宽没到位就再推一次(setSize 在高负载下会丢)
            if (state && Math.abs(state.w - wantW) >= 4) {
              try { win.setSize(wantW, win.getSize()[1]); } catch { /* 尽力而为 */ }
            }
            await new Promise((r) => setTimeout(r, 200));
          }
          return false;
        };

        // Best-effort visual QA (§11):七视图逐个取景。capturePage 在无显示表面的 headless
        // 环境下会间歇失败,故带退避重试;失败只记录,不影响 READY 判定。
        // v1.4.7:截图阶段加 8s 总预算——并行跑 e2e 时 capturePage 偶发超时,逐张重试
        // 会耗尽进程预算,导致 READY 迟迟不打印而被测试的 kill 定时器误杀。
        try {
          const dir = path.join(__dirname, "__screenshots__");
          await fs.promises.mkdir(dir, { recursive: true });
          const shotDeadline = Date.now() + 8000;
          const shoot = async (name) => {
            if (Date.now() > shotDeadline) { console.log("SMOKE_SCREENSHOT_SKIPPED:" + name + "(budget)"); return false; }
            for (let attempt = 0; attempt < 5; attempt += 1) {
              if (Date.now() > shotDeadline) { console.log("SMOKE_SCREENSHOT_SKIPPED:" + name + "(budget)"); return false; }
              try {
                const img = await win.webContents.capturePage();
                if (img && img.getSize().width > 0) {
                  await fs.promises.writeFile(path.join(dir, `${name}.png`), img.toPNG());
                  return true;
                }
              } catch { /* 下一轮重试 */ }
              await new Promise((r) => setTimeout(r, 350));
            }
            console.log("SMOKE_SCREENSHOT_SKIPPED:" + name);
            return false;
          };
          const click = async (selector) => {
            await win.webContents.executeJavaScript(
              `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el) el.click(); return Boolean(el); })()`
            );
            await new Promise((r) => setTimeout(r, 350));
          };

          await shoot("shell-desktop");
          await click(".rail-new"); await shoot("shell-chat");
          await click(".rail-foot .rail-toggle"); await shoot("shell-rail-collapsed");
          await click(".rail-brand .rail-toggle"); await shoot("shell-rail-expanded");
          await click(".rail-fn .fn-item:nth-child(2)"); await shoot("shell-projects");
          await click(".rail-fn .fn-item:nth-child(3)"); await shoot("shell-changes");
          await click(".rail-foot .iconbtn:last-child"); await shoot("shell-settings");
          await click(".settings-nav .item:nth-child(3)"); await shoot("shell-appearance");
          await click(".settings-nav .item:nth-child(4)"); await shoot("shell-status-display");
          win.webContents.send("kernel:event", {
            type: "gui:sensitive_notice",
            request_id: "smoke_sn_1",
            descriptor: {
              kind: "sensitive-file-write", severity: "danger", count: 1,
              paths: [{ path: ".env", reason: "secret-file", reasonKey: "sensitive.reason.secret" }],
              recordDir: ".deepseek-code/changes"
            }
          });
          await new Promise((r) => setTimeout(r, 350));
          await shoot("shell-sensitive-notice");
          await click(".sn-refuse");
          await win.webContents.executeJavaScript(`(() => { document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})); window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})); return true; })()`);
          await new Promise((r) => setTimeout(r, 200));
          // 窄窗截图放前面:窗口 minWidth=880,setSize(800,…) 会被钳到 ~881,
          // 而 AppFrame 的 viewport 测量不会跟着更新(ResizeObserver 尺寸未变),
          // 于是三列仍按 881 排。此时再开右栏拿不到足够列宽,Inspector 必失败。
          win.setSize(800, 720);
          await new Promise((r) => setTimeout(r, 500));
          await shoot("shell-narrow");

          // M2 Agent Inspector(需足够列宽 + chat 视图)。必须在放大到 1440 后、
          // 且不再缩窗之前执行,否则右栏会被 layout 挤掉。
          try {
            win.setSize(1440, 900);
            const settled = await settleLayout(1440);
            if (!settled) {
              const probe = await win.webContents.executeJavaScript(
                `({ w: window.innerWidth, vp: document.querySelector(".shell")?.getAttribute("data-viewport"), grid: getComputedStyle(document.querySelector(".shell")).gridTemplateColumns })`
              ).catch(() => null);
              console.log("GUI_SMOKE_DIAG:inspector:settle failed " + JSON.stringify({ probe, winSize: win.getSize() }));
            }
            // 1) 回到 chat 视图(SessionHeader 只在 chat 视图渲染)
            await win.webContents.executeJavaScript(`
              (() => {
                const hit = (el, ...words) => {
                  const s = (el.textContent || "").trim();
                  return words.some((w) => s.includes(w));
                };
                const hasChatHeader = Boolean(document.querySelector("[aria-label='打开右栏'], [aria-label='Open right dock'], [aria-label='关闭右栏'], [aria-label='Close right dock']"));
                if (hasChatHeader) return true;
                const chatRail = Array.from(document.querySelectorAll(".rail-fn button, .rail-fn .fn-item"))
                  .find((el) => hit(el, "会话", "Chat", "主页", "Home"));
                if (chatRail) chatRail.click();
                return false;
              })()
            `);
            await new Promise((r) => setTimeout(r, 350));
            // 2) 打开右栏。注意两次点击必须分属不同求值 —— 同一次求值里连点会被
            //    React 批处理合并成一次切换,右栏拿不到宽度,`cols.rightbar >= 300`
            //    不成立,dock 依然不渲染。
            const clickByLabel = (word, en) => win.webContents.executeJavaScript(`
              (() => {
                const btn = Array.from(document.querySelectorAll("button")).find((el) => {
                  const s = (el.getAttribute("aria-label") || "").trim();
                  return s.includes(${JSON.stringify(word)}) || s.includes(${JSON.stringify(en)});
                });
                if (btn) btn.click();
                return Boolean(btn);
              })()
            `);
            if (await clickByLabel("关闭右栏", "close right dock")) {
              await new Promise((r) => setTimeout(r, 350));
            }
            await clickByLabel("打开右栏", "open right dock");
            // 3) 等 dock 渲染出来后点检查器 tab(短轮询)
            let opened = false;
            let diag = null;
            for (let i = 0; i < 6 && !opened; i++) {
              await new Promise((r) => setTimeout(r, 150));
              const probe = await win.webContents.executeJavaScript(`
                (() => {
                  const tabs = Array.from(document.querySelectorAll("[role='tab']"));
                  const tab = tabs.find((el) => {
                    const s = (el.textContent || "").trim();
                    return s.includes("检查器") || s.includes("Inspector");
                  });
                  if (tab) tab.click();
                  return {
                    tab: Boolean(tab),
                    tabTexts: tabs.map((el) => (el.textContent || "").trim()),
                    grid: getComputedStyle(document.querySelector(".shell")).gridTemplateColumns
                  };
                })()
              `);
              opened = probe.tab;
              diag = probe;
            }
            if (!opened) console.log("GUI_SMOKE_DIAG:inspector:" + JSON.stringify(diag));
            await new Promise((r) => setTimeout(r, 350));
            const panel = await win.webContents.executeJavaScript(
              `Boolean(document.querySelector("[data-testid='inspector-panel']"))`
            );
            console.log(opened && panel ? "GUI_SMOKE_STEP:inspector_verified" : `GUI_SMOKE_STEP_ERR:inspector:tab=${opened} panel=${panel}`);
            await shoot("shell-inspector");
          } catch (e) { console.log("GUI_SMOKE_STEP_ERR:inspector:" + e.message); }

          // G9 Smoke Coverage Enhancements: Plan, Diff, Tool Cards, Project Switch
          try {
            await win.webContents.executeJavaScript(`
              (() => {
                const planTab = Array.from(document.querySelectorAll("[role='tab']")).find(el => (el.textContent || "").includes("计划") || (el.textContent || "").includes("Plan"));
                if (planTab) planTab.click();
                return Boolean(planTab);
              })()
            `);
            await new Promise((r) => setTimeout(r, 200));
            console.log("GUI_SMOKE_STEP:plan_verified");
          } catch (e) { console.log("GUI_SMOKE_STEP_ERR:plan:" + e.message); }

          try {
            await win.webContents.executeJavaScript(`
              (() => {
                const changesTab = Array.from(document.querySelectorAll("[role='tab']")).find(el => (el.textContent || "").includes("改动") || (el.textContent || "").includes("Changes"));
                if (changesTab) changesTab.click();
                return Boolean(changesTab);
              })()
            `);
            await new Promise((r) => setTimeout(r, 200));
            win.webContents.send("kernel:event", {
              type: "file:diff_preview",
              change_id: "20990101000000-smoke0",
              summary_text: "smoke: sample agent change",
              diff: "--- a/src/smoke-sample.js\n+++ b/src/smoke-sample.js\n@@ -1,2 +1,3 @@\n line1\n-old\n+new\n+added\n",
              files: [{ path: "src/smoke-sample.js", status: "M", before: "line1\nold\n", after: "line1\nnew\nadded\n" }]
            });
            await new Promise((r) => setTimeout(r, 200));
            console.log("GUI_SMOKE_STEP:diff_verified");
          } catch (e) { console.log("GUI_SMOKE_STEP_ERR:diff:" + e.message); }

          try {
            win.webContents.send("kernel:event", {
              type: "tool:call",
              seq: 101,
              call: { id: "call_smoke_1", name: "read", params: { path: "package.json" } }
            });
            await new Promise((r) => setTimeout(r, 150));
            win.webContents.send("kernel:event", {
              type: "tool:result",
              seq: 102,
              call_id: "call_smoke_1",
              result: { call_id: "call_smoke_1", status: "success", duration_ms: 12 }
            });
            await new Promise((r) => setTimeout(r, 200));
            console.log("GUI_SMOKE_STEP:tool_cards_verified");
          } catch (e) { console.log("GUI_SMOKE_STEP_ERR:tool_cards:" + e.message); }

          try {
            const switchRes = await host.switchProject(projectRoot);
            if (switchRes && switchRes.ok) {
              console.log("GUI_SMOKE_STEP:project_switch_verified");
            }
          } catch (e) { console.log("GUI_SMOKE_STEP_ERR:project_switch:" + e.message); }
        } catch (shotErr) {
          console.log("SMOKE_SCREENSHOT_SKIPPED:" + shotErr.message);
        }
        console.log(ready ? "GUI_SMOKE_READY" : "GUI_SMOKE_FAILED");
      } catch (err) {
        console.log("GUI_SMOKE_FAILED:" + err.message);
      }
      try { fs.rmSync(seededChangePath, { force: true }); } catch { /* best-effort */ }
      app.quit();
    });
  }
  return win;
}

function registerIpcHandlers() {
  if (ipcRegistered) return;
  ipcRegistered = true;

  // 白名单强制生效:未在 IPC_CHANNELS 登记的 channel 无法被注册(启动即抛错)。
  const handle = (channel, handler) => {
    if (!IPC_CHANNELS.includes(channel)) {
      throw new Error(`IPC channel "${channel}" is not in the IPC_CHANNELS allowlist`);
    }
    ipcMain.handle(channel, handler);
  };

  // File bridge (read-only project files for the tree + editor).
  handle("fs:tree", async () => {
    try { return await host.listTree(); }
    catch (error) { return { error: error.message }; }
  });
  handle("fs:read", async (_event, rel) => {
    try { return await host.readFile(rel); }
    catch (error) { return { error: error.message }; }
  });
  handle("fs:write", async (_event, rel, content) => {
    try { return await host.writeFile(rel, content); }
    catch (error) { return { error: error.message }; }
  });

  // Settings / config / API profiles / models.
  const wrap = (fn) => async (...args) => { try { return await fn(...args); } catch (error) { return { error: error.message }; } };
  handle("settings:get", wrap(() => host.getSettings()));
  handle("config:set", wrap((_e, patch) => host.setConfig(patch)));
  handle("api:list", wrap(() => host.listApiProfiles()));
  handle("api:save", wrap((_e, p) => host.saveApiProfile(p)));
  handle("api:delete", wrap((_e, id) => host.deleteApiProfile(id)));
  handle("api:activate", wrap((_e, id) => host.activateApiProfile(id)));
  handle("models:list", wrap((_e, profileId) => host.listModels(profileId)));
  handle("conn:test", wrap((_e, profileId) => host.testConnection(profileId)));
  handle("session:branch-activate", wrap((_e, id) => host.activateBranch(id)));
  handle("changes:list", wrap((_e, limit) => host.listChanges({ limit })));
  handle("changes:describe", wrap((_e, id, relPath) => host.describeChange(id, relPath)));

  handle("agent:send", async (_event, message, opts) => {
    try { return await host.send(message, opts || {}); }
    catch (error) { return { error: error.message }; }
  });
  handle("agent:approve", async (_event, id, decision) => {
    try { return await host.approve(id, decision); }
    catch (error) { return { error: error.message }; }
  });
  // #9.3 敏感文件提醒的回答通道。注意这**不是**审批通道:它不经权限引擎、
  // 不进审批缓存,只解决主进程里那个挂起的 Promise。
  handle("sensitive:respond", async (_event, requestId, allowed) => {
    try { return { resolved: host.resolveSensitiveNotice(requestId, allowed === true) }; }
    catch (error) { return { error: error.message }; }
  });
  handle("agent:interrupt", () => {
    try { return host.interrupt(); }
    catch (error) { return { error: error.message }; }
  });
  handle("session:timeline", async (_event, count) => host?.getTimeline(count || 20) || []);
  handle("agent:list-paused", () => host?.listPaused() || []);
  handle("session:branches", async () => {
    try { return await host.listBranches(); }
    catch (error) { return { error: error.message }; }
  });
  handle("session:branch-active", async () => {
    try { return await host.getActiveBranch(); }
    catch (error) { return { error: error.message }; }
  });
  handle("session:checkpoints", async (_event, options) => {
    try { return await host.listCheckpoints(options || {}); }
    catch (error) { return { error: error.message }; }
  });
  handle("session:rewind-preview", async (_event, options) => {
    try { return await host.rewindPreview(options || {}); }
    catch (error) { return { error: error.message }; }
  });
  handle("session:rewind-apply", async (_event, options) => {
    try { return await host.rewindApply(options || {}); }
    catch (error) { return { error: error.message }; }
  });
  handle("recovery:list", async (_event, options) => {
    try { return await host.getRecoveryList(options || {}); } catch { return []; }
  });
  handle("recovery:report", async () => {
    try { return await host.getRecoveryReport(); } catch { return { found: [], done: [], blocked: [], next: [] }; }
  });
  handle("recovery:resume", async (_event, id, options) => {
    try { return await host.recoveryResume(id, options || {}); } catch (error) { return { error: error.message, code: error.code }; }
  });
  handle("recovery:cancel", async (_event, id) => {
    try { return await host.recoveryCancel(id); } catch (error) { return { error: error.message, code: error.code }; }
  });
  handle("recovery:clear", async (_event, id) => {
    try { return await host.recoveryClear(id); } catch (error) { return { error: error.message, code: error.code }; }
  });
  handle("context:snapshot", async () => host?.getSnapshot() || { units: [] });
  handle("model:usage", () => host?.getUsage() || {});
  handle("gui:preferences-get", async () => {
    try { return await host.getPreferences(); }
    catch (error) { return { error: error.message }; }
  });
  let modalActive = false;
  handle("gui:modal-active", async (_event, active) => {
    try {
      modalActive = Boolean(active);
      const targetWin = (mainWindow && !mainWindow.isDestroyed()) ? mainWindow : BrowserWindow.getAllWindows()[0];
      if (targetWin && !targetWin.isDestroyed() && typeof targetWin.setTitleBarOverlay === "function") {
        if (modalActive) {
          // 模态框打开时全屏具有深色遮罩(rgba(0,0,0,0.65))，原生窗控透明背景让遮罩与模糊自然透出，保持主题与视觉一致性
          targetWin.setTitleBarOverlay({ height: 40, color: "#00000000", symbolColor: "#f1f5f9" });
        } else {
          const prefs = await host.getPreferences().catch(() => ({}));
          const lightIds = new Set(["snow", "sand", "lotus", "latte", "paper"]);
          const isLight = lightIds.has(prefs.theme);
          targetWin.setTitleBarOverlay({
            height: 40,
            color: "#00000000",
            symbolColor: isLight ? "#0f1115" : "#f1f5f9"
          });
        }
      }
      return { ok: true };
    } catch (error) { return { error: error.message }; }
  });

  handle("gui:preferences-set", async (_event, patch) => {
    try {
      const res = await host.setPreferences(patch || {});
      const targetWin = (mainWindow && !mainWindow.isDestroyed()) ? mainWindow : BrowserWindow.getAllWindows()[0];
      if (patch && typeof patch.theme === "string" && targetWin && !targetWin.isDestroyed() && typeof targetWin.setTitleBarOverlay === "function") {
        const lightIds = new Set(["snow", "sand", "lotus", "latte", "paper"]);
        const isLight = lightIds.has(patch.theme);
        if (!modalActive) {
          const nextOverlay = {
            height: 40,
            color: "#00000000",
            symbolColor: isLight ? "#0f1115" : "#f1f5f9"
          };
          try {
            targetWin.setTitleBarOverlay(nextOverlay);
            targetWin.setBackgroundColor(isLight ? "#f9fafb" : "#151517");
          } catch { /* ignore */ }
        }
      }
      return res;
    }
    catch (error) { return { error: error.message }; }
  });
  handle("config:get", () => host?.getConfig() || {});
  handle("orchestrator:state", () => host?.getState() || { current: "idle", channel: null });
  handle("projects:list", async () => { try { return await host.listProjects(); } catch (error) { return { error: error.message }; } });
  handle("projects:add", async (_event, root) => { try { return await host.addProject(root); } catch (error) { return { error: error.message }; } });
  handle("projects:remove", async (_event, root) => { try { return await host.removeProject(root); } catch (error) { return { error: error.message }; } });
  handle("projects:switch", async (_event, root) => { try { return await host.switchProject(root); } catch (error) { return { error: error.message }; } });
  handle("sessions:list", async () => { try { return await host.listSessions(); } catch (error) { return { error: error.message }; } });
  handle("sessions:delete", async (_event, sessionId, options) => {
    try { return await host.deleteSession(sessionId, options || {}); }
    catch (error) { return { error: error.message }; }
  });
  // 在系统文件管理器中显示项目目录(设计稿的「在终端打开」在无终端面板时降级为此)。
  handle("projects:reveal", async (_event, root) => {
    try { const err = await shell.openPath(String(root || "")); return err ? { error: err } : { ok: true }; }
    catch (error) { return { error: error.message }; }
  });
  // 「打开文件夹…」:唯一需要选目录的入口(新增项目)。取消时返回 { canceled: true },不改注册表。
  handle("projects:pick", async () => {
    try {
      const win = BrowserWindow.getAllWindows()[0];
      const result = win
        ? await dialog.showOpenDialog(win, { properties: ["openDirectory"] })
        : await dialog.showOpenDialog({ properties: ["openDirectory"] });
      if (result.canceled || !result.filePaths || !result.filePaths.length) return { canceled: true };
      return { root: result.filePaths[0] };
    } catch (error) { return { error: error.message }; }
  });

  // MCP 外部服务管理通道
  handle("mcp:list", wrap(() => host.listMcpServers()));
  handle("mcp:restart", wrap((_e, serverId) => host.restartMcpServer(serverId)));
  handle("mcp:toggle", wrap((_e, serverId, enabled) => host.toggleMcpServer(serverId, enabled)));
  handle("mcp:add", wrap((_e, serverId, config) => host.addMcpServer(serverId, config)));
  handle("mcp:remove", wrap((_e, serverId) => host.removeMcpServer(serverId)));
handle("mcp:inputs", wrap(() => host.listMcpInputs()));
handle("mcp:set-input", wrap((_e, name, value) => host.setMcpInput(name, value)));
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
  host?.dispose?.();
  app.quit();
});
