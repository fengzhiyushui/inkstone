import React from "react";
import { X, ArrowCounterClockwise } from "@phosphor-icons/react";
import DiffView from "./DiffView.jsx";
import { shortTime } from "../state/changes-derive.js";

// Read-only before↔after of one persisted change record, with hunk-level jump-to-editor.
export default function ChangeDiffView({ t, theme, changeDiff, onClose, onReveal }) {
  if (!changeDiff) return null;
  if (changeDiff.error) {
    return (
      <div className="changediff-error" role="alert">
        <span>{t("changes.error")}: {changeDiff.error}</span>
        <button type="button" className="ghost" onClick={onClose} aria-label={t("diff.close")}><X size={13} /></button>
      </div>
    );
  }
  const { meta, file } = changeDiff;
  const starts = file.status === "delete" ? [] : (file.hunkStarts || []);
  const actions = (
    <span className="chg-actions">
      {meta.rolledBack && <span title={t("changes.rolledBack")}><ArrowCounterClockwise size={12} /></span>}
      {starts.map((n) => (
        <button key={n} type="button" className="bc-btn" title={`${t("changes.jump")} @@ ${n}`}
          onClick={() => onReveal(file.path, n)}>@@ {n}</button>
      ))}
      {file.status !== "delete" && (
        <button type="button" className="bc-btn accent" onClick={() => onReveal(file.path, starts[0] || 1)}>
          {t("changes.jump")}
        </button>
      )}
    </span>
  );
  return (
    <DiffView t={t} theme={theme} language={file.language}
      original={file.before ?? ""} modified={file.after ?? ""}
      onClose={onClose}
      title={`${file.path} · ${shortTime(meta.time) || meta.time || ""} · ${meta.prompt || ""}`}
      actions={actions} />
  );
}
