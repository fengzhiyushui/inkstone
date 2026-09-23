# V2-18 Durable Recovery / Resume Hardening

- 类型：实施计划
- 日期：2026-06-01
- 状态：已完成
- 关联：[CHANGELOG](../../CHANGELOG.md)、[设计](../../specs/backend/2026-06-01-v2-18-durable-recovery-resume-hardening-design.md)

## 目标

为 V2 审批/repair 暂停、agent 管理的 edit/rewind 事务、单写者接管与共享 Recovery Center 提供进程崩溃级 durable recovery。

## 结果

`src/core/recovery/` 子系统落地：原子 sidecar、项目锁、事务日志、inbox 状态与启动对账。经 `createKernel()` 接线后，CLI/TUI/GUI 共用同一 kernel recovery API；edit/rewind/runtime 保持原公开行为，在既有缝上挂持久化。

### 执行切片

本计划保持完整伞形范围。实施开始后体量过大，按可发布切片推进：

| 切片 | 范围 | 目标 |
|------|------|------|
| V2-18a | Task 1–4：原子写/故障注入、恢复事件、项目锁、Inbox | 先立安全本地恢复基底 |
| V2-18b | Task 5–6 及 Task 10–12 中审批/repair 暴露部分 | 审批/repair 暂停跨进程重启可恢复 |
| V2-18c | Task 7–9、Task 14 及 Task 10–13/15 剩余部分 | 中断事务可回滚，CLI/GUI 可见恢复状态 |

GUI 视觉重设计继续延后（原 future-gui 草稿已删除；后续由 v1.4 / v1.8 前端系列落地）。

### 范围检查

锁要保护恢复，恢复要扫 sidecar/journal，暂停持久化依赖 runtime 审批恢复，CLI/GUI 暴露同一 kernel recovery 模型。这些子系统相互咬合，因此保留伞形计划，但用上述切片产出更小、可评审、可测试的软件。

### 文件结构

创建：

| 路径 | 职责 |
|------|------|
| `src/core/recovery/atomic-file.js` | `atomicReadJson`、`atomicWriteBytes`、`atomicWriteJson`、`cleanupAtomicTemps`、`safeRecoverySegment`。目录内临时文件、安全路径段。 |
| `src/core/recovery/recovery-faults.js` | 确定性故障注入，默认关闭。 |
| `src/core/recovery/recovery-errors.js` | 净化后的恢复错误创建与类别。 |
| `src/core/recovery/project-lock.js` | 锁目录获取、心跳、接管请求文件、epoch 所有权检查。 |
| `src/core/recovery/recovery-inbox.js` | `.deepseek-code/v2/recovery/inbox.json` 项模型。 |
| `src/core/recovery/paused-turn-persistence.js` | 暂停 sidecar 保存/加载/删除/隔离与项目范围扫描。 |
| `src/core/recovery/transaction-journal.js` | 字节级事务日志、恢复工件写入、提交矩阵。 |
| `src/core/recovery/recovery-service.js` | 启动恢复编排与 `kernel.recovery.*` API。 |

修改：

| 路径 | 变更 |
|------|------|
| `src/sessions/event-types.js` | 增加 V2-18 生命周期事件 |
| `src/sessions/session-manager.js` | 暂停标记持久化帮助，或由调用方 `publish` + `flush` |
| `src/core/approval/paused-turn-store.js` | list/restore/delete 与可选持久化回调 |
| `src/core/runtime/agent-runtime.js` | 暂停记录持久化、list/cancel、恢复时保留 permission context、修正 durable repair resume 形状 |
| `src/core/verification/repair-loop.js` | repair 审批暂停带 `repair_context.initial_tool_results` |
| `src/core/execution/executor-loop.js` | resume state 携带 permission context |
| `src/edits/edit-transaction.js` | 字节快照/恢复 API 与 owner/fault 钩子 |
| `src/edits/edit-service.js` | apply 外包 journal open/commit/abort |
| `src/sessions/rewind-transaction.js` | rewind journal 用字节快照/恢复 |
| `src/sessions/branch-store.js` | 分支状态 snapshot/restore |
| `src/sessions/rewind-service.js` | rewind journal 与分支状态恢复 |
| `src/index.js` | 恢复子系统、锁、扫描与 `kernel.recovery` 门面 |
| `src/apps/cli/render-events.js` | 恢复/takeover 生命周期事件安全摘要 |
| `src/apps/cli/kernel-runner.js` | `/recovery` REPL 命令与 takeover 提示路径 |
| `gui/kernel-host.js` | 向 GUI 暴露 recovery API |
| `gui/renderer/event-adapter.js` | 恢复事件摘要与状态通道映射 |
| `package.json` | 新恢复源文件进 `npm run check` |
| `README.md` | 实现后更新已知限制 |

