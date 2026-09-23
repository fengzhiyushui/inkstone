# V2-16 GUI 交互加固与发布抛光实施计划

- 类型：实施计划
- 日期：2026-05-31
- 状态：已完成
- 关联：[CHANGELOG](../../CHANGELOG.md) · [设计 spec](../../specs/frontend/2026-05-31-v2-16-gui-interaction-hardening-design.md) · [V2-14 分支回退](2026-05-31-v2-14-gui-workbench-branch-rewind.md)

## 目标

为 GUI 补偏好持久化、检查器显式关闭、快捷键与 Electron smoke。

## 结果

### 偏好桥

`gui/kernel-host.js` 增加：

| 函数 | 语义 |
|---|---|
| `normalizeGuiPreferences(value)` | 白名单归一（`schema` / `theme` / `railMode` / `contextCollapsed` 等），非法值回安全默认，未知键丢弃 |
| `loadGuiPreferences(projectRoot)` | 读 `<root>/.deepseek-code/gui-preferences.json`；损坏 JSON 回默认 |
| `saveGuiPreferences(projectRoot, patch)` | 白名单后原子写；`secret` 等未知键不落盘 |

host 暴露 `getPreferences` / `setPreferences` 代理。IPC：`gui:preferences-get` / `gui:preferences-set`。preload 暴露 `getPreferences()` / `setPreferences(patch)`。

归一示例语义：非法 `theme` 回 `night`（当时两套主题）；非法 `railMode` 回 `chat`；`contextCollapsed` 强制布尔；`schema` 固定 1。

### 状态与控制器

`workbench-state` 增加偏好水合与检查器显式关闭（关闭后 `inspectorMode` 回 `activity`，清 approval）。`app.js` 在偏好变更动作后持久化，绑定键盘快捷键，管理检查器 / 上下文关闭与焦点目标。`index.html` 加检查器关闭按钮（稳定 id）。样式只加关闭按钮与抽屉态，不改 V2-15 视觉身份。

### 发布抛光

Electron smoke 用临时项目根，仅 Electron 不可用时 skip。视觉 QA 覆盖抽屉 / 检查器生命周期与快捷键。

现役偏好水合仍走 `preferences_loaded`，键含 `theme` / `lastDark` / `lastLight` / `glass` / `language` / `statusDisplay` / `railCollapsed` / `sidebarWidth` / `rightbarWidth` / `rightbarOpen` / `dockTab`。

## 关键决策 / 遗留约束

- 偏好文件随项目根；先白名单再落盘，防污染与防泄密钥。
- 损坏文件容错，不抛崩 UI。
- 检查器关闭是显式动作，不靠点外面猜测。
- 不改 V2-15 视觉身份；动态内容仍安全渲染。
- 架构保持：渲染状态纯函数，`app.js` 只协调 DOM / 快捷键 / 焦点 / 持久化，host 管项目根偏好文件。

## 验证

- `tests/unit/gui/kernel-host.test.js`：归一非法值、缺省加载、损坏 JSON、保存后丢弃未知键。
- `tests/unit/gui/workbench-state.test.js`：水合与关闭行为。
- 静态契约：偏好桥引用、关闭按钮、快捷键 token。
- 门控 `tests/e2e/gui-smoke.test.js`。
- 视觉 QA + 全量 `npm test` + `npm run check`。
