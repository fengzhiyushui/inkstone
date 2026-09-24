# Inkstone post-V3 路线图

- 类型：路线图
- 日期：2026-09-17
- 状态：已评审（拍板结论见文末；装箱版本以 CHANGELOG 为准）
- 更新（2026-09-23）：**B4（打包 / 分发）暂缓**——维护者判定当前产品成熟度未达打包水平，已撤相应实施计划；重启时机由维护者评估后另立。
- 关联：[V3 路线图](2026-06-24-v3-roadmap-design.md) · [审计补救台账](../backend/2026-07-12-agent-findings-remediation.md) · [agent-runtime 边界](../backend/2026-08-09-v1.6.3-agent-runtime-refactor-design.md) · [v1.4 前端定稿](../frontend/2026-07-28-v1.4.0-frontend-redesign-design.md)

---

## 问题与目标

V3 三支柱落地后，v1.1.0 到 v1.7.1 主要由审计补账驱动，台账项已基本清零。后续需求散落在 V3 未勾里程碑、非目标清单、延后项与未入库评估稿里。本文收拢成一张处置表，按版本装箱，并列出需维护者拍板的决策。

本文不替代各版本 plan，也不预设拍板结果之外的结论。

## 现状事实（2026-09-17 核对，细节以代码为准）

| 事实 | 证据 | 影响 |
|---|---|---|
| FIM 内核在、前端未接线 | `src/deepseek/fim-client.js`；三端无 `fimComplete` 调用 | 「招牌」能力无 UI 落点 |
| GUI 有 MCP/插件入口，内容为空态 | GUI concept 视图 | 与 V3「MCP 非目标」矛盾 |
| 工具注册表无插件扩展点 | `src/tools/registry.js` 仅 register/resolve/listTools | 做 MCP/插件需先加装配期扩展点 |
| 当时零分发能力 | 无 `files`/`publishConfig`/CI/electron-builder | 用户只能 clone |
| npm 名 `inkstone` 被占 | `npm view inkstone` | 发 npm 需 scope 或改名 |
| 语义索引 WASM tree-sitter | `web-tree-sitter` optionalDependency + `src/context/grammars/` | 重写评估的第一热点 |
| `agent-runtime.js` 体量大，已有刻画测试 | v1.6.3 | 可重构，护栏在 |
| 编辑器为 Monaco 只读 diff | v1.4 决策 | D-G3 整组未做 |

## 收拢处置表

| # | 来源 | 项 | 内核改动 | 处置 | 装箱 |
|---|---|---|---|---|---|
| A1 | D-0 | 共享契约 schema 校验 + 事件回放 fixtures | 否 | 做 | v1.9 |
| A2 | D-G2 | Agent Inspector | 否 | 做 | v1.9 |
| A3 | D-G3c | FIM ghost text | 否 | 做，但先定显示面（Q3） | 随 Q3 |
| A4 | D-G3a/b/d | 真编辑 / 行内 patch / 选中即问 | 否 | 待拍板（Q3） | 随 Q3 |
| A5 | D-G5 | xterm 输出终端 | 否 | 不做 | — |
| A6 | D-G6 | TUI 分支/检查点/审批/恢复对齐 | 否 | 做 | v1.9 |
| B1 | V3 非目标 | MCP 工具接入 | 是 | 待拍板（Q2） | 随 Q2 |
| B2 | V3 非目标 | 插件市场 | 是 | 不做（v2 前） | v2.x 后再议 |
| B3 | V3 非目标 | 多模型供应商 | 是 | 不做 | — |
| B4 | V3 非目标 | 打包 / 分发 | 否 | 做 | v1.8 或 v1.9 |
| C1 | 重写评估 | Node 优化包（打包器等） | 部分 | 打包器并入 B4；其余见 C2 | — |
| C2 | 重写评估 | WASM tree-sitter → native + worker | 是 | 做，排 v2 | v2.x |
| C3 | 重写评估 | 内核 daemon 化 | 是，破坏性 | 不做 | — |
| D1 | 台账 #10 | agent-runtime 深度重构 | 是 | v2.0.0 | v2.0 |
| D2 | 台账 #7 | shell 命令白名单 | 是 | 不做（命令级分类已覆盖） | — |
| E1 | 换肤审计 | 工学换肤 | 否 | 做 | v1.8 |
| E2 | 换肤审计 | 推理正文 / TPS / 会话 id 暴露 | 是（事件负载） | 并入 A1 | v1.9 |
| E3 | 换肤审计 | assistant 不入流、usage 不刷新、未定义变量 | 否 | 尽早修 | v1.7.2 |
| F1 | 运维 | 推送 tag、清理 dependabot 死分支 | 否 | 立即清 | v1.7.1 |
| F2 | 运维 | 敏感模态冒烟截图 | 否 | 并入 E3 | v1.7.2 |

