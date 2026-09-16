# DeepSeek Code V3 路线图设计

> 类型:架构总览 / 路线图 spec
> 日期:2026-06-24
> 状态:已评审,待转实施计划(writing-plans)
> 关联:[Agent 分层记忆系统](../backend/2026-06-24-agent-layered-memory-design.md)
> **Pivot 注记(2026-07):** 前端栈由 Semi UI→手写、CodeMirror→Monaco、xterm 方案→node-pty;相位编号以 D-1–D-5 / D-G4 与 CHANGELOG 为准,而非早期 D-0 草案。

---

## 1. 定位

V3 不是推倒重来,而是「**先把 V2 收尾稳住地基 → 再沿三条重构主线把内核与界面提升一个量级 → 能力跃迁作为新地基的回报自然兑现**」。

**重心**:深化打磨(稳定)+ 架构重构(地基),能力跃迁为辅,产品化/分发本轮不强调。

**复用**:V3 复用 V2 的 `createKernel()` 组合根、事件时间线、工具执行路径、编辑/回滚服务、持久化恢复设施。重构是「替换子系统内部 + 升级界面」,不换骨架。

---

## 2. 路线图骨架(四阶段,严格先后)

```
Phase A · V2 收尾(地基清理)          首条主线,先做
  V2-18 合并持久化恢复 → V2-19 删 V1 legacy + 收敛 apps/ → V2-20 稳定化

Phase B · 支柱① 语义级上下文           agent 质量地基,C 依赖它
  启发式文件分层 → AST/符号级检索 + 依赖图

Phase C · 支柱② 多智能体调度           在语义上下文之上
  单 agent 单轮 → 三层 agent + 两级审核 + 双记忆 + 自主优化

Phase D · 支柱③ 前端三端重构           可与 B/C 并行(单独 worktree)
  Agent 操作系统可视化层 + Agent-aware 编辑器
```

**张力处理**:既要稳定又要重构,二者天然冲突。Phase A 先把地基清干净(尤其删掉 V1/V2 双码库),让后续重构在单一干净的 V2 内核上进行。Phase D 与内核无耦合,可与 B/C 并行,不必干等。

---

## 3. 非目标(本轮明确不做)

- ❌ 模型供应商抽象(DeepSeek 之外的多家模型)
- ❌ 工具插件化 / MCP 工具接入(注:Semi MCP 是开发期辅助,不在此列)
- ❌ 产品化打包 / 分发 / 插件市场
- ❌ 完整 LSP / Debugger / 交互式 PTY 终端 / Monaco 全功能工作台

---

## 4. 目标 Agent 架构(七层闭环)

V3 收敛到如下分层闭环(在现有 `agent-runtime` 之上增量,不重写):

```
用户请求
  ↓
① 任务路由器     判断复杂度 / 风险 / 是否要工具 / 是否要 Planner(升级 classifier.js)
  ↓
② 上下文管理器   语义检索(Phase B)+ 长上下文 + cache-aware prefix
  ↓
③ Planner       thinking mode 规划,产出结构化计划(Phase C)
  ↓
④ 工具执行层     模型只提请求,系统执行(现有 tools/executor.js)
  ↓
⑤ Verifier      规则 / 测试 / 二次模型审核(按需)
  ↓
⑥ 权限层        高风险动作人工确认(现有 permission-engine)
  ↓
最终答复:结构化结果 + 可追溯依据(事件时间线)
```

**已落实(V2)**:④工具执行层、⑥权限层、可追溯答复。
**待补(V3)**:①风险/复杂度路由(现 classifier 仅判类型)、②语义上下文(Phase B)、③Planner(Phase C)、⑤二次模型审核。

