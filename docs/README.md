# Inkstone 文档中心

本目录收录 Inkstone 全部项目文档。按类型分目录：设计（`specs/`）与实施计划（`plans/`）再按前端 / 后端 / 架构细分。根目录 [`README.md`](../README.md) 是项目入口；本文件是索引与维护规范。

---

## 目录结构

```text
docs/
  README.md                 文档索引与维护规范
  DEPLOYMENT_AND_USAGE.md   本地部署与使用指南
  project-overview.md       维护者深入说明（架构/工具/编辑/恢复/安全/事件/目录）
  CHANGELOG.md              变更日志
  specs/                    设计：做成什么样、为什么
    architecture/           跨端架构
    backend/                内核 / runtime / 工具 / 编辑 / 会话 / 恢复
    frontend/               GUI / CLI / TUI
  plans/                    实施：分几步、怎么验证
    roadmap/                宏观阶段 phase-0..5
    architecture/           跨端 / 仓库级计划
    backend/
    frontend/
```

`specs/` 与 `plans/` 的分工：spec 写目标、架构与取舍；plan 写任务拆分与验收。一个特性通常先有 spec 再有 plan。历史已完成的 plan 已压缩为「目标 / 结果 / 关键决策 / 验证」摘要，不再保留逐步 checkbox。

---

## 文档维护顺序

代码变更落地后，按下列顺序更新（与本次无关的步骤跳过，但不要打乱先后）：

| 顺序 | 文档 | 何时更新 |
|------|------|----------|
| 1 | 代码 | 先落地，并通过 `npm test` / `npm run check` / `git diff --check` |
| 2 | `docs/specs/<area>/` | 设计变化时，改成与**实际实现**一致 |
| 3 | `docs/plans/<area>/` | 登记新任务，或把已完成计划收成摘要 |
| 4 | [`project-overview.md`](project-overview.md) | 架构 / 内核 / 工具 / 编辑回滚 / 恢复 / 安全 / 会话事件 / 配置 / 目录变化时 |
| 5 | [`CHANGELOG.md`](CHANGELOG.md) | 在 `[Unreleased]` 累积；发布时按版本规则定级并写入版本小节 |
| 6 | 根 [`README.md`](../README.md) | **仅大版本（major）更新时重写**，时机由维护者决定 |
| 7 | 本文件 | 新增 / 移动 / 删除文档时同步索引 |

一句话顺序：代码 → specs/plans → project-overview → CHANGELOG → 索引。

`<area>` 取值：`backend`、`frontend`、`architecture`。

**命名**：plan 用 `YYYY-MM-DD-<topic>.md`，spec 用 `YYYY-MM-DD-<topic>-design.md`。spec 落 `docs/specs/<area>/`，plan 落 `docs/plans/<area>/`，不再增加其它分层。

---

## 版本命名规则

自 **v1.0.0**（2026-07-13）起采用语义化版本 `major.minor.patch`：

| 级别 | 示例 | 触发条件 | 由谁启动 |
|------|------|----------|----------|
| major | `v1.x` → `v2.0.0` | 大功能、DeepSeek 模型代际适配、支柱级能力、触及核心运行时 / 内核契约的破坏性重构 | 维护者拍板 |
| minor | `v1.8.6` → `v1.9.0` | 大版本规划内的小功能：slash 命令、内置工具、配置档、一门语言的语义支持、一次前端对齐 | 规划内可直接推进 |
| patch | `v1.8.6` → `v1.8.7` | 文档更新、小漏洞修复、测试补齐、依赖小升级；不改功能面 | 随手推进 |

判定口诀：大能力 / 换模型代际 / 破坏性重构 → major（等拍板）；规划内小功能 → minor；文档 / 小修 / 测试 → patch。

发布时同步：`package.json` 的 `version`、`src/theme.js` 的 `VERSION`（TUI/CLI banner）、以及 `CHANGELOG.md` 版本小节。git 中每个已发布版本有对应带注解 tag。

**与内部架构代号的区分**：文档里的「V2 内核 / V3 支柱」是运行时架构与开发阶段，不是产品版本号。产品版本自 v1.0.0 起单独演进。

---

## 索引

### 部署与使用
- [DEPLOYMENT_AND_USAGE](DEPLOYMENT_AND_USAGE.md) — 系统准备、极速部署、GUI 构建、模型配置、三端教程、排错

### 项目说明
- [project-overview](project-overview.md) — 架构内核、DeepSeek 适配、工具平面、编辑/回滚、恢复、护栏、安全、事件、存储、目录

