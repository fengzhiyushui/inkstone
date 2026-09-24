import React, { useEffect, useState } from "react";
import { deriveInspectorModel } from "../../../state/inspector-state.js";
import TimelineView from "../TimelineView.jsx";
import css from "./InspectorPanel.module.css";

// M2 Agent Inspector — 右栏 Dock 第 5 tab（D2：独立 tab，不动 PlanPanel）。
// 五区：优先条 / 计划 / 工具配对 / 审批 / 时间线。数据纯派生 + 轻量拉取 listPaused / timeline。
export default function InspectorPanel({ t, state, kernel }) {
  const [paused, setPaused] = useState([]);
  const [timeline, setTimeline] = useState([]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [p, tl] = await Promise.all([
          kernel?.listPaused ? kernel.listPaused() : Promise.resolve([]),
          kernel?.getTimeline ? kernel.getTimeline(200) : Promise.resolve([])
        ]);
        if (!cancelled) {
          setPaused(Array.isArray(p) ? p : []);
          setTimeline(Array.isArray(tl) ? tl : []);
        }
      } catch {
        if (!cancelled) {
          setPaused([]);
          setTimeline([]);
        }
      }
    };
    load();
    return () => { cancelled = true; };
  }, [kernel, state.activity, state.currentProject, state.dockTab]);

  const model = deriveInspectorModel({
    activity: state.activity,
    runtime: state.runtime,
    paused,
    timeline,
    orchState: state.orchState
  });

  const strip = model.priority;

  return (
    <div className={css.root} data-testid="inspector-panel">
      <section className={css.section}>
        <div className={css.secTitle}>{t("insp.priority")}</div>
        <div className={css.strip}>
          <span className={css.chip}>{t(`insp.lane.${strip.lane}`)}</span>
          <span className={css.kv}>{t("insp.round")} {strip.round}</span>
          <span className={css.kv}>{t("insp.progress")} {strip.done}/{strip.total}</span>
          {strip.failed > 0 && <span className={`${css.kv} ${css.err}`}>{t("insp.failed")} {strip.failed}</span>}
          <span className={css.kv}>{t("insp.tools")} {strip.counts.tool}</span>
          <span className={css.kv}>{t("insp.diffs")} {strip.counts.diff}</span>
          <span className={css.kv}>{t("insp.thoughts")} {strip.counts.thought}</span>
        </div>
      </section>

      <section className={css.section}>
        <div className={css.secTitle}>{t("insp.plan")}</div>
        <div className={css.metaLine}>
          {t("insp.runtime")} · {model.plan.runtime}
          {model.plan.channel ? ` · ${model.plan.channel}` : ""}
        </div>
        {model.plan.steps.length === 0 ? (
          <div className={css.empty}>{t("insp.planEmpty")}</div>
        ) : (
          <ol className={css.stepList}>
            {model.plan.steps.map((s) => (
              <li key={s.id || s.index} className={`${css.step} ${css[s.status] || ""}`}>
                <span className={css.stepIdx}>{s.index}</span>
                <span className={css.stepId}>{s.id}</span>
                <span className={css.stepSt}>{t(`insp.step.${s.status}`)}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className={css.section}>
        <div className={css.secTitle}>{t("insp.toolsSec")}</div>
        {model.tools.length === 0 ? (
          <div className={css.empty}>{t("insp.toolsEmpty")}</div>
        ) : (
          <ul className={css.toolList}>
            {model.tools.map((tool, i) => (
              <li key={tool.callId || i} className={`${css.tool} ${css[tool.status] || ""}`}>
                <span className={css.toolName}>{tool.name}</span>
                <span className={css.toolSt}>
                  {t(`insp.tool.${tool.status}`)}
                  {tool.durationMs != null ? ` · ${tool.durationMs}ms` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={css.section}>
        <div className={css.secTitle}>{t("insp.approvals")}</div>
        {model.approvals.paused.length === 0 && model.approvals.open.length === 0 ? (
          <div className={css.empty}>{t("insp.approvalsEmpty")}</div>
        ) : (
          <ul className={css.apprList}>
            {model.approvals.paused.map((p) => (
              <li key={`p-${p.id}`} className={`${css.appr} ${css.run}`}>
                <span className={css.apprId}>{p.id}</span>
                <span className={css.apprSum}>{p.summary || p.tool || "—"}</span>
              </li>
            ))}
            {model.approvals.open.map((p) => (
              <li key={`o-${p.id || p.summary}`} className={css.appr}>
                <span className={css.apprId}>{p.id || "—"}</span>
                <span className={css.apprSum}>{p.summary}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={css.section}>
        <div className={css.secTitle}>{t("insp.timeline")}</div>
        <TimelineView t={t} rows={model.timeline} height={260} emptyText={t("timeline.empty")} />
      </section>
    </div>
  );
}
