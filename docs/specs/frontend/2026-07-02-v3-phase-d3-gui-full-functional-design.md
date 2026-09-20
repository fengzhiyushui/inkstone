# DeepSeek Code V3 Phase D-3 · GUI 全功能可用 + 设置页设计

> 类型:前端设计 spec(frontend)
> 日期:2026-07-02
> 状态:待评审,待 user review → 实施计划
> 关联:[D-2 GUI 做真](2026-07-01-v3-phase-d2-gui-functional-design.md) · [D-1 外壳](2026-06-27-v3-phase-d1-gui-react-shell-design.md)

---

## 1. 背景与范围

D-2 后 GUI 核心工作流已通(真文件树 / Monaco 只读 / node-pty 终端 / 实时 Agent 卡片)。但仍有一批**半可用 / 不可用**元素。D-3 目标:**把所有半可用 / 不可用做成可用**,并**新增「设置」页**(含模型接入配置)。

**本片范围(用户已定:全部纳入 + 三决策全按推荐)**:
- **A 纯前端**:活动栏真切视图 · 标题栏菜单真下拉+动作 · 中间标题跟随当前文件 · 状态栏 Ln/Col/语言/模型徽标真实 · 底部面板 问题/输出 接真事件。
- **B 接后端**:分支真切换 · 检查点 rewind · **可编辑+保存(经 `editService`)** · Monaco diff 双栏。
- **C 设置页(新)**:活动栏最下方齿轮 → 设置视图;二级菜单含**模型接入**(API Key/BaseURL/模型)等 7 组;写盘经 kernel-host。
- **决策(已定)**:① 保存走 `editService.apply`(与 agent 编辑同一事务/回滚管线,不裸 fs 写)② 菜单真下拉 + 接一批实用动作(其余置灰/隐藏)③ 搜索先文件名过滤(全文搜索作面板内后续)。

**后端能力已确认**:`kernel.branches.activate(id)`(分支切换)· kernel-host `rewindPreview/apply`(rewind)· `editService.apply({diff})`(写盘)· `config` 读写(设置)。**kernel(`src/`)零改动**(仅 kernel-host 桥 + 复用现成 API)。

---

## 2. 非目标(留 D-4+)
- **改动跟踪(D-4)**:看 agent 改了哪些代码、点击跳转、修改前后对比 —— 独立成片。
- 全文搜索(本片文件名过滤;全文搜索后续)。
- 菜单铺满 VS Code 全部项(本片实用子集)。
- 多终端 / 分屏、文件监视热刷新、拖拽、虚拟滚动 —— 后续。

---

## 3. 设置页设计(核心新增)

**入口**:活动栏**最下方齿轮** → 设置视图**在主编辑区打开**(VS Code 式,不挤侧栏);左侧二级菜单 + 右侧表单。

**二级菜单(7 组,映射 `DEFAULT_CONFIG` + GUI 偏好)**:
| 组 | 项 | 来源/落盘 |
|---|---|---|
| **通用** | 语言(zh/en)、主题(night/day)、界面偏好 | GUI 偏好(`setPreferences`)|
| **模型接入** | **API 列表管理**(每条:名称 / Base URL / API Key,可增删改 + 激活)· 每条**模型从 API 获取填充**(不预设默认;获取失败报错)· reasoning effort · **连接测试** | API 列表存 `.deepseek-code/gui-api-profiles.json`(随仓忽略);激活的那条 → 写 `config.json`(kernel 用)|
| **运行护栏** | toolTimeoutMs / modelTimeoutMs / maxTurnTokens / maxModelCalls / maxToolCallRepairs | `config.limits` |
| **多智能体** | crossTaskLearning(off/on/gated)、router 模型档、maxRounds、并行数 | `config.orchestration` |
| **语义上下文** | semantic.enabled / hops / maxSymbols / languages / importRoots | `config.context.semantic` |
| **持久化恢复** | recovery.enabled | `config.recovery` |
| **关于** | 版本、许可、链接 | 静态 |

