import React, { useCallback, useRef } from "react";

// 8px 命中带;pointer capture;onDrag/onEnd 回调收到 clientX
export default function DragHandle({
  className = "",
  position = 0,
  disabled = false,
  onDrag,
  onEnd,
  side = "sidebar"
}) {
  const active = useRef(false);

  const onPointerDown = useCallback((e) => {
    if (disabled) return;
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    active.current = true;
  }, [disabled]);

  const onPointerMove = useCallback((e) => {
    if (!active.current || disabled) return;
    onDrag?.(e.clientX);
  }, [disabled, onDrag]);

  const finish = useCallback((e) => {
    if (!active.current) return;
    active.current = false;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    onEnd?.(e.clientX);
  }, [onEnd]);

  const onKeyDown = useCallback((e) => {
    if (disabled) return;
    const step = e.shiftKey ? 32 : 8;
    // 侧栏:← 变窄 → 变宽;右栏方向相反(以命中带 clientX 语义对齐)
    const delta = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
    if (!delta) return;
    e.preventDefault();
    const next = (typeof position === "number" ? position : 0) + (side === "rightbar" ? -delta : delta);
    onDrag?.(next);
    onEnd?.(next);
  }, [disabled, onDrag, onEnd, position, side]);

  return (
    <div
      className={className}
      style={{ left: position }}
      role="separator"
      aria-orientation="vertical"
      aria-label={side === "rightbar" ? "rightbar resize" : "sidebar resize"}
      aria-valuenow={typeof position === "number" ? Math.round(position) : undefined}
      tabIndex={0}
      data-side={side}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onKeyDown={onKeyDown}
    />
  );
}
