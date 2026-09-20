# V3 Phase D-3 · GUI 全功能可用 + 设置页 实施计划

> 完成状态以 [CHANGELOG](../../CHANGELOG.md) 为准。

> **执行说明:** 按 TDD bite-sized 步骤落地,每 Task 末「跑测试 + 提交」。
> **纯逻辑(M1/M3/M4/M6/M9)可内联先跑**;设置表单 / Monaco diff / 真切换(M2/M5/M7/M8/M10)走 build + 门控 smoke。
> 提交前**单独验证绿**(勿用 `npm test | grep` 吞退出码后直接提交)。
>
> 设计 spec:[2026-07-02-v3-phase-d3-gui-full-functional-design.md](../../specs/frontend/2026-07-02-v3-phase-d3-gui-full-functional-design.md)。

**Goal:** 把 GUI 所有半可用/不可用做成可用 + 新增设置页(API 列表管理 + 模型获取 + 全量可调项)。

**Architecture:** kernel(`src/`)零改动;kernel-host 复用现成 `configureProject`/`loadConfig`/`testDeepSeekConnection`/`branches.activate`/`editService`/`rewind*`,加 API-profiles 存储 + `listModels` fetch。渲染层派生/菜单/过滤/归一纯函数化 → node:test。

**Tech Stack:** React19 + Vite7 + Monaco(含 DiffEditor)· node:test · 复用 `src/config.js`/`src/provider.js`。

## Global Constraints(每 Task 隐含遵守)
- **kernel(`src/`)零改动**;新增只在 `gui/`(复用现成 src util/API)。
- **API Key 不回渲染层明文**:`getSettings`/`listApiProfiles` 只回 `hasKey`/掩码;明文仅落盘(`.deepseek-code/`,随仓忽略)。
- **保存经 `editService.apply`**(事务+回滚+change 记录),不裸 fs 写;过 workspace 边界。
- **模型无默认**:模型下拉只由 `listModels` 填充,失败报错、不回退。
- **双语**:新文案入 i18n(zh 默认)。
- **确定性可测**:归一/CRUD/listModels(mock fetch)/菜单模型/过滤/派生/保存 diff 全 node:test;UI/Monaco/真切换走 build+门控 smoke。
- **优雅降级**:无桥/读写失败/切换失败 → 提示不崩。

---

## File Structure(增量)

| 文件 | 责任 | 动作 |
|------|------|------|
| `gui/api-profiles.js` | API 列表存储 CRUD + activate(注入 fs/config 可测) | 新建 |
| `gui/kernel-host.js` | getSettings(脱敏)/setConfig/testConnection/listModels + 接 api-profiles + activateBranch + writeFile(editService) | 改 |
| `gui/main.js` · `gui/preload.js` | 新 IPC:settings/api/models/branch-activate/file-write | 改 |
| `gui/src/state/settings-schema.js` | 设置分组/归一纯函数 | 新建 |
| `gui/src/state/menu-model.js` | 标题栏菜单结构 + action | 新建 |
| `gui/src/state/file-filter.js` | `filterTree(tree,q)` | 新建 |
| `gui/src/state/panels.js`(或 agent-cards 旁)| `derivePanels(activity)` | 新建 |
| `gui/src/state/save-diff.js` | `wholeFileDiff(path, before, after)` | 新建 |
| `gui/src/state/workbench-state.js` | railView / settings / dirty / menu 状态 | 改 |
| `gui/src/components/Settings/*` | 设置视图(7 组 + API 列表 + 模型获取) | 新建 |
| `gui/src/components/{ActivityBar,TitleBar,StatusBar,Explorer,EditorGroup,Terminal}.jsx` | 切视图/菜单/状态/分支/编辑保存/diff | 改 |
| `gui/src/components/DiffView.jsx` | Monaco DiffEditor | 新建 |
| `tests/unit/gui/*.test.js` · `tests/e2e/gui-*.test.js` | 单测 + 门控 | 新建/改 |
| docs | 收口 | 改 |

---

## Task D3-M1 · 配置桥 + API 列表 + listModels(内联,mock fetch)

