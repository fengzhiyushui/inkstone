import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWorkbench } from "./hooks/useWorkbench.js";
import { useKernel } from "./hooks/useKernel.js";
import { makeT } from "./i18n/strings.js";
import { trafficTone, formatLatency } from "./state/workbench-state.js";
import { themeLabel, isLightTheme } from "./state/themes.js";
import { nextInGroup, otherModeTheme } from "./state/theme-hub.js";
import TitleBar from "./components/TitleBar.jsx";
import Rail from "./components/v4/Rail.jsx";
import HomeView from "./components/v4/HomeView.jsx";
import ChatView from "./components/v4/ChatView.jsx";
import { ProjectsView, ChangesView, McpView, PluginsView, RecoveryView } from "./components/v4/SecondaryViews.jsx";
import Settings from "./components/Settings/Settings.jsx";
import SensitiveNoticeModal from "./components/v4/SensitiveNoticeModal.jsx";

const VERSION = "1.7.2";

export default function App() {
  const [state, dispatch] = useWorkbench();
  const kernel = useKernel(dispatch);
  const t = makeT(state.language);
  const view = state.view;

  useEffect(() => { document.documentElement.setAttribute("theme", state.theme); }, [state.theme]);
  useEffect(() => { document.documentElement.lang = state.language; }, [state.language]);
  // v1.8 γ:玻璃态只给浮层。冒烟构建经 ?smoke=1 强制关闭,保证截图确定性。
  useEffect(() => {
    const smoke = new URLSearchParams(window.location.search).get("smoke") === "1";
    document.documentElement.setAttribute("glass", state.glass && !smoke ? "on" : "off");
  }, [state.glass]);
  useEffect(() => { kernel.refreshChanges(); }, [state.changesTick, kernel]);
  useEffect(() => { kernel.loadSessions().catch(() => {}); }, [state.currentProject, kernel]);

  // D-G7 Recovery Center 数据(视图打开时拉取)
  const [recovery, setRecovery] = useState({ items: [], report: null, busy: null });
  const refreshRecovery = useCallback(async () => {
    try {
      const [items, report] = await Promise.all([
        kernel.listRecovery ? kernel.listRecovery() : Promise.resolve([]),
        kernel.getRecoveryReport ? kernel.getRecoveryReport() : Promise.resolve(null)
      ]);
      setRecovery((prev) => ({ ...prev, items: items || [], report: report || null }));
    } catch {
      setRecovery((prev) => ({ ...prev, items: [], report: null }));
    }
  }, [kernel]);
  useEffect(() => {
    if (view === "recovery") refreshRecovery().catch(() => {});
  }, [view, state.currentProject, refreshRecovery]);

  // 设置页全窗打开时记住来源视图,关闭后回到原处。
  const returnRef = useRef("home");
  const setView = useCallback((v) => {
    if (v === "settings" && state.view !== "settings") returnRef.current = state.view;
    dispatch({ type: "view_changed", view: v });
  }, [dispatch, state.view]);
  const closeSettings = useCallback(() => {
    setView(returnRef.current && returnRef.current !== "settings" ? returnRef.current : "home");
  }, [setView]);

  const onSwitchProject = useCallback((root) => {
    if (!root) return;
    kernel.switchProject(root)
      .then(() => {
        dispatch({ type: "project_switched", root });
        return kernel.loadSessions().catch(() => {});
      })
      .catch(() => { /* 目录不存在等:错误已进 errors,视图保持 */ });
  }, [kernel, dispatch]);

  // 「打开文件夹…」:选目录 → 登记 → 切换。取消则什么都不做。
  const onOpenFolder = useCallback(async () => {
    const root = await kernel.pickProjectFolder();
    if (!root) return;
    await kernel.addProject(root);
    onSwitchProject(root);
  }, [kernel, onSwitchProject]);

  const onNewSession = useCallback((root) => {
    if (root && root !== state.currentProject) onSwitchProject(root);
    else dispatch({ type: "project_switched", root: root || state.currentProject });
    setView("chat");
  }, [state.currentProject, onSwitchProject, dispatch, setView]);

  const actions = useMemo(() => ({
    send: (text) => { dispatch({ type: "message_added", message: { role: "user", text } }); kernel.send(text); },
    approve: (id, decision) => kernel.approve(id, decision),
    interrupt: () => kernel.interrupt()
  }), [dispatch, kernel]);

  const cycleTheme = useCallback(() => {
    const next = nextInGroup(state.theme);
    dispatch({ type: "theme_changed", theme: next });
    kernel.setPreferences({ theme: next, ...(isLightTheme(next) ? { lastLight: next } : { lastDark: next }) });
  }, [state.theme, dispatch, kernel]);

  const toggleTheme = useCallback(() => {
    const next = otherModeTheme(state);
    dispatch({ type: "theme_changed", theme: next });
    kernel.setPreferences({ theme: next, ...(isLightTheme(next) ? { lastLight: next } : { lastDark: next }) });
  }, [state, dispatch, kernel]);

  const toggleLang = useCallback(() => {
    const next = state.language === "zh" ? "en" : "zh";
    dispatch({ type: "language_changed", language: next });
    kernel.setPreferences({ language: next });
  }, [state.language, dispatch, kernel]);

  const toggleRail = useCallback(() => {
    const next = !state.railCollapsed;
    dispatch({ type: "rail_collapsed_changed", collapsed: next });
    kernel.setPreferences({ railCollapsed: next });
  }, [state.railCollapsed, dispatch, kernel]);

  // 全局快捷键:Ctrl/⌘+N 新建会话(侧栏按钮的 kbd 提示由此兑现)、Ctrl/⌘+B 收放侧栏。
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === "n") {
        e.preventDefault();
        onNewSession(state.currentProject);
      } else if (k === "b") {
        e.preventDefault();
        toggleRail();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onNewSession, toggleRail, state.currentProject]);

  // 对话框状态行:一份数据两处复用(首页胶囊 + 会话胶囊)。
  const statusLine = useMemo(() => ({
    display: state.statusDisplay,
    usage: state.usage,
    status: {
      branch: state.activeBranchId,
      checkpoints: (state.checkpoints || []).length,
      connection: trafficTone(state) === "error" ? "error" : trafficTone(state) === "offline" ? "offline" : trafficTone(state) === "working" ? "working" : "ready",
      busy: trafficTone(state) === "working",
      model: state.config?.model,
      theme: state.theme,
      themeLabel: `${state.theme} ${themeLabel(state.theme)}`,
      language: state.language,
      turnTime: state.usage ? formatLatency(state.usage) : "",
      turnChanges: (state.changes || []).length
    },
    actions: {
      onCycleForm: (form) => {
        const next = { ...state.statusDisplay, form };
        dispatch({ type: "status_display_changed", display: next });
        kernel.setPreferences({ statusDisplay: next });
      },
      onCycleTheme: cycleTheme,
      onToggleLang: toggleLang
    }
  }), [state, dispatch, kernel, cycleTheme, toggleLang]);

  const menuActions = {
    "view.home": () => setView("home"),
    "view.settings": () => setView("settings"),
    "view.theme": toggleTheme,
    "view.lang": toggleLang,
    "help.about": () => setView("settings")
  };

  return (
    <div className="ide">
      <TitleBar t={t} language={state.language} theme={state.theme} title="Inkstone"
        railView={view} onToggleTheme={toggleTheme} onToggleLang={toggleLang} menuActions={menuActions} />
      <div className={`shell${state.railCollapsed ? " rail-off" : ""}${view === "settings" ? " shell-settings" : ""}`}>
        {view !== "settings" && (
          <Rail t={t} state={state} version={VERSION} setView={setView}
            collapsed={state.railCollapsed} onToggleCollapse={toggleRail}
            onSwitchProject={onSwitchProject} onNewSession={onNewSession} onOpenFolder={onOpenFolder} />
        )}
        <main className="pane">
          {view === "home" && (
            <HomeView t={t} state={state} actions={actions} setView={setView}
              onSwitchProject={onSwitchProject} statusLine={statusLine} />
          )}
          {view === "chat" && (
            <ChatView t={t} state={state} actions={actions} kernel={kernel} setView={setView} statusLine={statusLine} />
          )}
          {view === "projects" && (
            <ProjectsView t={t} state={state} onSwitchProject={onSwitchProject} onOpenFolder={onOpenFolder}
              onRemoveProject={(root) => kernel.removeProject(root)}
              onReveal={(root) => kernel.revealProject(root)} />
          )}
          {view === "changes" && (
            <ChangesView t={t} state={state} theme={state.theme}
              onOpenChange={(id, path) => kernel.openChangeDiff(id, path)}
              onDismissDiff={() => kernel.dismissChangeDiff()}
              onReveal={(p, line) => kernel.revealInEditor(p, line)} />
          )}
          {view === "mcp" && <McpView t={t} />}
          {view === "plugins" && <PluginsView t={t} />}
          {view === "recovery" && (
            <RecoveryView
              t={t}
              items={recovery.items}
              report={recovery.report}
              busy={recovery.busy}
              onRefresh={() => refreshRecovery()}
              onResume={async (id) => {
                setRecovery((p) => ({ ...p, busy: id }));
                try { await kernel.recoveryResume(id); } finally { setRecovery((p) => ({ ...p, busy: null })); await refreshRecovery(); }
              }}
              onCancel={async (id) => {
                setRecovery((p) => ({ ...p, busy: id }));
                try { await kernel.recoveryCancel(id); } finally { setRecovery((p) => ({ ...p, busy: null })); await refreshRecovery(); }
              }}
              onClear={async (id) => {
                setRecovery((p) => ({ ...p, busy: id }));
                try { await kernel.recoveryClear(id); } finally { setRecovery((p) => ({ ...p, busy: null })); await refreshRecovery(); }
              }}
            />
          )}
          {view === "settings" && <Settings t={t} state={state} kernel={kernel} dispatch={dispatch} version={VERSION} onClose={closeSettings} />}
        </main>
      </div>
      {/* #9.3:红色风险提醒。全窗模态,压在所有视图之上 —— 它不是审批,
          不进检查器的审批分区。 */}
      <SensitiveNoticeModal
        notice={state.sensitiveNotice}
        t={t}
        onRespond={(allowed) => {
          kernel.respondSensitive(state.sensitiveNotice.requestId, allowed);
          dispatch({ type: "sensitive_notice_cleared" });
        }}
      />
    </div>
  );
}
