import React, { useEffect } from "react";
import { ShieldWarning } from "@phosphor-icons/react";

// #9.3 敏感文件风险提醒 —— 红色全屏模态。
//
// 刻意**不复用**审批卡片:它不是权限审批,而是「这次改动会把该文件的完整原文
// 抄进变更记录」的副作用告知。措辞与配色都必须让用户一眼看出区别,否则会被
// 按审批的肌肉记忆一路点「批准」。
//
// 策略(一律问、不缓存、不按档位放行)在 src/apps/sensitive-notice-contract.js,
// 本组件只负责呈现与收集答复。
export default function SensitiveNoticeModal({ notice, t, onRespond }) {
  if (!notice || !notice.descriptor) return null;
  const descriptor = notice.descriptor;
  const paths = descriptor.paths || [];

  useEffect(() => {
    // 危险模态不响应 Escape,避免误关;仅锁背景滚动
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  return (
    <div className="sn-backdrop" role="dialog" aria-modal="true" aria-labelledby="sn-title">
      <div className="sn-card">
        <div className="sn-head">
          <ShieldWarning size={18} aria-hidden="true" />
          <span id="sn-title" className="sn-title">{t("sensitive.title")}</span>
        </div>

        <p className="sn-body">{t("sensitive.body")}</p>

        <ul className="sn-paths">
          {paths.map((item) => (
            <li key={item.path}>
              <code>{item.path}</code>
              <span className="sn-reason">{t(item.reasonKey || "sensitive.reason.other")}</span>
            </li>
          ))}
        </ul>

        <p className="sn-record"><code>{descriptor.recordDir}/</code></p>

        <div className="sn-actions">
          {/* 拒绝在前、且为默认焦点 —— 危险操作不该是顺手可点的那个 */}
          <button type="button" className="sn-btn sn-refuse" autoFocus onClick={() => onRespond(false)}>
            {t("sensitive.refuse")}
          </button>
          <button type="button" className="sn-btn sn-allow" onClick={() => onRespond(true)}>
            {t("sensitive.allow")}
          </button>
        </div>
      </div>
    </div>
  );
}
