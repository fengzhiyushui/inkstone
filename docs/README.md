# Inkstone 文档中心

本目录收录 Inkstone 的全部项目文档。所有文档按**类型**分目录,设计与计划再按**前端 / 后端 / 架构**细分,便于查阅与维护。

> 根目录的 [`README.md`](../README.md) 是项目入口;本文件是文档索引与维护规范。

---

## 目录结构

```
docs/
  README.md                 ← 本文件:文档索引 + 维护规范
  project-overview.md       ← 项目深入说明(架构/工具/编辑/恢复/安全/事件/目录)
  CHANGELOG.md              ← 项目变更日志(自 v1.0.0 起语义化版本)
  specs/                    ← 设计文档(design specs:目标、架构、取舍)
    architecture/           ← 跨端架构总览(V1/V2 运行时设计 + V3 路线图)
    backend/                ← 内核 / runtime / 工具 / 编辑 / 会话 / 恢复 设计
    frontend/               ← GUI / CLI / TUI 界面设计
  plans/                    ← 实施计划(implementation plans:分步落地)
    roadmap/                ← 宏观阶段(phase-0..5)与未来路线图
    architecture/           ← 跨端/仓库级实施计划(如品牌改名)
    backend/                ← 后端按特性的实施计划
    frontend/               ← 前端按特性的实施计划
  prototypes/               ← 历史静态原型存档(v1.2.0 自仓库根迁入);v1.4.0-redesign/ 为前端重设计稿(HTML,不接运行时,**终稿 = v4/**,索引见其 README)
```

**specs 与 plans 的区别**:`specs/` 回答"要做成什么样、为什么这么设计";`plans/` 回答"分几步、每步怎么做、怎么验证"。一个特性通常先有 spec 再有 plan。

---

## 文档维护规范与更新顺序

> ⚠️ 任何代码变更落地后,**按下表顺序**(代码 → 设计层 → 叙述层 → 索引)更新文档。每步都**条件触发**——与本次变更无关的就跳过,但先后不要打乱。照此路径走,接手者就能清楚"改了什么、为什么改、怎么用"。