**Files:** 新建 `gui/api-profiles.js`;改 `gui/kernel-host.js`/`main.js`/`preload.js`;新建 `tests/unit/gui/api-profiles.test.js`、`tests/unit/gui/kernel-host-settings.test.js`。

**Interfaces:** `createApiProfiles({ dir, readFile, writeFile })` → `{ list(), save(p), remove(id), activate(id), getActive() }`(Key 掩码在 host 层做)· host `getSettings()` · `setConfig(patch)` · `listModels(profileId?, { fetchImpl })` · `testConnection(profileId?)` · `activateBranch(id)`。

- [ ] **Step 1: api-profiles 失败测试**
```js
import test from "node:test"; import assert from "node:assert/strict";
import { promises as fs } from "node:fs"; import os from "node:os"; import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createApiProfiles } = require("../../../gui/api-profiles.js");
async function tmp() { return fs.mkdtemp(path.join(os.tmpdir(), "dsc-api-")); }

test("save assigns id, activate persists activeId, remove drops", async () => {
  const store = createApiProfiles({ dir: await tmp() });
  const p = await store.save({ name: "deepseek", baseUrl: "https://api.deepseek.com", apiKey: "sk-abc123" });
  assert.ok(p.id);
  await store.activate(p.id);
  assert.equal((await store.getActive()).id, p.id);
  const list = await store.list();
  assert.equal(list[0].name, "deepseek");
  await store.remove(p.id);
  assert.equal((await store.list()).length, 0);
});
```
- [ ] **Step 2–4: 实现** `api-profiles.js`(读/写 `<dir>/gui-api-profiles.json` = `{profiles:[{id,name,baseUrl,apiKey}],activeId}`;`save` 无 id 则分配 `p_<n>`;`activate` 设 activeId;原子写)→ 跑绿。
- [ ] **Step 5: kernel-host 失败测试**(`listModels` mock fetch;`getSettings` 脱敏)
```js
test("listModels returns ids on ok, throws on error, no default", async () => {
  const host = createKernelHost({ projectRoot: await tmp() });
  const ok = async () => ({ ok: true, json: async () => ({ data: [{ id: "m1" }, { id: "m2" }] }) });
  assert.deepEqual(await host.listModels(null, { fetchImpl: ok, baseUrl: "x", apiKey: "k" }), ["m1", "m2"]);
  const bad = async () => ({ ok: false, status: 401, text: async () => "unauthorized" });
  await assert.rejects(() => host.listModels(null, { fetchImpl: bad, baseUrl: "x", apiKey: "k" }));
});
test("getSettings masks api keys (never plaintext)", async () => {
  const host = createKernelHost({ projectRoot: await tmp() });
  await host.saveApiProfile({ name: "d", baseUrl: "u", apiKey: "sk-secret-123456" });
  const s = await host.getSettings();
  const prof = s.apiProfiles[0];
  assert.equal(prof.hasKey, true);
  assert.ok(!JSON.stringify(s).includes("sk-secret-123456")); // no plaintext anywhere
});
```
- [ ] **Step 6–8: 实现** kernel-host:
  - 接 `createApiProfiles`;`listApiProfiles/saveApiProfile/deleteApiProfile/activateApiProfile`(activate → `configureProject(root, { apiKey, baseUrl, model })`)。
  - `getSettings()` = `{ prefs: loadGuiPreferences, config: maskConfig(await loadConfig), apiProfiles: profiles.map(maskKey) }`(`maskKey` → `{id,name,baseUrl,hasKey,keyMask}` 无明文)。
  - `setConfig(patch)` = `configureProject(root, patch)`(非 API 类)。
  - `listModels(profileId, opts)` = fetch `GET {baseUrl}/models`(Bearer)→ `data[].id`;非 2xx/无 key → throw。`fetchImpl` 注入(默认 global fetch)。
  - `testConnection` = `provider.testDeepSeekConnection(config)`。
  - `activateBranch(id)` = `kernel.session.branches.activate(id)`。
