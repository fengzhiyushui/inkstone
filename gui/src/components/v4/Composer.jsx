import React, { useEffect, useRef, useState } from "react";
import { Plus, Shield, ChevronDown, ArrowUp, Square, KeyRound, Cpu, Check, Settings } from "lucide-react";
import MetricsLine from "./MetricsLine.jsx";
import css from "./Composer.module.css";

const KNOWN_MODELS = [
  { id: "deepseek-chat", name: "DeepSeek-V3", desc: "通用模型 · 快速响应" },
  { id: "deepseek-reasoner", name: "DeepSeek-R1", desc: "深度思考 · 复杂推理" }
];

export default function Composer({
  t, draft, setDraft, onSend, onInterrupt, busy,
  model, autonomy, placeholder, flat = false, statusLine,
  branch = null, hasApiKey = false, onOpenSettings, onSelectModel
}) {
  const ref = useRef(null);
  const menuRef = useRef(null);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);

  useEffect(() => {
    if (!modelMenuOpen) return undefined;
    const onClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setModelMenuOpen(false);
      }
    };
    const onKey = (e) => {
      if (e.key === "Escape") setModelMenuOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
      document.removeEventListener("keydown", onKey);
    };
  }, [modelMenuOpen]);

  const send = () => {
    const text = String(draft || "").trim();
    if (!text) return;
    if (!hasApiKey) {
      onOpenSettings?.("api");
      return;
    }
    onSend(text);
  };
  const onKey = (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); return; }
    if (e.key === "Escape") {
      e.preventDefault();
      if (ref.current) ref.current.blur();
    }
  };

  const autonomyLabel = autonomy || (t ? t("composer.workspaceMod") : "工作区内修改");
  const currentModel = model || "deepseek-chat";
  const allModels = [...KNOWN_MODELS];
  if (currentModel && !allModels.some((m) => m.id === currentModel)) {
    allModels.unshift({ id: currentModel, name: currentModel, desc: t ? t("composer.configuredModel") : "当前配置的模型" });
  }

  return (
    <div className={`cz ${css.wrap}`} style={flat ? { padding: 0 } : undefined}>
      <div className={`cz-in ${css.card}`}>
        <textarea
          ref={ref}
          className={`cz-input ${css.input}`}
          rows={2}
          placeholder={placeholder || t("chat.placeholder")}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
        />
        <div className={`cz-row ${css.row}`}>
          <div className={css.leftGroup}>
            <button
              type="button"
              className={`cz-tool ${css.plusBtn}`}
              title={t("chat.attach")}
              aria-label={t("chat.attach")}
            >
              <Plus size={14} />
            </button>
            <button
              type="button"
              className={css.permissionChip}
              title={t("chat.autonomy")}
            >
              <Shield size={12} style={{ color: "var(--accent)" }} />
              <span>{autonomyLabel}</span>
              <ChevronDown size={11} style={{ opacity: 0.7 }} />
            </button>
          </div>

          <div className={`spacer ${css.spacer}`} />

          <div className={css.rightGroup}>
            {branch ? (
              <button
                type="button"
                className={css.snapshotPill}
                title={t ? t("dock.branch") || "分支" : "分支"}
              >
                <span>{branch === "br_main" ? "main" : branch}</span>
                <ChevronDown size={11} style={{ opacity: 0.7 }} />
              </button>
            ) : null}

            {!hasApiKey && (
              <button
                type="button"
                className={css.apiNoticePill}
                title={t ? t("composer.needsApiKeyTip") : "尚未配置 API 密钥，点击前往设置"}
                onClick={() => onOpenSettings?.("api")}
              >
                <KeyRound size={12} style={{ color: "var(--warn)" }} />
                <span>{t ? t("composer.configApi") : "配置 API"}</span>
              </button>
            )}

            <div className={css.modelMenuWrap} ref={menuRef}>
              <button
                type="button"
                className={`${css.modelPill} ${!hasApiKey ? css.modelPillNeedsKey : ""}`}
                title={!hasApiKey
                  ? `${t ? t("composer.currentModel") : "当前模型"}: ${currentModel}（${t ? t("composer.needsApiKey") : "尚未配置 API 密钥，点击切换模型"}）`
                  : `${t ? t("composer.currentModel") : "当前模型"}: ${currentModel}（${t ? t("composer.clickToSwitchModel") : "点击切换模型"}）`}
                onClick={() => setModelMenuOpen((prev) => !prev)}
                aria-expanded={modelMenuOpen}
              >
                {!hasApiKey ? (
                  <span className={css.warnDot} title={t ? t("composer.apiNotConfigured") : "API 尚未配置"} />
                ) : null}
                <Cpu size={12} style={{ color: "var(--accent)" }} />
                <span>{currentModel}</span>
                <ChevronDown size={11} style={{ opacity: 0.7 }} />
              </button>
              {modelMenuOpen && (
                <div className={css.modelMenu} role="menu">
                  {!hasApiKey && (
                    <div className={css.modelMenuNotice}>
                      <div className={css.noticeHead}>
                        <KeyRound size={13} style={{ color: "var(--warn)" }} />
                        <span>{t ? t("composer.noApiKey") : "未检测到 API 密钥"}</span>
                      </div>
                      <div className={css.noticeBody}>
                        {t ? t("composer.noApiKeyDesc") : "首次启动请先配置 API 密钥，即可向 DeepSeek 发送请求。"}
                      </div>
                      <button
                        type="button"
                        className={css.noticeBtn}
                        onClick={() => {
                          setModelMenuOpen(false);
                          onOpenSettings?.("api");
                        }}
                      >
                        {t ? t("composer.goToApiSettings") : "前往配置 API"}
                      </button>
                    </div>
                  )}
                  <div className={css.modelMenuHead}>{t ? t("composer.selectModel") : "选择模型"}</div>
                  {allModels.map((m) => {
                    const isActive = m.id === currentModel;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        className={`${css.modelMenuItem} ${isActive ? css.active : ""}`}
                        onClick={() => {
                          setModelMenuOpen(false);
                          onSelectModel?.(m.id);
                        }}
                      >
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span style={{ fontWeight: 500 }}>{m.name}</span>
                            <span style={{ fontSize: 10, opacity: 0.65, fontFamily: "var(--font-mono)" }}>{m.id}</span>
                          </div>
                          <span className={css.modelMenuItemDesc}>{m.desc}</span>
                        </div>
                        {isActive && <Check size={13} style={{ color: "var(--accent)" }} />}
                      </button>
                    );
                  })}
                  <div className={css.modelMenuDivider} />
                  <button
                    type="button"
                    className={css.modelMenuFooter}
                    onClick={() => {
                      setModelMenuOpen(false);
                      onOpenSettings?.("api");
                    }}
                  >
                    <Settings size={12} />
                    <span>配置更多 API 与模型...</span>
                  </button>
                </div>
              )}
            </div>

            {busy ? (
              <button
                type="button"
                className={`cz-send ${css.sendBtn}`}
                title={t("chat.interrupt")}
                onClick={onInterrupt}
              >
                <Square size={12} />
              </button>
            ) : (
              <button
                type="button"
                className={`cz-send ${css.sendBtn}`}
                title={t("chat.send")}
                onClick={send}
              >
                <ArrowUp size={15} />
              </button>
            )}
          </div>
        </div>

        {statusLine && (!statusLine.display?.position || statusLine.display.position === "composer" || statusLine.display.position === "both") && (
          <div className={css.meta}>
            <MetricsLine {...statusLine} t={t} inComposer />
          </div>
        )}
      </div>
    </div>
  );
}
