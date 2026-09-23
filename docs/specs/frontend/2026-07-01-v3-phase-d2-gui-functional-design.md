# V3 Phase D-2 · GUI 做真

- 类型：前端 spec
- 日期：2026-07-01
- 状态：已实现
- 关联：[D-1 React 外壳](2026-06-27-v3-phase-d1-gui-react-shell-design.md) · [D-3 全功能](2026-07-02-v3-phase-d3-gui-full-functional-design.md)

## 问题与目标

D-1 交付外壳后，文件树、编辑器、终端、Agent 卡片仍是标记占位。本片换成真实数据：项目文件树、Monaco 只读查看、实时 Agent 卡片、node-pty 交互终端，并修 `language` 偏好未持久化。

## 决策

| 选了什么 | 否决了什么 | 为什么 |
|---|---|---|
| `listTree` / `readFile` 走 kernel-host 路径安全桥 | 渲染层裸 fs | 防 symlink 逃逸 |
| Monaco 只读 + 本地 worker | CDN worker / 立刻可编辑 | Electron `file://` 离线；可编辑留 D-3 |
| `deriveAgentCards(activity)` 纯派生 | 每组件各自读事件 | 可测、口径统一 |
| node-pty + xterm 单终端 | 多终端分屏 | 本片范围 |
| GUI 后端只加文件/PTY 桥 | 改 kernel | GUI 关注点 |
| node-pty 可注入 spawn | 硬依赖原生模块做单测 | mock 生命周期即可测 |

不做：编辑器可编辑保存、diff 双栏、多标签、右键/拖拽、全文搜索、Recovery Center UI、文件 watch。

## 设计

```text
Electron 主进程
  gui/main.js         + PTY 生命周期 IPC
  gui/kernel-host.js  + listTree() / readFile(rel)
  gui/preload.js      + fs.listTree/readFile + pty.*
        │ IPC
React
  Explorer    ← fs:tree → file_opened
  EditorGroup ← Monaco 只读显示 fs:read
  AgentPanel  ← deriveAgentCards(state.activity)
  Terminal    ← xterm ↔ pty IPC
```

文件树：递归 `projectRoot`，排除 `.git`/`node_modules`/`.deepseek-code`/`renderer-dist`/`dist`，返回扁平 `[{ path(rel, posix), name, type:"dir"|"file", depth }]`，约 5000 条封顶并截断标记。渲染层组装折叠树。

`readFile(relPath)` 经 `src/workspace/path-safety.js` 的 `resolveWorkspacePath`（realpath 边界，阻 symlink 逃逸）。拒目录、超大（约 1MB）、二进制（NUL 探测）。返回 `{ path, content, language, truncated }`，`language` 由扩展名映射。IPC `fs:tree` / `fs:read`。

Monaco：`monaco-editor` + `@monaco-editor/react`；本地 worker（`loader.config({ monaco })` 或 Vite worker 配置），`base:"./"` 下 worker 路径相对。`readOnly:true`、`theme` 随 night/day（`vs-dark`/`vs`）、`language` 来自读文件结果、minimap 关或简、字体 Cascadia Code。`openFiles`/`activeFile` 管标签，点树打开/激活。

Agent 卡片映射（纯函数，node:test）：

| 事件 | 卡片 |
|---|---|
| `orchestration:planned` / `round_started` / `replanned` | plan 卡 |
| `tool:call` + `tool:result`（按 id 配对） | tool 卡 running/ok/error |
| `file:diff_applied` / `file:diff_preview` | diff 卡（路径 + 增删行） |
| `verification:result` | test 卡 |

仅完全空闲时显示示例预览。

终端：`@xterm/xterm`、`@xterm/addon-fit`、`node-pty`（需 `@electron/rebuild` 按 Electron ABI）。`gui/pty-host.js`：`spawn(cwd=projectRoot)`，`onData → pty:data`；IPC `pty:start` / `pty:input` / `pty:resize` / `pty:kill`；窗口关闭 kill。单终端。spawn 依赖注入可 mock。pty 不可用显示「终端不可用」。交互终端等同 VS Code，不额外沙箱。

`language` 持久化：`GUI_PREFERENCE_DEFAULTS` 加 `language:"zh"`；`normalizeGuiPreferences` 加 `language: input.language==="en"?"en":"zh"`。

## 边界与不变量

- `src/` kernel 零改动；新增只在 `gui/`。
- `readFile` 必过 workspace realpath 边界，拒目录/超大/二进制/symlink 逃逸。
- `deriveAgentCards` / 偏好归一 / tree 组装 / pty 生命周期全 node:test。
- Monaco/xterm/真 pty 走 build + 门控 smoke。
- Monaco worker 本地化，不依赖 CDN。
- 无桥/读失败/pty 不可用降级不崩。
- 新依赖只进 `gui/package.json`；无 deps/未重建时终端优雅降级。

## 与现状的差异

当前 `gui/src/hooks/useKernel.js` 已暴露 `listTree`/`readFile`，Dock 的 `FilesPanel` 接文件树。`language` 持久化已生效于 `setPreferences`。Monaco 与终端组件随 v4 壳层演进，能力契约仍在 host。

## 验收

- `listTree` 排除项/封顶；`readFile` 读回、拒目录、拒超大、拒二进制、拒边界外。
- `normalizeGuiPreferences` language en/zh/非法→zh，theme/railMode 不回归。
- `deriveAgentCards` plan/tool 配对/diff/test、乱序缺 result 标 running、空 activity。
- pty mock 生命周期单测。
- build 含 monaco worker；smoke 断言编辑器与终端容器，真 pty 未重建时终端降级不崩。
- 回归全绿，核心测试无 gui deps 时仍可跑。
