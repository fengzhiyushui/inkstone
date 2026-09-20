import React, { useMemo, useState } from "react";
import {
  ChevronDown, ChevronRight, Wrench, FileDiff, TriangleAlert, ListChecks,
  Workflow, Check, CircleCheck, CircleX, Zap, GitCompare, Settings, Diamond, Sparkles
} from "lucide-react";
import { deriveAgentCards } from "../../state/agent-cards.js";
import Composer from "./Composer.jsx";

// v1.4 会话视图(设计稿 v4 视图 2):头部 → 消息流(用户气泡 / agent 排版 / 五类事件卡)→ 输入胶囊。
// 事件卡:计划(.pl)、工具、diff(.df)、审批(.ap,接 kernel approve)、编排(.oc)。全部可折叠。

function Collapsible({ defaultClosed = false, head, children, className = "" }) {
  const [closed, setClosed] = useState(defaultClosed);
  const collapsible = Boolean(children);
  return (
    <div className={`ev ${closed ? "closed" : ""} ${className}`}>
      <button type="button" className="ev-h" aria-expanded={!closed} onClick={() => collapsible && setClosed(!closed)}>
        {collapsible && <span className="car">{closed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}</span>}
        {head}
      </button>
      {children}
    </div>
  );
}

function PlanCard({ card, t }) {
  const done = card.steps.filter((s) => s.status === "done").length;
  const head = (
    <>
      <ListChecks size={13} />
      <span className="ttl">{t("ev.plan")}</span>
      <span>· {card.subtasks} {t("ev.steps")}</span>
      <span className="r">
        <span className="mini run">{t("ev.inProgress")} {done}/{card.subtasks || card.steps.length}</span>
      </span>
    </>
  );
  if (!card.steps.length) return <Collapsible head={head} />;
  return (
    <Collapsible head={head}>
      <div className="ev-b pl">
        {card.steps.map((s) => (
          <div key={s.id} className={`st ${s.status === "done" ? "done" : s.status === "run" ? "run" : "todo"}`}>
            <span className="bx">
              {s.status === "done" ? <Check size={10} /> : s.status === "run" ? <span className="spin" style={{ width: 9, height: 9, borderWidth: 1.5 }} /> : null}
            </span>
            {s.id}
            {s.status === "failed" && <span className="mini err" style={{ marginLeft: "auto" }}>{t("ev.failed")}</span>}
          </div>
        ))}
      </div>
    </Collapsible>
  );
}

function ToolCard({ card, t }) {
  const tone = card.status === "error" ? "err" : card.status === "ok" ? "ok" : "run";
  return (
    <Collapsible head={
      <>
        <Wrench size={13} />
        <span className="mini">{card.tool}</span>
        {card.argHint && <span className="arg">{card.argHint}</span>}
        <span className="r">
          {card.durationMs != null && <span className="mini">{t("ev.tool.duration").replace("{n}", card.durationMs)}</span>}
          <span className={`mini ${tone}`}>
            {card.status === "ok" ? <CircleCheck size={11} /> : card.status === "error" ? <CircleX size={11} /> : <span className="spin" style={{ width: 9, height: 9, borderWidth: 1.5 }} />}
            {card.status === "running" ? t("ev.running") : card.status === "ok" ? t("ev.toolOk") : t("ev.error")}
          </span>
        </span>
      </>
    } />
  );
}

function DiffCard({ card, t, onOpen }) {
  const head = (
    <>
      <FileDiff size={13} />
      <span className="ttl">{t("ev.diff")}</span>
      <span className="arg">{card.path}{card.fileCount > 1 ? ` +${card.fileCount - 1}` : ""}</span>
      <span className="r">
        {card.added > 0 && <span className="mini ok">+{card.added}</span>}
        {card.removed > 0 && <span className="mini err">−{card.removed}</span>}
        {card.changeId && <span className="mini">{card.changeId}</span>}
      </span>
    </>
  );
  return (
    <Collapsible head={head}>
      <div className="ev-b" style={{ padding: "6px 0" }}>
        <div className="df">
          {card.files.map((f) => (
            <div key={f.path} className="ln">
              <span className="no">{f.status}</span>
              <span className="tx">{f.path}</span>
              <span style={{ marginLeft: "auto", display: "flex", gap: 8, paddingRight: 12 }}>
                {f.added != null && <span style={{ color: "var(--ok)" }}>+{f.added}</span>}
                {f.removed != null && <span style={{ color: "var(--err)" }}>−{f.removed}</span>}
              </span>
            </div>
          ))}
        </div>
        {card.changeId && (
          <div style={{ padding: "8px 12px 2px" }}>
            <button type="button" className="btn ghost" onClick={() => onOpen(card.changeId, card.path)}>
              <GitCompare size={12} /> {t("ev.openDiff")}
            </button>
          </div>
        )}
      </div>
    </Collapsible>
  );
}

function ApprovalCard({ card, t, onApprove }) {
  return (
    <div className="ev ap" data-decision={card.decision || undefined}>
      <div className="ev-h">
        <TriangleAlert size={13} />
        <span className="ttl">{t("ev.approval")}</span>
        {card.decision && <span className="r"><span className="mini">{t(`ev.decision.${card.decision}`) || card.decision}</span></span>}
      </div>
      <div className="ev-b">
        <span className="cmd">{card.summary || card.id || ""}</span>
        {!card.decision && card.id && (
          <>
            <button type="button" className="btn accent" onClick={() => onApprove(card.id, "approve")}>{t("ev.approve")}</button>
            <button type="button" className="btn ghost" onClick={() => onApprove(card.id, "deny")}>{t("ev.deny")}</button>
          </>
        )}
      </div>
    </div>
  );
}

