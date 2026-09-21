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

  return (
    <div
      className={className}
      style={{ left: position }}
      role="separator"
      aria-orientation="vertical"
      aria-label={side === "rightbar" ? "rightbar resize" : "sidebar resize"}
      data-side={side}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
    />
  );
}
