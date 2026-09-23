# D-G7 GUI 恢复中心实施方案

- 类型：实施计划
- 日期：2026-09-15
- 状态：已完成
- 关联：[CHANGELOG](../../CHANGELOG.md) · [敏感文件提醒与脱敏](2026-08-09-sensitive-file-warning-and-display-redaction.md)

## 目标

GUI 暴露 `kernel.recovery` 的 list / report / resume / cancel / clear，右栏 dock 可打开恢复面板。

## 结果

v1.7.1 已实现。kernel-host 提供 `listRecovery` / `getRecoveryReport` / `recoveryResume` / `recoveryCancel` / `recoveryClear`；IPC `recovery:list|report|resume|cancel|clear` 进白名单；preload 暴露同名桥。UI 在 `RecoveryPanel.jsx`，由 `Dock` 的 `recovery` 页签挂载。recovery 未启用时 list/report 返回空结构，resume/cancel/clear 透传 `RECOVERY_DISABLED`。

## 关键决策 / 遗留约束

- 不改 kernel recovery 契约；IPC 未登记即抛；preload 只暴露子集。
- disabled 行为与 CLI/TUI 一致。
- 非目标：事务日志编辑器、故障注入 UI、跨项目聚合。

## 验证

- `tests/unit/gui/kernel-host.test.js` 恢复代理用例。
- 全量 `npm test` + `npm run check`。
- 入口：右栏 dock → 恢复页签。
