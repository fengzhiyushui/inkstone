# Phase C3 · 并行 Worker 写隔离（fs 拷贝 + 回放合并）

- 类型：后端 spec
- 日期：2026-06-27
- 状态：已实现
- 关联：[C1+C2 编排](2026-06-27-v3-phase-c1-c2-orchestration-design.md)

---

## 问题与目标

C1+C2 子任务串行。C3 让无依赖且文件范围不重叠的子任务并行，并在隔离工作区拷贝中改文件，完成后事务性回放合并进主区。隔离用 fs 拷贝而非 git worktree：worktree 看不到未提交/脏改动，会站在过时基线上。

## 决策

| 决策点 | 选择 | 否决项 | 理由 |
|---|---|---|---|
| 隔离 | fs 拷贝当前树（含脏） | git worktree | 基线精确 |
| 合并 | 净 diff 经主 `editService.apply` 回放 | 直接 cp 文件 | 复用事务/日志/回滚 |
| 事务粒度 | 每 subtask 一次原子 apply | 批级 all-or-nothing | 部分成功更实用 |
| 并发安全 | baseManifest CAS + 实际范围校验 | 信声明 | 防越界撞车 |
| 并行条件 | 依赖完成 + 声明范围不重叠 | 有依赖也并行 | 正确性优先 |
| 默认 | `maxParallelWorkers=1` 等价串行 | 默认并行 | 零回归逃生口 |

## 设计

### 流程

```
topoOrder → toBatches（依赖完成 + 不重叠最大集）
  批大小 1 或并发 1 → 主区原路（C1+C2）
  否则并行：
    isoRoot = fsCopyWorkspace（排除 .git/node_modules/.deepseek-code）
    baseManifest = hashTree(isoRoot)
    toolPlane = buildToolPlane(isoRoot)
    worker.send → 审核 → actual = changedPaths
    校验 actual ⊆ 声明范围 && 批内 actual 不重叠
    finally removeIso
  合并（按 subtask id 序）：
    净 diff → 主区 path hash == base → 一次 editService.apply
    冲突/失败 → 回滚标失败
```

### 硬约束

- 每 subtask 全部改动 = 一次原子事务；批次可部分成功。
- 合并前 CAS：主区当前 hash 必须等于 baseManifest；不符即冲突，该 subtask 失败不污染主区。
- 不信声明：用 baseManifest 算 actual，断言 ⊆ `context_scope.files` 且批内两两不重叠。
- 路径归一：分隔符、`./`、Windows 小写、尽力 realpath；`overlaps` 支持目录包含；rename 记旧+新两路径。
- 零残留：iso 目录 `.deepseek-code/v2/orchestration/iso/<runId>/<subtaskId>/`，finally 删除带 retry/backoff；启动清扫只删 owner 超 TTL（默认 1h）或本进程遗留。
- 降级：超过 `maxCopyFiles`（默认 5000）或拷贝失败 → 该批回退串行，不崩。

### 组件

`workspace-snapshot.js`（`fsCopyWorkspace` / `hashTree` / `changedPaths`）、`path-overlap.js`、`iso-workspace.js`、`merge-back.js`、`batch-planner.js`；`dispatch-loop.js` 改为按批；`index.js` 抽 `buildToolPlane(root)`。

```js
config.orchestration.parallel = { maxParallelWorkers: 4, maxCopyFiles: 5000, sweepTtlMs: 3600000 }
```

## 边界与不变量

1. `agent-runtime.js` 不改，只注入不同 `executeTool` / `project_root`。
2. 并发=1 或批=1 时与 C1+C2 一致。
3. 合并按固定 id 序，结果确定。
4. 不做 git 原生隔离、冲突自动重跑、有依赖并行、跨进程并行。

## 与现状的差异

实现导出以 `src/core/orchestration/{workspace-snapshot,path-overlap,iso-workspace,merge-back,batch-planner}.js` 为准。

## 验收

切批/归一化/快照/清扫/合并 CAS/越界失败可单测；多独立子任务并行后主区干净合并；部分成功如实汇报；iso 零残留。入口 `npm test`。