**横切硬约束(踩坑清单,部分 V2 已遵守)**:
- reasoning_content 不当长期记忆,只存「推理摘要 + 任务状态」(详见记忆 spec)
- thinking 设上限:最大轮数(现 maxToolIterations=5)、最大修复(现 maxRepairAttempts=2)、**最大成本预算(V3 新增,缺口)**
- 工具调用由系统执行,模型只提请求(V2 已做)
- 删除/付款/发消息/改库等动作人工确认(V2 已做)
- JSON/tool calling 做 schema 校验、失败重试(V2 已做)、**超时处理(V3 补)**

---

## 5. Phase A · V2 收尾

### V2-18 · 持久化恢复(合并收口)
- worktree `v2-18-durable-recovery` 已完成 Task 7–12:事务日志 + 二进制 preimage 捕获、项目锁 + epoch fencing、恢复收件箱、启动恢复扫描、kernel 接线、`kernel.dispose()` 释放锁。
- 剩:Task 13 GUI Recovery Center(并入 Phase D 的 D-G7)、Task 14 端到端故障注入;合并前补齐或显式延后。

### V2-19 · 删除 V1 legacy
- 迁移仍依赖 legacy 的命令(`scan`/`search`/`diff`/`config`/`changes`/`rollback`/`resume`/`tui`)到 V2 kernel。
- 删除 `src/agent.js`、`src/provider.js`、`src/kernel/*` 及其余 V1 扁平文件。
- 收敛 `apps/` 目录。
- **前置**:V2-18 合并之后再做,避免双码库上同时改恢复又删文件。

### V2-20 · 稳定化扫荡
- 补 `/recovery` CLI 入口(V2-18 Task 12 留尾)。
- 测试 / 文档 / GUI smoke 补齐,`npm test` + `npm run check` 全绿。
- 横切补强:**最大成本预算闸**、模型调用与工具的**超时处理**(目标 Agent 架构的两个缺口)。
- 「已知限制」逐条清理或更新。

---

## 6. Phase B · 语义级上下文引擎

**现状**:`src/context/` 文件级启发式——扫文件 → P0–P4 优先级 → token 预算塞整文件片段。问题:粒度是整文件、相关性靠路径启发、不懂代码结构。

**目标**:检索粒度从「文件」降到「符号」,相关性从「路径启发」升到「依赖图」。

**新增单元(置于现有 ContextEngine 之下,门面不变)**:
- `symbol-indexer` —— tree-sitter/AST 解析,抽函数/类/导出/导入,建符号表(符号 → 文件:行范围);增量,与 `context-cache` manifest 对齐。
- `dependency-graph` —— import/调用边构成的有向图,支持从种子符号扩展 N 跳邻居。
- `symbol-selector`(升级 `context-selector`)—— 用户消息 → 定位种子符号 → 沿依赖图扩展 → 按预算选符号级片段。
- `ContextUnit` 扩展 —— 单元粒度可为 file 或 symbol,带 `symbol_kind` / `defined_in` / `refs`。

**取舍**:**AST-first,先不上 embedding**。tree-sitter 确定性、零外部服务、跨语言、增量快,契合现有 manifest 缓存与可复现快照测试。向量语义检索作为后续可选层(需 embedding 服务,与「模型供应商抽象」耦合,本轮非目标)。

**风险**:tree-sitter 是原生依赖(预编译 grammar),需解决跨平台(Windows)安装;先支持 JS/TS,再扩语言。

---

## 7. Phase C · 多智能体调度

### 7.1 三层 agent 架构

```
主 agent(Orchestrator)   地位最高:拆任务 · 派活 · 收活 · 决策(唯一能改计划、拍板最终答复)
   ↓ 派发        ↑ 审核摘要(反哺)
次 agent(Reviewer)        居中(高于子、低于主):审核子产出 · 提炼总结 · 给优化建议
   ↑ 审核        ↓ 监督            (能否决打回,但不能改主的计划)
子 agent(Worker)×N        地位最低:执行子任务(可并行)· 受限上下文 + 工具子集
```

