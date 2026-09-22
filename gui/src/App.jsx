import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useWorkbench } from "./hooks/useWorkbench.js";
import { useKernel } from "./hooks/useKernel.js";
import { makeT } from "./i18n/strings.js";
import { trafficTone, formatLatency } from "./state/workbench-state.js";
import { themeLabel, isLightTheme, isDarkTheme } from "./state/themes.js";
import { nextInGroup, otherModeTheme } from "./state/theme-hub.js";
import { shouldHandleShellShortcut } from "./state/hotkeys.js";
import AppFrame from "./components/v4/AppFrame.jsx";
import Rail from "./components/v4/Rail.jsx";
import HomeView from "./components/v4/HomeView.jsx";
import ChatView from "./components/v4/ChatView.jsx";
import { ProjectsView, McpView, PluginsView } from "./components/v4/SecondaryViews.jsx";
import Dock from "./components/v4/Dock.jsx";
import SettingsPanels from "./components/Settings/Settings.jsx";
import SensitiveNoticeModal from "./components/v4/SensitiveNoticeModal.jsx";

const VERSION = "1.8.2";

export default function App() {
  const [state, dispatch] = useWorkbench();
  const kernel = useKernel(dispatch);
  const t = makeT(state.language);
  const view = state.view;
  const settingsOpen = Boolean(state.settingsOpen);

  useEffect(() => {
    document.documentElement.setAttribute("theme", state.theme);
    document.documentElement.toggleAttribute("data-dark", isDarkTheme(state.theme));
  }, [state.theme]);
  useEffect(() => { document.documentElement.lang = state.language; }, [state.language]);
  useEffect(() => {
    const smoke = new URLSearchParams(window.location.search).get("smoke") === "1";
    document.documentElement.setAttribute("glass", state.glass && !smoke ? "on" : "off");
  }, [state.glass]);
  useEffect(() => { kernel.refreshChanges(); }, [state.changesTick, kernel]);
  useEffect(() => { kernel.loadSessions().catch(() => {}); }, [state.currentProject, kernel]);

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
    if (state.rightbarOpen && state.dockTab === "recovery") refreshRecovery().catch(() => {});
  }, [state.rightbarOpen, state.dockTab, state.currentProject, refreshRecovery]);

  const openSettings = useCallback(() => dispatch({ type: "settings_toggled", open: true }), [dispatch]);
  const closeSettings = useCallback(() => dispatch({ type: "settings_toggled", open: false }), [dispatch]);

  const onSwitchProject = useCallback((root) => {
    if (!root) return;
    kernel.switchProject(root)
      .then(() => {
        dispatch({ type: "project_switched", root });
        return kernel.loadSessions().catch(() => {});
      })
      .catch(() => { /* keep view */ });
  }, [kernel, dispatch]);

  const onOpenFolder = useCallback(async () => {
    const root = await kernel.pickProjectFolder();
    if (!root) return;
    await kernel.addProject(root);
    onSwitchProject(root);
  }, [kernel, onSwitchProject]);

  const onNewSession = useCallback((root) => {
    if (root && root !== state.currentProject) onSwitchProject(root);
    else dispatch({ type: "project_switched", root: root || state.currentProject });
    dispatch({ type: "view_changed", view: "chat" });
  }, [state.currentProject, onSwitchProject, dispatch]);

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

  const toggleRightbar = useCallback(() => {
    dispatch({ type: "rightbar_toggled", viewport: window.innerWidth });
  }, [dispatch]);

  const openDock = useCallback((tab) => {
    dispatch({ type: "dock_tab_changed", tab });
    if (!state.rightbarOpen) dispatch({ type: "rightbar_toggled", viewport: window.innerWidth });
  }, [dispatch, state.rightbarOpen]);

  const setViewOrDock = useCallback((v) => {
    if (v === "settings") { openSettings(); return; }
    if (v === "changes" || v === "recovery") { openDock(v); return; }
    dispatch({ type: "view_changed", view: v });
  }, [openSettings, openDock, dispatch]);

  useEffect(() => {
    const onKey = (e) => {
      const modalOpen = Boolean(state.sensitiveNotice);
      if (!shouldHandleShellShortcut(e, { settingsOpen, modalOpen })) return;
      const k = e.key.toLowerCase();
      if (k === "n") { e.preventDefault(); onNewSession(state.currentProject); }
      else if (k === "b") { e.preventDefault(); toggleRail(); }
      else if (k === "j") { e.preventDefault(); toggleRightbar(); }
      else if (k === ",") { e.preventDefault(); openSettings(); }
      else if (k === "l" && e.shiftKey) { e.preventDefault(); toggleTheme(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onNewSession, toggleRail, toggleRightbar, openSettings, toggleTheme, state.currentProject, settingsOpen, state.sensitiveNotice]);

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

  return (
    <div className="ide">
      <AppFrame
        className={`shell${state.railCollapsed ? " rail-off" : ""}`}
        hideSidebar={false}
        railCollapsed={state.railCollapsed}
        sidebarWidth={state.sidebarWidth}
        rightbarOpen={Boolean(state.rightbarOpen)}
        rightbarWidth={state.rightbarWidth || 0}
        dispatch={dispatch}
        kernel={kernel}
        sidebar={(
          <Rail t={t} state={state} version={VERSION} setView={setViewOrDock}
            collapsed={state.railCollapsed} onToggleCollapse={toggleRail}
            onSwitchProject={onSwitchProject} onNewSession={onNewSession} onOpenFolder={onOpenFolder}
            onOpenDock={openDock} />
        )}
        main={(
          <main className="pane">
            {view === "home" && (
              <HomeView t={t} state={state} actions={actions}
                setView={setViewOrDock}
                onSwitchProject={onSwitchProject} statusLine={statusLine} />
            )}
            {view === "chat" && (
              <ChatView t={t} state={state} actions={actions} kernel={kernel}
                setView={setViewOrDock}
                statusLine={statusLine}
                onChatTab={(tab) => dispatch({ type: "chat_tab_changed", tab })}
                onToggleRightbar={toggleRightbar} />
            )}
            {view === "projects" && (
              <ProjectsView t={t} state={state} onSwitchProject={onSwitchProject} onOpenFolder={onOpenFolder}
                onRemoveProject={(root) => kernel.removeProject(root)}
                onReveal={(root) => kernel.revealProject(root)} />
            )}
            {view === "mcp" && <McpView t={t} />}
            {view === "plugins" && <PluginsView t={t} />}
          </main>
        )}
        rightbar={state.rightbarOpen ? (
          <Dock
            t={t}
            state={state}
            kernel={kernel}
            dispatch={dispatch}
            rightbarWidth={state.rightbarWidth || 0}
            recovery={recovery}
            onRefreshRecovery={refreshRecovery}
            onOpenChange={(id, path) => kernel.openChangeDiff(id, path)}
            onDismissDiff={() => kernel.dismissChangeDiff()}
            onReveal={(p, line) => kernel.revealInEditor(p, line)}
            onToggleRightbar={toggleRightbar}
          />
        ) : null}
      />
      <SettingsPanels t={t} state={state} kernel={kernel} dispatch={dispatch} version={VERSION}
        open={settingsOpen} onClose={closeSettings} />
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
