# Phase 1: Core Intelligence — Implementation Plan

- 类型：路线图
- 日期：2026-05-29
- 状态：已完成
- 关联：[CHANGELOG](../../CHANGELOG.md)、[Phase 0](2026-05-29-phase-0-kernel-foundation.md)、[Phase 2](2026-05-30-phase-2-security-extension.md)

## 目标

在 Phase 0 地基上建三个核心智能模块：ModelProvider（双通道 DeepSeek API）、ContextEngine（三层记忆 + 缓存感知组装）、TaskOrchestrator（事件驱动状态机）。

## 结果

依赖顺序 ModelProvider（独立）→ ContextEngine（独立）→ TaskOrchestrator（组合前两者）→ 接 KernelAPI → 集成。Tech stack：Node ≥ 20 ESM、`node:fetch`（global）、`node:crypto`、Phase 0 kernel 模块。

**ModelProvider**（`src/kernel/model-provider.js`）：封装 DeepSeek API 的 Think/Act 双通道模板、FIM 补全、streaming、retry/fallback、用量统计。接口 `invoke()` / `streamDelta()` / `fimComplete()` / `getUsageStats()` / `channelParams(channel)`。Think 通道开 thinking、更高 max_tokens（16384）、不设 temperature；Act 通道走常规参数（model `deepseek-v4-flash`）。消费 `DEFAULT_MODEL_PROFILES`。

**ContextEngine**（`src/kernel/context-engine.js`）：cold/warm/hot 三层上下文，打分淘汰、快照引用、失效。管理 ContextUnit 生命周期与缓存感知组装。

**TaskOrchestrator**（`src/kernel/task-orchestrator.js`）：显式状态机 Idle→Classify→ThinkPlan→ActExecute→ThinkReview→Verify→Complete，含快路径、autonomy 门控、事件日志迁移。

File structure（V1 落地）：

```text
Create:
  src/kernel/model-provider.js       — DeepSeek API adapter (dual-channel, FIM, streaming, retry)
  src/kernel/context-engine.js       — 3-layer context (ContextUnit, scoring, snapshot, invalidation)
  src/kernel/task-orchestrator.js    — State machine (11 states + fast paths + autonomy gating)
  test/kernel/model-provider.test.js
  test/kernel/context-engine.test.js
  test/kernel/task-orchestrator.test.js
Modify:
  src/kernel/kernel-api.js           — Wire ModelProvider + ContextEngine + TaskOrchestrator
```

测试 73 项：model-provider 13、context-engine 13、orchestrator 9、Phase 0 的 35、patch 3。`npm run check` 覆盖 22 个源文件。

后续 V2 重构对应能力落在：

| V1 模块 | V2 承接 |
|---------|---------|
| model-provider | `src/deepseek/model-gateway.js`、`model-router.js`、`fim-client.js`、`streaming.js`、`usage-tracker.js`、`api-errors.js`、`json-mode.js`、`prompt-assembler.js` |
| context-engine | `src/context/*`（context-unit、token-budget、context-selector、context-snapshot、context-cache、workspace-indexer、context-manifest） |
| task-orchestrator | `src/core/runtime/agent-runtime.js` + `src/core/execution/executor-loop.js` + `src/core/planning/classifier.js`；编排状态机另见 Phase C |

V1 的 `src/kernel/*` 已于 V2-19 删除。

## 关键决策 / 遗留约束

- Think/Act 双通道按 `channelParams` 切换模型与参数；现为 `models: { act, think, fim }`，默认 `deepseek-v4-flash` / `deepseek-v4-pro` / `deepseek-v4-pro`。
- 上下文三层与打分淘汰演进为 V2 的 token-budget + context-selector；语义级检索另见 Phase B。
- 状态机显式可测，迁移发事件；V2 的 lifecycle 更细（含 awaiting_approval、stopped）。
- FIM 与 streaming 是独立入口，不混进普通 invoke。
- retry/fallback 与 usage 跟踪在 model 层，不散落到调用方。

## 验证

V1 测试 `test/kernel/{model-provider,context-engine,task-orchestrator}.test.js`（随 V2-19 删除）。`node --test test/patch.test.js test/kernel/*.test.js` 73 PASS。当前对应入口见上表 V2 路径。

## 任务覆盖（as-built 映射）

Task 1 ModelProvider（13 测试：channelParams Think/Act、invoke、streamDelta、fimComplete、getUsageStats、retry/fallback）→ Task 2 ContextEngine（13 测试：三层、打分淘汰、快照、失效）→ Task 3 TaskOrchestrator（9 测试：状态机迁移、快路径、autonomy 门控）→ Task 4 接 KernelAPI → Task 5 集成（全量 73 + check 22 文件）。依赖顺序 ModelProvider → ContextEngine → TaskOrchestrator → Wire KernelAPI → Integration。
