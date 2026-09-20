# DeepSeek Code V3 Phase D-4 · GUI agent 改动跟踪设计

> 类型:前端设计 spec(frontend)
> 日期:2026-07-02
> 状态:待评审,待 user review → 实施计划
> 关联:[D-3 全功能+设置页](2026-07-02-v3-phase-d3-gui-full-functional-design.md) · [D-2 GUI 做真](2026-07-01-v3-phase-d2-gui-functional-design.md)

---

## 1. 背景与目标

D-3 后 GUI 全功能可用。D-4 目标:**用户能看到 agent 具体改了哪些文件/位置 → 点击跳转到编辑器对应位置 → 查看该次改动的「修改前 vs 修改后」对比**。

**已定四决策(brainstorm 逐题拍板)**:
1. **对比数据源 = 方案 C(记录内 before/after)**:摸底发现 change 记录不止 unified diff——`captureChangePlan` 应用前读原文存 `files[].before`(`src/changes.js:14-23`),`finalizeChange` 应用后读新文存 `files[].after`(`src/changes.js:36-52`),整条落盘 `.deepseek-code/changes/<id>.json`。`describe(id)` 直取前后全文喂现成 DiffView,零解析零反推,时点精确(不受后续编辑污染);新建/删除文件 before/after 为 null → 单侧为空,天然表达。原方案 A(渲染 unified 文本)放弃 Monaco 双栏体验、B(读当前文件反推 before)时点失真,均弃。
2. **入口 = SCM 视图内新分区「AGENT 改动」+ Agent 面板 diff 卡片联动**:SCM 侧栏(现有 分支+检查点 两区)加第三区;VS Code 心智同构(SCM=变更中心),不膨胀活动栏。实时+历史合并:打开时拉历史,`file:diff_applied` 事件按 `change_id` 增量刷新。
3. **点击行为 = 主开对比、次跳编辑器 + hunk 级跳转**:点文件行 → 主区开 before↔after 对比;对比头部「跳到编辑器」(首 hunk)+ 各 hunk 行号 chip(点单个 chip 跳编辑器对应段落,`revealLineInCenter` + clamp)。
4. **列表范围 = 全部显示 + 来源标签**:agent 改动与 GUI 手动保存(D-3 起同走 `editService.apply` 落 changes/)都列,标签区分(识别规则:prompt 前缀 `"GUI edit "` → 手动,kernel-host 自有约定可靠可判);已回滚标记(↺)一并做(`.deepseek-code/rollbacks.jsonl` 每行 `{time,id,forced}` + 实时 `file:rollback_applied` 事件,皆有 change_id,便宜)。

**摸底钉死的事实(实施依据)**:
- change 记录形状:`{id, time, prompt, diff(unified 全文), summary:[{path,status}], files:[{path,oldPath,newPath,status,before,after}], transaction_id?}`;`summary` 无 +/− 计数。
- 只读读取器正路:`createChangeStore({projectRoot})` → `.list({limit})`(按 time 倒序全记录)/ `.describe({change_id})`(整记录,支持 `"latest"`)(`src/edits/change-store.js`)。**注意 `editService.describe()` 只回元数据不含 before/after,不用它。**
- `file:diff_applied` 真实 payload:`{change_id, approval_id, summary:[{path,status}], files:[路径], diff_hash, diff_size}`(`src/edits/edit-service.js:146-153`);session 订阅扁平化转发 `{...data, type, meta, branch_id}`(`src/sessions/session-manager.js:34-36`);GUI 保存经 kernel-host 自建 editService 亦 pushEvent 同形状。
- **现存真 bug(D-4 顺手修)**:`gui/src/state/agent-cards.js:21-22` 与 `gui/src/state/panels-derive.js:23` 读不存在的 `e.path/e.added/e.removed` → diff 卡片恒显示空路径 +0 −0。
- hunk 解析:`parseUnifiedDiff(diff)` → `[{oldPath, newPath, hunks:[{oldStart, oldLines, newStart, newLines, lines:[{type:" "|"+"|"-", text}]}]}]`(`src/patch.js`)→ 每文件 `added/removed`(+/− 行计数)与 `hunkStarts`(各 `newStart`)可直接算。

---

## 2. 非目标(留后续)
- hunk 级智能重定位(文件后续被改后按内容追踪漂移;首发按记录行号跳 + clamp)。
- 改动列表全文搜索 / 来源过滤器(先标签;列表真长再加)。
- 从跟踪面板发起回滚(回滚仍走 agent/CLI;面板只读)。
- diff 内编辑、跨 change 聚合视图(按文件看全部历史)。