- **持续派发**:长任务"派一批 → 看审核摘要 → 再派新一批",直到完成/预算耗尽。
- **复用而非重写**:子 agent 就是现有 `agent-runtime` 实例(全依赖注入 → 可造多个、各注入不同工具子集与上下文范围);主 = 外面包一层编排 + planner(升级 classifier);次 = 特化的 runtime 实例(系统提示=审核者,工具只给只读 read/grep/test,不给写)。
- **角色决策**:runtime 保持 3 层不膨胀;显示词汇 Orchestrator/Reviewer/Worker;"Supervisor 仲裁"作为 Orchestrator 的显示侧面,不单列第 4 个 runtime 角色。

### 7.2 两级审核

```
主 派发子任务
   ↓
【关卡1 · 子自审】跑测试 + 对照子任务验收标准(复用现有 verifyAndMaybeRepair + runRepairLoop)
   ├─ 不过 → 自我修复(有界重试)
   └─ 仍不过 → 诚实上报「自审失败 + 原因」,不许带病提交
   ↓ 自审通过才提交
【关卡2 · 次 agent 独立审核】不轻信子自审,独立对抗式复查
   ├─ 通过 → 提炼审核摘要
   └─ 否决 → 打回重做 + 写明根因
   ↓ 摘要
主 agent 看摘要 → 继续派 / 打回 / 调整拆法 / 完成
```

- 子自审 = **局部**(便宜,worker 自带上下文);次审 = **独立 + 全局**(贵,抓盲区与跨块冲突)。
- 两级价值:便宜过滤(拦掉明显不合格)+ 纵深防御(独立审核抓 worker 盲区)。
- 次审必须独立复查,不能因"子说审过了"就放行,否则两级塌成一级。

### 7.3 自主优化(两层)
- **本次任务内(始终开)**:次 agent 审核摘要 → 主 agent 立即调整后续派发。
- **跨任务沉淀(开关,默认关)**:次 agent 提炼高价值教训 → 写入【经验记忆系统】→ 以后新任务 planner 检索相关经验影响拆/派。详见记忆 spec。
- 开关分级:`autonomy.crossTaskLearning: off | on | gated`(gated = 沉淀前人工确认高影响经验)。

### 7.4 必守约束
- **成本闸**:三层 + 持续审核会放大开销,强制最大派发轮数、最大子 agent 数、最大成本预算(子自审重试、次审轮数、FIM 调用都计入)。
- **编排确定性**:派几个、打回谁、要不要再来一轮 = 程序逻辑读结构化审核结果做判断,不甩给模型即兴;可测、可重放、可恢复。
- **写冲突隔离**:并行子 agent 改同一文件 → 各自在隔离工作副本(worktree 式)改完再合并 + Phase A 项目锁兜底。
- **持久化**:复用 Phase A 恢复设施,子 agent 崩溃可恢复;子代理事件嵌套进现有会话时间线(turn/branch 模型承载父子关系)。

---

## 8. Phase D · 前端三端重构

**定位**:不是「前端重写」,而是「为 agent 操作系统做可视化层」+「**Agent-aware 编辑器**」。轻、快、稳、专属 DeepSeek。三端(GUI/CLI/TUI)只负责输入、展示、审批,共用同一套 kernel facade,不碰 agent 业务逻辑。

**核心原则**:**先把「事件和状态的共同语言」做好,再重构三端外观。**

### 8.1 GUI 渲染栈决策
全面迁 **React + Vite + Semi UI**(终态),以 `DeepSeekCodeIDE.jsx` 原型为渲染层,保留 kernel-host / IPC / `window.deepseek`;`workbench-state.js` reducer 迁 `useReducer`。**路径用渐进挂载**(旧 renderer 内挂 React root,逐步替换),非大爆炸。配套接入 **Semi MCP + Semi Skills** 辅助写 Semi 代码。

### 8.2 里程碑