测试文件（当时列出）：

```text
tests/unit/core/recovery/atomic-file.test.js
tests/unit/core/recovery/recovery-faults.test.js
tests/unit/core/recovery/project-lock.test.js
tests/unit/core/recovery/recovery-inbox.test.js
tests/unit/core/recovery/paused-turn-persistence.test.js
tests/unit/core/recovery/transaction-journal.test.js
tests/unit/core/recovery/recovery-service.test.js
tests/unit/core/approval/paused-turn-store.test.js
tests/unit/core/verification/repair-loop.test.js
tests/integration/v2-durable-paused-turn.test.js
tests/integration/v2-recovery-edit-journal.test.js
tests/integration/v2-recovery-rewind-journal.test.js
tests/integration/v2-recovery-center-kernel.test.js
tests/unit/apps/cli/kernel-runner.test.js
tests/unit/apps/cli/render-events.test.js
tests/unit/gui/kernel-host.test.js
tests/unit/gui/renderer-event-adapter.test.js
```

### 事件与类型名（当时锁定）

生命周期：

| 事件 | 含义 |
|------|------|
| `recovery:started` | 启动对账开始 |
| `recovery:blocked` | 恢复被锁/接管状态挡住 |
| `recovery:report` | 恢复报告摘要 |
| `takeover:requested` | 请求接管单写者 |
| `takeover:completed` | 接管完成 |

事务：`tx:opened`、`tx:committed`、`tx:recovered`。

暂停轮次：`turn:paused`、`turn:rehydrated`、`turn:resumed`、`turn:cancelled`。

内核恢复 API 形状：`kernel.recovery.list` / `resume` / `cancel` / `clear` / `report`。

项目类型名：`paused_turn`、`recovered_tx`、`blocked_recovery`、`takeover`、`quarantined_state`。

sidecar id 形态：`rec_pause_<approvalId>`、`rec_tx_<txId>`。

### 关键契约

**原子写（`atomic-file.js`）**

- `atomicWriteJson` / `atomicWriteBytes`：目录内临时文件 + rename。
- `atomicReadJson`：损坏 JSON 不拖垮启动。
- `safeRecoverySegment`：拒绝路径穿越。
- `cleanupAtomicTemps`：清理遗留临时文件。

**项目锁（`project-lock.js`）**

- 获取锁目录，写 owner 元数据与 epoch。
- 心跳维持活性。
- 接管请求文件 + interactive/takeover 参数。
- `assertOwner()` 在写关键状态前校验 epoch，拒绝陈旧所有者。

**暂停 sidecar**

- 保存/加载/删除/隔离（quarantine）损坏项。
- 项目范围扫描，支持启动时 list。
- 恢复时保留原 permission context，不放大权限。
- repair 暂停保留 `repair_context.initial_tool_results` 与 resume 形状。

**事务 journal**

- 字节快照与恢复工件。
- edit：apply 外包 open/commit/abort。
- rewind：rollback 计划外包 journal，并恢复分支状态。
- 提交矩阵区分 committed / recovered / aborted。

**Recovery Center**

- CLI `/recovery` 命令与 takeover 提示。
- GUI 经同一 `kernel.recovery.*` 暴露。
- 生命周期事件无载荷，只给类别与计数。

### 安全不变量

- 生命周期事件无载荷，不含源码、snippet、API key 或原始异常文本。
- 单活跃写者；锁冲突走 takeover/cancel 语义，epoch 校验防止陈旧所有者写入。
- 恢复不放大 autonomy/permission 权限；resume 保留原 permission context。
- edit/rewind journal 用字节快照，可把中断事务回滚到安全点。
- 测试用故障注入覆盖崩溃点；测试本身不在仓库根留下 `.deepseek-code/v2` 污染。

