import React, { useEffect, useRef, useState } from "react";
import { MCP_CONTENT_TABS, MCP_CONTENT_LIMITS, checkedMcpResult, groupMcpResources, mcpContentText, quoteMcpContent, promptArguments } from "../../state/mcp-content.js";

export default function McpContentBrowser({ serverId, kernel, t, onUseContent }) {
  const [tab, setTab] = useState(null);
  const [pages, setPages] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [uri, setUri] = useState("");
  const [prompt, setPrompt] = useState(null);
  const [args, setArgs] = useState({});
  const [preview, setPreview] = useState(null);
  const request = useRef(0);
  useEffect(() => () => { request.current += 1; }, []);

  const run = async (operation, accept) => {
    const id = ++request.current;
    setLoading(true);
    setError("");
    try {
      const result = checkedMcpResult(await operation());
      if (id === request.current) accept(result);
    } catch (err) {
      if (id === request.current) setError(err.message || String(err));
    } finally {
      if (id === request.current) setLoading(false);
    }
  };

  const load = (id, cursor) => {
    const definition = MCP_CONTENT_TABS.find((item) => item.id === id);
    setTab(id);
    setPreview(null);
    setPrompt(null);
    setUri("");
    run(() => {
      if (typeof kernel?.[definition.call] !== "function") throw new Error(t("mcp.content.unavailable"));
      return kernel[definition.call](serverId, { ...MCP_CONTENT_LIMITS, ...(cursor ? { cursor } : {}) });
    }, (result) => {
      setPages((previous) => ({ ...previous, [id]: {
        ...result,
        items: [...(cursor ? previous[id]?.items || [] : []), ...(result[definition.key] || [])]
      } }));
    });
  };

  const read = (value) => {
    setUri(value);
    setPreview(null);
    run(() => kernel.readMcpResource(serverId, value, MCP_CONTENT_LIMITS), (result) => setPreview({ result, source: value }));
  };
  const getPrompt = (event) => {
    event.preventDefault();
    setPreview(null);
    run(() => kernel.getMcpPrompt(serverId, prompt.name, promptArguments(prompt, args), MCP_CONTENT_LIMITS),
      (result) => setPreview({ result, source: prompt.name }));
  };

  const current = pages[tab];
  const text = preview ? mcpContentText(preview.result) : "";
  return (
    <div className="mcp-content-browser">
      <div className="mcp-content-tabs" role="tablist" aria-label={t("mcp.content.title")}>
        {MCP_CONTENT_TABS.map((item) => (
          <button type="button" role="tab" aria-selected={tab === item.id} className={`btn ${tab === item.id ? "accent" : "ghost"}`}
            key={item.id} onClick={() => load(item.id)} disabled={loading}>{t(`mcp.content.${item.id}`)}</button>
        ))}
      </div>
      {!tab && <div className="mcp-input-desc">{t("mcp.content.onDemand")}</div>}
      {loading && <div role="status">{t("mcp.content.loading")}</div>}
      {error && <div className="mcp-error-banner" role="alert">{error}</div>}
      {current?.supported === false && <div role="status">{t("mcp.content.unsupported")}</div>}
      {current && current.supported !== false && (
        <div role="tabpanel" aria-label={t(`mcp.content.${tab}`)}>
          {current.items.length === 0 && <div className="mcp-input-desc">{t("mcp.content.empty")}</div>}
          {tab === "resources" && (
            <ul className="mcp-resource-tree" aria-label={t("mcp.content.resources")}>
              {groupMcpResources(current.items).map((group) => (
                <li key={group.name}><details open><summary>{group.name}</summary><ul>
                  {group.items.map((item, index) => <li key={`${item.uri}:${index}`}>
                    <button type="button" className="btn ghost" disabled={loading} onClick={() => read(item.uri)}>{item.name || item.uri}</button>
                    <code>{item.uri}</code>{item.description && <p className="mcp-input-desc">{item.description}</p>}
                  </li>)}
                </ul></details></li>
              ))}
            </ul>
          )}
          {tab === "templates" && <>
            {current.items.map((item, index) => <div key={`${item.uriTemplate}:${index}`} className="mcp-form-group">
              <button type="button" className="btn ghost" disabled={loading} onClick={() => setUri(item.uriTemplate || "")}>{item.name || item.uriTemplate}</button>
              <code>{item.uriTemplate}</code>{item.description && <p className="mcp-input-desc">{item.description}</p>}
            </div>)}
            <form onSubmit={(event) => { event.preventDefault(); read(uri.trim()); }}>
              <label className="mcp-form-label">{t("mcp.content.uri")}
                <input className="mcp-form-input mono" value={uri} onChange={(event) => setUri(event.target.value)} required />
              </label>
              <p className="mcp-input-desc">{t("mcp.content.templateHint")}</p>
              <button type="submit" className="btn ghost" disabled={loading || !uri.trim() || /\{[^}]*\}/.test(uri)}>{t("mcp.content.read")}</button>
            </form>
          </>}
          {tab === "prompts" && <>
            {current.items.map((item, index) => <div key={`${item.name}:${index}`} className="mcp-form-group">
              <button type="button" className="btn ghost" disabled={loading} onClick={() => { setPrompt(item); setArgs({}); setPreview(null); setError(""); }}>{item.name}</button>
              {item.description && <p className="mcp-input-desc">{item.description}</p>}
            </div>)}
            {prompt && <form onSubmit={getPrompt}>
              <strong>{prompt.name}</strong>
              {(prompt.arguments || []).map((arg) => <label className="mcp-form-label" key={arg.name}>
                {arg.name}{arg.required ? " *" : ""}
                <input className="mcp-form-input" autoComplete="off" required={Boolean(arg.required)}
                  type={/secret|password|token|key/i.test(arg.name) ? "password" : "text"}
                  value={args[arg.name] ?? ""} onChange={(event) => setArgs({ ...args, [arg.name]: event.target.value })} />
                {arg.description && <span className="mcp-input-desc">{arg.description}</span>}
              </label>)}
              <button type="submit" className="btn ghost" disabled={loading}>{t("mcp.content.getPrompt")}</button>
            </form>}
          </>}
          {current.truncated && <p className="mcp-input-desc" role="status">{t("mcp.content.truncated")}</p>}
          {current.nextCursor && <button type="button" className="btn ghost" disabled={loading} onClick={() => load(tab, current.nextCursor)}>{t("mcp.content.more")}</button>}
        </div>
      )}
      {preview && <div className="mcp-content-preview">
        <strong>{preview.source}</strong>
        {preview.result.supported === false ? <p role="status">{t("mcp.content.unsupported")}</p> : <>
          <p className="mcp-input-desc">{t("mcp.content.reference")}</p>
          <pre>{text || t("mcp.content.noText")}</pre>
          {preview.result.truncated && <p role="status">{t("mcp.content.truncated")}</p>}
          <button type="button" className="btn accent" disabled={!text || !onUseContent} onClick={() => onUseContent(quoteMcpContent(text, `${serverId} / ${preview.source}`, t("mcp.content.quote")))}>{t("mcp.content.toChat")}</button>
        </>}
      </div>}
    </div>
  );
}
