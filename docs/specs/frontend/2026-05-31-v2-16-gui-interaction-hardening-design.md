# V2-16 GUI 交互加固与发布打磨

- 类型：前端 spec
- 日期：2026-05-31
- 状态：已完成
- 关联：[V2-15 自然工作台](2026-05-31-v2-15-natural-agent-workbench-design.md)

## 问题与目标

V2-15 在静态截图上可用，本篇补真实使用所需的可靠交互：偏好持久化、键盘可达、drawer/inspector 生命周期与 Electron smoke。布局与视觉方向不变，属于发布打磨层。

## 决策

| 选了什么 | 否决了什么 | 为什么 |
|---|---|---|
| GUI 偏好落本地 JSON | 仅会话内存 | 重启后保留主题/面板/rail |
| 显式 inspector 关闭 + Escape | 只能点风险事件离开 | 用户可退出风险上下文 |
| 全局快捷键在输入框内忽略（Escape 除外） | 全局抢键 | 不干扰文本输入 |
| Electron smoke 可跳过 | 强依赖 CI 有 Electron | 无 Electron 环境仍可跑核心测试 |
| 只做交互加固 | 新视觉/新 runtime | 本片范围 |

不做：新 runtime、新 agent 行为、新分支/回退后端语义、重型框架迁移、耐久审批/修复续跑、大视觉重设计。

## 设计

偏好存储 `<projectRoot>/.deepseek-code/gui-preferences.json`：

```json
{
  "schema": 1,
  "theme": "night",
  "contextCollapsed": false,
  "railMode": "chat"
}
```

规则：缺失/损坏回默认；未知 theme/rail 忽略；写入尽力原子。偏好不含转录、prompt、工具输出、上下文路径或密钥。IPC：`gui:preferences-get`、`gui:preferences-set`。首屏尽量先加载偏好，失败则默认继续并报告非阻塞降级。theme、rail mode、panel collapsed 变化时写回。

Inspector 生命周期：

- 审批、回退预览、错误/冲突/恢复失败自动打开。
- 可见关闭钮或 `Escape` 关闭，`inspectorMode: "activity"`，中/窄屏关 drawer 覆盖。
- 选检查点重回 rewind；审批解决后关 approval 模式，除非另有风险结果。

Context 面板：rail 选中打开；toggle 折叠；窄屏首载默认折叠（偏好另有则从偏好）；仅当无 inspector drawer 时 `Escape` 关 context drawer。

键盘：

| 键 | 行为 |
|---|---|
| Ctrl+1..5 | Chat / Context / Branches / Timeline / Settings |
| Ctrl+K | 聚焦 `#msg-input` |
| Escape | 先关 inspector/context drawer |

焦点在 input/textarea/contenteditable 时全局快捷键忽略。rail 快捷键与点击走同一状态路径。inspector 因审批/回退打开时焦点移到关闭钮或首个相关动作；关闭后尽量回 composer。

Electron smoke：启动 `gui`，`--project=<temp>` 注入临时项目，断言 `#command-bar`、`#activity-rail`、`#agent-session`、`#statusline` 存在、窗口非空、主题切换存在，然后干净退出。无网络、无真实模型调用。Electron 不可用则明确跳过；本地有 `gui/node_modules/electron` 时应跑。

## 边界与不变量

- 主要文件：`gui/kernel-host.js`（偏好读写）、`gui/main.js`（IPC）、`gui/preload.js`（bridge）、`gui/renderer/workbench-state.js`、`app.js`、`index.html`、`style.css`。
- 测试：`kernel-host`、`renderer-static`、`workbench-state`、交互等价、`tests/e2e/gui-smoke.test.js`。
- 动态内容仍禁不安全 `innerHTML`。
- 测试用临时项目根，不在仓库根制造 `.deepseek-code/v2` 污染；真实用户启动 GUI 产生的 `.deepseek-code/v2` 不算测试污染。
- 焦点管理保持小而状态驱动，避免散落 DOM 焦点补丁。

## 与现状的差异

React 化后偏好键演进为 `theme`、`language`、`railCollapsed`、`sidebarWidth`、`rightbarWidth`、`glass`、`lastDark`/`lastLight` 等，见 `gui/src/state/workbench-state.js` 与 `useKernel.setPreferences`。本篇的 preference 文件模式与键位精神延续。

## 验收

- 焦点 GUI 测试与（可用时）Electron smoke 通过。
- `npm.cmd test` / `npm.cmd run check` / `git diff --check`。
- 截图确认关闭钮可见、composer 不隐藏、traffic 文案可见、无重叠。
- 偏好读写失败降级不崩。
