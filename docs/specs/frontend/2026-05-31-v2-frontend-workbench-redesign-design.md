# V2 前端工作台视觉重设计

- 类型：前端 spec
- 日期：2026-05-31
- 状态：已完成
- 关联：[V2-14 分支回退 UX](2026-05-31-v2-14-gui-workbench-branch-rewind-design.md) · [V2-15 自然工作台](2026-05-31-v2-15-natural-agent-workbench-design.md)

## 问题与目标

Electron GUI 此前只是基础三栏壳，视觉与信息密度达不到本地 agent 工作台水准。本篇在保留三栏心智模型的前提下，重做观感、运行状态、分支/回退可用性与响应式断点，目标是安静、精确、工具向的界面。

## 决策

| 选了什么 | 否决了什么 | 为什么 |
|---|---|---|
| 深色开发者工具色板，中性分层表面 | 装饰渐变、大标题、嵌套卡片 | 工作台需要高信息密度与长时间注视舒适度 |
| token 化间距/颜色，写在 `:root` | 散落裸色值 | 便于主题与后续换肤 |
| 三灯状态只覆盖全局健康与关键生命周期 | 每事件彩虹指示 | 避免噪音 |
| 响应式分档折叠 inspector / sidebar | 单一固定布局 | 保证 1020 / 720 断点可用 |

视觉基准参考 NN/g 启发式、WCAG 2.2 与 WAI-ARIA APG，以及 Carbon / Fluent / Polaris / Atlassian / Material 的 token 与布局建议。

## 设计

布局契约（桌面）：

| 区 | 宽 | 内容 |
|---|---|---|
| Sidebar | 260px | 品牌/会话条、分支列表、用量状态 |
| Conversation | 弹性 | topbar、空态/当前回合、消息、审批、composer |
| Inspector | 340px | 活动、审批、检查点、回退预览 |
| Status bar | 固定底 | autonomy、channel、runtime、active branch、降级提示 |

响应式：`≤1020px` 收起 inspector 为抽屉或显式开关；`≤720px` 侧栏折成顶部上下文条，保持对话与 composer 可用。

色板规则：近黑 ink 底、3–4 层 slate 表面；绿=运行/成功/缓存，蓝=中性主操作，琥珀=审批/警告，红=危险。UI 用系统无衬线，等宽仅用于 ID、分支名、数值与类代码值。圆角 4–8px，间距 4px 基数（8/12/16/20/24）。

功能 UX 要点：

1. 空态解释当前工作区状态并给起步动作，留白不空转。
2. tokens、缓存命中、延迟、请求数、runtime、channel、分支、降级态不只靠状态栏展示。
3. 分支/检查点行有 active/selected 标记与稳定 hover/focus。
4. 活动时间线按类型、摘要、分支、时间扫读。
5. 审批/回退等风险操作进 inspector，结果态清晰，危险样式独立。
6. 错误条融入常态工作，不霸占主视野。
7. 可见焦点、键盘可达、语义 role，状态不单靠颜色。

## 边界与不变量

- 不改 V2 runtime、IPC 契约、kernel host，改动落在 renderer；必要时仅加薄 preload/host 委托。
- 主要文件：`gui/renderer/index.html`、`gui/renderer/style.css`、`gui/renderer/app.js`、`gui/renderer/workbench-state.js`、`tests/unit/gui/*`。
- 动态内容一律 `textContent`，禁止不安全 `innerHTML`。

## 与现状的差异

本篇描述的是 V2 时期原生 renderer。后续 V3 D-1 起 GUI 迁到 React 渲染层（`gui/src/`），布局与 token 由 [v1.4.0](2026-07-28-v1.4.0-frontend-redesign-design.md) 与 [v1.8.1](2026-09-20-v1.8.1-dsh-shell-design.md) 接管。本文的三栏心智与安全不变量仍有效，具体文件路径以当前 `gui/src/` 为准。

## 验收

- DOM ID/类/token 与状态模型单测通过。
- `npm.cmd test`、`npm.cmd run check`、`git diff --check` 全绿。
- 截图核对 1440×900、1020×760、720×760：无空白区、重叠、截断控件、不可读文本。