- [ ] **Step 9: IPC/preload** — `settings:get`/`config:set`/`api:list`/`api:save`/`api:delete`/`api:activate`/`models:list`/`conn:test`/`session:branch-activate`/`fs:write`;preload 对应桥。node --check。
- [ ] **Step 10: 验证绿 → 提交** `feat(gui): settings/config bridge + API-profiles + listModels + branch-activate (D3-M1)` + 署名

---

## Task D3-M3 · 活动栏切视图 + 文件名过滤(内联纯逻辑)

**Files:** 新建 `gui/src/state/file-filter.js`;改 `workbench-state.js`(`railView`)、`ActivityBar.jsx`、`App.jsx`、`Explorer.jsx`。

- [ ] **Step 1: 失败测试** `filterTree(tree, q)`:空 q 全量;子串匹配(不分大小写);命中文件保留其父目录链;无命中→[]。reducer `rail_view_changed`。
- [ ] **Step 2–4: 实现** `filterTree`(递归:目录若有命中后代则保留)+ reducer `railView`(explorer/search/scm/run/settings)→ 跑绿。
- [ ] **Step 5:** ActivityBar 点选 → `rail_view_changed`;App 按 railView 渲染侧栏(explorer 树 / search 过滤框+过滤树 / scm 分支+检查点 / run 占位 / settings→主区);Explorer 复用。build 通过。
- [ ] **Step 6: 提交** `feat(gui): activity-bar view switching + file-name filter (D3-M3)` + 署名

---

## Task D3-M4 · 标题栏菜单模型 + 下拉(内联纯 + UI)

**Files:** 新建 `gui/src/state/menu-model.js`;改 `TitleBar.jsx`。

- [ ] **Step 1: 失败测试** `menuModel(t)` → 结构 `[{ label, items:[{ id, label, action, enabled }] }]`(文件:新建/打开/保存/全部保存;编辑:撤销/重做/查找;查看:切视图/主题/语言;帮助:关于);`resolveAction(id)` 映射。
- [ ] **Step 2–4: 实现** menu-model(纯,i18n)+ 跑绿。
- [ ] **Step 5:** TitleBar 自绘下拉浮层(点菜单展开、Esc/失焦关、键盘可达);action → 回调(save/openView/toggleTheme/…)。build 通过。
- [ ] **Step 6: 提交** `feat(gui): title-bar menus (model + dropdown + actions) (D3-M4)` + 署名

---

## Task D3-M6 · 底部面板 问题/输出(内联纯派生)

**Files:** 新建 `gui/src/state/panels-derive.js`;改 `EditorGroup.jsx`。

- [ ] **Step 1: 失败测试** `derivePanels(activity, errors)` → `{ problems:[...], output:[...] }`:问题=`verification:result`(pass:false)+`agent:error`+errors;输出=事件流格式化行。
- [ ] **Step 2–4: 实现** → 跑绿。
- [ ] **Step 5:** EditorGroup 面板 问题/输出 渲染派生(终端保留 D-2);问题数进状态栏。build。
- [ ] **Step 6: 提交** `feat(gui): bottom panel problems/output from event stream (D3-M6)` + 署名

---

## Task D3-M9 · 保存整文件 diff(内联纯逻辑)

**Files:** 新建 `gui/src/state/save-diff.js`;测试。

- [ ] **Step 1: 失败测试** `wholeFileDiff(path, before, after)` → unified diff 字符串(整文件替换,含 `--- a/path`/`+++ b/path` + hunk);before===after → 空(无需保存)。
- [ ] **Step 2–4: 实现**(整文件 unified diff)→ 跑绿。
- [ ] **Step 5: 提交** `feat(gui): whole-file unified diff for GUI save (D3-M9)` + 署名

---

## Task D3-M2 · 设置视图(门控·UI)

**Files:** 新建 `gui/src/components/Settings/*`、`gui/src/state/settings-schema.js`;改 `App.jsx`(settings 视图入主区)、i18n。