### specs/architecture
- [deepseek-code-v1-design](specs/architecture/2026-05-29-deepseek-code-v1-design.md) — V1 整体设计
- [deepseek-code-v2-clean-runtime-design](specs/architecture/2026-05-30-deepseek-code-v2-clean-runtime-design.md) — V2 干净运行时
- [v3-roadmap-design](specs/architecture/2026-06-24-v3-roadmap-design.md) — V3 路线图：四阶段、三支柱、三层多 agent
- [post-v3-roadmap-design](specs/architecture/2026-09-17-post-v3-roadmap-design.md) — V3 之后路线图（草案）

### specs/backend
- [v2-7 approval-resume](specs/backend/2026-05-30-v2-7-approval-resume-design.md)
- [v2-8 verifier-repair-loop](specs/backend/2026-05-31-v2-8-verifier-repair-loop-design.md)
- [v2-9 context-engine](specs/backend/2026-05-31-v2-9-context-engine-design.md)
- [v2-10 context-cache-usage-telemetry](specs/backend/2026-05-31-v2-10-context-cache-usage-telemetry-design.md)
- [v2-11 transactional-edit-dirty-workspace](specs/backend/2026-05-31-v2-11-transactional-edit-dirty-workspace-design.md)
- [v2-12 branching-conversation-rewind](specs/backend/2026-05-31-v2-12-branching-conversation-rewind-design.md)
- [v2-13 rewind-hardening-recovery](specs/backend/2026-05-31-v2-13-rewind-hardening-recovery-design.md)
- [v2-17 chat-kernel-unification](specs/backend/2026-05-31-v2-17-chat-kernel-unification-bypass-closure-design.md)
- [v2-18 durable-recovery-resume-hardening](specs/backend/2026-06-01-v2-18-durable-recovery-resume-hardening-design.md)
- [agent-layered-memory](specs/backend/2026-06-24-agent-layered-memory-design.md) — 分层记忆设计
- [v3-phase-b semantic-context](specs/backend/2026-06-26-v3-phase-b-semantic-context-design.md) — 语义上下文（WASM tree-sitter）
- [v3-phase-b+1 method-hints](specs/backend/2026-06-26-v3-phase-b-plus1-method-hints-design.md) — 方法消歧
- [v3-phase-b+3 multi-language](specs/backend/2026-06-26-v3-phase-b-plus3-multi-language-design.md) — JS/TS/Python
- [v3-phase-c1+c2 orchestration](specs/backend/2026-06-27-v3-phase-c1-c2-orchestration-design.md) — 多智能体编排与两级审核
- [v3-phase-c3 parallel-isolation](specs/backend/2026-06-27-v3-phase-c3-parallel-isolation-design.md) — 并行写隔离与合并
- [v3-phase-c5 replan-resume](specs/backend/2026-06-27-v3-phase-c5-replan-resume-design.md) — 重规划与同进程续跑
- [v3-phase-c-router tiered](specs/backend/2026-06-27-v3-phase-c-router-tiered-design.md) — 分层路由
- [v3-phase-c4 experience-memory](specs/backend/2026-06-27-v3-phase-c4-experience-memory-design.md) — 跨任务经验记忆
- [v3-phase-c-durable orchestration-recovery](specs/backend/2026-06-27-v3-phase-c-durable-orchestration-recovery-design.md) — 跨进程编排恢复
- [agent-findings remediation](specs/backend/2026-07-12-agent-findings-remediation.md) — 审计补救台账
- [v1.2.0 agent-findings-p2](specs/backend/2026-07-17-v1.2.0-agent-findings-p2-design.md)
- [v1.3.0 agent-findings-p3](specs/backend/2026-07-26-v1.3.0-agent-findings-p3-design.md)
- [v1.6.3 agent-runtime refactor](specs/backend/2026-08-09-v1.6.3-agent-runtime-refactor-design.md) — 阶段 1–2 成果；3–4 延后至大版本