```
D-0  共享契约冻结(+ 运行时 schema)
     契约(kernel facade 产出、带版本号):SessionState · AgentRun(role/parent 层级) ·
       TimelineEvent · ToolCall · ApprovalRequest · PatchPreview · RecoveryItem ·
       WorkspaceFile · EditorSelection · FileChange · TerminalEvent
     JSON Schema/Zod 运行时校验:event → schema validate → reducer → view-model
     事件回放 fixtures(录真实 event-log),三端共用,做确定性测试骨架
     铁律:三端只吃契约,绝不重新解释 kernel 原始事件
     可在 V2-18 facade 稳定后即启动,部分先于/并行 Phase A

D-G1 React/Vite/Semi 外壳(渐进挂载)+ Status Bar
     旧 renderer 挂 React root,IPC/kernel-host 不动;Semi 按需引 + 懒加载
     Status Bar 分主次:常驻[kernel/session/agent/approvals/recovery] / 详情[token/latency/branch/cache]
     Recovery 从此即全局态
     ▸ 验收:功能对齐现有 GUI(分支/rewind/审批/时间线可用)

D-G2 Agent Inspector(取代 ChatPanel)
     顶部 priority strip:Awaiting approval / Blocked / Failed tool / Patch ready / Recovery available
     主体:PlanSummary · ToolCalls · Approvals · Timeline · Recovery · Composer
     展示「DeepSeek 正读哪个文件 / 为何改 / 计划改哪 / 已生成哪些 patch / 哪些待确认 / 测试结果 / 能否恢复」
     按 AgentRun 契约渲染 → Phase C 落地后原生支持主/次/子泳道
     agent 卡片固定字段:角色 / 状态 / 所属任务 / 最近动作 / 审核结果 / 是否需用户处理

D-G3 Agent-aware 编辑器(轻量,拆细降风险)
     引擎:CodeMirror 6 可编辑 + Shiki 只读高亮(分工不叠加)+ diff2html
     D-G3a CodeMirror 真编辑 + 保存 + dirty state(三种来源态着色)
     D-G3b 行内 PatchPreview:逐块接受/拒绝(与 Inspector patch 清单联动)
     D-G3c DeepSeek FIM ghost text(招牌;接 fim-client.js)
     D-G3d 选中即问 + agent 回写 diff
     第一档(必做,轻而强):文件树 · 多标签 · 文件/符号搜索 · diff 预览 · patch 接受拒绝 · 定位到 agent 正看的行
     第二档(谨慎):轻编辑保存 · 选中即问 · 局部重写 · 应用前微调
     选中动作:Ask DeepSeek / Explain / Refactor / Find Related / Generate Patch / Review
     编辑走 edit-service(preview→accept/reject→apply→rollback)+ 事务日志(可回滚)
     ✗ 不做:LSP · Debugger · 插件 · node-pty · 复杂 Git 图 · Monaco

D-G4 CLI 对齐:render-events 吃同一契约 · /recovery 走同一 facade · 多 agent 摘要
     # ✅ 2026-07-12 落地:共享事件展示契约 src/apps/event-contract.js 三端共用(收敛问题 #5 于受支持 ESM 路径)+ CLI 多 agent 摘要 + /recovery CLI/TUI 对齐;GUI recovery UI 仍属 D-G7。
D-G5 输出终端:xterm 渲染 tool:result,不接交互式 PTY(避开 node-pty Windows 大坑)
D-G6 TUI 对齐:分支/检查点/审批/恢复,与 CLI/GUI 术语能力齐平
D-G7 Recovery Center 完整检查器:事务/阻塞/保留产物/恢复动作(收 V2-18 Task 13)
     # ✅ 2026-09-15 落地(v1.7.1):kernel-host recovery 代理 + IPC/preload + 侧栏 RecoveryView(列表/报告/续跑/取消/清除);kernel 契约零改动
```

### 8.3 三种 diff 来源态(必须严格区分,颜色/标签)
```
① 用户脏改(未保存)    → 只提示,不强管        ← 对应 V2-11 dirty workspace
② Agent 提议(preview)→ 逐块接受/拒绝         ← edit-service preview
③ Agent 已应用(committed)→ 可回滚            ← change-store + 事务日志
```

