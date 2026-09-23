# V2-6 Release Closure

- 类型：实施计划
- 日期：2026-05-30
- 状态：已完成
- 关联：[CHANGELOG](../../CHANGELOG.md)

## 目标

收束 V2 迁移：补上可持久化的会话时间线、发布冒烟、legacy 边界守卫，以及准确的用户文档，使当时 V2 运行时可交付、可理解。

## 结果

V2 保持单一公开内核入口 `src/index.js`，新建干净的 `src/sessions` 持久层，不复用 `src/kernel/*`。CLI、TUI、GUI 继续做薄客户端。发布测试证明已迁移入口不会落回旧 V1 kernel 路径。

V2-6 是发布收束阶段，不是新能力阶段。目标是让当时的 V2 运行时可交付、可理解，且不删 legacy 代码。

### 范围

做：

- `src/sessions` 下的 durable V2 事件日志。
- `kernel.session.getTimeline(count)` 与 `kernel.session.flush()`。
- CLI/kernel/GUI host 离线发布冒烟。
- 防止已迁移界面 import 旧 `src/kernel/kernel-api.js` 的边界测试。
- UTF-8 中文 README 重写。

不做：`awaiting_approval` 后的审批恢复、repair 重入 runtime、`gui/` 搬到 `apps/gui/`、删除 V0/V1、GUI 暴露真实 usage stats。

### 文件结构

创建：

| 路径 | 职责 |
|------|------|
| `src/sessions/event-log.js` | 追加式 JSONL 事件日志。负责记录形状、hash 链、路径消毒、保留字段剥离、tail 读取与 flush。 |
| `src/sessions/session-manager.js` | 把 V2 `EventBus` 事件桥进 event-log，暴露 `subscribe`、`flush`、`getTimeline`、`dispose`。 |
| `tests/unit/sessions/event-log.test.js` | JSONL 持久化、保留字段安全、排序、hash 链、重开、损坏行容忍。 |
| `tests/unit/sessions/session-manager.test.js` | 桥接持久化、订阅类型安全、flush、append 失败隔离、dispose。 |
| `tests/integration/v2-session-timeline.test.js` | `agent.send` 产出持久时间线。 |
| `tests/e2e/cli-smoke.test.js` | 测试退出码透传 + 离线 kernel-runner ask 冒烟。 |
| `tests/integration/v2-interface-boundary.test.js` | 已迁移 CLI/TUI/GUI 不得 import `src/kernel/kernel-api.js`。 |

修改：`src/index.js`、`src/cli.js`、`tests/integration/v2-kernel-facade.test.js`、`tests/unit/gui/kernel-host.test.js`、`package.json`、`README.md`。

### 事件日志契约

`createSessionEventLog({ sessionRoot, projectId, sessionId, meta })` / `openSessionEventLog` / `projectIdFromRoot`。

| 行为 | 语义 |
|------|------|
| 创建 | 自动写 `session:start`，`seq` 从 1 起 |
| `append(type, data, meta)` | 剥离 data 中的保留字段（`type`、`seq`、`event_hash`、`prev_hash` 等），由日志层写入 |
| hash 链 | 每条 `prev_hash` 指向前一条 `event_hash`；`event_hash` 形如 `sha256:…` |
| 路径消毒 | `sessionId` 等不可直接拼进文件系统路径 |
| `tail(n)` | 读最近 n 条 |
| `flush()` | 等待落盘 |
| 重开 | 同一 `{ sessionRoot, projectId, sessionId }` 续写，不重复 `session:start` |
| 损坏行 | 容忍跳过，不拖垮整份日志 |

`sessionRoot` 默认形态为 `<root>/.deepseek-code/v2/sessions`。meta 中的 `root`、`type`、`seq` 等保留字段由日志层权威写入，用户 payload 不能伪造。

### 内核与界面行为锁定

