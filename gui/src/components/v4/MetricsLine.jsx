import React from "react";
import {
  GitBranch, History, CircleCheck, CircleDashed, CircleAlert, CircleOff,
  Type, Hash, ChartColumn, Blocks, EyeOff, Timer, FileDiff, Cpu, Palette, Languages
} from "lucide-react";
import { metricSegments, dotCells } from "../../state/metrics-view.js";

// v1.4 对话框状态行(.cz-meta):
//   左段 = 状态标签(分支 / 检查点 / 连接),中段 = 比例指标(5 形态),右段 = 形态切换 + 模型/主题/语言。
// 形态与开关全部由「设置 › 状态显示」的 statusDisplay 偏好驱动;点形态按钮可临时轮换。
// 图标一律 lucide,不使用表情符号。

const FORMS = ["text", "num", "bar", "dots", "off"];
const FORM_ICON = { text: Type, num: Hash, bar: ChartColumn, dots: Blocks, off: EyeOff };
const CONN_ICON = { ready: CircleCheck, working: CircleDashed, error: CircleAlert, offline: CircleOff };
const TONE_CLASS = { accent: "", ok: "oklv", warn: "warnlv" };

export function nextForm(form) {
  const i = FORMS.indexOf(form);
  return FORMS[(i < 0 ? 0 : i + 1) % FORMS.length];
}

function Metrics({ t, form, segments, dotsCount }) {
  if (form === "off" || segments.length === 0) return null;
  const label = (key) => t(`metrics.${key}`);

  return (
    <span className="metrics" data-mv={form}>
      {form === "text" && (
        <span className="m-text">{segments.map((s) => `${label(s.key)} ${s.text}`).join(" · ")}</span>
      )}

      {form === "num" && (
        <span className="m-num">
          {segments.map((s) => (
            <span key={s.key} className="kv">
              <span className="k">{label(s.key)}</span>
              <span className="v">{s.num.v}</span>
              <span className="u">{s.num.u}</span>
            </span>
          ))}
        </span>
      )}

      {form === "bar" && (
        <span className="m-bar">
          {segments.map((s) => (
            <span key={s.key} className="mt">
              <span className="lb">{label(s.key)}</span>
              <span className="track">
                <span className={`fill ${TONE_CLASS[s.tone] || ""}`} style={{ width: `${Math.round(s.ratio * 100)}%` }} />
              </span>
              <span className="pc">{s.percent}</span>
            </span>
          ))}
        </span>
      )}

      {form === "dots" && (
        <span className="m-dots">
          {segments.map((s) => {
            const { total, filled } = dotCells(s.ratio, dotsCount);
            return (
              <span key={s.key} className="mt">
                <span className="lb">{label(s.key)}</span>
                <span className="cells">
                  {Array.from({ length: total }, (_, i) => (
                    <i key={i} className={i < filled ? `cell on ${TONE_CLASS[s.tone] || ""}` : "cell"} />
                  ))}
                </span>
                <span className="pc">{s.percent}</span>
              </span>
            );
          })}
        </span>
      )}
    </span>
  );
}

export default function MetricsLine({ t, display, usage, status = {}, actions = {}, inComposer = false }) {
  const d = display || {};
  const show = d.show || {};
  const form = FORMS.includes(d.form) ? d.form : "bar";
  const segments = metricSegments(usage, d, status.model);
  const idle = status.connection === "ready" && !status.busy;

  const ConnIcon = CONN_ICON[status.connection] || CircleCheck;
  const FormIcon = FORM_ICON[form] || ChartColumn;
  const connText = t(`status.conn.${status.connection || "ready"}`);

  const cls = ["cz-meta", d.fadeIdle && idle ? "fade" : "", d.compact ? "compact" : ""].filter(Boolean).join(" ");

  return (
    <div className={cls}>
      {show.branch !== false && !inComposer && status.branch && (
        <span className="sg"><GitBranch size={12} /> {status.branch}</span>
      )}
      {show.checkpoint !== false && (
        <span className="sg"><History size={12} /> {t("status.checkpoints").replace("{n}", status.checkpoints ?? 0)}</span>
      )}
      {show.connection !== false && (
        <span className={`sg ${status.connection === "ready" ? "okdot" : ""}`}><ConnIcon size={12} /> {connText}</span>
      )}

      <Metrics t={t} form={form} segments={segments} dotsCount={(d.format || {}).dotsCount} />

      {show.turnTime !== false && status.turnTime && (
        <span className="sg opt"><Timer size={12} /> {status.turnTime}</span>
      )}
      {show.turnChanges !== false && status.turnChanges > 0 && (
        <span className="sg opt"><FileDiff size={12} /> {t("status.turnChanges").replace("{n}", status.turnChanges)}</span>
      )}

      {!inComposer && (
        <>
          <span className="spacer" />

          <button type="button" className="mv-btn" title={t("status.cycleForm")}
            onClick={() => actions.onCycleForm && actions.onCycleForm(nextForm(form))}>
            <FormIcon size={11} /> {t(`settings.sd.form.${form}`)}
          </button>
          {show.model !== false && (status.model || status.modelLabel) && (
            <span className="sg opt"><Cpu size={12} /> {status.modelLabel || status.model}</span>
          )}
          {show.theme !== false && (
            <button type="button" className="sg click" title={t("status.cycleTheme")} onClick={actions.onCycleTheme}>
              <Palette size={12} /> {status.themeLabel || status.theme}
            </button>
          )}
          {show.language !== false && (
            <button type="button" className="sg click" title={t("toggle.lang")} onClick={actions.onToggleLang}>
              <Languages size={12} /> {status.language === "zh" ? "中文" : "English"}
            </button>
          )}
        </>
      )}
    </div>
  );
}
