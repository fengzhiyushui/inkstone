import React, { useState } from "react";
import {
  Home, FolderKanban, GitCompare, Network, Puzzle, Plus, ChevronDown, ChevronRight,
  FolderPlus, MessageSquare, Diamond, Settings, PanelLeftClose, PanelLeftOpen, LifeBuoy, Search
} from "lucide-react";
import { filterProjectTree, groupSessionsByDate, sessionStamp } from "../../state/session-groups.js";
import css from "./Rail.module.css";

// v1.8.1 侧栏:结构三段保留(rail-fn / rail-scroll / rail-foot + rail-new + sec-head),
// 视觉走 Rail.module.css(DSH 数值);语义类名保留给 smoke / dom-contract。

export default function Rail({
  t, state, version, setView, onSwitchProject, onNewSession, onOpenFolder,
  collapsed = false, onToggleCollapse
}) {
  const view = state.view;
  const projects = state.projects || [];
  const currentRoot = state.currentProject;
  const [newMenu, setNewMenu] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState({});
  const [closedProject, setClosedProject] = useState({});
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
    <div className={`sec-head ${css.secHead} ${collapsedSections[id] ? "closed" : ""}`}
      onClick={() => setCollapsedSections((p) => ({ ...p, [id]: !p[id] }))}>
      <span className="chev">{collapsedSections[id] ? <ChevronRight size={11} /> : <ChevronDown size={11} />}</span>
      {label}
      {onAdd
        ? <button type="button" className="add" title={addTitle} onClick={(e) => { e.stopPropagation(); onAdd(); }}><FolderPlus size={13} /></button>
        : <span className="cnt">{count}</span>}
    </div>
  );

  return (
    <aside className={`rail ${css.root} ${collapsed ? `collapsed ${css.collapsed}` : ""}`}>
      <div className={`rail-brand ${css.brand} ${collapsed ? css.brandCollapsed : ""}`}>
        <span className="lg" style={{ color: "var(--accent-text)" }}><Diamond size={14} /></span>
        <span className="nm">Inkstone</span>
        <span className="vv">v{version}</span>
      </div>

      <div className={`newwrap ${css.newwrap}`}>
        <button type="button" className={`rail-new ${css.newBtn}`} onClick={() => onNewSession(currentRoot)} title={t("rail.newSession")}>
          <Plus size={14} /> {t("rail.newSession")}<span className="kbd">Ctrl N</span>
        </button>
        <button type="button" className={`new-more ${css.newMore}`} onClick={() => setNewMenu(!newMenu)} title={t("rail.newWhere")}>
          <ChevronDown size={12} />
        </button>
        {newMenu && (
          <div className={`new-menu open ${css.newMenu}`}>
            <div className={`nm-h ${css.hd}`}>{t("rail.newWhere")}</div>
            {projects.map((p) => (
              <div key={p.id} className={`nm-i ${css.it} ${p.root === currentRoot ? "on" : ""}`}
                onClick={() => { setNewMenu(false); onNewSession(p.root); }}>
                <div>
                  <div className="t">{p.name}{p.root === currentRoot && <span className="cur">{t("rail.current")}</span>}</div>
                  <div className={`s ${css.sub}`}>{p.root === currentRoot ? t("rail.inheritDir") : p.root}</div>
                </div>
              </div>
            ))}
            <div className="nm-sep" />
            <div className={`nm-i ${css.it}`} onClick={() => { setNewMenu(false); onNewSession(null); }}>
              <div><div className="t">{t("rail.standalone")}</div><div className={`s ${css.sub}`}>{t("rail.noProject")}</div></div>
            </div>
            <div className={`nm-i ${css.it}`} onClick={() => { setNewMenu(false); onOpenFolder(); }}>
              <div><div className="t">{t("rail.openFolder")}</div><div className={`s ${css.sub}`}>{t("rail.onlyNew")}</div></div>
            </div>
          </div>
        )}
      </div>

      <div className={`rail-search ${css.search}`}>
        <Search size={12} aria-hidden="true" />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("rail.searchPlaceholder")} />
      </div>

      <nav className={`rail-fn ${css.fn}`}>
        {fn.map(({ id, label, icon: Icon, badge }) => (
          <button type="button" key={id} className={`fn-item ${css.fnItem} ${view === id ? "on" : ""}`} onClick={() => setView(id)}>
            <span className="ic"><Icon size={16} /></span>
            <span className="tt">{label}</span>
            {badge ? <span className="badge">{badge}</span> : null}
          </button>
        ))}
      </nav>
      <div className={`rail-div ${css.div}`} />

      <div className={`rail-scroll ${css.scroll}`}>
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
                <div className={`proj-h ${css.row} ${p.root === currentRoot ? "cur" : ""}`}
                  onClick={() => setClosedProject((prev) => ({ ...prev, [p.id]: open }))}>
                  <span className="chev">{open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}</span>
                  <span className="dot" />
                  <span className="nm" title={p.root}>{p.name}</span>
                  {p.root === currentRoot
                    ? <span className="tag">{t("rail.current")}</span>
                    : <span className="cnt">{sessions.length}</span>}
                  <button type="button" className={`pnew ${css.iconbtn}`} title={t("rail.newInProject")}
                    onClick={(e) => { e.stopPropagation(); onNewSession(p.root); }}><Plus size={12} /></button>
                </div>
                <div className="proj-b">
                  {groups.length === 0 && <div className="proj-empty">{t("rail.noSessions")}</div>}
                  {groups.map((g) => (
                    <React.Fragment key={g.bucket}>
                      <div className={`rail-grp ${css.secHead}`}>{t(`bucket.${g.bucket}`)}</div>
                      {g.sessions.slice(0, 4).map((s) => (
                        <button type="button" key={s.id} className={`r-item ${css.row}`} onClick={() => openSession(p.root)}>
                          <span className="tt" style={{ flex: 1, minWidth: 0 }}>{s.summary || t("rail.untitled")}</span>
                          <span className={`xx ${css.meta}`}>{stampText(s.mtime)}</span>
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
            <button type="button" key={s.id} className={`r-item ${css.row}`} onClick={() => setView("chat")}>
              <span className="ric"><MessageSquare size={13} /></span>
              <span className="tt" style={{ flex: 1, minWidth: 0 }}>{s.summary || t("rail.untitled")}</span>
              <span className={`xx ${css.meta}`}>{stampText(s.mtime)}</span>
            </button>
          ))}
          <button type="button" className={`r-item ${css.row}`} onClick={() => onNewSession(null)}>
            <span className="ric"><Plus size={13} /></span>
            <span className="tt" style={{ flex: 1, minWidth: 0 }}>{t("rail.newStandalone")}</span>
          </button>
        </div>
      </div>

      <div className={`rail-foot ${css.foot}`}>
        <span className="who" title={state.currentProject || ""}>
          <span className="avatar" style={{ width: 22, height: 22 }}><FolderKanban size={12} /></span>
          <span className="nmx">{state.currentProject ? state.currentProject.split(/[\\/]/).filter(Boolean).pop() : t("rail.noProjects")}</span>
        </span>
        <button type="button" className={`iconbtn rail-toggle ${css.iconbtn} ${collapsed ? "on" : ""}`}
          title={collapsed ? t("rail.expand") : t("rail.collapse")}
          aria-label={collapsed ? t("rail.expand") : t("rail.collapse")}
          onClick={onToggleCollapse}>
          {collapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
        </button>
        <button type="button" className={`iconbtn ${css.iconbtn} ${view === "settings" ? "on" : ""}`}
          title={t("rail.settings")} onClick={() => setView("settings")}><Settings size={15} /></button>
      </div>
    </aside>
  );
}
