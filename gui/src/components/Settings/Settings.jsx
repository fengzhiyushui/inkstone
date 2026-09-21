import React, { useCallback, useEffect, useState } from "react";
import {
  SlidersHorizontal, Palette, Gauge, KeyRound, Cpu, ShieldCheck, Workflow, Layers, Sparkles, Info
} from "lucide-react";
import { SETTINGS_GROUPS, getByPath, applyFieldEdit, sanitizeConfigPatch } from "../../state/settings-schema.js";
import ModelAccess from "./ModelAccess.jsx";
import Appearance from "./Appearance.jsx";
import StatusDisplayPanel from "./StatusDisplayPanel.jsx";
import { Row, Switch } from "./Form.jsx";
import SettingsModal from "./SettingsModal.jsx";
import css from "./SettingsModal.module.css";

const ICONS = { SlidersHorizontal, Palette, Gauge, KeyRound, Cpu, ShieldCheck, Workflow, Layers, Sparkles, Info };

function Field({ t, field, value, onChange }) {
  const label = t(field.labelKey);
  const desc = t(`${field.labelKey}.desc`);
  const hint = desc === `${field.labelKey}.desc` ? "" : desc;

  if (field.type === "bool") {
    return <Row title={label} desc={hint}><Switch on={Boolean(value)} onChange={(v) => onChange(field, v)} label={label} /></Row>;
  }
  if (field.type === "enum") {
    return (
      <Row title={label} desc={hint}>
        <select className="f-in" value={value ?? field.options[0]} onChange={(e) => onChange(field, e.target.value)}>
          {field.options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      </Row>
    );
  }
  if (field.type === "text") {
    return (
      <Row title={label} desc={hint}>
        <input className="f-in" value={value ?? ""} onChange={(e) => onChange(field, e.target.value)} />
      </Row>
    );
  }
  return (
    <Row title={`${label}${field.unit ? ` (${field.unit})` : ""}`} desc={hint}>
      <input className="f-in short" type="number" value={value === null || value === undefined ? "" : value}
        placeholder={field.type === "nullableInt" ? t("settings.off") : ""}
        onChange={(e) => onChange(field, e.target.value)} />
    </Row>
  );
}

function ConfigGroup({ t, group, draft, setDraft, onSave, dirty, saving }) {
  const onChange = (field, raw) => setDraft((d) => applyFieldEdit(d, field, raw));
  return (
    <div className="f-group">
      <div className="fg-t">{t(group.labelKey)}</div>
      {group.fields.map((f) => (
        <Field key={f.path} t={t} field={f} value={getByPath(draft, f.path)} onChange={onChange} />
      ))}
      <div className="f-row">
        <div className="fl">{dirty && <div className="fd">{t("settings.unsaved")}</div>}</div>
        <button type="button" className="btn accent" disabled={!dirty || saving} onClick={onSave}>{t("settings.save")}</button>
      </div>
    </div>
  );
}

function General({ t, state, kernel, dispatch }) {
  const setLang = (language) => { dispatch({ type: "language_changed", language }); kernel.setPreferences({ language }); };
  return (
    <div className="f-group">
      <div className="fg-t">{t("settings.general.ui")}</div>
      <Row title={t("settings.language")} desc={t("settings.language.desc")}>
        <select className="f-in" value={state.language} onChange={(e) => setLang(e.target.value)}>
          <option value="zh">中文(简体)</option>
          <option value="en">English</option>
        </select>
      </Row>
      <Row title={t("settings.theme")} desc={t("settings.theme.desc")}>
        <span className="mini">{state.theme}</span>
      </Row>
    </div>
  );
}

function About({ t, settings, version }) {
  const cfg = settings?.config || {};
  return (
    <div className="f-group">
      <div className="fg-t">Inkstone</div>
      <Row title={t("settings.about.version")}><span className="mini">v{version}</span></Row>
      <Row title={t("settings.about.model")}><span className="mini">{cfg.model || "—"}</span></Row>
      <Row title={t("settings.about.baseUrl")}><span className="mini">{cfg.baseUrl || "—"}</span></Row>
      <Row title={t("settings.about.key")}><span className={`mini ${cfg.hasApiKey ? "ok" : "warn"}`}>{cfg.hasApiKey ? t("settings.about.keySet") : t("settings.about.keyMissing")}</span></Row>
      <Row title={t("settings.about.kernel")}><span className="mini">createKernel() · {t("settings.about.shared")}</span></Row>
    </div>
  );
}

export default function SettingsPanels({ t, state, kernel, dispatch, version, open, onClose }) {
  const [active, setActive] = useState("general");
  const [settings, setSettings] = useState(null);
  const [draft, setDraft] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    if (!kernel.available || !kernel.getSettings) { setError(t("settings.noBridge")); return; }
    try {
      const s = await kernel.getSettings();
      if (s && s.error) { setError(s.error); return; }
      setSettings(s || null);
      setDraft((s && s.config) || {});
      setError("");
    } catch (e) { setError(e.message); }
  }, [kernel, t]);

  useEffect(() => { if (open) reload(); }, [open, reload]);

  const group = SETTINGS_GROUPS.find((g) => g.id === active) || SETTINGS_GROUPS[0];
  const dirty = Boolean(settings) && JSON.stringify(draft) !== JSON.stringify(settings.config || {});

  const saveConfig = async () => {
    setSaving(true);
    try {
      const r = await kernel.setConfig(sanitizeConfigPatch(draft));
      if (r && r.error) setError(r.error);
      else await reload();
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  };

  return (
    <SettingsModal t={t} open={open} onClose={onClose} active={active}
      nav={SETTINGS_GROUPS.map((g) => {
        const Icon = ICONS[g.icon] || SlidersHorizontal;
        return (
          <button type="button" key={g.id} className={`item ${css.item} ${active === g.id ? "on" : ""}`}
            aria-current={active === g.id} onClick={() => setActive(g.id)}>
            <Icon size={14} /> {t(g.labelKey)}
          </button>
        );
      })}>
      <h2 className={css.title}>{t(group.labelKey)}</h2>
      <p className={css.sd}>{t(`${group.labelKey}.sd`)}</p>
      {error && <div className="f-group"><span className="mini err">{error}</span></div>}

      {group.kind === "prefs" && <General t={t} state={state} kernel={kernel} dispatch={dispatch} />}
      {group.kind === "appearance" && <Appearance t={t} state={state} kernel={kernel} dispatch={dispatch} />}
      {group.kind === "statusDisplay" && <StatusDisplayPanel t={t} state={state} kernel={kernel} dispatch={dispatch} />}
      {group.kind === "model" && (
        <ModelAccess t={t} kernel={kernel}
          profiles={settings?.apiProfiles || []} activeProfileId={settings?.activeProfileId || null}
          onChanged={reload} />
      )}
      {group.kind === "config" && (
        <ConfigGroup t={t} group={group} draft={draft} setDraft={setDraft} onSave={saveConfig} dirty={dirty} saving={saving} />
      )}
      {group.kind === "about" && <About t={t} settings={settings} version={version} />}
    </SettingsModal>
  );
}