- [ ] `settings-schema.js`(纯):7 组字段定义 + 归一(posInt/enum/bool)+ 单测。
- [ ] Settings 视图:左二级菜单(通用/模型接入/运行护栏/多智能体/语义上下文/恢复/关于)+ 右表单;读 `settings:get`,写 `config:set`/`setPreferences`。
- [ ] **模型接入**:API 列表(增删改 + 激活)+ 「获取模型」→ `models:list` 填下拉(**无默认、失败红字**)+ 连接测试。Key 输入密码框、显示掩码。
- [ ] i18n 全文案;build 通过 → 提交 `feat(gui): settings view (7 groups + API list + model fetch) (D3-M2)` + 署名

---

## Task D3-M5 · 标题跟随文件 + 状态栏真实(门控·UI)
- [ ] 中间标题 = activeFile 基名;状态栏 Ln/Col ← Monaco `onDidChangeCursorPosition`;语言 ← activeFile;模型徽标 ← config.model;问题数 ← derivePanels。
- [ ] build → 提交 `feat(gui): dynamic title + real status bar (cursor/lang/model) (D3-M5)` + 署名

---

## Task D3-M7 · 分支真切换(门控·后端)
- [ ] SCM/Explorer 点分支 → `session:branch-activate` → `activateBranch` → 刷新 activeBranch + 时间线;失败降级提示。单测(mock kernel activate)。
- [ ] 提交 `feat(gui): real branch switch (activate) (D3-M7)` + 署名

---

## Task D3-M8 · 检查点 rewind(门控·后端)
- [ ] 点检查点 → `rewindPreview` → 确认弹层(显 `formatRewindStatus`/影响)→ 确认 `rewindApply` → 结果入状态;取消不 apply。单测(preview→确认→apply mock)。
- [ ] 提交 `feat(gui): checkpoint rewind (preview→confirm→apply) (D3-M8)` + 署名

---

## Task D3-M10 · 可编辑保存 + Monaco diff(门控·UI+后端)
- [ ] Monaco `readOnly:false` + dirty(reducer `file_dirty`)+ Ctrl/⌘+S → `fs:write`(kernel-host `writeFile` = `wholeFileDiff` → `editService.apply`)→ 清 dirty。单测(mock editService:diff 生成 + apply + 清 dirty + 边界拒斥)。
- [ ] `DiffView.jsx`(Monaco `DiffEditor`)显示原↔改;入口:diff 卡片 / 保存后。build。
- [ ] 提交 `feat(gui): editable Monaco + save via editService + diff view (D3-M10)` + 署名

---

## Task D3-M11 · build + smoke + 截图 + 回归 + 文档
- [ ] 扩 smoke(门控):设置视图 + 菜单下拉 + Monaco diff 挂载。
- [ ] 截图:设置页(模型接入 API 列表)+ 切视图 + diff 双栏(真项目)。
- [ ] 全量回归 `npm test`(核心 813+新纯逻辑全绿;门控 skip)+ `npm run check`。
- [ ] 文档:overview GUI 段(设置/API 列表/编辑保存/diff)、CHANGELOG D-3 条目、README 中英(GUI 可配 API/模型 + 编辑保存)、docs/README 索引加 D-3 spec+plan。
- [ ] 提交 `docs: ship V3 Phase D-3 GUI full-functional + settings` + 署名

---

## Self-Review
- **Spec 覆盖**:§3 设置/API 列表/模型获取→M1/M2;§4.1 切视图→M3;§4.2 菜单→M4;§4.3 标题/状态栏→M5;§4.4 面板→M6;§4.5 分支→M7;§4.6 rewind→M8;§4.7 保存→M9/M10;§4.8 diff→M10;§6 里程碑↔M1–M11。
- **纯逻辑先行**:M1(api-profiles/listModels mock)/M3(filterTree)/M4(menu-model)/M6(derivePanels)/M9(save-diff)无 UI deps → 内联;M2/M5/M7/M8/M10 UI/后端接线走 build+门控 smoke。
- **安全**:API Key 掩码不回渲染层(M1 测试钉死);保存经 editService(M10)。**kernel 零改动**。
- **类型一致**:`settings-schema` 字段 M1 产/M2 消费;`menuModel`/`filterTree`/`derivePanels`/`wholeFileDiff` 纯函数产出被对应组件消费一致。
