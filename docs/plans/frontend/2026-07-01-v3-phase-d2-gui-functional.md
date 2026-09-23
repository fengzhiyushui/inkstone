# V3 Phase D-2 · GUI 做真实施计划

- 类型：实施计划
- 日期：2026-07-01
- 状态：已完成
- 关联：[CHANGELOG](../../CHANGELOG.md) · [设计 spec](../../specs/frontend/2026-07-01-v3-phase-d2-gui-functional-design.md) · [D-1 React 外壳](2026-06-27-v3-phase-d1-gui-react-shell.md) · [D-3 全功能](2026-07-02-v3-phase-d3-gui-full-functional.md)

## 目标

把文件树、编辑器、终端、Agent 卡片从占位换成真数据，并修好 language 偏好持久化。

## 结果

### 文件桥与 language

`gui/kernel-host.js` 动态 import 复用 `src/workspace/path-safety.js`（只读 util，不改它）：

- `listTree() → string[]`：`walkWorkspaceFiles(projectRoot)`，posix 相对文件路径；排除 `.git` / `node_modules` / `.deepseek-code`；`maxFiles` 封顶。
- `readFile(rel) → { path, content, language, bytes }`：`readWorkspaceTextFile`（realpath 边界、拒目录、拒超大、拒二进制）+ `languageForExt(rel)`。

`languageForExt` 映射：js / mjs / cjs / jsx → javascript；ts / tsx → typescript；py → python；json → json；md → markdown；css / html / yaml / sh 各对应；其余 plaintext。

IPC：`fs:tree`、`fs:read`（登记 `IPC_CHANNELS`）。preload：`listTree`、`readFile`。

`normalizeGuiPreferences` 增加 `language`：默认 `zh`，仅接受 `en` 为第二值，非法回 `zh`。

### 真文件树

`gui/src/state/file-tree.js`：`buildTree(paths)` 纯函数，按 `/` 拆段建 `{ name, type, path, children }`，目录节点优先、同级 name 升序。

reducer 状态：`fileTree: []`、`openFiles: []`、`activeFile: null`。action：

| type | 行为 |
|---|---|
| `tree_loaded` | 写入 `fileTree` |
| `file_opened` | 按 path 去重合并，`activeFile = path`，记 `original` 供 dirty 对比 |
| `file_activated` | 切 `activeFile` |
| `file_closed` | 移除并回退 active；清对应 dirty |

`useKernel.listTree()` 首屏拉树；`openFile(path)` = `readFile` → `file_opened`，失败 `error_reported`。真树非空时去掉「示例」徽标。

### Agent 卡片

`gui/src/state/agent-cards.js`：`deriveAgentCards(activity) → Array<{ kind: "plan"|"tool"|"diff"|"test", ... }>`。

- `tool:call` 建 running 卡；`tool:result` 按 id 置 ok/err。
- `orchestration:planned` / `replanned` → plan。
- `file:diff_applied` / `file:rollback_applied` → diff。
- `verification:result` → test（`pass`）。
- 空 activity → `[]`。

### pty-host

`gui/pty-host.js`：`createPtyHost({ spawn, cwd, shell, onData })` → `{ start(cols, rows), write(data), resize(cols, rows), kill(), available }`。spawn 注入可 mock；缺失时 `available: false` 且 start/write/resize/kill 全 no-op 不抛；`kill` 幂等。

### Monaco 与终端（依赖门控）

Monaco 只读 + 按 `language` 高亮，worker 本地化（不走 CDN）。xterm + node-pty 交互终端；`pty.available === false` 时显示不可用提示。挂进当时 EditorGroup 底部面板。

v1.4.0 会话优先改版后，编辑器/终端不再作主界面；文件树进右栏 `FilesPanel`，diff 用 Monaco（`ChangeDiffView` / `DiffView`）。

## 关键决策 / 遗留约束

- kernel 零改动；路径安全只复用 path-safety。
- 确定性可测：`buildTree` / `deriveAgentCards` / `normalizeGuiPreferences` / reducer / pty-host 全 node:test。
- 依赖门控 + 降级：新依赖只进 `gui/`；`node-pty` 需 `@electron/rebuild`，失败降级不阻塞；无 deps 时相关测试 skip。
- 核心单测不依赖 gui deps。
- 离线：Monaco worker 不走 CDN。

## 验证

- `tests/unit/gui/kernel-host-fs.test.js`：listTree 排除 node_modules/.git；readFile 含 language；拒 `../../../etc/passwd`。
- language 归一测试；file-tree 排序与嵌套；agent-cards 四类卡；pty-host mock 生命周期与 unavailable 降级。
- `npm run build:renderer` + 手动真终端（门控）。
- 全量 `npm test` + `npm run check`。
- 现役对照：`gui/src/state/file-tree.js`、`agent-cards.js`、`panels/FilesPanel.jsx`、`hooks/useKernel.js` 的 `listTree` / `openFile`。
