import React from "react";
import { Check } from "lucide-react";
import { GUI_THEMES, isLightTheme } from "../../state/themes.js";

// 设置 › 外观:10 套主题网格(卡片自带 theme 属性,预览用的是该主题的真实 token 色)。
export default function Appearance({ t, state, kernel, dispatch }) {
  const setTheme = (id) => {
    dispatch({ type: "theme_changed", theme: id });
    kernel.setPreferences({ theme: id, ...(isLightTheme(id) ? { lastLight: id } : { lastDark: id }) });
  };
  return (
    <div className="f-group">
      <div className="fg-t">{t("settings.appearance.themes")}</div>
      <div className="th-grid">
        {GUI_THEMES.map((th) => (
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
      <div className="f-row" style={{ borderTop: "1px solid var(--border)", marginTop: 8 }}>
        <div className="fl"><div className="fd">{t("settings.appearance.note")}</div></div>
      </div>
    </div>
  );
}
