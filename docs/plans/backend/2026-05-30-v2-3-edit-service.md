# V2-3 Edit Service

- 类型：实施计划
- 日期：2026-05-30
- 状态：已完成
- 关联：[CHANGELOG](../../CHANGELOG.md)、[V2-2 Tool Plane](2026-05-30-v2-2-tool-plane.md)

## 目标

把成熟的 legacy unified diff、变更记录与回滚流水包装进 `src/edits` 服务边界，让 V2 编辑工具 `diff_preview`、`diff_apply`、`diff_rollback`、`edit` 变成真实现。

## 结果

`createEditService({ projectRoot })` 暴露 `preview`、`apply`、`rollback`、`describe`、`list`。写路径仍经 `ToolExecutor` 与权限引擎。编辑服务负责 diff 规范化、路径预检、preview 元数据、变更记录、回滚与编辑事件。

V2-3 把 V2 编辑工具做实，方式是把成熟的 legacy unified diff、change record、rollback 流水包进新的 `src/edits` 服务边界。V0 CLI 继续用 `src/patch.js` 与 `src/changes.js`；V2 的 `diff_preview`、`diff_apply`、`diff_rollback`、`edit` 改走干净的 `EditService`。

### 文件结构

```text
src/edits/diff-parser.js
src/edits/change-store.js
src/edits/rollback-service.js
src/edits/edit-service.js
tests/unit/edits/diff-parser.test.js
tests/unit/edits/change-store.test.js
tests/unit/edits/edit-service.test.js
tests/integration/v2-edit-tools-kernel.test.js
```

修改：`src/index.js`、`src/sessions/event-types.js`、`src/tools/builtin/edit-deferred.js`、`tests/unit/sessions/event-types.test.js`、`tests/unit/tools/builtin-network-memory.test.js`、`package.json`。

### 模块契约

| 模块 | 导出与行为 |
|------|------------|
| `src/edits/diff-parser.js` | `normalizeUnifiedDiff`（剥离 fenced）、`parseDiff`、`formatDiffSummary`、`assertDiffPathsSafe`。路径预检走 V2 `resolveWorkspacePath()`。 |
| `src/edits/change-store.js` | legacy 变更捕获/收尾/列表/描述的包装。 |
| `src/edits/rollback-service.js` | legacy 回滚包装；V2-11 再加 `force` 与脏冲突检测。 |
| `src/edits/edit-service.js` | 内置工具消费的公开服务：`preview` / `apply` / `rollback` / `describe` / `list`。 |
| `src/tools/builtin/edit-deferred.js` | 只做工具元数据与服务分发，不内嵌 diff 逻辑。 |

### 复用的 legacy 函数

保留、未删除（`src/patch.js` / `src/changes.js`）：

- `extractUnifiedDiff`
- `parseUnifiedDiff`
- `summarizeDiff`
- `applyUnifiedDiff`
- `captureChangePlan`
- `finalizeChange`
- `listChanges`
- `describeChange`
- `rollbackChange`

### 行为锁定

- 工具结果形状对齐 `ToolExecutor`：`{ status?, content, metadata }`。
- `preview({ diff })` 解析 fenced 或 plain unified diff，校验路径，不写文件、不建变更记录。metadata 含摘要、文件列表、hash/size 等，不含原始 diff 正文。
- `apply({ diff, prompt, approval_id })` 在 `capture()` 与 `applyUnifiedDiff()` 之前跑 `assertDiffPathsSafe()`。预检用 `mustExist: false`，边界违规先于缺文件错误。
- `apply()` 经 `applyUnifiedDiff()` 落盘，并在 `.deepseek-code/changes/<change_id>.json` 收尾变更记录。
- `rollback({ change_id })` 按 id 恢复；`diff_rollback` 类别保持 `write_update`，不归 `destructive`（恢复记录状态，不删任意用户数据）。
- supervised 写编辑返回 `approval_required` 且不写文件；gated 可应用 update diff。
- 路径穿越与 symlink 逃逸的 diff 在任何写入前拒绝。

### 事件契约

