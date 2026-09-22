import React, { useState } from "react";
import { Bug, Sparkles, Search, FileDiff, Diamond, MessageSquare } from "lucide-react";
import Composer from "./Composer.jsx";
import { recentSessions, sessionStamp } from "../../state/session-groups.js";

// v1.4 欢迎首页(设计稿 v4 视图 1):问候 → 输入胶囊 → 四张快捷卡 → 最近会话。
// 快捷卡不直接发起请求,只把任务模板写入草稿并聚焦,由用户补充后发送。

function greetingKey(hour) {
  if (hour < 6) return "home.greet.night";
  if (hour < 12) return "home.greet.morning";
  if (hour < 18) return "home.greet.afternoon";
  return "home.greet.evening";
}

const QUICK = [
  { id: "bug", icon: Bug },
  { id: "feature", icon: Sparkles },
  { id: "read", icon: Search },
  { id: "changes", icon: FileDiff, go: "changes" } // setViewOrDock 会转到右栏 dock
];

export default function HomeView({ t, state, actions, setView, onSwitchProject, statusLine }) {
  const [draft, setDraft] = useState("");
  const now = Date.now();
  const recent = recentSessions(state.projects, state.sessions, 3);
  const busy = Boolean(state.runtime && ["acting", "thinking", "verifying", "repairing"].includes(state.runtime.current));

  const send = (text) => {
    setDraft("");
    actions.send(text);
    setView("chat");
  };

  const stampText = (mtime) => {
    const s = sessionStamp(mtime, now);
    return s.kind === "weekday" ? t(`day.${s.weekday}`) : s.text;
  };

  return (
    <section className="view on">
      <div className="home">
        <div className="home-in">
          <div className="hello">
            <span className="lg"><Diamond size={22} /></span>
            <span className="hello-txt">{t(greetingKey(new Date(now).getHours()))}</span>
          </div>
          <p className="hint">{t("home.tagline")}</p>

          <Composer t={t} flat draft={draft} setDraft={setDraft} onSend={send}
            onInterrupt={actions.interrupt} busy={busy}
            model={state.config?.model} statusLine={statusLine} />

          <div className="quick">
            {QUICK.map(({ id, icon: Icon, go }) => (
              <button key={id} type="button" className="q-card"
                onClick={() => (go ? setView(go) : setDraft(t(`home.q.${id}.seed`)))}>
                <div className="qt"><Icon size={15} /> {t(`home.q.${id}.title`)}</div>
                <div className="qd">{t(`home.q.${id}.desc`)}</div>
              </button>
            ))}
          </div>

          {recent.length > 0 && (
            <div className="rc">
              <div className="rc-h">{t("home.recent")}</div>
              {recent.map((s) => (
                <button key={`${s.projectDir}/${s.id}`} type="button" className="rc-item"
                  onClick={() => {
                    const p = (state.projects || []).find((x) => x.id === s.projectDir);
                    if (p) onSwitchProject(p.root); else setView("chat");
                  }}>
                  <span className="ric"><MessageSquare size={14} /></span>
                  <span className="rt">{s.summary || t("rail.untitled")}</span>
                  <span className="rm">{stampText(s.mtime)} · {t("home.recentEvents").replace("{n}", s.events || 0)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
