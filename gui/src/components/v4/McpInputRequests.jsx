import React, { useEffect, useRef, useState } from "react";
import { createMcpInputController } from "../../state/mcp-input-requests.js";
import { schemaFields, toolParameters } from "../../state/mcp-diagnostics.js";
import { SchemaField } from "./McpDiagnostics.jsx";

function InputForm({ request, count, busy, failed, onRespond, t }) {
  const [values, setValues] = useState({});
  const [json, setJson] = useState("{}");
  const [raw, setRaw] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const card = useRef(null);
  const cancel = useRef(null);
  const respond = useRef(onRespond);
  respond.current = onRespond;
  const fields = schemaFields(request.requestedSchema);

  useEffect(() => {
    const previous = document.activeElement;
    cancel.current?.focus();
    const onKey = (event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); void respond.current("cancel"); }
      if (event.key !== "Tab") return;
      const elements = [...(card.current?.querySelectorAll("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary") || [])];
      const first = elements[0];
      const last = elements.at(-1);
      if (event.shiftKey && (document.activeElement === first || !card.current?.contains(document.activeElement))) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !card.current?.contains(document.activeElement))) {
        event.preventDefault(); first?.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("keydown", onKey, true); if (previous?.isConnected) previous.focus?.(); };
  }, [request.requestId]);

  const submit = (event) => {
    event.preventDefault();
    if (!confirmed || busy) return;
    try {
      const content = toolParameters(request.requestedSchema, values, raw || !fields ? json : undefined);
      setInvalid(false);
      void onRespond("accept", content);
    } catch { setInvalid(true); }
  };

  return <div className="cm-backdrop mcp-input-backdrop" role="dialog" aria-modal="true" aria-labelledby="mcp-input-title"
    aria-describedby="mcp-input-confirm-hint">
    <div className="mcp-modal-card mcp-input-card" ref={card}>
      <h2 id="mcp-input-title" className="cm-title">{t("mcp.input.title")}</h2>
      <p className="mcp-input-origin"><strong>{t("mcp.input.server")}: <code>{request.serverId}</code></strong></p>
      <p className="mcp-input-desc" role="status">{t("mcp.input.pending")} · {count}</p>
      <p className="mcp-input-message">{request.message}</p>
      <p className="mcp-input-desc" id="mcp-input-confirm-hint">{t("mcp.input.confirmHint")}</p>
      {(failed || invalid) && <p className="mcp-error-banner" role="alert">{t(invalid ? "mcp.input.invalid" : "mcp.input.failed")}</p>}
      <form className="mcp-diagnostic-tool-form" onSubmit={submit} autoComplete="off">
        {fields && <label><input type="checkbox" checked={raw} disabled={busy} onChange={(event) => {
          setRaw(event.target.checked); setConfirmed(false);
        }} /> {t("mcp.diagnostics.rawJson")}</label>}
        {raw || !fields ? <label className="mcp-form-label">{t("mcp.input.values")}
          <textarea className="mcp-form-input mono" rows={7} spellCheck={false} value={json} disabled={busy}
            onChange={(event) => { setJson(event.target.value); setConfirmed(false); }} /></label>
          : fields.map((field) => <SchemaField key={field.name} field={field} value={values[field.name]} disabled={busy}
            onChange={(value) => { setValues({ ...values, [field.name]: value }); setConfirmed(false); }} />)}
        <details><summary>{t("mcp.diagnostics.schema")}</summary><pre>{JSON.stringify(request.requestedSchema, null, 2)}</pre></details>
        <label className="mcp-input-confirm"><input type="checkbox" checked={confirmed} disabled={busy}
          onChange={(event) => setConfirmed(event.target.checked)} /> {t("mcp.input.confirm")}</label>
        <div className="mcp-diagnostic-actions">
          <button type="button" className="btn ghost" ref={cancel} disabled={busy} onClick={() => void onRespond("cancel")}>{t("mcp.input.cancel")}</button>
          <button type="button" className="btn ghost" disabled={busy} onClick={() => void onRespond("decline")}>{t("mcp.input.decline")}</button>
          <button type="submit" className="btn accent" disabled={busy || !confirmed}>{t(busy ? "mcp.input.sending" : "mcp.input.submit")}</button>
        </div>
      </form>
    </div>
  </div>;
}

// App-level mounting keeps this reachable while either a chat tool call or a
// diagnostics trial is waiting, including when the MCP settings view is closed.
export default function McpInputRequests({ kernel, t, onOpenChange }) {
  const [state, setState] = useState({ requests: [], busyId: null, error: false });
  const controller = useRef(null);
  useEffect(() => {
    const current = createMcpInputController({ kernel, onState: setState });
    controller.current = current;
    void current.refresh();
    return () => current.dispose();
  }, [kernel]);
  const request = state.requests[0];
  const open = Boolean(request);
  useEffect(() => { onOpenChange?.(open); }, [open, onOpenChange]);
  useEffect(() => () => { onOpenChange?.(false); }, [onOpenChange]);
  if (!request) return state.error ? <div className="mcp-input-error" role="alert">{t("mcp.input.failed")}
    <button type="button" className="btn ghost" onClick={() => void controller.current.refresh()}>{t("mcp.diagnostics.refresh")}</button>
  </div> : null;
  return <InputForm key={request.requestId} request={request} count={state.requests.length} busy={Boolean(state.busyId)} failed={state.error}
    onRespond={(action, content) => controller.current.respond(request.requestId, action, content)} t={t} />;
}
