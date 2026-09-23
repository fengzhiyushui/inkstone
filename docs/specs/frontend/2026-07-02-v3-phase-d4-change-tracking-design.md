# V3 Phase D-4 · GUI Agent 改动跟踪

- 类型：前端 spec
- 日期：2026-07-02
- 状态：已实现
- 关联：[D-3 全功能](2026-07-02-v3-phase-d3-gui-full-functional-design.md) · [D-G4 CLI 对齐](2026-07-12-v3-phase-dg4-cli-alignment-design.md)

## 问题与目标

用户需要看到 agent 改了哪些文件与位置，点击跳转编辑器对应行，并查看该次改动的 before/after 对比。列表同时含 agent 改动与 GUI 手动保存。

## 决策

| 选了什么 | 否决了什么 | 为什么 |
|---|---|---|
| 对比数据源 = change 记录内 `files[].before/after` | 渲 unified 文本 / 读当前文件反推 | 零解析，时点精确，新建/删除天然单侧为空 |
| 入口 = SCM「AGENT 改动」+ Agent diff 卡联动 | 再加活动栏一级 | SCM 是变更中心 |
| 点文件行开对比；hunk chip 跳编辑器 | 只跳转不对比 | 对比是主诉求 |
| 全部显示 + 来源标签 + 已回滚标记 | 过滤器先不做 | 列表真长再加 |

事实依据：change 记录含 `files[].before/after`（`captureChangePlan` / `finalizeChange`）；只读读取器走 `createChangeStore({projectRoot}).list/describe`，`editService.describe()` 不含 before/after，不用；`file:diff_applied` 带 `change_id`/`summary`/`files`；hunk 用 `parseUnifiedDiff`（`src/patch.js`）；手动保存 prompt 前缀 `"GUI edit "`；回滚看 `rollbacks.jsonl` 与 `file:rollback_applied`。

## 设计

kernel-host 只读桥：

- `listChanges({limit=50})` 主进程瘦身后过 IPC，条目 `{ id, time, prompt, files:[{ path, status, added, removed, hunkStarts }], rolledBack }`，不含 before/after/diff 全文。diff 解析失败则计数为 null，不抛。
- `describeChange(changeId, relPath)` 只回指定文件切片 `{ id, time, prompt, rolledBack, file:{ path, status, before, after, language, added, removed, hunkStarts } }`。language 用 `EXT_LANGUAGE` 映射；找不到 change/文件抛错。

IPC：`changes:list` / `changes:describe`。preload：`listChanges(limit)` / `describeChange(id, path)`。

渲染状态：`changes[]`、`changeDiff`、`pendingReveal`。action：`changes_loaded` / `change_diff_loaded` / `change_diff_dismissed` / `reveal_requested` / `reveal_consumed`。`file:diff_applied`/`file:rollback_applied` 自增 `changesTick` 触发重拉。

纯函数 `changes-derive.js`：`deriveChangeEntries` 归一来源标签（`source:"manual"|"agent"`）与展示字段。原 `changesVersion` 方案改为 reducer 内 `changesTick`，因为 activity 50 条滑窗下事件计数不单调。

UI：SCM 第三分区时间倒序折叠列表，头行 `时间 · prompt截断 · 来源标签 · ↺已回滚`，子行 `M/A/D path +a −r`。`ChangeDiffView` 在代码区替代 Editor（不进标签条），头部 path/时间/prompt + hunk chips + 「跳到编辑器」；`revealLineInCenter(clamp)`。diff 卡片可点，默认首文件。i18n 文案入 `changes.*`。

顺手修：`agent-cards.js` 与 `panels-derive.js` 误读不存在的 `e.path/e.added/e.removed`，改为 `change_id`/`summary`/`files`，diff 卡带 changeId 与首路径。

## 边界与不变量

- `src/` 零改动。
- 列表条目必须瘦身；前后全文仅 describe 单文件按需过 IPC。
- GUI 对 `changes/` 与 `rollbacks.jsonl` 只读。
- 派生/桥接/卡片修复/reducer/clamp 可 node:test。
- 无桥/坏 diff/缺字段降级不崩。
- 新文案入 i18n。

## 与现状的差异

当前改动列表与 diff 在右栏 Dock 的 `ChangesPanel` / `ChangeDiffView.jsx`，`openChangeDiff` / `dismissChangeDiff` / `reveal` 已在 `useKernel`。`changesTick` 驱动刷新。

## 验收

- list 瘦身、added/removed/hunkStarts、rolledBack、describe 切片、坏 diff 降级单测。
- 来源标签 `"GUI edit "` → manual。
- 卡片带 changeId 与首路径，旧字段期望删除。
- build/smoke 覆盖分区与对比。
- 全量 `npm test` 与 `npm run check` 通过。
