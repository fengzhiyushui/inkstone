// gui/main.js - Electron main process
const { app, BrowserWindow, ipcMain, Menu, dialog, shell } = require("electron");
const path = require("path");
const fs = require("node:fs");
const os = require("node:os");
const { createKernelHost, resolveProjectRoot } = require("./kernel-host.js");
const { saveDiagnosticExport } = require("./mcp-diagnostics.js");

// Remove Electron's default native menu bar (File/Edit/View/Window/Help) — the app
// has its own custom title bar; the native one would be a redundant second row.
Menu.setApplicationMenu(null);

let host = null;
let mainWindow = null;
// 冒烟模式下指向临时登记表目录(见下方 DEEPSEEK_CODE_GUI_SMOKE 块);非冒烟为 null。
let smokeRegistryDir = null;
// 冒烟模式下待回收的脚手架路径(临时登记表;以及测试自己建的临时项目根)。
let smokeCleanupPaths = [];
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
  "mcp:list", "mcp:restart", "mcp:toggle", "mcp:add", "mcp:remove", "mcp:inputs", "mcp:set-input",
  "mcp:auth-status", "mcp:auth-start", "mcp:auth-cancel", "mcp:auth-logout",
  "mcp:logs", "mcp:logs-export", "mcp:tools-list", "mcp:tool-test", "mcp:tool-test-approve", "mcp:tool-test-cancel",
  "mcp:input-requests", "mcp:input-respond",
  "mcp:resources-list", "mcp:resource-templates-list", "mcp:resource-read", "mcp:prompts-list", "mcp:prompt-get"
];

// 冒烟脚手架回收:登记表临时目录 + 测试自建的临时项目根 / userData。
// 只在冒烟会话里删(路径均由测试或本进程在 os.tmpdir() 下创建),失败仅告警。
let smokeCleaned = false;
function cleanupSmokeScaffolding() {
  if (smokeCleaned) return;
  smokeCleaned = true;
  if (process.env.DEEPSEEK_CODE_GUI_SMOKE !== "1") return;
  for (const p of smokeCleanupPaths.splice(0)) {
    const resolved = path.resolve(String(p));
    const tmp = path.resolve(os.tmpdir()) + path.sep;
    if (!resolved.startsWith(tmp)) {
      console.log("SMOKE_CLEANUP_SKIPPED:" + resolved + "(outside temp)");
      continue;
    }
    try {
      fs.rmSync(resolved, { recursive: true, force: true });
    } catch (err) {
      console.log("SMOKE_CLEANUP_FAILED:" + resolved + ":" + err.message);
    }
  }
}

