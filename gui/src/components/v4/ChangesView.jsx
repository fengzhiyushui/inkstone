import React from "react";
import { GitDiff, CaretLeft, PencilSimpleLine } from "@phosphor-icons/react";
import ChangeDiffView from "../ChangeDiffView.jsx";

function formatChangeTime(time) {
  if (!time) return "";
  const d = new Date(time);
  if (Number.isNaN(d.getTime())) return String(time);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// v1.4 次级视图 5:改动双栏。左 = 逐条改动记录下的文件单(agent / 手动分组),
// 右 = 选中文件的 before↔after diff。
// 自 SecondaryViews.jsx 拆出(按视图类型一文件一职责);named export 名不变,
// 仍由 SecondaryViews.jsx 再导出。dock 内的等价面板见 panels/ChangesPanel.jsx。
export function ChangesView({ t, state, theme, onOpenChange, onDismissDiff, onReveal }) {
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
    <section className="view on">
      <div className="changes">
        <aside className="c-list">
          <div className="cl-h">{t("changes.agentChanges")}</div>
          {rows.map(({ change, files }) => (
            <React.Fragment key={change.id}>
              <div className="rail-grp" title={change.prompt || ""}>
                {change.time || change.id}{change.rolledBack ? ` · ${t("changes.rolledBack")}` : ""}
              </div>
              {files.map((f) => (
                <button type="button" key={`${change.id}:${f.path}`}
                  className={`c-item ${openId === change.id && openPath === f.path ? "on" : ""}`}
                  onClick={() => onOpenChange(change.id, f.path)}>
                  <span className="c-src">{t("changes.srcAgent")}</span>
                  {f.path}
                  <span className="ps">
                    {f.added != null && <span className="a">+{f.added}</span>}
                    {f.removed != null && <span className="d">−{f.removed}</span>}
                  </span>
                </button>
              ))}
            </React.Fragment>
          ))}
          {totalFiles === 0 && (
            <div className="empty-note">
              <span className="en-ic"><GitDiff size={22} /></span>
              {t("changes.empty")}
            </div>
          )}
        </aside>

        <div className="c-view">
          {openDiff ? (
            <>
              <div className="cv-h">
                <button type="button" className="iconbtn" title={t("diff.close")} onClick={onDismissDiff}><CaretLeft size={15} /></button>
                <span className="fp">{openPath}</span>
                {openDiff.meta.rolledBack && <span className="mini warn">{t("changes.rolledBack")}</span>}
                <span className="mini">{openDiff.meta.id}</span>
              </div>
              <div className="cv-body">
                <ChangeDiffView t={t} theme={theme} changeDiff={openDiff} onClose={onDismissDiff} onReveal={onReveal} />
              </div>
            </>
          ) : (
            <div className="empty-note" style={{ marginTop: 60 }}>
              <span className="en-ic"><PencilSimpleLine size={24} /></span>
              {t("changes.pickFile")}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