**配置读写(kernel-host,src 零改动)**:
- `getSettings()` → 合并 `getPublicConfig()` + GUI 偏好 + 各 config 子块(归一后)+ **API 列表(profiles,Key 掩码)**。**脱敏**:任何 apiKey 只回 `hasKey`/掩码(如 `sk-…abcd`),**绝不回明文**。
- **API 列表管理(新)**:`listApiProfiles()` / `saveApiProfile({id?,name,baseUrl,apiKey})`(增或改,分配 id)/ `deleteApiProfile(id)` / `activateApiProfile(id)`。存 `.deepseek-code/gui-api-profiles.json`(`{ profiles:[{id,name,baseUrl,apiKey}], activeId }`,**随仓忽略**)。**激活** → 把该 profile 的 `apiKey`/`baseUrl`(+ 已选 model)写进 `config.json`(kernel 读它,**kernel 零改动**)。Key 明文只落盘、不回渲染层。
- `setConfig(patch)` → 复用 `src/config.js` 写逻辑(写 `.deepseek-code/config.json`),per-field 合并;非 API 类设置(护栏/多智能体/语义/恢复)走这里。
- `testConnection(profileId?)` → 复用 `provider.testDeepSeekConnection`(现成),测指定/激活 profile。
- `listModels(profileId?)` → 调 DeepSeek API **`GET {baseUrl}/models`**(OpenAI 兼容,`Authorization: Bearer {apiKey}`,用指定/激活 profile)→ 取 `data[].id`。**不预设任何默认模型**;无 apiKey / 网络 / API 错误 → **抛错 → Settings 显示错误**(不静默回退)。选中的 model 存进该 profile(激活时写 `config.model`)。
- 归一化/校验用纯函数(node:test)。

> **API 列表 + 模型获取(用户新增要求)**:模型接入不是单条 apiKey/baseUrl,而是**一张 API 列表**——用户每加一个 API(名称/BaseURL/Key)存为一条,可增删改、可**激活**某条作为当前使用。模型部分不硬编码:选中/激活某条 → `listModels` 拉该条的可用模型填下拉,**不给默认**;拉不到就红字报错、下拉为空。`config.model` 仅在用户从获取到的列表里选定后写入。

---

## 4. 组件与接线(按组)

### 4.1 活动栏切视图(A)
`reducer.railView`(explorer/search/scm/run/settings);活动栏点选 → 切换侧栏/主区渲染:
- **explorer**(现有文件树)· **search**(文件名过滤,纯 `filterTree(tree, q)`)· **scm**(分支+检查点,移这里)· **run**(任务占位→后续)· **settings**(齿轮→主区设置视图)。

### 4.2 标题栏菜单(A)
`menu-model.js`(纯):菜单结构 + 每项 `action` id;点动作 → dispatch/调用(新建/打开/保存/全部保存、撤销/重做→Monaco、切主题/语言、切视图、关于)。下拉用自绘浮层(无第三方)。

### 4.3 中间标题 + 状态栏(A)
中间标题 = `activeFile ? baseName + " — deepseek-code" : "deepseek-code"`。状态栏 Ln/Col 来自 Monaco `onDidChangeCursorPosition`;语言=activeFile.language;模型徽标=config.model;EOL/编码 = 文件探测(默认 UTF-8/LF)。

### 4.4 底部面板 问题/输出(A)
`derivePanels(activity)` 纯:问题=`verification:result` 失败 + `agent:error` + `state.errors`;输出=事件流格式化。调试控制台占位保留。

### 4.5 分支真切换(B)
kernel-host 加 `activateBranch(id)` → `kernel.session.branches.activate(id)`;IPC `session:branch-activate`;preload;SCM/Explorer 点分支 → 切换 + 刷新 activeBranch。单测(mock kernel)。

### 4.6 检查点 rewind(B)
接现成 `rewindPreview`/`rewindApply`:点检查点 → `rewindPreview` → **确认弹层**(显示影响)→ `rewindApply`;结果入状态(`rewind_result_loaded`)。纯 preview→view 映射可测。

### 4.7 可编辑 + 保存(B,经 editService)
- Monaco `readOnly:false`;dirty 态(reducer `file_dirty`);Ctrl/⌘+S → `saveFile(path, content)`。
- kernel-host `writeFile(rel, content)` → 读原内容 → 生成**整文件 unified diff** → `editService.apply({ diff, prompt:"gui edit" })`(事务 + change 记录 + 可回滚);成功 → 清 dirty。
- 安全:仍过 workspace 边界;写走 editService(与 agent 同管线)。单测(mock editService,验证生成 diff + apply 调用 + dirty 清除)。

### 4.8 Monaco diff 双栏(B)
`@monaco-editor/react` 的 `DiffEditor`;当有 change/diff 时显示原↔改;入口:diff 卡片点击 / 保存后可看本次改动。只读对比。

---

