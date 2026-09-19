# Inkstone V3 之后路线图设计(post-V3 roadmap)

> 类型:架构总览 / 路线图 spec
> 日期:2026-09-17
> 状态:**草案,待维护者拍板**(§7 列出全部需拍板项;拍板前不转 plan)
> 基线:`main @ ccacbd3`(v1.7.1)。CHANGELOG 记 1083+ 单测(本文撰写时未亲测)
> 关联:[V3 路线图](2026-06-24-v3-roadmap-design.md) · [审计补救台账](../backend/2026-07-12-agent-findings-remediation.md) · [agent-runtime 边界分析](../backend/2026-08-09-v1.6.3-agent-runtime-refactor-design.md) · [v1.4 前端定稿](../frontend/2026-07-28-v1.4.0-frontend-redesign-design.md)
> 分工:本文及后续 plan 由 Claude 产出,代码由 mimo 实现(维护者 2026-09-17 定)

---

## 0. 为什么需要这份文件

V3 路线图的三支柱已全部落地,其后 v1.1.0 → v1.7.1 七个版本**全部由审计补账驱动**,台账 10 项现已清零(#10 阶段 3–4 延后大版本)。项目处于**「路线图已走完、下一段没画」**的状态。

"未来"散落在五个互不引用的地方:V3 roadmap 未勾的 D-G 里程碑、roadmap §3 的非目标、台账里的延后项、桌面上的重写评估报告(2026-08-15,未入库)、`d:\tmp` 里的 v1.8.0 换肤审计稿(未入库)。本文把它们收拢成**一张表**,每项标处置,再按版本装箱。

**本文不做的事**:不替维护者拍板 §7 的决策;不给出任务级 plan(那是每个版本各自的 plan 的事)。

---

## 1. 现状事实(2026-09-17 核实,均以代码为准)

| 事实 | 证据 | 对路线的影响 |
|---|---|---|
| FIM 内核完整、**前端零接线** | `src/deepseek/fim-client.js` 存在;`gui/src` / `src/apps` 无任何 `fimComplete` 调用,只有设置页一行模型名配置 | roadmap 称 FIM 为"招牌"(D-G3c),两个月无人碰 |
| GUI 侧栏已有 **MCP / 插件**入口,内容是空态"功能规划中" | `strings.js` `concept.mcp/plugins/*Empty`;`SecondaryViews.ConceptView` | UI 先于规划存在;roadmap §3 把 MCP 列为非目标 → **矛盾** |
| 工具注册表**无插件扩展点** | `src/tools/registry.js` 只有 `register/resolve/listTools`,builtin 在装配时硬编码注入 | 插件/MCP 若做,先要一个装配期扩展点 |
| **零分发能力** | 根 `package.json` 无 `files`/`publishConfig`;无 `.github/workflows`;`gui/package.json` 无 electron-builder | 用户只能 `git clone` |
| npm 包名 **`inkstone` 已被占**(2019,富文本编辑器,`inkstone-io/inkstone`) | `npm view inkstone` | 若发 npm 必须改 scope 或名 |
| 语义索引走 **WASM tree-sitter**(`web-tree-sitter@0.20.8`,三份 `.wasm` 入库) | `package.json` optionalDependencies;`src/context/grammars/` | 重写报告点名的第一热点 |
| `agent-runtime.js` 1160 行,刻画测试 7 条已锁行为 | v1.6.3 | 重构随时可开,护栏已备 |
| 编辑器 = Monaco **只读 diff**,无代码编辑面 | v1.4 决策 | D-G3 整组未做 |
| v1.7.1 **未推送、未打 tag** | `main` ahead of `origin/main` 1 | 运维欠账,与路线无关但要清 |

---

## 2. 收拢:全部"未来"碎片一览

| # | 来源 | 项 | 内核改动? | 处置建议 | 装箱 |
|---|---|---|---|---|---|
| A1 | roadmap D-0 | 共享契约 JSON Schema 运行时校验 + 事件回放 fixtures | 否(app 层) | **做**——三端展示契约已有,补 schema + fixtures 是纯增量,且是后续所有前端片的测试骨架 | v1.9 |
| A2 | roadmap D-G2 | Agent Inspector:priority strip + 主/次/子 agent 泳道 | 否 | **做**——编排事件已全在 eventBus,只缺渲染;是"多智能体"支柱唯一看得见的前端 | v1.9 |
| A3 | roadmap D-G3c | **FIM ghost text** | 否(fim-client 已有) | **做,但先问在哪显示**——现 GUI 无可编辑面,ghost text 无处落。见 §7-Q3 | 取决于 Q3 |
| A4 | roadmap D-G3a/b/d | CodeMirror 真编辑 / 行内 patch 逐块接受 / 选中即问 | 否 | **待拍板**——v1.4 明确把编辑器收窄为只读 diff;重开等于推翻定稿。见 §7-Q3 | 取决于 Q3 |
| A5 | roadmap D-G5 | xterm 渲染 tool:result 输出终端 | 否 | **不做**——v1.5.1 已删 xterm 依赖;tool:result 在会话卡里够用 | — |
| A6 | roadmap D-G6 | TUI 对齐分支/检查点/审批/恢复 | 否 | **做**——`/recovery` 已对齐,补分支/检查点两个 slash 命令即可 | v1.9 |
| B1 | roadmap §3 非目标 | MCP 工具接入 | **是**(工具平面扩展点) | **待拍板**——UI 入口已存在两个月;要么做、要么把入口撤了。见 §7-Q2 | 取决于 Q2 |
| B2 | roadmap §3 非目标 | 插件市场 | 是 | **不做**(v2 之前)——没有分发就没有插件生态;与 B1 共用扩展点,B1 落地后再议 | v2.x |
| B3 | roadmap §3 非目标 | 多模型供应商 | 是 | **不做**——产品定位是 DeepSeek 原生;`models.{act,think,fim}` 已可换模型 id | — |
| B4 | roadmap §3 非目标 | 产品化打包 / 分发 | 否(工程) | **做**——与重写报告 C1 合流;零分发 = 零用户。见 §7-Q1 | v1.8 或 v1.9 |
| C1 | 重写报告 | **不换语言**;Node 优化包 5–8 人月:native tree-sitter / worker 池 / 懒加载 / 打包器 | 是(context 引擎) | **分两半**:打包器归 B4;索引原生化单独立项(见 C2) | — |
| C2 | 重写报告 | 索引热点:WASM tree-sitter → native binding + worker_threads,冷索引 5–12× | 是 | **做,但排在 v2**——语义引擎默认关(opt-in),性能痛点未被用户报告过;先做能感知的东西 | v2.x |
| C3 | 重写报告 | 内核 daemon 化(kernel 与 GUI 进程解耦,为未来换语言铺路) | **是,破坏性** | **不做**(可见未来)——报告自己说"若动机只是性能,不值得";D-G7 之后 kernel-host 已够薄 | — |
| D1 | 台账 #10 | agent-runtime 阶段 3–4 重构 | 是 | **v2.0.0**——维护者已定案,不改 | v2.0 |
| D2 | 台账 #7 后半 | shell 命令白名单(v1.2 延后) | 是(security) | **不做**——v1.3.1 的命令级分类已覆盖其目标;白名单在 agent 场景是负收益(误拦 > 拦对) | — |
| E1 | tmp 审计 | v1.8.0 工学换肤(5 暗 5 明主题、卡片两段式、玻璃态、氛围层) | 否 | **做**——用户原稿已给,审计已完成,只差 spec/plan 落库。见 §7-Q4/Q5 | v1.8 |
| E2 | tmp 审计 | 推理正文 / TPS / 会话 id 暴露(gap-map 标"v1.9 待办") | 是(事件负载) | **合并进 A1**——正是"契约冻结"要决定的字段集 | v1.9 |
| E3 | tmp 审计 | 现有缺陷:assistant 回复不入流、usage 首屏一次不刷新、`.sn-*` 未定义变量 | 否 | **做,越早越好**——这三条不是换肤,是 GUI 当前就坏着 | v1.7.2 |
| F1 | 运维 | v1.7.1 推送 + tag;dependabot 8 条分支(5 条指向死原型) | 否 | 立即清 | v1.7.1 |
| F2 | 运维 | v1.7.0 敏感模态 Electron 冒烟截图(文档承诺未兑现) | 否 | 并入 E3 同一片 | v1.7.2 |

---

## 3. 装箱方案(按版本)

版本级别按 [docs/README 命名规则](../../README.md#版本命名规则):minor = 规划内小功能不重构核心;major = 破坏性重构 / 支柱级新能力,由维护者启动。

### v1.7.2 · GUI 缺陷补丁(patch)

**内容**:E3 三条 + F2。
**理由**:这三条缺陷让 GUI 的会话视图**现在就显示不出 agent 回复**,任何换肤都建立在坏地基上;先修再美化。
**内核改动**:无(全在 `gui/src`)。
**体量**:小。

### v1.8.0 · 工学换肤(minor)

**内容**:E1,按 `d:\tmp\inkstone-v1.8-work\audits\proposal-gamma.md` 的 P0–P3(P4 时间线抽屉是否含入见 Q5)。
**理由**:用户原稿在,审计在,视觉是用户最直接感知的价值。
**内核改动**:无(`src/apps/event-contract.js` 属 app 层,允许)。
**体量**:约 v1.4.0 的一半(γ 方案估算)。
**前置**:v1.7.2 必须先落(γ 方案的 P2 依赖 assistant 入流)。
**后续动作**:本文拍板后,立即把 tmp 审计稿收敛为 `docs/specs/frontend/2026-09-XX-v1.8.0-ergo-restyle-design.md` + plan,**把 tmp 里的思考救进仓库**。

### v1.9.0 · 契约冻结 + 多智能体可视化(minor)

**内容**:A1 + A2 + A6 + E2。
**理由**:A2 让"多智能体调度"这个支柱第一次在 GUI 上可见;A1 是它的测试骨架;E2 的字段(推理 token、会话 id)正好在 A1 决定。三者一起做避免契约改两次。
**内核改动**:E2 可能需要 `model:response` 事件多带字段 —— **这是 v1.1 以来第一次动 `src/core` 事件负载**,需在 plan 里单独标红并加刻画测试。
**体量**:中。

### v1.8 或 v1.9 · 分发(minor,可独立)

**内容**:B4 + C1 的打包器部分:根包 `files` 字段 + npm 发布(需解决包名,Q1)+ electron-builder 三平台 + GitHub Actions(test + build + release on tag)。
**理由**:13 个 tag 至今没有一个用户能安装的产物。
**内核改动**:无。
**位置**:不依赖 v1.8/v1.9 任何内容,可插在任意两版之间;建议**紧跟 v1.8.0**——换肤后正是第一次对外的好时机。

### v2.0.0 · 内核重构(major,维护者启动)

**内容**:D1(agent-runtime 阶段 3–4)+ C2(索引原生化)+ B1/B2 若 Q2 决定做则在此落扩展点。
**理由**:三项都动内核契约或性能地基,按规则归大版本;放一起是因为都要先做"契约固化"(A1)再动手。
**前置**:v1.9.0 的 A1 契约冻结。

### 明确不做(写进本文即定案,后续不再讨论)

A5 输出终端、B3 多供应商、C3 daemon 化、D2 shell 白名单。若日后要翻案,改本文而不是另起讨论。

---

## 4. 依赖图

```
v1.7.1 推送/tag(F1)
   └─► v1.7.2 缺陷补丁(E3+F2)
          └─► v1.8.0 换肤(E1)  ──►  分发(B4)  [可对调]
                 └─► v1.9.0 契约冻结 + Inspector(A1+A2+A6+E2)
                        └─► v2.0.0 内核重构(D1+C2+B1?)
```

单向依赖,每版独立可发布。v1.8.0 与分发可对调;v1.9.0 之前必须有 v1.7.2。

---

## 5. 与既有决策的关系

| 既有决策 | 本文立场 |
|---|---|
| roadmap §3「MCP 非目标」vs GUI 已有 MCP 入口 | 矛盾**交维护者**(Q2);本文不预设答案 |
| v1.4「编辑器只读 diff」vs roadmap D-G3「Agent-aware 编辑器」 | 矛盾**交维护者**(Q3);FIM 招牌的落点取决于此 |
| 重写报告「优先分发」vs roadmap「分发非目标」 | 本文**采纳报告**:非目标写于 V3 开工前(2026-06),彼时产品未成形;现在三支柱已落地,分发的前提成立了 |
| 重写报告「不换语言」 | **采纳**,并把 C3 daemon 化明确列为不做 |
| 「kernel 零改动」纪律(v1.4 起) | v1.7.2 / v1.8.0 / 分发继续守;**v1.9.0 首次有条件放开**(仅事件负载加字段,须刻画测试);v2.0.0 放开 |
| #10 延后大版本(2026-09-15) | 不改,落 v2.0.0 |

---

## 6. 每版的验收线(通用)

1. `npm test` 只增不减;`npm run check`;`cd gui && npm run build:renderer`;e2e ×4。
2. `git diff --stat main..HEAD -- src/core src/deepseek src/tools src/edits src/sessions src/context src/security src/workspace` 为空(v1.9.0 起按该版 plan 的白名单放开)。
3. 版本四处同步 + CHANGELOG + docs/README「当前版本」+ 带注解 tag + **推送**(v1.7.1 的教训:发布 = 推到远端,不是打完 tag)。
4. 文档顺序:代码 → specs/plans → project-overview → CHANGELOG → 索引。

---

## 7. 需要维护者拍板的决策(拍板前本文不转 plan)

| # | 问题 | 选项 | 影响 |
|---|---|---|---|
| **Q1** | npm 包名 `inkstone` 已被占,发布用什么名? | (a) scope 包 `@<你的 npm 用户名>/inkstone`;(b) 改名如 `inkstone-code` / `inkstone-agent`;(c) 暂不发 npm,只发 GitHub Release 二进制 | 决定分发片的形态;(c) 最省事但 `npx` 装不了 |
| **Q2** | MCP:做,还是撤掉侧栏入口? | (a) 做——需在 `tools/registry` 加装配期扩展点(内核改动,归 v2.0);(b) 撤入口——侧栏 5 项变 3 项,smoke 点击链要改;(c) 保持"规划中"空态到 v2.0 | (c) 是现状,代价是 UI 上挂着两个月的空承诺 |
| **Q3** | 编辑器方向:守 v1.4「只读 diff」,还是重开 D-G3? | (a) 守——FIM 落点改为 **TUI**(`/fim` 补全命令,不需要编辑面)或 **CLI**(`inkstone fim <file>:<line>`);(b) 重开 D-G3a 轻编辑——FIM 在 GUI 做 ghost text,但要推翻 v1.4 定稿并引入 CodeMirror | (a) 保守且 FIM 立刻可用;(b) 是 roadmap 原意但代价大。**建议 (a)** |
| **Q4** | v1.8.0 的 `lastLight` 默认值 | (a) `latte`(与现有 `day→latte` 迁移一致);(b) `paper`(新 UI 顺序首个浅色) | γ 方案遗留;纯偏好 |
| **Q5** | v1.8.0 含不含 P4 时间线抽屉 | (a) 含——v1.4 删了 RewindDialog 后 GUI 再无回退 UI,这是真缺口;(b) 不含——推到 v1.9.0 与 Inspector 一起做 | (b) 更顺:时间线本就该吃 A1 的契约 |
| **Q6** | 分发放 v1.8 之后还是之前? | (a) v1.8.0 换肤先,分发紧随;(b) 分发先,让用户先装上再看新皮 | 无技术依赖,纯节奏 |

**维护者拍板(2026-09-17)**:
- **Q1** → 暂不管;**项目后续可能改名**,npm 包名随改名一并定。分发片的 npm 部分挂起,GitHub Release 二进制部分不受影响。
- **Q2** → **先评估工作量再定**。待办:出一份 MCP 接入工作量评估(扩展点 + 协议客户端 + 权限映射 + UI),再决定做/撤/保持。
- **Q3** → 维护者要求详细说明后再定(见下方「Q3 展开」)。
- **Q4** → 采纳建议:`latte`。
- **Q5** → 采纳建议:时间线抽屉推 v1.9.0。
- **Q6** → **v1.8.0 换肤先行**;前端界面与主题设计先展开探讨,再定 plan。

**Q3 展开(编辑器方向与 FIM 落点)**:

背景事实:FIM(Fill-In-the-Middle)是 DeepSeek 的代码补全接口——给它光标前后的代码,它补中间那段。内核 `src/deepseek/fim-client.js` 从 v1.0 就完整实现了,但**三端没有任何一处调用它**,因为补全需要一个"光标所在的编辑面",而 v1.4 定稿把 GUI 编辑器收窄成了 Monaco **只读 diff**(只能看改动对比,不能打字)。V3 roadmap 的 D-G3 里程碑原本规划了"Agent-aware 编辑器"(CodeMirror 可编辑 + FIM ghost text + 选中即问),v1.4 时被明确砍掉。

所以 Q3 实际是两个问题叠在一起:① GUI 要不要重新有一个可编辑的代码面?② FIM 这个内核能力要不要接出来、接到哪?

| 选项 | 含义 | 代价 | FIM 怎么落 |
|---|---|---|---|
| **(a) 守 v1.4** | GUI 继续只读 diff,不做编辑器 | 零——现状 | FIM 落到**不需要编辑面**的地方:TUI 加 `/fim <文件>:<行>` 命令(在终端里给一行位置,打印补全建议);或 CLI `inkstone fim <文件>:<行>`。用户在自己的编辑器里改代码,用 Inkstone 只做"问一下这里该补什么" |
| **(b) 重开 D-G3a** | GUI 引入 CodeMirror 可编辑面,支持打字、保存、脏标记 | 大:新依赖、新组件、与 editService 的保存事务对接、推翻 v1.4 定稿、smoke 与截图基线重做 | FIM 做成编辑器里的 ghost text(灰色内联建议,Tab 接受),这是 roadmap 原意 |
| **(c) 中间路**  | GUI 不做通用编辑器,只在**改动视图的 diff 上**加"就这一处让 FIM 再给个版本"按钮 | 小:复用 Monaco diff 已有的 before/after,不引新依赖 | FIM 有了 GUI 入口,但不是打字补全,是"对一处改动要替代方案" |

建议 (a):Inkstone 的定位是 agent(它替你改),不是 IDE(你自己改);把编辑器做回来会和 VS Code 正面竞争且永远做不过。(c) 值得作为 v1.9 的候选记一笔。

**Q3 拍板(2026-09-17)→ (a)**:守 v1.4 只读 diff;FIM 落 TUI `/fim` / CLI `inkstone fim`,归 v1.9.0(A6 TUI 对齐一并做);(c) 记为 v1.9 候选。

**v1.8.0 设计决策(2026-09-17 同日拍板)**:
- **主题集**:保持 10 套,**不做五明五暗**,要有明暗之间的**过渡色主题**(中间调)。具体分档见 v1.8.0 spec。
- **实施策略**:**先做 γ(分层渐进,DOM 冻结)**;**β(按原稿解剖学重建标记)保留为后续升级路径**,不删。γ 的每一层都要为 β 留门——类名与 token 槽位不做会让 β 更难的改动。
- **氛围层**:**不做**粒子画布;保持**极简**,但要有**舒适性**(留白、圆角、柔光、字阶这类低成本质感,不是动效堆砌)。蓝图网格作 CSS 背景可留、可关。

---

## 8. 拍板后的第一批产出(Claude 负责)

1. `docs/specs/frontend/2026-09-XX-v1.8.0-ergo-restyle-design.md` + plan —— 把 tmp 审计稿救进仓库(最紧迫,tmp 随时会丢)
2. `docs/plans/frontend/2026-09-XX-v1.7.2-gui-defects.md` —— 三条缺陷 + 冒烟截图,写到 mimo 零上下文可做
3. `docs/plans/architecture/2026-09-XX-distribution.md` —— 按 Q1 结论
4. 本文状态改「已评审」,并把处置结论回写 V3 roadmap 各 D-G 行(标 ✅ / ⏩ 归入 v1.x / ✗ 不做)