function OrchCard({ card, t }) {
  const total = card.completed + card.failed;
  const pct = total > 0 ? Math.round((card.completed / total) * 100) : 0;
  return (
    <Collapsible head={
      <>
        <Workflow size={13} />
        <span className="ttl">{t("ev.orchestration")}</span>
        <span>· {t("ev.rounds").replace("{n}", card.rounds)}</span>
        <span className="r"><span className={`mini ${card.failed > 0 ? "warn" : "ok"}`}>{card.completed}/{total || card.completed}</span></span>
      </>
    }>
      <div className="ev-b oc">
        {card.steps.map((s) => (
          <div key={s.id} className="row">
            <span className={`mini ${s.status === "done" ? "ok" : s.status === "failed" ? "err" : "run"}`}>{s.status}</span>
            <span className="nm">{s.id}</span>
            <span style={{ flex: 1 }} />
            <span className="mini">{t("ev.attempt").replace("{n}", s.attempt || 1)}</span>
          </div>
        ))}
        <div className="bar"><i style={{ width: `${pct}%` }} /></div>
      </div>
    </Collapsible>
  );
}

function TestCard({ card, t }) {
  return (
    <Collapsible head={
      <>
        {card.pass ? <CircleCheck size={13} /> : <CircleX size={13} />}
        <span className="ttl">{t("ev.verification")}</span>
        <span className="r"><span className={`mini ${card.pass ? "ok" : "err"}`}>{card.status || (card.pass ? t("ev.passed") : t("ev.failed"))}</span></span>
      </>
    } />
  );
}

// v1.8.0 推理摘要卡:默认收起;正文由网关隐藏,只展示用途与用量。
function ThoughtCard({ card, t }) {
  const meta = [card.purpose, card.reasoningTokens != null ? `${card.reasoningTokens} tokens` : null].filter(Boolean).join(" · ");
  return (
    <Collapsible defaultClosed head={
      <>
        <Sparkles size={13} />
        <span className="ttl">{t("ev.thought")}</span>
        {meta && <span>· {meta}</span>}
      </>
    }>
      <div className="ev-b"><span className="mini">{t("ev.thought.hidden")}</span></div>
    </Collapsible>
  );
}

export default function ChatView({ t, state, actions, kernel, statusLine, setView }) {
  const [draft, setDraft] = useState("");
  const cards = useMemo(() => deriveAgentCards(state.activity), [state.activity]);
  const busy = Boolean(state.runtime && ["acting", "thinking", "verifying", "repairing"].includes(state.runtime.current));
  const projectName = state.currentProject ? state.currentProject.split(/[\\/]/).filter(Boolean).pop() : "";

  const renderCard = (card, i) => {
    switch (card.kind) {
      case "plan": return <PlanCard key={i} card={card} t={t} />;
      case "tool": return <ToolCard key={i} card={card} t={t} />;
      case "diff": return <DiffCard key={i} card={card} t={t} onOpen={(id, p) => { kernel.openChangeDiff(id, p); setView("changes"); }} />;
      case "approval": return <ApprovalCard key={i} card={card} t={t} onApprove={actions.approve} />;
      case "orchestration": return <OrchCard key={i} card={card} t={t} />;
      case "test": return <TestCard key={i} card={card} t={t} />;
      case "thought": return <ThoughtCard key={i} card={card} t={t} />;
      default: return null;
    }
  };

  return (
    <section className="view on">
      <header className="pane-head">
        <span className="ttl">{t("chat.title")}</span>
        <span className="sub">{projectName}</span>
        <div className="spacer" />
        <span className="seg" title={t("chat.autonomy")}><Zap size={12} /> {state.runtime?.autonomy || t("chat.gated")}</span>
        <span className="seg acc" title={t("settings.model")}>{state.config?.model || "—"}</span>
        <button type="button" className="iconbtn" title={t("rail.changes")} onClick={() => setView("changes")}><GitCompare size={15} /></button>
        <button type="button" className="iconbtn" title={t("rail.settings")} onClick={() => setView("settings")}><Settings size={15} /></button>
      </header>

      <div className="stream">
        <div className="stream-in">
          {state.messages.map((m, i) => (
            m.role === "user"
              ? <div key={`m${i}`} className="u-msg"><div className="bb">{m.text || m.content}</div></div>
              : (
                <div key={`m${i}`} className="a-msg">
                  <span className="mk"><Diamond size={12} /></span>
                  <div className="tx">
                    {m.text || m.content}
                    <div className="mt">{state.config?.model || ""}</div>
                  </div>
                </div>
              )
          ))}
          {cards.map(renderCard)}
          {state.messages.length === 0 && cards.length === 0 && (
            <div className="empty-note">
              <span className="en-ic"><Diamond size={26} /></span>
              {t("chat.empty")}
            </div>
          )}
        </div>
      </div>

      <Composer t={t} draft={draft} setDraft={setDraft} busy={busy}
        onSend={(text) => { setDraft(""); actions.send(text); }}
        onInterrupt={actions.interrupt}
        model={state.config?.model} autonomy={state.runtime?.autonomy}
        statusLine={statusLine} />
    </section>
  );
}
