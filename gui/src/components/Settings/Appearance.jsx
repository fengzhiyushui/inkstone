import React, { useState } from "react";
import { Check } from "@phosphor-icons/react";
import { TIERS, themesByTier, isLightTheme } from "../../state/themes.js";
import { contrastRatio } from "../../state/contrast.js";
import { Switch } from "./Form.jsx";

// v1.8.1 设置 › 外观:ThemeHub 并入本文件(结构两档 + 10 套配色)。
const SWATCHES = ["bg-base", "bg-panel", "text", "text-mut", "accent"];

function cssVar(name) {
  if (typeof document === "undefined") return "";
  return getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
}

function ThemeDetail({ t, family }) {
  const [copied, setCopied] = useState("");
  const text = cssVar("text");
  const bg = cssVar("bg-base");
  const ratio = text && bg ? contrastRatio(text, bg).toFixed(2) : "—";

  const copy = (hex) => {
    try { navigator.clipboard?.writeText(hex); } catch { /* ignore */ }
    setCopied(hex);
  };

  return (
    <div className="th-detail">
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {SWATCHES.map((name) => {
          const hex = cssVar(name);
          return (
            <button type="button" key={name} title={`--${name}`} onClick={() => copy(hex)}
              style={{
                display: "flex", alignItems: "center", gap: 5, padding: "3px 7px",
                borderRadius: "var(--r-6)", border: ".5px solid var(--border-l2)",
                background: "var(--bg-element)", color: "var(--text)",
                fontSize: "12px", fontFamily: "var(--font-mono)"
              }}>
              <i style={{ width: 10, height: 10, borderRadius: 3, border: ".5px solid var(--border-strong)", background: `var(--${name})` }} />
              {copied === hex ? t("theme.detail.copied") : hex}
            </button>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 14, marginTop: 7 }}>
        <span className="mini">{t("theme.detail.contrast")} {ratio}</span>
        <span className="mini">{t("theme.detail.source")} {family}</span>
      </div>
    </div>
  );
}

export default function Appearance({ t, state, kernel, dispatch }) {
  const setTheme = (id) => {
    dispatch({ type: "theme_changed", theme: id });
    kernel.setPreferences({ theme: id, ...(isLightTheme(id) ? { lastLight: id } : { lastDark: id }) });
  };
  const setGlass = (on) => {
    dispatch({ type: "glass_changed", glass: on });
    kernel.setPreferences({ glass: on });
  };
  const byTier = themesByTier();

  return (
    <div className="f-group">
      <div className="fd" style={{ color: "var(--text-mut)", fontSize: "12px", marginBottom: 10 }}>
        {t("settings.appearance.sd")}
      </div>
      {TIERS.map((tier) => {
        const list = byTier[tier] || [];
        const active = list.find((x) => x.id === state.theme);
        return (
          <div className="f-group" key={tier}>
            <div className="fg-t">{t(`settings.appearance.${tier}`)}</div>
            <div className="fd" style={{ color: "var(--text-mut)", fontSize: "12px", marginBottom: 10 }}>
              {t(`settings.appearance.${tier}.desc`)}
            </div>
            <div className="th-grid">
              {list.map((th) => (
                <button type="button" key={th.id} theme={th.id}
                  className={`th-card ${state.theme === th.id ? "on" : ""}`}
                  aria-pressed={state.theme === th.id} onClick={() => setTheme(th.id)}>
                  <span className="pv"><i /><i /></span>
                  <span className="nm">
                    {state.theme === th.id && <Check size={12} />}
                    {th.id} {th.name}
                    <span className="k">{t(`settings.appearance.${th.group}`)}</span>
                  </span>
                </button>
              ))}
            </div>
            {active && <ThemeDetail t={t} family={active.family} />}
          </div>
        );
      })}
      <div className="f-group">
        <div className="fg-t">{t("settings.appearance.glass")}</div>
        <div className="f-row">
          <div className="fl"><div className="fd">{t("settings.appearance.glass.desc")}</div></div>
          <Switch on={Boolean(state.glass)} onChange={setGlass} label={t("settings.appearance.glass")} />
        </div>
      </div>
      <div className="f-row" style={{ borderTop: ".5px solid var(--border-l2)", marginTop: 8 }}>
        <div className="fl"><div className="fd">{t("settings.appearance.note")}</div></div>
      </div>
    </div>
  );
}
