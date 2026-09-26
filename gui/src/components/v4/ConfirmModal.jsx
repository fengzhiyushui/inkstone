import React, { useEffect, useRef } from "react";
import { Trash, Warning, X } from "@phosphor-icons/react";

/**
 * ConfirmModal: 高端拟态确认弹窗
 * 彻底替换原生丑陋的 window.confirm，融入全局毛玻璃、双层边框与动态主题。
 */
export default function ConfirmModal({
  open,
  title,
  message,
  subMessage,
  confirmText,
  cancelText,
  danger = true,
  icon: CustomIcon,
  onConfirm,
  onCancel,
  t
}) {
  const cancelBtnRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    window.api?.setModalActive?.(true);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // 默认聚焦取消按钮以保障破坏性操作安全性
    const timer = setTimeout(() => {
      cancelBtnRef.current?.focus();
    }, 40);

    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel?.();
      }
    };
    window.addEventListener("keydown", onKey);

    return () => {
      clearTimeout(timer);
      window.api?.setModalActive?.(false);
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onCancel]);

  if (!open) return null;

  const IconComponent = CustomIcon || (danger ? Trash : Warning);

  return (
    <div
      className="cm-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cm-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel?.();
      }}
    >
      <div className="cm-card">
        <button
          type="button"
          className="cm-close"
          aria-label={t ? t("settings.close") : "关闭"}
          onClick={onCancel}
        >
          <X size={14} />
        </button>

        <div className="cm-head">
          <span className={`cm-ic ${danger ? "danger" : ""}`}>
            <IconComponent size={18} weight="bold" />
          </span>
          <span id="cm-title" className="cm-title">{title}</span>
        </div>

        <div className="cm-body">
          <p className="cm-msg">{message}</p>
          {subMessage && <p className="cm-sub">{subMessage}</p>}
        </div>

        <div className="cm-actions">
          <button
            ref={cancelBtnRef}
            type="button"
            className="cm-btn cm-cancel"
            onClick={onCancel}
          >
            {cancelText || (t ? t("confirm.cancel") : "取消")}
          </button>
          <button
            type="button"
            className={`cm-btn ${danger ? "cm-danger" : "cm-primary"}`}
            onClick={onConfirm}
          >
            {confirmText || (t ? t("confirm.confirm") : "确定")}
          </button>
        </div>
      </div>
    </div>
  );
}
