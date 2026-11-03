import React from "react";
import { Folders, FolderOpen, Trash, MagnifyingGlass } from "@phosphor-icons/react";

// v1.4 次级视图 4/7:项目列表(当前项目 + 最近项目)。
// 自 SecondaryViews.jsx 拆出(按视图类型一文件一职责);named export 名不变,
// 仍由 SecondaryViews.jsx 再导出,App.jsx 的 import 形状保持兼容。
export function ProjectsView({ t, state, onSwitchProject, onRemoveProject, onOpenFolder, onReveal, onRequestConfirm }) {
  const projects = state.projects || [];
  const current = projects.find((p) => p.root === state.currentProject) || null;
  const others = projects.filter((p) => p.root !== state.currentProject);
  const sessionCount = (id) => {
    const g = (state.sessions || []).find((x) => x.projectDir === id);
    return g ? g.sessions.length : 0;
  };

  const Card = ({ p, isCurrent }) => (
    <div className={`api-item ${isCurrent ? "cur" : ""}`}>
      <span className="ai-ic"><Folders size={16} /></span>
      <div className="ai-info" style={{ minWidth: 0 }}>
        <div className="an">{p.name}{isCurrent && <span className="badge">{t("rail.current")}</span>}</div>
        <div className="ad">{p.root} · {t("projects.sessions").replace("{n}", sessionCount(p.id))}</div>
      </div>
      <div className="spacer" />
      <div className="ai-actions">
        {onReveal && <button type="button" className="btn ghost" onClick={() => onReveal(p.root)}><FolderOpen size={12} /> {t("projects.reveal")}</button>}
        {!isCurrent && <button type="button" className="btn ghost" onClick={() => onSwitchProject(p.root)}>{t("projects.open")}</button>}
        {onRemoveProject && (
          <button type="button" className="btn ghost" title={t("projects.remove")} onClick={() => {
            if (onRequestConfirm) {
              onRequestConfirm({
                title: t ? t("rail.removeProject") : "移除项目",
                message: t ? t("rail.removeProjectConfirm") : "确定从侧栏列表中移除该项目吗？",
                subMessage: t ? t("rail.removeProjectSub") : "仅从列表中解绑，不会删除磁盘上的任何代码文件。",
                confirmText: t ? t("confirm.remove") : "移除",
                cancelText: t ? t("confirm.cancel") : "取消",
                danger: true,
                onConfirm: () => onRemoveProject(p.root)
              });
            } else {
              onRemoveProject(p.root);
            }
          }}>
            <Trash size={12} />
          </button>
        )}
      </div>
    </div>
  );

  return (
    <section className="view on">
      <header className="pane-head">
        <span className="ttl">{t("projects.title")}</span>
        <span className="sub">{t("projects.subtitle")}</span>
        <div className="spacer" />
        <button type="button" className="btn ghost" onClick={onOpenFolder}><FolderOpen size={13} /> {t("rail.openFolder")}</button>
      </header>
      <div className="s-body"><div className="s-in" style={{ maxWidth: 760 }}>
        {current && (
          <div className="f-group">
            <div className="fg-t">{t("projects.current")}</div>
            <Card p={current} isCurrent />
          </div>
        )}
        <div className="f-group">
          <div className="fg-t">{t("projects.recent")}</div>
          {others.map((p) => <Card key={p.id} p={p} isCurrent={false} />)}
          {others.length === 0 && (
            <div className="empty-note">
              <span className="en-ic"><MagnifyingGlass size={24} /></span>
              {t("projects.emptyRecent")}
            </div>
          )}
        </div>
      </div></div>
    </section>
  );
}
