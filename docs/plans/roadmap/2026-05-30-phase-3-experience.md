# Phase 3: Experience Layer — Implementation Plan

- 类型：路线图
- 日期：2026-05-30
- 状态：已完成
- 关联：[CHANGELOG](../../CHANGELOG.md)、[Phase 0](2026-05-29-phase-0-kernel-foundation.md)、[Phase 1](2026-05-29-phase-1-core-intelligence.md)、[Phase 4](2026-05-30-phase-4-gui.md)

## 目标

把 SessionLog 接入 kernel 运行时（事件持久化、时间线查询），并升级 TUI 的事件时间线与状态栏。完整 session resume/replay 延后到 follow-up。

## 结果

V1 时期新建 `src/kernel/session-manager.js`：Session Manager 把 EventBus 桥接到 SessionLog，每个 kernel 事件落盘。Tech stack：Node ≥ 20 ESM、既有 readline TUI、Phase 0 SessionLog、Phase 1 EventBus。

接口：

```text
createSessionManager({ eventBus, sessionLog })
  .bridge(eventTypes) -> { flush(), unsubscribe() }
  .getTimeline(n) -> Event[]
  .shutdown()
```

`bridge` 只持久化订阅的事件类型，未订阅类型不落盘。`getTimeline(n)` 从日志回放重建时间线，返回最近 n 条；无 session 时返回空数组。`shutdown` / `unsubscribe` 后停止桥接。

`src/kernel/kernel-api.js` 的 `session.subscribe` 接到真实持久化。`src/tui.js` 增加会话时间线面板与实时状态栏，仍在既有 readline 框架内，无新依赖。

File structure（V1 落地）：

```text
Create:
  src/kernel/session-manager.js       — Event persistence bridge + resume logic
  test/kernel/session-manager.test.js
Modify:
  src/kernel/kernel-api.js            — Wire session.subscribe to real persistence
  src/tui.js                          — Add timeline view + status bar
```

测试覆盖：bridge 持久化 EventBus 事件、忽略未订阅类型、`getTimeline` 返回最近 n 条、无 session 返回空、shutdown 停止桥接。

后续演进：V2-19 删除了 `src/kernel/*`；会话事件与时间线能力由 V2 的 `src/sessions/*`（event-log、event-types、session-manager、branch-store、checkpoint-index、rewind-service）、`src/apps/session-index.js`、`src/apps/tui/*`（event-cards、statusLine）承接。事件类型清单见 `src/sessions/event-types.js`。跨任务经验记忆另见 Phase C4。

## 关键决策 / 遗留约束

- 桥接可订阅指定事件类型，未订阅类型不落盘，便于控制日志体积。
- 完整 resume/replay 不在本阶段。V2 的 rewind / branch / checkpoint 体系是后续替代方案。
- TUI 升级不引入新依赖，留在 readline 框架内。
- Session Manager 是 EventBus 与 SessionLog 之间的桥，不承载业务逻辑。

## 验证

V1 测试 `test/kernel/session-manager.test.js`（随 V2-19 删除）。当前对应入口：`src/sessions/event-log.js`、`src/sessions/session-manager.js`、`src/apps/session-index.js`、`src/apps/tui/event-cards.js`、`src/apps/tui/tui-state.js` 的 `statusLine`。

## 任务覆盖（as-built 映射）

Task 1 Session Manager（bridge 持久化、忽略未订阅类型、getTimeline 最近 n 条、无 session 空数组、shutdown 停止桥接）→ Task 2 KernelAPI 接线（session.subscribe 到真实持久化）→ Task 3 TUI 时间线面板 + 状态栏（readline 框架内，无新依赖）。完整 session resume/replay 显式延后。
