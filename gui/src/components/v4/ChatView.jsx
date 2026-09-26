import React, { useEffect, useMemo, useState } from "react";
import {
  CaretDown, CaretRight, Wrench, GitDiff, Warning, ListChecks,
  GitFork, Check, CheckCircle, XCircle, Diamond, Sparkle,
  Copy, ThumbsUp, ThumbsDown, ShareNetwork, Database
} from "@phosphor-icons/react";
import { deriveAgentCards } from "../../state/agent-cards.js";
import { deriveTimelineRows } from "../../state/inspector-state.js";
import Composer from "./Composer.jsx";
import SessionHeader from "./SessionHeader.jsx";
import TimelineView from "./TimelineView.jsx";
import css from "./ChatView.module.css";

function MessageTelemetry({ message, model }) {
  const [copied, setCopied] = useState(false);
  const text = message.text || message.content || "";
  const timeStr = useMemo(() => {
    if (message.time) return message.time;
    if (message.timestamp) {
      const d = new Date(message.timestamp);
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    }
    const d = new Date();
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }, [message.time, message.timestamp]);

  const onCopy = () => {
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }
  };

  const usageText = message.usage || "用量 10.6K tok";

  return (
    <div className="msg-telemetry-bar">
      <div className="msg-actions-group">
        <button type="button" className="msg-action-btn" title="复制内容" onClick={onCopy}>
          {copied ? <Check size={12} style={{ color: "var(--ok)" }} /> : <Copy size={12} />}
        </button>
        <button type="button" className="msg-action-btn" title="有帮助">
          <ThumbsUp size={12} />
        </button>
        <button type="button" className="msg-action-btn" title="没帮助">
          <ThumbsDown size={12} />
        </button>
        <button type="button" className="msg-action-btn" title="分享此轮">
          <ShareNetwork size={12} />
        </button>
      </div>
      <div className="msg-metrics-group">
        <div className="msg-metric-pill" title="输入 8.4k tok · 输出 2.2k tok · 缓存命中 88%">
          <Database size={11} style={{ color: "var(--text-faint)" }} />
          <span>{usageText}</span>
        </div>
        <span>{timeStr}</span>
      </div>
    </div>
  );
}

