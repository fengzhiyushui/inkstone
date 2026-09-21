import React, { useEffect, useRef, useState } from "react";
import { Check, Minus, Square, X, Moon, Sun, Diamond } from "lucide-react";
import { menuModel } from "../state/menu-model.js";
import { isLightTheme } from "../state/themes.js";

export default function TitleBar({ t, language, theme, title, railView, onToggleTheme, onToggleLang, menuActions = {} }) {
  const dark = !isLightTheme(theme);
  const model = menuModel(t);
  const [open, setOpen] = useState(null); // index of open top-level menu
  const barRef = useRef(null);

  useEffect(() => {
    if (open === null) return undefined;
    const onDoc = (e) => { if (barRef.current && !barRef.current.contains(e.target)) setOpen(null); };
    const onKey = (e) => { if (e.key === "Escape") setOpen(null); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const runAction = (id) => {
    setOpen(null);
    const fn = menuActions[id];
    if (typeof fn === "function") fn();
  };

  return (
    <header className="titlebar" role="banner">
      <div className="logo" style={{ color: "var(--accent)" }}><Diamond size={15} /></div>
      <nav className="menu" aria-label="menu" ref={barRef}>
        {model.map((group, gi) => (
          <div key={group.label} className="menu-group">
            <button type="button" className={open === gi ? "open" : ""}
              aria-haspopup="menu" aria-expanded={open === gi}
              onClick={() => setOpen(open === gi ? null : gi)}
              onMouseEnter={() => { if (open !== null) setOpen(gi); }}>
              {group.label}
            </button>
            {open === gi && (
              <div className="menu-dropdown" role="menu" aria-label={group.label}>
                {group.items.map((it, ii) => (
                  it.id === "sep"
                    ? <div key={`sep${ii}`} className="menu-sep" role="separator" />
                    : <button key={it.id} type="button" role="menuitem" disabled={it.enabled === false}
                        className="menu-item" onClick={() => runAction(it.id)}>
                        <span className="mi-label">{it.label}</span>
                        {(railView && it.id === `view.${railView}`) ? <span className="mi-check"><Check size={12} /></span> : null}
                      </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </nav>
      <div className="title">{title}</div>
      <div className="actions">
        <button type="button" className="ib lang" aria-label={t("toggle.lang")} onClick={onToggleLang}>
          {language === "zh" ? "中" : "EN"}
        </button>
        <button type="button" className="ib" aria-label={t("toggle.theme")} onClick={onToggleTheme}>
          {dark ? <Moon size={14} /> : <Sun size={14} />}
        </button>
      </div>
      {/* B0:原生 titleBarOverlay 接管窗控;自绘三钮隐藏不删(B4 删整个文件) */}
      <div className="winctl" hidden style={{ display: "none" }}>
        <button type="button" aria-label="minimize" onClick={() => window.deepseek?.minimize?.()}><Minus size={13} /></button>
        <button type="button" aria-label="maximize" onClick={() => window.deepseek?.maximizeToggle?.()}><Square size={11} /></button>
        <button type="button" className="close" aria-label="close" onClick={() => window.deepseek?.closeWindow?.()}><X size={13} /></button>
      </div>
    </header>
  );
}
