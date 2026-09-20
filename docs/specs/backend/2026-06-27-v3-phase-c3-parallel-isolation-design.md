# DeepSeek Code V3 Phase C3 · 并行 Worker 写隔离(fs 拷贝 + 回放合并)设计

> 类型:后端设计 spec(backend)
> 日期:2026-06-27
> 状态:已评审,待转实施计划
> 关联:[C1+C2 多智能体编排](2026-06-27-v3-phase-c1-c2-orchestration-design.md)(本片在其上)· [V3 路线图](../architecture/2026-06-24-v3-roadmap-design.md) §7.4

---

## 1. 背景与目标

C1+C2 已落地:Orchestrator 把任务拆成子任务,**串行**经 Worker 执行(`dispatch-loop.js` 顺序跑)。**C3 目标**:让**无依赖且文件范围不重叠**的子任务**并行**执行,且并行 Worker 改文件**互不污染** —— 每个并行 Worker 在**隔离的工作区拷贝**里改,完成后把改动**事务性回放合并**进主工作区。

**机制决策(已评审)**:用 **fs 拷贝隔离工作区**,**不用字面 git worktree**。原因:`git worktree` 从已提交 ref 检出,看不到未提交/脏改动(agent 干活时工作区常脏;同一次编排里前面串行批次的改动落在主区也是未提交的)→ Worker 会站在过时基线上。fs 拷贝抓当前精确状态(含脏),无需 git 语义,合并 = 把不重叠的净 diff 经主 `editService` 重放。

**延续约束**:`agent-runtime.js` 一行不改;编排确定性;成本闸常开;**默认零回归**(`maxParallelWorkers=1` 或批大小=1 时与 C1+C2 串行逐字节一致)。

---

## 2. 范围与非目标

**做**:并行批次划分(依赖 + 不重叠)· 每 Worker fs 拷贝隔离工作区 + 绑定该目录的工具平面 · 快照一致性校验(乐观并发)· 实际写入范围校验 · 严格路径归一化 · 每 subtask 原子事务回放合并(批次部分成功)· 零残留(retry 删除 + 启动清扫)· 成本/并发闸。

**不做(留后续)**:git 原生隔离(用 fs 拷贝替代)· 合并冲突子任务自动重跑(MVP 标失败)· **有依赖**子任务并行(只并行独立 + 不重叠)· 跨进程并行 · 大仓库增量拷贝优化(超阈值回退串行)。

---

## 3. 架构与数据流

```
dispatch-loop(C1+C2 串行) ──C3──> batched dispatch
   topoOrder(subtasks) → 切批:
      一批 = { 依赖已完成 } ∩ { 声明范围两两不重叠 } 的最大集
      (无声明范围 / 范围重叠 / 依赖未满足 → 不同批,落单)
   for each batch:
      if batch.size == 1 或 maxParallelWorkers == 1:
         直接在主区跑(== C1+C2,无拷贝)           ← 零回归路径
      else:
         parallel(batch, cap=maxParallelWorkers):  ← 并发
            isoRoot = fsCopyWorkspace(mainRoot)     ← 排除 .git/node_modules/.deepseek-code
            baseManifest = hashTree(isoRoot)        ← path→hash 快照
            toolPlane = buildToolPlane(isoRoot)     ← 绑定 isoRoot 的 editService/registry/executor
            worker = createRuntime({ executeTool: toolPlane.execute, project_root: isoRoot, toolSchemas: 子集 })
            wres = worker.send(...)                 ← 关卡1 自审(内置)
            verdict = reviewer.review(...)          ← 关卡2 独立审核
            actual = changedPaths(isoRoot, baseManifest)
            校验 actual ⊆ 声明范围 && 批内 actual 不重叠   ← 实际写入范围校验
            finally: removeIso(isoRoot)             ← 零残留(retry+backoff)
      merge(批内通过的 worker,按 subtask id 顺序):
         每 subtask:净 diff(isoRoot vs baseManifest)→ 校验主区 path hash==base →
            一次 editService.apply()(原子)→ 落主区 change 记录;冲突/校验失败 → 回滚标失败
```

并行只在「多个独立 + 不重叠」子任务时发生;其余走 C1+C2 串行原路。批次划分、合并顺序均为**程序逻辑(确定性)**;并发是唯一非确定点,但合并按固定 id 序串行 → 结果确定。

---

## 4. 硬约束(实施判据)

