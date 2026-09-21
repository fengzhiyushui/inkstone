import React, { useRef } from "react";
import { Send, Paperclip, AtSign, Zap, Square } from "lucide-react";
import MetricsLine from "./MetricsLine.jsx";
import css from "./Composer.module.css";

export default function Composer({
  t, draft, setDraft, onSend, onInterrupt, busy,
  model, autonomy, placeholder, flat = false, statusLine
}) {
  const ref = useRef(null);
  const send = () => {
    const text = String(draft || "").trim();
    if (!text) return;
    onSend(text);
  };
  const onKey = (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
  };
  const insert = (token) => {
    setDraft(`${draft || ""}${draft && !draft.endsWith(" ") ? " " : ""}${token}`);
    if (ref.current) ref.current.focus();
  };

  return (
    <div className={`cz ${css.wrap}`} style={flat ? { padding: 0 } : undefined}>
      <div className={`cz-in ${css.card}`}>
        <textarea ref={ref} className={`cz-input ${css.input}`} rows={2} placeholder={placeholder || t("chat.placeholder")}
          autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} />
        <div className={`cz-row ${css.row}`}>
          <button type="button" className={`cz-tool ${css.tool}`} title={t("chat.attach")} onClick={() => insert("@")}>
            <Paperclip size={14} />
          </button>
          <button type="button" className={`cz-tool ${css.tool}`} title={t("chat.mention")} onClick={() => insert("@")}>
            <AtSign size={14} />
          </button>
          <span className={`cz-tool ${css.tool}`} title={t("chat.autonomy")}><Zap size={14} /> {autonomy || t("chat.gated")}</span>
          <div className={`spacer ${css.spacer}`} />
          <span className={`cz-mode ${css.mode}`}>{model || "—"}</span>
          {busy
            ? <button type="button" className={`cz-send ${css.send}`} title={t("chat.interrupt")} onClick={onInterrupt}><Square size={12} /></button>
            : <button type="button" className={`cz-send ${css.send}`} title={t("chat.send")} onClick={send}><Send size={14} /></button>}
        </div>
        {statusLine && (
          <div className={css.meta}>
            <MetricsLine {...statusLine} t={t} />
          </div>
        )}
      </div>
    </div>
  );
}
