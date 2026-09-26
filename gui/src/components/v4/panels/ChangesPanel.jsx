import React from "react";
import { GitDiff, CaretLeft } from "@phosphor-icons/react";
import ChangeDiffView from "../../ChangeDiffView.jsx";
import css from "../Dock.module.css";

function formatChangeTime(time) {
  if (!time) return "";
  const d = new Date(time);
  if (Number.isNaN(d.getTime())) return String(time);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// B3:ChangesView 逻辑迁入 dock 面板(数据层零改动)
export default function ChangesPanel({ t, state, onOpenChange, onDismissDiff, onReveal }) {
  const changes = state.changes || [];
  const openDiff = state.changeDiff && state.changeDiff.meta ? state.changeDiff : null;
  const openId = openDiff ? openDiff.meta.id : null;
  const openPath = openDiff && openDiff.file ? openDiff.file.path : null;

  if (openDiff) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "6px 10px", borderBottom: "1px solid var(--sash)", display: "flex", alignItems: "center", gap: 6 }}>
          <button
            type="button"
            className={css.row}
            style={{ width: "auto", padding: "2px 6px", display: "inline-flex", alignItems: "center" }}
            onClick={() => onDismissDiff?.()}
            title={t("diff.close")}
          >
            <CaretLeft size={13} style={{ marginRight: 2 }} />
            <span style={{ fontSize: 11 }}>{t("changes.agentChanges")}</span>
          </button>
          <span style={{ fontSize: 11, color: "var(--text-mut)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {openPath}
          </span>
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          <ChangeDiffView t={t} theme={state.theme} changeDiff={openDiff} onClose={onDismissDiff} onReveal={onReveal} />
        </div>
      </div>
    );
  }

  const rows = changes.map((c) => ({
    change: { ...c, time: formatChangeTime(c.time) },
    files: (c.files || []).map((f) => (typeof f === "string" ? { path: f } : f))
  }));
  const totalFiles = rows.reduce((n, r) => n + r.files.length, 0);

  return (
    <div>
      <div className={css.grp}>{t("changes.agentChanges")}</div>
      {rows.map(({ change, files }) => (
        <React.Fragment key={change.id}>
          <div className={css.grp} title={change.prompt || ""}>
            {change.time || change.id}{change.rolledBack ? ` · ${t("changes.rolledBack")}` : ""}
          </div>
          {files.map((f) => (
            <button
              type="button"
              key={`${change.id}:${f.path}`}
              className={`${css.row} ${openId === change.id && openPath === f.path ? "on" : ""}`}
              onClick={() => onOpenChange?.(change.id, f.path)}
              title={f.path}
            >
              <span className={css.nm} title={f.path}>{f.path}</span>
              {f.added != null && <span style={{ color: "var(--ok)", fontSize: 12 }}>+{f.added}</span>}
              {f.removed != null && <span style={{ color: "var(--err)", fontSize: 12 }}>−{f.removed}</span>}
            </button>
          ))}
        </React.Fragment>
      ))}
      {totalFiles === 0 && (
        <div className={css.empty}><GitDiff size={18} style={{ display: "inline", verticalAlign: "middle", marginRight: 6 }} />{t("changes.empty")}</div>
      )}
    </div>
  );
}
