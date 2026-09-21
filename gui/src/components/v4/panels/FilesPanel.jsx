import React, { useEffect, useMemo } from "react";
import { File, Folder, FolderOpen } from "lucide-react";
import { treeFromPaths } from "../../../state/file-tree.js";
import css from "../Dock.module.css";

function TreeRows({ nodes, expanded, depth, onToggle, onOpen, t }) {
  return nodes.map((n) => {
    const isDir = n.type === "directory";
    const open = Boolean(expanded[n.path]);
    return (
      <React.Fragment key={n.path}>
        <button
          type="button"
          className={`${css.row} ${!isDir && expanded.__file === n.path ? "on" : ""}`}
          style={{ paddingLeft: 8 + depth * 16 }}
          aria-expanded={isDir ? open : undefined}
          onClick={() => (isDir ? onToggle(n.path) : onOpen(n.path))}
          title={n.path}
        >
          {isDir
            ? (open ? <FolderOpen size={14} /> : <Folder size={14} />)
            : <File size={14} />}
          <span className={css.nm}>{n.name}</span>
        </button>
        {isDir && open && n.children?.length > 0 && (
          <TreeRows nodes={n.children} expanded={expanded} depth={depth + 1} onToggle={onToggle} onOpen={onOpen} t={t} />
        )}
      </React.Fragment>
    );
  });
}

export default function FilesPanel({ t, state, kernel, dispatch }) {
  const paths = Array.isArray(state.fileTree) ? state.fileTree : [];
  // listTree 可能返回 [{path}] 或 string[]
  const flat = useMemo(() => paths.map((p) => (typeof p === "string" ? p : p.path)).filter(Boolean), [paths]);
  const tree = useMemo(() => treeFromPaths(flat), [flat]);
  const expanded = state.dockFiles?.expanded || {};

  useEffect(() => {
    if (flat.length === 0 && kernel?.listTree) {
      kernel.listTree().catch(() => {});
    }
  }, [flat.length, kernel]);

  return (
    <div>
      {tree.length === 0 && <div className={css.empty}>{t("rail.noProjects")}</div>}
      <TreeRows
        nodes={tree}
        expanded={expanded}
        depth={0}
        onToggle={(path) => dispatch({ type: "tree_dir_toggled", path })}
        onOpen={(path) => kernel?.openFile?.(path)}
        t={t}
      />
    </div>
  );
}
