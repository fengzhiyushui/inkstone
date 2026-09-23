# Inkstone V3 路线图设计

- 类型：路线图
- 日期：2026-06-24
- 状态：已完成（三支柱已落地；后续见 [post-V3 路线图](2026-09-17-post-v3-roadmap-design.md)）
- 关联：[Agent 分层记忆](../backend/2026-06-24-agent-layered-memory-design.md) · [v2 Clean Runtime](2026-05-30-deepseek-code-v2-clean-runtime-design.md)

> Pivot 注记（2026-07）：前端栈定为手写 UI + Monaco 只读 diff + 自研终端渲染；相位编号以 D-1–D-5 / D-G4 与 CHANGELOG 为准，而非早期 D-0 草案。GUI 栈的早期 Semi UI / CodeMirror / xterm 选项在实施中已改。

---

## 问题与目标

V2 落地后需要在单一干净内核上再抬升：语义级上下文、多智能体调度、三端可视化。V3 不推倒重来，顺序是先收尾 V2 地基，再沿三条主线重构，能力跃迁作为新地基的回报。

复用 `createKernel()` 组合根、事件时间线、工具执行路径、编辑/回滚、持久化恢复。重构替换子系统内部与界面，不换骨架。

非目标（本轮不做）：多模型供应商抽象、MCP/工具插件化、产品化打包分发插件市场、完整 LSP / Debugger / 交互式 PTY / 全功能 IDE 工作台。

## 决策

| 决策点 | 选择 | 否决项 | 理由 |
|---|---|---|---|
| 主线顺序 | 先 Phase A 收尾 V2 | 边删 legacy 边重构 | 双码库上改恢复会互相踩 |
| 语义上下文 | AST-first（tree-sitter），embedding 延后 | 先上向量检索 | 确定性、零外部服务、可复现 |
| 多 agent 角色 | 三层 runtime：Orchestrator / Reviewer / Worker | 第 4 个 Supervisor runtime | 不膨胀；Supervisor 只作 Orchestrator 显示侧面 |
| 审核 | 两级：子自审 + 次独立审 | 只靠自审或只靠外审 | 便宜过滤 + 纵深防御 |
| 跨任务学习 | 开关，默认 off，独立经验记忆 | 默认写入主记忆 | 防伪经验污染 |
| 编辑器 | 轻量 Agent-aware，不做 IDE 克隆 | Monaco 全功能工作台 | 服务 agent 编码闭环，避免与 IDE 正面竞争 |
| 终端 | 只渲染 tool 输出 | node-pty 交互 PTY | 避开 Windows 原生依赖 |

## 设计

### 目标 Agent 闭环

```
用户请求
  → ① 任务路由器（复杂度/风险/是否 plan）
  → ② 上下文管理器（语义检索 + cache-aware prefix）
  → ③ Planner（thinking 产出结构化计划）
  → ④ 工具执行层（系统执行，模型只提请求）
  → ⑤ Verifier（规则/测试/二次模型审核）
  → ⑥ 权限层（高风险人工确认）
  → 结构化结果 + 事件时间线可追溯
```

V2 已具备 ④⑥ 与可追溯答复。V3 补 ① 路由、② 语义上下文、③ Planner、⑤ 二次审核，并补成本预算闸与模型/工具超时。

横切硬约束：`reasoning_content` 不当长期记忆；轮数、修复次数、成本预算都有上限；工具由系统执行；危险动作人工确认；JSON/tool call schema 校验 + 有界重试 + 超时。

### Phase A · V2 收尾

- **V2-18 持久化恢复**：事务日志 + 二进制 preimage、项目锁 + epoch fencing、恢复收件箱、启动扫描、kernel 接线、`dispose()` 释放锁。GUI Recovery Center 归 D-G7。
- **V2-19 删 V1 legacy**：依赖 legacy 的命令迁到 V2 kernel；删除旧扁平实现；收敛 `apps/`。前置是 V2-18 合并。
- **V2-20 稳定化**：补 `/recovery` CLI、测试与文档、成本预算闸与超时、清理已知限制。

### Phase B · 语义级上下文

现状（设计时）是文件级启发式。目标把检索粒度从文件降到符号，相关性从路径启发升到依赖图。

新增单元（ContextEngine 门面不变）：`symbol-indexer`（AST 抽符号，增量，与 context-cache manifest 对齐）、`dependency-graph`（import/调用边，N 跳扩展）、`symbol-selector`（消息 → 种子符号 → 图扩展 → 预算内片段）、`ContextUnit` 扩展 symbol 粒度字段。

