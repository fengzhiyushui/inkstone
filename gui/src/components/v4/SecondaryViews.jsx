import React from "react";
import {
  Folders, FolderOpen, Trash, CaretLeft, GitDiff, ShareNetwork, PuzzlePiece,
  MagnifyingGlass, PencilSimpleLine, Lifebuoy, ArrowClockwise, Power, CaretDown, CaretRight,
  Plus, X, Check, Key
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

export function AddMcpModal({ open, onClose, onAdd, onAdded, t }) {
  const [serverId, setServerId] = React.useState("");
  const [command, setCommand] = React.useState("npx");
  const [args, setArgs] = React.useState("");
  const [autoApprove, setAutoApprove] = React.useState("");
  const [envJson, setEnvJson] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [activePreset, setActivePreset] = React.useState(null);
  // v1.12.0:远程 Streamable HTTP / legacy SSE 接入
  const [transport, setTransport] = React.useState("stdio");
  const [url, setUrl] = React.useState("");
  const [remoteType, setRemoteType] = React.useState("streamable-http");
  const [headersJson, setHeadersJson] = React.useState("");
  const [allowPrivate, setAllowPrivate] = React.useState("");

  const PRESETS = [
    {
      id: "filesystem",
      label: "本地文件系统",
      command: "npx",
      args: "-y @modelcontextprotocol/server-filesystem ./src",
      autoApprove: "read_file, list_directory",
      env: ""
    },
    {
      id: "fetch",
      label: "网页抓取",
      command: "npx",
      args: "-y @modelcontextprotocol/server-fetch",
      autoApprove: "fetch",
      env: ""
    },
    {
      id: "memory",
      label: "知识记忆图谱",
      command: "npx",
      args: "-y @modelcontextprotocol/server-memory",
      autoApprove: "create_graph, read_graph",
      env: ""
    },
    {
      id: "sqlite",
      label: "SQLite 数据库",
      command: "npx",
      args: "-y mcp-server-sqlite --db-path ./data.db",
      autoApprove: "read_query",
      env: ""
    },
    {
      id: "github",
      label: "GitHub 仓库",
      command: "npx",
      args: "-y @modelcontextprotocol/server-github",
      autoApprove: "",
      env: '{"GITHUB_PERSONAL_ACCESS_TOKEN": ""}'
    }
  ];

  const applyPreset = (preset) => {
    setActivePreset(preset.id);
    setServerId(preset.id);
    setCommand(preset.command);
    setArgs(preset.args);
    setAutoApprove(preset.autoApprove);
    setEnvJson(preset.env || "");
    setError(null);
  };

  React.useEffect(() => {
    if (open) {
      setError(null);
      setSubmitting(false);
    }
  }, [open]);

  if (!open) return null;

  const handleSubmit = async (e) => {
    e?.preventDefault();
    setError(null);

    const trimmedId = serverId.trim();
    if (!trimmedId || !/^[a-zA-Z0-9_-]+$/.test(trimmedId)) {
      setError("服务 ID 格式无效，只支持英文字母、数字、短横线与下划线。");
      return;
    }

    let parsedAutoApprove = [];
    if (autoApprove.trim()) {
      parsedAutoApprove = autoApprove.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
    }

    // ── v1.12.0:远程(HTTP)分支 ─────────────────────────────────────────────
    if (transport === "http") {
      const trimmedUrl = url.trim();
      if (!trimmedUrl) {
        setError("远程服务必须填写 URL。");
        return;
      }
      try {
        const parsedUrl = new URL(trimmedUrl);
        if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
          setError("URL 只支持 http:// 或 https://。");
          return;
        }
      } catch {
        setError("URL 格式无效。");
        return;
      }
      let parsedHeaders = {};
      if (headersJson.trim()) {
        try {
          parsedHeaders = JSON.parse(headersJson);
        } catch (err) {
          setError(`请求头必须为合法的 JSON 对象: ${err.message}`);
          return;
        }
        if (!parsedHeaders || typeof parsedHeaders !== "object" || Array.isArray(parsedHeaders)) {
          setError("请求头必须为 JSON 对象。");
          return;
        }
      }
      const allowlist = allowPrivate
        .split(/[,，\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);

      setSubmitting(true);
      try {
        if (!onAdd) throw new Error("MCP 内核服务未就绪");
        const res = await onAdd(trimmedId, {
          url: trimmedUrl,
          type: remoteType,
          autoApprove: parsedAutoApprove,
          headers: parsedHeaders,
          ...(allowlist.length ? { allowlist } : {})
        });
        if (res && res.status === "ERROR") {
          setError(`服务添加成功但连接异常: ${res.error || "未知原因"}`);
          setSubmitting(false);
        } else {
          await onAdded?.();
          onClose();
        }
      } catch (err) {
        setError(err.message || "添加失败");
        setSubmitting(false);
      }
      return;
    }

    const trimmedCommand = command.trim();
    if (!trimmedCommand) {
      setError("执行命令不能为空。");
      return;
    }

    let parsedArgs = [];
    if (args.trim()) {
      parsedArgs = args.trim().split(/\s+/).filter(Boolean);
    }

    let parsedEnv = {};
    if (envJson.trim()) {
      try {
        parsedEnv = JSON.parse(envJson);
      } catch (err) {
        setError(`环境变量必须为合法的 JSON 对象: ${err.message}`);
        return;
      }
    }

    setSubmitting(true);
    try {
      if (!onAdd) throw new Error("MCP 内核服务未就绪");
      const res = await onAdd(trimmedId, {
        command: trimmedCommand,
        args: parsedArgs,
        autoApprove: parsedAutoApprove,
        env: parsedEnv
      });

      if (res && res.status === "ERROR") {
        setError(`服务添加成功但连接异常: ${res.error || "未知原因"}`);
        setSubmitting(false);
      } else {
        await onAdded?.();
        onClose();
      }
    } catch (err) {
      setError(err.message || String(err));
      setSubmitting(false);
    }
  };

  return (
    <div className="cm-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="mcp-modal-card">
        <button type="button" className="cm-close" onClick={onClose}>
          <X size={14} />
        </button>

        <div className="cm-head">
          <span className="cm-ic">
            <ShareNetwork size={18} weight="bold" />
          </span>
          <span className="cm-title">添加 MCP 外部工具服务</span>
        </div>

        <div style={{ marginTop: "14px" }}>
          <div className="mcp-form-label">推荐预设模板</div>
          <div className="mcp-preset-pills">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`mcp-preset-pill ${activePreset === p.id ? "active" : ""}`}
                onClick={() => applyPreset(p)}
              >
                {p.label}
              </button>
            ))}
          </div>

          {error && <div className="mcp-error-banner">{error}</div>}

          <form onSubmit={handleSubmit}>
            <div className="mcp-form-group">
              <label className="mcp-form-label">接入方式 *</label>
              <div className="mcp-transport-pick" role="radiogroup" aria-label="接入方式">
                <button
                  type="button"
                  role="radio"
                  aria-checked={transport === "stdio"}
                  className={`mcp-tp ${transport === "stdio" ? "on" : ""}`}
                  onClick={() => { setTransport("stdio"); setError(null); }}
                >
                  本地进程 (stdio)
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={transport === "http"}
                  className={`mcp-tp ${transport === "http" ? "on" : ""}`}
                  onClick={() => { setTransport("http"); setError(null); }}
                >
                  远程 HTTP
                </button>
              </div>
            </div>

            <div className="mcp-form-group">
              <label className="mcp-form-label">服务标识 (Server ID) *</label>
              <input
                type="text"
                className="mcp-form-input mono"
                placeholder="例如: filesystem, sqlite, github"
                value={serverId}
                onChange={(e) => { setServerId(e.target.value); setActivePreset(null); }}
                required
              />
            </div>

            {transport === "http" && (
              <>
                <div className="mcp-form-group">
                  <label className="mcp-form-label">服务地址 (URL) *</label>
                  <input
                    type="text"
                    className="mcp-form-input mono"
                    placeholder="例如: https://mcp.example.com/mcp"
                    value={url}
                    onChange={(e) => { setUrl(e.target.value); setActivePreset(null); }}
                  />
                </div>
                <div className="mcp-form-group">
                  <label className="mcp-form-label">传输类型</label>
                  <select
                    className="mcp-form-input"
                    value={remoteType}
                    onChange={(e) => setRemoteType(e.target.value)}
                  >
                    <option value="streamable-http">streamable-http（推荐）</option>
                    <option value="sse">sse（legacy，已废弃）</option>
                  </select>
                </div>
                <div className="mcp-form-group">
                  <label className="mcp-form-label">请求头 (Headers，可选 JSON)</label>
                  <textarea
                    rows={2}
                    className="mcp-form-input mono"
                    placeholder='例如: {"Authorization": "Bearer ${input:tok}"}'
                    value={headersJson}
                    onChange={(e) => setHeadersJson(e.target.value)}
                  />
                </div>
                <div className="mcp-form-group">
                  <label className="mcp-form-label">私网放行 (可选，逗号分隔 IP/CIDR)</label>
                  <input
                    type="text"
                    className="mcp-form-input mono"
                    placeholder="例如: 127.0.0.1, 10.0.0.0/8"
                    value={allowPrivate}
                    onChange={(e) => setAllowPrivate(e.target.value)}
                  />
                  <div className="mcp-input-desc">
                    出于 SSRF 防护，内网与本机地址默认被拒绝；仅在此显式列出的目标才会放行。
                  </div>
                </div>
              </>
            )}

            {transport === "stdio" && (
              <>
                <div className="mcp-form-group">
                  <label className="mcp-form-label">执行命令 (Command) *</label>
                  <input
                    type="text"
                    className="mcp-form-input mono"
                    placeholder="例如: npx, node, python, uvx"
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                  />
                </div>
              </>
            )}

            <div className="mcp-form-group">
              <label className="mcp-form-label">参数列表 (Arguments，空格分隔)</label>
              <input
                type="text"
                className="mcp-form-input mono"
                placeholder="例如: -y @modelcontextprotocol/server-filesystem ./src"
                value={args}
                onChange={(e) => setArgs(e.target.value)}
              />
            </div>

            <div className="mcp-form-group">
              <label className="mcp-form-label">免审批工具白名单 (Auto-Approve，逗号分隔)</label>
              <input
                type="text"
                className="mcp-form-input mono"
                placeholder="例如: read_file, list_directory"
                value={autoApprove}
                onChange={(e) => setAutoApprove(e.target.value)}
              />
            </div>

            <div className="mcp-form-group">
              <label className="mcp-form-label">环境变量 (可选 JSON 格式)</label>
              <textarea
                rows={2}
                className="mcp-form-input mono"
                placeholder='例如: {"GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..."}'
                value={envJson}
                onChange={(e) => setEnvJson(e.target.value)}
              />
            </div>

            <div className="cm-actions" style={{ marginTop: "20px" }}>
              <button type="button" className="cm-btn cm-cancel" onClick={onClose} disabled={submitting}>
                取消
              </button>
              <button type="submit" className="cm-btn cm-primary" disabled={submitting}>
                {submitting ? "正在连接..." : "保存并启动"}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