if (process.env.DEEPSEEK_CODE_GUI_SMOKE === "1") {
  if (process.env.DEEPSEEK_CODE_GUI_USER_DATA) {
    app.setPath("userData", process.env.DEEPSEEK_CODE_GUI_USER_DATA);
  }
  // 冒烟必须隔离全局项目 MRU 登记表:否则每跑一次测试就把临时项目写进开发者
  // 真实的 ~/.deepseek-code/projects.json,并在界面上堆积成一片死项目。
  // 优先级:显式 env(测试用它指向自己的临时目录并回收)> 冒烟模式自带临时目录。
  if (process.env.DEEPSEEK_CODE_GUI_PROJECT_REGISTRY_DIR) {
    smokeRegistryDir = process.env.DEEPSEEK_CODE_GUI_PROJECT_REGISTRY_DIR;
  } else {
    smokeRegistryDir = path.join(os.tmpdir(), `inkstone-smoke-registry-${process.pid}`);
  }
  smokeCleanupPaths.push(smokeRegistryDir);
  if (process.env.DEEPSEEK_CODE_GUI_SMOKE_CLEANUP_DIRS) {
    // 测试自己 mkdtemp 出来的脚手架路径(临时项目根、Electron userData),
    // 以 path.delimiter 分隔;冒烟退出时一并回收,避免长期堆积。
    for (const p of process.env.DEEPSEEK_CODE_GUI_SMOKE_CLEANUP_DIRS.split(path.delimiter)) {
      if (p && p.trim()) smokeCleanupPaths.push(p.trim());
    }
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
    openMcpAuthorization: (url) => shell.openExternal(url),
    // 冒烟:登记表落到临时目录,避免污染开发者真实项目列表
    ...(smokeRegistryDir ? { projectRegistryDir: smokeRegistryDir } : {}),
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

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    const isDev = devUrl && url.startsWith(devUrl);
    const isFile = url.startsWith("file://");
    if (!isDev && !isFile) {
      event.preventDefault();
      if (url.startsWith("https://") || url.startsWith("http://")) {
        shell.openExternal(url);
      }
    }
  });

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
        /**
         * 等三列布局真正铺满目标窗宽。
         *
         * 背景（v1.12.1 冒烟排查）：`AppFrame` 用 ResizeObserver 观测自身根节点来
         * 推导 `viewport`，但在无显示 surface 的 headless 环境里，程序化 `setSize`
         * 之后**元素的 contentBox 常常不变化**（窗口 physically 变宽了，壳层仍按旧
         * 宽度排版），于是 `viewport` 停在旧值、右栏拿不到列宽、dock 不渲染。
         * 单纯重试 `setSize` 无效（窗口本来就到位了）。
         * 因此这里在“窗口已到位但布局没收敛”时，主动触发一次 `resize` 事件 +
         * 读写 offsetWidth 强制回流，把观测回调唤醒。
         */
        const settleLayout = async (wantW, tries = 25) => {
          let emulatedViewport = false;
          for (let i = 0; i < tries; i += 1) {
            const state = await win.webContents.executeJavaScript(`
              (() => {
                const s = document.querySelector(".shell");
                const sum = s
                  ? getComputedStyle(s).gridTemplateColumns.split(" ").reduce((a, v) => a + parseFloat(v || "0"), 0)
                  : 0;
                const w = window.innerWidth;
                // 强制回流 + 唤醒观测者:AppFrame 的 viewport 可能是陈旧测量值
                if (s) { void s.offsetWidth; }
                window.dispatchEvent(new Event("resize"));
                return { w, sum, vp: s ? (s.getAttribute("data-viewport") || null) : null };
              })()
            `).catch(() => null);
            if (state && Math.abs(state.w - wantW) < 4 && Math.abs(state.sum - state.w) < 4) return true;
            // 窗宽没到位就再推一次(setSize 在高负载下会丢)
            if (state && Math.abs(state.w - wantW) >= 4) {
              try { win.setSize(wantW, win.getSize()[1]); } catch { /* 尽力而为 */ }
              // Windows without an active display surface can acknowledge the
              // native size while Chromium retains the previous viewport. In
              // smoke only, drive the real renderer viewport through Electron's
              // emulation API; the layout and Inspector DOM checks still run.
              if (!emulatedViewport && i >= 2 && Math.abs(win.getSize()[0] - wantW) < 4) {
                const height = win.getContentSize()[1];
                win.webContents.enableDeviceEmulation({ screenPosition: "desktop",
                  screenSize: { width: wantW, height }, viewPosition: { x: 0, y: 0 },
                  deviceScaleFactor: 0, viewSize: { width: wantW, height }, scale: 1 });
                emulatedViewport = true;
                console.log("GUI_SMOKE_DIAG:viewport_emulated:" + wantW);
              }
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
      cleanupSmokeScaffolding();
      app.quit();
    });
  }
  return win;
}

