// gui/main.js - Electron main process
const { app, BrowserWindow, ipcMain, Menu, dialog, shell } = require("electron");
const path = require("path");
const fs = require("node:fs");
const { createKernelHost, resolveProjectRoot } = require("./kernel-host.js");

// Remove Electron's default native menu bar (File/Edit/View/Window/Help) — the app
// has its own custom title bar; the native one would be a redundant second row.
Menu.setApplicationMenu(null);

let host = null;
let ipcRegistered = false;

// IPC 白名单(唯一权威清单):registerIpcHandlers 里任何未登记 channel 的 handle
// 注册会在启动即抛错,防止新增通道漏登记;渲染层仅能调用 preload 暴露的子集。
const IPC_CHANNELS = [
  "window:minimize", "window:maximize", "window:close",
  "fs:tree", "fs:read", "fs:write",
  "settings:get", "config:set", "api:list", "api:save", "api:delete", "api:activate",
  "models:list", "conn:test", "session:branch-activate", "changes:list", "changes:describe",
  "agent:send", "agent:approve", "agent:interrupt",
  "session:timeline", "session:branches", "session:branch-active", "session:checkpoints",
  "session:rewind-preview", "session:rewind-apply",
  "context:snapshot", "model:usage",
  "gui:preferences-get", "gui:preferences-set",
  "config:get", "orchestrator:state",
  "projects:list", "projects:add", "projects:remove", "projects:switch", "sessions:list",
  "projects:reveal", "projects:pick",
  "sensitive:respond",
  "recovery:list", "recovery:report", "recovery:resume", "recovery:cancel", "recovery:clear"
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
  const seededChangePath = path.join(
    resolveProjectRoot(process.argv, path.resolve(__dirname, "..")),
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
  const win = new BrowserWindow({
    width: smoke ? 1440 : 900,
    height: smoke ? 900 : 700,
    minWidth: 400,
    minHeight: 400,
    autoHideMenuBar: true,
    titleBarStyle: "hidden",
    backgroundColor: "#1e1e1e",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    },
    title: "Inkstone"
  });

  host = createKernelHost({
    projectRoot: resolveProjectRoot(process.argv, path.resolve(__dirname, "..")),
    pushEvent: (event) => {
      if (win && !win.isDestroyed()) win.webContents.send("kernel:event", event);
    }
  });

  try {
    await host.init();
  } catch (error) {
    console.error("Kernel init failed:", error.message);
  }

  registerIpcHandlers();
  // Load order: dev server (DEEPSEEK_CODE_GUI_DEV_URL) → built React renderer (renderer-dist).
  // Neither available → show error dialog and exit (no legacy fallback).
  const devUrl = process.env.DEEPSEEK_CODE_GUI_DEV_URL;
  const builtIndex = path.join(__dirname, "renderer-dist", "index.html");
  if (devUrl) {
    win.loadURL(devUrl);
  } else if (fs.existsSync(builtIndex)) {
    win.loadFile(builtIndex);
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
        const ready = await win.webContents.executeJavaScript(`
          new Promise((resolve) => {
            const ok = () => Boolean(
              document.querySelector(".ide") &&
              document.querySelector('header[role="banner"]') &&
              document.querySelector(".shell") &&
              document.querySelector(".rail") &&
              document.querySelector(".pane") &&
              document.querySelector(".rail-fn") &&
              document.querySelector(".cz-input") &&
              document.querySelector('.titlebar .actions .lang')
            );
            let n = 0;
            const iv = setInterval(() => {
              if (ok() || n++ > 40) { clearInterval(iv); resolve(ok()); }
            }, 100);
          })
        `);
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

          await shoot("shell-desktop");                                   // 首页
          await click(".rail-new"); await shoot("shell-chat");            // 会话
          await click(".rail-fn .fn-item:nth-child(3)"); await shoot("shell-changes");
          await click(".rail-fn .fn-item:nth-child(2)"); await shoot("shell-projects");
          await click(".rail-foot .iconbtn:last-child"); await shoot("shell-settings");
          await click(".s-nav .sn-item:nth-child(3)"); await shoot("shell-appearance");
          await click(".s-nav .sn-item:nth-child(4)"); await shoot("shell-status-display");
          await click(".settings-back");                                  // 回首页再截窄屏
          win.setSize(800, 720);
          await new Promise((r) => setTimeout(r, 500));
          await shoot("shell-narrow");
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

  // Custom title-bar window controls (native frame is hidden via titleBarStyle).
  handle("window:minimize", (e) => { BrowserWindow.fromWebContents(e.sender)?.minimize(); });
  handle("window:maximize", (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w) { w.isMaximized() ? w.unmaximize() : w.maximize(); }
  });
  handle("window:close", (e) => { BrowserWindow.fromWebContents(e.sender)?.close(); });

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
  handle("gui:preferences-set", async (_event, patch) => {
    try { return await host.setPreferences(patch || {}); }
    catch (error) { return { error: error.message }; }
  });
  handle("config:get", () => host?.getConfig() || {});
  handle("orchestrator:state", () => host?.getState() || { current: "idle", channel: null });
  handle("projects:list", async () => { try { return await host.listProjects(); } catch (error) { return { error: error.message }; } });
  handle("projects:add", async (_event, root) => { try { return await host.addProject(root); } catch (error) { return { error: error.message }; } });
  handle("projects:remove", async (_event, root) => { try { return await host.removeProject(root); } catch (error) { return { error: error.message }; } });
  handle("projects:switch", async (_event, root) => { try { return await host.switchProject(root); } catch (error) { return { error: error.message }; } });
  handle("sessions:list", async () => { try { return await host.listSessions(); } catch (error) { return { error: error.message }; } });
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
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
  host?.dispose?.();
  app.quit();
});
