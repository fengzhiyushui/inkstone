import React, { useMemo, useState } from "react";
import css from "./TimelineView.module.css";

// 共享时间线组件：Dock Inspector 与会话头「轨迹」tab 共用。
// 虚拟列表：只渲染窗口内行，触底加载更多；行高固定 28px。
const PAGE = 80;
const ROW_H = 28;

function stampOf(row) {
  if (!row.ts) return "";
  const d = new Date(row.ts);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

export default function TimelineView({ t, rows = [], emptyText, height = 320 }) {
  const [visible, setVisible] = useState(PAGE);
  const shown = useMemo(() => rows.slice(0, visible), [rows, visible]);
  const onScroll = (ev) => {
    const el = ev.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 8 && visible < rows.length) {
      setVisible((n) => Math.min(rows.length, n + PAGE));
    }
  };

  if (!rows.length) {
    return <div className={css.empty}>{emptyText || t("timeline.empty")}</div>;
  }

  return (
    <div className={css.root} style={{ maxHeight: height }}>
      <div className={css.head}>
        <span className={css.hSeq}>{t("timeline.seq")}</span>
        <span className={css.hType}>{t("timeline.type")}</span>
        <span className={css.hTime}>{t("timeline.time")}</span>
      </div>
      <div className={css.list} onScroll={onScroll} role="list" aria-label={t("timeline.title")}>
        {shown.map((row) => (
          <div key={row.key} className={css.row} role="listitem" style={{ height: ROW_H }} title={row.content || row.type}>
            <span className={css.seq}>{row.seq != null ? row.seq : "—"}</span>
            <span className={css.type}>{row.title}</span>
            <span className={css.time}>{stampOf(row)}</span>
          </div>
        ))}
        {visible < rows.length && (
          <button type="button" className={css.more} onClick={() => setVisible((n) => Math.min(rows.length, n + PAGE))}>
            {t("timeline.more").replace("{n}", String(rows.length - visible))}
          </button>
        )}
      </div>
    </div>
  );
}
