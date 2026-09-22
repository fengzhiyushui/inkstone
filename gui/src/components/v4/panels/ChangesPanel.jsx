import React from "react";
import { GitCompare } from "lucide-react";
import css from "../Dock.module.css";

function formatChangeTime(time) {
  if (!time) return "";
  const d = new Date(time);
  if (Number.isNaN(d.getTime())) return String(time);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// B3:ChangesView 逻辑迁入 dock 面板(数据层零改动)
export default function ChangesPanel({ t, state, onOpenChange }) {
  const changes = state.changes || [];
  const openDiff = state.changeDiff && state.changeDiff.meta ? state.changeDiff : null;
  const openId = openDiff ? openDiff.meta.id : null;
  const openPath = openDiff && openDiff.file ? openDiff.file.path : null;

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
        <div className={css.empty}><GitCompare size={18} style={{ display: "inline", verticalAlign: "middle", marginRight: 6 }} />{t("changes.empty")}</div>
      )}
    </div>
  );
}