### specs/frontend
- [v2-14 gui-workbench-branch-rewind](specs/frontend/2026-05-31-v2-14-gui-workbench-branch-rewind-design.md)
- [v2-15 natural-agent-workbench](specs/frontend/2026-05-31-v2-15-natural-agent-workbench-design.md)
- [v2-16 gui-interaction-hardening](specs/frontend/2026-05-31-v2-16-gui-interaction-hardening-design.md)
- [v2-frontend-workbench-redesign](specs/frontend/2026-05-31-v2-frontend-workbench-redesign-design.md)
- [v3-phase-d1 gui-react-shell](specs/frontend/2026-06-27-v3-phase-d1-gui-react-shell-design.md) — React 外壳
- [v3-phase-d2 gui-functional](specs/frontend/2026-07-01-v3-phase-d2-gui-functional-design.md) — 文件树 / Monaco / 卡片
- [v3-phase-d3 gui-full-functional](specs/frontend/2026-07-02-v3-phase-d3-gui-full-functional-design.md) — 设置页与全功能
- [v3-phase-d4 change-tracking](specs/frontend/2026-07-02-v3-phase-d4-change-tracking-design.md) — 改动跟踪
- [v3-phase-d5 tui-redesign](specs/frontend/2026-07-06-v3-phase-d5-tui-redesign-design.md) — TUI 行内滚动流
- [v3-phase-dg4 cli-alignment](specs/frontend/2026-07-12-v3-phase-dg4-cli-alignment-design.md) — 三端事件展示契约
- [v1.4.0 frontend-redesign](specs/frontend/2026-07-28-v1.4.0-frontend-redesign-design.md) — 会话优先 UI 重做定稿
- [v1.8.0 ergo-restyle](specs/frontend/2026-09-17-v1.8.0-ergo-restyle-design.md) — 工学换肤（四段带主题）
- [v1.8.1 dsh-shell](specs/frontend/2026-09-20-v1.8.1-dsh-shell-design.md) — 壳层三列 + dock + 设置模态

### plans/roadmap
- [phase-0 kernel-foundation](plans/roadmap/2026-05-29-phase-0-kernel-foundation.md)
- [phase-1 core-intelligence](plans/roadmap/2026-05-29-phase-1-core-intelligence.md)
- [phase-2 security-extension](plans/roadmap/2026-05-30-phase-2-security-extension.md)
- [phase-3 experience](plans/roadmap/2026-05-30-phase-3-experience.md)
- [phase-4 gui](plans/roadmap/2026-05-30-phase-4-gui.md)
- [phase-5 polish](plans/roadmap/2026-05-30-phase-5-polish.md)

### plans/architecture
- [inkstone-rebrand](plans/architecture/2026-07-31-inkstone-rebrand.md) — DeepSeek Code → Inkstone
- [v1.9.0 contract-freeze-and-visualization](plans/architecture/2026-09-23-v1.9.0-contract-freeze-and-visualization.md) — 契约冻结 + Inspector + 模型适配（M1-P0/M1/M2 已完工，M3–M5 进行中）

### plans/backend
历史计划已收成摘要（目标 / 结果 / 关键决策 / 验证）。全目录见 [`plans/backend/`](plans/backend/)。

**V2 内核与护栏**
- [v2-0 skeleton](plans/backend/2026-05-30-v2-0-skeleton-protocol-foundation.md) · [v2-1 gateway](plans/backend/2026-05-30-v2-1-deepseek-gateway.md) · [v2-2 tool-plane](plans/backend/2026-05-30-v2-2-tool-plane.md) · [v2-3 edit-service](plans/backend/2026-05-30-v2-3-edit-service.md) · [v2-4 runtime-loop](plans/backend/2026-05-30-v2-4-runtime-loop.md) · [v2-6 release](plans/backend/2026-05-30-v2-6-release-closure.md) · [v2-7 approval](plans/backend/2026-05-30-v2-7-approval-resume.md) · [v2-8 verifier](plans/backend/2026-05-31-v2-8-verifier-repair-loop.md) · [v2-9 context](plans/backend/2026-05-31-v2-9-context-engine.md) · [v2-10 cache/usage](plans/backend/2026-05-31-v2-10-context-cache-usage-telemetry.md) · [v2-11 transactional-edit](plans/backend/2026-05-31-v2-11-transactional-edit-dirty-workspace.md) · [v2-12 rewind](plans/backend/2026-05-31-v2-12-branching-conversation-rewind.md) · [v2-13 rewind-hardening](plans/backend/2026-05-31-v2-13-rewind-hardening-recovery.md) · [v2-17 chat-kernel](plans/backend/2026-05-31-v2-17-chat-kernel-unification.md) · [v2-18 recovery](plans/backend/2026-06-01-v2-18-durable-recovery-resume-hardening.md) · [v2-18c journaling](plans/backend/2026-06-25-v2-18c-edit-rewind-journaling.md) · [v2-19 delete-v1](plans/backend/2026-06-25-v2-19-delete-v1-legacy.md)
- [v2-20a](plans/backend/2026-06-24-v2-20a-runtime-cost-timeout-guardrails.md) · [v2-20b](plans/backend/2026-06-25-v2-20b-guardrail-injection-graceful-stop.md) · [v2-20c](plans/backend/2026-06-25-v2-20c-malformed-toolcall-retry.md) · [v2-20d](plans/backend/2026-06-25-v2-20d-resume-path-guardrail-alignment.md) · [v2-20e](plans/backend/2026-06-25-v2-20e-repair-path-model-timeout.md) · [v2-20f](plans/backend/2026-06-25-v2-20f-guardrail-defaults-config.md)

