# Inkstone 文档中心

本目录收录 Inkstone 全部项目文档。按类型分目录：**设计（`specs/`，7 篇领域 Living Spec）**与**实施（`plans/`，现役计划 + 历史归档）**。根目录 [`README.md`](../README.md) 是项目入口；本文件是索引与维护规范。

---

## 目录结构

```text
docs/
  README.md                 文档索引与维护规范（本文件）
  DEPLOYMENT_AND_USAGE.md   本地部署与使用指南
  project-overview.md       维护者深入说明（架构/工具/编辑/恢复/安全/事件/目录）
  CHANGELOG.md              变更日志
  specs/                    设计：做成什么样、为什么（Living Specs，随实现更新）
    architecture/
      system-architecture.md      架构演进、路线图与一核三端原则
      mcp-subsystem.md            MCP Client v2 全量设计（v1.11–v1.17）
    backend/
      runtime-and-execution.md    运行时、审批、验证修复、成本护栏、v1.18 运行闭环
      context-and-memory.md       文件/WASM 语义上下文、多语言、分层记忆与经验库
      orchestration.md            分层路由、Planner/Worker/Reviewer、并行写隔离、重规划、task 委派
      edits-sessions-recovery.md  事务编辑、分支 Rewind、跨进程恢复与审计台账
    frontend/
      workbench-and-surfaces.md   GUI 三列壳层、Inspector、TUI 与三端事件契约
  plans/                    实施：分几步、怎么验证
    HISTORICAL_PLANS_ARCHIVE.md   63 篇历史过程计划的压缩归档（索引表）
    architecture/
      2026-11-03-v1.19-streamlining-plan.md   v1.19 架构收敛与全栈精简三阶段计划
```

`specs/` 与 `plans/` 的分工：spec 写目标、架构与取舍，描述**当前实现**；plan 写任务拆分与验收。历史已完成的 plan 不再保留逐步 checkbox，统一压缩为 [`HISTORICAL_PLANS_ARCHIVE.md`](plans/HISTORICAL_PLANS_ARCHIVE.md) 的索引表；原始过程文件在 git 历史（pre-v1.19 `main`）中可查。

---

## 文档维护顺序

代码变更落地后，按下列顺序更新（与本次无关的步骤跳过，但不要打乱先后）：

| 顺序 | 文档 | 何时更新 |
|------|------|----------|
| 1 | 代码 | 先落地，并通过 `npm test` / `npm run check` / `git diff --check` |
| 2 | `docs/specs/<area>/` | 设计变化时，改成与**实际实现**一致（Living Spec 直接改正文，不新增历史碎片） |
| 3 | `docs/plans/` | 登记新任务；已完成的计划收成摘要并入归档表 |
| 4 | [`project-overview.md`](project-overview.md) | 架构 / 内核 / 工具 / 编辑回滚 / 恢复 / 安全 / 会话事件 / 配置 / 目录变化时 |
| 5 | [`CHANGELOG.md`](CHANGELOG.md) | 在 `[Unreleased]` 累积；发布时按版本规则定级并写入版本小节 |
| 6 | 根 [`README.md`](../README.md) | **仅大版本（major）更新时重写**，时机由维护者决定 |
| 7 | 本文件 | 新增 / 移动 / 删除文档时同步索引 |

一句话顺序：代码 → specs/plans → project-overview → CHANGELOG → 索引。

`<area>` 取值：`architecture`、`backend`、`frontend`。

**命名**：Living Spec 用 `<topic>.md`（无日期前缀，因为内容是现状而非时点快照）；新计划用 `YYYY-MM-DD-<topic>.md`，落 `docs/plans/architecture/` 或对应 `<area>/`。不再增加其它分层。

---

## 版本命名规则

自 **v1.0.0**（2026-07-13）起采用语义化版本 `major.minor.patch`：

