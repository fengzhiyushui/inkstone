import React from "react";
import { MagnifyingGlass, Lifebuoy } from "@phosphor-icons/react";

// D-G7 Recovery Center:列表 + report 摘要 + 动作。recovery 未启用时展示空态说明。
// 自 SecondaryViews.jsx 拆出(按视图类型一文件一职责);named export 名不变,
// 仍由 SecondaryViews.jsx 再导出。dock 内的等价面板见 panels/RecoveryPanel.jsx。
export function RecoveryView({ t, items = [], report = null, busy = null, onResume, onCancel, onClear, onRefresh, disabled = false }) {
  const buckets = [
    { key: "found", label: t("recovery.found") },
    { key: "done", label: t("recovery.done") },
    { key: "blocked", label: t("recovery.blocked") },
    { key: "next", label: t("recovery.next") }
  ];
  return (
    <section className="view on">
      <header className="pane-head">
        <span className="ttl">{t("recovery.title")}</span>
        <span className="sub">{t("recovery.subtitle")}</span>
        <div className="spacer" />
        <button type="button" className="btn ghost" onClick={onRefresh}><MagnifyingGlass size={13} /> {t("recovery.refresh")}</button>
      </header>
      <div className="s-body"><div className="s-in" style={{ maxWidth: 760 }}>
        {disabled && (
          <div className="empty-note">
            <span className="en-ic"><Lifebuoy size={24} /></span>
            {t("recovery.disabled")}
          </div>
        )}
        {!disabled && (
          <>
            {report && (
              <div className="f-group">
                <div className="fg-t">{t("recovery.report")}</div>
                {buckets.map((b) => (
                  <div key={b.key} className="api-item">
                    <div className="an">{b.label}</div>
                    <div className="ad">{(report[b.key] || []).length}</div>
                  </div>
                ))}
              </div>
            )}
            <div className="f-group">
              <div className="fg-t">{t("recovery.items")}</div>
              {items.length === 0 && (
                <div className="empty-note">
                  <span className="en-ic"><Lifebuoy size={24} /></span>
                  {t("recovery.empty")}
                </div>
              )}
              {items.map((item) => {
                const id = item.id || item.approval_id || item.key || "";
                return (
                  <div key={id || String(Math.random())} className="api-item">
                    <div className="ai-info" style={{ minWidth: 0 }}>
                      <div className="an">{id}</div>
                      <div className="ad">{item.kind || item.status || item.type || ""}{item.summary ? ` · ${item.summary}` : ""}</div>
                    </div>
                    <div className="spacer" />
                    <div className="ai-actions">
                      {onResume && (
                        <button type="button" className="btn ghost" disabled={busy === id}
                          onClick={() => onResume(id)}>{t("recovery.resume")}</button>
                      )}
                      {onCancel && (
                        <button type="button" className="btn ghost" disabled={busy === id}
                          onClick={() => onCancel(id)}>{t("recovery.cancel")}</button>
                      )}
                      {onClear && (
                        <button type="button" className="btn ghost" disabled={busy === id}
                          onClick={() => onClear(id)}>{t("recovery.clear")}</button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div></div>
    </section>
  );
}