取舍：AST-first，embedding 作后续可选层。风险：tree-sitter 跨平台安装；语言先 JS/TS 再扩。实现见 `src/context/semantic/`，配置键 `context.semantic.{enabled,hops,maxSymbols,includeMethodHints,importRoots}`。

### Phase C · 多智能体调度

三层角色：

- **Orchestrator**：拆任务、派活、收活、决策；唯一可改计划与最终答复。
- **Reviewer**：独立审核子产出，提炼摘要，可否决打回，不改主计划。
- **Worker ×N**：执行子任务，受限上下文与工具子集，可并行。

子 agent 就是可多开的 `agent-runtime` 实例（依赖注入不同工具子集与上下文作用域）。两级审核：关卡 1 子自审（测试 + 验收标准，复用 verifyAndMaybeRepair / repair-loop）；关卡 2 次 agent 独立复查，不因「子说审过了」放行。

自主优化两层：本次任务内用审核摘要调后续派发（始终开）；跨任务沉淀进经验记忆（开关 `off | on | gated`，默认 off）。

必守约束：成本闸（最大派发轮数、最大子 agent 数、最大成本）；派发/打回/再派是程序逻辑读结构化审核结果，不甩给模型即兴；写冲突隔离（隔离工作副本 + 合并 + 项目锁）；持久化复用 Phase A，子 agent 事件嵌套进会话时间线。

实现见 `src/core/orchestration/`、`src/core/memory/`，配置键 `orchestration.*`。

### Phase D · 前端三端重构

定位：Agent 操作系统可视化层 + Agent-aware 编辑器。三端只负责输入、展示、审批，共用 kernel facade 与 `src/apps/event-contract.js`，不重新解释内核原始事件。

里程碑（含后期落地标记）：

| 里程碑 | 内容 | 状态 |
|---|---|---|
| D-0 | 共享契约冻结 + 运行时 schema + 事件回放 fixtures | 部分落地（event-contract）；完整 schema/fixtures 归 post-V3 |
| D-G1 | GUI 外壳 + Status Bar | 已落地 |
| D-G2 | Agent Inspector（priority strip、计划/工具/审批/时间线） | 见 post-V3 装箱 |
| D-G3 | Agent-aware 编辑器（真编辑 / 行内 patch / FIM / 选中即问） | v1.4 起收窄为只读 diff；重开与否见 post-V3 Q3 |
| D-G4 | CLI 对齐：render-events 同契约、`/recovery`、多 agent 摘要 | ✅ 2026-07-12 |
| D-G5 | xterm 输出终端 | 后评估为不做（依赖已删） |
| D-G6 | TUI 对齐分支/检查点/审批/恢复 | 见 post-V3 |
| D-G7 | Recovery Center 完整检查器 | ✅ 2026-09-15（v1.7.1） |

三种 diff 来源态必须严格区分：用户脏改（只提示）、Agent 提议 preview（逐块接受/拒绝）、Agent 已应用 committed（可回滚）。

FIM 交互若落地需单独验收：防抖、可取消、超时、缓存、失败静默、不阻塞输入、计入成本预算。

流畅度硬规则：首屏不载编辑器重模块；大文件默认只读并提示局部加载；diff 阈值分页；timeline 与文件树虚拟列表；输入延迟 < 50ms；模型输出禁 `innerHTML`；深浅色一致。

## 排序与依赖

| 阶段 | 依赖 | 可并行 |
|---|---|---|
| Phase A（V2-18→19→20） | 无 | — |
| Phase B 语义上下文 | Phase A 更顺 | 可与 D 并行 |
| Phase C 多 agent | Phase B、记忆系统 | 可与 D 并行 |
| Phase D D-0/G1/G2/G3/G4 | 契约冻结 | 与 B/C 并行 |
| D-G7 Recovery Center | V2-18 合并 | — |

## 边界与不变量

1. 内核单写、界面 client。
2. 工具系统执行、模型只提请求。
3. 危险动作人工确认。
4. 成本与轮数有硬上限。
5. 语义层默认可关（`context.semantic.enabled` 默认 false）。
6. 跨任务学习默认 off。

## 与现状的差异

早期设计里的 Semi UI + CodeMirror + xterm 栈未采用；GUI 为手写 UI + Monaco 只读 diff。相位编号以实际 plan / CHANGELOG 为准。MCP 与多供应商仍是非目标（GUI 空态入口与该决策的矛盾见 post-V3 Q2）。

## 验收

V3 总验收：语义检索可开可关且默认不影响基线；多 agent 编排有成本闸、可恢复、事件可追溯；三端吃同一事件契约；`npm test` 与 `npm run check` 全绿。分项验收见各 backend / frontend spec。