### 后续校准

当前实现里 durable recovery 默认关闭，需 `createKernel(root, { recovery: { enabled: true } })` 开启。这与 V2-20 guardrail 一致，内核提供机制，配置层决定策略。锁失败在测试环境可 `lockFailureMode: "warn"` 旁路。主 runtime 与 worker 可共享同一 paused-turn store，保证恢复记录对重建 worker 的 `approve()` 可见。编排级 durable recovery 在后续 V3 扩展。

### 自检覆盖（当时）

- 审批/repair durable 暂停 sidecar：Task 5、6、10、11、14。
- 原 autonomy/permission 语义：Task 6、11。
- edit 事务 journal 与回滚：Task 7、8、10、14。
- rewind 事务 journal 与分支恢复：Task 7、9、10、14。
- 单活跃写者与 takeover/cancel：Task 3、12、14。
- Recovery Center UX 与 API：Task 4、10、11、12、13。
- 无载荷生命周期事件：Task 2、10、12、13。
- 安全/隐私脱敏：Task 2、4、5、7、10、11、15。
- 故障注入与无 `.deepseek-code/v2` 污染：Task 1、14、15。

## 关键决策 / 遗留约束

| 决策 | 选择 | 否决 | 原因 |
|------|------|------|------|
| 架构 | 独立 recovery 子系统 | 散进 edit/rewind API | 对账与锁集中 |
| 持久单位 | sidecar + journal | 单一大状态文件 | 崩溃半状态可隔离 |
| 写者模型 | 单写者 + epoch | 多进程自由写 | 避免交错损坏 |
| 故障测试 | 确定性注入 | 只靠自然崩溃 | 可重复 |
| GUI | 共享 kernel recovery API | 各端私有恢复 | 行为一致 |
| 执行方式 | a/b/c 切片 | 一次大爆炸 | 体量过大，切片可交付 |

遗留约束：

- 保留 autonomy/permission 语义。
- 不在本阶段做 GUI 重设计。
- 不删 V2-19 负责的 legacy 清理项。
- 不加运行时依赖。
- Recovery Center 经 CLI `/recovery` 与 GUI 暴露同一模型。
- 类型名与 id 形态保持上表一致，避免恢复解析分叉。

## 验证

| 测试 | 锁定行为 |
|------|----------|
| `tests/unit/core/recovery/atomic-file.test.js` | 原子写、损坏容忍、安全路径段 |
| `tests/unit/core/recovery/recovery-faults.test.js` | 默认关闭、确定性注入 |
| `tests/unit/core/recovery/project-lock.test.js` | 获取、心跳、takeover、epoch |
| `tests/unit/core/recovery/recovery-inbox.test.js` | inbox 项模型 |
| `tests/unit/core/recovery/paused-turn-persistence.test.js` | sidecar 保存/加载/隔离/扫描 |
| `tests/unit/core/recovery/transaction-journal.test.js` | 字节快照、提交矩阵、恢复工件 |
| `tests/unit/core/recovery/recovery-service.test.js` | 启动对账与 `kernel.recovery.*` |
| `tests/integration/v2-durable-paused-turn.test.js` | 审批/repair 暂停跨重启 |
| `tests/integration/v2-recovery-edit-journal.test.js` | 中断 edit 事务恢复 |
| `tests/integration/v2-recovery-rewind-journal.test.js` | 中断 rewind 与分支状态恢复 |
| `tests/integration/v2-recovery-center-kernel.test.js` | list/resume/cancel/clear/report |
| `tests/integration/v2-kernel-recovery-journal.test.js`、`v2-recovery-service-journal.test.js` | 内核级 journal |
| CLI/GUI 摘要测试 | 无载荷泄漏 |

当时全量 `npm.cmd test`、`npm.cmd run check`、`git diff --check` 通过。污染检查确认测试不在仓库根生成 `.deepseek-code/v2`。

现对应入口：

- `src/core/recovery/recovery-service.js`
- `src/core/recovery/project-lock.js`
- `src/core/recovery/transaction-journal.js`
- `src/core/recovery/paused-turn-persistence.js`