## 5. 硬约束(实施判据)
1. **kernel(`src/`)零改动**;新增只在 `gui/`(kernel-host 桥复用现成 `branches.activate`/`editService`/`config`/`provider`)。
2. **API Key 不回渲染层明文**:`getSettings` 只回 `hasApiKey`/掩码;明文仅写盘。
3. **保存经 `editService`**(事务 + 回滚 + change 记录),不裸 fs 写;过 workspace 边界。
4. **确定性可测**:菜单模型 / 视图切换 / 搜索过滤 / 设置归一 / 面板派生 / diff-view 映射 / 保存 diff 生成 全 node:test;Monaco diff / 设置表单 / 真切换走 build + 门控 smoke。
5. **优雅降级**:无 kernel 桥 / config 读失败 / 分支切换失败 → 提示不崩。
6. **双语**:所有新文案入 i18n(zh 默认)。

---

## 6. 里程碑(供拆实施计划;每 Task 末测试+提交)
```
D3-M1  kernel-host 配置读写(getSettings 脱敏 / setConfig 复用 config.js / testConnection / **listModels 调 /models,失败抛错** / **API 列表 CRUD + activate,存 gui-api-profiles.json、激活写 config**)+ IPC/preload + 归一纯函数 + node:test
D3-M2  设置视图(7 组二级菜单 + 表单,读 config/prefs、写 setConfig/setPreferences、连接测试;**API 列表管理:增删改 + 激活;模型下拉由 listModels 填充,不预设默认,获取失败红字报错**)+ i18n + build
D3-M3  活动栏切视图(reducer railView + explorer/search/scm/run/settings)+ 文件名过滤纯函数 + 单测
D3-M4  标题栏菜单(menu-model 纯 + 自绘下拉 + 动作 dispatch)+ 单测
D3-M5  中间标题跟随文件 + 状态栏 Ln/Col(Monaco 光标)+ 语言/模型徽标 + 单测
D3-M6  底部面板 问题/输出(derivePanels 纯派生)+ 单测
D3-M7  分支真切换(kernel-host activateBranch + IPC + SCM 接线)+ 单测
D3-M8  检查点 rewind(preview→确认弹层→apply)+ 单测
D3-M9  可编辑 + 保存(Monaco 可写 + dirty + Ctrl+S + kernel-host writeFile 经 editService)+ 单测
D3-M10 Monaco diff 双栏(DiffEditor + 入口)+ build
D3-M11 build + 门控 smoke(设置/菜单/切视图挂载)+ 截图 + 回归全绿 + 文档
```
> 纯逻辑(M1 归一 / M3 过滤 / M4 菜单模型 / M6 派生 / M9 diff 生成)可内联先跑;设置表单/Monaco diff/真切换走 build+smoke。

---

## 7. 测试策略(node:test + build/门控 smoke)
- **设置**:`getSettings` 脱敏(任何 apiKey 不回明文、回 hasKey/掩码);`setConfig` per-field 合并 + 归一(非法回退);写盘含 apiKey 不回读。
- **API 列表**:`saveApiProfile` 增/改(分配 id)、`deleteApiProfile`、`activateApiProfile`(写 config.apiKey/baseUrl,persist activeId);`getSettings` 回列表时 Key 掩码。
- **listModels**(mock fetch):成功→模型 id 列表填充;无 apiKey/网络/API 错误→**抛错**(不回退默认);**下拉无预设默认**(未获取时为空)。
- **切视图**:railView 状态机;`filterTree(tree,q)` 文件名过滤(空 q 全量、匹配子串、保留父目录)。
- **菜单**:menu-model 结构 + action id 映射;禁用项标记。
- **状态栏/标题**:activeFile→标题/语言;Ln/Col 从光标事件更新(mock)。
- **面板**:`derivePanels` 问题(verification 失败/error)/输出 派生。
- **分支切换**(mock kernel):activate 调用 + activeBranch 刷新;失败降级。
- **rewind**:preview→确认→apply 流;取消不 apply。
- **保存**(mock editService):dirty→save→生成整文件 diff→apply→清 dirty;边界拒斥。
- **diff-view**:原↔改 model 映射。
- **build/smoke(门控)**:设置视图 + 菜单下拉 + Monaco diff 挂载;真项目截图。
- **回归**:现有 813 全绿(kernel 零改动;新纯逻辑并入;门控 skip)。

---

## 8. 开放问题(实施中定)
- 设置视图占主区 vs 独立标签页(倾向主区 Settings 标签,像 VS Code)。
- Monaco 可写与「只读查看」如何并存(D-2 只读 → D-3 默认可写但可切只读?倾向默认可写 + 保存前不自动写)。
- 保存整文件 diff 对大文件性能(先整文件,行级 diff 后续)。
- 菜单动作的完整清单(实施时定实用子集)。
- rewind 确认弹层的信息粒度(复用 `formatRewindStatus`)。