## 装箱

- **v1.7.2 · GUI 缺陷补丁**：E3 + F2。先修显示坏损再换肤。内核无改动。
- **v1.8.0 · 工学换肤**：E1。主题集保持 10 套并含中间调；实施先做 γ（分层渐进、DOM 冻结），β 保留升级路径；不做粒子氛围层，保留低成本质感。前置 v1.7.2。
- **v1.9.0 · 契约冻结 + 多智能体可视化**：A1 + A2 + A6 + E2。E2 首次可能给 `model:response` 加字段，需刻画测试。
- **分发（minor，可独立）**：B4 + 打包器。建议紧随 v1.8.0。npm 命名随项目改名一并定。
- **v2.0.0 · 内核重构（major）**：D1 + C2 + 若 Q2 决定做则落扩展点。前置 v1.9 契约冻结。
- **明确不做**：A5、B3、C3、D2。若翻案改本文。

## 依赖

```
v1.7.1 推送/tag
  → v1.7.2 缺陷补丁
    → v1.8.0 换肤  ↔  分发（可对调）
      → v1.9.0 契约冻结 + Inspector
        → v2.0.0 内核重构
```

## 与既有决策的关系

| 既有决策 | 立场 |
|---|---|
| V3「MCP 非目标」vs GUI 已有入口 | 矛盾交 Q2 |
| v1.4「只读 diff」vs D-G3 编辑器 | 矛盾交 Q3 |
| 重写评估「优先分发」vs V3「分发非目标」 | 采纳评估：前提已成立 |
| 重写评估「不换语言」 | 采纳；C3 不做 |
| 「kernel 零改动」纪律 | v1.7.2 / v1.8.0 / 分发继续守；v1.9 有条件放开事件负载；v2.0 放开 |
| 台账 #10 延后大版本 | 不改，落 v2.0.0 |

## 每版验收线

1. `npm test` 只增不减；`npm run check`；GUI renderer 构建通过。
2. 默认内核目录无未授权 diff（v1.9 起按该版 plan 白名单）。
3. 版本号、CHANGELOG、docs 索引、tag 与远端推送一致（发布以推到远端为准）。
4. 文档顺序：代码 → specs/plans → 总览 → CHANGELOG → 索引。

## 拍板结论（2026-09-17）

| # | 问题 | 结论 |
|---|---|---|
| Q1 | npm 包名 | 暂缓；项目后续可能改名，包名随改名定。GitHub Release 不受影响 |
| Q2 | MCP 做或撤入口 | 先出工作量评估（扩展点 + 协议客户端 + 权限映射 + UI）再定 |
| Q3 | 编辑器与 FIM 落点 | **(a) 守 v1.4 只读 diff**；FIM 落 TUI `/fim` / CLI `inkstone fim`，归 v1.9；对 diff 一处要替代方案的 (c) 记为 v1.9 候选 |
| Q4 | v1.8.0 `lastLight` 默认 | `latte` |
| Q5 | v1.8.0 是否含时间线抽屉 | 否，推 v1.9.0 |
| Q6 | 分发节奏 | v1.8.0 换肤先行 |

Q3 补充：Inkstone 定位是 agent 代改，不是 IDE 自改；把可编辑面做回来会与 IDE 正面竞争。FIM 需要光标编辑面时改为 TUI/CLI 位置补全，不引入编辑器依赖。

## 验收

本文生效后：新需求先对照处置表定位装箱；拍板项未结清不转 plan；每版满足「每版验收线」四条。
