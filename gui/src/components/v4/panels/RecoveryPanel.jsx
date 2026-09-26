import React from "react";
import { Lifebuoy } from "@phosphor-icons/react";
import css from "../Dock.module.css";

// B3:RecoveryView 逻辑迁入 dock 面板(kernel recovery 代理零改动)
export default function RecoveryPanel({ t, recovery, kernel, onRefreshRecovery }) {
  const items = recovery?.items || [];
  const report = recovery?.report || null;
  const busy = recovery?.busy || null;

  return (
    <div>
      <div className={css.grp}>{t("recovery.items")}</div>
      {items.length === 0 && <div className={css.empty}><Lifebuoy size={18} style={{ display: "inline", verticalAlign: "middle", marginRight: 6 }} />{t("recovery.empty")}</div>}
      {items.map((it) => (
        <div key={it.id || it.task_id} className={css.row} style={{ height: "auto", padding: "8px", alignItems: "flex-start", flexDirection: "column", gap: 4 }}>
          <div style={{ fontSize: 13, overflowWrap: "anywhere" }}>{it.summary || it.id}</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button type="button" className="btn ghost" style={{ fontSize: 12 }}
              disabled={busy === it.id}
              onClick={() => kernel?.recoveryResume?.(it.id).then(() => onRefreshRecovery?.())}>
              {t("recovery.resume")}
            </button>
            <button type="button" className="btn ghost" style={{ fontSize: 12 }}
              disabled={busy === it.id}
              onClick={() => kernel?.recoveryCancel?.(it.id).then(() => onRefreshRecovery?.())}>
              {t("recovery.cancel")}
            </button>
            <button type="button" className="btn ghost" style={{ fontSize: 12 }}
              disabled={busy === it.id}
              onClick={() => kernel?.recoveryClear?.(it.id).then(() => onRefreshRecovery?.())}>
              {t("recovery.clear")}
            </button>
          </div>
        </div>
      ))}
      {report && (
        <div className={css.grp} style={{ marginTop: 12 }}>
          {t("recovery.report")}: {t("recovery.found")} {(report.found || []).length} · {t("recovery.blocked")} {(report.blocked || []).length}
        </div>
      )}
    </div>
  );
}
