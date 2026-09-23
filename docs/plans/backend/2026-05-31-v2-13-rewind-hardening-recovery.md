# V2-13 Rewind Hardening & Recovery

- 类型：实施计划
- 日期：2026-05-31
- 状态：已完成
- 关联：[CHANGELOG](../../CHANGELOG.md)、[V2-12 Branching Rewind](2026-05-31-v2-12-branching-conversation-rewind.md)、[设计](../../specs/backend/2026-05-31-v2-13-rewind-hardening-recovery-design.md)

## 目标

让 branching rewind 在回滚已成功、但后续分支创建/激活/更晚回滚失败时，能把工作区文件补偿恢复回来。

## 结果

新增 `rewind-transaction.js` 做快照/恢复，`rewind-service.js` 的 `apply()` 包上补偿逻辑。恢复事件注册进事件表，界面只加事件摘要。

### 文件结构

创建：

| 路径 | 职责 |
|------|------|
| `src/sessions/rewind-transaction.js` | 内存快照/恢复与安全错误类别 |
| `tests/unit/sessions/rewind-transaction.test.js` | 快照/恢复与错误类别 |

修改：

| 路径 | 变更 |
|------|------|
| `src/sessions/rewind-service.js` | apply 事务补偿、安全错误类别、恢复事件 |
| `src/index.js` | `createRewindService()` 传 `projectRoot: root` |
| `src/sessions/event-types.js` | 注册恢复事件 |
| `src/apps/cli/render-events.js` | 恢复事件短摘要 |
| `package.json` | 新模块进 `npm run check` |
| `tests/unit/sessions/rewind-service.test.js` | 分支创建/激活失败、后续回滚失败/冲突 |
| `tests/unit/sessions/event-types.test.js`、`tests/unit/apps/cli/render-events.test.js` | 事件与摘要 |
| `tests/integration/v2-branching-rewind.test.js` | 内核级恢复 |

### 快照/恢复契约

`captureRewindSnapshots(root, paths)` / `restoreRewindSnapshots(root, snapshots)` / `safeRewindError(error, stage)`。

| 行为 | 语义 |
|------|------|
| 捕获 | 既有文件记 `before` 与 `before_hash`；缺失文件 `existed_before: false` |
| 元数据安全 | `before` 正文不进可序列化 metadata |
| 恢复 | 恢复被改文件，删除 rewind 过程中创建的文件 |
| 路径穿越 | `../outside.txt` 等拒绝 |
| 错误类别 | 只返回类别字符串，从不返回原始异常文本 |

`safeRewindError` 映射：

| stage | 类别 |
|-------|------|
| `create_branch` | `branch_create_failed` |
| `activate_branch` | `branch_activate_failed` |
| `rollback` | `rollback_failed` |
| `restore` | `restore_failed` |
| 其他 | `rewind_failed` |

### 结果状态语义

| 情况 | status |
|------|--------|
| 回滚成功后分支创建失败 | `failed_restored` |
| 回滚成功后分支激活失败 | `failed_restored` |
| 更晚回滚失败（更早回滚已完成） | `failed_restored` |
| 更晚回滚冲突 | `conflict_restored` |
| 补偿恢复本身失败 | `failed_unrestorable` |
| 脏冲突且未改文件 | `conflict` |
| 全部成功 | 成功并激活子分支 |

失败/恢复后活动分支保持不变。

### 事件契约

| 事件 | 边界 |
|------|------|
| `session:rewind_restore_started` | 目标与文件计数 |
| `session:rewind_restored` | 恢复结果类别 |
| `session:rewind_recovery_failed` | `failed_unrestorable` 等 |

恢复事件不含原始 diff、hunk、文件正文、snippet 或原始异常文本。`rewind.preview()` 仍只读。成功路径仍创建并激活子分支。

### 验收锁定清单（当时完成标准）

- `rewind.preview()` 仍只读。
- 成功 rewind 仍创建并激活子分支。
- 分支创建失败后返回 `failed_restored`。
- 分支激活失败后返回 `failed_restored`。
- 后续回滚失败返回 `failed_restored`。
- 后续回滚冲突返回 `conflict_restored`。
- 恢复本身失败时结果为 `failed_unrestorable`。
- 失败/恢复后活动分支不变。
- 恢复事件已注册并有摘要。
- 恢复事件不含原始 diff、hunk、文件正文、snippet 或原始异常文本。
- 全量测试、语法检查、空白检查、污染检查通过。

## 关键决策 / 遗留约束

| 决策 | 选择 | 否决 | 原因 |
|------|------|------|------|
| 补偿范围 | 内存快照恢复 | 先做磁盘 journal | 本阶段修 rewind 半失败，durable 在 V2-18 |
| 错误对外 | 类别字符串 | 原始 message | 避免泄漏路径/内容 |
| 成功路径 | 保持原语义 | 补偿逻辑污染成功分支 | 行为稳定 |
| 测试接线 | 经 branch facade 注入 | 测试专用钩子 | 生产结构一致 |
| 恢复顺序 | 按捕获逆序 | 任意顺序 | 与文件依赖一致 |

遗留约束：

- 补偿恢复只在内存；跨进程崩溃 durable recovery 留给 V2-18。
- 不加 GUI 分支面板。
- 不改写既有 JSONL。
- 集成测试若 monkey-patch 分支门面影响不到已创建 rewind service，优先改 `createRewindService()` 的依赖注入，而不是加测试钩子。
- 不加依赖。
- Windows 命令统一 `npm.cmd`。

## 验证

| 测试 | 锁定行为 |
|------|----------|
| `tests/unit/sessions/rewind-transaction.test.js` | 捕获/恢复、路径穿越拒绝、`safeRewindError` 映射 |
| `tests/unit/sessions/rewind-service.test.js` | 四类失败补偿与 `failed_unrestorable` |
| `tests/unit/sessions/event-types.test.js` | 恢复事件注册 |
| `tests/unit/apps/cli/render-events.test.js` | 摘要不泄漏正文 |
| `tests/integration/v2-branching-rewind.test.js` | 临时 root 内核级恢复 |

当时全量 `npm.cmd test`、`npm.cmd run check`、`git diff --check` 通过。测试数量应高于 V2-12 基线（465）。

现对应入口：

- `src/sessions/rewind-transaction.js`
- `src/sessions/rewind-service.js`