- `kernel.session.getTimeline(count)` 返回真实持久化事件，不合成重复 final。
- `kernel.session.flush()` 等待 fire-and-forget 事件持久化。
- `agent.send()` 时间线包含 `session:start`、`user:message`、`agent:turn_started`、`agent:step`、`agent:final`。
- GUI host 不重复发出 `agent:result` 最终消息。
- 假 root 测试传 `sessionLog: null` 或把 `sessionRoot` 指到临时目录。
- CLI `test` 黑盒冒烟透传子进程退出码。
- CLI ask runner 可经注入的离线 V2 内核完成，不出现 JSON mode 失败文案。
- 已迁移 CLI/TUI/GUI 入口不 import `src/kernel/kernel-api.js`。
- README 为可读 UTF-8 中文，如实描述 V2 状态与已知限制。

### 文档范围

README 重写覆盖：项目定位、快速开始、V2 架构、DeepSeek 适配、工具平面、编辑与回滚、安全不变量、会话时间线、已知限制、目录导览。完成状态仍以 [CHANGELOG](../../CHANGELOG.md) 为准。

### 验收锁定清单（当时完成标准）

- `kernel.session.getTimeline(count)` 返回持久化 V2 事件，不是空数组。
- `kernel.session.flush()` 等待 fire-and-forget 持久化。
- `agent.send()` 时间线含 `session:start`、`user:message`、`agent:turn_started`、`agent:step`、`agent:final`。
- 同一 `{ sessionRoot, projectId, sessionId }` 重开续写 JSONL，不重复 `session:start`。
- CLI `test` 黑盒冒烟透传子进程退出码。
- CLI ask runner 可经注入离线 V2 内核完成，不出现 JSON mode 失败文案。
- GUI host 不重复发 `agent:result` final。
- 已迁移 CLI/TUI/GUI 入口不 import `src/kernel/kernel-api.js`。
- README 为可读 UTF-8 中文，准确描述 V2 状态与已知限制。
- `npm.cmd test`、`npm.cmd run check`、`git diff --check` 全部退出 0。

## 关键决策 / 遗留约束

| 决策 | 选择 | 否决 | 原因 |
|------|------|------|------|
| 会话持久层 | 新建 `src/sessions` | 复用 `src/kernel/*` | 与 V1 内核解耦 |
| 日志形态 | 追加 JSONL + hash 链 | 可变状态库 | 便于 tail、校验与后续 rewind |
| 发布范围 | 收束与文档 | 新开能力 | 本阶段目标是可交付 |
| 边界守卫 | 静态 import 检查 | 只靠人工 review | 迁移回归可自动拦 |
| 假 root | 显式 `sessionLog: null` | 隐式落盘再清理 | 测试无污染 |

遗留约束：

- 审批恢复、repair 回环、GUI 迁移、真实 usage stats 展示明确出界。
- 不删 V0/V1 文件。
- 测试用假项目根默认关持久化，避免污染仓库 `.deepseek-code/`。
- 后续 rewind/branch 只追加事件，不改写既有 JSONL。
- Windows 命令统一 `npm.cmd`。
- 无关本地脏文件不入库。

## 验证

| 测试 | 锁定行为 |
|------|----------|
| `tests/unit/sessions/event-log.test.js` | 创建/剥离/hash 链/重开/损坏行 |
| `tests/unit/sessions/session-manager.test.js` | 桥接、flush、失败隔离、dispose |
| `tests/integration/v2-session-timeline.test.js` | 内核级时间线完整 |
| `tests/e2e/cli-smoke.test.js` | CLI 退出码与离线 ask |
| `tests/integration/v2-interface-boundary.test.js` | 禁 import `src/kernel/kernel-api.js` |
| `tests/unit/gui/kernel-host.test.js` | `getTimeline` 委托 V2，不重复 final |

当时 `npm.cmd test`、`npm.cmd run check`、`git diff --check` 全部通过。

现对应入口：

- `src/sessions/event-log.js`
- `src/sessions/session-manager.js`
- `kernel.session.getTimeline` / `flush`
