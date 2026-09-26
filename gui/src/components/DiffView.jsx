import React from "react";
import { DiffEditor } from "@monaco-editor/react";
import { X } from "@phosphor-icons/react";
import { isLightTheme } from "../state/themes.js";

// Side-by-side original ↔ modified view for a GUI edit (before/after save).
// v1.4.6 还原:关闭按钮改 lucide X(零字形),Monaco 主题按 10 主题的明暗分组映射。
// v1.8.0:明暗判定统一走 themes.js 的 isLightTheme,不再本地维护 LIGHT 集合。
export function monacoThemeFor(theme) {
  return isLightTheme(theme) ? "vs" : "vs-dark";
}

export default function DiffView({ theme, language, original, modified, onClose, t, title, actions }) {
  return (
    <div className="diffview" role="document" aria-label="diff">
      <div className="diffview-head">
        <span className="name" title={typeof title === "string" ? title : undefined}>
          {title || (t ? t("diff.title") : "Diff")}
        </span>
        {actions || null}
        <button type="button" className="ghost" onClick={onClose} aria-label={t ? t("diff.close") : "Close diff"}>
          <X size={13} />
        </button>
      </div>
      <div className="diffview-body">
        <DiffEditor
          height="100%"
          theme={monacoThemeFor(theme)}
          language={language}
          original={original ?? ""}
          modified={modified ?? ""}
          options={{
            readOnly: true,
            renderSideBySide: true,
            minimap: { enabled: false },
            fontFamily: '"Cascadia Code", "Consolas", monospace',
            fontSize: 13,
            scrollBeyondLastLine: false
          }}
        />
      </div>
    </div>
  );
}
