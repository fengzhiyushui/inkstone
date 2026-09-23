import React, { useMemo } from "react";
import { Check, Circle, CircleX, ListChecks } from "lucide-react";
import { deriveAgentCards } from "../../../state/agent-cards.js";
import css from "./PlanPanel.module.css";

export default function PlanPanel({ t, state }) {
  const cards = useMemo(() => deriveAgentCards(state.activity), [state.activity]);
  const planCard = cards.find((c) => c.kind === "plan");
  const steps = planCard?.steps || [];
  const total = planCard?.subtasks || steps.length || 0;
  const done = steps.filter((s) => s.status === "done").length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  if (!steps.length) {
    return (
      <div className={css.emptyState}>
        <ListChecks size={28} style={{ color: "var(--accent)" }} />
        <div className={css.emptyTitle}>{t("dock.plan") || "执行计划"}</div>
        <div className={css.emptyDesc}>
          当前尚无活跃的多步规划任务。在对话中发送编码或排查任务，智能体将自动规划步骤并在本栏实时跟踪。
        </div>
      </div>
    );
  }

  return (
    <div className={css.root}>
      <div className={css.summary}>
        <div className={css.titleRow}>
          <span className={css.title}>{t("dock.plan") || "当前执行计划"}</span>
          <span className={css.statusTag}>进度 {pct}% · {done}/{total} 步</span>
        </div>
        <div className={css.progressBar}>
          <div className={css.progressFill} style={{ width: `${pct}%` }} />
        </div>
      </div>

      <div className={css.stepsList}>
        {steps.map((s, idx) => {
          const isDone = s.status === "done";
          const isRun = s.status === "run";
          const isFailed = s.status === "failed";
          const statusClass = isDone ? "done" : isRun ? "running" : isFailed ? "failed" : "todo";

          return (
            <div key={s.id || idx} className={`${css.stepCard} ${css[statusClass] || ""}`}>
              <div className={`${css.stepHeader} ${css[statusClass] || ""}`}>
                {isDone && <Check size={14} style={{ color: "var(--ok)", flexShrink: 0 }} />}
                {isRun && <span className="spin" style={{ width: 12, height: 12, borderWidth: 1.5, flexShrink: 0 }} />}
                {isFailed && <CircleX size={14} style={{ color: "var(--err)", flexShrink: 0 }} />}
                {!isDone && !isRun && !isFailed && <Circle size={14} style={{ color: "var(--text-faint)", flexShrink: 0 }} />}
                <span>步骤 {idx + 1}：{s.id}</span>
              </div>
              <div className={css.stepMeta}>
                {isDone && "已完成"}
                {isRun && "正在执行中…"}
                {isFailed && "执行失败"}
                {!isDone && !isRun && !isFailed && "等待调度"}
                {s.attempt > 1 && ` · 尝试第 ${s.attempt} 次`}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
