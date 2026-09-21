import React, { useEffect } from "react";
import { X } from "lucide-react";
import css from "./SettingsModal.module.css";

export default function SettingsModal({ t, open, onClose, children, nav, active, onNav }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === "Escape") onClose?.(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className={css.backdrop} role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className={css.card} role="dialog" aria-modal="true" aria-label={t("rail.settings")}>
        <aside className={`settings-nav ${css.nav}`} aria-label={t("rail.settings")}>
          <div className={css.navHead}>{t("rail.settings")}</div>
          {nav}
        </aside>
        <div className={css.body}>
          <button type="button" className={css.close} title={t("settings.close")} aria-label={t("settings.close")} onClick={onClose}>
            <X size={14} />
          </button>
          {children}
        </div>
      </div>
    </div>
  );
}
