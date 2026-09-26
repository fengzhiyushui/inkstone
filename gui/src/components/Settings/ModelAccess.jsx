import React, { useState } from "react";
import { Key, Play, PencilSimpleLine, Trash, ArrowCounterClockwise, Plus } from "@phosphor-icons/react";
import { Row } from "./Form.jsx";

const BLANK = { name: "", baseUrl: "https://api.deepseek.com", apiKey: "" };

// Model-access settings: manage a list of API endpoints (add/edit/delete/activate),
// fetch the model list from the active/selected endpoint (no default — error on failure),
// and test the connection. API keys are entered as passwords and never rendered back
// in plaintext (the bridge returns only a mask).
export default function ModelAccess({ t, kernel, profiles, activeProfileId, onChanged }) {
  const [form, setForm] = useState(null);       // null = not adding/editing
  const [models, setModels] = useState({});     // profileId → string[] | { error }
  const [busy, setBusy] = useState("");         // action-in-flight label
  const [test, setTest] = useState({});         // profileId → { ok, message }

  const startAdd = () => setForm({ ...BLANK });
  const startEdit = (p) => setForm({ id: p.id, name: p.name, baseUrl: p.baseUrl, apiKey: "" }); // key blank = keep

  const saveForm = async () => {
    if (!form.name.trim() || !form.baseUrl.trim()) return;
    setBusy("save");
    const payload = { name: form.name.trim(), baseUrl: form.baseUrl.trim() };
    if (form.id) payload.id = form.id;
    if (form.apiKey) payload.apiKey = form.apiKey;               // omit → preserve existing key
    try { await kernel.saveApiProfile(payload); setForm(null); await onChanged(); }
    finally { setBusy(""); }
  };

  const del = async (id) => { setBusy("del:" + id); try { await kernel.deleteApiProfile(id); await onChanged(); } finally { setBusy(""); } };
  const activate = async (id) => { setBusy("act:" + id); try { await kernel.activateApiProfile(id); await onChanged(); } finally { setBusy(""); } };

  const fetchModels = async (id) => {
    setBusy("models:" + id);
    try {
      const list = await kernel.listModels(id);
      if (list && list.error) setModels((m) => ({ ...m, [id]: { error: list.error } }));
      else if (Array.isArray(list)) setModels((m) => ({ ...m, [id]: list }));
      else setModels((m) => ({ ...m, [id]: { error: t("settings.model.fetchFailed") } }));
    } catch (e) {
      setModels((m) => ({ ...m, [id]: { error: e.message || t("settings.model.fetchFailed") } }));
    } finally { setBusy(""); }
  };

  const chooseModel = async (p, model) => {
    if (!model) return;
    setBusy("pick:" + p.id);
    try { await kernel.saveApiProfile({ id: p.id, name: p.name, baseUrl: p.baseUrl, model }); await onChanged(); }
    finally { setBusy(""); }
  };

  const testConn = async (id) => {
    setBusy("test:" + id);
    try {
      const r = await kernel.testConnection(id);
      const ok = r && !r.error && (r.ok !== false);
      setTest((s) => ({ ...s, [id]: { ok, message: (r && (r.error || r.message)) || (ok ? t("settings.model.testOk") : t("settings.model.testFail")) } }));
    } catch (e) {
      setTest((s) => ({ ...s, [id]: { ok: false, message: e.message } }));
    } finally { setBusy(""); }
  };

  return (
    <>
      <div className="f-group">
        <div className="fg-t">{t("settings.model.apis")}</div>

        {(!profiles || profiles.length === 0) && !form && (
          <div className="empty-note">
            <span className="en-ic"><Key size={22} /></span>
            {t("settings.model.empty")}
          </div>
        )}

        {(profiles || []).map((p) => {
          const active = p.id === activeProfileId;
          const mlist = models[p.id];
          const tr = test[p.id];
          return (
            <div key={p.id} className={`api-item ${active ? "cur" : ""}`} style={{ flexWrap: "wrap" }}>
              <span className="ai-ic"><Key size={16} /></span>
              <div style={{ minWidth: 0 }}>
                <div className="an">
                  {p.name}
                  {active && <span className="badge">{t("settings.model.active")}</span>}
                  {p.model && <span className="mini">{p.model}</span>}
                </div>
                <div className="ad">{p.baseUrl} · {p.keyMask || (p.hasKey ? "••••" : t("settings.model.noKey"))}</div>
              </div>
              <div className="spacer" />
              {!active && (
                <button type="button" className="btn ghost" disabled={busy === "act:" + p.id} onClick={() => activate(p.id)}>
                  <Play size={12} /> {t("settings.model.activate")}
                </button>
              )}
              <button type="button" className="btn ghost" onClick={() => startEdit(p)}><PencilSimpleLine size={12} /> {t("settings.edit")}</button>
              <button type="button" className="btn ghost" disabled={busy === "del:" + p.id} onClick={() => del(p.id)}>
                <Trash size={12} />
              </button>

              <div style={{ flexBasis: "100%", display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
                <button type="button" className="btn ghost" disabled={busy === "models:" + p.id} onClick={() => fetchModels(p.id)}>
                  <ArrowCounterClockwise size={12} /> {t("settings.model.fetch")}
                </button>
                {Array.isArray(mlist) && (
                  <select className="f-in mid" defaultValue={p.model || ""} onChange={(e) => chooseModel(p, e.target.value)}
                    aria-label={t("settings.model.select")}>
                    <option value="" disabled>{t("settings.model.select")}</option>
                    {mlist.map((id) => <option key={id} value={id}>{id}</option>)}
                  </select>
                )}
                {mlist && mlist.error && <span className="mini err">{t("settings.model.fetchFailed")}: {mlist.error}</span>}
                <button type="button" className="btn ghost" disabled={busy === "test:" + p.id} onClick={() => testConn(p.id)}>
                  {t("settings.model.test")}
                </button>
                {tr && <span className={`mini ${tr.ok ? "ok" : "err"}`}>{tr.message}</span>}
              </div>
            </div>
          );
        })}

        <button type="button" className="btn ghost" onClick={startAdd}><Plus size={12} /> {t("settings.model.add")}</button>
      </div>

      {form && (
        <div className="f-group">
          <div className="fg-t">{form.id ? t("settings.model.editApi") : t("settings.model.newApi")}</div>
          <Row title={t("settings.model.name")}>
            <input className="f-in" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="deepseek" />
          </Row>
          <Row title={t("settings.model.baseUrl")}>
            <input className="f-in" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://api.deepseek.com" />
          </Row>
          <Row title={t("settings.model.apiKey")} desc={t("settings.model.keyLocal")}>
            <input className="f-in" type="password" value={form.apiKey} autoComplete="off"
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
              placeholder={form.id ? t("settings.model.keyKeep") : "sk-…"} />
          </Row>
          <div className="f-row">
            <div className="fl" />
            <button type="button" className="btn accent" disabled={busy === "save"} onClick={saveForm}>{t("settings.save")}</button>
            <button type="button" className="btn ghost" onClick={() => setForm(null)}>{t("settings.cancel")}</button>
          </div>
        </div>
      )}
    </>
  );
}