### 4.1 事务粒度(写死)
- **每个 subtask 的全部改动 = 一次原子事务**:整 subtask 落主区,或全回滚。实现:对该 subtask 算**一份净 unified diff**(isoRoot 终态 vs baseManifest,仅其实际改动路径),**一次** `editService.apply()`(已有事务 + 日志 + 回滚)。
- **批次 = 部分成功**(显式,非整批 all-or-nothing):同批可有的 subtask 合并成功、有的标失败;互不牵连。Synthesizer 照 C1+C2 诚实汇报成功/失败。

### 4.2 快照一致性(乐观并发 / CAS)
- 拷贝时记 `baseManifest`:`path → sha256`,覆盖整拷贝树(受 `maxCopyFiles` 限)。
- **合并每个被触碰路径前**校验主区当前态 == base:
  - 修改:`hash(mainRoot/path) === baseManifest[path]`。
  - 新建:`baseManifest[path]` 不存在 **且** 主区 `path` 不存在。
  - 删除:`hash(mainRoot/path) === baseManifest[path]`。
- 任一不符(主区被用户 / 其他批 / 外部改过)→ **冲突** → 该 subtask 回滚(apply 事务天然回滚)、标失败、不污染主区。

### 4.3 实际写入范围校验(不信声明)
- Worker 结束后用 `baseManifest` 算**实际**改动路径集 `actual`(增/删/改)。
- 断言 `actual ⊆ 声明范围`(`context_scope.files`,目录含子路径);**并**重新校验**批内各 worker 的 `actual` 两两不重叠**(防声明不重叠但实际越界撞车)。
- 越界或实际重叠 → 该 subtask **失败**(MVP 不自动重跑);不把越界改动合进主区。