| 阶段 | 顺序 | 文档 | 何时更新 |
|------|----|------|---------|
| **0 · 落地** | 1 | **代码** | 变更先落地,并通过 `npm test` / `npm run check` / `git diff --check` |
| **1 · 设计层**<br>(做成什么样 / 分几步) | 2 | `docs/specs/<area>/` | 设计变化时,更新对应设计文档,使其反映**实际形态**(非最初设想) |
| | 3 | `docs/plans/<area>/` | 勾掉已完成任务、登记新发现的子任务 |
| | 4 | [`project-overview.md`](project-overview.md) | 变更**触及架构 / 内核 / 工具 / 编辑回滚 / 恢复 / 安全 / 会话事件 / 配置 / 目录**时,同步这份内部总览(它是"活的"参考,非 per-feature spec) |
| **2 · 叙述层**<br>(面向读者) | 5 | [`CHANGELOG.md`](CHANGELOG.md) | 在 `[Unreleased]` 累积条目;发布时按[版本命名规则](#版本命名规则)定级、移入带版本号小节(并同步 `package.json` / `src/theme.js` 的版本) |
| | 6 | 根 [`README.md`](../README.md) **+ 英文镜像 [`README.en.md`](../README.en.md)** | **仅大版本(major)更新时重写**,何时重写由**开发者自行抉择**;重写时**中英两份门面必须同步**(改了中文就改英文)。其余文档维护顺序不受此影响 |
| **3 · 索引** | 7 | `docs/README.md`(本文件) | 仅当**新增 / 移动 / 删除**文档,需要同步结构图与索引时 |

**一句话顺序**:代码 → specs/plans → project-overview → CHANGELOG → 索引(主 README 中+英**仅大版本更新时重写,时机由开发者抉择**)。

**`<area>` 取值**:`backend`(内核/runtime)、`frontend`(GUI/CLI/TUI)、`architecture`(跨端架构)。

**新文档命名约定**:`YYYY-MM-DD-<topic>.md`(plan)、`YYYY-MM-DD-<topic>-design.md`(spec),与现有文件保持一致。

**目录约定**:spec 落 `docs/specs/<area>/`,plan 落 `docs/plans/<area>/`,不再增加其它分层。

---

## 版本命名规则

自 **v1.0.0**(2026-07-13,整合此前 V1/V2/V3 全部内部迭代)起,项目采用**语义化版本** `major.minor.patch`。三级的判定与本项目实际结合如下:

| 级别 | 形如 | 触发条件(结合本项目) | 由谁启动 |
|------|------|----------------------|---------|
| **大版本 major** | `v1.0.0` → `v2.0.0` | **大的功能更新**或**最新 DeepSeek 模型代际适配**;支柱级新能力(如新增「第四支柱」)、或触及核心运行时 / 内核契约的**破坏性重构** | **由维护者(用户)抉择并启动** —— 不自行发起 |
| **小版本 minor** | `v1.0.0` → `v1.1.0` | 大版本整体规划内的**小功能实现**:新增一个 slash 命令 / 一个内置工具 / 一档配置项 / 一门语言的语义支持 / 一次前端对齐(如 D-G4 这类展示层补齐)。**不重构软件核心功能** | 维护者规划内可直接推进 |
| **补丁 patch** | `v1.0.0` → `v1.0.1` | **文档更新**、**小漏洞修复**(如补 SSRF 黑名单、修渲染 bug、补测试)、依赖小升级;**不改变功能面** | 随手推进 |

**判定口诀**:动了「大能力 / 换模型代际 / 破坏性重构」→ 大版本(等用户拍板);大版本规划内加「不重构的小功能」→ 小版本;只动「文档 / 小修 / 测试」→ 补丁。

**发布时的版本落地**(patch 亦然):同步改 [`package.json`](../package.json) 的 `version` 与 [`src/theme.js`](../src/theme.js) 的 `VERSION`(TUI/CLI banner 显示它),并在 [`CHANGELOG.md`](CHANGELOG.md) 追加对应小节。

**与内部架构代号的区分**:内部文档里的「V2 内核 / V3 支柱」是**运行时架构代号与开发阶段**,**不是**产品版本号;产品版本自 v1.0.0 起单独按上表演进,二者是两条轴。

---

## 索引

### 项目说明(内部深入)
- [project-overview](project-overview.md) — **维护者视角的项目说明**:架构内核 · DeepSeek 适配 · 工具平面 · 编辑/回滚 · 持久化恢复 · 运行护栏 · 安全不变量 · 会话事件全集 · 存储布局 · 目录地图

### specs/architecture — 跨端架构
- [deepseek-code-v1-design](specs/architecture/2026-05-29-deepseek-code-v1-design.md) — V1 整体设计
- [deepseek-code-v2-clean-runtime-design](specs/architecture/2026-05-30-deepseek-code-v2-clean-runtime-design.md) — V2 干净运行时架构
- [v3-roadmap-design](specs/architecture/2026-06-24-v3-roadmap-design.md) — **V3 路线图**:四阶段 + 三支柱 + 目标 Agent 架构 + 三层多 agent + 前端三端
- [post-v3-roadmap-design](specs/architecture/2026-09-17-post-v3-roadmap-design.md) — **V3 之后路线图(草案,待拍板)**:收拢五处散落的"未来"碎片(D-G 未勾项 / 非目标 / 台账延后 / 重写报告 / v1.8 换肤审计)→ 一张处置表 → 装箱 v1.7.2 / v1.8.0 / 分发 / v1.9.0 / v2.0.0;§7 六项待维护者拍板

### specs/backend — 后端设计
- [v2-7 approval-resume](specs/backend/2026-05-30-v2-7-approval-resume-design.md)
- [v2-8 verifier-repair-loop](specs/backend/2026-05-31-v2-8-verifier-repair-loop-design.md)
- [v2-9 context-engine](specs/backend/2026-05-31-v2-9-context-engine-design.md)
- [v2-10 context-cache-usage-telemetry](specs/backend/2026-05-31-v2-10-context-cache-usage-telemetry-design.md)
- [v2-11 transactional-edit-dirty-workspace](specs/backend/2026-05-31-v2-11-transactional-edit-dirty-workspace-design.md)
- [v2-12 branching-conversation-rewind](specs/backend/2026-05-31-v2-12-branching-conversation-rewind-design.md)
- [v2-13 rewind-hardening-recovery](specs/backend/2026-05-31-v2-13-rewind-hardening-recovery-design.md)
- [v2-17 chat-kernel-unification](specs/backend/2026-05-31-v2-17-chat-kernel-unification-bypass-closure-design.md)
- [v2-18 durable-recovery-resume-hardening](specs/backend/2026-06-01-v2-18-durable-recovery-resume-hardening-design.md)
- [agent-layered-memory-design](specs/backend/2026-06-24-agent-layered-memory-design.md) — **Agent 分层记忆系统**:双记忆 + 七层 + 三级分化 + 巩固器
- [v3-phase-b semantic-context](specs/backend/2026-06-26-v3-phase-b-semantic-context-design.md) — **Phase B 语义级上下文引擎**:WASM tree-sitter 单解析栈 + 可靠静态子集 + unresolved 一等事实 + confidence/provider 扩展口(opt-in)
- [v3-phase-b+1 method-hints](specs/backend/2026-06-26-v3-phase-b-plus1-method-hints-design.md) — **B+1 方法消歧**:member-call 唯一匹配 → probable + CLI `--semantic-context` / `--include-method-hints`(默认关)
- [v3-phase-b+3 multi-language](specs/backend/2026-06-26-v3-phase-b-plus3-multi-language-design.md) — **B+3 扩语言**:tree-sitter query 统一抽取(JS/TS shadow-parity 迁移)+ Python(尽力静态模块解析 + 可配 import roots)
- [v3-phase-c1+c2 orchestration](specs/backend/2026-06-27-v3-phase-c1-c2-orchestration-design.md) — **C1+C2 多智能体编排**:统一入口 + 确定性路由器(单/多 agent 合并)+ Orchestrator/Planner/串行 Worker + **两级审核**(子自审 + 独立 Reviewer)+ 成本闸常开;复用 `agent-runtime` 实例,引擎不改
- [v3-phase-c3 parallel-isolation](specs/backend/2026-06-27-v3-phase-c3-parallel-isolation-design.md) — **C3 并行写隔离**:无依赖+不重叠子任务并行,每 Worker fs 拷贝隔离工作区 + 绑定该目录工具平面 → 每 subtask 原子事务回放合并(快照一致性 CAS + 实际范围校验 + 严格路径归一化 + 零残留 retry/启动清扫);`maxParallelWorkers=1` 退化串行零回归
- [v3-phase-c5 replan-resume](specs/backend/2026-06-27-v3-phase-c5-replan-resume-design.md) — **C5 重规划 + 持续派发**:确定性回合循环(`planner.replan→{done,subtasks}`,模型只产结构化、程序闸控终止)+ 严格 replan schema + 无进展守卫 + **同进程编排级续跑**(暂停存编排状态、`approve` 路由 orchestrator、不重 plan/不重复派发);`maxRounds=1` 退化 C1+C2 零回归
- [v3-phase-c-router tiered](specs/backend/2026-06-27-v3-phase-c-router-tiered-design.md) — **C-Router 分层路由**:启发式评分三档(明显简单/复杂免费短路、模糊中间档调一次便宜模型判 lane)+ 长 edit 捕手修「关键词太窄」+ 文件 token 归一化首个免计 + 模型档总调用/总超时上限 + 全失败收敛启发式兜底;**默认开**、`router.model.enabled=false` opt-out 逐字节回今天(`agent-runtime`/`classifier` 不改)
- [v3-phase-c4 experience-memory](specs/backend/2026-06-27-v3-phase-c4-experience-memory-design.md) — **C4 跨任务经验记忆(完整)**:独立经验库 + 三级分化(打分/老化/末位淘汰)+ Jaccard 聚簇去重 + 巩固器(次 agent 任务边界异步)+ planner 检索注入(adopted=used∩presented)+ **风险经验单调升级权限**(只 allow→ask、不改 agent-runtime)+ 开关 off/on/gated;默认 off 零回归
- [v3-phase-c-durable orchestration-recovery](specs/backend/2026-06-27-v3-phase-c-durable-orchestration-recovery-design.md) — **C-Durable 跨进程编排级 durable 恢复**:暂停双写(worker turn sidecar + 编排 sidecar,同 approvalId)→ 重启扫描交叉校验(schema+指纹+归属门)→ `worker-factory` 确定性重建 + 共享 `pausedTurnStore` 重水化 approve → 续跑不重 plan;5 边界(孤儿 blocked / 不存 raw options / 版本指纹门 / approval 归属 / 预算续扣);opt-in `recovery.enabled`,默认关,`agent-runtime` 一行未改
- [agent-findings remediation](specs/backend/2026-07-12-agent-findings-remediation.md) — **agent 审计发现补救台账**:10 条目根因/改法/验证与处理状态(#1–#5 ✅ v1.1.0;#6/#7(env)/#9 易项 ✅ v1.2.0;#8/#9.3/#9.6/#10 挂账)
- [v1.2.0 agent-findings-p2 design](specs/backend/2026-07-17-v1.2.0-agent-findings-p2-design.md) — **v1.2.0 设计**:grep 每文件+总超时 · shell env 白名单继承(不放行代理) · #9 卫生易项;#8/#9.3/#9.6/#10 明确非目标

### specs/frontend — 前端设计
- [v2-14 gui-workbench-branch-rewind](specs/frontend/2026-05-31-v2-14-gui-workbench-branch-rewind-design.md)
- [v2-15 natural-agent-workbench](specs/frontend/2026-05-31-v2-15-natural-agent-workbench-design.md)
- [v2-16 gui-interaction-hardening](specs/frontend/2026-05-31-v2-16-gui-interaction-hardening-design.md)
- [v2-frontend-workbench-redesign](specs/frontend/2026-05-31-v2-frontend-workbench-redesign-design.md)
- [v3-phase-d1 gui-react-shell](specs/frontend/2026-06-27-v3-phase-d1-gui-react-shell-design.md) — **D-1 GUI React 外壳**:渲染层迁 React+Vite(原案含 Semi UI,实施中弃用改**手写 VS Code 风格**,见 spec 内 pivot 节;后端 IPC 不改)+ reducer 复用/不可变防线 + 布局契约 + a11y 基线 + 占位强标记 + 依赖门控测试
- [v3-phase-d2 gui-functional](specs/frontend/2026-07-01-v3-phase-d2-gui-functional-design.md) — **D-2 GUI 做真**:真文件树(path-safety 边界)+ Monaco 只读(本地 worker)+ 实时 Agent 卡片派生 + node-pty 交互终端(注入可测/降级)+ language 持久化;kernel 零改动
- [v3-phase-d3 gui-full-functional](specs/frontend/2026-07-02-v3-phase-d3-gui-full-functional-design.md) — **D-3 GUI 全功能 + 设置页**:切视图/搜索 + 标题栏菜单 + 真状态栏 + 面板派生 + 分支切换/rewind + 可编辑保存(整文件 diff → editService)+ 设置页(7 组 + API 列表管理 + 模型获取无默认/失败报错);API Key 掩码不回明文,kernel 零改动
- [v3-phase-d4 gui-change-tracking](specs/frontend/2026-07-02-v3-phase-d4-change-tracking-design.md) — **D-4 GUI agent 改动跟踪**:SCM「AGENT 改动」分区(来源标签 agent/手动 + 已回滚标)→ 主区「修改前 vs 修改后」对比(方案 C:记录内 before/after 直喂 DiffEditor,零 diff 反推)+ hunk chips 跳编辑器(行号 clamp);只读桥 `changes:list` 列表瘦身 / `changes:describe` 单文件切片;kernel 零改动
- [v3-phase-d5 tui-redesign](specs/frontend/2026-07-06-v3-phase-d5-tui-redesign-design.md) — **D-5 TUI 重设计**:行内滚动流 agent 会话(原生滚动区 + 底部固定输入/状态栏)+ 流式 onDelta 透传 + 工具/diff/审批卡片 + slash 补全 + /config 共享 api-profiles(激活重建 kernel 保上下文);手写 ANSI,zh/en 双语,kernel 核心零改动
- [v1.4.0 frontend-redesign](specs/frontend/2026-07-28-v1.4.0-frontend-redesign-design.md) — **v1.4.0 前端界面整体重做(✅ 设计定稿 + 已实现,终稿 = prototypes/v1.4.0-redesign/v4/)**:GUI 借鉴 Codex/Claude Desktop、TUI 仿 opencode;10 套主题(3 浅 7 深)单一 token 源,色值取自各方案官方定义源并通过 WCAG 对比度校验;五轮 HTML 稿迭代定型(侧栏=功能区/项目分区/独立对话,每项目独立分区内挂会话、新建会话继承项目目录;指标 5 形态可选;TUI 首页 opencode 构图 + /theme + /shell);已在 feat/v1.4 分支按 plan 实施完成;kernel 零改动
- [v1.8.0 ergo-restyle](specs/frontend/2026-09-17-v1.8.0-ergo-restyle-design.md) — **v1.8.0 工学换肤(✅ 已评审 2026-09-17)**:换视觉语言不换信息架构;10 套主题重编为**四段带**(暗 3 / 柔暗 2 / 柔明 2 / 明 3——正文 ≥7:1 闸门使中灰 L90–164 成死区,"过渡"只能两侧各自延伸);卡片两段式 + composer 柔光 + 主题中枢;γ 分层落地(DOM 冻结)、β 重建保留为升级口;不做粒子与网格,极简舒适;对比度闸门升级为常驻单测
- [v1.8.1 dsh-shell](specs/frontend/2026-09-20-v1.8.1-dsh-shell-design.md) — **壳层重构 · DSH 参照 · β 路径(✅ 已实施 feat/v1.8)**:三列可拖拽 + 右栏 dock + 模态设置 + 中性阶梯 token;零引用外部代码;B0–B4 分层
- [D-G7 gui-recovery-center](plans/frontend/2026-09-15-d-g7-gui-recovery-center.md) — **✅ v1.7.1**:GUI Recovery Center(收 V2-18 Task 13);kernel-host 代理 + IPC + RecoveryView

### plans/roadmap — 宏观阶段
- [phase-0 kernel-foundation](plans/roadmap/2026-05-29-phase-0-kernel-foundation.md)
- [phase-1 core-intelligence](plans/roadmap/2026-05-29-phase-1-core-intelligence.md)
- [phase-2 security-extension](plans/roadmap/2026-05-30-phase-2-security-extension.md)
- [phase-3 experience](plans/roadmap/2026-05-30-phase-3-experience.md)
- [phase-4 gui](plans/roadmap/2026-05-30-phase-4-gui.md)
- [phase-5 polish](plans/roadmap/2026-05-30-phase-5-polish.md)

### plans/architecture — 仓库级/跨端实施计划
- [inkstone-rebrand](plans/architecture/2026-07-31-inkstone-rebrand.md) — **Inkstone 改名实施方案(已实施,合入 main)**:DeepSeek Code → Inkstone;品牌暴露面全改(显示/结构/公开面),`.deepseek-code` 存储目录与 `DEEPSEEK_*` env 等契约保留,api 端点与模型 id 不动;P0–P6 分 commit 执行 + 收口 grep 允许清单

### plans/backend — 后端实施计划
- [v3-phase-b semantic-context](plans/backend/2026-06-26-v3-phase-b-semantic-context.md) — **Phase B 实施计划**:15 任务 TDD(ParserProvider → extractor → indexer → dependency-graph → symbol-selector → 门面接线 → 文档)
- [v3-phase-b+1 method-hints](plans/backend/2026-06-26-v3-phase-b-plus1-method-hints.md) — **B+1 实施计划**:6 任务 TDD(member_property → 唯一匹配 probable + Map neighbors → engine 透传 → kernel-options 合并 → CLI 标志 → 文档)
- [v3-phase-b+3 multi-language](plans/backend/2026-06-26-v3-phase-b-plus3-multi-language.md) — **B+3 实施计划**:12 任务 / M1–M6(query-runner + JS/TS shadow-parity 迁移 → Python 尽力静态解析 → 退役旧 extractor)
- [v3-phase-c1+c2 orchestration](plans/backend/2026-06-27-v3-phase-c1-c2-orchestration.md) — **C1+C2 实施计划**:12 任务 / M1–M6(schema + 确定性路由器 → 工具子集 + worker/reviewer 工厂 → planner → 派发循环 + synth → orchestrator + kernel 接线 → 回归 + 文档)
- [v3-phase-c3 parallel-isolation](plans/backend/2026-06-27-v3-phase-c3-parallel-isolation.md) — **C3 实施计划**:8 任务 / M1–M8(path-overlap → workspace-snapshot → iso-workspace → buildToolPlane 重构 → merge-back(净 diff+CAS) → batch-planner → 批次并行派发 → config+sweep+文档)
- [v3-phase-c5 replan-resume](plans/backend/2026-06-27-v3-phase-c5-replan-resume.md) — **C5 实施计划**:8 任务 / M1–M8(validateReplan+fingerprint → planner.replan → config.maxRounds → dispatch 暂停/续跑 → orchestrator 回合循环 → 同进程续跑 → kernel 路由+终判+e2e → 回归+文档)
- [v3-phase-c-router tiered](plans/backend/2026-06-27-v3-phase-c-router-tiered.md) — **C-Router 实施计划**:4 任务 / M1–M4(router-scoring 纯函数 → task-router 分层+模型档 → config 归一化+index 注入+route_resolved 事件 → e2e+回归 670+文档)
- [v3-phase-c4 experience-memory](plans/backend/2026-06-27-v3-phase-c4-experience-memory.md) — **C4 实施计划**:M0–M9 / TDD(契约 → store 写队列 → scoring → cluster → upsert → consolidator → retrieval+planner → orchestrator 接线 → permission 单调升级 → gated+e2e+回归 739+文档)
- [v3-phase-c-durable orchestration-recovery](plans/backend/2026-06-27-v3-phase-c-durable-orchestration-recovery.md) — **C-Durable 实施计划**:M0–M8 / TDD(契约层 → orchestration-persistence → budget 种子+serializeState → 共享 store → resumeDurable → 暂停双写 → recovery-service 扫描+孤儿 blocked → index 接线+durable approve → 跨实例 e2e+回归 782+文档)
- [v1.2.0 agent-findings P2](plans/backend/2026-07-16-v1.2.0-agent-findings-p2.md) — **v1.2.0 实施计划**:审计挂账有界收口(#6 grep 超时 · #7 shell env 白名单 · #9 卫生易项 9.1/9.2/9.4/9.5/9.7;#8/#9.3/#10 延后)
- v2-0 skeleton-protocol-foundation · v2-1 deepseek-gateway · v2-2 tool-plane · v2-3 edit-service · v2-4 runtime-loop · v2-6 release-closure · v2-7 approval-resume · v2-8 verifier-repair-loop · v2-9 context-engine · v2-10 context-cache-usage-telemetry · v2-11 transactional-edit-dirty-workspace · v2-12 branching-conversation-rewind · v2-13 rewind-hardening-recovery · v2-17 chat-kernel-unification · v2-18 durable-recovery-resume-hardening · **v2-20a runtime-cost-timeout-guardrails** · **v2-20b guardrail-injection-graceful-stop** · **v2-20c malformed-toolcall-retry** · **v2-20d resume-path-guardrail-alignment** · **v2-20e repair-path-model-timeout** · **v2-20f guardrail-defaults-config** · **v2-19 delete-v1-legacy** · **v2-18c edit-rewind-journaling**
- 文件位于 [`plans/backend/`](plans/backend/)

### plans/frontend — 前端实施计划
- [v1.7.2 gui-defects](plans/frontend/2026-09-17-v1.7.2-gui-defects.md) — **v1.7.2 GUI 三处现有缺陷 + 敏感模态截图欠账(patch)**:agent 回复从不入流 / 状态行数据首屏一次不刷新 / `.sn-*` 引用 7 个未定义 CSS 变量;各附 HEAD 复现证据、失败测试全文、内容锚点;**v1.8.0 P2 的硬前置**
- [v1.8.1 dsh-shell plan](plans/frontend/2026-09-20-v1.8.1-dsh-shell-plan.md) — **v1.8.1 壳层重构实施方案(B0 骨架 → B1 token → B2 侧栏/会话页 → B3 右栏 dock → B4 设置模态/收口)**:全量搬设计事实、零引用外部代码(B0 首个任务即守卫测试);附录 A 逐项标注取值来源;前置 v1.8.0(**✅ 已实施完成**,feat/v1.8)
- [v1.8.0 ergo-restyle plan](plans/frontend/2026-09-17-v1.8.0-ergo-restyle-plan.md) — **v1.8.0 工学换肤实施方案(P0 tokens 地基 → P1 壳层视觉 → P2 卡片/推理摘要/外观 → P3 收口)**:每层文件路径 / 断言值 / 验收命令写到零上下文可执行;附录 A 六套新主题色值(两名独立复核 110 项闸门);前置 v1.7.2(**✅ 已实施完成**,1107 测试全绿,P0–P3 四层各自五项准入)
- [v2-5 interface-migration](plans/frontend/2026-05-30-v2-5-interface-migration.md)
- [v2-14 gui-workbench-branch-rewind](plans/frontend/2026-05-31-v2-14-gui-workbench-branch-rewind.md)
- [v2-15 natural-agent-workbench](plans/frontend/2026-05-31-v2-15-natural-agent-workbench.md)
- [v2-16 gui-interaction-hardening](plans/frontend/2026-05-31-v2-16-gui-interaction-hardening.md)
- [v2-frontend-workbench-redesign](plans/frontend/2026-05-31-v2-frontend-workbench-redesign.md)
- [future-gui-deepseek-code-ide-redesign](plans/frontend/2026-06-01-future-gui-deepseek-code-ide-redesign.md)
- [gui-frontend-optimization-plan](plans/frontend/gui-frontend-optimization-plan.md)
- [v3-phase-d1 gui-react-shell](plans/frontend/2026-06-27-v3-phase-d1-gui-react-shell.md) — **D-1 实施计划**:M1–M8(reducer ESM/不可变 → 纯函数 layout/loads/panels → vite 构建接线 → 四栏组件+布局+a11y → 数据接线 → 主题+占位 → smoke+截图 → 回归+文档)
- [v3-phase-d2 gui-functional](plans/frontend/2026-07-01-v3-phase-d2-gui-functional.md) — **D-2 实施计划**:M1–M7(文件桥+language → 树+reducer → Monaco 只读 → 卡片派生 → pty-host → xterm+node-pty → build/smoke/文档)
- [v3-phase-d3 gui-full-functional](plans/frontend/2026-07-02-v3-phase-d3-gui-full-functional.md) — **D-3 实施计划**:M1–M11(配置桥+API 列表+listModels → 切视图/搜索 → 标题栏菜单 → 面板派生 → 保存 diff → 设置视图 → 标题/状态栏 → 分支切换 → rewind → 可编辑+diff → build/smoke/截图/文档)
- [v3-phase-d4 gui-change-tracking](plans/frontend/2026-07-02-v3-phase-d4-change-tracking.md) — **D-4 实施计划**:M1–M5(只读改动桥 list/describe+IPC → changes-derive+reducer+卡片字段修复 → useKernel 桥+SCM 分区+i18n → ChangeDiffView+hunk 跳转+卡片可点 → 门控 smoke+全量回归+文档)
- [v3-phase-d5 tui-redesign](plans/frontend/2026-07-06-v3-phase-d5-tui-redesign.md) — **D-5 实施计划**:T1–T15(ansi/input/i18n/reducer → 事件卡片 → painter → 组合根+薄入口替换 → slash 补全 → api-profiles 迁移+model-catalog+config-flow+/config 接线 → 门控 pty smoke+回归+文档)
- [v1.4.0 frontend-redesign-plan](plans/frontend/2026-07-31-v1.4.0-frontend-redesign-plan.md) — **v1.4.0 前端重构实施方案(✅ 已实施完成,998 测试全绿)**:现状摸底(GUI 已带 React/Electron 依赖、TUI 主包零依赖、会话可枚举、项目注册表/MCP/插件为空洞)→ 技术决策(栈不换、渲染层原地重写、v4 tokens 单源、kernel 零改动、MCP/插件仅概念预览)→ P0 地基(token 管线+项目/会话数据层)→ P1 GUI 骨架(侧栏项目分区+会话视图+指标 5 形态)→ P2 二级界面 → P3 TUI(首页+/theme+/shell,可并行)→ P4 收口;R1–R6 风险对策(kernel 重建切项目、旧会话只读回放保底等)

---

## 版本与里程碑

当前版本 **v1.8.1**(2026-09-20,壳层重构:三列可拖拽 + 右栏 dock + 设置模态 + 中性阶梯 token;v1.8.0 为工学换肤)。首个正式版本 v1.0.0 整合此前全部内部迭代;完整能力总结与后续版本日志见 [`CHANGELOG.md`](CHANGELOG.md),版本升级判定见上文[版本命名规则](#版本命名规则)。**每个已发布版本在 git 中有对应的带注解 tag**(`git tag -l` / `git show v1.7.2`)。

v1.0.0 的开发历程分三代(详细里程碑见上方 specs/plans 索引与 git 历史):**V1 原型** → **V2 干净运行时**(内核统一 / 工具平面 / 编辑回滚 / 验证修复 / 上下文引擎 / 分支 rewind / 持久化恢复 / 运行护栏)→ **V3 三支柱**(语义级上下文 · 多智能体调度 · 前端三端重构 + CLI 对齐 D-G4)。
