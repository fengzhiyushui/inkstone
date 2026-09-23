# V2-19 删除 V1 Legacy 架构 Implementation Plan

- 类型：实施计划
- 日期：2026-06-25
- 状态：已完成
- 关联：[V3 路线图](../../specs/architecture/2026-06-24-v3-roadmap-design.md)、[CHANGELOG](../../CHANGELOG.md)

## 目标

删除与 V2 并存的死掉 V1 架构，在不影响在用功能的前提下消除双重代码库。

## 结果

删除面（2026-06-25 审计确认无引用）：`src/agent.js`、`src/chat.js`、`src/ui.js`、`src/kernel/` 十个 V1 内核文件（config-provider、context-engine、event-bus、kernel-api、model-provider、permission-engine、session-log、session-manager、task-orchestrator、tool-registry）、`test/kernel/` 九个测试。`config.js` 去掉 `DEFAULT_MODEL_PROFILES` re-export，`package.json` 的 `scripts.check` 不再引用 kernel。

保留面（被 V2 共享或在用命令依赖）：`config.js`、`provider.js`、`context.js`、`patch.js`、`changes.js`、`search.js`、`git.js`、`tui.js`、`theme.js`、`test/patch.test.js`。其中 `patch.js` / `changes.js` / `git.js` 已被 `src/edits/*`、`src/tools/builtin/git.js` 依赖，属 V2 共享模块。

`scan`、`search`、`diff`、`changes` / `rollback`、`config`、`tui` 等命令链路不受影响；`ask` / `edit` / `chat` / `test` 已走 V2。

## 关键决策 / 遗留约束

- 只删审计确认无引用的 V1 死代码。`config.js:157` 的 re-export 虽存在，但无 V2 消费者（仅 `test/kernel/*` 直接从 kernel 导入），故随 kernel 一起删。
- `apps/` 目录收敛、共享工具迁入更合适的 V2 目录属后续整理，不在本切片，避免扩大改动面。
- `provider.js` 的 `askDeepSeek` 在删除 `agent.js` 后成死导出，暂留待后续清理。
- 主体功能不受影响是硬约束：任何在用命令的实现模块一律不动。

## 验证

`npm run check` 退出码 0（不再引用 kernel）。`npm test` 全绿（总数下降恰为 `test/kernel/*` 用例数，其余无回归）。CLI `help` 与 `config show` 正常启动，证明 cli.js 及保留依赖链完好。当前 `src/` 已无 `kernel/`、`agent.js`、`chat.js`、`ui.js`。
