import React from "react";
import { MoreHorizontal, PanelRightOpen, PanelRightClose } from "lucide-react";
import css from "./SessionHeader.module.css";

export default function SessionHeader({
  t,
  title,
  mode,
  chatTab = "chat",
  rightbarOpen = false,
  onToggleRightbar,
  onTabChange,
  right
}) {
  return (
    <header className={`pane-head ${css.head}`} role="banner">
      <span className={`ttl ${css.title}`}>{title}</span>
      {mode && (
        <span className={`seg cz-mode ${css.mode}`} title={t("chat.autonomy")}>
          {mode}
        </span>
      )}
      <div className={`spacer ${css.spacer}`} />
      <div className={css.tablist} role="tablist" aria-label={t("chat.trajectory")}>
        <button
          type="button"
          role="tab"
          className={css.tab}
          aria-selected={chatTab === "chat"}
          onClick={() => onTabChange?.("chat")}
        >
          {t("chat.title")}
        </button>
        <button
          type="button"
          role="tab"
          className={css.tab}
          aria-selected={chatTab === "trajectory"}
          onClick={() => onTabChange?.("trajectory")}
        >
          {t("chat.trajectory")}
        </button>
      </div>
      <button
        type="button"
        className={`iconbtn ${css.iconbtn} ${rightbarOpen ? "on" : ""}`}
        title={rightbarOpen ? t("rightbar.close") : t("rightbar.open")}
        aria-label={rightbarOpen ? t("rightbar.close") : t("rightbar.open")}
        onClick={() => onToggleRightbar?.()}
      >
        {rightbarOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
      </button>
      <button type="button" className={`iconbtn ${css.iconbtn}`} title={t("chat.more")}>
        <MoreHorizontal size={15} />
      </button>
      {right}
    </header>
  );
}
