import React, { useEffect, useRef, useState } from "react";
import {
  Home, FolderKanban, GitCompare, Network, Puzzle, Plus, ChevronDown, ChevronRight,
  FolderPlus, MessageSquare, Diamond, Settings, PanelLeftClose, PanelLeftOpen, LifeBuoy, Search,
  Palette, Languages
} from "lucide-react";
import { filterProjectTree, groupSessionsByDate, sessionStamp } from "../../state/session-groups.js";
import css from "./Rail.module.css";

// v1.8.1 侧栏:结构三段保留(rail-fn / rail-scroll / rail-foot + rail-new + sec-head),
// 视觉走 Rail.module.css(DSH 数值);语义类名保留给 smoke / dom-contract。

export default function Rail({
  t, state, version, setView, onSwitchProject, onNewSession, onOpenFolder,
  collapsed = false, onToggleCollapse,
  onOpenDock,
  onCycleTheme, onToggleLang
}) {
  const view = state.view;
  const projects = state.projects || [];
  const currentRoot = state.currentProject;
  const [newMenu, setNewMenu] = useState(false);
  const newWrapRef = useRef(null);
  const [collapsedSections, setCollapsedSections] = useState({});
  const [closedProject, setClosedProject] = useState({});
  const [query, setQuery] = useState("");
  const now = Date.now();

  useEffect(() => {
    if (collapsed) {
      setNewMenu(false);
      return undefined;
    }
    if (!newMenu) return undefined;
    const onDown = (e) => {
      if (newWrapRef.current && !newWrapRef.current.contains(e.target)) {
        setNewMenu(false);
      }
    };
    const onKey = (e) => {
      if (e.key === "Escape") setNewMenu(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [collapsed, newMenu]);

  const registeredIds = new Set(projects.map((p) => p.id));
  const standalone = (state.sessions || [])
    .filter((g) => !registeredIds.has(g.projectDir))
    .flatMap((g) => g.sessions)
    .filter((s) => !query.trim() || String(s.summary || "").toLowerCase().includes(query.trim().toLowerCase()));

  const tree = filterProjectTree(projects, state.sessions, query);

  const fn = [
    { id: "home", label: t("rail.home"), icon: Home },
    { id: "projects", label: t("rail.projects"), icon: FolderKanban, badge: projects.length || null },
    { id: "changes", label: t("rail.changes"), icon: GitCompare, badge: (state.changes || []).length || null, dock: "changes" },
    { id: "recovery", label: t("rail.recovery"), icon: LifeBuoy, dock: "recovery" },
    { id: "mcp", label: t("rail.mcp"), icon: Network },
    { id: "plugins", label: t("rail.plugins"), icon: Puzzle }
  ];

  const stampText = (mtime) => {
    const s = sessionStamp(mtime, now);
    return s.kind === "weekday" ? t(`day.${s.weekday}`) : s.text;
  };

  const openSession = (root) => { if (root && root !== currentRoot) onSwitchProject(root); else setView("chat"); };

  const SectionHead = ({ id, label, count, onAdd, addTitle }) => (
    <div className={`sec-head ${css.secHead} ${collapsedSections[id] ? "closed" : ""}`}>
      <button
        type="button"
        className={css.secToggle}
        aria-expanded={!collapsedSections[id]}
        onClick={() => setCollapsedSections((p) => ({ ...p, [id]: !p[id] }))}
      >
        <span className="chev">{collapsedSections[id] ? <ChevronRight size={11} /> : <ChevronDown size={11} />}</span>
        {label}
      </button>
      {onAdd
        ? <button type="button" className="add" title={addTitle} onClick={onAdd}><FolderPlus size={13} /></button>
        : <span className="cnt">{count}</span>}
    </div>
  );

  return (
    <aside className={`rail ${css.root} ${collapsed ? `collapsed ${css.collapsed}` : ""}`}>
      <div className={`rail-brand ${css.brand} ${collapsed ? css.brandCollapsed : ""}`}>
        <span className="lg" style={{ color: "var(--accent-text)" }}><Diamond size={14} /></span>
        <span className={`nm ${css.brandText}`}>Inkstone</span>
        <span className={`vv ${css.brandVersion}`}>v{version}</span>
        <button type="button" className={`iconbtn rail-toggle ${css.iconbtn} ${css.brandToggle}`}
          title={collapsed ? t("rail.expand") : t("rail.collapse")}
          aria-label={collapsed ? t("rail.expand") : t("rail.collapse")}
          onClick={onToggleCollapse}>
          {collapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
        </button>
      </div>

      <div ref={newWrapRef} className={`newwrap ${css.newwrap}`}>
        <button type="button" className={`rail-new ${css.newBtn} ${collapsed ? css.newBtnCollapsed : ""}`}
          onClick={() => onNewSession(currentRoot)}
          title={t("rail.newSession")}
          data-tooltip={collapsed ? `${t("rail.newSession")} (Ctrl+N)` : undefined}>
          <Plus size={14} />
          <span className={css.newBtnText}>{t("rail.newSession")}</span>
          <span className={`kbd ${css.newBtnKbd}`}>Ctrl N</span>
        </button>
        <button type="button" className={`new-more ${css.newMore}`} onClick={() => setNewMenu(!newMenu)} title={t("rail.newWhere")}>
          <ChevronDown size={12} />
        </button>
        {newMenu && (
          <div className={`new-menu open ${css.newMenu}`}>
            <div className={`nm-h ${css.hd}`}>{t("rail.newWhere")}</div>
            {projects.map((p) => (
              <button type="button" key={p.id} className={`nm-i ${css.it} ${p.root === currentRoot ? "on" : ""}`}
                onClick={() => { setNewMenu(false); onNewSession(p.root); }}>
                <div>
                  <div className="t">{p.name}{p.root === currentRoot && <span className="cur">{t("rail.current")}</span>}</div>
                  <div className={`s ${css.sub}`}>{p.root === currentRoot ? t("rail.inheritDir") : p.root}</div>
                </div>
              </button>
            ))}
            <div className="nm-sep" />
            <button type="button" className={`nm-i ${css.it}`} onClick={() => { setNewMenu(false); onNewSession(null); }}>
              <div><div className="t">{t("rail.standalone")}</div><div className={`s ${css.sub}`}>{t("rail.noProject")}</div></div>
            </button>
            <button type="button" className={`nm-i ${css.it}`} onClick={() => { setNewMenu(false); onOpenFolder(); }}>
              <div><div className="t">{t("rail.openFolder")}</div><div className={`s ${css.sub}`}>{t("rail.onlyNew")}</div></div>
            </button>
          </div>
        )}
      </div>

      <div className={`rail-search ${css.search}`}>
        <Search size={12} aria-hidden="true" />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("rail.searchPlaceholder")} />
      </div>

      <nav className={`rail-fn ${css.fn}`}>
        {fn.map(({ id, label, icon: Icon, badge, dock }) => (
          <button type="button" key={id} className={`fn-item ${css.fnItem} ${view === id || (dock && state.dockTab === dock && state.rightbarOpen) ? "on" : ""}`}
            title={collapsed ? label : undefined}
            data-tooltip={collapsed ? label : undefined}
            onClick={() => {
              if (dock) onOpenDock?.(dock);
              else setView(id);
            }}>
            <span className={`ic ${css.ic}`}><Icon size={16} /></span>
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
                <div className={`proj-h ${css.row} ${p.root === currentRoot ? "cur" : ""}`}>
                  <button
                    type="button"
                    className={css.secToggle}
                    aria-expanded={open}
                    onClick={() => setClosedProject((prev) => ({ ...prev, [p.id]: !open }))}
                  >
                    <span className="chev">{open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}</span>
                    <span className="dot" />
                    <span className="nm" title={p.root}>{p.name}</span>
                  </button>
                  {p.root === currentRoot
                    ? <span className="tag">{t("rail.current")}</span>
                    : <span className="cnt">{sessions.length}</span>}
                  <button type="button" className={`pnew ${css.iconbtn}`} title={t("rail.newInProject")}
                    onClick={() => onNewSession(p.root)}><Plus size={12} /></button>
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
        <span className={`who ${css.who}`} title={state.currentProject || ""}>
          <span className="avatar" style={{ width: 22, height: 22 }}><FolderKanban size={12} /></span>
          <span className="nmx">{state.currentProject ? state.currentProject.split(/[\\/]/).filter(Boolean).pop() : t("rail.noProjects")}</span>
        </span>
        <div className={css.footActions}>
          <button type="button" className={`iconbtn rail-toggle ${css.iconbtn} ${collapsed ? "on" : ""}`}
            title={collapsed ? t("rail.expand") : t("rail.collapse")}
            aria-label={collapsed ? t("rail.expand") : t("rail.collapse")}
            data-tooltip={collapsed ? t("rail.expand") : undefined}
            onClick={onToggleCollapse}>
            {collapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
          </button>
          {onCycleTheme && (
            <button type="button" className={`iconbtn ${css.iconbtn}`}
              title={`${t ? t("status.cycleTheme") : "切换主题"}: ${state.theme}`}
              aria-label={t ? t("status.cycleTheme") : "切换主题"}
              data-tooltip={collapsed ? `${t ? t("status.cycleTheme") : "切换主题"} (${state.theme})` : undefined}
              onClick={onCycleTheme}>
              <Palette size={15} />
            </button>
          )}
          {onToggleLang && (
            <button type="button" className={`iconbtn ${css.iconbtn}`}
              title={t ? t("toggle.lang") : "切换语言"}
              aria-label={t ? t("toggle.lang") : "切换语言"}
              data-tooltip={collapsed ? (state.language === "zh" ? "English" : "中文") : undefined}
              onClick={onToggleLang}>
              <Languages size={15} />
            </button>
          )}
          <button type="button" className={`iconbtn ${css.iconbtn} ${state.settingsOpen ? "on" : ""}`}
            title={t("rail.settings")}
            aria-label={t("rail.settings")}
            data-tooltip={collapsed ? t("rail.settings") : undefined}
            onClick={() => setView("settings")}><Settings size={15} /></button>
        </div>
      </div>
    </aside>
  );
}
