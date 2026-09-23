# V2-15 自然 Agent 工作台

- 类型：前端 spec
- 日期：2026-05-31
- 状态：已完成
- 关联：[V2-14 工作台刷新](2026-05-31-v2-14-gui-workbench-branch-rewind-design.md) · [V2-16 交互加固](2026-05-31-v2-16-gui-interaction-hardening-design.md)

## 问题与目标

把 Electron GUI 从三栏仪表盘感改成更接近现代 AI 编程工具的本地 agent 工作台。保留分区心智，形态改为窄 activity rail、可折叠上下文栏、中央 agent 会话、右侧上下文 inspector、底部 statusline。首屏即可用，用户始终知道 agent 在做什么、是否要审批、在哪个分支/检查点、缓存与用量、能否回退、kernel 健康与否。

## 决策

| 选了什么 | 否决了什么 | 为什么 |
|---|---|---|
| 顶栏 command/status + 左 rail + 可折叠 context + 中央会话 + 右 inspector + 底 statusline | 旧的大号 per-pane 标题 | 朝向 IDE/agent 工具密度 |
| 双主题（Night Workbench / Day Review）共用语义 token | 组件绑裸色 | 主题可换、对比可测 |
| 单一 traffic-light 状态簇 + 旁路文字 | 散布多灯 | 状态一眼定位，不靠颜色单独表意 |
| 事件按选中对象切换 inspector | 固定 inspector | 风险操作自动聚焦 |
| 首屏即工作台 | landing/hero | 本地工具 |

设计参考 Carbon / Atlassian color、VS Code theme-color、Material color roles、WCAG 对比度（正文 4.5:1，图形 3:1）。

## 设计

顶栏：左侧产品/会话身份与工作区，中部当前任务或检查点摘要，右侧模型/autonomy、traffic 簇、刷新。

Activity rail（图标优先，均有可访问名）：Chat、Context、Branches、Timeline、Settings。点击切换 context 面板模式。rail 不做第二指标列。

Context 面板默认 280px，可折叠为 rail；窄屏变抽屉。Chat 模式显示 active branch、紧凑指标、审批摘要；Context 显示索引/缓存健康；Branches 列分支与激活标记；Timeline 列近期事件；Settings 管主题与运行偏好。

主会话区：紧凑空态、消息转录、按回合分组的工具事件、审批提示、验证/修复摘要、常驻 composer。转录读作执行日志加对话，工具/diff/验证/修复可扫读。

Inspector 随选中变化：事件详情、检查点回退预览、审批风险详情、分支祖先/检查点、无选中时近期活动与健康。审批与回退自动聚焦 inspector。

Statusline：runtime、active branch、autonomy、审批态、tokens、cache hit、平均延迟、请求数、dirty/degraded/offline。只放持久事实。

双主题 token 组：

| 组 | 槽 |
|---|---|
| 背景 | app / rail / panel / main / elevated / inset |
| 文字 | primary / secondary / muted / inverse |
| 描边 | subtle / strong / focus / selection |
| accent | primary / hover / soft |
| 语义 | success / warning / danger / info / offline |
| agent | traffic-ready / traffic-working / traffic-error / traffic-offline |
| code/diff | code 背景、增删背景与描边 |

Night 默认深色（ink/slate 表面，蓝/青 accent）；Day 为截图与日光审查用浅色。组件只引用 token，裸 hex 只在主题声明里。

Traffic 状态映射：绿=ready/complete/clean/connected；黄=working/awaiting approval/verifying/degraded；红=error/denied/rollback conflict/unsafe；灰=idle/offline/unavailable。灯旁总有文字。

交互：rail 切模式；context 可折叠并会话内记忆；选分支载检查点；选检查点开回退预览；审批/错误切 inspector；主题切 `data-theme`；动态内容 `textContent`。

响应式：`≥1200` 四区全开；`900–1199` inspector 变 slide-over；`≤760` rail 变顶部分段导航，context/inspector 变抽屉。任何断点不得藏 composer、traffic 文字、runtime/branch 事实。

可访问性：全控件可见焦点；图标按钮 `aria-label`；状态灯旁有文字；双主题对比可查；风险操作有标签与确认/预览。

## 边界与不变量

- 不改 V2 runtime、审批语义、回退语义、上下文缓存、会话存储。
- 主要改动文件：`gui/renderer/index.html`、`style.css`、`app.js`、`workbench-state.js`、`tests/unit/gui/*`。
- 动态渲染禁止不安全 `innerHTML`。
- 旧 V2-14/V2-frontend 假设由本布局契约整体替换，不只是抛光。

## 与现状的差异

V3 起 GUI 迁 React，本篇的分区契约被 [D-1](2026-06-27-v3-phase-d1-gui-react-shell-design.md) 与 [v1.4.0](2026-07-28-v1.4.0-frontend-redesign-design.md) 继承改造。双主题 token 与 traffic 语义在后续演进为主题 id 与 status 簇。

## 验收

- 静态测试覆盖布局区、rail、command bar、statusline、主题 token、traffic 文案。
- 状态测试覆盖 rail 模式、面板折叠、inspector 上下文、主题切换、traffic tone。
- 禁止不安全 `innerHTML`。
- 截图 1440×900 Night/Day、1020×760、720×760：composer 不隐藏，状态可读，无空白区/重叠/噪色。
- `npm.cmd test` / `npm.cmd run check` / `git diff --check` 通过。
