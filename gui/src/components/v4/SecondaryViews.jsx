import React from "react";
import {
  ShareNetwork, ArrowClockwise, Power, CaretDown, CaretRight,
  Plus, X, Key, Trash
} from "@phosphor-icons/react";
import McpContentBrowser from "./McpContentBrowser.jsx";
import McpOAuthControls from "./McpOAuthControls.jsx";
import McpDiagnostics from "./McpDiagnostics.jsx";
import { buildMcpOAuthConfig } from "../../state/mcp-oauth.js";
import { checkedMcpResult } from "../../state/mcp-content.js";

// v1.4 次级视图(设计稿 v4 视图 4/5/6/7)已按职责拆到同目录独立文件;
// 此处再导出,SecondaryViews.jsx 的 named export 面保持不变
// (App.jsx 的 import 形状与既有调用方零改动)。
export { ProjectsView } from "./ProjectsView.jsx";
export { ChangesView } from "./ChangesView.jsx";
export { RecoveryView } from "./RecoveryView.jsx";
export { PluginsView } from "./PluginsView.jsx";

// 概念预览:保留设计稿的头部 + 说明段 + 空态,不列虚构条目。
// (MCP 视图族的添加服务弹窗 + 服务中枢保留在本文件 —— dom-contract /
//  v1100 / mcp-gui 等冻结测试按源码文本断言这里的风险徽章、信任开关与
//  两条 checkedMcpResult 提交路径,拆走会破坏契约。)
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
  const [oauthEnabled, setOauthEnabled] = React.useState(false);
  const [oauthClientId, setOauthClientId] = React.useState("");
  const [oauthScopes, setOauthScopes] = React.useState("");
  const [allowPrivate, setAllowPrivate] = React.useState("");
  // v1.13.0:是否信任该 server 自报的 annotations
  const [trustServer, setTrustServer] = React.useState(false);
  const [elicitationEnabled, setElicitationEnabled] = React.useState(false);
  const [subscriptionsEnabled, setSubscriptionsEnabled] = React.useState(false);

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

      let oauthConfig;
      try { oauthConfig = buildMcpOAuthConfig(oauthEnabled, oauthClientId, oauthScopes, parsedHeaders); }
      catch { setError(t("mcp.oauth.headerConflict")); return; }

      setSubmitting(true);
      try {
        if (!onAdd) throw new Error("MCP 内核服务未就绪");
        const res = await onAdd(trimmedId, {
          url: trimmedUrl,
          type: remoteType,
          autoApprove: parsedAutoApprove,
          headers: parsedHeaders,
          ...oauthConfig,
          ...(elicitationEnabled ? { elicitation: { enabled: true } } : {}),
          ...(subscriptionsEnabled ? { subscriptions: { enabled: true } } : {}),
          ...(allowlist.length ? { allowlist } : {}),
          ...(trustServer ? { trust: true } : {})
        });
        if (res?.status !== "ERROR") checkedMcpResult(res);
        if (res && res.status === "ERROR" && !oauthEnabled) {
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
        env: parsedEnv,
        ...(elicitationEnabled ? { elicitation: { enabled: true } } : {}),
        ...(subscriptionsEnabled ? { subscriptions: { enabled: true } } : {}),
        ...(trustServer ? { trust: true } : {})
      });

      if (res?.status !== "ERROR") checkedMcpResult(res);
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
                <label className="mcp-trust-row">
                  <input type="checkbox" checked={oauthEnabled} onChange={(event) => setOauthEnabled(event.target.checked)} />
                  {t("mcp.oauth.enable")}
                </label>
                {oauthEnabled && <div className="mcp-oauth-setup">
                  <p className="mcp-input-desc">{t("mcp.oauth.setupHint")}</p>
                  <label className="mcp-form-label">{t("mcp.oauth.clientId")}
                    <input className="mcp-form-input mono" value={oauthClientId} autoComplete="off"
                      onChange={(event) => setOauthClientId(event.target.value)} />
                  </label>
                  <p className="mcp-input-desc">{t("mcp.oauth.clientHint")}</p>
                  <label className="mcp-form-label">{t("mcp.oauth.scopes")}
                    <input className="mcp-form-input mono" value={oauthScopes}
                      onChange={(event) => setOauthScopes(event.target.value)} />
                  </label>
                </div>}
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
              <label className="mcp-form-label">免审批工具白名单 (Auto-Approve，逗号分隔)</label>              <input
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

            <label className="mcp-trust-row"><input type="checkbox" checked={elicitationEnabled}
              onChange={(event) => setElicitationEnabled(event.target.checked)} /> {t("mcp.input.enable")}</label>
            <p className="mcp-input-desc">{t("mcp.input.enableHint")}</p>
            <label className="mcp-trust-row"><input type="checkbox" checked={subscriptionsEnabled}
              onChange={(event) => setSubscriptionsEnabled(event.target.checked)} /> {t("mcp.subscriptions.enable")}</label>
            <p className="mcp-input-desc">{t("mcp.subscriptions.enableHint")}</p>
            <div className="cm-actions" style={{ marginTop: "20px" }}>
              <button type="button" className="cm-btn cm-cancel" onClick={onClose} disabled={submitting}>
                取消
              </button>
              <button type="submit" className="cm-btn cm-primary" disabled={submitting}>
                {submitting ? "正在连接..." : "保存并启动"}
              </button>
            </div>
            {/* v1.13.0:信任开关 —— 决定是否采纳 server 自报的 annotations */}
            <label className="mcp-trust-row" title="受信后,server 自报的 annotations 才参与风险判定;未受信则一律忽略">
              <input
                type="checkbox"
                checked={trustServer}
                onChange={(e) => setTrustServer(e.target.checked)}
              />
              <span>信任此 server(采纳其 annotations)</span>
            </label>
            {trustServer && (
              <div className="mcp-input-desc" style={{ marginTop: "6px" }}>
                 请只信任你自己部署或审计过的 server;不受信 server 的 annotations 一律忽略,
                 以免写工具被伪装成“只读”。
              </div>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}

export function McpView({ t, kernel, onRequestConfirm, onUseContent }) {
  const [servers, setServers] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [expanded, setExpanded] = React.useState(() => new Set());
  const [busyId, setBusyId] = React.useState(null);
  const [showAddModal, setShowAddModal] = React.useState(false);
  const [contentEpoch, setContentEpoch] = React.useState(0);
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
      setContentEpoch((value) => value + 1);
    } catch {
      setServers([]);
    } finally {
      setLoading(false);
    }
  }, [kernel]);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  React.useEffect(() => kernel?.subscribeMcpAuthChanges?.(() => { void refresh(); }), [kernel, refresh]);
  React.useEffect(() => kernel?.subscribeMcpSubscriptionChanges?.(() => { void refresh(); }), [kernel, refresh]);

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
                const statusLabel = srv.status === "CONNECTED" ? "已连接" : srv.status === "ERROR" ? "异常" : srv.status === "DISABLED" ? "已禁用" : srv.status === "AUTH_REQUIRED" ? t("mcp.oauth.unauthenticated") : "连接中";

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

                    {srv.oauth?.enabled && <McpOAuthControls serverId={srv.serverId} initialStatus={srv.authStatus}
                      disabled={srv.disabled} kernel={kernel} t={t} onChanged={refresh} />}
                    {srv.elicitation?.enabled && <p className="mcp-input-desc">{t("mcp.input.enabled")}</p>}
                    {srv.subscriptions?.enabled && <p className="mcp-input-desc">{t("mcp.subscriptions.label")}: {t(`mcp.subscriptions.status.${
                      ["connecting", "active", "closed", "cancelled", "error"].includes(srv.subscriptionStatus?.status ?? srv.subscriptionStatus)
                        ? (srv.subscriptionStatus?.status ?? srv.subscriptionStatus) : "inactive"}`)}</p>}

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
                                {/* v1.13.0:风险徽章(内核给出 level/label;破坏性用 danger 色) */}
                                <span style={{
                                  marginLeft: "8px", fontSize: "10px", padding: "1px 5px", borderRadius: "4px",
                                  background: (tDef.badge?.level === "danger")
                                    ? "rgba(244, 63, 94, 0.16)"
                                    : (tDef.category === "read" ? "rgba(59, 130, 246, 0.15)" : "rgba(249, 115, 22, 0.15)"),
                                  color: (tDef.badge?.level === "danger")
                                    ? "#fb7185"
                                    : (tDef.category === "read" ? "#60a5fa" : "#fb923c")
                                }} title={`category: ${tDef.category}`}>
                                  {tDef.badge?.label || tDef.category}
                                </span>
                                {tDef.autoApprove && (
                                  <span style={{
                                    marginLeft: "4px", fontSize: "10px", padding: "1px 5px", borderRadius: "4px",
                                    background: "rgba(34, 197, 94, 0.15)", color: "#4ade80"
                                  }}>
                                    免审批
                                  </span>
                                )}
                                {tDef.approvalScope && tDef.approvalScope !== "session" && (
                                  <span style={{
                                    marginLeft: "4px", fontSize: "10px", padding: "1px 5px", borderRadius: "4px",
                                    background: "rgba(34, 197, 94, 0.15)", color: "#4ade80"
                                  }}>
                                    {tDef.approvalScope === "always" ? "永久放行" : "本项目放行"}
                                  </span>
                                )}
                              </div>
                              {tDef.description && (
                                <div style={{ color: "var(--text-mut)", fontSize: "11px", marginTop: "2px" }}>
                                  {tDef.description}
                                </div>
                              )}
                              {/* 让用户看清"这条风险判定是凭谁来的" */}
                              {tDef.riskSource === "keyword-untrusted" && (
                                <div style={{ color: "var(--text-faint)", fontSize: "10px", marginTop: "2px" }}>
                                  该 server 未受信,自报 annotations 已忽略
                                </div>
                              )}
                              {tDef.riskSource === "annotations" && (
                                <div style={{ color: "var(--text-faint)", fontSize: "10px", marginTop: "2px" }}>
                                  风险判定来自受信 server 的 annotations
                                </div>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    {!srv.disabled && <McpContentBrowser key={`${srv.serverId}:${contentEpoch}`}
                      serverId={srv.serverId} kernel={kernel} t={t} onUseContent={onUseContent} />}
                    <McpDiagnostics serverId={srv.serverId} kernel={kernel} t={t} />
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