| 事件 | 内容边界 |
|------|----------|
| `file:diff_preview` | 路径列表、摘要、hash/size；无原始 diff |
| `file:diff_applied` | change id、文件列表；无原始 diff |
| `file:rollback_applied` | change id、恢复范围；无原始 diff |

完整 diff 正文只在工具 metadata 需要时返回，不进 session 事件。metadata 可含 hash、size、summary、file list、change id。

### 与内核的关系

- `createKernel` 在 `options.editService` 缺省时创建默认 `EditService`。
- `buildToolPlane` 把 editService 注入 `createBuiltinTools`。
- `diff_preview`、`diff_apply`、`diff_rollback`、`edit` 经 `kernel.tools.execute()` 可用。
- 权限决策仍由 `ToolExecutor` 统一处理，服务层不绕过。
- V2-2 的延迟编辑占位错误被真实服务分发取代。

### 验收锁定清单（当时完成标准）

- `createEditService({ projectRoot })` 暴露 `preview`、`apply`、`rollback`、`describe`、`list`。
- `preview()` 解析 fenced 或 plain unified diff，不写文件。
- `apply()` 在 legacy capture/apply 前校验每个 old/new 路径。
- 路径预检用 `mustExist: false`。
- `apply()` 经 `applyUnifiedDiff()` 写文件。
- `apply()` 在 `.deepseek-code/changes/<change_id>.json` 收尾变更记录。
- `rollback()` 按 change id 恢复。
- 四工具经 `kernel.tools.execute()` 可用。
- `diff_apply` 与 `edit` 仍走 ToolExecutor 权限。
- supervised 返回 `approval_required` 且不写文件。
- gated 可应用 update diff。
- 路径穿越与 symlink 逃逸在写入前拒绝。
- 发布 `file:diff_preview`、`file:diff_applied`、`file:rollback_applied`。
- 编辑事件不含原始 diff 正文。
- `npm.cmd test`、`npm.cmd run check`、`git diff --check` 通过。

## 关键决策 / 遗留约束

| 决策 | 选择 | 否决 | 原因 |
|------|------|------|------|
| legacy 处理 | 先包装后重构 | 直接改写 patch/changes | V0 继续可用，风险隔离 |
| 路径预检 | V2 层 realpath | 只靠 legacy 词法解析 | 边界一致、错误语义可控 |
| apply 原子性 | 本阶段仅服务边界 | 多文件事务回滚 | 留给 V2-11，避免一次改太多 |
| artifact 存储 | 只记 hash/size 元数据 | 独立工件库 | 变更记录文件已够用 |
| rollback 类别 | `write_update` | `destructive` | 恢复记录态，不是任意删除 |
| preview | 只读 | 顺手落记录 | 预览不应有副作用 |

遗留约束：

- 不改 `src/patch.js` / `src/changes.js` 行为，除非测试证明包装做不到。
- 不删 legacy V0 文件。
- 不接模型 runtime 循环（V2-4）。
- 不做语义补丁修复；repair 路径后续处理。
- 原始 diff 不进 session 事件。
- 不加依赖。
- Windows 命令统一 `npm.cmd`。

## 验证

| 测试 | 锁定行为 |
|------|----------|
| `tests/unit/edits/diff-parser.test.js` | fenced/plain 规范化、parse/summary、路径预检与逃逸拒绝 |
| `tests/unit/edits/change-store.test.js` | capture/finalize/list/describe 包装 |
| `tests/unit/edits/edit-service.test.js` | preview 只读、apply 预检次序、rollback、事件无 diff |
| `tests/integration/v2-edit-tools-kernel.test.js` | 四工具经 kernel 可用；supervised 审批停；gated 可写 |
| `tests/unit/sessions/event-types.test.js` | `file:rollback_applied` 等注册 |

当时全量 `npm.cmd test`、`npm.cmd run check`、`git diff --check` 通过。

现对应入口：

- `src/edits/edit-service.js` 的 `preview` / `apply` / `rollback`
- `src/edits/diff-parser.js`
- 事务与脏回滚见 V2-11
- durable journal 见 V2-18
