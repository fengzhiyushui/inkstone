import React from "react";
import { PuzzlePiece } from "@phosphor-icons/react";

// 概念预览:保留设计稿的头部 + 说明段 + 空态,不列虚构条目。
// 自 SecondaryViews.jsx 拆出(随 PluginsView 一并迁走,仅此一处使用)。
function ConceptView({ t, title, subtitle, icon, note, emptyKey }) {
  return (
    <section className="view on">
      <header className="pane-head">
        <span className="ttl">{title}</span>
        <span className="sub">{subtitle}</span>
        <div className="spacer" />
        <span className="seg">{t("concept.planning")}</span>
      </header>
      <div className="s-body"><div className="s-in" style={{ maxWidth: 760 }}>
        <div className="f-group">
          <div className="fg-t">{t("concept.configured")}</div>
          <div className="empty-note">
            <span className="en-ic">{icon}</span>
            {t(emptyKey)}
          </div>
        </div>
        <div className="f-group">
          <div className="fg-t">{t("concept.note")}</div>
          <p style={{ color: "var(--text-mut)", fontSize: "var(--fs-12)", lineHeight: 1.75, margin: 0 }}>{note}</p>
        </div>
      </div></div>
    </section>
  );
}

// v1.4 次级视图 6:插件概念预览(设计稿版式 + 空态,不虚构服务条目)。
// 自 SecondaryViews.jsx 拆出(按视图类型一文件一职责);named export 名不变,
// 仍由 SecondaryViews.jsx 再导出。
export function PluginsView({ t }) {
  return <ConceptView t={t} title={t("rail.plugins")} subtitle={t("concept.pluginsSub")}
    icon={<PuzzlePiece size={26} />} note={t("concept.plugins")} emptyKey="concept.pluginsEmpty" />;
}