| 级别 | 示例 | 触发条件 | 由谁启动 |
|------|------|----------|----------|
| major | `v1.x` → `v2.0.0` | 大功能、DeepSeek 模型代际适配、支柱级能力、触及核心运行时 / 内核契约的破坏性重构 | 维护者拍板 |
| minor | `v1.9.0` → `v1.10.0` | 大版本规划内的小功能：slash 命令、内置工具、配置档、一门语言的语义支持、一次前端对齐 | 规划内可直接推进 |
| patch | `v1.10.0` → `v1.10.1` | 文档更新、小漏洞修复、测试补齐、依赖小升级；不改功能面 | 随手推进 |

判定口诀：大能力 / 换模型代际 / 破坏性重构 → major（等拍板）；规划内小功能 → minor；文档 / 小修 / 测试 → patch。

发布时同步四处代码版本：`package.json`、`package-lock.json`、`src/theme.js` 的 `VERSION`（TUI/CLI banner）、`gui/src/App.jsx` 的 `VERSION`，并更新 `CHANGELOG.md` 版本小节。git 中每个已发布版本有对应带注解 tag。

**与内部架构代号的区分**：文档里的「V2 内核 / V3 支柱」是运行时架构与开发阶段，不是产品版本号。产品版本自 v1.0.0 起单独演进。

---

## 开发分支与版本管理规范（预览探索期 · 方式 A 版）

在项目当前开发未发行/预览探索阶段，为了兼顾敏捷迭代的高效性与 Git 历史图谱的清晰美观，严格遵循以下分支与合并规范：

1. **远端单主干架构（Trunk-based）**：
   - GitHub 远端原则上**仅保留唯一的 `main` 主干分支**，代表对外公开展示的基准线；
   - 所有大版本演进（v1、v2）自然在 `main` 主干向前推进，不设平行的长期大版本开发分支；
   - 严禁在远端堆积未完成的临时功能分支，保持远端仓库 100% 清爽整洁。

2. **小版本本地独立冲刺（Local Ephemeral Sprints）**：
   - 针对规划中的小版本特性包（如 `v1.16` 或 `v2.1`），**仅在本地迁出分支**（如 `git checkout -b codex/v1.16`）；
   - **严禁向 GitHub 远端推送小版本分支**，确保开发与试错 100% 隔离在本地沙箱。

3. **冲刺周期内免发细碎 Patch**：
   - 在本地小版本开发期间，无论是增加新特性、修复 Bug 还是补充测试，一律作为常规 Commit 提交在分支内（如 `feat:`、`fix:`、`test:`）；
   - **严禁在冲刺期间细分 `vX.Y.1`、`vX.Y.2` 等碎片补丁版本号**，亦不打细碎 Tag，避免版本号与 Tag 泛滥。

4. **方式 A 结构化合入（`--no-ff` 阶段大环）**：
   - 本地全部功能开发完成，并通过 `npm test` 与 `npm run check` 质量门禁验收；
   - 切回 `main` 分支，采用**非快进合并（`--no-ff`）**合入小版本：
     ```bash
     git checkout main
     git merge --no-ff <小版本分支> -m "release(vX.Y): <特性集描述>"
     ```
   - 确保合入 `main` 的是一个包含多个 commit 的“有意义的功能包大环”，彻底杜绝单提交气泡；
   - 在合入节点打上唯一带注解里程碑 Tag（如 `git tag -a vX.Y-preview -m "Inkstone vX.Y preview"`）；
   - 推送至远端：`git push origin main --tags`；
   - 合并完成后，立即清理删除本地临时分支：`git branch -d <小版本分支>`。

---

## 索引

### 部署与使用
- [DEPLOYMENT_AND_USAGE](DEPLOYMENT_AND_USAGE.md) — 系统准备、极速部署、GUI 构建、模型配置、三端教程、排错

### 项目说明
- [project-overview](project-overview.md) — 架构内核、DeepSeek 适配、工具平面、编辑/回滚、恢复、护栏、安全、事件、存储、目录

