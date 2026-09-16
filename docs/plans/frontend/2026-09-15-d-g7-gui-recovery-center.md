# D-G7 GUI Recovery Center 实施方案

> 完成状态以 [CHANGELOG](../../CHANGELOG.md) 为准。
> **状态:v1.7.1 已实现(2026-09-15)。**
> 收口 V2-18 Task 13 / roadmap D-G7。原 Task 13 写于 UMD 渲染层时代,本片按现役 React v4 重做。

**目标:** GUI 暴露 `kernel.recovery` 的 list / report / resume / cancel / clear,侧栏入口可打开恢复中心视图。

**范围:** kernel-host 代理 + IPC 白名单 + preload + RecoveryView + i18n + 单测。**不改 kernel recovery 契约**。

**非目标:** 事务日志详情编辑器、故障注入 UI、跨项目恢复聚合。

---

## 任务

### M1 · kernel-host 恢复代理

- [x] `getRecoveryList` / `getRecoveryReport` / `recoveryResume` / `recoveryCancel` / `recoveryClear`
- [x] recovery 未启用时 list/report 返回空结构,不抛;resume/cancel/clear 透传 `RECOVERY_DISABLED`
- [x] 导出到 `createKernelHost()` 返回面

### M2 · IPC + preload

- [x] `IPC_CHANNELS` 增加 `recovery:list|report|resume|cancel|clear`
- [x] `registerIpcHandlers` 注册;preload 暴露 `listRecovery` 等

### M3 · RecoveryView + 侧栏

- [x] `SecondaryViews.RecoveryView`:列表(状态/摘要/动作)+ report 摘要块 + 刷新
- [x] Rail 功能区加「恢复」入口;App 路由 `view === "recovery"`
- [x] 中英 i18n

### M4 · 测试与文档

- [x] `tests/unit/gui/kernel-host.test.js` 恢复代理用例
- [x] CHANGELOG / project-overview / roadmap D-G7 注记落地
- [ ] 全量 `npm test` + `npm run check`(+ gui deps 时 smoke)

---

## 硬约束

- IPC 未登记 channel 注册即抛;preload 只暴露子集
- recovery disabled 行为与 CLI/TUI 一致(空列表 + `RECOVERY_DISABLED`)
- 不引入新运行时依赖
