# V3 Phase D-4 · GUI agent 改动跟踪实施计划

- 类型：实施计划
- 日期：2026-07-02
- 状态：已完成
- 关联：[CHANGELOG](../../CHANGELOG.md) · [设计 spec](../../specs/frontend/2026-07-02-v3-phase-d4-change-tracking-design.md) · [D-3 全功能](2026-07-02-v3-phase-d3-gui-full-functional.md) · [敏感脱敏](2026-08-09-sensitive-file-warning-and-display-redaction.md)

## 目标

GUI 展示 agent 改了哪些文件与位置，点开看 before↔after，并支持 hunk 级跳到对应行。

## 结果

kernel-host 只读接 `src/edits/change-store.js`（`createChangeStore({ projectRoot })` → `.list({ limit })` / `.describe({ change_id })`）与 `src/patch.js`（`parseUnifiedDiff(diff)` → `[{ oldPath, newPath, hunks: [{ newStart, lines: [{ type, text }] }] }]`）。

### 桥接口

**`host.listChanges({ limit = 50 })`**

```text
Promise<Array<{
  id, time, prompt, rolledBack,
  files: Array<{ path, status, added: number|null, removed: number|null, hunkStarts: number[]|null }>
}>>
```

- time 倒序。
- 列表**必须不含** `files[].before/after` 与 `diff` 全文。
- `added` / `removed` 由 `parseUnifiedDiff` 统计；解析失败时为 `null` 并省略显示。
- `rolledBack` 对照 `.deepseek-code/rollbacks.jsonl`（只读）。

**`host.describeChange(changeId, relPath?)`**

```text
Promise<{
  id, time, prompt, rolledBack,
  file: { path, status, before: string|null, after: string|null, language, added, removed, hunkStarts }
}>
```

- `relPath` 缺省取首文件；`changeId` 缺省 `"latest"`；找不到 throw。
- `language` 复用 kernel-host 既有 `languageForExt`。

**IPC / preload**

- `changes:list` / `changes:describe`。
- `window.deepseek.listChanges(limit)` / `describeChange(id, relPath)`（经 `wrap`，错误回 `{ error }`）。

### 渲染层

`gui/src/state/changes-derive.js` 纯函数：

| 函数 | 语义 |
|---|---|
| `deriveChangeEntries` | 记录 → 列表行（文件数、来源、状态） |
| `statusLetter` | 状态字母 |
| `clampLine` | 行号夹紧 |
| `shortTime` | 短时间显示 |

reducer 新状态：`changes`、`changesTick`、`changeDiff`、`pendingReveal`。新 action：`changes_loaded`、`change_diff_loaded`、`change_diff_dismissed`、`reveal_requested`、`reveal_consumed`。

`useKernel` 暴露 `refreshChanges` / `openChangeDiff` / `dismissChangeDiff` / `revealInEditor`。`file:diff_applied` 与 `file:rollback_applied` 推进 `changesTick`，`App` 用 effect 在 tick 变化时 `refreshChanges()`。

UI 落点现为右栏 `ChangesPanel` + `ChangeDiffView`（复用 Monaco `DiffEditor`，可带 `title` / `actions`）。hunk chips 可跳编辑器对应行（`pendingReveal` → reveal 语义）。Agent 卡片的 diff 卡可点，带 `changeId`。

`file:diff_applied` 真实字段为 `change_id` / `files` / `summary`。`agent-cards` 与面板派生按此读取；`files` 元素既可能是对象也可能是字符串路径，归一必须两者都收。

来源识别：prompt 前缀 `"GUI edit "` → `manual`，其余 → `agent`（kernel-host `writeFile` 自有约定）。v1.7.0 起 `describe` 过 `src/security/redactor.js`，存储原文不变。

### 顺手修复

`agent-cards` / panels 派生曾读不存在字段；本阶段按真实事件字段校正。

## 关键决策 / 遗留约束

- kernel 零改动；新增只在 `gui/`，src 工具经 dynamic import 复用。
- 大文本不滥载：全文只经 `describeChange` 单文件切片按需过 IPC。
- GUI 对 `.deepseek-code/changes/` 与 `rollbacks.jsonl` 只读（smoke 种子除外，写后即删）。
- 缺字段 / 解析失败 / describe 失败 → 提示或缺省显示（计数为 null 时省略），不崩。
- 双语文案进 `gui/src/i18n/strings.js`（`changes.*`）。
- 验证命令：`node --test <file>`；全量 `npm test`（当时基线 ≥837）；`npm run check`；`cd gui && npm run build:renderer`；门控 smoke 期望 `GUI_SMOKE_READY`。
- 提交前单独验证绿，不用 `npm test | grep` 吞退出码。

## 验证

- `tests/unit/gui/kernel-host-changes.test.js`：list 瘦身（无 before/after/diff 全文）、rollback 标、describe 切片、`latest` 缺省、找不到 throw、hunkStarts 统计。
- `tests/unit/gui/changes-derive.test.js`：状态字母、行号 clamp、时间格式、字符串/对象 files 归一。
- 追加 `agent-cards` / `workbench-state` / i18n 断言。
- build + 门控 smoke；全量回归 + `npm run check`。
- 现役入口：右栏 dock → 改动页签（`J` 开关右栏）；点条目开 diff；hunk 跳转。
