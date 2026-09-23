# V2-5 接口迁移实施计划

- 类型：实施计划
- 日期：2026-05-30
- 状态：已完成
- 关联：[CHANGELOG](../../CHANGELOG.md) · [V2 运行时设计](../../specs/architecture/2026-05-30-deepseek-code-v2-clean-runtime-design.md) · [D-1 React 外壳](2026-06-27-v3-phase-d1-gui-react-shell.md)

## 目标

把 CLI、TUI、Electron GUI 迁到 `src/index.js` 的 V2 公开 kernel，迁移期保留旧命令。

## 结果

三端都变成 V2 kernel 薄客户端，UI 不写运行业务逻辑。

### 产出文件

| 文件 | 责任 |
|---|---|
| `src/apps/cli/render-events.js` | V2 会话事件与最终结果 → 简洁 CLI 文本 |
| `src/apps/cli/kernel-runner.js` | 建 V2 kernel、订事件、发 agent 回合、执行 `test` 工具 |
| `src/apps/kernel-options.js` | 旧 `.deepseek-code/config.json` → `createKernel()` DeepSeek options |
| `tests/unit/apps/kernel-options.test.js` | 配置桥测试 |
| `tests/unit/apps/cli/render-events.test.js` | 事件渲染测试 |
| `tests/unit/apps/cli/kernel-runner.test.js` | runner 测试 |
| `tests/integration/v2-cli-kernel-runner.test.js` | 集成 |
| `gui/kernel-host.js` | 动态 import V2 kernel，state/usage/config 兼容响应，事件扇出 |
| `gui/renderer/event-adapter.js` | 纯事件图标/摘要/状态/审批助手 |
| `tests/unit/gui/kernel-host.test.js` | host 测试 |
| `tests/unit/gui/renderer-event-adapter.test.js` | 适配器测试 |

修改：`src/cli.js`、`src/tui.js`、`gui/main.js`、`gui/renderer/index.html`、`gui/renderer/app.js`、`package.json`。

职责图：`render-events.js` 只做事件→文本；`kernel-runner.js` 管 kernel 生命周期与回合；`kernel-options.js` 管旧配置桥；`cli.js` 把选定命令分发到 V2 runner，兼容命令不动；`tui.js` 建 kernel 并经 `kernel.agent.send()` 跑 ask/edit；`kernel-host.js` 管动态 import 与 IPC 操作；`main.js` 变薄壳；`event-adapter.js` 纯格式化；`app.js` 消费适配器并保持 XSS-safe DOM。

### 端行为

**CLI**

- `ask`：V2，`autonomy:"gated"`。
- `edit`：默认 `autonomy:"supervised"`（可停在审批）；`edit --yes` 映射 `gated`；`edit --dry-run` 在 prompt 追加 preview-only 说明。
- `test`：直接 `kernel.tools.execute()`，`autonomy:"auto"`。用户 argv 映射 `{ detect: false, argv }`；无 argv 时 `{ detect: false }` 跑检测到的测试命令。test 是命令执行，不是模型会话。

**TUI**

- 保留 readline / raw-mode 与既有菜单。
- ask / edit 与遥测迁 V2；其余菜单动作仍走旧助手。

**GUI**

- 主进程经 kernel-host 加载 `src/index.js`，不再直接依赖旧 `src/kernel/kernel-api.js`。
- 渲染层理解 V2 事件：`agent:final`、`agent:error`、`approval:requested`、`tool:call`、`tool:result`、`file:diff_applied`、`verification:result` 等。
- 安全壳保持：`nodeIntegration:false`、`contextIsolation:true`、`sandbox:true`、CSP、IPC 白名单、`textContent` 渲染。

迁移期保留旧命令：`chat`、`search`、`scan`、`diff`、`config`、`changes`、`rollback`、`resume`。

### 后续归属

kernel-host 与事件适配语义延续到现役 `gui/kernel-host.js`、`gui/src/hooks/kernel-loads.js`、`gui/src/state/agent-cards.js`（原 `renderer/event-adapter.js` 随 UMD 退役）。CLI 渲染器与 runner 仍在 `src/apps/cli/`。

## 关键决策 / 遗留约束

- 唯一公开运行时入口 `createKernel()`（`src/index.js`）；接口层只做薄客户端。
- CLI 安全行为与 autonomy 档位绑定。
- 渲染可测：事件格式化抽成纯 CommonJS 浏览器兼容模块，无 Electron / DOM 依赖。
- kernel-host 可测：CommonJS 包装动态 ESM import，注入 kernelFactory 可 mock。
- 本阶段不做 approval 完整 resume、不删 `src/agent.js` / `src/chat.js` / `src/kernel/*`、不挪 `gui/` 到 `apps/gui/`、不重写遗留乱码中文、不引入 React/Ink/打包器/新依赖、不持久化 V2 时间线（`getTimeline()` 可仍空）。
- 技术栈：Node ≥20，根源码 ESM，Electron main/preload CommonJS，渲染层原生 JS，`node:test` + `node:assert/strict`。

## 验证

- 单测：`kernel-options`、`cli/render-events`、`cli/kernel-runner`、`gui/kernel-host`、`renderer-event-adapter`。
- 集成：`v2-cli-kernel-runner`。
- 手工 smoke：CLI ask / edit / test；TUI ask / edit；GUI 事件流与审批。
- 全量 `npm test` + `npm run check`。
- 验收要点：三端都只经 `createKernel()`；旧命令仍可用；GUI 安全壳不变；事件适配可离屏测试。
- 现役对照：`src/apps/cli/*`、`src/apps/kernel-options.js`、`gui/kernel-host.js`。
