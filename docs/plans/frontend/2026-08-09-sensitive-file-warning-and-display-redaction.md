# 敏感文件风险提醒 + 展示层脱敏实施方案（#9.3 前端片）

- 类型：实施计划
- 日期：2026-08-09
- 状态：已完成
- 关联：[CHANGELOG](../../CHANGELOG.md) · [补救 spec](../../specs/backend/2026-07-12-agent-findings-remediation.md) · [D-G7 恢复中心](2026-09-15-d-g7-gui-recovery-center.md)

## 目标

agent 要写 `.env` / `*.pem` 等敏感文件时独立告知用户；CLI/TUI/GUI 的变更详情展示对密钥脱敏，落盘仍保留原文供回滚。

## 结果

v1.7.0 已发布。后端卫生（大小上限 / 回滚守卫 / 保留期 / 目录限权）在 v1.6.2 完成；本片做需要三端前端配合的两件事。

### 敏感文件独立风险提醒

agent 改敏感文件时，完整原文会进 `.deepseek-code/changes/<id>.json`（回滚必需，不可脱敏）。用户原先毫无感知。设计立场是用户知情后自己拍板：允许则继续并照常落记录，拒绝则不改该文件。

两条硬要求：提醒独立于所有权限档位之外（属副作用告知，混进权限矩阵会被 `auto` / `full-auto` 一键放行）；红色显著标注，三端各自实现，不复用普通审批卡片。

判定来源为现成的 `contextSkipReason`（`src/context/workspace-indexer.js`），覆盖 `.env*` / `*.pem` / `*.key` / `*.p12` / `*.pfx` / `.npmrc` / 含 `credentials|token|apikey|auth` 的配置文件。不新建清单。

实现路径（编辑真正发生之前触发，不经权限引擎）：

- 新建 `src/edits/sensitive-notice.js`：`buildSensitiveNotice(paths) → { paths: [{ path, reason }], hasSensitive: boolean } | null`，纯判定 + 载荷 `{ paths, reason, recordPath }`。
- 修改 `src/edits/edit-service.js`：`createEditService({ onSensitiveNotice })`，`assertDiffPathsSafe` 之后、`store.capture` 之前预检；`await onSensitiveNotice(payload)` 返回 `false` → 抛 `SENSITIVE_EDIT_DECLINED`，工作区未改、无 change 记录。未注入回调时行为逐字节不变。
- 修改 `src/index.js`：kernel 层 notice 回调透传到 editService。

三端 UI：

| 端 | 落点 | 行为 |
|---|---|---|
| CLI | `render-events.js` / `kernel-runner.js` | 红色块，含路径、原因、「记录会存完整原文」 |
| TUI | `event-cards.js` / `tui-state.js` / `tui-app.js` / `tui-i18n.js` | 独立态（不复用 approval），y/n 行内答复，红色 ANSI，CJK 宽度正确 |
| GUI | `SensitiveNoticeModal.jsx` + `workbench-state.sensitiveNotice` | 与 `approval` 互不干扰；`respondSensitive` → `sensitive:respond`（IPC 白名单登记） |

拍板结论：`full-auto` 也一律提问（该档 `read_secret` / `execute_dangerous` 本就是 `ask`，不是无人值守免打扰档）；每次提醒不缓存选择。

### 展示层脱敏

CLI `changes` / GUI 变更详情曾把密钥原样打到屏幕上，截图或贴 issue 会外泄。本地磁盘明文是既有取舍，本片针对越界路径。

存储保持原文供回滚，脱敏只作用于渲染，复用 `src/security/redactor.js`：

- `gui/kernel-host.js` 的 `changes:describe` 回渲染层前过 redactor。
- CLI `changes` 与 TUI diff 卡同步掩码。
- 断言两侧：渲染无明文，磁盘记录原文不变；回滚仍能用原文复原。

## 关键决策 / 遗留约束

- kernel 公开契约（`send` / `approve` / `interrupt` 签名、事件发布顺序、错误语义）不变；v1.6.3 刻画测试保持全绿。
- 存储内容一个字节不改。
- 测试基线只增不减；收尾 `npm test` + `npm run check` + `npm run build:renderer`。
- 提交信息不带 `Co-Authored-By`。
- 不引入新运行时依赖。
- 样式走 `tokens.css` 既有 danger 色，不新造色值。

## 验证

- `tests/unit/edits/sensitive-notice.test.js`：只标敏感路径、拒绝抛错且无落盘、允许正常、未注入不变。
- `tests/unit/apps/cli-sensitive-notice.test.js`、`tests/unit/apps/tui/sensitive-notice.test.js`：红色渲染、full-auto 行为、i18n 对齐。
- GUI：notice 与 approval 状态互不干扰；`IPC_CHANNELS` 已登记新 channel。
- `tests/unit/gui/kernel-host-changes-redaction.test.js`、`tests/unit/apps/cli-changes-redaction.test.js`：掩码 + 磁盘原文 + 回滚复原。
- 现役入口：GUI `SensitiveNoticeModal`；冒烟景 `shell-sensitive-notice`。
