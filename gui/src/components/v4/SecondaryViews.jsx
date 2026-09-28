import React from "react";
import {
  Folders, FolderOpen, Trash, CaretLeft, GitDiff, ShareNetwork, PuzzlePiece,
  MagnifyingGlass, PencilSimpleLine, Lifebuoy, ArrowClockwise, Power, CaretDown, CaretRight
} from "@phosphor-icons/react";
import ChangeDiffView from "../ChangeDiffView.jsx";

function formatChangeTime(time) {
  if (!time) return "";
  const d = new Date(time);
  if (Number.isNaN(d.getTime())) return String(time);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// v1.4 次级视图(设计稿 v4 视图 4/5/6/7)。
// 概念预览(MCP / 插件)只保留设计稿的版式与说明,不虚构服务条目 —— 没有数据就给空态。

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

// 改动:左 = 逐条改动记录下的文件单(agent / 手动分组),右 = 选中文件的 before↔after diff。
export function ChangesView({ t, state, theme, onOpenChange, onDismissDiff, onReveal }) {
  const changes = state.changes || [];
  const openDiff = state.changeDiff && state.changeDiff.meta ? state.changeDiff : null;
  const openId = openDiff ? openDiff.meta.id : null;
  const openPath = openDiff && openDiff.file ? openDiff.file.path : null;

  const rows = changes.map((c) => ({
    change: { ...c, time: formatChangeTime(c.time) },
    files: (c.files || []).map((f) => (typeof f === "string" ? { path: f } : f))
  }));
  const totalFiles = rows.reduce((n, r) => n + r.files.length, 0);

  return (
    <section className="view on">
      <div className="changes">
        <aside className="c-list">
          <div className="cl-h">{t("changes.agentChanges")}</div>
          {rows.map(({ change, files }) => (
            <React.Fragment key={change.id}>
              <div className="rail-grp" title={change.prompt || ""}>
                {change.time || change.id}{change.rolledBack ? ` · ${t("changes.rolledBack")}` : ""}
              </div>
              {files.map((f) => (
                <button type="button" key={`${change.id}:${f.path}`}
                  className={`c-item ${openId === change.id && openPath === f.path ? "on" : ""}`}
                  onClick={() => onOpenChange(change.id, f.path)}>
                  <span className="c-src">{t("changes.srcAgent")}</span>
                  {f.path}
                  <span className="ps">
                    {f.added != null && <span className="a">+{f.added}</span>}
                    {f.removed != null && <span className="d">−{f.removed}</span>}
                  </span>
                </button>
              ))}
            </React.Fragment>
          ))}
          {totalFiles === 0 && (
            <div className="empty-note">
              <span className="en-ic"><GitDiff size={22} /></span>
              {t("changes.empty")}
            </div>
          )}
        </aside>

        <div className="c-view">
          {openDiff ? (
            <>
              <div className="cv-h">
                <button type="button" className="iconbtn" title={t("diff.close")} onClick={onDismissDiff}><CaretLeft size={15} /></button>
                <span className="fp">{openPath}</span>
                {openDiff.meta.rolledBack && <span className="mini warn">{t("changes.rolledBack")}</span>}
                <span className="mini">{openDiff.meta.id}</span>
              </div>
              <div className="cv-body">
                <ChangeDiffView t={t} theme={theme} changeDiff={openDiff} onClose={onDismissDiff} onReveal={onReveal} />
              </div>
            </>
          ) : (
            <div className="empty-note" style={{ marginTop: 60 }}>
              <span className="en-ic"><PencilSimpleLine size={24} /></span>
              {t("changes.pickFile")}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

// 概念预览:保留设计稿的头部 + 说明段 + 空态,不列虚构条目。
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

export function McpView({ t, kernel }) {
  const [servers, setServers] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [expanded, setExpanded] = React.useState(() => new Set());
  const [busyId, setBusyId] = React.useState(null);

  const refresh = React.useCallback(async () => {
    if (!kernel?.listMcpServers) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const list = await kernel.listMcpServers();
      setServers(Array.isArray(list) ? list : []);
    } catch {
      setServers([]);
    } finally {
      setLoading(false);
    }
  }, [kernel]);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  const toggleExpand = (id) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleRestart = async (id) => {
    if (!kernel?.restartMcpServer) return;
    setBusyId(id);
    try {
      await kernel.restartMcpServer(id);
    } finally {
      await refresh();
      setBusyId(null);
    }
  };

  const handleToggle = async (id, currentlyDisabled) => {
    if (!kernel?.toggleMcpServer) return;
    setBusyId(id);
    try {
      await kernel.toggleMcpServer(id, currentlyDisabled);
    } finally {
      await refresh();
      setBusyId(null);
    }
  };

  const connectedCount = servers.filter((s) => s.status === "CONNECTED").length;
  const totalTools = servers.reduce((acc, s) => acc + (s.toolCount || 0), 0);

  return (
    <section className="view on">
      <header className="pane-head">
        <span className="ttl">{t("rail.mcp")}</span>
        <span className="sub">{t("concept.mcpSub")}</span>
        <div className="spacer" />
        <button type="button" className="btn ghost" onClick={refresh} title={t("recovery.refresh")}>
          <ArrowClockwise size={13} className={loading ? "spin" : ""} /> {t("recovery.refresh")}
        </button>
      </header>

      <div className="s-body">
        <div className="s-in" style={{ maxWidth: 760 }}>
          {/* Stats Bar */}
          <div className="mcp-stats-bar" style={{
            display: "flex", gap: "16px", marginBottom: "16px",
            padding: "10px 14px", borderRadius: "8px",
            background: "var(--card-bg, rgba(255,255,255,0.03))",
            border: "1px solid var(--border-color, rgba(255,255,255,0.06))",
            fontSize: "var(--fs-12, 12px)", color: "var(--text-mut, #888)"
          }}>
            <div>已配置服务: <strong style={{ color: "var(--text-main, #eee)" }}>{servers.length}</strong></div>
            <div>已连接: <strong style={{ color: "var(--accent, #4ade80)" }}>{connectedCount}</strong></div>
            <div>可用工具: <strong style={{ color: "var(--text-main, #eee)" }}>{totalTools}</strong></div>
          </div>

          {servers.length === 0 ? (
            <div className="empty-note" style={{ textAlign: "center", padding: "32px 16px" }}>
              <span className="en-ic"><ShareNetwork size={32} /></span>
              <div style={{ marginTop: "12px", fontWeight: "600", fontSize: "14px" }}>
                {t("concept.mcpEmpty")}
              </div>
              <p style={{ maxWidth: "480px", margin: "8px auto 16px", color: "var(--text-mut)", fontSize: "12px", lineHeight: "1.6" }}>
                在项目根目录 <code>.deepseek-code/config.json</code> 中配置 <code>mcpServers</code> 字段，即可将外部数据库、文件系统或 API 工具安全挂载至 Agent。
              </p>
              <div style={{
                background: "var(--code-bg, rgba(0,0,0,0.3))",
                padding: "12px", borderRadius: "6px",
                textAlign: "left", fontSize: "11px", fontFamily: "var(--font-mono, monospace)",
                overflowX: "auto", border: "1px solid var(--border-color, rgba(255,255,255,0.06))"
              }}>
                <pre style={{ margin: 0 }}>{JSON.stringify({
                  mcpServers: {
                    filesystem: {
                      command: "npx",
                      args: ["-y", "@modelcontextprotocol/server-filesystem", "./src"],
                      autoApprove: ["read_file", "list_directory"]
                    }
                  }
                }, null, 2)}</pre>
              </div>
            </div>
          ) : (
            <div className="mcp-servers-list" style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              {servers.map((srv) => {
                const isExpanded = expanded.has(srv.serverId);
                const isBusy = busyId === srv.serverId;
                const statusColor = srv.status === "CONNECTED" ? "#22c55e" : srv.status === "ERROR" ? "#ef4444" : srv.status === "DISABLED" ? "#6b7280" : "#eab308";
                const statusLabel = srv.status === "CONNECTED" ? "已连接" : srv.status === "ERROR" ? "异常" : srv.status === "DISABLED" ? "已禁用" : "连接中";

                return (
                  <div key={srv.serverId} className="api-item" style={{ flexDirection: "column", alignItems: "stretch", padding: "12px" }}>
                    <div style={{ display: "flex", alignItems: "center", width: "100%" }}>
                      <span className="ai-ic" style={{ color: statusColor }}>
                        <ShareNetwork size={18} />
                      </span>
                      <div className="ai-info" style={{ minWidth: 0, marginLeft: "8px" }}>
                        <div className="an" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          <span>{srv.serverId}</span>
                          <span style={{
                            display: "inline-flex", alignItems: "center", gap: "4px",
                            padding: "2px 6px", borderRadius: "10px",
                            fontSize: "11px", background: `${statusColor}20`, color: statusColor, fontWeight: 500
                          }}>
                            <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: statusColor }} />
                            {statusLabel}
                          </span>
                          {srv.serverInfo?.version && (
                            <span style={{ fontSize: "11px", color: "var(--text-mut)" }}>v{srv.serverInfo.version}</span>
                          )}
                        </div>
                        <div className="ad" style={{ fontFamily: "var(--font-mono, monospace)", fontSize: "11px", marginTop: "2px" }}>
                          {srv.command} {(srv.args || []).join(" ")}
                        </div>
                      </div>

                      <div className="spacer" />

                      <div className="ai-actions" style={{ display: "flex", gap: "6px" }}>
                        <button
                          type="button"
                          className="btn ghost"
                          disabled={isBusy}
                          onClick={() => handleRestart(srv.serverId)}
                          title="重启服务"
                        >
                          <ArrowClockwise size={12} className={isBusy ? "spin" : ""} /> 重启
                        </button>
                        <button
                          type="button"
                          className={`btn ghost ${srv.disabled ? "" : "danger"}`}
                          disabled={isBusy}
                          onClick={() => handleToggle(srv.serverId, !srv.disabled)}
                          title={srv.disabled ? "启用服务" : "禁用服务"}
                        >
                          <Power size={12} /> {srv.disabled ? "启用" : "禁用"}
                        </button>
                        {srv.toolCount > 0 && (
                          <button
                            type="button"
                            className="btn ghost"
                            onClick={() => toggleExpand(srv.serverId)}
                            title={isExpanded ? "收起工具" : "展开工具"}
                          >
                            {isExpanded ? <CaretDown size={12} /> : <CaretRight size={12} />} {srv.toolCount} 工具
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Error details */}
                    {srv.error && (
                      <div style={{
                        marginTop: "10px", padding: "8px 10px", borderRadius: "4px",
                        background: "rgba(239, 68, 68, 0.1)", border: "1px solid rgba(239, 68, 68, 0.2)",
                        fontSize: "12px", color: "#f87171"
                      }}>
                        <strong>错误:</strong> {srv.error}
                        {srv.stderr && (
                          <pre style={{ marginTop: "4px", fontSize: "11px", whiteSpace: "pre-wrap", maxHeight: "80px", overflowY: "auto" }}>
                            {srv.stderr}
                          </pre>
                        )}
                      </div>
                    )}

                    {/* Tools drawer */}
                    {isExpanded && srv.tools && srv.tools.length > 0 && (
                      <div style={{
                        marginTop: "12px", paddingTop: "10px",
                        borderTop: "1px solid var(--border-color, rgba(255,255,255,0.06))",
                        display: "flex", flexDirection: "column", gap: "8px"
                      }}>
                        <div style={{ fontSize: "12px", fontWeight: "600", color: "var(--text-mut)" }}>
                          暴露给 Agent 的工具列表:
                        </div>
                        {srv.tools.map((tDef) => (
                          <div key={tDef.name} style={{
                            display: "flex", alignItems: "flex-start", justifyContent: "space-between",
                            padding: "6px 8px", borderRadius: "4px",
                            background: "var(--tool-item-bg, rgba(255,255,255,0.02))",
                            fontSize: "12px"
                          }}>
                            <div>
                              <div style={{ fontFamily: "var(--font-mono, monospace)", fontWeight: 500, color: "var(--text-main)" }}>
                                {tDef.originalName || tDef.name}
                                <span style={{
                                  marginLeft: "8px", fontSize: "10px", padding: "1px 5px", borderRadius: "4px",
                                  background: tDef.category === "read" ? "rgba(59, 130, 246, 0.15)" : "rgba(249, 115, 22, 0.15)",
                                  color: tDef.category === "read" ? "#60a5fa" : "#fb923c"
                                }}>
                                  {tDef.category}
                                </span>
                                {tDef.autoApprove && (
                                  <span style={{
                                    marginLeft: "4px", fontSize: "10px", padding: "1px 5px", borderRadius: "4px",
                                    background: "rgba(34, 197, 94, 0.15)", color: "#4ade80"
                                  }}>
                                    免审批
                                  </span>
                                )}
                              </div>
                              {tDef.description && (
                                <div style={{ color: "var(--text-mut)", fontSize: "11px", marginTop: "2px" }}>
                                  {tDef.description}
                                </div>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

export function PluginsView({ t }) {
  return <ConceptView t={t} title={t("rail.plugins")} subtitle={t("concept.pluginsSub")}
    icon={<PuzzlePiece size={26} />} note={t("concept.plugins")} emptyKey="concept.pluginsEmpty" />;
}

// D-G7 Recovery Center:列表 + report 摘要 + 动作。recovery 未启用时展示空态说明。
export function RecoveryView({ t, items = [], report = null, busy = null, onResume, onCancel, onClear, onRefresh, disabled = false }) {
  const buckets = [
    { key: "found", label: t("recovery.found") },
    { key: "done", label: t("recovery.done") },
    { key: "blocked", label: t("recovery.blocked") },
    { key: "next", label: t("recovery.next") }
  ];
  return (
    <section className="view on">
      <header className="pane-head">
        <span className="ttl">{t("recovery.title")}</span>
        <span className="sub">{t("recovery.subtitle")}</span>
        <div className="spacer" />
        <button type="button" className="btn ghost" onClick={onRefresh}><MagnifyingGlass size={13} /> {t("recovery.refresh")}</button>
      </header>
      <div className="s-body"><div className="s-in" style={{ maxWidth: 760 }}>
        {disabled && (
          <div className="empty-note">
            <span className="en-ic"><Lifebuoy size={24} /></span>
            {t("recovery.disabled")}
          </div>
        )}
        {!disabled && (
          <>
            {report && (
              <div className="f-group">
                <div className="fg-t">{t("recovery.report")}</div>
                {buckets.map((b) => (
                  <div key={b.key} className="api-item">
                    <div className="an">{b.label}</div>
                    <div className="ad">{(report[b.key] || []).length}</div>
                  </div>
                ))}
              </div>
            )}
            <div className="f-group">
              <div className="fg-t">{t("recovery.items")}</div>
              {items.length === 0 && (
                <div className="empty-note">
                  <span className="en-ic"><Lifebuoy size={24} /></span>
                  {t("recovery.empty")}
                </div>
              )}
              {items.map((item) => {
                const id = item.id || item.approval_id || item.key || "";
                return (
                  <div key={id || String(Math.random())} className="api-item">
                    <div className="ai-info" style={{ minWidth: 0 }}>
                      <div className="an">{id}</div>
                      <div className="ad">{item.kind || item.status || item.type || ""}{item.summary ? ` · ${item.summary}` : ""}</div>
                    </div>
                    <div className="spacer" />
                    <div className="ai-actions">
                      {onResume && (
                        <button type="button" className="btn ghost" disabled={busy === id}
                          onClick={() => onResume(id)}>{t("recovery.resume")}</button>
                      )}
                      {onCancel && (
                        <button type="button" className="btn ghost" disabled={busy === id}
                          onClick={() => onCancel(id)}>{t("recovery.cancel")}</button>
                      )}
                      {onClear && (
                        <button type="button" className="btn ghost" disabled={busy === id}
                          onClick={() => onClear(id)}>{t("recovery.clear")}</button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div></div>
    </section>
  );
}
