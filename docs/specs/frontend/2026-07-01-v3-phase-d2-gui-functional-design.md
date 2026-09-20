# DeepSeek Code V3 Phase D-2 · GUI 做「真」(文件树/Monaco 只读/实时 Agent 卡片/交互终端)设计

> 类型:前端设计 spec(frontend)
> 日期:2026-07-01
> 状态:待评审,待 user review → 实施计划
> 关联:[D-1 GUI React 外壳](2026-06-27-v3-phase-d1-gui-react-shell-design.md) · [GUI 优化方案](../../plans/frontend/gui-frontend-optimization-plan.md)

---

## 1. 背景与范围

D-1 交付了手写 VS Code 风格四栏外壳(无 Semi、双语、无原生窗口壳),但文件树/编辑器/终端/Agent 卡片都是**标记占位**。D-2 把这些换成**真的**:

**本片范围(用户已定关键岔路)**:
1. **真文件树** —— 读真实项目目录,点文件 → 载入编辑器。
2. **Monaco 编辑器 · 只读查看器** —— VS Code 同款内核,真语法高亮显示真实文件(**可编辑/保存留 D-3**)。
3. **实时 Agent 卡片** —— 从真事件流派生 plan/工具/diff/测试卡,替换示例预览。
4. **交互终端 · node-pty** —— xterm + `node-pty` 真 PTY,可在项目根开真 shell 交互。
5. **修** D-1 遗留:`language` 偏好未持久化(`normalizeGuiPreferences` 丢字段)。

**延续不变量**:kernel(`src/`)零改动;GUI 后端(kernel-host)新增的只是**文件读取 / PTY 桥**(GUI 关注点,非 agent kernel);所有可测逻辑走 node:test,重集成(Monaco/xterm/pty)走 build + 门控 smoke;新依赖只进 `gui/package.json`。

---

## 2. 非目标(留 D-3+)
- **编辑器可编辑 + 保存**(接 edit-service 写盘)—— D-3。
- **diff 双栏视图**(diff2html / Monaco diff)—— D-3。
- 多标签页文件管理(本片单活动文件 + 少量最近打开)、文件树右键菜单/拖拽、搜索面板接真、Recovery Center UI —— 后续。
- 文件监视/热刷新(本片按需读,不 watch)。

---

## 3. 架构

```
Electron 主进程
  gui/main.js         + PTY 生命周期(spawn/data/input/resize/kill)IPC
  gui/kernel-host.js  + listTree() / readFile(rel)(路径安全)
  gui/preload.js      + fs.listTree/readFile + pty.* 桥
        │ IPC
React 渲染层
  Explorer   ← 真文件树(fs:tree),点选 → dispatch file_opened
  EditorGroup← Monaco 只读(@monaco-editor/react + 本地 monaco worker)显示 fs:read 内容
  AgentPanel ← deriveAgentCards(state.activity) 实时卡片
  Terminal   ← xterm(@xterm/xterm + addon-fit)↔ pty IPC
```

**核心**:kernel 不动;新增的文件/PTY 能力是 GUI 后端的**读/进程桥**;渲染层派生逻辑尽量纯函数化以可测。

---

## 4. 组件与接口

### 4.1 文件树 + 读文件(kernel-host,路径安全)
- `listTree()` → 递归遍历 `projectRoot`,排除 `.git`/`node_modules`/`.deepseek-code`/`renderer-dist`/`dist`;返回**扁平数组** `[{ path(rel, posix), name, type:"dir"|"file", depth }]`(渲染层组装折叠树);受 `maxEntries`(如 5000)封顶,超出截断标记。
- `readFile(relPath)` → 经 `src/workspace/path-safety.js` 的 `resolveWorkspacePath`(realpath 边界,阻 symlink 逃逸)解析;拒绝目录 / 超大(> ~1MB)/ 二进制(NUL 探测);返回 `{ path, content, language, truncated }`,`language` 由扩展名映射(js/ts/py/json/md/…)。
- IPC:`fs:tree` / `fs:read`;preload:`listTree()` / `readFile(rel)`。
- **kernel 不动**:这两个是 kernel-host 直接用 `fs` + 复用 `workspace/path-safety`(纯 util,非 kernel 实例)。

### 4.2 Monaco 只读编辑器
- 依赖:`monaco-editor` + `@monaco-editor/react`;**本地 worker**(Electron `file://` 离线,不能走 CDN):`loader.config({ monaco })` 绑本地 monaco + Vite worker 配置(`?worker` 或 `vite-plugin-monaco-editor`),`base:"./"` 下 worker 路径相对。
- 组件:`readOnly:true`、`theme: 主题==night?"vs-dark":"vs"`、`language` 来自 `fs:read`、`minimap` 关或简、字体 `"Cascadia Code"`。空态显示占位提示。
- EditorGroup 标签页反映**已打开文件集**(state 里 `openFiles` + `activeFile`);点树 → 打开/激活。

### 4.3 实时 Agent 卡片(纯派生)
- `deriveAgentCards(activity) -> Card[]`(纯,node:test):从事件流折叠成卡片 view-model:
  - `orchestration:planned`/`round_started`/`replanned` → **plan 卡**(子任务数/回合)。
  - `tool:call` + 后续 `tool:result`(按 id 配对)→ **tool 卡**(工具名 + 状态 running/ok/error)。
  - `file:diff_applied`/`file:diff_preview` → **diff 卡**(路径 + 增删行数)。
  - `verification:result` → **test 卡**(通过/失败)。
- AgentPanel:真消息 + 审批 + `deriveAgentCards` 卡片;仅**完全空闲**(无消息、无卡片)时显示示例预览。

