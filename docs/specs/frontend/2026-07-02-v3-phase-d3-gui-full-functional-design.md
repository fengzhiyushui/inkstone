# V3 Phase D-3 · GUI 全功能可用与设置页

- 类型：前端 spec
- 日期：2026-07-02
- 状态：已实现
- 关联：[D-2 做真](2026-07-01-v3-phase-d2-gui-functional-design.md) · [D-4 改动跟踪](2026-07-02-v3-phase-d4-change-tracking-design.md)

## 问题与目标

D-2 后核心工作流已通，仍有半可用元素。本片把它们做成可用，并新增设置页（含模型接入 API 列表）。保存走 `editService.apply`，与 agent 编辑同一事务/回滚管线。

## 决策

| 选了什么 | 否决了什么 | 为什么 |
|---|---|---|
| 设置页开在主区，左导航右表单 | 挤侧栏 | 对齐 VS Code |
| API 列表管理（增删改激活） | 单条 apiKey/baseUrl | 多供应商 |
| 模型从 `GET {baseUrl}/models` 拉取，无默认 | 硬编码默认模型 | 拉不到就报错 |
| 保存经 `editService.apply` | 裸 fs 写 | 事务 + change 记录 + 可回滚 |
| 搜索先文件名过滤 | 立刻全文搜索 | 范围可控 |
| 菜单真下拉 + 实用子集 | 铺满 VS Code 全菜单 | 范围可控 |
| 激活 profile 写 `config.json` | GUI 私有配置 | kernel 读现有配置，零改动 |

不做：改动跟踪（D-4）、全文搜索、多终端、文件监视、拖拽、虚拟滚动。

## 设计

设置七组：

| 组 | 项 | 落盘 |
|---|---|---|
| 通用 | 语言、主题、界面偏好 | GUI 偏好 |
| 模型接入 | API 列表 CRUD + 激活、模型拉取、reasoning effort、连接测试 | `.deepseek-code/gui-api-profiles.json` + 激活写 `config.json` |
| 运行护栏 | toolTimeoutMs / modelTimeoutMs / maxTurnTokens / maxModelCalls / maxToolCallRepairs | `config.limits` |
| 多智能体 | crossTaskLearning、router 档、maxRounds、并行数 | `config.orchestration` |
| 语义上下文 | semantic.enabled / hops / maxSymbols / languages / importRoots | `config.context.semantic` |
| 持久化恢复 | recovery.enabled | `config.recovery` |
| 关于 | 版本、许可、链接 | 静态 |

配置桥（kernel-host，src 零改动）：

- `getSettings()` 合并公开配置 + GUI 偏好 + API 列表；任何 apiKey 只回 `hasKey`/掩码（如 `sk-…abcd`）。
- `listApiProfiles` / `saveApiProfile({id?,name,baseUrl,apiKey})` / `deleteApiProfile` / `activateApiProfile`。存储 `{ profiles:[{id,name,baseUrl,apiKey}], activeId }`。激活把 `apiKey`/`baseUrl`/model 写入 `config.json`。Key 明文只落盘。
- `setConfig(patch)` 复用 `src/config.js` 写 `.deepseek-code/config.json`，per-field 合并。
- `testConnection(profileId?)` 复用 `provider.testDeepSeekConnection`。
- `listModels(profileId?)` 调 `{baseUrl}/models`（`Authorization: Bearer {apiKey}`）取 `data[].id`；失败抛错，Settings 红字报错，不静默回退。`config.model` 仅在用户选定后写入。

活动栏视图：`explorer` / `search`（文件名过滤 `filterTree`）/ `scm` / `run`（占位）/ `settings`。标题栏菜单由 `menu-model.js` 纯模型驱动，自绘浮层。状态栏 Ln/Col 来自 Monaco `onDidChangeCursorPosition`，语言=activeFile.language，模型徽标=config.model。底部问题/输出由 `derivePanels(activity)` 派生。

分支切换：`activateBranch(id)` → `kernel.session.branches.activate(id)`，IPC `session:branch-activate`。检查点回退接 `rewindPreview`/`rewindApply` 并确认弹层。

可编辑保存：Monaco 可写，dirty 进 reducer；`Ctrl/⌘+S` → `writeFile` 生成整文件 unified diff → `editService.apply({ diff, prompt:"gui edit" })`，成功清 dirty。Monaco Diff 只读对比 before/after。

## 边界与不变量

- `src/` 零改动。
- API Key 不回渲染层明文。
- 保存经 `editService`，过 workspace 边界。
- 菜单模型、视图切换、搜索过滤、设置归一、面板派生、diff 映射、保存 diff 生成可 node:test。
- 无桥/读写失败降级不崩。
- 新文案入 i18n（zh 默认）。

## 与现状的差异

设置现为模态（[v1.8.1](2026-09-20-v1.8.1-dsh-shell-design.md)），分组见 `gui/src/state/settings-schema.js` 与 `gui/src/components/Settings/`。API 列表存储文件名仍为 `.deepseek-code/gui-api-profiles.json`。改动/恢复已迁右栏 dock。

## 验收

- `getSettings` 脱敏；API 列表 CRUD/激活；`listModels` 失败抛错且无预设默认。
- 视图切换、菜单、状态栏、面板、分支切换、rewind 确认流、保存 dirty 流单测。
- build/smoke 覆盖设置、菜单、diff 挂载。
- 回归全绿。
