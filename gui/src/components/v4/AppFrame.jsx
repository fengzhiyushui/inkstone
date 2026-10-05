import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  computeColumns, clampWidth, clampRightbarWidth,
  SIDEBAR_MIN, SIDEBAR_MAX
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
    if (!el) return undefined;

    const measure = () => {
      // 壳层独占窗口宽度,因此以窗口宽度为准。RO 漏报 / 元素盒子未变时,
      // 这里仍能给出正确值(修复 headless 下程序化 resize 后布局不收敛)。
      const w = typeof window === "undefined" ? 0 : window.innerWidth;
      if (w > 0) setViewport((prev) => (Math.abs(prev - w) < 0.5 ? prev : w));
    };

    // 首帧立即量一次:ResizeObserver **只在尺寸变化时**触发,若挂载时窗口已被
    // 程序化 setSize 到目标宽度、而元素盒子恰好未变,viewport 会一直是初始值。
    measure();

    if (typeof ResizeObserver === "undefined") {
      // 无 ResizeObserver 的环境(老浏览器/部分 jsdom)退化为 window.resize 轮询
      window.addEventListener?.("resize", measure);
      return () => window.removeEventListener?.("resize", measure);
    }

    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width;
      if (w && w > 0) setViewport(w);
    });
    ro.observe(el);

    // 双保险:定时补量,覆盖 RO 在 headless / 高负载下漏报的场景
    const timer = setInterval(measure, 500);
    if (typeof timer.unref === "function") timer.unref();

    return () => {
      ro.disconnect();
      clearInterval(timer);
    };
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
    const w = clampRightbarWidth(viewport - clientX, viewport);
    dispatch?.({ type: "rightbar_resized", width: w });
    if (persist) kernel?.setPreferences?.({ rightbarWidth: w });
  }, [dispatch, kernel, viewport]);

  return (
    <div
      ref={rootRef}
      className={`${css.frame}${className ? ` ${className}` : ""}`}
      data-windows-titlebar=""
      data-dragging={dragging ? "true" : undefined}
      data-viewport={viewport}
      style={{ gridTemplateColumns: `${cols.sidebar}px ${cols.center}px ${cols.rightbar}px` }}
    >
      {titlebar ? <div className={css.chrome}>{titlebar}</div> : null}
      <div className={`${css.sidebar} rail`}>{sidebar}</div>
      <div className={`${css.center} pane`}>{main}</div>
      <div className={css.rightbar} data-rightbar-col="">{cols.rightbar >= 300 ? rightbar : null}</div>
      {!hideSidebar && !railCollapsed && cols.sidebar > 0 && (
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