// 卡片头:整行可点用于折叠,但操作按钮放在 button 之外,避免嵌套交互元素
function Collapsible({ defaultClosed = false, head, actions, children, className = "" }) {
  const [closed, setClosed] = useState(defaultClosed);
  const collapsible = Boolean(children);
  return (
    <div className={`ev ${css.card} ${closed ? "closed" : ""} ${className}`}>
      <div className={css.cardHeadRow}>
        <button
          type="button"
          className={`ev-h ${css.cardHead}`}
          aria-expanded={!closed}
          disabled={!collapsible}
          onClick={() => collapsible && setClosed(!closed)}
        >
          {collapsible && <span className="car">{closed ? <CaretRight size={11} /> : <CaretDown size={11} />}</span>}
          {head}
        </button>
        {actions ? <div className={css.cardActions}>{actions}</div> : null}
      </div>
      {!closed && children ? <div className={`ev-b ${css.cardBody}`}>{children}</div> : null}
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
      <div className="pl">
        {card.steps.map((s) => (
          <div key={s.id} className={`st ${s.status === "done" ? "done" : s.status === "run" ? "run" : "todo"}`}>
            <span className="bx">
              {s.status === "done" ? <Check size={10} /> : s.status === "run" ? <span className="spin" style={{ width: 9, height: 9, borderWidth: 1.5 }} /> : null}
            </span>
            <span className={css.stepId}>{s.id}</span>
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
            {card.status === "ok" ? <CheckCircle size={11} /> : card.status === "error" ? <XCircle size={11} /> : <span className="spin" style={{ width: 9, height: 9, borderWidth: 1.5 }} />}
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
      <GitDiff size={13} />
      <span className="ttl">{t("ev.diff")}</span>
      <span>· {card.files?.length || 0}</span>
    </>
  );
  const actions = (
    <>
      {card.added != null && <span className="mini ok">+{card.added}</span>}
      {card.removed != null && <span className="mini err">−{card.removed}</span>}
      <button type="button" className="btn ghost" style={{ fontSize: 11, padding: "1px 8px" }}
        onClick={() => onOpen(card.changeId, card.files?.[0]?.path)}>
        {t("ev.openDiff")}
      </button>
    </>
  );
  return <Collapsible head={head} actions={actions} />;
}

function ApprovalCard({ card, t, onApprove }) {
  const head = (
    <>
      <Warning size={13} />
      <span className="ttl">{t("ev.approval")}</span>
      {card.summary && <span className={css.headSum}>· {card.summary}</span>}
    </>
  );
  const actions = card.resolved
    ? <span className={`mini ${card.decision === "approved" ? "ok" : "err"}`}>{t(`ev.decision.${card.decision === "approved" ? "approved" : "denied"}`)}</span>
    : (
      <>
        <button type="button" className="btn ghost" onClick={() => onApprove(card.id, "deny")}>{t("ev.deny")}</button>
        <button type="button" className="btn accent" onClick={() => onApprove(card.id, "approve")}>{t("ev.approve")}</button>
      </>
    );
  return <Collapsible className="ap" head={head} actions={actions} />;
}

function OrchCard({ card, t }) {
  const pct = Math.round(((card.completed || 0) / Math.max(1, card.subtasks || 1)) * 100);
  return (
    <Collapsible head={
      <>
        <GitFork size={13} />
        <span className="ttl">{t("ev.orchestration")}</span>
        <span className="r"><span className="mini">{t("ev.rounds").replace("{n}", card.rounds || 1)}</span></span>
      </>
    }>
      <div className="oc">
        {(card.steps || []).map((s) => (
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
        {card.pass ? <CheckCircle size={13} /> : <XCircle size={13} />}
        <span className="ttl">{t("ev.verification")}</span>
        <span className="r"><span className={`mini ${card.pass ? "ok" : "err"}`}>{card.status || (card.pass ? t("ev.passed") : t("ev.failed"))}</span></span>
      </>
    } />
  );
}

function ThoughtCard({ card, t }) {
  const [open, setOpen] = useState(false);
  const meta = [card.purpose, card.model, card.reasoningTokens != null ? `${card.reasoningTokens} tokens` : null].filter(Boolean).join(" · ");
  return (
    <>
      <button type="button" className={css.thoughtRow} aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={css.thoughtBar} />
        <Sparkle size={12} />
        <span className={css.thoughtText}>
          {t("ev.thought")}{meta ? ` · ${meta}` : ""}
        </span>
        {open ? <CaretDown size={11} /> : <CaretRight size={11} />}
      </button>
      {open && (
        <div className={css.thoughtBody}>
          {card.reasoning ? <div className={css.thoughtReasoning}>{card.reasoning}</div> : null}
          <div className="mini">
            {[
              card.cacheHitTokens != null ? `${t("metrics.cacheHit")} ${card.cacheHitTokens}` : null,
              card.cacheMissTokens != null ? `${t("metrics.cacheMiss")} ${card.cacheMissTokens}` : null,
              card.tps != null ? `${t("metrics.tps")} ${card.tps}` : null,
              card.latencyMs != null ? `${card.latencyMs}ms` : null
            ].filter(Boolean).join(" · ")}
          </div>
          {!card.reasoning && !(card.cacheHitTokens != null || card.tps != null) && (
            <span className="mini">{t("ev.thought.hidden")}</span>
          )}
        </div>
      )}
    </>
  );
}

export default function ChatView({ t, state, actions, kernel, statusLine, setView, onChatTab, onToggleRightbar }) {
  const [draft, setDraft] = useState("");
  const [timeline, setTimeline] = useState([]);
  const cards = useMemo(() => deriveAgentCards(state.activity), [state.activity]);
  const busy = Boolean(state.runtime && ["acting", "thinking", "verifying", "repairing"].includes(state.runtime.current));
  const projectName = state.currentProject ? state.currentProject.split(/[\\/]/).filter(Boolean).pop() : "";
  const chatTab = state.chatTab || "chat";

  // Q5:轨迹 tab 接真实 session:timeline(与 Inspector 同源)
  useEffect(() => {
    if (chatTab !== "trajectory") return undefined;
    let cancelled = false;
    const load = async () => {
      try {
        const rows = kernel?.getTimeline ? await kernel.getTimeline(200) : [];
        if (!cancelled) setTimeline(Array.isArray(rows) ? rows : []);
      } catch {
        if (!cancelled) setTimeline([]);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [chatTab, kernel, state.activity, state.currentProject]);

  const renderCard = (card, i) => {
    switch (card.kind) {
      case "plan": return <PlanCard key={i} card={card} t={t} />;
      case "tool": return <ToolCard key={i} card={card} t={t} />;
      case "diff": return <DiffCard key={i} card={card} t={t} onOpen={(id, p) => { kernel.openChangeDiff(id, p); }} />;
      case "approval": return <ApprovalCard key={i} card={card} t={t} onApprove={actions.approve} />;
      case "orchestration": return <OrchCard key={i} card={card} t={t} />;
      case "test": return <TestCard key={i} card={card} t={t} />;
      case "thought": return <ThoughtCard key={i} card={card} t={t} />;
      default: return null;
    }
  };

  return (
    <section className="view on" style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%" }}>
      <SessionHeader
        t={t}
        title={projectName || t("chat.title")}
        mode={state.runtime?.autonomy || t("chat.gated")}
        chatTab={chatTab}
        rightbarOpen={Boolean(state.rightbarOpen)}
        onToggleRightbar={() => onToggleRightbar?.()}
        onTabChange={(tab) => onChatTab?.(tab)}
        right={(
          <span className="seg" title={t("settings.model")} style={{ height: 24, padding: "1px 8px", borderRadius: 24, fontSize: 13, background: "var(--hover)", color: "var(--text-mut)", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {state.config?.model || "—"}
          </span>
        )}
      />

      <div className={`stream ${css.stream}`}>
        <div className={`stream-in ${css.streamIn}`}>
          {chatTab === "trajectory" ? (
            <div className={css.trajectoryWrap}>
              <TimelineView t={t} rows={deriveTimelineRows(timeline)} height={420} emptyText={t("timeline.empty")} />
            </div>
          ) : (
            <>
              {state.messages.map((m, i) => (
                m.role === "user"
                  ? <div key={`m${i}`} className={`u-msg ${css.user}`}><div className={`bb ${css.bubble}`}>{m.text || m.content}</div></div>
                  : (
                    <div key={`m${i}`} className={`a-msg ${css.assistant}`}>
                      <span className={`mk ${""}`}><Diamond size={12} /></span>
                      <div className={`tx ${css.assistant ? "" : ""}`}>
                        {m.text || m.content}
                        <div className="mt">{state.config?.model || ""}</div>
                        <MessageTelemetry message={m} model={state.config?.model} />
                      </div>
                    </div>
                  )
              ))}
              {cards.map(renderCard)}
              {state.messages.length === 0 && cards.length === 0 && (
                <div className={`empty-note ${css.emptyNote}`}>
                  <div className={css.emptyIconWrap}>
                    <Diamond size={26} />
                  </div>
                  <div className={css.emptyTitle}>{projectName || "Inkstone Workspace"}</div>
                  <div className={css.emptySubtitle}>{t("chat.empty")}</div>
                  <div className={css.emptySuggestions}>
                    <button
                      type="button"
                      className={css.suggestionChip}
                      onClick={() => setDraft("请分析当前项目的架构设计与核心模块划分。")}
                    >
                      <Sparkle size={12} />
                      <span>分析项目架构</span>
                    </button>
                    <button
                      type="button"
                      className={css.suggestionChip}
                      onClick={() => setDraft("请审查当前代码库中的潜在逻辑问题或坏味道。")}
                    >
                      <Sparkle size={12} />
                      <span>审查代码质量</span>
                    </button>
                    <button
                      type="button"
                      className={css.suggestionChip}
                      onClick={() => setDraft("请为最近修改的模块补充完善的单元测试。")}
                    >
                      <Sparkle size={12} />
                      <span>补充单元测试</span>
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <Composer t={t} draft={draft} setDraft={setDraft} busy={busy}
        onSend={(text) => { setDraft(""); actions.send(text); }}
        onInterrupt={actions.interrupt}
        model={state.config?.model}
        hasApiKey={Boolean(state.config?.hasApiKey)}
        onOpenSettings={actions.openSettings}
        onSelectModel={actions.selectModel}
        autonomy={state.runtime?.autonomy}
        branch={state.activeBranchId || "main"}
        statusLine={statusLine} />
    </section>
  );
}