**V3 支柱**
- [b semantic](plans/backend/2026-06-26-v3-phase-b-semantic-context.md) · [b+1](plans/backend/2026-06-26-v3-phase-b-plus1-method-hints.md) · [b+3](plans/backend/2026-06-26-v3-phase-b-plus3-multi-language.md)
- [c1+c2](plans/backend/2026-06-27-v3-phase-c1-c2-orchestration.md) · [c3](plans/backend/2026-06-27-v3-phase-c3-parallel-isolation.md) · [c4](plans/backend/2026-06-27-v3-phase-c4-experience-memory.md) · [c5](plans/backend/2026-06-27-v3-phase-c5-replan-resume.md) · [c-router](plans/backend/2026-06-27-v3-phase-c-router-tiered.md) · [c-durable](plans/backend/2026-06-27-v3-phase-c-durable-orchestration-recovery.md)

**版本收口**
- [v1.2.0 findings](plans/backend/2026-07-16-v1.2.0-agent-findings-p2.md) · [v1.3.0 findings](plans/backend/2026-07-26-v1.3.0-agent-findings-p3.md) · [v1.6 backlog](plans/backend/2026-08-09-v1.6-backlog-closure.md)

### plans/frontend
- [v2-5 interface-migration](plans/frontend/2026-05-30-v2-5-interface-migration.md) · [v2-14](plans/frontend/2026-05-31-v2-14-gui-workbench-branch-rewind.md) · [v2-15](plans/frontend/2026-05-31-v2-15-natural-agent-workbench.md) · [v2-16](plans/frontend/2026-05-31-v2-16-gui-interaction-hardening.md) · [v2 workbench](plans/frontend/2026-05-31-v2-frontend-workbench-redesign.md)
- [d1](plans/frontend/2026-06-27-v3-phase-d1-gui-react-shell.md) · [d2](plans/frontend/2026-07-01-v3-phase-d2-gui-functional.md) · [d3](plans/frontend/2026-07-02-v3-phase-d3-gui-full-functional.md) · [d4](plans/frontend/2026-07-02-v3-phase-d4-change-tracking.md) · [d5](plans/frontend/2026-07-06-v3-phase-d5-tui-redesign.md) · [dg4](plans/frontend/2026-07-12-v3-phase-dg4-cli-alignment.md)
- [v1.4.0 plan](plans/frontend/2026-07-31-v1.4.0-frontend-redesign-plan.md) · [sensitive-file](plans/frontend/2026-08-09-sensitive-file-warning-and-display-redaction.md) · [d-g7 recovery](plans/frontend/2026-09-15-d-g7-gui-recovery-center.md) · [v1.7.2](plans/frontend/2026-09-17-v1.7.2-gui-defects.md) · [v1.8.0 plan](plans/frontend/2026-09-17-v1.8.0-ergo-restyle-plan.md) · [v1.8.1 plan](plans/frontend/2026-09-20-v1.8.1-dsh-shell-plan.md)

> 已删除：`future-gui-deepseek-code-ide-redesign`、`gui-frontend-optimization-plan`（被 v1.8 现役壳层取代）；`docs/prototypes/` 整目录（v1.4 定稿 HTML、v1.8 截图、`DeepSeekCodeIDE.jsx`、`preview-deepseek-code/` 及其依赖残留）。需要时查 git 历史。

---

## 版本与里程碑

当前产品版本以 [`package.json`](../package.json) 与 [`CHANGELOG.md`](CHANGELOG.md) 为准（**v1.9.0**，2026-09-24）。`package.json`、`package-lock.json`、`src/theme.js`、`gui/src/App.jsx` 四处版本应一致。

开发历程简记：V1 原型 → V2 干净运行时（内核统一、工具平面、编辑回滚、验证修复、上下文、分支 rewind、持久化恢复、护栏）→ V3 三支柱（语义上下文、多智能体调度、三端前端）→ v1.x 产品化（v1.4 会话优先 UI，v1.8 工学换肤与壳层重构）。
