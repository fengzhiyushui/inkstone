# V2-14 GUI 工作台刷新与分支回退实施计划

- 类型：实施计划
- 日期：2026-05-31
- 状态：已完成
- 关联：[CHANGELOG](../../CHANGELOG.md) · [设计 spec](../../specs/frontend/2026-05-31-v2-14-gui-workbench-branch-rewind-design.md) · [V2-15 自然 Agent 工作台](2026-05-31-v2-15-natural-agent-workbench.md) · [V2-16 交互加固](2026-05-31-v2-16-gui-interaction-hardening.md)

## 目标

把 Electron GUI 收成三栏 Agent 工作台，露出用量/延迟/缓存指标，并打通分支、检查点与回退流程。

## 结果

### 宿主与 IPC

`gui/kernel-host.js` 增加 `getActiveBranch()` 代理。IPC 与 preload 暴露：

| 桥方法 | 语义 |
|---|---|
| `listBranches` | 分支列表 |
| `getActiveBranch` | 当前活动分支 |
| `listCheckpoints` | 检查点列表 |
| `rewindPreview` | 回退预览 |
| `rewindApply` | 应用回退 |

`package.json` 的 check 脚本纳入新渲染状态模块。

### 纯状态模块

新建 `gui/renderer/workbench-state.js`（UMD/CommonJS 纯函数；后迁 `gui/src/state/workbench-state.js`）。覆盖：

- 全局状态与空态可见性
- 分支列表 / 活动分支 / 选中分支
- 检查点列表 / 选中检查点 / 目标解析
- rewind preview / result / force 开关
- activity 缓冲（后有上限，防长会话无界增长）
- usage / speed / cache-hit 指标派生

目标解析 `targetFromCheckpoint`：优先 `turn_id`，再 `event_id`，最后 `seq`。

现役选择器与格式化仍来自该模块：`targetFromCheckpoint`、`formatRewindStatus`、`metricsFromUsage`、`formatTokenCount`、`formatCacheRate`、`formatLatency`、`statusSummary`、`trafficTone`、`trafficLabel`、`shortId`。

指标格式化语义：token 数 ≥1000 显示 `n.nK`；cache rate 优先 `cache_hit_rate`，否则 `hits/(hits+misses)`；latency ≥1000ms 显示 `n.ns`，否则 `ms`。

回退结果文案：

| status | 文案语义 |
|---|---|
| `success` | 回退已应用，新分支激活 |
| `conflict` | 脏文件阻挡回退 |
| `conflict_restored` | 回退被挡，先前改动已恢复 |
| `failed_restored` | 回退失败，工作区已恢复 |
| `failed_unrestorable` | 回退恢复失败，需人工检查 |
| 其它 | `Rewind status: <status>` |

### 事件与渲染

`event-adapter` 补 branch / rewind / recovery 摘要与状态。UMD 渲染层重做为三栏 workbench（侧栏 + 会话 + 检查器），CSS 刷新视觉系统与布局。控制器把分支点选、检查点选中、preview、force、apply 接到状态机。动态内容全程 `textContent`。

不加框架、打包器或运行时依赖。不做 diff viewer 与分支删除。

## 关键决策 / 遗留约束

- 保持三栏工作台概念，不收成单聊天栏。
- 状态纯函数化，DOM 控制器只做协调；渲染 XSS-safe。
- 检查点目标优先 `turn_id`，再 `event_id`，最后 `seq`。
- 本阶段出界：diff viewer、分支删除、新依赖。
- 静态测试要求 DOM id、禁 `innerHTML`、无乱码旧文案。

## 验证

- `tests/unit/gui/workbench-state.test.js`：分支/检查点选择、目标解析、rewind 状态与文案、metrics 格式、activity 缓冲、空态可见性。
- `tests/unit/gui/kernel-host.test.js`：active branch 代理（注入 mock kernel）。
- `tests/unit/gui/renderer-event-adapter.test.js`：新事件摘要。
- 静态安全测试。
- 手工：选分支 → 选检查点 → preview → force → apply → 结果提示。
- 全量 `npm test` + `npm run check`。
- 现役对照：`gui/src/state/workbench-state.js` 的 rewind/metrics 导出；检查器模式 `branch` / `checkpoints` / `rewind`。
