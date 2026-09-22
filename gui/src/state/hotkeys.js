import React from "react";

// 判定快捷键是否应让位给输入框 / 可编辑控件
export function isTypingTarget(target) {
  if (!target || typeof target !== "object") return false;
  const tag = String(target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (target.isContentEditable) return true;
  return false;
}

// 全局壳层快捷键:输入态与模态打开时一律放行
export function shouldHandleShellShortcut(event, { settingsOpen = false, modalOpen = false } = {}) {
  if (!event || !(event.ctrlKey || event.metaKey)) return false;
  if (event.altKey) return false;
  if (isTypingTarget(event.target)) return false;
  if (settingsOpen || modalOpen) return false;
  return true;
}