### 8.4 DeepSeek FIM 专属交互(招牌 = 风险)
克制触发:停顿 300–500ms · 仅当前文件局部上下文 · Esc 取消 · Tab 接受 · 继续输入即废弃 · 失败静默 · 可一键关 · 不与 agent 编辑抢方向盘 · 前缀哈希缓存 · **计入成本预算**。
FIM 单独验收门:防抖 · 可取消 · 超时 · 缓存 · 失败静默 · 绝不阻塞输入。

### 8.5 流畅度硬规则(每里程碑验收)
```
首屏不载编辑器重模块,开文件才懒加载;大文件默认只读 + 阈值提示局部加载
diff 超阈值分页/折叠;timeline & 文件树虚拟列表
输入延迟 < 50ms;主线程不阻塞(大 diff/长 timeline 用 worker 或分片);60fps;乐观更新
模型输出禁 innerHTML;编辑器只存 tabs/selection/dirty,不接管 agent 业务
深浅色一致,DeepSeek 蓝主色贯穿
```

---

## 9. 排序与依赖

| 阶段 | 依赖 | 可并行 |
|---|---|---|
| Phase A(V2-18→19→20) | 无(首条主线) | — |
| Phase B 语义上下文 | Phase A 地基清理后更顺 | 可与 D 并行 |
| Phase C 多 agent | Phase B(子 agent 上下文按作用域供给)、记忆系统 | 可与 D 并行 |
| Phase D D-0/G1/G2/G3/G4 | D-0 契约冻结(V2-18 facade 稳定后) | 与 B/C 并行(单独 worktree) |
| Phase D D-G7 Recovery Center | Phase A(V2-18 合并) | — |
| Phase D D-G2 多 agent 泳道 | 契约先就位(零返工);Phase C 落地后内容才完整 | — |

---

## 10. 关键决策记录

| 决策 | 选择 | 理由 |
|---|---|---|
| 首条主线 | 先收尾 V2 | 单一干净内核上再重构 |
| 语义上下文 | AST-first,embedding 延后 | 确定性、零外部服务、契合缓存与可复现测试 |
| 多 agent 角色 | 3 层 runtime(主/次/子) | 不膨胀;Supervisor 作 Orchestrator 显示侧面 |
| 审核 | 两级(子自审 + 次独立审) | 便宜过滤 + 纵深防御 |
| 跨任务学习 | 可开关(默认关),独立经验记忆 | 防伪经验污染主记忆 |
| GUI 栈 | React + Vite + Semi UI,渐进挂载 | 视觉/可维护性最佳,路径降风险 |
| 编辑器引擎 | CodeMirror 6(+Shiki+diff2html),非 Monaco | 轻、快、可控、不与 VS Code 内卷 |
| 编辑器定位 | Agent-aware editor,非 IDE 克隆 | 服务 DeepSeek 编码闭环,产品辨识度 |
| 终端 | xterm 只渲染输出,不接 node-pty | 避开 Windows Electron 原生依赖坑 |

---

## 11. 后续 spec 拆分

本路线图为总览。以下子项各自再出独立 spec → plan → 实施:
- Phase B 语义上下文引擎(独立 backend spec)
- Phase C 多智能体调度(独立 backend spec,引用记忆 spec)
- **Agent 分层记忆系统**(已独立:`docs/specs/backend/2026-06-24-agent-layered-memory-design.md`)
- Phase D 各里程碑(D-0 契约 + 各 D-G 独立 frontend spec/plan)
- V2-19 删 legacy、V2-20 稳定化(独立 backend plan)

---

## 12. 开放问题(实施前再定)
- 成本预算闸的具体度量(token / 美元 / 调用数)与默认阈值。
- tree-sitter grammar 的打包与 Windows 安装方案。
- 经验记忆三级阈值 T1/T2/T3 的初始取值(详见记忆 spec)。
- 是否需要独立 Supervisor 仲裁者(当前默认否,审 spec 可改)。