---

## 3. 数据流:kernel-host 只读改动桥(src 零改动)

沿 D-3 桥套路(lazy dynamic import src 工具),新增两方法:

- **`listChanges({limit=50})`**:`createChangeStore({projectRoot}).list({limit})` → **主进程瘦身**后过 IPC(剥 `files[].before/after` 与 `diff` 全文,大记录不进渲染层)。每条轻量条目:
  `{id, time, prompt, files:[{path, status, added, removed, hunkStarts}], rolledBack}`。
  富化就地完成:`parseUnifiedDiff(record.diff)` 按路径对齐(patch 路径 = `newPath==="/dev/null" ? oldPath : newPath`)算 added/removed/hunkStarts;读 `rollbacks.jsonl` 行 JSON 取 id 集合(Set 去重)打 `rolledBack`。**diff 解析失败 → 该条 files 无计数(added/removed/hunkStarts 为 null),不抛**;rollbacks.jsonl 缺失/坏行 → 视为无回滚。
- **`describeChange(changeId, relPath)`**:`store.describe({change_id})` → 只回**指定文件切片**(缺省首文件):
  `{id, time, prompt, rolledBack, file:{path, status, before, after, language, added, removed, hunkStarts}}`。
  language 用 kernel-host 现成 `EXT_LANGUAGE` 映射;找不到 change/文件 → 抛错(渲染层显示错误)。
- **IPC/preload/useKernel**:`changes:list` / `changes:describe` 频道,preload `listChanges(limit)` / `describeChange(id, path)`,命名与现有 `settings:get` 等一致;useKernel 包 `refreshChanges` / `openChangeDiff` / `dismissChangeDiff` / `revealInEditor`。

---

## 4. 渲染层状态与纯逻辑

- **reducer 新状态**:`changes:[]`(轻量条目)· `changeDiff: null | {meta:{id,time,prompt,rolledBack}, file, error?}` · `pendingReveal: null | {path, line}`。
  新 action:`changes_loaded` / `change_diff_loaded` / `change_diff_dismissed` / `reveal_requested` / `reveal_consumed`(加载中沿用现有 `loading_changed`,key=`changes`/`changeDiff`)。
- **新纯函数 `gui/src/state/changes-derive.js`**:
  - `deriveChangeEntries(list)`:归一 + 来源识别(`source:"manual"|"agent"`,prompt 前缀 `"GUI edit "`)+ 展示字段(时间短格式、prompt 截断)。
  - `changesVersion(activity)`:数 `file:diff_applied`+`file:rollback_applied` 事件数 → App 层 useEffect 依赖它触发 `refreshChanges()`(挂载首拉一次;事件驱动重拉,历史为底、`change_id` 天然对齐)。
  - **as-built 注(2026-07-05)**:上条未按原样落地——实现为 reducer 直接收这两个事件自增 **`changesTick`** 触发重拉(activity 50 条滑窗下事件计数不单调,不能当版本号);偏差已记 plan M2 与 CHANGELOG D-4 条目。
- **顺手修复(真 bug)**:
  - `agent-cards.js`:diff 卡片改为 `{kind:"diff", changeId:e.change_id||null, path:首路径(files[0]||summary[0].path), fileCount, applied}`;卡片显示 `首文件 (+N)`,**携带 changeId 使卡片可点**。计数不造假:事件不带 diff,卡片不显 +/−(完整计数在改动分区)。
  - `panels-derive.js`:`file:diff_applied` 输出行改 `edit 首路径 (+N files)` 形式。

---

## 5. UI:SCM 分区 + ChangeDiffView + 跳转

