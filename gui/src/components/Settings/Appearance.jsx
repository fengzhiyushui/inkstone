import React from "react";
import ThemeHub from "./ThemeHub.jsx";

// 设置 › 外观:v1.8.0 起由 ThemeHub 承载四段分组主题网格,
// 本文件只保留 .f-group 容器与底部说明行(.s-nav 顺序不变)。
export default function Appearance({ t, state, kernel, dispatch }) {
  return (
    <div className="f-group">
      <ThemeHub t={t} state={state} kernel={kernel} dispatch={dispatch} />
      <div className="f-row" style={{ borderTop: "1px solid var(--border)", marginTop: 8 }}>
        <div className="fl"><div className="fd">{t("settings.appearance.note")}</div></div>
      </div>
    </div>
  );
}
