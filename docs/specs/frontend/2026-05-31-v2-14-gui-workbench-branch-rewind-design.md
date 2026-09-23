# V2-14 GUI 工作台刷新与分支回退 UX

- 类型：前端 spec
- 日期：2026-05-31
- 状态：已完成
- 关联：[V2 视觉重设计](2026-05-31-v2-frontend-workbench-redesign-design.md) · [V2-15 自然工作台](2026-05-31-v2-15-natural-agent-workbench-design.md)

## 问题与目标

V2 内核已有工具循环、审批续跑、修复循环、上下文缓存、事务编辑、分支感知回退与回退恢复。GUI 仍像薄聊天壳。本篇把它做成三栏 agent 工作台，并暴露分支/回退工作流。UI 是重建，保留三栏方向但升级为产品壳。

## 决策

| 选了什么 | 否决了什么 | 为什么 |
|---|---|---|
| 三栏 workbench：左上下文 / 中会话 / 右 inspector | 三层叠加旧壳 | 主工作流居中，分支与回退可见 |
| 通过 preload/main IPC 暴露分支与回退 | 渲染层直调 kernel | 走既有 IPC 风格，不扩任意方法面 |
| 回退先 preview 再 apply，显式确认 | 直接回退 | 风险操作需预览 |
| 指标用小 stat 行展示 tokens/延迟/缓存 | 独立大面板 | 工作台密度 |
| UI 文案英文，修复乱码 | 中英混排乱码标签 | 与既有 GUI 测试一致 |
| 纯逻辑拆出 `workbench-state.js` / `event-adapter.js` | 全堆 `app.js` | Node 可测 |
| 新依赖尽量不加 | 为样式引框架 | 保持现有 GUI 栈 |

不做：完整 visual diff、分支图可视化、分支删除/改名、崩溃恢复、Git 分支集成、实时协作、大前端框架迁移、浏览器 dev server 依赖。

## 设计

```text
+----------------------+---------------------------+----------------------+
| Left Rail            | Conversation              | Inspector            |
| 项目/分支/指标        | 消息 · 审批 · Composer     | 活动/检查点/回退/恢复 |
+----------------------+---------------------------+----------------------+
| Status bar: runtime, channel, tokens, cache, active branch             |
+-----------------------------------------------------------------------+
```

视觉方向：近黑中性底，面板浅一档描边；蓝/青主操作、琥珀警告、红危险；圆角 ≤8px；系统无衬线，无 viewport 字号、无负字距。指标用小 stat 行。避开装饰渐变、光斑、大 hero、卡片套卡片、溢出固定控件的文字、乱码 emoji 图标。

IPC 暴露（`window.deepseek`）：

```text
listBranches()
getActiveBranch()
listCheckpoints(options)
rewindPreview(options)
rewindApply(options)
getTimeline(optionsOrCount)
```

主进程通道：`session:branches`、`session:branch-active`、`session:checkpoints`、`session:rewind-preview`、`session:rewind-apply`。既有通道不变。handler 返回数据或 `{ error }`。

模块边界：

| 文件 | 职责 |
|---|---|
| `gui/renderer/workbench-state.js` | 纯 reducer/selectors：分支、检查点、preview、活动、状态 |
| `gui/renderer/event-adapter.js` | 事件摘要/图标/状态提取，扩展分支/回退/恢复 |
| `gui/renderer/app.js` | DOM 控制器：绑定、调 preload、渲染状态 |

分支面板显示 active branch、`listBranches()` 列表、parent branch、fork 点标签。最小分支项含激活点与名称。点分支只查看检查点（`listCheckpoints({ branch_id })`），不自动激活续跑。

检查点时间线：turn 标签、seq/event 短号、累计变更数、`Preview` 按钮。列表紧凑可滚。空态一行 `No checkpoints yet`。

回退流程：

1. 点 `Preview` → `rewindPreview({ target })`，结果入 state。
2. 展示：目标标签、回滚数、文件、计划分支 id、force 勾选、`Apply rewind`。
3. 无 preview 不 apply；`rewindApply({ target, force })` 后渲染结果并刷新分支/检查点/时间线。

状态文案：

| 状态 | 文案 |
|---|---|
| success | Rewind applied. New branch active. |
| conflict | Rewind blocked by dirty files. |
| conflict_restored | Rewind blocked; previous changes were restored. |
| failed_restored | Rewind failed; workspace was restored. |
| failed_unrestorable | Rewind recovery failed. Manual check required. |

活动面板保留最新 kernel 事件与安全摘要。状态栏显示 runtime、channel、total tokens、cache hit rate、active branch。左栏或 inspector 顶部另示 tokens、`avg_latency_ms`（无吞吐时不编造 speed，显示 avg latency）、缓存命中率、请求数。轮询约 2 秒，回退成功后额外刷新。

## 边界与不变量

- 渲染层禁止 `innerHTML`；事件摘要不倾倒原始 payload。
- 回退预览只显示路径与计数，不显示原始 diff；恢复错误只显示安全类别。
- 审批传真实 approval id；UI 不显示 `reasoning_content`。
- IPC 不暴露任意 kernel 方法。
- 不改 V2 runtime、IPC 既有契约、kernel host。

## 与现状的差异

后续 GUI 迁 React 后，分支/回退状态仍在 `gui/src/state/workbench-state.js`，IPC 名保留。文件树布局与组件路径见当前 `gui/src/`。

## 验收

- 三栏加载，聊天/审批/状态行为不回归。
- 分支列表、检查点、回退 preview/apply 走 kernel 数据并可刷新。
- V2-13 恢复状态（`failed_restored` / `failed_unrestorable` / `conflict_restored`）清晰展示。
- 指标 DOM ID 覆盖 tokens、speed/latency、cache hit、requests。
- 单测覆盖 event-adapter 分支/回退/恢复摘要、workbench-state 缓冲上限与不可变、指标格式化。
- `npm.cmd test` / `npm.cmd run check` / `git diff --check` 通过，测试不污染 `.deepseek-code/v2`。