- **SCM 侧栏第三区「AGENT 改动」**(`Explorer.jsx` scm 分支加一段):时间倒序,每条 change 可折叠(默认最新一条展开),头行 = `时间 · prompt截断 · 来源标签 · ↺已回滚(如有)`;子行 = `M/A/D path +a −r`(无计数时省略)。点子行 → `openChangeDiff(id, path)`。空态(无记录/无桥)给占位提示。
- **`ChangeDiffView.jsx`(新组件)**:`state.changeDiff` 非空时在 EditorGroup 代码区替代 Editor 渲染(同现有 dirty `showDiff` 内嵌模式;**不进标签条**——伪标签会搅乱 openFiles 的 dirty/保存语义;changeDiff 优先于 dirty showDiff,关闭后回)。头部:`path · 时间 · prompt` + hunk chips(`@@ 12`)+ 「跳到编辑器」(=首 hunk)+ ✕;主体:现成 `DiffView`(`original=before, modified=after`,readOnly 双栏)。
- **跳转机制**:chip/按钮 → 先 `change_diff_dismissed`(对比占编辑区,须让位)→ `kernel.openFile(path)` + `reveal_requested{path, line:hunkStart}`;EditorGroup 加 useEffect:`pendingReveal && activeFile===pendingReveal.path && editorRef 就绪` → `revealLineInCenter(clamp(line, 1, model.getLineCount()))` + `setPosition` → `reveal_consumed`。行号漂移(文件后续又被改)按记录行号跳 + clamp,不智能重定位。跳转目标文件已删 → 走现有 openFile 错误路径(error_reported)。
- **Agent 面板卡片联动**:diff 卡片点击 → `openChangeDiff(changeId, 首文件)`(actions 注入);多文件其余从 SCM 分区点。
- **i18n**:新文案全入 `strings.js`(`changes.*`),zh 默认。

---

## 6. 硬约束(实施判据)
1. **kernel(`src/`)零改动**;新增只在 `gui/`(change-store / patch.js 经 dynamic import 复用)。
2. **大文本不滥载**:列表条目必须瘦身(无 before/after/diff 全文);前后全文仅 describe 单文件按需过 IPC。
3. **只读**:GUI 侧对 changes/ 与 rollbacks.jsonl 只读,绝不写。
4. **确定性可测**:changes-derive / kernel-host 桥(瘦身/富化/切片/降级)/ 卡片与面板派生修复 / reducer 新 action / clamp 纯逻辑全 node:test;分区/DiffEditor/revealLine 走 build + 门控 smoke。
5. **优雅降级**:无桥 / list 失败 / describe 失败 / diff 解析失败 / 记录缺字段 → 提示或缺省显示,不崩。
6. **双语**:新文案入 i18n(zh 默认)。
7. 提交前单独跑验证确认绿。

---

## 7. 里程碑(供拆实施计划;每 Task 末测试+提交)
```
D4-M1  kernel-host 只读改动桥(listChanges 瘦身+富化+rollback 标记 / describeChange 文件切片)+ IPC/preload + node:test
D4-M2  渲染层纯逻辑(changes-derive 来源标签+changesVersion + reducer 新 action + agent-cards/panels-derive 字段修复)+ node:test
D4-M3  SCM「AGENT 改动」分区 UI + useKernel 接线 + i18n + build
D4-M4  ChangeDiffView(hunk chips + 跳到编辑器 revealLine + clamp)+ Agent 卡片可点 + build
D4-M5  门控 smoke(分区+对比挂载截图)+ 全量回归(≥837 全绿 + npm run check)+ 文档(project-overview D-4 / CHANGELOG / README 中英 / docs/README 索引)
```
> 纯逻辑(M1 桥 mock 盘上记录 / M2 派生)内联先跑;M3/M4 UI 走 build + 门控 smoke。

---

## 8. 测试策略(node:test + build/门控 smoke)
- **kernel-host 桥**(tmp 目录造真 change JSON + rollbacks.jsonl):list 输出**不含** before/after/diff 全文;added/removed/hunkStarts 正确;rolledBack 标记命中;describe 切片回 before/after+language;缺 change/文件 → 抛错;坏 diff → 无计数不抛;无 changes 目录 → []。
- **changes-derive**:`"GUI edit x"` → manual、其余 agent;归一与截断;`changesVersion` 只数两类事件。
- **agent-cards / panels-derive 修复**:用**真实 payload 形状**(change_id/summary/files)断言卡片带 changeId、首路径、fileCount;旧字段(path/added/removed)期望删除。
- **reducer**:新 action 状态机(loaded/dismissed/reveal 流转;reveal_consumed 清 pendingReveal)。
- **clamp/跳转纯逻辑**:行号越界钳制。
- **build/smoke(门控)**:SCM 改动分区渲染 + ChangeDiffView 挂载(真项目截图落 `gui/__screenshots__`)。
- **回归**:核心 `npm test` ≥837 全绿(kernel 零改动;门控 skip);`npm run check`。

---

## 9. 开放问题(实施中定)
- 列表条数首发固定 `limit=50`;「加载更多」等真需要再加(YAGNI)。
- prompt 截断长度与悬浮完整显示(title 属性即可)。
- 多文件 change 的卡片点击默认首文件——是否加「文件选择」下拉(倾向不加,SCM 分区已可逐文件点)。
- rollbacks.jsonl 同 id 多行(重复回滚)→ Set 去重即可。
