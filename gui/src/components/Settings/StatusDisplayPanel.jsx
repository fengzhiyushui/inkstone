import React from "react";
import { Type, Hash, ChartColumn, Blocks, EyeOff } from "lucide-react";
import { STATUS_FORMS, STATUS_POSITIONS, STATUS_TOGGLES } from "../../state/status-display.js";
import { Row, Switch } from "./Form.jsx";

// 设置 › 状态显示(设计稿 §状态显示,4 组 22 项):形态 / 位置 / 显示哪些 / 数值与格式。
// 改动即时写入偏好,与对话框底部状态行(MetricsLine)同一份 statusDisplay。
const FORM_ICON = { text: Type, num: Hash, bar: ChartColumn, dots: Blocks, off: EyeOff };
const PERCENT_DECIMALS = [0, 1, 2];
const DOTS_COUNTS = [5, 10, 20];
const WARN_RATIOS = [0.7, 0.8, 0.9, 1];

export default function StatusDisplayPanel({ t, state, kernel, dispatch }) {
  const d = state.statusDisplay || { show: {}, format: {} };
  const apply = (patch) => {
    const next = {
      ...d,
      ...patch,
      show: { ...(d.show || {}), ...(patch.show || {}) },
      format: { ...(d.format || {}), ...(patch.format || {}) }
    };
    dispatch({ type: "status_display_changed", display: next });
    kernel.setPreferences({ statusDisplay: next });
  };

  return (
    <>
      <div className="f-group">
        <div className="fg-t">{t("settings.sd.form")}</div>
        <div className="mv-grid">
          {STATUS_FORMS.map((f) => {
            const Icon = FORM_ICON[f];
            return (
              <button type="button" key={f} className={`mv-card ${d.form === f ? "on" : ""}`}
                aria-pressed={d.form === f} onClick={() => apply({ form: f })}>
                <span className="demo"><Icon size={16} /></span>
                <span className="nm">{t(`settings.sd.form.${f}`)}</span>
              </button>
            );
          })}
        </div>
        <div className="f-row" style={{ paddingTop: 10 }}>
          <div className="fl"><div className="fd">{t("settings.sd.formNote")}</div></div>
        </div>
      </div>

      <div className="f-group">
        <div className="fg-t">{t("settings.sd.position")}</div>
        <Row title={t("settings.sd.positionLabel")} desc={t("settings.sd.positionDesc")}>
          <select className="f-in" value={d.position} onChange={(e) => apply({ position: e.target.value })}>
            {STATUS_POSITIONS.map((p) => <option key={p} value={p}>{t(`settings.sd.pos.${p}`)}</option>)}
          </select>
        </Row>
        <Row title={t("settings.sd.fadeIdle")} desc={t("settings.sd.fadeIdleDesc")}>
          <Switch on={d.fadeIdle} onChange={(v) => apply({ fadeIdle: v })} label={t("settings.sd.fadeIdle")} />
        </Row>
        <Row title={t("settings.sd.compact")} desc={t("settings.sd.compactDesc")}>
          <Switch on={d.compact} onChange={(v) => apply({ compact: v })} label={t("settings.sd.compact")} />
        </Row>
      </div>

      <div className="f-group">
        <div className="fg-t">{t("settings.sd.show")}</div>
        {STATUS_TOGGLES.map((key) => (
          <Row key={key} title={t(`settings.sd.${key}`)} desc={t(`settings.sd.${key}.desc`)}>
            <Switch on={d.show[key]} onChange={(v) => apply({ show: { [key]: v } })} label={t(`settings.sd.${key}`)} />
          </Row>
        ))}
      </div>

      <div className="f-group">
        <div className="fg-t">{t("settings.sd.format")}</div>
        <Row title={t("settings.sd.percentDecimals")} desc={t("settings.sd.percentDecimalsDesc")}>
          <select className="f-in mid" value={d.format.percentDecimals ?? 0}
            onChange={(e) => apply({ format: { percentDecimals: Number(e.target.value) } })}>
            {PERCENT_DECIMALS.map((n) => <option key={n} value={n}>{t("settings.sd.decimals").replace("{n}", n)}</option>)}
          </select>
        </Row>
        <Row title={t("settings.sd.bigUnits")} desc={t("settings.sd.bigUnitsDesc")}>
          <Switch on={d.format.bigUnits} onChange={(v) => apply({ format: { bigUnits: v } })} label={t("settings.sd.bigUnits")} />
        </Row>
        <Row title={t("settings.sd.warnRatio")} desc={t("settings.sd.warnRatioDesc")}>
          <select className="f-in mid" value={d.format.contextWarnRatio ?? 0.8}
            onChange={(e) => apply({ format: { contextWarnRatio: Number(e.target.value) } })}>
            {WARN_RATIOS.map((r) => (
              <option key={r} value={r}>{r >= 1 ? t("settings.sd.noWarn") : `${Math.round(r * 100)}%`}</option>
            ))}
          </select>
        </Row>
        <Row title={t("settings.sd.dotsCount")} desc={t("settings.sd.dotsCountDesc")}>
          <select className="f-in mid" value={d.format.dotsCount ?? 10}
            onChange={(e) => apply({ format: { dotsCount: Number(e.target.value) } })}>
            {DOTS_COUNTS.map((n) => <option key={n} value={n}>{t("settings.sd.cells").replace("{n}", n)}</option>)}
          </select>
        </Row>
        <Row title={t("settings.sd.tpsDecimals")} desc={t("settings.sd.tpsDecimalsDesc")}>
          <select className="f-in mid" value={d.format.tpsDecimals ?? 1}
            onChange={(e) => apply({ format: { tpsDecimals: Number(e.target.value) } })}>
            {PERCENT_DECIMALS.map((n) => <option key={n} value={n}>{t("settings.sd.decimals").replace("{n}", n)}</option>)}
          </select>
        </Row>
      </div>
    </>
  );
}
