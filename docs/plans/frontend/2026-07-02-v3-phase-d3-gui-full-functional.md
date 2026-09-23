# V3 Phase D-3 · GUI 全功能可用 + 设置页实施计划

- 类型：实施计划
- 日期：2026-07-02
- 状态：已完成
- 关联：[CHANGELOG](../../CHANGELOG.md) · [设计 spec](../../specs/frontend/2026-07-02-v3-phase-d3-gui-full-functional-design.md) · [D-2 GUI 做真](2026-07-01-v3-phase-d2-gui-functional.md) · [D-4 改动跟踪](2026-07-02-v3-phase-d4-change-tracking.md)

## 目标

打通设置页、API 配置、模型拉取、分支切换、检查点回退、可编辑保存与 diff，并补齐菜单/过滤/面板派生。

## 结果

### 配置桥 + API 列表 + listModels

`gui/api-profiles.js`：`createApiProfiles({ dir, readFile, writeFile })` → `{ list, save, remove, activate, getActive }`。存储 `<dir>/gui-api-profiles.json`，形状 `{ profiles: [{ id, name, baseUrl, apiKey }], activeId }`。`save` 无 id 时分配 `p_<n>`；`activate` 写 `activeId`；原子写。

kernel-host 接口：

| 方法 | 行为 |
|---|---|
| `getSettings()` | `{ prefs, config: maskConfig(...), apiProfiles: map(maskKey) }`，无明文 Key |
| `setConfig(patch)` | `configureProject(root, patch)` |
| `listApiProfiles` / `saveApiProfile` / `deleteApiProfile` / `activateApiProfile` | profile CRUD；激活时回写 `apiKey` / `baseUrl` / `model` |
| `listModels(profileId, { fetchImpl })` | `GET {baseUrl}/models` → `data[].id`；无 key / 非 2xx 抛错；无默认模型 |
| `testConnection(profileId?)` | `provider.testDeepSeekConnection(config)` |
| `activateBranch(id)` | `kernel.session.branches.activate(id)` |
| `writeFile` | `wholeFileDiff` → `editService.apply` |

`maskKey` → `{ id, name, baseUrl, hasKey, keyMask }`。IPC/preload：`settings:get`、`config:set`、`api:list|save|delete|activate`、`models:list`、`conn:test`、`session:branch-activate`、`fs:write`。

### 纯逻辑模块

| 模块 | Produces | 语义 |
|---|---|---|
| `file-filter.js` | `filterTree(tree, q)` | 空 q 全量；子串不分大小写；命中文件保留父目录链；无命中 → [] |
| `menu-model.js` | `menuModel(t)` / `resolveAction(id)` | 文件 / 编辑 / 查看 / 帮助结构 |
| `save-diff.js` | `wholeFileDiff(path, before, after)` | unified 整文件 diff；before===after → 空 |
| 面板派生 | `derivePanels(activity, errors)` | problems = verification 失败 + agent:error + errors；output = 事件流行 |

reducer 增 `railView` / settings / dirty / menu 状态。

### 设置视图与保存

`gui/src/state/settings-schema.js`：

- `SETTINGS_GROUPS`：general、appearance、statusDisplay、api、model、limits、orchestration、context、experience、about。
- `getByPath` / `setByPath`（不可变深写）、`coerceField`（bool / enum / posInt / nonNegInt / nullableInt / number）、`applyFieldEdit`、`sanitizeConfigPatch`（剥 `hasKey`）。

设置 UI 读 `getSettings`，写 `setConfig` / `setPreferences`。API 列表可增删改与激活；「获取模型」填下拉，失败红字；Key 密码框 + 掩码。

可编辑保存：dirty 追踪（`file_edited` 对比 `original`），Ctrl/⌘+S → `fs:write`（`editService.apply`）→ `file_saved` 清 dirty。`DiffView` 为 Monaco DiffEditor，入口为 diff 卡片或保存后。

分支真切换与检查点 rewind（`rewindPreview` → 确认弹层 → `rewindApply`，取消不 apply）接 kernel 会话 API。标题跟随 `activeFile` 基名；状态栏含 Ln/Col、语言、模型徽标、问题数。

v1.4.0 会话优先改版后，IDE 式标题栏菜单与底部问题/输出面板收缩；设置 / API / 模型 / diff 语义延续到现役 Settings 模态与 Changes dock。

## 关键决策 / 遗留约束

- API Key 不回渲染层明文；明文仅落 `.deepseek-code/`。
- 模型无默认；失败报错不回退。
- 保存必经 `editService`（事务 + 回滚 + change 记录），不裸 fs 写；过 workspace 边界。
- kernel 零改动；双语文案默认 zh。
- 优雅降级：无桥 / 读写失败 / 切换失败 → 提示不崩。
- 提交前单独验证绿，不用管道吞退出码。

## 验证

- api-profiles CRUD 与 activate 回写；listModels mock fetch（ok / 401）；getSettings 全响应无 `sk-` 明文；settings-schema 归一；filterTree / menu-model / save-diff / derivePanels；rewind mock 流（preview→confirm→apply）。
- 设置改动即时生效并持久化；连接测试与获取模型可手工验证。
- `npm run build:renderer` + 门控 smoke（设置视图、菜单、Monaco diff）。
- 全量 `npm test` + `npm run check`。
- 现役入口：设置模态（`,`）→ API / 模型 / 各配置组；右栏 changes diff。
