import { useEffect, useMemo } from "react";
import { getApi } from "../lib/api.js";
import { buildInitialLoads, branchesAction, eventToAction, errorToAction, refreshLoadsFor } from "./kernel-loads.js";
import { targetFromCheckpoint } from "../state/workbench-state.js";

// Subscribes to window.deepseek events → dispatch, runs first-paint loads, and exposes
// action wrappers. Pure mapping lives in kernel-loads.js (node:test-covered).
export function useKernel(dispatch) {
  const api = getApi();

  useEffect(() => {
    if (!api) {
      dispatch(errorToAction("connection", new Error("GUI bridge unavailable (running without Electron)")));
      return undefined;
    }
    let cancelled = false;
    const unsub = typeof api.onKernelEvent === "function"
      ? api.onKernelEvent((e) => {
          dispatch(eventToAction(e));
          for (const load of refreshLoadsFor(e && e.type)) {
            const fn = api[load.call];
            if (typeof fn !== "function") continue;
            fn().then((res) => { if (!cancelled) dispatch(load.toAction(res)); })
              .catch((err) => { if (!cancelled) dispatch(errorToAction(load.call, err)); });
          }
        })
      : null;

    (async () => {
      for (const load of buildInitialLoads()) {
        const fn = api[load.call];
        if (typeof fn !== "function") continue;
        try {
          const res = await fn();
          if (!cancelled) dispatch(load.toAction(res));
        } catch (err) {
          if (!cancelled) dispatch(errorToAction(load.call, err));
        }
      }
      try {
        const [list, active] = await Promise.all([
          api.listBranches ? api.listBranches() : [],
          api.getActiveBranch ? api.getActiveBranch() : null
        ]);
        const activeId = active && (active.branch_id || active.id || active);
        if (!cancelled) dispatch(branchesAction(list, typeof activeId === "string" ? activeId : null));
      } catch (err) {
        if (!cancelled) dispatch(errorToAction("branches", err));
      }
    })();

    return () => {
      cancelled = true;
      if (typeof unsub === "function") unsub();
    };
  }, [api, dispatch]);

  return useMemo(() => {
    async function refreshBranches() {
      if (!api?.listBranches) return;
      try {
        const [list, active] = await Promise.all([
          api.listBranches(),
          api.getActiveBranch ? api.getActiveBranch() : null
        ]);
        const activeId = active && (active.branch_id || active.id || active);
        dispatch(branchesAction(list, typeof activeId === "string" ? activeId : null));
      } catch (err) {
        dispatch(errorToAction("branches", err));
      }
    }

    async function openFileImpl(path) {
      if (!api?.readFile) return;
      try {
        const r = await api.readFile(path);
        if (r && r.error) dispatch(errorToAction("readFile", new Error(r.error)));
        else dispatch({ type: "file_opened", file: r });
      } catch (err) {
        dispatch(errorToAction("readFile", err));
      }
    }

    return {
      available: Boolean(api),
      send: (message, opts) => api?.send?.(message, opts),
      approve: (id, decision) => api?.approve?.(id, decision),
      // #9.3:敏感文件提醒的答复(非审批通道)
      respondSensitive: (requestId, allowed) => api?.respondSensitive?.(requestId, allowed === true),
      interrupt: () => api?.interrupt?.(),
      listPaused: () => (api?.listPaused ? api.listPaused() : Promise.resolve([])),
      getTimeline: (count) => (api?.getTimeline ? api.getTimeline(count) : Promise.resolve([])),
      getState: () => (api?.getState ? api.getState() : Promise.resolve({ current: "idle", channel: null })),
      setPreferences: (patch) => api?.setPreferences?.(patch),

      // Settings bridge (pass-through; components own their local form state).
      getSettings: () => api?.getSettings?.(),
      setConfig: (patch) => api?.setConfig?.(patch),
      listApiProfiles: () => api?.listApiProfiles?.(),
      saveApiProfile: (p) => api?.saveApiProfile?.(p),
      deleteApiProfile: (id) => api?.deleteApiProfile?.(id),
      activateApiProfile: (id) => api?.activateApiProfile?.(id),
      listModels: (profileId) => api?.listModels?.(profileId),
      testConnection: (profileId) => api?.testConnection?.(profileId),

      openFile: openFileImpl,
      listTree: async () => {
        if (!api?.listTree) return [];
        try {
          const files = await api.listTree();
          const list = Array.isArray(files) ? files : (files && files.files) || [];
          dispatch({ type: "tree_loaded", files: list });
          return list;
        } catch (err) {
          dispatch(errorToAction("listTree", err));
          return [];
        }
      },

      refreshChanges: async (limit) => {
        if (!api?.listChanges) return;
        try {
          const r = await api.listChanges(limit);
          if (r && r.error) dispatch(errorToAction("changes", new Error(r.error)));
          else dispatch({ type: "changes_loaded", changes: Array.isArray(r) ? r : [] });
        } catch (err) {
          dispatch(errorToAction("changes", err));
        }
      },

      openChangeDiff: async (changeId, path) => {
        if (!api?.describeChange) {
          dispatch({ type: "change_diff_loaded", diff: { error: "changes unavailable (no bridge)" } });
          return;
        }
        try {
          const r = await api.describeChange(changeId, path);
          if (r && r.error) dispatch({ type: "change_diff_loaded", diff: { error: r.error } });
          else dispatch({
            type: "change_diff_loaded",
            diff: { meta: { id: r.id, time: r.time, prompt: r.prompt, rolledBack: r.rolledBack }, file: r.file, error: null }
          });
        } catch (err) {
          dispatch({ type: "change_diff_loaded", diff: { error: err && err.message ? err.message : String(err) } });
        }
      },

      dismissChangeDiff: () => dispatch({ type: "change_diff_dismissed" }),

      // D-G7 Recovery Center
      listRecovery: (options) => api?.listRecovery ? api.listRecovery(options) : Promise.resolve([]),
      getRecoveryReport: () => api?.getRecoveryReport
        ? api.getRecoveryReport()
        : Promise.resolve({ found: [], done: [], blocked: [], next: [] }),
      recoveryResume: (id, options) => api?.recoveryResume ? api.recoveryResume(id, options) : Promise.resolve({ error: "recovery unavailable" }),
      recoveryCancel: (id) => api?.recoveryCancel ? api.recoveryCancel(id) : Promise.resolve({ error: "recovery unavailable" }),
      recoveryClear: (id) => api?.recoveryClear ? api.recoveryClear(id) : Promise.resolve({ error: "recovery unavailable" }),

      revealInEditor: (path, line) => {
        dispatch({ type: "change_diff_dismissed" });
        dispatch({ type: "reveal_requested", path, line });
        return openFileImpl(path);
      },

      saveFile: async (path, state) => {
        if (!api?.writeFile) { dispatch(errorToAction("writeFile", new Error("save unavailable (no bridge)"))); return; }
        const file = (state?.openFiles || []).find((f) => f.path === path);
        if (!file) return;
        try {
          const r = await api.writeFile(path, file.content);
          if (r && r.error) dispatch(errorToAction("writeFile", new Error(r.error)));
          else dispatch({ type: "file_saved", path, content: file.content });
        } catch (err) {
          dispatch(errorToAction("writeFile", err));
        }
      },

      activateBranch: async (id) => {
        if (!api?.activateBranch) return;
        try {
          const r = await api.activateBranch(id);
          if (r && r.error) dispatch(errorToAction("branches", new Error(r.error)));
          await refreshBranches();
        } catch (err) {
          dispatch(errorToAction("branches", err));
        }
      },

      previewRewind: async (checkpoint) => {
        if (!api?.rewindPreview) return;
        try {
          const preview = await api.rewindPreview(targetFromCheckpoint(checkpoint));
          dispatch({ type: "rewind_preview_loaded", preview });
        } catch (err) {
          dispatch(errorToAction("rewind", err));
        }
      },

      applyRewind: async (target, force) => {
        if (!api?.rewindApply) return;
        try {
          const result = await api.rewindApply({ ...(target || {}), force: Boolean(force) });
          dispatch({ type: "rewind_result_loaded", result });
          await refreshBranches();
        } catch (err) {
          dispatch(errorToAction("rewind", err));
        }
      },

      dismissRewind: () => dispatch({ type: "rewind_dismissed" }),

      // v1.4.0 项目/会话
      switchProject: async (root) => {
        if (!api?.switchProject) return;
        const r = await api.switchProject(root);
        if (r && r.error) dispatch(errorToAction("projects", new Error(r.error)));
        return r;
      },
      addProject: async (root) => {
        if (!api?.addProject) return;
        const r = await api.addProject(root);
        if (r && r.error) dispatch(errorToAction("projects", new Error(r.error)));
        else dispatch({ type: "projects_loaded", projects: await (api.listProjects ? api.listProjects() : []) });
        return r;
      },
      removeProject: async (root) => {
        if (!api?.removeProject) return;
        const r = await api.removeProject(root);
        if (r && r.error) dispatch(errorToAction("projects", new Error(r.error)));
        else {
          dispatch({ type: "projects_loaded", projects: await (api.listProjects ? api.listProjects() : []) });
          const sess = await api.listSessions?.();
          if (sess) dispatch({ type: "sessions_loaded", sessions: Array.isArray(sess) ? sess : [] });
        }
        return r;
      },
      deleteSession: async (sessionId, options) => {
        if (!api?.deleteSession) return;
        try {
          const r = await api.deleteSession(sessionId, options);
          if (r && r.error) dispatch(errorToAction("sessions", new Error(r.error)));
          else {
            const sess = await api.listSessions?.();
            if (sess) dispatch({ type: "sessions_loaded", sessions: Array.isArray(sess) ? sess : [] });
          }
          return r;
        } catch (err) {
          dispatch(errorToAction("sessions", err));
        }
      },
      loadSessions: async () => {
        if (!api?.listSessions) return;
        try {
          const r = await api.listSessions();
          if (r && r.error) dispatch(errorToAction("sessions", new Error(r.error)));
          else dispatch({ type: "sessions_loaded", sessions: Array.isArray(r) ? r : [] });
        } catch (err) {
          dispatch(errorToAction("sessions", err));
        }
      },
      // 在系统文件管理器中显示项目目录
      revealProject: (root) => api?.revealProject?.(root),

      // 模态框打开/关闭同步窗控透明度与遮罩
      setModalActive: (active) => (api?.setModalActive ? api.setModalActive(active) : Promise.resolve({ ok: true })),

      // 「打开文件夹…」:选目录 → 登记 → 返回 root(取消返回 null,由调用方静默处理)
      pickProjectFolder: async () => {
        if (!api?.pickProjectFolder) return null;
        try {
          const r = await api.pickProjectFolder();
          if (!r || r.canceled) return null;
          if (r.error) { dispatch(errorToAction("projects", new Error(r.error))); return null; }
          return r.root || null;
        } catch (err) {
          dispatch(errorToAction("projects", err));
          return null;
        }
      }
    };
  }, [api, dispatch]);
}