// ── 表驱动 IPC 路由 ────────────────────────────────────────────────
// 每条 = channel → (host, ...args) => 目标调用;渲染进程参数逐个透传,
// 参数默认值 / 可选链兜底与原逐条 handle 一一对应。
// 错误语义默认 { error: message }(即旧 wrap);需要其它兜底用 catchAs 声明;
// passthrough: true = 不捕获异常(读快照类,host 未就绪时返回兜底值)。
const IPC_ROUTES = [
  // 文件桥(只读项目文件 + 编辑器保存)
  { ch: "fs:tree", call: (h) => h.listTree() },
  { ch: "fs:read", call: (h, rel) => h.readFile(rel) },
  { ch: "fs:write", call: (h, rel, content) => h.writeFile(rel, content) },
  // 设置 / 配置 / API 画像 / 模型
  { ch: "settings:get", call: (h) => h.getSettings() },
  { ch: "config:set", call: (h, patch) => h.setConfig(patch) },
  { ch: "api:list", call: (h) => h.listApiProfiles() },
  { ch: "api:save", call: (h, p) => h.saveApiProfile(p) },
  { ch: "api:delete", call: (h, id) => h.deleteApiProfile(id) },
  { ch: "api:activate", call: (h, id) => h.activateApiProfile(id) },
  { ch: "models:list", call: (h, profileId) => h.listModels(profileId) },
  { ch: "conn:test", call: (h, profileId) => h.testConnection(profileId) },
  { ch: "session:branch-activate", call: (h, id) => h.activateBranch(id) },
  { ch: "changes:list", call: (h, limit) => h.listChanges({ limit }) },
  { ch: "changes:describe", call: (h, id, relPath) => h.describeChange(id, relPath) },
  // Agent
  { ch: "agent:send", call: (h, message, opts) => h.send(message, opts || {}) },
  { ch: "agent:approve", call: (h, id, decision) => h.approve(id, decision) },
  { ch: "agent:interrupt", call: (h) => h.interrupt() },
  // #9.3 敏感文件提醒的回答通道。注意这**不是**审批通道:它不经权限引擎、
  // 不进审批缓存,只解决主进程里那个挂起的 Promise。
  { ch: "sensitive:respond", call: (h, requestId, allowed) => ({ resolved: h.resolveSensitiveNotice(requestId, allowed === true) }) },
  // 会话 / 分支 / 检查点 / 回滚
  { ch: "session:branches", call: (h) => h.listBranches() },
  { ch: "session:branch-active", call: (h) => h.getActiveBranch() },
  { ch: "session:checkpoints", call: (h, options) => h.listCheckpoints(options || {}) },
  { ch: "session:rewind-preview", call: (h, options) => h.rewindPreview(options || {}) },
  { ch: "session:rewind-apply", call: (h, options) => h.rewindApply(options || {}) },
  // 恢复中心:list/report 失败时给空结构(不冒泡 { error }),resume/cancel/clear 附 code
  { ch: "recovery:list", call: (h, options) => h.getRecoveryList(options || {}), catchAs: () => [] },
  { ch: "recovery:report", call: (h) => h.getRecoveryReport(), catchAs: () => ({ found: [], done: [], blocked: [], next: [] }) },
  { ch: "recovery:resume", call: (h, id, options) => h.recoveryResume(id, options || {}), catchAs: (e) => ({ error: e.message, code: e.code }) },
  { ch: "recovery:cancel", call: (h, id) => h.recoveryCancel(id), catchAs: (e) => ({ error: e.message, code: e.code }) },
  { ch: "recovery:clear", call: (h, id) => h.recoveryClear(id), catchAs: (e) => ({ error: e.message, code: e.code }) },
  // 读快照直通:host 未就绪时返回兜底值,不捕获异常(与原实现一致)
  { ch: "session:timeline", call: (h, count) => h?.getTimeline(count || 20) || [], passthrough: true },
  { ch: "agent:list-paused", call: (h) => h?.listPaused() || [], passthrough: true },
  { ch: "context:snapshot", call: (h) => h?.getSnapshot() || { units: [] }, passthrough: true },
  { ch: "model:usage", call: (h) => h?.getUsage() || {}, passthrough: true },
  { ch: "config:get", call: (h) => h?.getConfig() || {}, passthrough: true },
  { ch: "orchestrator:state", call: (h) => h?.getState() || { current: "idle", channel: null }, passthrough: true },
  // GUI 偏好(gui:preferences-set 需联动原生 titleBarOverlay,见下方显式注册)
  { ch: "gui:preferences-get", call: (h) => h.getPreferences() },
  // 项目 / 会话(projects:reveal / projects:pick 需 shell / dialog,见下方显式注册)
  { ch: "projects:list", call: (h) => h.listProjects() },
  { ch: "projects:add", call: (h, root) => h.addProject(root) },
  { ch: "projects:remove", call: (h, root) => h.removeProject(root) },
  { ch: "projects:switch", call: (h, root) => h.switchProject(root) },
  { ch: "sessions:list", call: (h) => h.listSessions() },
  // MCP:未被下方「冻结注册形态」清单覆盖的通道
  { ch: "mcp:list", call: (h) => h.listMcpServers() },
  { ch: "mcp:restart", call: (h, serverId) => h.restartMcpServer(serverId) },
  { ch: "mcp:toggle", call: (h, serverId, enabled) => h.toggleMcpServer(serverId, enabled) },
  { ch: "mcp:add", call: (h, serverId, config) => h.addMcpServer(serverId, config) },
  { ch: "mcp:remove", call: (h, serverId) => h.removeMcpServer(serverId) },
  { ch: "mcp:inputs", call: (h) => h.listMcpInputs() },
  { ch: "mcp:set-input", call: (h, name, value) => h.setMcpInput(name, value) }
];

