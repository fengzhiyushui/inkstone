import React, { useEffect, useRef, useState } from "react";
import { checkedDiagnosticLogs, checkedDiagnosticTools, createToolTestController, schemaFields, toolParameters } from "../../state/mcp-diagnostics.js";

export function SchemaField({ field, value, onChange, disabled }) {
  const { name, definition, required } = field;
  const common = { className: "mcp-form-input mono", value: value ?? "", disabled, onChange: (event) => onChange(event.target.value), autoComplete: "off" };
  const choices = Array.isArray(definition.enum) ? definition.enum : definition.type === "boolean" ? [true, false] : null;
  return <label className="mcp-form-label">{name}{required ? " *" : ""}
    {choices ? <select {...common}><option value="">—</option>{choices.map((choice, index) =>
      <option key={index} value={JSON.stringify(choice)}>{typeof choice === "string" ? choice : JSON.stringify(choice)}</option>)}</select>
      : ["string", "number", "integer"].includes(definition.type) ? <input {...common}
        type={definition.type === "string" ? (/secret|password|token|key/i.test(name) ? "password" : "text") : "number"}
        step={definition.type === "integer" ? 1 : "any"} />
        : <textarea {...common} rows={3} placeholder="JSON" spellCheck={false} />}
    {typeof definition.description === "string" && <span className="mcp-input-desc">{definition.description}</span>}
  </label>;
}