### 4.4 交互终端(node-pty)
- 依赖:`@xterm/xterm` · `@xterm/addon-fit` · `node-pty`(**原生模块**,装后需 `@electron/rebuild` 按 Electron ABI 重编译)。
- 主进程 `gui/pty-host.js`(新):`spawn(cwd=projectRoot, shell=平台默认)`;`onData → pushEvent("pty:data")`;IPC `pty:start`/`pty:input`/`pty:resize`/`pty:kill`;窗口关/dispose 时 kill。单终端起步(多终端后续)。
- 渲染层 Terminal:xterm 实例 + fit 插件,`onData → pty:input`,`pty:data → term.write`,resize → `pty:resize`。
- **注入可测**:`pty-host` 的 spawn 依赖注入(默认 node-pty),单测用 mock pty 验证 data/input/resize/kill 生命周期,不依赖真原生模块。
- **安全**:交互终端 = GUI 内开真 shell(与 VS Code 同),用户本机自负;不额外沙箱(超本片)。

### 4.5 language 持久化修复
- `GUI_PREFERENCE_DEFAULTS` 加 `language:"zh"`;`normalizeGuiPreferences` 加 `language: input.language==="en"?"en":"zh"`。→ `setPreferences({language})` 真持久化。node:test 钉死。

---

## 5. 硬约束(实施判据)
1. **kernel(`src/`)零改动**;新增只在 `gui/`(kernel-host 文件桥、pty-host、preload、renderer)。
2. **路径安全**:`readFile` 必过 workspace 边界 realpath 校验,拒目录/超大/二进制/symlink 逃逸。
3. **确定性可测**:`deriveAgentCards` / `normalizeGuiPreferences` / tree 组装 / pty 生命周期(注入 mock)全 node:test;Monaco/xterm/真 pty 走 build + 门控 smoke。
4. **依赖门控 + 原生重建**:Monaco/xterm/node-pty 只进 `gui/package.json`;`node-pty` 需 `@electron/rebuild`;无 deps/未重建时终端优雅降级(显示「终端不可用」而非崩)。build/smoke 无 deps 时 skip → 核心 `npm test` 仍全绿。
5. **离线**:Monaco worker 本地化,不依赖 CDN(Electron `file://`)。
6. **优雅降级**:`window.deepseek` 缺失(裸浏览器)/ pty 不可用 / 文件读失败 → 占位或提示,永不崩。

---

## 6. 里程碑(供拆实施计划;每 Task 末测试+提交)
```
D2-M1  kernel-host listTree/readFile(路径安全)+ IPC + preload + language 持久化修复 + node:test(tree 组装、readFile 边界/拒斥、normalizeGuiPreferences language)
D2-M2  Explorer 接真文件树(fs:tree → 折叠树,点选 dispatch file_opened)+ openFiles/activeFile reducer 状态 + 单测(tree 折叠纯函数、reducer)
D2-M3  Monaco 只读集成(monaco-editor + @monaco-editor/react + 本地 worker vite 配)→ 显示 fs:read 真内容/高亮/主题联动;build 通过(门控)
D2-M4  deriveAgentCards 纯派生(node:test)+ AgentPanel 实时卡片替换示例预览
D2-M5  pty-host(spawn/data/input/resize/kill,注入 mock 可测)+ IPC + preload + 单测(mock pty 生命周期)
D2-M6  xterm 终端 UI 接 pty(fit/resize/输入输出)+ @electron/rebuild node-pty(门控·本地)+ build 通过
D2-M7  build + 门控 smoke(断言 Monaco/终端容器挂载)+ 截图验收(真文件/真终端)+ 回归全绿 + 文档(overview/CHANGELOG/README 中英/索引)
```
> M1/M4/M5(纯逻辑)无 deps 可先做;M3/M6(Monaco/pty)需装依赖 + 原生重建(门控,本机或联网);M7 收口。

---

## 7. 测试策略(node:test + build/门控 smoke)
- **kernel-host fs**:`listTree` 排除项/封顶;`readFile` 读回、拒目录、拒超大、拒二进制(NUL)、拒边界外(symlink/`..`);临时目录夹具。
- **normalizeGuiPreferences**:`language` en/zh/非法→zh;既有 theme/railMode 不回归。
- **deriveAgentCards**(纯):plan/tool(call+result 配对)/diff/test 各场景;乱序/缺 result 的 tool 卡标 running;空 activity → 空。
- **reducer 新状态**:`file_opened`/`file_closed`/`file_activated`(openFiles/activeFile 不可变)。
- **pty-host**(mock spawn):start 建 pty、input 透传、resize 调用、data 事件回推、kill 清理;pty 不可用 → 降级标志。
- **build(门控)**:`vite build` 含 monaco worker 产出成功。
- **smoke(门控)**:加载构建产物,断言 `.editor`(Monaco 容器)+ 终端容器挂载 + 四栏;真 pty 若未重建 → 终端降级不崩。
- **截图**:真文件树 + Monaco 高亮 + 终端(有输出)desktop 图。
- **回归**:现有 799 全绿(kernel 零改动;新纯逻辑测试并入;门控测试无 deps 时 skip)。

---

## 8. 开放问题(实施中定)
- Monaco worker 在 Electron `file://` + Vite `base:"./"` 的确切装配(`@monaco-editor/react` `loader.config` vs `vite-plugin-monaco-editor`)——M3 择一验证。
- `node-pty` 在本环境 `@electron/rebuild` 是否顺利;不顺则终端 M6 降级为「命令跑器」兜底(仍留 PTY 为目标)。
- 文件树大项目性能(先封顶 + 懒展开;虚拟滚动后续)。
- 终端多实例 / 分屏(本片单实例)。
