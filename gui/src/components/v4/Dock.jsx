import React, { useEffect } from "react";
import { X } from "lucide-react";
import FilesPanel from "./panels/FilesPanel.jsx";
import ChangesPanel from "./panels/ChangesPanel.jsx";
import RecoveryPanel from "./panels/RecoveryPanel.jsx";
import css from "./Dock.module.css";

const TABS = [
  { id: "files", labelKey: "dock.files" },
  { id: "changes", labelKey: "dock.changes" },
  { id: "recovery", labelKey: "dock.recovery" }
];

export default function Dock({
  t,
  state,
  kernel,
  dispatch,
  rightbarWidth,
  recovery,
  onRefreshRecovery,
  onOpenChange,
  onDismissDiff,
  onReveal,
  onToggleRightbar
}) {
  const tab = state.dockTab || "files";

  useEffect(() => {
    if (tab === "recovery" && onRefreshRecovery) onRefreshRecovery();
  }, [tab, onRefreshRecovery]);

  return (
    <div className={css.dock} style={{ width: rightbarWidth }} role="complementary" aria-label="dock">
      <div className={css.tabbar} role="tablist" aria-label="dock tabs">
        {TABS.map(({ id, labelKey }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`${css.tab} ${tab === id ? css.tabOn : ""}`}
            onClick={() => dispatch({ type: "dock_tab_changed", tab: id })}
          >
            {t(labelKey)}
          </button>
        ))}
        <div className={css.spacer} />
        <button type="button" className={css.close} title={t("dock.close")} aria-label={t("dock.close")}
          onClick={() => onToggleRightbar?.()}>
          <X size={14} />
        </button>
      </div>
      <div className={css.body}>
        {tab === "files" && <FilesPanel t={t} state={state} kernel={kernel} dispatch={dispatch} />}
        {tab === "changes" && (
          <ChangesPanel t={t} state={state} onOpenChange={onOpenChange} onDismissDiff={onDismissDiff} onReveal={onReveal} />
        )}
        {tab === "recovery" && (
          <RecoveryPanel t={t} recovery={recovery} kernel={kernel} onRefreshRecovery={onRefreshRecovery} />
        )}
      </div>
    </div>
  );
}