### specs/architecture
- [system-architecture](specs/architecture/system-architecture.md) — 架构演进（V1 原型 → V2 干净运行时 → V3 三支柱 → v1.x 产品化）、一核三端原则、`createKernel` 组合根、turn 生命周期与路线图
- [mcp-subsystem](specs/architecture/mcp-subsystem.md) — MCP Client v2 全量设计：dual-era 协议、三种传输、工具治理、内容与提示词、OAuth、诊断、试跑、取消、MRTR 人工输入与列表订阅（实现至 v1.17.0）

### specs/backend
- [runtime-and-execution](specs/backend/runtime-and-execution.md) — 执行循环、审批与恢复、验证-修复循环、畸形 tool-call 有界重试、运行护栏、用量遥测、请求级聚合总预算（R18-01）、v1.18.0 运行闭环与审计台账
- [context-and-memory](specs/backend/context-and-memory.md) — 上下文引擎与缓存、workspace-indexer 跳过规则、WASM 语义上下文（JS/TS/Python）、多语言扩展、分层记忆与跨任务经验库
- [orchestration](specs/backend/orchestration.md) — 确定性路由器与 C-Router 分层、Planner/Worker/Reviewer、两级审核、并行写隔离与 CAS 合并、重规划与同进程续跑、`task` 子委派、跨进程编排级 durable 恢复
- [edits-sessions-recovery](specs/backend/edits-sessions-recovery.md) — EditService、事务编辑与脏工作区检测、变更记录卫生（大小上限 / 保留期 / 截断守卫）、敏感文件提醒、分支 Rewind、持久化恢复与事务日志

### specs/frontend
- [workbench-and-surfaces](specs/frontend/workbench-and-surfaces.md) — GUI 演进与 v1.8.1 三列壳层规格、数据接入与 IPC 白名单、改动跟踪、Inspector、设置页、MCP GUI、TUI 十模块、三端共享事件展示契约

### plans/
- [HISTORICAL_PLANS_ARCHIVE](plans/HISTORICAL_PLANS_ARCHIVE.md) — 63 篇历史过程计划的压缩归档（roadmap / architecture / backend / frontend 八张索引表）+ 7 篇 Living Spec 索引
- [2026-11-03-v1.19-streamlining-plan](plans/architecture/2026-11-03-v1.19-streamlining-plan.md) — v1.19「架构收敛与全栈精简优化专项」计划（阶段一 v1.19.0、阶段二 v1.19.1、阶段三 v1.19.2、阶段四 v1.19.3 已全部实施）

> 已删除：`docs/plans/{roadmap,backend,frontend}/` 与 `docs/plans/architecture/` 下的 63 篇过程碎片、`docs/specs/` 下的 44 篇碎片化历史 spec（v1.19.0 整合为上述 7 篇 Living Spec 与单篇归档）。需要时查 git 历史。

---

## 版本与里程碑

当前产品版本以 [`package.json`](../package.json) 与 [`CHANGELOG.md`](CHANGELOG.md) 为准（**v1.19.3**，2026-11-03）。`package.json`、`package-lock.json`、`src/theme.js`、`gui/src/App.jsx` 四处版本应一致。

开发历程简记：V1 原型 → V2 干净运行时（内核统一、工具平面、编辑回滚、验证修复、上下文、分支 rewind、持久化恢复、护栏）→ V3 三支柱（语义上下文、多智能体调度、三端前端）→ v1.x 产品化（v1.4 会话优先 UI，v1.8 工学换肤与壳层重构，v1.9–v1.17 MCP Client v2 全量落地，v1.18 运行能力闭环）→ **v1.19 架构收敛与全栈精简**（消除 V1 双轨遗留、内聚 `src/edits/`、文档体系 111 篇 → 15 篇、测试套件深度浓缩至 103 项、GUI 打包裁剪至 3.36 MB 与 IPC 100% 表驱动、深层同构重复逻辑合并为公共内核）。