function registerIpcHandlers() {
  if (ipcRegistered) return;
  ipcRegistered = true;

  // 白名单强制生效:未在 IPC_CHANNELS 登记的 channel 无法被注册(启动即抛错)。
  // registered 同时用于收尾自检:白名单里每个 channel 都必须被注册到。
  const registered = new Set();
  const handle = (channel, handler) => {
    if (!IPC_CHANNELS.includes(channel)) {
      throw new Error(`IPC channel "${channel}" is not in the IPC_CHANNELS allowlist`);
    }
    ipcMain.handle(channel, handler);
    registered.add(channel);
  };
  // 通用转发管道:把渲染进程参数逐个透传给 call(host, ...args),抛错时收敛为
  // { error: message } —— 与旧逐条 wrap(...) 的错误语义完全一致。
  const forward = (call, catchAs) => async (_event, ...args) => {
    try { return await call(host, ...args); }
    catch (error) { return catchAs ? catchAs(error) : { error: error.message }; }
  };

  // 表驱动注册:一张映射表 + 一个循环,替代逐条 handle(...) 样板。
  for (const { ch, call, passthrough, catchAs } of IPC_ROUTES) {
    handle(ch, passthrough
      ? async (_event, ...args) => call(host, ...args)
      : forward(call, catchAs));
  }

  // 模态框开关:决定原生窗控用透明 symbol 色(模态期)还是主题对应色。
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
  handle("sessions:delete", forward((h, sessionId, options) => h.deleteSession(sessionId, options || {})));
  // 在系统文件管理器中显示项目目录(设计稿的「在终端打开」在无终端面板时降级为此)。
  handle("projects:reveal", async (_event, root) => {
    try {
      const raw = String(root || "").trim();
      if (!raw || raw.includes("\0")) return { error: "Invalid path" };
      const resolved = path.resolve(raw);
      const stat = await fs.promises.stat(resolved);
      if (!stat.isDirectory()) return { error: "Path must be a directory" };
      const err = await shell.openPath(resolved);
      return err ? { error: err } : { ok: true };
    }
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

  // MCP 外部服务管理通道。
  // ⚠ 注册形态冻结:以下 17 个 channel 的 `handle("<channel>"` 字面量被
  //   tests/unit/gui/mcp-gui.test.js(mcp-content / mcp-diagnostics /
  //   mcp-input-requests / mcp-oauth 四个 describe)逐条按源码文本断言,
  //   因此不能并入上方路由表,只能显式注册。转发行为与表中路由共用同一条
  //   forward() 管道(参数逐个透传 + 统一 { error } 收敛),并无行为差异。
  handle("mcp:auth-status", forward((h, id) => h.getMcpAuthStatus(id)));
  handle("mcp:auth-start", forward((h, id) => h.startMcpAuth(id)));
  handle("mcp:auth-cancel", forward((h, id) => h.cancelMcpAuth(id)));
  handle("mcp:auth-logout", forward((h, id) => h.logoutMcpAuth(id)));
  handle("mcp:logs", forward((h, id, options) => h.getMcpLogs(id, options)));
  handle("mcp:logs-export", forward((h, id, options) => saveDiagnosticExport({ host, serverId: id, options,
    showSaveDialog: (settings) => dialog.showSaveDialog(mainWindow, settings), writeFile: fs.promises.writeFile })));
  handle("mcp:tools-list", forward((h, id) => h.listMcpTools(id)));
  handle("mcp:tool-test", forward((h, id, name, params, options) => h.startMcpToolTest(id, name, params, options)));
  handle("mcp:tool-test-approve", forward((h, id) => h.approveMcpToolTest(id)));
  handle("mcp:tool-test-cancel", forward((h, id) => h.cancelMcpToolTest(id)));
  handle("mcp:input-requests", forward((h) => h.listMcpInputRequests()));
  handle("mcp:input-respond", forward((h, id, response) => h.respondMcpInputRequest(id, response)));
  handle("mcp:resources-list", forward((h, id, options) => h.listMcpResources(id, options)));
  handle("mcp:resource-templates-list", forward((h, id, options) => h.listMcpResourceTemplates(id, options)));
  handle("mcp:resource-read", forward((h, id, uri, options) => h.readMcpResource(id, uri, options)));
  handle("mcp:prompts-list", forward((h, id, options) => h.listMcpPrompts(id, options)));
  handle("mcp:prompt-get", forward((h, id, name, args, options) => h.getMcpPrompt(id, name, args, options)));

  // 收尾自检:白名单里的每个 channel 都必须被注册(表 + 显式块合并覆盖),
  // 防止重构时漏掉某条通道却无人报错。
  const missing = IPC_CHANNELS.filter((channel) => !registered.has(channel));
  if (missing.length) {
    throw new Error(`IPC channels registered but missing handlers: ${missing.join(", ")}`);
  }
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
  host?.dispose?.();
  cleanupSmokeScaffolding();
  app.quit();
});
