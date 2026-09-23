# V2-15 自然 Agent 工作台实施方案

- 类型：实施计划
- 日期：2026-05-31
- 状态：已完成
- 关联：[CHANGELOG](../../CHANGELOG.md) · [V2 视觉重做](2026-05-31-v2-frontend-workbench-redesign.md) · [设计 spec](../../specs/frontend/2026-05-31-v2-15-natural-agent-workbench-design.md)

## 目标

把 UMD 渲染层整理成 command bar / activity rail / context panel / agent session / contextual inspector / statusline 的自然 Agent 工作台，并补齐主题与状态模型。

## 结果

`workbench-state` 扩展 `railMode`、`contextCollapsed`、`inspectorMode`、`theme`，action 增加 `rail_mode_changed`、`context_collapsed_changed`、`inspector_mode_changed`、`theme_changed`。选择器：`trafficTone`、`trafficLabel`、`statusSummary`、`themeLabel`。分支 / 检查点 / 回退 / 审批 / activity / error 状态保留。

当时 DOM 结构含 `#app.workbench-shell[data-theme]`、`#command-bar`、`#activity-rail`、`#context-panel`、`#agent-session`、`#contextual-inspector`、`#statusline`、`#traffic-light` 与 `#traffic-light-label`，并保留 `#messages`、`#approval-box`、`#composer`、`#msg-input`、`#branch-list`、`#checkpoint-list`、`#activity-log`、`#rewind-preview`、`#rewind-force`、`#rewind-apply`。主题 Night/Day token 块 + `data-theme`。

这套 UMD 布局在 v1.3.2 删除 `gui/renderer/` 后由 React 渲染层继承语义：检查器模式并入 `INSPECTOR_MODES`（activity / approval / rewind / details / checkpoints / branch），traffic 状态进 `trafficTone()` 与状态行，主题升级为 10 套 token 主题（见 [v1.4.0 重构](2026-07-31-v1.4.0-frontend-redesign-plan.md)）。

## 关键决策 / 遗留约束

- 状态模型纯函数化；渲染控制器只绑 rail、上下文折叠、主题切换与 inspector 模式。
- 动态内容走 `textContent`；图标控件补可访问标签。
- 主题可切换并持久化；`focus-visible` 必备；无装饰渐变。
- 断点 1200 / 900 / 760；单个克制的 traffic-light 组件。
- 静态测试禁 `innerHTML` 赋值。

## 验证

- `tests/unit/gui/workbench-state.test.js`、`renderer-static.test.js`、`renderer-event-adapter.test.js`（先红后绿）。
- 临时 `.tmp-gui-qa` mock 截图（1440×900 night/day、1020×760、720×760）后删除。
- 全量 `npm test` + `npm run check` + `git diff --check`。