export function McpView({ t, kernel, onRequestConfirm }) {
  const [servers, setServers] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [expanded, setExpanded] = React.useState(() => new Set());
  const [busyId, setBusyId] = React.useState(null);
  const [showAddModal, setShowAddModal] = React.useState(false);
  // v1.11.2:${input:*} 密钥引用 —— 定义来自 .mcp.json / config.json 的 inputs,
  // 值写入 ~/.deepseek-code/credentials(0600),绝不落项目树。
  const [inputs, setInputs] = React.useState([]);
  const [inputDraft, setInputDraft] = React.useState({});
  const [savingInput, setSavingInput] = React.useState(null);

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

  const refreshInputs = React.useCallback(async () => {
    if (!kernel?.listMcpInputs) {
      setInputs([]);
      return;
    }
    try {
      const list = await kernel.listMcpInputs();
      setInputs(Array.isArray(list) ? list : []);
    } catch {
      setInputs([]);
    }
  }, [kernel]);

  React.useEffect(() => {
    refreshInputs();
  }, [refreshInputs]);

  const handleSaveInput = async (name) => {
    if (!kernel?.setMcpInput) return;
    setSavingInput(name);
    try {
      await kernel.setMcpInput(name, inputDraft[name] ?? "");
      setInputDraft((prev) => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
      await refreshInputs();
    } finally {
      setSavingInput(null);
    }
  };

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

  const handleRemove = (id) => {
    if (!kernel?.removeMcpServer) return;
    if (onRequestConfirm) {
      onRequestConfirm({
        title: "删除 MCP 服务",
        message: `确定从当前项目中移除 MCP 服务 "${id}" 吗？`,
        subMessage: "该服务管理的外部工具将立即从 Agent 中卸载，并从 .deepseek-code/config.json 中移除。",
        confirmText: "移除",
        cancelText: "取消",
        danger: true,
        onConfirm: async () => {
          setBusyId(id);
          try {
            await kernel.removeMcpServer(id);
          } finally {
            await refresh();
            setBusyId(null);
          }
        }
      });
    } else {
      kernel.removeMcpServer(id).then(refresh);
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
        <button
          type="button"
          className="btn accent"
          onClick={() => setShowAddModal(true)}
          title="添加 MCP 服务"
          style={{ marginRight: "8px", display: "inline-flex", alignItems: "center", gap: "5px" }}
        >
          <Plus size={13} weight="bold" /> 添加服务
        </button>
        <button type="button" className="btn ghost" onClick={() => { refresh(); refreshInputs(); }} title={t("recovery.refresh")}>
          <ArrowClockwise size={13} className={loading ? "spin" : ""} /> {t("recovery.refresh")}
        </button>
      </header>

      <div className="s-body">
        <div className="s-in" style={{ maxWidth: 760 }}>
          {/* Stats Bar */}
          <div className="mcp-stats-bar">
            <div>已配置服务: <strong style={{ color: "var(--text-main, #eee)" }}>{servers.length}</strong></div>
            <div>已连接: <strong style={{ color: "var(--accent, #4ade80)" }}>{connectedCount}</strong></div>
            <div>可用工具: <strong style={{ color: "var(--text-main, #eee)" }}>{totalTools}</strong></div>
          </div>

          {/* v1.11.2 ${input:*} 密钥引用:项目配置只保留引用名,值存放于凭据库 */}
          {inputs.length > 0 && (
            <div className="mcp-inputs-panel">
              <div className="mcp-inputs-head">
                <Key size={13} weight="bold" />
                <span>{t("mcp.inputs.title")}</span>
                <span className="mcp-inputs-sub">{t("mcp.inputs.sub")}</span>
              </div>
              {inputs.map((inp) => {
                const dirty = Object.prototype.hasOwnProperty.call(inputDraft, inp.name);
                const missing = !inp.hasValue;
                return (
                  <div className="mcp-form-group" key={inp.name}>
                    <label className="mcp-form-label">
                      <span className="mono">{inp.name}</span>
                      <span className={`mcp-input-badge ${missing ? "missing" : "ok"}`}>
                        {missing ? t("mcp.inputs.missing") : t("mcp.inputs.set")}
                      </span>
                    </label>
                    {inp.description && <div className="mcp-input-desc">{inp.description}</div>}
                    <div className="mcp-input-row">
                      <input
                        type={inp.password ? "password" : "text"}
                        className="mcp-form-input mono"
                        autoComplete="off"
                        placeholder={missing ? t("mcp.inputs.placeholder") : "••••••••"}
                        value={inputDraft[inp.name] ?? ""}
                        onChange={(e) => setInputDraft((prev) => ({ ...prev, [inp.name]: e.target.value }))}
                      />
                      <button
                        type="button"
                        className="btn accent"
                        disabled={!dirty || savingInput === inp.name}
                        onClick={() => handleSaveInput(inp.name)}
                      >
                        {savingInput === inp.name ? t("mcp.inputs.saving") : t("mcp.inputs.save")}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {servers.length === 0 ? (
            <div className="empty-note" style={{ textAlign: "center", padding: "32px 16px" }}>
              <span className="en-ic"><ShareNetwork size={32} /></span>
              <div style={{ marginTop: "12px", fontWeight: "600", fontSize: "14px" }}>
                {t("concept.mcpEmpty")}
              </div>
              <p style={{ maxWidth: "480px", margin: "8px auto 16px", color: "var(--text-mut)", fontSize: "12px", lineHeight: "1.6" }}>
                点击右上角「添加服务」即可一键接入文件系统、网络抓取、数据库或 GitHub 等外部工具，赋予 Agent 强大的外部环境操作能力。
              </p>
              <button
                type="button"
                className="btn accent"
                onClick={() => setShowAddModal(true)}
                style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
              >
                <Plus size={14} weight="bold" /> 添加第一个 MCP 服务
              </button>
            </div>
          ) : (
            <div className="mcp-servers-list">
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
                          {srv.url
                            ? <>{srv.url} <span style={{ color: "var(--text-faint)" }}>[{srv.type || "streamable-http"}]</span></>
                            : <>{srv.command} {(srv.args || []).join(" ")}</>}
                        </div>
                        {srv.deprecatedTransport && (
                          <div style={{ fontSize: "10px", color: "#eab308", marginTop: "2px" }}>
                            legacy SSE 传输已废弃，建议改用 streamable-http
                          </div>
                        )}
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
                        <button
                          type="button"
                          className="btn ghost danger"
                          disabled={isBusy}
                          onClick={() => handleRemove(srv.serverId)}
                          title="删除服务"
                        >
                          <Trash size={12} />
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

      <AddMcpModal
        open={showAddModal}
        onClose={() => setShowAddModal(false)}
        onAdd={kernel?.addMcpServer}
        onAdded={refresh}
        t={t}
      />
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