export default function McpDiagnostics({ serverId, kernel, t }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState("logs");
  const [filters, setFilters] = useState({ level: "", category: "", method: "", search: "", limit: 100 });
  const [logs, setLogs] = useState(null);
  const [tools, setTools] = useState([]);
  const [selected, setSelected] = useState("");
  const [values, setValues] = useState({});
  const [raw, setRaw] = useState(false);
  const [json, setJson] = useState("{}");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [test, setTest] = useState({ status: "idle", busy: false });
  const requests = useRef(0);
  const controller = useRef(null);
  useEffect(() => {
    const current = createToolTestController({ kernel, serverId, onState: setTest });
    controller.current = current;
    return () => { requests.current++; current.dispose(); };
  }, [kernel, serverId]);
  const tool = tools.find((item) => item.name === selected);
  const fields = schemaFields(tool?.inputSchema);
  const approval = test.metadata?.approval ?? test.approval;
  const locked = test.busy || test.status === "approval_required";
  const load = async (nextTab = tab) => {
    const id = ++requests.current;
    setLoading(true); setError(""); setNotice("");
    try {
      if (nextTab === "logs") {
        const result = checkedDiagnosticLogs(await kernel.getMcpLogs(serverId, filters));
        if (id === requests.current) setLogs(result);
      } else {
        const result = checkedDiagnosticTools(await kernel.listMcpTools(serverId));
        if (id === requests.current) setTools(result);
      }
    } catch (err) { if (id === requests.current) setError(err.message); }
    finally { if (id === requests.current) setLoading(false); }
  };
  const run = (event) => {
    event.preventDefault(); setError("");
    try {
      const params = toolParameters(tool?.inputSchema, values, raw || !fields ? json : undefined);
      void controller.current.start(selected, params);
    } catch (err) { setError(`${t("mcp.diagnostics.invalidArguments")}: ${err.message}`); }
  };
  const exportLogs = async () => {
    const id = ++requests.current;
    setLoading(true); setError(""); setNotice("");
    try {
      const result = await kernel.exportMcpLogs(serverId, filters);
      if (id === requests.current && result.saved) setNotice(t("mcp.diagnostics.exported"));
    } catch (err) { if (id === requests.current) setError(err.message); }
    finally { if (id === requests.current) setLoading(false); }
  };
  return <details className="mcp-diagnostics" onToggle={(event) => {
    const expanded = event.currentTarget.open; setOpen(expanded);
    if (expanded && !logs && !loading) void load("logs");
  }}>
    <summary>{t("mcp.diagnostics.title")}</summary>
    {open && <>
      <div className="mcp-content-tabs" role="tablist" aria-label={t("mcp.diagnostics.title")}>
        {["logs", "test"].map((key) => <button type="button" role="tab" aria-selected={tab === key} key={key}
          className={`btn ${tab === key ? "accent" : "ghost"}`} disabled={loading} onClick={() => { setTab(key); void load(key); }}>{t(`mcp.diagnostics.${key}`)}</button>)}
      </div>
      {error && <div className="mcp-error-banner" role="alert">{error}</div>}
      {notice && <p role="status">{notice}</p>}
      {loading && <p role="status">{t("mcp.content.loading")}</p>}
      {tab === "logs" ? <div role="tabpanel" aria-label={t("mcp.diagnostics.logs")}>
        <form className="mcp-diagnostic-filters" onSubmit={(event) => { event.preventDefault(); void load(); }}>
          <label className="mcp-form-label">{t("mcp.diagnostics.level")}
            <select className="mcp-form-input" value={filters.level} onChange={(event) => setFilters({ ...filters, level: event.target.value })}>
              <option value="">{t("mcp.diagnostics.all")}</option>{["debug", "info", "warn", "error"].map((level) => <option key={level}>{level}</option>)}
            </select></label>
          {["category", "method", "search"].map((key) => <label className="mcp-form-label" key={key}>{t(`mcp.diagnostics.${key}`)}
            <input className="mcp-form-input" maxLength={200} value={filters[key]} onChange={(event) => setFilters({ ...filters, [key]: event.target.value })} /></label>)}
          <div className="mcp-diagnostic-actions"><button className="btn ghost" type="submit" disabled={loading}>{t("mcp.diagnostics.refresh")}</button>
            <button className="btn ghost" type="button" disabled={loading} onClick={exportLogs}>{t("mcp.diagnostics.export")}</button></div>
        </form>
        <p className="mcp-input-desc">{t("mcp.diagnostics.logHint")}</p>
        {logs && <>
          {logs.storageError && <p className="mcp-error-banner" role="alert">{String(logs.storageError)}</p>}
          {logs.entries.length === 0 && <p>{t("mcp.content.empty")}</p>}
          <ol className="mcp-diagnostic-log-list">{logs.entries.map((entry, index) => <li key={`${entry.id ?? index}:${index}`}>
            <div><time>{String(entry.timestamp ?? "")}</time> <strong>{String(entry.level ?? "")}</strong> {String(entry.category ?? entry.kind ?? "")}
              {entry.direction && <> · {t(`mcp.diagnostics.direction.${entry.direction}`)}</>}
              {entry.method && <> · <code>{String(entry.method)}</code></>}
              {entry.requestId != null && <> · <code>#{String(entry.requestId)}</code></>}
              {entry.durationMs != null && <> · {String(entry.durationMs)} ms</>}
              {entry.status && <> · {String(entry.status)}</>}
            </div>
            {entry.message && <p>{String(entry.message)}</p>}
            {entry.preview && <pre>{String(entry.preview)}</pre>}
          </li>)}</ol>
          {logs.truncated && <p role="status">{t("mcp.diagnostics.truncated")}</p>}
        </>}
      </div> : <div role="tabpanel" aria-label={t("mcp.diagnostics.test")}>
        <p className="mcp-input-desc">{t("mcp.diagnostics.testHint")}</p>
        {tools.length === 0 && !loading && <p>{t("mcp.diagnostics.noTools")}</p>}
        <label className="mcp-form-label">{t("mcp.diagnostics.tool")}
          <select className="mcp-form-input" value={selected} disabled={locked || loading} onChange={(event) => {
            setSelected(event.target.value); setValues({}); setJson("{}"); setRaw(false); setError(""); setTest({ status: "idle", busy: false });
          }}><option value="">—</option>{tools.map((item) => <option key={item.name} value={item.name}>{item.originalName || item.name}</option>)}</select>
        </label>
        {tool && <form className="mcp-diagnostic-tool-form" onSubmit={run}>
          <p className="mcp-input-desc">{tool.description}</p>
          {fields && <label><input type="checkbox" checked={raw} disabled={locked} onChange={(event) => setRaw(event.target.checked)} /> {t("mcp.diagnostics.rawJson")}</label>}
          {raw || !fields ? <label className="mcp-form-label">{t("mcp.diagnostics.arguments")}<textarea className="mcp-form-input mono" rows={6}
            spellCheck={false} value={json} disabled={locked} onChange={(event) => setJson(event.target.value)} /></label>
            : fields.map((field) => <SchemaField key={field.name} field={field} value={values[field.name]} disabled={locked}
              onChange={(value) => setValues({ ...values, [field.name]: value })} />)}
          <details><summary>{t("mcp.diagnostics.schema")}</summary><pre>{JSON.stringify(tool.inputSchema ?? {}, null, 2)}</pre></details>
          <div className="mcp-diagnostic-actions"><button className="btn accent" type="submit" disabled={locked || loading}>{t("mcp.diagnostics.run")}</button></div>
        </form>}
        {locked && <button className="btn ghost" type="button" onClick={() => void controller.current.cancel()}>{t("mcp.diagnostics.cancel")}</button>}
        {test.status === "approval_required" && <div className="mcp-diagnostic-approval" role="alert">
          <strong>{t("mcp.diagnostics.confirmTitle")}</strong><p>{t("mcp.diagnostics.confirmHint")}</p>
          {approval && <pre>{JSON.stringify(approval, null, 2)}</pre>}
          <button type="button" className="btn accent" onClick={() => void controller.current.approve()}>{t("mcp.diagnostics.approve")}</button>
        </div>}
        {test.status !== "idle" && <div className="mcp-content-preview" aria-live="polite">
          <strong>{t(`mcp.diagnostics.status.${test.status}`)}</strong>
          {Number.isFinite(test.metadata?.durationMs) && <span> · {test.metadata.durationMs} ms</span>}
          {test.content != null && <pre>{typeof test.content === "string" ? test.content : JSON.stringify(test.content, null, 2)}</pre>}
          {(test.error || test.cancelError) && <pre role="alert">{String(test.error || test.cancelError)}</pre>}
        </div>}
      </div>}
    </>}
  </details>;
}
