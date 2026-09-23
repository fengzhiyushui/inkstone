# V3 Phase C3 并行 Worker 写隔离 Implementation Plan

- 类型：实施计划
- 日期：2026-06-27
- 状态：已完成
- 关联：[C1+C2 orchestration](2026-06-27-v3-phase-c1-c2-orchestration.md)、[CHANGELOG](../../CHANGELOG.md)

## 目标

让「无依赖 + 声明文件范围不重叠」的子任务并行执行：每个并行 Worker 在 fs 拷贝隔离工作区里改动，完成后经快照一致性校验 + 每 subtask 原子事务回放合并进主工作区。`maxParallelWorkers=1` 或批大小=1 时与 C1+C2 串行逐字节一致。

## 结果

在 C1+C2 的 `dispatch-loop` 上加一层批次（依赖 + 不重叠切批）。并行批内每 Worker：fs 拷贝主区 → 记 `baseManifest`（path→sha256）→ `buildToolPlane(isoRoot)` 给一套绑定隔离目录的工具 → 隔离 runtime 执行 → 自审 + 独立审核 → 实际写入范围校验 → `finally` 删隔离区。合并：每 subtask 算净 unified diff（整文件替换），CAS 校验主区 path hash==base，一次 `editService.apply`（原子）；冲突/越界 → 回滚标失败。

Shared interfaces：

```text
// path-overlap.js
normalizePath(p) -> string
  // 归一: 分隔符→/、去 ./、win32 小写折叠、posix 相对
overlaps(setA, setB) -> boolean   // 相等或目录包含
withinScope(actualPaths, declaredFiles) -> string[]   // 越界路径; [] = 全在范围内

// workspace-snapshot.js
fsCopyWorkspace(srcRoot, destRoot, { maxCopyFiles }) -> { copied, truncated }
hashTree(root, { maxCopyFiles }) -> Map<posix path, "sha256:...">
changedPaths(root, baseManifest) -> { added, deleted, modified }

// iso-workspace.js
createIso({ root, runId, subtaskId }) -> isoRoot 绝对路径(已建 + 写 .owner)
removeIso(isoRoot, { retries, backoffMs }) -> Promise<boolean>
sweepOrphans({ root, ttlMs, pid }) -> Promise<string[]>   // 清掉的目录

// merge-back.js
makeUnifiedDiff(path, baseContent|null, finalContent|null) -> string
  // 整文件替换 diff(new/delete/modify)
mergeSubtask({ editService, mainRoot, isoRoot, baseManifest, actual })
  -> { ok, change_id?, reason? }

// batch-planner.js
toBatches(orderedSubtasks, { completedIds, maxParallelWorkers }) -> SubTask[][]

// index.js
buildToolPlane(root, { eventBus, permissionEngine, recoveryJournal,
                       assertOwner, webFetch, defaultToolTimeoutMs })
  -> { editService, toolRegistry, toolExecutor, execute }
```

配置 `orchestration.parallel = { maxParallelWorkers: 4, maxCopyFiles: 5000, sweepTtlMs: 3600000 }`。

## 关键决策 / 遗留约束

- **`agent-runtime.js` 一行不改**：Worker 仍是 `createAgentRuntime` 实例，经 `createRuntime` 注入 `executeTool`（隔离工具平面）+ `projectRoot`（isoRoot）+ `toolSchemas` 子集。
- **编排确定性**：切批、合并顺序均程序逻辑；合并按 subtask id 升序；并发是唯一非确定点，合并串行固定序 → 结果确定。
- **事务粒度**：每个 subtask 全部改动 = 一次原子事务（整 subtask 落主区 or 全回滚）；批次 = 部分成功（显式，非整批 all-or-nothing）。
- **快照一致性（CAS）**：合并每个被触碰路径前校验主区 == base（改：`hash==base`；增：base 无且主区无；删：`hash==base`）；不符 → 冲突 → 该 subtask 回滚标失败，不污染主区。
- **实际写入范围校验**：Worker 结束后用 `baseManifest` 算实际改动路径；断言实际 ⊆ 声明范围且批内实际改动两两不重叠。越界/重叠 → 该 subtask 失败，不信 `context_scope.files`。
- **路径归一化严格**：`normalizePath` = 分隔符→`/` + 去 `./` + Windows 小写折叠 + posix 相对；`overlaps` = 归一后相等或目录包含；create/delete/rename 登记新旧两路径。符号链接真实解析由 `path-safety` 在写入时兜底；overlap 守卫用字符串归一，保确定可测。
- **零残留**：每 Worker `finally` 必删，删除带 retry + backoff（抗 Windows EBUSY/EPERM）；启动清扫带 owner(pid)+TTL，只删「超 TTL 或当前进程上次 run」，绝不误删活跃 run。
- **降级永不崩**：工作区文件数 > `maxCopyFiles` / 拷贝失败 / 工具平面构造失败 → 该批回退串行，记 log。
- **默认零回归**：`maxParallelWorkers=1` 或批大小=1 → 走 C1+C2 串行原路；现有 594 全绿。

## 验证

`tests/core/orchestration/` 下 path-overlap（分隔符归一、目录包含、withinScope）、workspace-snapshot、iso-workspace（removeIso retry、sweepOrphans 不误删）、merge-back（净 diff 往返、CAS 冲突）、batch-planner、c3-parallel-e2e。零残留断言、`maxParallelWorkers=1` 零回归。当时基线 594 全绿。当前入口 `src/core/orchestration/{path-overlap,workspace-snapshot,iso-workspace,merge-back,batch-planner}.js`、`src/config.js` 的 `orchestration.parallel`、`src/index.js` 的 `buildToolPlane`。

## 任务覆盖（as-built 映射）

| 里程碑 | 内容 |
|--------|------|
| M1 | path-overlap |
| M2 | workspace-snapshot |
| M3 | iso-workspace |
| M4 | merge-back |
| M5 | batch-planner |
| M6 | dispatch 批次并行 + settleWorker |
| M7 | 合并 + 零残留 |
| M8 | 配置接线 + e2e + 文档 |

最大风险是 Task 7（批次并行 + 合并 + 零残留）与 Task 5（净 diff 往返真 editService）。判据明确：集成测试 + 往返测试 + CAS 冲突测试 + 零残留断言；M4 纯重构有 594 回归兜底，`maxParallelWorkers=1` 永远是零回归逃生口。
