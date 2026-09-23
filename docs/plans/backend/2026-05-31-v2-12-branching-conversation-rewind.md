# V2-12 Branching Conversation Rewind

- 类型：实施计划
- 日期：2026-05-31
- 状态：已完成
- 关联：[CHANGELOG](../../CHANGELOG.md)、[V2-11 Transactional Edit](2026-05-31-v2-11-transactional-edit-dirty-workspace.md)、[设计](../../specs/backend/2026-05-31-v2-12-branching-conversation-rewind-design.md)

## 目标

加上重路线会话 rewind：分支感知时间线、checkpoint、预览/应用回退，以及活动分支续跑。

## 结果

分四段增量落地。`branch-store.js` 管持久分支元数据与活动分支；`session-manager.js` 给事件打分支戳并按分支过滤时间线；`checkpoint-index.js` 从追加式事件日志推导 rewind 目标与变更范围；`rewind-service.js` 创建子分支并用 V2-11 回滚安全恢复文件。

### 执行切片

| 切片 | 范围 |
|------|------|
| V2-12A | 分支基础：`branch-store.js`、session 打戳/过滤、内核 branch 门面 |
| V2-12B | `checkpoint-index.js`：目标解析与回滚计划 |
| V2-12C | rewind preview/apply、冲突、分支激活 |
| V2-12D | GUI/CLI 事件摘要与全量回归 |

### 文件结构

创建：

| 路径 | 职责 |
|------|------|
| `src/sessions/branch-store.js` | `br_main`、子分支、活动分支、激活、祖先链 |
| `src/sessions/checkpoint-index.js` | 纯函数：事件归一化、checkpoint、目标解析、回滚计划 |
| `src/sessions/rewind-service.js` | preview/apply、创建子分支、发布安全 rewind 事件 |
| `tests/unit/sessions/branch-store.test.js` | 分支持久化 |
| `tests/unit/sessions/checkpoint-index.test.js` | 目标解析 |
| `tests/unit/sessions/rewind-service.test.js` | preview/apply |
| `tests/integration/v2-branching-rewind.test.js` | 内核级分支 rewind |

修改：`session-manager.js`、`event-types.js`、`src/index.js`、`gui/kernel-host.js`、`src/apps/cli/render-events.js`、`package.json`，以及需要小改的 session/fake kernel 测试。

### 分支存储契约

`createBranchStore({ sessionRoot, projectId, sessionId })`，持久文件形态 `…/<projectId>/<sessionId>.branches.json`。

| 导出/方法 | 行为 |
|-----------|------|
| `BR_MAIN` | 主分支 id，惰性创建 |
| `getActiveBranchId()` | 默认 `br_main` |
| `listBranches()` | 分支元数据列表 |
| `createBranch({ parent_branch_id, forked_from_event_id, forked_from_seq, forked_from_turn_id, label })` | 创建子分支 |
| `activateBranch(branch_id)` | 未知 id 抛 `unknown branch` |
| `getAncestry(branch_id)` | 从根到当前的父链 |

重开 store 后活动分支与分支列表保持持久化状态。子分支记录 `parent_branch_id` 与 fork 点（event/seq/turn）。

### Checkpoint 与目标解析

`checkpoint-index.js` 只做纯计算：

- 归一化无分支历史事件。
- 推导 checkpoint（turn/event/seq 锚点）。
- 按 `event_id`、`seq`、`turn_id` 解析目标。
- 计算需要回滚的 change id 范围。

### Rewind 服务契约

| 方法 | 行为 |
|------|------|
| `preview({ target, branch_id })` | 只读；给出目标、文件列表、`rollback_change_ids`、计划分支 |
| `apply({ target, branch_id, force, label })` | 先 preview；捕获快照；逆序回滚 change；成功则创建并激活子分支 |

行为锁定：

- 运行时事件打上活动 `branch_id`。
- `getTimeline(count)` 保持向后兼容。
- 分支时间线过滤包含到 fork 点为止的祖先事件。
- preview 不写文件。
- rewind 永不直接写文件，始终调用 V2-11 rollback。
- 成功 rewind 创建并激活子分支；之后的新 turn 使用子分支 id。
- 脏冲突时活动分支不变，返回 `conflict` 类结果。
- 不改写既有 JSONL 事件。
- rewind 事件不含原始 diff 或文件正文。

### 事件契约

| 事件 | 含义 |
|------|------|
| `session:branch_created` | 新子分支 |
| `session:branch_activated` | 活动分支切换 |
| `session:rewind_preview` | 预览结果 |
| `session:rewind_started` | apply 开始 |
| `session:rewind_applied` | 成功 |
| `session:rewind_conflict` | 脏冲突 |
| `session:rewind_failed` | 失败 |

CLI `render-events.js` 提供短摘要；GUI host 暴露 branch/rewind 委托方法，供后续界面使用。

### 验收锁定清单（当时完成标准）

- 分支元数据持久化并可重开。
- 旧会话惰性创建 `br_main`。
- runtime 事件打上活动 `branch_id`。
- `getTimeline(count)` 向后兼容。
- 分支时间线过滤包含祖先事件到 fork 点。
- checkpoint 可按 `event_id`、`seq`、`turn_id` 解析。
- rewind preview 只读。
- rewind apply 逆序回滚 change。
- 成功 rewind 创建并激活子分支。
- 脏冲突不改活动分支。
- rewind 后未来 turn 使用子分支 id。
- GUI host 暴露 branch/rewind 委托。
- rewind 事件不含原始 diff 或文件正文。
- 全量测试、语法检查、空白检查、污染检查通过。

## 关键决策 / 遗留约束

| 决策 | 选择 | 否决 | 原因 |
|------|------|------|------|
| 数据模型 | 一开始就上分支 | 轻量线性 rewind | 后续恢复/对比需要真实拓扑 |
| 文件恢复 | 走 V2-11 回滚 | rewind 自写文件 | 复用事务与脏检测 |
| 目标解析 | event_id / seq / turn_id | 只支持行号 | 与事件日志对齐 |
| UI | 先 API 与摘要 | 本阶段做 GUI 面板 | 降低范围 |
| 时间线 | 过滤祖先事件 | 一次全量 dump | 分支视角可读 |

遗留约束：

- 不做 GUI 分支面板。
- 不改写既有 JSONL。
- 失败补偿与恢复类别见 V2-13。
- 跨进程 durable 恢复见 V2-18。
- 不加依赖。
- Windows 命令统一 `npm.cmd`。

## 验证

| 测试 | 锁定行为 |
|------|----------|
| `tests/unit/sessions/branch-store.test.js` | 惰性 `br_main`、子分支持久化、未知激活、祖先链 |
| `tests/unit/sessions/checkpoint-index.test.js` | 三种目标解析与回滚计划 |
| `tests/unit/sessions/rewind-service.test.js` | preview 只读、apply 逆序回滚、子分支激活 |
| `tests/unit/sessions/session-manager.test.js` | 打戳与分支过滤 |
| `tests/integration/v2-branching-rewind.test.js` | 内核级分支续跑与 rewind |
| `tests/unit/sessions/event-types.test.js`、CLI/GUI 摘要测试 | 事件注册与安全摘要 |

当时全量 `npm.cmd test`、`npm.cmd run check`、`git diff --check` 通过。测试数量应高于 V2-11 基线（443）。

现对应入口：

- `src/sessions/branch-store.js`
- `src/sessions/checkpoint-index.js`
- `src/sessions/rewind-service.js`
