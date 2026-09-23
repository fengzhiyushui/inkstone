# Phase 0: Kernel Foundation — Implementation Plan

- 类型：路线图
- 日期：2026-05-29
- 状态：已完成
- 关联：[CHANGELOG](../../CHANGELOG.md)、[Phase 1](2026-05-29-phase-1-core-intelligence.md)、[Phase 2](2026-05-30-phase-2-security-extension.md)

## 目标

搭起后续阶段依赖的最小内核地基：EventBus、SessionLog、KernelAPI、带 ModelProfile 的 ConfigProvider，对既有 CLI 流零破坏。

## 结果

V1 时期在 `src/kernel/` 下落地四个独立模块，各自可隔离测试。Tech stack：Node ≥ 20 ESM、`node:events`、`node:crypto`、`node:path`、`node:fs/promises`、`node:test` + `node:assert/strict`。

| 模块 | 职责 |
|------|------|
| `event-bus.js` | 类型化 publish/subscribe；`subscribe` 返回可 `unsubscribe` 的句柄；同类型多订阅者都收到 |
| `session-log.js` | append-only JSONL + schema 版本 + SHA-256 哈希链；`createSessionLog` / `tail` / `verifyEventLog` |
| `kernel-api.js` | 公开接口契约定义 |
| `config-provider.js` | 扩展 `src/config.js` 的 ModelProfile 支持，保持向后兼容 |

File structure（V1 落地）：

```text
Create:
  src/kernel/event-bus.js          — Typed EventBus (publish/subscribe)
  src/kernel/session-log.js        — Append-only JSONL + hash chain
  src/kernel/kernel-api.js         — Kernel public interface definition
  src/kernel/config-provider.js    — Enhanced config with ModelProfile
  test/kernel/event-bus.test.js
  test/kernel/session-log.test.js
  test/kernel/config-provider.test.js
Modify:
  src/config.js                    — Add ModelProfile export, keep backward compat
  package.json                     — Add "check:kernel" script entry
```

测试 26 项：event-bus 7、session-log 7、config-provider 9、既有 patch 3。`package.json` 的 `check` 脚本覆盖 `src/kernel/*.js`。

后续 V2-19 删除了 `src/kernel/*`；对应能力由 V2 的 `src/shared/event-bus.js`、`src/sessions/event-log.js`（含 `hashEvent` / `verifyEventLog` / `projectIdFromRoot`）、`src/core/protocol/*`、`src/config.js` 承接。

## 关键决策 / 遗留约束

- SessionLog 追加写 + 哈希链，便于完整性校验；schema 版本随事件落盘。
- EventBus 只做类型化 pub/sub，不负责持久化；持久化由 Session Manager 桥接（Phase 3）。
- KernelAPI 只定契约，实现在 Phase 1 填入。
- ModelProfile 概念演进为 V2 的 `models: { act, think, fim }` 通道配置（v1.2.0 起可配）。
- 对既有 CLI 流零破坏：旧文件语法检查全过，`test/patch.test.js` 不回归。
- 四个模块独立可测，不互相纠缠；后续阶段在此之上组合。

## 验证

V1 测试 `test/kernel/*.test.js`（随 V2-19 删除）。`npm run check` 无输出（所有文件 parse 成功）。`node --test test/patch.test.js test/kernel/*.test.js` 26 PASS。当前对应入口：`src/shared/event-bus.js`、`src/sessions/event-log.js`、`src/sessions/event-types.js`、`src/core/protocol/`、`src/config.js`。

## 任务覆盖（as-built 映射）

Task 1 EventBus（7 测试：subscribe 收到、unsubscribe 停收、多订阅者都收）→ Task 2 SessionLog（7 测试：追加写、tail、哈希链、verifyEventLog）→ Task 3 ConfigProvider（9 测试：ModelProfile 合并、向后兼容）→ Task 4 KernelAPI（语法检查）→ Task 5 集成（check 脚本 + 全量）。Phase 0 完成清单：四模块创建并测试、config.js 更新、check 覆盖、26 测试全绿、既有 CLI 不破坏。
