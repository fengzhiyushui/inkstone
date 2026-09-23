# V2-0 Skeleton & Protocol Foundation

- 类型：实施计划
- 日期：2026-05-30
- 状态：已完成
- 关联：[CHANGELOG](../../CHANGELOG.md)

## 目标

在旧 `src/kernel` 与 legacy CLI 旁侧新建 V2 运行时骨架：共享工具、协议对象、会话事件名、mock `AgentRuntime` 与公开 `createKernel()` 门面，不改动现有 v0/v1 行为。

## 结果

V2 目录骨架落地。后续 DeepSeek 网关、工具平面、编辑、会话与界面迁移都挂在同一公开入口上。当时创建的模块仍在使用。

本阶段只做 V2-0：目录骨架、共享帮助函数、核心协议工厂、会话事件类型注册、最小 classifier 与 lifecycle、mock `AgentRuntime`、`src/index.js` 公开 `createKernel()`，以及让 V2 测试并入现有回归。真实 DeepSeek 调用、真实工具、diff 应用、GUI/TUI/CLI 迁移都不在本阶段。

### 文件结构

```text
src/index.js
src/shared/id.js
src/shared/time.js
src/shared/event-bus.js
src/core/protocol/agent-turn.js
src/core/protocol/agent-step.js
src/core/protocol/tool-call.js
src/core/protocol/tool-result.js
src/core/protocol/approval-request.js
src/core/protocol/artifact.js
src/core/protocol/index.js
src/core/planning/classifier.js
src/core/runtime/lifecycle.js
src/core/runtime/agent-runtime.js
src/sessions/event-types.js
tests/unit/shared/event-bus.test.js
tests/unit/core/protocol.test.js
tests/unit/core/lifecycle.test.js
tests/unit/core/agent-runtime.test.js
tests/unit/sessions/event-types.test.js
tests/integration/v2-kernel-facade.test.js
```

修改：`package.json`。

### 职责边界

- `src/shared/*` 通用帮助函数，无产品向副作用。
- `src/core/protocol/*` 轮次数据的纯工厂与校验：`agent-turn`、`agent-step`、`tool-call`、`tool-result`、`approval-request`、`artifact`。
- `src/core/planning/classifier.js` 首轮确定性任务分类，后续 runtime 据此决定快路径或工具循环。
- `src/core/runtime/lifecycle.js` 运行时状态与迁移记录。
- `src/core/runtime/agent-runtime.js` 最小 mock 轮次循环，只发布规范事件。
- `src/sessions/event-types.js` V2 会话事件名单一来源。
- `src/index.js` 稳定公开内核入口。

### 公开契约

`createKernel(root, options)` 返回内核对象，当时已具备的门面包括 `agent`、`session`、`tools`、`config`。关键注入点与形状：

| 调用 | 行为 |
|------|------|
| `createKernel(root, { modelGateway })` | 注入 mock 或自定义网关，覆盖默认模型适配 |
| `createKernel(root, { sessionId, projectId, sessionRoot, eventBus, sessionLog })` | 可覆盖会话身份与持久化根；`sessionLog: null` 关闭落盘 |
| `kernel.agent.send(message, options)` | 驱动一轮 mock agent turn |
| `kernel.session` | 事件时间线门面，后续计划扩展 `getTimeline` / `flush` |

`createEventBus()` 契约：

- `publish(type, data)` 附带 `meta.event_type`、`meta.event_id`（`evt_` 前缀）、`meta.timestamp`。
- `subscribe(type, handler)` 收到 `(data, meta)`，返回可 `unsubscribe()` 的句柄。
- 取消订阅后不再投递。

`makeId(prefix)` 生成带前缀 ID；`evt_` 专用于事件。时间戳走 `src/shared/time.js`，便于测试注入。

协议工厂与字段命名走 snake_case，当时锁定的主要字段：

| 对象 | 字段 |
|------|------|
| Turn | `id`、`session_id`、`status`、`steps` |
| Step | `id`、`turn_id`、`kind`、`status` |
| ToolCall | `id`、`name`、`params`、`source`、`requested_by_step_id` |
| ToolResult | `tool_call_id`、`status`、`content`、`metadata` |
| ApprovalRequest | `id`、`tool_call`、`target`、`status` |
| Artifact | 轻量工件描述，供后续编辑/导出使用 |

`src/core/protocol/index.js` 聚合上述工厂，调用方不直接拼裸对象。

### 事件名校验

`SESSION_EVENT_TYPES` 是唯一清单。`isSessionEventType(type)` 返回布尔，`assertSessionEventType(type)` 对未知类型抛 `unknown session event type: …`。

V2-0 初始集：

- `session:start`
- `user:message`
- `agent:turn_started`
- `agent:step`
- `model:request`
- `model:response`
- `tool:call`
- `tool:result`
- `permission:decision`
- `approval:requested`
- `approval:resolved`
- `agent:final`
- `agent:error`

后续计划只增不改已有名。该不变量在 DeepSeek 中断、审批恢复、rewind、recovery 里继续成立。

### Mock runtime 事件链

一轮 agent turn：

```text
session:start
user:message
agent:turn_started
agent:step
agent:final
```

`agent:final` 之后不得再由同一陈旧 turn 发布结果。`agent-runtime` 的 lifecycle 记录状态迁移，供中断与锁释放判断使用。

## 关键决策 / 遗留约束

| 决策 | 选择 | 否决 | 原因 |
|------|------|------|------|
| V2 放置方式 | 旁路新建 | 就地改 V1 | 旧 `src/kernel` 与 legacy CLI 不动，迁移可分阶段 |
| 协议形态 | 纯工厂函数 | 类继承树 | 易测、易序列化，字段即契约 |
| 事件名 | 命名空间冒号 | 扁平字符串 | 后续按域分组注册，避免重名 |
| 依赖 | 仅 Node 内置 | 引入运行时库 | 发布面保持可审计 |
| 入口 | 单一 `createKernel` | 多套 facade | CLI/TUI/GUI 同源 |

遗留约束：

- 技术栈锁定 Node.js >= 20、ESM、`node:test`、`node:assert/strict`。
- 本阶段不接真实 DeepSeek、真实工具、diff 应用，也不迁移 GUI/TUI/CLI。
- `src/core/runtime` 后续也不得直接 import `src/tools`；跨层协作走注入回调。
- Windows 验证命令统一 `npm.cmd`。
- 后续模块（DeepSeek、tools、edits、sessions 持久层）都以本阶段事件名与协议工厂为基线扩展。
- 无关用户本地文件保持不动。

## 验证

当时逐任务先写失败测试再实现：

| 测试 | 锁定行为 |
|------|----------|
| `tests/unit/shared/event-bus.test.js` | publish 元数据、`evt_` 前缀、timestamp、unsubscribe |
| `tests/unit/core/protocol.test.js` | 各工厂字段与校验 |
| `tests/unit/core/lifecycle.test.js` | 状态迁移记录 |
| `tests/unit/core/agent-runtime.test.js` | mock 轮次事件顺序与最终结果 |
| `tests/unit/sessions/event-types.test.js` | 事件名注册与未知类型抛错 |
| `tests/integration/v2-kernel-facade.test.js` | `createKernel` 注入 mock 网关可跑通一轮 |

全量 `npm.cmd test` 与 `npm.cmd run check` 通过，当时基线约 130 项测试。语法检查覆盖新增源文件。

现对应入口：

- `src/index.js` 的 `createKernel` 与 mock 注入路径
- `tests/integration/v2-kernel-facade.test.js`
- `src/sessions/event-types.js` 的 `SESSION_EVENT_TYPES`
- `src/core/protocol/index.js`
