import React, { useState } from "react";
import {
  Home, FolderKanban, GitCompare, Network, Puzzle, Plus, ChevronDown, ChevronRight,
  FolderPlus, MessageSquare, Diamond, Settings, PanelLeftClose, PanelLeftOpen, LifeBuoy
} from "lucide-react";
import { filterProjectTree, groupSessionsByDate, sessionStamp } from "../../state/session-groups.js";

// v1.4 侧栏(设计稿 v4):
//   上 = 品牌 / 新会话(带「在哪里新建」)/ 搜索 / 功能区(固定不滚)
//   中 = 每个项目一个独立分区,分区体内挂该项目自己的会话(按今天/昨天/本周/更早分段)
//   下 = 独立对话 + 页脚(用户 + 设置入口)
// 图标全部 lucide;搜索同时过滤项目与会话。
// 折叠态(.rail.collapsed,偏好 railCollapsed 持久化):缩成 52px 图标轨,
// 仅保留品牌标 + 功能区图标 + 页脚(展开/设置),文本与分区体全部隐藏。

export default function Rail({
  t, state, version, setView, onSwitchProject, onNewSession, onOpenFolder,
  collapsed = false, onToggleCollapse
}) {
  const view = state.view;
  const projects = state.projects || [];
  const currentRoot = state.currentProject;
  const [newMenu, setNewMenu] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState({});   // 分区折叠(projects / standalone)
  const [closedProject, setClosedProject] = useState({}); // 项目分区折叠(默认展开)
  const [query, setQuery] = useState("");
  const now = Date.now();

  const registeredIds = new Set(projects.map((p) => p.id));
  const standalone = (state.sessions || [])
    .filter((g) => !registeredIds.has(g.projectDir))
    .flatMap((g) => g.sessions)
    .filter((s) => !query.trim() || String(s.summary || "").toLowerCase().includes(query.trim().toLowerCase()));

  const tree = filterProjectTree(projects, state.sessions, query);

  const fn = [
    { id: "home", label: t("rail.home"), icon: Home },
    { id: "projects", label: t("rail.projects"), icon: FolderKanban, badge: projects.length || null },
    { id: "changes", label: t("rail.changes"), icon: GitCompare, badge: (state.changes || []).length || null },
    { id: "recovery", label: t("rail.recovery"), icon: LifeBuoy },
    { id: "mcp", label: t("rail.mcp"), icon: Network },
    { id: "plugins", label: t("rail.plugins"), icon: Puzzle }
  ];

  const stampText = (mtime) => {
    const s = sessionStamp(mtime, now);
    return s.kind === "weekday" ? t(`day.${s.weekday}`) : s.text;
  };

  const openSession = (root) => { if (root && root !== currentRoot) onSwitchProject(root); else setView("chat"); };

  const SectionHead = ({ id, label, count, onAdd, addTitle }) => (
    <div className={`sec-head ${collapsedSections[id] ? "closed" : ""}`}
      onClick={() => setCollapsedSections((p) => ({ ...p, [id]: !p[id] }))}>
      <span className="chev">{collapsedSections[id] ? <ChevronRight size={11} /> : <ChevronDown size={11} />}</span>
      {label}
      {onAdd
        ? <button type="button" className="add" title={addTitle} onClick={(e) => { e.stopPropagation(); onAdd(); }}><FolderPlus size={13} /></button>
        : <span className="cnt">{count}</span>}
    </div>
  );

  return (
    <aside className={`rail ${collapsed ? "collapsed" : ""}`}>
      <div className="rail-brand">
        <span className="lg"><Diamond size={14} /></span>
        <span className="nm">Inkstone</span>
        <span className="vv">v{version}</span>
      </div>

      <div className="newwrap">
        <button type="button" className="rail-new" onClick={() => onNewSession(currentRoot)} title={t("rail.newSession")}>
          <Plus size={14} /> {t("rail.newSession")}<span className="kbd">Ctrl N</span>
        </button>
        <button type="button" className="new-more" onClick={() => setNewMenu(!newMenu)} title={t("rail.newWhere")}>
          <ChevronDown size={12} />
        </button>
        {newMenu && (
          <div className="new-menu open">
            <div className="nm-h">{t("rail.newWhere")}</div>
            {projects.map((p) => (
              <div key={p.id} className={`nm-i ${p.root === currentRoot ? "on" : ""}`}
                onClick={() => { setNewMenu(false); onNewSession(p.root); }}>
                <span className="d" />
                <div>
                  <div className="t">{p.name}{p.root === currentRoot && <span className="cur">{t("rail.current")}</span>}</div>
                  <div className="s">{p.root === currentRoot ? t("rail.inheritDir") : p.root}</div>
                </div>
              </div>
            ))}
            <div className="nm-sep" />
            <div className="nm-i" onClick={() => { setNewMenu(false); onNewSession(null); }}>
              <span className="d free" />
              <div><div className="t">{t("rail.standalone")}</div><div className="s">{t("rail.noProject")}</div></div>
            </div>
            <div className="nm-i" onClick={() => { setNewMenu(false); onOpenFolder(); }}>
              <span className="d free" />
              <div><div className="t">{t("rail.openFolder")}</div><div className="s">{t("rail.onlyNew")}</div></div>
            </div>
          </div>
        )}
      </div>

      <div className="rail-search">
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("rail.searchPlaceholder")} />
      </div>

      <nav className="rail-fn">
        {fn.map(({ id, label, icon: Icon, badge }) => (
          <button type="button" key={id} className={`fn-item ${view === id ? "on" : ""}`} onClick={() => setView(id)}>
            <span className="ic"><Icon size={16} /></span>
            <span className="tt">{label}</span>
            {badge ? <span className="badge">{badge}</span> : null}
          </button>
        ))}
      </nav>
      <div className="rail-div" />

      <div className="rail-scroll">
        <SectionHead id="projects" label={t("rail.projects")} onAdd={onOpenFolder} addTitle={t("rail.openFolder")} />
        <div className={`sec-body ${collapsedSections.projects ? "closed" : ""}`}>
          {tree.length === 0 && (
            <div className="proj-empty">{query.trim() ? t("rail.noMatch") : t("rail.noProjects")}</div>
          )}
          {tree.map(({ project: p, sessions }) => {
            const open = !closedProject[p.id];
            const groups = groupSessionsByDate(sessions, now);
            return (
              <div key={p.id} className={`proj ${p.root === currentRoot ? "cur" : ""} ${open ? "open" : ""}`}>
                <div className="proj-h" onClick={() => setClosedProject((prev) => ({ ...prev, [p.id]: open }))}>
                  <span className="chev">{open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}</span>
                  <span className="dot" />
                  <span className="nm" title={p.root}>{p.name}</span>
                  {p.root === currentRoot
                    ? <span className="tag">{t("rail.current")}</span>
                    : <span className="cnt">{sessions.length}</span>}
                  <button type="button" className="pnew" title={t("rail.newInProject")}
                    onClick={(e) => { e.stopPropagation(); onNewSession(p.root); }}><Plus size={12} /></button>
                </div>
                <div className="proj-b">
                  {groups.length === 0 && <div className="proj-empty">{t("rail.noSessions")}</div>}
                  {groups.map((g) => (
                    <React.Fragment key={g.bucket}>
                      <div className="rail-grp">{t(`bucket.${g.bucket}`)}</div>
                      {g.sessions.slice(0, 4).map((s) => (
                        <button type="button" key={s.id} className="r-item" onClick={() => openSession(p.root)}>
                          <span className="tt">{s.summary || t("rail.untitled")}</span>
                          <span className="xx">{stampText(s.mtime)}</span>
                        </button>
                      ))}
                    </React.Fragment>
                  ))}
                  {sessions.length > 4 && (
                    <button type="button" className="proj-more" onClick={() => setView("projects")}>
                      {t("rail.allSessions").replace("{n}", sessions.length)}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <SectionHead id="standalone" label={t("rail.standalone")} count={standalone.length} />
        <div className={`sec-body ${collapsedSections.standalone ? "closed" : ""}`}>
          {standalone.length === 0 && <div className="proj-empty">{t("rail.noStandalone")}</div>}
          {standalone.slice(0, 8).map((s) => (
            <button type="button" key={s.id} className="r-item" onClick={() => setView("chat")}>
              <span className="ric"><MessageSquare size={13} /></span>
              <span className="tt">{s.summary || t("rail.untitled")}</span>
              <span className="xx">{stampText(s.mtime)}</span>
            </button>
          ))}
          <button type="button" className="r-item" onClick={() => onNewSession(null)}>
            <span className="ric"><Plus size={13} /></span>
            <span className="tt">{t("rail.newStandalone")}</span>
          </button>
        </div>
      </div>

      <div className="rail-foot">
        <span className="who" title={state.currentProject || ""}>
          <span className="avatar" style={{ width: 22, height: 22 }}><FolderKanban size={12} /></span>
          <span className="nmx">{state.currentProject ? state.currentProject.split(/[\\/]/).filter(Boolean).pop() : t("rail.noProjects")}</span>
        </span>
        <button type="button" className={`iconbtn rail-toggle ${collapsed ? "on" : ""}`}
          title={collapsed ? t("rail.expand") : t("rail.collapse")}
          aria-label={collapsed ? t("rail.expand") : t("rail.collapse")}
          onClick={onToggleCollapse}>
          {collapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
        </button>
        <button type="button" className={`iconbtn ${view === "settings" ? "on" : ""}`}
          title={t("rail.settings")} onClick={() => setView("settings")}><Settings size={15} /></button>
      </div>
    </aside>
  );
}