### 4.4 路径归一化(严格,防 Windows 漏网)
`normalizePath(p)` = 分隔符归一 `/` + 去 `./` + **Windows 小写折叠**(大小写不敏感 FS)+ 尽力 `realpath` 解符号链接 + 统一为「主区相对、posix」。重叠判定 `overlaps(a,b)` = 归一化后**相等**或**目录包含**(`a/` ⊇ `a/b.js`)。create/delete/**rename 登记新旧两路径**(rename = del old + add new)。声明范围里的目录条目按目录包含展开。

### 4.5 零残留(抗 Windows 文件句柄)
- iso 目录:`.deepseek-code/v2/orchestration/iso/<runId>/<subtaskId>/`;每 run 写一个 `iso/<runId>/.owner`(pid + 起始时间戳)。
- 每 worker 用完 **`finally` 必删**,删除带 **retry + backoff**(应对 Windows EBUSY/EPERM 句柄滞留:如 3 次,间隔 50/150/350ms);仍失败仅记 `warning`,不影响主流程。
- **启动清扫**:orchestrator/kernel 初始化时扫 `iso/`,**只删**「`.owner` 超 TTL(默认 1h)**或** 标记为当前进程上次 run」的目录 —— 带 owner+TTL 守卫,**绝不误删另一仍在跑的 run**(跨进程虽非目标,清扫逻辑亦安全)。

### 4.6 降级与回退
- 工作区文件数 > `maxCopyFiles` → 该批**跳过隔离、回退串行**(避免巨拷贝),记 log。
- 拷贝失败 / 工具平面构造失败 → 该批回退串行;**永不崩**。
- `maxParallelWorkers=1` → 全程串行(== C1+C2)。

---

## 5. 组件(新增于 `src/core/orchestration/`,+ `index.js` 重构)

| 单元 | 职责 |
|------|------|
| `workspace-snapshot.js` | `fsCopyWorkspace(srcRoot, destRoot)`(排除 `.git`/`node_modules`/`.deepseek-code`,受 `maxCopyFiles`)· `hashTree(root)→Map<path,hash>` · `changedPaths(root, baseManifest)→{added,deleted,modified}` |
| `path-overlap.js` | `normalizePath` · `overlaps(setA,setB)` · `withinScope(actualPaths, declaredScope)`(§4.4) |
| `iso-workspace.js` | iso 目录生命周期:`createIso(runId, subtaskId)` · `removeIso(dir)`(retry+backoff)· `sweepOrphans({ ttlMs, ownerTag })`(§4.5) |
| `merge-back.js` | `mergeSubtask({ mainEditService, mainRoot, isoRoot, baseManifest, actual })`:净 diff → §4.2 校验 → 一次 `editService.apply`;冲突→失败 |
| `batch-planner.js` | `toBatches(orderedSubtasks, { completedIds, maxParallelWorkers })`:依赖 + 不重叠切批(§3) |
| `dispatch-loop.js`(改) | 由「逐 subtask 串行」改为「逐**批**」;批大小 1 / 并发=1 走原路;>1 走并行 + 隔离 + 合并 |
| `index.js`(重构) | 抽 `buildToolPlane(root) → { editService, toolRegistry, toolExecutor, execute }`;主区与各 iso 区共用此工厂;`createRuntime` 支持注入 `executeTool` + `project_root` |
| `config.js`(改) | `orchestration.parallel = { maxParallelWorkers, maxCopyFiles, sweepTtlMs }` |

**`buildToolPlane(root)`**:把现 `index.js` 内联的 `createEditService`/`createToolRegistry`/`createToolExecutor` 构造抽成以 `root` 为参的工厂。主区构造调它(行为不变);每个 iso 区调它得到绑定 isoRoot 的工具平面。`agent-runtime` 仍不改(只是 `executeTool`/`project_root` 注入不同值)。

---

## 6. 配置

```text
config.orchestration.parallel = {
  maxParallelWorkers: 4,     // 1 = 全串行(== C1+C2,零回归逃生口)
  maxCopyFiles: 5000,        // 工作区超此 → 该批回退串行
  sweepTtlMs: 3600000        // iso 启动清扫 TTL(1h)
}
```
`normalizeOrchestration`(config.js)加 `parallel` 子块,per-field 深合并 + 安全默认。**无独立 on/off**:`maxParallelWorkers` 即旋钮(=1 关并行)。

---

## 7. 测试策略(node:test,确定性优先)

- **batch-planner**:依赖 + 不重叠正确切批;有依赖 / 范围重叠 / 无声明范围 → 落单批;`maxParallelWorkers=1` → 全单批。
- **path-overlap**:Windows 大小写、分隔符、目录包含、rename 双路径、符号链接归一后判重叠;`withinScope` 越界检出。
- **workspace-snapshot**:拷贝排除大目录、含脏改动;`hashTree` / `changedPaths`(增删改)正确。
- **iso-workspace**:`removeIso` retry 成功;`sweepOrphans` 删超 TTL、**保留 owner 内/未超 TTL**(不误删活跃)。
- **merge-back**:不重叠净 diff 干净落主区(主区有 change 记录);**主区被改过 → CAS 失败 → 回滚标失败、主区不变**;越界改动 → 失败。
- **零残留**:成功 / 失败 / 抛异常 三路径后 iso 目录均不存在;启动清扫扫掉遗留。
- **事务粒度**:一个 subtask 多文件改动 = 一次 apply;中途校验失败 → 该 subtask 全回滚(无半落地)。
- **dispatch 集成**:多独立不重叠子任务并行 + 合并;部分成功(一个越界失败、其余成功)。
- **确定性**:同 plan → 同合并结果(合并按 id 序)。
- **回归**:C1+C2 dispatch-loop 测试 + 全量 594 全绿(默认不破坏串行语义)。

---

## 8. 里程碑(供拆实施计划)

```text
M1  path-overlap(normalize/overlaps/withinScope)+ 单测
M2  workspace-snapshot(fsCopy 排除大目录 / hashTree / changedPaths)+ 单测
M3  iso-workspace(createIso / removeIso retry / sweepOrphans owner+TTL)+ 单测
M4  index.js 抽 buildToolPlane(root)(主区行为不变,回归绿)+ createRuntime 支持注入 executeTool/project_root
M5  merge-back(净 diff + §4.2 CAS 校验 + 原子 apply + 冲突回滚)+ 单测
M6  batch-planner(依赖+不重叠切批)+ 单测
M7  dispatch-loop 接批次并行(批=1 走原路;>1 隔离+实际范围校验+合并)+ 集成测试 + 零残留测试
M8  config.parallel + 透传 + 回归 594 全绿 + 文档(README 中英 / CHANGELOG / project-overview §14 补 C3)
```

> M1–M3、M5、M6 全可纯单测(不打真模型、不依赖真编排);M4 是纯重构(回归守);M7 才组装真并行链路。严格分段降风险。

---

## 9. 开放问题(实施前/中再定)
- `maxParallelWorkers` / `maxCopyFiles` / `sweepTtlMs` 默认值(给安全起点,实测调)。
- `hashTree` 是否只对「声明范围 + 实际改动路径」算 hash(省成本)而非整树 —— 倾向:拷贝时整树记 manifest 上限 `maxCopyFiles`,合并只查被触碰路径(够用且省)。
- rename 检测:MVP 用「del old + add new」近似(不做 git 式相似度 rename 跟踪)。
- 净 diff 生成器:复用现有 `diff-parser` 反向?或直接逐文件生成 unified diff —— 实施时定最小可用方案。
