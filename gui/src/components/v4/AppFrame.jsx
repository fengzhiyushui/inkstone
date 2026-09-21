import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  computeColumns, clampWidth,
  SIDEBAR_MIN, SIDEBAR_MAX, RIGHTBAR_MIN
} from "../../state/columns.js";
import DragHandle from "./DragHandle.jsx";
import css from "./AppFrame.module.css";

export default function AppFrame({
  sidebar,
  main,
  rightbar,
  titlebar = null,
  className = "",
  railCollapsed = false,
  hideSidebar = false,
  sidebarWidth = 280,
  rightbarOpen = false,
  rightbarWidth = 0,
  dispatch,
  kernel
}) {
  const rootRef = useRef(null);
  const [viewport, setViewport] = useState(() => (typeof window === "undefined" ? 1280 : window.innerWidth));
  const [dragging, setDragging] = useState(null);

  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width;
      if (w && w > 0) setViewport(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const sidebarIn = (hideSidebar || railCollapsed) ? 0 : sidebarWidth;
  const rightbarIn = (hideSidebar || !rightbarOpen) ? 0 : rightbarWidth;
  const cols = computeColumns(viewport, sidebarIn, rightbarIn, hideSidebar ? 0 : undefined);

  const applySidebar = useCallback((clientX, persist) => {
    const w = clampWidth(clientX, SIDEBAR_MIN, SIDEBAR_MAX);
    dispatch?.({ type: "sidebar_resized", width: w });
    if (persist) kernel?.setPreferences?.({ sidebarWidth: w });
  }, [dispatch, kernel]);

  const applyRightbar = useCallback((clientX, persist) => {
    const w = Math.max(RIGHTBAR_MIN, Math.round(viewport - clientX));
    dispatch?.({ type: "rightbar_resized", width: w });
    if (persist) kernel?.setPreferences?.({ rightbarWidth: w });
  }, [dispatch, kernel, viewport]);

  return (
    <div
      ref={rootRef}
      className={`${css.frame}${className ? ` ${className}` : ""}`}
      data-windows-titlebar=""
      data-dragging={dragging ? "true" : undefined}
      style={{ gridTemplateColumns: `${cols.sidebar}px ${cols.center}px ${cols.rightbar}px` }}
    >
      {titlebar ? <div className={css.chrome}>{titlebar}</div> : null}
      <div className={`${css.sidebar} rail`}>{sidebar}</div>
      <div className={`${css.center} pane`}>{main}</div>
      <div className={css.rightbar} data-rightbar-col="">{rightbar}</div>
      {!hideSidebar && cols.sidebar > 0 && (
        <DragHandle
          className={css.handle}
          position={cols.sidebar}
          side="sidebar"
          onDrag={(px) => { setDragging("sidebar"); applySidebar(px, false); }}
          onEnd={(px) => { setDragging(null); applySidebar(px, true); }}
        />
      )}
      {!hideSidebar && cols.rightbar > 0 && (
        <DragHandle
          className={css.handle}
          position={viewport - cols.rightbar}
          side="rightbar"
          onDrag={(px) => { setDragging("rightbar"); applyRightbar(px, false); }}
          onEnd={(px) => { setDragging(null); applyRightbar(px, true); }}
        />
      )}
    </div>
  );
}
